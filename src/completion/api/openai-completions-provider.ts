import { getBaseModelId } from '../../model-id-utils';
import type { AuthTokenInfo } from '../../auth/types';
import type { ModelConfig, ProviderConfig } from '../../types';
import { isRawBaseUrlEnabled } from '../../utils';
import { isRecord } from '../configuration';
import type {
  CodeGemmaCompletionRequest,
  FimCompletionRequest,
  ZetaCompletionRequest,
} from '../model/requests';
import type {
  BufferedCompletionResponse,
  CompletionChoice,
} from '../model/responses';
import { buildCodeGemmaPrompt } from '../template/codegemma';
import { FIM_PROTOCOL_STOPS } from '../template/fim';
import {
  buildZetaPrompt,
  parseZetaOutput,
  type ZetaPrompt,
} from '../template/zeta';
import { CompletionRuntimeError } from '../model/errors';
import {
  buildEffectiveStops,
  postprocessNativeCompletionText,
} from '../template/postprocess';
import {
  postCompletionJson,
  runNativeCompletionOperation,
} from './http';
import { buildCompletionBaseUrl } from './base-url';
import type {
  CompletionApiCapabilities,
  CompletionApiOperation,
  CompletionApiProvider,
  NativeCompletionApiContext,
} from './provider';
import {
  createNativeCompletionApiProvider,
  defineNativeCompletionApiProvider,
} from './provider';
import { omitRequestBodyFields } from './request-body';
import { runWithCompletionConcurrency } from './concurrency';
import { computeCompletionRequestTargetSignature } from '../provider-target';

export const OPENAI_COMPLETIONS_CAPABILITIES = {
  fim: {
    responseMode: 'buffered',
    multiCandidateSupport: 'single-request',
  },
  codegemma: {
    responseMode: 'buffered',
    multiCandidateSupport: 'single-request',
  },
  zeta1: {
    responseMode: 'buffered',
    multiCandidateSupport: 'single-result-only',
  },
  zeta2: {
    responseMode: 'buffered',
    multiCandidateSupport: 'single-result-only',
  },
  'zeta2.1': {
    responseMode: 'buffered',
    multiCandidateSupport: 'single-result-only',
  },
} as const satisfies CompletionApiCapabilities;

function modelFields(model: ModelConfig): Record<string, unknown> {
  return {
    ...(model.maxOutputTokens === undefined
      ? {}
      : { max_tokens: model.maxOutputTokens }),
    ...(model.temperature === undefined
      ? {}
      : { temperature: model.temperature }),
    ...(model.topP === undefined ? {} : { top_p: model.topP }),
    ...(model.frequencyPenalty === undefined
      ? {}
      : { frequency_penalty: model.frequencyPenalty }),
    ...(model.presencePenalty === undefined
      ? {}
      : { presence_penalty: model.presencePenalty }),
  };
}

function mergedBody(
  provider: ProviderConfig,
  model: ModelConfig,
): Record<string, unknown> {
  return omitRequestBodyFields({
    ...modelFields(model),
    ...(provider.extraBody ?? {}),
    ...(model.extraBody ?? {}),
  }, [
    'model',
    'messages',
    'input',
    'prompt',
    'suffix',
    'raw',
    'options',
    'stream',
    'stream_options',
    'stop',
    'prediction',
  ]);
}

function requestOptions(
  request: FimCompletionRequest | CodeGemmaCompletionRequest,
): Record<string, unknown> {
  return {
    ...(request.options.maxTokens === undefined
      ? {}
      : { max_tokens: request.options.maxTokens }),
    ...(request.options.candidateCount === undefined
      ? {}
      : { n: request.options.candidateCount }),
  };
}

export function buildOpenAIFimRequestBody(
  provider: ProviderConfig,
  model: ModelConfig,
  request: FimCompletionRequest,
): Record<string, unknown> {
  return {
    ...mergedBody(provider, model),
    ...requestOptions(request),
    model: getBaseModelId(model.id),
    prompt: request.prefix,
    suffix: request.suffix,
    stop: [...FIM_PROTOCOL_STOPS],
    stream: false,
  };
}

export function buildOpenAICodeGemmaRequestBody(
  provider: ProviderConfig,
  model: ModelConfig,
  request: CodeGemmaCompletionRequest,
): Record<string, unknown> {
  return {
    ...mergedBody(provider, model),
    ...requestOptions(request),
    model: getBaseModelId(model.id),
    prompt: buildCodeGemmaPrompt(request),
    stop: [...FIM_PROTOCOL_STOPS],
    stream: false,
  };
}

export function buildOpenAIZetaRequestBody(
  provider: ProviderConfig,
  model: ModelConfig,
  request: ZetaCompletionRequest,
  prompt: ZetaPrompt = buildZetaPrompt(request),
): Record<string, unknown> {
  return {
    ...omitRequestBodyFields(mergedBody(provider, model), [
      'temperature',
      'max_tokens',
      'n',
    ]),
    model: getBaseModelId(model.id),
    prompt: prompt.prompt,
    ...(request.options.maxTokens === undefined
      ? {}
      : { max_tokens: request.options.maxTokens }),
    stop: [...prompt.stops],
    stream: false,
  };
}

export function parseOpenAICompletionsResponse(
  payload: unknown,
  effectiveStops: readonly string[],
): BufferedCompletionResponse {
  if (!isRecord(payload) || !Array.isArray(payload.choices)) {
    throw new CompletionRuntimeError(
      'completion-invalid-response',
      'OpenAI Completions returned an invalid response.',
    );
  }
  const choices = payload.choices.map((choice): CompletionChoice => {
    if (!isRecord(choice) || typeof choice.text !== 'string') {
      throw new CompletionRuntimeError(
        'completion-invalid-response',
        'OpenAI Completions returned an invalid choice.',
      );
    }
    return {
      text: postprocessNativeCompletionText(choice.text, effectiveStops),
      ...(typeof choice.finish_reason === 'string'
        ? { finishReason: choice.finish_reason }
        : {}),
    };
  });
  return {
    mode: 'buffered',
    choices,
    ...(payload.usage === undefined ? {} : { usage: payload.usage }),
  };
}

export function parseOpenAIZetaResponse(
  payload: unknown,
  request: ZetaCompletionRequest,
  prompt: ZetaPrompt,
): BufferedCompletionResponse {
  if (!isRecord(payload) || !Array.isArray(payload.choices)) {
    throw new CompletionRuntimeError(
      'completion-invalid-response',
      'OpenAI Completions returned an invalid Zeta response.',
    );
  }
  const first = payload.choices[0];
  if (!isRecord(first) || typeof first.text !== 'string') {
    throw new CompletionRuntimeError(
      'completion-invalid-response',
      'OpenAI Completions returned an invalid Zeta choice.',
    );
  }
  return {
    mode: 'buffered',
    choices: [
      {
        text: parseZetaOutput(request.kind, first.text, prompt),
        ...(typeof first.finish_reason === 'string'
          ? { finishReason: first.finish_reason }
          : {}),
      },
    ],
    ...(payload.usage === undefined ? {} : { usage: payload.usage }),
    edit: {
      targetUri: request.document.uri,
      startOffset: prompt.editableStart,
      endOffset: prompt.editableEnd,
    },
  };
}

function providerSnapshotSignature(
  context: NativeCompletionApiContext,
  provider: ProviderConfig,
): string {
  return computeCompletionRequestTargetSignature(provider, {
    modelId: context.model.id,
    requestTarget: completionUrl(context, provider),
  });
}

async function resolveRequestSnapshot(
  context: NativeCompletionApiContext,
): Promise<{ provider: ProviderConfig; credential: AuthTokenInfo }> {
  const expectedSignature = providerSnapshotSignature(
    context,
    context.provider,
  );
  const before = context.resolveProvider?.() ?? context.provider;
  if (providerSnapshotSignature(context, before) !== expectedSignature) {
    throw new Error(
      'Authentication configuration changed while the completion request was starting. Please retry.',
    );
  }
  const credential = await context.resolveCredential();
  const after = context.resolveProvider?.() ?? context.provider;
  if (providerSnapshotSignature(context, after) !== expectedSignature) {
    throw new Error(
      'Authentication configuration changed while the completion request was starting. Please retry.',
    );
  }
  return { provider: context.provider, credential };
}

function completionUrl(
  context: NativeCompletionApiContext,
  provider: ProviderConfig,
): string {
  const baseUrl = buildCompletionBaseUrl(
    { ...context, provider },
    {
      ensureSuffix: '/v1',
      skipSuffixIfMatch: /\/v\d+$/,
      useRawBaseUrl: isRawBaseUrlEnabled(provider),
    },
  );
  return `${baseUrl}/completions`;
}

function createFimOperation(
  context: NativeCompletionApiContext,
): CompletionApiOperation<'fim'> {
  return {
    async execute(request, token) {
      return await runNativeCompletionOperation(
        context,
        request.kind,
        token,
        async (logger) => {
          const { provider, credential } =
            await resolveRequestSnapshot(context);
          const payload = await postCompletionJson(
            completionUrl(context, provider),
            buildOpenAIFimRequestBody(
              provider,
              context.model,
              request,
            ),
            provider,
            context.model,
            credential,
            token,
            logger,
          );
          return parseOpenAICompletionsResponse(
            payload,
            buildEffectiveStops(request.options.stop),
          );
        },
      );
    },
  };
}

function createCodeGemmaOperation(
  context: NativeCompletionApiContext,
): CompletionApiOperation<'codegemma'> {
  return {
    async execute(request, token) {
      return await runNativeCompletionOperation(
        context,
        request.kind,
        token,
        async (logger) => {
          const { provider, credential } =
            await resolveRequestSnapshot(context);
          const payload = await postCompletionJson(
            completionUrl(context, provider),
            buildOpenAICodeGemmaRequestBody(
              provider,
              context.model,
              request,
            ),
            provider,
            context.model,
            credential,
            token,
            logger,
          );
          return parseOpenAICompletionsResponse(
            payload,
            buildEffectiveStops(request.options.stop),
          );
        },
      );
    },
  };
}

async function executeZeta(
  context: NativeCompletionApiContext,
  request: ZetaCompletionRequest,
  token: Parameters<CompletionApiOperation<'zeta1'>['execute']>[1],
): Promise<BufferedCompletionResponse> {
  return await runWithCompletionConcurrency(
    `openai-zeta:${context.provider.name}:${context.model.id}`,
    2,
    token,
    () =>
      runNativeCompletionOperation(
        context,
        request.kind,
        token,
        async (logger) => {
      const { provider, credential } = await resolveRequestSnapshot(context);
      const prompt = buildZetaPrompt(request);
      const payload = await postCompletionJson(
        completionUrl(context, provider),
        buildOpenAIZetaRequestBody(
          provider,
          context.model,
          request,
          prompt,
        ),
        provider,
        context.model,
        credential,
        token,
        logger,
      );
      return parseOpenAIZetaResponse(payload, request, prompt);
        },
      ),
  );
}

function createZeta1Operation(
  context: NativeCompletionApiContext,
): CompletionApiOperation<'zeta1'> {
  return { execute: (request, token) => executeZeta(context, request, token) };
}

function createZeta2Operation(
  context: NativeCompletionApiContext,
): CompletionApiOperation<'zeta2'> {
  return { execute: (request, token) => executeZeta(context, request, token) };
}

function createZeta21Operation(
  context: NativeCompletionApiContext,
): CompletionApiOperation<'zeta2.1'> {
  return { execute: (request, token) => executeZeta(context, request, token) };
}

export function createOpenAICompletionsApiProvider(
  context: NativeCompletionApiContext,
): CompletionApiProvider {
  return createNativeCompletionApiProvider(
    OPENAI_COMPLETIONS_PROVIDER_DEFINITION,
    context,
  );
}

export const OPENAI_COMPLETIONS_PROVIDER_DEFINITION =
  defineNativeCompletionApiProvider({
    capabilities: OPENAI_COMPLETIONS_CAPABILITIES,
    operationFactories: {
      fim: createFimOperation,
      codegemma: createCodeGemmaOperation,
      zeta1: createZeta1Operation,
      zeta2: createZeta2Operation,
      'zeta2.1': createZeta21Operation,
    },
  });

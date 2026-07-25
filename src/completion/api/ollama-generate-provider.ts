import { getBaseModelId } from '../../model-id-utils';
import type { ModelConfig, ProviderConfig } from '../../types';
import { isRawBaseUrlEnabled } from '../../utils';
import { isRecord } from '../configuration';
import type {
  CodeGemmaCompletionRequest,
  FimCompletionRequest,
  ZetaCompletionRequest,
} from '../model/requests';
import type { BufferedCompletionResponse } from '../model/responses';
import { buildCodeGemmaPrompt } from '../template/codegemma';
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

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function modelOptions(model: ModelConfig): Record<string, unknown> {
  return {
    ...(model.maxOutputTokens === undefined
      ? {}
      : { num_predict: model.maxOutputTokens }),
    ...(model.temperature === undefined
      ? {}
      : { temperature: model.temperature }),
    ...(model.topK === undefined ? {} : { top_k: model.topK }),
    ...(model.topP === undefined ? {} : { top_p: model.topP }),
    ...(model.frequencyPenalty === undefined
      ? {}
      : { frequency_penalty: model.frequencyPenalty }),
    ...(model.presencePenalty === undefined
      ? {}
      : { presence_penalty: model.presencePenalty }),
  };
}

function splitExtraBody(
  provider: ProviderConfig,
  model: ModelConfig,
): { body: Record<string, unknown>; options: Record<string, unknown> } {
  const providerBody = provider.extraBody ?? {};
  const modelBody = model.extraBody ?? {};
  const body = omitRequestBodyFields(
    { ...providerBody, ...modelBody },
    [
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
    ],
  );
  return {
    body,
    options: omitRequestBodyFields(
      {
        ...modelOptions(model),
        ...(isObject(providerBody.options) ? providerBody.options : {}),
        ...(isObject(modelBody.options) ? modelBody.options : {}),
      },
      ['stop', 'prediction'],
    ),
  };
}

export function buildOllamaFimRequestBody(
  provider: ProviderConfig,
  model: ModelConfig,
  request: FimCompletionRequest,
): Record<string, unknown> {
  const extra = splitExtraBody(provider, model);
  return {
    ...extra.body,
    model: getBaseModelId(model.id),
    prompt: request.prefix,
    suffix: request.suffix,
    raw: false,
    options: {
      ...extra.options,
      ...(request.options.maxTokens === undefined
        ? {}
        : { num_predict: request.options.maxTokens }),
      stop: [...buildEffectiveStops(request.options.stop)],
    },
    stream: false,
  };
}

export function buildOllamaCodeGemmaRequestBody(
  provider: ProviderConfig,
  model: ModelConfig,
  request: CodeGemmaCompletionRequest,
): Record<string, unknown> {
  const extra = splitExtraBody(provider, model);
  return {
    ...extra.body,
    model: getBaseModelId(model.id),
    prompt: buildCodeGemmaPrompt(request),
    raw: true,
    options: {
      ...extra.options,
      ...(request.options.maxTokens === undefined
        ? {}
        : { num_predict: request.options.maxTokens }),
      stop: [...buildEffectiveStops(request.options.stop)],
    },
    stream: false,
  };
}

export function buildOllamaZetaRequestBody(
  provider: ProviderConfig,
  model: ModelConfig,
  request: ZetaCompletionRequest,
  prompt: ZetaPrompt = buildZetaPrompt(request),
): Record<string, unknown> {
  const extra = splitExtraBody(provider, model);
  return {
    ...omitRequestBodyFields(extra.body, [
      'temperature',
      'max_tokens',
      'max_completion_tokens',
      'n',
    ]),
    model: getBaseModelId(model.id),
    prompt: prompt.prompt,
    raw: true,
    options: {
      ...omitRequestBodyFields(extra.options, [
        'temperature',
        'num_predict',
        'stop',
      ]),
      ...(request.options.maxTokens === undefined
        ? {}
        : { num_predict: request.options.maxTokens }),
      stop: [...prompt.stops],
    },
    stream: false,
  };
}

export function parseOllamaGenerateResponse(
  payload: unknown,
  effectiveStops: readonly string[],
): BufferedCompletionResponse {
  if (!isRecord(payload) || typeof payload.response !== 'string') {
    throw new CompletionRuntimeError(
      'completion-invalid-response',
      'Ollama Generate returned an invalid response.',
    );
  }
  return {
    mode: 'buffered',
    choices: [
      {
        text: postprocessNativeCompletionText(
          payload.response,
          effectiveStops,
        ),
        ...(typeof payload.done_reason === 'string'
          ? { finishReason: payload.done_reason }
          : {}),
      },
    ],
    usage: payload,
  };
}

export function parseOllamaZetaResponse(
  payload: unknown,
  request: ZetaCompletionRequest,
  prompt: ZetaPrompt,
): BufferedCompletionResponse {
  if (!isRecord(payload) || typeof payload.response !== 'string') {
    throw new CompletionRuntimeError(
      'completion-invalid-response',
      'Ollama Generate returned an invalid Zeta response.',
    );
  }
  return {
    mode: 'buffered',
    choices: [
      {
        text: parseZetaOutput(request.kind, payload.response, prompt),
        ...(typeof payload.done_reason === 'string'
          ? { finishReason: payload.done_reason }
          : {}),
      },
    ],
    usage: payload,
    edit: {
      targetUri: request.document.uri,
      startOffset: prompt.editableStart,
      endOffset: prompt.editableEnd,
    },
  };
}

function completionUrl(context: NativeCompletionApiContext): string {
  const baseUrl = buildCompletionBaseUrl(context, {
    stripPattern: /\/api$/i,
    useRawBaseUrl: isRawBaseUrlEnabled(context.provider),
  });
  return `${baseUrl}/api/generate`;
}

const SINGLE_RESULT_CAPABILITY = {
  responseMode: 'buffered',
  multiCandidateSupport: 'single-result-only',
} as const;

export const OLLAMA_GENERATE_CAPABILITIES = {
  fim: SINGLE_RESULT_CAPABILITY,
  codegemma: SINGLE_RESULT_CAPABILITY,
  zeta1: SINGLE_RESULT_CAPABILITY,
  zeta2: SINGLE_RESULT_CAPABILITY,
  'zeta2.1': SINGLE_RESULT_CAPABILITY,
} as const satisfies CompletionApiCapabilities;

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
          const credential = await context.resolveCredential();
          const payload = await postCompletionJson(
            completionUrl(context),
            buildOllamaFimRequestBody(
              context.provider,
              context.model,
              request,
            ),
            context.provider,
            context.model,
            credential,
            token,
            logger,
          );
          return parseOllamaGenerateResponse(
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
          const credential = await context.resolveCredential();
          const payload = await postCompletionJson(
            completionUrl(context),
            buildOllamaCodeGemmaRequestBody(
              context.provider,
              context.model,
              request,
            ),
            context.provider,
            context.model,
            credential,
            token,
            logger,
          );
          return parseOllamaGenerateResponse(
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
    `ollama-zeta:${context.provider.name}:${context.model.id}`,
    1,
    token,
    () =>
      runNativeCompletionOperation(
        context,
        request.kind,
        token,
        async (logger) => {
      const credential = await context.resolveCredential();
      const prompt = buildZetaPrompt(request);
      const payload = await postCompletionJson(
        completionUrl(context),
        buildOllamaZetaRequestBody(
          context.provider,
          context.model,
          request,
          prompt,
        ),
        context.provider,
        context.model,
        credential,
        token,
        logger,
      );
      return parseOllamaZetaResponse(payload, request, prompt);
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

export function createOllamaGenerateApiProvider(
  context: NativeCompletionApiContext,
): CompletionApiProvider {
  return createNativeCompletionApiProvider(
    OLLAMA_GENERATE_PROVIDER_DEFINITION,
    context,
  );
}

export const OLLAMA_GENERATE_PROVIDER_DEFINITION =
  defineNativeCompletionApiProvider({
    capabilities: OLLAMA_GENERATE_CAPABILITIES,
    operationFactories: {
      fim: createFimOperation,
      codegemma: createCodeGemmaOperation,
      zeta1: createZeta1Operation,
      zeta2: createZeta2Operation,
      'zeta2.1': createZeta21Operation,
    },
  });

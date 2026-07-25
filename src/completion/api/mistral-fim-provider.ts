import { getBaseModelId } from '../../model-id-utils';
import type { ModelConfig, ProviderConfig } from '../../types';
import { isRawBaseUrlEnabled } from '../../utils';
import { isRecord } from '../configuration';
import { CompletionRuntimeError } from '../model/errors';
import type { CodestralCompletionRequest } from '../model/requests';
import type {
  BufferedCompletionResponse,
  CompletionChoice,
} from '../model/responses';
import {
  codestralWindowFromRequest,
  type CodestralPromptWindow,
} from '../template/codestral';
import { postCompletionJson, runNativeCompletionOperation } from './http';
import { omitRequestBodyFields } from './request-body';
import { buildCompletionBaseUrl } from './base-url';
import type {
  CompletionApiCapabilities,
  CompletionApiOperation,
  NativeCompletionApiContext,
} from './provider';
import { defineNativeCompletionApiProvider } from './provider';

export function buildCodestralRequestBody(
  provider: ProviderConfig,
  model: ModelConfig,
  request: CodestralCompletionRequest,
  window: CodestralPromptWindow = codestralWindowFromRequest(request),
): Record<string, unknown> {
  return {
    ...omitRequestBodyFields(
      { ...(provider.extraBody ?? {}), ...(model.extraBody ?? {}) },
      [
        'model',
        'messages',
        'prompt',
        'suffix',
        'stream',
        'stream_options',
        'temperature',
        'max_tokens',
        'max_completion_tokens',
        'top_p',
      ],
    ),
    model: getBaseModelId(model.id),
    prompt: window.prompt,
    suffix: window.suffix,
    stream: false,
    top_p: 1,
    ...(request.options.maxTokens === undefined
      ? {}
      : { max_tokens: request.options.maxTokens }),
  };
}

export function parseCodestralResponse(
  payload: unknown,
): BufferedCompletionResponse {
  if (!isRecord(payload) || !Array.isArray(payload.choices)) {
    throw new CompletionRuntimeError(
      'completion-invalid-response',
      'Mistral FIM returned an invalid response.',
    );
  }
  const choices = payload.choices.map((raw): CompletionChoice => {
    const message = isRecord(raw) ? raw.message : undefined;
    if (!isRecord(message) || typeof message.content !== 'string') {
      throw new CompletionRuntimeError(
        'completion-invalid-response',
        'Mistral FIM returned an invalid choice.',
      );
    }
    return {
      text: message.content,
      ...(isRecord(raw) && typeof raw.finish_reason === 'string'
        ? { finishReason: raw.finish_reason }
        : {}),
    };
  });
  return {
    mode: 'buffered',
    choices,
    ...(payload.usage === undefined ? {} : { usage: payload.usage }),
  };
}

function completionUrl(context: NativeCompletionApiContext): string {
  const baseUrl = buildCompletionBaseUrl(context, {
    ensureSuffix: '/v1',
    skipSuffixIfMatch: /\/v\d+$/,
    useRawBaseUrl: isRawBaseUrlEnabled(context.provider),
  });
  return `${baseUrl}/completions`;
}

const CAPABILITY = {
  responseMode: 'buffered',
  multiCandidateSupport: 'single-result-only',
} as const;

export const MISTRAL_FIM_CAPABILITIES = {
  codestral: CAPABILITY,
} as const satisfies CompletionApiCapabilities;

function createCodestralOperation(
  context: NativeCompletionApiContext,
): CompletionApiOperation<'codestral'> {
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
            buildCodestralRequestBody(context.provider, context.model, request),
            context.provider,
            context.model,
            credential,
            token,
            logger,
          );
          return parseCodestralResponse(payload);
        },
      );
    },
  };
}

export const MISTRAL_FIM_PROVIDER_DEFINITION =
  defineNativeCompletionApiProvider({
    capabilities: MISTRAL_FIM_CAPABILITIES,
    operationFactories: { codestral: createCodestralOperation },
  });

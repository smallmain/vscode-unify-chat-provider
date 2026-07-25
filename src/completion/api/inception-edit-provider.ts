import { getBaseModelId } from '../../model-id-utils';
import type { ModelConfig, ProviderConfig } from '../../types';
import { isRawBaseUrlEnabled } from '../../utils';
import { isRecord } from '../configuration';
import { CompletionRuntimeError } from '../model/errors';
import type { MercuryEditCompletionRequest } from '../model/requests';
import type { BufferedCompletionResponse } from '../model/responses';
import { buildMercuryPrompt, type MercuryPrompt } from '../template/mercury';
import { postCompletionJson, runNativeCompletionOperation } from './http';
import { omitRequestBodyFields } from './request-body';
import { runWithCompletionConcurrency } from './concurrency';
import { buildCompletionBaseUrl } from './base-url';
import type {
  CompletionApiCapabilities,
  CompletionApiOperation,
  NativeCompletionApiContext,
} from './provider';
import { defineNativeCompletionApiProvider } from './provider';

export function buildMercuryEditRequestBody(
  provider: ProviderConfig,
  model: ModelConfig,
  request: MercuryEditCompletionRequest,
  prompt: MercuryPrompt = buildMercuryPrompt(request),
): Record<string, unknown> {
  return {
    ...omitRequestBodyFields(
      { ...(provider.extraBody ?? {}), ...(model.extraBody ?? {}) },
      [
        'model',
        'messages',
        'stream',
        'stream_options',
        'temperature',
        'max_tokens',
        'max_completion_tokens',
      ],
    ),
    model: getBaseModelId(model.id),
    messages: [{ role: 'user', content: prompt.prompt }],
  };
}

function unwrapMercuryEditFence(content: string): string {
  const match =
    /^[\t ]*```[^\r\n`]*\r?\n([\s\S]*?)\r?\n```[\t ]*(?:\r?\n)?$/.exec(
      content,
    );
  return match?.[1] ?? content;
}

export function parseMercuryEditResponse(
  payload: unknown,
  request: MercuryEditCompletionRequest,
  prompt: MercuryPrompt,
): BufferedCompletionResponse {
  if (!isRecord(payload) || !Array.isArray(payload.choices)) {
    throw new CompletionRuntimeError(
      'completion-invalid-response',
      'Inception Edit returned an invalid response.',
    );
  }
  const first = payload.choices[0];
  const message = isRecord(first) ? first.message : undefined;
  if (!isRecord(message) || typeof message.content !== 'string') {
    throw new CompletionRuntimeError(
      'completion-invalid-response',
      'Inception Edit returned an invalid choice.',
    );
  }
  return {
    mode: 'buffered',
    choices: [
      {
        text: unwrapMercuryEditFence(message.content),
        ...(isRecord(first) && typeof first.finish_reason === 'string'
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

export const INCEPTION_EDIT_CAPABILITIES = {
  'mercury-edit-2': CAPABILITY,
} as const satisfies CompletionApiCapabilities;

function createMercuryOperation(
  context: NativeCompletionApiContext,
): CompletionApiOperation<'mercury-edit-2'> {
  return {
    async execute(request, token) {
      return await runWithCompletionConcurrency(
        `mercury:${context.provider.name}:${context.model.id}`,
        2,
        token,
        () =>
          runNativeCompletionOperation(
            context,
            request.kind,
            token,
            async (logger) => {
          const credential = await context.resolveCredential();
          const prompt = buildMercuryPrompt(request);
          const payload = await postCompletionJson(
            completionUrl(context),
            buildMercuryEditRequestBody(
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
          return parseMercuryEditResponse(payload, request, prompt);
            },
          ),
      );
    },
  };
}

export const INCEPTION_EDIT_PROVIDER_DEFINITION =
  defineNativeCompletionApiProvider({
    capabilities: INCEPTION_EDIT_CAPABILITIES,
    operationFactories: { 'mercury-edit-2': createMercuryOperation },
  });

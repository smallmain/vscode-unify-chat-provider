import * as vscode from 'vscode';
import { randomUUID } from 'node:crypto';
import type { AuthTokenInfo, AuthTokenRefresh } from '../../auth/types';
import type { ApiProvider } from '../interface';
import type { RequestLogger } from '../../logger';
import type {
  ChatRequestTrace,
  ModelConfig,
  ProviderConfig,
} from '../../types';
import { buildZedProviderRequest } from './chat-codecs';
import { getBaseModelId } from '../../model-id-utils';
import {
  parseJsonLine,
  parseZedCompletionEnvelope,
  ZedChatEventDecoder,
} from './codecs';
import type { ZedChatChunk, ZedModelDiscoveryResult } from './types';
import { ZED_CLOUD_CLIENT_VERSION } from './types';
import { buildZedUrl, resolveZedBaseUrls } from './urls';
import {
  assertZedProviderAuth,
  createZedCloudClient,
  createZedLlmTokenSource,
} from './runtime';
import {
  rememberZedModelRoutes,
  resolveCachedZedModelRoute,
} from './route-cache';
import type { ZedLlmTokenSource } from './cloud-client';

interface ZedModelDiscoveryOptions {
  readonly signal?: AbortSignal;
}

export class ZedStreamEndedUnexpectedlyError extends Error {
  override readonly name = 'StreamEndedUnexpectedly';

  constructor(provider: string) {
    super(`Zed ${provider} completion stream ended unexpectedly.`);
  }
}

async function* responseLines(
  response: Response,
  logger: RequestLogger,
): AsyncGenerator<string> {
  if (!response.body) throw new Error('Zed completion response has no body.');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      pending += decoder.decode(value, { stream: !done });
      let newline = pending.indexOf('\n');
      while (newline >= 0) {
        const line = pending.slice(0, newline).trim();
        pending = pending.slice(newline + 1);
        if (line) {
          const payload = line.startsWith('data:') ? line.slice(5).trim() : line;
          if (payload && payload !== '[DONE]') {
            logger.providerResponseChunk(payload);
            yield payload;
          }
        }
        newline = pending.indexOf('\n');
      }
      if (done) break;
    }
    const tail = pending.trim();
    if (tail && tail !== '[DONE]') {
      const payload = tail.startsWith('data:') ? tail.slice(5).trim() : tail;
      logger.providerResponseChunk(payload);
      yield payload;
    }
  } finally {
    reader.releaseLock();
  }
}

function toVscodePart(
  chunk: Exclude<ZedChatChunk, { kind: 'status' }>,
): vscode.LanguageModelResponsePart2 {
  switch (chunk.kind) {
    case 'text':
      return new vscode.LanguageModelTextPart(chunk.text);
    case 'thinking':
      return new vscode.LanguageModelThinkingPart(
        chunk.text,
        chunk.id,
        chunk.metadata,
      );
    case 'tool_call':
      return new vscode.LanguageModelToolCallPart(
        chunk.callId,
        chunk.name,
        chunk.input,
      );
  }
}

export class ZedProvider implements ApiProvider {
  private readonly client;

  constructor(private readonly config: ProviderConfig) {
    this.client = createZedCloudClient(config);
  }

  private async discoverModelsWithTokens(
    tokens: ZedLlmTokenSource,
    organizationId: string,
    options: ZedModelDiscoveryOptions = {},
  ): Promise<ZedModelDiscoveryResult> {
    const result = await this.client.listModels(
      tokens,
      organizationId,
      {
        signal: options.signal,
        onUnknownProvider: (modelId, provider) => {
          console.warn(
            `[unify-chat-provider] Skipping Zed model ${modelId}: unsupported upstream provider ${String(provider)}.`,
          );
        },
      },
    );
    rememberZedModelRoutes(this.config, organizationId, result.routes);
    return result;
  }

  private async discoverModels(
    credential: AuthTokenInfo,
    refreshCredential?: AuthTokenRefresh,
    options: ZedModelDiscoveryOptions = {},
  ): Promise<ZedModelDiscoveryResult> {
    const organizationId = assertZedProviderAuth(this.config);
    return this.discoverModelsWithTokens(
      createZedLlmTokenSource(credential, refreshCredential),
      organizationId,
      options,
    );
  }

  async getAvailableModels(
    credential: AuthTokenInfo,
    refreshCredential?: AuthTokenRefresh,
  ): Promise<ModelConfig[]> {
    const models = (await this.discoverModels(credential, refreshCredential))
      .models;
    return models.some((model) => model.id === 'zeta-cloud')
      ? models
      : [{ id: 'zeta-cloud' }, ...models];
  }

  async *streamChat(
    _encodedModelId: string,
    model: ModelConfig,
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    options: vscode.ProvideLanguageModelChatResponseOptions,
    requestTrace: ChatRequestTrace,
    token: vscode.CancellationToken,
    logger: RequestLogger,
    credential: AuthTokenInfo,
    refreshCredential?: AuthTokenRefresh,
  ): AsyncGenerator<vscode.LanguageModelResponsePart2> {
    const organizationId = assertZedProviderAuth(this.config);
    if (token.isCancellationRequested) return;
    const controller = new AbortController();
    const cancellation = token.onCancellationRequested(() => controller.abort());
    try {
      const tokens = createZedLlmTokenSource(credential, refreshCredential);
      const baseModelId = getBaseModelId(model.id);
      let route = resolveCachedZedModelRoute(
        this.config,
        organizationId,
        baseModelId,
      );
      if (!route) {
        await this.discoverModelsWithTokens(
          tokens,
          organizationId,
          { signal: controller.signal },
        );
        route = resolveCachedZedModelRoute(
          this.config,
          organizationId,
          baseModelId,
        );
      }
      if (!route) {
        throw new Error(
          `Zed model route is unavailable for ${baseModelId} in organization ${organizationId}.`,
        );
      }
      const threadId = randomUUID();
      const promptId = randomUUID();
      const providerRequest = buildZedProviderRequest(
        route.upstreamProvider,
        model,
        messages,
        options,
        { threadId },
      );
      const body = {
        thread_id: threadId,
        prompt_id: promptId,
        provider: route.upstreamProvider,
        model: baseModelId,
        provider_request: providerRequest,
      };
      const endpoint = buildZedUrl(
        resolveZedBaseUrls(this.config.baseUrl).cloud,
        '/completions',
      );
      logger.providerRequest({
        endpoint,
        method: 'POST',
        headers: {
          Authorization: 'Bearer [ZED_LLM_TOKEN]',
          'Content-Type': 'application/json',
          'x-zed-version': ZED_CLOUD_CLIENT_VERSION,
          'x-zed-client-supports-status-messages': 'true',
          'x-zed-client-supports-stream-ended-request-completion-status': 'true',
        },
        body,
      });
      const startedFetchAt = Date.now();
      const result = await this.client.complete(
        tokens,
        body,
        controller.signal,
        model.extraHeaders,
      );
      requestTrace.performance.ttf = Date.now() - startedFetchAt;
      logger.providerResponseMeta(result.response);

      let sawOutput = false;
      let sawStreamEnded = false;
      const decoder = new ZedChatEventDecoder(route.upstreamProvider);
      for await (const line of responseLines(result.response, logger)) {
        const raw = parseJsonLine(line, 'completion stream event');
        let event: unknown = raw;
        if (result.includesStatusMessages) {
          const envelope = parseZedCompletionEnvelope<unknown>(raw);
          if (envelope.kind === 'status') {
            if (envelope.status.kind === 'failed') {
              throw new Error(
                `Zed completion failed (${envelope.status.code}): ${envelope.status.message}`,
              );
            }
            if (envelope.status.kind === 'stream_ended') {
              sawStreamEnded = true;
            }
            continue;
          }
          event = envelope.event;
        }
        for (const chunk of decoder.decode(event)) {
          if (chunk.kind === 'status') continue;
          if (!sawOutput) {
            sawOutput = true;
            requestTrace.performance.ttft =
              Date.now() - requestTrace.performance.tts;
          }
          const part = toVscodePart(chunk);
          logger.vscodeOutput(part);
          yield part;
        }
      }
      if (!sawStreamEnded) {
        throw new ZedStreamEndedUnexpectedlyError(route.upstreamProvider);
      }
      for (const chunk of decoder.finish()) {
        if (chunk.kind === 'status') continue;
        if (!sawOutput) {
          sawOutput = true;
          requestTrace.performance.ttft =
            Date.now() - requestTrace.performance.tts;
        }
        const part = toVscodePart(chunk);
        logger.vscodeOutput(part);
        yield part;
      }
    } finally {
      cancellation.dispose();
    }
  }

  estimateTokenCount(text: string): number {
    return Math.ceil(text.length / 4);
  }
}

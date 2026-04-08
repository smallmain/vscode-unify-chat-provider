import type {
  CancellationToken,
  LanguageModelChatRequestMessage,
  LanguageModelResponsePart2,
  ProvideLanguageModelChatResponseOptions,
} from 'vscode';
import * as vscode from 'vscode';
import type { AuthTokenInfo } from '../../auth/types';
import type { RequestLogger } from '../../logger';
import { getBaseModelId } from '../../model-id-utils';
import type {
  ModelConfig,
  PerformanceTrace,
  ProviderConfig,
} from '../../types';
import { isImageMarker } from '../../utils';
import type { ApiProvider } from '../interface';
import { buildBaseUrl } from '../utils';
import { OpenAIChatCompletionProvider } from '../openai/chat-completion-client';
import { OpenAIResponsesProvider } from '../openai/responses-client';
import type { ChatCompletionChunk } from 'openai/resources/chat/completions';
import type { ChatCompletionSnapshot } from 'openai/lib/ChatCompletionStream';
import type { ResponseCreateParamsBase } from 'openai/resources/responses/responses';
import { buildOpencodeUserAgent } from '../../utils';

function resolveCopilotApiBaseUrl(config: ProviderConfig): string {
  const normalized = buildBaseUrl(config.baseUrl, { stripPattern: /\/v1$/ });

  const auth = config.auth;
  const enterpriseDomain =
    auth?.method === 'github-copilot' ? auth.enterpriseUrl?.trim() : undefined;

  const baseUrl =
    enterpriseDomain && normalized === 'https://api.githubcopilot.com'
      ? buildBaseUrl(`https://copilot-api.${enterpriseDomain}`, {
          stripPattern: /\/v1$/,
        })
      : normalized;

  // Auto-switch to the enterprise Copilot base URL when user has configured
  // enterprise auth but still uses the default github.com base URL.
  return buildBaseUrl(baseUrl, {
    ensureSuffix: '/v1',
    skipSuffixIfMatch: /\/v\d+$/,
  });
}

function shouldUseResponsesApi(modelId: string): boolean {
  const baseId = getBaseModelId(modelId);
  if (baseId.startsWith('gpt-5-mini')) {
    return false;
  }

  const match = /^gpt-(\d+)(?:[.-]|$)/.exec(baseId);
  if (!match) {
    return false;
  }

  const major = Number(match[1]);
  return Number.isFinite(major) && major >= 5;
}

type CopilotInitiator = 'user' | 'agent';

function normalizeCopilotToolCallIndices(
  chunk: ChatCompletionChunk,
): ChatCompletionChunk {
  let changed = false;

  const choices = chunk.choices.map((choice) => {
    const delta = choice.delta;
    const toolCalls = delta?.tool_calls;
    if (!toolCalls || toolCalls.length === 0) {
      return choice;
    }

    const indices = toolCalls
      .map((call) => call.index)
      .filter((n): n is number => typeof n === 'number' && Number.isFinite(n));

    if (indices.length === 0) {
      return choice;
    }

    // Copilot streams tool_calls with 1-based indices (starting from 1), and may emit
    // chunks that only contain higher indices (e.g. index=2/3) without repeating index=1.
    // Normalize to 0-based indices so downstream accumulation doesn't produce sparse arrays.
    //
    // Heuristic: if we ever see index=0, assume it's already 0-based and do nothing.
    const hasZero = indices.includes(0);
    if (hasZero) {
      return choice;
    }

    changed = true;

    const normalizedToolCalls = toolCalls.map((call) => ({
      ...call,
      index: call.index > 0 ? call.index - 1 : call.index,
    }));

    return {
      ...choice,
      delta: {
        ...delta,
        tool_calls: normalizedToolCalls,
      },
    };
  });

  return changed ? { ...chunk, choices } : chunk;
}

function isToolResultPart(
  part: unknown,
): part is
  | vscode.LanguageModelToolResultPart
  | vscode.LanguageModelToolResultPart2 {
  return (
    part instanceof vscode.LanguageModelToolResultPart ||
    part instanceof vscode.LanguageModelToolResultPart2
  );
}

function containsImagePart(part: unknown): boolean {
  if (part instanceof vscode.LanguageModelDataPart) {
    return isImageMarker(part);
  }

  if (isToolResultPart(part)) {
    return part.content.some(containsImagePart);
  }

  return false;
}

function hasVisionRequest(
  messages: readonly LanguageModelChatRequestMessage[],
): boolean {
  for (const message of messages) {
    if (message.content.some(containsImagePart)) {
      return true;
    }
  }
  return false;
}

function inferInitiator(
  messages: readonly LanguageModelChatRequestMessage[],
): CopilotInitiator {
  const last = messages.at(-1);
  if (!last) {
    return 'user';
  }

  if (last.role === vscode.LanguageModelChatMessageRole.Assistant) {
    return 'agent';
  }

  if (last.role === vscode.LanguageModelChatMessageRole.User) {
    const hasToolResult = last.content.some(isToolResultPart);
    return hasToolResult ? 'agent' : 'user';
  }

  return 'user';
}

function applyCopilotHeaders(options: {
  headers: Record<string, string>;
  credential?: AuthTokenInfo;
  messages?: readonly LanguageModelChatRequestMessage[];
}): void {
  const headers = options.headers;

  for (const key of Object.keys(headers)) {
    const lower = key.toLowerCase();
    if (
      lower === 'x-api-key' ||
      lower === 'authorization' ||
      lower === 'user-agent'
    ) {
      delete headers[key];
    }
  }

  const token =
    options.credential?.kind === 'token' ? options.credential.token : undefined;
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  headers['User-Agent'] = buildOpencodeUserAgent();
  headers['Openai-Intent'] = 'conversation-edits';

  if (options.messages) {
    headers['x-initiator'] = inferInitiator(options.messages);

    if (hasVisionRequest(options.messages)) {
      headers['Copilot-Vision-Request'] = 'true';
    }
  }
}

class GitHubCopilotChatCompletionProvider extends OpenAIChatCompletionProvider {
  protected override resolveBaseUrl(config: ProviderConfig): string {
    return resolveCopilotApiBaseUrl(config);
  }

  override accumulateChatCompletion(
    snapshot: ChatCompletionSnapshot | undefined,
    chunk: ChatCompletionChunk,
  ): ChatCompletionSnapshot {
    return super.accumulateChatCompletion(
      snapshot,
      normalizeCopilotToolCallIndices(chunk),
    );
  }

  protected override buildHeaders(
    credential?: AuthTokenInfo,
    modelConfig?: ModelConfig,
    messages?: readonly LanguageModelChatRequestMessage[],
  ): Record<string, string> {
    const headers = super.buildHeaders(credential, modelConfig, messages);
    applyCopilotHeaders({ headers, credential, messages });
    return headers;
  }
}

class GitHubCopilotResponsesProvider extends OpenAIResponsesProvider {
  protected override resolveBaseUrl(config: ProviderConfig): string {
    return resolveCopilotApiBaseUrl(config);
  }

  protected override handleRequest(
    sessionId: string,
    baseBody: ResponseCreateParamsBase,
  ): void {
    super.handleRequest(sessionId, baseBody);
    baseBody.store ??= false;
  }

  protected override buildHeaders(
    sessionId: string,
    credential?: AuthTokenInfo,
    modelConfig?: ModelConfig,
    messages?: readonly LanguageModelChatRequestMessage[],
  ): Record<string, string> {
    const headers = super.buildHeaders(
      sessionId,
      credential,
      modelConfig,
      messages,
    );
    applyCopilotHeaders({ headers, credential, messages });
    return headers;
  }
}

export class GitHubCopilotProvider implements ApiProvider {
  private readonly providerConfig: ProviderConfig;
  private readonly chatProvider: GitHubCopilotChatCompletionProvider;
  private readonly responsesProvider: GitHubCopilotResponsesProvider;

  private assertCopilotAuth(): void {
    if (this.providerConfig.auth?.method !== 'github-copilot') {
      throw new Error(
        'GitHub Copilot provider requires auth method "github-copilot".',
      );
    }
  }

  constructor(config: ProviderConfig) {
    const extraBody = config.extraBody ?? {};
    const hasStore =
      config.store !== undefined ||
      Object.prototype.hasOwnProperty.call(extraBody, 'store');
    const configWithDefaults: ProviderConfig = hasStore
      ? config
      : { ...config, extraBody: { ...extraBody, store: false } };
    this.providerConfig = configWithDefaults;

    this.chatProvider = new GitHubCopilotChatCompletionProvider(
      configWithDefaults,
    );
    this.responsesProvider = new GitHubCopilotResponsesProvider(
      configWithDefaults,
    );
  }

  async *streamChat(
    encodedModelId: string,
    model: ModelConfig,
    messages: readonly LanguageModelChatRequestMessage[],
    options: ProvideLanguageModelChatResponseOptions,
    performanceTrace: PerformanceTrace,
    token: CancellationToken,
    logger: RequestLogger,
    credential: AuthTokenInfo,
  ): AsyncGenerator<LanguageModelResponsePart2> {
    this.assertCopilotAuth();
    const provider = shouldUseResponsesApi(model.id)
      ? this.responsesProvider
      : this.chatProvider;

    yield* provider.streamChat(
      encodedModelId,
      model,
      messages,
      options,
      performanceTrace,
      token,
      logger,
      credential,
    );
  }

  estimateTokenCount(text: string): number {
    return this.chatProvider.estimateTokenCount(text);
  }

  async getAvailableModels(credential: AuthTokenInfo): Promise<ModelConfig[]> {
    this.assertCopilotAuth();
    const chatResult = await this.chatProvider.getAvailableModels(credential);
    const responsesResult =
      await this.responsesProvider.getAvailableModels(credential);

    const allModels = [...chatResult, ...responsesResult];
    const uniqueModels: ModelConfig[] = [];
    const seenIds = new Set<string>();

    for (const model of allModels) {
      if (!seenIds.has(model.id)) {
        seenIds.add(model.id);
        uniqueModels.push(model);
      }
    }

    return uniqueModels;
  }
}

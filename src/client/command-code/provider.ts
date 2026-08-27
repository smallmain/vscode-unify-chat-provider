import type {
  CancellationToken,
  LanguageModelChatRequestMessage,
  LanguageModelResponsePart2,
  ProvideLanguageModelChatResponseOptions,
} from 'vscode';
import type { AuthTokenInfo, AuthTokenRefresh } from '../../auth/types';
import { createSimpleHttpLogger } from '../../logger';
import type { RequestLogger } from '../../logger';
import type { ChatRequestTrace, ModelConfig, ProviderConfig } from '../../types';
import {
  DEFAULT_NORMAL_TIMEOUT_CONFIG,
  resolveChatNetwork,
} from '../../utils';
import { AnthropicProvider } from '../anthropic/client';
import type {
  ApiProvider,
  EmptyChatResponsePolicy,
} from '../interface';
import { OpenAIChatCompletionProvider } from '../openai/chat-completion-client';
import {
  createCustomFetch,
  getToken,
  getTokenType,
  getUnifiedUserAgent,
  mergeHeaders,
  setUserAgentHeader,
} from '../utils';
import { resolveCommandCodeProtocol } from './protocol';
export {
  resolveCommandCodeProtocol,
  type CommandCodeProtocol,
} from './protocol';

export const COMMAND_CODE_API_BASE_URL =
  'https://api.commandcode.ai/provider/v1';
export const COMMAND_CODE_MODELS_URL = `${COMMAND_CODE_API_BASE_URL}/models`;
export const COMMAND_CODE_MESSAGES_URL = `${COMMAND_CODE_API_BASE_URL}/messages`;
export const COMMAND_CODE_CHAT_COMPLETIONS_URL =
  `${COMMAND_CODE_API_BASE_URL}/chat/completions`;

export interface CommandCodeDelegateConfigs {
  readonly anthropic: ProviderConfig;
  readonly openAI: ProviderConfig;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requireNonEmptyString(
  record: Record<string, unknown>,
  key: string,
  location: string,
): string {
  const value = record[key];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(
      `Failed to get available models: ${location}.${key} must be a non-empty string`,
    );
  }
  return value.trim();
}

function requireNonNegativeInteger(
  record: Record<string, unknown>,
  key: string,
  location: string,
): number {
  const value = record[key];
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    throw new Error(
      `Failed to get available models: ${location}.${key} must be a non-negative integer`,
    );
  }
  return value;
}

function requirePositiveInteger(
  record: Record<string, unknown>,
  key: string,
  location: string,
): number {
  const value = record[key];
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value <= 0
  ) {
    throw new Error(
      `Failed to get available models: ${location}.${key} must be a positive integer`,
    );
  }
  return value;
}

export function parseCommandCodeModelsResponse(raw: unknown): ModelConfig[] {
  if (!isRecord(raw) || raw['object'] !== 'list' || !Array.isArray(raw['data'])) {
    throw new Error(
      'Failed to get available models: unexpected Command Code catalog response',
    );
  }

  return raw['data'].map((value, index) => {
    const location = `data[${index}]`;
    if (!isRecord(value) || value['object'] !== 'model') {
      throw new Error(
        `Failed to get available models: ${location}.object must be "model"`,
      );
    }

    const id = requireNonEmptyString(value, 'id', location);
    const name = requireNonEmptyString(value, 'name', location);
    requireNonNegativeInteger(value, 'created', location);
    requireNonEmptyString(value, 'owned_by', location);
    const contextLength = requirePositiveInteger(
      value,
      'context_length',
      location,
    );

    return {
      id,
      name,
      maxInputTokens: contextLength,
    };
  });
}

export function createCommandCodeDelegateConfigs(
  config: ProviderConfig,
): CommandCodeDelegateConfigs {
  const shared: ProviderConfig = {
    ...config,
    baseUrl: COMMAND_CODE_API_BASE_URL,
    useRawBaseUrl: false,
  };
  return {
    anthropic: { ...shared, type: 'anthropic' },
    openAI: { ...shared, type: 'openai-chat-completion' },
  };
}

export class CommandCodeProvider implements ApiProvider {
  private readonly providerConfig: ProviderConfig;
  private readonly anthropicProvider: ApiProvider;
  private readonly openAIProvider: ApiProvider;

  constructor(config: ProviderConfig) {
    const delegateConfigs = createCommandCodeDelegateConfigs(config);
    this.providerConfig = {
      ...config,
      baseUrl: COMMAND_CODE_API_BASE_URL,
      useRawBaseUrl: false,
    };
    this.anthropicProvider = new AnthropicProvider(delegateConfigs.anthropic);
    this.openAIProvider = new OpenAIChatCompletionProvider(
      delegateConfigs.openAI,
    );
  }

  getEmptyChatResponsePolicy(model: ModelConfig): EmptyChatResponsePolicy {
    return resolveCommandCodeProtocol(model) === 'anthropic-messages'
      ? 'success'
      : 'retry';
  }

  async *streamChat(
    encodedModelId: string,
    model: ModelConfig,
    messages: readonly LanguageModelChatRequestMessage[],
    options: ProvideLanguageModelChatResponseOptions,
    requestTrace: ChatRequestTrace,
    token: CancellationToken,
    logger: RequestLogger,
    credential: AuthTokenInfo,
    refreshCredential?: AuthTokenRefresh,
  ): AsyncGenerator<LanguageModelResponsePart2> {
    const provider =
      resolveCommandCodeProtocol(model) === 'anthropic-messages'
        ? this.anthropicProvider
        : this.openAIProvider;
    yield* provider.streamChat(
      encodedModelId,
      model,
      messages,
      options,
      requestTrace,
      token,
      logger,
      credential,
      refreshCredential,
    );
  }

  estimateTokenCount(text: string): number {
    return this.openAIProvider.estimateTokenCount(text);
  }

  async getAvailableModels(
    credential: AuthTokenInfo,
    _refreshCredential?: AuthTokenRefresh,
    signal?: AbortSignal,
  ): Promise<ModelConfig[]> {
    const logger = createSimpleHttpLogger({
      purpose: 'Get Available Models',
      providerName: this.providerConfig.name,
      providerType: this.providerConfig.type,
    });
    const network = resolveChatNetwork(this.providerConfig);
    const timeout = network.timeout ?? DEFAULT_NORMAL_TIMEOUT_CONFIG;
    const fetchWithNetwork = createCustomFetch({
      connectionTimeoutMs: timeout.connection,
      responseTimeoutMs: timeout.response,
      logger,
      retryConfig: network.retry,
      proxy: network.proxy,
      type: 'normal',
    });
    const token = getToken(credential);
    const headers = mergeHeaders(token, this.providerConfig.extraHeaders);
    headers['Accept'] = 'application/json';
    setUserAgentHeader(headers, getUnifiedUserAgent());
    if (token) {
      headers['Authorization'] =
        `${getTokenType(credential) ?? 'Bearer'} ${token}`;
    }

    try {
      const response = await fetchWithNetwork(COMMAND_CODE_MODELS_URL, {
        method: 'GET',
        headers,
        signal,
      });
      if (!response.ok) {
        throw new Error(
          `Failed to get available models: HTTP ${response.status}`,
        );
      }
      const raw: unknown = await response.json();
      return parseCommandCodeModelsResponse(raw);
    } catch (error) {
      logger.error(error);
      throw error;
    }
  }
}

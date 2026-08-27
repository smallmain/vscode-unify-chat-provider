import type {
  CancellationToken,
  LanguageModelChatRequestMessage,
  LanguageModelResponsePart2,
  ProvideLanguageModelChatResponseOptions,
} from 'vscode';
import type { ChatRequestTrace, ModelConfig, ProviderConfig } from '../types';
import type { RequestLogger } from '../logger';
import type { AuthTokenInfo, AuthTokenRefresh } from '../auth/types';
import type { ProviderType } from './definitions';

export type EmptyChatResponsePolicy = 'retry' | 'success';

export interface ProviderDefinition {
  type: ProviderType;
  label: string;
  description: string;
  /**
   * Category label used for grouping in UI (QuickPick separators).
   * Stored as an i18n key (passed through `t()` by the UI).
   */
  category: string;
  class: new (config: ProviderConfig) => ApiProvider;
  /** How a clean response stream with no public VS Code parts is handled. */
  emptyChatResponsePolicy?: EmptyChatResponsePolicy;
}

/**
 * Common interface for all API providers
 */
export interface ApiProvider {
  /**
   * Stream a chat response
   */
  streamChat(
    encodedModelId: string,
    model: ModelConfig,
    messages: readonly LanguageModelChatRequestMessage[],
    options: ProvideLanguageModelChatResponseOptions,
    requestTrace: ChatRequestTrace,
    token: CancellationToken,
    logger: RequestLogger,
    credential: AuthTokenInfo,
    refreshCredential?: AuthTokenRefresh,
  ): AsyncGenerator<LanguageModelResponsePart2>;

  /**
   * Estimate token count for text
   */
  estimateTokenCount(text: string): number;

  /**
   * Override the provider definition's empty-stream policy for a model.
   * Composite providers use this when the effective wire protocol is model-specific.
   */
  getEmptyChatResponsePolicy?(
    model: ModelConfig,
  ): EmptyChatResponsePolicy;

  /**
   * Get available models from the provider
   * Returns a list of model configurations supported by this API client
   */
  getAvailableModels?(
    credential: AuthTokenInfo,
    refreshCredential?: AuthTokenRefresh,
    signal?: AbortSignal,
  ): Promise<ModelConfig[]>;
}

export function resolveEmptyChatResponsePolicy(
  definition: Pick<ProviderDefinition, 'emptyChatResponsePolicy'>,
  provider: Pick<ApiProvider, 'getEmptyChatResponsePolicy'>,
  model: ModelConfig,
): EmptyChatResponsePolicy {
  return (
    provider.getEmptyChatResponsePolicy?.(model) ??
    definition.emptyChatResponsePolicy ??
    'retry'
  );
}

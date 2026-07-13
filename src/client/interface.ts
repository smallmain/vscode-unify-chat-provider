import type {
  CancellationToken,
  LanguageModelChatRequestMessage,
  LanguageModelResponsePart2,
  ProvideLanguageModelChatResponseOptions,
} from 'vscode';
import type { ChatRequestTrace, ModelConfig, ProviderConfig } from '../types';
import type { RequestLogger } from '../logger';
import type { AuthTokenInfo } from '../auth/types';
import { ProviderType } from './definitions';

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
  ): AsyncGenerator<LanguageModelResponsePart2>;

  /**
   * Estimate token count for text
   */
  estimateTokenCount(text: string): number;

  /**
   * Get available models from the provider
   * Returns a list of model configurations supported by this API client
   */
  getAvailableModels?(credential: AuthTokenInfo): Promise<ModelConfig[]>;

  /**
   * Get the current rate-limit status (token bucket snapshot).
   * Returns undefined when no rate limiting is configured for this provider.
   */
  getRateLimitStatus?(): { available: number; capacity: number } | undefined;

  /**
   * Acquire a token for one logical chat request, waiting if necessary.
   * Called by the service before transport selection so HTTP, SSE, and
   * WebSocket requests share the same limiter.
   */
  acquireRateLimitToken?(): Promise<void>;
}

import type {
  CancellationToken,
  LanguageModelChatRequestMessage,
  LanguageModelResponsePart2,
  ProvideLanguageModelChatResponseOptions,
} from 'vscode';
import type { ModelConfig, PerformanceTrace, ProviderConfig } from '../types';
import type { RequestLogger } from '../logger';
import { ProviderType, Mimic } from './definitions';

export interface ProviderDefinition {
  type: ProviderType;
  label: string;
  description: string;
  supportMimics: Mimic[];
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
    performanceTrace: PerformanceTrace,
    token: CancellationToken,
    logger: RequestLogger,
  ): AsyncGenerator<LanguageModelResponsePart2>;

  /**
   * Estimate token count for text
   */
  estimateTokenCount(text: string): number;

  /**
   * Get available models from the provider
   * Returns a list of model configurations supported by this API client
   */
  getAvailableModels?(): Promise<ModelConfig[]>;
}

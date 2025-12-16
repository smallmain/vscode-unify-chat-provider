import type {
  CancellationToken,
  LanguageModelChatRequestMessage,
  LanguageModelResponsePart2,
  ProvideLanguageModelChatResponseOptions,
} from 'vscode';
import type { Mimic, ProviderType } from '.';
import type { PerformanceTrace } from '../types';
import type { RequestLogger } from '../logger';

/**
 * Configuration for a single provider endpoint
 */
export interface ProviderConfig {
  /** Provider type (determines API format) */
  type: ProviderType;
  /** Unique name for this provider */
  name: string;
  /** Base URL for the API (e.g., https://api.anthropic.com) */
  baseUrl: string;
  /** API key for authentication */
  apiKey?: string;
  /** List of available model IDs */
  models: ModelConfig[];
  /** Mimic behavior */
  mimic?: Mimic;
  /** Extra headers to include in requests */
  extraHeaders?: Record<string, string>;
  /** Extra body parameters to include in requests */
  extraBody?: Record<string, unknown>;
}

/**
 * Configuration for a single model
 */
export interface ModelConfig {
  /** Model ID (e.g., claude-sonnet-4-20250514#thinking) */
  id: string;
  /** Display name for the model */
  name?: string;
  /** Model family (e.g., gpt-4, claude-3) */
  family?: string;
  /** Maximum input tokens */
  maxInputTokens?: number;
  /** Maximum output tokens */
  maxOutputTokens?: number;
  /** Model capabilities */
  capabilities?: ModelCapabilities;
  /** Whether to stream the response */
  stream?: boolean;
  /** Sampling temperature */
  temperature?: number;
  /** Top-k sampling */
  topK?: number;
  /** Top-p sampling */
  topP?: number;
  /** Frequency penalty */
  frequencyPenalty?: number;
  /** Presence penalty */
  presencePenalty?: number;
  /** Parallel tool calling (true to enable, false to disable, undefined to use default) */
  parallelToolCalling?: boolean;
  /**
   * Constrains response verbosity. Lower = concise, higher = verbose.
   * Supported values: low | medium | high.
   */
  verbosity?: 'low' | 'medium' | 'high';
  /** Thinking configuration */
  thinking?: {
    type: 'enabled' | 'disabled';
    budgetTokens?: number;
    /**
     * Thinking effort level. Leave undefined to let the provider decide.
     */
    effort?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
  };
  /**
   * Enable interleaved thinking for tool use.
   */
  interleavedThinking?: boolean;
  /**
   * Use native web search tool.
   */
  webSearch?: {
    /** Whether web search is enabled. Defaults to false. */
    enabled?: boolean;
    /** Maximum number of web searches per request. */
    maxUses?: number;
    /** Only include results from these domains. */
    allowedDomains?: string[];
    /** Never include results from these domains. */
    blockedDomains?: string[];
    /** User location for localizing search results. */
    userLocation?: {
      type: 'approximate';
      city?: string;
      region?: string;
      country?: string;
      timezone?: string;
    };
  };
  /**
   * Use native memory tool.
   */
  memoryTool?: boolean;
  /** Extra headers to include in requests */
  extraHeaders?: Record<string, string>;
  /** Extra body parameters to include in requests */
  extraBody?: Record<string, unknown>;
}

/**
 * Model capabilities configuration
 */
export interface ModelCapabilities {
  /** Whether the model supports tool/function calling. If a number is provided, it is the maximum number of tools. */
  toolCalling?: boolean | number;
  /** Whether the model supports image input */
  imageInput?: boolean;
}

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

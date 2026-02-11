import { AuthConfig } from './auth/types';
import { ProviderType } from './client/definitions';
import type { RetryConfig } from './utils';

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
  /**
   * Unified authentication configuration.
   */
  auth?: AuthConfig;
  /**
   * @deprecated Use `auth` field instead. This field is kept for configuration migration
   * and will be removed in a future version.
   */
  apiKey?: string;
  /** List of available model IDs */
  models: ModelConfig[];
  /** Extra headers to include in requests */
  extraHeaders?: Record<string, string>;
  /** Extra body parameters to include in requests */
  extraBody?: Record<string, unknown>;
  /** Timeout configuration */
  timeout?: TimeoutConfig;
  /** Retry configuration */
  retry?: RetryConfig;
  /** Whether to auto-fetch official models from the provider API */
  autoFetchOfficialModels?: boolean;
}

export type DeprecatedProviderConfigKey = 'apiKey';
export type ProviderConfigPersistedKey = Exclude<
  keyof ProviderConfig,
  DeprecatedProviderConfigKey
>;

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
  /**
   * Maximum input/context tokens (context window).
   *
   * Note: Some providers expose this as a "max context" setting (input + output)
   * rather than a strict "prompt-only" limit.
   */
  maxInputTokens?: number;
  /**
   * Maximum output tokens (generated tokens / completion).
   *
   * Some providers require this value (e.g., Anthropic `max_tokens`), while
   * others treat it as optional and apply a server-side default if omitted.
   */
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
    type: 'enabled' | 'disabled' | 'auto';
    budgetTokens?: number;
    /**
     * Thinking effort level. Leave undefined to let the provider decide.
     */
    effort?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
  };
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

/**
 * Timeout configuration for HTTP requests and SSE streams.
 * All values are in milliseconds.
 */
export interface TimeoutConfig {
  /**
   * Maximum time to wait for the TCP connection to be established.
   * Default: 60000 (60 seconds)
   */
  connection?: number;
  /**
   * Maximum time to wait between receiving data chunks during SSE streaming.
   * Resets each time new data is received (token, SSE ping, keep-alive, etc.).
   * Default: 300000 (5 minutes)
   */
  response?: number;
}

export interface PerformanceTrace {
  /**
   * Time to Start
   */
  tts: number;
  /**
   * Time to Fetch
   */
  ttf: number;
  /**
   * Time to First Token
   */
  ttft: number;
  /**
   * Tokens Per Second
   */
  tps: number;
  /**
   * Total Latency
   */
  tl: number;
}

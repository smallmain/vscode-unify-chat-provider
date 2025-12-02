/**
 * Supported provider types
 */
export type ProviderType = 'anthropic';

/**
 * Configuration for a single provider endpoint
 */
export interface ProviderConfig {
  /** Provider type (determines API format) */
  type: ProviderType;
  /** Unique name for this provider */
  name: string;
  /** Base URL for the API (e.g., https://api.anthropic.com/v1/messages) */
  baseUrl: string;
  /** API key for authentication */
  apiKey?: string;
  /** List of available model IDs */
  models: ModelConfig[];
  /** Default model ID to use */
  defaultModel?: string;
}

/**
 * Configuration for a single model
 */
export interface ModelConfig {
  /** Model ID (e.g., claude-sonnet-4-20250514) */
  id: string;
  /** Display name for the model */
  name?: string;
  /** Maximum input tokens */
  maxInputTokens?: number;
  /** Maximum output tokens */
  maxOutputTokens?: number;
}

/**
 * Extension configuration stored in workspace settings
 */
export interface ExtensionConfiguration {
  endpoints: ProviderConfig[];
}

/**
 * Anthropic API message format
 */
export interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: AnthropicContentBlock[];
}

/**
 * Anthropic content block types
 */
export type AnthropicContentBlock =
  | AnthropicTextBlock
  | AnthropicImageBlock
  | AnthropicToolUseBlock
  | AnthropicToolResultBlock;

export interface AnthropicTextBlock {
  type: 'text';
  text: string;
}

export interface AnthropicImageBlock {
  type: 'image';
  source: {
    type: 'base64';
    media_type: string;
    data: string;
  };
}

export interface AnthropicToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface AnthropicToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: string;
}

/**
 * Anthropic API request body
 */
export interface AnthropicRequest {
  model: string;
  messages: AnthropicMessage[];
  max_tokens: number;
  stream: boolean;
  system?: string;
  tools?: AnthropicTool[];
}

/**
 * Anthropic tool definition
 */
export interface AnthropicTool {
  name: string;
  description: string;
  input_schema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

/**
 * Anthropic streaming event types
 */
export type AnthropicStreamEvent =
  | { type: 'message_start'; message: { id: string; model: string } }
  | { type: 'content_block_start'; index: number; content_block: AnthropicContentBlock }
  | { type: 'content_block_delta'; index: number; delta: AnthropicDelta }
  | { type: 'content_block_stop'; index: number }
  | { type: 'message_delta'; delta: { stop_reason: string } }
  | { type: 'message_stop' }
  | { type: 'error'; error: { type: string; message: string } };

export type AnthropicDelta =
  | { type: 'text_delta'; text: string }
  | { type: 'input_json_delta'; partial_json: string };

/**
 * Common interface for all API clients
 */
export interface ApiClient {
  /**
   * Stream a chat response
   */
  streamChat(
    messages: unknown[],
    modelId: string,
    options: {
      maxTokens?: number;
      system?: string;
      tools?: unknown[];
    },
    token: import('vscode').CancellationToken
  ): AsyncGenerator<import('vscode').LanguageModelTextPart | import('vscode').LanguageModelToolCallPart>;

  /**
   * Convert VS Code messages to the client's format
   */
  convertMessages(
    messages: readonly import('vscode').LanguageModelChatMessage[]
  ): { system?: string; messages: unknown[] };

  /**
   * Convert VS Code tools to the client's format
   */
  convertTools(tools: readonly import('vscode').LanguageModelChatTool[]): unknown[];

  /**
   * Estimate token count for text
   */
  estimateTokenCount(text: string): number;
}

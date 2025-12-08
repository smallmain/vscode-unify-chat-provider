/**
 * Anthropic API type definitions
 */

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
  | AnthropicTextBlockWithCitations
  | AnthropicImageBlock
  | AnthropicToolUseBlock
  | AnthropicToolResultBlock
  | AnthropicThinkingBlock
  | AnthropicRedactedThinkingBlock
  | AnthropicServerToolUseBlock
  | AnthropicWebSearchToolResultBlock;

/**
 * Cache control definition for Anthropic prompt caching.
 */
export interface AnthropicCacheControl {
  type: 'ephemeral';
}

export interface AnthropicTextBlock {
  type: 'text';
  text: string;
  cache_control?: AnthropicCacheControl;
}

export interface AnthropicImageBlock {
  type: 'image';
  source:
    | {
        type: 'base64';
        media_type: string;
        data: string;
      }
    | {
        type: 'url';
        url: string;
      };
  cache_control?: AnthropicCacheControl;
}

export interface AnthropicToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
  cache_control?: AnthropicCacheControl;
}

export interface AnthropicToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: string | (AnthropicTextBlock | AnthropicImageBlock)[];
  is_error?: boolean;
  cache_control?: AnthropicCacheControl;
}

export interface AnthropicThinkingBlock {
  type: 'thinking';
  thinking: string;
  signature: string;
}

export interface AnthropicRedactedThinkingBlock {
  type: 'redacted_thinking';
  data: string;
}

/**
 * Server tool use block for Anthropic server-side tools like web_search
 */
export interface AnthropicServerToolUseBlock {
  type: 'server_tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

/**
 * Web search result from Anthropic's web search tool
 */
export interface AnthropicWebSearchResult {
  type: 'web_search_result';
  url: string;
  title: string;
  encrypted_content: string;
  page_age?: string;
}

/**
 * Web search tool result error
 */
export interface AnthropicWebSearchToolResultError {
  type: 'web_search_tool_result_error';
  error_code:
    | 'max_uses_exceeded'
    | 'too_many_requests'
    | 'invalid_input'
    | 'query_too_long'
    | 'unavailable';
}

/**
 * Web search tool result block
 */
export interface AnthropicWebSearchToolResultBlock {
  type: 'web_search_tool_result';
  tool_use_id: string;
  content: AnthropicWebSearchResult[] | AnthropicWebSearchToolResultError;
}

/**
 * Citation location for web search results
 */
export interface AnthropicWebSearchResultLocation {
  type: 'web_search_result_location';
  url: string;
  title: string;
  encrypted_index: string;
  cited_text: string;
}

/**
 * Citation types - can be extended for other citation sources
 */
export type AnthropicCitation = AnthropicWebSearchResultLocation;

/**
 * Text block with citations
 */
export interface AnthropicTextBlockWithCitations {
  type: 'text';
  text: string;
  citations?: AnthropicCitation[];
  cache_control?: AnthropicCacheControl;
}

/**
 * Anthropic system content block types
 */
export type AnthropicSystemContentBlock =
  | AnthropicTextBlock
  | AnthropicCacheControlSystemBlock;

export interface AnthropicCacheControlSystemBlock {
  type: 'text';
  text: string;
  cache_control: AnthropicCacheControl;
}

/**
 * Anthropic API request body
 */
export interface AnthropicRequest {
  model: string;
  messages: AnthropicMessage[];
  max_tokens: number;
  stream: boolean;
  system?: string | AnthropicSystemContentBlock[];
  tools?: AnthropicToolUnion[];
  temperature?: number;
  top_k?: number;
  top_p?: number;
  thinking?:
    | {
        type: 'enabled';
        budget_tokens: number;
      }
    | {
        type: 'disabled';
      };
  tool_choice?: {
    type: 'auto' | 'any' | 'tool' | 'none';
    name?: string;
    disable_parallel_tool_use?: boolean;
  };
  metadata?: {
    user_id: string;
  };
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
 * User location for web search localization
 */
export interface AnthropicWebSearchUserLocation {
  type: 'approximate';
  city?: string;
  region?: string;
  country?: string;
  timezone?: string;
}

/**
 * Anthropic web search server tool definition
 */
export interface AnthropicWebSearchTool {
  type: 'web_search_20250305';
  name: 'web_search';
  max_uses?: number;
  allowed_domains?: string[];
  blocked_domains?: string[];
  user_location?: AnthropicWebSearchUserLocation;
}

/**
 * Anthropic memory tool definition
 */
export interface AnthropicMemoryTool {
  type: 'memory_20250818';
  name: 'memory';
}

/**
 * Usage metrics returned by Anthropic Messages API.
 * See https://platform.claude.com/docs/en/api/messages#usage
 */
export interface AnthropicUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  cache_creation: {
    ephemeral_1h_input_tokens: number;
    ephemeral_5m_input_tokens: number;
  };
  server_tool_use: {
    web_search_requests: number;
  };
  service_tier: 'standard' | 'priority' | 'batch';
}

/**
 * Union type for all tool types in Anthropic API requests
 */
export type AnthropicToolUnion =
  | AnthropicTool
  | AnthropicWebSearchTool
  | AnthropicMemoryTool;

/**
 * Anthropic streaming event types
 */
export type AnthropicStreamEvent =
  | {
      type: 'message_start';
      message: {
        id: string;
        model: string;
        usage?: AnthropicUsage;
      };
    }
  | {
      type: 'content_block_start';
      index: number;
      content_block: AnthropicContentBlock;
    }
  | { type: 'content_block_delta'; index: number; delta: AnthropicDelta }
  | { type: 'content_block_stop'; index: number }
  | {
      type: 'message_delta';
      delta: { stop_reason: string };
      usage?: AnthropicUsage;
    }
  | {
      type: 'message_stop';
      message?: {
        usage?: AnthropicUsage;
      };
    }
  | { type: 'error'; error: { type: string; message: string } };

export type AnthropicDelta =
  | { type: 'text_delta'; text: string }
  | { type: 'input_json_delta'; partial_json: string }
  | { type: 'thinking_delta'; thinking: string }
  | { type: 'signature_delta'; signature: string }
  | { type: 'citations_delta'; citation: AnthropicCitation };

/**
 * Anthropic ListModels API response types
 */
export interface AnthropicModelInfo {
  type: 'model';
  id: string;
  display_name: string;
  created_at: string;
}

export interface AnthropicListModelsResponse {
  data: AnthropicModelInfo[];
  has_more: boolean;
  first_id: string | null;
  last_id: string | null;
}

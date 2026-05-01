/**
 * Bedrock Converse API message content block types.
 */
export interface BedrockTextBlock {
  text: string;
}

export interface BedrockToolUseBlock {
  toolUse: {
    toolUseId: string;
    name: string;
    input: Record<string, unknown>;
  };
}

export interface BedrockToolResultBlock {
  toolResult: {
    toolUseId: string;
    content: Array<{ text: string } | { json: Record<string, unknown> }>;
    status?: 'success' | 'error';
  };
}

export interface BedrockImageBlock {
  image: {
    format: 'png' | 'jpeg' | 'gif' | 'webp';
    source: {
      bytes: string; // base64 encoded
    };
  };
}

export interface BedrockCachePointBlock {
  cachePoint: {
    type: 'default';
  };
}

export type BedrockContentBlock =
  | BedrockTextBlock
  | BedrockImageBlock
  | BedrockToolUseBlock
  | BedrockToolResultBlock
  | BedrockCachePointBlock;

export interface BedrockMessage {
  role: 'user' | 'assistant';
  content: BedrockContentBlock[];
}

export interface BedrockSystemBlock {
  text: string;
}

export type BedrockSystemContentBlock =
  | BedrockSystemBlock
  | BedrockCachePointBlock;

export interface BedrockToolSpec {
  name: string;
  description?: string;
  inputSchema: {
    json: Record<string, unknown>;
  };
}

export interface BedrockToolConfig {
  tools: Array<{ toolSpec: BedrockToolSpec }>;
  toolChoice?: {
    auto?: Record<string, never>;
    any?: Record<string, never>;
    tool?: { name: string };
  };
}

export interface BedrockConverseStreamRequest {
  modelId: string;
  system?: BedrockSystemContentBlock[];
  messages: BedrockMessage[];
  inferenceConfig?: {
    maxTokens?: number;
    temperature?: number;
    topP?: number;
    topK?: number;
    stopSequences?: string[];
  };
  toolConfig?: BedrockToolConfig;
  additionalModelRequestFields?: Record<string, unknown>;
}

export interface BedrockModelSummary {
  modelArn: string;
  modelId: string;
  modelName: string;
  providerName: string;
  inputModalities: string[];
  outputModalities: string[];
  responseStreamingSupported: boolean;
  inferenceTypesSupported?: string[];
  modelLifecycle?: {
    status?: string;
  };
}

export interface BedrockUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheWriteInputTokens?: number;
}

export interface BedrockInferenceProfile {
  inferenceProfileId: string;
  inferenceProfileName: string;
  models: Array<{ modelArn: string }>;
  status: string;
}

/**
 * Buffer for accumulating streamed tool call arguments.
 */
export interface ToolCallBuffer {
  id: string;
  name: string;
  args: string;
}

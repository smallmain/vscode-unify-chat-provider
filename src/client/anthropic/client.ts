import * as vscode from 'vscode';
import {
  AnthropicMessage,
  AnthropicRequest,
  AnthropicStreamEvent,
  AnthropicTextBlock,
  AnthropicToolUseBlock,
  AnthropicToolResultBlock,
  AnthropicTool,
  AnthropicListModelsResponse,
  AnthropicContentBlock,
  AnthropicImageBlock,
  AnthropicSystemContentBlock,
  AnthropicToolUnion,
  AnthropicWebSearchTool,
  AnthropicMemoryTool,
  AnthropicServerToolUseBlock,
  AnthropicWebSearchToolResultBlock,
  AnthropicTextBlockWithCitations,
  AnthropicUsage,
} from './types';
import {
  logResponseChunk,
  logResponseComplete,
  logResponseError,
  logResponseMetadata,
  logInfo,
  startRequestLog,
} from '../../logger';
import { ApiProvider, ProviderConfig, ModelConfig } from '../interface';
import { normalizeBaseUrlInput } from '../../utils';
import { DEFAULT_MAX_OUTPUT_TOKENS } from '../../defaults';
import {
  CustomDataPartMimeTypes,
  CacheType,
  PerformanceTrace,
} from '../../types';
import { FeatureId, isFeatureSupported } from '../../features';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { WELL_KNOWN_MODELS } from '../../well-known-models';

/**
 * Client for Anthropic-compatible APIs
 */
export class AnthropicProvider implements ApiProvider {
  constructor(private readonly config: ProviderConfig) {}

  /**
   * Build request headers
   * @param betaFeatures Optional array of beta feature strings to include in anthropic-beta header
   */
  private buildHeaders(betaFeatures?: string[]): Record<string, string> {
    const headers: Record<string, string> = {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      'anthropic-version': '2023-06-01',
    };

    if (this.config.mimic === 'claude-code') {
      headers['Accept'] = 'application/json';
      headers['User-Agent'] = 'claude-cli/2.0.55 (external, cli)';
      headers['x-app'] = 'cli';
      headers['x-stainless-arch'] = 'arm64';
      headers['x-stainless-lang'] = 'js';
      headers['x-stainless-os'] = 'MacOS';
      headers['x-stainless-package-version'] = '0.70.0';
      headers['x-stainless-retry-count'] = '0';
      headers['x-stainless-runtime'] = 'node';
      headers['x-stainless-runtime-version'] = 'v20.19.6';
      headers['x-stainless-timeout'] = '600';
    }

    if (this.config.apiKey) {
      headers['x-api-key'] = this.config.apiKey;
      headers['Authorization'] = `Bearer ${this.config.apiKey}`;
    }

    // Add beta features header if any beta features are requested
    const features = new Set(betaFeatures);

    // Ensure anthropic-beta is always present for Claude Code validation
    if (this.config.mimic === 'claude-code') {
      features.add('claude-code-20250219');
      features.add('interleaved-thinking-2025-05-14');
    }

    if (features.size > 0) {
      headers['anthropic-beta'] = Array.from(features).join(',');
    }

    return headers;
  }

  /**
   * Convert VS Code messages to Anthropic format
   */
  private convertMessages(
    messages: readonly vscode.LanguageModelChatRequestMessage[],
  ): {
    system?: string | AnthropicSystemContentBlock[];
    messages: AnthropicMessage[];
  } {
    const systemBlocks: AnthropicSystemContentBlock[] = [];
    let hasSystemCacheControl = false;
    let system: string | AnthropicSystemContentBlock[] | undefined;
    const converted: AnthropicMessage[] = [];

    for (const msg of messages) {
      if (msg.role === vscode.LanguageModelChatMessageRole.User) {
        const content = this.extractContent(msg);
        if (content.length > 0) {
          converted.push({ role: 'user', content });
        }
      } else if (msg.role === vscode.LanguageModelChatMessageRole.Assistant) {
        const content = this.extractContent(msg);
        if (content.length > 0) {
          converted.push({ role: 'assistant', content });
        }
      } else if (msg.role === vscode.LanguageModelChatMessageRole.System) {
        const { blocks, hasCacheControl } = this.extractSystemContent(msg);
        if (blocks.length > 0) {
          systemBlocks.push(...blocks);
          hasSystemCacheControl = hasSystemCacheControl || hasCacheControl;
        }
      }
    }

    if (systemBlocks.length > 0) {
      if (!hasSystemCacheControl) {
        // When no cache control is present, collapse to a single string
        system = systemBlocks.map((b) => b.text).join('\n');
      } else {
        system = systemBlocks;
      }
    }

    return {
      system,
      messages: this.ensureAlternatingRoles(converted),
    };
  }

  /**
   * Check if a content block supports cache_control.
   * Thinking, redacted_thinking, server_tool_use, and web_search_tool_result blocks do not support cache_control.
   */
  private contentBlockSupportsCacheControl(
    block: AnthropicContentBlock,
  ): block is Exclude<
    AnthropicContentBlock,
    | { type: 'thinking' }
    | { type: 'redacted_thinking' }
    | { type: 'server_tool_use' }
    | { type: 'web_search_tool_result' }
  > {
    return (
      block.type !== 'thinking' &&
      block.type !== 'redacted_thinking' &&
      block.type !== 'server_tool_use' &&
      block.type !== 'web_search_tool_result'
    );
  }

  /**
   * Extract the cache control value from a LanguageModelDataPart.
   * Returns true if the data represents an ephemeral cache control marker.
   */
  private isCacheControlMarker(part: vscode.LanguageModelDataPart): boolean {
    if (part.mimeType !== CustomDataPartMimeTypes.CacheControl) {
      return false;
    }
    const dataString = Buffer.from(part.data).toString('utf-8');
    return dataString === CacheType;
  }

  /**
   * Extract content blocks from a VS Code message
   */
  private extractContent(
    msg: vscode.LanguageModelChatRequestMessage,
  ): AnthropicContentBlock[] {
    const blocks: AnthropicContentBlock[] = [];

    for (const part of msg.content) {
      if (part instanceof vscode.LanguageModelTextPart) {
        if (part.value.trim()) {
          blocks.push({ type: 'text', text: part.value });
        }
      } else if (part instanceof vscode.LanguageModelThinkingPart) {
        // Handle thinking parts from previous assistant responses
        const metadata = part.metadata as
          | {
              redactedData?: string;
              _completeThinking?: string;
              signature?: string;
            }
          | undefined;
        if (metadata?.redactedData) {
          // Redacted thinking block
          blocks.push({
            type: 'redacted_thinking',
            data: metadata.redactedData,
          });
        } else if (metadata?._completeThinking) {
          // Complete thinking block with signature
          blocks.push({
            type: 'thinking',
            thinking: metadata._completeThinking,
            signature: metadata.signature || '',
          });
        }
        // Skip incremental thinking parts - we only care about the complete one
      } else if (part instanceof vscode.LanguageModelToolCallPart) {
        blocks.push({
          type: 'tool_use',
          id: part.callId,
          name: part.name,
          input: part.input as Record<string, unknown>,
        });
      } else if (part instanceof vscode.LanguageModelToolResultPart) {
        const content = this.extractToolResultContent(part.content);
        const toolResultBlock: AnthropicToolResultBlock = {
          type: 'tool_result',
          tool_use_id: part.callId,
          content,
        };
        // Check if the tool result indicates an error
        // LanguageModelToolResultPart may have isError property in newer VS Code versions
        const isError = (part as { isError?: boolean }).isError;
        if (isError !== undefined) {
          toolResultBlock.is_error = isError;
        }
        blocks.push(toolResultBlock);
      } else if (part instanceof vscode.LanguageModelDataPart) {
        // Handle cache_control marker - add cache_control to the previous block
        if (this.isCacheControlMarker(part)) {
          const previousBlock = blocks.at(-1);
          if (
            previousBlock &&
            this.contentBlockSupportsCacheControl(previousBlock)
          ) {
            previousBlock.cache_control = { type: 'ephemeral' };
          } else {
            // If no previous block or it doesn't support cache_control,
            // create a placeholder text block with cache_control
            // (empty string is invalid for Anthropic, use a space)
            blocks.push({
              type: 'text',
              text: ' ',
              cache_control: { type: 'ephemeral' },
            });
          }
        } else if (part.mimeType === CustomDataPartMimeTypes.StatefulMarker) {
          // Skip stateful markers - they are for internal use
          continue;
        } else if (part.mimeType.startsWith('image/')) {
          const dataString = Buffer.from(part.data).toString('utf-8');
          // Check if the data looks like a URL
          if (
            dataString.startsWith('http://') ||
            dataString.startsWith('https://')
          ) {
            blocks.push({
              type: 'image',
              source: {
                type: 'url',
                url: dataString,
              },
            });
          } else {
            // Default to base64 encoding
            const base64 = Buffer.from(part.data).toString('base64');
            blocks.push({
              type: 'image',
              source: {
                type: 'base64',
                media_type: part.mimeType,
                data: base64,
              },
            });
          }
        } else if (part.mimeType.startsWith('text/')) {
          const text = Buffer.from(part.data).toString('utf-8');
          blocks.push({ type: 'text', text });
        } else {
          throw new Error(
            `Unsupported mime type in LanguageModelDataPart: ${
              part.mimeType
            }. Data length: ${part.data?.byteLength ?? 'unknown'}`,
          );
        }
      } else {
        throw new Error(
          `Unsupported message part type encountered. Part details: ${JSON.stringify(
            part,
          )}.`,
        );
      }
    }

    return blocks;
  }

  /**
   * Extract system content blocks, keeping cache_control markers.
   */
  private extractSystemContent(msg: vscode.LanguageModelChatRequestMessage): {
    blocks: AnthropicSystemContentBlock[];
    hasCacheControl: boolean;
  } {
    const blocks: AnthropicSystemContentBlock[] = [];
    let hasCacheControl = false;

    for (const part of msg.content) {
      if (part instanceof vscode.LanguageModelTextPart) {
        if (part.value.trim()) {
          blocks.push({ type: 'text', text: part.value });
        }
      } else if (part instanceof vscode.LanguageModelDataPart) {
        if (this.isCacheControlMarker(part)) {
          const previousBlock = blocks.at(-1);
          if (previousBlock) {
            previousBlock.cache_control = { type: 'ephemeral' };
          } else {
            blocks.push({
              type: 'text',
              text: ' ',
              cache_control: { type: 'ephemeral' },
            });
          }
          hasCacheControl = true;
        } else if (part.mimeType === CustomDataPartMimeTypes.StatefulMarker) {
          continue;
        } else if (part.mimeType.startsWith('text/')) {
          const text = Buffer.from(part.data).toString('utf-8');
          blocks.push({ type: 'text', text });
        } else {
          throw new Error(
            `Unsupported mime type in system message LanguageModelDataPart: ${
              part.mimeType
            }. Data length: ${part.data?.byteLength ?? 'unknown'}`,
          );
        }
      }
    }

    return { blocks, hasCacheControl };
  }

  /**
   * Extract content for tool result
   */
  private extractToolResultContent(
    content: unknown[],
  ): string | (AnthropicTextBlock | AnthropicImageBlock)[] {
    const blocks: (AnthropicTextBlock | AnthropicImageBlock)[] = [];

    for (const part of content) {
      if (part instanceof vscode.LanguageModelTextPart) {
        // Anthropic errors if we have text parts with empty string text content
        if (part.value.trim()) {
          blocks.push({ type: 'text', text: part.value });
        }
      } else if (part instanceof vscode.LanguageModelThinkingPart) {
        // Thinking parts should not appear in tool results, but skip them if they do
        continue;
      } else if (part instanceof vscode.LanguageModelDataPart) {
        // Handle cache_control marker in tool results
        if (this.isCacheControlMarker(part)) {
          // In tool results, cache_control marker creates a placeholder text block
          // (empty string is invalid for Anthropic, use a space)
          blocks.push({
            type: 'text',
            text: ' ',
            cache_control: { type: 'ephemeral' },
          });
        } else if (part.mimeType === CustomDataPartMimeTypes.StatefulMarker) {
          // Skip stateful markers
          continue;
        } else if (part.mimeType.startsWith('image/')) {
          const dataString = Buffer.from(part.data).toString('utf-8');
          // Check if the data looks like a URL
          if (
            dataString.startsWith('http://') ||
            dataString.startsWith('https://')
          ) {
            blocks.push({
              type: 'image',
              source: {
                type: 'url',
                url: dataString,
              },
            });
          } else {
            // Default to base64 encoding
            const base64 = Buffer.from(part.data).toString('base64');
            blocks.push({
              type: 'image',
              source: {
                type: 'base64',
                media_type: part.mimeType,
                data: base64,
              },
            });
          }
        } else if (part.mimeType.startsWith('text/')) {
          const text = Buffer.from(part.data).toString('utf-8');
          blocks.push({ type: 'text', text });
        } else {
          throw new Error(
            `Unsupported mime type in LanguageModelDataPart: ${
              part.mimeType
            }. Data length: ${part.data?.byteLength ?? 'unknown'}`,
          );
        }
      } else {
        throw new Error(
          `Unsupported tool result part type encountered. Part details: ${JSON.stringify(
            part,
          )}.`,
        );
      }
    }

    if (blocks.length === 0) {
      return '';
    }

    return blocks;
  }

  /**
   * Ensure messages alternate between user and assistant roles
   */
  private ensureAlternatingRoles(
    messages: AnthropicMessage[],
  ): AnthropicMessage[] {
    if (messages.length === 0) {
      return [];
    }

    const result: AnthropicMessage[] = [];

    for (const msg of messages) {
      const lastRole =
        result.length > 0 ? result[result.length - 1].role : null;

      if (lastRole === msg.role) {
        // Merge with previous message of same role
        result[result.length - 1].content.push(...msg.content);
      } else {
        result.push({ ...msg, content: [...msg.content] });
      }
    }

    // Anthropic requires the first message to be from user
    if (result.length > 0 && result[0].role !== 'user') {
      result.unshift({
        role: 'user',
        content: [{ type: 'text', text: '...' }],
      });
    }

    return result;
  }

  /**
   * Convert VS Code tools to Anthropic format.
   *
   * Handles special tools:
   * - Memory tool: Replaces local 'memory' tool with native Anthropic memory tool
   * - Web search: Appends native web search if enabled and no local 'web_search' tool exists
   *
   * @returns Object containing converted tools and flags for enabled native tools
   */
  private convertTools(
    tools: readonly vscode.LanguageModelChatTool[],
    model?: ModelConfig,
  ): { tools: AnthropicToolUnion[]; hasMemoryTool: boolean } {
    const result: AnthropicToolUnion[] = [];
    let hasMemoryTool = false;
    let hasWebSearchTool = false;

    const memoryToolEnabled = model?.memoryTool === true;
    const memoryToolSupported = model
      ? isFeatureSupported(FeatureId.AnthropicMemoryTool, model)
      : false;
    const webSearchSupported = model
      ? isFeatureSupported(FeatureId.AnthropicWebSearch, model)
      : false;

    for (const tool of tools) {
      // Handle native Anthropic memory tool - replaces local memory tool
      if (tool.name === 'memory' && memoryToolEnabled && memoryToolSupported) {
        hasMemoryTool = true;
        result.push({
          type: 'memory_20250818',
          name: 'memory',
        } as AnthropicMemoryTool);
        continue;
      }

      if (tool.name === 'web_search') {
        hasWebSearchTool = true;
      }

      const inputSchema = (tool.inputSchema as
        | AnthropicTool['input_schema']
        | undefined) ?? {
        type: 'object',
        properties: {},
        required: [],
      };

      result.push({
        name: tool.name,
        description: tool.description,
        input_schema: inputSchema,
      });
    }

    // Add web search server tool if enabled, supported, and no local web_search tool exists
    // This is because there is no local web_search tool definition we can replace
    if (model?.webSearch?.enabled && webSearchSupported && !hasWebSearchTool) {
      const webSearchTool: AnthropicWebSearchTool = {
        type: 'web_search_20250305',
        name: 'web_search',
      };

      if (model.webSearch.maxUses !== undefined) {
        webSearchTool.max_uses = model.webSearch.maxUses;
      }

      // Cannot use both allowed and blocked domains simultaneously
      if (
        model.webSearch.allowedDomains &&
        model.webSearch.allowedDomains.length > 0
      ) {
        webSearchTool.allowed_domains = model.webSearch.allowedDomains;
      } else if (
        model.webSearch.blockedDomains &&
        model.webSearch.blockedDomains.length > 0
      ) {
        webSearchTool.blocked_domains = model.webSearch.blockedDomains;
      }

      if (model.webSearch.userLocation) {
        webSearchTool.user_location = model.webSearch.userLocation;
      }

      result.push(webSearchTool);
    }

    return { tools: result, hasMemoryTool };
  }

  private convertToolChoice(
    toolMode: vscode.LanguageModelChatToolMode,
    tools?: AnthropicToolUnion[],
    thinkingEnabled?: boolean,
    parallelToolCalling?: boolean,
  ): AnthropicRequest['tool_choice'] | undefined {
    // When thinking is enabled, Claude only supports 'auto' and 'none' modes.
    // Using 'any' or 'tool' with thinking enabled will cause an API error.
    if (thinkingEnabled) {
      // With thinking enabled, we can only use 'auto' (default) or 'none'
      // If user requested Required mode, we fall back to 'auto' since 'any' and 'tool' are not supported
      if (toolMode === vscode.LanguageModelChatToolMode.Required) {
        // Cannot use 'any' or specific tool with thinking, use 'auto' as fallback
        return this.applyParallelToolChoice(
          { type: 'auto' },
          parallelToolCalling,
        );
      }
      // For other modes, return undefined to use default 'auto' behavior
      return this.applyParallelToolChoice(undefined, parallelToolCalling);
    }

    if (toolMode === vscode.LanguageModelChatToolMode.Required) {
      if (!tools || tools.length === 0) {
        throw new Error(
          'Tool mode is set to Required but no tools are provided',
        );
      }

      if (tools.length === 1) {
        return this.applyParallelToolChoice(
          { type: 'tool', name: tools[0].name },
          parallelToolCalling,
        );
      } else {
        return this.applyParallelToolChoice(
          { type: 'any' },
          parallelToolCalling,
        );
      }
    } else {
      return this.applyParallelToolChoice(undefined, parallelToolCalling);
    }
  }

  private applyParallelToolChoice(
    toolChoice: AnthropicRequest['tool_choice'] | undefined,
    parallelToolCalling?: boolean,
  ): AnthropicRequest['tool_choice'] | undefined {
    if (parallelToolCalling === undefined) {
      return toolChoice;
    }

    const base = toolChoice ?? { type: 'auto' as const };
    return {
      ...base,
      disable_parallel_tool_use:
        parallelToolCalling === false ? true : undefined,
    };
  }

  /**
   * Calculate safe thinking budget based on Anthropic API constraints.
   *
   * Constraints:
   * - Minimum value: 1024 tokens
   * - Must be less than max_tokens - 1
   * - Reasonable upper limit: 32000 tokens
   *
   * @param thinkingConfig The thinking configuration from model config
   * @param maxOutputTokens The max_tokens value for the request
   * @returns Safe budget value or undefined if thinking should be disabled
   */
  private normalizeThinkingBudget(
    configValue: number | undefined,
    maxOutputTokens: number,
    interleavedThinkingEnabled: boolean,
  ): number {
    if (configValue === undefined) {
      configValue = 0;
    }

    // Normalize minimum value: must be at least 1024
    const normalizedBudget = configValue < 1024 ? 1024 : configValue;

    // Calculate safe value: min of (32000, maxOutputTokens - 1, normalizedBudget)
    return interleavedThinkingEnabled
      ? normalizedBudget
      : Math.min(32000, maxOutputTokens - 1, normalizedBudget);
  }

  /**
   * Send a streaming chat request
   */
  async *streamChat(
    model: ModelConfig,
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    options: vscode.ProvideLanguageModelChatResponseOptions,
    performanceTrace: PerformanceTrace,
    token: vscode.CancellationToken,
  ): AsyncGenerator<vscode.LanguageModelResponsePart2> {
    const abortController = new AbortController();
    const cancellationListener = token.onCancellationRequested(() => {
      abortController.abort();
    });

    const thinkingEnabled = model.thinking?.type === 'enabled';
    const hasTools = (options.tools && options.tools.length > 0) ?? false;
    const interleavedThinkingSupported = isFeatureSupported(
      FeatureId.AnthropicInterleavedThinking,
      model,
    );
    const interleavedThinkingEnabled =
      thinkingEnabled &&
      model.interleavedThinking === true &&
      hasTools &&
      interleavedThinkingSupported;

    const endpoint = toMessagesUrl(this.config.baseUrl);
    let requestId = 'req-unknown';

    const { system, messages: anthropicMessages } =
      this.convertMessages(messages);

    // Convert tools with model config for web search and memory tool support
    // Also add tools if web search is enabled even without explicit tools
    const webSearchEnabled = model.webSearch?.enabled === true;
    const toolsResult =
      hasTools || webSearchEnabled
        ? this.convertTools(options.tools ?? [], model)
        : undefined;

    const tools = toolsResult?.tools;
    const hasMemoryTool = toolsResult?.hasMemoryTool ?? false;

    // Build betas array for beta API features
    const betaFeatures: string[] = [];

    if (interleavedThinkingEnabled) {
      betaFeatures.push('interleaved-thinking-2025-05-14');
    }

    // Add context management beta for memory tool
    if (hasMemoryTool) {
      betaFeatures.push('context-management-2025-06-27');
    }

    const headers = this.buildHeaders(
      betaFeatures.length > 0 ? betaFeatures : undefined,
    );

    // Pass thinkingEnabled to convertToolChoice to enforce tool_choice restrictions
    const toolChoice = this.convertToolChoice(
      options.toolMode,
      tools,
      thinkingEnabled,
      model.parallelToolCalling,
    );

    try {
      const requestBody: AnthropicRequest = {
        model: model.id,
        messages: anthropicMessages,
        max_tokens: model.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
        stream: true,
      };

      if (this.config.mimic === 'claude-code') {
        requestBody.metadata = {
          user_id: USER_ID,
        };
      }

      if (system) {
        requestBody.system = system;
      }

      if (tools) {
        requestBody.tools = tools;
      }

      if (toolChoice) {
        requestBody.tool_choice = toolChoice;
      }

      // Apply model configuration overrides
      if (model.stream !== undefined) {
        requestBody.stream = model.stream;
      }
      if (model.temperature !== undefined) {
        // Note: When thinking is enabled, temperature modification is not supported
        // The API will reject non-default temperature values
        requestBody.temperature = model.temperature;
      }
      if (model.topK !== undefined) {
        // Note: When thinking is enabled, top_k modification is not supported
        requestBody.top_k = model.topK;
      }
      if (model.topP !== undefined) {
        // Note: When thinking is enabled, top_p must be between 0.95 and 1
        requestBody.top_p = model.topP;
      }
      if (model.thinking !== undefined) {
        const { type, budgetTokens } = model.thinking;
        if (type === 'enabled') {
          // With interleaved thinking, budget_tokens can exceed max_tokens
          // For regular thinking, it must be less than max_tokens
          requestBody.thinking = {
            type,
            budget_tokens: this.normalizeThinkingBudget(
              budgetTokens,
              requestBody.max_tokens,
              interleavedThinkingEnabled,
            ),
          };
        }
      }

      requestId = startRequestLog({
        provider: this.config.name,
        modelId: model.id,
        endpoint,
        headers,
        body: requestBody,
      });

      performanceTrace.ttf = Date.now() - performanceTrace.tts;

      const response = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(requestBody),
        signal: abortController.signal,
        keepalive: true,
        mode: 'cors',
      });

      logResponseMetadata(requestId, response);

      if (!response.ok) {
        const errorText = await response.text();
        logResponseError(requestId, `HTTP ${response.status}: ${errorText}`);
        throw new Error(
          `API request failed (${response.status}): ${errorText}`,
        );
      }

      const contentType = response.headers.get('content-type') ?? '';

      let usage: AnthropicUsage | undefined = undefined;

      if (contentType.includes('text/event-stream')) {
        yield* this.parseSSEStream(
          response,
          token,
          requestId,
          (usage = {} as AnthropicUsage),
          performanceTrace,
        );
      } else {
        // Non-streaming response fallback
        const rawText = await response.text();
        logResponseChunk(requestId, rawText);
        const result = JSON.parse(rawText);

        usage = (result as { usage?: AnthropicUsage }).usage;
        performanceTrace.ttft =
          Date.now() - (performanceTrace.tts + performanceTrace.ttf);

        for (const block of result.content ?? []) {
          if (block.type === 'text') {
            // Check for citations in text block
            const textBlock = block as AnthropicTextBlockWithCitations;
            if (textBlock.citations && textBlock.citations.length > 0) {
              // Emit citations as a data part first
              yield new vscode.LanguageModelDataPart(
                new TextEncoder().encode(
                  JSON.stringify({ citations: textBlock.citations }),
                ),
                CustomDataPartMimeTypes.TextCitations,
              );
            }
            yield new vscode.LanguageModelTextPart(block.text);
          } else if (block.type === 'tool_use') {
            yield new vscode.LanguageModelToolCallPart(
              block.id,
              block.name,
              block.input,
            );
          } else if (block.type === 'server_tool_use') {
            // Handle server tool use (e.g., web_search)
            const serverToolBlock = block as AnthropicServerToolUseBlock;
            yield new vscode.LanguageModelDataPart(
              new TextEncoder().encode(JSON.stringify(serverToolBlock)),
              CustomDataPartMimeTypes.WebSearchToolUse,
            );
          } else if (block.type === 'web_search_tool_result') {
            // Handle web search tool result
            const resultBlock = block as AnthropicWebSearchToolResultBlock;
            yield new vscode.LanguageModelDataPart(
              new TextEncoder().encode(JSON.stringify(resultBlock)),
              CustomDataPartMimeTypes.WebSearchToolResult,
            );
          } else if (block.type === 'thinking') {
            // Output thinking content
            yield new vscode.LanguageModelThinkingPart(block.thinking || '');
            // Output final thinking part with metadata for multi-turn conversation
            if (block.signature) {
              const finalThinkingPart = new vscode.LanguageModelThinkingPart(
                '',
              );
              finalThinkingPart.metadata = {
                signature: block.signature,
                _completeThinking: block.thinking,
              };
              yield finalThinkingPart;
            }
          }
          // redacted_thinking blocks are intentionally not output
        }
      }

      if (usage?.output_tokens !== undefined) {
        performanceTrace.tps =
          (usage.output_tokens /
            (Date.now() - (performanceTrace.tts + performanceTrace.ttf))) *
          1000;
      } else {
        performanceTrace.tps = NaN;
      }

      if (usage) {
        logInfo(`[${requestId}] Usage: ${JSON.stringify(usage)}`);
      }

      logResponseComplete(requestId);
    } catch (error) {
      // Errors are logged before being rethrown so the UI still handles them.
      logResponseError(requestId, error);
      throw error;
    } finally {
      cancellationListener.dispose();
    }
  }

  /**
   * Parse SSE stream from Anthropic API
   */
  private async *parseSSEStream(
    response: Response,
    token: vscode.CancellationToken,
    requestId: string,
    usage: AnthropicUsage,
    performanceTrace: PerformanceTrace,
  ): AsyncGenerator<vscode.LanguageModelResponsePart2> {
    const reader = response.body?.getReader();
    if (!reader) {
      return;
    }

    const decoder = new TextDecoder();
    let buffer = '';

    // Track current tool call being built
    let currentToolCall: {
      id: string;
      name: string;
      inputJson: string;
    } | null = null;

    // Track pending thinking block
    let pendingThinking: {
      thinking: string;
      signature: string;
    } | null = null;

    // Track pending redacted thinking block
    let pendingRedactedThinking: {
      data: string;
    } | null = null;

    // Track current server tool use block (for web search)
    let currentServerToolUse: {
      id: string;
      name: string;
      inputJson: string;
    } | null = null;

    // Track current text block with potential citations
    let currentTextBlock: {
      text: string;
      hasCitations: boolean;
    } | null = null;

    // Track pending web search tool result
    let pendingWebSearchResult: AnthropicWebSearchToolResultBlock | null = null;

    let firstTokenRecorded = false;
    const recordFirstToken = () => {
      if (!firstTokenRecorded) {
        performanceTrace.ttft =
          Date.now() - (performanceTrace.tts + performanceTrace.ttf);
        firstTokenRecorded = true;
      }
    };

    try {
      while (!token.isCancellationRequested) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith('data:')) {
            continue;
          }

          const data = trimmed.slice(5).trim();
          logResponseChunk(requestId, data);
          if (data === '[DONE]') {
            return;
          }

          try {
            const event = JSON.parse(data) as AnthropicStreamEvent;

            if (event.type === 'content_block_start') {
              if (event.content_block.type === 'tool_use') {
                const toolBlock = event.content_block as AnthropicToolUseBlock;
                currentToolCall = {
                  id: toolBlock.id,
                  name: toolBlock.name,
                  inputJson: '',
                };
              } else if (event.content_block.type === 'thinking') {
                pendingThinking = {
                  thinking: '',
                  signature: '',
                };
              } else if (event.content_block.type === 'redacted_thinking') {
                const redactedBlock = event.content_block as {
                  type: 'redacted_thinking';
                  data: string;
                };
                pendingRedactedThinking = {
                  data: redactedBlock.data,
                };
              } else if (event.content_block.type === 'server_tool_use') {
                // Handle server tool use (e.g., web_search)
                const serverToolBlock =
                  event.content_block as AnthropicServerToolUseBlock;
                currentServerToolUse = {
                  id: serverToolBlock.id,
                  name: serverToolBlock.name,
                  inputJson: '',
                };
              } else if (
                event.content_block.type === 'web_search_tool_result'
              ) {
                // Handle web search tool result
                const resultBlock =
                  event.content_block as AnthropicWebSearchToolResultBlock;
                pendingWebSearchResult = resultBlock;
                // Emit the web search result as a data part
                recordFirstToken();
                yield new vscode.LanguageModelDataPart(
                  new TextEncoder().encode(JSON.stringify(resultBlock)),
                  CustomDataPartMimeTypes.WebSearchToolResult,
                );
              } else if (event.content_block.type === 'text') {
                // Check if this text block has citations
                const textBlock =
                  event.content_block as AnthropicTextBlockWithCitations;
                if (textBlock.citations && textBlock.citations.length > 0) {
                  currentTextBlock = {
                    text: textBlock.text || '',
                    hasCitations: true,
                  };
                  // Emit citations as a data part first
                  recordFirstToken();
                  yield new vscode.LanguageModelDataPart(
                    new TextEncoder().encode(
                      JSON.stringify({ citations: textBlock.citations }),
                    ),
                    CustomDataPartMimeTypes.TextCitations,
                  );
                  // Then emit the text
                  if (textBlock.text) {
                    recordFirstToken();
                    yield new vscode.LanguageModelTextPart(textBlock.text);
                  }
                } else {
                  currentTextBlock = {
                    text: textBlock.text || '',
                    hasCitations: false,
                  };
                }
              }
            } else if (event.type === 'content_block_delta') {
              if (event.delta.type === 'text_delta') {
                recordFirstToken();
                yield new vscode.LanguageModelTextPart(event.delta.text);
              } else if (event.delta.type === 'input_json_delta') {
                // Handle input_json_delta for both regular tool_use and server_tool_use
                recordFirstToken();
                if (currentToolCall) {
                  currentToolCall.inputJson += event.delta.partial_json;
                } else if (currentServerToolUse) {
                  currentServerToolUse.inputJson += event.delta.partial_json;
                }
              } else if (
                event.delta.type === 'thinking_delta' &&
                pendingThinking
              ) {
                pendingThinking.thinking += event.delta.thinking || '';
                recordFirstToken();
                yield new vscode.LanguageModelThinkingPart(
                  event.delta.thinking || '',
                );
              } else if (
                event.delta.type === 'signature_delta' &&
                pendingThinking
              ) {
                pendingThinking.signature += event.delta.signature || '';
              } else if (event.delta.type === 'citations_delta') {
                const citation = (event.delta as { citation?: unknown })
                  .citation;
                if (citation) {
                  const payload = { citations: [citation] };
                  recordFirstToken();
                  yield new vscode.LanguageModelDataPart(
                    new TextEncoder().encode(JSON.stringify(payload)),
                    CustomDataPartMimeTypes.TextCitations,
                  );
                }
              }
            } else if (event.type === 'content_block_stop') {
              if (currentToolCall) {
                try {
                  const input = JSON.parse(currentToolCall.inputJson || '{}');
                  recordFirstToken();
                  yield new vscode.LanguageModelToolCallPart(
                    currentToolCall.id,
                    currentToolCall.name,
                    input,
                  );
                } catch {
                  // Invalid JSON, skip this tool call
                }
                currentToolCall = null;
              } else if (currentServerToolUse) {
                // Emit server tool use (e.g., web_search) as a data part
                try {
                  const input = JSON.parse(
                    currentServerToolUse.inputJson || '{}',
                  );
                  const serverToolUseData = {
                    type: 'server_tool_use',
                    id: currentServerToolUse.id,
                    name: currentServerToolUse.name,
                    input,
                  };
                  recordFirstToken();
                  yield new vscode.LanguageModelDataPart(
                    new TextEncoder().encode(JSON.stringify(serverToolUseData)),
                    CustomDataPartMimeTypes.WebSearchToolUse,
                  );
                } catch {
                  // Invalid JSON, skip this server tool use
                }
                currentServerToolUse = null;
              } else if (pendingThinking) {
                // Output final thinking part with metadata for multi-turn conversation
                if (pendingThinking.signature) {
                  const finalThinkingPart =
                    new vscode.LanguageModelThinkingPart('');
                  finalThinkingPart.metadata = {
                    signature: pendingThinking.signature,
                    _completeThinking: pendingThinking.thinking,
                  };
                  recordFirstToken();
                  yield finalThinkingPart;
                }
                pendingThinking = null;
              } else if (pendingRedactedThinking) {
                // Redacted thinking blocks don't need output, just clear state
                pendingRedactedThinking = null;
              } else if (pendingWebSearchResult) {
                // Web search result already emitted in content_block_start, just clear state
                pendingWebSearchResult = null;
              } else if (currentTextBlock) {
                // Clear text block state
                currentTextBlock = null;
              }
            } else if (event.type === 'message_start') {
              const _usage = event.message?.usage;
              if (_usage) Object.assign(usage, _usage);
            } else if (event.type === 'message_delta') {
              const _usage = event.usage;
              if (_usage) usage.output_tokens = _usage.output_tokens;
            } else if (event.type === 'message_stop') {
              const _usage = event.message?.usage;
              if (_usage) Object.assign(usage, _usage);
            } else if (event.type === 'error') {
              throw new Error(`Stream error: ${event.error.message}`);
            }
          } catch (parseError) {
            // Skip invalid JSON lines
            if (
              parseError instanceof Error &&
              parseError.message.startsWith('Stream error')
            ) {
              throw parseError;
            }
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  /**
   * Estimate token count for text (rough approximation)
   */
  estimateTokenCount(text: string): number {
    // Rough estimation: ~4 characters per token for English text
    return Math.ceil(text.length / 4);
  }

  /**
   * Get available models from the Anthropic API
   * Uses the ListModels endpoint with pagination support
   */
  async getAvailableModels(): Promise<ModelConfig[]> {
    const headers = this.buildHeaders();
    const allModels: ModelConfig[] = [];
    let afterId: string | undefined;

    try {
      do {
        const endpoint = toModelsUrl(this.config.baseUrl, afterId);
        const response = await fetch(endpoint, {
          method: 'GET',
          headers,
          keepalive: true,
        });

        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(
            `Failed to fetch models (${response.status}): ${errorText}`,
          );
        }

        const data = (await response.json()) as AnthropicListModelsResponse;

        // Convert API response to ModelConfig format
        for (const model of data.data) {
          const wellKnwonConfig = WELL_KNOWN_MODELS.find(
            (v) => v.id === model.id,
          );
          allModels.push(
            Object.assign(wellKnwonConfig ?? {}, {
              id: model.id,
              name: model.display_name,
            }),
          );
        }

        // Handle pagination
        if (data.has_more && data.last_id) {
          afterId = data.last_id;
        } else {
          break;
        }
      } while (true);

      return allModels;
    } catch (error) {
      // Re-throw with more context
      if (error instanceof Error) {
        throw new Error(`Failed to get available models: ${error.message}`);
      }
      throw error;
    }
  }
}

function toMessagesUrl(baseUrl: string): string {
  const normalized = normalizeBaseUrlInput(baseUrl);
  return `${normalized}/v1/messages`;
}

function toModelsUrl(baseUrl: string, afterId?: string): string {
  const normalized = normalizeBaseUrlInput(baseUrl);
  const url = new URL(`${normalized}/v1/models`);
  if (afterId) {
    url.searchParams.set('after_id', afterId);
  }
  return url.toString();
}

const USER_ID = generateClaudeUserId();

/**
 * 生成 ClaudeCode 风格的 user_id
 * 格式: user_{SHA256}_account__session_{UUID}
 * * @param seedInput - 可选：用于生成哈希的种子字符串（如邮箱、用户名）。如果不传，则随机生成。
 * @returns 格式化后的 user_id 字符串
 */
function generateClaudeUserId(seedInput?: string): string {
  // 1. 生成 SHA-256 部分 (64字符)
  let hashContent: string | Buffer;

  if (seedInput) {
    hashContent = seedInput;
  } else {
    // 如果没有输入，生成随机的高熵字节作为哈希源
    hashContent = randomBytes(32);
  }

  // 计算 SHA-256 哈希值并转为十六进制字符串
  const sha256Part = createHash('sha256').update(hashContent).digest('hex');

  // 2. 生成会话 UUID 部分 (标准 UUID v4)
  const uuidPart = randomUUID();

  // 3. 拼接字符串
  return `user_${sha256Part}_account__session_${uuidPart}`;
}

import * as vscode from 'vscode';
import {
  ProviderConfig,
  AnthropicMessage,
  AnthropicRequest,
  AnthropicStreamEvent,
  AnthropicTextBlock,
  AnthropicToolUseBlock,
  AnthropicTool,
  ApiClient,
} from '../types';

/**
 * Client for Anthropic-compatible APIs
 */
export class AnthropicClient implements ApiClient {
  constructor(private readonly config: ProviderConfig) {}

  /**
   * Build request headers
   */
  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'anthropic-version': '2023-06-01',
    };

    if (this.config.apiKey) {
      headers['x-api-key'] = this.config.apiKey;
    }

    return headers;
  }

  /**
   * Convert VS Code messages to Anthropic format
   */
  convertMessages(
    messages: readonly vscode.LanguageModelChatMessage[]
  ): { system?: string; messages: AnthropicMessage[] } {
    let system: string | undefined;
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
      }
    }

    // Ensure messages alternate between user and assistant
    return { system, messages: this.ensureAlternatingRoles(converted) };
  }

  /**
   * Extract content blocks from a VS Code message
   */
  private extractContent(msg: vscode.LanguageModelChatMessage): (AnthropicTextBlock | AnthropicToolUseBlock)[] {
    const blocks: (AnthropicTextBlock | AnthropicToolUseBlock)[] = [];

    for (const part of msg.content) {
      if (part instanceof vscode.LanguageModelTextPart) {
        if (part.value.trim()) {
          blocks.push({ type: 'text', text: part.value });
        }
      } else if (part instanceof vscode.LanguageModelToolCallPart) {
        blocks.push({
          type: 'tool_use',
          id: part.callId,
          name: part.name,
          input: part.input as Record<string, unknown>,
        });
      }
    }

    return blocks;
  }

  /**
   * Ensure messages alternate between user and assistant roles
   */
  private ensureAlternatingRoles(messages: AnthropicMessage[]): AnthropicMessage[] {
    if (messages.length === 0) {
      return [];
    }

    const result: AnthropicMessage[] = [];

    for (const msg of messages) {
      const lastRole = result.length > 0 ? result[result.length - 1].role : null;

      if (lastRole === msg.role) {
        // Merge with previous message of same role
        result[result.length - 1].content.push(...msg.content);
      } else {
        result.push({ ...msg, content: [...msg.content] });
      }
    }

    // Anthropic requires the first message to be from user
    if (result.length > 0 && result[0].role !== 'user') {
      result.unshift({ role: 'user', content: [{ type: 'text', text: '...' }] });
    }

    return result;
  }

  /**
   * Convert VS Code tools to Anthropic format
   */
  convertTools(tools: readonly vscode.LanguageModelChatTool[]): AnthropicTool[] {
    return tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.inputSchema as AnthropicTool['input_schema'],
    }));
  }

  /**
   * Send a streaming chat request
   */
  async *streamChat(
    messages: AnthropicMessage[],
    modelId: string,
    options: {
      maxTokens?: number;
      system?: string;
      tools?: AnthropicTool[];
    },
    token: vscode.CancellationToken
  ): AsyncGenerator<vscode.LanguageModelTextPart | vscode.LanguageModelToolCallPart> {
    const abortController = new AbortController();
    const cancellationListener = token.onCancellationRequested(() => {
      abortController.abort();
    });

    try {
      const requestBody: AnthropicRequest = {
        model: modelId,
        messages,
        max_tokens: options.maxTokens ?? 4096,
        stream: true,
      };

      if (options.system) {
        requestBody.system = options.system;
      }

      if (options.tools && options.tools.length > 0) {
        requestBody.tools = options.tools;
      }

      const response = await fetch(this.config.baseUrl, {
        method: 'POST',
        headers: this.buildHeaders(),
        body: JSON.stringify(requestBody),
        signal: abortController.signal,
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`API request failed (${response.status}): ${errorText}`);
      }

      const contentType = response.headers.get('content-type') ?? '';

      if (contentType.includes('text/event-stream')) {
        yield* this.parseSSEStream(response, token);
      } else {
        // Non-streaming response fallback
        const result = await response.json();
        for (const block of result.content ?? []) {
          if (block.type === 'text') {
            yield new vscode.LanguageModelTextPart(block.text);
          } else if (block.type === 'tool_use') {
            yield new vscode.LanguageModelToolCallPart(block.id, block.name, block.input);
          }
        }
      }
    } finally {
      cancellationListener.dispose();
    }
  }

  /**
   * Parse SSE stream from Anthropic API
   */
  private async *parseSSEStream(
    response: Response,
    token: vscode.CancellationToken
  ): AsyncGenerator<vscode.LanguageModelTextPart | vscode.LanguageModelToolCallPart> {
    const reader = response.body?.getReader();
    if (!reader) {
      return;
    }

    const decoder = new TextDecoder();
    let buffer = '';

    // Track current tool call being built
    let currentToolCall: { id: string; name: string; inputJson: string } | null = null;

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
              }
            } else if (event.type === 'content_block_delta') {
              if (event.delta.type === 'text_delta') {
                yield new vscode.LanguageModelTextPart(event.delta.text);
              } else if (event.delta.type === 'input_json_delta' && currentToolCall) {
                currentToolCall.inputJson += event.delta.partial_json;
              }
            } else if (event.type === 'content_block_stop') {
              if (currentToolCall) {
                try {
                  const input = JSON.parse(currentToolCall.inputJson || '{}');
                  yield new vscode.LanguageModelToolCallPart(currentToolCall.id, currentToolCall.name, input);
                } catch {
                  // Invalid JSON, skip this tool call
                }
                currentToolCall = null;
              }
            } else if (event.type === 'error') {
              throw new Error(`Stream error: ${event.error.message}`);
            }
          } catch (parseError) {
            // Skip invalid JSON lines
            if (parseError instanceof Error && parseError.message.startsWith('Stream error')) {
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
}

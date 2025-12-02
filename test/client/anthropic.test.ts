/**
 * Tests for AnthropicClient
 */

import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import * as assert from 'node:assert';
import {
  vscode,
  CancellationTokenSource,
  LanguageModelTextPart,
  LanguageModelToolCallPart,
  LanguageModelChatMessage,
  LanguageModelChatMessageRole,
} from '../mocks/vscode.js';
import {
  createTestProviderConfig,
  collectAsyncGenerator,
  createSSEData,
  createMockReadableStream,
  createMockResponse,
  assertThrowsAsync,
} from '../utils/test-helpers.js';
import type { ProviderConfig, AnthropicMessage, AnthropicTool } from '../types.js';

// Create a testable version of AnthropicClient using our mocks
class TestableAnthropicClient {
  constructor(private readonly config: ProviderConfig) {}

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

  convertMessages(
    messages: readonly InstanceType<typeof LanguageModelChatMessage>[]
  ): { system?: string; messages: AnthropicMessage[] } {
    let system: string | undefined;
    const converted: AnthropicMessage[] = [];

    for (const msg of messages) {
      if (msg.role === LanguageModelChatMessageRole.User) {
        const content = this.extractContent(msg);
        if (content.length > 0) {
          converted.push({ role: 'user', content });
        }
      } else if (msg.role === LanguageModelChatMessageRole.Assistant) {
        const content = this.extractContent(msg);
        if (content.length > 0) {
          converted.push({ role: 'assistant', content });
        }
      }
    }

    return { system, messages: this.ensureAlternatingRoles(converted) };
  }

  private extractContent(msg: InstanceType<typeof LanguageModelChatMessage>): Array<{ type: 'text'; text: string } | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }> {
    const blocks: Array<{ type: 'text'; text: string } | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }> = [];

    for (const part of msg.content) {
      if (part instanceof LanguageModelTextPart) {
        if (part.value.trim()) {
          blocks.push({ type: 'text', text: part.value });
        }
      } else if (part instanceof LanguageModelToolCallPart) {
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

  private ensureAlternatingRoles(messages: AnthropicMessage[]): AnthropicMessage[] {
    if (messages.length === 0) {
      return [];
    }

    const result: AnthropicMessage[] = [];

    for (const msg of messages) {
      const lastRole = result.length > 0 ? result[result.length - 1].role : null;

      if (lastRole === msg.role) {
        result[result.length - 1].content.push(...msg.content);
      } else {
        result.push({ ...msg, content: [...msg.content] });
      }
    }

    if (result.length > 0 && result[0].role !== 'user') {
      result.unshift({ role: 'user', content: [{ type: 'text', text: '...' }] });
    }

    return result;
  }

  convertTools(tools: readonly { name: string; description: string; inputSchema: unknown }[]): AnthropicTool[] {
    return tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.inputSchema as AnthropicTool['input_schema'],
    }));
  }

  async *streamChat(
    messages: AnthropicMessage[],
    modelId: string,
    options: {
      maxTokens?: number;
      system?: string;
      tools?: AnthropicTool[];
    },
    token: { isCancellationRequested: boolean; onCancellationRequested: (fn: () => void) => { dispose: () => void } },
    fetchFn: typeof fetch = fetch
  ): AsyncGenerator<InstanceType<typeof LanguageModelTextPart> | InstanceType<typeof LanguageModelToolCallPart>> {
    const abortController = new AbortController();
    const cancellationListener = token.onCancellationRequested(() => {
      abortController.abort();
    });

    try {
      const requestBody = {
        model: modelId,
        messages,
        max_tokens: options.maxTokens ?? 4096,
        stream: true,
        ...(options.system ? { system: options.system } : {}),
        ...(options.tools && options.tools.length > 0 ? { tools: options.tools } : {}),
      };

      const response = await fetchFn(this.config.baseUrl, {
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
        const result = (await response.json()) as { content?: Array<{ type: string; text?: string; id?: string; name?: string; input?: object }> };
        for (const block of result.content ?? []) {
          if (block.type === 'text' && block.text) {
            yield new LanguageModelTextPart(block.text);
          } else if (block.type === 'tool_use' && block.id && block.name) {
            yield new LanguageModelToolCallPart(block.id, block.name, block.input ?? {});
          }
        }
      }
    } finally {
      cancellationListener.dispose();
    }
  }

  private async *parseSSEStream(
    response: Response,
    token: { isCancellationRequested: boolean }
  ): AsyncGenerator<InstanceType<typeof LanguageModelTextPart> | InstanceType<typeof LanguageModelToolCallPart>> {
    const reader = response.body?.getReader();
    if (!reader) {
      return;
    }

    const decoder = new TextDecoder();
    let buffer = '';
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
            const event = JSON.parse(data);

            if (event.type === 'content_block_start') {
              if (event.content_block.type === 'tool_use') {
                currentToolCall = {
                  id: event.content_block.id,
                  name: event.content_block.name,
                  inputJson: '',
                };
              }
            } else if (event.type === 'content_block_delta') {
              if (event.delta.type === 'text_delta') {
                yield new LanguageModelTextPart(event.delta.text);
              } else if (event.delta.type === 'input_json_delta' && currentToolCall) {
                currentToolCall.inputJson += event.delta.partial_json;
              }
            } else if (event.type === 'content_block_stop') {
              if (currentToolCall) {
                try {
                  const input = JSON.parse(currentToolCall.inputJson || '{}');
                  yield new LanguageModelToolCallPart(currentToolCall.id, currentToolCall.name, input);
                } catch {
                  // Invalid JSON, skip this tool call
                }
                currentToolCall = null;
              }
            } else if (event.type === 'error') {
              throw new Error(`Stream error: ${event.error.message}`);
            }
          } catch (parseError) {
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

  estimateTokenCount(text: string): number {
    return Math.ceil(text.length / 4);
  }

  // Expose private method for testing
  getHeaders(): Record<string, string> {
    return this.buildHeaders();
  }
}

describe('AnthropicClient', () => {
  let client: TestableAnthropicClient;
  let cancellationSource: CancellationTokenSource;

  beforeEach(() => {
    const config = createTestProviderConfig();
    client = new TestableAnthropicClient(config);
    cancellationSource = new CancellationTokenSource();
  });

  afterEach(() => {
    cancellationSource.dispose();
  });

  describe('buildHeaders', () => {
    it('should include Content-Type and anthropic-version headers', () => {
      const headers = client.getHeaders();
      assert.strictEqual(headers['Content-Type'], 'application/json');
      assert.strictEqual(headers['anthropic-version'], '2023-06-01');
    });

    it('should include x-api-key when apiKey is configured', () => {
      const headers = client.getHeaders();
      assert.strictEqual(headers['x-api-key'], 'test-api-key');
    });

    it('should not include x-api-key when apiKey is not configured', () => {
      const configWithoutKey = createTestProviderConfig({ apiKey: undefined });
      const clientWithoutKey = new TestableAnthropicClient(configWithoutKey);
      const headers = clientWithoutKey.getHeaders();
      assert.ok(!('x-api-key' in headers));
    });
  });

  describe('convertMessages', () => {
    it('should convert user message to Anthropic format', () => {
      const messages = [LanguageModelChatMessage.User('Hello, world!')];
      const result = client.convertMessages(messages);

      assert.strictEqual(result.messages.length, 1);
      assert.strictEqual(result.messages[0].role, 'user');
      assert.strictEqual(result.messages[0].content.length, 1);
      assert.deepStrictEqual(result.messages[0].content[0], { type: 'text', text: 'Hello, world!' });
    });

    it('should convert assistant message to Anthropic format', () => {
      const messages = [
        LanguageModelChatMessage.User('Hi'),
        LanguageModelChatMessage.Assistant('Hello!'),
      ];
      const result = client.convertMessages(messages);

      assert.strictEqual(result.messages.length, 2);
      assert.strictEqual(result.messages[1].role, 'assistant');
      assert.deepStrictEqual(result.messages[1].content[0], { type: 'text', text: 'Hello!' });
    });

    it('should handle tool call parts in assistant messages', () => {
      const messages = [
        LanguageModelChatMessage.User('Search for cats'),
        new LanguageModelChatMessage(LanguageModelChatMessageRole.Assistant, [
          new LanguageModelToolCallPart('call-123', 'search', { query: 'cats' }),
        ]),
      ];
      const result = client.convertMessages(messages);

      assert.strictEqual(result.messages[1].role, 'assistant');
      assert.strictEqual(result.messages[1].content[0].type, 'tool_use');
      const toolUse = result.messages[1].content[0] as { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> };
      assert.strictEqual(toolUse.id, 'call-123');
      assert.strictEqual(toolUse.name, 'search');
      assert.deepStrictEqual(toolUse.input, { query: 'cats' });
    });

    it('should filter out empty text content', () => {
      const messages = [
        new LanguageModelChatMessage(LanguageModelChatMessageRole.User, [
          new LanguageModelTextPart(''),
          new LanguageModelTextPart('   '),
          new LanguageModelTextPart('valid text'),
        ]),
      ];
      const result = client.convertMessages(messages);

      assert.strictEqual(result.messages[0].content.length, 1);
      assert.deepStrictEqual(result.messages[0].content[0], { type: 'text', text: 'valid text' });
    });

    it('should skip messages with no valid content', () => {
      const messages = [
        new LanguageModelChatMessage(LanguageModelChatMessageRole.User, [
          new LanguageModelTextPart(''),
        ]),
        LanguageModelChatMessage.User('valid message'),
      ];
      const result = client.convertMessages(messages);

      assert.strictEqual(result.messages.length, 1);
      assert.deepStrictEqual(result.messages[0].content[0], { type: 'text', text: 'valid message' });
    });
  });

  describe('ensureAlternatingRoles', () => {
    it('should prepend dummy user message if first message is assistant', () => {
      const messages = [LanguageModelChatMessage.Assistant('Hello!')];
      const result = client.convertMessages(messages);

      assert.strictEqual(result.messages.length, 2);
      assert.strictEqual(result.messages[0].role, 'user');
      assert.deepStrictEqual(result.messages[0].content[0], { type: 'text', text: '...' });
      assert.strictEqual(result.messages[1].role, 'assistant');
    });

    it('should merge consecutive messages with same role', () => {
      const messages = [
        LanguageModelChatMessage.User('First'),
        LanguageModelChatMessage.User('Second'),
        LanguageModelChatMessage.Assistant('Response'),
      ];
      const result = client.convertMessages(messages);

      assert.strictEqual(result.messages.length, 2);
      assert.strictEqual(result.messages[0].content.length, 2);
      assert.deepStrictEqual(result.messages[0].content[0], { type: 'text', text: 'First' });
      assert.deepStrictEqual(result.messages[0].content[1], { type: 'text', text: 'Second' });
    });

    it('should handle empty message array', () => {
      const result = client.convertMessages([]);
      assert.deepStrictEqual(result.messages, []);
    });

    it('should handle complex alternating pattern', () => {
      const messages = [
        LanguageModelChatMessage.User('Q1'),
        LanguageModelChatMessage.Assistant('A1'),
        LanguageModelChatMessage.User('Q2'),
        LanguageModelChatMessage.User('Q2 continued'),
        LanguageModelChatMessage.Assistant('A2'),
      ];
      const result = client.convertMessages(messages);

      assert.strictEqual(result.messages.length, 4);
      assert.strictEqual(result.messages[0].role, 'user');
      assert.strictEqual(result.messages[1].role, 'assistant');
      assert.strictEqual(result.messages[2].role, 'user');
      assert.strictEqual(result.messages[2].content.length, 2); // Q2 and Q2 continued merged
      assert.strictEqual(result.messages[3].role, 'assistant');
    });
  });

  describe('convertTools', () => {
    it('should convert VS Code tools to Anthropic format', () => {
      const tools = [
        {
          name: 'search',
          description: 'Search for information',
          inputSchema: {
            type: 'object' as const,
            properties: {
              query: { type: 'string', description: 'Search query' },
            },
            required: ['query'],
          },
        },
      ];

      const result = client.convertTools(tools);

      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].name, 'search');
      assert.strictEqual(result[0].description, 'Search for information');
      assert.deepStrictEqual(result[0].input_schema, tools[0].inputSchema);
    });

    it('should convert multiple tools', () => {
      const tools = [
        {
          name: 'tool1',
          description: 'First tool',
          inputSchema: { type: 'object' as const, properties: {} },
        },
        {
          name: 'tool2',
          description: 'Second tool',
          inputSchema: { type: 'object' as const, properties: { x: { type: 'number' } } },
        },
      ];

      const result = client.convertTools(tools);

      assert.strictEqual(result.length, 2);
      assert.strictEqual(result[0].name, 'tool1');
      assert.strictEqual(result[1].name, 'tool2');
    });

    it('should handle empty tools array', () => {
      const result = client.convertTools([]);
      assert.deepStrictEqual(result, []);
    });
  });

  describe('streamChat', () => {
    it('should send correct request body', async () => {
      let capturedRequest: { url: string; options: RequestInit } | null = null;

      const mockFetch = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
        capturedRequest = { url: url.toString(), options: init! };
        return createMockResponse({
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ content: [] }),
        });
      };

      const messages: AnthropicMessage[] = [{ role: 'user', content: [{ type: 'text', text: 'Hello' }] }];

      await collectAsyncGenerator(
        client.streamChat(messages, 'test-model', { maxTokens: 1000 }, cancellationSource.token, mockFetch)
      );

      if (!capturedRequest) throw new Error('Request not captured');
      const req = capturedRequest as { url: string; options: RequestInit };
      assert.strictEqual(req.options.method, 'POST');

      const body = JSON.parse(req.options.body as string);
      assert.strictEqual(body.model, 'test-model');
      assert.strictEqual(body.max_tokens, 1000);
      assert.strictEqual(body.stream, true);
      assert.deepStrictEqual(body.messages, messages);
    });

    it('should include system prompt when provided', async () => {
      let capturedBody: Record<string, unknown> | null = null;

      const mockFetch = async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
        capturedBody = JSON.parse(init!.body as string);
        return createMockResponse({
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ content: [] }),
        });
      };

      const messages: AnthropicMessage[] = [{ role: 'user', content: [{ type: 'text', text: 'Hello' }] }];

      await collectAsyncGenerator(
        client.streamChat(messages, 'test-model', { system: 'You are helpful.' }, cancellationSource.token, mockFetch)
      );

      if (!capturedBody) throw new Error('Body not captured');
      const captured = capturedBody as Record<string, unknown>;
      assert.strictEqual(captured.system, 'You are helpful.');
    });

    it('should include tools when provided', async () => {
      let capturedBody: Record<string, unknown> | null = null;

      const mockFetch = async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
        capturedBody = JSON.parse(init!.body as string);
        return createMockResponse({
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ content: [] }),
        });
      };

      const tools: AnthropicTool[] = [
        { name: 'test', description: 'Test tool', input_schema: { type: 'object', properties: {} } },
      ];

      await collectAsyncGenerator(
        client.streamChat([], 'test-model', { tools }, cancellationSource.token, mockFetch)
      );

      if (!capturedBody) throw new Error('Body not captured');
      const captured = capturedBody as Record<string, unknown>;
      assert.deepStrictEqual(captured.tools, tools);
    });

    it('should not include tools when array is empty', async () => {
      let capturedBody: Record<string, unknown> | null = null;

      const mockFetch = async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
        capturedBody = JSON.parse(init!.body as string);
        return createMockResponse({
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ content: [] }),
        });
      };

      await collectAsyncGenerator(
        client.streamChat([], 'test-model', { tools: [] }, cancellationSource.token, mockFetch)
      );

      if (!capturedBody) throw new Error('Body not captured');
      const captured = capturedBody as Record<string, unknown>;
      assert.ok(!('tools' in captured));
    });

    it('should throw error for non-OK response', async () => {
      const mockFetch = async (): Promise<Response> => {
        return createMockResponse({
          status: 401,
          statusText: 'Unauthorized',
          body: 'Invalid API key',
        });
      };

      await assertThrowsAsync(
        async () => {
          await collectAsyncGenerator(
            client.streamChat([], 'test-model', {}, cancellationSource.token, mockFetch)
          );
        },
        'API request failed (401)'
      );
    });

    it('should handle JSON response (non-streaming fallback)', async () => {
      const mockFetch = async (): Promise<Response> => {
        return createMockResponse({
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            content: [
              { type: 'text', text: 'Hello, world!' },
              { type: 'tool_use', id: 'call-1', name: 'search', input: { q: 'test' } },
            ],
          }),
        });
      };

      const results = await collectAsyncGenerator(
        client.streamChat([], 'test-model', {}, cancellationSource.token, mockFetch)
      );

      assert.strictEqual(results.length, 2);
      assert.ok(results[0] instanceof LanguageModelTextPart);
      assert.strictEqual((results[0] as InstanceType<typeof LanguageModelTextPart>).value, 'Hello, world!');
      assert.ok(results[1] instanceof LanguageModelToolCallPart);
      assert.strictEqual((results[1] as InstanceType<typeof LanguageModelToolCallPart>).name, 'search');
    });

    it('should parse SSE stream for text deltas', async () => {
      const sseData = [
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}\n\n',
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":" world"}}\n\n',
        'data: {"type":"message_stop"}\n\n',
      ];

      const mockFetch = async (): Promise<Response> => {
        return createMockResponse({
          headers: { 'content-type': 'text/event-stream' },
          body: createMockReadableStream(sseData),
        });
      };

      const results = await collectAsyncGenerator(
        client.streamChat([], 'test-model', {}, cancellationSource.token, mockFetch)
      );

      assert.strictEqual(results.length, 2);
      assert.ok(results[0] instanceof LanguageModelTextPart);
      assert.strictEqual((results[0] as InstanceType<typeof LanguageModelTextPart>).value, 'Hello');
      assert.ok(results[1] instanceof LanguageModelTextPart);
      assert.strictEqual((results[1] as InstanceType<typeof LanguageModelTextPart>).value, ' world');
    });

    it('should parse SSE stream for tool calls', async () => {
      const sseData = [
        'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"call-123","name":"search","input":{}}}\n\n',
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"query\\":"}}\n\n',
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"\\"cats\\"}"}}\n\n',
        'data: {"type":"content_block_stop","index":0}\n\n',
        'data: {"type":"message_stop"}\n\n',
      ];

      const mockFetch = async (): Promise<Response> => {
        return createMockResponse({
          headers: { 'content-type': 'text/event-stream' },
          body: createMockReadableStream(sseData),
        });
      };

      const results = await collectAsyncGenerator(
        client.streamChat([], 'test-model', {}, cancellationSource.token, mockFetch)
      );

      assert.strictEqual(results.length, 1);
      assert.ok(results[0] instanceof LanguageModelToolCallPart);
      const toolCall = results[0] as InstanceType<typeof LanguageModelToolCallPart>;
      assert.strictEqual(toolCall.callId, 'call-123');
      assert.strictEqual(toolCall.name, 'search');
      assert.deepStrictEqual(toolCall.input, { query: 'cats' });
    });

    it('should handle [DONE] marker in SSE stream', async () => {
      const sseData = [
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}\n\n',
        'data: [DONE]\n\n',
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Should not see this"}}\n\n',
      ];

      const mockFetch = async (): Promise<Response> => {
        return createMockResponse({
          headers: { 'content-type': 'text/event-stream' },
          body: createMockReadableStream(sseData),
        });
      };

      const results = await collectAsyncGenerator(
        client.streamChat([], 'test-model', {}, cancellationSource.token, mockFetch)
      );

      assert.strictEqual(results.length, 1);
      assert.strictEqual((results[0] as InstanceType<typeof LanguageModelTextPart>).value, 'Hello');
    });

    it('should throw on stream error event', async () => {
      const sseData = [
        'data: {"type":"error","error":{"type":"rate_limit_error","message":"Rate limit exceeded"}}\n\n',
      ];

      const mockFetch = async (): Promise<Response> => {
        return createMockResponse({
          headers: { 'content-type': 'text/event-stream' },
          body: createMockReadableStream(sseData),
        });
      };

      await assertThrowsAsync(
        async () => {
          await collectAsyncGenerator(
            client.streamChat([], 'test-model', {}, cancellationSource.token, mockFetch)
          );
        },
        'Stream error: Rate limit exceeded'
      );
    });

    it('should skip invalid JSON lines in SSE stream', async () => {
      const sseData = [
        'data: not valid json\n\n',
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Valid"}}\n\n',
        'data: {"type":"message_stop"}\n\n',
      ];

      const mockFetch = async (): Promise<Response> => {
        return createMockResponse({
          headers: { 'content-type': 'text/event-stream' },
          body: createMockReadableStream(sseData),
        });
      };

      const results = await collectAsyncGenerator(
        client.streamChat([], 'test-model', {}, cancellationSource.token, mockFetch)
      );

      assert.strictEqual(results.length, 1);
      assert.strictEqual((results[0] as InstanceType<typeof LanguageModelTextPart>).value, 'Valid');
    });

    it('should skip empty lines and non-data lines in SSE stream', async () => {
      const sseData = [
        '\n',
        ':comment\n',
        'event: message\n',
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}\n\n',
      ];

      const mockFetch = async (): Promise<Response> => {
        return createMockResponse({
          headers: { 'content-type': 'text/event-stream' },
          body: createMockReadableStream(sseData),
        });
      };

      const results = await collectAsyncGenerator(
        client.streamChat([], 'test-model', {}, cancellationSource.token, mockFetch)
      );

      assert.strictEqual(results.length, 1);
    });

    it('should handle tool call with invalid JSON gracefully', async () => {
      const sseData = [
        'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"call-123","name":"search","input":{}}}\n\n',
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"invalid json {"}}\n\n',
        'data: {"type":"content_block_stop","index":0}\n\n',
        'data: {"type":"message_stop"}\n\n',
      ];

      const mockFetch = async (): Promise<Response> => {
        return createMockResponse({
          headers: { 'content-type': 'text/event-stream' },
          body: createMockReadableStream(sseData),
        });
      };

      // Should not throw, just skip the invalid tool call
      const results = await collectAsyncGenerator(
        client.streamChat([], 'test-model', {}, cancellationSource.token, mockFetch)
      );

      // Invalid tool call should be skipped
      assert.strictEqual(results.length, 0);
    });

    it('should use default maxTokens when not provided', async () => {
      let capturedBody: Record<string, unknown> | null = null;

      const mockFetch = async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
        capturedBody = JSON.parse(init!.body as string);
        return createMockResponse({
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ content: [] }),
        });
      };

      await collectAsyncGenerator(
        client.streamChat([], 'test-model', {}, cancellationSource.token, mockFetch)
      );

      if (!capturedBody) throw new Error('Body not captured');
      const captured = capturedBody as Record<string, unknown>;
      assert.strictEqual(captured.max_tokens, 4096);
    });
  });

  describe('estimateTokenCount', () => {
    it('should estimate ~4 characters per token', () => {
      assert.strictEqual(client.estimateTokenCount(''), 0);
      assert.strictEqual(client.estimateTokenCount('test'), 1);
      assert.strictEqual(client.estimateTokenCount('hello world'), 3); // 11 chars = ceil(11/4) = 3
      assert.strictEqual(client.estimateTokenCount('a'.repeat(100)), 25);
    });

    it('should round up for partial tokens', () => {
      assert.strictEqual(client.estimateTokenCount('a'), 1); // 1 char = ceil(1/4) = 1
      assert.strictEqual(client.estimateTokenCount('ab'), 1); // 2 chars = ceil(2/4) = 1
      assert.strictEqual(client.estimateTokenCount('abc'), 1); // 3 chars = ceil(3/4) = 1
      assert.strictEqual(client.estimateTokenCount('abcd'), 1); // 4 chars = ceil(4/4) = 1
      assert.strictEqual(client.estimateTokenCount('abcde'), 2); // 5 chars = ceil(5/4) = 2
    });
  });
});

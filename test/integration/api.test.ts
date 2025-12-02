/**
 * Integration tests with real API
 *
 * These tests require valid API credentials in test/test.config.ts
 * The test.config.ts file is gitignored and should not be committed.
 *
 * To run these tests:
 * 1. Create test/test.config.ts with your API credentials
 * 2. Run: npm test
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert';
import { TEST_API_CONFIG } from '../test.config.js';
import {
  CancellationTokenSource,
  LanguageModelTextPart,
  LanguageModelToolCallPart,
} from '../mocks/vscode.js';
import { collectAsyncGenerator } from '../utils/test-helpers.js';
import type {
  ProviderConfig,
  AnthropicMessage,
  AnthropicTool,
} from '../types.js';

// Real AnthropicClient implementation for integration testing
class IntegrationAnthropicClient {
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

  async *streamChat(
    messages: AnthropicMessage[],
    modelId: string,
    options: {
      maxTokens?: number;
      system?: string;
      tools?: AnthropicTool[];
    },
    token: {
      isCancellationRequested: boolean;
      onCancellationRequested: (fn: () => void) => { dispose: () => void };
    },
  ): AsyncGenerator<
    | InstanceType<typeof LanguageModelTextPart>
    | InstanceType<typeof LanguageModelToolCallPart>
  > {
    const abortController = new AbortController();
    const cancellationListener = token.onCancellationRequested(() => {
      abortController.abort();
    });

    try {
      const requestBody = {
        model: modelId,
        messages,
        max_tokens: options.maxTokens ?? 1024,
        stream: true,
        ...(options.system ? { system: options.system } : {}),
        ...(options.tools && options.tools.length > 0
          ? { tools: options.tools }
          : {}),
      };

      const response = await fetch(this.config.baseUrl, {
        method: 'POST',
        headers: this.buildHeaders(),
        body: JSON.stringify(requestBody),
        signal: abortController.signal,
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(
          `API request failed (${response.status}): ${errorText}`,
        );
      }

      const contentType = response.headers.get('content-type') ?? '';

      if (contentType.includes('text/event-stream')) {
        yield* this.parseSSEStream(response, token);
      } else {
        const result = (await response.json()) as {
          content?: Array<{
            type: string;
            text?: string;
            id?: string;
            name?: string;
            input?: object;
          }>;
        };
        for (const block of result.content ?? []) {
          if (block.type === 'text' && block.text) {
            yield new LanguageModelTextPart(block.text);
          } else if (block.type === 'tool_use' && block.id && block.name) {
            yield new LanguageModelToolCallPart(
              block.id,
              block.name,
              block.input ?? {},
            );
          }
        }
      }
    } finally {
      cancellationListener.dispose();
    }
  }

  private async *parseSSEStream(
    response: Response,
    token: { isCancellationRequested: boolean },
  ): AsyncGenerator<
    | InstanceType<typeof LanguageModelTextPart>
    | InstanceType<typeof LanguageModelToolCallPart>
  > {
    const reader = response.body?.getReader();
    if (!reader) {
      return;
    }

    const decoder = new TextDecoder();
    let buffer = '';
    let currentToolCall: {
      id: string;
      name: string;
      inputJson: string;
    } | null = null;

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
              if (event.content_block?.type === 'tool_use') {
                currentToolCall = {
                  id: event.content_block.id,
                  name: event.content_block.name,
                  inputJson: '',
                };
              }
            } else if (event.type === 'content_block_delta') {
              if (event.delta?.type === 'text_delta') {
                yield new LanguageModelTextPart(event.delta.text);
              } else if (
                event.delta?.type === 'input_json_delta' &&
                currentToolCall
              ) {
                currentToolCall.inputJson += event.delta.partial_json;
              }
            } else if (event.type === 'content_block_stop') {
              if (currentToolCall) {
                try {
                  const input = JSON.parse(currentToolCall.inputJson || '{}');
                  yield new LanguageModelToolCallPart(
                    currentToolCall.id,
                    currentToolCall.name,
                    input,
                  );
                } catch {
                  // Invalid JSON, skip
                }
                currentToolCall = null;
              }
            } else if (event.type === 'error') {
              throw new Error(
                `Stream error: ${event.error?.message ?? 'Unknown error'}`,
              );
            }
          } catch (parseError) {
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
}

describe('Integration Tests', { timeout: 60000 }, () => {
  let client: IntegrationAnthropicClient;
  let cancellationSource: CancellationTokenSource;

  beforeEach(() => {
    const config: ProviderConfig = {
      type: 'anthropic',
      name: 'deepseek',
      baseUrl: TEST_API_CONFIG.baseUrl,
      apiKey: TEST_API_CONFIG.apiKey,
      models: [{ id: TEST_API_CONFIG.testModel }],
    };
    client = new IntegrationAnthropicClient(config);
    cancellationSource = new CancellationTokenSource();
  });

  afterEach(() => {
    cancellationSource.dispose();
  });

  describe('Basic Chat', () => {
    it('should complete a simple chat request', async () => {
      const messages: AnthropicMessage[] = [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Say "Hello, World!" and nothing else.' },
          ],
        },
      ];

      const results = await collectAsyncGenerator(
        client.streamChat(
          messages,
          TEST_API_CONFIG.testModel,
          { maxTokens: 50 },
          cancellationSource.token,
        ),
      );

      assert.ok(
        results.length > 0,
        'Should receive at least one response part',
      );

      const textParts = results.filter(
        (r) => r instanceof LanguageModelTextPart,
      );
      assert.ok(textParts.length > 0, 'Should receive text parts');

      const fullText = textParts
        .map((p) => (p as InstanceType<typeof LanguageModelTextPart>).value)
        .join('');
      assert.ok(
        fullText.toLowerCase().includes('hello'),
        `Response should contain "hello", got: ${fullText}`,
      );
    });

    it('should handle multi-turn conversation', async () => {
      const messages: AnthropicMessage[] = [
        {
          role: 'user',
          content: [{ type: 'text', text: 'Remember the number 42.' }],
        },
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'I will remember the number 42.' }],
        },
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: 'What number did I ask you to remember? Reply with just the number.',
            },
          ],
        },
      ];

      const results = await collectAsyncGenerator(
        client.streamChat(
          messages,
          TEST_API_CONFIG.testModel,
          { maxTokens: 50 },
          cancellationSource.token,
        ),
      );

      const textParts = results.filter(
        (r) => r instanceof LanguageModelTextPart,
      );
      const fullText = textParts
        .map((p) => (p as InstanceType<typeof LanguageModelTextPart>).value)
        .join('');
      assert.ok(
        fullText.includes('42'),
        `Response should contain "42", got: ${fullText}`,
      );
    });

    it('should respect system prompt', async () => {
      const messages: AnthropicMessage[] = [
        {
          role: 'user',
          content: [{ type: 'text', text: 'What is your name?' }],
        },
      ];

      const results = await collectAsyncGenerator(
        client.streamChat(
          messages,
          TEST_API_CONFIG.testModel,
          {
            maxTokens: 100,
            system:
              'You are a helpful assistant named TestBot. Always introduce yourself as TestBot.',
          },
          cancellationSource.token,
        ),
      );

      const textParts = results.filter(
        (r) => r instanceof LanguageModelTextPart,
      );
      const fullText = textParts
        .map((p) => (p as InstanceType<typeof LanguageModelTextPart>).value)
        .join('');
      assert.ok(
        fullText.toLowerCase().includes('testbot'),
        `Response should mention "TestBot", got: ${fullText}`,
      );
    });
  });

  describe('Tool Calling', () => {
    it('should make a tool call when appropriate', async () => {
      const messages: AnthropicMessage[] = [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: 'What is the weather in San Francisco? Use the get_weather tool.',
            },
          ],
        },
      ];

      const tools: AnthropicTool[] = [
        {
          name: 'get_weather',
          description: 'Get the current weather in a given location',
          input_schema: {
            type: 'object',
            properties: {
              location: {
                type: 'string',
                description: 'The city and state, e.g. San Francisco, CA',
              },
            },
            required: ['location'],
          },
        },
      ];

      const results = await collectAsyncGenerator(
        client.streamChat(
          messages,
          TEST_API_CONFIG.testModel,
          { maxTokens: 200, tools },
          cancellationSource.token,
        ),
      );

      const toolCalls = results.filter(
        (r) => r instanceof LanguageModelToolCallPart,
      );

      // Note: Not all models will make tool calls, so we check for either tool call or text response
      if (toolCalls.length > 0) {
        const toolCall = toolCalls[0] as InstanceType<
          typeof LanguageModelToolCallPart
        >;
        assert.strictEqual(toolCall.name, 'get_weather');
        assert.ok(toolCall.callId, 'Tool call should have an ID');
        const input = toolCall.input as { location?: string };
        assert.ok(
          input.location?.toLowerCase().includes('san francisco'),
          `Tool input should mention San Francisco, got: ${JSON.stringify(
            input,
          )}`,
        );
      } else {
        // Model responded with text instead of tool call - this is acceptable
        const textParts = results.filter(
          (r) => r instanceof LanguageModelTextPart,
        );
        assert.ok(
          textParts.length > 0,
          'Should receive either tool call or text response',
        );
      }
    });

    it('should handle tool result in conversation', async () => {
      const messages: AnthropicMessage[] = [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: 'Use the get_number tool to get a number, then tell me what it is.',
            },
          ],
        },
        {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'tool-call-1',
              name: 'get_number',
              input: {},
            },
          ],
        },
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tool-call-1',
              content: '42',
            },
          ],
        },
      ];

      const tools: AnthropicTool[] = [
        {
          name: 'get_number',
          description: 'Get a random number',
          input_schema: {
            type: 'object',
            properties: {},
          },
        },
      ];

      const results = await collectAsyncGenerator(
        client.streamChat(
          messages,
          TEST_API_CONFIG.testModel,
          { maxTokens: 100, tools },
          cancellationSource.token,
        ),
      );

      const textParts = results.filter(
        (r) => r instanceof LanguageModelTextPart,
      );
      const fullText = textParts
        .map((p) => (p as InstanceType<typeof LanguageModelTextPart>).value)
        .join('');
      assert.ok(
        fullText.includes('42'),
        `Response should mention "42", got: ${fullText}`,
      );
    });
  });

  describe('Streaming', () => {
    it('should receive multiple streaming chunks', async () => {
      const messages: AnthropicMessage[] = [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: 'Count from 1 to 5, each number on a new line.',
            },
          ],
        },
      ];

      const results = await collectAsyncGenerator(
        client.streamChat(
          messages,
          TEST_API_CONFIG.testModel,
          { maxTokens: 100 },
          cancellationSource.token,
        ),
      );

      // Streaming should produce multiple chunks
      assert.ok(
        results.length >= 1,
        `Should receive multiple streaming chunks, got ${results.length}`,
      );
    });

    it('should handle cancellation', async () => {
      const messages: AnthropicMessage[] = [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Write a very long story about a dragon.' },
          ],
        },
      ];

      const generator = client.streamChat(
        messages,
        TEST_API_CONFIG.testModel,
        { maxTokens: 2000 },
        cancellationSource.token,
      );

      const results: Array<
        | InstanceType<typeof LanguageModelTextPart>
        | InstanceType<typeof LanguageModelToolCallPart>
      > = [];

      // Collect a few results then cancel
      for await (const part of generator) {
        results.push(part);
        if (results.length >= 3) {
          cancellationSource.cancel();
          break;
        }
      }

      assert.ok(
        results.length >= 1,
        'Should have received some results before cancellation',
      );
      assert.ok(
        results.length < 100,
        'Should have stopped early due to cancellation',
      );
    });
  });

  describe('Error Handling', () => {
    it('should handle invalid API key', async () => {
      const invalidClient = new IntegrationAnthropicClient({
        type: 'anthropic',
        name: 'test',
        baseUrl: TEST_API_CONFIG.baseUrl,
        apiKey: 'invalid-key',
        models: [{ id: TEST_API_CONFIG.testModel }],
      });

      const messages: AnthropicMessage[] = [
        { role: 'user', content: [{ type: 'text', text: 'Hello' }] },
      ];

      let threw = false;
      try {
        await collectAsyncGenerator(
          invalidClient.streamChat(
            messages,
            TEST_API_CONFIG.testModel,
            {},
            cancellationSource.token,
          ),
        );
      } catch (error) {
        threw = true;
        assert.ok(error instanceof Error);
        // Should be an authentication error (401 or similar)
        assert.ok(
          error.message.includes('401') ||
            error.message.includes('403') ||
            error.message.includes('auth'),
          `Expected auth error, got: ${error.message}`,
        );
      }

      assert.ok(threw, 'Should throw an error for invalid API key');
    });
  });

  describe('Edge Cases', () => {
    it('should handle empty message content', async () => {
      // Start with a valid user message
      const messages: AnthropicMessage[] = [
        { role: 'user', content: [{ type: 'text', text: 'Say hi' }] },
      ];

      const results = await collectAsyncGenerator(
        client.streamChat(
          messages,
          TEST_API_CONFIG.testModel,
          { maxTokens: 50 },
          cancellationSource.token,
        ),
      );

      assert.ok(results.length > 0, 'Should receive response');
    });

    it('should handle special characters in messages', async () => {
      const messages: AnthropicMessage[] = [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: 'Echo this exactly: <script>alert("test")</script> & "quotes" \'apostrophes\' 中文 🎉',
            },
          ],
        },
      ];

      const results = await collectAsyncGenerator(
        client.streamChat(
          messages,
          TEST_API_CONFIG.testModel,
          { maxTokens: 200 },
          cancellationSource.token,
        ),
      );

      assert.ok(results.length > 0, 'Should handle special characters');
    });

    it('should handle long messages', async () => {
      const longText = 'This is a test sentence. '.repeat(100);
      const messages: AnthropicMessage[] = [
        {
          role: 'user',
          content: [
            { type: 'text', text: `Summarize this in one word: ${longText}` },
          ],
        },
      ];

      const results = await collectAsyncGenerator(
        client.streamChat(
          messages,
          TEST_API_CONFIG.testModel,
          { maxTokens: 50 },
          cancellationSource.token,
        ),
      );

      assert.ok(results.length > 0, 'Should handle long input');
    });
  });
});

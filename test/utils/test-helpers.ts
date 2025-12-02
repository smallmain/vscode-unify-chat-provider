/**
 * Test helper utilities
 */

import * as assert from 'node:assert';
import type { ProviderConfig, ModelConfig } from '../types.js';

/**
 * Create a test provider configuration
 */
export function createTestProviderConfig(overrides?: Partial<ProviderConfig>): ProviderConfig {
  return {
    type: 'anthropic',
    name: 'test-provider',
    baseUrl: 'https://api.example.com/v1/messages',
    apiKey: 'test-api-key',
    models: [
      { id: 'test-model-1', name: 'Test Model 1', maxInputTokens: 100000, maxOutputTokens: 4096 },
      { id: 'test-model-2', name: 'Test Model 2' },
    ],
    ...overrides,
  };
}

/**
 * Create a test model configuration
 */
export function createTestModelConfig(overrides?: Partial<ModelConfig>): ModelConfig {
  return {
    id: 'test-model',
    name: 'Test Model',
    maxInputTokens: 100000,
    maxOutputTokens: 4096,
    ...overrides,
  };
}

/**
 * Assert that an async function throws an error
 */
export async function assertThrowsAsync(
  fn: () => Promise<unknown>,
  expectedMessage?: string | RegExp
): Promise<void> {
  let threw = false;
  let error: Error | undefined;

  try {
    await fn();
  } catch (e) {
    threw = true;
    error = e as Error;
  }

  assert.ok(threw, 'Expected function to throw an error');

  if (expectedMessage) {
    if (typeof expectedMessage === 'string') {
      assert.ok(
        error?.message.includes(expectedMessage),
        `Expected error message to contain "${expectedMessage}", got "${error?.message}"`
      );
    } else {
      assert.ok(
        expectedMessage.test(error?.message ?? ''),
        `Expected error message to match ${expectedMessage}, got "${error?.message}"`
      );
    }
  }
}

/**
 * Collect all values from an async generator
 */
export async function collectAsyncGenerator<T>(generator: AsyncGenerator<T>): Promise<T[]> {
  const results: T[] = [];
  for await (const value of generator) {
    results.push(value);
  }
  return results;
}

/**
 * Create a mock readable stream from string chunks
 */
export function createMockReadableStream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let index = 0;

  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index < chunks.length) {
        controller.enqueue(encoder.encode(chunks[index]));
        index++;
      } else {
        controller.close();
      }
    },
  });
}

/**
 * Create SSE formatted data
 */
export function createSSEData(events: Array<{ event?: string; data: unknown }>): string {
  return events
    .map((e) => {
      const lines: string[] = [];
      if (e.event) {
        lines.push(`event: ${e.event}`);
      }
      lines.push(`data: ${JSON.stringify(e.data)}`);
      lines.push('');
      return lines.join('\n');
    })
    .join('\n');
}

/**
 * Wait for a specified number of milliseconds
 */
export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Create a mock fetch response
 */
export function createMockResponse(options: {
  status?: number;
  statusText?: string;
  headers?: Record<string, string>;
  body?: string | ReadableStream<Uint8Array>;
}): Response {
  const { status = 200, statusText = 'OK', headers = {}, body = '' } = options;

  const responseHeaders = new Headers(headers);

  const responseBody =
    typeof body === 'string'
      ? new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(body));
            controller.close();
          },
        })
      : body;

  return new Response(responseBody, {
    status,
    statusText,
    headers: responseHeaders,
  });
}

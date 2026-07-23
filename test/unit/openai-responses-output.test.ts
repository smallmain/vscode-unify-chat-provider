import * as vscode from 'vscode';
import { describe, expect, it, vi } from 'vitest';
import type {
  Response,
  ResponseFunctionToolCall,
  ResponseOutputItem,
  ResponseOutputMessage,
  ResponseReasoningItem,
  ResponseUsage,
} from 'openai/resources/responses/responses';
import type { ChatRequestTrace, ProviderConfig } from '../../src/types';

vi.mock('vscode', () => {
  class LanguageModelTextPart {
    constructor(readonly value: string) {}
  }

  class LanguageModelThinkingPart {
    constructor(
      readonly value: string | string[],
      readonly id?: string,
      readonly metadata?: object,
    ) {}
  }

  class LanguageModelToolCallPart {
    constructor(
      readonly callId: string,
      readonly name: string,
      readonly input: object,
    ) {}
  }

  class LanguageModelDataPart {
    readonly data: Uint8Array;

    constructor(
      data: Uint8Array,
      readonly mimeType: string,
    ) {
      this.data = data;
    }
  }

  return {
    LanguageModelTextPart,
    LanguageModelThinkingPart,
    LanguageModelToolCallPart,
    LanguageModelDataPart,
    LanguageModelChatMessageRole: { User: 1, Assistant: 2, System: 3 },
    LanguageModelToolMode: { Auto: 1, Required: 2 },
    window: {
      createOutputChannel: () => ({
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
      }),
    },
    workspace: {
      getConfiguration: () => ({
        get: (_key: string, fallback: unknown) => fallback,
      }),
    },
  };
});

vi.mock('../../src/client/definitions', () => ({ FeatureId: {} }));

vi.mock('../../src/logger', () => {
  class RequestLogger {
    constructor(readonly requestId: string) {}
    providerResponseChunk(): void {}
    verbose(): void {}
    usage(): void {}
  }

  return {
    RequestLogger,
    authLog: { warn: () => undefined },
    createSimpleHttpLogger: () => undefined,
  };
});

vi.mock('../../src/client/utils', () => ({
  buildBaseUrl: (baseUrl: string) => baseUrl,
  createCopilotUsage: (
    promptTokens: number,
    completionTokens: number,
    cachedTokens: number,
  ) => ({
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: promptTokens + completionTokens,
    prompt_tokens_details: { cached_tokens: cachedTokens },
  }),
  createFirstTokenRecorder: () => () => undefined,
  parseToolArguments: (value: string): object => {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === 'object' && parsed !== null ? parsed : {};
  },
  processUsage: (
    requestTrace: ChatRequestTrace,
    logger: { usage(value: unknown): void },
    usage: ChatRequestTrace['usage'],
  ) => {
    requestTrace.usage = usage;
    logger.usage(usage);
  },
}));

vi.mock('../../src/utils', async () => {
  const vscodeApi = await import('vscode');
  return {
    DEFAULT_NORMAL_TIMEOUT_CONFIG: {
      connection: 60_000,
      response: 300_000,
    },
    encodeStatefulMarkerPart: (_identity: string, data: object) =>
      new vscodeApi.LanguageModelDataPart(
        Buffer.from(JSON.stringify(data)),
        'stateful_marker',
      ),
    isRawBaseUrlEnabled: () => false,
  };
});

import { RequestLogger } from '../../src/logger';
import {
  OpenAIResponsesProvider,
  type OpenAIResponsesStreamEvent,
} from '../../src/client/openai/responses-client';

const providerConfig: ProviderConfig = {
  type: 'openai-responses',
  name: 'test',
  baseUrl: 'https://api.openai.com/v1',
  models: [],
};

const usage: ResponseUsage = {
  input_tokens: 10,
  input_tokens_details: {
    cache_write_tokens: 0,
    cached_tokens: 2,
  },
  output_tokens: 4,
  output_tokens_details: { reasoning_tokens: 1 },
  total_tokens: 14,
};

const cancellationToken: vscode.CancellationToken = {
  isCancellationRequested: false,
  onCancellationRequested: () => ({ dispose: () => undefined }),
};

function createTrace(): ChatRequestTrace {
  return {
    performance: {
      tts: Date.now(),
      ttf: 0,
      ttft: 0,
      tps: 0,
      tl: 0,
    },
  };
}

function createMessage(text: string): ResponseOutputMessage {
  return {
    id: 'msg_test',
    content: [
      {
        type: 'output_text',
        text,
        annotations: [],
      },
    ],
    role: 'assistant',
    status: 'completed',
    type: 'message',
  };
}

function createRefusal(refusal: string): ResponseOutputMessage {
  return {
    id: 'msg_refusal',
    content: [{ type: 'refusal', refusal }],
    role: 'assistant',
    status: 'completed',
    type: 'message',
  };
}

function createResponse(output: ResponseOutputItem[]): Response {
  return {
    id: 'resp_test',
    created_at: 1,
    output_text: output
      .filter(
        (item): item is ResponseOutputMessage => item.type === 'message',
      )
      .flatMap((item) => item.content)
      .filter((content) => content.type === 'output_text')
      .map((content) => content.text)
      .join(''),
    error: null,
    incomplete_details: null,
    instructions: null,
    metadata: null,
    model: 'gpt-5',
    object: 'response',
    output,
    parallel_tool_calls: true,
    temperature: null,
    tool_choice: 'auto',
    tools: [],
    top_p: null,
    status: 'completed',
    usage,
  };
}

async function* streamEvents(
  events: readonly OpenAIResponsesStreamEvent[],
): AsyncGenerator<OpenAIResponsesStreamEvent> {
  yield* events;
}

class TestOpenAIResponsesProvider extends OpenAIResponsesProvider {
  parseStreamForTest(
    events: readonly OpenAIResponsesStreamEvent[],
    requestTrace: ChatRequestTrace,
  ): AsyncGenerator<vscode.LanguageModelResponsePart2> {
    return this.parseMessageStream(
      streamEvents(events),
      'session',
      cancellationToken,
      new RequestLogger('test'),
      requestTrace,
      'identity',
      true,
      'sse',
      'image/png',
    );
  }

  parseResponseForTest(
    response: Response,
    requestTrace: ChatRequestTrace,
  ): AsyncGenerator<vscode.LanguageModelResponsePart2> {
    return this.parseMessage(
      response,
      'session',
      requestTrace,
      new RequestLogger('test'),
      'identity',
      true,
      'http',
      'image/png',
    );
  }
}

const provider = new TestOpenAIResponsesProvider(providerConfig);

async function collectParts(
  stream: AsyncIterable<vscode.LanguageModelResponsePart2>,
): Promise<vscode.LanguageModelResponsePart2[]> {
  const parts: vscode.LanguageModelResponsePart2[] = [];
  for await (const part of stream) {
    parts.push(part);
  }
  return parts;
}

function textValues(
  parts: readonly vscode.LanguageModelResponsePart2[],
): string[] {
  return parts
    .filter(
      (part): part is vscode.LanguageModelTextPart =>
        part instanceof vscode.LanguageModelTextPart,
    )
    .map((part) => part.value);
}

describe('OpenAI Responses output parsing', () => {
  it('emits only the missing suffix from a final text event', async () => {
    const message = createMessage('hello');
    const parts = await collectParts(
      provider.parseStreamForTest(
        [
          {
            type: 'response.output_text.delta',
            content_index: 0,
            delta: 'hel',
            item_id: message.id,
            logprobs: [],
            output_index: 0,
            sequence_number: 1,
          },
          {
            type: 'response.output_text.done',
            content_index: 0,
            item_id: message.id,
            logprobs: [],
            output_index: 0,
            sequence_number: 2,
            text: 'hello',
          },
          {
            type: 'response.output_item.done',
            item: message,
            output_index: 0,
            sequence_number: 3,
          },
          {
            type: 'response.completed',
            response: createResponse([message]),
            sequence_number: 4,
          },
        ],
        createTrace(),
      ),
    );

    expect(textValues(parts)).toEqual(['hel', 'lo']);
    expect(
      parts.filter(
        (part) => part instanceof vscode.LanguageModelDataPart,
      ),
    ).toHaveLength(1);
  });

  it('recovers text from response.completed when text events are absent', async () => {
    const message = createMessage('fallback text');
    const parts = await collectParts(
      provider.parseStreamForTest(
        [
          {
            type: 'response.completed',
            response: createResponse([message]),
            sequence_number: 1,
          },
        ],
        createTrace(),
      ),
    );

    expect(textValues(parts)).toEqual(['fallback text']);
  });

  it('recovers refusals from final events without duplicating them', async () => {
    const message = createRefusal('request refused');
    const parts = await collectParts(
      provider.parseStreamForTest(
        [
          {
            type: 'response.refusal.done',
            content_index: 0,
            item_id: message.id,
            output_index: 0,
            refusal: 'request refused',
            sequence_number: 1,
          },
          {
            type: 'response.completed',
            response: createResponse([message]),
            sequence_number: 2,
          },
        ],
        createTrace(),
      ),
    );

    expect(textValues(parts)).toEqual(['request refused']);
  });

  it('rejects a completed stream that contains only reasoning', async () => {
    const reasoning: ResponseReasoningItem = {
      id: 'reasoning_test',
      summary: [{ type: 'summary_text', text: 'internal reasoning' }],
      type: 'reasoning',
      status: 'completed',
    };
    const requestTrace = createTrace();
    const emittedParts: vscode.LanguageModelResponsePart2[] = [];

    await expect(async () => {
      for await (const part of provider.parseStreamForTest(
        [
          {
            type: 'response.completed',
            response: createResponse([reasoning]),
            sequence_number: 1,
          },
        ],
        requestTrace,
      )) {
        emittedParts.push(part);
      }
    }).rejects.toThrow(
      'OpenAI Responses API completed without output text, refusal, tool calls, or other consumable output.',
    );

    expect(
      emittedParts.some(
        (part) => part instanceof vscode.LanguageModelDataPart,
      ),
    ).toBe(false);
    expect(requestTrace.usage?.total_tokens).toBe(14);
  });

  it('accepts function-call-only responses and emits each call once', async () => {
    const functionCall: ResponseFunctionToolCall = {
      type: 'function_call',
      id: 'fc_test',
      call_id: 'call_test',
      name: 'finish_task',
      arguments: '{"done":true}',
      status: 'completed',
    };
    const parts = await collectParts(
      provider.parseStreamForTest(
        [
          {
            type: 'response.output_item.done',
            item: functionCall,
            output_index: 0,
            sequence_number: 1,
          },
          {
            type: 'response.completed',
            response: createResponse([functionCall]),
            sequence_number: 2,
          },
        ],
        createTrace(),
      ),
    );

    const toolCalls = parts.filter(
      (part): part is vscode.LanguageModelToolCallPart =>
        part instanceof vscode.LanguageModelToolCallPart,
    );
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]).toMatchObject({
      callId: 'call_test',
      name: 'finish_task',
      input: { done: true },
    });
  });

  it('applies the empty-output check to non-streaming responses', async () => {
    const reasoning: ResponseReasoningItem = {
      id: 'reasoning_test',
      summary: [],
      type: 'reasoning',
      status: 'completed',
    };

    await expect(
      collectParts(
        provider.parseResponseForTest(
          createResponse([reasoning]),
          createTrace(),
        ),
      ),
    ).rejects.toThrow(
      'OpenAI Responses API completed without output text, refusal, tool calls, or other consumable output.',
    );
  });
});

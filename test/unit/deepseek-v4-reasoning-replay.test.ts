import { beforeEach, describe, expect, it, vi } from 'vitest';

const network = vi.hoisted(() => ({
  bodies: [] as Record<string, unknown>[],
  fetcher: (async () => new Response('', { status: 500 })) as typeof fetch,
}));

vi.mock('vscode', () => {
  class LanguageModelDataPart {
    constructor(
      readonly data: Uint8Array,
      readonly mimeType: string,
    ) {}
  }

  class LanguageModelTextPart {
    constructor(readonly value: string) {}
  }

  class LanguageModelThinkingPart {
    constructor(
      readonly value: string | string[],
      readonly id?: string,
      readonly metadata?: Record<string, unknown>,
    ) {}
  }

  class LanguageModelToolCallPart {
    constructor(
      readonly callId: string,
      readonly name: string,
      readonly input: object,
    ) {}
  }

  class LanguageModelToolResultPart {
    constructor(
      readonly callId: string,
      readonly content: unknown[],
    ) {}
  }

  return {
    env: { language: 'en' },
    extensions: { getExtension: () => undefined },
    l10n: {
      t: (message: string | { message: string }) =>
        typeof message === 'string' ? message : message.message,
    },
    LanguageModelChatMessageRole: { System: 1, User: 2, Assistant: 3 },
    LanguageModelChatToolMode: { Auto: 1, Required: 2 },
    LanguageModelDataPart,
    LanguageModelTextPart,
    LanguageModelThinkingPart,
    LanguageModelToolCallPart,
    LanguageModelToolResultPart,
    LanguageModelToolResultPart2: LanguageModelToolResultPart,
    window: {
      createOutputChannel: () => ({
        info: () => undefined,
        error: () => undefined,
        warn: () => undefined,
        debug: () => undefined,
        trace: () => undefined,
        append: () => undefined,
        appendLine: () => undefined,
        replace: () => undefined,
        clear: () => undefined,
        show: () => undefined,
        hide: () => undefined,
        dispose: () => undefined,
        name: 'test',
        logLevel: 2,
        onDidChangeLogLevel: () => ({ dispose: () => undefined }),
      }),
    },
    workspace: {
      getConfiguration: () => ({
        get: <T>(_key: string, fallback: T) => fallback,
      }),
    },
  };
});

vi.mock('../../src/client/anthropic/client', () => ({
  AnthropicProvider: class {},
}));
vi.mock('../../src/client/anthropic/claude-code-client', () => ({
  AnthropicClaudeCodeProvider: class {},
}));
vi.mock('../../src/client/google/ai-studio-client', () => ({
  GoogleAIStudioProvider: class {},
}));
vi.mock('../../src/client/google/antigravity-client', () => ({
  GoogleAntigravityProvider: class {},
}));
vi.mock('../../src/client/google/gemini-cli-client', () => ({
  GoogleGeminiCLIProvider: class {},
}));
vi.mock('../../src/client/google/vertex-ai-client', () => ({
  VertexAIProvider: class {},
}));
vi.mock('../../src/client/github-copilot/client', () => ({
  GitHubCopilotProvider: class {},
}));
vi.mock('../../src/client/ollama/client', () => ({
  OllamaProvider: class {},
}));
vi.mock('../../src/client/openai/codex-client', () => ({
  OpenAICodexProvider: class {},
}));
vi.mock('../../src/client/openai/responses-client', () => ({
  OpenAIResponsesProvider: class {},
}));
vi.mock('../../src/client/xai/grok-build-client', () => ({
  XaiGrokBuildProvider: class {},
}));
vi.mock('../../src/client/zed/provider', () => ({
  ZedProvider: class {},
}));
vi.mock('../../src/config-store', () => ({
  CONFIG_NAMESPACE: 'unifyChatProvider',
}));
vi.mock('../../src/official-models-manager', () => ({
  officialModelsManager: {},
}));

vi.mock('../../src/client/utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/client/utils')>();
  return {
    ...actual,
    createCustomFetch: () => network.fetcher,
  };
});

import * as vscode from 'vscode';
import { FeatureId, PROVIDER_TYPES } from '../../src/client/definitions';
import { isFeatureSupported } from '../../src/client/utils';
import { DataPartMimeTypes } from '../../src/client/types';
import { RequestLogger } from '../../src/logger';
import type {
  ChatRequestTrace,
  ModelConfig,
  ProviderConfig,
} from '../../src/types';
import { createStatefulMarkerIdentity } from '../../src/utils';

const encodedModelId = 'custom/deepseek-v4-pro';

class SilentRequestLogger extends RequestLogger {
  override providerRequest(_details: {
    endpoint: string;
    method?: string;
    headers?: Record<string, string>;
    body?: unknown;
  }): void {}

  override providerResponseMeta(_response: Response): void {}
  override providerResponseChunk(_chunk: string): void {}
  override vscodeOutput(_part: vscode.LanguageModelResponsePart2): void {}
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function providerConfig(baseUrl = 'https://custom.example/v1'): ProviderConfig {
  return {
    type: 'openai-chat-completion',
    name: 'Reasoning replay test',
    baseUrl,
    models: [],
  };
}

function model(id = 'deepseek-v4-pro'): ModelConfig {
  return {
    id,
    maxInputTokens: 100_000,
    maxOutputTokens: 4096,
    stream: false,
    thinking: { type: 'enabled', effort: 'high' },
    capabilities: { toolCalling: true },
  };
}

function trace(): ChatRequestTrace {
  return {
    performance: { tts: Date.now(), ttf: 0, ttft: 0, tps: 0, tl: 0 },
  };
}

function cancellationToken(): vscode.CancellationToken {
  return {
    isCancellationRequested: false,
    onCancellationRequested: () => ({ dispose: () => undefined }),
  };
}

function options(): vscode.ProvideLanguageModelChatResponseOptions {
  return {
    requestInitiator: 'test',
    toolMode: vscode.LanguageModelChatToolMode.Auto,
    tools: [
      {
        name: 'lookup',
        description: 'Lookup a value',
        inputSchema: {
          type: 'object',
          properties: { query: { type: 'string' } },
        },
      },
    ],
  };
}

function completionResponse(): Response {
  return new Response(
    JSON.stringify({
      id: 'chatcmpl-test',
      object: 'chat.completion',
      created: 0,
      model: 'test-model',
      choices: [
        {
          index: 0,
          finish_reason: 'stop',
          logprobs: null,
          message: { role: 'assistant', content: 'done' },
        },
      ],
    }),
    {
      status: 200,
      headers: { 'content-type': 'application/json' },
    },
  );
}

async function captureRequestBody(
  config: ProviderConfig,
  selectedModel: ModelConfig,
  messages: readonly vscode.LanguageModelChatRequestMessage[],
  requestModelId = encodedModelId,
): Promise<Record<string, unknown>> {
  const Provider = PROVIDER_TYPES['openai-chat-completion'].class;
  const provider = new Provider(config);
  for await (const part of provider.streamChat(
    requestModelId,
    selectedModel,
    messages,
    options(),
    trace(),
    cancellationToken(),
    new SilentRequestLogger('deepseek-reasoning-replay'),
    { kind: 'token', token: 'test-token' },
  )) {
    void part;
  }

  const body = network.bodies.at(-1);
  if (!body) {
    throw new Error('No Chat Completions request body was captured');
  }
  return body;
}

function createMarker(
  config: ProviderConfig,
  selectedModel: ModelConfig,
  raw: Record<string, unknown>,
  identity = createStatefulMarkerIdentity(config, selectedModel),
): vscode.LanguageModelDataPart {
  const encoded = Buffer.from(
    JSON.stringify({ identity, data: { data: raw } }),
  ).toString('base64');
  return new vscode.LanguageModelDataPart(
    Buffer.from(`${encodedModelId}\\${encoded}`),
    DataPartMimeTypes.StatefulMarker,
  );
}

function toolHistory(
  marker?: vscode.LanguageModelDataPart,
  resultCallIds: readonly ('call-1' | 'call-2')[] = ['call-1', 'call-2'],
): vscode.LanguageModelChatRequestMessage[] {
  return [
    {
      role: vscode.LanguageModelChatMessageRole.User,
      name: undefined,
      content: [new vscode.LanguageModelTextPart('question')],
    },
    {
      role: vscode.LanguageModelChatMessageRole.Assistant,
      name: undefined,
      content: [
        new vscode.LanguageModelThinkingPart('reason-1'),
        new vscode.LanguageModelThinkingPart(['reason-2', 'reason-3']),
        new vscode.LanguageModelTextPart('Calling tools'),
        new vscode.LanguageModelToolCallPart('call-1', 'lookup', {
          query: 'first',
        }),
        new vscode.LanguageModelToolCallPart('call-2', 'lookup', {
          query: 'second',
        }),
        ...(marker ? [marker] : []),
      ],
    },
    {
      role: vscode.LanguageModelChatMessageRole.User,
      name: undefined,
      content: resultCallIds.map(
        (callId) =>
          new vscode.LanguageModelToolResultPart(callId, [
            new vscode.LanguageModelTextPart(
              callId === 'call-1' ? 'first result' : 'second result',
            ),
          ]),
      ),
    },
  ];
}

function requestMessages(body: Record<string, unknown>): unknown[] {
  const messages = body['messages'];
  if (!Array.isArray(messages)) {
    throw new Error('Captured request did not contain a messages array');
  }
  return messages;
}

beforeEach(() => {
  network.bodies = [];
  network.fetcher = async (input, init) => {
    const request = new Request(input, init);
    const parsed: unknown = JSON.parse(await request.text());
    if (!isRecord(parsed)) {
      throw new Error('Chat Completions request body must be an object');
    }
    network.bodies.push(parsed);
    return completionResponse();
  };
});

describe('DeepSeek V4 reasoning replay', () => {
  it('uses real feature matching for custom and ordinary model IDs', () => {
    const config = providerConfig();

    expect(
      isFeatureSupported(
        FeatureId.OpenAIUseReasoningContent,
        config,
        model(),
      ),
    ).toBe(true);
    expect(
      isFeatureSupported(
        FeatureId.OpenAIUseReasoningContent,
        config,
        model('ordinary-chat-model'),
      ),
    ).toBe(false);
  });

  it.each([
    { name: 'without a marker', marker: undefined },
    {
      name: 'with an invalid marker',
      marker: createMarker(
        providerConfig(),
        model(),
        { role: 'assistant', content: 'stale' },
        'wrong-identity',
      ),
    },
  ])('replays a complete multi-tool turn $name', async ({ marker }) => {
    const body = await captureRequestBody(
      providerConfig(),
      model(),
      toolHistory(marker),
    );

    expect(requestMessages(body)).toEqual([
      {
        role: 'user',
        content: [{ type: 'text', text: 'question' }],
      },
      {
        role: 'assistant',
        reasoning_content: 'reason-1reason-2reason-3',
        content: [{ type: 'text', text: 'Calling tools' }],
        tool_calls: [
          {
            id: 'call-1',
            type: 'function',
            function: {
              name: 'lookup',
              arguments: '{"query":"first"}',
            },
          },
          {
            id: 'call-2',
            type: 'function',
            function: {
              name: 'lookup',
              arguments: '{"query":"second"}',
            },
          },
        ],
      },
      { role: 'tool', content: 'first result', tool_call_id: 'call-1' },
      { role: 'tool', content: 'second result', tool_call_id: 'call-2' },
    ]);
  });

  it('keeps valid stateful raw data authoritative, including null content', async () => {
    const config = providerConfig();
    const selectedModel = model();
    const raw = {
      role: 'assistant',
      content: null,
      reasoning_content: 'raw reasoning',
      tool_calls: [
        {
          id: 'call-1',
          type: 'function',
          function: { name: 'lookup', arguments: '{"query":"raw first"}' },
        },
        {
          id: 'call-2',
          type: 'function',
          function: { name: 'lookup', arguments: '{"query":"raw second"}' },
        },
      ],
    };
    const body = await captureRequestBody(
      config,
      selectedModel,
      toolHistory(createMarker(config, selectedModel, raw)),
    );

    expect(requestMessages(body)[1]).toEqual(raw);
  });

  it('drops the whole fallback exchange when one tool result is missing', async () => {
    const body = await captureRequestBody(
      providerConfig(),
      model(),
      toolHistory(undefined, ['call-1']),
    );

    expect(requestMessages(body)).toEqual([
      {
        role: 'user',
        content: [{ type: 'text', text: 'question' }],
      },
    ]);
  });

  it('prefers OpenRouter reasoning_details and reindexes multiple thinking parts', async () => {
    const config = providerConfig('https://openrouter.ai/api/v1');
    const selectedModel = model();

    expect(
      isFeatureSupported(
        FeatureId.OpenAIUseReasoningDetails,
        config,
        selectedModel,
      ),
    ).toBe(true);
    expect(
      isFeatureSupported(
        FeatureId.OpenAIUseReasoningContent,
        config,
        selectedModel,
      ),
    ).toBe(true);

    const body = await captureRequestBody(
      config,
      selectedModel,
      toolHistory(),
    );
    const assistant = requestMessages(body)[1];

    expect(assistant).toEqual({
      role: 'assistant',
      reasoning_details: [
        { type: 'reasoning.text', index: 0, text: 'reason-1' },
        { type: 'reasoning.text', index: 1, text: 'reason-2' },
        { type: 'reasoning.text', index: 2, text: 'reason-3' },
      ],
      content: [{ type: 'text', text: 'Calling tools' }],
      tool_calls: [
        {
          id: 'call-1',
          type: 'function',
          function: {
            name: 'lookup',
            arguments: '{"query":"first"}',
          },
        },
        {
          id: 'call-2',
          type: 'function',
          function: {
            name: 'lookup',
            arguments: '{"query":"second"}',
          },
        },
      ],
    });
    expect(assistant).not.toHaveProperty('reasoning_content');
  });

  it('does not retain an untrusted reasoning tool round for an ordinary model', async () => {
    const body = await captureRequestBody(
      providerConfig(),
      model('ordinary-chat-model'),
      toolHistory(),
      'custom/ordinary-chat-model',
    );

    expect(requestMessages(body)).toEqual([
      {
        role: 'user',
        content: [{ type: 'text', text: 'question' }],
      },
    ]);
  });
});

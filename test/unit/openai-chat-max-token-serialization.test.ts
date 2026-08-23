import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const transport = vi.hoisted((): { fetcher: typeof fetch } => ({
  fetcher: async () => {
    throw new Error('Test fetcher was not configured');
  },
}));

vi.mock('vscode', () => {
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
  class LanguageModelDataPart {
    constructor(
      readonly data: Uint8Array,
      readonly mimeType: string,
    ) {}
  }

  return {
    env: { language: 'en' },
    extensions: { getExtension: () => undefined },
    l10n: { t: (message: string) => message },
    LanguageModelTextPart,
    LanguageModelThinkingPart,
    LanguageModelToolCallPart,
    LanguageModelToolResultPart,
    LanguageModelToolResultPart2: LanguageModelToolResultPart,
    LanguageModelDataPart,
    LanguageModelChatMessageRole: { System: 1, User: 2, Assistant: 3 },
    LanguageModelChatToolMode: { Auto: 1, Required: 2 },
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
    createCustomFetch: () => transport.fetcher,
  };
});

import * as vscode from 'vscode';
import { RequestLogger } from '../../src/logger';
import type {
  ChatRequestTrace,
  ModelConfig,
  ProviderConfig,
} from '../../src/types';

let OpenAIChatCompletionProvider: typeof import('../../src/client/openai/chat-completion-client').OpenAIChatCompletionProvider;

beforeAll(async () => {
  // Load the real feature registry first. It owns provider classes and avoids
  // entering its circular dependency graph from a provider leaf module.
  await import('../../src/client/definitions');
  ({ OpenAIChatCompletionProvider } = await import(
    '../../src/client/openai/chat-completion-client'
  ));
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

async function readRequestBody(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Record<string, unknown>> {
  const text =
    typeof init?.body === 'string'
      ? init.body
      : input instanceof Request
        ? await input.clone().text()
        : undefined;
  if (text === undefined) {
    throw new Error('Expected a JSON request body');
  }

  const parsed: unknown = JSON.parse(text);
  if (!isRecord(parsed)) {
    throw new Error('Expected a JSON object request body');
  }
  return parsed;
}

function successfulCompletion(model: string): Response {
  return new Response(
    JSON.stringify({
      id: 'chatcmpl-test',
      object: 'chat.completion',
      created: 0,
      model,
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: 'ok', refusal: null },
          finish_reason: 'stop',
          logprobs: null,
        },
      ],
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

function successfulStream(model: string): Response {
  const chunks = [
    {
      id: 'chatcmpl-test',
      object: 'chat.completion.chunk',
      created: 0,
      model,
      choices: [
        {
          index: 0,
          delta: { role: 'assistant', content: 'ok' },
          finish_reason: null,
          logprobs: null,
        },
      ],
    },
    {
      id: 'chatcmpl-test',
      object: 'chat.completion.chunk',
      created: 0,
      model,
      choices: [
        {
          index: 0,
          delta: {},
          finish_reason: 'stop',
          logprobs: null,
        },
      ],
    },
  ];
  const body = `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('')}data: [DONE]\n\n`;
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

function duplicateTokenLimitError(): Response {
  return new Response(
    JSON.stringify({
      error: {
        message:
          "Setting 'max_tokens' and 'max_completion_tokens' at the same time is not supported.",
        type: 'invalid_request_error',
      },
    }),
    { status: 400, headers: { 'content-type': 'application/json' } },
  );
}

function cancellationToken(): vscode.CancellationToken {
  return {
    isCancellationRequested: false,
    onCancellationRequested: () => ({ dispose: () => undefined }),
  };
}

function trace(): ChatRequestTrace {
  return {
    performance: { tts: Date.now(), ttf: 0, ttft: 0, tps: 0, tl: 0 },
  };
}

async function collect<T>(source: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const value of source) {
    values.push(value);
  }
  return values;
}

function provider(
  baseUrl: string,
  extraBody?: Record<string, unknown>,
): ProviderConfig {
  return {
    type: 'openai-chat-completion',
    name: 'Test provider',
    baseUrl,
    models: [],
    ...(extraBody ? { extraBody } : {}),
  };
}

async function sendChat(
  providerConfig: ProviderConfig,
  model: ModelConfig,
): Promise<Record<string, unknown>> {
  let requestBody: Record<string, unknown> | undefined;
  transport.fetcher = async (input, init) => {
    requestBody = await readRequestBody(input, init);
    if (
      requestBody['max_tokens'] !== undefined &&
      requestBody['max_completion_tokens'] !== undefined
    ) {
      return duplicateTokenLimitError();
    }
    return requestBody['stream'] === true
      ? successfulStream(model.id)
      : successfulCompletion(model.id);
  };

  const messages: vscode.LanguageModelChatRequestMessage[] = [
    {
      role: vscode.LanguageModelChatMessageRole.User,
      name: undefined,
      content: [new vscode.LanguageModelTextPart('hello')],
    },
  ];
  const parts = await collect(
    new OpenAIChatCompletionProvider(providerConfig).streamChat(
      model.id,
      model,
      messages,
      {
        requestInitiator: 'test',
        toolMode: vscode.LanguageModelChatToolMode.Auto,
        tools: [],
      },
      trace(),
      cancellationToken(),
      new RequestLogger('openai-chat-max-token-test'),
      { kind: 'token', token: 'test-key' },
    ),
  );

  expect(
    parts.some(
      (part) =>
        part instanceof vscode.LanguageModelTextPart && part.value === 'ok',
    ),
  ).toBe(true);
  if (requestBody === undefined) {
    throw new Error('Expected the Chat Completions request to be sent');
  }
  expect(requestBody['stream']).toBe(model.stream ?? true);
  return requestBody;
}

type TokenLimitKey = 'max_tokens' | 'max_completion_tokens';

function expectOnlyTokenLimit(
  body: Record<string, unknown>,
  key: TokenLimitKey,
  value: unknown,
): void {
  const alternate =
    key === 'max_tokens' ? 'max_completion_tokens' : 'max_tokens';
  expect(body).toHaveProperty(key);
  expect(body[key]).toEqual(value);
  expect(body).not.toHaveProperty(alternate);
}

beforeEach(() => {
  transport.fetcher = async () => {
    throw new Error('Test fetcher was not configured');
  };
});

describe('OpenAI Chat Completions max token serialization', () => {
  const routingCases: Array<{
    name: string;
    providerConfig: ProviderConfig;
    model: ModelConfig;
    expectedKey: TokenLimitKey;
  }> = [
    {
      name: 'defaults a legacy custom gateway to max_tokens (non-streaming)',
      providerConfig: provider('https://newapi.example.test/v1'),
      model: { id: 'gpt-4.1-mini', maxOutputTokens: 64, stream: false },
      expectedKey: 'max_tokens',
    },
    {
      name: 'uses max_completion_tokens for a GPT-5 family (streaming)',
      providerConfig: provider('https://newapi.example.test/v1'),
      model: { id: 'gpt-5.5', maxOutputTokens: 65, stream: true },
      expectedKey: 'max_completion_tokens',
    },
    {
      name: 'does not classify gpt-50 as the gpt-5 family',
      providerConfig: provider('https://newapi.example.test/v1'),
      model: { id: 'gpt-50-preview', maxOutputTokens: 66, stream: false },
      expectedKey: 'max_tokens',
    },
    {
      name: 'uses an explicit GPT-5 family for an opaque Azure deployment',
      providerConfig: provider(
        'https://example-resource.openai.azure.com/openai/v1',
      ),
      model: {
        id: 'production-chat',
        family: 'gpt-5.5',
        maxOutputTokens: 67,
        stream: true,
      },
      expectedKey: 'max_completion_tokens',
    },
    {
      name: 'defaults an opaque Azure deployment without family metadata to max_tokens',
      providerConfig: provider(
        'https://example-resource.openai.azure.com/openai/v1',
      ),
      model: {
        id: 'production-chat',
        maxOutputTokens: 68,
        stream: false,
      },
      expectedKey: 'max_tokens',
    },
    {
      name: 'honors an explicit legacy family over a GPT-like deployment name',
      providerConfig: provider(
        'https://example-resource.openai.azure.com/openai/v1',
      ),
      model: {
        id: 'gpt-5-production',
        family: 'gpt-4.1',
        maxOutputTokens: 69,
        stream: true,
      },
      expectedKey: 'max_tokens',
    },
    {
      name: 'keeps max_tokens for a DeepSeek model',
      providerConfig: provider('https://api.deepseek.com/v1'),
      model: {
        id: 'deepseek-chat',
        maxOutputTokens: 70,
        stream: false,
      },
      expectedKey: 'max_tokens',
    },
    {
      name: 'recognizes a namespaced OpenAI model from NVIDIA',
      providerConfig: provider('https://integrate.api.nvidia.com/v1'),
      model: {
        id: 'openai/gpt-oss-120b',
        maxOutputTokens: 71,
        stream: true,
      },
      expectedKey: 'max_completion_tokens',
    },
    {
      name: 'keeps max_tokens for a namespaced DeepSeek model from NVIDIA',
      providerConfig: provider('https://integrate.api.nvidia.com/v1'),
      model: {
        id: 'deepseek-ai/deepseek-v4-pro',
        maxOutputTokens: 72,
        stream: false,
      },
      expectedKey: 'max_tokens',
    },
    {
      name: 'recognizes a namespaced GPT-5 model from OpenRouter',
      providerConfig: provider('https://openrouter.ai/api/v1'),
      model: {
        id: 'openai/gpt-5.5',
        maxOutputTokens: 73,
        stream: true,
      },
      expectedKey: 'max_completion_tokens',
    },
    {
      name: 'keeps max_tokens for a namespaced DeepSeek model from OpenRouter',
      providerConfig: provider('https://openrouter.ai/api/v1'),
      model: {
        id: 'deepseek/deepseek-chat',
        maxOutputTokens: 74,
        stream: false,
      },
      expectedKey: 'max_tokens',
    },
    {
      name: 'honors a provider max_completion_tokens protocol for an opaque model',
      providerConfig: provider('https://api.cerebras.ai/v1'),
      model: {
        id: 'deployment-alias',
        maxOutputTokens: 75,
        stream: true,
      },
      expectedKey: 'max_completion_tokens',
    },
    {
      name: 'prioritizes a provider max_tokens protocol over a GPT-5 family',
      providerConfig: provider('https://api.siliconflow.cn/v1'),
      model: { id: 'gpt-5.5', maxOutputTokens: 76, stream: false },
      expectedKey: 'max_tokens',
    },
  ];

  for (const testCase of routingCases) {
    it(testCase.name, async () => {
      const body = await sendChat(testCase.providerConfig, testCase.model);
      expectOnlyTokenLimit(
        body,
        testCase.expectedKey,
        testCase.model.maxOutputTokens,
      );
    });
  }

  it('normalizes a later model max_completion_tokens override to max_tokens', async () => {
    const body = await sendChat(
      provider('https://newapi.example.test/v1', { max_tokens: 81 }),
      {
        id: 'gpt-4.1-mini',
        maxOutputTokens: 80,
        stream: true,
        extraBody: { max_completion_tokens: 82 },
      },
    );

    expectOnlyTokenLimit(body, 'max_tokens', 82);
  });

  it('normalizes a later model max_tokens override to max_completion_tokens', async () => {
    const body = await sendChat(
      provider('https://newapi.example.test/v1', {
        max_completion_tokens: 91,
      }),
      {
        id: 'gpt-5.5',
        maxOutputTokens: 90,
        stream: false,
        extraBody: { max_tokens: 92 },
      },
    );

    expectOnlyTokenLimit(body, 'max_completion_tokens', 92);
  });

  it('uses the protocol-preferred alias when one extraBody contains both', async () => {
    const body = await sendChat(
      provider('https://newapi.example.test/v1', {
        max_tokens: 101,
        max_completion_tokens: 102,
      }),
      { id: 'gpt-5.5', maxOutputTokens: 100, stream: true },
    );

    expectOnlyTokenLimit(body, 'max_completion_tokens', 102);
  });

  it('maps a null opposite alias without falling back to maxOutputTokens', async () => {
    const body = await sendChat(
      provider('https://newapi.example.test/v1'),
      {
        id: 'gpt-5.5',
        maxOutputTokens: 110,
        stream: false,
        extraBody: { max_tokens: null },
      },
    );

    expectOnlyTokenLimit(body, 'max_completion_tokens', null);
  });

  it('ignores an undefined alias and retains maxOutputTokens', async () => {
    const body = await sendChat(
      provider('https://newapi.example.test/v1', {
        max_completion_tokens: undefined,
      }),
      {
        id: 'gpt-4.1-mini',
        maxOutputTokens: 120,
        stream: true,
      },
    );

    expectOnlyTokenLimit(body, 'max_tokens', 120);
  });

  it('retains a zero token limit instead of treating it as absent', async () => {
    const body = await sendChat(
      provider('https://newapi.example.test/v1'),
      { id: 'gpt-5.5', maxOutputTokens: 0, stream: false },
    );

    expectOnlyTokenLimit(body, 'max_completion_tokens', 0);
  });

  it('omits both aliases when no output limit is configured', async () => {
    const body = await sendChat(
      provider('https://newapi.example.test/v1'),
      { id: 'gpt-4.1-mini', maxOutputTokens: undefined, stream: true },
    );

    expect(body).not.toHaveProperty('max_tokens');
    expect(body).not.toHaveProperty('max_completion_tokens');
  });
});

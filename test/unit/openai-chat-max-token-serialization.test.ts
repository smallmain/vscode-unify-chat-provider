import { beforeEach, describe, expect, it, vi } from 'vitest';

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

vi.mock('../../src/client/definitions', () => {
  const featureId = {
    OpenAIOnlyMaxCompletionTokens: 'openai_only-max-completion-tokens',
    OpenAIOnlyMaxTokens: 'openai_only-max-tokens',
  };
  return {
    FeatureId: featureId,
    FEATURES: {
      [featureId.OpenAIOnlyMaxCompletionTokens]: {
        supportedFamilys: ['gpt-5', 'o1', 'o3', 'o4-mini'],
      },
      [featureId.OpenAIOnlyMaxTokens]: {
        supportedProviders: ['api.mistral.ai', 'api.siliconflow.cn'],
      },
    },
    PROVIDER_TYPES: {},
  };
});

vi.mock('../../src/client/utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/client/utils')>();
  return {
    ...actual,
    createCustomFetch: () => transport.fetcher,
  };
});

import * as vscode from 'vscode';
import { OpenAIChatCompletionProvider } from '../../src/client/openai/chat-completion-client';
import { RequestLogger } from '../../src/logger';
import type {
  ChatRequestTrace,
  ModelConfig,
  ProviderConfig,
} from '../../src/types';

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
    return successfulCompletion(model.id);
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
  return requestBody;
}

beforeEach(() => {
  transport.fetcher = async () => {
    throw new Error('Test fetcher was not configured');
  };
});

describe('OpenAI Chat Completions max token serialization', () => {
  it('sends only max_tokens for a legacy model through a custom compatible gateway', async () => {
    const body = await sendChat(
      {
        type: 'openai-chat-completion',
        name: 'NewAPI',
        baseUrl: 'https://newapi.example.test/v1',
        models: [],
      },
      {
        id: 'gpt-4.1-mini',
        maxOutputTokens: 64,
        stream: false,
      },
    );

    expect(body['max_tokens']).toBe(64);
    expect(body).not.toHaveProperty('max_completion_tokens');
  });

  it('keeps max_completion_tokens for models that require it', async () => {
    const body = await sendChat(
      {
        type: 'openai-chat-completion',
        name: 'NewAPI',
        baseUrl: 'https://newapi.example.test/v1',
        models: [],
      },
      {
        id: 'gpt-5.5',
        maxOutputTokens: 128,
        stream: false,
      },
    );

    expect(body['max_completion_tokens']).toBe(128);
    expect(body).not.toHaveProperty('max_tokens');
  });

  it('keeps max_tokens for providers that explicitly require it', async () => {
    const body = await sendChat(
      {
        type: 'openai-chat-completion',
        name: 'Mistral AI',
        baseUrl: 'https://api.mistral.ai/v1',
        models: [],
      },
      {
        id: 'mistral-medium-3-5',
        maxOutputTokens: 256,
        stream: false,
      },
    );

    expect(body['max_tokens']).toBe(256);
    expect(body).not.toHaveProperty('max_completion_tokens');
  });

  it('prioritizes a provider max_tokens contract over a model-family hint', async () => {
    const body = await sendChat(
      {
        type: 'openai-chat-completion',
        name: 'SiliconFlow',
        baseUrl: 'https://api.siliconflow.cn/v1',
        models: [],
      },
      {
        id: 'gpt-5.5',
        maxOutputTokens: 512,
        stream: false,
      },
    );

    expect(body['max_tokens']).toBe(512);
    expect(body).not.toHaveProperty('max_completion_tokens');
  });
});

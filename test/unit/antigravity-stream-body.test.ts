import { beforeEach, describe, expect, it, vi } from 'vitest';

const network = vi.hoisted(() => {
  const bodies: unknown[] = [];
  const fetcher: typeof fetch = async () =>
    new Response(JSON.stringify({ response: { candidates: [] } }), {
      status: 200,
    });
  return { bodies, fetcher };
});

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

vi.mock('../../src/client/definitions', () => ({
  FeatureId: { GeminiUseThinkingLevel: 'gemini_use-thinking-level' },
}));

vi.mock('../../src/client/utils', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../src/client/utils')>();
  return {
    ...actual,
    createCustomFetch: () => network.fetcher,
  };
});

vi.mock(
  '../../src/auth/providers/antigravity-oauth/version',
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import('../../src/auth/providers/antigravity-oauth/version')
      >();
    return {
      ...actual,
      getAntigravityVersion: async () => '1.1.19',
    };
  },
);

import * as vscode from 'vscode';
import type { AuthTokenInfo } from '../../src/auth/types';
import { GoogleAntigravityProvider } from '../../src/client/google/antigravity-client';
import { RequestLogger } from '../../src/logger';
import type {
  ChatRequestTrace,
  ModelConfig,
  ProviderConfig,
  ThinkingEffort,
} from '../../src/types';

const providerConfig: ProviderConfig = {
  type: 'google-antigravity',
  name: 'Antigravity',
  baseUrl: 'https://cloudcode-pa.googleapis.com',
  models: [],
  auth: { method: 'antigravity-oauth', bindingId: 'binding' },
  retry: { maxRetries: 0 },
};

const credential: AuthTokenInfo = {
  kind: 'token',
  token: 'access-token',
  authContext: {
    method: 'antigravity-oauth',
    bindingId: 'binding',
    sessionId: 'session',
    revision: 1,
    projectId: 'test-project',
  },
};

function messages(): vscode.LanguageModelChatRequestMessage[] {
  return [
    {
      role: vscode.LanguageModelChatMessageRole.User,
      name: undefined,
      content: [new vscode.LanguageModelTextPart('hello')],
    },
  ];
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

async function collect(source: AsyncIterable<unknown>): Promise<void> {
  for await (const _value of source) {
    // Exhaust the request so the captured body is the one sent by streamChat.
  }
}

async function captureRequestBody(
  modelId: string,
  effort?: ThinkingEffort,
): Promise<unknown> {
  const model: ModelConfig = {
    id: modelId,
    stream: false,
    thinking: { type: 'enabled', effort },
  };

  await collect(
    new GoogleAntigravityProvider(providerConfig).streamChat(
      modelId,
      model,
      messages(),
      {
        requestInitiator: 'test',
        toolMode: vscode.LanguageModelChatToolMode.Auto,
        tools: [],
      },
      trace(),
      cancellationToken(),
      new RequestLogger('antigravity-stream-body-test'),
      credential,
    ),
  );

  return network.bodies.at(-1);
}

beforeEach(() => {
  network.bodies.length = 0;
  network.fetcher = async (_input, init) => {
    if (typeof init?.body !== 'string') {
      throw new Error('Expected streamChat to send a JSON request body');
    }
    const body: unknown = JSON.parse(init.body);
    network.bodies.push(body);
    return new Response(JSON.stringify({ response: { candidates: [] } }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
});

describe('Antigravity streamChat request routing', () => {
  it('sends Gemini 3.7 minimal through the low runtime route', async () => {
    const body = await captureRequestBody('gemini-3.7-flash', 'minimal');

    expect(body).toMatchObject({
      model: 'gemini-3.7-flash-low',
      request: {
        generationConfig: {
          thinkingConfig: { includeThoughts: true, thinkingLevel: 'low' },
        },
      },
    });
  });

  it('keeps a manually configured Gemini 3.5 medium wire ID', async () => {
    const body = await captureRequestBody('gemini-3.5-flash-low');

    expect(body).toMatchObject({
      model: 'gemini-3.5-flash-low',
      request: {
        generationConfig: {
          thinkingConfig: { includeThoughts: true, thinkingLevel: 'medium' },
        },
      },
    });
  });
});

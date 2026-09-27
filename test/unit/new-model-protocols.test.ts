import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const network = vi.hoisted(() => ({
  fetch: vi.fn<typeof fetch>(),
  requests: new Array<Request>(),
}));

vi.mock('vscode', () => {
  class LanguageModelTextPart {
    constructor(readonly value: string) {}
  }
  class LanguageModelThinkingPart {
    constructor(readonly value: string | readonly string[]) {}
  }
  class LanguageModelToolCallPart {
    constructor(readonly callId: string, readonly name: string, readonly input: object) {}
  }
  class LanguageModelToolResultPart {
    constructor(readonly callId: string, readonly content: unknown[]) {}
  }
  return {
    LanguageModelTextPart,
    LanguageModelThinkingPart,
    LanguageModelToolCallPart,
    LanguageModelToolResultPart,
    LanguageModelToolResultPart2: class extends LanguageModelToolResultPart {},
    LanguageModelDataPart: class {
      constructor(readonly data: Uint8Array, readonly mimeType: string) {}
    },
    LanguageModelChatMessageRole: { System: 1, User: 2, Assistant: 3 },
    LanguageModelChatToolMode: { Auto: 1, Required: 2 },
    EventEmitter: class {
      readonly event = () => ({ dispose: () => undefined });
      fire(): void {}
      dispose(): void {}
    },
    ThemeIcon: class { constructor(readonly id: string) {} },
    env: { language: 'en' },
    l10n: { t: (message: string) => message },
    extensions: { getExtension: () => undefined },
    workspace: {
      getConfiguration: () => ({ get: (_key: string, fallback?: unknown) => fallback }),
    },
  };
});

vi.mock('../../src/logger', () => {
  class RequestLogger {
    error(): void {}
    verbose(): void {}
    providerRequest(): void {}
    providerResponseChunk(): void {}
    providerResponseMeta(): void {}
  }
  return { RequestLogger };
});

vi.mock('../../src/client/utils', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/client/utils')>(),
  createCustomFetch: () => network.fetch,
}));

vi.mock('../../src/utils', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/utils')>(),
  // Exercise reconstruction from VS Code parts without raw-message restoration.
  sanitizeMessagesForModelSwitch: (
    messages: readonly import('vscode').LanguageModelChatRequestMessage[],
  ) => [...messages],
}));

import * as vscode from 'vscode';
import { PROVIDER_TYPES } from '../../src/client/definitions';
import { RequestLogger } from '../../src/logger';
import { applyPresetTemplateSelections } from '../../src/preset-templates';
import type { ModelConfig, ProviderConfig } from '../../src/types';
import { mergeWithWellKnownModel } from '../../src/well-known/models';

const STOP = 'request-captured';
const history: vscode.LanguageModelChatRequestMessage[] = [
  {
    role: vscode.LanguageModelChatMessageRole.User,
    name: undefined,
    content: [new vscode.LanguageModelTextPart('Calculate the answer.')],
  },
  {
    role: vscode.LanguageModelChatMessageRole.Assistant,
    name: undefined,
    content: [
      new vscode.LanguageModelThinkingPart('I need to use the calculator.'),
      new vscode.LanguageModelToolCallPart('call-1', 'calculate', {}),
    ],
  },
  {
    role: vscode.LanguageModelChatMessageRole.User,
    name: undefined,
    content: [
      new vscode.LanguageModelToolResultPart('call-1', [new vscode.LanguageModelTextPart('42')]),
    ],
  },
];

beforeEach(() => {
  network.requests.length = 0;
  network.fetch.mockImplementation(async (input, init) => {
    network.requests.push(new Request(input, init));
    return new Response(JSON.stringify({ error: { message: STOP } }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', network.fetch);
});

afterEach(() => vi.unstubAllGlobals());

async function requestBody(
  baseUrl: string,
  model: ModelConfig,
  type: ProviderConfig['type'] = 'openai-chat-completion',
): Promise<unknown> {
  const config: ProviderConfig = {
    name: 'New model protocol test', type, baseUrl, models: [],
    proxy: { type: 'direct' }, retry: { maxRetries: 0 },
  };
  const provider = new PROVIDER_TYPES[type].class(config);
  const send = async () => {
    for await (const part of provider.streamChat(
      model.id,
      { ...model, stream: false },
      history,
      { requestInitiator: 'test', toolMode: vscode.LanguageModelChatToolMode.Auto },
      { performance: { tts: Date.now(), ttf: 0, ttft: 0, tps: 0, tl: 0 } },
      { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => undefined }) },
      new RequestLogger('new-model-protocol-test'),
      { kind: 'token', token: 'test-key' },
    )) { void part; }
  };
  await expect(send()).rejects.toThrow(STOP);
  expect(network.requests).toHaveLength(1);
  const body: unknown = await network.requests[0].json();
  return body;
}

describe('New model request protocols', () => {
  it.each([
    ['tsubasa-fast', 8192],
    ['tsubasa-pro', 16384],
  ])('serializes %s through Chat Completions with one token limit', async (id, maxTokens) => {
    const body = await requestBody(
      'https://api.tsubasa.sh/v1',
      mergeWithWellKnownModel({ id }),
    );
    expect(body).toMatchObject({ model: id, max_tokens: maxTokens });
    expect(body).not.toHaveProperty('max_completion_tokens');
    expect(body).not.toHaveProperty('reasoning_effort');
    expect(body).not.toHaveProperty('thinking');
    expect(network.requests[0].url).toBe('https://api.tsubasa.sh/v1/chat/completions');
    expect(network.requests[0].headers.get('Authorization')).toBe('Bearer test-key');
  });

  it.each(['cn', 'sgp', 'ams'])(
    'preserves MiMo thinking and tool-call reasoning on the %s Token Plan',
    async (region) => {
      const body = await requestBody(
        `https://token-plan-${region}.xiaomimimo.com/v1`,
        mergeWithWellKnownModel({ id: 'mimo-v2.6-pro' }),
      );
      expect(body).toMatchObject({
        thinking: { type: 'enabled' },
        max_completion_tokens: 128000,
        messages: expect.arrayContaining([
          expect.objectContaining({
            role: 'assistant',
            reasoning_content: 'I need to use the calculator.',
          }),
        ]),
      });
      expect(body).not.toHaveProperty('reasoning_effort');
    },
  );

  it.each(['high', 'none'] as const)('sends supported Hy4 %s parameters', async (effort) => {
    const model = applyPresetTemplateSelections(
      mergeWithWellKnownModel({ id: 'hy4-preview' }),
      { reasoningEffort: effort },
    );
    const body = await requestBody('https://tokenhub.tencentmaas.com', model);
    expect(body).toMatchObject({
      thinking: { type: effort === 'none' ? 'disabled' : 'enabled' },
    });
    if (effort === 'none') {
      expect(body).not.toHaveProperty('reasoning_effort');
    } else {
      expect(body).toHaveProperty('reasoning_effort', 'high');
    }
  });

  it('preserves Kimi K2.8 reasoning on the overseas Coding API', async () => {
    const body = await requestBody(
      'https://api.kimi.ai/coding/v1',
      mergeWithWellKnownModel({ id: 'kimi-for-coding' }),
    );
    expect(body).toMatchObject({
      model: 'kimi-for-coding',
      reasoning_effort: 'max',
      max_completion_tokens: 131072,
      messages: expect.arrayContaining([
        expect.objectContaining({
          role: 'assistant',
          reasoning_content: 'I need to use the calculator.',
        }),
      ]),
    });
  });

  it('sends Fable 5.1 xhigh without converting it to max', async () => {
    const model = applyPresetTemplateSelections(
      mergeWithWellKnownModel({ id: 'claude-fable-5-1' }),
      { reasoningEffort: 'xhigh' },
    );
    const body = await requestBody('https://api.anthropic.com', model, 'anthropic');
    expect(body).toMatchObject({ output_config: { effort: 'xhigh' } });
  });
});

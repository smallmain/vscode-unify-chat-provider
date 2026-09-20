import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiProvider } from '../../src/client/interface';
import type { ChatRequestTrace, ModelConfig, ProviderConfig } from '../../src/types';

const state = vi.hoisted(() => ({
  fetch: vi.fn<typeof fetch>(),
  requests: new Array<Request>(),
  webSocketHeaders: new Array<Record<string, string>>(),
}));

vi.mock('vscode', () => {
  class LanguageModelTextPart {
    constructor(readonly value: string) {}
  }
  class LanguageModelDataPart {
    constructor(readonly data: Uint8Array, readonly mimeType: string) {}
  }
  class LanguageModelToolCallPart {
    constructor(readonly callId: string, readonly name: string, readonly input: object) {}
  }
  class LanguageModelToolResultPart {
    constructor(readonly callId: string, readonly content: unknown[]) {}
  }
  return {
    LanguageModelTextPart,
    LanguageModelDataPart,
    LanguageModelThinkingPart: class {
      constructor(readonly value: string | readonly string[]) {}
    },
    LanguageModelToolCallPart,
    LanguageModelToolResultPart,
    LanguageModelToolResultPart2: class extends LanguageModelToolResultPart {},
    LanguageModelChatMessageRole: { System: 1, User: 2, Assistant: 3 },
    LanguageModelChatToolMode: { Auto: 1, Required: 2 },
    EventEmitter: class {
      readonly event = () => ({ dispose: () => undefined });
      fire(): void {}
      dispose(): void {}
    },
    ThemeIcon: class {
      constructor(readonly id: string) {}
    },
    env: { language: 'en' },
    l10n: { t: (value: string) => value },
    extensions: { getExtension: () => undefined },
    workspace: { getConfiguration: () => ({ get: (_key: string, fallback?: unknown) => fallback }) },
  };
});

vi.mock('../../src/logger', () => {
  class RequestLogger {
    constructor(readonly requestId: string) {}
    error(): void {}
    verbose(): void {}
    providerRequest(): void {}
    providerResponseChunk(): void {}
    providerResponseMeta(): void {}
  }
  return {
    RequestLogger,
    createSimpleHttpLogger: () => new RequestLogger('catalog'),
    authLog: { error: vi.fn(), warn: vi.fn(), verbose: vi.fn() },
  };
});

vi.mock('../../src/client/utils', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/client/utils')>(),
  createCustomFetch: () => state.fetch,
}));

vi.mock('../../src/client/openai/responses-websocket-transport', () => ({
  OpenAIResponsesWebSocketTransport: class {
    constructor(_client: unknown, headers: Record<string, string>) {
      state.webSocketHeaders.push({ ...headers });
      throw new Error('intentional-header-test-stop');
    }
  },
}));

import * as vscode from 'vscode';
import { RequestLogger } from '../../src/logger';
import { PROVIDER_TYPES } from '../../src/client/definitions';
import { deriveOpenCodeSessionId } from '../../src/client/opencode/session';

const STOP = 'intentional-header-test-stop';
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const messages: readonly vscode.LanguageModelChatRequestMessage[] = [{
  role: vscode.LanguageModelChatMessageRole.User,
  name: undefined,
  content: [new vscode.LanguageModelTextPart('hello')],
}];

function configuration(type: ProviderConfig['type'], baseUrl = 'https://opencode.ai/zen/go/v1'): ProviderConfig {
  return {
    type, name: 'OpenCode session test', baseUrl, models: [], transport: 'sse',
    proxy: { type: 'direct' }, retry: { maxRetries: 0 },
  };
}

function trace(): ChatRequestTrace {
  return { performance: { tts: Date.now(), ttf: 0, ttft: 0, tps: 0, tl: 0 } };
}

async function send(
  provider: ApiProvider,
  model: ModelConfig,
  history = messages,
  requestTrace = trace(),
): Promise<void> {
  for await (const part of provider.streamChat(
    `OpenCode session test/${model.id}`,
    model,
    history,
    { requestInitiator: 'test', toolMode: vscode.LanguageModelChatToolMode.Auto },
    requestTrace,
    { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => undefined }) },
    new RequestLogger('session-test'),
    { kind: 'token', token: 'test-key' },
  )) {
    void part;
  }
}

beforeEach(() => {
  state.requests.length = 0;
  state.webSocketHeaders.length = 0;
  state.fetch.mockImplementation(async (input, init) => {
    state.requests.push(new Request(input, init));
    // Stop after the real SDK has serialized the outbound request.
    return new Response(JSON.stringify({ error: { message: STOP }, message: STOP }), {
      status: 400, headers: { 'Content-Type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', state.fetch);
});

afterEach(() => vi.unstubAllGlobals());

const routes = [
  ['opencode-go', 'glm-5.3-flash', '/zen/go/v1/chat/completions'],
  ['opencode-go', 'minimax-m3', '/zen/go/v1/messages'],
  ['opencode-go', 'gpt-5.6-luna', '/zen/go/v1/responses'],
  ['opencode-zen', 'deepseek-v4-flash', '/zen/v1/chat/completions'],
  ['opencode-zen', 'claude-sonnet-5', '/zen/v1/messages'],
  ['opencode-zen', 'gpt-5.6-sol', '/zen/v1/responses'],
  ['opencode-zen', 'gemini-3.8-flash', '/zen/v1/models/gemini-3.8-flash:'],
  ['openai-chat-completion', 'glm-5.3-flash', '/zen/go/v1/chat/completions'],
  ['anthropic', 'minimax-m3', '/zen/go/v1/messages'],
  ['openai-responses', 'gpt-5.6-luna', '/zen/go/v1/responses'],
  ['google-ai-studio', 'gemini-3.8-flash', '/zen/go/v1/models/gemini-3.8-flash:'],
] as const;

describe.each([false, true])('OpenCode SDK request headers (stream=%s)', (stream) => {
  it.each(routes)('sends the session header for %s / %s', async (type, id, pathname) => {
    const config = configuration(type);
    const provider = new PROVIDER_TYPES[type].class(config);
    await expect(send(provider, { id, stream })).rejects.toThrow(STOP);
    expect(state.requests).toHaveLength(1);
    const request = state.requests[0];
    expect(new URL(request.url).pathname).toContain(pathname);
    expect(request.headers.get('x-opencode-session')).toBe(deriveOpenCodeSessionId(id, messages));
    expect(request.headers.get('user-agent')).toContain('ucp/');
  });
});

describe('OpenCode request isolation', () => {
  it('sends the same fallback header on Responses WebSocket retries', async () => {
    const config: ProviderConfig = {
      ...configuration('opencode-go'), transport: 'websocket',
    };
    const provider = new PROVIDER_TYPES['opencode-go'].class(config);
    const model = { id: 'gpt-5.6-luna', stream: true };
    const requestTrace = trace();
    await expect(send(provider, model, [], requestTrace)).rejects.toThrow(STOP);
    await expect(send(provider, model, [], requestTrace)).rejects.toThrow(STOP);
    expect(state.requests).toHaveLength(0);
    expect(state.webSocketHeaders).toHaveLength(2);
    const id = state.webSocketHeaders[0]['x-opencode-session'];
    expect(id).toMatch(UUID);
    expect(state.webSocketHeaders[1]['x-opencode-session']).toBe(id);
  });

  it.each(routes.slice(0, 7))('preserves explicit headers through %s / %s', async (type, id) => {
    const config = {
      ...configuration(type),
      extraHeaders: { 'X-OpenCode-Session': 'provider-session' },
    };
    const model: ModelConfig = {
      id, stream: false, extraHeaders: { 'x-opencode-session': 'model-session' },
    };
    await expect(send(new PROVIDER_TYPES[type].class(config), model)).rejects.toThrow(STOP);
    expect(state.requests).toHaveLength(1);
    expect(state.requests[0].headers.get('x-opencode-session')).toBe('model-session');
    expect(config.extraHeaders).toEqual({ 'X-OpenCode-Session': 'provider-session' });
    expect(model.extraHeaders).toEqual({ 'x-opencode-session': 'model-session' });
  });

  it('keeps image-only request retries stable without persisting the fallback ID', async () => {
    const config = configuration('opencode-go');
    const model: ModelConfig = { id: 'glm-5.3-flash', stream: false, capabilities: { imageInput: true } };
    const provider = new PROVIDER_TYPES['opencode-go'].class(config);
    const history = [{
      role: vscode.LanguageModelChatMessageRole.User,
      name: undefined,
      content: [new vscode.LanguageModelDataPart(new Uint8Array([1]), 'image/png')],
    }];
    const requestTrace = trace();
    await expect(send(provider, model, history, requestTrace)).rejects.toThrow(STOP);
    await expect(send(provider, model, history, requestTrace)).rejects.toThrow(STOP);
    await expect(send(provider, model, history)).rejects.toThrow(STOP);
    const ids = state.requests.map((request) => request.headers.get('x-opencode-session'));
    expect(ids[0]).toMatch(UUID);
    expect(ids[1]).toBe(ids[0]);
    expect(ids[2]).not.toBe(ids[0]);
    expect(config.extraHeaders).toBeUndefined();
    expect(model.extraHeaders).toBeUndefined();
  });

  it.each([
    'openai-chat-completion', 'openai-responses', 'anthropic', 'google-ai-studio',
  ] as const)('does not add an OpenCode header to another %s provider', async (type) => {
    const config = configuration(type, 'https://api.example.test/v1');
    await expect(send(new PROVIDER_TYPES[type].class(config), {
      id: 'test-model', stream: false,
    })).rejects.toThrow(STOP);
    expect(state.requests).toHaveLength(1);
    expect(state.requests[0].headers.has('x-opencode-session')).toBe(false);
  });
});

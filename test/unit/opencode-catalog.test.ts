import { beforeEach, describe, expect, it, vi } from 'vitest';

const httpLogger = vi.hoisted(() => ({
  error: vi.fn(),
}));

vi.mock('vscode', () => ({
  Disposable: class Disposable {
    constructor(private readonly callback: () => void = () => undefined) {}
    dispose(): void {
      this.callback();
    }
  },
  EventEmitter: class EventEmitter<T> {
    private readonly listeners = new Set<(value: T) => void>();
    readonly event = (listener: (value: T) => void) => {
      this.listeners.add(listener);
      return { dispose: () => this.listeners.delete(listener) };
    };
    fire(value: T): void {
      for (const listener of this.listeners) listener(value);
    }
    dispose(): void {
      this.listeners.clear();
    }
  },
  env: { language: 'en' },
  extensions: { getExtension: () => undefined },
  l10n: {
    t: (message: string | { message: string }) =>
      typeof message === 'string' ? message : message.message,
  },
  workspace: {
    getConfiguration: () => ({
      get: <T>(_key: string, fallback: T) => fallback,
    }),
  },
}));

vi.mock('../../src/logger', () => ({
  createSimpleHttpLogger: () => httpLogger,
}));

vi.mock('../../src/client/utils', () => ({
  createCustomFetch: () => {
    throw new Error('The injected test fetcher should be used.');
  },
  getToken: (credential: { kind: string; token?: string }) =>
    credential.kind === 'token' ? credential.token : undefined,
  getTokenType: (credential: { kind: string; tokenType?: string }) =>
    credential.kind === 'token' ? credential.tokenType : undefined,
  getUnifiedUserAgent: () => 'ucp/test',
  matchProvider: (url: string, pattern: string | RegExp) =>
    typeof pattern === 'string'
      ? url.includes(pattern.replaceAll('*', ''))
      : pattern.test(url),
  mergeHeaders: (
    token: string | undefined,
    ...sources: Array<Record<string, string> | undefined>
  ) => {
    const headers: Record<string, string> = Object.assign(
      {},
      ...sources.filter(Boolean),
    );
    for (const [key, value] of Object.entries(headers)) {
      headers[key] = value.replaceAll('${APIKEY}', token ?? '${APIKEY}');
    }
    return headers;
  },
  setUserAgentHeader: (headers: Record<string, string>, userAgent: string) => {
    headers['User-Agent'] = userAgent;
  },
}));

vi.mock('../../src/utils', () => ({
  DEFAULT_NORMAL_TIMEOUT_CONFIG: {
    connection: 20_000,
    response: 120_000,
  },
  resolveChatNetwork: () => ({ proxy: undefined }),
}));

import {
  fetchOpenCodeCatalog,
  getOpenCodeCatalogUrl,
  type OpenCodeCatalogFetch,
  parseOpenCodeCatalog,
} from '../../src/well-known/opencode-catalog';
import { prepareOfficialModels } from '../../src/well-known/opencode-models';
import type { ProviderConfig } from '../../src/types';

const geminiIds = [
  'gemini-3-flash',
  'gemini-3.1-pro',
  'gemini-3.5-flash',
  'gemini-3.5-flash-lite',
  'gemini-3.6-flash',
  'gemini-3.7-flash',
] as const;

function geminiProvider(): ProviderConfig {
  return {
    type: 'google-ai-studio',
    name: 'OpenCode Zen (Gemini)',
    baseUrl: 'https://opencode.ai/zen',
    models: [],
  };
}

beforeEach(() => {
  httpLogger.error.mockReset();
});

describe('OpenCode model catalog transport', () => {
  it('uses canonical catalog URLs for both OpenCode services', () => {
    expect(getOpenCodeCatalogUrl(geminiProvider())).toBe(
      'https://opencode.ai/zen/v1/models',
    );
    expect(
      getOpenCodeCatalogUrl({
        ...geminiProvider(),
        baseUrl: 'https://opencode.ai/zen/go/v1',
      }),
    ).toBe('https://opencode.ai/zen/go/v1/models');
  });

  it('fetches the real Zen catalog URL and delivers six Gemini models', async () => {
    const fetcher = vi.fn<OpenCodeCatalogFetch>(async (input, init) => {
      expect(input.toString()).toBe('https://opencode.ai/zen/v1/models');
      expect(init?.method).toBe('GET');
      expect(new Headers(init?.headers).get('authorization')).toBe(
        'Bearer zen-key',
      );

      return new Response(
        JSON.stringify({
          object: 'list',
          data: [
            ...geminiIds.map((id) => ({
              id,
              object: 'model',
              owned_by: 'opencode',
            })),
            {
              id: 'gpt-5.6-sol',
              object: 'model',
              owned_by: 'opencode',
            },
          ],
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      );
    });
    const provider = geminiProvider();

    const rawModels = await fetchOpenCodeCatalog(
      provider,
      { kind: 'token', token: 'zen-key' },
      undefined,
      fetcher,
    );
    const models = prepareOfficialModels(rawModels, provider);

    expect(fetcher).toHaveBeenCalledOnce();
    expect(models.map((model) => model.id)).toEqual(geminiIds);
  });

  it('rejects a Google-shaped response instead of silently returning no models', () => {
    expect(() =>
      parseOpenCodeCatalog({
        models: geminiIds.map((name) => ({ name })),
      }),
    ).toThrowError('expected an OpenAI list response');
  });
});

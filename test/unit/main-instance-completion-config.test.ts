import { describe, expect, it, vi } from 'vitest';

const mainInstanceState = vi.hoisted(() => ({
  handlers: new Map<string, (params: unknown) => Promise<unknown>>(),
  runLeaderMutation: vi.fn(
    async (work: () => Promise<unknown>): Promise<unknown> => await work(),
  ),
}));

const authLogState = vi.hoisted(() => ({
  error: vi.fn(),
}));

vi.mock('vscode', () => ({
  env: { language: 'en' },
  l10n: { t: (message: string) => message },
}));

vi.mock('../../src/logger', () => ({
  authLog: {
    appendLine: vi.fn(),
    error: authLogState.error,
    verbose: vi.fn(),
    warn: vi.fn(),
  },
}));

vi.mock('../../src/main-instance/index', () => ({
  mainInstance: {
    registerHandler: vi.fn(
      (method: string, handler: (params: unknown) => Promise<unknown>) => {
        mainInstanceState.handlers.set(method, handler);
      },
    ),
    runLeaderMutation: mainInstanceState.runLeaderMutation,
  },
}));

vi.mock('../../src/client/definitions', () => ({
  PROVIDER_TYPES: { 'openai-chat-completion': {}, zed: {} },
}));

vi.mock('../../src/utils', () => ({
  normalizeUseRawBaseUrl: (value: unknown) => value === true,
}));

vi.mock('../../src/vscode-model-id-migration', () => ({
  migrateLegacyVSCodeModelIds: vi.fn(),
}));

import { migrateLegacyVSCodeModelIds } from '../../src/vscode-model-id-migration';
import {
  parseAuthConfig,
  parseModelConfig,
  parseLocalAuthCommitGuard,
  parseProviderSourceGuard,
  parseOfficialModelsFetchState,
  parseProviderConfig,
  registerMainInstanceHandlers,
} from '../../src/main-instance/register-handlers';
import {
  MAIN_INSTANCE_COMPATIBILITY_VERSION,
  PROTOCOL_VERSION,
} from '../../src/main-instance/protocol';

const METHOD = 'config.syncPersistedProvider';

describe('main-instance completion configuration sync', () => {
  const officialState = {
    lastFetchTime: 1,
    models: [{ id: 'cloud-model' }],
    modelsHash: 'hash',
    consecutiveIdenticalFetches: 0,
    currentIntervalMs: 60_000,
  };

  it('round-trips provider-agnostic official model state', () => {
    expect(
      parseOfficialModelsFetchState(
        officialState,
        'officialModels.applyProviderState',
      ),
    ).toEqual(officialState);
  });

  it('strictly parses local auth commit guards', () => {
    const guard = {
      staticConfigFingerprint: 'a'.repeat(64),
      epoch: 2,
      sessionId: 'session-1',
      revision: 7,
    };
    expect(parseLocalAuthCommitGuard(guard, METHOD)).toEqual(guard);
    expect(() =>
      parseLocalAuthCommitGuard(
        { ...guard, staticConfigFingerprint: 'not-a-fingerprint' },
        METHOD,
      ),
    ).toThrowError(
      expect.objectContaining({
        code: 'BAD_REQUEST',
        message: expect.stringContaining('invalid auth commit guard'),
      }),
    );
  });

  it('strictly parses provider source guards', () => {
    const guard = {
      expectations: [
        { providerName: 'new-provider', expected: 'absent' },
        {
          providerName: 'old-provider',
          expected: 'present',
          authTargetSignature: 'b'.repeat(64),
        },
      ],
    } as const;
    expect(parseProviderSourceGuard(guard, METHOD)).toEqual(guard);
    expect(() =>
      parseProviderSourceGuard(
        {
          expectations: [
            {
              providerName: 'provider',
              expected: 'present',
              authTargetSignature: 'not-a-signature',
              leakedSecret: 'secret',
            },
          ],
        },
        METHOD,
      ),
    ).toThrowError(
      expect.objectContaining({
        code: 'BAD_REQUEST',
        message: expect.stringContaining('invalid provider source guard'),
      }),
    );
  });

  it('rejects method-incompatible and unknown auth fields', () => {
    expect(() =>
      parseAuthConfig(
        { method: 'none', token: 'must-not-persist' },
        METHOD,
      ),
    ).toThrowError(
      expect.objectContaining({
        code: 'BAD_REQUEST',
        message: expect.stringContaining('invalid authConfig'),
      }),
    );
    expect(() =>
      parseAuthConfig(
        {
          method: 'oauth2',
          bindingId: '00000000-0000-4000-8000-000000000120',
          oauth: {
            grantType: 'client_credentials',
            tokenUrl: 'https://identity.example.test/token',
            clientId: 'client',
            futureSecret: 'must-not-persist',
          },
        },
        METHOD,
      ),
    ).toThrowError(
      expect.objectContaining({
        code: 'BAD_REQUEST',
        message: expect.stringContaining('invalid authConfig'),
      }),
    );
  });

  it('reconstructs auth DTOs without retaining the input object', () => {
    const input = {
      method: 'api-key' as const,
      label: 'API key',
      apiKey: '$UCPSECRET:00000000-0000-4000-8000-000000000121$',
    };
    const parsed = parseAuthConfig(input, METHOD);
    expect(parsed).toEqual(input);
    expect(parsed).not.toBe(input);
  });

  it('normalizes provider and model configuration without losing empty arrays', () => {
    expect(
      parseProviderConfig(
        {
          type: 'openai-chat-completion',
          name: 'provider',
          baseUrl: 'https://api.example.test/v1',
          completion: {
            transport: 'native',
            baseUrl: ' https://completion.example.test/v1 ',
            templates: ['copilot-replica-nes', 'fim', 'fim'],
          },
          models: [
            {
              id: 'disabled-model',
              completion: { templates: [] },
            },
          ],
        },
        METHOD,
      ),
    ).toMatchObject({
      completion: {
        transport: 'native',
        baseUrl: 'https://completion.example.test/v1',
        templates: ['fim', 'copilot-replica-nes'],
      },
      models: [
        {
          id: 'disabled-model',
          completion: { templates: [] },
        },
      ],
    });
  });

  it('rejects legacy provider fields with a stable BAD_REQUEST diagnostic', () => {
    expect(() =>
      parseProviderConfig(
        {
          type: 'openai-chat-completion',
          name: 'provider',
          baseUrl: 'https://api.example.test/v1',
          completion: { fimType: 'native' },
          models: [],
        },
        METHOD,
      ),
    ).toThrowError(
      expect.objectContaining({
        code: 'BAD_REQUEST',
        message: expect.stringContaining(
          'provider.completion: completion-unknown-field (fimType)',
        ),
      }),
    );
  });

  it('rejects invalid model fields at the indexed model path', () => {
    expect(() =>
      parseProviderConfig(
        {
          type: 'openai-chat-completion',
          name: 'provider',
          baseUrl: 'https://api.example.test/v1',
          models: [
            {
              id: 'model',
              completion: { templates: ['unknown'] },
            },
          ],
        },
        METHOD,
      ),
    ).toThrowError(
      expect.objectContaining({
        code: 'BAD_REQUEST',
        message: expect.stringContaining(
          'provider.models[0].completion: completion-invalid-templates',
        ),
      }),
    );
  });

  it('round-trips Zed auth and rejects malformed organization settings', () => {
    const provider = parseProviderConfig(
      {
        type: 'zed',
        name: 'zed-cloud',
        baseUrl: 'https://zed.dev',
        models: [],
        auth: {
          method: 'zed',
          bindingId: '00000000-0000-4000-8000-000000000110',
          identityId: 'identity',
          token: '$UCPSECRET:credential$',
          organizationId: 'org-1',
          dataCollection: true,
        },
      },
      METHOD,
    );
    expect(provider.auth).toEqual({
      method: 'zed',
      bindingId: '00000000-0000-4000-8000-000000000110',
      identityId: 'identity',
      token: '$UCPSECRET:credential$',
      organizationId: 'org-1',
      dataCollection: true,
    });

    expect(() =>
      parseProviderConfig(
        {
          type: 'zed',
          name: 'zed-cloud',
          baseUrl: 'https://zed.dev',
          models: [],
          auth: {
            method: 'zed',
            bindingId: '00000000-0000-4000-8000-000000000110',
            organizationId: 7,
            dataCollection: 'yes',
          },
        },
        METHOD,
      ),
    ).toThrowError(
      expect.objectContaining({
        code: 'BAD_REQUEST',
        message: expect.stringContaining('invalid authConfig'),
      }),
    );
  });

  it('keeps absent completion unspecified so invalid stored state is not collapsed', () => {
    const model = parseModelConfig({ id: 'model' });
    expect(model).not.toBeNull();
    expect(Object.hasOwn(model ?? {}, 'completion')).toBe(false);
    expect(model?.completion).toBeUndefined();

    const provider = parseProviderConfig(
      {
        type: 'openai-chat-completion',
        name: 'provider',
        baseUrl: 'https://api.example.test/v1',
        models: [{ id: 'model' }],
      },
      METHOD,
    );
    expect(Object.hasOwn(provider, 'completion')).toBe(false);
    expect(Object.hasOwn(provider.models[0], 'completion')).toBe(false);
  });

  it('preserves an explicit empty object as a reset override', () => {
    const provider = parseProviderConfig(
      {
        type: 'openai-chat-completion',
        name: 'provider',
        baseUrl: 'https://api.example.test/v1',
        completion: {},
        models: [{ id: 'model', completion: {} }],
      },
      METHOD,
    );
    expect(Object.hasOwn(provider, 'completion')).toBe(true);
    expect(provider.completion).toEqual({});
    expect(Object.hasOwn(provider.models[0], 'completion')).toBe(true);
    expect(provider.models[0].completion).toEqual({});
  });

  it('uses compatibility version 7 without changing protocol version 1', () => {
    expect(MAIN_INSTANCE_COMPATIBILITY_VERSION).toBe(7);
    expect(PROTOCOL_VERSION).toBe(1);
  });

  it('keeps a committed provider save successful when model ID migration fails', async () => {
    mainInstanceState.handlers.clear();
    mainInstanceState.runLeaderMutation.mockClear();
    authLogState.error.mockReset();
    vi.mocked(migrateLegacyVSCodeModelIds).mockReset();
    vi.mocked(migrateLegacyVSCodeModelIds).mockRejectedValueOnce(
      new Error('migration failed'),
    );
    const provider = {
      type: 'openai-chat-completion',
      name: 'provider',
      baseUrl: 'https://api.example.test/v1',
      models: [],
      auth: { method: 'api-key', apiKey: 'secret-ref' },
    } as const;
    const commit = vi.fn();
    const rollback = vi.fn(async () => undefined);
    const upsertProvider = vi.fn(async () => undefined);
    const clearProvider = vi.fn();
    const options = {
      configStore: { upsertProvider },
      authManager: {
        prepareProviderForPersistence: vi.fn(async () => ({
          provider,
          commit,
          rollback,
        })),
        clearProvider,
      },
      balanceManager: {},
      officialModelsManager: {},
    } as unknown as Parameters<typeof registerMainInstanceHandlers>[0];
    registerMainInstanceHandlers(options);
    const handler = mainInstanceState.handlers.get(METHOD);
    if (!handler) throw new Error('Expected provider sync handler.');

    await expect(handler({ provider })).resolves.toEqual({ ok: true });

    expect(upsertProvider).toHaveBeenCalledOnce();
    expect(commit).toHaveBeenCalledOnce();
    expect(rollback).not.toHaveBeenCalled();
    expect(clearProvider).toHaveBeenCalledWith('provider');
    expect(authLogState.error).toHaveBeenCalledOnce();
  });
});

import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({
  env: { language: 'en' },
  l10n: { t: (message: string) => message },
}));

vi.mock('../../src/logger', () => ({
  authLog: {
    appendLine: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../../src/main-instance/index', () => ({
  mainInstance: { registerHandler: vi.fn() },
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

import {
  parseModelConfig,
  parseOfficialModelsFetchState,
  parseProviderConfig,
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

  it('uses compatibility version 5 without changing protocol version 1', () => {
    expect(MAIN_INSTANCE_COMPATIBILITY_VERSION).toBe(5);
    expect(PROTOCOL_VERSION).toBe(1);
  });
});

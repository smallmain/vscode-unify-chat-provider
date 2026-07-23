import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  values: {} as Record<string, unknown>,
  updates: [] as Array<{ key: string; value: unknown; target: number }>,
  beforeEndpointWrite: undefined as (() => void | Promise<void>) | undefined,
  configurationListeners: new Set<
    (event: { affectsConfiguration(section: string): boolean }) => void
  >(),
}));

vi.mock('vscode', () => {
  class Disposable {
    constructor(private readonly callback: () => void = () => undefined) {}

    dispose(): void {
      this.callback();
    }
  }

  class EventEmitter<T> {
    private readonly listeners = new Set<(value: T) => void>();
    readonly event = (listener: (value: T) => void): Disposable => {
      this.listeners.add(listener);
      return new Disposable(() => this.listeners.delete(listener));
    };

    fire(value: T): void {
      for (const listener of this.listeners) {
        listener(value);
      }
    }

    dispose(): void {
      this.listeners.clear();
    }
  }

  return {
    ConfigurationTarget: { Global: 1 },
    Disposable,
    EventEmitter,
    env: { language: 'en' },
    l10n: { t: (message: string) => message },
    workspace: {
      getConfiguration: () => ({
        get: (key: string) => state.values[key],
        update: async (key: string, value: unknown, target: number) => {
          if (key === 'endpoints') await state.beforeEndpointWrite?.();
          state.updates.push({ key, value, target });
          state.values[key] = value;
          for (const listener of state.configurationListeners) {
            listener({
              affectsConfiguration: (section) =>
                section === 'unifyChatProvider' ||
                section === `unifyChatProvider.${key}`,
            });
          }
        },
      }),
      onDidChangeConfiguration: (
        listener: (event: {
          affectsConfiguration(section: string): boolean;
        }) => void,
      ) => {
        state.configurationListeners.add(listener);
        return new Disposable(() => state.configurationListeners.delete(listener));
      },
    },
  };
});

vi.mock('../../src/client/definitions', () => ({
  PROVIDER_KEYS: ['openai-chat-completion'],
  PROVIDER_TYPES: { 'openai-chat-completion': {} },
}));

vi.mock('../../src/secret/migration', () => ({
  getRenamedProviderType: () => undefined,
}));

vi.mock('../../src/utils', () => ({
  isRawBaseUrlEnabled: (config: { useRawBaseUrl?: boolean }) =>
    config.useRawBaseUrl === true,
  normalizeBaseUrlInput: (value: string) => value,
  normalizeRawBaseUrlInput: (value: string) => value,
  normalizeUseRawBaseUrl: (value: unknown) => value === true,
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

vi.mock('../../src/vscode-model-id-migration', () => ({
  migrateLegacyVSCodeModelIds: vi.fn(),
}));

import { ConfigStore } from '../../src/config-store';
import { stableStringify } from '../../src/config-ops';
import { parseProviderConfig } from '../../src/main-instance/register-handlers';
import type { OpenAICodexAuthConfig } from '../../src/auth/types';

const SYNC_METHOD = 'config.syncPersistedProvider';

beforeEach(() => {
  state.values = {};
  state.updates = [];
  state.beforeEndpointWrite = undefined;
  state.configurationListeners.clear();
});

describe('ConfigStore completion configuration', () => {
  it('restores an endpoints update that arrives after migration comparison', async () => {
    const initial = [{ name: 'legacy', auth: { method: 'openai-codex' } }];
    const concurrent = [
      ...initial,
      { name: 'synced', preserve: true },
    ];
    const migrated = [
      {
        name: 'legacy',
        auth: {
          method: 'openai-codex',
          bindingId: '00000000-0000-4000-8000-000000000401',
        },
      },
    ];
    state.values.endpoints = initial;
    const store = new ConfigStore();
    state.beforeEndpointWrite = () => {
      state.beforeEndpointWrite = undefined;
      state.values.endpoints = concurrent;
      for (const listener of state.configurationListeners) {
        listener({
          affectsConfiguration: (section) =>
            section === 'unifyChatProvider' ||
            section === 'unifyChatProvider.endpoints',
        });
      }
    };

    await expect(
      store.setRawEndpointsIfUnchanged(
        stableStringify(initial),
        migrated,
      ),
    ).resolves.toBe(false);
    expect(state.values.endpoints).toEqual(concurrent);
    expect(state.updates.map((update) => update.value)).toEqual([
      migrated,
      concurrent,
    ]);
    store.dispose();
  });

  it('does not overwrite Settings Sync during a conditional provider upsert', async () => {
    const initial = [
      {
        type: 'openai-chat-completion',
        name: 'provider',
        baseUrl: 'https://old.example.test/v1',
        models: [],
        auth: {
          method: 'openai-codex',
          bindingId: '00000000-0000-4000-8000-000000000401',
        },
      },
    ];
    const concurrent = [
      {
        ...initial[0],
        baseUrl: 'https://synced.example.test/v1',
        syncedField: 'preserve',
      },
    ];
    state.values.endpoints = initial;
    const store = new ConfigStore();
    state.beforeEndpointWrite = () => {
      state.beforeEndpointWrite = undefined;
      state.values.endpoints = concurrent;
      for (const listener of state.configurationListeners) {
        listener({
          affectsConfiguration: (section) =>
            section === 'unifyChatProvider' ||
            section === 'unifyChatProvider.endpoints',
        });
      }
    };

    await expect(
      store.upsertProviderIfUnchanged(
        {
          type: 'openai-chat-completion',
          name: 'provider',
          baseUrl: 'https://edited.example.test/v1',
          models: [],
          auth: {
            method: 'openai-codex',
            bindingId: '00000000-0000-4000-8000-000000000401',
          },
        },
        {},
        () => true,
      ),
    ).resolves.toBe(false);
    expect(state.values.endpoints).toEqual(concurrent);
    store.dispose();
  });

  it('never writes device session fields to synchronized endpoints', async () => {
    const store = new ConfigStore();
    const auth: OpenAICodexAuthConfig = {
      method: 'openai-codex',
      bindingId: '00000000-0000-4000-8000-000000000401',
      identityId: 'local-session',
      token: 'local-token',
      accountId: 'local-account',
      email: 'local@example.com',
    };
    await store.setEndpoints([
      {
        type: 'openai-chat-completion',
        name: 'provider',
        baseUrl: 'https://api.example.test/v1',
        models: [],
        auth,
      },
    ]);

    expect(state.updates[0].value).toEqual([
      {
        type: 'openai-chat-completion',
        name: 'provider',
        baseUrl: 'https://api.example.test/v1',
        models: [],
        auth: {
          method: 'openai-codex',
          bindingId: '00000000-0000-4000-8000-000000000401',
        },
      },
    ]);
    store.dispose();
  });

  it('keeps invalid raw diagnostics while exposing only normalized values', () => {
    state.values.endpoints = [
      {
        type: 'openai-chat-completion',
        name: 'provider',
        baseUrl: 'https://api.example.test/v1',
        completion: { fimType: 'native' },
        models: [
          {
            id: 'valid-model',
            completion: {
              templates: ['copilot-replica-nes', 'fim', 'fim'],
            },
          },
          {
            id: 'invalid-model',
            completion: { templates: ['unknown'] },
          },
        ],
      },
    ];

    const store = new ConfigStore();
    const provider = store.getProvider('provider');

    expect(provider?.completion).toBeUndefined();
    expect(provider?.models[0].completion).toEqual({
      templates: ['fim', 'copilot-replica-nes'],
    });
    expect(provider?.models[1].completion).toBeUndefined();
    expect(store.getProviderCompletionConfigState('provider')).toMatchObject({
      status: 'invalid',
      issues: [{ code: 'completion-unknown-field', field: 'fimType' }],
    });
    expect(
      store.getModelCompletionConfigState('provider', 'invalid-model'),
    ).toMatchObject({
      status: 'invalid',
      issues: [{ code: 'completion-invalid-templates' }],
    });

    store.dispose();
  });

  it('preserves invalid raw completion data during unrelated normalized writes', async () => {
    state.values.endpoints = [
      {
        type: 'openai-chat-completion',
        name: 'provider',
        baseUrl: 'https://api.example.test/v1',
        completion: { fimTemplate: 'generic' },
        models: [
          {
            id: 'model',
            completion: { templates: ['unknown'] },
          },
        ],
      },
    ];

    const store = new ConfigStore();
    const parsed = parseProviderConfig(
      {
        type: 'openai-chat-completion',
        name: 'provider',
        baseUrl: 'https://api.example.test/v1',
        models: [{ id: 'model' }],
      },
      SYNC_METHOD,
    );
    await store.upsertProvider(parsed);

    expect(state.updates).toHaveLength(1);
    expect(state.updates[0].value).toEqual([
      expect.objectContaining({
        name: 'provider',
        completion: { fimTemplate: 'generic' },
        models: [
          expect.objectContaining({
            id: 'model',
            completion: { templates: ['unknown'] },
          }),
        ],
      }),
    ]);

    store.dispose();
  });

  it('lets explicit valid configuration replace preserved invalid data', async () => {
    state.values.endpoints = [
      {
        type: 'openai-chat-completion',
        name: 'provider',
        baseUrl: 'https://api.example.test/v1',
        completion: { fimType: 'native' },
        models: [
          {
            id: 'model',
            completion: { fimTemplate: 'generic' },
          },
        ],
      },
    ];

    const store = new ConfigStore();
    const parsed = parseProviderConfig(
      {
        type: 'openai-chat-completion',
        name: 'provider',
        baseUrl: 'https://api.example.test/v1',
        completion: {},
        models: [
          {
            id: 'model',
            completion: { templates: [] },
          },
        ],
      },
      SYNC_METHOD,
    );
    await store.upsertProvider(parsed);

    expect(state.updates[0].value).toEqual([
      expect.objectContaining({
        completion: {},
        models: [
          expect.objectContaining({
            completion: { templates: [] },
          }),
        ],
      }),
    ]);

    store.dispose();
  });

  it('preserves invalid raw completion data across provider and model renames', async () => {
    state.values.endpoints = [
      {
        type: 'openai-chat-completion',
        name: 'old-provider',
        baseUrl: 'https://api.example.test/v1',
        completion: { fimType: 'native' },
        models: [
          {
            id: 'old-model',
            completion: { templates: ['unknown'] },
          },
        ],
      },
    ];

    const store = new ConfigStore();
    const renamed = parseProviderConfig(
      {
        type: 'openai-chat-completion',
        name: 'new-provider',
        baseUrl: 'https://api.example.test/v1',
        models: [{ id: 'new-model' }, { id: 'old-model' }],
      },
      SYNC_METHOD,
    );
    await store.upsertProvider(renamed, {
      originalName: 'old-provider',
      modelSourceIds: { 'new-model': 'old-model' },
    });

    expect(state.updates).toHaveLength(1);
    expect(state.updates[0].value).toEqual([
      expect.objectContaining({
        name: 'new-provider',
        completion: { fimType: 'native' },
        models: [
          expect.objectContaining({
            id: 'new-model',
            completion: { templates: ['unknown'] },
          }),
          { id: 'old-model' },
        ],
      }),
    ]);

    store.dispose();
  });
});

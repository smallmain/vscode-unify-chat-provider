import type * as vscode from 'vscode';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  values: {} as Record<string, unknown>,
  configurationListeners: new Set<
    (event: { affectsConfiguration(section: string): boolean }) => void
  >(),
  showErrorMessage: vi.fn(),
  showInformationMessage: vi.fn(),
  beforeEndpointWrite: undefined as (() => void | Promise<void>) | undefined,
  runLeaderMutation: vi.fn(
    async <T>(work: () => Promise<T>): Promise<T> => await work(),
  ),
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
      for (const listener of this.listeners) listener(value);
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
    window: {
      showErrorMessage: state.showErrorMessage,
      showInformationMessage: state.showInformationMessage,
    },
    workspace: {
      getConfiguration: () => ({
        get: (key: string) => state.values[key],
        update: async (key: string, value: unknown) => {
          if (key === 'endpoints') await state.beforeEndpointWrite?.();
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

vi.mock('../../src/utils', () => ({
  isRawBaseUrlEnabled: (config: { useRawBaseUrl?: boolean }) =>
    config.useRawBaseUrl === true,
  normalizeBaseUrlInput: (value: string) => value,
  normalizeRawBaseUrlInput: (value: string) => value,
  normalizeUseRawBaseUrl: (value: unknown) => value === true,
}));

vi.mock('../../src/auth', () => ({
  normalizeAuthForProvider: (auth: unknown) => auth,
  normalizeAuthOnImport: async (auth: unknown) => auth,
  prepareAuthForDuplicate: async (auth: unknown) => auth,
  supportsSensitiveAuthInSettings: () => false,
}));

vi.mock('../../src/ui/form-utils', () => ({
  normalizeProviderDraft: (draft: Record<string, unknown>) => {
    const provider = { ...draft };
    delete provider['_authCommitGuard'];
    delete provider['_completionModelSourceIds'];
    delete provider['_draftSessionId'];
    return provider;
  },
  validateProviderForm: () => [],
  validateProviderNameUnique: () => null,
}));

vi.mock('../../src/ui/component', () => ({
  showValidationErrors: vi.fn(),
}));

vi.mock('../../src/ui/conflict-resolution', () => ({
  generateUniqueProviderName: (name: string) => `${name} (2)`,
  promptConflictResolution: vi.fn(),
}));

vi.mock('../../src/ui/base64-config', () => ({
  showCopiedBase64Config: vi.fn(),
}));

vi.mock('../../src/auth/auth-transfer', () => ({
  resolveAuthForExportOrShowError: vi.fn(),
}));

vi.mock('../../src/balance/balance-transfer', () => ({
  resolveBalanceForExportOrShowError: vi.fn(),
}));

vi.mock('../../src/balance', () => ({
  getBalanceMethodDefinition: () => undefined,
}));

vi.mock('../../src/official-models-manager', () => ({
  officialModelsManager: {
    clearDraftSession: vi.fn(),
    migrateDraftToProvider: vi.fn(),
  },
}));

vi.mock('../../src/main-instance', () => ({
  mainInstance: {
    isLeader: () => true,
    isReady: () => true,
    runLeaderMutation: state.runLeaderMutation,
    runInLeaderWhenAvailable: vi.fn(),
  },
}));

vi.mock('../../src/vscode-model-id-migration', () => ({
  migrateLegacyVSCodeModelIds: vi.fn(),
}));

import { ConfigStore } from '../../src/config-store';
import { SecretStore } from '../../src/secret/secret-store';
import type { ProviderFormDraft } from '../../src/ui/form-utils';
import {
  assertValidProviderDraftSessionAuthToken,
  saveProviderDraft,
} from '../../src/ui/provider-ops';
import {
  parseProviderConfigArray,
  parseProviderConfigInput,
} from '../../src/ui/import-config';
import type { ProviderConfig } from '../../src/types';

const BINDING_ID = '00000000-0000-4000-8000-000000000702';
const IMPORTED_BINDING_ID = '00000000-0000-4000-8000-000000000703';
const BASE_URL = 'https://api.example.test/v1';

class MemorySecretStorage implements vscode.SecretStorage {
  private readonly values = new Map<string, string>();
  readonly onDidChange: vscode.Event<vscode.SecretStorageChangeEvent> = () => ({
    dispose: () => undefined,
  });

  async keys(): Promise<string[]> {
    return Array.from(this.values.keys());
  }
  async get(key: string): Promise<string | undefined> {
    return this.values.get(key);
  }
  async store(key: string, value: string): Promise<void> {
    this.values.set(key, value);
  }
  async delete(key: string): Promise<void> {
    this.values.delete(key);
  }
}

function sessionDraft(name: string): ProviderFormDraft {
  return {
    type: 'openai-chat-completion',
    name,
    baseUrl: BASE_URL,
    models: [],
    auth: {
      method: 'openai-codex',
      bindingId: BINDING_ID,
      identityId: 'session-1',
      token: JSON.stringify({
        accessToken: 'access-token',
        tokenType: 'Bearer',
      }),
      accountId: 'account-1',
    },
  };
}

function apiKeyProvider(apiKey = 'api-key'): ProviderConfig {
  return {
    type: 'openai-chat-completion',
    name: 'provider',
    baseUrl: BASE_URL,
    models: [],
    auth: { method: 'api-key', apiKey },
  };
}

function sessionProvider(): ProviderConfig {
  return {
    ...apiKeyProvider(),
    auth: { method: 'openai-codex', bindingId: BINDING_ID },
  };
}

async function persistInitialSession(
  secretStore: SecretStore,
  provider: ProviderConfig,
): Promise<void> {
  await secretStore.persistSessionAuth(
    {
      providerName: provider.name,
      providerType: provider.type,
      baseUrl: provider.baseUrl,
    },
    {
      method: 'openai-codex',
      bindingId: BINDING_ID,
      identityId: 'initial-session',
      token: JSON.stringify({
        accessToken: 'initial-access',
        tokenType: 'Bearer',
      }),
      accountId: 'initial-account',
    },
    {
      reason: 'login',
      emptyToken: 'clear',
      binding: 'existing-or-random',
    },
  );
}

beforeEach(() => {
  state.values = {};
  state.configurationListeners.clear();
  state.showErrorMessage.mockReset();
  state.showInformationMessage.mockReset();
  state.beforeEndpointWrite = undefined;
  state.runLeaderMutation.mockClear();
});

describe('provider session save source guards', () => {
  it('rejects malformed inline session tokens during draft prevalidation', () => {
    const draft = sessionDraft('malformed');
    if (!draft.auth || draft.auth.method !== 'openai-codex') {
      throw new Error('Expected Codex draft auth.');
    }
    draft.auth.token = '{invalid-json}';

    expect(() =>
      assertValidProviderDraftSessionAuthToken(draft),
    ).toThrow('Invalid authentication token data.');
  });

  it('saves a new session provider whose source is expected to be absent', async () => {
    state.values.endpoints = [];
    const store = new ConfigStore();
    const secretStore = new SecretStore(new MemorySecretStorage());

    await expect(
      saveProviderDraft({
        draft: sessionDraft('new-provider'),
        store,
        secretStore,
      }),
    ).resolves.toBe('saved');

    expect(store.getProvider('new-provider')?.auth).toEqual({
      method: 'openai-codex',
      bindingId: BINDING_ID,
    });
    store.dispose();
  });

  it('allows an API-key provider to switch to session auth', async () => {
    state.values.endpoints = [apiKeyProvider()];
    const store = new ConfigStore();
    const secretStore = new SecretStore(new MemorySecretStorage());
    const existing = store.getProvider('provider');
    if (!existing) throw new Error('Expected existing provider.');

    await expect(
      saveProviderDraft({
        draft: sessionDraft('provider'),
        store,
        secretStore,
        existing,
        originalName: existing.name,
      }),
    ).resolves.toBe('saved');

    expect(store.getProvider('provider')?.auth).toEqual({
      method: 'openai-codex',
      bindingId: BINDING_ID,
    });
    store.dispose();
  });

  it('allows a provider with no auth to switch to session auth', async () => {
    state.values.endpoints = [
      {
        ...apiKeyProvider(),
        auth: { method: 'none' },
      },
    ];
    const store = new ConfigStore();
    const secretStore = new SecretStore(new MemorySecretStorage());
    const existing = store.getProvider('provider');
    if (!existing) throw new Error('Expected existing provider.');

    await expect(
      saveProviderDraft({
        draft: sessionDraft('provider'),
        store,
        secretStore,
        existing,
        originalName: existing.name,
      }),
    ).resolves.toBe('saved');

    expect(store.getProvider('provider')?.auth).toEqual({
      method: 'openai-codex',
      bindingId: BINDING_ID,
    });
    store.dispose();
  });

  it('rejects a save when the captured source provider changed', async () => {
    state.values.endpoints = [apiKeyProvider('old-key')];
    const store = new ConfigStore();
    const secretStore = new SecretStore(new MemorySecretStorage());
    const existing = store.getProvider('provider');
    if (!existing) throw new Error('Expected existing provider.');

    await store.upsertProvider({
      ...existing,
      baseUrl: 'https://changed.example.test/v1',
    });

    await expect(
      saveProviderDraft({
        draft: sessionDraft('provider'),
        store,
        secretStore,
        existing,
        originalName: existing.name,
      }),
    ).resolves.toBe('invalid');

    expect(store.getProvider('provider')?.baseUrl).toBe(
      'https://changed.example.test/v1',
    );
    expect(state.showErrorMessage).toHaveBeenCalledOnce();
    store.dispose();
  });

  it('rolls back the local session when the provider configuration write fails', async () => {
    state.values.endpoints = [sessionProvider()];
    const store = new ConfigStore();
    const secretStore = new SecretStore(new MemorySecretStorage());
    const existing = store.getProvider('provider');
    if (!existing) throw new Error('Expected existing provider.');
    await persistInitialSession(secretStore, existing);
    const changes = vi.fn();
    const subscription = secretStore.onDidChangeLocalAuthState(changes);
    state.beforeEndpointWrite = () => {
      state.beforeEndpointWrite = undefined;
      throw new Error('configuration write failed');
    };

    await expect(
      saveProviderDraft({
        draft: sessionDraft('provider'),
        store,
        secretStore,
        existing,
        originalName: existing.name,
      }),
    ).rejects.toThrow('configuration write failed');

    const runtime = secretStore.hydrateSessionAuth(
      {
        providerName: existing.name,
        providerType: existing.type,
        baseUrl: existing.baseUrl,
      },
      { method: 'openai-codex', bindingId: BINDING_ID },
    );
    expect(await secretStore.getOAuth2Token(runtime.token ?? '')).toMatchObject({
      accessToken: 'initial-access',
    });
    expect(changes).not.toHaveBeenCalled();
    subscription.dispose();
    store.dispose();
  });

  it('restores a synced provider and local session when sync lands during the write', async () => {
    state.values.endpoints = [sessionProvider()];
    const store = new ConfigStore();
    const secretStore = new SecretStore(new MemorySecretStorage());
    const existing = store.getProvider('provider');
    if (!existing) throw new Error('Expected existing provider.');
    const descriptor = {
      providerName: existing.name,
      providerType: existing.type,
      baseUrl: existing.baseUrl,
    };
    await persistInitialSession(secretStore, existing);
    state.beforeEndpointWrite = () => {
      state.beforeEndpointWrite = undefined;
      state.values.endpoints = [
        {
          ...sessionProvider(),
          baseUrl: 'https://synced-during-write.example.test/v1',
        },
      ];
      for (const listener of state.configurationListeners) {
        listener({
          affectsConfiguration: (section) =>
            section === 'unifyChatProvider' ||
            section === 'unifyChatProvider.endpoints',
        });
      }
    };

    await expect(
      saveProviderDraft({
        draft: sessionDraft('provider'),
        store,
        secretStore,
        existing,
        originalName: existing.name,
      }),
    ).resolves.toBe('invalid');

    expect(store.getProvider('provider')?.baseUrl).toBe(
      'https://synced-during-write.example.test/v1',
    );
    const runtime = secretStore.hydrateSessionAuth(
      descriptor,
      { method: 'openai-codex', bindingId: BINDING_ID },
    );
    expect(await secretStore.getOAuth2Token(runtime.token ?? '')).toMatchObject({
      accessToken: 'initial-access',
    });
    expect(state.showErrorMessage).toHaveBeenCalledOnce();
    store.dispose();
  });

  it('keeps the destination binding when a sensitive import overwrites it', async () => {
    state.values.endpoints = [sessionProvider()];
    const store = new ConfigStore();
    const secretStore = new SecretStore(new MemorySecretStorage());
    const draft = sessionDraft('provider');
    if (draft.auth?.method !== 'openai-codex') {
      throw new Error('Expected imported Codex auth.');
    }
    draft.auth.bindingId = IMPORTED_BINDING_ID;

    await expect(
      saveProviderDraft({
        draft,
        store,
        secretStore,
        skipConflictResolution: true,
      }),
    ).resolves.toBe('saved');

    expect(store.getProvider('provider')?.auth).toEqual({
      method: 'openai-codex',
      bindingId: BINDING_ID,
    });
    store.dispose();
  });

  it('rejects an overwrite when the destination session changes during import', async () => {
    state.values.endpoints = [sessionProvider()];
    const store = new ConfigStore();
    const secretStore = new SecretStore(new MemorySecretStorage());
    const descriptor = {
      providerName: 'provider',
      providerType: 'openai-chat-completion',
      baseUrl: BASE_URL,
    };
    await secretStore.persistSessionAuth(
      descriptor,
      {
        method: 'openai-codex',
        bindingId: BINDING_ID,
        identityId: 'initial-session',
        token: JSON.stringify({
          accessToken: 'initial-access',
          tokenType: 'Bearer',
        }),
        accountId: 'initial-account',
      },
      {
        reason: 'login',
        emptyToken: 'clear',
        binding: 'existing-or-random',
      },
    );

    const originalPrepare =
      secretStore.prepareSessionAuthCommitIntent.bind(secretStore);
    vi.spyOn(secretStore, 'prepareSessionAuthCommitIntent').mockImplementationOnce(
      async (commitDescriptor, auth) => {
        const intent = await originalPrepare(commitDescriptor, auth);
        await secretStore.persistSessionAuth(
          descriptor,
          {
            method: 'openai-codex',
            bindingId: BINDING_ID,
            identityId: 'concurrent-session',
            token: JSON.stringify({
              accessToken: 'concurrent-access',
              tokenType: 'Bearer',
            }),
            accountId: 'concurrent-account',
          },
          {
            reason: 'login',
            emptyToken: 'clear',
            binding: 'existing-or-random',
          },
        );
        return intent;
      },
    );

    const draft = sessionDraft('provider');
    if (draft.auth?.method !== 'openai-codex') {
      throw new Error('Expected imported Codex auth.');
    }
    draft.auth.bindingId = IMPORTED_BINDING_ID;

    await expect(
      saveProviderDraft({
        draft,
        store,
        secretStore,
        skipConflictResolution: true,
      }),
    ).resolves.toBe('invalid');

    const runtime = secretStore.hydrateSessionAuth(
      descriptor,
      { method: 'openai-codex', bindingId: BINDING_ID },
    );
    expect(await secretStore.getOAuth2Token(runtime.token ?? '')).toMatchObject({
      accessToken: 'concurrent-access',
    });
    expect(state.showErrorMessage).toHaveBeenCalledOnce();
    store.dispose();
  });
});

describe('provider import auth parsing', () => {
  const malformed = {
    type: 'openai-chat-completion',
    name: 'imported',
    baseUrl: BASE_URL,
    models: [],
    auth: {
      method: 'openai-codex',
      unknownContext: 'must-not-be-accepted',
    },
  };

  it('rejects malformed auth in single and array imports without throwing', () => {
    expect(() => parseProviderConfigInput(malformed)).not.toThrow();
    expect(parseProviderConfigInput(malformed)).toBeUndefined();
    expect(() => parseProviderConfigArray([malformed])).not.toThrow();
    expect(parseProviderConfigArray([malformed])).toBeUndefined();
  });

  it('assigns a new binding before a sensitive imported provider becomes a draft', () => {
    const imported = parseProviderConfigInput({
      type: 'openai-chat-completion',
      name: 'imported',
      baseUrl: BASE_URL,
      models: [],
      auth: {
        method: 'openai-codex',
        bindingId: BINDING_ID,
        identityId: 'imported-session',
        token: JSON.stringify({
          accessToken: 'imported-access',
          tokenType: 'Bearer',
        }),
        accountId: 'imported-account',
      },
    });

    expect(imported?.auth).toMatchObject({
      method: 'openai-codex',
      identityId: 'imported-session',
      accountId: 'imported-account',
    });
    if (imported?.auth?.method !== 'openai-codex') {
      throw new Error('Expected imported Codex auth.');
    }
    expect(imported.auth.bindingId).not.toBe(BINDING_ID);
  });
});

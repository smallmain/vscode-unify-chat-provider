import type * as vscode from 'vscode';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const workspaceState = vi.hoisted(() => ({
  endpoints: [] as unknown[],
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
      for (const listener of this.listeners) listener(value);
    }
    dispose(): void {
      this.listeners.clear();
    }
  }
  return {
    Disposable,
    EventEmitter,
    env: { language: 'en' },
    l10n: { t: (message: string) => message },
    workspace: {
      getConfiguration: () => ({
        get: (key: string) =>
          key === 'endpoints' ? workspaceState.endpoints : undefined,
      }),
      onDidChangeConfiguration: (
        listener: (event: {
          affectsConfiguration(section: string): boolean;
        }) => void,
      ) => {
        workspaceState.configurationListeners.add(listener);
        return new Disposable(() =>
          workspaceState.configurationListeners.delete(listener),
        );
      },
    },
  };
});

vi.mock('../../src/config-store', () => ({
  CONFIG_NAMESPACE: 'unifyChatProvider',
}));

vi.mock('../../src/logger', () => ({
  authLog: {
    error: vi.fn(),
    verbose: vi.fn(),
    warn: vi.fn(),
  },
}));

import {
  cleanupUnusedSecrets,
  ORPHAN_SECRET_RETENTION_MS,
} from '../../src/secret/cleanup';
import {
  buildApiKeyStorageKey,
  buildOAuth2ClientSecretStorageKey,
  buildOAuth2TokenStorageKey,
  createSecretRef,
} from '../../src/secret/constants';
import { SecretStore } from '../../src/secret/secret-store';
import type { OpenAICodexAuthConfig } from '../../src/auth/types';

class MemorySecretStorage implements vscode.SecretStorage {
  readonly values = new Map<string, string>();
  beforeGet?: (key: string) => void;
  afterGet?: (key: string) => void;
  beforeStore?: (key: string) => void;
  beforeDelete?: (key: string) => void;
  readonly onDidChange: vscode.Event<vscode.SecretStorageChangeEvent> = () => ({
    dispose: () => undefined,
  });

  async keys(): Promise<string[]> {
    return Array.from(this.values.keys());
  }

  async get(key: string): Promise<string | undefined> {
    this.beforeGet?.(key);
    const value = this.values.get(key);
    this.afterGet?.(key);
    return value;
  }

  async store(key: string, value: string): Promise<void> {
    this.beforeStore?.(key);
    this.values.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.beforeDelete?.(key);
    this.values.delete(key);
  }
}

beforeEach(() => {
  workspaceState.endpoints = [];
  workspaceState.configurationListeners.clear();
});

describe('device-local secret garbage collection', () => {
  it('retains legacy secrets for seven continuous orphan days', async () => {
    const storage = new MemorySecretStorage();
    const store = new SecretStore(storage);
    const apiKeyRef = createSecretRef();
    const tokenRef = createSecretRef();
    const clientSecretRef = createSecretRef();
    await store.setApiKey(apiKeyRef, 'api-secret');
    await store.setOAuth2Token(tokenRef, {
      accessToken: 'access-secret',
      tokenType: 'Bearer',
    });
    await store.setOAuth2ClientSecret(clientSecretRef, 'client-secret');
    const keys = [
      buildApiKeyStorageKey(apiKeyRef),
      buildOAuth2TokenStorageKey(tokenRef),
      buildOAuth2ClientSecretStorageKey(clientSecretRef),
    ].filter((key): key is string => key !== null);

    await cleanupUnusedSecrets(store, { now: 1_000 });
    expect(keys.every((key) => storage.values.has(key))).toBe(true);
    await cleanupUnusedSecrets(store, {
      now: 1_000 + ORPHAN_SECRET_RETENTION_MS - 1,
    });
    expect(keys.every((key) => storage.values.has(key))).toBe(true);
    await cleanupUnusedSecrets(store, {
      now: 1_000 + ORPHAN_SECRET_RETENTION_MS,
    });
    expect(keys.every((key) => !storage.values.has(key))).toBe(true);
  });

  it('cancels an orphan mark when a reference reappears', async () => {
    const storage = new MemorySecretStorage();
    const store = new SecretStore(storage);
    const ref = createSecretRef();
    const key = buildApiKeyStorageKey(ref);
    if (!key) throw new Error('Expected API key storage key.');
    await store.setApiKey(ref, 'api-secret');

    await cleanupUnusedSecrets(store, { now: 100 });
    workspaceState.endpoints = [
      {
        type: 'openai-chat-completion',
        name: 'Provider',
        baseUrl: 'https://example.test/v1',
        auth: { method: 'api-key', apiKey: ref },
        models: [],
      },
    ];
    await cleanupUnusedSecrets(store, {
      now: 100 + ORPHAN_SECRET_RETENTION_MS,
    });
    expect(storage.values.has(key)).toBe(true);

    workspaceState.endpoints = [];
    await cleanupUnusedSecrets(store, {
      now: 100 + ORPHAN_SECRET_RETENTION_MS + 1,
    });
    await cleanupUnusedSecrets(store, {
      now: 100 + ORPHAN_SECRET_RETENTION_MS * 2,
    });
    expect(storage.values.has(key)).toBe(true);
    await cleanupUnusedSecrets(store, {
      now: 100 + ORPHAN_SECRET_RETENTION_MS * 2 + 1,
    });
    expect(storage.values.has(key)).toBe(false);
  });

  it('retains and later deletes a whole local auth envelope by binding', async () => {
    const storage = new MemorySecretStorage();
    const store = new SecretStore(storage);
    const bindingId = '00000000-0000-4000-8000-000000000301';
    const descriptor = {
      providerName: 'Codex',
      providerType: 'openai-responses',
      baseUrl: 'https://api.openai.com/v1',
    };
    const auth: OpenAICodexAuthConfig = {
      method: 'openai-codex',
      bindingId,
      token: JSON.stringify({
        accessToken: 'device-token',
        tokenType: 'Bearer',
      }),
      accountId: 'account-a',
    };
    const persisted = await store.persistSessionAuth(descriptor, auth, {
      reason: 'login',
      emptyToken: 'clear',
      binding: 'existing-or-random',
    });
    workspaceState.endpoints = [
      {
        ...descriptor,
        type: descriptor.providerType,
        name: descriptor.providerName,
        models: [],
        auth: persisted,
      },
    ];
    const startedAt = Date.now();
    await cleanupUnusedSecrets(store, { now: startedAt });
    expect(store.getLocalAuthEnvelope(bindingId)).toBeDefined();

    workspaceState.endpoints = [];
    await cleanupUnusedSecrets(store, { now: startedAt + 100 });
    await cleanupUnusedSecrets(store, {
      now: startedAt + 100 + ORPHAN_SECRET_RETENTION_MS,
    });
    expect(store.getLocalAuthEnvelope(bindingId)).toBeUndefined();
  });

  it('rechecks current references and bindings immediately before deletion', async () => {
    const storage = new MemorySecretStorage();
    const store = new SecretStore(storage);
    const ref = createSecretRef();
    const apiKey = buildApiKeyStorageKey(ref);
    if (!apiKey) throw new Error('Expected API key storage key.');
    await store.setApiKey(ref, 'api-secret');

    const bindingId = '00000000-0000-4000-8000-000000000302';
    const descriptor = {
      providerName: 'Codex',
      providerType: 'openai-responses',
      baseUrl: 'https://api.openai.com/v1',
    };
    const persisted = await store.persistSessionAuth(
      descriptor,
      {
        method: 'openai-codex',
        bindingId,
        token: JSON.stringify({
          accessToken: 'device-token',
          tokenType: 'Bearer',
        }),
        accountId: 'account-a',
      },
      {
        reason: 'login',
        emptyToken: 'clear',
        binding: 'existing-or-random',
      },
    );

    const startedAt = Date.now();
    await cleanupUnusedSecrets(store, { now: startedAt });
    storage.afterGet = (key) => {
      if (!key.endsWith('secret-gc-v1')) return;
      storage.afterGet = undefined;
      workspaceState.endpoints = [
        {
          type: 'openai-chat-completion',
          name: 'API Key Provider',
          baseUrl: 'https://example.test/v1',
          auth: { method: 'api-key', apiKey: ref },
          models: [],
        },
        {
          ...descriptor,
          type: descriptor.providerType,
          name: descriptor.providerName,
          models: [],
          auth: persisted,
        },
      ];
    };

    await cleanupUnusedSecrets(store, {
      now: startedAt + ORPHAN_SECRET_RETENTION_MS,
    });

    expect(storage.values.has(apiKey)).toBe(true);
    expect(store.getLocalAuthEnvelope(bindingId)).toBeDefined();
  });

  it('restores a secret when Settings Sync reintroduces it during deletion', async () => {
    const storage = new MemorySecretStorage();
    const store = new SecretStore(storage);
    const ref = createSecretRef();
    const key = buildApiKeyStorageKey(ref);
    if (!key) throw new Error('Expected API key storage key.');
    await store.setApiKey(ref, 'api-secret');
    const startedAt = 2_000;
    await cleanupUnusedSecrets(store, { now: startedAt });

    storage.beforeDelete = (deletingKey) => {
      if (deletingKey !== key) return;
      storage.beforeDelete = undefined;
      workspaceState.endpoints = [
        {
          type: 'openai-chat-completion',
          name: 'Synced Provider',
          baseUrl: 'https://example.test/v1',
          auth: { method: 'api-key', apiKey: ref },
          models: [],
        },
      ];
      for (const listener of workspaceState.configurationListeners) {
        listener({
          affectsConfiguration: (section) =>
            section === 'unifyChatProvider.endpoints',
        });
      }
    };

    await cleanupUnusedSecrets(store, {
      now: startedAt + ORPHAN_SECRET_RETENTION_MS,
    });

    expect(storage.values.get(key)).toBe('api-secret');
  });

  it('does not delete an API key value updated after the cleanup snapshot', async () => {
    const storage = new MemorySecretStorage();
    const store = new SecretStore(storage);
    const ref = createSecretRef();
    const key = buildApiKeyStorageKey(ref);
    if (!key) throw new Error('Expected API key storage key.');
    await store.setApiKey(ref, 'old-api-secret');
    const startedAt = 3_000;
    await cleanupUnusedSecrets(store, { now: startedAt });

    let reads = 0;
    storage.beforeGet = (readKey) => {
      if (readKey !== key || ++reads !== 2) return;
      storage.beforeGet = undefined;
      storage.values.set(key, 'new-api-secret');
    };
    await cleanupUnusedSecrets(store, {
      now: startedAt + ORPHAN_SECRET_RETENTION_MS,
    });

    expect(storage.values.get(key)).toBe('new-api-secret');
  });

  it('restores an expired auth snapshot when its fingerprint returns during pruning', async () => {
    const storage = new MemorySecretStorage();
    const store = new SecretStore(storage);
    const bindingId = '00000000-0000-4000-8000-000000000305';
    const descriptorA = {
      providerName: 'Codex',
      providerType: 'openai-responses',
      baseUrl: 'https://a.example.test/v1',
    };
    const descriptorB = {
      ...descriptorA,
      baseUrl: 'https://b.example.test/v1',
    };
    const staticAuth = await store.persistSessionAuth(
      descriptorA,
      {
        method: 'openai-codex',
        bindingId,
        token: JSON.stringify({
          accessToken: 'device-token',
          tokenType: 'Bearer',
        }),
        accountId: 'account-a',
      },
      {
        reason: 'login',
        emptyToken: 'clear',
        binding: 'existing-or-random',
      },
    );
    const endpoint = (descriptor: typeof descriptorA) => ({
      ...descriptor,
      type: descriptor.providerType,
      name: descriptor.providerName,
      models: [],
      auth: staticAuth,
    });
    workspaceState.endpoints = [endpoint(descriptorB)];
    const startedAt = Date.now();
    await cleanupUnusedSecrets(store, { now: startedAt });

    storage.beforeStore = (key) => {
      if (!key.includes('auth-session-v1')) return;
      storage.beforeStore = undefined;
      workspaceState.endpoints = [endpoint(descriptorA)];
      for (const listener of workspaceState.configurationListeners) {
        listener({
          affectsConfiguration: (section) =>
            section === 'unifyChatProvider.endpoints',
        });
      }
    };
    await cleanupUnusedSecrets(store, {
      now: startedAt + ORPHAN_SECRET_RETENTION_MS,
    });

    const restored = store.getLocalAuthCredentialSnapshot(
      descriptorA,
      staticAuth,
    );
    expect(restored?.token?.accessToken).toBe('device-token');
    expect(store.getLocalAuthEnvelope(bindingId)?.snapshots).toHaveLength(1);
  });

  it('clamps orphan timestamps when the system clock moves backwards', async () => {
    const storage = new MemorySecretStorage();
    const store = new SecretStore(storage);
    const bindingId = '00000000-0000-4000-8000-000000000304';
    const descriptor = {
      providerName: 'Codex',
      providerType: 'openai-responses',
      baseUrl: 'https://api.openai.com/v1',
    };
    await store.persistSessionAuth(
      descriptor,
      {
        method: 'openai-codex',
        bindingId,
        token: JSON.stringify({
          accessToken: 'device-token',
          tokenType: 'Bearer',
        }),
        accountId: 'account-a',
      },
      {
        reason: 'login',
        emptyToken: 'clear',
        binding: 'existing-or-random',
      },
    );

    await store.reconcileLocalAuthSnapshots([], 1);
    const marked = store.getLocalAuthEnvelope(bindingId);
    expect(marked?.snapshots[0]?.orphanedAt).toBeGreaterThanOrEqual(
      marked?.snapshots[0]?.updatedAt ?? Number.POSITIVE_INFINITY,
    );

    const reloaded = new SecretStore(storage);
    await reloaded.initializeLocalAuthState();
    expect(reloaded.getLocalAuthEnvelope(bindingId)).toBeDefined();
  });

  it('cancels a non-expired orphan mark when a reference arrives mid-cleanup', async () => {
    const storage = new MemorySecretStorage();
    const store = new SecretStore(storage);
    const ref = createSecretRef();
    const key = buildApiKeyStorageKey(ref);
    if (!key) throw new Error('Expected API key storage key.');
    await store.setApiKey(ref, 'api-secret');
    const startedAt = 1_000;
    await cleanupUnusedSecrets(store, { now: startedAt });

    storage.afterGet = (storageKey) => {
      if (!storageKey.endsWith('secret-gc-v1')) return;
      storage.afterGet = undefined;
      workspaceState.endpoints = [
        {
          type: 'openai-chat-completion',
          name: 'Provider',
          baseUrl: 'https://example.test/v1',
          auth: { method: 'api-key', apiKey: ref },
          models: [],
        },
      ];
    };
    await cleanupUnusedSecrets(store, { now: startedAt + 1 });

    workspaceState.endpoints = [];
    await cleanupUnusedSecrets(store, {
      now: startedAt + ORPHAN_SECRET_RETENTION_MS,
    });
    expect(storage.values.has(key)).toBe(true);
    await cleanupUnusedSecrets(store, {
      now: startedAt + ORPHAN_SECRET_RETENTION_MS * 2 - 1,
    });
    expect(storage.values.has(key)).toBe(true);
    await cleanupUnusedSecrets(store, {
      now: startedAt + ORPHAN_SECRET_RETENTION_MS * 2,
    });
    expect(storage.values.has(key)).toBe(false);
  });

  it('keeps one orphan deadline when a binding returns with a new fingerprint', async () => {
    const storage = new MemorySecretStorage();
    const store = new SecretStore(storage);
    const bindingId = '00000000-0000-4000-8000-000000000303';
    const descriptorA = {
      providerName: 'Codex',
      providerType: 'openai-responses',
      baseUrl: 'https://a.example.test/v1',
    };
    const descriptorB = {
      ...descriptorA,
      baseUrl: 'https://b.example.test/v1',
    };
    await store.persistSessionAuth(
      descriptorA,
      {
        method: 'openai-codex',
        bindingId,
        token: JSON.stringify({
          accessToken: 'device-token',
          tokenType: 'Bearer',
        }),
        accountId: 'account-a',
      },
      {
        reason: 'login',
        emptyToken: 'clear',
        binding: 'existing-or-random',
      },
    );

    const startedAt = Date.now();
    await cleanupUnusedSecrets(store, { now: startedAt });
    workspaceState.endpoints = [
      {
        ...descriptorB,
        type: descriptorB.providerType,
        name: descriptorB.providerName,
        models: [],
        auth: { method: 'openai-codex', bindingId },
      },
    ];
    await cleanupUnusedSecrets(store, {
      now: startedAt + ORPHAN_SECRET_RETENTION_MS - 1,
    });
    expect(store.getLocalAuthEnvelope(bindingId)?.snapshots).toHaveLength(1);

    await cleanupUnusedSecrets(store, {
      now: startedAt + ORPHAN_SECRET_RETENTION_MS,
    });
    expect(store.getLocalAuthEnvelope(bindingId)).toBeUndefined();
  });
});

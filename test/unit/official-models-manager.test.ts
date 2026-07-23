import { beforeEach, describe, expect, it, vi } from 'vitest';

const providerClient = vi.hoisted(() => ({
  getAvailableModels: vi.fn(),
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
        get: <T>(_key: string, fallback: T) => fallback,
      }),
    },
  };
});

vi.mock('../../src/main-instance', () => ({
  mainInstance: {
    isLeader: () => true,
    onDidReceiveEvent: () => ({ dispose: () => undefined }),
    onDidChangeRole: () => ({ dispose: () => undefined }),
    broadcast: vi.fn(),
    runInLeaderWhenAvailable: vi.fn(),
  },
}));

vi.mock('../../src/client/utils', () => ({
  createProvider: () => ({
    getAvailableModels: providerClient.getAvailableModels,
  }),
}));

vi.mock('../../src/utils', () => ({
  isRawBaseUrlEnabled: () => false,
  normalizeBaseUrlInput: (value: string) => value.trim().replace(/\/+$/, ''),
  normalizeRawBaseUrlInput: (value: string) => value.trim(),
  normalizeUseRawBaseUrl: (value: unknown) => value === true,
}));

vi.mock('../../src/auth', () => ({
  createAuthProvider: vi.fn(),
  normalizeAuthForProvider: (auth: unknown) => auth,
  redactAuthForExport: (auth: Record<string, unknown>) => ({
    ...auth,
    token: undefined,
  }),
}));

import type * as vscode from 'vscode';
import {
  OfficialModelsManager,
  type OfficialModelsAuthManager,
  type OfficialModelsConfigStore,
  type OfficialModelsExtensionContext,
} from '../../src/official-models-manager';
import { SecretStore } from '../../src/secret/secret-store';
import type { ProviderConfig } from '../../src/types';

const ZED_BINDING_ID = '00000000-0000-4000-8000-000000000103';

class MemoryMemento implements vscode.Memento {
  constructor(private readonly values: Map<string, unknown>) {}
  keys(): readonly string[] {
    return Array.from(this.values.keys());
  }
  get<T>(key: string): T | undefined;
  get<T>(key: string, defaultValue: T): T;
  get<T>(key: string, defaultValue?: T): T | undefined {
    return this.values.has(key)
      ? (this.values.get(key) as T)
      : defaultValue;
  }
  async update(key: string, value: unknown): Promise<void> {
    if (value === undefined) this.values.delete(key);
    else this.values.set(key, value);
  }
}

class MemorySecretStorage implements vscode.SecretStorage {
  readonly onDidChange: vscode.Event<vscode.SecretStorageChangeEvent> = () => ({
    dispose: () => undefined,
  });
  async keys(): Promise<string[]> {
    return [];
  }
  async get(_key: string): Promise<string | undefined> {
    return undefined;
  }
  async store(_key: string, _value: string): Promise<void> {}
  async delete(_key: string): Promise<void> {}
}

function provider(): ProviderConfig {
  return {
    type: 'zed',
    name: 'Zed',
    baseUrl: 'https://zed.dev',
    auth: {
      method: 'zed',
      bindingId: ZED_BINDING_ID,
      baseUrl: 'https://zed.dev',
    },
    models: [],
    autoFetchOfficialModels: true,
  };
}

function configStore(config: ProviderConfig): OfficialModelsConfigStore {
  return {
    endpoints: [config],
    getProvider: (name: string) => (name === config.name ? config : undefined),
    onDidChange: () => ({ dispose: () => undefined }),
  };
}

function authManager(
  hasCredential = true,
  getOrganizationId: () => string = () => 'org-a',
): OfficialModelsAuthManager {
  return {
    getCredential: async () =>
      hasCredential
        ? {
            value: 'llm-token',
            tokenType: 'Bearer',
            authContext: {
              method: 'zed',
              bindingId: ZED_BINDING_ID,
              sessionId: 'identity',
              revision: 1,
              organizationId: getOrganizationId(),
              dataCollection: false,
              dataCollectionAllowed: false,
            },
          }
        : undefined,
  };
}

function context(storage: Map<string, unknown>): OfficialModelsExtensionContext {
  return { globalState: new MemoryMemento(storage) };
}

function secretStore(): SecretStore {
  return new SecretStore(new MemorySecretStorage());
}

beforeEach(() => {
  providerClient.getAvailableModels.mockReset();
});

describe('official model manager provider boundary', () => {
  it('stores only the models returned through the common Provider API', async () => {
    providerClient.getAvailableModels.mockResolvedValue([
      { id: 'zeta-cloud' },
      { id: 'dynamic-model' },
    ]);
    const config = provider();
    const storage = new Map<string, unknown>();
    const manager = new OfficialModelsManager();
    await manager.initialize(
      context(storage),
      configStore(config),
      secretStore(),
      authManager(),
    );

    const models = await manager.getOfficialModels(config, true);

    expect(providerClient.getAvailableModels).toHaveBeenCalledOnce();
    expect(models.map((model) => model.id)).toEqual([
      'zeta-cloud',
      'dynamic-model',
    ]);
    const state = manager.getProviderState(config.name);
    expect(state?.models.map((model) => model.id)).toEqual([
      'zeta-cloud',
      'dynamic-model',
    ]);
    expect(Object.hasOwn(state ?? {}, 'zedRoutes')).toBe(false);
    expect(Object.hasOwn(state ?? {}, 'zedOrganizationId')).toBe(false);
    const persisted = storage.get('officialModelsState') as
      | Record<string, Record<string, unknown>>
      | undefined;
    expect(Object.hasOwn(persisted?.[config.name] ?? {}, 'zedRoutes')).toBe(
      false,
    );
    manager.dispose();
  });

  it('does not inject provider-specific models when the Provider fetch fails', async () => {
    providerClient.getAvailableModels.mockRejectedValue(
      new Error('Authentication required'),
    );
    const config = provider();
    const manager = new OfficialModelsManager();
    await manager.initialize(
      context(new Map()),
      configStore(config),
      secretStore(),
      authManager(false),
    );

    await expect(manager.getOfficialModels(config, true)).resolves.toEqual([]);
    expect(providerClient.getAvailableModels).toHaveBeenCalledWith(
      { kind: 'none' },
      undefined,
      expect.any(AbortSignal),
    );
    manager.dispose();
  });

  it('prevents an obsolete provider fetch from overwriting a newer local auth context', async () => {
    const config = provider();
    let organizationId = 'org-a';
    let releaseFirst: ((models: Array<{ id: string }>) => void) | undefined;
    let firstSignal: AbortSignal | undefined;
    providerClient.getAvailableModels
      .mockImplementationOnce(
        (_credential, _refreshCredential, signal: AbortSignal | undefined) => {
          firstSignal = signal;
          return new Promise<Array<{ id: string }>>((resolve) => {
            releaseFirst = resolve;
          });
        },
      )
      .mockResolvedValueOnce([{ id: 'new-organization-model' }]);
    const manager = new OfficialModelsManager();
    await manager.initialize(
      context(new Map()),
      configStore(config),
      secretStore(),
      authManager(true, () => organizationId),
    );

    const first = manager.getOfficialModels(config, true);
    await vi.waitFor(() => {
      expect(providerClient.getAvailableModels).toHaveBeenCalledOnce();
    });
    organizationId = 'org-b';
    await manager.clearProviderState(config.name);
    expect(firstSignal?.aborted).toBe(true);
    await manager.getOfficialModels(config, true);
    releaseFirst?.([{ id: 'old-organization-model' }]);
    await first;

    expect(manager.getProviderState(config.name)?.models).toEqual([
      expect.objectContaining({ id: 'new-organization-model' }),
    ]);
    manager.dispose();
  });

  it('invalidates cached models when the local auth state changes', async () => {
    providerClient.getAvailableModels
      .mockResolvedValueOnce([{ id: 'old-organization-model' }])
      .mockRejectedValue(new Error('Authentication revoked'));
    const config = provider();
    const store: OfficialModelsConfigStore = {
      endpoints: [config],
      getProvider: (name) => (name === config.name ? config : undefined),
      onDidChange: () => ({ dispose: () => undefined }),
    };
    const manager = new OfficialModelsManager();
    await manager.initialize(
      context(new Map()),
      store,
      secretStore(),
      authManager(),
    );
    await manager.getOfficialModels(config, true);

    await manager.clearProviderState(config.name);

    await vi.waitFor(() => {
      expect(
        manager
          .getProviderState(config.name)
          ?.models.some((model) => model.id === 'old-organization-model') ?? false,
      ).toBe(false);
    });
    manager.dispose();
  });
});

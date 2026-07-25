import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderConfig } from '../../src/types';

const state = vi.hoisted(() => ({
  createBalanceProvider: vi.fn(),
  refresh: vi.fn(),
}));

vi.mock('vscode', () => {
  class EventEmitter<T> {
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
  }

  return {
    EventEmitter,
    l10n: { t: (message: string) => message },
    window: { showErrorMessage: vi.fn() },
  };
});

vi.mock('../../src/main-instance', () => ({
  mainInstance: {
    isLeader: () => true,
    broadcast: vi.fn(),
    onDidReceiveEvent: () => ({ dispose: () => undefined }),
    onDidChangeRole: () => ({ dispose: () => undefined }),
    runInLeaderWhenAvailable: vi.fn(),
  },
}));

vi.mock('../../src/main-instance/compatibility', () => ({
  showMainInstanceCompatibilityWarning: vi.fn(async () => false),
}));

vi.mock('../../src/config-ops', () => {
  const stableValue = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(stableValue);
    if (typeof value !== 'object' || value === null) return value;
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, stableValue(entry)]),
    );
  };
  return {
    stableStringify: (value: unknown) => JSON.stringify(stableValue(value)),
  };
});

vi.mock('../../src/balance/create-balance-provider', () => ({
  createBalanceProvider: (context: unknown, config: unknown) => {
    state.createBalanceProvider(context, config);
    return {
      definition: { id: 'test', label: 'Test' },
      getConfig: () => config,
      configure: async () => ({ success: true, config }),
      refresh: state.refresh,
      dispose: vi.fn(),
    };
  },
}));

import { BalanceManager } from '../../src/balance/balance-manager';

describe('BalanceManager credential snapshots', () => {
  beforeEach(() => {
    state.createBalanceProvider.mockReset();
    state.refresh.mockReset();
    state.refresh.mockResolvedValue({
      success: true,
      snapshot: { updatedAt: 1, items: [] },
    });
  });

  it('retries configuration changes before constructing the balance provider', async () => {
    const bindingId = '00000000-0000-4000-8000-000000000221';
    const originalProvider: ProviderConfig = {
      type: 'openai-chat-completion',
      name: 'balance-test',
      baseUrl: 'https://old.example.test/v1',
      models: [],
      auth: { method: 'openai-codex', bindingId },
      balanceProvider: { method: 'codex' },
    };
    const updatedProvider: ProviderConfig = {
      ...originalProvider,
      baseUrl: 'https://new.example.test/v1',
    };
    let currentProvider = originalProvider;
    const getCredential = vi.fn(async () => {
      currentProvider = updatedProvider;
      return {
        value: 'new-target-token',
        tokenType: 'Bearer',
        authContext: {
          method: 'openai-codex' as const,
          bindingId,
          sessionId: '00000000-0000-4000-8000-000000000222',
          revision: 2,
        },
      };
    });
    const manager = new BalanceManager();
    Reflect.set(manager, 'configStore', {
      getProvider: (name: string) =>
        name === currentProvider.name ? currentProvider : undefined,
      networkProxy: undefined,
      storeApiKeyInSettings: false,
    });
    Reflect.set(manager, 'secretStore', {});
    Reflect.set(manager, 'authManager', { getCredential });

    await manager.forceRefresh(originalProvider.name);

    expect(getCredential).toHaveBeenCalledTimes(2);
    expect(state.createBalanceProvider).toHaveBeenCalledTimes(1);
    expect(state.refresh).toHaveBeenCalledTimes(1);
    expect(state.refresh).toHaveBeenCalledWith({
      provider: expect.objectContaining({
        name: originalProvider.name,
        baseUrl: updatedProvider.baseUrl,
      }),
      credential: expect.objectContaining({
        kind: 'token',
        token: 'new-target-token',
        authContext: expect.objectContaining({ revision: 2 }),
      }),
    });
    expect(manager.getProviderState(originalProvider.name)).toMatchObject({
      snapshot: { updatedAt: 1, items: [] },
      lastError: undefined,
    });

    manager.dispose();
  });
});

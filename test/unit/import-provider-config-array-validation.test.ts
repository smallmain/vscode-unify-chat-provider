import type * as vscode from 'vscode';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  assertValidSessionToken: vi.fn(),
  confirmFinalizeImport: vi.fn(),
  saveProviderDraft: vi.fn(),
  showValidationErrors: vi.fn(),
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
  class ThemeIcon {
    constructor(readonly id: string) {}
  }
  return {
    ConfigurationTarget: { Global: 1 },
    Disposable,
    EventEmitter,
    ThemeIcon,
    env: { language: 'en' },
    l10n: { t: (message: string) => message },
    window: {
      showErrorMessage: vi.fn(),
      showInformationMessage: vi.fn(),
    },
    workspace: {
      getConfiguration: () => ({
        get: () => undefined,
        update: vi.fn(),
      }),
      onDidChangeConfiguration: () => new Disposable(),
    },
  };
});

vi.mock('../../src/ui/import-review', () => ({
  confirmCancelImport: vi.fn(),
  confirmFinalizeImport: state.confirmFinalizeImport,
  showImportReviewPicker: vi.fn(async () => ({
    kind: 'accept',
    selectedIds: new Set([0, 1]),
  })),
}));

vi.mock('../../src/ui/import-config', () => ({
  buildProviderDraftFromConfig: vi.fn(),
}));

vi.mock('../../src/ui/component', () => ({
  showValidationErrors: state.showValidationErrors,
}));

vi.mock('../../src/ui/form-utils', () => ({
  validateProviderForm: vi.fn(() => []),
}));

vi.mock('../../src/ui/provider-ops', () => ({
  assertValidProviderDraftSessionAuthToken: state.assertValidSessionToken,
  discardDraftAuthState: vi.fn(),
  saveProviderDraft: state.saveProviderDraft,
}));

vi.mock('../../src/official-models-manager', () => ({
  officialModelsManager: { clearDraftSession: vi.fn() },
}));

vi.mock('../../src/ui/conflict-resolution', () => ({
  generateUniqueProviderName: vi.fn((name: string) => `${name} 2`),
  promptConflictResolution: vi.fn(),
}));

vi.mock('../../src/i18n', () => ({
  t: (message: string, ...args: unknown[]) =>
    message.replace(/\{(\d+)\}/g, (_match, index: string) =>
      String(args[Number(index)] ?? ''),
    ),
}));

vi.mock('../../src/secret', () => ({
  cleanupUnusedSecrets: vi.fn(),
}));

vi.mock('../../src/main-instance', () => ({
  mainInstance: {
    isLeader: () => false,
    isReady: () => false,
    runLeaderMutation: vi.fn(),
  },
}));

vi.mock('../../src/logger', () => ({
  authLog: {
    error: vi.fn(),
    verbose: vi.fn(),
    warn: vi.fn(),
  },
}));

import { ConfigStore } from '../../src/config-store';
import { SecretStore } from '../../src/secret/secret-store';
import type { ProviderFormDraft } from '../../src/ui/form-utils';
import { runImportProviderConfigArrayScreen } from '../../src/ui/screens/import-provider-config-array-screen';

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

beforeEach(() => {
  state.assertValidSessionToken.mockReset();
  state.confirmFinalizeImport.mockReset();
  state.confirmFinalizeImport.mockResolvedValue(true);
  state.saveProviderDraft.mockReset();
  state.saveProviderDraft.mockResolvedValue('saved');
  state.showValidationErrors.mockReset();
});

describe('provider array import validation', () => {
  it('validates every selected auth before saving the first provider', async () => {
    state.assertValidSessionToken
      .mockImplementationOnce(() => undefined)
      .mockImplementationOnce(() => {
        throw new Error('Invalid authentication token data.');
      });
    const drafts: ProviderFormDraft[] = [
      {
        type: 'openai-chat-completion',
        name: 'first',
        baseUrl: 'https://first.example.test/v1',
        models: [],
        auth: {
          method: 'openai-codex',
          bindingId: '00000000-0000-4000-8000-000000000801',
        },
      },
      {
        type: 'openai-chat-completion',
        name: 'second',
        baseUrl: 'https://second.example.test/v1',
        models: [],
        auth: {
          method: 'openai-codex',
          bindingId: '00000000-0000-4000-8000-000000000802',
          token: '{invalid-json}',
        },
      },
    ];
    const store = new ConfigStore();

    const result = await runImportProviderConfigArrayScreen(
      {
        store,
        secretStore: new SecretStore(new MemorySecretStorage()),
      },
      {
        kind: 'importProviderConfigArray',
        configs: [],
        drafts,
      },
      undefined,
    );

    expect(result).toEqual({ kind: 'stay' });
    expect(state.assertValidSessionToken).toHaveBeenCalledTimes(2);
    expect(state.showValidationErrors).toHaveBeenCalledWith([
      'second: Invalid authentication token data.',
    ]);
    expect(state.confirmFinalizeImport).not.toHaveBeenCalled();
    expect(state.saveProviderDraft).not.toHaveBeenCalled();
    store.dispose();
  });
});

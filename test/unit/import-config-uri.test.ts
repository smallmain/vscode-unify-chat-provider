import type * as vscode from 'vscode';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  decoded: undefined as unknown,
  runUiStack: vi.fn(),
  showErrorMessage: vi.fn(),
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

  class Uri {
    private constructor(
      readonly path: string,
      readonly query: string,
      private readonly value: string,
    ) {}

    static parse(value: string): Uri {
      const parsed = new URL(value);
      return new Uri(parsed.pathname, parsed.search.slice(1), value);
    }

    toString(): string {
      return this.value;
    }
  }

  return {
    Disposable,
    EventEmitter,
    ProgressLocation: { Notification: 1 },
    Uri,
    env: { language: 'en', uriScheme: 'vscode' },
    l10n: { t: (message: string) => message },
    window: {
      showErrorMessage: state.showErrorMessage,
      withProgress: async (
        _options: unknown,
        task: () => Promise<unknown>,
      ) => await task(),
    },
    workspace: {
      getConfiguration: () => ({ get: () => undefined }),
      onDidChangeConfiguration: () => new Disposable(),
    },
  };
});

vi.mock('../../src/ui/base64-config', () => ({
  decodeConfigStringToValue: () => state.decoded,
  fetchConfigFromUrl: vi.fn(),
  isValidHttpUrl: () => false,
}));

vi.mock('../../src/ui/router/stack-router', () => ({
  runUiStack: state.runUiStack,
}));

vi.mock('../../src/main-instance', () => ({
  mainInstance: { runInLeaderWhenAvailable: vi.fn() },
}));

vi.mock('../../src/client/definitions', () => ({
  PROVIDER_KEYS: ['openai-chat-completion'],
  PROVIDER_TYPES: { 'openai-chat-completion': {} },
}));

vi.mock('../../src/utils', () => ({
  isRawBaseUrlEnabled: () => false,
  normalizeBaseUrlInput: (value: string) => value,
  normalizeRawBaseUrlInput: (value: string) => value,
  normalizeUseRawBaseUrl: (value: unknown) => value === true,
}));

vi.mock('../../src/secret/migration', () => ({
  getRenamedProviderType: () => undefined,
}));

vi.mock('../../src/logger', () => ({
  authLog: {
    error: vi.fn(),
    verbose: vi.fn(),
    warn: vi.fn(),
  },
}));

import { ImportConfigUriHandler } from '../../src/uri-handler';
import { ConfigStore } from '../../src/config-store';
import { SecretStore } from '../../src/secret/secret-store';
import {
  parseProviderConfigArray,
  parseProviderConfigInput,
} from '../../src/ui/import-config';
import * as vscodeApi from 'vscode';

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
  state.decoded = undefined;
  state.runUiStack.mockReset();
  state.showErrorMessage.mockReset();
});

describe('ImportConfigUriHandler auth validation', () => {
  const malformedTokenProvider = {
    type: 'openai-chat-completion',
    name: 'malformed-token',
    baseUrl: 'https://api.example.test/v1',
    models: [],
    auth: {
      method: 'openai-codex',
      token: '{invalid-json}',
    },
  };

  it('rejects malformed session tokens in single and array config inputs', () => {
    expect(parseProviderConfigInput(malformedTokenProvider)).toBeUndefined();
    expect(
      parseProviderConfigArray([
        {
          ...malformedTokenProvider,
          name: 'valid-first',
          auth: { method: 'openai-codex' },
        },
        malformedTokenProvider,
      ]),
    ).toBeUndefined();
  });

  it('rejects malformed auth without opening the provider form', async () => {
    state.decoded = {
      type: 'openai-chat-completion',
      name: 'malformed',
      baseUrl: 'https://api.example.test/v1',
      models: [],
      auth: {
        method: 'openai-codex',
        unknownContext: 'must-not-be-accepted',
      },
    };
    const configStore = new ConfigStore();
    const handler = new ImportConfigUriHandler(
      configStore,
      new SecretStore(new MemorySecretStorage()),
    );

    await expect(
      handler.handleUri(
        vscodeApi.Uri.parse(
          'vscode://SmallMain.vscode-unify-chat-provider/import-config?config=value',
        ),
      ),
    ).resolves.toBeUndefined();

    expect(state.showErrorMessage).toHaveBeenCalledWith(
      'Invalid provider configuration.',
    );
    expect(state.runUiStack).not.toHaveBeenCalled();
    configStore.dispose();
  });

  it('rejects malformed session tokens from URI imports', async () => {
    state.decoded = malformedTokenProvider;
    const configStore = new ConfigStore();
    const handler = new ImportConfigUriHandler(
      configStore,
      new SecretStore(new MemorySecretStorage()),
    );

    await expect(
      handler.handleUri(
        vscodeApi.Uri.parse(
          'vscode://SmallMain.vscode-unify-chat-provider/import-config?config=value',
        ),
      ),
    ).resolves.toBeUndefined();

    expect(state.showErrorMessage).toHaveBeenCalledWith(
      'Invalid provider configuration.',
    );
    expect(state.runUiStack).not.toHaveBeenCalled();
    configStore.dispose();
  });
});

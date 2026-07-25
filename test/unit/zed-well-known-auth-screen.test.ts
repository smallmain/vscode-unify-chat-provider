import { describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => ({
  authConfig: undefined as
    | { method?: string; baseUrl?: string }
    | undefined,
}));

vi.mock('vscode', () => {
  class Disposable {
    constructor(private readonly callback: () => void = () => undefined) {}
    dispose(): void {
      this.callback();
    }
  }
  class EventEmitter<T> {
    readonly event = (_listener: (value: T) => void): Disposable =>
      new Disposable();
    fire(_value: T): void {}
    dispose(): void {}
  }
  return {
    Disposable,
    EventEmitter,
    QuickPickItemKind: { Separator: -1 },
    env: { language: 'en' },
    l10n: { t: (message: string) => message },
    workspace: {
      getConfiguration: () => ({
        get: <T>(_key: string, fallback: T): T => fallback,
      }),
      onDidChangeConfiguration: () => new Disposable(),
    },
  };
});

vi.mock('../../src/ui/provider-ops', () => ({
  captureDraftAuthCommitGuard: vi.fn(),
  saveProviderDraft: vi.fn(),
}));

vi.mock('../../src/ui/component', () => ({
  pickQuickItem: vi.fn(),
  showValidationErrors: vi.fn(),
}));

vi.mock('../../src/well-known/auths', () => ({
  WELL_KNOWN_AUTH_PRESETS: [],
}));

vi.mock('../../src/auth', () => ({
  AUTH_METHODS: {
    zed: {
      id: 'zed',
      label: 'Zed',
      category: 'OAuth',
      description: 'Zed auth',
    },
  },
  createAuthProvider: vi.fn(),
  createAuthProviderForMethod: vi.fn(
    (
      _context: unknown,
      method: string,
      config?: { method?: string; baseUrl?: string },
    ) => ({
      getConfig: () => config,
      configure: async () => {
        harness.authConfig = config ?? { method };
        return {
          success: true,
          config: { method: 'zed', baseUrl: config?.baseUrl },
        };
      },
      dispose: vi.fn(),
    }),
  ),
  normalizeAuthForProvider: (
    auth: { method?: string; baseUrl?: string } | undefined,
    context: { baseUrl?: string },
    method = auth?.method,
  ) =>
    method === 'zed'
      ? {
          ...(auth ?? {}),
          method: 'zed',
          baseUrl: context.baseUrl,
        }
      : auth,
  getAuthMethodDefinition: () => ({
    id: 'zed',
    label: 'Zed',
    category: 'OAuth',
    description: 'Zed auth',
  }),
}));

import { ConfigStore } from '../../src/config-store';
import { SecretStore } from '../../src/secret/secret-store';
import type { WellKnownProviderConfig } from '../../src/well-known/providers';
import type { ProviderFormDraft } from '../../src/ui/form-utils';
import { runWellKnownProviderAuthScreen } from '../../src/ui/screens/well-known-provider-auth-screen';

describe('Zed well-known authentication screen', () => {
  it('seeds Zed auth.baseUrl from the draft before configure()', async () => {
    const provider = {
      name: 'Zed',
      category: 'Experimental',
      type: 'zed',
      baseUrl: 'https://zed.dev',
      authTypes: ['zed'],
      models: [],
      autoFetchOfficialModels: true,
    } satisfies WellKnownProviderConfig;
    const secretStore = new SecretStore({
      get: async () => undefined,
      store: async () => undefined,
      delete: async () => undefined,
      keys: async () => [],
      onDidChange: () => ({ dispose: () => undefined }),
    });
    const draft: ProviderFormDraft = {
      type: provider.type,
      name: provider.name,
      baseUrl: provider.baseUrl,
      models: [],
      autoFetchOfficialModels: true,
    };

    const action = await runWellKnownProviderAuthScreen(
      { store: new ConfigStore(), secretStore },
      { kind: 'wellKnownProviderAuth', provider, draft },
      undefined,
    );

    expect(harness.authConfig).toMatchObject({
      method: 'zed',
      baseUrl: 'https://zed.dev',
    });
    expect(action).toMatchObject({ kind: 'push', route: { kind: 'modelList' } });
    expect(draft.auth).toEqual({
      method: 'zed',
      baseUrl: 'https://zed.dev',
    });
  });
});

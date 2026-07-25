import type * as vscode from 'vscode';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const createAuthProviderMock = vi.hoisted(() => vi.fn());
const broadcastMock = vi.hoisted(() => vi.fn());
const mainInstanceState = vi.hoisted(() => ({
  leader: true,
  runInLeaderWhenAvailable: vi.fn(),
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
    Disposable,
    EventEmitter,
    env: { language: 'en' },
    l10n: { t: (message: string) => message },
  };
});

vi.mock('../../src/logger', () => ({
  authLog: {
    error: vi.fn(),
    verbose: vi.fn(),
    warn: vi.fn(),
  },
}));

vi.mock('../../src/main-instance', () => ({
  mainInstance: {
    isLeader: () => mainInstanceState.leader,
    broadcast: broadcastMock,
    runInLeaderWhenAvailable: mainInstanceState.runInLeaderWhenAvailable,
    runLeaderMutation: mainInstanceState.runLeaderMutation,
    onDidReceiveEvent: () => ({ dispose: () => undefined }),
    onDidChangeRole: () => ({ dispose: () => undefined }),
  },
}));

vi.mock('../../src/auth/create-auth-provider', () => ({
  createAuthProvider: createAuthProviderMock,
}));

vi.mock('../../src/auth/definitions', () => ({
  normalizeAuthForProvider: (auth: unknown) => auth,
}));

import {
  AuthManager,
  type AuthManagerConfigStore,
} from '../../src/auth/auth-manager';
import type {
  AuthProvider,
  AuthProviderContext,
} from '../../src/auth/auth-provider';
import type {
  AuthCredential,
  AuthRuntimeConfig,
  OpenAICodexAuthConfig,
} from '../../src/auth/types';
import { captureProviderSourceGuard } from '../../src/auth/provider-source-guard';
import { LocalAuthStateConflictError } from '../../src/secret';
import { SecretStore } from '../../src/secret/secret-store';
import type { ProviderConfig } from '../../src/types';

const BINDING_ID = '00000000-0000-4000-8000-000000000401';
const descriptor = {
  providerName: 'Codex',
  providerType: 'openai-responses',
  baseUrl: 'https://api.openai.com/v1',
} as const;

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

function token(accessToken: string): string {
  return JSON.stringify({ accessToken, tokenType: 'Bearer' });
}

async function createFixture(options: { leaderAuthReady?: boolean } = {}): Promise<{
  authManager: AuthManager;
  getConfigured: () => ProviderConfig;
  setConfigured: (provider: ProviderConfig) => void;
  initialRuntime: OpenAICodexAuthConfig;
  secretStore: SecretStore;
  upsertProvider: ReturnType<typeof vi.fn>;
  upsertProviderIfUnchanged: ReturnType<typeof vi.fn>;
}> {
  const secretStore = new SecretStore(new MemorySecretStorage());
  const initialRuntime: OpenAICodexAuthConfig = {
    method: 'openai-codex',
    bindingId: BINDING_ID,
    identityId: 'initial-session',
    token: token('initial-access'),
    accountId: 'account-a',
  };
  const persisted = await secretStore.persistSessionAuth(
    descriptor,
    initialRuntime,
    {
      reason: 'login',
      emptyToken: 'clear',
      binding: 'existing-or-random',
    },
  );
  let configured: ProviderConfig = {
    type: descriptor.providerType,
    name: descriptor.providerName,
    baseUrl: descriptor.baseUrl,
    auth: persisted,
    models: [],
  };
  const upsertProvider = vi.fn(async (provider: ProviderConfig) => {
    configured = provider;
  });
  const upsertProviderIfUnchanged = vi.fn(
    async (
      provider: ProviderConfig,
      _hints: {},
      isSourceCurrent: () => boolean,
    ) => {
      if (!isSourceCurrent()) return false;
      await upsertProvider(provider);
      return true;
    },
  );
  const configStore: AuthManagerConfigStore = {
    getProvider: (name) =>
      name === configured.name ? configured : undefined,
    upsertProvider,
    upsertProviderIfUnchanged,
  };
  return {
    authManager: new AuthManager(
      configStore,
      secretStore,
      undefined,
      options.leaderAuthReady,
    ),
    getConfigured: () => configured,
    setConfigured: (provider) => {
      configured = provider;
    },
    initialRuntime,
    secretStore,
    upsertProvider,
    upsertProviderIfUnchanged,
  };
}

function fakeProvider(
  auth: AuthRuntimeConfig,
  getCredential: () => Promise<AuthCredential | undefined>,
  dispose = vi.fn(),
): AuthProvider {
  return {
    definition: { id: auth.method, label: auth.method },
    getConfig: () => auth,
    getCredential,
    getExpiryBufferMs: () => 0,
    isValid: async () => true,
    configure: async () => ({ success: false }),
    revoke: async () => undefined,
    onDidChangeStatus: () => ({ dispose: () => undefined }),
    dispose,
  };
}

beforeEach(() => {
  createAuthProviderMock.mockReset();
  broadcastMock.mockReset();
  mainInstanceState.leader = true;
  mainInstanceState.runInLeaderWhenAvailable.mockReset();
  mainInstanceState.runLeaderMutation.mockClear();
});

describe('AuthManager local auth operation races', () => {
  it('waits for leader migration before using device-local auth', async () => {
    const fixture = await createFixture({ leaderAuthReady: false });
    const configured = fixture.getConfigured();
    if (configured.auth?.method !== 'openai-codex') {
      throw new Error('Expected persisted Codex authentication.');
    }
    const context = fixture.secretStore.getLocalAuthContext(
      descriptor,
      configured.auth,
    );
    if (!context) throw new Error('Expected local auth context.');
    mainInstanceState.runInLeaderWhenAvailable.mockResolvedValue({
      credential: {
        value: 'initial-access',
        tokenType: 'Bearer',
        authContext: context,
      },
    });

    await expect(
      fixture.authManager.getCredential(descriptor.providerName),
    ).resolves.toMatchObject({ value: 'initial-access' });
    expect(createAuthProviderMock).not.toHaveBeenCalled();

    createAuthProviderMock.mockImplementation(
      (_context: AuthProviderContext, auth: AuthRuntimeConfig) =>
        fakeProvider(auth, async () => ({ value: 'initial-access' })),
    );
    fixture.authManager.setLeaderAuthReady(true);
    await expect(
      fixture.authManager.getCredential(descriptor.providerName),
    ).resolves.toMatchObject({ value: 'initial-access' });
    expect(createAuthProviderMock).toHaveBeenCalledOnce();
    fixture.authManager.dispose();
  });

  it('rejects a follower credential for a different local binding', async () => {
    const fixture = await createFixture({ leaderAuthReady: false });
    mainInstanceState.runInLeaderWhenAvailable.mockResolvedValue({
      credential: {
        value: 'other-access',
        tokenType: 'Bearer',
        authContext: {
          method: 'openai-codex',
          bindingId: '00000000-0000-4000-8000-000000000499',
          sessionId: 'other-session',
          revision: 1,
        },
      },
    });

    await expect(
      fixture.authManager.getCredential(descriptor.providerName),
    ).resolves.toBeUndefined();
    fixture.authManager.dispose();
  });

  it('rejects a follower credential for a stale session on the same binding', async () => {
    const fixture = await createFixture({ leaderAuthReady: false });
    mainInstanceState.runInLeaderWhenAvailable.mockResolvedValue({
      credential: {
        value: 'stale-access',
        tokenType: 'Bearer',
        authContext: {
          method: 'openai-codex',
          bindingId: BINDING_ID,
          sessionId: 'stale-session',
          revision: 0,
          accountId: 'stale-account',
        },
      },
    });

    await expect(
      fixture.authManager.getCredential(descriptor.providerName),
    ).resolves.toBeUndefined();
    expect(mainInstanceState.runInLeaderWhenAvailable).toHaveBeenCalledTimes(3);
    fixture.authManager.dispose();
  });

  it('commits only the first login that captured the same starting revision', async () => {
    const fixture = await createFixture();
    let providerContext: AuthProviderContext | undefined;
    createAuthProviderMock.mockImplementation(
      (context: AuthProviderContext, auth: AuthRuntimeConfig) => {
        providerContext = context;
        return fakeProvider(auth, async () => undefined);
      },
    );
    fixture.authManager.getProvider(descriptor.providerName);
    if (!providerContext?.persistAuthConfig) {
      throw new Error('Expected a persistence-bound auth provider context.');
    }

    const firstGuard = providerContext.captureAuthCommitGuard?.();
    const secondGuard = providerContext.captureAuthCommitGuard?.();
    const first: OpenAICodexAuthConfig = {
      ...fixture.initialRuntime,
      identityId: 'login-a',
      token: token('access-a'),
      accountId: 'account-a',
    };
    const second: OpenAICodexAuthConfig = {
      ...fixture.initialRuntime,
      identityId: 'login-b',
      token: token('access-b'),
      accountId: 'account-b',
    };

    const firstCommit = providerContext.persistAuthConfig(first, firstGuard);
    const secondCommit = providerContext.persistAuthConfig(second, secondGuard);
    await firstCommit;
    await expect(secondCommit).rejects.toBeInstanceOf(
      LocalAuthStateConflictError,
    );

    const configured = fixture.getConfigured();
    if (configured.auth?.method !== 'openai-codex') {
      throw new Error('Expected persisted Codex authentication.');
    }
    const hydrated = fixture.secretStore.hydrateSessionAuth(
      descriptor,
      configured.auth,
    );
    const stored = await fixture.secretStore.getOAuth2Token(
      hydrated.token ?? '',
    );
    expect(stored?.accessToken).toBe('access-a');
    expect(
      fixture.secretStore.getLocalAuthContext(descriptor, hydrated),
    ).toMatchObject({ method: 'openai-codex', accountId: 'account-a' });
    fixture.authManager.dispose();
  });

  it('retries credential acquisition after an external account switch', async () => {
    const fixture = await createFixture();
    let releaseOld: ((credential: AuthCredential) => void) | undefined;
    const oldCredential = new Promise<AuthCredential>((resolve) => {
      releaseOld = resolve;
    });
    const firstDispose = vi.fn();
    let created = 0;
    createAuthProviderMock.mockImplementation(
      (_context: AuthProviderContext, auth: AuthRuntimeConfig) => {
        created += 1;
        return created === 1
          ? fakeProvider(auth, async () => oldCredential, firstDispose)
          : fakeProvider(auth, async () => ({ value: 'new-access' }));
      },
    );

    const pending = fixture.authManager.getCredential(descriptor.providerName);
    await vi.waitFor(() => expect(createAuthProviderMock).toHaveBeenCalledOnce());

    const configured = fixture.getConfigured();
    if (configured.auth?.method !== 'openai-codex') {
      throw new Error('Expected persisted Codex authentication.');
    }
    const current = fixture.secretStore.hydrateSessionAuth(
      descriptor,
      configured.auth,
    );
    if (current.method !== 'openai-codex') {
      throw new Error('Expected hydrated Codex authentication.');
    }
    const guard = fixture.secretStore.getLocalAuthCommitGuard(
      descriptor,
      current,
    );
    await fixture.secretStore.persistSessionAuth(
      descriptor,
      {
        ...current,
        identityId: 'new-login',
        token: token('new-access'),
        accountId: 'account-b',
      },
      {
        reason: 'login',
        emptyToken: 'clear',
        binding: 'existing-or-random',
        guard,
      },
    );
    releaseOld?.({ value: 'old-access' });

    await expect(pending).resolves.toMatchObject({
      value: 'new-access',
      authContext: {
        method: 'openai-codex',
        accountId: 'account-b',
      },
    });
    expect(firstDispose).toHaveBeenCalledOnce();
    expect(createAuthProviderMock).toHaveBeenCalledTimes(2);
    fixture.authManager.dispose();
  });

  it('retries an empty credential after a local session context commit', async () => {
    const fixture = await createFixture();
    let providerContext: AuthProviderContext | undefined;
    let releasePending: (() => void) | undefined;
    const pendingCredential = new Promise<AuthCredential | undefined>(
      (resolve) => {
        releasePending = () => resolve(undefined);
      },
    );
    let attempt = 0;
    const getCredential = vi.fn(
      async (): Promise<AuthCredential | undefined> => {
        attempt += 1;
        return attempt === 1
          ? await pendingCredential
          : { value: 'refreshed-access' };
      },
    );
    const dispose = vi.fn();
    createAuthProviderMock.mockImplementation(
      (context: AuthProviderContext, auth: AuthRuntimeConfig) => {
        providerContext = context;
        return fakeProvider(auth, getCredential, dispose);
      },
    );

    const pending = fixture.authManager.getCredential(descriptor.providerName);
    await vi.waitFor(() => expect(getCredential).toHaveBeenCalledOnce());
    if (!providerContext?.persistAuthConfig) {
      throw new Error('Expected a persistence-bound auth provider context.');
    }

    const guard = providerContext.captureAuthCommitGuard?.();
    await providerContext.persistAuthConfig(
      {
        ...fixture.initialRuntime,
        token: token('refreshed-access'),
      },
      guard,
    );
    const configured = fixture.getConfigured();
    if (configured.auth?.method !== 'openai-codex') {
      throw new Error('Expected persisted Codex authentication.');
    }
    const currentContext = fixture.secretStore.getLocalAuthContext(
      descriptor,
      configured.auth,
    );
    if (!currentContext) throw new Error('Expected refreshed local auth context.');
    expect(dispose).not.toHaveBeenCalled();

    releasePending?.();

    await expect(pending).resolves.toEqual({
      value: 'refreshed-access',
      authContext: currentContext,
    });
    expect(getCredential).toHaveBeenCalledTimes(2);
    expect(createAuthProviderMock).toHaveBeenCalledOnce();
    expect(dispose).not.toHaveBeenCalled();
    fixture.authManager.dispose();
  });

  it('does not return a credential for a changed static provider target', async () => {
    const fixture = await createFixture();
    let releaseOld: ((credential: AuthCredential) => void) | undefined;
    const oldCredential = new Promise<AuthCredential>((resolve) => {
      releaseOld = resolve;
    });
    const firstDispose = vi.fn();
    createAuthProviderMock
      .mockImplementationOnce(
        (_context: AuthProviderContext, auth: AuthRuntimeConfig) =>
          fakeProvider(auth, async () => oldCredential, firstDispose),
      )
      .mockImplementation(
        (_context: AuthProviderContext, auth: AuthRuntimeConfig) =>
          fakeProvider(auth, async () => ({ value: 'wrong-target-access' })),
      );

    const pending = fixture.authManager.getCredential(descriptor.providerName);
    await vi.waitFor(() => expect(createAuthProviderMock).toHaveBeenCalledOnce());
    fixture.setConfigured({
      ...fixture.getConfigured(),
      baseUrl: 'https://other.example.test/v1',
    });
    releaseOld?.({ value: 'old-target-access' });

    await expect(pending).resolves.toBeUndefined();
    expect(firstDispose).toHaveBeenCalledOnce();
    fixture.authManager.dispose();
  });

  it('rejects a stale auth commit after the synced provider target changes', async () => {
    const fixture = await createFixture();
    let providerContext: AuthProviderContext | undefined;
    createAuthProviderMock.mockImplementation(
      (context: AuthProviderContext, auth: AuthRuntimeConfig) => {
        providerContext = context;
        return fakeProvider(auth, async () => undefined);
      },
    );
    fixture.authManager.getProvider(descriptor.providerName);
    if (!providerContext?.persistAuthConfig) {
      throw new Error('Expected a persistence-bound auth provider context.');
    }

    const guard = providerContext.captureAuthCommitGuard?.();
    fixture.setConfigured({
      ...fixture.getConfigured(),
      baseUrl: 'https://synced.example.test/v1',
    });

    await expect(
      providerContext.persistAuthConfig(
        {
          ...fixture.initialRuntime,
          token: token('stale-refresh'),
        },
        guard,
      ),
    ).rejects.toBeInstanceOf(LocalAuthStateConflictError);
    expect(fixture.getConfigured().baseUrl).toBe(
      'https://synced.example.test/v1',
    );
    expect(fixture.upsertProvider).not.toHaveBeenCalled();
    fixture.authManager.dispose();
  });

  it('does not overwrite a provider synced during the local secret commit', async () => {
    const fixture = await createFixture();
    let providerContext: AuthProviderContext | undefined;
    createAuthProviderMock.mockImplementation(
      (context: AuthProviderContext, auth: AuthRuntimeConfig) => {
        providerContext = context;
        return fakeProvider(auth, async () => undefined);
      },
    );
    fixture.authManager.getProvider(descriptor.providerName);
    if (!providerContext?.persistAuthConfig) {
      throw new Error('Expected a persistence-bound auth provider context.');
    }
    const originalPrepare =
      fixture.secretStore.prepareSessionAuthTransaction.bind(
        fixture.secretStore,
      );
    vi.spyOn(
      fixture.secretStore,
      'prepareSessionAuthTransaction',
    ).mockImplementationOnce(
      async (commitDescriptor, auth, options) => {
        const result = await originalPrepare(commitDescriptor, auth, options);
        fixture.setConfigured({
          ...fixture.getConfigured(),
          baseUrl: 'https://synced-during-commit.example.test/v1',
        });
        return result;
      },
    );

    await expect(
      providerContext.persistAuthConfig({
        ...fixture.initialRuntime,
        token: token('stale-refresh'),
      }),
    ).rejects.toBeInstanceOf(LocalAuthStateConflictError);
    expect(fixture.getConfigured().baseUrl).toBe(
      'https://synced-during-commit.example.test/v1',
    );
    expect(fixture.upsertProvider).not.toHaveBeenCalled();
    const restored = fixture.secretStore.getLocalAuthCredentialSnapshot(
      descriptor,
      fixture.initialRuntime,
    );
    expect(restored?.token?.accessToken).toBe('initial-access');
    expect(restored?.authContext).toMatchObject({
      method: 'openai-codex',
      accountId: 'account-a',
    });
    fixture.authManager.dispose();
  });

  it('rejects a stale provider-form session commit at the Leader', async () => {
    const fixture = await createFixture();
    const configured = fixture.getConfigured();
    if (!configured.auth || !isCodexAuth(configured.auth)) {
      throw new Error('Expected persisted Codex authentication.');
    }
    const guard = fixture.secretStore.getLocalAuthCommitGuard(
      descriptor,
      fixture.initialRuntime,
    );
    const sourceGuard = captureProviderSourceGuard([
      { providerName: configured.name, provider: configured },
    ]);
    fixture.setConfigured({
      ...configured,
      baseUrl: 'https://synced-form-target.example.test/v1',
    });
    const runtimeAuth: OpenAICodexAuthConfig = {
      ...fixture.initialRuntime,
      token: token('stale-form-token'),
    };

    await expect(
      fixture.authManager.prepareProviderForPersistence(
        {
          ...configured,
          auth: runtimeAuth,
        },
        guard,
        sourceGuard,
      ),
    ).rejects.toBeInstanceOf(LocalAuthStateConflictError);
    expect(fixture.getConfigured().baseUrl).toBe(
      'https://synced-form-target.example.test/v1',
    );
    fixture.authManager.dispose();
  });

  it('does not repeat a successful follower auth config write locally', async () => {
    const fixture = await createFixture();
    let providerContext: AuthProviderContext | undefined;
    createAuthProviderMock.mockImplementation(
      (context: AuthProviderContext, auth: AuthRuntimeConfig) => {
        providerContext = context;
        return fakeProvider(auth, async () => undefined);
      },
    );
    fixture.authManager.getProvider(descriptor.providerName);
    if (!providerContext?.persistAuthConfig) {
      throw new Error('Expected a persistence-bound auth provider context.');
    }
    mainInstanceState.leader = false;
    mainInstanceState.runInLeaderWhenAvailable.mockResolvedValue({ ok: true });

    await providerContext.persistAuthConfig({
      ...fixture.initialRuntime,
      token: token('follower-refresh'),
    });

    expect(mainInstanceState.runInLeaderWhenAvailable).toHaveBeenCalledOnce();
    expect(fixture.upsertProvider).not.toHaveBeenCalled();
    fixture.authManager.dispose();
  });

  it('rejects a provider persistence callback after AuthManager disposal', async () => {
    const fixture = await createFixture();
    let providerContext: AuthProviderContext | undefined;
    createAuthProviderMock.mockImplementation(
      (context: AuthProviderContext, auth: AuthRuntimeConfig) => {
        providerContext = context;
        return fakeProvider(auth, async () => undefined);
      },
    );
    fixture.authManager.getProvider(descriptor.providerName);
    if (!providerContext?.persistAuthConfig) {
      throw new Error('Expected a persistence-bound auth provider context.');
    }
    fixture.authManager.dispose();

    await expect(
      providerContext.persistAuthConfig({
        ...fixture.initialRuntime,
        token: token('late-refresh'),
      }),
    ).rejects.toBeInstanceOf(LocalAuthStateConflictError);
    expect(mainInstanceState.runLeaderMutation).not.toHaveBeenCalled();
    expect(fixture.upsertProvider).not.toHaveBeenCalled();
  });
});

function isCodexAuth(
  auth: ProviderConfig['auth'],
): auth is OpenAICodexAuthConfig {
  return auth?.method === 'openai-codex';
}

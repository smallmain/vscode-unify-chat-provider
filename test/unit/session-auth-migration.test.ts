import type * as vscode from 'vscode';
import { afterEach, describe, expect, it, vi } from 'vitest';

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

vi.mock('../../src/auth', () => ({
  normalizeAuthOnImport: async (auth: unknown) => auth,
  supportsSensitiveAuthInSettings: () => false,
}));

vi.mock('../../src/logger', () => ({
  authLog: {
    error: vi.fn(),
    verbose: vi.fn(),
    warn: vi.fn(),
  },
}));

import {
  deriveLegacyAuthBindingId,
  type AuthBindingDescriptor,
} from '../../src/auth/local-auth-state';
import { stableStringify } from '../../src/config-ops';
import type {
  OAuth2AuthConfig,
  OAuth2TokenData,
  OpenAICodexAuthConfig,
} from '../../src/auth/types';
import {
  buildOAuth2ClientSecretStorageKey,
  buildOAuth2TokenStorageKey,
  createSecretRef,
} from '../../src/secret/constants';
import {
  migrateApiKeyToAuth,
  migrateProviderTypes,
  migrateSessionAuthState,
} from '../../src/secret/migration';
import { SecretStore } from '../../src/secret/secret-store';

class MemorySecretStorage implements vscode.SecretStorage {
  readonly values = new Map<string, string>();
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

class RawEndpointStore {
  afterCompare?: () => void | Promise<void>;
  compareAndSetAttempts = 0;

  constructor(public rawEndpoints: unknown[]) {}

  async setRawEndpoints(endpoints: unknown[]): Promise<void> {
    this.rawEndpoints = endpoints;
  }

  async setRawEndpointsIfUnchanged(
    expectedSignature: string,
    endpoints: unknown[],
  ): Promise<boolean> {
    this.compareAndSetAttempts += 1;
    if (stableStringify(this.rawEndpoints) !== expectedSignature) return false;
    await this.afterCompare?.();
    if (stableStringify(this.rawEndpoints) !== expectedSignature) return false;
    this.rawEndpoints = endpoints;
    return true;
  }
}

const descriptor: AuthBindingDescriptor = {
  providerName: 'Codex',
  providerType: 'openai-responses',
  baseUrl: 'https://api.openai.com/v1',
};

function jwt(claims: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none' })).toString(
    'base64url',
  );
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `${header}.${payload}.signature`;
}

function codexToken(accountId: string): OAuth2TokenData {
  return {
    accessToken: jwt({
      'https://api.openai.com/auth': { chatgpt_account_id: accountId },
      email: `${accountId}@example.com`,
    }),
    refreshToken: `${accountId}-refresh`,
    tokenType: 'Bearer',
  };
}

function rawProvider(tokenRef: string): Record<string, unknown> {
  return {
    ...descriptor,
    name: descriptor.providerName,
    type: descriptor.providerType,
    models: [
      {
        id: 'gpt-test',
        completion: { templates: ['future-template'], future: true },
        sourceId: 'source-model-id',
      },
    ],
    completion: { templates: ['future-template'], future: true },
    proposedApiState: { untouched: true },
    auth: {
      method: 'openai-codex',
      token: tokenRef,
      identityId: 'legacy-session',
      accountId: 'synced-account',
      email: 'synced@example.com',
    },
  };
}

function migratedAuth(store: RawEndpointStore): Record<string, unknown> {
  const endpoint = store.rawEndpoints[0];
  if (!endpoint || typeof endpoint !== 'object' || Array.isArray(endpoint)) {
    throw new Error('Expected migrated endpoint.');
  }
  const auth = (endpoint as Record<string, unknown>)['auth'];
  if (!auth || typeof auth !== 'object' || Array.isArray(auth)) {
    throw new Error('Expected migrated auth.');
  }
  return auth as Record<string, unknown>;
}

afterEach(() => vi.unstubAllGlobals());

describe('raw endpoint startup migrations', () => {
  it('rebases API key migration on a concurrent Settings Sync update', async () => {
    const initial = {
      type: 'openai-chat-completion',
      name: 'Legacy API Key',
      baseUrl: 'https://legacy.example.test/v1',
      apiKey: 'legacy-key',
      models: [],
      futureProviderOption: { preserve: 'initial' },
    };
    const config = new RawEndpointStore([initial]);
    config.afterCompare = () => {
      config.afterCompare = undefined;
      config.rawEndpoints = [
        {
          ...initial,
          futureProviderOption: { preserve: 'synced' },
          asynchronouslySynced: { preserve: true },
        },
        {
          type: 'anthropic',
          name: 'Arrived During Migration',
          baseUrl: 'https://api.anthropic.com',
          apiKey: 'arrived-key',
          models: [],
          futureProviderOption: { preserve: 'arrived' },
        },
      ];
    };

    await migrateApiKeyToAuth(config);

    expect(config.compareAndSetAttempts).toBe(2);
    expect(config.rawEndpoints).toEqual([
      {
        type: 'openai-chat-completion',
        name: 'Legacy API Key',
        baseUrl: 'https://legacy.example.test/v1',
        models: [],
        futureProviderOption: { preserve: 'synced' },
        asynchronouslySynced: { preserve: true },
        auth: { method: 'api-key', apiKey: 'legacy-key' },
      },
      {
        type: 'anthropic',
        name: 'Arrived During Migration',
        baseUrl: 'https://api.anthropic.com',
        models: [],
        futureProviderOption: { preserve: 'arrived' },
        auth: { method: 'api-key', apiKey: 'arrived-key' },
      },
    ]);

    const migratedSignature = stableStringify(config.rawEndpoints);
    await migrateApiKeyToAuth(config);
    expect(config.compareAndSetAttempts).toBe(2);
    expect(stableStringify(config.rawEndpoints)).toBe(migratedSignature);
  });

  it('rebases provider type migration on a concurrent Settings Sync update', async () => {
    const initial = {
      type: 'claude-code-cloak',
      name: 'Legacy Claude',
      baseUrl: 'https://api.anthropic.com',
      models: [],
      futureProviderOption: { preserve: 'initial' },
    };
    const config = new RawEndpointStore([initial]);
    config.afterCompare = () => {
      config.afterCompare = undefined;
      config.rawEndpoints = [
        {
          ...initial,
          futureProviderOption: { preserve: 'synced' },
          asynchronouslySynced: { preserve: true },
        },
        {
          type: 'claude-code-cloak',
          name: 'Arrived During Migration',
          baseUrl: 'https://api.anthropic.com',
          models: [],
          futureProviderOption: { preserve: 'arrived' },
        },
      ];
    };

    await migrateProviderTypes(config);

    expect(config.compareAndSetAttempts).toBe(2);
    expect(config.rawEndpoints).toEqual([
      {
        type: 'claude-code',
        name: 'Legacy Claude',
        baseUrl: 'https://api.anthropic.com',
        models: [],
        futureProviderOption: { preserve: 'synced' },
        asynchronouslySynced: { preserve: true },
      },
      {
        type: 'claude-code',
        name: 'Arrived During Migration',
        baseUrl: 'https://api.anthropic.com',
        models: [],
        futureProviderOption: { preserve: 'arrived' },
      },
    ]);

    const migratedSignature = stableStringify(config.rawEndpoints);
    await migrateProviderTypes(config);
    expect(config.compareAndSetAttempts).toBe(2);
    expect(stableStringify(config.rawEndpoints)).toBe(migratedSignature);
  });
});

describe('session auth startup migration', () => {
  it('does not create an empty envelope for an already-static config', async () => {
    const storage = new MemorySecretStorage();
    const secrets = new SecretStore(storage);
    const bindingId = '00000000-0000-4000-8000-000000000230';
    const config = new RawEndpointStore([
      {
        ...descriptor,
        name: descriptor.providerName,
        type: descriptor.providerType,
        models: [],
        auth: { method: 'openai-codex', bindingId },
      },
    ]);

    await migrateSessionAuthState({ configStore: config, secretStore: secrets });

    expect(secrets.getLocalAuthEnvelope(bindingId)).toBeUndefined();
    expect(migratedAuth(config)).toEqual({
      method: 'openai-codex',
      bindingId,
    });
  });

  it('recovers a unique local Codex orphan after another device synced static auth', async () => {
    const storage = new MemorySecretStorage();
    const secrets = new SecretStore(storage);
    const bindingId = '00000000-0000-4000-8000-000000000231';
    const orphan = createSecretRef();
    await secrets.setOAuth2Token(orphan, codexToken('device-local'));
    const config = new RawEndpointStore([
      {
        ...descriptor,
        name: descriptor.providerName,
        type: descriptor.providerType,
        models: [],
        auth: { method: 'openai-codex', bindingId },
      },
    ]);

    await migrateSessionAuthState({ configStore: config, secretStore: secrets });

    expect(migratedAuth(config)).toEqual({
      method: 'openai-codex',
      bindingId,
    });
    expect(
      secrets.getLocalAuthContext(descriptor, {
        method: 'openai-codex',
        bindingId,
      }),
    ).toMatchObject({ accountId: 'device-local' });
  });

  it('does not resurrect an orphan after an explicit local logout', async () => {
    const storage = new MemorySecretStorage();
    const secrets = new SecretStore(storage);
    const bindingId = '00000000-0000-4000-8000-000000000232';
    await secrets.persistSessionAuth(
      descriptor,
      { method: 'openai-codex', bindingId },
      {
        reason: 'logout',
        emptyToken: 'clear',
        binding: 'existing-or-random',
      },
    );
    const orphan = createSecretRef();
    await secrets.setOAuth2Token(orphan, codexToken('must-stay-logged-out'));
    const config = new RawEndpointStore([
      {
        ...descriptor,
        name: descriptor.providerName,
        type: descriptor.providerType,
        models: [],
        auth: { method: 'openai-codex', bindingId },
      },
    ]);

    await migrateSessionAuthState({ configStore: config, secretStore: secrets });

    expect(
      secrets.getLocalAuthContext(descriptor, {
        method: 'openai-codex',
        bindingId,
      }),
    ).toBeUndefined();
    expect(await secrets.getOAuth2Token(orphan)).toEqual(
      codexToken('must-stay-logged-out'),
    );
  });

  it('moves a current local token offline and preserves raw endpoint fields', async () => {
    const storage = new MemorySecretStorage();
    const secrets = new SecretStore(storage);
    const ref = createSecretRef();
    await secrets.setOAuth2Token(ref, codexToken('local-account'));
    const original = rawProvider(ref);
    const originalAuth = original['auth'];
    if (
      !originalAuth ||
      typeof originalAuth !== 'object' ||
      Array.isArray(originalAuth)
    ) {
      throw new Error('Expected raw auth.');
    }
    (originalAuth as Record<string, unknown>)['futureAuthOption'] = {
      untouched: true,
    };
    const config = new RawEndpointStore([original]);
    const fetcher = vi.fn(async () => {
      throw new Error('Migration must not access the network.');
    });
    vi.stubGlobal('fetch', fetcher);

    await migrateSessionAuthState({ configStore: config, secretStore: secrets });

    const endpoint = config.rawEndpoints[0] as Record<string, unknown>;
    expect(endpoint['completion']).toEqual(original['completion']);
    expect(endpoint['models']).toEqual(original['models']);
    expect(endpoint['proposedApiState']).toEqual(original['proposedApiState']);
    const auth = migratedAuth(config);
    expect(auth).toEqual({
      method: 'openai-codex',
      bindingId: expect.any(String),
      futureAuthOption: { untouched: true },
    });
    const bindingId = auth['bindingId'];
    expect(typeof bindingId).toBe('string');
    if (typeof bindingId !== 'string') throw new Error('Missing binding ID.');
    expect(
      secrets.getLocalAuthContext(descriptor, {
        method: 'openai-codex',
        bindingId,
      }),
    ).toMatchObject({
      accountId: 'synced-account',
      sessionId: 'legacy-session',
    });
    const legacyKey = buildOAuth2TokenStorageKey(ref);
    expect(legacyKey ? storage.values.has(legacyKey) : false).toBe(true);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('rebases migration when endpoints change after comparison', async () => {
    const storage = new MemorySecretStorage();
    const secrets = new SecretStore(storage);
    const ref = createSecretRef();
    await secrets.setOAuth2Token(ref, codexToken('local-account'));
    const initial = rawProvider(ref);
    const config = new RawEndpointStore([initial]);
    config.afterCompare = () => {
      config.afterCompare = undefined;
      config.rawEndpoints = [
        {
          ...initial,
          asynchronouslySynced: { preserve: true },
        },
        {
          type: 'openai-chat-completion',
          name: 'Arrived During Migration',
          baseUrl: 'https://new.example.test/v1',
          auth: { method: 'none' },
          models: [],
        },
      ];
    };

    await migrateSessionAuthState({ configStore: config, secretStore: secrets });

    expect(config.compareAndSetAttempts).toBe(2);
    expect(config.rawEndpoints).toHaveLength(2);
    expect(config.rawEndpoints[0]).toMatchObject({
      asynchronouslySynced: { preserve: true },
      auth: {
        method: 'openai-codex',
        bindingId: expect.any(String),
      },
    });
    expect(config.rawEndpoints[1]).toMatchObject({
      name: 'Arrived During Migration',
    });
  });

  it('uses legacy Claude email as the migration-only session identity', async () => {
    const storage = new MemorySecretStorage();
    const secrets = new SecretStore(storage);
    const ref = createSecretRef();
    await secrets.setOAuth2Token(ref, {
      accessToken: 'claude-access',
      refreshToken: 'claude-refresh',
      tokenType: 'Bearer',
    });
    const claudeDescriptor: AuthBindingDescriptor = {
      providerName: 'Claude',
      providerType: 'anthropic',
      baseUrl: 'https://api.anthropic.com',
    };
    const email = 'legacy@example.com';
    const config = new RawEndpointStore([
      {
        ...claudeDescriptor,
        name: claudeDescriptor.providerName,
        type: claudeDescriptor.providerType,
        models: [],
        auth: {
          method: 'claude-code',
          token: ref,
          email: `  ${email}  `,
        },
      },
    ]);

    await migrateSessionAuthState({ configStore: config, secretStore: secrets });

    const auth = migratedAuth(config);
    expect(auth).toEqual({
      method: 'claude-code',
      bindingId: expect.any(String),
    });
    const bindingId = auth['bindingId'];
    if (typeof bindingId !== 'string') throw new Error('Missing binding ID.');
    expect(
      secrets.getLocalAuthContext(claudeDescriptor, {
        method: 'claude-code',
        bindingId,
      }),
    ).toMatchObject({
      method: 'claude-code',
      sessionId: email,
    });
  });

  it('migrates every provider that shares the same legacy token reference', async () => {
    const storage = new MemorySecretStorage();
    const secrets = new SecretStore(storage);
    const ref = createSecretRef();
    const sharedToken = codexToken('shared-account');
    await secrets.setOAuth2Token(ref, sharedToken);
    const config = new RawEndpointStore([
      rawProvider(ref),
      { ...rawProvider(ref), name: 'Codex Copy' },
    ]);

    await migrateSessionAuthState({ configStore: config, secretStore: secrets });

    for (const raw of config.rawEndpoints) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        throw new Error('Expected migrated provider.');
      }
      const provider = raw as Record<string, unknown>;
      const authValue = provider['auth'];
      if (
        !authValue ||
        typeof authValue !== 'object' ||
        Array.isArray(authValue)
      ) {
        throw new Error('Expected migrated auth.');
      }
      const authRecord = authValue as Record<string, unknown>;
      const bindingId = authRecord['bindingId'];
      if (typeof bindingId !== 'string') {
        throw new Error('Expected migrated binding ID.');
      }
      const runtime = secrets.hydrateSessionAuth(
        {
          providerName: String(provider['name']),
          providerType: String(provider['type']),
          baseUrl: String(provider['baseUrl']),
        },
        { method: 'openai-codex', bindingId },
      );
      expect(await secrets.getOAuth2Token(runtime.token ?? '')).toEqual(
        sharedToken,
      );
    }
  });

  it('keeps a migrated Gemini session readable when oauthType was omitted', async () => {
    const storage = new MemorySecretStorage();
    const secrets = new SecretStore(storage);
    const ref = createSecretRef();
    await secrets.setOAuth2Token(ref, {
      accessToken: 'gemini-access',
      refreshToken: 'gemini-refresh',
      tokenType: 'Bearer',
    });
    const geminiDescriptor: AuthBindingDescriptor = {
      providerName: 'Gemini',
      providerType: 'google-gemini-cli',
      baseUrl: 'https://cloudcode-pa.googleapis.com',
    };
    const config = new RawEndpointStore([
      {
        ...geminiDescriptor,
        name: geminiDescriptor.providerName,
        type: geminiDescriptor.providerType,
        models: [],
        auth: {
          method: 'google-gemini-oauth',
          token: ref,
          identityId: 'legacy-gemini-session',
          managedProjectId: 'local-project',
        },
      },
    ]);

    await migrateSessionAuthState({ configStore: config, secretStore: secrets });

    const auth = migratedAuth(config);
    expect(auth).toEqual({
      method: 'google-gemini-oauth',
      bindingId: expect.any(String),
    });
    const bindingId = auth['bindingId'];
    if (typeof bindingId !== 'string') throw new Error('Missing binding ID.');
    const staticAuth = {
      method: 'google-gemini-oauth' as const,
      bindingId,
    };
    const hydrated = secrets.hydrateSessionAuth(
      geminiDescriptor,
      staticAuth,
    );
    const tokenRef = hydrated.token;
    expect(tokenRef).toBeTruthy();
    expect(await secrets.getOAuth2Token(tokenRef ?? '')).toMatchObject({
      accessToken: 'gemini-access',
    });
    expect(
      secrets.getLocalAuthContext(geminiDescriptor, staticAuth),
    ).toMatchObject({
      method: 'google-gemini-oauth',
      managedProjectId: 'local-project',
    });
  });

  it('cleans known session fields even when legacy auth is malformed', async () => {
    const storage = new MemorySecretStorage();
    const secrets = new SecretStore(storage);
    const config = new RawEndpointStore([
      {
        ...descriptor,
        name: 'Malformed OAuth',
        type: descriptor.providerType,
        models: [],
        auth: {
          method: 'oauth2',
          token: JSON.stringify(codexToken('must-not-sync')),
          identityId: 'legacy-session',
          email: 'must-not-sync@example.com',
          futureAuthOption: { untouched: true },
          oauth: {
            grantType: 'authorization_code',
            authorizationUrl: 'https://identity.example.test/authorize',
            tokenUrl: 42,
            clientId: 'client-id',
            clientSecret: 'must-not-sync',
            futureOAuthOption: 'untouched',
          },
        },
      },
    ]);

    await migrateSessionAuthState({ configStore: config, secretStore: secrets });

    const auth = migratedAuth(config);
    expect(auth).toMatchObject({
      method: 'oauth2',
      bindingId: expect.any(String),
      futureAuthOption: { untouched: true },
      oauth: {
        grantType: 'authorization_code',
        tokenUrl: 42,
        futureOAuthOption: 'untouched',
      },
    });
    expect(auth).not.toHaveProperty('token');
    expect(auth).not.toHaveProperty('identityId');
    expect(auth).not.toHaveProperty('email');
    expect(auth['oauth']).not.toHaveProperty('clientSecret');
    expect(secrets.getLocalAuthEnvelope(String(auth['bindingId']))).toBeUndefined();
  });

  it('derives the same binding while keeping device tokens isolated', async () => {
    const ref = createSecretRef();
    const storageA = new MemorySecretStorage();
    const storageB = new MemorySecretStorage();
    const secretsA = new SecretStore(storageA);
    const secretsB = new SecretStore(storageB);
    await secretsA.setOAuth2Token(ref, codexToken('device-a'));
    await secretsB.setOAuth2Token(ref, codexToken('device-b'));
    const configA = new RawEndpointStore([rawProvider(ref)]);
    const configB = new RawEndpointStore([rawProvider(ref)]);

    await Promise.all([
      migrateSessionAuthState({ configStore: configA, secretStore: secretsA }),
      migrateSessionAuthState({ configStore: configB, secretStore: secretsB }),
    ]);

    const bindingA = migratedAuth(configA)['bindingId'];
    const bindingB = migratedAuth(configB)['bindingId'];
    expect(bindingA).toBe(bindingB);
    const legacyAuth: OpenAICodexAuthConfig = {
      method: 'openai-codex',
      bindingId: '',
      token: ref,
      identityId: 'legacy-session',
      accountId: 'synced-account',
      email: 'synced@example.com',
    };
    expect(bindingA).toBe(deriveLegacyAuthBindingId(descriptor, legacyAuth));
    if (typeof bindingA !== 'string') throw new Error('Missing binding ID.');
    const staticAuth = { method: 'openai-codex' as const, bindingId: bindingA };
    const runtimeA = secretsA.hydrateSessionAuth(descriptor, staticAuth);
    const runtimeB = secretsB.hydrateSessionAuth(descriptor, staticAuth);
    expect(await secretsA.getOAuth2Token(runtimeA.token ?? '')).toEqual(
      codexToken('device-a'),
    );
    expect(await secretsB.getOAuth2Token(runtimeB.token ?? '')).toEqual(
      codexToken('device-b'),
    );
  });

  it('never lets synced legacy fields overwrite an existing local envelope', async () => {
    const storage = new MemorySecretStorage();
    const secrets = new SecretStore(storage);
    const bindingId = '00000000-0000-4000-8000-000000000233';
    await secrets.persistSessionAuth(
      descriptor,
      {
        method: 'openai-codex',
        bindingId,
        token: JSON.stringify(codexToken('local-account')),
        accountId: 'local-account',
        email: 'local-account@example.com',
      },
      {
        reason: 'login',
        emptyToken: 'clear',
        binding: 'existing-or-random',
      },
    );
    const syncedRef = createSecretRef();
    await secrets.setOAuth2Token(syncedRef, codexToken('synced-account'));
    const synced = rawProvider(syncedRef);
    const syncedAuth = synced['auth'];
    if (
      !syncedAuth ||
      typeof syncedAuth !== 'object' ||
      Array.isArray(syncedAuth)
    ) {
      throw new Error('Expected synced auth.');
    }
    (syncedAuth as Record<string, unknown>)['bindingId'] = bindingId;
    const config = new RawEndpointStore([synced]);

    await migrateSessionAuthState({ configStore: config, secretStore: secrets });

    expect(migratedAuth(config)).toEqual({
      method: 'openai-codex',
      bindingId,
    });
    const staticAuth = { method: 'openai-codex' as const, bindingId };
    const runtime = secrets.hydrateSessionAuth(descriptor, staticAuth);
    expect(await secrets.getOAuth2Token(runtime.token ?? '')).toEqual(
      codexToken('local-account'),
    );
    expect(secrets.getLocalAuthContext(descriptor, staticAuth)).toMatchObject({
      accountId: 'local-account',
      email: 'local-account@example.com',
    });
  });

  it('migrates a locally resolvable token into a new static fingerprint snapshot', async () => {
    const storage = new MemorySecretStorage();
    const secrets = new SecretStore(storage);
    const bindingId = '00000000-0000-4000-8000-000000000235';
    await secrets.persistSessionAuth(
      descriptor,
      {
        method: 'openai-codex',
        bindingId,
        token: JSON.stringify(codexToken('old-fingerprint')),
        accountId: 'old-fingerprint',
      },
      {
        reason: 'login',
        emptyToken: 'clear',
        binding: 'existing-or-random',
      },
    );

    const newDescriptor: AuthBindingDescriptor = {
      ...descriptor,
      baseUrl: 'https://proxy.example.test/v1',
    };
    const ref = createSecretRef();
    const newToken = codexToken('new-fingerprint');
    await secrets.setOAuth2Token(ref, newToken);
    const endpoint = rawProvider(ref);
    endpoint['baseUrl'] = newDescriptor.baseUrl;
    const rawAuth = endpoint['auth'];
    if (!rawAuth || typeof rawAuth !== 'object' || Array.isArray(rawAuth)) {
      throw new Error('Expected raw auth.');
    }
    (rawAuth as Record<string, unknown>)['bindingId'] = bindingId;
    const config = new RawEndpointStore([endpoint]);

    await migrateSessionAuthState({ configStore: config, secretStore: secrets });

    const staticAuth = { method: 'openai-codex' as const, bindingId };
    const runtime = secrets.hydrateSessionAuth(newDescriptor, staticAuth);
    expect(await secrets.getOAuth2Token(runtime.token ?? '')).toEqual(newToken);
    expect(secrets.getLocalAuthEnvelope(bindingId)?.snapshots).toHaveLength(2);
    expect(migratedAuth(config)).toEqual(staticAuth);
  });

  it('keeps a valid OAuth client secret when the legacy token is missing', async () => {
    const storage = new MemorySecretStorage();
    const secrets = new SecretStore(storage);
    const missingTokenRef = createSecretRef();
    const clientSecretRef = createSecretRef();
    await secrets.setOAuth2ClientSecret(clientSecretRef, 'local-client-secret');
    const oauthDescriptor: AuthBindingDescriptor = {
      providerName: 'OAuth',
      providerType: 'openai-chat-completion',
      baseUrl: 'https://example.test/v1',
    };
    const config = new RawEndpointStore([
      {
        ...oauthDescriptor,
        name: oauthDescriptor.providerName,
        type: oauthDescriptor.providerType,
        models: [],
        auth: {
          method: 'oauth2',
          token: missingTokenRef,
          identityId: 'missing-session',
          oauth: {
            grantType: 'authorization_code',
            authorizationUrl: 'https://identity.example.test/authorize',
            tokenUrl: 'https://identity.example.test/token',
            clientId: 'client-id',
            clientSecret: clientSecretRef,
          },
        },
      },
    ]);

    await migrateSessionAuthState({ configStore: config, secretStore: secrets });

    const authRecord = migratedAuth(config);
    expect(authRecord).not.toHaveProperty('token');
    expect(JSON.stringify(authRecord)).not.toContain('clientSecret');
    const bindingId = authRecord['bindingId'];
    if (typeof bindingId !== 'string') throw new Error('Missing binding ID.');
    const staticAuth: OAuth2AuthConfig = {
      method: 'oauth2',
      bindingId,
      oauth: {
        grantType: 'authorization_code',
        authorizationUrl: 'https://identity.example.test/authorize',
        tokenUrl: 'https://identity.example.test/token',
        clientId: 'client-id',
      },
    };
    const runtime = secrets.hydrateSessionAuth(oauthDescriptor, staticAuth);
    if (
      runtime.method !== 'oauth2' ||
      runtime.oauth.grantType !== 'authorization_code'
    ) {
      throw new Error('Expected authorization-code OAuth.');
    }
    expect(await secrets.getOAuth2Token(runtime.token ?? '')).toBeNull();
    expect(
      await secrets.getOAuth2ClientSecret(runtime.oauth.clientSecret ?? ''),
    ).toBe('local-client-secret');
    const legacyClientSecretKey =
      buildOAuth2ClientSecretStorageKey(clientSecretRef);
    expect(
      legacyClientSecretKey
        ? storage.values.has(legacyClientSecretKey)
        : false,
    ).toBe(true);
  });

  it('recovers only a unique client-credentials secret after static auth sync', async () => {
    const oauthDescriptor: AuthBindingDescriptor = {
      providerName: 'OAuth Client Credentials',
      providerType: 'openai-chat-completion',
      baseUrl: 'https://example.test/v1',
    };
    const bindingId = '00000000-0000-4000-8000-000000000234';
    const staticEndpoint = {
      ...oauthDescriptor,
      name: oauthDescriptor.providerName,
      type: oauthDescriptor.providerType,
      models: [],
      auth: {
        method: 'oauth2',
        bindingId,
        oauth: {
          grantType: 'client_credentials',
          tokenUrl: 'https://identity.example.test/token',
          clientId: 'client-id',
          scopes: ['models.read'],
        },
      },
    };

    const uniqueStorage = new MemorySecretStorage();
    const uniqueSecrets = new SecretStore(uniqueStorage);
    const uniqueRef = createSecretRef();
    await uniqueSecrets.setOAuth2ClientSecret(uniqueRef, 'device-secret');
    const uniqueConfig = new RawEndpointStore([staticEndpoint]);

    await migrateSessionAuthState({
      configStore: uniqueConfig,
      secretStore: uniqueSecrets,
    });

    const staticAuth: OAuth2AuthConfig = {
      method: 'oauth2',
      bindingId,
      oauth: {
        grantType: 'client_credentials',
        tokenUrl: 'https://identity.example.test/token',
        clientId: 'client-id',
        scopes: ['models.read'],
      },
    };
    const runtime = uniqueSecrets.hydrateSessionAuth(
      oauthDescriptor,
      staticAuth,
    );
    if (
      runtime.method !== 'oauth2' ||
      runtime.oauth.grantType !== 'client_credentials'
    ) {
      throw new Error('Expected client-credentials OAuth.');
    }
    expect(
      await uniqueSecrets.getOAuth2ClientSecret(
        runtime.oauth.clientSecret ?? '',
      ),
    ).toBe('device-secret');

    const ambiguousStorage = new MemorySecretStorage();
    const ambiguousSecrets = new SecretStore(ambiguousStorage);
    const first = createSecretRef();
    const second = createSecretRef();
    await ambiguousSecrets.setOAuth2ClientSecret(first, 'first-secret');
    await ambiguousSecrets.setOAuth2ClientSecret(second, 'second-secret');
    const ambiguousConfig = new RawEndpointStore([staticEndpoint]);

    await migrateSessionAuthState({
      configStore: ambiguousConfig,
      secretStore: ambiguousSecrets,
    });

    expect(ambiguousSecrets.getLocalAuthEnvelope(bindingId)).toBeUndefined();
    expect(await ambiguousSecrets.getOAuth2ClientSecret(first)).toBe(
      'first-secret',
    );
    expect(await ambiguousSecrets.getOAuth2ClientSecret(second)).toBe(
      'second-secret',
    );
  });

  it('recovers one provable Codex orphan and ignores ambiguous candidates', async () => {
    const missingRef = createSecretRef();
    const uniqueStorage = new MemorySecretStorage();
    const uniqueSecrets = new SecretStore(uniqueStorage);
    const uniqueOrphan = createSecretRef();
    await uniqueSecrets.setOAuth2Token(uniqueOrphan, codexToken('recovered'));
    const uniqueConfig = new RawEndpointStore([rawProvider(missingRef)]);

    await migrateSessionAuthState({
      configStore: uniqueConfig,
      secretStore: uniqueSecrets,
    });
    const uniqueBinding = migratedAuth(uniqueConfig)['bindingId'];
    if (typeof uniqueBinding !== 'string') throw new Error('Missing binding ID.');
    expect(
      uniqueSecrets.getLocalAuthContext(descriptor, {
        method: 'openai-codex',
        bindingId: uniqueBinding,
      }),
    ).toMatchObject({
      accountId: 'recovered',
      email: 'recovered@example.com',
    });
    const recoveredKey = buildOAuth2TokenStorageKey(uniqueOrphan);
    expect(recoveredKey ? uniqueStorage.values.has(recoveredKey) : false).toBe(
      true,
    );

    const ambiguousStorage = new MemorySecretStorage();
    const ambiguousSecrets = new SecretStore(ambiguousStorage);
    const first = createSecretRef();
    const second = createSecretRef();
    await ambiguousSecrets.setOAuth2Token(first, codexToken('first'));
    await ambiguousSecrets.setOAuth2Token(second, codexToken('second'));
    const ambiguousConfig = new RawEndpointStore([rawProvider(missingRef)]);
    await migrateSessionAuthState({
      configStore: ambiguousConfig,
      secretStore: ambiguousSecrets,
    });
    const ambiguousBinding = migratedAuth(ambiguousConfig)['bindingId'];
    if (typeof ambiguousBinding !== 'string') {
      throw new Error('Missing binding ID.');
    }
    expect(
      ambiguousSecrets.getLocalAuthContext(descriptor, {
        method: 'openai-codex',
        bindingId: ambiguousBinding,
      }),
    ).toBeUndefined();
    expect(await ambiguousSecrets.getOAuth2Token(first)).toEqual(
      codexToken('first'),
    );
    expect(await ambiguousSecrets.getOAuth2Token(second)).toEqual(
      codexToken('second'),
    );
  });

  it('does not assign one Codex orphan to an ambiguous missing provider', async () => {
    const storage = new MemorySecretStorage();
    const secrets = new SecretStore(storage);
    const orphan = createSecretRef();
    await secrets.setOAuth2Token(orphan, codexToken('unassigned'));
    const first = rawProvider(createSecretRef());
    const second = rawProvider(createSecretRef());
    second['name'] = 'Codex 2';
    const config = new RawEndpointStore([first, second]);

    await migrateSessionAuthState({ configStore: config, secretStore: secrets });

    for (const endpoint of config.rawEndpoints) {
      if (!endpoint || typeof endpoint !== 'object' || Array.isArray(endpoint)) {
        throw new Error('Expected migrated provider.');
      }
      const record = endpoint as Record<string, unknown>;
      const auth = record['auth'];
      if (!auth || typeof auth !== 'object' || Array.isArray(auth)) {
        throw new Error('Expected migrated auth.');
      }
      const bindingId = (auth as Record<string, unknown>)['bindingId'];
      if (typeof bindingId !== 'string') throw new Error('Missing binding ID.');
      expect(
        secrets.getLocalAuthContext(
          {
            providerName: String(record['name']),
            providerType: descriptor.providerType,
            baseUrl: descriptor.baseUrl,
          },
          { method: 'openai-codex', bindingId },
        ),
      ).toBeUndefined();
    }
    expect(await secrets.getOAuth2Token(orphan)).toEqual(
      codexToken('unassigned'),
    );
  });
});

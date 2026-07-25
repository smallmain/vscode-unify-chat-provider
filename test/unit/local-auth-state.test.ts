import type * as vscode from 'vscode';
import { describe, expect, it, vi } from 'vitest';

const vscodeWindow = vi.hoisted(() => ({
  showQuickPick: vi.fn(async (items: unknown) =>
    Array.isArray(items) ? items[0] : undefined,
  ),
  showInformationMessage: vi.fn(),
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
  class ThemeIcon {
    constructor(readonly id: string) {}
  }
  return {
    Disposable,
    EventEmitter,
    ThemeIcon,
    env: { language: 'en' },
    l10n: { t: (message: string) => message },
    window: vscodeWindow,
  };
});

vi.mock('../../src/logger', () => ({
  authLog: {
    error: vi.fn(),
    verbose: vi.fn(),
    warn: vi.fn(),
  },
}));

import {
  assertValidInlineSessionAuthToken,
  buildLocalAuthRef,
  computeStaticAuthFingerprint,
  discardMismatchedLocalSessionState,
  deriveLegacyAuthBindingId,
  isValidAuthBindingId,
  LOCAL_AUTH_STATE_KEY_PREFIX,
  parseAuthContext,
  parseLocalAuthStateEnvelope,
  renewSessionAuthBinding,
  stripSessionAuthState,
  type AuthBindingDescriptor,
} from '../../src/auth/local-auth-state';
import { resolveProviderForExportOrShowError } from '../../src/auth/auth-transfer';
import { createAuthProvider } from '../../src/auth/create-auth-provider';
import { OpenAICodexAuthProvider } from '../../src/auth/providers/openai-codex';
import { OAuth2AuthProvider } from '../../src/auth/providers/oauth2';
import type {
  OpenAICodexAuthConfig,
  OAuth2AuthConfig,
  OAuth2TokenData,
  SessionAuthRuntimeConfig,
} from '../../src/auth/types';
import type { ProviderConfig } from '../../src/types';
import {
  buildOAuth2ClientSecretStorageKey,
  buildOAuth2TokenStorageKey,
  extractUuidFromRef,
  isLocalAuthRef,
  isSecretRef,
  isSessionSecretRef,
  ORPHAN_SECRET_RETENTION_MS,
} from '../../src/secret/constants';
import { SecretStore } from '../../src/secret/secret-store';

const BINDING_ID = '00000000-0000-4000-8000-000000000201';

class MemorySecretStorage implements vscode.SecretStorage {
  readonly values = new Map<string, string>();
  beforeGet?: (key: string) => void | Promise<void>;
  beforeStore?: (key: string, value: string) => void | Promise<void>;
  afterStore?: (key: string, value: string) => void | Promise<void>;
  beforeDelete?: (key: string) => void | Promise<void>;
  readonly onDidChange: vscode.Event<vscode.SecretStorageChangeEvent> = () => ({
    dispose: () => undefined,
  });

  async keys(): Promise<string[]> {
    return Array.from(this.values.keys());
  }

  async get(key: string): Promise<string | undefined> {
    const value = this.values.get(key);
    await this.beforeGet?.(key);
    return value;
  }

  async store(key: string, value: string): Promise<void> {
    await this.beforeStore?.(key, value);
    this.values.set(key, value);
    await this.afterStore?.(key, value);
  }

  async delete(key: string): Promise<void> {
    await this.beforeDelete?.(key);
    this.values.delete(key);
  }
}

function findAuthEnvelopeKey(
  storage: MemorySecretStorage,
  bindingId = BINDING_ID,
): string | undefined {
  return Array.from(storage.values.keys()).find(
    (key) =>
      key.includes(LOCAL_AUTH_STATE_KEY_PREFIX) && key.endsWith(bindingId),
  );
}

const descriptor: AuthBindingDescriptor = {
  providerName: 'Codex',
  providerType: 'openai-responses',
  baseUrl: 'https://api.openai.com/v1',
};

function codexAuth(
  overrides: Partial<OpenAICodexAuthConfig> = {},
): OpenAICodexAuthConfig {
  return {
    method: 'openai-codex',
    bindingId: BINDING_ID,
    ...overrides,
  };
}

function token(value: string): OAuth2TokenData {
  return {
    accessToken: `${value}-access`,
    refreshToken: `${value}-refresh`,
    tokenType: 'Bearer',
    expiresAt: 4_102_444_800_000,
  };
}

function jwt(payload: Record<string, unknown>): string {
  return [
    Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString(
      'base64url',
    ),
    Buffer.from(JSON.stringify(payload)).toString('base64url'),
    'signature',
  ].join('.');
}

function withToken(
  value: string,
  accountId: string,
): OpenAICodexAuthConfig {
  return codexAuth({
    token: JSON.stringify(token(value)),
    accountId,
    email: `${accountId}@example.com`,
  });
}

describe('local auth state contract', () => {
  it('derives stable bindings and fingerprints only static auth inputs', () => {
    const legacy = codexAuth({
      bindingId: '',
      token: JSON.stringify(token('legacy')),
      accountId: 'account-a',
      label: 'First label',
    });
    const first = deriveLegacyAuthBindingId(descriptor, legacy);
    const otherLegacy: OpenAICodexAuthConfig = {
      ...legacy,
      token: JSON.stringify(token('other-device')),
      accountId: 'account-b',
      label: 'Other label',
    };
    const second = deriveLegacyAuthBindingId(descriptor, otherLegacy);
    expect(second).toBe(first);
    expect(
      deriveLegacyAuthBindingId(
        { ...descriptor, providerName: 'Renamed before migration' },
        legacy,
      ),
    ).not.toBe(first);

    const fingerprint = computeStaticAuthFingerprint(descriptor, legacy);
    const changedRuntime: OpenAICodexAuthConfig = {
      ...legacy,
      bindingId: '00000000-0000-4000-8000-000000000202',
      token: JSON.stringify(token('changed')),
      accountId: 'changed',
      email: 'changed@example.com',
    };
    expect(
      computeStaticAuthFingerprint(descriptor, changedRuntime),
    ).toBe(fingerprint);
    expect(stripSessionAuthState(legacy)).not.toHaveProperty('token');
    expect(stripSessionAuthState(legacy)).not.toHaveProperty('accountId');

    const geminiDescriptor = {
      providerName: 'Gemini',
      providerType: 'google-gemini-cli',
      baseUrl: 'https://cloudcode-pa.googleapis.com',
    };
    const geminiDefault: SessionAuthRuntimeConfig = {
      method: 'google-gemini-oauth',
      bindingId: BINDING_ID,
    };
    const geminiCodeAssist: SessionAuthRuntimeConfig = {
      ...geminiDefault,
      oauthType: 'code_assist',
    };
    expect(
      computeStaticAuthFingerprint(geminiDescriptor, geminiDefault),
    ).toBe(
      computeStaticAuthFingerprint(geminiDescriptor, geminiCodeAssist),
    );
  });

  it('treats raw URL mode and the exact raw URL as static auth identity', () => {
    const auth = codexAuth();
    const normalized = {
      ...descriptor,
      baseUrl: 'https://api.openai.com/v1?tenant=a',
    };
    const rawA = { ...normalized, useRawBaseUrl: true };
    const rawB = {
      ...rawA,
      baseUrl: 'https://api.openai.com/v1?tenant=b',
    };

    expect(computeStaticAuthFingerprint(normalized, auth)).toBe(
      computeStaticAuthFingerprint(descriptor, auth),
    );
    expect(computeStaticAuthFingerprint(rawA, auth)).not.toBe(
      computeStaticAuthFingerprint(normalized, auth),
    );
    expect(computeStaticAuthFingerprint(rawB, auth)).not.toBe(
      computeStaticAuthFingerprint(rawA, auth),
    );
    expect(deriveLegacyAuthBindingId(rawB, auth)).not.toBe(
      deriveLegacyAuthBindingId(rawA, auth),
    );
  });

  it('generates a fresh binding for each imported new provider', () => {
    const first = renewSessionAuthBinding(codexAuth());
    const second = renewSessionAuthBinding(codexAuth());
    if (
      first.method !== 'openai-codex' ||
      second.method !== 'openai-codex'
    ) {
      throw new Error('Expected Codex auth.');
    }
    expect(isValidAuthBindingId(first.bindingId)).toBe(true);
    expect(first.bindingId).not.toBe(BINDING_ID);
    expect(second.bindingId).not.toBe(first.bindingId);
  });

  it('strictly rejects malformed envelopes and recognizes local references', () => {
    const ref = buildLocalAuthRef(BINDING_ID, 'a'.repeat(64));
    expect(isSecretRef(ref)).toBe(false);
    expect(isSessionSecretRef(ref)).toBe(true);
    expect(isLocalAuthRef(ref)).toBe(true);
    expect(extractUuidFromRef(ref)).toBeNull();

    expect(
      parseLocalAuthStateEnvelope({
        version: 1,
        bindingId: BINDING_ID,
        revision: 1,
        snapshots: [
          {
            method: 'openai-codex',
            staticConfigFingerprint: 'a'.repeat(64),
            epoch: 1,
            sessionId: 'session-a',
            token: token('a'),
            authContext: {
              method: 'openai-codex',
              bindingId: BINDING_ID,
              sessionId: 'different-session',
              revision: 1,
            },
            createdAt: 1,
            updatedAt: 1,
          },
        ],
      }),
    ).toBeNull();
  });

  it('strictly parses each AuthContext branch and rejects foreign fields', () => {
    const common = {
      bindingId: BINDING_ID,
      sessionId: 'session-a',
      revision: 1,
    };
    const validContexts = [
      { method: 'oauth2', ...common },
      {
        method: 'antigravity-oauth',
        ...common,
        projectId: 'project-a',
        tier: 'paid',
        email: 'a@example.test',
      },
      {
        method: 'google-gemini-oauth',
        ...common,
        managedProjectId: 'managed-a',
        tierId: 'tier-a',
      },
      {
        method: 'openai-codex',
        ...common,
        accountId: 'account-a',
        email: 'a@example.test',
      },
      { method: 'claude-code', ...common, email: 'a@example.test' },
      { method: 'xai-grok-oauth', ...common, email: 'a@example.test' },
      { method: 'github-copilot', ...common },
      {
        method: 'zed',
        ...common,
        organizationId: 'organization-a',
        dataCollection: true,
        dataCollectionAllowed: true,
        email: 'a@example.test',
      },
    ] as const;

    for (const context of validContexts) {
      const parsed = parseAuthContext(context);
      expect(parsed).toEqual(context);
      expect(Object.isFrozen(parsed)).toBe(true);
    }

    const foreignFields = [
      { method: 'oauth2', ...common, email: 'foreign@example.test' },
      {
        method: 'antigravity-oauth',
        ...common,
        accountId: 'foreign-account',
      },
      {
        method: 'google-gemini-oauth',
        ...common,
        organizationId: 'foreign-organization',
      },
      {
        method: 'openai-codex',
        ...common,
        projectId: 'foreign-project',
      },
      { method: 'claude-code', ...common, accountId: 'foreign-account' },
      { method: 'xai-grok-oauth', ...common, tier: 'free' },
      {
        method: 'github-copilot',
        ...common,
        email: 'foreign@example.test',
      },
      {
        method: 'zed',
        ...common,
        organizationId: 'organization-a',
        dataCollection: false,
        dataCollectionAllowed: false,
        projectId: 'foreign-project',
      },
    ] as const;

    for (const context of foreignFields) {
      expect(parseAuthContext(context)).toBeNull();
    }
    expect(
      parseAuthContext({
        method: 'openai-codex',
        ...common,
        unexpected: undefined,
      }),
    ).toBeNull();
  });

  it('treats a local-auth-shaped API key as a literal API key', async () => {
    const store = new SecretStore(new MemorySecretStorage());
    const value = buildLocalAuthRef(BINDING_ID, 'a'.repeat(64));
    await expect(store.getApiKeyStatus(value)).resolves.toEqual({
      kind: 'plain',
      apiKey: value,
    });
  });

  it('rejects malformed inline session tokens without rejecting local references', () => {
    expect(() =>
      assertValidInlineSessionAuthToken(
        codexAuth({ token: JSON.stringify({ accessToken: 'missing-type' }) }),
      ),
    ).toThrow('Invalid authentication token data.');
    expect(() =>
      assertValidInlineSessionAuthToken(codexAuth({ token: '{invalid-json' })),
    ).toThrow('Invalid authentication token data.');
    expect(() =>
      assertValidInlineSessionAuthToken(
        codexAuth({ token: buildLocalAuthRef(BINDING_ID, 'a'.repeat(64)) }),
      ),
    ).not.toThrow();
    expect(() => assertValidInlineSessionAuthToken(codexAuth())).not.toThrow();
  });

  it('does not carry a local session reference across static fingerprints', () => {
    const original = codexAuth();
    const originalRef = buildLocalAuthRef(
      BINDING_ID,
      computeStaticAuthFingerprint(descriptor, original),
    );
    const runtime = codexAuth({
      identityId: 'old-session',
      token: originalRef,
      accountId: 'old-account',
    });

    expect(discardMismatchedLocalSessionState(descriptor, runtime)).toEqual(
      runtime,
    );
    expect(
      discardMismatchedLocalSessionState(
        { ...descriptor, baseUrl: 'https://other.example/v1' },
        runtime,
      ),
    ).toEqual({ method: 'openai-codex', bindingId: BINDING_ID });
  });

  it('reduces every session method to synchronized static fields', () => {
    const shared = {
      bindingId: BINDING_ID,
      token: JSON.stringify(token('secret')),
      identityId: 'session-secret',
    };
    const cases: Array<{
      auth: SessionAuthRuntimeConfig;
      expected: Record<string, unknown>;
    }> = [
      {
        auth: {
          method: 'oauth2',
          ...shared,
          oauth: {
            grantType: 'authorization_code',
            authorizationUrl: 'https://example.test/authorize',
            tokenUrl: 'https://example.test/token',
            clientId: 'public-client',
            clientSecret: 'private-client-secret',
            scopes: ['scope-a'],
          },
        },
        expected: {
          method: 'oauth2',
          bindingId: BINDING_ID,
          oauth: {
            grantType: 'authorization_code',
            authorizationUrl: 'https://example.test/authorize',
            tokenUrl: 'https://example.test/token',
            clientId: 'public-client',
            scopes: ['scope-a'],
          },
        },
      },
      {
        auth: {
          method: 'oauth2',
          ...shared,
          oauth: {
            grantType: 'client_credentials',
            tokenUrl: 'https://example.test/token',
            clientId: 'service-client',
            clientSecret: 'private-client-secret',
            scopes: ['scope-b'],
          },
        },
        expected: {
          method: 'oauth2',
          bindingId: BINDING_ID,
          oauth: {
            grantType: 'client_credentials',
            tokenUrl: 'https://example.test/token',
            clientId: 'service-client',
            scopes: ['scope-b'],
          },
        },
      },
      {
        auth: {
          method: 'oauth2',
          ...shared,
          oauth: {
            grantType: 'device_code',
            deviceAuthorizationUrl: 'https://example.test/device',
            tokenUrl: 'https://example.test/token',
            clientId: 'device-client',
            scopes: ['scope-c'],
          },
        },
        expected: {
          method: 'oauth2',
          bindingId: BINDING_ID,
          oauth: {
            grantType: 'device_code',
            deviceAuthorizationUrl: 'https://example.test/device',
            tokenUrl: 'https://example.test/token',
            clientId: 'device-client',
            scopes: ['scope-c'],
          },
        },
      },
      {
        auth: {
          method: 'antigravity-oauth',
          ...shared,
          projectId: 'project',
          email: 'secret@example.com',
        },
        expected: { method: 'antigravity-oauth', bindingId: BINDING_ID },
      },
      {
        auth: {
          method: 'google-gemini-oauth',
          ...shared,
          oauthType: 'google_one',
          managedProjectId: 'managed-project',
        },
        expected: {
          method: 'google-gemini-oauth',
          bindingId: BINDING_ID,
          oauthType: 'google_one',
        },
      },
      {
        auth: { method: 'openai-codex', ...shared, accountId: 'account' },
        expected: { method: 'openai-codex', bindingId: BINDING_ID },
      },
      {
        auth: { method: 'claude-code', ...shared, email: 'secret@example.com' },
        expected: { method: 'claude-code', bindingId: BINDING_ID },
      },
      {
        auth: { method: 'xai-grok-oauth', ...shared, email: 'secret@example.com' },
        expected: { method: 'xai-grok-oauth', bindingId: BINDING_ID },
      },
      {
        auth: {
          method: 'github-copilot',
          ...shared,
          enterpriseUrl: 'github.example.com',
        },
        expected: {
          method: 'github-copilot',
          bindingId: BINDING_ID,
          enterpriseUrl: 'github.example.com',
        },
      },
      {
        auth: {
          method: 'zed',
          ...shared,
          baseUrl: 'https://zed.dev',
          organizationId: 'org',
          dataCollection: true,
          dataCollectionAllowed: true,
          email: 'secret@example.com',
        },
        expected: {
          method: 'zed',
          bindingId: BINDING_ID,
          baseUrl: 'https://zed.dev',
        },
      },
    ];

    for (const entry of cases) {
      const serialized: unknown = JSON.parse(
        JSON.stringify(stripSessionAuthState(entry.auth)),
      );
      expect(serialized).toEqual(entry.expected);
    }
  });

  it('keeps pending OAuth token and client secret in memory until envelope commit', async () => {
    const storage = new MemorySecretStorage();
    const store = new SecretStore(storage);
    const tokenRef = store.createTransientOAuth2TokenRef();
    const clientSecretRef = store.createTransientOAuth2ClientSecretRef();
    await store.setOAuth2Token(tokenRef, token('staged'));
    await store.setOAuth2ClientSecret(clientSecretRef, 'staged-client-secret');

    const legacyTokenKey = buildOAuth2TokenStorageKey(tokenRef);
    const legacyClientSecretKey =
      buildOAuth2ClientSecretStorageKey(clientSecretRef);
    if (!legacyTokenKey || !legacyClientSecretKey) {
      throw new Error('Expected valid transient references.');
    }
    expect(storage.values.has(legacyTokenKey)).toBe(false);
    expect(storage.values.has(legacyClientSecretKey)).toBe(false);

    const oauthDescriptor: AuthBindingDescriptor = {
      providerName: 'Generic OAuth',
      providerType: 'openai-chat-completion',
      baseUrl: 'https://example.test/v1',
    };
    const persisted = await store.persistSessionAuth(
      oauthDescriptor,
      {
        method: 'oauth2',
        bindingId: BINDING_ID,
        identityId: 'staged-login',
        token: tokenRef,
        oauth: {
          grantType: 'client_credentials',
          tokenUrl: 'https://example.test/token',
          clientId: 'client-id',
          clientSecret: clientSecretRef,
        },
      },
      {
        reason: 'login',
        emptyToken: 'clear',
        binding: 'existing-or-random',
      },
    );

    expect(persisted).not.toHaveProperty('token');
    if (
      persisted.method !== 'oauth2' ||
      persisted.oauth.grantType !== 'client_credentials'
    ) {
      throw new Error('Expected client-credentials OAuth auth.');
    }
    expect(persisted.oauth).not.toHaveProperty('clientSecret');
    expect(storage.values.has(legacyTokenKey)).toBe(false);
    expect(storage.values.has(legacyClientSecretKey)).toBe(false);
    const runtime = store.hydrateSessionAuth(oauthDescriptor, persisted);
    if (
      runtime.method !== 'oauth2' ||
      runtime.oauth.grantType !== 'client_credentials'
    ) {
      throw new Error('Expected client-credentials OAuth auth.');
    }
    expect(runtime.identityId).toBe('staged-login');
    expect(
      store.getLocalAuthContext(oauthDescriptor, persisted),
    ).toMatchObject({ sessionId: 'staged-login' });
    expect(await store.getOAuth2Token(runtime.token ?? '')).toEqual(
      token('staged'),
    );
    expect(
      await store.getOAuth2ClientSecret(runtime.oauth.clientSecret ?? ''),
    ).toBe('staged-client-secret');
  });

  it('duplicates a generic OAuth app secret without duplicating its user session', async () => {
    const store = new SecretStore(new MemorySecretStorage());
    const oauthDescriptor: AuthBindingDescriptor = {
      providerName: 'Generic OAuth',
      providerType: 'openai-chat-completion',
      baseUrl: 'https://example.test/v1',
    };
    const original = await store.persistSessionAuth(
      oauthDescriptor,
      {
        method: 'oauth2',
        bindingId: BINDING_ID,
        identityId: 'original-session',
        token: JSON.stringify(token('original-access')),
        oauth: {
          grantType: 'client_credentials',
          tokenUrl: 'https://example.test/token',
          clientId: 'client-id',
          clientSecret: 'app-client-secret',
        },
      },
      {
        reason: 'login',
        emptyToken: 'clear',
        binding: 'existing-or-random',
      },
    );
    const hydrated = store.hydrateSessionAuth(oauthDescriptor, original);
    if (hydrated.method !== 'oauth2') {
      throw new Error('Expected generic OAuth auth.');
    }
    const materialized = await store.prepareSessionAuthCommitIntent(
      oauthDescriptor,
      hydrated,
    );
    if (materialized.method !== 'oauth2') {
      throw new Error('Expected materialized generic OAuth auth.');
    }
    const prepared = await OAuth2AuthProvider.prepareForDuplicate(
      materialized,
      { secretStore: store, storeSecretsInSettings: false },
    );
    const rebound = renewSessionAuthBinding(prepared);
    if (rebound.method !== 'oauth2') {
      throw new Error('Expected duplicated generic OAuth auth.');
    }
    const duplicateDescriptor = {
      ...oauthDescriptor,
      providerName: 'Generic OAuth (copy)',
    };
    const duplicate = await store.persistSessionAuth(
      duplicateDescriptor,
      rebound,
      {
        reason: 'import',
        emptyToken: 'preserve',
        binding: 'existing-or-random',
      },
    );
    const duplicateRuntime = store.hydrateSessionAuth(
      duplicateDescriptor,
      duplicate,
    );
    if (
      duplicateRuntime.method !== 'oauth2' ||
      duplicateRuntime.oauth.grantType !== 'client_credentials'
    ) {
      throw new Error('Expected client-credentials OAuth duplicate.');
    }
    expect(duplicateRuntime.token).toBeUndefined();
    expect(
      await store.getOAuth2ClientSecret(
        duplicateRuntime.oauth.clientSecret ?? '',
      ),
    ).toBe('app-client-secret');
  });

  it('discards draft session writes without deleting preserved local state', async () => {
    const store = new SecretStore(new MemorySecretStorage());
    const persisted = await store.persistSessionAuth(
      descriptor,
      withToken('committed', 'account'),
      {
        reason: 'login',
        emptyToken: 'clear',
        binding: 'existing-or-random',
      },
    );
    const committed = store.hydrateSessionAuth(descriptor, persisted);
    if (committed.method !== 'openai-codex' || !committed.token) {
      throw new Error('Expected committed Codex auth.');
    }
    await store.deleteOAuth2Token(committed.token);
    expect(await store.getOAuth2Token(committed.token)).toBeNull();
    store.discardDraftSessionAuth(committed, committed);
    expect(await store.getOAuth2Token(committed.token)).toEqual(
      token('committed'),
    );

    const replacementRef = store.createTransientOAuth2TokenRef();
    await store.setOAuth2Token(replacementRef, token('replacement'));
    const replacement = { ...committed, token: replacementRef };
    store.discardDraftSessionAuth(replacement, committed);
    expect(await store.getOAuth2Token(replacementRef)).toBeNull();
    expect(await store.getOAuth2Token(committed.token)).toEqual(
      token('committed'),
    );
  });

  it('keeps a staged login usable and attaches its matching local context', async () => {
    const storage = new MemorySecretStorage();
    const store = new SecretStore(storage);
    const tokenRef = store.createTransientOAuth2TokenRef();
    await store.setOAuth2Token(tokenRef, token('draft'));
    const auth = codexAuth({
      identityId: 'draft-session',
      token: tokenRef,
      accountId: 'draft-account',
      email: 'draft@example.com',
    });

    expect(store.hydrateSessionAuth(descriptor, auth)).toEqual(auth);
    const provider = createAuthProvider(
      {
        providerId: descriptor.providerName,
        providerLabel: descriptor.providerName,
        providerType: descriptor.providerType,
        baseUrl: descriptor.baseUrl,
        secretStore: store,
      },
      auth,
    );
    if (!provider) throw new Error('Expected a Codex auth provider.');
    const credential = await provider.getCredential();

    expect(credential?.value).toBe('draft-access');
    expect(credential?.authContext).toMatchObject({
      method: 'openai-codex',
      bindingId: BINDING_ID,
      sessionId: 'draft-session',
      accountId: 'draft-account',
      email: 'draft@example.com',
    });
  });

  it('hands a follower transient reference over to the Leader envelope', async () => {
    const storage = new MemorySecretStorage();
    const follower = new SecretStore(storage);
    const leader = new SecretStore(storage);
    await follower.initializeLocalAuthState();
    await leader.initializeLocalAuthState();
    const tokenRef = follower.createTransientOAuth2TokenRef();
    await follower.setOAuth2Token(tokenRef, token('follower'));
    const auth = codexAuth({
      identityId: 'follower-login',
      token: tokenRef,
      accountId: 'follower-account',
    });
    const intent = await follower.prepareSessionAuthCommitIntent(
      descriptor,
      auth,
    );

    await leader.persistSessionAuth(descriptor, intent, {
      reason: 'login',
      emptyToken: 'clear',
      binding: 'existing-or-random',
    });
    await follower.reloadLocalAuthState(BINDING_ID);
    follower.clearPendingSessionAuth(descriptor, auth);

    expect(await follower.getOAuth2Token(tokenRef)).toEqual(token('follower'));
    const legacyKey = buildOAuth2TokenStorageKey(tokenRef);
    expect(legacyKey && storage.values.has(legacyKey)).toBe(false);
  });

  it('fails closed when a reloaded local envelope is malformed', async () => {
    const storage = new MemorySecretStorage();
    const store = new SecretStore(storage);
    await store.persistSessionAuth(
      descriptor,
      codexAuth({
        identityId: 'valid-session',
        token: JSON.stringify(token('valid')),
        accountId: 'valid-account',
      }),
      {
        reason: 'login',
        emptyToken: 'clear',
        binding: 'existing-or-random',
      },
    );
    const envelopeKey = findAuthEnvelopeKey(storage);
    if (!envelopeKey) throw new Error('Expected local auth envelope key.');
    storage.values.set(envelopeKey, '{"version":1,"invalid":true}');

    await store.reloadLocalAuthState(BINDING_ID);

    expect(store.getLocalAuthEnvelope(BINDING_ID)).toBeUndefined();
    expect(
      store.getLocalAuthContext(descriptor, codexAuth()),
    ).toBeUndefined();
  });

  it('keeps the prior session when SecretStorage fails before the atomic write', async () => {
    const storage = new MemorySecretStorage();
    const store = new SecretStore(storage);
    await store.persistSessionAuth(descriptor, withToken('old', 'account-old'), {
      reason: 'login',
      emptyToken: 'clear',
      binding: 'existing-or-random',
    });
    const envelopeKey = findAuthEnvelopeKey(storage);
    if (!envelopeKey) throw new Error('Expected local auth envelope key.');
    storage.beforeStore = (key) => {
      if (key !== envelopeKey) return;
      storage.beforeStore = undefined;
      throw new Error('write failed before commit');
    };

    await expect(
      store.persistSessionAuth(
        descriptor,
        withToken('rejected', 'account-rejected'),
        {
          reason: 'refresh',
          emptyToken: 'clear',
          binding: 'existing-or-random',
        },
      ),
    ).rejects.toThrow('write failed before commit');

    const reloaded = new SecretStore(storage);
    await reloaded.initializeLocalAuthState();
    expect(
      reloaded.getLocalAuthEnvelope(BINDING_ID)?.snapshots[0]?.token
        ?.accessToken,
    ).toBe('old-access');
  });

  it('accepts a SecretStorage write that succeeded before reporting an error', async () => {
    const storage = new MemorySecretStorage();
    const store = new SecretStore(storage);
    await store.persistSessionAuth(descriptor, withToken('old', 'account-old'), {
      reason: 'login',
      emptyToken: 'clear',
      binding: 'existing-or-random',
    });
    const envelopeKey = findAuthEnvelopeKey(storage);
    if (!envelopeKey) throw new Error('Expected local auth envelope key.');
    storage.afterStore = (key) => {
      if (key !== envelopeKey) return;
      storage.afterStore = undefined;
      throw new Error('write reported failure after commit');
    };

    await expect(
      store.persistSessionAuth(
        descriptor,
        withToken('committed', 'account-committed'),
        {
          reason: 'refresh',
          emptyToken: 'clear',
          binding: 'existing-or-random',
        },
      ),
    ).resolves.toMatchObject({
      method: 'openai-codex',
      bindingId: BINDING_ID,
    });

    const reloaded = new SecretStore(storage);
    await reloaded.initializeLocalAuthState();
    expect(
      reloaded.getLocalAuthEnvelope(BINDING_ID)?.snapshots[0]?.token
        ?.accessToken,
    ).toBe('committed-access');
  });

  it('does not let a delayed reload replace a newer binding revision', async () => {
    const storage = new MemorySecretStorage();
    const store = new SecretStore(storage);
    await store.persistSessionAuth(
      descriptor,
      withToken('before-reload', 'account'),
      {
        reason: 'login',
        emptyToken: 'clear',
        binding: 'existing-or-random',
      },
    );

    let releaseRead = (): void => undefined;
    let reportReadStarted = (): void => undefined;
    const readGate = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    const readStarted = new Promise<void>((resolve) => {
      reportReadStarted = resolve;
    });
    storage.beforeGet = async () => {
      storage.beforeGet = undefined;
      reportReadStarted();
      await readGate;
    };

    const reload = store.reloadLocalAuthState(BINDING_ID);
    await readStarted;
    const persist = store.persistSessionAuth(
      descriptor,
      withToken('after-reload', 'account'),
      {
        reason: 'refresh',
        emptyToken: 'clear',
        binding: 'existing-or-random',
      },
    );
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    releaseRead();
    await Promise.all([reload, persist]);

    const envelope = store.getLocalAuthEnvelope(BINDING_ID);
    expect(envelope?.revision).toBe(2);
    expect(envelope?.snapshots[0]?.token?.accessToken).toBe(
      'after-reload-access',
    );
  });

  it('serializes envelope deletion with a newer binding write', async () => {
    const storage = new MemorySecretStorage();
    const store = new SecretStore(storage);
    await store.persistSessionAuth(
      descriptor,
      withToken('before-delete', 'account'),
      {
        reason: 'login',
        emptyToken: 'clear',
        binding: 'existing-or-random',
      },
    );
    const envelopeKey = findAuthEnvelopeKey(storage);
    if (!envelopeKey) throw new Error('Expected local auth envelope key.');

    let releaseDelete = (): void => undefined;
    let reportDeleteStarted = (): void => undefined;
    const deleteGate = new Promise<void>((resolve) => {
      releaseDelete = resolve;
    });
    const deleteStarted = new Promise<void>((resolve) => {
      reportDeleteStarted = resolve;
    });
    storage.beforeStore = async (key, value) => {
      if (key !== envelopeKey || !value.includes('"snapshots":[]')) return;
      storage.beforeStore = undefined;
      reportDeleteStarted();
      await deleteGate;
    };

    const deletion = store.deleteByKey(envelopeKey);
    await deleteStarted;
    const persist = store.persistSessionAuth(
      descriptor,
      withToken('after-delete', 'account'),
      {
        reason: 'login',
        emptyToken: 'clear',
        binding: 'existing-or-random',
      },
    );
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    releaseDelete();
    await Promise.all([deletion, persist]);

    const envelope = store.getLocalAuthEnvelope(BINDING_ID);
    expect(envelope?.revision).toBe(3);
    expect(envelope?.snapshots[0]?.token?.accessToken).toBe(
      'after-delete-access',
    );
    expect(storage.values.has(envelopeKey)).toBe(true);
  });

  it('restores an envelope above a newer tombstone revision without reloading', async () => {
    const storage = new MemorySecretStorage();
    const store = new SecretStore(storage);
    const persisted = await store.persistSessionAuth(
      descriptor,
      withToken('before-gc-restore', 'restored-account'),
      {
        reason: 'login',
        emptyToken: 'clear',
        binding: 'existing-or-random',
      },
    );
    const envelopeKey = findAuthEnvelopeKey(storage);
    if (!envelopeKey) throw new Error('Expected local auth envelope key.');
    const backup = storage.values.get(envelopeKey);
    if (!backup) throw new Error('Expected local auth envelope backup.');

    await store.deleteByKey(envelopeKey);
    await store.restoreOwnedSecretByKey(envelopeKey, backup);

    const envelope = store.getLocalAuthEnvelope(BINDING_ID);
    expect(envelope?.revision).toBe(3);
    expect(envelope?.snapshots[0]?.token?.accessToken).toBe(
      'before-gc-restore-access',
    );
    expect(store.getLocalAuthContext(descriptor, persisted)).toMatchObject({
      accountId: 'restored-account',
      revision: 3,
    });
  });

  it('does not resurrect a GC-deleted envelope from a promoted stale cache', async () => {
    const storage = new MemorySecretStorage();
    const leader = new SecretStore(storage);
    await leader.persistSessionAuth(
      descriptor,
      withToken('before-gc', 'account-before-gc'),
      {
        reason: 'login',
        emptyToken: 'clear',
        binding: 'existing-or-random',
      },
    );
    const staleFollower = new SecretStore(storage);
    await staleFollower.initializeLocalAuthState();
    const envelopeKey = findAuthEnvelopeKey(storage);
    if (!envelopeKey) throw new Error('Expected local auth envelope key.');

    await leader.reconcileLocalAuthSnapshots([], Date.now());
    await leader.deleteByKey(envelopeKey);
    expect(storage.values.has(envelopeKey)).toBe(true);
    expect(leader.getLocalAuthEnvelope(BINDING_ID)).toBeUndefined();
    expect(staleFollower.getLocalAuthEnvelope(BINDING_ID)).toBeDefined();

    await staleFollower.reconcileLocalAuthSnapshots([], Date.now());

    expect(storage.values.has(envelopeKey)).toBe(true);
    expect(staleFollower.getLocalAuthEnvelope(BINDING_ID)).toBeUndefined();
  });

  it('keeps revisions monotonic across deletion and recreation by another store', async () => {
    const storage = new MemorySecretStorage();
    const firstLeader = new SecretStore(storage);
    await firstLeader.persistSessionAuth(
      descriptor,
      withToken('first', 'account-first'),
      {
        reason: 'login',
        emptyToken: 'clear',
        binding: 'existing-or-random',
      },
    );
    await firstLeader.persistSessionAuth(
      descriptor,
      withToken('second', 'account-second'),
      {
        reason: 'refresh',
        emptyToken: 'clear',
        binding: 'existing-or-random',
      },
    );
    expect(firstLeader.getLocalAuthEnvelope(BINDING_ID)?.revision).toBe(2);

    const oldFollower = new SecretStore(storage);
    await oldFollower.initializeLocalAuthState();
    const envelopeKey = findAuthEnvelopeKey(storage);
    if (!envelopeKey) throw new Error('Expected local auth envelope key.');
    await firstLeader.deleteByKey(envelopeKey);

    const replacementLeader = new SecretStore(storage);
    await replacementLeader.initializeLocalAuthState();
    const persisted = await replacementLeader.persistSessionAuth(
      descriptor,
      withToken('replacement', 'account-replacement'),
      {
        reason: 'login',
        emptyToken: 'clear',
        binding: 'existing-or-random',
      },
    );
    expect(replacementLeader.getLocalAuthEnvelope(BINDING_ID)?.revision).toBe(4);

    await oldFollower.reloadLocalAuthState(BINDING_ID);

    expect(oldFollower.getLocalAuthEnvelope(BINDING_ID)?.revision).toBe(4);
    expect(oldFollower.getLocalAuthContext(descriptor, persisted)).toMatchObject({
      accountId: 'account-replacement',
      revision: 4,
    });
  });

  it('rejects a delayed older envelope read across two stores', async () => {
    const storage = new MemorySecretStorage();
    const writer = new SecretStore(storage);
    await writer.persistSessionAuth(
      descriptor,
      withToken('revision-one', 'account-one'),
      {
        reason: 'login',
        emptyToken: 'clear',
        binding: 'existing-or-random',
      },
    );
    const envelopeKey = findAuthEnvelopeKey(storage);
    if (!envelopeKey) throw new Error('Expected local auth envelope key.');
    const revisionOneRaw = storage.values.get(envelopeKey);
    if (!revisionOneRaw) throw new Error('Expected revision one envelope.');

    await writer.persistSessionAuth(
      descriptor,
      withToken('revision-two', 'account-two'),
      {
        reason: 'refresh',
        emptyToken: 'clear',
        binding: 'existing-or-random',
      },
    );
    const revisionTwoRaw = storage.values.get(envelopeKey);
    if (!revisionTwoRaw) throw new Error('Expected revision two envelope.');
    const follower = new SecretStore(storage);
    await follower.initializeLocalAuthState();
    expect(follower.getLocalAuthEnvelope(BINDING_ID)?.revision).toBe(2);

    storage.values.set(envelopeKey, revisionOneRaw);
    let releaseRead = (): void => undefined;
    let reportReadStarted = (): void => undefined;
    const readGate = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    const readStarted = new Promise<void>((resolve) => {
      reportReadStarted = resolve;
    });
    storage.beforeGet = async (key) => {
      if (key !== envelopeKey) return;
      storage.beforeGet = undefined;
      reportReadStarted();
      await readGate;
    };

    const reload = follower.reloadLocalAuthState(BINDING_ID);
    await readStarted;
    storage.values.set(envelopeKey, revisionTwoRaw);
    releaseRead();
    await reload;

    expect(follower.getLocalAuthEnvelope(BINDING_ID)?.revision).toBe(2);
    expect(
      follower.getLocalAuthEnvelope(BINDING_ID)?.snapshots[0]?.token?.accessToken,
    ).toBe('revision-two-access');
  });

  it('keeps legacy Claude email fallback out of new logins', async () => {
    const store = new SecretStore(new MemorySecretStorage());
    const claudeDescriptor: AuthBindingDescriptor = {
      providerName: 'Claude',
      providerType: 'anthropic',
      baseUrl: 'https://api.anthropic.com',
    };
    const legacyEmail = 'legacy@example.com';
    const persisted = await store.persistSessionAuth(
      claudeDescriptor,
      {
        method: 'claude-code',
        bindingId: BINDING_ID,
        token: JSON.stringify(token('claude-login')),
        email: legacyEmail,
      },
      {
        reason: 'login',
        emptyToken: 'clear',
        binding: 'existing-or-random',
      },
    );

    const context = store.getLocalAuthContext(claudeDescriptor, persisted);
    expect(context?.method).toBe('claude-code');
    expect(context?.sessionId).toBeTruthy();
    expect(context?.sessionId).not.toBe(legacyEmail);
  });

  it('commits a provider token refresh to the versioned envelope', async () => {
    const storage = new MemorySecretStorage();
    const store = new SecretStore(storage);
    const oauthDescriptor: AuthBindingDescriptor = {
      providerName: 'OAuth Provider',
      providerType: 'openai-chat-completion',
      baseUrl: 'https://example.test/v1',
    };
    const initialAuth: OAuth2AuthConfig = {
      method: 'oauth2',
      bindingId: BINDING_ID,
      identityId: 'oauth-session',
      token: JSON.stringify(token('before-refresh')),
      oauth: {
        grantType: 'authorization_code',
        authorizationUrl: 'https://identity.example.test/authorize',
        tokenUrl: 'https://identity.example.test/token',
        clientId: 'public-client',
      },
    };
    let persisted = await store.persistSessionAuth(
      oauthDescriptor,
      initialAuth,
      {
        reason: 'login',
        emptyToken: 'clear',
        binding: 'existing-or-random',
      },
    );
    if (persisted.method !== 'oauth2') {
      throw new Error('Expected OAuth auth.');
    }
    let guard = store.getLocalAuthCommitGuard(oauthDescriptor, persisted);
    const providerRuntime = store.hydrateSessionAuth(
      oauthDescriptor,
      persisted,
    );
    if (providerRuntime.method !== 'oauth2') {
      throw new Error('Expected OAuth auth.');
    }
    const provider = new OAuth2AuthProvider(
      {
        providerId: oauthDescriptor.providerName,
        providerLabel: oauthDescriptor.providerName,
        providerType: oauthDescriptor.providerType,
        baseUrl: oauthDescriptor.baseUrl,
        secretStore: store,
        persistAuthConfig: async (auth) => {
          if (auth.method !== 'oauth2') {
            throw new Error('Expected OAuth auth.');
          }
          const next = await store.persistSessionAuth(
            oauthDescriptor,
            auth,
            {
              reason: auth.token ? 'context' : 'logout',
              emptyToken: 'clear',
              binding: 'existing-or-random',
              guard,
            },
          );
          if (next.method !== 'oauth2') {
            throw new Error('Expected OAuth auth.');
          }
          persisted = next;
          guard = store.getLocalAuthCommitGuard(oauthDescriptor, next);
        },
      },
      providerRuntime,
    );
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            access_token: 'after-refresh-access',
            refresh_token: 'after-refresh-refresh',
            token_type: 'Bearer',
            expires_in: 3600,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      ),
    );
    try {
      await expect(provider.refresh()).resolves.toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }

    expect(store.getLocalAuthEnvelope(BINDING_ID)?.revision).toBe(2);
    const reloaded = new SecretStore(storage);
    await reloaded.initializeLocalAuthState();
    const runtime = reloaded.hydrateSessionAuth(oauthDescriptor, persisted);
    if (runtime.method !== 'oauth2') {
      throw new Error('Expected OAuth auth.');
    }
    expect(await reloaded.getOAuth2Token(runtime.token ?? '')).toMatchObject({
      accessToken: 'after-refresh-access',
      refreshToken: 'after-refresh-refresh',
    });
  });

  it('rejects a credential when its token no longer matches the local snapshot', async () => {
    const store = new SecretStore(new MemorySecretStorage());
    const oauthDescriptor: AuthBindingDescriptor = {
      providerName: 'OAuth Provider',
      providerType: 'openai-chat-completion',
      baseUrl: 'https://example.test/v1',
    };
    const initial: OAuth2AuthConfig = {
      method: 'oauth2',
      bindingId: BINDING_ID,
      identityId: 'oauth-session',
      token: JSON.stringify(token('old-access')),
      oauth: {
        grantType: 'authorization_code',
        authorizationUrl: 'https://identity.example.test/authorize',
        tokenUrl: 'https://identity.example.test/token',
        clientId: 'public-client',
      },
    };
    const persisted = await store.persistSessionAuth(
      oauthDescriptor,
      initial,
      {
        reason: 'login',
        emptyToken: 'clear',
        binding: 'existing-or-random',
      },
    );
    const provider = createAuthProvider(
      {
        providerId: oauthDescriptor.providerName,
        providerLabel: oauthDescriptor.providerName,
        providerType: oauthDescriptor.providerType,
        baseUrl: oauthDescriptor.baseUrl,
        secretStore: store,
      },
      persisted,
    );
    if (!provider) throw new Error('Expected OAuth provider.');

    const originalGetToken = store.getOAuth2Token.bind(store);
    let tokenRead: (() => void) | undefined;
    const tokenWasRead = new Promise<void>((resolve) => {
      tokenRead = resolve;
    });
    let releaseRead: (() => void) | undefined;
    const readGate = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    vi.spyOn(store, 'getOAuth2Token').mockImplementation(async (ref) => {
      const value = await originalGetToken(ref);
      tokenRead?.();
      await readGate;
      return value;
    });

    const pendingCredential = provider.getCredential();
    await tokenWasRead;
    const runtime = store.hydrateSessionAuth(oauthDescriptor, persisted);
    const guard = store.getLocalAuthCommitGuard(oauthDescriptor, runtime);
    await store.persistSessionAuth(
      oauthDescriptor,
      { ...runtime, token: JSON.stringify(token('new-access')) },
      {
        reason: 'refresh',
        emptyToken: 'clear',
        binding: 'existing-or-random',
        guard,
      },
    );
    releaseRead?.();

    await expect(pendingCredential).resolves.toBeUndefined();
  });

  it('recovers an ambiguous Codex orphan only after a UI selection', async () => {
    const storage = new MemorySecretStorage();
    const store = new SecretStore(storage);
    const firstRef = store.createRef();
    const secondRef = store.createRef();
    await store.setOAuth2Token(firstRef, {
      ...token('first-orphan'),
      accessToken: jwt({
        chatgpt_account_id: 'account-first',
        email: 'first@example.test',
      }),
    });
    await store.setOAuth2Token(secondRef, {
      ...token('second-orphan'),
      accessToken: jwt({
        chatgpt_account_id: 'account-second',
        email: 'second@example.test',
      }),
    });
    let persistedAuth = codexAuth();
    const provider = new OpenAICodexAuthProvider(
      {
        providerId: descriptor.providerName,
        providerLabel: descriptor.providerName,
        providerType: descriptor.providerType,
        baseUrl: descriptor.baseUrl,
        secretStore: store,
        persistAuthConfig: async (auth) => {
          if (auth.method !== 'openai-codex') {
            throw new Error('Expected Codex auth.');
          }
          const persisted = await store.persistSessionAuth(descriptor, auth, {
            reason: 'import',
            emptyToken: 'preserve',
            binding: 'existing-or-random',
          });
          if (persisted.method !== 'openai-codex') {
            throw new Error('Expected persisted Codex auth.');
          }
          persistedAuth = persisted;
        },
      },
      persistedAuth,
    );

    expect(store.getLocalAuthEnvelope(BINDING_ID)).toBeUndefined();
    const items = await provider.getStatusViewItems();
    const recovery = items.find((item) =>
      item.label.includes('Recover local authorization'),
    );
    if (!recovery?.action) throw new Error('Expected recovery action.');
    await recovery.action.run();

    const quickPickItems = vscodeWindow.showQuickPick.mock.calls.at(-1)?.[0];
    expect(Array.isArray(quickPickItems) ? quickPickItems : []).toHaveLength(2);

    expect(
      store.getLocalAuthContext(descriptor, persistedAuth),
    ).toMatchObject({ accountId: 'account-first' });
    const firstKey = buildOAuth2TokenStorageKey(firstRef);
    const secondKey = buildOAuth2TokenStorageKey(secondRef);
    expect(firstKey && storage.values.has(firstKey)).toBe(true);
    expect(secondKey && storage.values.has(secondKey)).toBe(true);
  });

  it('isolates login, refresh, context, and logout across two devices', async () => {
    const deviceA = new SecretStore(new MemorySecretStorage());
    const deviceB = new SecretStore(new MemorySecretStorage());

    const staticA = await deviceA.persistSessionAuth(
      descriptor,
      withToken('device-a', 'account-a'),
      {
        reason: 'login',
        emptyToken: 'clear',
        binding: 'existing-or-random',
      },
    );
    const staticB = await deviceB.persistSessionAuth(
      descriptor,
      withToken('device-b', 'account-b'),
      {
        reason: 'login',
        emptyToken: 'clear',
        binding: 'existing-or-random',
      },
    );

    expect(staticA).toEqual(staticB);
    expect(staticA).not.toHaveProperty('token');
    expect(staticA).not.toHaveProperty('accountId');
    expect(deviceA.getLocalAuthContext(descriptor, staticA)).toMatchObject({
      method: 'openai-codex',
      accountId: 'account-a',
    });
    expect(deviceB.getLocalAuthContext(descriptor, staticB)).toMatchObject({
      method: 'openai-codex',
      accountId: 'account-b',
    });

    const runtimeA = deviceA.hydrateSessionAuth(descriptor, staticA);
    const runtimeB = deviceB.hydrateSessionAuth(descriptor, staticB);
    if (runtimeA.method !== 'openai-codex') {
      throw new Error('Expected Codex runtime auth.');
    }
    expect(await deviceA.getOAuth2Token(runtimeA.token ?? '')).toEqual(
      token('device-a'),
    );
    expect(await deviceB.getOAuth2Token(runtimeB.token ?? '')).toEqual(
      token('device-b'),
    );

    const refreshGuard = deviceA.getLocalAuthCommitGuard(descriptor, runtimeA);
    await deviceA.setOAuth2Token(runtimeA.token ?? '', token('device-a-next'));
    await deviceA.persistSessionAuth(
      descriptor,
      { ...runtimeA, accountId: 'account-a-next' },
      {
        reason: 'refresh',
        emptyToken: 'clear',
        binding: 'existing-or-random',
        guard: refreshGuard,
      },
    );
    expect(await deviceB.getOAuth2Token(runtimeB.token ?? '')).toEqual(
      token('device-b'),
    );
    expect(deviceB.getLocalAuthContext(descriptor, staticB)).toMatchObject({
      accountId: 'account-b',
    });

    const logoutRuntime = deviceA.hydrateSessionAuth(descriptor, staticA);
    await deviceA.persistSessionAuth(
      descriptor,
      { ...logoutRuntime, token: undefined },
      {
        reason: 'logout',
        emptyToken: 'clear',
        binding: 'existing-or-random',
        guard: deviceA.getLocalAuthCommitGuard(descriptor, logoutRuntime),
      },
    );
    expect(deviceA.getLocalAuthContext(descriptor, staticA)).toBeUndefined();
    expect(await deviceB.getOAuth2Token(runtimeB.token ?? '')).toEqual(
      token('device-b'),
    );
  });

  it('exports transfer DTOs without binding IDs and reads sensitive data locally', async () => {
    const store = new SecretStore(new MemorySecretStorage());
    const staticAuth = await store.persistSessionAuth(
      descriptor,
      withToken('local-export', 'local-account'),
      {
        reason: 'login',
        emptyToken: 'clear',
        binding: 'existing-or-random',
      },
    );
    const provider: ProviderConfig = {
      ...descriptor,
      type: 'openai-responses',
      name: descriptor.providerName,
      models: [],
      auth: staticAuth,
    };
    const original = structuredClone(provider);

    const redacted = await resolveProviderForExportOrShowError({
      secretStore: store,
      provider,
      includeSensitive: false,
    });
    expect(redacted?.auth).toEqual({ method: 'openai-codex' });

    const sensitive = await resolveProviderForExportOrShowError({
      secretStore: store,
      provider,
      includeSensitive: true,
    });
    expect(sensitive?.auth).toMatchObject({
      method: 'openai-codex',
      accountId: 'local-account',
      email: 'local-account@example.com',
    });
    expect(sensitive?.auth).not.toHaveProperty('bindingId');
    if (sensitive?.auth?.method !== 'openai-codex') {
      throw new Error('Expected Codex transfer auth.');
    }
    expect(JSON.parse(sensitive.auth.token ?? '')).toEqual(
      token('local-export'),
    );
    expect(provider).toEqual(original);
  });

  it('exports the session token and account context from one local snapshot', async () => {
    const store = new SecretStore(new MemorySecretStorage());
    const staticAuth = await store.persistSessionAuth(
      descriptor,
      withToken('snapshot', 'snapshot-account'),
      {
        reason: 'login',
        emptyToken: 'clear',
        binding: 'existing-or-random',
      },
    );
    const tokenRefRead = vi
      .spyOn(store, 'getOAuth2Token')
      .mockResolvedValue(token('different-revision'));

    const sensitive = await resolveProviderForExportOrShowError({
      secretStore: store,
      provider: {
        ...descriptor,
        type: 'openai-responses',
        name: descriptor.providerName,
        models: [],
        auth: staticAuth,
      },
      includeSensitive: true,
    });

    expect(tokenRefRead).not.toHaveBeenCalled();
    expect(sensitive?.auth).toMatchObject({
      method: 'openai-codex',
      accountId: 'snapshot-account',
      email: 'snapshot-account@example.com',
    });
    if (sensitive?.auth?.method !== 'openai-codex') {
      throw new Error('Expected Codex transfer auth.');
    }
    expect(JSON.parse(sensitive.auth.token ?? '')).toEqual(token('snapshot'));
  });

  it('exports an OAuth token and client secret from one local snapshot', async () => {
    const store = new SecretStore(new MemorySecretStorage());
    const oauthDescriptor = {
      providerName: 'OAuth',
      providerType: 'openai-chat-completion',
      baseUrl: 'https://oauth-api.example.test/v1',
    } as const satisfies AuthBindingDescriptor;
    const oauth: OAuth2AuthConfig = {
      method: 'oauth2',
      bindingId: BINDING_ID,
      identityId: 'oauth-session',
      token: JSON.stringify(token('oauth-snapshot')),
      oauth: {
        grantType: 'authorization_code',
        authorizationUrl: 'https://auth.example.test/authorize',
        tokenUrl: 'https://auth.example.test/token',
        clientId: 'client-id',
        clientSecret: 'snapshot-client-secret',
      },
    };
    const staticAuth = await store.persistSessionAuth(
      oauthDescriptor,
      oauth,
      {
        reason: 'login',
        emptyToken: 'clear',
        binding: 'existing-or-random',
      },
    );
    const tokenRefRead = vi
      .spyOn(store, 'getOAuth2Token')
      .mockResolvedValue(token('different-revision'));
    const clientSecretRefRead = vi
      .spyOn(store, 'getOAuth2ClientSecret')
      .mockResolvedValue('different-client-secret');

    const sensitive = await resolveProviderForExportOrShowError({
      secretStore: store,
      provider: {
        ...oauthDescriptor,
        type: oauthDescriptor.providerType,
        name: oauthDescriptor.providerName,
        models: [],
        auth: staticAuth,
      },
      includeSensitive: true,
    });

    expect(tokenRefRead).not.toHaveBeenCalled();
    expect(clientSecretRefRead).not.toHaveBeenCalled();
    if (sensitive?.auth?.method !== 'oauth2') {
      throw new Error('Expected OAuth2 transfer auth.');
    }
    expect(JSON.parse(sensitive.auth.token ?? '')).toEqual(
      token('oauth-snapshot'),
    );
    if (sensitive.auth.oauth.grantType !== 'authorization_code') {
      throw new Error('Expected authorization-code OAuth transfer auth.');
    }
    expect(sensitive.auth.oauth.clientSecret).toBe('snapshot-client-secret');
  });

  it('accepts only the first concurrent login using the captured epoch', async () => {
    const store = new SecretStore(new MemorySecretStorage());
    const initial = codexAuth();
    const guard = store.getLocalAuthCommitGuard(descriptor, initial);
    const [first, second] = await Promise.allSettled([
      store.persistSessionAuth(descriptor, withToken('first', 'first'), {
        reason: 'login',
        emptyToken: 'clear',
        binding: 'existing-or-random',
        guard,
      }),
      store.persistSessionAuth(descriptor, withToken('second', 'second'), {
        reason: 'login',
        emptyToken: 'clear',
        binding: 'existing-or-random',
        guard,
      }),
    ]);

    expect(first.status).toBe('fulfilled');
    expect(second.status).toBe('rejected');
    const runtime = store.hydrateSessionAuth(descriptor, initial);
    expect(await store.getOAuth2Token(runtime.token ?? '')).toEqual(
      token('first'),
    );
  });

  it('keeps concurrent refresh intents isolated before guarded commit', async () => {
    const store = new SecretStore(new MemorySecretStorage());
    const persisted = await store.persistSessionAuth(
      descriptor,
      withToken('initial', 'account'),
      {
        reason: 'login',
        emptyToken: 'clear',
        binding: 'existing-or-random',
      },
    );
    const runtime = store.hydrateSessionAuth(descriptor, persisted);
    const guard = store.getLocalAuthCommitGuard(descriptor, runtime);
    const firstRef = store.createTransientOAuth2TokenRef();
    const secondRef = store.createTransientOAuth2TokenRef();
    await store.setOAuth2Token(firstRef, token('first-refresh'));
    await store.setOAuth2Token(secondRef, token('second-refresh'));

    const [first, second] = await Promise.allSettled([
      store.persistSessionAuth(
        descriptor,
        { ...runtime, token: firstRef },
        {
          reason: 'refresh',
          emptyToken: 'clear',
          binding: 'existing-or-random',
          guard,
        },
      ),
      store.persistSessionAuth(
        descriptor,
        { ...runtime, token: secondRef },
        {
          reason: 'refresh',
          emptyToken: 'clear',
          binding: 'existing-or-random',
          guard,
        },
      ),
    ]);

    expect(first.status).toBe('fulfilled');
    expect(second.status).toBe('rejected');
    const refreshed = store.hydrateSessionAuth(descriptor, persisted);
    expect(await store.getOAuth2Token(refreshed.token ?? '')).toEqual(
      token('first-refresh'),
    );
    expect(
      store.getLocalAuthEnvelope(BINDING_ID)?.snapshots[0]?.epoch,
    ).toBe(1);
  });

  it('releases obsolete transient aliases after a later refresh', async () => {
    const store = new SecretStore(new MemorySecretStorage());
    const persisted = await store.persistSessionAuth(
      descriptor,
      withToken('initial', 'account'),
      {
        reason: 'login',
        emptyToken: 'clear',
        binding: 'existing-or-random',
      },
    );
    const firstRuntime = store.hydrateSessionAuth(descriptor, persisted);
    const firstRef = store.createTransientOAuth2TokenRef();
    await store.setOAuth2Token(firstRef, token('first-refresh'));
    await store.persistSessionAuth(
      descriptor,
      { ...firstRuntime, token: firstRef },
      {
        reason: 'refresh',
        emptyToken: 'clear',
        binding: 'existing-or-random',
        guard: store.getLocalAuthCommitGuard(descriptor, firstRuntime),
      },
    );

    const secondRuntime = store.hydrateSessionAuth(descriptor, persisted);
    const secondRef = store.createTransientOAuth2TokenRef();
    await store.setOAuth2Token(secondRef, token('second-refresh'));
    await store.persistSessionAuth(
      descriptor,
      { ...secondRuntime, token: secondRef },
      {
        reason: 'refresh',
        emptyToken: 'clear',
        binding: 'existing-or-random',
        guard: store.getLocalAuthCommitGuard(descriptor, secondRuntime),
      },
    );

    expect(await store.getOAuth2Token(firstRef)).toBeNull();
    expect(await store.getOAuth2Token(secondRef)).toEqual(
      token('second-refresh'),
    );
  });

  it('does not let a staged refresh defeat an earlier guarded logout', async () => {
    const store = new SecretStore(new MemorySecretStorage());
    const persisted = await store.persistSessionAuth(
      descriptor,
      withToken('initial', 'account'),
      {
        reason: 'login',
        emptyToken: 'clear',
        binding: 'existing-or-random',
      },
    );
    const runtime = store.hydrateSessionAuth(descriptor, persisted);
    const guard = store.getLocalAuthCommitGuard(descriptor, runtime);
    const refreshRef = store.createTransientOAuth2TokenRef();
    await store.setOAuth2Token(refreshRef, token('stale-refresh'));

    const [logout, refresh] = await Promise.allSettled([
      store.persistSessionAuth(
        descriptor,
        { ...runtime, token: undefined },
        {
          reason: 'logout',
          emptyToken: 'clear',
          binding: 'existing-or-random',
          guard,
        },
      ),
      store.persistSessionAuth(
        descriptor,
        { ...runtime, token: refreshRef },
        {
          reason: 'refresh',
          emptyToken: 'clear',
          binding: 'existing-or-random',
          guard,
        },
      ),
    ]);

    expect(logout.status).toBe('fulfilled');
    expect(refresh.status).toBe('rejected');
    expect(store.hydrateSessionAuth(descriptor, persisted).token).toBeUndefined();
  });

  it('allows a guarded static config change when the binding did not change', async () => {
    const store = new SecretStore(new MemorySecretStorage());
    const oauthDescriptor: AuthBindingDescriptor = {
      providerName: 'OAuth',
      providerType: 'openai-chat-completion',
      baseUrl: 'https://api.example.test/v1',
    };
    const initial: OAuth2AuthConfig = {
      method: 'oauth2',
      bindingId: BINDING_ID,
      identityId: 'initial-session',
      token: JSON.stringify(token('initial')),
      oauth: {
        grantType: 'authorization_code',
        authorizationUrl: 'https://identity.example.test/authorize',
        tokenUrl: 'https://identity.example.test/token',
        clientId: 'initial-client',
      },
    };
    const persisted = await store.persistSessionAuth(
      oauthDescriptor,
      initial,
      {
        reason: 'login',
        emptyToken: 'clear',
        binding: 'existing-or-random',
      },
    );
    const guard = store.getLocalAuthCommitGuard(oauthDescriptor, persisted);
    const changed: OAuth2AuthConfig = {
      ...initial,
      identityId: 'changed-session',
      token: JSON.stringify(token('changed')),
      oauth: { ...initial.oauth, clientId: 'changed-client' },
    };

    await expect(
      store.persistSessionAuth(oauthDescriptor, changed, {
        reason: 'login',
        emptyToken: 'clear',
        binding: 'existing-or-random',
        guard,
      }),
    ).resolves.toMatchObject({
      method: 'oauth2',
      bindingId: BINDING_ID,
    });

    const snapshots = store.getLocalAuthEnvelope(BINDING_ID)?.snapshots ?? [];
    expect(snapshots).toHaveLength(2);
    expect(snapshots.map((snapshot) => snapshot.staticConfigFingerprint)).toEqual(
      expect.arrayContaining([
        guard.staticConfigFingerprint,
        computeStaticAuthFingerprint(oauthDescriptor, changed),
      ]),
    );
  });

  it('does not copy an existing session into a changed static fingerprint', async () => {
    const store = new SecretStore(new MemorySecretStorage());
    const oauthDescriptor: AuthBindingDescriptor = {
      providerName: 'OAuth',
      providerType: 'openai-chat-completion',
      baseUrl: 'https://api.example.test/v1',
    };
    const initial: OAuth2AuthConfig = {
      method: 'oauth2',
      bindingId: BINDING_ID,
      token: JSON.stringify(token('initial')),
      oauth: {
        grantType: 'authorization_code',
        authorizationUrl: 'https://identity.example.test/authorize',
        tokenUrl: 'https://identity.example.test/token',
        clientId: 'initial-client',
      },
    };
    const persisted = await store.persistSessionAuth(
      oauthDescriptor,
      initial,
      {
        reason: 'login',
        emptyToken: 'clear',
        binding: 'existing-or-random',
      },
    );
    const runtime = store.hydrateSessionAuth(oauthDescriptor, persisted);
    if (runtime.method !== 'oauth2') {
      throw new Error('Expected OAuth runtime config.');
    }
    const changed = {
      ...runtime,
      oauth: { ...runtime.oauth, clientId: 'changed-client' },
    };

    const changedPersisted = await store.persistSessionAuth(
      oauthDescriptor,
      changed,
      {
        reason: 'import',
        emptyToken: 'preserve',
        binding: 'existing-or-random',
        guard: store.getLocalAuthCommitGuard(oauthDescriptor, runtime),
      },
    );

    expect(
      store.hydrateSessionAuth(oauthDescriptor, changedPersisted).token,
    ).toBeUndefined();
    expect(
      store.getLocalAuthEnvelope(BINDING_ID)?.snapshots.some(
        (snapshot) => snapshot.token?.accessToken === 'initial-access',
      ),
    ).toBe(true);
  });

  it('keeps runtime references isolated between snapshots of one binding', async () => {
    const store = new SecretStore(new MemorySecretStorage());
    const descriptorA = { ...descriptor, baseUrl: 'https://a.example/v1' };
    const descriptorB = { ...descriptor, baseUrl: 'https://b.example/v1' };
    const persistedA = await store.persistSessionAuth(
      descriptorA,
      withToken('a', 'account-a'),
      {
        reason: 'login',
        emptyToken: 'clear',
        binding: 'existing-or-random',
      },
    );
    const persistedB = await store.persistSessionAuth(
      descriptorB,
      withToken('b', 'account-b'),
      {
        reason: 'login',
        emptyToken: 'clear',
        binding: 'existing-or-random',
      },
    );

    const runtimeA = store.hydrateSessionAuth(descriptorA, persistedA);
    const runtimeB = store.hydrateSessionAuth(descriptorB, persistedB);
    expect(runtimeA.token).not.toBe(runtimeB.token);
    expect(await store.getOAuth2Token(runtimeA.token ?? '')).toEqual(token('a'));
    expect(await store.getOAuth2Token(runtimeB.token ?? '')).toEqual(token('b'));
  });

  it('rejects a stale guard even when the operation changes static config', async () => {
    const store = new SecretStore(new MemorySecretStorage());
    const initial = await store.persistSessionAuth(
      descriptor,
      withToken('initial', 'initial'),
      {
        reason: 'login',
        emptyToken: 'clear',
        binding: 'existing-or-random',
      },
    );
    const staleGuard = store.getLocalAuthCommitGuard(descriptor, initial);
    await store.persistSessionAuth(
      descriptor,
      withToken('newer', 'newer'),
      {
        reason: 'login',
        emptyToken: 'clear',
        binding: 'existing-or-random',
        guard: staleGuard,
      },
    );

    const changedDescriptor = {
      ...descriptor,
      baseUrl: 'https://other.openai.example/v1',
    };
    await expect(
      store.persistSessionAuth(
        changedDescriptor,
        withToken('stale', 'stale'),
        {
          reason: 'login',
          emptyToken: 'clear',
          binding: 'existing-or-random',
          guard: staleGuard,
        },
      ),
    ).rejects.toThrow('Authentication state changed');
  });

  it('treats a materialized account switch as a new session', async () => {
    const store = new SecretStore(new MemorySecretStorage());
    const initial = await store.persistSessionAuth(
      descriptor,
      { ...withToken('first', 'first'), identityId: 'session-first' },
      {
        reason: 'login',
        emptyToken: 'clear',
        binding: 'existing-or-random',
      },
    );
    const before = store.getLocalAuthEnvelope(BINDING_ID)?.snapshots[0];
    if (initial.method !== 'openai-codex') {
      throw new Error('Expected Codex auth.');
    }
    const switched = await store.persistSessionAuth(
      descriptor,
      {
        ...initial,
        identityId: 'session-second',
        token: JSON.stringify(token('second')),
        accountId: 'second',
      },
      {
        reason: 'import',
        emptyToken: 'preserve',
        binding: 'existing-or-random',
      },
    );
    const after = store.getLocalAuthEnvelope(BINDING_ID)?.snapshots[0];

    expect(after?.epoch).toBe((before?.epoch ?? 0) + 1);
    expect(after?.sessionId).not.toBe(before?.sessionId);
    expect(store.getLocalAuthContext(descriptor, switched)).toMatchObject({
      accountId: 'second',
      sessionId: after?.sessionId,
    });
  });

  it('rejects a stale refresh after logout', async () => {
    const store = new SecretStore(new MemorySecretStorage());
    const persisted = await store.persistSessionAuth(
      descriptor,
      withToken('login', 'account'),
      {
        reason: 'login',
        emptyToken: 'clear',
        binding: 'existing-or-random',
      },
    );
    const runtime = store.hydrateSessionAuth(descriptor, persisted);
    const staleGuard = store.getLocalAuthCommitGuard(descriptor, runtime);
    await store.persistSessionAuth(
      descriptor,
      { ...runtime, token: undefined },
      {
        reason: 'logout',
        emptyToken: 'clear',
        binding: 'existing-or-random',
        guard: staleGuard,
      },
    );

    await expect(
      store.persistSessionAuth(
        descriptor,
        { ...runtime, token: JSON.stringify(token('stale-refresh')) },
        {
          reason: 'refresh',
          emptyToken: 'clear',
          binding: 'existing-or-random',
          guard: staleGuard,
        },
      ),
    ).rejects.toThrow('Authentication state changed');
  });

  it('restores matching snapshots and removes continuously orphaned ones at 7 days', async () => {
    const store = new SecretStore(new MemorySecretStorage());
    const descriptorA = { ...descriptor, baseUrl: 'https://a.example/v1' };
    const descriptorB = { ...descriptor, baseUrl: 'https://b.example/v1' };
    const auth = codexAuth();
    await store.persistSessionAuth(descriptorA, withToken('a', 'account-a'), {
      reason: 'login',
      emptyToken: 'clear',
      binding: 'existing-or-random',
    });
    await store.persistSessionAuth(descriptorB, withToken('b', 'account-b'), {
      reason: 'login',
      emptyToken: 'clear',
      binding: 'existing-or-random',
    });

    const fingerprintA = computeStaticAuthFingerprint(descriptorA, auth);
    const fingerprintB = computeStaticAuthFingerprint(descriptorB, auth);
    const orphanedAt = store
      .getLocalAuthEnvelope(BINDING_ID)
      ?.snapshots.find(
        (snapshot) => snapshot.staticConfigFingerprint === fingerprintA,
      )?.orphanedAt;
    expect(orphanedAt).toBeTypeOf('number');

    await store.reconcileLocalAuthSnapshots(
      [
        {
          providerName: descriptorB.providerName,
          bindingId: BINDING_ID,
          method: 'openai-codex',
          fingerprint: fingerprintB,
        },
      ],
      (orphanedAt ?? 0) + ORPHAN_SECRET_RETENTION_MS - 1,
    );
    expect(store.getLocalAuthEnvelope(BINDING_ID)?.snapshots).toHaveLength(2);

    await store.reconcileLocalAuthSnapshots(
      [
        {
          providerName: descriptorA.providerName,
          bindingId: BINDING_ID,
          method: 'openai-codex',
          fingerprint: fingerprintA,
        },
      ],
      (orphanedAt ?? 0) + ORPHAN_SECRET_RETENTION_MS - 1,
    );
    const restored = store
      .getLocalAuthEnvelope(BINDING_ID)
      ?.snapshots.find(
        (snapshot) => snapshot.staticConfigFingerprint === fingerprintA,
      );
    expect(restored?.orphanedAt).toBeUndefined();
    expect(
      store.getLocalAuthContext(descriptorA, auth),
    ).toMatchObject({ accountId: 'account-a' });

    const markedB = store
      .getLocalAuthEnvelope(BINDING_ID)
      ?.snapshots.find(
        (snapshot) => snapshot.staticConfigFingerprint === fingerprintB,
      );
    await store.reconcileLocalAuthSnapshots(
      [
        {
          providerName: descriptorA.providerName,
          bindingId: BINDING_ID,
          method: 'openai-codex',
          fingerprint: fingerprintA,
        },
      ],
      (markedB?.orphanedAt ?? 0) + ORPHAN_SECRET_RETENTION_MS,
    );
    expect(
      store
        .getLocalAuthEnvelope(BINDING_ID)
        ?.snapshots.some(
          (snapshot) => snapshot.staticConfigFingerprint === fingerprintB,
        ),
    ).toBe(false);
  });
});

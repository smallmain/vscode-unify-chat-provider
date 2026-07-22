import { get } from 'node:http';
import {
  constants,
  createPublicKey,
  publicEncrypt,
} from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const browser = vi.hoisted(() => ({
  systemId: '',
  signInUrl: '',
  userId: '123',
  accessToken: 'long-lived-secret',
}));

function decodeBase64Url(value: string): Buffer {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(`${base64}${'='.repeat((4 - (base64.length % 4)) % 4)}`, 'base64');
}

function encodeBase64UrlWithPadding(value: Buffer): string {
  return value
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

async function completeBrowserSignIn(urlValue: string): Promise<boolean> {
  browser.signInUrl = urlValue;
  const signIn = new URL(urlValue);
  browser.systemId = signIn.searchParams.get('system_id') ?? '';
  const publicKeyValue = signIn.searchParams.get('native_app_public_key');
  const port = signIn.searchParams.get('native_app_port');
  if (!publicKeyValue || !port) return false;
  const publicKey = createPublicKey({
    key: decodeBase64Url(publicKeyValue),
    type: 'pkcs1',
    format: 'der',
  });
  const encrypted = publicEncrypt(
    {
      key: publicKey,
      padding: constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: 'sha256',
    },
    Buffer.from(browser.accessToken),
  );
  const callback = new URL(`http://127.0.0.1:${port}/`);
  callback.searchParams.set('user_id', browser.userId);
  callback.searchParams.set(
    'access_token',
    encodeBase64UrlWithPadding(encrypted),
  );

  await new Promise<void>((resolve, reject) => {
    get(callback, (response) => {
      try {
        expect(response.statusCode).toBe(302);
        expect(response.headers.location).toBe(
          'https://zed.dev/native_app_signin_succeeded',
        );
        response.resume();
        response.once('end', resolve);
      } catch (error) {
        reject(error);
      }
    }).once('error', reject);
  });
  return true;
}

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
    Uri: {
      parse: (value: string) => ({ toString: () => value }),
    },
    env: {
      language: 'en',
      openExternal: async (uri: { toString(): string }) =>
        completeBrowserSignIn(uri.toString()),
    },
    l10n: { t: (message: string, ...args: string[]) =>
      args.reduce(
        (result, value, index) => result.replace(`{${index}}`, value),
        message,
      ) },
    window: {
      showInformationMessage: vi.fn(),
      showErrorMessage: vi.fn(),
      showQuickPick: vi.fn(),
    },
  };
});

vi.mock('../../src/logger', () => ({
  authLog: {
    error: vi.fn(),
    verbose: vi.fn(),
    warn: vi.fn(),
  },
}));

import { SecretStore } from '../../src/secret/secret-store';
import { ZedAuthProvider } from '../../src/auth/providers/zed';
import { performZedNativeSignIn } from '../../src/auth/providers/zed/native-signin';
import type { AuthConfig } from '../../src/auth/types';

beforeEach(() => {
  browser.systemId = '';
  browser.signInUrl = '';
  browser.userId = '123';
  browser.accessToken = 'long-lived-secret';
});

afterEach(() => vi.unstubAllGlobals());

describe('Zed native sign-in', () => {
  it('decrypts the loopback callback and includes the stable system id', async () => {
    const credential = await performZedNativeSignIn({
      baseUrl: 'https://zed.dev',
      systemId: 'stable-system-id',
      timeoutMs: 5_000,
    });
    expect(credential).toEqual({
      userId: '123',
      accessToken: 'long-lived-secret',
    });
    const signIn = new URL(browser.signInUrl);
    expect(signIn.origin).toBe('https://zed.dev');
    expect(signIn.pathname).toBe('/native_app_signin');
    expect(browser.systemId).toBe('stable-system-id');
  });

  it('stores only a SecretStorage reference in auth config', async () => {
    const secrets = new Map<string, string>();
    const secretStore = new SecretStore({
      get: async (key: string) => secrets.get(key),
      store: async (key: string, value: string) => void secrets.set(key, value),
      delete: async (key: string) => void secrets.delete(key),
      keys: async () => Array.from(secrets.keys()),
      onDidChange: () => ({ dispose: () => undefined }),
    });
    const previousTokenRef = secretStore.createRef();
    await secretStore.setOAuth2Token(previousTokenRef, {
      accessToken: JSON.stringify({
        userId: 'previous-user',
        accessToken: 'previous-secret',
      }),
      tokenType: 'Zed',
    });
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input.toString());
      expect(new Headers(init?.headers).get('authorization')).toBe(
        '123 long-lived-secret',
      );
      if (url.pathname === '/client/users/me') {
        expect(new Headers(init?.headers).get('authorization')).toBe(
          '123 long-lived-secret',
        );
        return new Response(
          JSON.stringify({
            user: { id_v2: 'user-v2', username: 'zed-user' },
            organizations: [
              { id: 'org-default', name: 'Default', is_personal: true },
            ],
            default_organization_id: 'org-default',
            configuration_by_organization: {
              'org-default': {
                edit_prediction: {
                  is_enabled: true,
                  is_feedback_enabled: true,
                },
              },
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (url.pathname === '/client/system_settings') {
        expect(init?.method).toBe('PATCH');
        return new Response('{}', { status: 200 });
      }
      throw new Error(`Unexpected Zed request: ${url.pathname}`);
    });

    let persisted: AuthConfig | undefined;
    const provider = new ZedAuthProvider(
      {
        providerId: 'Zed Account',
        providerLabel: 'Zed Account',
        secretStore,
        persistAuthConfig: async (config) => {
          persisted = config;
        },
      },
      {
        method: 'zed',
        baseUrl: 'https://zed.dev',
        token: previousTokenRef,
        dataCollection: false,
      },
    );
    const result = await provider.configure();
    expect(result.success).toBe(true);
    expect(result.config).toMatchObject({
      method: 'zed',
      baseUrl: 'https://zed.dev',
      organizationId: 'org-default',
      dataCollection: false,
    });
    const tokenRef = result.config?.method === 'zed' ? result.config.token : '';
    expect(tokenRef).toMatch(/^\$UCPSECRET:/);
    expect(JSON.stringify(result.config)).not.toContain('long-lived-secret');
    expect(JSON.stringify(persisted)).not.toContain('long-lived-secret');
    expect(Array.from(secrets.values()).join('\n')).toContain(
      'long-lived-secret',
    );
    expect(await secretStore.getOAuth2Token(previousTokenRef)).toBeDefined();
    expect(browser.systemId).toBeTruthy();
    expect(secrets.get('ucp:state:zed-system-id-v1')).toBe(browser.systemId);

    await provider.revoke();
    expect(Array.from(secrets.values()).join('\n')).not.toContain(
      'long-lived-secret',
    );
    expect(await secretStore.getOAuth2Token(previousTokenRef)).toBeDefined();
  });

  it('assigns an identity and moves imported credentials into SecretStorage', async () => {
    const secrets = new Map<string, string>();
    const secretStore = new SecretStore({
      get: async (key: string) => secrets.get(key),
      store: async (key: string, value: string) => void secrets.set(key, value),
      delete: async (key: string) => void secrets.delete(key),
      keys: async () => Array.from(secrets.keys()),
      onDidChange: () => ({ dispose: () => undefined }),
    });
    const imported = await ZedAuthProvider.normalizeOnImport(
      {
        method: 'zed',
        token: JSON.stringify({
          accessToken: JSON.stringify({
            userId: 'imported-user',
            accessToken: 'imported-secret',
          }),
          tokenType: 'Zed',
        }),
      },
      { secretStore, storeSecretsInSettings: false },
    );

    expect(imported.identityId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(imported.token).toMatch(/^\$UCPSECRET:/);
    expect(JSON.stringify(imported)).not.toContain('imported-secret');
    expect(Array.from(secrets.values()).join('\n')).toContain('imported-secret');

    const retained = await ZedAuthProvider.normalizeOnImport(
      { method: 'zed' },
      {
        secretStore,
        storeSecretsInSettings: false,
        existing: { method: 'zed', identityId: 'existing-identity' },
      },
    );
    expect(retained.identityId).toBeUndefined();

    const provider = new ZedAuthProvider(
      {
        providerId: 'Imported Zed',
        providerLabel: 'Imported Zed',
        secretStore,
        persistAuthConfig: async () => undefined,
      },
      { ...imported, baseUrl: 'https://zed.dev' },
    );
    await provider.revoke();
    expect(Array.from(secrets.values()).join('\n')).not.toContain(
      'imported-secret',
    );
  });

  it('revokes a long-lived credential on account HTTP 401', async () => {
    const secrets = new Map<string, string>();
    const secretStore = new SecretStore({
      get: async (key: string) => secrets.get(key),
      store: async (key: string, value: string) => void secrets.set(key, value),
      delete: async (key: string) => void secrets.delete(key),
      keys: async () => Array.from(secrets.keys()),
      onDidChange: () => ({ dispose: () => undefined }),
    });
    const tokenRef = secretStore.createRef();
    await secretStore.setOAuth2Token(tokenRef, {
      accessToken: JSON.stringify({
        userId: 'user-id',
        accessToken: 'revoked-secret',
      }),
      tokenType: 'Zed',
    });
    vi.stubGlobal(
      'fetch',
      async () => new Response('unauthorized', { status: 401 }),
    );

    const persisted: AuthConfig[] = [];
    const provider = new ZedAuthProvider(
      {
        providerId: 'Revoked Zed',
        providerLabel: 'Revoked Zed',
        secretStore,
        persistAuthConfig: async (config) => void persisted.push(config),
      },
      {
        method: 'zed',
        baseUrl: 'https://zed.dev',
        identityId: 'identity',
        token: tokenRef,
        organizationId: 'org',
        dataCollection: true,
        dataCollectionAllowed: true,
        email: 'zed@example.com',
      },
    );
    const statuses: string[] = [];
    provider.onDidChangeStatus(({ status }) => statuses.push(status));

    await expect(provider.getCredential()).resolves.toBeUndefined();
    expect(persisted.at(-1)).toEqual({
      method: 'zed',
      label: undefined,
      description: undefined,
      baseUrl: 'https://zed.dev',
      identityId: undefined,
      token: undefined,
      organizationId: undefined,
      dataCollection: false,
      dataCollectionAllowed: false,
      email: undefined,
    });
    expect(statuses).toEqual(['revoked']);
    expect(Array.from(secrets.values()).join('\n')).not.toContain(
      'revoked-secret',
    );
    expect(secrets.get('ucp:state:zed-system-id-v1')).toBeTruthy();
  });

  it('keeps a long-lived credential on account HTTP 403', async () => {
    const secrets = new Map<string, string>();
    const secretStore = new SecretStore({
      get: async (key: string) => secrets.get(key),
      store: async (key: string, value: string) => void secrets.set(key, value),
      delete: async (key: string) => void secrets.delete(key),
      keys: async () => Array.from(secrets.keys()),
      onDidChange: () => ({ dispose: () => undefined }),
    });
    const tokenRef = secretStore.createRef();
    await secretStore.setOAuth2Token(tokenRef, {
      accessToken: JSON.stringify({
        userId: 'user-id',
        accessToken: 'retained-secret',
      }),
      tokenType: 'Zed',
    });
    vi.stubGlobal('fetch', async () => new Response('forbidden', { status: 403 }));

    const persisted: AuthConfig[] = [];
    const provider = new ZedAuthProvider(
      {
        providerId: 'Forbidden Zed',
        providerLabel: 'Forbidden Zed',
        secretStore,
        persistAuthConfig: async (config) => void persisted.push(config),
      },
      {
        method: 'zed',
        baseUrl: 'https://zed.dev',
        identityId: 'identity',
        token: tokenRef,
        organizationId: 'org',
      },
    );

    await expect(provider.getCredential()).rejects.toThrow(
      'Zed account lookup failed with HTTP 403',
    );
    expect(persisted).toEqual([]);
    expect(Array.from(secrets.values()).join('\n')).toContain(
      'retained-secret',
    );
  });
});

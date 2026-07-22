import type * as vscode from 'vscode';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({
  env: { language: 'en' },
  l10n: { t: (message: string) => message },
}));

vi.mock('../../src/logger', () => ({
  authLog: {
    error: vi.fn(),
    verbose: vi.fn(),
    warn: vi.fn(),
  },
}));

import { SecretStore } from '../../src/secret/secret-store';
import {
  getZedSystemId,
  ZedAuthSessionCache,
} from '../../src/auth/providers/zed/session-cache';
import type { ZedFetch } from '../../src/client/zed/types';

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolvePromise: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve(value) {
      resolvePromise?.(value);
    },
  };
}

function accountResponse(): Response {
  return new Response(
    JSON.stringify({
      user: {
        id_v2: 'user',
        username: 'zed-user',
        email: 'zed@example.com',
      },
      organizations: [
        { id: 'org-a', name: 'A', is_personal: true },
        { id: 'org-b', name: 'B', is_personal: false },
      ],
      default_organization_id: 'org-a',
      configuration_by_organization: {
        'org-a': {
          edit_prediction: {
            is_enabled: true,
            is_feedback_enabled: true,
          },
        },
        'org-b': {
          edit_prediction: {
            is_enabled: true,
            is_feedback_enabled: false,
          },
        },
      },
    }),
    { status: 200 },
  );
}

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

afterEach(() => vi.unstubAllGlobals());

describe('Zed auth session cache', () => {
  it('selects the default organization and invalidates its LLM token on switch', async () => {
    const accountRequests: string[] = [];
    const tokenRequests: string[] = [];
    const settingsUpdates: string[] = [];
    const fetcher: ZedFetch = async (input, init) => {
      const url = new URL(input.toString());
      expect(new Headers(init?.headers).get('authorization')).toBe(
        'user-id long-lived-secret',
      );
      expect(new Headers(init?.headers).get('x-zed-system-id')).toBe(
        'system-id',
      );
      if (url.pathname === '/client/users/me') {
        accountRequests.push(url.pathname);
        return accountResponse();
      }
      if (url.pathname === '/client/system_settings') {
        const body = JSON.parse(String(init?.body)) as {
          selected_organization_id: string;
        };
        settingsUpdates.push(body.selected_organization_id);
        return new Response('{}', { status: 200 });
      }
      if (url.pathname === '/client/llm_tokens') {
        const body = JSON.parse(String(init?.body)) as {
          organization_id: string;
        };
        tokenRequests.push(body.organization_id);
        return new Response(
          JSON.stringify({
            token: `${body.organization_id}-token-${tokenRequests.length}`,
          }),
          { status: 200 },
        );
      }
      throw new Error(`Unexpected Zed request: ${url.pathname}`);
    };
    vi.stubGlobal('fetch', fetcher);

    const cache = new ZedAuthSessionCache(
      'https://zed.dev',
      { userId: 'user-id', accessToken: 'long-lived-secret' },
      'system-id',
    );
    const initial = await cache.ensureAccount(undefined);
    expect(initial).toMatchObject({
      configuredOrganizationChanged: true,
      user: { email: 'zed@example.com' },
      organization: {
        id: 'org-a',
        editPrediction: { isEnabled: true, isFeedbackEnabled: true },
      },
    });
    await cache.ensureAccount('org-a');
    expect(accountRequests).toEqual(['/client/users/me']);
    expect(settingsUpdates).toEqual(['org-a']);

    expect(await cache.getLlmToken('org-a')).toBe('org-a-token-1');
    expect(await cache.getLlmToken('org-a')).toBe('org-a-token-1');
    expect(tokenRequests).toEqual(['org-a']);

    const switched = await cache.selectOrganization('org-b', 'org-a');
    expect(switched).toMatchObject({
      configuredOrganizationChanged: true,
      organization: {
        id: 'org-b',
        editPrediction: { isFeedbackEnabled: false },
      },
    });
    expect(settingsUpdates).toEqual(['org-a', 'org-b']);
    expect(await cache.getLlmToken('org-b')).toBe('org-b-token-2');
    expect(tokenRequests).toEqual(['org-a', 'org-b']);
  });

  it('does not let an old organization token promise overwrite the new cache', async () => {
    const oldToken = deferred<Response>();
    const oldRequestStarted = deferred<void>();
    const fetcher: ZedFetch = async (input, init) => {
      const url = new URL(input.toString());
      if (url.pathname === '/client/users/me') return accountResponse();
      if (url.pathname === '/client/system_settings') {
        return new Response('{}', { status: 200 });
      }
      if (url.pathname === '/client/llm_tokens') {
        const body = JSON.parse(String(init?.body)) as {
          organization_id: string;
        };
        if (body.organization_id === 'org-a') {
          oldRequestStarted.resolve();
          return oldToken.promise;
        }
        return new Response(JSON.stringify({ token: 'org-b-token' }), {
          status: 200,
        });
      }
      throw new Error(`Unexpected Zed request: ${url.pathname}`);
    };
    vi.stubGlobal('fetch', fetcher);

    const cache = new ZedAuthSessionCache(
      'https://zed.dev',
      { userId: 'user-id', accessToken: 'long-lived-secret' },
      'system-id',
    );
    await cache.ensureAccount('org-a');
    const stale = cache.getLlmToken('org-a');
    await oldRequestStarted.promise;
    await cache.selectOrganization('org-b', 'org-a');
    expect(await cache.getLlmToken('org-b')).toBe('org-b-token');

    oldToken.resolve(
      new Response(JSON.stringify({ token: 'org-a-token' }), { status: 200 }),
    );
    expect(await stale).toBe('org-a-token');
    expect(await cache.getLlmToken('org-b')).toBe('org-b-token');
  });

  it('persists one stable system id in device SecretStorage', async () => {
    const storage = new MemorySecretStorage();
    const first = await getZedSystemId(new SecretStore(storage));
    const second = await getZedSystemId(new SecretStore(storage));

    expect(second).toBe(first);
    expect(storage.values.get('ucp:state:zed-system-id-v1')).toBe(first);
    expect(first).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });
});

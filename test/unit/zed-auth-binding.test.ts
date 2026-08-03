import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => {
  class Disposable {
    dispose(): void {}
  }
  class EventEmitter<T> {
    readonly event = (_listener: (event: T) => void) => new Disposable();
    fire(_event: T): void {}
    dispose(): void {}
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
    workspace: {
      getConfiguration: () => ({
        get: <T>(_key: string, fallback: T): T => fallback,
      }),
    },
    window: {},
  };
});

import { normalizeAuthForProvider } from '../../src/auth/definitions';
import type { ZedAuthConfig } from '../../src/auth/types';

const OLD_TOKEN = '$UCPSECRET:00000000-0000-4000-8000-000000000001$';
const NEW_TOKEN = '$UCPSECRET:00000000-0000-4000-8000-000000000002$';
const BINDING_ID = '00000000-0000-4000-8000-000000000104';

function zedAuth(
  baseUrl: string,
  identityId: string,
  token: string,
): ZedAuthConfig {
  return {
    method: 'zed',
    bindingId: BINDING_ID,
    baseUrl,
    identityId,
    token,
    organizationId: 'org',
    dataCollection: true,
    dataCollectionAllowed: true,
    email: 'zed@example.com',
  };
}

describe('auth provider binding', () => {
  it('seeds provider-owned data before a new Zed sign-in', () => {
    expect(
      normalizeAuthForProvider(
        undefined,
        { providerType: 'zed', baseUrl: 'https://zed.example' },
        'zed',
      ),
    ).toMatchObject({
      method: 'zed',
      baseUrl: 'https://zed.example',
      dataCollection: false,
      dataCollectionAllowed: false,
    });
  });

  it('clears a credential retained across a provider site change', () => {
    const previous = zedAuth('https://zed.dev', 'old-identity', OLD_TOKEN);
    const retained = {
      ...previous,
      baseUrl: 'https://zed.example',
    };

    expect(
      normalizeAuthForProvider(retained, {
        providerType: 'zed',
        baseUrl: 'https://zed.example',
        previousProviderType: 'zed',
        previousBaseUrl: 'https://zed.dev',
        previousAuth: previous,
      }),
    ).toEqual({
      method: 'zed',
      bindingId: BINDING_ID,
      label: undefined,
      description: undefined,
      baseUrl: 'https://zed.example',
      dataCollection: false,
      dataCollectionAllowed: false,
    });
  });

  it('keeps a credential created by signing in to the new site', () => {
    const previous = zedAuth('https://zed.dev', 'old-identity', OLD_TOKEN);
    const next = zedAuth('https://zed.example', 'new-identity', NEW_TOKEN);

    expect(
      normalizeAuthForProvider(next, {
        providerType: 'zed',
        baseUrl: 'https://zed.example',
        previousProviderType: 'zed',
        previousBaseUrl: 'https://zed.dev',
        previousAuth: previous,
      }),
    ).toBe(next);
  });

  it('fails closed when the authentication site URL is invalid', () => {
    const auth = zedAuth('not-a-url', 'identity', NEW_TOKEN);

    expect(
      normalizeAuthForProvider(auth, {
        providerType: 'zed',
        baseUrl: 'https://zed.example',
      }),
    ).not.toHaveProperty('token');
  });

  it('leaves auth methods without a binding policy unchanged', () => {
    const auth = { method: 'api-key' as const, apiKey: 'secret' };
    expect(
      normalizeAuthForProvider(auth, {
        providerType: 'openai-chat-completion',
        baseUrl: 'https://api.example.com',
      }),
    ).toBe(auth);
  });
});

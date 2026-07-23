import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({
  Disposable: class Disposable {
    constructor(private readonly callback: () => void = () => undefined) {}
    dispose(): void {
      this.callback();
    }
  },
  EventEmitter: class EventEmitter<T> {
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
  },
  env: { language: 'en' },
  l10n: { t: (message: string) => message },
}));

vi.mock('../../src/logger', () => ({
  authLog: {
    error: vi.fn(),
    verbose: vi.fn(),
  },
}));

vi.mock('../../src/utils', () => ({
  generatePKCE: vi.fn(),
}));

import {
  getClientCredentialsToken,
  startDeviceCodeFlow,
} from '../../src/auth/providers/oauth2/oauth2-client';
import {
  extractAccountIdFromClaims,
  parseJwtClaims,
} from '../../src/auth/providers/openai-codex/oauth-client';
import { refreshAccessToken } from '../../src/auth/providers/antigravity-oauth/oauth-client';
import { refreshGeminiCliAccessToken } from '../../src/auth/providers/google-gemini-oauth/oauth-client';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('OAuth response compatibility', () => {
  it('accepts numeric-string durations and ignores malformed optional fields', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_000);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            access_token: 'access',
            expires_in: '3600',
            token_type: { unexpected: true },
          }),
          { status: 200 },
        ),
      ),
    );

    const token = await getClientCredentialsToken({
      grantType: 'client_credentials',
      tokenUrl: 'https://identity.example.test/token',
      clientId: 'client',
      clientSecret: 'secret',
    });

    expect(token).toEqual({
      accessToken: 'access',
      tokenType: 'Bearer',
      refreshToken: undefined,
      expiresAt: 3_601_000,
      scope: undefined,
    });
  });

  it('preserves client secret bytes in client-credentials requests', async () => {
    const fetcher = vi.fn(
      async (_input: string | URL | Request, init?: RequestInit) => {
        const request =
          _input instanceof Request && init === undefined
            ? _input
            : new Request(_input, init);
        const body = new URLSearchParams(await request.text());
        expect(body.get('client_secret')).toBe('  secret with spaces  ');
        return new Response(
          JSON.stringify({ access_token: 'access', token_type: '  Custom  ' }),
          { status: 200 },
        );
      },
    );
    vi.stubGlobal('fetch', fetcher);

    await expect(
      getClientCredentialsToken({
        grantType: 'client_credentials',
        tokenUrl: 'https://identity.example.test/token',
        clientId: 'client',
        clientSecret: '  secret with spaces  ',
      }),
    ).resolves.toMatchObject({
      accessToken: 'access',
      tokenType: '  Custom  ',
    });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('accepts numeric-string device-code timing fields', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            device_code: 'device',
            user_code: 'user',
            verification_uri: 'https://identity.example.test/verify',
            verification_uri_complete: 7,
            expires_in: '600',
            interval: '2',
          }),
          { status: 200 },
        ),
      ),
    );

    await expect(
      startDeviceCodeFlow({
        grantType: 'device_code',
        deviceAuthorizationUrl: 'https://identity.example.test/device',
        tokenUrl: 'https://identity.example.test/token',
        clientId: 'client',
      }),
    ).resolves.toEqual({
      deviceCode: 'device',
      userCode: 'user',
      verificationUri: 'https://identity.example.test/verify',
      expiresIn: 600,
      interval: 2,
    });
  });

  it('preserves numeric-string expiry compatibility for Google OAuth refreshes', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_000);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            access_token: 'access',
            expires_in: '3600',
            token_type: 'Bearer',
          }),
          { status: 200 },
        ),
      ),
    );

    await expect(
      refreshAccessToken({ refreshToken: 'refresh' }),
    ).resolves.toMatchObject({ expiresAt: 3_601_000 });
    await expect(
      refreshGeminiCliAccessToken({ refreshToken: 'refresh' }),
    ).resolves.toMatchObject({ expiresAt: 3_601_000 });
  });

  it('keeps usable Codex claims when unrelated optional claims are malformed', () => {
    const payload = Buffer.from(
      JSON.stringify({
        chatgpt_account_id: 'account',
        email: 7,
        exp: 123,
        organizations: [null, { id: 3 }, { id: 'fallback' }],
        'https://api.openai.com/auth': 'invalid',
      }),
    ).toString('base64url');
    const claims = parseJwtClaims(`header.${payload}.signature`);

    expect(claims).toEqual({
      chatgpt_account_id: 'account',
      exp: 123,
      organizations: [{ id: 'fallback' }],
    });
    expect(claims && extractAccountIdFromClaims(claims)).toBe('account');
  });
});

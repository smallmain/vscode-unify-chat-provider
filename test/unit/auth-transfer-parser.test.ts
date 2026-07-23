import { describe, expect, it } from 'vitest';
import { parseAuthTransferConfig } from '../../src/auth/auth-transfer-parser';
import { isSessionAuthConfig } from '../../src/auth/local-auth-state';

const EXPORTED_BINDING_ID = '00000000-0000-4000-8000-000000000701';

describe('auth transfer parser', () => {
  it('accepts sensitive session transfers and always assigns a new binding', () => {
    const parsed = parseAuthTransferConfig({
      method: 'oauth2',
      bindingId: EXPORTED_BINDING_ID,
      identityId: 'session-1',
      token: JSON.stringify({
        accessToken: 'access-token',
        refreshToken: 'refresh-token',
        tokenType: 'Bearer',
      }),
      oauth: {
        grantType: 'authorization_code',
        authorizationUrl: 'https://identity.example.test/authorize',
        tokenUrl: 'https://identity.example.test/token',
        clientId: 'client-id',
        clientSecret: 'client-secret',
        redirectUri: 'http://localhost/callback',
        scopes: ['scope-a'],
        pkce: true,
      },
    });

    expect(parsed).toMatchObject({
      method: 'oauth2',
      identityId: 'session-1',
      oauth: {
        grantType: 'authorization_code',
        clientSecret: 'client-secret',
      },
    });
    expect(parsed && isSessionAuthConfig(parsed)).toBe(true);
    if (!parsed || !isSessionAuthConfig(parsed)) {
      throw new Error('Expected parsed session auth.');
    }
    expect(parsed.bindingId).not.toBe(EXPORTED_BINDING_ID);
  });

  it.each([
    { method: 'none' },
    { method: 'api-key', apiKey: 'api-key' },
    {
      method: 'google-vertex-ai-auth',
      subType: 'adc',
      projectId: 'project',
      location: 'us-central1',
    },
    {
      method: 'google-vertex-ai-auth',
      subType: 'service-account',
      keyFilePath: '/tmp/key.json',
      location: 'us-central1',
    },
    {
      method: 'google-vertex-ai-auth',
      subType: 'api-key',
      apiKey: 'vertex-key',
    },
    {
      method: 'oauth2',
      oauth: {
        grantType: 'client_credentials',
        tokenUrl: 'https://identity.example.test/token',
        clientId: 'client-id',
        clientSecret: 'client-secret',
      },
    },
    {
      method: 'oauth2',
      oauth: {
        grantType: 'device_code',
        deviceAuthorizationUrl: 'https://identity.example.test/device',
        tokenUrl: 'https://identity.example.test/token',
        clientId: 'client-id',
      },
    },
    { method: 'antigravity-oauth', projectId: 'project', tier: 'paid' },
    {
      method: 'google-gemini-oauth',
      oauthType: 'ai_studio',
      email: 'user@example.test',
    },
    { method: 'openai-codex', accountId: 'account-id' },
    { method: 'claude-code', email: 'user@example.test' },
    { method: 'xai-grok-oauth', email: 'user@example.test' },
    { method: 'github-copilot', enterpriseUrl: 'github.example.test' },
    {
      method: 'zed',
      baseUrl: 'https://zed.dev',
      organizationId: 'org-id',
      dataCollection: false,
      dataCollectionAllowed: true,
    },
  ])('accepts supported transfer shape $method', (transfer) => {
    expect(parseAuthTransferConfig(transfer)).not.toBeNull();
  });

  it.each([
    { method: 'future-oauth' },
    { method: 'none', token: 'unexpected' },
    { method: 'api-key', apiKey: 123 },
    {
      method: 'oauth2',
      oauth: {
        grantType: 'authorization_code',
        authorizationUrl: 'https://identity.example.test/authorize',
        tokenUrl: 'https://identity.example.test/token',
      },
    },
    {
      method: 'oauth2',
      oauth: {
        grantType: 'device_code',
        deviceAuthorizationUrl: 'https://identity.example.test/device',
        tokenUrl: 'https://identity.example.test/token',
        clientId: 'client-id',
        futureSecret: 'unexpected',
      },
    },
    {
      method: 'google-vertex-ai-auth',
      subType: 'adc',
      projectId: 'project',
    },
    {
      method: 'google-vertex-ai-auth',
      subType: 'service-account',
      keyFilePath: 123,
      location: 'us-central1',
    },
    {
      method: 'openai-codex',
      bindingId: 'invalid-binding',
    },
    {
      method: 'openai-codex',
      accountId: 'account-id',
      unknownContext: true,
    },
    {
      method: 'openai-codex',
      token: '{invalid-json}',
    },
    {
      method: 'openai-codex',
      token: JSON.stringify({ accessToken: 'access-token' }),
    },
    {
      method: 'openai-codex',
      token: JSON.stringify({
        accessToken: 'access-token',
        tokenType: 'Bearer',
        expiresAt: 'not-a-number',
      }),
    },
  ])('rejects malformed transfer without throwing', (transfer) => {
    expect(() => parseAuthTransferConfig(transfer)).not.toThrow();
    expect(parseAuthTransferConfig(transfer)).toBeNull();
  });
});

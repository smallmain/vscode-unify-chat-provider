import * as vscode from 'vscode';
import { randomBytes, createHash } from 'crypto';
import {
  OAuth2AuthCodeConfig,
  OAuth2ClientCredentialsConfig,
  OAuth2Config,
  OAuth2DeviceCodeConfig,
  OAuth2TokenData,
} from '../../types';
import {
  DeviceCodeResponse,
  OAuth2AuthState,
  PKCEChallenge,
  TokenResponse,
} from './types';
import { t } from '../../../i18n';
import {
  createOAuth2ErrorFromResponse,
  createOAuth2ErrorFromNetworkError,
} from './errors';

/**
 * Generate a random state string for OAuth
 */
export function generateState(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * Generate PKCE challenge
 */
export function generatePKCE(): PKCEChallenge {
  const codeVerifier = randomBytes(32).toString('base64url');
  const hash = createHash('sha256').update(codeVerifier).digest();
  const codeChallenge = hash.toString('base64url');

  return {
    codeVerifier,
    codeChallenge,
    codeChallengeMethod: 'S256',
  };
}

/**
 * Build authorization URL for authorization code flow
 */
export function buildAuthorizationUrl(
  config: OAuth2AuthCodeConfig,
  state: OAuth2AuthState,
): string {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: config.clientId,
    redirect_uri: state.redirectUri,
    state: state.state,
  });

  if (config.scopes && config.scopes.length > 0) {
    params.set('scope', config.scopes.join(' '));
  }

  if (state.pkce) {
    params.set('code_challenge', state.pkce.codeChallenge);
    params.set('code_challenge_method', state.pkce.codeChallengeMethod);
  }

  return `${config.authorizationUrl}?${params.toString()}`;
}

/**
 * Exchange authorization code for tokens
 */
export async function exchangeCodeForToken(
  config: OAuth2AuthCodeConfig,
  code: string,
  state: OAuth2AuthState,
): Promise<OAuth2TokenData> {
  const params = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: config.clientId,
    code,
    redirect_uri: state.redirectUri,
  });

  if (config.clientSecret) {
    params.set('client_secret', config.clientSecret);
  }

  if (state.pkce) {
    params.set('code_verifier', state.pkce.codeVerifier);
  }

  const response = await fetch(config.tokenUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: params.toString(),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(t('Token exchange failed: {0}', error));
  }

  const data = (await response.json()) as TokenResponse;
  return tokenResponseToData(data);
}

/**
 * Get token using client credentials flow
 */
export async function getClientCredentialsToken(
  config: OAuth2ClientCredentialsConfig,
  signal?: AbortSignal,
): Promise<OAuth2TokenData> {
  const params = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: config.clientId,
    client_secret: config.clientSecret,
  });

  if (config.scopes && config.scopes.length > 0) {
    params.set('scope', config.scopes.join(' '));
  }

  let response: Response;
  try {
    response = await fetch(config.tokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
      signal,
    });
  } catch (error) {
    throw createOAuth2ErrorFromNetworkError(error);
  }

  if (!response.ok) {
    throw await createOAuth2ErrorFromResponse(
      response,
      t('Token request failed'),
    );
  }

  const data = (await response.json()) as TokenResponse;
  return tokenResponseToData(data);
}

/**
 * Start device code flow
 */
export async function startDeviceCodeFlow(
  config: OAuth2DeviceCodeConfig,
): Promise<DeviceCodeResponse> {
  const params = new URLSearchParams({
    client_id: config.clientId,
  });

  if (config.scopes && config.scopes.length > 0) {
    params.set('scope', config.scopes.join(' '));
  }

  const response = await fetch(config.deviceAuthorizationUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: params.toString(),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(t('Device authorization failed: {0}', error));
  }

  const data = await response.json();
  return {
    deviceCode: data.device_code,
    userCode: data.user_code,
    verificationUri: data.verification_uri,
    verificationUriComplete: data.verification_uri_complete,
    expiresIn: data.expires_in,
    interval: data.interval || 5,
  };
}

/**
 * Poll for device code token
 */
export async function pollDeviceCodeToken(
  config: OAuth2DeviceCodeConfig,
  deviceCode: string,
  token: vscode.CancellationToken,
): Promise<OAuth2TokenData | null> {
  const params = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    client_id: config.clientId,
    device_code: deviceCode,
  });

  const response = await fetch(config.tokenUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: params.toString(),
  });

  if (token.isCancellationRequested) {
    return null;
  }

  if (!response.ok) {
    const data = await response.json();
    const error = data.error;

    if (error === 'authorization_pending') {
      // User hasn't completed authorization yet
      return null;
    }

    if (error === 'slow_down') {
      // Need to slow down polling
      return null;
    }

    if (error === 'expired_token') {
      throw new Error(t('Device code expired. Please try again.'));
    }

    if (error === 'access_denied') {
      throw new Error(t('Authorization was denied.'));
    }

    throw new Error(t('Token request failed: {0}', data.error_description || error));
  }

  const data = (await response.json()) as TokenResponse;
  return tokenResponseToData(data);
}

/**
 * Refresh an access token
 */
export async function refreshToken(
  config: OAuth2Config,
  refreshTokenValue: string,
  signal?: AbortSignal,
): Promise<OAuth2TokenData> {
  if (config.grantType === 'device_code') {
    throw new Error('Device code flow does not support refresh tokens');
  }

  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshTokenValue,
  });

  if ('clientId' in config) {
    params.set('client_id', config.clientId);
  }

  if ('clientSecret' in config && config.clientSecret) {
    params.set('client_secret', config.clientSecret);
  }

  let response: Response;
  try {
    response = await fetch(config.tokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
      signal,
    });
  } catch (error) {
    throw createOAuth2ErrorFromNetworkError(error);
  }

  if (!response.ok) {
    throw await createOAuth2ErrorFromResponse(
      response,
      t('Token refresh failed'),
    );
  }

  const data = (await response.json()) as TokenResponse;
  return tokenResponseToData(data);
}

export type OAuth2RevocationTokenTypeHint = 'access_token' | 'refresh_token';

/**
 * Revoke a token via OAuth2 revocation endpoint, if configured.
 * Best-effort: callers may choose to swallow errors.
 */
export async function revokeToken(
  config: OAuth2Config,
  tokenValue: string,
  hint: OAuth2RevocationTokenTypeHint,
  signal?: AbortSignal,
): Promise<void> {
  const revocationUrl = config.revocationUrl;
  if (!revocationUrl) {
    return;
  }

  const params = new URLSearchParams({
    token: tokenValue,
    token_type_hint: hint,
  });

  if ('clientId' in config) {
    params.set('client_id', config.clientId);
  }

  if ('clientSecret' in config && config.clientSecret) {
    params.set('client_secret', config.clientSecret);
  }

  let response: Response;
  try {
    response = await fetch(revocationUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
      signal,
    });
  } catch (error) {
    throw createOAuth2ErrorFromNetworkError(error);
  }

  if (!response.ok) {
    throw await createOAuth2ErrorFromResponse(
      response,
      t('Token revocation failed'),
    );
  }
}

/**
 * Convert token response to OAuth2TokenData
 */
function tokenResponseToData(response: TokenResponse): OAuth2TokenData {
  return {
    accessToken: response.access_token,
    tokenType: response.token_type || 'Bearer',
    refreshToken: response.refresh_token,
    expiresAt: response.expires_in
      ? Date.now() + response.expires_in * 1000
      : undefined,
    scope: response.scope,
  };
}

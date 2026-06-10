import { randomBytes } from 'node:crypto';
import {
  XAI_GROK_OAUTH_AUTHORIZE_URL,
  XAI_GROK_OAUTH_CLIENT_ID,
  XAI_GROK_OAUTH_DISCOVERY_URL,
  XAI_GROK_OAUTH_PLAN,
  XAI_GROK_OAUTH_REDIRECT_URI,
  XAI_GROK_OAUTH_REFERRER,
  XAI_GROK_OAUTH_SCOPE,
  XAI_GROK_OAUTH_TOKEN_URL,
} from './constants';
import { authLog } from '../../../logger';
import { generatePKCE, type PKCEChallenge } from '../../../utils';

function normalizeTokenType(raw: string | undefined): string {
  const trimmed = raw?.trim();
  if (!trimmed) {
    return 'Bearer';
  }
  return trimmed.toLowerCase() === 'bearer' ? 'Bearer' : trimmed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function pickString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}

function pickNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === 'number' ? value : undefined;
}

export interface XaiGrokAuthorization {
  url: string;
  verifier: string;
  challenge: string;
  state: string;
  nonce: string;
  redirectUri: string;
}

export function authorizeXaiGrok(): XaiGrokAuthorization {
  const pkce: PKCEChallenge<'S256'> = generatePKCE(64);
  const state = generateOAuthState();
  const nonce = generateOAuthNonce();
  const redirectUri = XAI_GROK_OAUTH_REDIRECT_URI;

  // We validate against discovery but force the known authorize URL + referrer/plan
  // to match Hermes / OpenCode / opencode-grok-auth exactly for the public client.
  const url = new URL(XAI_GROK_OAUTH_AUTHORIZE_URL);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', XAI_GROK_OAUTH_CLIENT_ID);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('scope', XAI_GROK_OAUTH_SCOPE);
  url.searchParams.set('code_challenge', pkce.challenge);
  url.searchParams.set('code_challenge_method', pkce.method);
  url.searchParams.set('state', state);
  url.searchParams.set('nonce', nonce);
  url.searchParams.set('plan', XAI_GROK_OAUTH_PLAN);
  url.searchParams.set('referrer', XAI_GROK_OAUTH_REFERRER);

  return {
    url: url.toString(),
    verifier: pkce.verifier,
    challenge: pkce.challenge,
    state,
    nonce,
    redirectUri,
  };
}

export interface XaiDiscovery {
  authorizationEndpoint: string;
  tokenEndpoint: string;
}

export async function discoverXaiOAuth(fetchImpl: typeof fetch = fetch): Promise<XaiDiscovery> {
  const response = await fetchImpl(XAI_GROK_OAUTH_DISCOVERY_URL, {
    headers: { Accept: 'application/json' },
  });

  if (!response.ok) {
    throw new Error(`xAI OIDC discovery failed with HTTP ${response.status}.`);
  }

  const payload: unknown = await response.json();
  if (!isRecord(payload)) {
    throw new Error('xAI OIDC discovery returned invalid payload.');
  }

  const authorizationEndpoint = pickString(payload, 'authorization_endpoint')?.trim();
  const tokenEndpoint = pickString(payload, 'token_endpoint')?.trim();

  if (!authorizationEndpoint || !tokenEndpoint) {
    throw new Error('xAI OIDC discovery did not include authorization and token endpoints.');
  }

  return {
    authorizationEndpoint: validateXaiOAuthEndpoint(authorizationEndpoint, 'authorization_endpoint'),
    tokenEndpoint: validateXaiOAuthEndpoint(tokenEndpoint, 'token_endpoint'),
  };
}

export function validateXaiOAuthEndpoint(url: string, field = 'endpoint'): string {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:') {
    throw new Error(`xAI OAuth discovery returned a non-HTTPS ${field}: ${url}`);
  }
  const host = parsed.hostname.toLowerCase();
  if (host !== 'x.ai' && !host.endsWith('.x.ai')) {
    throw new Error(`xAI OAuth discovery ${field} host ${host} is not on xAI's origin.`);
  }
  return url;
}

type XaiTokenResponse = {
  accessToken: string;
  refreshToken: string;
  tokenType: string;
  expiresAt?: number;
  idToken?: string;
};

function parseIdTokenEmail(idToken: string | undefined): string | undefined {
  if (!idToken) return undefined;
  const parts = idToken.split('.');
  if (parts.length !== 3) return undefined;
  try {
    const json = Buffer.from(parts[1], 'base64url').toString('utf8');
    const claims: unknown = JSON.parse(json);
    if (!isRecord(claims)) return undefined;
    const email = pickString(claims, 'email')?.trim();
    return email && email.length > 0 ? email : undefined;
  } catch {
    return undefined;
  }
}

function parseTokenResponse(
  payload: unknown,
  startedAt: number,
  fallbackRefreshToken = '',
): XaiTokenResponse {
  if (!isRecord(payload)) {
    throw new Error('Invalid token response');
  }

  const accessToken = pickString(payload, 'access_token')?.trim();
  if (!accessToken) {
    throw new Error('Missing access token in response');
  }

  const refreshToken =
    pickString(payload, 'refresh_token')?.trim() || fallbackRefreshToken;
  if (!refreshToken) {
    throw new Error('Missing refresh token in response');
  }

  const tokenType = normalizeTokenType(pickString(payload, 'token_type'));
  const expiresIn = pickNumber(payload, 'expires_in');
  const expiresAt =
    typeof expiresIn === 'number' && Number.isFinite(expiresIn)
      ? startedAt + expiresIn * 1000
      : undefined;

  const idToken = pickString(payload, 'id_token')?.trim() || undefined;

  return {
    accessToken,
    refreshToken,
    tokenType,
    expiresAt,
    idToken,
  };
}

export type XaiGrokTokenExchangeResult =
  | ({ type: 'success' } & XaiTokenResponse & { email?: string })
  | { type: 'failed'; error: string };

export async function exchangeXaiGrokCode(options: {
  code: string;
  redirectUri: string;
  verifier: string;
  codeChallenge: string;
  tokenEndpoint?: string; // if not provided, use discovery or fallback const
}): Promise<XaiGrokTokenExchangeResult> {
  authLog.verbose('xai-grok-oauth-client', 'Exchanging authorization code for tokens');

  let tokenEndpoint = options.tokenEndpoint?.trim();
  if (!tokenEndpoint) {
    try {
      const discovered = await discoverXaiOAuth();
      tokenEndpoint = discovered.tokenEndpoint;
    } catch {
      tokenEndpoint = XAI_GROK_OAUTH_TOKEN_URL;
    }
  }
  if (!tokenEndpoint) {
    throw new Error('Failed to determine xAI token endpoint');
  }
  tokenEndpoint = validateXaiOAuthEndpoint(tokenEndpoint, 'token_endpoint');

  const startedAt = Date.now();
  const response = await fetch(tokenEndpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: options.code,
      redirect_uri: options.redirectUri,
      client_id: XAI_GROK_OAUTH_CLIENT_ID,
      code_verifier: options.verifier,
      code_challenge: options.codeChallenge,
      code_challenge_method: 'S256',
    }).toString(),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    authLog.error(
      'xai-grok-oauth-client',
      `Token exchange failed (status: ${response.status})`,
      errorText,
    );
    return {
      type: 'failed',
      error: errorText || `Token exchange failed: ${response.status}`,
    };
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return { type: 'failed', error: 'Failed to parse token response' };
  }

  try {
    const parsed = parseTokenResponse(payload, startedAt);
    const email = parseIdTokenEmail(parsed.idToken);
    return { type: 'success', ...parsed, email };
  } catch (error) {
    return {
      type: 'failed',
      error: error instanceof Error ? error.message : 'Invalid token response',
    };
  }
}

export type XaiGrokTokenRefreshResult =
  | ({ type: 'success' } & XaiTokenResponse & { email?: string })
  | { type: 'failed'; error: string };

export async function refreshXaiGrokToken(options: {
  refreshToken: string;
  tokenEndpoint?: string;
}): Promise<XaiGrokTokenRefreshResult> {
  authLog.verbose('xai-grok-oauth-client', 'Refreshing access token');

  const refreshToken = options.refreshToken.trim();
  if (!refreshToken) {
    return { type: 'failed', error: 'Missing refresh token' };
  }

  let tokenEndpoint = options.tokenEndpoint?.trim();
  if (!tokenEndpoint) {
    try {
      const discovered = await discoverXaiOAuth();
      tokenEndpoint = discovered.tokenEndpoint;
    } catch {
      tokenEndpoint = XAI_GROK_OAUTH_TOKEN_URL;
    }
  }
  if (!tokenEndpoint) {
    throw new Error('Failed to determine xAI token endpoint');
  }
  tokenEndpoint = validateXaiOAuthEndpoint(tokenEndpoint, 'token_endpoint');

  const startedAt = Date.now();
  const response = await fetch(tokenEndpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: XAI_GROK_OAUTH_CLIENT_ID,
      refresh_token: refreshToken,
    }).toString(),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    authLog.error(
      'xai-grok-oauth-client',
      `Token refresh failed (status: ${response.status})`,
      errorText,
    );
    return {
      type: 'failed',
      error: errorText || `Token refresh failed: ${response.status}`,
    };
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return { type: 'failed', error: 'Failed to parse refresh response' };
  }

  try {
    const parsed = parseTokenResponse(payload, startedAt, refreshToken);
    const email = parseIdTokenEmail(parsed.idToken);
    return { type: 'success', ...parsed, email };
  } catch (error) {
    return {
      type: 'failed',
      error: error instanceof Error ? error.message : 'Invalid refresh response',
    };
  }
}

export type CallbackResult =
  | { type: 'success'; code: string }
  | { type: 'cancel' }
  | { type: 'error'; error: string };

export function parseXaiGrokCallbackInput(
  input: string,
  expectedState: string,
): CallbackResult {
  const raw = input.trim();
  if (!raw) {
    return { type: 'error', error: 'Missing authorization code.' };
  }

  let code = raw;
  let state = expectedState;

  try {
    const url = new URL(raw);
    const oauthError = url.searchParams.get('error');
    if (oauthError) {
      return {
        type: 'error',
        error: url.searchParams.get('error_description') ?? oauthError,
      };
    }
    code = url.searchParams.get('code') ?? '';
    state = url.searchParams.get('state') ?? '';
  } catch {
    // bare code or query fragment; keep expected state
  }

  if (!code) {
    return { type: 'error', error: 'Missing authorization code in callback.' };
  }
  if (state !== expectedState) {
    return { type: 'error', error: 'OAuth state mismatch.' };
  }

  return { type: 'success', code };
}

function generateOAuthState(): string {
  // 24 bytes hex is plenty for state
  return randomBytes(24).toString('hex');
}

function generateOAuthNonce(): string {
  return randomBytes(24).toString('hex');
}

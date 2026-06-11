import { createHash, randomBytes } from 'node:crypto';
import {
  OPENAI_CODEX_CLIENT_ID,
  OPENAI_CODEX_ISSUER,
  OPENAI_CODEX_ORIGINATOR,
  OPENAI_CODEX_REDIRECT_URI,
  OPENAI_CODEX_SCOPE,
} from './constants';
import { authLog } from '../../../logger';

function generateState(): string {
  return randomBytes(32).toString('base64url');
}

function generateCodexPKCE(): {
  verifier: string;
  challenge: string;
  method: 'S256';
} {
  const verifier = randomBytes(64).toString('hex');
  const challenge = createHash('sha256')
    .update(verifier, 'utf8')
    .digest('base64url');
  return { verifier, challenge, method: 'S256' };
}

export interface OpenAICodexAuthorization {
  url: string;
  verifier: string;
  state: string;
  redirectUri: string;
}

export function authorizeOpenAICodex(): OpenAICodexAuthorization {
  const pkce = generateCodexPKCE();
  const state = generateState();
  const redirectUri = OPENAI_CODEX_REDIRECT_URI;

  const url = new URL(`${OPENAI_CODEX_ISSUER}/oauth/authorize`);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', OPENAI_CODEX_CLIENT_ID);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('scope', OPENAI_CODEX_SCOPE);
  url.searchParams.set('code_challenge', pkce.challenge);
  url.searchParams.set('code_challenge_method', pkce.method);
  url.searchParams.set('id_token_add_organizations', 'true');
  url.searchParams.set('codex_cli_simplified_flow', 'true');
  url.searchParams.set('state', state);
  url.searchParams.set('originator', OPENAI_CODEX_ORIGINATOR);

  return {
    url: url.toString(),
    verifier: pkce.verifier,
    state,
    redirectUri,
  };
}

type TokenResponse = {
  id_token?: unknown;
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
  token_type?: unknown;
};

function isTokenResponse(value: unknown): value is TokenResponse {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function parseTokenResponse(value: unknown): TokenResponse {
  if (!isTokenResponse(value)) {
    throw new Error('Invalid token response');
  }
  return value;
}

export interface OpenAICodexIdTokenClaims {
  chatgpt_account_id?: string;
  organizations?: Array<{ id: string }>;
  email?: string;
  'https://api.openai.com/auth'?: {
    chatgpt_account_id?: string;
  };
}

export function parseJwtClaims(token: string): OpenAICodexIdTokenClaims | undefined {
  const parts = token.split('.');
  if (parts.length !== 3) {
    return undefined;
  }
  try {
    const json = Buffer.from(parts[1], 'base64url').toString('utf8');
    const parsed: unknown = JSON.parse(json);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return undefined;
    }
    return parsed as OpenAICodexIdTokenClaims;
  } catch {
    return undefined;
  }
}

export function extractAccountIdFromClaims(
  claims: OpenAICodexIdTokenClaims,
): string | undefined {
  return (
    claims.chatgpt_account_id ||
    claims['https://api.openai.com/auth']?.chatgpt_account_id ||
    claims.organizations?.[0]?.id
  );
}

function extractAccountId(tokens: {
  idToken?: string;
  accessToken?: string;
}): string | undefined {
  const fromIdToken = tokens.idToken?.trim();
  if (fromIdToken) {
    const claims = parseJwtClaims(fromIdToken);
    const accountId = claims ? extractAccountIdFromClaims(claims) : undefined;
    if (accountId) return accountId;
  }

  const fromAccessToken = tokens.accessToken?.trim();
  if (fromAccessToken) {
    const claims = parseJwtClaims(fromAccessToken);
    return claims ? extractAccountIdFromClaims(claims) : undefined;
  }

  return undefined;
}

function extractEmail(tokens: { idToken?: string; accessToken?: string }): string | undefined {
  const fromIdToken = tokens.idToken?.trim();
  if (fromIdToken) {
    const claims = parseJwtClaims(fromIdToken);
    const email = claims?.email;
    if (typeof email === 'string' && email.trim()) {
      return email.trim();
    }
  }

  const fromAccessToken = tokens.accessToken?.trim();
  if (fromAccessToken) {
    const claims = parseJwtClaims(fromAccessToken);
    const email = claims?.email;
    if (typeof email === 'string' && email.trim()) {
      return email.trim();
    }
  }

  return undefined;
}

export type OpenAICodexTokenExchangeResult =
  | {
      type: 'success';
      accessToken: string;
      refreshToken: string;
      expiresAt?: number;
      tokenType: string;
      accountId?: string;
      email?: string;
    }
  | { type: 'failed'; error: string };

export async function exchangeOpenAICodexCode(options: {
  code: string;
  redirectUri: string;
  verifier: string;
}): Promise<OpenAICodexTokenExchangeResult> {
  authLog.verbose('openai-codex-client', 'Exchanging authorization code for tokens');
  const response = await fetch(`${OPENAI_CODEX_ISSUER}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: options.code,
      redirect_uri: options.redirectUri,
      client_id: OPENAI_CODEX_CLIENT_ID,
      code_verifier: options.verifier,
    }).toString(),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    authLog.error('openai-codex-client', `Token exchange failed (status: ${response.status})`, errorText);
    return { type: 'failed', error: errorText || `Token exchange failed: ${response.status}` };
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return { type: 'failed', error: 'Failed to parse token response' };
  }

  const tokenPayload = parseTokenResponse(payload);

  const accessToken =
    typeof tokenPayload.access_token === 'string'
      ? tokenPayload.access_token.trim()
      : '';
  const refreshToken =
    typeof tokenPayload.refresh_token === 'string'
      ? tokenPayload.refresh_token.trim()
      : '';
  const idToken =
    typeof tokenPayload.id_token === 'string'
      ? tokenPayload.id_token.trim()
      : undefined;

  if (!accessToken) {
    return { type: 'failed', error: 'Missing access token in response' };
  }
  if (!refreshToken) {
    return { type: 'failed', error: 'Missing refresh token in response' };
  }

  const tokenTypeRaw =
    typeof tokenPayload.token_type === 'string' ? tokenPayload.token_type.trim() : '';
  const tokenType =
    tokenTypeRaw.toLowerCase() === 'bearer' ? 'Bearer' : tokenTypeRaw || 'Bearer';

  const expiresAt =
    typeof tokenPayload.expires_in === 'number'
      ? Date.now() + tokenPayload.expires_in * 1000
      : undefined;

  const accountId = extractAccountId({ idToken, accessToken });
  const email = extractEmail({ idToken, accessToken });

  return {
    type: 'success',
    accessToken,
    refreshToken,
    expiresAt,
    tokenType,
    accountId,
    email,
  };
}

export type OpenAICodexTokenRefreshResult =
  | {
      type: 'success';
      accessToken: string;
      refreshToken: string;
      expiresAt?: number;
      tokenType: string;
      accountId?: string;
      email?: string;
    }
  | { type: 'failed'; error: string };

export async function refreshOpenAICodexToken(options: {
  refreshToken: string;
}): Promise<OpenAICodexTokenRefreshResult> {
  authLog.verbose('openai-codex-client', 'Refreshing access token');
  const response = await fetch(`${OPENAI_CODEX_ISSUER}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: options.refreshToken,
      client_id: OPENAI_CODEX_CLIENT_ID,
      scope: 'openid profile email',
    }).toString(),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    authLog.error('openai-codex-client', `Token refresh failed (status: ${response.status})`, errorText);
    return { type: 'failed', error: errorText || `Token refresh failed: ${response.status}` };
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return { type: 'failed', error: 'Failed to parse token refresh response' };
  }

  const tokenPayload = parseTokenResponse(payload);

  const accessToken =
    typeof tokenPayload.access_token === 'string'
      ? tokenPayload.access_token.trim()
      : '';
  const refreshToken =
    typeof tokenPayload.refresh_token === 'string'
      ? tokenPayload.refresh_token.trim()
      : options.refreshToken;
  const idToken =
    typeof tokenPayload.id_token === 'string'
      ? tokenPayload.id_token.trim()
      : undefined;

  if (!accessToken) {
    return { type: 'failed', error: 'Missing access token in response' };
  }

  const tokenTypeRaw =
    typeof tokenPayload.token_type === 'string' ? tokenPayload.token_type.trim() : '';
  const tokenType =
    tokenTypeRaw.toLowerCase() === 'bearer' ? 'Bearer' : tokenTypeRaw || 'Bearer';

  const expiresAt =
    typeof tokenPayload.expires_in === 'number'
      ? Date.now() + tokenPayload.expires_in * 1000
      : undefined;

  const accountId = extractAccountId({ idToken, accessToken });
  const email = extractEmail({ idToken, accessToken });

  return {
    type: 'success',
    accessToken,
    refreshToken,
    expiresAt,
    tokenType,
    accountId,
    email,
  };
}

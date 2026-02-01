import { createHash, randomBytes } from 'node:crypto';
import {
  CLAUDE_CODE_AUTH_URL,
  CLAUDE_CODE_CLIENT_ID,
  CLAUDE_CODE_REDIRECT_URI,
  CLAUDE_CODE_SCOPE,
  CLAUDE_CODE_TOKEN_URL,
} from './constants';
import { authLog } from '../../../logger';

function generatePkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(96).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

function normalizeTokenType(raw: string | undefined): string {
  const trimmed = raw?.trim();
  if (!trimmed) {
    return 'Bearer';
  }
  return trimmed.toLowerCase() === 'bearer' ? 'Bearer' : trimmed;
}

function parseCodeAndState(code: string): { code: string; state?: string } {
  const hashIndex = code.indexOf('#');
  if (hashIndex === -1) {
    return { code };
  }

  const parsedCode = code.slice(0, hashIndex);
  const parsedState = code.slice(hashIndex + 1).trim();
  return {
    code: parsedCode,
    state: parsedState || undefined,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function pickString(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}

function pickNumber(
  record: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = record[key];
  return typeof value === 'number' ? value : undefined;
}

type ClaudeCodeTokenResponse = {
  accessToken: string;
  refreshToken?: string;
  tokenType: string;
  expiresAt?: number;
  email?: string;
};

function parseTokenResponse(payload: unknown): ClaudeCodeTokenResponse {
  if (!isRecord(payload)) {
    throw new Error('Invalid token response');
  }

  const accessToken = pickString(payload, 'access_token')?.trim();
  if (!accessToken) {
    throw new Error('Missing access token');
  }

  const refreshToken = pickString(payload, 'refresh_token')?.trim() || undefined;
  const tokenType = normalizeTokenType(pickString(payload, 'token_type'));
  const expiresIn = pickNumber(payload, 'expires_in');

  const account = payload['account'];
  const email =
    isRecord(account) ? pickString(account, 'email_address')?.trim() || undefined : undefined;

  const expiresAt =
    typeof expiresIn === 'number' && Number.isFinite(expiresIn)
      ? Date.now() + expiresIn * 1000
      : undefined;

  return { accessToken, refreshToken, tokenType, expiresAt, email };
}

export interface ClaudeCodeAuthorization {
  url: string;
  verifier: string;
  state: string;
  redirectUri: string;
}

export function authorizeClaudeCode(): ClaudeCodeAuthorization {
  const pkce = generatePkce();
  const state = pkce.verifier;
  const redirectUri = CLAUDE_CODE_REDIRECT_URI;

  const url = new URL(CLAUDE_CODE_AUTH_URL);
  url.searchParams.set('code', 'true');
  url.searchParams.set('client_id', CLAUDE_CODE_CLIENT_ID);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('scope', CLAUDE_CODE_SCOPE);
  url.searchParams.set('code_challenge', pkce.challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('state', state);

  return { url: url.toString(), verifier: pkce.verifier, state, redirectUri };
}

export type ClaudeCodeTokenExchangeResult =
  | ({ type: 'success' } & ClaudeCodeTokenResponse)
  | { type: 'failed'; error: string };

export async function exchangeClaudeCodeCode(options: {
  code: string;
  state: string;
  verifier: string;
  redirectUri: string;
}): Promise<ClaudeCodeTokenExchangeResult> {
  authLog.verbose('claude-code-client', 'Exchanging authorization code for tokens');

  const parsed = parseCodeAndState(options.code.trim());
  const state = parsed.state ?? options.state;

  const response = await fetch(CLAUDE_CODE_TOKEN_URL, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      code: parsed.code,
      state,
      grant_type: 'authorization_code',
      client_id: CLAUDE_CODE_CLIENT_ID,
      redirect_uri: options.redirectUri,
      code_verifier: options.verifier,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    authLog.error(
      'claude-code-client',
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
    const parsedToken = parseTokenResponse(payload);
    return { type: 'success', ...parsedToken };
  } catch (error) {
    return {
      type: 'failed',
      error: error instanceof Error ? error.message : 'Invalid token response',
    };
  }
}

export type ClaudeCodeTokenRefreshResult =
  | ({ type: 'success' } & ClaudeCodeTokenResponse)
  | { type: 'failed'; error: string };

export async function refreshClaudeCodeToken(options: {
  refreshToken: string;
}): Promise<ClaudeCodeTokenRefreshResult> {
  authLog.verbose('claude-code-client', 'Refreshing access token');

  const refreshToken = options.refreshToken.trim();
  if (!refreshToken) {
    return { type: 'failed', error: 'Missing refresh token' };
  }

  const response = await fetch(CLAUDE_CODE_TOKEN_URL, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      client_id: CLAUDE_CODE_CLIENT_ID,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    authLog.error(
      'claude-code-client',
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
    const parsedToken = parseTokenResponse(payload);
    return { type: 'success', ...parsedToken };
  } catch (error) {
    return {
      type: 'failed',
      error: error instanceof Error ? error.message : 'Invalid refresh response',
    };
  }
}

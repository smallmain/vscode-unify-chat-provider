/**
 * OAuth client implementation for Gemini CLI authentication.
 *
 * This implements the OAuth 2.0 Authorization Code flow with PKCE
 * using the official Gemini CLI OAuth credentials.
 */

import { createHash, randomBytes } from 'node:crypto';
import {
  GEMINI_CLI_CLIENT_ID,
  GEMINI_CLI_CLIENT_SECRET,
  GEMINI_CLI_SCOPES,
  GEMINI_CLI_ENDPOINT,
  GEMINI_CLI_ENDPOINT_FALLBACKS,
  GEMINI_CLI_API_HEADERS,
  GOOGLE_OAUTH_AUTH_URL,
  GOOGLE_OAUTH_TOKEN_URL,
  GOOGLE_USERINFO_URL,
  getGeminiCliRandomizedHeaders,
} from './constants';
import type {
  GeminiCliAccountInfo,
  GeminiCliAuthState,
  GeminiCliAuthorization,
  GeminiCliTier,
  GeminiCliTokenExchangeResult,
} from './types';
import { authLog } from '../../../logger';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function extractManagedProjectId(value: unknown): string {
  if (typeof value === 'string') {
    return value.trim();
  }
  if (isRecord(value) && typeof value['id'] === 'string') {
    return value['id'].trim();
  }
  return '';
}

function extractTierId(payload: Record<string, unknown>): string | undefined {
  const pickTierId = (tierValue: unknown): string | undefined => {
    if (!isRecord(tierValue) || typeof tierValue['id'] !== 'string') {
      return undefined;
    }
    const id = tierValue['id'].trim();
    return id ? id : undefined;
  };

  const paidTier = pickTierId(payload['paidTier']);
  if (paidTier) {
    return paidTier;
  }
  const paidTierSnake = pickTierId(payload['paid_tier']);
  if (paidTierSnake) {
    return paidTierSnake;
  }

  const currentTier = pickTierId(payload['currentTier']);
  if (currentTier) {
    return currentTier;
  }
  const currentTierSnake = pickTierId(payload['current_tier']);
  if (currentTierSnake) {
    return currentTierSnake;
  }

  return undefined;
}

function extractDefaultTierId(allowedTiers: unknown): string {
  if (!Array.isArray(allowedTiers)) {
    return 'legacy-tier';
  }

  const defaultTier = allowedTiers.find((tier) => {
    return isRecord(tier) && tier['isDefault'] === true;
  });

  if (!defaultTier || !isRecord(defaultTier) || typeof defaultTier['id'] !== 'string') {
    return 'legacy-tier';
  }

  const id = defaultTier['id'].trim();
  return id ? id : 'legacy-tier';
}

function base64UrlEncode(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

function encodeState(payload: GeminiCliAuthState): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

function decodeState(state: string): GeminiCliAuthState {
  const normalized = state.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized.padEnd(
    normalized.length + ((4 - (normalized.length % 4)) % 4),
    '=',
  );
  const json = Buffer.from(padded, 'base64').toString('utf8');
  const parsed: unknown = JSON.parse(json);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Invalid state');
  }
  const record = parsed as Record<string, unknown>;
  const verifier = record['verifier'];
  const redirectUri = record['redirectUri'];
  if (typeof verifier !== 'string' || verifier.trim() === '') {
    throw new Error('Invalid state: missing verifier');
  }
  if (typeof redirectUri !== 'string' || redirectUri.trim() === '') {
    throw new Error('Invalid state: missing redirectUri');
  }
  return {
    verifier,
    redirectUri,
  };
}

function generatePkce(): { verifier: string; challenge: string } {
  const verifier = base64UrlEncode(randomBytes(32));
  const hash = createHash('sha256').update(verifier).digest();
  const challenge = hash.toString('base64url');
  return { verifier, challenge };
}

/**
 * Generate the OAuth authorization URL for Gemini CLI.
 */
export async function authorizeGeminiCli(options: {
  redirectUri: string;
}): Promise<GeminiCliAuthorization> {
  const pkce = generatePkce();

  const redirectUri = options.redirectUri.trim();
  const state = encodeState({ verifier: pkce.verifier, redirectUri });

  const url = new URL(GOOGLE_OAUTH_AUTH_URL);
  url.searchParams.set('client_id', GEMINI_CLI_CLIENT_ID);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('scope', GEMINI_CLI_SCOPES.join(' '));
  url.searchParams.set('code_challenge', pkce.challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('state', state);
  url.searchParams.set('access_type', 'offline');
  url.searchParams.set('prompt', 'consent');

  return {
    url: url.toString(),
    verifier: pkce.verifier,
    redirectUri,
  };
}

type TokenResponse = {
  access_token?: string;
  expires_in?: number;
  refresh_token?: string;
  token_type?: string;
};

type UserInfo = { email?: string };

type OAuthErrorPayload = {
  error?:
    | string
    | {
        code?: string;
        status?: string;
        message?: string;
      };
  error_description?: string;
};

function parseOAuthErrorPayload(text: string | undefined): {
  code?: string;
  description?: string;
} {
  if (!text) {
    return {};
  }

  try {
    const parsed: unknown = JSON.parse(text);
    if (!isRecord(parsed)) {
      return { description: text };
    }

    const payload = parsed as OAuthErrorPayload;
    let code: string | undefined;
    if (typeof payload.error === 'string') {
      code = payload.error;
    } else if (payload.error && typeof payload.error === 'object') {
      code = payload.error.status ?? payload.error.code;
      if (!payload.error_description && payload.error.message) {
        return { code, description: payload.error.message };
      }
    }

    const description = payload.error_description;
    if (description) {
      return { code, description };
    }

    if (
      payload.error &&
      typeof payload.error === 'object' &&
      payload.error.message
    ) {
      return { code, description: payload.error.message };
    }

    return { code };
  } catch {
    return { description: text };
  }
}

export class GeminiCliTokenRefreshError extends Error {
  code?: string;
  description?: string;
  status: number;
  statusText: string;

  constructor(options: {
    message: string;
    code?: string;
    description?: string;
    status: number;
    statusText: string;
  }) {
    super(options.message);
    this.name = 'GeminiCliTokenRefreshError';
    this.code = options.code;
    this.description = options.description;
    this.status = options.status;
    this.statusText = options.statusText;
  }
}

const FETCH_TIMEOUT_MS = 10_000;
const ONBOARD_TIMEOUT_MS = 30_000;
const ONBOARD_MAX_ATTEMPTS = 10;
const ONBOARD_POLL_DELAY_MS = 3_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithTimeout(
  url: string,
  options: RequestInit,
  timeoutMs = FETCH_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Fetch account information after authentication.
 * If loadCodeAssist returns no project ID, attempts to onboard the user.
 */
export async function fetchGeminiCliAccountInfo(
  accessToken: string,
): Promise<GeminiCliAccountInfo> {
  authLog.verbose('gemini-cli-oauth', 'Fetching account info');
  const randomized = getGeminiCliRandomizedHeaders();
  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
    'User-Agent': randomized['User-Agent'],
    'X-Goog-Api-Client': randomized['X-Goog-Api-Client'],
    'Client-Metadata': randomized['Client-Metadata'],
  };

  const metadata = {
    ideType: 'IDE_UNSPECIFIED',
    platform: 'PLATFORM_UNSPECIFIED',
    pluginType: 'GEMINI',
  };

  let detectedTier: GeminiCliTier = 'free';
  let tierId: string | undefined;
  let managedProjectId: string | undefined;

  const loadEndpoints = Array.from(
    new Set<string>([GEMINI_CLI_ENDPOINT, ...GEMINI_CLI_ENDPOINT_FALLBACKS]),
  );

  for (const baseEndpoint of loadEndpoints) {
    try {
      authLog.verbose('gemini-cli-oauth', `Trying endpoint: ${baseEndpoint}`);
      const response = await fetchWithTimeout(`${baseEndpoint}/v1internal:loadCodeAssist`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ metadata }),
      });

      if (!response.ok) {
        authLog.verbose('gemini-cli-oauth', `Endpoint ${baseEndpoint} returned ${response.status}, trying next`);
        continue;
      }

      const data: unknown = await response.json();
      if (!isRecord(data)) {
        continue;
      }

      managedProjectId =
        extractManagedProjectId(data['cloudaicompanionProject']) || undefined;
      tierId = extractTierId(data);
      const defaultTierId = extractDefaultTierId(data['allowedTiers']);
      const effectiveTierId =
        tierId ?? (defaultTierId !== 'legacy-tier' ? defaultTierId : undefined);
      if (effectiveTierId) {
        const lower = effectiveTierId.toLowerCase();
        detectedTier =
          lower.includes('free') || lower.includes('zero') ? 'free' : 'paid';
      }

      // If we got a managed project ID, return immediately
      if (managedProjectId) {
        authLog.verbose(
          'gemini-cli-oauth',
          `Account info fetched (managedProjectId: ${managedProjectId}, tier: ${detectedTier})`,
        );
        return {
          tier: detectedTier,
          tierId: effectiveTierId,
          managedProjectId,
        };
      }

      // No managed project ID from loadCodeAssist, try onboardUser
      authLog.verbose(
        'gemini-cli-oauth',
        `loadCodeAssist returned no projectId; attempting onboardUser (tierId: ${defaultTierId})`,
      );

      const onboardTierId = tierId ?? defaultTierId;
      const onboardRequestBody = JSON.stringify({
        tierId: onboardTierId,
        metadata,
      });

      for (let attempt = 1; attempt <= ONBOARD_MAX_ATTEMPTS; attempt++) {
        authLog.verbose(
          'gemini-cli-oauth',
          `Polling onboardUser (${attempt}/${ONBOARD_MAX_ATTEMPTS}) via ${baseEndpoint}`,
        );

        const onboardResp = await fetchWithTimeout(
          `${baseEndpoint}/v1internal:onboardUser`,
          {
            method: 'POST',
            headers: {
              ...headers,
              ...getGeminiCliRandomizedHeaders(),
            },
            body: onboardRequestBody,
          },
          ONBOARD_TIMEOUT_MS,
        );

        if (!onboardResp.ok) {
          const errorText = await onboardResp.text().catch(() => '');
          authLog.verbose(
            'gemini-cli-oauth',
            `onboardUser failed (status: ${onboardResp.status}): ${errorText}`,
          );
          break;
        }

        const onboardData: unknown = await onboardResp.json();
        if (!isRecord(onboardData)) {
          continue;
        }

        const done = onboardData['done'];
        if (done === true) {
          const responsePayload = onboardData['response'];
          if (!isRecord(responsePayload)) {
            authLog.verbose(
              'gemini-cli-oauth',
              'onboardUser response missing "response" object',
            );
            break;
          }

          const onboardProjectId = extractManagedProjectId(
            responsePayload['cloudaicompanionProject'],
          );
          if (!onboardProjectId) {
            authLog.verbose(
              'gemini-cli-oauth',
              'onboardUser completed without projectId',
            );
            break;
          }

          authLog.verbose(
            'gemini-cli-oauth',
            `onboardUser returned projectId: ${onboardProjectId}`,
          );
          return {
            tier: detectedTier,
            tierId: onboardTierId !== 'legacy-tier' ? onboardTierId : undefined,
            managedProjectId: onboardProjectId,
          };
        }

        await sleep(ONBOARD_POLL_DELAY_MS);
      }
    } catch (error) {
      authLog.verbose('gemini-cli-oauth', `Endpoint ${baseEndpoint} failed with error, trying next`);
      continue;
    }
  }

  authLog.verbose('gemini-cli-oauth', `Account info fetch completed (tier: ${detectedTier}, managedProjectId: ${managedProjectId ?? 'none'})`);
  return {
    tier: detectedTier,
    tierId,
    managedProjectId,
  };
}

/**
 * Exchange authorization code for tokens.
 */
export async function exchangeGeminiCli(options: {
  code: string;
  state: string;
}): Promise<GeminiCliTokenExchangeResult> {
  authLog.verbose('gemini-cli-oauth', 'Exchanging authorization code for tokens');
  try {
    const decoded = decodeState(options.state);

    authLog.verbose('gemini-cli-oauth', `Token exchange request to ${GOOGLE_OAUTH_TOKEN_URL}`);
    const tokenResponse = await fetch(GOOGLE_OAUTH_TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
        Accept: '*/*',
        'Accept-Encoding': 'gzip, deflate, br',
        'User-Agent': GEMINI_CLI_API_HEADERS['User-Agent'],
        'X-Goog-Api-Client': GEMINI_CLI_API_HEADERS['X-Goog-Api-Client'],
      },
      body: new URLSearchParams({
        client_id: GEMINI_CLI_CLIENT_ID,
        client_secret: GEMINI_CLI_CLIENT_SECRET,
        code: options.code,
        grant_type: 'authorization_code',
        redirect_uri: decoded.redirectUri,
        code_verifier: decoded.verifier,
      }),
    });

    if (!tokenResponse.ok) {
      const errorText = await tokenResponse.text().catch(() => '');
      authLog.error('gemini-cli-oauth', `Token exchange failed (status: ${tokenResponse.status})`, errorText);
      return { type: 'failed', error: errorText || 'Token exchange failed' };
    }

    const tokenPayload = (await tokenResponse.json()) as TokenResponse;

    const accessToken = tokenPayload.access_token;
    const refreshToken = tokenPayload.refresh_token;

    if (typeof accessToken !== 'string' || accessToken.trim() === '') {
      authLog.error('gemini-cli-oauth', 'Missing access token in response');
      return { type: 'failed', error: 'Missing access token in response' };
    }

    if (typeof refreshToken !== 'string' || refreshToken.trim() === '') {
      authLog.error('gemini-cli-oauth', 'Missing refresh token in response');
      return { type: 'failed', error: 'Missing refresh token in response' };
    }

    const expiresAt =
      typeof tokenPayload.expires_in === 'number'
        ? Date.now() + tokenPayload.expires_in * 1000
        : undefined;

    authLog.verbose('gemini-cli-oauth', 'Fetching user info');
    const userInfoResponse = await fetch(GOOGLE_USERINFO_URL, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'User-Agent': GEMINI_CLI_API_HEADERS['User-Agent'],
        'X-Goog-Api-Client': GEMINI_CLI_API_HEADERS['X-Goog-Api-Client'],
      },
    });

    const userInfo: UserInfo = userInfoResponse.ok
      ? ((await userInfoResponse.json()) as UserInfo)
      : {};

    authLog.verbose(
      'gemini-cli-oauth',
      `Token exchange successful (email: ${userInfo.email ?? 'unknown'})`,
    );
    return {
      type: 'success',
      accessToken,
      refreshToken,
      expiresAt,
      email: userInfo.email,
    };
  } catch (error) {
    authLog.error('gemini-cli-oauth', 'Token exchange failed with exception', error);
    return {
      type: 'failed',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Refresh the access token using a refresh token.
 */
export async function refreshGeminiCliAccessToken(options: {
  refreshToken: string;
}): Promise<{
  accessToken: string;
  expiresAt?: number;
  tokenType?: string;
  refreshToken?: string;
} | null> {
  authLog.verbose('gemini-cli-oauth', 'Refreshing access token');
  try {
    const refreshToken = options.refreshToken.trim();
    if (!refreshToken) {
      authLog.error('gemini-cli-oauth', 'Missing refresh token for refresh request');
      return null;
    }

    const randomized = getGeminiCliRandomizedHeaders();
    const response = await fetch(GOOGLE_OAUTH_TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
        Accept: '*/*',
        'Accept-Encoding': 'gzip, deflate, br',
        'User-Agent': randomized['User-Agent'],
        'X-Goog-Api-Client': randomized['X-Goog-Api-Client'],
      },
      body: new URLSearchParams({
        client_id: GEMINI_CLI_CLIENT_ID,
        client_secret: GEMINI_CLI_CLIENT_SECRET,
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
      }),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      const { code, description } = parseOAuthErrorPayload(errorText);
      const details = [code, description ?? errorText].filter(Boolean).join(': ');
      const baseMessage = `Gemini CLI token refresh failed (${response.status} ${response.statusText})`;
      const message = details ? `${baseMessage} - ${details}` : baseMessage;

      authLog.error('gemini-cli-oauth', message);
      throw new GeminiCliTokenRefreshError({
        message,
        code,
        description: description ?? errorText,
        status: response.status,
        statusText: response.statusText,
      });
    }

    const payload = (await response.json()) as TokenResponse;
    const accessToken = payload.access_token;
    if (typeof accessToken !== 'string' || accessToken.trim() === '') {
      authLog.error('gemini-cli-oauth', 'Missing access token in refresh response');
      return null;
    }

    const expiresAt =
      typeof payload.expires_in === 'number'
        ? Date.now() + payload.expires_in * 1000
        : undefined;

    const tokenType = typeof payload.token_type === 'string' ? payload.token_type : undefined;

    authLog.verbose('gemini-cli-oauth', `Token refresh successful (expiresAt: ${expiresAt ? new Date(expiresAt).toISOString() : 'never'})`);

    // Google may return a new refresh token
    const newRefreshToken =
      typeof payload.refresh_token === 'string' && payload.refresh_token.trim()
        ? payload.refresh_token
        : undefined;

    return { accessToken, expiresAt, tokenType, refreshToken: newRefreshToken };
  } catch (error) {
    if (error instanceof GeminiCliTokenRefreshError) {
      throw error;
    }
    authLog.error('gemini-cli-oauth', 'Token refresh failed with exception', error);
    return null;
  }
}

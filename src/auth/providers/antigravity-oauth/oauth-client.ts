import {
  ANTIGRAVITY_CLIENT_ID,
  ANTIGRAVITY_CLIENT_SECRET,
  ANTIGRAVITY_SCOPES,
  CODE_ASSIST_ENDPOINT_FALLBACKS,
  CODE_ASSIST_HEADERS,
  CODE_ASSIST_LOAD_ENDPOINTS,
  GEMINI_CLI_HEADERS,
  GOOGLE_OAUTH_AUTH_URL,
  GOOGLE_OAUTH_TOKEN_URL,
  GOOGLE_USERINFO_URL,
  buildCodeAssistMetadata,
  getRandomizedHeaders,
} from './constants';
import type {
  AntigravityAccountInfo,
  AntigravityAuthState,
  AntigravityAuthorization,
  AntigravityTokenExchangeResult,
  AntigravityTier,
} from './types';
import { authLog } from '../../../logger';
import { generatePKCE } from '../../../utils';

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

async function sleep(ms: number): Promise<void> {
  if (ms <= 0) {
    return;
  }
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function encodeState(payload: AntigravityAuthState): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

function decodeState(state: string): AntigravityAuthState {
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
  const projectId = record['projectId'];
  const redirectUri = record['redirectUri'];
  if (typeof verifier !== 'string' || verifier.trim() === '') {
    throw new Error('Invalid state');
  }
  if (typeof redirectUri !== 'string' || redirectUri.trim() === '') {
    throw new Error('Invalid state');
  }
  return {
    verifier,
    projectId: typeof projectId === 'string' ? projectId : '',
    redirectUri,
  };
}

export async function authorizeAntigravity(options: {
  projectId?: string;
  redirectUri: string;
}): Promise<AntigravityAuthorization> {
  const pkce = generatePKCE(43);

  const projectId = options.projectId?.trim() ?? '';
  const redirectUri = options.redirectUri.trim();
  const state = encodeState({ verifier: pkce.verifier, projectId, redirectUri });

  const url = new URL(GOOGLE_OAUTH_AUTH_URL);
  url.searchParams.set('client_id', ANTIGRAVITY_CLIENT_ID);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('scope', ANTIGRAVITY_SCOPES.join(' '));
  url.searchParams.set('code_challenge', pkce.challenge);
  url.searchParams.set('code_challenge_method', pkce.method);
  url.searchParams.set('state', state);
  url.searchParams.set('access_type', 'offline');
  url.searchParams.set('prompt', 'consent');
  url.searchParams.set('include_granted_scopes', 'true');

  return {
    url: url.toString(),
    verifier: pkce.verifier,
    projectId,
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

function parseNonNegativeNumber(value: unknown): number | undefined {
  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim()
        ? Number(value)
        : Number.NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function parseTokenResponse(value: unknown): TokenResponse | undefined {
  if (!isRecord(value)) return undefined;
  const accessToken = value['access_token'];
  const expiresIn = parseNonNegativeNumber(value['expires_in']);
  const refreshToken = value['refresh_token'];
  const tokenType = value['token_type'];
  return {
    ...(typeof accessToken === 'string' ? { access_token: accessToken } : {}),
    ...(expiresIn === undefined ? {} : { expires_in: expiresIn }),
    ...(typeof refreshToken === 'string'
      ? { refresh_token: refreshToken }
      : {}),
    ...(typeof tokenType === 'string' ? { token_type: tokenType } : {}),
  };
}

function parseUserInfo(value: unknown): UserInfo {
  if (!isRecord(value)) return {};
  const email = value['email'];
  return typeof email === 'string' ? { email } : {};
}

export type AntigravityRefreshTokenParts = {
  refreshToken: string;
  projectId?: string;
  managedProjectId?: string;
};

export function parseAntigravityRefreshTokenParts(
  refresh: string,
): AntigravityRefreshTokenParts {
  const [refreshToken = '', projectId = '', managedProjectId = ''] = (
    refresh ?? ''
  ).split('|');
  return {
    refreshToken,
    projectId: projectId.trim() ? projectId.trim() : undefined,
    managedProjectId: managedProjectId.trim() ? managedProjectId.trim() : undefined,
  };
}

export function formatAntigravityRefreshTokenParts(
  parts: AntigravityRefreshTokenParts,
): string {
  const projectSegment = parts.projectId ?? '';
  const base = `${parts.refreshToken}|${projectSegment}`;
  return parts.managedProjectId ? `${base}|${parts.managedProjectId}` : base;
}

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

export class AntigravityTokenRefreshError extends Error {
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
    this.name = 'AntigravityTokenRefreshError';
    this.code = options.code;
    this.description = options.description;
    this.status = options.status;
    this.statusText = options.statusText;
  }
}

const FETCH_TIMEOUT_MS = 10_000;
const ONBOARD_TIMEOUT_MS = 30_000;
const ONBOARD_MAX_ATTEMPTS = 10;
const ONBOARD_POLL_DELAY_MS = 5_000;

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

export async function fetchAccountInfo(
  accessToken: string,
  projectId?: string,
): Promise<AntigravityAccountInfo> {
  authLog.verbose('antigravity-client', 'Fetching account info');
  const randomized = await getRandomizedHeaders('gemini-cli');
  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
    'User-Agent': randomized['User-Agent'],
    'X-Goog-Api-Client': CODE_ASSIST_HEADERS['X-Goog-Api-Client'],
    'Client-Metadata': CODE_ASSIST_HEADERS['Client-Metadata'],
  };

  let detectedTier: AntigravityTier = 'free';
  let tierId: string | undefined;
  let managedProjectId: string | undefined;

  const loadEndpoints = Array.from(
    new Set<string>([...CODE_ASSIST_LOAD_ENDPOINTS, ...CODE_ASSIST_ENDPOINT_FALLBACKS]),
  );

  for (const baseEndpoint of loadEndpoints) {
    try {
      authLog.verbose('antigravity-client', `Trying endpoint: ${baseEndpoint}`);
      const response = await fetchWithTimeout(`${baseEndpoint}/v1internal:loadCodeAssist`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          metadata: buildCodeAssistMetadata(projectId),
        }),
      });

      if (!response.ok) {
        authLog.verbose('antigravity-client', `Endpoint ${baseEndpoint} returned ${response.status}, trying next`);
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

      if (managedProjectId) {
        authLog.verbose(
          'antigravity-client',
          `Account info fetched (managedProjectId: ${managedProjectId}, tier: ${detectedTier})`,
        );
        return {
          projectId: projectId?.trim() ?? '',
          managedProjectId,
          tier: detectedTier,
          tierId: effectiveTierId,
        };
      }

      authLog.verbose(
        'antigravity-client',
        `loadCodeAssist returned no projectId; attempting onboardUser (tierId: ${defaultTierId})`,
      );

      const onboardTierId = tierId ?? defaultTierId;
      const requestBody = JSON.stringify({
        tierId: onboardTierId,
        metadata: buildCodeAssistMetadata(projectId),
      });

      for (let attempt = 1; attempt <= ONBOARD_MAX_ATTEMPTS; attempt++) {
        authLog.verbose(
          'antigravity-client',
          `Polling onboardUser (${attempt}/${ONBOARD_MAX_ATTEMPTS}) via ${baseEndpoint}`,
        );
          const onboardResp = await fetchWithTimeout(
            `${baseEndpoint}/v1internal:onboardUser`,
            {
              method: 'POST',
              headers: {
                ...headers,
                ...(await getRandomizedHeaders('antigravity')),
              },
              body: requestBody,
            },
            ONBOARD_TIMEOUT_MS,
        );

        if (!onboardResp.ok) {
          const errorText = await onboardResp.text().catch(() => '');
          throw new Error(
            `onboardUser failed (status: ${onboardResp.status}): ${errorText}`,
          );
        }

        const onboardData: unknown = await onboardResp.json();
        if (!isRecord(onboardData)) {
          continue;
        }

        const done = onboardData['done'];
        if (done === true) {
          const responsePayload = onboardData['response'];
          if (!isRecord(responsePayload)) {
            throw new Error('onboardUser response missing "response" object');
          }

          const onboardProjectId = extractManagedProjectId(
            responsePayload['cloudaicompanionProject'],
          );
          if (!onboardProjectId) {
            throw new Error('onboardUser completed without projectId');
          }

          authLog.verbose(
            'antigravity-client',
            `onboardUser returned projectId: ${onboardProjectId}`,
          );
          return {
            projectId: projectId?.trim() ?? '',
            managedProjectId: onboardProjectId,
            tier: detectedTier,
            tierId:
              onboardTierId !== 'legacy-tier' ? onboardTierId : undefined,
          };
        }

        await sleep(ONBOARD_POLL_DELAY_MS);
      }
    } catch (error) {
      authLog.verbose('antigravity-client', `Endpoint ${baseEndpoint} failed with error, trying next`);
      continue;
    }
  }

  authLog.verbose('antigravity-client', `Account info fetch completed (projectId: empty, tier: ${detectedTier})`);
  return {
    projectId: projectId?.trim() ?? '',
    managedProjectId,
    tier: detectedTier,
    tierId,
  };
}

export async function exchangeAntigravity(options: {
  code: string;
  state: string;
}): Promise<AntigravityTokenExchangeResult> {
  authLog.verbose('antigravity-client', 'Exchanging authorization code for tokens');
  try {
    const decoded = decodeState(options.state);

    authLog.verbose('antigravity-client', `Token exchange request to ${GOOGLE_OAUTH_TOKEN_URL}`);
    const tokenResponse = await fetch(GOOGLE_OAUTH_TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
        Accept: '*/*',
        'Accept-Encoding': 'gzip, deflate, br',
        'User-Agent': GEMINI_CLI_HEADERS['User-Agent'],
        'X-Goog-Api-Client': GEMINI_CLI_HEADERS['X-Goog-Api-Client'],
      },
      body: new URLSearchParams({
        client_id: ANTIGRAVITY_CLIENT_ID,
        client_secret: ANTIGRAVITY_CLIENT_SECRET,
        code: options.code,
        grant_type: 'authorization_code',
        redirect_uri: decoded.redirectUri,
        code_verifier: decoded.verifier,
      }),
    });

    if (!tokenResponse.ok) {
      const errorText = await tokenResponse.text().catch(() => '');
      authLog.error('antigravity-client', `Token exchange failed (status: ${tokenResponse.status})`, errorText);
      return { type: 'failed', error: errorText || 'Token exchange failed' };
    }

    const tokenPayload = parseTokenResponse(await tokenResponse.json());
    if (!tokenPayload) {
      return { type: 'failed', error: 'Invalid token response' };
    }

    const accessToken = tokenPayload.access_token;
    const refreshToken = tokenPayload.refresh_token;

    if (typeof accessToken !== 'string' || accessToken.trim() === '') {
      authLog.error('antigravity-client', 'Missing access token in response');
      return { type: 'failed', error: 'Missing access token in response' };
    }

    if (typeof refreshToken !== 'string' || refreshToken.trim() === '') {
      authLog.error('antigravity-client', 'Missing refresh token in response');
      return { type: 'failed', error: 'Missing refresh token in response' };
    }

    const expiresAt =
      typeof tokenPayload.expires_in === 'number'
        ? Date.now() + tokenPayload.expires_in * 1000
        : undefined;

    authLog.verbose('antigravity-client', 'Fetching user info');
    const userInfoResponse = await fetch(GOOGLE_USERINFO_URL, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'User-Agent': GEMINI_CLI_HEADERS['User-Agent'],
        'X-Goog-Api-Client': GEMINI_CLI_HEADERS['X-Goog-Api-Client'],
      },
    });

    const userInfo = userInfoResponse.ok
      ? parseUserInfo(await userInfoResponse.json())
      : {};

    const desiredProjectId = decoded.projectId.trim();
    const accountInfo = await fetchAccountInfo(
      accessToken,
      desiredProjectId || undefined,
    );

    const managedProjectId = accountInfo.managedProjectId?.trim() || undefined;
    const packedRefreshToken = formatAntigravityRefreshTokenParts({
      refreshToken,
      projectId: desiredProjectId || undefined,
      managedProjectId,
    });

    authLog.verbose(
      'antigravity-client',
      `Token exchange successful (email: ${userInfo.email}, projectId: ${desiredProjectId || 'auto'}, managedProjectId: ${managedProjectId || 'auto'})`,
    );
    return {
      type: 'success',
      accessToken,
      refreshToken: packedRefreshToken,
      expiresAt,
      email: userInfo.email,
      projectId: desiredProjectId,
      managedProjectId,
      tier: accountInfo.tier,
      tierId: accountInfo.tierId,
    };
  } catch (error) {
    authLog.error('antigravity-client', 'Token exchange failed with exception', error);
    return {
      type: 'failed',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function refreshAccessToken(options: {
  refreshToken: string;
}): Promise<{
  accessToken: string;
  expiresAt?: number;
  tokenType?: string;
  refreshToken?: string;
} | null> {
  authLog.verbose('antigravity-client', 'Refreshing access token');
  try {
    const parts = parseAntigravityRefreshTokenParts(options.refreshToken);
    if (!parts.refreshToken.trim()) {
      authLog.error('antigravity-client', 'Missing refresh token for refresh request');
      return null;
    }

    const randomized = await getRandomizedHeaders('gemini-cli');
    const response = await fetch(GOOGLE_OAUTH_TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
        Accept: '*/*',
        'Accept-Encoding': 'gzip, deflate, br',
        'User-Agent': randomized['User-Agent'],
        'X-Goog-Api-Client':
          randomized['X-Goog-Api-Client'] ??
          GEMINI_CLI_HEADERS['X-Goog-Api-Client'],
      },
      body: new URLSearchParams({
        client_id: ANTIGRAVITY_CLIENT_ID,
        client_secret: ANTIGRAVITY_CLIENT_SECRET,
        refresh_token: parts.refreshToken,
        grant_type: 'refresh_token',
      }),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      const { code, description } = parseOAuthErrorPayload(errorText);
      const details = [code, description ?? errorText].filter(Boolean).join(': ');
      const baseMessage = `Antigravity token refresh failed (${response.status} ${response.statusText})`;
      const message = details ? `${baseMessage} - ${details}` : baseMessage;

      authLog.error('antigravity-client', message);
      throw new AntigravityTokenRefreshError({
        message,
        code,
        description: description ?? errorText,
        status: response.status,
        statusText: response.statusText,
      });
    }

    const payload = parseTokenResponse(await response.json());
    if (!payload) {
      authLog.error('antigravity-client', 'Invalid token refresh response');
      return null;
    }
    const accessToken = payload.access_token;
    if (typeof accessToken !== 'string' || accessToken.trim() === '') {
      authLog.error('antigravity-client', 'Missing access token in refresh response');
      return null;
    }

    const expiresAt =
      typeof payload.expires_in === 'number'
        ? Date.now() + payload.expires_in * 1000
        : undefined;

    const tokenType = typeof payload.token_type === 'string' ? payload.token_type : undefined;

    authLog.verbose('antigravity-client', `Token refresh successful (expiresAt: ${expiresAt ? new Date(expiresAt).toISOString() : 'never'})`);
    const refreshToken =
      typeof payload.refresh_token === 'string' && payload.refresh_token.trim()
        ? formatAntigravityRefreshTokenParts({
            refreshToken: payload.refresh_token,
            projectId: parts.projectId,
            managedProjectId: parts.managedProjectId,
          })
        : options.refreshToken;

    return { accessToken, expiresAt, tokenType, refreshToken };
  } catch (error) {
    if (error instanceof AntigravityTokenRefreshError) {
      throw error;
    }
    authLog.error('antigravity-client', 'Token refresh failed with exception', error);
    return null;
  }
}

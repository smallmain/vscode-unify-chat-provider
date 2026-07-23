import { createHash, randomUUID } from 'node:crypto';
import {
  isLocalAuthRef,
  isSessionSecretRef,
  LOCAL_AUTH_REF_PREFIX,
  LOCAL_AUTH_REF_SUFFIX,
} from '../secret/constants';
import type {
  AuthConfig,
  AuthContext,
  AuthRuntimeConfig,
  OAuth2Config,
  OAuth2StaticConfig,
  OAuth2TokenData,
  SessionAuthConfig,
  SessionAuthMethod,
  SessionAuthRuntimeConfig,
} from './types';

export const LOCAL_AUTH_STATE_VERSION = 1 as const;
export const LOCAL_AUTH_STATE_KEY_PREFIX = 'auth-session-v1.';
export { LOCAL_AUTH_REF_PREFIX, LOCAL_AUTH_REF_SUFFIX } from '../secret/constants';
export const MAX_LOCAL_AUTH_SNAPSHOTS = 3;

const UUID_LIKE_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const STATIC_AUTH_FINGERPRINT_REGEX = /^[0-9a-f]{64}$/i;

const SESSION_AUTH_METHODS = new Set<SessionAuthMethod>([
  'oauth2',
  'antigravity-oauth',
  'google-gemini-oauth',
  'claude-code',
  'openai-codex',
  'xai-grok-oauth',
  'github-copilot',
  'zed',
]);

function sortForStableJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortForStableJson);
  if (!value || typeof value !== 'object') return value;
  const record = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(record).sort()) {
    const normalized = sortForStableJson(record[key]);
    if (normalized !== undefined) sorted[key] = normalized;
  }
  return sorted;
}

export function stableAuthStateStringify(value: unknown): string {
  return JSON.stringify(sortForStableJson(value)) ?? 'undefined';
}

export interface LocalAuthSessionSnapshotV1 {
  method: SessionAuthMethod;
  staticConfigFingerprint: string;
  epoch: number;
  sessionId?: string;
  token?: OAuth2TokenData;
  clientSecret?: string;
  authContext?: AuthContext;
  orphanedAt?: number;
  createdAt: number;
  updatedAt: number;
}

export interface LocalAuthStateEnvelopeV1 {
  version: typeof LOCAL_AUTH_STATE_VERSION;
  bindingId: string;
  revision: number;
  orphanedAt?: number;
  snapshots: LocalAuthSessionSnapshotV1[];
}

export interface AuthBindingDescriptor {
  providerName: string;
  providerType: string;
  baseUrl: string;
  useRawBaseUrl?: boolean;
}

export function isSessionAuthMethod(value: unknown): value is SessionAuthMethod {
  return typeof value === 'string' && SESSION_AUTH_METHODS.has(value as SessionAuthMethod);
}

export function isValidAuthBindingId(value: unknown): value is string {
  return typeof value === 'string' && UUID_LIKE_REGEX.test(value);
}

export function createAuthBindingId(): string {
  return randomUUID();
}

export function renewSessionAuthBinding(
  auth: AuthRuntimeConfig,
): AuthRuntimeConfig {
  return isSessionAuthConfig(auth)
    ? { ...auth, bindingId: createAuthBindingId() }
    : auth;
}

function deterministicUuid(value: string): string {
  const hex = createHash('sha256').update(value).digest('hex').slice(0, 32).split('');
  hex[12] = '5';
  hex[16] = ['8', '9', 'a', 'b'][Number.parseInt(hex[16] ?? '0', 16) % 4];
  const joined = hex.join('');
  return `${joined.slice(0, 8)}-${joined.slice(8, 12)}-${joined.slice(12, 16)}-${joined.slice(16, 20)}-${joined.slice(20)}`;
}

function normalizeUrlForIdentity(value: string): string {
  const trimmed = value.trim();
  try {
    const url = new URL(trimmed);
    url.protocol = url.protocol.toLowerCase();
    url.hostname = url.hostname.toLowerCase();
    url.hash = '';
    url.search = '';
    url.pathname = url.pathname.replace(/\/+$/, '') || '/';
    return url.toString().replace(/\/$/, '');
  } catch {
    return trimmed.replace(/\/+$/, '').toLowerCase();
  }
}

function normalizeDescriptorBaseUrl(
  descriptor: Pick<AuthBindingDescriptor, 'baseUrl' | 'useRawBaseUrl'>,
): string {
  return descriptor.useRawBaseUrl === true
    ? descriptor.baseUrl.trim()
    : normalizeUrlForIdentity(descriptor.baseUrl);
}

export function deriveLegacyAuthBindingId(
  descriptor: AuthBindingDescriptor,
  auth: Pick<SessionAuthRuntimeConfig, 'method'> & object,
): string {
  return deterministicUuid(
    stableAuthStateStringify({
      namespace: 'ucp-auth-binding-v1',
      providerName: descriptor.providerName.trim().toLowerCase(),
      providerType: descriptor.providerType.trim().toLowerCase(),
      baseUrl: normalizeDescriptorBaseUrl(descriptor),
      ...(descriptor.useRawBaseUrl === true ? { useRawBaseUrl: true } : {}),
      auth: staticAuthFingerprintInput(auth),
    }),
  );
}

export function buildLocalAuthRef(
  bindingId: string,
  staticConfigFingerprint: string,
): string {
  if (!isValidAuthBindingId(bindingId)) {
    throw new Error(`Invalid auth binding ID: ${bindingId}`);
  }
  if (!STATIC_AUTH_FINGERPRINT_REGEX.test(staticConfigFingerprint)) {
    throw new Error(
      `Invalid static auth fingerprint: ${staticConfigFingerprint}`,
    );
  }
  return `${LOCAL_AUTH_REF_PREFIX}${bindingId}.${staticConfigFingerprint}${LOCAL_AUTH_REF_SUFFIX}`;
}

export function extractBindingIdFromLocalAuthRef(ref: string): string | null {
  if (!ref.startsWith(LOCAL_AUTH_REF_PREFIX) || !ref.endsWith(LOCAL_AUTH_REF_SUFFIX)) {
    return null;
  }
  const target = ref.slice(
    LOCAL_AUTH_REF_PREFIX.length,
    -LOCAL_AUTH_REF_SUFFIX.length,
  );
  const [bindingId, fingerprint, extra] = target.split('.');
  if (
    extra !== undefined ||
    (fingerprint !== undefined &&
      !STATIC_AUTH_FINGERPRINT_REGEX.test(fingerprint))
  ) {
    return null;
  }
  return isValidAuthBindingId(bindingId) ? bindingId : null;
}

export function localAuthStateDeviceKey(bindingId: string): string {
  if (!isValidAuthBindingId(bindingId)) {
    throw new Error(`Invalid auth binding ID: ${bindingId}`);
  }
  return `${LOCAL_AUTH_STATE_KEY_PREFIX}${bindingId}`;
}

function staticOAuthConfig(oauth: OAuth2Config): OAuth2StaticConfig {
  if (oauth.grantType === 'authorization_code') {
    const { clientSecret: _, ...staticConfig } = oauth;
    return staticConfig;
  }
  if (oauth.grantType === 'client_credentials') {
    const { clientSecret: _, ...staticConfig } = oauth;
    return staticConfig;
  }
  return { ...oauth };
}

export function stripSessionAuthState(
  auth: SessionAuthRuntimeConfig,
): SessionAuthConfig {
  switch (auth.method) {
    case 'oauth2':
      return {
        method: auth.method,
        bindingId: auth.bindingId,
        label: auth.label,
        description: auth.description,
        oauth: staticOAuthConfig(auth.oauth),
      };
    case 'google-gemini-oauth':
      return {
        method: auth.method,
        bindingId: auth.bindingId,
        label: auth.label,
        description: auth.description,
        ...(auth.oauthType === undefined ? {} : { oauthType: auth.oauthType }),
      };
    case 'github-copilot':
      return {
        method: auth.method,
        bindingId: auth.bindingId,
        label: auth.label,
        description: auth.description,
        enterpriseUrl: auth.enterpriseUrl,
      };
    case 'zed':
      return {
        method: auth.method,
        bindingId: auth.bindingId,
        label: auth.label,
        description: auth.description,
        baseUrl: auth.baseUrl,
      };
    case 'antigravity-oauth':
    case 'claude-code':
    case 'openai-codex':
    case 'xai-grok-oauth':
      return {
        method: auth.method,
        bindingId: auth.bindingId,
        label: auth.label,
        description: auth.description,
      };
  }
}

export function discardMismatchedLocalSessionState(
  descriptor: AuthBindingDescriptor,
  auth: SessionAuthRuntimeConfig,
): SessionAuthRuntimeConfig {
  const expectedRef = buildLocalAuthRef(
    auth.bindingId,
    computeStaticAuthFingerprint(descriptor, auth),
  );
  const tokenRef = auth.token?.trim();
  const clientSecretRef =
    auth.method === 'oauth2' && auth.oauth.grantType !== 'device_code'
      ? auth.oauth.clientSecret?.trim()
      : undefined;
  const mismatched =
    (tokenRef !== undefined &&
      isLocalAuthRef(tokenRef) &&
      tokenRef !== expectedRef) ||
    (clientSecretRef !== undefined &&
      isLocalAuthRef(clientSecretRef) &&
      clientSecretRef !== expectedRef);
  return mismatched ? stripSessionAuthState(auth) : auth;
}

function staticAuthFingerprintInput(
  auth: Pick<SessionAuthRuntimeConfig, 'method'> & object,
): unknown {
  const copy: Record<string, unknown> = { ...auth };
  if (
    copy['method'] === 'google-gemini-oauth' &&
    copy['oauthType'] === undefined
  ) {
    copy['oauthType'] = 'code_assist';
  }
  for (const key of [
    'bindingId',
    'label',
    'description',
    'identityId',
    'token',
    'clientSecret',
    'projectId',
    'managedProjectId',
    'tier',
    'tierId',
    'accountId',
    'email',
    'organizationId',
    'dataCollection',
    'dataCollectionAllowed',
  ]) {
    delete copy[key];
  }
  const oauth = copy['oauth'];
  if (isRecord(oauth)) {
    const staticOAuth = { ...oauth };
    delete staticOAuth['clientSecret'];
    copy['oauth'] = staticOAuth;
  }
  return copy;
}

export function computeStaticAuthFingerprint(
  descriptor: Pick<
    AuthBindingDescriptor,
    'providerType' | 'baseUrl' | 'useRawBaseUrl'
  >,
  auth: Pick<SessionAuthRuntimeConfig, 'method'> & object,
): string {
  return createHash('sha256')
    .update(
      stableAuthStateStringify({
        providerType: descriptor.providerType.trim().toLowerCase(),
        baseUrl: normalizeDescriptorBaseUrl(descriptor),
        ...(descriptor.useRawBaseUrl === true ? { useRawBaseUrl: true } : {}),
        auth: staticAuthFingerprintInput(auth),
      }),
    )
    .digest('hex');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function commonSessionFields(
  record: Record<string, unknown>,
  bindingId: string,
): { bindingId: string; label?: string; description?: string } | null {
  const label = optionalString(record, 'label');
  const description = optionalString(record, 'description');
  if (label === null || description === null) return null;
  return {
    bindingId,
    ...(label === undefined ? {} : { label }),
    ...(description === undefined ? {} : { description }),
  };
}

function sessionValueFields(record: Record<string, unknown>): {
  identityId?: string;
  token?: string;
} | null {
  const identityId = optionalString(record, 'identityId');
  const token = optionalString(record, 'token');
  if (identityId === null || token === null) return null;
  return {
    ...(identityId === undefined ? {} : { identityId }),
    ...(token === undefined ? {} : { token }),
  };
}

function parseOAuth2Config(value: unknown): OAuth2Config | null {
  if (!isRecord(value)) return null;
  const tokenUrl = value['tokenUrl'];
  const revocationUrl = optionalString(value, 'revocationUrl');
  const scopesValue = value['scopes'];
  if (
    typeof tokenUrl !== 'string' ||
    revocationUrl === null ||
    (scopesValue !== undefined &&
      (!Array.isArray(scopesValue) ||
        !scopesValue.every((scope) => typeof scope === 'string')))
  ) {
    return null;
  }
  const base = {
    tokenUrl,
    ...(revocationUrl === undefined ? {} : { revocationUrl }),
    ...(scopesValue === undefined ? {} : { scopes: scopesValue }),
  };
  switch (value['grantType']) {
    case 'authorization_code': {
      const authorizationUrl = value['authorizationUrl'];
      const clientId = value['clientId'];
      const clientSecret = optionalString(value, 'clientSecret');
      const redirectUri = optionalString(value, 'redirectUri');
      const pkce = value['pkce'];
      if (
        typeof authorizationUrl !== 'string' ||
        typeof clientId !== 'string' ||
        clientSecret === null ||
        redirectUri === null ||
        (pkce !== undefined && typeof pkce !== 'boolean')
      ) {
        return null;
      }
      return {
        ...base,
        grantType: 'authorization_code',
        authorizationUrl,
        clientId,
        ...(clientSecret === undefined ? {} : { clientSecret }),
        ...(redirectUri === undefined ? {} : { redirectUri }),
        ...(pkce === undefined ? {} : { pkce }),
      };
    }
    case 'client_credentials': {
      const clientId = value['clientId'];
      const clientSecret = optionalString(value, 'clientSecret');
      if (typeof clientId !== 'string' || clientSecret === null) {
        return null;
      }
      return {
        ...base,
        grantType: 'client_credentials',
        clientId,
        ...(clientSecret === undefined ? {} : { clientSecret }),
      };
    }
    case 'device_code': {
      const deviceAuthorizationUrl = value['deviceAuthorizationUrl'];
      const clientId = value['clientId'];
      if (typeof deviceAuthorizationUrl !== 'string' || typeof clientId !== 'string') {
        return null;
      }
      return {
        ...base,
        grantType: 'device_code',
        deviceAuthorizationUrl,
        clientId,
      };
    }
    default:
      return null;
  }
}

export function parseSessionAuthConfig(
  value: unknown,
  fallbackBindingId?: string,
): SessionAuthRuntimeConfig | null {
  if (!isRecord(value) || !isSessionAuthMethod(value['method'])) return null;
  const bindingValue = value['bindingId'];
  const bindingId = isValidAuthBindingId(bindingValue)
    ? bindingValue
    : isValidAuthBindingId(fallbackBindingId)
      ? fallbackBindingId
      : undefined;
  if (!bindingId) return null;
  const common = commonSessionFields(value, bindingId);
  const session = sessionValueFields(value);
  if (!common || !session) return null;
  const email = optionalString(value, 'email');
  if (email === null) return null;
  switch (value['method']) {
    case 'oauth2': {
      const oauth = parseOAuth2Config(value['oauth']);
      return oauth ? { method: 'oauth2', ...common, ...session, oauth } : null;
    }
    case 'antigravity-oauth':
    case 'google-gemini-oauth': {
      const projectId = optionalString(value, 'projectId');
      const managedProjectId = optionalString(value, 'managedProjectId');
      const tierId = optionalString(value, 'tierId');
      const tier = value['tier'];
      if (
        projectId === null ||
        managedProjectId === null ||
        tierId === null ||
        (tier !== undefined && tier !== 'free' && tier !== 'paid')
      ) {
        return null;
      }
      const normalizedTier: 'free' | 'paid' | undefined =
        tier === 'free' || tier === 'paid' ? tier : undefined;
      const account = {
        ...(projectId === undefined ? {} : { projectId }),
        ...(managedProjectId === undefined ? {} : { managedProjectId }),
        ...(normalizedTier === undefined ? {} : { tier: normalizedTier }),
        ...(tierId === undefined ? {} : { tierId }),
        ...(email === undefined ? {} : { email }),
      };
      if (value['method'] === 'antigravity-oauth') {
        return { method: value['method'], ...common, ...session, ...account };
      }
      const oauthType = value['oauthType'];
      if (
        oauthType !== undefined &&
        oauthType !== 'code_assist' &&
        oauthType !== 'ai_studio' &&
        oauthType !== 'google_one'
      ) {
        return null;
      }
      return {
        method: value['method'],
        ...common,
        ...session,
        ...account,
        ...(oauthType === undefined ? {} : { oauthType }),
      };
    }
    case 'openai-codex': {
      const accountId = optionalString(value, 'accountId');
      if (accountId === null) return null;
      return {
        method: value['method'],
        ...common,
        ...session,
        ...(accountId === undefined ? {} : { accountId }),
        ...(email === undefined ? {} : { email }),
      };
    }
    case 'claude-code':
    case 'xai-grok-oauth':
      return {
        method: value['method'],
        ...common,
        ...session,
        ...(email === undefined ? {} : { email }),
      };
    case 'github-copilot': {
      const enterpriseUrl = optionalString(value, 'enterpriseUrl');
      if (enterpriseUrl === null) return null;
      return {
        method: value['method'],
        ...common,
        ...session,
        ...(enterpriseUrl === undefined ? {} : { enterpriseUrl }),
      };
    }
    case 'zed': {
      const baseUrl = optionalString(value, 'baseUrl');
      const organizationId = optionalString(value, 'organizationId');
      const dataCollection = value['dataCollection'];
      const dataCollectionAllowed = value['dataCollectionAllowed'];
      if (
        baseUrl === null ||
        organizationId === null ||
        (dataCollection !== undefined && typeof dataCollection !== 'boolean') ||
        (dataCollectionAllowed !== undefined &&
          typeof dataCollectionAllowed !== 'boolean')
      ) {
        return null;
      }
      return {
        method: value['method'],
        ...common,
        ...session,
        ...(baseUrl === undefined ? {} : { baseUrl }),
        ...(organizationId === undefined ? {} : { organizationId }),
        ...(dataCollection === undefined ? {} : { dataCollection }),
        ...(dataCollectionAllowed === undefined
          ? {}
          : { dataCollectionAllowed }),
        ...(email === undefined ? {} : { email }),
      };
    }
  }
}

function optionalString(record: Record<string, unknown>, key: string): string | undefined | null {
  const value = record[key];
  return value === undefined
    ? undefined
    : typeof value === 'string'
      ? value
      : null;
}

function optionalFiniteNumber(
  record: Record<string, unknown>,
  key: string,
): number | undefined | null {
  const value = record[key];
  return value === undefined
    ? undefined
    : typeof value === 'number' && Number.isFinite(value)
      ? value
      : null;
}

export function parseOAuth2TokenData(value: unknown): OAuth2TokenData | null {
  if (!isRecord(value)) return null;
  const accessToken = value['accessToken'];
  const tokenType = value['tokenType'];
  const refreshToken = optionalString(value, 'refreshToken');
  const expiresAt = optionalFiniteNumber(value, 'expiresAt');
  const scope = optionalString(value, 'scope');
  if (
    typeof accessToken !== 'string' ||
    accessToken.trim() === '' ||
    typeof tokenType !== 'string' ||
    tokenType.trim() === '' ||
    refreshToken === null ||
    expiresAt === null ||
    scope === null
  ) {
    return null;
  }
  return {
    accessToken,
    tokenType,
    ...(refreshToken === undefined ? {} : { refreshToken }),
    ...(expiresAt === undefined ? {} : { expiresAt }),
    ...(scope === undefined ? {} : { scope }),
  };
}

export function assertValidInlineSessionAuthToken(
  auth: SessionAuthRuntimeConfig,
): void {
  const rawToken = auth.token?.trim();
  if (!rawToken || isSessionSecretRef(rawToken)) return;

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawToken);
  } catch {
    throw new Error('Invalid authentication token data.');
  }
  if (!parseOAuth2TokenData(parsed)) {
    throw new Error('Invalid authentication token data.');
  }
}

function parseAuthContextBase(
  value: Record<string, unknown>,
): { method: SessionAuthMethod; bindingId: string; sessionId: string; revision: number } | null {
  const method = value['method'];
  const bindingId = value['bindingId'];
  const sessionId = value['sessionId'];
  const revision = value['revision'];
  if (
    !isSessionAuthMethod(method) ||
    !isValidAuthBindingId(bindingId) ||
    typeof sessionId !== 'string' ||
    sessionId.trim() === '' ||
    typeof revision !== 'number' ||
    !Number.isSafeInteger(revision) ||
    revision < 0
  ) {
    return null;
  }
  return { method, bindingId, sessionId, revision };
}

const AUTH_CONTEXT_BASE_KEYS = [
  'method',
  'bindingId',
  'sessionId',
  'revision',
] as const;
const AUTH_CONTEXT_GOOGLE_KEYS = [
  ...AUTH_CONTEXT_BASE_KEYS,
  'projectId',
  'managedProjectId',
  'tier',
  'tierId',
  'email',
] as const;
const AUTH_CONTEXT_CODEX_KEYS = [
  ...AUTH_CONTEXT_BASE_KEYS,
  'accountId',
  'email',
] as const;
const AUTH_CONTEXT_EMAIL_KEYS = [
  ...AUTH_CONTEXT_BASE_KEYS,
  'email',
] as const;
const AUTH_CONTEXT_ZED_KEYS = [
  ...AUTH_CONTEXT_BASE_KEYS,
  'organizationId',
  'dataCollection',
  'dataCollectionAllowed',
  'email',
] as const;

function hasOnlyAuthContextKeys(
  value: Record<string, unknown>,
  allowedKeys: readonly string[],
): boolean {
  return Object.keys(value).every((key) => allowedKeys.includes(key));
}

function immutableAuthContext<T extends AuthContext>(context: T): T {
  return Object.freeze(context);
}

export function parseAuthContext(value: unknown): AuthContext | null {
  if (!isRecord(value)) return null;
  const base = parseAuthContextBase(value);
  if (!base) return null;
  const common = {
    bindingId: base.bindingId,
    sessionId: base.sessionId,
    revision: base.revision,
  };
  switch (base.method) {
    case 'oauth2':
      return hasOnlyAuthContextKeys(value, AUTH_CONTEXT_BASE_KEYS)
        ? immutableAuthContext({ method: base.method, ...common })
        : null;
    case 'antigravity-oauth':
    case 'google-gemini-oauth': {
      if (!hasOnlyAuthContextKeys(value, AUTH_CONTEXT_GOOGLE_KEYS)) {
        return null;
      }
      const projectId = optionalString(value, 'projectId');
      const managedProjectId = optionalString(value, 'managedProjectId');
      const tierId = optionalString(value, 'tierId');
      const email = optionalString(value, 'email');
      const tier = value['tier'];
      if (
        projectId === null ||
        managedProjectId === null ||
        tierId === null ||
        email === null ||
        (tier !== undefined && tier !== 'free' && tier !== 'paid')
      ) {
        return null;
      }
      return immutableAuthContext({
        method: base.method,
        ...common,
        ...(projectId === undefined ? {} : { projectId }),
        ...(managedProjectId === undefined ? {} : { managedProjectId }),
        ...(tier === undefined ? {} : { tier }),
        ...(tierId === undefined ? {} : { tierId }),
        ...(email === undefined ? {} : { email }),
      });
    }
    case 'openai-codex': {
      if (!hasOnlyAuthContextKeys(value, AUTH_CONTEXT_CODEX_KEYS)) {
        return null;
      }
      const accountId = optionalString(value, 'accountId');
      const email = optionalString(value, 'email');
      if (accountId === null || email === null) return null;
      return immutableAuthContext({
        method: base.method,
        ...common,
        ...(accountId === undefined ? {} : { accountId }),
        ...(email === undefined ? {} : { email }),
      });
    }
    case 'claude-code':
    case 'xai-grok-oauth': {
      if (!hasOnlyAuthContextKeys(value, AUTH_CONTEXT_EMAIL_KEYS)) {
        return null;
      }
      const email = optionalString(value, 'email');
      if (email === null) return null;
      return immutableAuthContext({
        method: base.method,
        ...common,
        ...(email === undefined ? {} : { email }),
      });
    }
    case 'github-copilot':
      return hasOnlyAuthContextKeys(value, AUTH_CONTEXT_BASE_KEYS)
        ? immutableAuthContext({ method: base.method, ...common })
        : null;
    case 'zed': {
      if (!hasOnlyAuthContextKeys(value, AUTH_CONTEXT_ZED_KEYS)) {
        return null;
      }
      const organizationId = value['organizationId'];
      const dataCollection = value['dataCollection'];
      const dataCollectionAllowed = value['dataCollectionAllowed'];
      const email = optionalString(value, 'email');
      if (
        typeof organizationId !== 'string' ||
        organizationId.trim() === '' ||
        typeof dataCollection !== 'boolean' ||
        typeof dataCollectionAllowed !== 'boolean' ||
        email === null
      ) {
        return null;
      }
      return immutableAuthContext({
        method: base.method,
        ...common,
        organizationId,
        dataCollection: dataCollectionAllowed && dataCollection,
        dataCollectionAllowed,
        ...(email === undefined ? {} : { email }),
      });
    }
  }
}

function parseSnapshot(
  value: unknown,
  bindingId: string,
  revision: number,
): LocalAuthSessionSnapshotV1 | null {
  if (!isRecord(value)) return null;
  const method = value['method'];
  const staticConfigFingerprint = value['staticConfigFingerprint'];
  const epoch = value['epoch'];
  const sessionId = optionalString(value, 'sessionId');
  const clientSecret = optionalString(value, 'clientSecret');
  const createdAt = value['createdAt'];
  const updatedAt = value['updatedAt'];
  const orphanedAt = optionalFiniteNumber(value, 'orphanedAt');
  const token =
    value['token'] === undefined
      ? undefined
      : parseOAuth2TokenData(value['token']);
  const authContext =
    value['authContext'] === undefined
      ? undefined
      : parseAuthContext(value['authContext']);
  if (
    !isSessionAuthMethod(method) ||
    typeof staticConfigFingerprint !== 'string' ||
    !/^[0-9a-f]{64}$/i.test(staticConfigFingerprint) ||
    typeof epoch !== 'number' ||
    !Number.isSafeInteger(epoch) ||
    epoch < 0 ||
    sessionId === null ||
    clientSecret === null ||
    typeof createdAt !== 'number' ||
    !Number.isFinite(createdAt) ||
    createdAt < 0 ||
    typeof updatedAt !== 'number' ||
    !Number.isFinite(updatedAt) ||
    updatedAt < createdAt ||
    token === null ||
    authContext === null ||
    orphanedAt === null ||
    (orphanedAt !== undefined && orphanedAt < updatedAt)
  ) {
    return null;
  }
  if (
    (token !== undefined &&
      (sessionId === undefined || authContext === undefined)) ||
    (token === undefined &&
      (sessionId !== undefined || authContext !== undefined)) ||
    (clientSecret !== undefined && method !== 'oauth2')
  ) {
    return null;
  }
  if (
    authContext &&
    (authContext.bindingId !== bindingId ||
      authContext.method !== method ||
      authContext.revision !== revision ||
      authContext.sessionId !== sessionId)
  ) {
    return null;
  }
  return {
    method,
    staticConfigFingerprint,
    epoch,
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(token === undefined ? {} : { token }),
    ...(clientSecret === undefined ? {} : { clientSecret }),
    ...(authContext === undefined ? {} : { authContext }),
    ...(orphanedAt === undefined ? {} : { orphanedAt }),
    createdAt,
    updatedAt,
  };
}

export function parseLocalAuthStateEnvelope(value: unknown): LocalAuthStateEnvelopeV1 | null {
  if (!isRecord(value)) return null;
  const version = value['version'];
  const bindingId = value['bindingId'];
  const revision = value['revision'];
  const orphanedAt = optionalFiniteNumber(value, 'orphanedAt');
  const snapshots = value['snapshots'];
  if (
    version !== LOCAL_AUTH_STATE_VERSION ||
    !isValidAuthBindingId(bindingId) ||
    typeof revision !== 'number' ||
    !Number.isSafeInteger(revision) ||
    revision < 0 ||
    orphanedAt === null ||
    !Array.isArray(snapshots) ||
    snapshots.length > MAX_LOCAL_AUTH_SNAPSHOTS
  ) {
    return null;
  }
  const parsedSnapshots: LocalAuthSessionSnapshotV1[] = [];
  const fingerprints = new Set<string>();
  for (const snapshot of snapshots) {
    const parsed = parseSnapshot(snapshot, bindingId, revision);
    if (
      !parsed ||
      fingerprints.has(parsed.staticConfigFingerprint)
    ) {
      return null;
    }
    fingerprints.add(parsed.staticConfigFingerprint);
    parsedSnapshots.push(parsed);
  }
  return {
    version,
    bindingId,
    revision,
    ...(orphanedAt === undefined ? {} : { orphanedAt }),
    snapshots: parsedSnapshots,
  };
}

export function parseLocalAuthStateEnvelopeJson(raw: string): LocalAuthStateEnvelopeV1 | null {
  try {
    const value: unknown = JSON.parse(raw);
    return parseLocalAuthStateEnvelope(value);
  } catch {
    return null;
  }
}

export function isSessionAuthConfig(
  auth: AuthConfig | AuthRuntimeConfig,
): auth is SessionAuthRuntimeConfig {
  return isSessionAuthMethod(auth.method);
}

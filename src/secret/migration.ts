import * as vscode from 'vscode';
import type { ConfigStore } from '../config-store';
import { PROVIDER_KEYS, type ProviderType } from '../client/definitions';
import type { ProviderConfig } from '../types';
import type { AuthConfig } from '../auth/types';
import { stableStringify } from '../config-ops';
import { SecretStore } from './secret-store';
import { isLegacySecretRef, isSecretRef } from './constants';
import { t } from '../i18n';
import {
  normalizeAuthOnImport,
  supportsSensitiveAuthInSettings,
} from '../auth';
import {
  computeStaticAuthFingerprint,
  deriveLegacyAuthBindingId,
  isSessionAuthMethod,
  isValidAuthBindingId,
  parseSessionAuthConfig,
  stripSessionAuthState,
} from '../auth/local-auth-state';
import type {
  OAuth2TokenData,
  SessionAuthRuntimeConfig,
} from '../auth/types';
import {
  extractAccountIdFromClaims,
  parseJwtClaims,
} from '../auth/providers/openai-codex/oauth-client';

const LEGACY_PROVIDER_TYPE_RENAMES = {
  'claude-code-cloak': 'claude-code',
} as const;

function collectLegacySecretRefs(value: unknown, refs: Set<string>): void {
  if (typeof value === 'string') {
    if (isLegacySecretRef(value.trim())) refs.add(value.trim());
    return;
  }
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value) collectLegacySecretRefs(item, refs);
    return;
  }
  for (const item of Object.values(value as Record<string, unknown>)) {
    collectLegacySecretRefs(item, refs);
  }
}

function codexContextFromToken(
  token: OAuth2TokenData,
): { accountId: string; email?: string } | undefined {
  const claims = parseJwtClaims(token.accessToken);
  if (!claims) return undefined;
  const accountId = extractAccountIdFromClaims(claims)?.trim();
  if (!accountId) return undefined;
  const email = claims.email?.trim();
  return {
    accountId,
    ...(email ? { email } : {}),
  };
}

function clearMissingLegacySession(
  auth: SessionAuthRuntimeConfig,
): SessionAuthRuntimeConfig {
  const stripped = stripSessionAuthState(auth);
  if (
    auth.method !== 'oauth2' ||
    stripped.method !== 'oauth2' ||
    auth.oauth.grantType === 'device_code' ||
    stripped.oauth.grantType === 'device_code'
  ) {
    return stripped;
  }
  return {
    ...stripped,
    oauth: {
      ...stripped.oauth,
      clientSecret: auth.oauth.clientSecret,
    },
  };
}

function hasLegacySessionState(record: Record<string, unknown>): boolean {
  for (const key of [
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
    if (Object.prototype.hasOwnProperty.call(record, key)) return true;
  }
  const oauth = record['oauth'];
  return (
    !!oauth &&
    typeof oauth === 'object' &&
    !Array.isArray(oauth) &&
    Object.prototype.hasOwnProperty.call(oauth, 'clientSecret')
  );
}

function preserveLegacyClaudeIdentity(
  auth: SessionAuthRuntimeConfig,
  record: Record<string, unknown>,
): SessionAuthRuntimeConfig {
  if (
    auth.method !== 'claude-code' ||
    (auth.identityId?.trim() ?? '') !== ''
  ) {
    return auth;
  }
  const email = record['email'];
  if (typeof email !== 'string' || email.trim() === '') return auth;
  return { ...auth, identityId: email.trim() };
}

function sanitizeRawSessionAuth(
  record: Record<string, unknown>,
  bindingId: string,
  persisted?: AuthConfig,
): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {
    ...record,
    ...(persisted ?? {}),
    bindingId,
  };
  for (const key of [
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
    delete sanitized[key];
  }

  const rawOAuth = record['oauth'];
  const persistedOAuth =
    persisted?.method === 'oauth2' ? persisted.oauth : undefined;
  if (
    rawOAuth &&
    typeof rawOAuth === 'object' &&
    !Array.isArray(rawOAuth)
  ) {
    const oauth: Record<string, unknown> = {
      ...(rawOAuth as Record<string, unknown>),
      ...(persistedOAuth ?? {}),
    };
    delete oauth['clientSecret'];
    sanitized['oauth'] = oauth;
  } else if (persistedOAuth) {
    sanitized['oauth'] = persistedOAuth;
  }
  return sanitized;
}

type LegacyProviderType = keyof typeof LEGACY_PROVIDER_TYPE_RENAMES;
type RenamedProviderType =
  (typeof LEGACY_PROVIDER_TYPE_RENAMES)[LegacyProviderType];

function isLegacyProviderType(value: string): value is LegacyProviderType {
  return Object.prototype.hasOwnProperty.call(LEGACY_PROVIDER_TYPE_RENAMES, value);
}

export function getRenamedProviderType(
  value: string,
): RenamedProviderType | undefined {
  return isLegacyProviderType(value) ? LEGACY_PROVIDER_TYPE_RENAMES[value] : undefined;
}

export function renameLegacyProviderType(
  value: string,
): RenamedProviderType | string {
  return getRenamedProviderType(value) ?? value;
}

function isSupportedProviderType(value: string): value is ProviderType {
  return PROVIDER_KEYS.includes(value as ProviderType);
}

function getApiKeyFromAuth(auth: AuthConfig | undefined): string | undefined {
  if (!auth || typeof auth !== 'object' || Array.isArray(auth)) {
    return undefined;
  }
  const apiKey: unknown = Reflect.get(auth, 'apiKey');
  return typeof apiKey === 'string' ? apiKey : undefined;
}

/**
 * Migrate legacy API key storage format (v2.x -> v3.x).
 * In v2.x, the secret reference itself was used as the storage key.
 * In v3.x, we use a prefixed format: `ucp:api-key:<uuid>`.
 */
async function migrateLegacyApiKeyIfNeeded(
  secretStore: SecretStore,
  ref: string,
): Promise<void> {
  // Check if new format key already exists
  const newFormatValue = await secretStore.getApiKey(ref);
  if (newFormatValue) {
    return; // Already migrated
  }

  // Check if old format key exists (ref itself as key)
  const oldFormatValue = await secretStore.getLegacyApiKey(ref);
  if (oldFormatValue) {
    // Copy to new format
    await secretStore.setApiKey(ref, oldFormatValue);
    // Delete old format key
    await secretStore.deleteLegacyApiKey(ref);
  }
}

const STARTUP_MIGRATION_MAX_ATTEMPTS = 8;

type RawEndpointMigrationConfigStore = Pick<
  ConfigStore,
  'rawEndpoints' | 'setRawEndpointsIfUnchanged'
>;

interface RawEndpointMigrationResult {
  didChange: boolean;
  updated: unknown[];
}

async function migrateRawEndpointsWithRetry(options: {
  configStore: RawEndpointMigrationConfigStore;
  migrationName: string;
  build: (rawEndpoints: readonly unknown[]) => RawEndpointMigrationResult;
}): Promise<void> {
  for (
    let attempt = 0;
    attempt < STARTUP_MIGRATION_MAX_ATTEMPTS;
    attempt += 1
  ) {
    const rawEndpoints = options.configStore.rawEndpoints;
    if (!Array.isArray(rawEndpoints) || rawEndpoints.length === 0) return;

    const expectedSignature = stableStringify(rawEndpoints);
    const result = options.build(rawEndpoints);
    if (!result.didChange) {
      if (
        stableStringify(options.configStore.rawEndpoints) === expectedSignature
      ) {
        return;
      }
      continue;
    }

    if (
      await options.configStore.setRawEndpointsIfUnchanged(
        expectedSignature,
        result.updated,
      )
    ) {
      return;
    }
  }

  throw new Error(
    `${options.migrationName} could not commit because endpoints kept changing.`,
  );
}

function buildApiKeyToAuthMigration(
  rawEndpoints: readonly unknown[],
): RawEndpointMigrationResult {
  let didChange = false;
  const updated = rawEndpoints.map((item): unknown => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      return item;
    }

    const obj = item as Record<string, unknown>;
    if (!Object.prototype.hasOwnProperty.call(obj, 'apiKey')) {
      return item;
    }

    const next: Record<string, unknown> = { ...obj };
    const legacyApiKey = next['apiKey'];
    delete next['apiKey'];
    didChange = true;

    if (next['auth'] === undefined || next['auth'] === null) {
      if (typeof legacyApiKey === 'string' && legacyApiKey.trim()) {
        next['auth'] = {
          method: 'api-key',
          apiKey: legacyApiKey,
        };
      }
    }

    return next;
  });

  return { didChange, updated };
}

export async function migrateApiKeyToAuth(
  configStore: RawEndpointMigrationConfigStore,
): Promise<void> {
  await migrateRawEndpointsWithRetry({
    configStore,
    migrationName: 'API key authentication migration',
    build: buildApiKeyToAuthMigration,
  });
}

function buildProviderTypeMigration(
  rawEndpoints: readonly unknown[],
): RawEndpointMigrationResult {
  let didChange = false;
  const updated = rawEndpoints.flatMap((item): unknown[] => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      return [item];
    }

    const obj = item as Record<string, unknown>;
    const typeValue = obj['type'];
    if (typeof typeValue !== 'string') {
      return [item];
    }

    const renamed = renameLegacyProviderType(typeValue);
    if (!isSupportedProviderType(renamed)) {
      didChange = true;
      return [];
    }

    if (renamed !== typeValue) {
      didChange = true;
      return [{ ...obj, type: renamed }];
    }

    return [item];
  });

  return { didChange, updated };
}

export async function migrateProviderTypes(
  configStore: RawEndpointMigrationConfigStore,
): Promise<void> {
  await migrateRawEndpointsWithRetry({
    configStore,
    migrationName: 'Provider type migration',
    build: buildProviderTypeMigration,
  });
}

interface SessionAuthMigrationResult {
  didChange: boolean;
  updated: unknown[];
}

async function buildSessionAuthMigration(options: {
  rawEndpoints: readonly unknown[];
  secretStore: SecretStore;
}): Promise<SessionAuthMigrationResult> {
  const rawEndpoints = options.rawEndpoints;

  const configuredLegacyRefs = new Set<string>();
  collectLegacySecretRefs(rawEndpoints, configuredLegacyRefs);
  const orphanCandidates = await options.secretStore.listLegacyOAuth2TokenCandidates(
    configuredLegacyRefs,
  );
  const orphanClientSecretCandidates =
    await options.secretStore.listLegacyOAuth2ClientSecretCandidates(
      configuredLegacyRefs,
    );
  const claimedOrphanRefs = new Set<string>();
  const claimedOrphanClientSecretRefs = new Set<string>();
  let missingCodexSessionCount = 0;
  let missingClientCredentialsSecretCount = 0;
  for (const item of rawEndpoints) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const endpoint = item as Record<string, unknown>;
    const name = endpoint['name'];
    const providerType = endpoint['type'];
    const baseUrl = endpoint['baseUrl'];
    const rawAuth = endpoint['auth'];
    if (
      typeof name !== 'string' ||
      typeof providerType !== 'string' ||
      typeof baseUrl !== 'string'
    ) {
      continue;
    }
    if (!rawAuth || typeof rawAuth !== 'object' || Array.isArray(rawAuth)) {
      continue;
    }
    const authRecord = rawAuth as Record<string, unknown>;
    const method = authRecord['method'];
    if (!isSessionAuthMethod(method)) continue;
    const descriptor = {
      providerName: name,
      providerType,
      baseUrl,
      useRawBaseUrl: endpoint['useRawBaseUrl'] === true,
    };
    const existingBinding = authRecord['bindingId'];
    const hadBinding = isValidAuthBindingId(existingBinding);
    const bindingId = hadBinding
      ? existingBinding
      : deriveLegacyAuthBindingId(descriptor, { ...authRecord, method });
    const parsed = parseSessionAuthConfig(authRecord, bindingId);
    if (!parsed) continue;
    const existingSnapshot = options.secretStore
      .getLocalAuthEnvelope(bindingId)
      ?.snapshots.some(
        (snapshot) =>
          snapshot.staticConfigFingerprint ===
          computeStaticAuthFingerprint(descriptor, parsed),
      );
    if (existingSnapshot) continue;

    const hasLegacyState = hasLegacySessionState(authRecord);
    const tokenRef = parsed.token?.trim();
    const missingLegacyToken =
      !!tokenRef &&
      isLegacySecretRef(tokenRef) &&
      !(await options.secretStore.hasOAuth2Token(tokenRef));
    if (
      parsed.method === 'openai-codex' &&
      ((hadBinding && !hasLegacyState) || missingLegacyToken)
    ) {
      missingCodexSessionCount += 1;
    }

    if (
      parsed.method === 'oauth2' &&
      parsed.oauth.grantType === 'client_credentials'
    ) {
      const clientSecretRef = parsed.oauth.clientSecret?.trim();
      const missingLegacyClientSecret =
        !!clientSecretRef &&
        isLegacySecretRef(clientSecretRef) &&
        !(await options.secretStore.getOAuth2ClientSecret(clientSecretRef));
      if (
        (hadBinding && !hasLegacyState) ||
        missingLegacyClientSecret
      ) {
        missingClientCredentialsSecretCount += 1;
      }
    }
  }

  let didChange = false;
  const updated: unknown[] = [];
  for (const item of rawEndpoints) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      updated.push(item);
      continue;
    }
    const endpoint = item as Record<string, unknown>;
    const name = endpoint['name'];
    const providerType = endpoint['type'];
    const baseUrl = endpoint['baseUrl'];
    const rawAuth = endpoint['auth'];
    if (
      typeof name !== 'string' ||
      typeof providerType !== 'string' ||
      typeof baseUrl !== 'string' ||
      !rawAuth ||
      typeof rawAuth !== 'object' ||
      Array.isArray(rawAuth)
    ) {
      updated.push(item);
      continue;
    }
    const authRecord = rawAuth as Record<string, unknown>;
    const method = authRecord['method'];
    if (!isSessionAuthMethod(method)) {
      updated.push(item);
      continue;
    }
    const descriptor = {
      providerName: name,
      providerType,
      baseUrl,
      useRawBaseUrl: endpoint['useRawBaseUrl'] === true,
    };
    const existingBinding = authRecord['bindingId'];
    const hadBinding = isValidAuthBindingId(existingBinding);
    const bindingId = hadBinding
      ? existingBinding
      : deriveLegacyAuthBindingId(descriptor, { ...authRecord, method });
    const parsed = parseSessionAuthConfig(authRecord, bindingId);
    if (!parsed) {
      const nextEndpoint = {
        ...endpoint,
        auth: sanitizeRawSessionAuth(authRecord, bindingId),
      };
      if (stableStringify(nextEndpoint) !== stableStringify(item)) {
        didChange = true;
      }
      updated.push(nextEndpoint);
      continue;
    }
    const hasLegacyState = hasLegacySessionState(authRecord);
    const existingEnvelope = options.secretStore.getLocalAuthEnvelope(bindingId);
    const existingSnapshot = existingEnvelope?.snapshots.some(
      (snapshot) =>
        snapshot.staticConfigFingerprint ===
        computeStaticAuthFingerprint(descriptor, parsed),
    );
    if (existingSnapshot) {
      if (hadBinding && !hasLegacyState) {
        updated.push(item);
        continue;
      }
      const nextEndpoint = {
        ...endpoint,
        auth: sanitizeRawSessionAuth(
          authRecord,
          bindingId,
          stripSessionAuthState(parsed),
        ),
      };
      if (stableStringify(nextEndpoint) !== stableStringify(item)) {
        didChange = true;
      }
      updated.push(nextEndpoint);
      continue;
    }

    let migrationInput: SessionAuthRuntimeConfig | undefined;
    if (hadBinding && !hasLegacyState) {
      if (
        parsed.method === 'openai-codex' &&
        missingCodexSessionCount === 1
      ) {
        const matching = orphanCandidates
          .filter((candidate) => !claimedOrphanRefs.has(candidate.ref))
          .map((candidate) => ({
            candidate,
            context: codexContextFromToken(candidate.token),
          }))
          .filter(
            (entry): entry is {
              candidate: (typeof orphanCandidates)[number];
              context: { accountId: string; email?: string };
            } => entry.context !== undefined,
          );
        if (matching.length === 1) {
          const recovered = matching[0];
          claimedOrphanRefs.add(recovered.candidate.ref);
          migrationInput = {
            ...parsed,
            token: recovered.candidate.ref,
            accountId: recovered.context.accountId,
            email: recovered.context.email,
          };
        }
      } else if (
        parsed.method === 'oauth2' &&
        parsed.oauth.grantType === 'client_credentials' &&
        missingClientCredentialsSecretCount === 1
      ) {
        const matching = orphanClientSecretCandidates.filter(
          (candidate) => !claimedOrphanClientSecretRefs.has(candidate.ref),
        );
        if (matching.length === 1) {
          const recovered = matching[0];
          claimedOrphanClientSecretRefs.add(recovered.ref);
          migrationInput = {
            ...parsed,
            oauth: {
              ...parsed.oauth,
              clientSecret: recovered.ref,
            },
          };
        }
      }
      if (!migrationInput) {
        updated.push(item);
        continue;
      }
    }

    if (!migrationInput) {
      migrationInput = parsed;
    }

    if (parsed.method === 'zed' && !hadBinding) {
      migrationInput = {
        ...parsed,
        identityId: undefined,
        token: undefined,
        organizationId: undefined,
        dataCollection: false,
        dataCollectionAllowed: false,
        email: undefined,
      };
    }

    const currentTokenRef = parsed.token?.trim();
    if (
      method !== 'zed' &&
      currentTokenRef &&
      isLegacySecretRef(currentTokenRef) &&
      !(await options.secretStore.hasOAuth2Token(currentTokenRef))
    ) {
      migrationInput = clearMissingLegacySession(parsed);
      if (
        method === 'openai-codex' &&
        missingCodexSessionCount === 1
      ) {
        const matching = orphanCandidates
          .filter((candidate) => !claimedOrphanRefs.has(candidate.ref))
          .map((candidate) => ({
            candidate,
            context: codexContextFromToken(candidate.token),
          }))
          .filter(
            (entry): entry is {
              candidate: (typeof orphanCandidates)[number];
              context: { accountId: string; email?: string };
            } => entry.context !== undefined,
          );
        if (matching.length === 1) {
          const recovered = matching[0];
          claimedOrphanRefs.add(recovered.candidate.ref);
          migrationInput = {
            ...migrationInput,
            method: 'openai-codex',
            token: recovered.candidate.ref,
            accountId: recovered.context.accountId,
            email: recovered.context.email,
          };
        }
      }
    }

    if (
      parsed.method === 'oauth2' &&
      parsed.oauth.grantType === 'client_credentials' &&
      missingClientCredentialsSecretCount === 1
    ) {
      const clientSecretRef = parsed.oauth.clientSecret?.trim();
      const missingLegacyClientSecret =
        !!clientSecretRef &&
        isLegacySecretRef(clientSecretRef) &&
        !(await options.secretStore.getOAuth2ClientSecret(clientSecretRef));
      if (missingLegacyClientSecret) {
        const matching = orphanClientSecretCandidates.filter(
          (candidate) => !claimedOrphanClientSecretRefs.has(candidate.ref),
        );
        if (matching.length === 1) {
          const recovered = matching[0];
          claimedOrphanClientSecretRefs.add(recovered.ref);
          migrationInput = {
            ...migrationInput,
            method: 'oauth2',
            oauth: {
              ...parsed.oauth,
              clientSecret: recovered.ref,
            },
          };
        }
      }
    }
    migrationInput = preserveLegacyClaudeIdentity(migrationInput, authRecord);
    const staticAuth = await options.secretStore.persistSessionAuth(
      descriptor,
      migrationInput,
      {
        reason: 'migration',
        emptyToken: 'preserve',
        binding: 'legacy-deterministic',
      },
    );
    const nextEndpoint = {
      ...endpoint,
      auth: sanitizeRawSessionAuth(authRecord, bindingId, staticAuth),
    };
    if (stableStringify(nextEndpoint) !== stableStringify(item)) {
      didChange = true;
    }
    updated.push(nextEndpoint);
  }

  return { didChange, updated };
}

/**
 * Moves device session state out of synced endpoint configuration.
 * Only the auth object is replaced so unknown endpoint fields survive intact.
 */
export async function migrateSessionAuthState(options: {
  configStore: Pick<
    ConfigStore,
    'rawEndpoints' | 'setRawEndpointsIfUnchanged'
  >;
  secretStore: SecretStore;
}): Promise<void> {
  await options.secretStore.initializeLocalAuthState();

  for (
    let attempt = 0;
    attempt < STARTUP_MIGRATION_MAX_ATTEMPTS;
    attempt += 1
  ) {
    const rawEndpoints = options.configStore.rawEndpoints;
    if (rawEndpoints.length === 0) return;
    const expectedSignature = stableStringify(rawEndpoints);
    const result = await buildSessionAuthMigration({
      rawEndpoints,
      secretStore: options.secretStore,
    });
    if (!result.didChange) {
      if (
        stableStringify(options.configStore.rawEndpoints) === expectedSignature
      ) {
        return;
      }
      continue;
    }
    if (
      await options.configStore.setRawEndpointsIfUnchanged(
        expectedSignature,
        result.updated,
      )
    ) {
      return;
    }
  }

  throw new Error(
    'Session authentication migration could not commit because endpoints kept changing.',
  );
}

export async function migrateApiKeyStorage(options: {
  configStore: ConfigStore;
  secretStore: SecretStore;
  storeApiKeyInSettings: boolean;
  showProgress: boolean;
}): Promise<void> {
  const work = async (): Promise<void> => {
    const providers = options.configStore.endpoints;
    if (providers.length === 0) {
      return;
    }

    // Migrate legacy secret storage keys (v2.x -> v3.x)
    for (const provider of providers) {
      const apiKey = getApiKeyFromAuth(provider.auth);
      if (apiKey && isSecretRef(apiKey)) {
        await migrateLegacyApiKeyIfNeeded(options.secretStore, apiKey);
      }
    }

    let didChange = false;
    const updated: ProviderConfig[] = [];

    for (const p of providers) {
      const provider = { ...p };
      const auth = provider.auth;

      if (auth && auth.method !== 'none') {
        const before = stableStringify(auth);

        const storeSecretsInSettings =
          options.storeApiKeyInSettings &&
          supportsSensitiveAuthInSettings(auth);

        const normalized = await normalizeAuthOnImport(auth, {
          secretStore: options.secretStore,
          storeSecretsInSettings,
          existing: auth,
        });

        provider.auth = normalized;

        if (stableStringify(provider.auth) !== before) {
          didChange = true;
        }
      }

      updated.push(provider);
    }

    if (didChange) {
      await options.configStore.setEndpoints(updated);
    }
  };

  if (options.showProgress) {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: t('Migrating secret storage...'),
        cancellable: false,
      },
      work,
    );
    return;
  }

  await work();
}

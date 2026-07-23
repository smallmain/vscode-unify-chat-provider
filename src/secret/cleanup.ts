import * as vscode from 'vscode';
import { CONFIG_NAMESPACE } from '../config-store';
import {
  SecretStore,
  type ActiveLocalAuthFingerprint,
} from './secret-store';
import {
  isSecretRef,
  extractUuidFromStorageKey,
  buildRefFromUuid,
  SECRET_KEY_PREFIXES,
  DEVICE_STATE_STORAGE_PREFIX,
  ORPHAN_SECRET_RETENTION_MS,
} from './constants';
import {
  isValidAuthBindingId,
  LOCAL_AUTH_STATE_KEY_PREFIX,
  computeStaticAuthFingerprint,
  parseSessionAuthConfig,
  stableAuthStateStringify,
} from '../auth/local-auth-state';

export { ORPHAN_SECRET_RETENTION_MS } from './constants';
const GC_STATE_KEY = 'secret-gc-v1';
const AUTH_STATE_STORAGE_PREFIX =
  `${DEVICE_STATE_STORAGE_PREFIX}${LOCAL_AUTH_STATE_KEY_PREFIX}`;

interface SecretGcStateV1 {
  version: 1;
  orphanedAt: Record<string, number>;
}

function collectSecretRefsFromAny(raw: unknown, refs: Set<string>): void {
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (trimmed && isSecretRef(trimmed)) {
      refs.add(trimmed);
    }
    return;
  }

  if (!raw || typeof raw !== 'object') {
    return;
  }

  if (Array.isArray(raw)) {
    for (const item of raw) {
      collectSecretRefsFromAny(item, refs);
    }
    return;
  }

  for (const value of Object.values(raw as Record<string, unknown>)) {
    collectSecretRefsFromAny(value, refs);
  }
}

function readConfiguredEndpoints(): unknown[] {
  const value = vscode.workspace
    .getConfiguration(CONFIG_NAMESPACE)
    .get<unknown[]>('endpoints');
  return Array.isArray(value) ? value : [];
}

function collectUsedSecretRefsFromConfiguredEndpoints(
  endpoints: readonly unknown[] = readConfiguredEndpoints(),
): Set<string> {
  const refs = new Set<string>();
  collectSecretRefsFromAny(endpoints, refs);
  return refs;
}

function collectActiveLocalAuthFingerprints(
  endpoints: readonly unknown[] = readConfiguredEndpoints(),
): ActiveLocalAuthFingerprint[] {
  const active: ActiveLocalAuthFingerprint[] = [];
  for (const value of endpoints) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const endpoint = value as Record<string, unknown>;
    const providerName = endpoint['name'];
    const providerType = endpoint['type'];
    const baseUrl = endpoint['baseUrl'];
    const rawAuth = endpoint['auth'];
    if (
      typeof providerName !== 'string' ||
      typeof providerType !== 'string' ||
      typeof baseUrl !== 'string' ||
      !rawAuth ||
      typeof rawAuth !== 'object' ||
      Array.isArray(rawAuth)
    ) {
      continue;
    }
    const authRecord = rawAuth as Record<string, unknown>;
    const bindingId = authRecord['bindingId'];
    if (!isValidAuthBindingId(bindingId)) continue;
    const auth = parseSessionAuthConfig(authRecord, bindingId);
    if (!auth) continue;
    active.push({
      providerName,
      bindingId,
      method: auth.method,
      fingerprint: computeStaticAuthFingerprint(
        {
          providerType,
          baseUrl,
          useRawBaseUrl: endpoint['useRawBaseUrl'] === true,
        },
        auth,
      ),
    });
  }
  return active;
}

export async function reconcileLocalAuthStateWithConfiguredEndpoints(
  secretStore: SecretStore,
  now = Date.now(),
): Promise<void> {
  await secretStore.reconcileLocalAuthSnapshots(
    collectActiveLocalAuthFingerprints(),
    now,
    { pruneExpired: false },
  );
}

function parseGcState(raw: string | undefined): SecretGcStateV1 {
  if (!raw) return { version: 1, orphanedAt: {} };
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return { version: 1, orphanedAt: {} };
    }
    const record = value as Record<string, unknown>;
    const entries = record['orphanedAt'];
    if (
      record['version'] !== 1 ||
      !entries ||
      typeof entries !== 'object' ||
      Array.isArray(entries)
    ) {
      return { version: 1, orphanedAt: {} };
    }
    const orphanedAt: Record<string, number> = {};
    for (const [key, timestamp] of Object.entries(entries)) {
      if (
        typeof timestamp === 'number' &&
        Number.isFinite(timestamp) &&
        timestamp >= 0
      ) {
        orphanedAt[key] = timestamp;
      }
    }
    return { version: 1, orphanedAt };
  } catch {
    return { version: 1, orphanedAt: {} };
  }
}

function isSupportedSecretKeyUsed(
  key: string,
  usedRefs: ReadonlySet<string>,
  usedBindingIds: ReadonlySet<string>,
): boolean {
  if (key.startsWith(AUTH_STATE_STORAGE_PREFIX)) {
    const bindingId = key.slice(AUTH_STATE_STORAGE_PREFIX.length);
    return isValidAuthBindingId(bindingId) && usedBindingIds.has(bindingId);
  }
  const uuid = extractUuidFromStorageKey(key);
  if (!uuid) return false;
  const ref = buildRefFromUuid(uuid);
  return isSecretRef(ref) && usedRefs.has(ref);
}

function isSupportedSecretKey(key: string): boolean {
  return (
    key.startsWith(SECRET_KEY_PREFIXES.apiKey) ||
    key.startsWith(SECRET_KEY_PREFIXES.oauth2ClientSecret) ||
    key.startsWith(SECRET_KEY_PREFIXES.oauth2Token) ||
    key.startsWith(AUTH_STATE_STORAGE_PREFIX)
  );
}

export async function cleanupUnusedSecrets(
  secretStore: SecretStore,
  options: { now?: number } = {},
): Promise<void> {
  const now = options.now ?? Date.now();
  let configurationChanged = false;
  const subscription = vscode.workspace.onDidChangeConfiguration((event) => {
    if (event.affectsConfiguration(`${CONFIG_NAMESPACE}.endpoints`)) {
      configurationChanged = true;
    }
  });
  const endpoints = readConfiguredEndpoints();
  const endpointsSignature = stableAuthStateStringify(endpoints);
  const gcStateBefore = await secretStore.getDeviceState(GC_STATE_KEY);
  const allKeys = await secretStore.getAllKeys();
  const supportedKeys = allKeys.filter(isSupportedSecretKey);
  const backup = new Map<string, string>();
  for (const key of supportedKeys) {
    const stored = await secretStore.getOwnedSecretByKey(key);
    if (stored !== undefined) backup.set(key, stored);
  }

  const configurationIsCurrent = (): boolean =>
    !configurationChanged &&
    stableAuthStateStringify(readConfiguredEndpoints()) === endpointsSignature;
  const deletedKeys = new Set<string>();
  let restored = false;
  const restore = async (): Promise<void> => {
    if (restored) return;
    restored = true;
    for (const [key, stored] of backup) {
      if (key.startsWith(AUTH_STATE_STORAGE_PREFIX)) {
        if ((await secretStore.getOwnedSecretByKey(key)) !== stored) {
          await secretStore.restoreOwnedSecretByKey(key, stored);
        }
      } else if (deletedKeys.has(key)) {
        await secretStore.restoreOwnedSecretByKey(key, stored);
      }
    }
    const currentEndpoints = readConfiguredEndpoints();
    const currentAuth = collectActiveLocalAuthFingerprints(currentEndpoints);
    const currentRefs = collectUsedSecretRefsFromConfiguredEndpoints(
      currentEndpoints,
    );
    const currentBindingIds = new Set(
      currentAuth.map((item) => item.bindingId),
    );
    const restoredGcState = parseGcState(gcStateBefore);
    for (const key of supportedKeys) {
      if (isSupportedSecretKeyUsed(key, currentRefs, currentBindingIds)) {
        delete restoredGcState.orphanedAt[key];
      }
    }
    if (Object.keys(restoredGcState.orphanedAt).length === 0) {
      await secretStore.deleteDeviceState(GC_STATE_KEY);
    } else {
      await secretStore.setDeviceState(
        GC_STATE_KEY,
        JSON.stringify(restoredGcState),
      );
    }
    await secretStore.reconcileLocalAuthSnapshots(
      currentAuth,
      now,
      { pruneExpired: false },
    );
  };

  try {
    const activeAuth = collectActiveLocalAuthFingerprints(endpoints);
    const usedRefs = collectUsedSecretRefsFromConfiguredEndpoints(endpoints);
    const usedBindingIds = new Set(activeAuth.map((item) => item.bindingId));
    const gcState = parseGcState(gcStateBefore);
    const seenSupported = new Set<string>();
    const toDelete: string[] = [];

    await secretStore.reconcileLocalAuthSnapshots(activeAuth, now, {
      pruneExpired: false,
    });

    for (const key of supportedKeys) {
      const isAuthStateKey = key.startsWith(AUTH_STATE_STORAGE_PREFIX);
      const bindingId = isAuthStateKey
        ? key.slice(AUTH_STATE_STORAGE_PREFIX.length)
        : undefined;
      if (
        bindingId &&
        isValidAuthBindingId(bindingId) &&
        secretStore.isLocalAuthTombstone(bindingId)
      ) {
        delete gcState.orphanedAt[key];
        continue;
      }
      seenSupported.add(key);
      if (isSupportedSecretKeyUsed(key, usedRefs, usedBindingIds)) {
        delete gcState.orphanedAt[key];
        continue;
      }
      const envelopeOrphanedAt =
        bindingId && isValidAuthBindingId(bindingId)
          ? secretStore.getLocalAuthEnvelope(bindingId)?.orphanedAt
          : undefined;
      const firstSeen = envelopeOrphanedAt ?? gcState.orphanedAt[key];
      if (firstSeen === undefined) {
        gcState.orphanedAt[key] = now;
      } else {
        gcState.orphanedAt[key] = firstSeen;
        if (now - firstSeen >= ORPHAN_SECRET_RETENTION_MS) {
          toDelete.push(key);
        }
      }
    }

    for (const key of Object.keys(gcState.orphanedAt)) {
      if (!seenSupported.has(key)) delete gcState.orphanedAt[key];
    }

    await secretStore.reconcileLocalAuthSnapshots(activeAuth, now);
    if (configurationIsCurrent()) {
      for (const key of toDelete) {
        if (!configurationIsCurrent()) break;
        const original = backup.get(key);
        if (
          original === undefined ||
          (await secretStore.getOwnedSecretByKey(key)) !== original
        ) {
          delete gcState.orphanedAt[key];
          continue;
        }
        if (!key.startsWith(AUTH_STATE_STORAGE_PREFIX)) {
          deletedKeys.add(key);
        }
        await secretStore.deleteByKey(key);
        delete gcState.orphanedAt[key];
      }
    }

    if (Object.keys(gcState.orphanedAt).length === 0) {
      await secretStore.deleteDeviceState(GC_STATE_KEY);
    } else {
      await secretStore.setDeviceState(GC_STATE_KEY, JSON.stringify(gcState));
    }
    if (!configurationIsCurrent()) await restore();
  } catch (error) {
    await restore();
    throw error;
  } finally {
    subscription.dispose();
  }
}

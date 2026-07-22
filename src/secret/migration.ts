import * as vscode from 'vscode';
import type { ConfigStore } from '../config-store';
import { PROVIDER_KEYS, type ProviderType } from '../client/definitions';
import type { ProviderConfig } from '../types';
import type { AuthConfig } from '../auth/types';
import { stableStringify } from '../config-ops';
import { SecretStore } from './secret-store';
import { isSecretRef } from './constants';
import { t } from '../i18n';
import { getAuthMethodCtor } from '../auth';

const LEGACY_PROVIDER_TYPE_RENAMES = {
  'claude-code-cloak': 'claude-code',
} as const;

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

export async function migrateApiKeyToAuth(
  configStore: ConfigStore,
): Promise<void> {
  const rawEndpoints = configStore.rawEndpoints;
  if (!Array.isArray(rawEndpoints) || rawEndpoints.length === 0) {
    return;
  }

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

  if (didChange) {
    await configStore.setRawEndpoints(updated);
  }
}

export async function migrateProviderTypes(
  configStore: ConfigStore,
): Promise<void> {
  const rawEndpoints = configStore.rawEndpoints;
  if (!Array.isArray(rawEndpoints) || rawEndpoints.length === 0) {
    return;
  }

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

  if (didChange) {
    await configStore.setRawEndpoints(updated);
  }
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

        const ctor = getAuthMethodCtor(auth.method);
        if (!ctor) {
          updated.push(provider);
          continue;
        }

        const storeSecretsInSettings =
          options.storeApiKeyInSettings && ctor.supportsSensitiveDataInSettings(auth);

        const normalized = await ctor.normalizeOnImport(auth, {
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

export async function deleteApiKeySecretIfUnused(options: {
  secretStore: SecretStore;
  providers: readonly ProviderConfig[];
  apiKeyRef: string;
}): Promise<void> {
  if (!isSecretRef(options.apiKeyRef)) {
    return;
  }

  const stillUsed = options.providers.some((p) => {
    return getApiKeyFromAuth(p.auth)?.trim() === options.apiKeyRef;
  });

  if (!stillUsed) {
    await options.secretStore.deleteApiKey(options.apiKeyRef);
  }
}

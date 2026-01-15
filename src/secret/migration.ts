import * as vscode from 'vscode';
import type { ConfigStore } from '../config-store';
import type { ProviderConfig } from '../types';
import type { AuthConfig } from '../auth/types';
import { stableStringify } from '../config-ops';
import { SecretStore } from './secret-store';
import { isSecretRef } from './constants';
import { t } from '../i18n';
import { getAuthMethodCtor } from '../auth';

function getApiKeyFromAuth(auth: AuthConfig | undefined): string | undefined {
  if (!auth || typeof auth !== 'object' || Array.isArray(auth)) {
    return undefined;
  }
  const record = auth as unknown as Record<string, unknown>;
  const apiKey = record['apiKey'];
  return typeof apiKey === 'string' ? apiKey : undefined;
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

    let didChange = false;
    const updated: ProviderConfig[] = [];

    for (const p of providers) {
      const provider = { ...p };
      const auth = provider.auth;

      if (auth && auth.method !== 'none') {
        const before = stableStringify(auth);

        const normalized = await getAuthMethodCtor(
          auth.method,
        )!.normalizeOnImport(auth, {
          secretStore: options.secretStore,
          storeSecretsInSettings: options.storeApiKeyInSettings,
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

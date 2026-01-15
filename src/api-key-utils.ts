import * as vscode from 'vscode';
import type { ProviderConfig } from './types';
import type { SecretStore } from './secret';
import type { AuthConfig } from './auth/types';
import { t } from './i18n';

export const MISSING_API_KEY_FOR_COPY_MESSAGE = t(
  'API key is missing. Please re-enter it before exporting the configuration.',
);

function getApiKeyFromAuth(auth: AuthConfig | undefined): string | undefined {
  if (!auth || typeof auth !== 'object' || Array.isArray(auth)) {
    return undefined;
  }
  const record = auth as unknown as Record<string, unknown>;
  const apiKey = record['apiKey'];
  return typeof apiKey === 'string' ? apiKey : undefined;
}

function setAuthApiKey(auth: AuthConfig, apiKey: string | undefined): AuthConfig {
  if (!auth || typeof auth !== 'object' || Array.isArray(auth)) {
    return auth;
  }
  return { ...(auth as unknown as Record<string, unknown>), apiKey } as AuthConfig;
}

export async function resolveAuthApiKeyForExport(
  secretStore: SecretStore,
  rawApiKey: string | undefined,
): Promise<{ kind: 'ok'; apiKey: string | undefined } | { kind: 'missing-secret' }> {
  const status = await secretStore.getApiKeyStatus(rawApiKey);
  if (status.kind === 'unset') return { kind: 'ok', apiKey: undefined };
  if (status.kind === 'plain') return { kind: 'ok', apiKey: status.apiKey };
  if (status.kind === 'secret') return { kind: 'ok', apiKey: status.apiKey };
  return { kind: 'missing-secret' };
}

export async function resolveApiKeyForExportOrShowError(
  secretStore: SecretStore,
  config: { auth?: AuthConfig },
  options?: { message?: string; includeSensitive?: boolean },
): Promise<boolean> {
  const rawApiKey = getApiKeyFromAuth(config.auth);
  if (rawApiKey === undefined) {
    return true;
  }

  if (options?.includeSensitive === false) {
    if (config.auth) {
      config.auth = setAuthApiKey(config.auth, undefined);
    }
    return true;
  }

  const message = options?.message ?? MISSING_API_KEY_FOR_COPY_MESSAGE;

  const resolved = await resolveAuthApiKeyForExport(secretStore, rawApiKey);
  if (resolved.kind === 'missing-secret') {
    vscode.window.showErrorMessage(message, { modal: true });
    return false;
  }

  if (config.auth) {
    config.auth = setAuthApiKey(config.auth, resolved.apiKey);
  }

  return true;
}

export async function resolveProvidersForExportOrShowError(options: {
  secretStore: SecretStore;
  providers: readonly ProviderConfig[];
  message?: string;
  includeSensitive?: boolean;
}): Promise<ProviderConfig[] | undefined> {
  const resolvedProviders: ProviderConfig[] = [];
  const missing: string[] = [];

  for (const provider of options.providers) {
    const rawApiKey = getApiKeyFromAuth(provider.auth);
    if (rawApiKey === undefined) {
      resolvedProviders.push({ ...provider });
      continue;
    }

    if (options.includeSensitive === false) {
      resolvedProviders.push({
        ...provider,
        auth: provider.auth ? setAuthApiKey(provider.auth, undefined) : undefined,
      });
      continue;
    }

    const resolved = await resolveAuthApiKeyForExport(options.secretStore, rawApiKey);
    if (resolved.kind === 'missing-secret') {
      missing.push(provider.name);
      continue;
    }

    resolvedProviders.push({
      ...provider,
      auth: provider.auth ? setAuthApiKey(provider.auth, resolved.apiKey) : undefined,
    });
  }

  if (missing.length > 0) {
    const message =
      options.message ??
      t(
        'API key is missing for: {0}. Please re-enter before exporting.',
        missing.join(', '),
      );
    vscode.window.showErrorMessage(message, { modal: true });
    return undefined;
  }

  return resolvedProviders;
}

export async function deleteProviderApiKeySecretIfUnused(options: {
  secretStore: SecretStore;
  providers: readonly ProviderConfig[];
  providerName: string;
}): Promise<void> {
  const provider = options.providers.find((p) => p.name === options.providerName);
  const rawApiKey = getApiKeyFromAuth(provider?.auth)?.trim();
  if (!rawApiKey) {
    return;
  }

  const status = await options.secretStore.getApiKeyStatus(rawApiKey);
  if (status.kind !== 'secret' && status.kind !== 'missing-secret') {
    return;
  }

  const stillUsed = options.providers.some((p) => {
    if (p.name === options.providerName) return false;
    return getApiKeyFromAuth(p.auth)?.trim() === rawApiKey;
  });

  if (stillUsed) {
    return;
  }

  await options.secretStore.deleteApiKey(rawApiKey);
}

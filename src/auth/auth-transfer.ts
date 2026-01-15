import * as vscode from 'vscode';
import type { ProviderConfig } from '../types';
import type { SecretStore } from '../secret';
import type { AuthConfig } from './types';
import { t } from '../i18n';
import { getAuthMethodCtor } from './definitions';

export async function resolveAuthForExportOrShowError(
  secretStore: SecretStore,
  config: { auth?: AuthConfig },
  options: { includeSensitive: boolean; message?: string },
): Promise<boolean> {
  const auth = config.auth;
  if (!auth) {
    return true;
  }

  if (!options.includeSensitive) {
    config.auth = getAuthMethodCtor(auth.method)?.redactForExport(auth) ?? auth;
    return true;
  }

  try {
    config.auth =
      (await getAuthMethodCtor(auth.method)?.resolveForExport(
        auth,
        secretStore,
      )) ?? auth;
    return true;
  } catch {
    vscode.window.showErrorMessage(
      options.message ??
        t(
          'Sensitive data is missing. Please re-authenticate before exporting.',
        ),
      { modal: true },
    );
    return false;
  }
}

export async function resolveProviderForExportOrShowError(options: {
  secretStore: SecretStore;
  provider: ProviderConfig;
  includeSensitive: boolean;
  message?: string;
}): Promise<ProviderConfig | undefined> {
  const auth = options.provider.auth;
  if (!auth) {
    return { ...options.provider };
  }

  if (!options.includeSensitive) {
    return {
      ...options.provider,
      auth: getAuthMethodCtor(auth.method)?.redactForExport(auth) ?? auth,
    };
  }

  try {
    const resolved =
      (await getAuthMethodCtor(auth.method)?.resolveForExport(
        auth,
        options.secretStore,
      )) ?? auth;
    return { ...options.provider, auth: resolved };
  } catch {
    const message =
      options.message ??
      t(
        'Sensitive data is missing for provider "{0}". Please re-authenticate before exporting.',
        options.provider.name,
      );
    vscode.window.showErrorMessage(message, { modal: true });
    return undefined;
  }
}

export async function resolveProvidersForExportOrShowError(options: {
  secretStore: SecretStore;
  providers: readonly ProviderConfig[];
  includeSensitive: boolean;
  message?: string;
}): Promise<ProviderConfig[] | undefined> {
  if (!options.includeSensitive) {
    return options.providers.map((p) => {
      if (!p.auth) return { ...p };
      return {
        ...p,
        auth:
          getAuthMethodCtor(p.auth.method)?.redactForExport(p.auth) ?? p.auth,
      };
    });
  }

  const resolvedProviders: ProviderConfig[] = [];
  const missing: string[] = [];

  for (const provider of options.providers) {
    if (!provider.auth) {
      resolvedProviders.push({ ...provider });
      continue;
    }

    try {
      const resolvedAuth =
        (await getAuthMethodCtor(provider.auth.method)?.resolveForExport(
          provider.auth,
          options.secretStore,
        )) ?? provider.auth;
      resolvedProviders.push({ ...provider, auth: resolvedAuth });
    } catch {
      missing.push(provider.name);
    }
  }

  if (missing.length > 0) {
    const message =
      options.message ??
      t(
        'Sensitive data is missing for: {0}. Please re-authenticate before exporting.',
        missing.join(', '),
      );
    vscode.window.showErrorMessage(message, { modal: true });
    return undefined;
  }

  return resolvedProviders;
}

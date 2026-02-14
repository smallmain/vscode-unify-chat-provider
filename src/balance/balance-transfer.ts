import * as vscode from 'vscode';
import { t } from '../i18n';
import type { SecretStore } from '../secret';
import type { ProviderConfig } from '../types';
import type { BalanceConfig } from './types';
import { getBalanceMethodDefinition } from './definitions';

async function resolveBalanceForExport(options: {
  secretStore: SecretStore;
  balanceProvider: BalanceConfig;
  includeSensitive: boolean;
}): Promise<BalanceConfig> {
  const definition = getBalanceMethodDefinition(options.balanceProvider.method);
  if (!definition) {
    return options.balanceProvider;
  }

  if (!options.includeSensitive) {
    return definition.redactForExport(options.balanceProvider);
  }

  return definition.resolveForExport(options.balanceProvider, options.secretStore);
}

export async function resolveBalanceForExportOrShowError(
  secretStore: SecretStore,
  config: { balanceProvider?: BalanceConfig },
  options: { includeSensitive: boolean; message?: string },
): Promise<boolean> {
  const balanceProvider = config.balanceProvider;
  if (!balanceProvider || balanceProvider.method === 'none') {
    return true;
  }

  try {
    config.balanceProvider = await resolveBalanceForExport({
      secretStore,
      balanceProvider,
      includeSensitive: options.includeSensitive,
    });
    return true;
  } catch {
    vscode.window.showErrorMessage(
      options.message ??
        t(
          'Sensitive balance data is missing. Please reconfigure balance monitoring before exporting.',
        ),
      { modal: true },
    );
    return false;
  }
}

export async function resolveProviderBalanceForExportOrShowError(options: {
  secretStore: SecretStore;
  provider: ProviderConfig;
  includeSensitive: boolean;
  message?: string;
}): Promise<ProviderConfig | undefined> {
  const balanceProvider = options.provider.balanceProvider;
  if (!balanceProvider || balanceProvider.method === 'none') {
    return { ...options.provider };
  }

  try {
    const resolved = await resolveBalanceForExport({
      secretStore: options.secretStore,
      balanceProvider,
      includeSensitive: options.includeSensitive,
    });

    return { ...options.provider, balanceProvider: resolved };
  } catch {
    const message =
      options.message ??
      t(
        'Sensitive balance data is missing for provider "{0}". Please reconfigure balance monitoring before exporting.',
        options.provider.name,
      );
    vscode.window.showErrorMessage(message, { modal: true });
    return undefined;
  }
}

export async function resolveProvidersBalanceForExportOrShowError(options: {
  secretStore: SecretStore;
  providers: readonly ProviderConfig[];
  includeSensitive: boolean;
  message?: string;
}): Promise<ProviderConfig[] | undefined> {
  const resolvedProviders: ProviderConfig[] = [];
  const missing: string[] = [];

  for (const provider of options.providers) {
    const balanceProvider = provider.balanceProvider;
    if (!balanceProvider || balanceProvider.method === 'none') {
      resolvedProviders.push({ ...provider });
      continue;
    }

    try {
      const resolvedBalance = await resolveBalanceForExport({
        secretStore: options.secretStore,
        balanceProvider,
        includeSensitive: options.includeSensitive,
      });
      resolvedProviders.push({ ...provider, balanceProvider: resolvedBalance });
    } catch {
      missing.push(provider.name);
    }
  }

  if (missing.length > 0) {
    const message =
      options.message ??
      t(
        'Sensitive balance data is missing for: {0}. Please reconfigure balance monitoring before exporting.',
        missing.join(', '),
      );
    vscode.window.showErrorMessage(message, { modal: true });
    return undefined;
  }

  return resolvedProviders;
}

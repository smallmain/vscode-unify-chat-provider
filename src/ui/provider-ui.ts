import * as vscode from 'vscode';
import { ConfigStore } from '../config-store';
import { showCopiedBase64Config } from './base64-config';
import {
  promptForProviderImportConfig,
} from './import-from-config';
import { runUiStack } from './router/stack-router';
import type { UiContext } from './router/types';
import { runRemoveProviderScreen } from './screens/remove-provider-screen';
import type { ApiKeySecretStore } from '../api-key-secret-store';
import { resolveProvidersForExportOrShowError } from '../api-key-utils';
import { t } from '../i18n';

export async function manageProviders(
  store: ConfigStore,
  apiKeyStore: ApiKeySecretStore,
): Promise<void> {
  const ctx: UiContext = { store, apiKeyStore };
  await runUiStack(ctx, { kind: 'providerList' });
}

export async function addProvider(
  store: ConfigStore,
  apiKeyStore: ApiKeySecretStore,
): Promise<void> {
  const ctx: UiContext = { store, apiKeyStore };
  await runUiStack(ctx, { kind: 'providerForm' });
}

export async function addProviderFromConfig(
  store: ConfigStore,
  apiKeyStore: ApiKeySecretStore,
): Promise<void> {
  const ctx: UiContext = { store, apiKeyStore };
  const imported = await promptForProviderImportConfig();
  if (!imported) return;

  if (imported.kind === 'multiple') {
    await runUiStack(ctx, {
      kind: 'importProviderConfigArray',
      configs: imported.configs,
    });
    return;
  }

  await runUiStack(ctx, { kind: 'providerForm', initialConfig: imported.config });
}

export async function addProviderFromWellKnownList(
  store: ConfigStore,
  apiKeyStore: ApiKeySecretStore,
): Promise<void> {
  const ctx: UiContext = { store, apiKeyStore };
  await runUiStack(ctx, { kind: 'wellKnownProviderList' });
}

export async function importProviders(
  store: ConfigStore,
  apiKeyStore: ApiKeySecretStore,
): Promise<void> {
  const ctx: UiContext = { store, apiKeyStore };
  await runUiStack(ctx, { kind: 'importProviders' });
}

export async function exportAllProviders(
  store: ConfigStore,
  apiKeyStore: ApiKeySecretStore,
): Promise<void> {
  const providers = store.endpoints;
  if (providers.length === 0) {
    vscode.window.showInformationMessage(t('No providers configured.'));
    return;
  }

  const resolved = await resolveProvidersForExportOrShowError({
    apiKeyStore,
    providers,
  });
  if (!resolved) return;
  await showCopiedBase64Config(resolved);
}

export async function removeProvider(
  store: ConfigStore,
  apiKeyStore: ApiKeySecretStore,
): Promise<void> {
  await runRemoveProviderScreen(store, apiKeyStore);
}

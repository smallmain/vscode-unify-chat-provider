import * as vscode from 'vscode';
import { ConfigStore } from '../config-store';
import { showCopiedBase64Config } from './base64-config';
import {
  promptForProviderImportConfig,
} from './import-from-config';
import { runUiStack } from './router/stack-router';
import type { UiContext } from './router/types';
import type { EventedUriHandler } from '../uri-handler';
import { runRemoveProviderScreen } from './screens/remove-provider-screen';
import { SecretStore } from '../secret';
import { resolveProvidersForExportOrShowError } from '../auth/auth-transfer';
import { promptForSensitiveDataInclusion } from './provider-ops';
import { t } from '../i18n';

export async function manageProviders(
  store: ConfigStore,
  secretStore: SecretStore,
  uriHandler?: EventedUriHandler,
): Promise<void> {
  const ctx: UiContext = { store, secretStore, uriHandler };
  await runUiStack(ctx, { kind: 'providerList' });
}

export async function addProvider(
  store: ConfigStore,
  secretStore: SecretStore,
  uriHandler?: EventedUriHandler,
): Promise<void> {
  const ctx: UiContext = { store, secretStore, uriHandler };
  await runUiStack(ctx, { kind: 'providerForm' });
}

export async function addProviderFromConfig(
  store: ConfigStore,
  secretStore: SecretStore,
  uriHandler?: EventedUriHandler,
): Promise<void> {
  const ctx: UiContext = { store, secretStore, uriHandler };
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
  secretStore: SecretStore,
  uriHandler?: EventedUriHandler,
): Promise<void> {
  const ctx: UiContext = { store, secretStore, uriHandler };
  await runUiStack(ctx, { kind: 'wellKnownProviderList' });
}

export async function importProviders(
  store: ConfigStore,
  secretStore: SecretStore,
  uriHandler?: EventedUriHandler,
): Promise<void> {
  const ctx: UiContext = { store, secretStore, uriHandler };
  await runUiStack(ctx, { kind: 'importProviders' });
}

export async function exportAllProviders(
  store: ConfigStore,
  secretStore: SecretStore,
  _uriHandler?: EventedUriHandler,
): Promise<void> {
  const providers = store.endpoints;
  if (providers.length === 0) {
    vscode.window.showInformationMessage(t('No providers configured.'));
    return;
  }

  const includeSensitive = await promptForSensitiveDataInclusion();
  if (includeSensitive === undefined) return;

  const resolved = await resolveProvidersForExportOrShowError({
    secretStore,
    providers,
    includeSensitive,
  });
  if (!resolved) return;
  await showCopiedBase64Config(resolved);
}

export async function removeProvider(
  store: ConfigStore,
  secretStore: SecretStore,
  _uriHandler?: EventedUriHandler,
): Promise<void> {
  await runRemoveProviderScreen(store, secretStore);
}

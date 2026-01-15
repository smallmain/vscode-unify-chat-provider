import * as vscode from 'vscode';
import type { ConfigStore } from '../../config-store';
import { confirmRemove, pickQuickItem, showRemovedMessage } from '../component';
import { getAllModelsForProvider } from '../../utils';
import { ProviderConfig } from '../../types';
import { SecretStore } from '../../secret';
import { deleteProviderApiKeySecretIfUnused } from '../../api-key-utils';
import { t } from '../../i18n';

async function buildProviderItem(
  p: ProviderConfig,
): Promise<vscode.QuickPickItem & { providerName: string }> {
  const allModels = await getAllModelsForProvider(p);
  const modelList = allModels.map((m) => m.name || m.id).join(', ');
  return {
    label: p.name,
    description: p.baseUrl,
    detail: t('{0} model(s): {1}', allModels.length, modelList),
    providerName: p.name,
  };
}

export async function runRemoveProviderScreen(
  store: ConfigStore,
  secretStore: SecretStore,
): Promise<void> {
  const endpoints = store.endpoints;
  if (endpoints.length === 0) {
    vscode.window.showInformationMessage(t('No providers configured.'));
    return;
  }

  const items = await Promise.all(endpoints.map(buildProviderItem));

  const selection = await pickQuickItem<
    vscode.QuickPickItem & { providerName: string }
  >({
    title: t('Remove Provider'),
    placeholder: t('Select a provider to remove'),
    items,
  });

  if (!selection) return;

  const confirmed = await confirmRemove(selection.providerName, 'provider');
  if (!confirmed) return;

  await deleteProviderApiKeySecretIfUnused({
    secretStore,
    providers: store.endpoints,
    providerName: selection.providerName,
  });

  await store.removeProvider(selection.providerName);
  showRemovedMessage(selection.providerName, 'Provider');
}

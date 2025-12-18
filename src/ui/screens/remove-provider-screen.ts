import * as vscode from 'vscode';
import type { ConfigStore } from '../../config-store';
import { confirmRemove, pickQuickItem, showRemovedMessage } from '../component';

export async function runRemoveProviderScreen(
  store: ConfigStore,
): Promise<void> {
  const endpoints = store.endpoints;
  if (endpoints.length === 0) {
    vscode.window.showInformationMessage('No providers configured.');
    return;
  }

  const selection = await pickQuickItem<
    vscode.QuickPickItem & { providerName: string }
  >({
    title: 'Remove Provider',
    placeholder: 'Select a provider to remove',
    items: endpoints.map((p) => ({
      label: p.name,
      description: p.baseUrl,
      detail: `${p.models.length} model(s): ${p.models
        .map((m) => m.name || m.id)
        .join(', ')}`,
      providerName: p.name,
    })),
  });

  if (!selection) return;

  const confirmed = await confirmRemove(selection.providerName, 'provider');
  if (!confirmed) return;

  await store.removeProvider(selection.providerName);
  showRemovedMessage(selection.providerName, 'Provider');
}


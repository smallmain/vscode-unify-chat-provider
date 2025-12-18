import * as vscode from 'vscode';
import { confirmDelete, pickQuickItem, showDeletedMessage } from '../component';
import {
  promptForBase64Config,
  showCopiedBase64Config,
} from '../base64-config';
import type {
  ProviderListRoute,
  UiContext,
  UiNavAction,
  UiResume,
} from '../router/types';
import { duplicateProvider } from '../provider-ops';
import { ProviderConfig } from '../../types';

type ProviderListItem = vscode.QuickPickItem & {
  action?: 'add' | 'add-from-wellknown' | 'add-from-base64' | 'provider';
  providerName?: string;
};

export async function runProviderListScreen(
  ctx: UiContext,
  _route: ProviderListRoute,
  _resume: UiResume | undefined,
): Promise<UiNavAction> {
  const selection = await pickQuickItem<ProviderListItem>({
    title: 'Manage Providers',
    placeholder: 'Select a provider to edit, or add a new one',
    ignoreFocusOut: false,
    items: buildProviderListItems(ctx.store),
    onDidTriggerItemButton: async (event, qp) => {
      const item = event.item;
      if (item.action !== 'provider' || !item.providerName) return;

      const buttonIndex = item.buttons?.findIndex((b) => b === event.button);

      if (buttonIndex === 0) {
        const provider = ctx.store.getProvider(item.providerName);
        if (provider) {
          await showCopiedBase64Config(provider);
        }
        return;
      }

      if (buttonIndex === 1) {
        const provider = ctx.store.getProvider(item.providerName);
        if (provider) {
          await duplicateProvider(ctx.store, provider);
          qp.items = buildProviderListItems(ctx.store);
        }
        return;
      }

      if (buttonIndex === 2) {
        qp.ignoreFocusOut = true;
        const confirmed = await confirmDelete(item.providerName, 'provider');
        qp.ignoreFocusOut = false;

        if (!confirmed) return;
        await ctx.store.removeProvider(item.providerName);
        showDeletedMessage(item.providerName, 'Provider');
        qp.items = buildProviderListItems(ctx.store);
      }
    },
  });

  if (!selection) return { kind: 'pop' };

  if (selection.action === 'add') {
    return { kind: 'push', route: { kind: 'providerForm' } };
  }

  if (selection.action === 'add-from-wellknown') {
    return { kind: 'push', route: { kind: 'wellKnownProviderList' } };
  }

  if (selection.action === 'add-from-base64') {
    const config = await promptForBase64Config<Partial<ProviderConfig>>({
      title: 'Add Provider From Base64 Config',
      placeholder: 'Paste Base64 configuration string...',
    });
    if (!config) return { kind: 'stay' };
    return {
      kind: 'push',
      route: { kind: 'providerForm', initialConfig: config },
    };
  }

  if (selection.providerName) {
    return {
      kind: 'push',
      route: { kind: 'providerForm', providerName: selection.providerName },
    };
  }

  return { kind: 'stay' };
}

function buildProviderListItems(store: UiContext['store']): ProviderListItem[] {
  const items: ProviderListItem[] = [
    {
      label: '$(add) Add Provider...',
      action: 'add',
      alwaysShow: true,
    },
    {
      label: '$(broadcast) Add From Well-Known Provider List...',
      action: 'add-from-wellknown',
      alwaysShow: true,
    },
    {
      label: '$(file-code) Add From Base64 Config...',
      action: 'add-from-base64',
      alwaysShow: true,
    },
  ];

  for (const provider of store.endpoints) {
    items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
    const modelList = provider.models.map((m) => m.name || m.id).join(', ');
    items.push({
      label: provider.name,
      description: provider.baseUrl,
      detail: modelList ? `Models: ${modelList}` : 'No models',
      action: 'provider',
      providerName: provider.name,
      buttons: [
        {
          iconPath: new vscode.ThemeIcon('copy'),
          tooltip: 'Copy as Base64 config',
        },
        {
          iconPath: new vscode.ThemeIcon('files'),
          tooltip: 'Duplicate provider',
        },
        {
          iconPath: new vscode.ThemeIcon('trash'),
          tooltip: 'Delete provider',
        },
      ],
    });
  }

  return items;
}

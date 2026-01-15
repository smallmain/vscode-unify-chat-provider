import * as vscode from 'vscode';
import { confirmDelete, pickQuickItem, showDeletedMessage } from '../component';
import { showCopiedBase64Config } from '../base64-config';
import {
  promptForProviderImportConfig,
} from '../import-from-config';
import type {
  ProviderListRoute,
  UiContext,
  UiNavAction,
  UiResume,
} from '../router/types';
import {
  duplicateProvider,
  exportProviderConfigFromDraft,
  saveProviderDraft,
  promptForSensitiveDataInclusion,
} from '../provider-ops';
import { createProviderDraft } from '../form-utils';
import { getAllModelsForProvider } from '../../utils';
import { deleteProviderApiKeySecretIfUnused } from '../../api-key-utils';
import { resolveProvidersForExportOrShowError } from '../../auth/auth-transfer';
import { t } from '../../i18n';

type ProviderListItem = vscode.QuickPickItem & {
  action?:
    | 'add'
    | 'add-from-wellknown'
    | 'add-from-base64'
    | 'export-all'
    | 'export-provider'
    | 'import-from-other-applications'
    | 'provider';
  providerName?: string;
};

export async function runProviderListScreen(
  ctx: UiContext,
  _route: ProviderListRoute,
  _resume: UiResume | undefined,
): Promise<UiNavAction> {
  const selection = await pickQuickItem<ProviderListItem>({
    title: t('Manage Providers'),
    placeholder: t('Select a provider to edit, or add a new one'),
    ignoreFocusOut: false,
    items: await buildProviderListItems(ctx.store),
    onDidTriggerItemButton: async (event, qp) => {
      const item = event.item;
      if (item.action !== 'provider' || !item.providerName) return;

      const buttonIndex = item.buttons?.findIndex((b) => b === event.button);

      if (buttonIndex === 0) {
        return { ...item, action: 'export-provider' };
      }

      if (buttonIndex === 1) {
        const provider = ctx.store.getProvider(item.providerName);
        if (provider) {
          await duplicateProvider(ctx.store, ctx.secretStore, provider);
          qp.items = await buildProviderListItems(ctx.store);
        }
        return;
      }

      if (buttonIndex === 2) {
        qp.ignoreFocusOut = true;
        const confirmed = await confirmDelete(item.providerName, 'provider');
        qp.ignoreFocusOut = false;

        if (!confirmed) return;
        await deleteProviderApiKeySecretIfUnused({
          secretStore: ctx.secretStore,
          providers: ctx.store.endpoints,
          providerName: item.providerName,
        });
        await ctx.store.removeProvider(item.providerName);
        showDeletedMessage(item.providerName, 'Provider');
        qp.items = await buildProviderListItems(ctx.store);
      }

      return;
    },
  });

  if (!selection) return { kind: 'pop' };

  if (selection.action === 'export-provider') {
    if (!selection.providerName) return { kind: 'stay' };

    const provider = ctx.store.getProvider(selection.providerName);
    if (!provider) {
      vscode.window.showErrorMessage(
        t('Provider "{0}" not found.', selection.providerName),
      );
      return { kind: 'stay' };
    }

    const draft = createProviderDraft(provider);
    await exportProviderConfigFromDraft({
      draft,
      secretStore: ctx.secretStore,
      allowPartial: true,
    });
    return { kind: 'stay' };
  }

  if (selection.action === 'add') {
    return { kind: 'push', route: { kind: 'providerForm' } };
  }

  if (selection.action === 'add-from-wellknown') {
    return { kind: 'push', route: { kind: 'wellKnownProviderList' } };
  }

  if (selection.action === 'add-from-base64') {
    const imported = await promptForProviderImportConfig();
    if (!imported) return { kind: 'stay' };

    if (imported.kind === 'multiple') {
      return {
        kind: 'push',
        route: { kind: 'importProviderConfigArray', configs: imported.configs },
      };
    }

    return { kind: 'push', route: { kind: 'providerForm', initialConfig: imported.config } };
  }

  if (selection.action === 'export-all') {
    const providers = ctx.store.endpoints;
    if (providers.length === 0) {
      vscode.window.showInformationMessage(t('No providers configured.'));
      return { kind: 'stay' };
    }

    const includeSensitive = await promptForSensitiveDataInclusion();
    if (includeSensitive === undefined) return { kind: 'stay' };

    const resolved = await resolveProvidersForExportOrShowError({
      secretStore: ctx.secretStore,
      providers,
      includeSensitive,
    });
    if (!resolved) return { kind: 'stay' };
    await showCopiedBase64Config(resolved);
    return { kind: 'stay' };
  }

  if (selection.action === 'import-from-other-applications') {
    return {
      kind: 'push',
      route: { kind: 'importProviders' },
    };
  }

  if (selection.providerName) {
    const existing = ctx.store.getProvider(selection.providerName);
    if (!existing) {
      vscode.window.showErrorMessage(
        t('Provider "{0}" not found.', selection.providerName),
      );
      return { kind: 'stay' };
    }

    const draft = createProviderDraft(existing);
    return {
      kind: 'push',
      route: {
        kind: 'modelList',
        invocation: 'providerEdit',
        models: draft.models,
        providerLabel: existing.name,
        requireAtLeastOne: false,
        draft,
        existing,
        originalName: existing.name,
        confirmDiscardOnBack: true,
        onSave: async () =>
          saveProviderDraft({
            draft,
            store: ctx.store,
            secretStore: ctx.secretStore,
            existing,
            originalName: existing.name,
          }),
        afterSave: 'pop',
      },
    };
  }

  return { kind: 'stay' };
}

async function buildProviderListItems(
  store: UiContext['store'],
): Promise<ProviderListItem[]> {
  const items: ProviderListItem[] = [
    {
      label: '$(add) ' + t('Add Provider...'),
      action: 'add',
      alwaysShow: true,
    },
    {
      label: '$(star-empty) ' + t('Add From Well-Known Provider List...'),
      action: 'add-from-wellknown',
      alwaysShow: true,
    },
    {
      label: '$(file-code) ' + t('Import From Config...'),
      action: 'add-from-base64',
      alwaysShow: true,
    },
    {
      label: '$(git-stash) ' + t('Import From Other Applications...'),
      action: 'import-from-other-applications',
      alwaysShow: true,
    },
  ];

  for (const provider of store.endpoints) {
    items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
    const allModels = await getAllModelsForProvider(provider);
    const modelList = allModels.map((m) => m.name || m.id).join(', ');
    items.push({
      label: provider.name,
      description: provider.baseUrl,
      detail: modelList ? t('Models: {0}', modelList) : t('No models'),
      action: 'provider',
      providerName: provider.name,
      buttons: [
        {
          iconPath: new vscode.ThemeIcon('export'),
          tooltip: t('Export as Base64 config'),
        },
        {
          iconPath: new vscode.ThemeIcon('files'),
          tooltip: t('Duplicate provider'),
        },
        {
          iconPath: new vscode.ThemeIcon('trash'),
          tooltip: t('Delete provider'),
        },
      ],
    });
  }

  if (store.endpoints.length > 0) {
    items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
  }
  items.push({
    label: '$(export) ' + t('Export All Providers...'),
    action: 'export-all',
    alwaysShow: true,
  });

  return items;
}

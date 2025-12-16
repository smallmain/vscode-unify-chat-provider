import * as vscode from 'vscode';
import { ConfigStore } from '../config-store';
import type { ProviderConfig } from '../client/interface';
import {
  confirmDelete,
  confirmRemove,
  pickQuickItem,
  showDeletedMessage,
  showRemovedMessage,
  showValidationErrors,
} from './component';
import { editField } from './field-editors';
import { buildFormItems, type FormItem } from './field-schema';
import {
  confirmDiscardProviderChanges,
  createProviderDraft,
  normalizeProviderDraft,
  validateProviderForm,
  type ProviderFormDraft,
} from './form-utils';
import {
  providerFormSchema,
  type ProviderFieldContext,
} from './provider-fields';
import { manageModelList } from './model-form';
import {
  mergePartialProviderConfig,
  promptForBase64Config,
  showCopiedBase64Config,
} from './base64-config';

export type ProviderFormResult = 'saved' | 'deleted' | 'cancelled';

type ProviderListItem = vscode.QuickPickItem & {
  action?: 'add' | 'add-from-base64' | 'provider';
  providerName?: string;
};

/**
 * Entry point for the management UI shown from the Language Model provider list.
 */
export async function manageProviders(store: ConfigStore): Promise<void> {
  for (;;) {
    const selection = await pickQuickItem<ProviderListItem>({
      title: 'Manage Providers',
      placeholder: 'Select a provider to edit, or add a new one',
      ignoreFocusOut: false,
      items: buildProviderListItems(store),
      onDidTriggerItemButton: async (event, qp) => {
        const item = event.item;
        if (item.action !== 'provider' || !item.providerName) return;

        const buttonIndex = item.buttons?.findIndex((b) => b === event.button);

        // Copy
        if (buttonIndex === 0) {
          const provider = store.getProvider(item.providerName);
          if (provider) {
            await showCopiedBase64Config(provider);
          }
          return;
        }

        // Duplicate
        if (buttonIndex === 1) {
          const provider = store.getProvider(item.providerName);
          if (provider) {
            await duplicateProvider(store, provider);
            qp.items = buildProviderListItems(store);
          }
          return;
        }

        // Delete
        if (buttonIndex === 2) {
          qp.ignoreFocusOut = true;
          const confirmed = await confirmDelete(item.providerName, 'provider');
          qp.ignoreFocusOut = false;

          if (!confirmed) return;
          await store.removeProvider(item.providerName);
          showDeletedMessage(item.providerName, 'Provider');
          qp.items = buildProviderListItems(store);
        }
      },
    });

    if (!selection) return;
    if (selection.action === 'add') {
      await openProviderForm(store);
      continue;
    }
    if (selection.action === 'add-from-base64') {
      const config = await promptForBase64Config<Partial<ProviderConfig>>({
        title: 'Add Provider From Base64 Config',
        placeholder: 'Paste Base64 configuration string...',
      });
      if (config) {
        await openProviderForm(store, undefined, config);
      }
      continue;
    }
    if (selection.providerName) {
      await openProviderForm(store, selection.providerName);
    }
  }
}

/**
 * Shortcut command to start the add-provider flow.
 */
export async function addProvider(store: ConfigStore): Promise<void> {
  await openProviderForm(store);
}

/**
 * Shortcut command to remove a provider via a simple picker.
 */
export async function removeProvider(store: ConfigStore): Promise<void> {
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

/**
 * Build the provider list items for the main management picker.
 */
function buildProviderListItems(store: ConfigStore): ProviderListItem[] {
  const items: ProviderListItem[] = [
    {
      label: '$(add) Add New Provider...',
      action: 'add',
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

/**
 * Open the provider form for adding or editing a provider.
 * @param store - The config store
 * @param providerName - The name of the provider to edit (undefined for new)
 * @param initialConfig - Initial config values to pre-fill (for add from base64)
 */
export async function openProviderForm(
  store: ConfigStore,
  providerName?: string,
  initialConfig?: Partial<ProviderConfig>,
): Promise<ProviderFormResult> {
  const existing = providerName ? store.getProvider(providerName) : undefined;
  if (providerName && !existing) {
    vscode.window.showErrorMessage(`Provider "${providerName}" not found.`);
    return 'cancelled';
  }

  const draft = createProviderDraft(existing);

  // Apply initial config if provided (for add from base64)
  if (initialConfig && !existing) {
    mergePartialProviderConfig(draft, initialConfig);
  }

  const originalName = existing?.name;

  // Create the context for field editing
  const context: ProviderFieldContext = {
    store,
    originalName,
    onEditModels: async (d: ProviderFormDraft) => {
      await manageModelList(d.models, {
        providerLabel: d.name ?? originalName ?? 'Provider',
        requireAtLeastOne: false,
        draft: d,
      });
    },
  };

  for (;;) {
    const selection = await pickQuickItem<FormItem<ProviderFormDraft>>({
      title: existing ? 'Edit Provider' : 'Add Provider',
      placeholder: 'Select a field to edit',
      ignoreFocusOut: true,
      items: buildFormItems(providerFormSchema, draft, {
        isEditing: !!existing,
      }),
    });

    if (!selection || selection.action === 'cancel') {
      const decision = await confirmDiscardProviderChanges(draft, existing);
      if (decision === 'discard') return 'cancelled';
      if (decision === 'save') {
        const saved = await saveProviderDraft(
          draft,
          store,
          existing,
          originalName,
        );
        if (saved === 'saved') return 'saved';
      }
      continue;
    }

    if (selection.action === 'delete' && existing) {
      const confirmed = await confirmDelete(existing.name, 'provider');
      if (confirmed) {
        await store.removeProvider(existing.name);
        showDeletedMessage(existing.name, 'Provider');
        return 'deleted';
      }
      continue;
    }

    if (selection.action === 'copy') {
      // Build a config from current draft for copying
      const configToCopy = buildProviderConfigFromDraft(draft);
      await showCopiedBase64Config(configToCopy);
      continue;
    }

    if (selection.action === 'duplicate' && existing) {
      await duplicateProvider(store, existing);
      continue;
    }

    if (selection.action === 'confirm') {
      const saved = await saveProviderDraft(
        draft,
        store,
        existing,
        originalName,
      );
      if (saved === 'saved') return 'saved';
      continue;
    }

    const field = selection.field;
    if (field) {
      await editField(providerFormSchema, draft, field, context);
    }
  }
}

/**
 * Save the provider draft to the store.
 */
async function saveProviderDraft(
  draft: ProviderFormDraft,
  store: ConfigStore,
  existing?: ProviderConfig,
  originalName?: string,
): Promise<'saved' | 'invalid'> {
  const errors = validateProviderForm(draft, store, originalName);
  if (errors.length > 0) {
    await showValidationErrors(errors);
    return 'invalid';
  }

  const provider = normalizeProviderDraft(draft);
  if (originalName && provider.name !== originalName) {
    await store.removeProvider(originalName);
  }
  await store.upsertProvider(provider);
  vscode.window.showInformationMessage(
    existing
      ? `Provider "${provider.name}" updated.`
      : `Provider "${provider.name}" added.`,
  );
  return 'saved';
}

/**
 * Build a partial provider config from a draft (for copying).
 */
function buildProviderConfigFromDraft(
  draft: ProviderFormDraft,
): Partial<ProviderConfig> {
  const config: Partial<ProviderConfig> = {};
  if (draft.type) config.type = draft.type;
  if (draft.name) config.name = draft.name;
  if (draft.baseUrl) config.baseUrl = draft.baseUrl;
  if (draft.apiKey) config.apiKey = draft.apiKey;
  if (draft.mimic) config.mimic = draft.mimic;
  if (draft.models.length > 0) config.models = [...draft.models];
  if (draft.extraHeaders) config.extraHeaders = { ...draft.extraHeaders };
  if (draft.extraBody) config.extraBody = { ...draft.extraBody };
  return config;
}

/**
 * Duplicate a provider with auto-incremented name.
 */
async function duplicateProvider(
  store: ConfigStore,
  provider: ProviderConfig,
): Promise<void> {
  // Generate a unique name
  let baseName = provider.name;
  let newName = `${baseName} (copy)`;
  let counter = 2;

  while (store.getProvider(newName)) {
    newName = `${baseName} (copy ${counter})`;
    counter++;
  }

  // Create the duplicated provider
  const duplicated: ProviderConfig = {
    ...provider,
    name: newName,
    models: provider.models.map((m) => ({ ...m })),
    extraHeaders: provider.extraHeaders
      ? { ...provider.extraHeaders }
      : undefined,
    extraBody: provider.extraBody ? { ...provider.extraBody } : undefined,
  };

  await store.upsertProvider(duplicated);
  vscode.window.showInformationMessage(`Provider duplicated as "${newName}".`);
}

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

export type ProviderFormResult = 'saved' | 'deleted' | 'cancelled';

type ProviderListItem = vscode.QuickPickItem & {
  action: 'add' | 'provider';
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

        qp.ignoreFocusOut = true;
        const confirmed = await confirmDelete(item.providerName, 'provider');
        qp.ignoreFocusOut = false;

        if (!confirmed) return;
        await store.removeProvider(item.providerName);
        showDeletedMessage(item.providerName, 'Provider');
        qp.items = buildProviderListItems(store);
      },
    });

    if (!selection) return;
    if (selection.action === 'add') {
      await openProviderForm(store);
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
  ];

  for (const provider of store.endpoints) {
    const modelList = provider.models.map((m) => m.name || m.id).join(', ');
    items.push({
      label: provider.name,
      description: provider.baseUrl,
      detail: modelList ? `Models: ${modelList}` : 'No models',
      action: 'provider',
      providerName: provider.name,
      buttons: [
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
 */
export async function openProviderForm(
  store: ConfigStore,
  providerName?: string,
): Promise<ProviderFormResult> {
  const existing = providerName ? store.getProvider(providerName) : undefined;
  if (providerName && !existing) {
    vscode.window.showErrorMessage(`Provider "${providerName}" not found.`);
    return 'cancelled';
  }

  const draft = createProviderDraft(existing);
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
      onWillAccept: async (item) => {
        if (item.action !== 'confirm') return true;
        const errors = validateProviderForm(draft, store, originalName);
        if (errors.length > 0) {
          await showValidationErrors(errors);
          return false;
        }
        return true;
      },
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

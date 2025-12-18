import * as vscode from 'vscode';
import { ConfigStore } from '../../config-store';
import {
  confirmDelete,
  pickQuickItem,
  showDeletedMessage,
} from '../component';
import {
  mergePartialProviderConfig,
  showCopiedBase64Config,
} from '../base64-config';
import { editField } from '../field-editors';
import { buildFormItems, type FormItem } from '../field-schema';
import {
  confirmDiscardProviderChanges,
  createProviderDraft,
  type ProviderFormDraft,
} from '../form-utils';
import { providerFormSchema, type ProviderFieldContext } from '../provider-fields';
import type {
  ProviderFormRoute,
  UiContext,
  UiNavAction,
  UiResume,
} from '../router/types';
import {
  buildProviderConfigFromDraft,
  duplicateProvider,
  saveProviderDraft,
} from '../provider-ops';

export async function runProviderFormScreen(
  ctx: UiContext,
  route: ProviderFormRoute,
  _resume: UiResume | undefined,
): Promise<UiNavAction> {
  await ensureInitialized(route, ctx.store);

  if (!route.draft) return { kind: 'pop' };

  const draft = route.draft;
  const existing = route.existing;
  const originalName = route.originalName;

  const context: ProviderFieldContext = {
    store: ctx.store,
    originalName,
    onEditModels: async () => {},
  };

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
    if (decision === 'discard') return { kind: 'pop' };
    if (decision === 'save') {
      const saved = await saveProviderDraft({
        draft,
        store: ctx.store,
        existing,
        originalName,
      });
      if (saved === 'saved') return { kind: 'pop' };
    }
    return { kind: 'stay' };
  }

  if (selection.action === 'delete' && existing) {
    const confirmed = await confirmDelete(existing.name, 'provider');
    if (confirmed) {
      await ctx.store.removeProvider(existing.name);
      showDeletedMessage(existing.name, 'Provider');
      return { kind: 'pop' };
    }
    return { kind: 'stay' };
  }

  if (selection.action === 'copy') {
    const configToCopy = buildProviderConfigFromDraft(draft);
    await showCopiedBase64Config(configToCopy);
    return { kind: 'stay' };
  }

  if (selection.action === 'duplicate' && existing) {
    await duplicateProvider(ctx.store, existing);
    return { kind: 'stay' };
  }

  if (selection.action === 'confirm') {
    const saved = await saveProviderDraft({
      draft,
      store: ctx.store,
      existing,
      originalName,
    });
    if (saved === 'saved') return { kind: 'pop' };
    return { kind: 'stay' };
  }

  const field = selection.field;
  if (field) {
    if (field === 'models') {
      return {
        kind: 'push',
        route: {
          kind: 'modelList',
          models: draft.models,
          providerLabel: draft.name ?? originalName ?? 'Provider',
          requireAtLeastOne: false,
          draft,
        },
      };
    }

    await editField(providerFormSchema, draft, field, context);
  }

  return { kind: 'stay' };
}

async function ensureInitialized(
  route: ProviderFormRoute,
  store: ConfigStore,
): Promise<void> {
  if (route.draft) return;

  const providerName = route.providerName;
  const existing = providerName ? store.getProvider(providerName) : undefined;
  if (providerName && !existing) {
    vscode.window.showErrorMessage(`Provider "${providerName}" not found.`);
    return;
  }

  const draft = createProviderDraft(existing);

  if (route.initialConfig && !existing) {
    mergePartialProviderConfig(draft, route.initialConfig);
  }

  route.existing = existing;
  route.originalName = existing?.name;
  route.draft = draft;
}

import * as vscode from 'vscode';
import { ConfigStore } from '../../config-store';
import { confirmDelete, pickQuickItem, showDeletedMessage } from '../component';
import { mergePartialProviderConfig } from '../base64-config';
import { editField } from '../field-editors';
import { buildFormItems, type FormItem } from '../field-schema';
import {
  confirmDiscardProviderChanges,
  createProviderDraft,
  type ProviderFormDraft,
} from '../form-utils';
import {
  providerFormSchema,
  type ProviderFieldContext,
} from '../provider-fields';
import type {
  ProviderFormRoute,
  UiContext,
  UiNavAction,
  UiResume,
} from '../router/types';
import {
  duplicateProvider,
  exportProviderConfigFromDraft,
  saveProviderDraft,
} from '../provider-ops';
import { deleteProviderApiKeySecretIfUnused } from '../../api-key-utils';

const providerSettingsSchema = {
  ...providerFormSchema,
  fields: providerFormSchema.fields.filter((f) => f.key !== 'models'),
};

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
  const isSettings = route.mode === 'settings';

  const apiKeyStatus = await ctx.apiKeyStore.getStatus(draft.apiKey);

  const context: ProviderFieldContext = {
    store: ctx.store,
    apiKeyStatus,
    storeApiKeyInSettings: ctx.store.storeApiKeyInSettings,
    originalName,
    onEditModels: async () => {},
    onEditTimeout: async () => {},
  };

  const items = buildFormItems(
    isSettings ? providerSettingsSchema : providerFormSchema,
    draft,
    {
      isEditing: !isSettings && !!existing,
      hasConfirm: !isSettings,
      hasExport: !isSettings,
    },
    context,
  );

  const selection = await pickQuickItem<FormItem<ProviderFormDraft>>({
    title: isSettings
      ? existing
        ? `Provider Settings (${existing.name})`
        : 'Provider Settings'
      : existing
      ? 'Edit Provider'
      : 'Add Provider',
    placeholder: 'Select a field to edit',
    ignoreFocusOut: true,
    items,
  });

  if (!selection || selection.action === 'cancel') {
    if (isSettings) return { kind: 'pop' };

    const decision = await confirmDiscardProviderChanges(draft, existing);
    if (decision === 'discard') return { kind: 'pop' };
    if (decision === 'save') {
      const saved = await saveProviderDraft({
        draft,
        store: ctx.store,
        apiKeyStore: ctx.apiKeyStore,
        existing,
        originalName,
      });
      if (saved === 'saved') return { kind: 'pop' };
    }
    return { kind: 'stay' };
  }

  if (!isSettings && selection.action === 'delete' && existing) {
    const confirmed = await confirmDelete(existing.name, 'provider');
    if (confirmed) {
      await deleteProviderApiKeySecretIfUnused({
        apiKeyStore: ctx.apiKeyStore,
        providers: ctx.store.endpoints,
        providerName: existing.name,
      });
      await ctx.store.removeProvider(existing.name);
      showDeletedMessage(existing.name, 'Provider');
      return { kind: 'pop' };
    }
    return { kind: 'stay' };
  }

  if (!isSettings && selection.action === 'export') {
    await exportProviderConfigFromDraft({
      draft,
      apiKeyStore: ctx.apiKeyStore,
      allowPartial: true,
    });
    return { kind: 'stay' };
  }

  if (!isSettings && selection.action === 'duplicate' && existing) {
    await duplicateProvider(ctx.store, ctx.apiKeyStore, existing);
    return { kind: 'stay' };
  }

  if (!isSettings && selection.action === 'confirm') {
    const saved = await saveProviderDraft({
      draft,
      store: ctx.store,
      apiKeyStore: ctx.apiKeyStore,
      existing,
      originalName,
    });
    if (saved === 'saved') return { kind: 'pop' };
    return { kind: 'stay' };
  }

  const field = selection.field;
  if (field) {
    if (!isSettings && field === 'models') {
      return {
        kind: 'push',
        route: {
          kind: 'modelList',
          invocation: 'addProvider',
          models: draft.models,
          providerLabel: draft.name ?? originalName ?? 'Provider',
          requireAtLeastOne: false,
          draft,
        },
      };
    }

    if (field === 'timeout') {
      return {
        kind: 'push',
        route: {
          kind: 'timeoutForm',
          timeout: draft.timeout ?? {},
          draft,
        },
      };
    }

    await editField(
      isSettings ? providerSettingsSchema : providerFormSchema,
      draft,
      field,
      context,
    );
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

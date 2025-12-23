import { pickQuickItem } from '../component';
import { editField } from '../field-editors';
import { buildFormItems, type FormItem } from '../field-schema';
import {
  confirmDiscardProviderChanges,
  type ProviderFormDraft,
} from '../form-utils';
import {
  providerFormSchema,
  type ProviderFieldContext,
} from '../provider-fields';
import type {
  ProviderDraftFormResult,
  ProviderDraftFormRoute,
  UiContext,
  UiNavAction,
  UiResume,
} from '../router/types';
import { deepClone } from '../../config-ops';
import { officialModelsManager } from '../../official-models-manager';

export async function runProviderDraftFormScreen(
  ctx: UiContext,
  route: ProviderDraftFormRoute,
  _resume: UiResume | undefined,
): Promise<UiNavAction> {
  const draft = route.draft;
  const original = route.original;

  const apiKeyStatus = await ctx.apiKeyStore.getStatus(draft.apiKey);

  const context: ProviderFieldContext = {
    store: ctx.store,
    apiKeyStatus,
    storeApiKeyInSettings: ctx.store.storeApiKeyInSettings,
    onEditModels: async () => {},
    onEditTimeout: async () => {},
  };

  const selection = await pickQuickItem<FormItem<ProviderFormDraft>>({
    title: draft.name?.trim()
      ? `Edit Provider (${draft.name.trim()})`
      : 'Edit Provider',
    placeholder: 'Select a field to edit',
    ignoreFocusOut: true,
    items: buildFormItems(
      providerFormSchema,
      draft,
      {
        isEditing: false,
        hasExport: false,
        backLabel: '$(arrow-left) Back',
        saveLabel: '$(check) Done',
      },
      context,
    ),
  });

  if (!selection || selection.action === 'cancel') {
    const decision = await confirmDiscardProviderChanges(draft, original);
    if (decision === 'discard') {
      const sessionId = draft._officialModelsSessionId;
      const originalSessionId = original._officialModelsSessionId;
      if (sessionId && sessionId !== originalSessionId) {
        officialModelsManager.clearDraftSession(sessionId);
      }
      const result: ProviderDraftFormResult = { kind: 'cancelled' };
      return { kind: 'pop', resume: { kind: 'providerDraftFormResult', result } };
    }
    if (decision === 'save') {
      const result: ProviderDraftFormResult = {
        kind: 'saved',
        draft: deepClone(draft),
      };
      return { kind: 'pop', resume: { kind: 'providerDraftFormResult', result } };
    }
    return { kind: 'stay' };
  }

  if (selection.action === 'confirm') {
    const result: ProviderDraftFormResult = {
      kind: 'saved',
      draft: deepClone(draft),
    };
    return { kind: 'pop', resume: { kind: 'providerDraftFormResult', result } };
  }

  if (selection.action) {
    return { kind: 'stay' };
  }

  const field = selection.field;
  if (!field) return { kind: 'stay' };

  if (field === 'models') {
    return {
      kind: 'push',
      route: {
        kind: 'modelList',
        invocation: 'addProvider',
        models: draft.models,
        providerLabel: draft.name ?? 'Provider',
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

  await editField(providerFormSchema, draft, field, context);
  return { kind: 'stay' };
}

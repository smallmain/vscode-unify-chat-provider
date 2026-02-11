import * as vscode from 'vscode';
import { ConfigStore } from '../../config-store';
import { confirmDelete, pickQuickItem, showDeletedMessage } from '../component';
import { mergePartialProviderConfig } from '../base64-config';
import { editField } from '../field-editors';
import { buildFormItems, type FormItem } from '../field-schema';
import { normalizeLegacyProviderConfig } from '../import-config';
import {
  confirmDiscardProviderChanges,
  createProviderDraft,
  ensureDraftSessionId,
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
import { createAuthProvider, type AuthUiStatusSnapshot } from '../../auth';
import { deepClone } from '../../config-ops';
import { deleteProviderApiKeySecretIfUnused } from '../../api-key-utils';
import { t } from '../../i18n';
import { cleanupUnusedSecrets } from '../../secret';

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

  const context: ProviderFieldContext = {
    store: ctx.store,
    originalName,
    onEditModels: async () => {},
    onEditTimeout: async () => {},
    secretStore: ctx.secretStore,
    uriHandler: ctx.uriHandler,
  };

  let authDetail: string | undefined =
    draft.auth && draft.auth.method !== 'none' ? t('Loading...') : undefined;

  const buildItems = (): FormItem<ProviderFormDraft>[] => {
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

    return items.map((item) => {
      if (item.field !== 'auth') return item;
      return { ...item, detail: authDetail };
    });
  };

  const selection = await pickQuickItem<FormItem<ProviderFormDraft>>({
    title: isSettings
      ? existing
        ? t('Provider Settings ({0})', existing.name)
        : t('Provider Settings')
      : existing
      ? t('Edit Provider')
      : t('Add Provider'),
    placeholder: t('Select a field to edit'),
    ignoreFocusOut: true,
    items: buildItems(),
    onExternalRefresh: (refreshItems) => {
      let disposed = false;
      let refreshInFlight = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let currentIntervalMs = 5_000;

      const intervalFromSnapshot = (snapshot: AuthUiStatusSnapshot | undefined): number => {
        if (snapshot?.kind !== 'valid' && snapshot?.kind !== 'expired') {
          return 5_000;
        }

        const expiresAt = snapshot.expiresAt;
        if (expiresAt === undefined) {
          return 5_000;
        }

        const remainingMs = expiresAt - Date.now();
        if (remainingMs > 0 && remainingMs < 60_000) {
          return 1_000;
        }

        return 5_000;
      };

      const schedule = () => {
        if (disposed) return;
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
          void refresh();
        }, currentIntervalMs);
      };

      const refresh = async () => {
        if (disposed) return;
        if (refreshInFlight) return;
        refreshInFlight = true;

        try {
          const auth = draft.auth;
          if (!auth || auth.method === 'none') {
            authDetail = undefined;
            refreshItems(buildItems());
            return;
          }

          const providerLabel = draft.name?.trim() || originalName || t('Provider');
          const providerId = originalName ?? ensureDraftSessionId(draft);
          const authProvider = createAuthProvider(
            {
              providerId,
              providerLabel,
              secretStore: ctx.secretStore,
              uriHandler: ctx.uriHandler,
            },
            deepClone(auth),
          );

          if (!authProvider) {
            authDetail = undefined;
            refreshItems(buildItems());
            return;
          }

          try {
            authDetail = await authProvider.getSummaryDetail?.();
            const snapshot = await authProvider.getStatusSnapshot?.();
            const nextInterval = intervalFromSnapshot(snapshot);
            if (nextInterval !== currentIntervalMs) {
              currentIntervalMs = nextInterval;
            }
          } finally {
            authProvider.dispose?.();
          }

          refreshItems(buildItems());
        } finally {
          refreshInFlight = false;
          schedule();
        }
      };

      schedule();
      void refresh();

      return {
        dispose: () => {
          disposed = true;
          if (timer) clearTimeout(timer);
        },
      };
    },
  });

  if (!selection || selection.action === 'cancel') {
    if (isSettings) return { kind: 'pop' };

    const decision = await confirmDiscardProviderChanges(draft, existing);
    if (decision === 'discard') {
      await cleanupUnusedSecrets(ctx.secretStore);
      return { kind: 'pop' };
    }
    if (decision === 'save') {
      const saved = await saveProviderDraft({
        draft,
        store: ctx.store,
        secretStore: ctx.secretStore,
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
        secretStore: ctx.secretStore,
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
      secretStore: ctx.secretStore,
      allowPartial: true,
    });
    return { kind: 'stay' };
  }

  if (!isSettings && selection.action === 'duplicate' && existing) {
    await duplicateProvider(ctx.store, ctx.secretStore, existing);
    return { kind: 'stay' };
  }

  if (!isSettings && selection.action === 'confirm') {
    const saved = await saveProviderDraft({
      draft,
      store: ctx.store,
      secretStore: ctx.secretStore,
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
          providerLabel: draft.name ?? originalName ?? t('Provider'),
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
          retry: draft.retry ?? {},
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
    vscode.window.showErrorMessage(
      t('Provider "{0}" not found.', providerName),
    );
    return;
  }

  const draft = createProviderDraft(existing);

  if (route.initialConfig && !existing) {
    mergePartialProviderConfig(
      draft,
      normalizeLegacyProviderConfig(route.initialConfig),
    );
  }

  route.existing = existing;
  route.originalName = existing?.name;
  route.draft = draft;
}

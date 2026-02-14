import { pickQuickItem } from '../component';
import { editField } from '../field-editors';
import { buildFormItems, type FormItem } from '../field-schema';
import {
  confirmDiscardProviderChanges,
  ensureDraftSessionId,
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
import { createAuthProvider, type AuthUiStatusSnapshot } from '../../auth';
import { officialModelsManager } from '../../official-models-manager';
import { cleanupUnusedSecrets } from '../../secret';
import { t } from '../../i18n';
import { resolveBalanceFieldDetail } from '../balance-detail';

export async function runProviderDraftFormScreen(
  ctx: UiContext,
  route: ProviderDraftFormRoute,
  _resume: UiResume | undefined,
): Promise<UiNavAction> {
  const draft = route.draft;
  const original = route.original;

  const context: ProviderFieldContext = {
    store: ctx.store,
    onEditModels: async () => {},
    onEditTimeout: async () => {},
    secretStore: ctx.secretStore,
    uriHandler: ctx.uriHandler,
  };

  let authDetail: string | undefined =
    draft.auth && draft.auth.method !== 'none' ? t('Loading...') : undefined;
  let balanceDetail: string | undefined =
    draft.balanceProvider && draft.balanceProvider.method !== 'none'
      ? t('Loading...')
      : undefined;

  const buildItems = (): FormItem<ProviderFormDraft>[] => {
    const items = buildFormItems(
      providerFormSchema,
      draft,
      {
        isEditing: false,
        hasExport: false,
        backLabel: '$(arrow-left) ' + t('Back'),
        saveLabel: '$(check) ' + t('Done'),
      },
      context,
    );

    return items.map((item) => {
      if (item.field === 'auth') {
        return { ...item, detail: authDetail };
      }
      if (item.field === 'balanceProvider') {
        return { ...item, detail: balanceDetail };
      }
      return item;
    });
  };

  const selection = await pickQuickItem<FormItem<ProviderFormDraft>>({
    title: draft.name?.trim()
      ? t('Edit Provider ({0})', draft.name.trim())
      : t('Edit Provider'),
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
          } else {
            const providerLabel = draft.name?.trim() || t('Provider');
            const providerId = ensureDraftSessionId(draft);
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
            } else {
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
            }
          }

          const balanceProvider = draft.balanceProvider;
          if (!balanceProvider || balanceProvider.method === 'none') {
            balanceDetail = undefined;
          } else {
            balanceDetail = await resolveBalanceFieldDetail({
              draft,
              store: ctx.store,
              secretStore: ctx.secretStore,
            });
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
    const decision = await confirmDiscardProviderChanges(draft, original);
      if (decision === 'discard') {
        const sessionId = draft._draftSessionId;
        const originalSessionId = original._draftSessionId;
        if (sessionId && sessionId !== originalSessionId) {
          officialModelsManager.clearDraftSession(sessionId);
        }

        if (!route.skipSecretCleanupOnDiscard) {
          await cleanupUnusedSecrets(ctx.secretStore);
        }

        const result: ProviderDraftFormResult = { kind: 'cancelled' };
      return {
        kind: 'pop',
        resume: { kind: 'providerDraftFormResult', result },
      };
    }
    if (decision === 'save') {
      const result: ProviderDraftFormResult = {
        kind: 'saved',
        draft: deepClone(draft),
      };
      return {
        kind: 'pop',
        resume: { kind: 'providerDraftFormResult', result },
      };
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
        providerLabel: draft.name ?? t('Provider'),
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

  await editField(providerFormSchema, draft, field, context);
  return { kind: 'stay' };
}

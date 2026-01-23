import * as vscode from 'vscode';
import {
  normalizeWellKnownConfigs,
  WELL_KNOWN_MODELS,
} from '../../well-known/models';
import { confirmDelete, pickQuickItem, showDeletedMessage } from '../component';
import { duplicateModel, showCopiedBase64Config } from '../base64-config';
import { promptForModelImportConfig } from '../import-from-config';
import {
  confirmDiscardProviderChanges,
  formatModelDetail,
  removeModel,
  ensureDraftSessionId as ensureDraftSessionIdForDraft,
} from '../form-utils';
import type {
  ModelListRoute,
  UiContext,
  UiNavAction,
  UiResume,
} from '../router/types';
import { ModelConfig, ProviderConfig } from '../../types';
import {
  duplicateProvider,
  exportProviderConfigFromDraft,
} from '../provider-ops';
import { deleteProviderApiKeySecretIfUnused } from '../../api-key-utils';
import {
  officialModelsManager,
  OfficialModelsDraftInput,
  OfficialModelsFetchState,
} from '../../official-models-manager';
import { t } from '../../i18n';
import { isSecretRef } from '../../secret';
import { normalizeBaseUrlInput } from '../../utils';

/**
 * Ensure we have a session ID for draft-only state. Prefer the draft's
 * `_draftSessionId` so auth + official models share the same stable key.
 */
function ensureRouteDraftSessionId(route: ModelListRoute): string {
  if (route.draft) {
    const id = ensureDraftSessionIdForDraft(route.draft);
    route.draftSessionId = id;
    return id;
  }

  if (route.draftSessionId) return route.draftSessionId;

  const newSessionId = `draft-${Date.now()}-${Math.random()
    .toString(36)
    .substring(2, 9)}`;
  route.draftSessionId = newSessionId;
  return newSessionId;
}

function getProviderForWellKnownModelMatching(
  route: ModelListRoute,
): ProviderConfig | undefined {
  const draft = route.draft;
  if (draft?.type && draft.baseUrl?.trim()) {
    const name =
      draft.name?.trim() || route.providerLabel?.trim() || 'Provider';

    return {
      type: draft.type,
      name,
      baseUrl: normalizeBaseUrlInput(draft.baseUrl),
      models: [],
      extraHeaders: draft.extraHeaders,
      extraBody: draft.extraBody,
      timeout: draft.timeout,
      autoFetchOfficialModels: draft.autoFetchOfficialModels,
    };
  }

  return route.existing;
}

type ModelListItem = vscode.QuickPickItem & {
  action?:
    | 'add'
    | 'back'
    | 'edit'
    | 'export-model'
    | 'save'
    | 'provider-settings'
    | 'provider-copy'
    | 'provider-duplicate'
    | 'provider-delete'
    | 'add-from-official'
    | 'add-from-wellknown'
    | 'add-from-base64'
    | 'toggle-auto-fetch'
    | 'refresh-official';
  model?: ModelConfig;
  isOfficial?: boolean;
};

export async function runModelListScreen(
  ctx: UiContext,
  route: ModelListRoute,
  resume: UiResume | undefined,
): Promise<UiNavAction> {
  applyResume(route, resume);

  const mustKeepOne = route.requireAtLeastOne ?? false;
  const includeSave = typeof route.onSave === 'function';
  const providerName = route.draft?.name ?? route.providerLabel;
  const title =
    route.invocation === 'providerEdit'
      ? t('Provider: {0}', providerName)
      : t('Models ({0})', providerName);
  let didSave = false;
  await updateOfficialModelsDataForRoute(route);

  // Ensure we have a session ID for draft state management
  const sessionId = ensureRouteDraftSessionId(route);

  const selection = await pickQuickItem<ModelListItem>({
    title,
    placeholder: t('Select a model to edit, or add a new one'),
    ignoreFocusOut: true,
    items: buildModelListItems(route, includeSave),
    onExternalRefresh: (refreshItems) => {
      // Subscribe to official models updates using session ID
      return officialModelsManager.onDidUpdate((updatedId) => {
        if (updatedId === sessionId) {
          const state = officialModelsManager.getDraftSessionState(sessionId);
          route.officialModelsData = {
            models: state?.models ?? [],
            state,
          };
          refreshItems(buildModelListItems(route, includeSave));
        }
      });
    },
    onInlineAction: async (item, qp) => {
      // Handle toggle-auto-fetch inline without closing the picker
      if (item.action === 'toggle-auto-fetch') {
        if (route.draft) {
          const wasEnabled = route.draft.autoFetchOfficialModels ?? false;
          const nowEnabled = !wasEnabled;
          route.draft.autoFetchOfficialModels = nowEnabled;

          if (nowEnabled) {
            triggerOfficialModelsRefresh(route, sessionId);
          } else {
            // Disabled: clear draft session state
            route.officialModelsData = undefined;
            officialModelsManager.clearDraftSession(sessionId);
          }
          qp.items = buildModelListItems(route, includeSave);
        }
        return true;
      }

      // Handle refresh-official inline without closing the picker
      if (item.action === 'refresh-official') {
        triggerOfficialModelsRefresh(route, sessionId);
        qp.items = buildModelListItems(route, includeSave);
        return true;
      }

      return false;
    },
    onWillAccept: async (item) => {
      if (item.action !== 'save') return;
      if (!route.onSave) return false;
      const result = await route.onSave();
      didSave = result === 'saved';
      return didSave;
    },
    onDidTriggerItemButton: async (event, qp) => {
      const model = event.item.model;
      const isOfficial = event.item.isOfficial;
      if (!model) return;

      const buttonIndex = event.item.buttons?.findIndex(
        (b) => b === event.button,
      );

      if (buttonIndex === 0) {
        return { ...event.item, action: 'export-model' };
      }

      if (isOfficial) {
        return;
      }

      if (buttonIndex === 1) {
        const duplicated = duplicateModel(model, route.models);
        route.models.push(duplicated);
        vscode.window.showInformationMessage(
          t('Model duplicated as "{0}".', duplicated.id),
        );
        qp.items = buildModelListItems(route, includeSave);
        return;
      }

      if (buttonIndex === 2) {
        if (mustKeepOne && route.models.length <= 1) {
          vscode.window.showWarningMessage(
            t(
              'Cannot delete the last model. A provider must have at least one model.',
            ),
          );
          return;
        }
        if (route.invocation !== 'providerEdit') {
          const confirmed = await confirmDelete(model.id, 'model');
          if (!confirmed) return;
        }
        removeModel(route.models, model.id);
        qp.items = buildModelListItems(route, includeSave);
      }

      return;
    },
  });

  if (!selection || selection.action === 'back') {
    if (route.confirmDiscardOnBack && route.draft) {
      const decision = await confirmDiscardProviderChanges(
        route.draft,
        route.existing,
      );
      if (decision === 'discard') {
        // Clean up draft session when discarding changes
        officialModelsManager.clearDraftSession(sessionId);

        if (route.invocation !== 'providerEdit') {
          const tokenRef = (() => {
            const auth = route.draft.auth;
            if (!auth || typeof auth !== 'object' || Array.isArray(auth)) {
              return undefined;
            }
            const record = auth as unknown as Record<string, unknown>;
            const token = record['token'];
            return typeof token === 'string' ? token.trim() : undefined;
          })();
          if (tokenRef && isSecretRef(tokenRef)) {
            await ctx.secretStore.deleteOAuth2Token(tokenRef);
          }
        }
        return route.invocation === 'addFromWellKnownProvider'
          ? { kind: 'popToRoot' }
          : { kind: 'pop' };
      }
      if (decision === 'save') {
        if (!route.onSave) {
          vscode.window.showErrorMessage(
            t('Save is not available in this context.'),
          );
          return { kind: 'stay' };
        }
        const result = await route.onSave();
        if (result === 'saved') {
          const afterSave = route.afterSave ?? 'pop';
          return afterSave === 'popToRoot'
            ? { kind: 'popToRoot' }
            : { kind: 'pop' };
        }
      }
      return { kind: 'stay' };
    }

    return route.invocation === 'addFromWellKnownProvider'
      ? { kind: 'popToRoot' }
      : { kind: 'pop' };
  }

  if (selection.action === 'export-model') {
    if (!selection.model) return { kind: 'stay' };
    await showCopiedBase64Config(selection.model);
    return { kind: 'stay' };
  }

  if (selection.action === 'provider-settings') {
    if (!route.draft) return { kind: 'stay' };
    return {
      kind: 'push',
      route: {
        kind: 'providerForm',
        mode: 'settings',
        draft: route.draft,
        existing: route.existing,
        originalName: route.originalName,
      },
    };
  }

  if (selection.action === 'provider-copy') {
    if (!route.draft) return { kind: 'stay' };
    await exportProviderConfigFromDraft({
      draft: route.draft,
      secretStore: ctx.secretStore,
      allowPartial: true,
    });
    return { kind: 'stay' };
  }

  if (selection.action === 'provider-duplicate') {
    if (!route.existing) return { kind: 'stay' };
    await duplicateProvider(ctx.store, ctx.secretStore, route.existing);
    return { kind: 'stay' };
  }

  if (selection.action === 'provider-delete') {
    if (!route.existing || !route.originalName) return { kind: 'stay' };
    const confirmed = await confirmDelete(route.originalName, 'provider');
    if (!confirmed) return { kind: 'stay' };
    await deleteProviderApiKeySecretIfUnused({
      secretStore: ctx.secretStore,
      providers: ctx.store.endpoints,
      providerName: route.originalName,
    });
    await ctx.store.removeProvider(route.originalName);
    showDeletedMessage(route.originalName, 'Provider');
    return { kind: 'pop' };
  }

  if (selection.action === 'add') {
    return {
      kind: 'push',
      route: {
        kind: 'modelForm',
        models: route.models,
        providerLabel: route.draft?.name ?? route.providerLabel,
        providerType: route.draft?.type,
      },
    };
  }

  if (selection.action === 'save') {
    if (!includeSave || !didSave) return { kind: 'stay' };
    // Migration is handled by saveProviderDraft via draft._draftSessionId
    const afterSave = route.afterSave ?? 'pop';
    return afterSave === 'popToRoot' ? { kind: 'popToRoot' } : { kind: 'pop' };
  }

  if (selection.action === 'add-from-base64') {
    const imported = await promptForModelImportConfig();
    if (!imported) return { kind: 'stay' };

    if (imported.kind === 'multiple') {
      return {
        kind: 'push',
        route: {
          kind: 'importModelConfigArray',
          models: imported.models,
          targetModels: route.models,
          providerLabel: route.draft?.name ?? route.providerLabel,
          providerType: route.draft?.type,
        },
      };
    }

    return {
      kind: 'push',
      route: {
        kind: 'modelForm',
        models: route.models,
        initialConfig: imported.config,
        providerLabel: route.draft?.name ?? route.providerLabel,
        providerType: route.draft?.type,
      },
    };
  }

  if (selection.action === 'add-from-official') {
    const draftInput = buildOfficialModelsDraftInput(route);
    return {
      kind: 'push',
      route: {
        kind: 'modelSelection',
        title: t('Add From Official Model List'),
        existingModels: route.models,
        fetchModels: async () => {
          const result = await officialModelsManager.getOfficialModelsForDraft(
            sessionId,
            draftInput,
            { forceFetch: true },
          );
          if (result.state?.lastError) {
            throw new Error(result.state.lastError);
          }
          return result.models;
        },
      },
    };
  }

  if (selection.action === 'add-from-wellknown') {
    const providerForMatching = getProviderForWellKnownModelMatching(route);
    return {
      kind: 'push',
      route: {
        kind: 'modelSelection',
        title: t('Add From Well-Known Model List'),
        existingModels: route.models,
        fetchModels: async () =>
          normalizeWellKnownConfigs(
            WELL_KNOWN_MODELS,
            undefined,
            providerForMatching,
          ),
      },
    };
  }

  const selectedModel = selection.model;
  if (selectedModel) {
    if (selection.isOfficial) {
      return {
        kind: 'push',
        route: {
          kind: 'modelView',
          model: selectedModel,
          providerLabel: route.draft?.name ?? route.providerLabel,
          providerType: route.draft?.type,
        },
      };
    }

    return {
      kind: 'push',
      route: {
        kind: 'modelForm',
        model: selectedModel,
        models: route.models,
        originalId: selectedModel.id,
        providerLabel: route.draft?.name ?? route.providerLabel,
        providerType: route.draft?.type,
      },
    };
  }

  return { kind: 'stay' };
}

function applyResume(
  route: ModelListRoute,
  resume: UiResume | undefined,
): void {
  if (!resume) return;

  if (resume.kind === 'modelFormResult') {
    const result = resume.result;
    if (result.kind === 'saved') {
      const originalId = result.originalId;
      if (originalId) {
        const idx = route.models.findIndex((m) => m.id === originalId);
        if (idx !== -1) {
          route.models[idx] = result.model;
          return;
        }
      }
      route.models.push(result.model);
      return;
    }

    if (result.kind === 'deleted') {
      removeModel(route.models, result.modelId);
    }

    return;
  }

  if (resume.kind === 'modelSelectionResult') {
    route.models.push(...resume.models);
  }
}

function buildModelListItems(
  route: ModelListRoute,
  includeSave: boolean,
): ModelListItem[] {
  const models = route.models;
  const userModelIds = new Set(models.map((m) => m.id));
  const autoFetchEnabled = route.draft?.autoFetchOfficialModels ?? false;
  const officialModels = route.officialModelsData?.models ?? [];
  const fetchState = route.officialModelsData?.state;

  const items: ModelListItem[] = [
    { label: `$(arrow-left) ${t('Back')}`, action: 'back' },
  ];

  items.push(
    { label: `$(add) ${t('Add Model...')}`, action: 'add' },
    {
      label: `$(star-empty) ${t('Add From Well-Known Model List...')}`,
      action: 'add-from-wellknown',
    },
    {
      label: `$(broadcast) ${t('Add From Official Model List...')}`,
      action: 'add-from-official',
    },
    {
      label: `$(file-code) ${t('Import From Config...')}`,
      action: 'add-from-base64',
    },
  );

  // Auto-fetch toggle and status section
  if (route.draft) {
    items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });

    // Toggle item
    items.push({
      label: `$(globe) ${t('Auto-Fetch Official Models')}`,
      description: autoFetchEnabled ? t('Enabled') : t('Disabled'),
      action: 'toggle-auto-fetch',
    });

    // Status item (only shown when enabled)
    if (autoFetchEnabled) {
      items.push({
        ...formatFetchStatus(fetchState),
        action: 'refresh-official',
      });
    }
  }

  // User-configured models section
  if (models.length > 0 || (autoFetchEnabled && officialModels.length > 0)) {
    items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
  }

  // User models
  for (const model of models) {
    items.push({
      label: model.name || model.id,
      description: model.name ? model.id : undefined,
      detail: formatModelDetail(model),
      model,
      action: 'edit',
      isOfficial: false,
      buttons: [
        {
          iconPath: new vscode.ThemeIcon('export'),
          tooltip: t('Export as Base64 config'),
        },
        {
          iconPath: new vscode.ThemeIcon('files'),
          tooltip: t('Duplicate model'),
        },
        { iconPath: new vscode.ThemeIcon('trash'), tooltip: t('Delete model') },
      ],
    });
  }

  // Official models (when enabled, excluding conflicts)
  if (autoFetchEnabled) {
    const filteredOfficialModels = officialModels.filter(
      (m) => !userModelIds.has(m.id),
    );

    for (const model of filteredOfficialModels) {
      items.push({
        label: `$(globe) ${model.name || model.id}`,
        description: model.name ? model.id : undefined,
        detail: formatModelDetail(model),
        model,
        action: 'edit',
        isOfficial: true,
        buttons: [
          {
            iconPath: new vscode.ThemeIcon('export'),
            tooltip: t('Export as Base64 config'),
          },
        ],
      });
    }
  }

  if (
    (route.invocation === 'addFromWellKnownProvider' ||
      route.invocation === 'providerEdit') &&
    route.draft &&
    typeof route.onSave === 'function'
  ) {
    items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
    items.push({
      label: `$(gear) ${t('Provider Settings...')}`,
      action: 'provider-settings',
    });
  }

  if (includeSave || route.existing) {
    items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });

    if (includeSave) {
      items.push({ label: `$(check) ${t('Save')}`, action: 'save' });
    }

    items.push({ label: `$(export) ${t('Export')}`, action: 'provider-copy' });

    if (route.existing && route.draft) {
      items.push({
        label: `$(files) ${t('Duplicate')}`,
        action: 'provider-duplicate',
      });
      items.push({
        label: `$(trash) ${t('Delete')}`,
        action: 'provider-delete',
      });
    }
  }

  return items;
}

/**
 * Format the fetch status for display
 */
function formatFetchStatus(state: OfficialModelsFetchState | undefined): {
  label: string;
  description?: string;
  detail?: string;
} {
  if (state?.isFetching) {
    return {
      label: `$(sync~spin) ${t('Fetching...')}`,
    };
  }

  // Check for errors first - even if lastFetchTime is 0 (first fetch failed)
  if (state?.lastError) {
    const errorDate = state.lastErrorTime
      ? new Date(state.lastErrorTime)
      : state.lastFetchTime
      ? new Date(state.lastFetchTime)
      : new Date();
    return {
      label: `$(warning) ${t('Last attempt: {0}', formatTimeAgo(errorDate))}`,
      detail: t('Error: {0}', state.lastError),
      description: t('(click to fetch)'),
    };
  }

  if (!state || !state.lastFetchTime) {
    return {
      label: `$(refresh) ${t('Not fetched yet')}`,
      description: t('(click to fetch)'),
    };
  }

  const lastFetchDate = new Date(state.lastFetchTime);
  const timeAgo = formatTimeAgo(lastFetchDate);

  return {
    label: `$(refresh) ${t('Last fetched: {0}', timeAgo)}`,
    description: t('(click to fetch)'),
  };
}

/**
 * Format a date as a relative time string
 */
function formatTimeAgo(date: Date): string {
  const now = Date.now();
  const diff = now - date.getTime();

  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return t('{0}d ago', days);
  if (hours > 0) return t('{0}h ago', hours);
  if (minutes > 0) return t('{0}m ago', minutes);
  return t('just now');
}

async function updateOfficialModelsDataForRoute(
  route: ModelListRoute,
): Promise<void> {
  if (!route.draft?.autoFetchOfficialModels) {
    route.officialModelsData = undefined;
    return;
  }

  const sessionId = ensureRouteDraftSessionId(route);
  const draftInput = buildOfficialModelsDraftInput(route);

  // When editing an existing provider, try to load persisted state first
  if (route.existing?.name && route.invocation === 'providerEdit') {
    officialModelsManager.loadPersistedStateToDraft(
      sessionId,
      route.existing.name,
      draftInput,
    );
  }

  route.officialModelsData =
    await officialModelsManager.getOfficialModelsForDraft(
      sessionId,
      draftInput,
    );
}

function buildOfficialModelsDraftInput(
  route: ModelListRoute,
): OfficialModelsDraftInput {
  const draft = route.draft;
  if (!draft) return {};

  return {
    type: draft.type,
    name: draft.name,
    baseUrl: draft.baseUrl,
    auth: draft.auth,
    extraHeaders: draft.extraHeaders,
    extraBody: draft.extraBody,
    timeout: draft.timeout,
  };
}

/**
 * Trigger a refresh of official models without blocking.
 * The UI will be updated via the onDidUpdate event.
 */
function triggerOfficialModelsRefresh(
  route: ModelListRoute,
  sessionId: string,
): void {
  const draftInput = buildOfficialModelsDraftInput(route);
  officialModelsManager.triggerDraftRefresh(sessionId, draftInput);

  const state = officialModelsManager.getDraftSessionState(sessionId);
  route.officialModelsData = { models: state?.models ?? [], state };
}

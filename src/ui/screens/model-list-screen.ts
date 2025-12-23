import * as vscode from 'vscode';
import { WELL_KNOWN_MODELS } from '../../well-known/models';
import { confirmDelete, pickQuickItem, showDeletedMessage } from '../component';
import { duplicateModel, showCopiedBase64Config } from '../base64-config';
import {
  promptForModelImportConfig,
} from '../import-from-config';
import {
  confirmDiscardProviderChanges,
  formatModelDetail,
  removeModel,
} from '../form-utils';
import type {
  ModelListRoute,
  UiContext,
  UiNavAction,
  UiResume,
} from '../router/types';
import { ModelConfig } from '../../types';
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

/**
 * Generate a unique session ID for draft state management
 */
function generateSessionId(): string {
  return `draft-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}

/**
 * Ensure draft has a session ID.
 * Session ID is stored on draft object to persist across route recreations.
 */
function ensureDraftSessionId(route: ModelListRoute): string {
  // Prefer draft's session ID (persists across route recreations)
  if (route.draft?._officialModelsSessionId) {
    route.draftSessionId = route.draft._officialModelsSessionId;
    return route.draftSessionId;
  }

  // Fall back to route's session ID
  if (route.draftSessionId) {
    if (route.draft) {
      route.draft._officialModelsSessionId = route.draftSessionId;
    }
    return route.draftSessionId;
  }

  // Generate new session ID
  const newSessionId = generateSessionId();
  route.draftSessionId = newSessionId;
  if (route.draft) {
    route.draft._officialModelsSessionId = newSessionId;
  }
  return newSessionId;
}

type ModelListItem = vscode.QuickPickItem & {
  action?:
    | 'add'
    | 'back'
    | 'edit'
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
      ? `Provider: ${providerName}`
      : `Models (${providerName})`;
  let didSave = false;
  await updateOfficialModelsDataForRoute(route);

  // Ensure we have a session ID for draft state management
  const sessionId = ensureDraftSessionId(route);

  const selection = await pickQuickItem<ModelListItem>({
    title,
    placeholder: 'Select a model to edit, or add a new one',
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

      if (isOfficial) {
        if (buttonIndex === 0) {
          await showCopiedBase64Config(model);
        }
      } else {
        if (buttonIndex === 0) {
          await showCopiedBase64Config(model);
          return;
        }

        if (buttonIndex === 1) {
          const duplicated = duplicateModel(model, route.models);
          route.models.push(duplicated);
          vscode.window.showInformationMessage(
            `Model duplicated as "${duplicated.id}".`,
          );
          qp.items = buildModelListItems(route, includeSave);
          return;
        }

        if (buttonIndex === 2) {
          if (mustKeepOne && route.models.length <= 1) {
            vscode.window.showWarningMessage(
              'Cannot delete the last model. A provider must have at least one model.',
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
      }
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
        return route.invocation === 'addFromWellKnownProvider'
          ? { kind: 'popToRoot' }
          : { kind: 'pop' };
      }
      if (decision === 'save') {
        if (!route.onSave) {
          vscode.window.showErrorMessage(
            'Save is not available in this context.',
          );
          return { kind: 'stay' };
        }
        const result = await route.onSave();
        if (result === 'saved') {
          // Migration is handled by saveProviderDraft via draft._officialModelsSessionId
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
      apiKeyStore: ctx.apiKeyStore,
      allowPartial: true,
    });
    return { kind: 'stay' };
  }

  if (selection.action === 'provider-duplicate') {
    if (!route.existing) return { kind: 'stay' };
    await duplicateProvider(ctx.store, ctx.apiKeyStore, route.existing);
    return { kind: 'stay' };
  }

  if (selection.action === 'provider-delete') {
    if (!route.existing || !route.originalName) return { kind: 'stay' };
    const confirmed = await confirmDelete(route.originalName, 'provider');
    if (!confirmed) return { kind: 'stay' };
    await deleteProviderApiKeySecretIfUnused({
      apiKeyStore: ctx.apiKeyStore,
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
    // Migration is handled by saveProviderDraft via draft._officialModelsSessionId
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
        title: 'Add From Official Model List',
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
    return {
      kind: 'push',
      route: {
        kind: 'modelSelection',
        title: 'Add From Well-Known Model List',
        existingModels: route.models,
        fetchModels: async () => WELL_KNOWN_MODELS,
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
    { label: '$(arrow-left) Back', action: 'back' },
  ];

  items.push(
    { label: '$(add) Add Model...', action: 'add' },
    {
      label: '$(star-empty) Add From Well-Known Model List...',
      action: 'add-from-wellknown',
    },
    {
      label: '$(broadcast) Add From Official Model List...',
      action: 'add-from-official',
    },
    {
      label: '$(file-code) Import From Config...',
      action: 'add-from-base64',
    },
  );

  // Auto-fetch toggle and status section
  if (route.draft) {
    items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });

    // Toggle item
    items.push({
      label: `$(globe) Auto-Fetch Official Models`,
      description: autoFetchEnabled ? 'Enabled' : 'Disabled',
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
          tooltip: 'Export as Base64 config',
        },
        {
          iconPath: new vscode.ThemeIcon('files'),
          tooltip: 'Duplicate model',
        },
        { iconPath: new vscode.ThemeIcon('trash'), tooltip: 'Delete model' },
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
            tooltip: 'Export as Base64 config',
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
      label: '$(gear) Provider Settings...',
      action: 'provider-settings',
    });
  }

  if (includeSave || route.existing) {
    items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });

    if (includeSave) {
      items.push({ label: '$(check) Save', action: 'save' });
    }

    items.push({ label: '$(export) Export', action: 'provider-copy' });

    if (route.existing && route.draft) {
      items.push({ label: '$(files) Duplicate', action: 'provider-duplicate' });
      items.push({ label: '$(trash) Delete', action: 'provider-delete' });
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
      label: '$(sync~spin) Fetching...',
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
      label: `$(warning) Last attempt: ${formatTimeAgo(errorDate)}`,
      detail: `Error: ${state.lastError}`,
      description: '(click to fetch)',
    };
  }

  if (!state || !state.lastFetchTime) {
    return {
      label: '$(refresh) Not fetched yet',
      description: '(click to fetch)',
    };
  }

  const lastFetchDate = new Date(state.lastFetchTime);
  const timeAgo = formatTimeAgo(lastFetchDate);

  return {
    label: `$(refresh) Last fetched: ${timeAgo}`,
    description: '(click to fetch)',
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

  if (days > 0) return `${days}d ago`;
  if (hours > 0) return `${hours}h ago`;
  if (minutes > 0) return `${minutes}m ago`;
  return 'just now';
}

async function updateOfficialModelsDataForRoute(
  route: ModelListRoute,
): Promise<void> {
  if (!route.draft?.autoFetchOfficialModels) {
    route.officialModelsData = undefined;
    return;
  }

  const sessionId = ensureDraftSessionId(route);
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
    apiKey: draft.apiKey,
    mimic: draft.mimic,
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

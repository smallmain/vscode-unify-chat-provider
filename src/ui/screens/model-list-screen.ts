import * as vscode from 'vscode';
import {
  mergeWithWellKnownModels,
  WELL_KNOWN_MODELS,
} from '../../well-known/models';
import { confirmDelete, pickQuickItem, showDeletedMessage } from '../component';
import {
  duplicateModel,
  promptForBase64Config,
  showCopiedBase64Config,
} from '../base64-config';
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
import { createProvider } from '../../client/utils';
import { ModelConfig } from '../../types';
import {
  buildProviderConfigFromDraft,
  duplicateProvider,
} from '../provider-ops';

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
    | 'add-from-base64';
  model?: ModelConfig;
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

  const selection = await pickQuickItem<ModelListItem>({
    title,
    placeholder: 'Select a model to edit, or add a new one',
    ignoreFocusOut: true,
    items: buildModelListItems(route, includeSave),
    onWillAccept: async (item) => {
      if (item.action !== 'save') return;
      if (!route.onSave) return false;
      const result = await route.onSave();
      didSave = result === 'saved';
      return didSave;
    },
    onDidTriggerItemButton: async (event, qp) => {
      const model = event.item.model;
      if (!model) return;

      const buttonIndex = event.item.buttons?.findIndex(
        (b) => b === event.button,
      );

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
    },
  });

  if (!selection || selection.action === 'back') {
    if (route.confirmDiscardOnBack && route.draft) {
      const decision = await confirmDiscardProviderChanges(
        route.draft,
        route.existing,
      );
      if (decision === 'discard') return { kind: 'pop' };
      if (decision === 'save') {
        if (!route.onSave) {
          vscode.window.showErrorMessage(
            'Save is not available in this context.',
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

    return { kind: 'pop' };
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
    const configToCopy = buildProviderConfigFromDraft(route.draft);
    await showCopiedBase64Config(configToCopy);
    return { kind: 'stay' };
  }

  if (selection.action === 'provider-duplicate') {
    if (!route.existing) return { kind: 'stay' };
    await duplicateProvider(ctx.store, route.existing);
    return { kind: 'stay' };
  }

  if (selection.action === 'provider-delete') {
    if (!route.existing || !route.originalName) return { kind: 'stay' };
    const confirmed = await confirmDelete(route.originalName, 'provider');
    if (!confirmed) return { kind: 'stay' };
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
      },
    };
  }

  if (selection.action === 'save') {
    if (!includeSave || !didSave) return { kind: 'stay' };
    const afterSave = route.afterSave ?? 'pop';
    return afterSave === 'popToRoot' ? { kind: 'popToRoot' } : { kind: 'pop' };
  }

  if (selection.action === 'add-from-base64') {
    const config = await promptForBase64Config<Partial<ModelConfig>>({
      title: 'Add Model From Base64 Config',
      placeholder: 'Paste Base64 configuration string...',
    });
    if (!config) return { kind: 'stay' };
    return {
      kind: 'push',
      route: {
        kind: 'modelForm',
        models: route.models,
        initialConfig: config,
        providerLabel: route.draft?.name ?? route.providerLabel,
      },
    };
  }

  if (selection.action === 'add-from-official') {
    if (!route.draft?.baseUrl || !route.draft?.type) {
      vscode.window.showErrorMessage(
        'Please configure API Format and Base URL first before fetching official models.',
      );
      return { kind: 'stay' };
    }
    const draft = route.draft;
    const client = createProvider({
      type: draft.type!,
      name: draft.name ?? 'temp',
      baseUrl: draft.baseUrl!,
      apiKey: draft.apiKey,
      models: [],
    });
    if (!client.getAvailableModels) {
      vscode.window.showErrorMessage(
        'Fetching official models is not supported for this provider.',
      );
      return { kind: 'stay' };
    }

    return {
      kind: 'push',
      route: {
        kind: 'modelSelection',
        title: 'Add From Official Model List',
        existingModels: route.models,
        fetchModels: async () =>
          mergeWithWellKnownModels(await client.getAvailableModels!()),
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
    return {
      kind: 'push',
      route: {
        kind: 'modelForm',
        model: selectedModel,
        models: route.models,
        originalId: selectedModel.id,
        providerLabel: route.draft?.name ?? route.providerLabel,
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
  const items: ModelListItem[] = [
    { label: '$(arrow-left) Back', action: 'back' },
  ];

  items.push(
    { label: '$(add) Add Model...', action: 'add' },
    {
      label: '$(broadcast) Add From Well-Known Model List...',
      action: 'add-from-wellknown',
    },
    {
      label: '$(cloud-download) Add From Official Model List...',
      action: 'add-from-official',
    },
    {
      label: '$(file-code) Add From Base64 Config...',
      action: 'add-from-base64',
    },
  );

  if (models.length > 0) {
    items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
    for (const model of models) {
      items.push({
        label: model.name || model.id,
        description: model.name ? model.id : undefined,
        detail: formatModelDetail(model),
        model,
        action: 'edit',
        buttons: [
          {
            iconPath: new vscode.ThemeIcon('copy'),
            tooltip: 'Copy as Base64 config',
          },
          {
            iconPath: new vscode.ThemeIcon('files'),
            tooltip: 'Duplicate model',
          },
          { iconPath: new vscode.ThemeIcon('trash'), tooltip: 'Delete model' },
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

    if (route.existing && route.draft) {
      items.push({ label: '$(copy) Copy', action: 'provider-copy' });
      items.push({ label: '$(files) Duplicate', action: 'provider-duplicate' });
      items.push({ label: '$(trash) Delete', action: 'provider-delete' });
    }
  }

  return items;
}

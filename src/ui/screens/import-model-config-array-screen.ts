import * as vscode from 'vscode';
import {
  confirmCancelImport,
  confirmFinalizeImport,
  showImportReviewPicker,
  type ImportReviewItem,
} from '../import-review';
import { showValidationErrors } from '../component';
import {
  formatModelDetail,
  normalizeModelDraft,
} from '../form-utils';
import type {
  ImportModelConfigArrayRoute,
  ModelFormResult,
  UiContext,
  UiNavAction,
  UiResume,
} from '../router/types';
import { ModelConfig } from '../../types';
import {
  promptConflictResolution,
  generateUniqueModelIdAndName,
} from '../conflict-resolution';
import { t } from '../../i18n';

const editButton: vscode.QuickInputButton = {
  iconPath: new vscode.ThemeIcon('edit'),
  tooltip: t('Edit Model'),
};

function getModelDisplayName(model: ModelConfig, fallbackIndex: number): string {
  if (model.name?.trim()) return model.name.trim();
  if (model.id?.trim()) return model.id.trim();
  return t('Model {0}', fallbackIndex + 1);
}

function buildModelImportItems(
  models: ModelConfig[],
  selectedIds: Set<number>,
): ImportReviewItem[] {
  return models.map((model, index) => ({
    label: getModelDisplayName(model, index),
    description: model.name ? model.id : undefined,
    detail: formatModelDetail(model),
    entryId: index,
    picked: selectedIds.has(index),
    buttons: [editButton],
  }));
}

function findDuplicates(values: string[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();

  for (const value of values) {
    if (seen.has(value)) {
      duplicates.add(value);
    } else {
      seen.add(value);
    }
  }

  return [...duplicates];
}

/**
 * Validate selected models for internal errors only.
 * Does NOT check conflicts with existing models.
 */
function validateSelectedModels(options: {
  importedModels: ModelConfig[];
  selectedIds: Set<number>;
}): string[] {
  const selected = [...options.selectedIds]
    .map((id) => ({ id, model: options.importedModels[id] }))
    .filter((entry): entry is { id: number; model: ModelConfig } =>
      Boolean(entry.model),
    );

  if (selected.length === 0) {
    return [t('Select at least one model to import.')];
  }

  const ids = selected.map(({ model }) => model.id?.trim() ?? '');
  if (ids.some((id) => !id)) {
    return [t('Some models are missing IDs. Please edit them first.')];
  }

  // Check for duplicates within imported configs (invalid config error)
  const duplicates = findDuplicates(ids);
  if (duplicates.length > 0) {
    return [t('Model ID conflicts: {0}', duplicates.join(', '))];
  }

  return [];
}

/**
 * Find models that conflict with existing models.
 */
function findExistingConflicts(options: {
  importedModels: ModelConfig[];
  selectedIds: Set<number>;
  existingModels: ModelConfig[];
}): string[] {
  const existingIds = new Set(options.existingModels.map((m) => m.id));
  const conflicts: string[] = [];

  for (const id of options.selectedIds) {
    const model = options.importedModels[id];
    if (!model) continue;

    const modelId = model.id?.trim();
    if (modelId && existingIds.has(modelId)) {
      conflicts.push(modelId);
    }
  }

  return [...new Set(conflicts)];
}

function applyModelFormResultToImportedList(options: {
  entryId: number | undefined;
  importedModels: ModelConfig[];
  result: ModelFormResult;
}): void {
  const entryId = options.entryId;
  if (entryId === undefined) return;

  if (options.result.kind === 'saved') {
    options.importedModels[entryId] = options.result.model;
    return;
  }

  if (options.result.kind === 'deleted') {
    options.importedModels.splice(entryId, 1);
  }
}

export async function runImportModelConfigArrayScreen(
  _ctx: UiContext,
  route: ImportModelConfigArrayRoute,
  resume: UiResume | undefined,
): Promise<UiNavAction> {
  if (resume?.kind === 'modelFormResult') {
    applyModelFormResultToImportedList({
      entryId: route.editingEntryId,
      importedModels: route.models,
      result: resume.result,
    });
    route.editingEntryId = undefined;
  }

  if (!route.selectedIds) {
    route.selectedIds = new Set(route.models.map((_, index) => index));
  }

  if (route.models.length === 0) {
    vscode.window.showInformationMessage(t('No models found to import.'));
    return { kind: 'pop' };
  }

  const pickerResult = await showImportReviewPicker({
    title: t('Import Models From Config'),
    placeholder: t('Select models to import'),
    items: buildModelImportItems(route.models, route.selectedIds),
  });

  if (pickerResult.kind === 'back') {
    const confirmed = await confirmCancelImport();
    return confirmed ? { kind: 'pop' } : { kind: 'stay' };
  }

  route.selectedIds = pickerResult.selectedIds;

  if (pickerResult.kind === 'edit') {
    const model = route.models[pickerResult.entryId];
    if (!model) {
      vscode.window.showErrorMessage(t('Model not found.'));
      return { kind: 'stay' };
    }

    route.editingEntryId = pickerResult.entryId;
    const contextModels = [...route.targetModels, ...route.models];
    return {
      kind: 'push',
      route: {
        kind: 'modelForm',
        mode: 'import',
        model,
        models: contextModels,
        originalId: model.id,
        providerLabel: route.providerLabel,
        providerType: route.providerType,
      },
    };
  }

  // Step 1: Validate for internal errors (excluding existing model conflicts)
  const errors = validateSelectedModels({
    importedModels: route.models,
    selectedIds: route.selectedIds,
  });
  if (errors.length > 0) {
    await showValidationErrors(errors);
    return { kind: 'stay' };
  }

  // Step 2: Check for conflicts with existing models
  const existingConflicts = findExistingConflicts({
    importedModels: route.models,
    selectedIds: route.selectedIds,
    existingModels: route.targetModels,
  });

  if (existingConflicts.length > 0) {
    const resolution = await promptConflictResolution({
      kind: 'model',
      conflicts: existingConflicts,
    });

    if (resolution === 'cancel') {
      return { kind: 'stay' };
    }

    // Build a list of existing models for generating unique IDs
    const allExistingModels = [...route.targetModels];

    // Apply resolution to all conflicting models
    for (const id of route.selectedIds) {
      const model = route.models[id];
      if (!model) continue;

      const modelId = model.id?.trim();
      if (!modelId || !existingConflicts.includes(modelId)) continue;

      if (resolution === 'rename') {
        // Generate unique model ID (#1, #2) and name ((1), (2)) with matching version
        const result = generateUniqueModelIdAndName(
          modelId,
          model.name,
          allExistingModels,
        );
        model.id = result.id;
        if (result.name) {
          model.name = result.name;
        }
        // Add to allExistingModels to avoid conflicts with other imports
        allExistingModels.push({ id: model.id });
      } else if (resolution === 'overwrite') {
        // Remove the existing model from targetModels
        const existingIndex = route.targetModels.findIndex(
          (m) => m.id === modelId,
        );
        if (existingIndex !== -1) {
          route.targetModels.splice(existingIndex, 1);
        }
      }
    }
  }

  const selectedModels = [...route.selectedIds]
    .map((id) => route.models[id])
    .filter((model): model is ModelConfig => Boolean(model))
    .map((model) => normalizeModelDraft(model));

  const ok = await confirmFinalizeImport({
    count: selectedModels.length,
    itemLabel: 'model',
  });
  if (!ok) return { kind: 'stay' };

  route.targetModels.push(...selectedModels);
  return { kind: 'pop' };
}

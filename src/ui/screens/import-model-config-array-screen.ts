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

const editButton: vscode.QuickInputButton = {
  iconPath: new vscode.ThemeIcon('edit'),
  tooltip: 'Edit model',
};

function getModelDisplayName(model: ModelConfig, fallbackIndex: number): string {
  if (model.name?.trim()) return model.name.trim();
  if (model.id?.trim()) return model.id.trim();
  return `Model ${fallbackIndex + 1}`;
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

function validateSelectedModels(options: {
  importedModels: ModelConfig[];
  selectedIds: Set<number>;
  existingModels: ModelConfig[];
}): string[] {
  const selected = [...options.selectedIds]
    .map((id) => ({ id, model: options.importedModels[id] }))
    .filter((entry): entry is { id: number; model: ModelConfig } =>
      Boolean(entry.model),
    );

  if (selected.length === 0) {
    return ['Select at least one model to import.'];
  }

  const ids = selected.map(({ model }) => model.id?.trim() ?? '');
  if (ids.some((id) => !id)) {
    return ['Some models are missing IDs. Please edit them first.'];
  }

  const duplicates = findDuplicates(ids);
  if (duplicates.length > 0) {
    return [`Model ID conflicts: ${duplicates.join(', ')}`];
  }

  const existingIds = new Set(options.existingModels.map((m) => m.id));
  const conflicts = ids.filter((id) => existingIds.has(id));
  if (conflicts.length > 0) {
    const unique = [...new Set(conflicts)];
    return [`Model ID conflicts: ${unique.join(', ')}`];
  }

  return [];
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
    vscode.window.showInformationMessage('No models found to import.');
    return { kind: 'pop' };
  }

  const pickerResult = await showImportReviewPicker({
    title: 'Import Models From Config',
    placeholder: 'Select models to import',
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
      vscode.window.showErrorMessage('Model not found.');
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

  const errors = validateSelectedModels({
    importedModels: route.models,
    selectedIds: route.selectedIds,
    existingModels: route.targetModels,
  });
  if (errors.length > 0) {
    await showValidationErrors(errors);
    return { kind: 'stay' };
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

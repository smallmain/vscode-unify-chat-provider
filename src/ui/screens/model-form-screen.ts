import * as vscode from 'vscode';
import {
  duplicateModel,
  mergePartialModelConfig,
  showCopiedBase64Config,
} from '../base64-config';
import { pickQuickItem, showValidationErrors } from '../component';
import { editField } from '../field-editors';
import { buildFormItems, type FormItem } from '../field-schema';
import {
  confirmDiscardModelChanges,
  createModelDraft,
  normalizeModelDraft,
  validateModelIdUnique,
} from '../form-utils';
import { modelFormSchema, type ModelFieldContext } from '../model-fields';
import type {
  ModelFormResult,
  ModelFormRoute,
  ModelViewRoute,
  UiContext,
  UiNavAction,
  UiResume,
} from '../router/types';
import { ModelConfig } from '../../types';

export async function runModelFormScreen(
  _ctx: UiContext,
  route: ModelFormRoute,
  _resume: UiResume | undefined,
): Promise<UiNavAction> {
  const isImportMode = route.mode === 'import';
  if (!route.draft) {
    route.draft = createModelDraft(route.model);
    route.originalId = route.model?.id;

    if (route.initialConfig && !route.model) {
      mergePartialModelConfig(route.draft, route.initialConfig);
    }
  }

  const draft = route.draft;
  const originalId = route.originalId;

  const context: ModelFieldContext = {
    models: route.models,
    originalId,
    providerType: route.providerType,
  };

  const providerSuffix = route.providerLabel ? ` (${route.providerLabel})` : '';

  const selection = await pickQuickItem<FormItem<ModelConfig>>({
    title: route.model
      ? isImportMode
        ? `Edit Model (${route.model.name || route.model.id})${providerSuffix}`
        : `Model: ${route.model.name || route.model.id}${providerSuffix}`
      : `Add Model${providerSuffix}`,
    placeholder: 'Select a field to edit',
    ignoreFocusOut: true,
    items: buildFormItems(
      modelFormSchema,
      draft,
      {
        isEditing: !isImportMode && !!route.model,
        hasExport: !isImportMode,
        backLabel: '$(arrow-left) Back',
        saveLabel: isImportMode ? '$(check) Done' : '$(check) Save',
      },
      context,
    ),
  });

  if (!selection || selection.action === 'cancel') {
    const decision = await confirmDiscardModelChanges(
      draft,
      route.models,
      route.model,
      originalId,
    );
    if (decision === 'discard') {
      const result: ModelFormResult = { kind: 'cancelled' };
      return { kind: 'pop', resume: { kind: 'modelFormResult', result } };
    }
    if (decision === 'save') {
      const saved = await validateAndBuildModel(
        draft,
        route.models,
        originalId,
      );
      if (saved) {
        const result: ModelFormResult = {
          kind: 'saved',
          model: saved,
          originalId,
        };
        return { kind: 'pop', resume: { kind: 'modelFormResult', result } };
      }
    }
    return { kind: 'stay' };
  }

  if (selection.action === 'delete') {
    const modelId = originalId ?? draft.id;
    const result: ModelFormResult = { kind: 'deleted', modelId };
    return { kind: 'pop', resume: { kind: 'modelFormResult', result } };
  }

  if (selection.action === 'export') {
    await showCopiedBase64Config(draft);
    return { kind: 'stay' };
  }

  if (selection.action === 'duplicate' && route.model) {
    const duplicated = duplicateModel(route.model, route.models);
    route.models.push(duplicated);
    vscode.window.showInformationMessage(
      `Model duplicated as "${duplicated.id}".`,
    );
    return { kind: 'stay' };
  }

  if (selection.action === 'confirm') {
    const saved = await validateAndBuildModel(draft, route.models, originalId);
    if (saved) {
      const result: ModelFormResult = {
        kind: 'saved',
        model: saved,
        originalId,
      };
      return { kind: 'pop', resume: { kind: 'modelFormResult', result } };
    }
    return { kind: 'stay' };
  }

  const field = selection.field;
  if (field) {
    await editModelFieldByFormItem(draft, field, selection.label, context);
  }

  return { kind: 'stay' };
}

/**
 * Read-only model view screen for viewing official models
 */
export async function runModelViewScreen(
  _ctx: UiContext,
  route: ModelViewRoute,
  _resume: UiResume | undefined,
): Promise<UiNavAction> {
  const model = route.model;
  const providerSuffix = route.providerLabel ? ` (${route.providerLabel})` : '';

  const context: ModelFieldContext = {
    models: [],
    originalId: model.id,
    providerType: route.providerType,
  };

  // Build read-only items (no confirm, no duplicate/delete, only export)
  const readOnlyItems = buildFormItems(
    modelFormSchema,
    model,
    {
      isEditing: false,
      hasConfirm: false,
      hasExport: true,
    },
    context,
  );

  const selection = await pickQuickItem<FormItem<ModelConfig>>({
    title: `Model: ${
      route.model.name || route.model.id
    }${providerSuffix} (Read-Only)`,
    placeholder: 'Select a field to view',
    ignoreFocusOut: true,
    items: readOnlyItems,
  });

  if (!selection || selection.action === 'cancel') {
    return { kind: 'pop' };
  }

  if (selection.action === 'export') {
    await showCopiedBase64Config(model);
    return { kind: 'stay' };
  }

  // For any field selection, just stay (read-only, no editing)
  return { kind: 'stay' };
}

async function editModelFieldByFormItem(
  draft: ModelConfig,
  fieldKey: keyof ModelConfig,
  label: string,
  context: ModelFieldContext,
): Promise<void> {
  const normalizedLabel = label.replace(/^\$\([^)]+\)\s*/, '');
  const matchingField = modelFormSchema.fields.find(
    (f) => f.key === fieldKey && f.label === normalizedLabel,
  );

  if (matchingField) {
    if (matchingField.type === 'custom') {
      await matchingField.edit(draft, context);
      return;
    }
    await editField(modelFormSchema, draft, fieldKey, context);
    return;
  }

  await editField(modelFormSchema, draft, fieldKey, context);
}

async function validateAndBuildModel(
  draft: ModelConfig,
  models: ModelConfig[],
  originalId?: string,
): Promise<ModelConfig | undefined> {
  const err = validateModelIdUnique(draft.id, models, originalId);
  if (err) {
    await showValidationErrors([err]);
    return undefined;
  }
  return normalizeModelDraft(draft);
}

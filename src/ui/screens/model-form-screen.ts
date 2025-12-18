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
  };

  const selection = await pickQuickItem<FormItem<ModelConfig>>({
    title: route.model
      ? `Model: ${route.model.name || route.model.id}`
      : 'Add Model',
    placeholder: 'Select a field to edit',
    ignoreFocusOut: true,
    items: buildFormItems(modelFormSchema, draft, {
      isEditing: !!route.model,
    }),
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

  if (selection.action === 'copy') {
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

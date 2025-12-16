import * as vscode from 'vscode';
import { createProvider } from '../client';
import type { ModelConfig } from '../client/interface';
import { WELL_KNOWN_MODELS } from '../well-known-models';
import { generateAutoVersionedId } from '../model-id-utils';
import {
  confirmDelete,
  pickQuickItem,
  showValidationErrors,
} from './component';
import { editField } from './field-editors';
import { buildFormItems, type FormItem } from './field-schema';
import {
  confirmDiscardModelChanges,
  createModelDraft,
  formatModelDetail,
  normalizeModelDraft,
  removeModel,
  validateModelIdUnique,
  type ProviderFormDraft,
} from './form-utils';
import { modelFormSchema, type ModelFieldContext } from './model-fields';
import {
  duplicateModel,
  mergePartialModelConfig,
  promptForBase64Config,
  showCopiedBase64Config,
} from './base64-config';

export type ModelFormResult =
  | { kind: 'saved'; model: ModelConfig }
  | { kind: 'deleted' }
  | { kind: 'cancelled' };

type ModelListItem = vscode.QuickPickItem & {
  action?:
    | 'add'
    | 'back'
    | 'edit'
    | 'add-from-official'
    | 'add-from-wellknown'
    | 'add-from-base64';
  model?: ModelConfig;
};

type ModelSelectionItem = vscode.QuickPickItem & {
  model?: ModelConfig;
  action?: 'back';
};

interface ManageModelListOptions {
  providerLabel: string;
  requireAtLeastOne?: boolean;
  draft?: ProviderFormDraft;
}

interface ShowModelSelectionPickerOptions {
  title: string;
  existingModels: ModelConfig[];
  fetchModels: () => Promise<ModelConfig[]>;
}

/**
 * Manage the model list for a provider.
 */
export async function manageModelList(
  models: ModelConfig[],
  options: ManageModelListOptions,
): Promise<void> {
  const mustKeepOne = options.requireAtLeastOne ?? false;

  for (;;) {
    const selection = await pickQuickItem<ModelListItem>({
      title: `Models (${options.providerLabel})`,
      placeholder: 'Select a model to edit, or add a new one',
      ignoreFocusOut: true,
      items: buildModelListItems(models),
      onDidTriggerItemButton: async (event, qp) => {
        const model = event.item.model;
        if (!model) return;

        const buttonIndex = event.item.buttons?.findIndex(
          (b) => b === event.button,
        );

        // Copy
        if (buttonIndex === 0) {
          await showCopiedBase64Config(model);
          return;
        }

        // Duplicate
        if (buttonIndex === 1) {
          const duplicated = duplicateModel(model, models);
          models.push(duplicated);
          vscode.window.showInformationMessage(
            `Model duplicated as "${duplicated.id}".`,
          );
          qp.items = buildModelListItems(models);
          return;
        }

        // Delete
        if (buttonIndex === 2) {
          if (mustKeepOne && models.length <= 1) {
            vscode.window.showWarningMessage(
              'Cannot delete the last model. A provider must have at least one model.',
            );
            return;
          }
          const confirmed = await confirmDelete(model.id, 'model');
          if (!confirmed) return;
          removeModel(models, model.id);
          qp.items = buildModelListItems(models);
        }
      },
    });

    if (!selection || selection.action === 'back') {
      return;
    }

    if (selection.action === 'add') {
      const result = await openModelForm(undefined, models);
      if (result.kind === 'saved') {
        models.push(result.model);
      }
      continue;
    }

    if (selection.action === 'add-from-base64') {
      const config = await promptForBase64Config<Partial<ModelConfig>>({
        title: 'Add Model From Base64 Config',
        placeholder: 'Paste Base64 configuration string...',
      });
      if (config) {
        const result = await openModelForm(undefined, models, config);
        if (result.kind === 'saved') {
          models.push(result.model);
        }
      }
      continue;
    }

    if (selection.action === 'add-from-official') {
      if (!options.draft?.baseUrl || !options.draft?.type) {
        vscode.window.showErrorMessage(
          'Please configure API Format and Base URL first before fetching official models.',
        );
        continue;
      }
      const draft = options.draft;
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
        continue;
      }
      const addedModels = await showModelSelectionPicker({
        title: 'Add From Official Model List',
        existingModels: models,
        fetchModels: async () => client.getAvailableModels!(),
      });
      if (addedModels) {
        models.push(...addedModels);
      }
      continue;
    }

    if (selection.action === 'add-from-wellknown') {
      if (!options.draft?.type) {
        vscode.window.showErrorMessage(
          'Please select an API format before using the well-known model list.',
        );
        continue;
      }
      const addedModels = await showModelSelectionPicker({
        title: 'Add From Well-Known Model List',
        existingModels: models,
        fetchModels: async () => WELL_KNOWN_MODELS,
      });
      if (addedModels) {
        models.push(...addedModels);
      }
      continue;
    }

    const selectedModel = selection.model;
    if (selectedModel) {
      const result = await openModelForm(selectedModel, models);
      if (result.kind === 'deleted') {
        if (mustKeepOne && models.length <= 1) {
          vscode.window.showWarningMessage(
            'Cannot delete the last model. A provider must have at least one model.',
          );
          continue;
        }
        removeModel(models, selectedModel.id);
      } else if (result.kind === 'saved') {
        const idx = models.findIndex((m) => m.id === selectedModel.id);
        if (idx !== -1) {
          models[idx] = result.model;
        }
      }
    }
  }
}

/**
 * Run the model form for adding or editing a model.
 * @param model - The existing model to edit (undefined for new)
 * @param models - The list of existing models (for validation)
 * @param initialConfig - Initial config values to pre-fill (for add from base64)
 */
async function openModelForm(
  model: ModelConfig | undefined,
  models: ModelConfig[],
  initialConfig?: Partial<ModelConfig>,
): Promise<ModelFormResult> {
  const draft = createModelDraft(model);

  // Apply initial config if provided (for add from base64)
  if (initialConfig && !model) {
    mergePartialModelConfig(draft, initialConfig);
  }

  const originalId = model?.id;

  const context: ModelFieldContext = {
    models,
    originalId,
  };

  for (;;) {
    const selection = await pickQuickItem<FormItem<ModelConfig>>({
      title: model ? `Model: ${model.name || model.id}` : 'Add Model',
      placeholder: 'Select a field to edit',
      ignoreFocusOut: true,
      items: buildFormItems(modelFormSchema, draft, { isEditing: !!model }),
    });

    if (!selection || selection.action === 'cancel') {
      const decision = await confirmDiscardModelChanges(
        draft,
        models,
        model,
        originalId,
      );
      if (decision === 'discard') return { kind: 'cancelled' };
      if (decision === 'save') {
        const saved = await validateAndBuildModel(draft, models, originalId);
        if (saved) return { kind: 'saved', model: saved };
      }
      continue;
    }

    if (selection.action === 'delete') {
      return { kind: 'deleted' };
    }

    if (selection.action === 'copy') {
      await showCopiedBase64Config(draft);
      continue;
    }

    if (selection.action === 'duplicate' && model) {
      const duplicated = duplicateModel(model, models);
      models.push(duplicated);
      vscode.window.showInformationMessage(
        `Model duplicated as "${duplicated.id}".`,
      );
      continue;
    }

    if (selection.action === 'confirm') {
      const saved = await validateAndBuildModel(draft, models, originalId);
      if (saved) return { kind: 'saved', model: saved };
      continue;
    }

    const field = selection.field;
    if (field) {
      // Handle fields that share the same key (like 'capabilities' for toolCalling and imageInput)
      await editModelFieldByFormItem(draft, field, selection.label, context);
    }
  }
}

/**
 * Edit a model field based on the form item label (to distinguish between fields with same key).
 */
async function editModelFieldByFormItem(
  draft: ModelConfig,
  fieldKey: keyof ModelConfig,
  label: string,
  context: ModelFieldContext,
): Promise<void> {
  // Find the matching field by both key and label
  const normalizedLabel = label.replace(/^\$\([^)]+\)\s*/, ''); // Remove icon prefix
  const matchingField = modelFormSchema.fields.find(
    (f) => f.key === fieldKey && f.label === normalizedLabel,
  );

  if (matchingField) {
    // For custom fields, call their edit handler directly
    if (matchingField.type === 'custom') {
      await matchingField.edit(draft, context);
    } else {
      await editField(modelFormSchema, draft, fieldKey, context);
    }
  } else {
    // Fallback to standard field editing
    await editField(modelFormSchema, draft, fieldKey, context);
  }
}

/**
 * Validate and build a model from the draft.
 */
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

/**
 * Build the model list items for the picker.
 */
function buildModelListItems(models: ModelConfig[]): ModelListItem[] {
  const items: ModelListItem[] = [
    { label: '$(arrow-left) Back', action: 'back' },
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
  ];

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

  return items;
}

/**
 * Show a model selection picker with multi-select support.
 */
async function showModelSelectionPicker(
  options: ShowModelSelectionPickerOptions,
): Promise<ModelConfig[] | undefined> {
  return new Promise<ModelConfig[] | undefined>((resolve) => {
    const qp = vscode.window.createQuickPick<ModelSelectionItem>();
    qp.title = options.title;
    qp.placeholder = 'Loading models...';
    qp.canSelectMany = true;
    qp.ignoreFocusOut = true;
    qp.busy = true;
    qp.items = [{ label: '$(arrow-left) Back', action: 'back' }];

    let isLoading = true;

    // Fetch models asynchronously
    options
      .fetchModels()
      .then((models) => {
        isLoading = false;
        qp.busy = false;
        qp.placeholder = 'Select models to add';

        const existingIds = new Set(options.existingModels.map((m) => m.id));
        const items: ModelSelectionItem[] = [
          { label: '$(arrow-left) Back', action: 'back' },
          { label: '', kind: vscode.QuickPickItemKind.Separator },
        ];

        for (const model of models) {
          const alreadyExists = existingIds.has(model.id);
          let detail: string | undefined;

          if (alreadyExists) {
            // Calculate what ID would be used if selected
            const newId = generateAutoVersionedId(
              model.id,
              options.existingModels,
            );
            detail = `(already exists, will add as ${newId})`;
          } else {
            detail = formatModelDetail(model);
          }

          items.push({
            label: model.name || model.id,
            description: model.name ? model.id : undefined,
            detail,
            model,
            picked: false,
          });
        }

        if (models.length === 0) {
          items.push({
            label: '$(info) No models available',
            description: 'The API returned no models',
          });
        }

        qp.items = items;
      })
      .catch((error) => {
        isLoading = false;
        qp.busy = false;
        qp.placeholder = 'Failed to load models';
        qp.canSelectMany = false;
        qp.items = [
          { label: '$(arrow-left) Back', action: 'back' },
          { label: '', kind: vscode.QuickPickItemKind.Separator },
          {
            label: '$(error) Failed to load models',
            description: error instanceof Error ? error.message : String(error),
          },
        ];
      });

    qp.onDidAccept(() => {
      const selectedItems = qp.selectedItems;

      // Check if Back button is in selection
      if (
        selectedItems.some((item: ModelSelectionItem) => item.action === 'back')
      ) {
        qp.hide();
        resolve(undefined);
        return;
      }

      // If loading or no selection, ignore
      if (isLoading || selectedItems.length === 0) {
        return;
      }

      // Collect selected models, auto-generating version IDs for duplicates
      const existingIds = new Set(options.existingModels.map((m) => m.id));
      const newModels: ModelConfig[] = [];
      // Track models added in this batch to generate sequential versions
      const addedInBatch: ModelConfig[] = [];

      for (const item of selectedItems) {
        if (item.model) {
          const combinedModels = [...options.existingModels, ...addedInBatch];
          let newId = item.model.id;

          // If this ID already exists, generate a versioned ID
          if (
            existingIds.has(item.model.id) ||
            addedInBatch.some((m) => m.id === item.model!.id)
          ) {
            newId = generateAutoVersionedId(item.model.id, combinedModels);
          }

          const newModel = { ...item.model, id: newId };
          newModels.push(newModel);
          addedInBatch.push(newModel);
        }
      }

      if (newModels.length > 0) {
        vscode.window.showInformationMessage(
          `Added ${newModels.length} model(s): ${newModels
            .map((m) => m.name || m.id)
            .join(', ')}`,
        );
      }

      qp.hide();
      resolve(newModels.length > 0 ? newModels : undefined);
    });

    // Handle single click on Back item
    qp.onDidChangeSelection((items: readonly ModelSelectionItem[]) => {
      if (items.some((item: ModelSelectionItem) => item.action === 'back')) {
        qp.hide();
        resolve(undefined);
      }
    });

    qp.onDidHide(() => {
      qp.dispose();
      resolve(undefined);
    });

    qp.show();
  });
}

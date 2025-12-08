import * as vscode from 'vscode';
import { ConfigStore } from '../config-store';
import {
  DEFAULT_MAX_INPUT_TOKENS,
  DEFAULT_MAX_OUTPUT_TOKENS,
} from '../defaults';
import { pickQuickItem, showInput, showValidationErrors } from './component';
import {
  validateModelIdUnique,
  validatePositiveIntegerOrEmpty,
  validateProviderForm,
  validateProviderNameUnique,
  validateBaseUrl,
} from './validation';
import { normalizeBaseUrlInput } from '../utils';
import { createProvider, PROVIDERS, ProviderType } from '../client';
import {
  ModelCapabilities,
  ModelConfig,
  ProviderConfig,
  Mimic,
  SUPPORT_MIMIC,
} from '../client/interface';
import { WELL_KNOWN_MODELS } from '../well-known-models';

type ProviderFormDraft = {
  type?: ProviderType;
  name?: string;
  baseUrl?: string;
  apiKey?: string;
  mimic?: Mimic;
  models: ModelConfig[];
};

const MIMIC_LABELS: Record<Mimic, string> = {
  [Mimic.ClaudeCode]: 'Claude Code',
};

type ProviderListItem = vscode.QuickPickItem & {
  action: 'add' | 'provider';
  providerName?: string;
};

type ProviderFormItem = vscode.QuickPickItem & {
  action?: 'confirm' | 'cancel' | 'delete';
  field?: keyof ProviderFormDraft;
};

type ModelListItem = vscode.QuickPickItem & {
  action?: 'add' | 'back' | 'edit' | 'add-from-official' | 'add-from-wellknown';
  model?: ModelConfig;
};

type ModelFormField = keyof ModelConfig | keyof ModelCapabilities;

type ModelFormItem = vscode.QuickPickItem & {
  action?: 'confirm' | 'cancel' | 'delete';
  field?: ModelFormField;
};

type ModelFormResult =
  | { kind: 'saved'; model: ModelConfig }
  | { kind: 'deleted' }
  | { kind: 'cancelled' };

/**
 * Entry point for the management UI shown from the Language Model provider list.
 */
export async function manageProviders(store: ConfigStore): Promise<void> {
  for (;;) {
    const selection = await pickQuickItem<ProviderListItem>({
      title: 'Manage Providers',
      placeholder: 'Select a provider to edit, or add a new one',
      ignoreFocusOut: false,
      items: buildProviderListItems(store),
      onDidTriggerItemButton: async (event, qp) => {
        const item = event.item;
        if (item.action !== 'provider' || !item.providerName) return;

        qp.ignoreFocusOut = true;
        const confirm = await vscode.window.showWarningMessage(
          `Delete provider "${item.providerName}"?`,
          { modal: true },
          'Delete',
        );
        qp.ignoreFocusOut = false;

        if (confirm !== 'Delete') return;
        await store.removeProvider(item.providerName);
        vscode.window.showInformationMessage(
          `Provider "${item.providerName}" has been deleted.`,
        );
        qp.items = buildProviderListItems(store);
      },
    });

    if (!selection) return;
    if (selection.action === 'add') {
      await openProviderForm(store);
      continue;
    }
    if (selection.providerName) {
      await openProviderForm(store, selection.providerName);
    }
  }
}

/** Shortcut command to start the add-provider flow. */
export async function addProvider(store: ConfigStore): Promise<void> {
  await openProviderForm(store);
}

/** Shortcut command to remove a provider via a simple picker. */
export async function removeProvider(store: ConfigStore): Promise<void> {
  const endpoints = store.endpoints;
  if (endpoints.length === 0) {
    vscode.window.showInformationMessage('No providers configured.');
    return;
  }

  const selection = await pickQuickItem<
    vscode.QuickPickItem & { providerName: string }
  >({
    title: 'Remove Provider',
    placeholder: 'Select a provider to remove',
    items: endpoints.map((p) => ({
      label: p.name,
      description: p.baseUrl,
      detail: `${p.models.length} model(s): ${p.models
        .map((m) => m.name || m.id)
        .join(', ')}`,
      providerName: p.name,
    })),
  });

  if (!selection) return;

  const confirm = await vscode.window.showWarningMessage(
    `Are you sure you want to remove "${selection.providerName}"?`,
    { modal: true },
    'Remove',
  );
  if (confirm !== 'Remove') return;

  await store.removeProvider(selection.providerName);
  vscode.window.showInformationMessage(
    `Provider "${selection.providerName}" has been removed.`,
  );
}

async function openProviderForm(
  store: ConfigStore,
  providerName?: string,
): Promise<'saved' | 'deleted' | 'cancelled'> {
  const existing = providerName ? store.getProvider(providerName) : undefined;
  if (providerName && !existing) {
    vscode.window.showErrorMessage(`Provider "${providerName}" not found.`);
    return 'cancelled';
  }

  const draft: ProviderFormDraft = existing
    ? { ...existing, models: cloneModels(existing.models) }
    : { models: [] };
  const originalName = existing?.name;

  for (;;) {
    const selection = await pickQuickItem<ProviderFormItem>({
      title: existing ? `Edit Provider` : 'Add Provider',
      placeholder: 'Select a field to edit',
      ignoreFocusOut: true,
      items: buildProviderFormItems(draft, !!existing),
      onWillAccept: async (item) => {
        if (item.action !== 'confirm') return true;
        const errors = validateProviderForm(draft, store, originalName);
        if (errors.length > 0) {
          await showValidationErrors(errors);
          return false; // keep picker open
        }
        return true;
      },
    });

    if (!selection || selection.action === 'cancel') {
      const decision = await confirmDiscardProviderChanges(draft, existing);
      if (decision === 'discard') return 'cancelled';
      if (decision === 'save') {
        const saved = await saveProviderDraft(
          draft,
          store,
          existing,
          originalName,
        );
        if (saved === 'saved') return 'saved';
      }
      continue;
    }

    if (selection.action === 'delete' && existing) {
      const confirm = await vscode.window.showWarningMessage(
        `Are you sure you want to delete "${existing.name}"?`,
        { modal: true },
        'Delete',
      );
      if (confirm === 'Delete') {
        await store.removeProvider(existing.name);
        vscode.window.showInformationMessage(
          `Provider "${existing.name}" has been deleted.`,
        );
        return 'deleted';
      }
      continue;
    }

    if (selection.action === 'confirm') {
      const saved = await saveProviderDraft(
        draft,
        store,
        existing,
        originalName,
      );
      if (saved === 'saved') return 'saved';
      continue;
    }

    const field = selection.field;
    if (field) {
      await editProviderField(draft, field, store, originalName);
    }
  }
}

async function editProviderField(
  draft: ProviderFormDraft,
  field: keyof ProviderFormDraft,
  store: ConfigStore,
  originalName?: string,
): Promise<void> {
  switch (field) {
    case 'type': {
      const picked = await pickQuickItem<
        vscode.QuickPickItem & { typeValue: ProviderType }
      >({
        title: 'API Format',
        placeholder: 'Select the API format',
        items: Object.values(PROVIDERS).map((opt) => ({
          label: opt.label,
          description: opt.description,
          picked: opt.type === draft.type,
          typeValue: opt.type,
        })),
      });
      if (picked) {
        draft.type = picked.typeValue;

        // Reset mimic if it is not supported by the newly selected provider type
        if (
          draft.mimic &&
          !(SUPPORT_MIMIC[draft.type] ?? []).includes(draft.mimic)
        ) {
          draft.mimic = undefined;
        }
      }
      break;
    }
    case 'name': {
      const val = await showInput({
        prompt: 'Enter a name for this provider',
        placeHolder: 'e.g., My Provider, OpenRouter, Custom',
        value: draft.name ?? '',
        validateInput: (v) =>
          validateProviderNameUnique(v, store, originalName),
      });
      if (val !== undefined) draft.name = val.trim() || undefined;
      break;
    }
    case 'baseUrl': {
      const val = await showInput({
        prompt: 'Enter the API base URL',
        placeHolder: 'e.g., https://api.example.com',
        value: draft.baseUrl ?? '',
        validateInput: validateBaseUrl,
      });
      if (val !== undefined) draft.baseUrl = normalizeBaseUrlInput(val);
      break;
    }
    case 'apiKey': {
      const val = await showInput({
        prompt: 'Enter your API key (leave blank to remove)',
        password: true,
        value: draft.apiKey ?? '',
      });
      if (val !== undefined) {
        const trimmed = val.trim();
        draft.apiKey = trimmed ? trimmed : undefined;
      }
      break;
    }
    case 'mimic': {
      if (!draft.type) {
        vscode.window.showWarningMessage(
          'Please select an API format before choosing a mimic option.',
        );
        break;
      }

      const supported = SUPPORT_MIMIC[draft.type] ?? [];
      if (supported.length === 0) {
        vscode.window.showInformationMessage(
          'The selected provider type does not have any mimic options.',
        );
        draft.mimic = undefined;
        break;
      }

      const picked = await pickQuickItem<
        vscode.QuickPickItem & { mimicValue?: Mimic }
      >({
        title: 'Mimic Behavior',
        placeholder: 'Select a mimic option (or None)',
        items: [
          {
            label: 'None',
            description: "Use the provider's default behavior",
            picked: !draft.mimic,
            mimicValue: undefined,
          },
          ...supported.map((mimic) => ({
            label: formatMimicLabel(mimic),
            description: mimic,
            picked: draft.mimic === mimic,
            mimicValue: mimic,
          })),
        ],
      });

      if (picked) {
        draft.mimic = picked.mimicValue ?? undefined;
      }
      break;
    }
    case 'models': {
      await manageModelList(draft.models, {
        providerLabel: draft.name ?? originalName ?? 'Provider',
        requireAtLeastOne: false,
        draft,
      });
      break;
    }
  }
}

async function manageModelList(
  models: ModelConfig[],
  options: {
    providerLabel: string;
    requireAtLeastOne?: boolean;
    draft?: ProviderFormDraft;
  },
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
        if (mustKeepOne && models.length <= 1) {
          vscode.window.showWarningMessage(
            'Cannot delete the last model. A provider must have at least one model.',
          );
          return;
        }
        const confirm = await vscode.window.showWarningMessage(
          `Delete model "${model.id}"?`,
          { modal: true },
          'Delete',
        );
        if (confirm !== 'Delete') return;
        removeModel(models, model.id);
        qp.items = buildModelListItems(models);
      },
    });

    if (!selection || selection.action === 'back') {
      return;
    }

    if (selection.action === 'add') {
      const result = await runModelForm(undefined, models);
      if (result.kind === 'saved') {
        models.push(result.model);
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
      const result = await runModelForm(selectedModel, models);
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

async function runModelForm(
  model: ModelConfig | undefined,
  models: ModelConfig[],
): Promise<ModelFormResult> {
  const draft: ModelConfig = model ? { ...model } : { id: '' };
  const originalId = model?.id;

  for (;;) {
    const selection = await pickQuickItem<ModelFormItem>({
      title: model ? `Model: ${model.name || model.id}` : 'Add Model',
      placeholder: 'Select a field to edit',
      ignoreFocusOut: true,
      items: buildModelFormItems(draft, !!model),
      onWillAccept: async (item) => {
        if (item.action !== 'confirm') return true;
        const err = validateModelIdUnique(draft.id, models, originalId);
        if (err) {
          await showValidationErrors([err]);
          return false;
        }
        return true;
      },
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

    if (selection.action === 'confirm') {
      const saved = await validateAndBuildModel(draft, models, originalId);
      if (saved) return { kind: 'saved', model: saved };
      continue;
    }

    const field = selection.field;
    if (field) {
      await editModelField(draft, field, models, originalId);
    }
  }
}

async function editModelField(
  draft: ModelConfig,
  field: ModelFormField,
  models: ModelConfig[],
  originalId?: string,
): Promise<void> {
  switch (field) {
    case 'id': {
      const val = await showInput({
        prompt: 'Enter the model ID',
        placeHolder: 'e.g., claude-sonnet-4-20250514',
        value: draft.id || '',
        validateInput: (v) => validateModelIdUnique(v, models, originalId),
      });
      if (val !== undefined) draft.id = val.trim();
      break;
    }
    case 'name': {
      const val = await showInput({
        prompt: 'Enter display name (leave blank to remove)',
        placeHolder: 'e.g., Claude Sonnet 4',
        value: draft.name || '',
      });
      if (val !== undefined) draft.name = val.trim() || undefined;
      break;
    }
    case 'family': {
      const val = await showInput({
        prompt: 'Enter model family (leave blank to use model ID)',
        placeHolder: 'e.g., gpt-4, claude-3',
        value: draft.family || '',
      });
      if (val !== undefined) draft.family = val.trim() || undefined;
      break;
    }
    case 'maxInputTokens': {
      const val = await showInput({
        prompt: `Enter max input tokens (leave blank for defaults: ${DEFAULT_MAX_INPUT_TOKENS.toLocaleString()})`,
        value: draft.maxInputTokens?.toString() || '',
        validateInput: validatePositiveIntegerOrEmpty,
      });
      if (val !== undefined)
        draft.maxInputTokens = val ? Number(val) : undefined;
      break;
    }
    case 'maxOutputTokens': {
      const val = await showInput({
        prompt: `Enter max output tokens (leave blank for defaults: ${DEFAULT_MAX_OUTPUT_TOKENS.toLocaleString()})`,
        value: draft.maxOutputTokens?.toString() || '',
        validateInput: validatePositiveIntegerOrEmpty,
      });
      if (val !== undefined)
        draft.maxOutputTokens = val ? Number(val) : undefined;
      break;
    }
    case 'toolCalling': {
      const picked = await pickQuickItem<
        vscode.QuickPickItem & { value: boolean | 'limit' }
      >({
        title: 'Tool Calling Support',
        placeholder: 'Select tool calling support',
        items: [
          {
            label: 'Enabled',
            description: 'Model supports tool calling',
            value: true,
          },
          {
            label: 'Disabled',
            description: 'Model does not support tool calling',
            value: false,
          },
          {
            label: 'Limited...',
            description: 'Set a maximum number of tools',
            value: 'limit',
          },
        ],
      });

      if (!picked) return;

      if (picked.value === 'limit') {
        const limitStr = await showInput({
          prompt: 'Enter maximum number of tools',
          placeHolder: 'e.g., 10',
          value:
            typeof draft.capabilities?.toolCalling === 'number'
              ? draft.capabilities.toolCalling.toString()
              : '',
          validateInput: validatePositiveIntegerOrEmpty,
        });
        if (limitStr !== undefined) {
          const limit = limitStr ? Number(limitStr) : undefined;
          if (limit !== undefined) {
            draft.capabilities = {
              ...draft.capabilities,
              toolCalling: limit,
            };
          }
        }
      } else {
        draft.capabilities = {
          ...draft.capabilities,
          toolCalling: picked.value,
        };
      }
      break;
    }
    case 'imageInput': {
      const picked = await pickQuickItem<
        vscode.QuickPickItem & { value: boolean }
      >({
        title: 'Image Input Support',
        placeholder: 'Enable or disable image input',
        items: [
          {
            label: 'Enabled',
            description: 'Model supports image input',
            value: true,
          },
          {
            label: 'Disabled',
            description: 'Model does not support image input',
            value: false,
          },
        ],
      });
      if (picked) {
        draft.capabilities = {
          ...draft.capabilities,
          imageInput: picked.value,
        };
      }
      break;
    }
    case 'stream': {
      const picked = await pickQuickItem<
        vscode.QuickPickItem & { value: boolean | undefined }
      >({
        title: 'Stream Response',
        placeholder: 'Select stream setting',
        items: [
          {
            label: 'Default',
            description: 'Use provider default',
            value: undefined,
          },
          { label: 'True', description: 'Enable streaming', value: true },
          { label: 'False', description: 'Disable streaming', value: false },
        ],
      });
      if (picked) draft.stream = picked.value;
      break;
    }
    case 'temperature': {
      const val = await showInput({
        prompt: 'Enter temperature',
        placeHolder: 'Leave blank for default',
        value: draft.temperature?.toString() || '',
        validateInput: (v) => {
          if (!v) return null;
          const n = Number(v);
          if (isNaN(n)) return 'Must be a number';
          return null;
        },
      });
      if (val !== undefined) draft.temperature = val ? Number(val) : undefined;
      break;
    }
    case 'topK': {
      const val = await showInput({
        prompt: 'Enter Top K',
        placeHolder: 'Leave blank for default',
        value: draft.topK?.toString() || '',
        validateInput: validatePositiveIntegerOrEmpty,
      });
      if (val !== undefined) draft.topK = val ? Number(val) : undefined;
      break;
    }
    case 'topP': {
      const val = await showInput({
        prompt: 'Enter Top P',
        placeHolder: 'Leave blank for default',
        value: draft.topP?.toString() || '',
        validateInput: (v) => {
          if (!v) return null;
          const n = Number(v);
          if (isNaN(n)) return 'Must be a number';
          return null;
        },
      });
      if (val !== undefined) draft.topP = val ? Number(val) : undefined;
      break;
    }
    case 'thinking': {
      const picked = await pickQuickItem<
        vscode.QuickPickItem & { value: 'enabled' | 'disabled' | undefined }
      >({
        title: 'Thinking Capability',
        placeholder: 'Select thinking setting',
        items: [
          {
            label: 'Default',
            description: 'Use provider default',
            value: undefined,
          },
          {
            label: 'Enabled',
            description: 'Enable thinking',
            value: 'enabled',
          },
          {
            label: 'Disabled',
            description: 'Disable thinking',
            value: 'disabled',
          },
        ],
      });

      if (!picked) return;

      if (picked.value === undefined) {
        draft.thinking = undefined;
      } else if (picked.value === 'disabled') {
        draft.thinking = { type: 'disabled' };
      } else {
        const budgetStr = await showInput({
          prompt: 'Enter budget tokens for thinking',
          placeHolder: 'Leave blank for default',
          value: draft.thinking?.budgetTokens?.toString(),
          validateInput: validatePositiveIntegerOrEmpty,
        });
        draft.thinking = {
          type: 'enabled',
          budgetTokens: budgetStr ? Number(budgetStr) : undefined,
        };
      }
      break;
    }
  }
}

function buildProviderListItems(store: ConfigStore): ProviderListItem[] {
  const items: ProviderListItem[] = [
    {
      label: '$(add) Add New Provider...',
      action: 'add',
      alwaysShow: true,
    },
  ];

  for (const provider of store.endpoints) {
    const modelList = provider.models.map((m) => m.name || m.id).join(', ');
    items.push({
      label: provider.name,
      description: provider.baseUrl,
      detail: modelList ? `Models: ${modelList}` : 'No models',
      action: 'provider',
      providerName: provider.name,
      buttons: [
        {
          iconPath: new vscode.ThemeIcon('trash'),
          tooltip: 'Delete provider',
        },
      ],
    });
  }

  return items;
}

function buildProviderFormItems(
  draft: ProviderFormDraft,
  isEditing: boolean,
): ProviderFormItem[] {
  const modelCount = draft.models.length;
  const mimicDescription = draft.mimic
    ? formatMimicLabel(draft.mimic)
    : '(optional, none)';
  const items: ProviderFormItem[] = [
    { label: '$(arrow-left) Back', action: 'cancel' },
    {
      label: '',
      kind: vscode.QuickPickItemKind.Separator,
      description: 'Primary Fields',
    },
    {
      label: '$(tag) Name',
      description: draft.name || '(required)',
      field: 'name',
    },
    {
      label: '$(symbol-enum) API Format',
      description:
        Object.values(PROVIDERS).find((o) => o.type === draft.type)?.label ||
        '(required)',
      field: 'type',
    },
    {
      label: '$(globe) API Base URL',
      description: draft.baseUrl || '(required)',
      field: 'baseUrl',
    },
    {
      label: '$(key) API Key',
      description: draft.apiKey ? '••••••••' : '(optional)',
      field: 'apiKey',
    },
    {
      label: '',
      kind: vscode.QuickPickItemKind.Separator,
      description: 'Content Fields',
    },
    {
      label: '$(symbol-misc) Models',
      description:
        modelCount > 0 ? `${modelCount} model(s)` : '(optional, none added)',
      detail:
        modelCount > 0
          ? draft.models.map((m) => m.name || m.id).join(', ')
          : undefined,
      field: 'models',
    },
    {
      label: '',
      kind: vscode.QuickPickItemKind.Separator,
      description: 'Other Fields',
    },
    {
      label: '$(vr) Mimic',
      description: mimicDescription,
      detail: 'Mimic some User-Agent client behavior.',
      field: 'mimic',
    },
    { label: '', kind: vscode.QuickPickItemKind.Separator },
    {
      label: '$(check) Save',
      action: 'confirm',
    },
  ];

  if (isEditing) {
    items.push({
      label: '$(trash) Delete',
      action: 'delete',
    });
  }

  return items;
}

function buildModelListItems(models: ModelConfig[]): ModelListItem[] {
  const items: ModelListItem[] = [
    { label: '$(arrow-left) Back', action: 'back' },
    { label: '$(add) Add Model...', action: 'add' },
    {
      label: '$(clippy) Add From Well-Known Model List...',
      action: 'add-from-wellknown',
    },
    {
      label: '$(cloud-download) Add From Official Model List...',
      action: 'add-from-official',
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
          { iconPath: new vscode.ThemeIcon('trash'), tooltip: 'Delete model' },
        ],
      });
    }
  }

  return items;
}

function buildModelFormItems(
  draft: ModelConfig,
  isEditing: boolean,
): ModelFormItem[] {
  const defaultMaxInputDescription = `optional, defaults: ${DEFAULT_MAX_INPUT_TOKENS.toLocaleString()}`;
  const defaultMaxOutputDescription = `optional, defaults: ${DEFAULT_MAX_OUTPUT_TOKENS.toLocaleString()}`;

  const items: ModelFormItem[] = [
    { label: '$(arrow-left) Back', action: 'cancel' },
    {
      label: '',
      kind: vscode.QuickPickItemKind.Separator,
      description: 'Primary Fields',
    },
    {
      label: '$(tag) Model ID',
      description: draft.id || '(required)',
      field: 'id',
    },
    {
      label: '$(symbol-text) Display Name',
      description: draft.name || '(optional)',
      field: 'name',
    },
    {
      label: '$(versions) Model Family',
      description: draft.family || '(optional)',
      field: 'family',
    },
    {
      label: '',
      kind: vscode.QuickPickItemKind.Separator,
      description: 'Detailed Fields',
    },
    {
      label: '$(arrow-down) Max Input Tokens',
      description:
        draft.maxInputTokens?.toLocaleString() || defaultMaxInputDescription,
      field: 'maxInputTokens',
    },
    {
      label: '$(arrow-up) Max Output Tokens',
      description:
        draft.maxOutputTokens?.toLocaleString() || defaultMaxOutputDescription,
      field: 'maxOutputTokens',
    },
    {
      label: '',
      kind: vscode.QuickPickItemKind.Separator,
      description: 'Capabilities',
    },
    {
      label: '$(tools) Tool Calling',
      description:
        typeof draft.capabilities?.toolCalling === 'number'
          ? `Enabled (max ${draft.capabilities.toolCalling})`
          : draft.capabilities?.toolCalling
          ? 'Enabled'
          : 'Disabled',
      field: 'toolCalling',
    },
    {
      label: '$(file-media) Image Input Support',
      description: draft.capabilities?.imageInput ? 'Enabled' : 'Disabled',
      field: 'imageInput',
    },
    {
      label: '$(fold-down) Stream',
      description:
        draft.stream === undefined
          ? 'default'
          : draft.stream
          ? 'true'
          : 'false',
      field: 'stream',
    },
    {
      label: '$(lightbulb) Thinking',
      description: draft.thinking
        ? `${draft.thinking.type}${
            draft.thinking.type === 'enabled'
              ? ` (${draft.thinking.budgetTokens} tokens)`
              : ''
          }`
        : 'default',
      field: 'thinking',
    },
    {
      label: '',
      kind: vscode.QuickPickItemKind.Separator,
      description: 'Parameters',
    },
    {
      label: '$(circle) Temperature',
      description:
        draft.temperature === undefined
          ? 'default'
          : draft.temperature.toString(),
      field: 'temperature',
    },
    {
      label: '$(circle) Top K',
      description: draft.topK === undefined ? 'default' : draft.topK.toString(),
      field: 'topK',
    },
    {
      label: '$(circle) Top P',
      description: draft.topP === undefined ? 'default' : draft.topP.toString(),
      field: 'topP',
    },
    { label: '', kind: vscode.QuickPickItemKind.Separator },
    {
      label: '$(check) Save',
      action: 'confirm',
    },
  ];

  if (isEditing) {
    items.push({ label: '$(trash) Delete', action: 'delete' });
  }

  return items;
}

function formatMimicLabel(mimic: Mimic): string {
  return MIMIC_LABELS[mimic] ?? mimic;
}

function formatModelDetail(model: ModelConfig): string | undefined {
  const parts: string[] = [];
  if (model.maxInputTokens) {
    parts.push(`Input: ${model.maxInputTokens.toLocaleString()}`);
  }
  if (model.maxOutputTokens) {
    parts.push(`Output: ${model.maxOutputTokens.toLocaleString()}`);
  }
  if (model.capabilities?.toolCalling) {
    if (typeof model.capabilities.toolCalling === 'number') {
      parts.push(`Tool (max ${model.capabilities.toolCalling})`);
    } else {
      parts.push('Tool');
    }
  }
  if (model.capabilities?.imageInput) {
    parts.push('Image');
  }
  return parts.length > 0 ? parts.join(' | ') : undefined;
}

function normalizeProviderDraft(draft: ProviderFormDraft): ProviderConfig {
  return {
    type: draft.type!,
    name: draft.name!.trim(),
    baseUrl: normalizeBaseUrlInput(draft.baseUrl!),
    apiKey: draft.apiKey?.trim() || undefined,
    mimic: draft.mimic,
    models: cloneModels(draft.models),
  };
}

function normalizeModelDraft(draft: ModelConfig): ModelConfig {
  return {
    id: draft.id.trim(),
    name: draft.name?.trim() || undefined,
    family: draft.family?.trim() || undefined,
    maxInputTokens: draft.maxInputTokens,
    maxOutputTokens: draft.maxOutputTokens,
    capabilities: draft.capabilities ? { ...draft.capabilities } : undefined,
    stream: draft.stream,
    temperature: draft.temperature,
    topK: draft.topK,
    topP: draft.topP,
    thinking: draft.thinking ? { ...draft.thinking } : undefined,
  };
}

function cloneModels(models: ModelConfig[]): ModelConfig[] {
  return models.map((m) => ({
    id: m.id,
    name: m.name,
    family: m.family,
    maxInputTokens: m.maxInputTokens,
    maxOutputTokens: m.maxOutputTokens,
    capabilities: m.capabilities ? { ...m.capabilities } : undefined,
    stream: m.stream,
    temperature: m.temperature,
    topK: m.topK,
    topP: m.topP,
    thinking: m.thinking ? { ...m.thinking } : undefined,
  }));
}

function removeModel(models: ModelConfig[], id: string): void {
  const idx = models.findIndex((m) => m.id === id);
  if (idx !== -1) models.splice(idx, 1);
}

async function confirmDiscardProviderChanges(
  draft: ProviderFormDraft,
  original?: ProviderConfig,
): Promise<'discard' | 'save' | 'stay'> {
  if (!hasProviderChanges(draft, original)) return 'discard';
  const choice = await vscode.window.showWarningMessage(
    'Discard unsaved provider changes?',
    { modal: true },
    'Discard',
    'Save',
  );
  if (choice === 'Discard') return 'discard';
  if (choice === 'Save') return 'save';
  return 'stay';
}

async function confirmDiscardModelChanges(
  draft: ModelConfig,
  models: ModelConfig[],
  original?: ModelConfig,
  originalId?: string,
): Promise<'discard' | 'save' | 'stay'> {
  if (!hasModelChanges(draft, original)) return 'discard';
  const choice = await vscode.window.showWarningMessage(
    'Discard unsaved model changes?',
    { modal: true },
    'Discard',
    'Save',
  );
  if (choice === 'Discard') return 'discard';
  if (choice === 'Save') {
    const err = validateModelIdUnique(draft.id, models, originalId);
    if (err) {
      await showValidationErrors([err]);
      return 'stay';
    }
    return 'save';
  }
  return 'stay';
}

function hasProviderChanges(
  draft: ProviderFormDraft,
  original?: ProviderConfig,
): boolean {
  const trimmedName = draft.name?.trim();
  const trimmedBaseUrl = draft.baseUrl?.trim();
  const trimmedApiKey = draft.apiKey?.trim();

  if (!original) {
    return (
      !!draft.type ||
      !!trimmedName ||
      !!trimmedBaseUrl ||
      !!trimmedApiKey ||
      !!draft.mimic ||
      draft.models.length > 0
    );
  }

  if (draft.type !== original.type) return true;
  if ((trimmedName ?? '') !== original.name) return true;
  if ((trimmedBaseUrl ?? '') !== original.baseUrl) return true;
  if ((trimmedApiKey ?? '') !== (original.apiKey ?? '')) return true;
  if (draft.mimic !== original.mimic) return true;
  return modelsChanged(draft.models, original.models);
}

function thinkingEqual(
  a?: ModelConfig['thinking'],
  b?: ModelConfig['thinking'],
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.type === b.type && a.budgetTokens === b.budgetTokens;
}

function hasModelChanges(draft: ModelConfig, original?: ModelConfig): boolean {
  const trimmedId = draft.id.trim();
  const trimmedName = draft.name?.trim() ?? '';
  const inputTokens = draft.maxInputTokens ?? null;
  const outputTokens = draft.maxOutputTokens ?? null;
  const toolCalling = draft.capabilities?.toolCalling ?? false;
  const imageInput = draft.capabilities?.imageInput ?? false;

  const stream = draft.stream;
  const temperature = draft.temperature;
  const topK = draft.topK;
  const topP = draft.topP;
  const thinking = draft.thinking;

  if (!original) {
    return (
      !!trimmedId ||
      !!trimmedName ||
      inputTokens !== null ||
      outputTokens !== null ||
      !!toolCalling ||
      imageInput ||
      stream !== undefined ||
      temperature !== undefined ||
      topK !== undefined ||
      topP !== undefined ||
      thinking !== undefined
    );
  }

  return (
    trimmedId !== original.id ||
    trimmedName !== (original.name ?? '') ||
    inputTokens !== (original.maxInputTokens ?? null) ||
    outputTokens !== (original.maxOutputTokens ?? null) ||
    toolCalling !== (original.capabilities?.toolCalling ?? false) ||
    imageInput !== (original.capabilities?.imageInput ?? false) ||
    stream !== original.stream ||
    temperature !== original.temperature ||
    topK !== original.topK ||
    topP !== original.topP ||
    !thinkingEqual(thinking, original.thinking)
  );
}

function modelsChanged(next: ModelConfig[], original: ModelConfig[]): boolean {
  if (next.length !== original.length) return true;
  return next.some((model, idx) => !modelsEqual(model, original[idx]));
}

function modelsEqual(a: ModelConfig, b: ModelConfig): boolean {
  return (
    a.id === b.id &&
    (a.name ?? '') === (b.name ?? '') &&
    (a.maxInputTokens ?? null) === (b.maxInputTokens ?? null) &&
    (a.maxOutputTokens ?? null) === (b.maxOutputTokens ?? null) &&
    (a.capabilities?.toolCalling ?? false) ===
      (b.capabilities?.toolCalling ?? false) &&
    (a.capabilities?.imageInput ?? false) ===
      (b.capabilities?.imageInput ?? false) &&
    a.stream === b.stream &&
    a.temperature === b.temperature &&
    a.topK === b.topK &&
    a.topP === b.topP &&
    thinkingEqual(a.thinking, b.thinking)
  );
}

async function saveProviderDraft(
  draft: ProviderFormDraft,
  store: ConfigStore,
  existing?: ProviderConfig,
  originalName?: string,
): Promise<'saved' | 'invalid'> {
  const errors = validateProviderForm(draft, store, originalName);
  if (errors.length > 0) {
    await showValidationErrors(errors);
    return 'invalid';
  }

  const provider: ProviderConfig = normalizeProviderDraft(draft);
  if (originalName && provider.name !== originalName) {
    await store.removeProvider(originalName);
  }
  await store.upsertProvider(provider);
  vscode.window.showInformationMessage(
    existing
      ? `Provider "${provider.name}" updated.`
      : `Provider "${provider.name}" added.`,
  );
  return 'saved';
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

type ModelSelectionItem = vscode.QuickPickItem & {
  model?: ModelConfig;
  action?: 'back';
};

interface ShowModelSelectionPickerOptions {
  title: string;
  existingModels: ModelConfig[];
  fetchModels: () => Promise<ModelConfig[]>;
}

/**
 * Show a model selection picker with multi-select support
 * Returns the selected models or undefined if cancelled
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
          items.push({
            label: model.name || model.id,
            description: model.name ? model.id : undefined,
            detail: alreadyExists
              ? '(already added)'
              : formatModelDetail(model),
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

      // Check if Back button is in selection (shouldn't happen with canSelectMany, but check anyway)
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

      // Filter out already existing models and collect selected models
      const existingIds = new Set(options.existingModels.map((m) => m.id));
      const newModels: ModelConfig[] = [];
      const conflictIds: string[] = [];

      for (const item of selectedItems) {
        if (item.model) {
          if (existingIds.has(item.model.id)) {
            conflictIds.push(item.model.id);
          } else {
            newModels.push({ ...item.model });
          }
        }
      }

      if (conflictIds.length > 0) {
        vscode.window.showWarningMessage(
          `The following models are already added and will be skipped: ${conflictIds.join(
            ', ',
          )}`,
        );
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

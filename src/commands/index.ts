import * as vscode from 'vscode';
import { ConfigStore } from '../config/store';
import { ProviderConfig, ModelConfig, ProviderType } from '../types';

/**
 * Available provider types with display labels
 */
const PROVIDER_TYPE_OPTIONS: {
  label: string;
  value: ProviderType;
  description: string;
}[] = [
  {
    label: 'Anthropic',
    value: 'anthropic',
    description: 'Anthropic Messages API format',
  },
];

/**
 * QuickPick item for provider management
 */
interface ProviderQuickPickItem extends vscode.QuickPickItem {
  provider?: ProviderConfig;
  action?: 'add';
}

/**
 * QuickPick buttons
 */
const editButton: vscode.QuickInputButton = {
  iconPath: new vscode.ThemeIcon('edit'),
  tooltip: 'Edit Provider',
};

const deleteButton: vscode.QuickInputButton = {
  iconPath: new vscode.ThemeIcon('trash'),
  tooltip: 'Delete Provider',
};

/**
 * Register all extension commands
 */
export function registerCommands(
  context: vscode.ExtensionContext,
  configStore: ConfigStore,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('unifyChatProvider.addProvider', () =>
      addProvider(configStore),
    ),
    vscode.commands.registerCommand('unifyChatProvider.removeProvider', () =>
      removeProvider(configStore),
    ),
    vscode.commands.registerCommand('unifyChatProvider.manageProviders', () =>
      manageProviders(configStore),
    ),
  );
}

/**
 * Add a new provider through interactive prompts
 */
async function addProvider(configStore: ConfigStore): Promise<void> {
  // Select provider type
  const typeSelection = await vscode.window.showQuickPick(
    PROVIDER_TYPE_OPTIONS.map((opt) => ({
      label: opt.label,
      description: opt.description,
      value: opt.value,
    })),
    {
      placeHolder: 'Select the API format',
    },
  );

  if (!typeSelection) {
    return;
  }

  const providerType = (typeSelection as { value: ProviderType }).value;

  // Get provider name
  const name = await vscode.window.showInputBox({
    prompt: 'Enter a name for this provider',
    placeHolder: 'e.g., Anthropic, OpenRouter, Custom',
    validateInput: (value) => {
      if (!value.trim()) {
        return 'Provider name is required';
      }
      if (configStore.getProvider(value.trim())) {
        return 'A provider with this name already exists';
      }
      return null;
    },
  });

  if (!name) {
    return;
  }

  // Get base URL
  const baseUrl = await vscode.window.showInputBox({
    prompt: 'Enter the API endpoint URL',
    placeHolder: 'e.g., https://api.anthropic.com/v1/messages',
    validateInput: (value) => {
      if (!value.trim()) {
        return 'API endpoint URL is required';
      }
      try {
        new URL(value.trim());
        return null;
      } catch {
        return 'Please enter a valid URL';
      }
    },
  });

  if (!baseUrl) {
    return;
  }

  // Get API key
  const apiKey = await vscode.window.showInputBox({
    prompt: 'Enter your API key (leave blank if not required)',
    password: true,
  });

  if (apiKey === undefined) {
    return;
  }

  // Get models
  const modelsInput = await vscode.window.showInputBox({
    prompt: 'Enter model IDs (comma-separated)',
    placeHolder: 'e.g., claude-sonnet-4-20250514, claude-opus-4-20250514',
    validateInput: (value) => {
      if (!value.trim()) {
        return 'At least one model is required';
      }
      return null;
    },
  });

  if (!modelsInput) {
    return;
  }

  const modelIds = modelsInput
    .split(',')
    .map((m) => m.trim())
    .filter(Boolean);

  if (modelIds.length === 0) {
    vscode.window.showErrorMessage('At least one model is required');
    return;
  }

  // Convert to ModelConfig array
  const models: ModelConfig[] = modelIds.map((id) => ({ id }));

  // Create and save the provider
  const provider: ProviderConfig = {
    type: providerType,
    name: name.trim(),
    baseUrl: baseUrl.trim(),
    apiKey: apiKey || undefined,
    models,
  };

  await configStore.upsertProvider(provider);
  vscode.window.showInformationMessage(
    `Provider "${name}" has been added successfully.`,
  );
}

/**
 * Remove an existing provider
 */
async function removeProvider(configStore: ConfigStore): Promise<void> {
  const endpoints = configStore.endpoints;

  if (endpoints.length === 0) {
    vscode.window.showInformationMessage('No providers configured.');
    return;
  }

  const items: vscode.QuickPickItem[] = endpoints.map((p) => ({
    label: p.name,
    description: p.baseUrl,
    detail: `${p.models.length} model(s): ${p.models
      .map((m) => m.id)
      .join(', ')}`,
  }));

  const selected = await vscode.window.showQuickPick(items, {
    placeHolder: 'Select a provider to remove',
  });

  if (!selected) {
    return;
  }

  const confirm = await vscode.window.showWarningMessage(
    `Are you sure you want to remove "${selected.label}"?`,
    { modal: true },
    'Remove',
  );

  if (confirm !== 'Remove') {
    return;
  }

  await configStore.removeProvider(selected.label);
  vscode.window.showInformationMessage(
    `Provider "${selected.label}" has been removed.`,
  );
}

/**
 * Manage providers with an interactive QuickPick UI
 */
async function manageProviders(configStore: ConfigStore): Promise<void> {
  const showProviderList = async (): Promise<void> => {
    const quickPick = vscode.window.createQuickPick<ProviderQuickPickItem>();
    quickPick.title = 'Manage Providers';
    quickPick.placeholder = 'Select a provider to edit, or add a new one';
    quickPick.ignoreFocusOut = true;

    const updateItems = () => {
      const endpoints = configStore.endpoints;
      const items: ProviderQuickPickItem[] = [
        {
          label: '$(add) Add New Provider...',
          action: 'add',
          alwaysShow: true,
        },
      ];

      for (const provider of endpoints) {
        const modelList = provider.models.map((m) => m.name || m.id).join(', ');
        items.push({
          label: provider.name,
          description: provider.baseUrl,
          detail: `$(symbol-misc) model(s): ${modelList}`,
          provider,
          buttons: [deleteButton],
        });
      }

      quickPick.items = items;
    };

    updateItems();

    // Listen for configuration changes to refresh the list
    const configListener = configStore.onDidChange(() => {
      updateItems();
    });

    quickPick.onDidAccept(async () => {
      const selected = quickPick.selectedItems[0];
      if (!selected) {
        return;
      }

      if (selected.action === 'add') {
        quickPick.hide();
        await addProvider(configStore);
        // Re-open the list after adding
        await showProviderList();
      } else if (selected.provider) {
        quickPick.hide();
        await showProviderDetails(configStore, selected.provider);
        // Re-open the list after viewing details
        await showProviderList();
      }
    });

    quickPick.onDidTriggerItemButton(async (e) => {
      const item = e.item as ProviderQuickPickItem;
      if (!item.provider) {
        return;
      }

      if (e.button === deleteButton) {
        const confirm = await vscode.window.showWarningMessage(
          `Are you sure you want to delete "${item.provider.name}"?`,
          { modal: true },
          'Delete',
        );

        if (confirm === 'Delete') {
          await configStore.removeProvider(item.provider.name);
          vscode.window.showInformationMessage(
            `Provider "${item.provider.name}" has been deleted.`,
          );
        }
      }
    });

    quickPick.onDidHide(() => {
      configListener.dispose();
      quickPick.dispose();
    });

    quickPick.show();

    // Return a promise that resolves when the QuickPick is hidden
    return new Promise<void>((resolve) => {
      quickPick.onDidHide(() => resolve());
    });
  };

  await showProviderList();
}

/**
 * Show provider details with options to edit or delete
 */
async function showProviderDetails(
  configStore: ConfigStore,
  provider: ProviderConfig,
): Promise<void> {
  interface DetailItem extends vscode.QuickPickItem {
    action?: 'delete' | 'back';
    field?: string;
  }

  const items: DetailItem[] = [
    {
      label: '$(arrow-left) Back',
      action: 'back',
    },
    {
      label: '',
      kind: vscode.QuickPickItemKind.Separator,
    },
    {
      label: '$(tag) Name',
      description: provider.name,
      field: 'name',
    },
    {
      label: '$(globe) API Endpoint',
      description: provider.baseUrl,
      field: 'baseUrl',
    },
    {
      label: '$(key) API Key',
      description: provider.apiKey ? '••••••••' : '(not set)',
      field: 'apiKey',
    },
    {
      label: '$(symbol-misc) Models',
      description: `${provider.models.length} model(s)`,
      detail: provider.models.map((m) => m.name || m.id).join(', '),
      field: 'models',
    },
    {
      label: '',
      kind: vscode.QuickPickItemKind.Separator,
    },
    {
      label: '$(trash) Delete Provider',
      action: 'delete',
    },
  ];

  const selected = await vscode.window.showQuickPick(items, {
    title: `Provider: ${provider.name}`,
    placeHolder: 'View details or select an action',
  });

  if (!selected) {
    return;
  }

  if (selected.action === 'back') {
    return;
  }

  if (selected.action === 'delete') {
    const confirm = await vscode.window.showWarningMessage(
      `Are you sure you want to delete "${provider.name}"?`,
      { modal: true },
      'Delete',
    );

    if (confirm === 'Delete') {
      await configStore.removeProvider(provider.name);
      vscode.window.showInformationMessage(
        `Provider "${provider.name}" has been deleted.`,
      );
    }
    return;
  }

  // If a field was selected, jump to edit that specific field
  if (selected.field) {
    await editProvider(configStore, provider, selected.field);
    // Re-open details after editing
    await showProviderDetails(configStore, provider);
  }
}

/**
 * Edit an existing provider
 */
async function editProvider(
  configStore: ConfigStore,
  provider: ProviderConfig,
  focusField: string,
): Promise<void> {
  // Create a mutable copy of the provider
  const edited: ProviderConfig = {
    ...provider,
    models: [...provider.models],
  };
  const originalName = provider.name;

  switch (focusField) {
    case 'name': {
      const name = await vscode.window.showInputBox({
        prompt: 'Enter a new name for this provider',
        value: edited.name,
        validateInput: (value) => {
          if (!value.trim()) {
            return 'Provider name is required';
          }
          if (
            value.trim() !== originalName &&
            configStore.getProvider(value.trim())
          ) {
            return 'A provider with this name already exists';
          }
          return null;
        },
      });
      if (name !== undefined) {
        edited.name = name.trim();
        // Remove old provider and add with new name
        await configStore.removeProvider(originalName);
        await configStore.upsertProvider(edited);
        vscode.window.showInformationMessage('Provider name updated.');
      }
      break;
    }
    case 'baseUrl': {
      const baseUrl = await vscode.window.showInputBox({
        prompt: 'Enter the API endpoint URL',
        value: edited.baseUrl,
        validateInput: (value) => {
          if (!value.trim()) {
            return 'API endpoint URL is required';
          }
          try {
            new URL(value.trim());
            return null;
          } catch {
            return 'Please enter a valid URL';
          }
        },
      });
      if (baseUrl !== undefined) {
        edited.baseUrl = baseUrl.trim();
        await configStore.upsertProvider(edited);
        vscode.window.showInformationMessage('API endpoint updated.');
      }
      break;
    }
    case 'apiKey': {
      const apiKey = await vscode.window.showInputBox({
        prompt: 'Enter your API key (leave blank to remove)',
        password: true,
        value: edited.apiKey || '',
      });
      if (apiKey !== undefined) {
        edited.apiKey = apiKey || undefined;
        await configStore.upsertProvider(edited);
        vscode.window.showInformationMessage('API key updated.');
      }
      break;
    }
    case 'models': {
      await editProviderModels(configStore, edited);
      break;
    }
  }
}

/**
 * Edit models for a provider
 */
async function editProviderModels(
  configStore: ConfigStore,
  provider: ProviderConfig,
): Promise<void> {
  interface ModelItem extends vscode.QuickPickItem {
    model?: ModelConfig;
    action?: 'add' | 'back';
  }

  const showModelList = async (): Promise<void> => {
    const items: ModelItem[] = [
      {
        label: '$(arrow-left) Back',
        action: 'back',
      },
      {
        label: '$(add) Add Model...',
        action: 'add',
      },
      {
        label: '',
        kind: vscode.QuickPickItemKind.Separator,
      },
    ];

    for (const model of provider.models) {
      items.push({
        label: model.name || model.id,
        description: model.name ? model.id : undefined,
        detail:
          [
            model.maxInputTokens
              ? `Max input: ${model.maxInputTokens.toLocaleString()}`
              : null,
            model.maxOutputTokens
              ? `Max output: ${model.maxOutputTokens.toLocaleString()}`
              : null,
          ]
            .filter(Boolean)
            .join(' | ') || undefined,
        model,
        buttons: [editButton, deleteButton],
      });
    }

    const quickPick = vscode.window.createQuickPick<ModelItem>();
    quickPick.title = `Models for ${provider.name}`;
    quickPick.placeholder = 'Select a model to edit, or add a new one';
    quickPick.items = items;
    quickPick.ignoreFocusOut = true;

    return new Promise<void>((resolve) => {
      quickPick.onDidAccept(async () => {
        const selected = quickPick.selectedItems[0];
        if (!selected) {
          return;
        }

        if (selected.action === 'back') {
          quickPick.hide();
          resolve();
          return;
        }

        if (selected.action === 'add') {
          quickPick.hide();
          await addModel(configStore, provider);
          await showModelList();
          resolve();
          return;
        }

        if (selected.model) {
          quickPick.hide();
          await editModel(configStore, provider, selected.model);
          await showModelList();
          resolve();
        }
      });

      quickPick.onDidTriggerItemButton(async (e) => {
        const item = e.item as ModelItem;
        if (!item.model) {
          return;
        }

        if (e.button === editButton) {
          quickPick.hide();
          await editModel(configStore, provider, item.model);
          await showModelList();
          resolve();
        } else if (e.button === deleteButton) {
          if (provider.models.length === 1) {
            vscode.window.showWarningMessage(
              'Cannot delete the last model. A provider must have at least one model.',
            );
            return;
          }

          const confirm = await vscode.window.showWarningMessage(
            `Delete model "${item.model.id}"?`,
            { modal: true },
            'Delete',
          );

          if (confirm === 'Delete') {
            provider.models = provider.models.filter(
              (m) => m.id !== item.model!.id,
            );
            await configStore.upsertProvider(provider);
            // Refresh the list
            quickPick.items = quickPick.items.filter(
              (i) => (i as ModelItem).model?.id !== item.model!.id,
            );
          }
        }
      });

      quickPick.onDidHide(() => {
        quickPick.dispose();
        resolve();
      });

      quickPick.show();
    });
  };

  await showModelList();
}

/**
 * Add a new model to a provider
 */
async function addModel(
  configStore: ConfigStore,
  provider: ProviderConfig,
): Promise<void> {
  const id = await vscode.window.showInputBox({
    prompt: 'Enter the model ID',
    placeHolder: 'e.g., claude-sonnet-4-20250514',
    validateInput: (value) => {
      if (!value.trim()) {
        return 'Model ID is required';
      }
      if (provider.models.some((m) => m.id === value.trim())) {
        return 'A model with this ID already exists';
      }
      return null;
    },
  });

  if (!id) {
    return;
  }

  const name = await vscode.window.showInputBox({
    prompt: 'Display name (optional)',
    placeHolder: 'e.g., Claude Sonnet 4',
  });

  if (name === undefined) {
    return;
  }

  const model: ModelConfig = {
    id: id.trim(),
    name: name.trim() || undefined,
  };

  provider.models.push(model);
  await configStore.upsertProvider(provider);
  vscode.window.showInformationMessage(`Model "${id}" has been added.`);
}

/**
 * Edit a model configuration
 */
async function editModel(
  configStore: ConfigStore,
  provider: ProviderConfig,
  model: ModelConfig,
): Promise<void> {
  interface FieldItem extends vscode.QuickPickItem {
    field?: string;
    action?: 'delete' | 'back';
  }

  const items: FieldItem[] = [
    {
      label: '$(arrow-left) Back',
      action: 'back',
    },
    {
      label: '',
      kind: vscode.QuickPickItemKind.Separator,
    },
    {
      label: '$(tag) Model ID',
      description: model.id,
      field: 'id',
    },
    {
      label: '$(symbol-text) Display Name',
      description: model.name || '(not set)',
      field: 'name',
    },
    {
      label: '$(arrow-down) Max Input Tokens',
      description: model.maxInputTokens?.toLocaleString() || '(default)',
      field: 'maxInputTokens',
    },
    {
      label: '$(arrow-up) Max Output Tokens',
      description: model.maxOutputTokens?.toLocaleString() || '(default)',
      field: 'maxOutputTokens',
    },
    {
      label: '',
      kind: vscode.QuickPickItemKind.Separator,
    },
    {
      label: '$(trash) Delete Model',
      action: 'delete',
    },
  ];

  const selected = await vscode.window.showQuickPick(items, {
    title: `Model: ${model.name || model.id}`,
    placeHolder: 'Select a field to edit',
  });

  if (!selected || selected.action === 'back') {
    return;
  }

  if (selected.action === 'delete') {
    if (provider.models.length === 1) {
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

    if (confirm === 'Delete') {
      provider.models = provider.models.filter((m) => m.id !== model.id);
      await configStore.upsertProvider(provider);
      vscode.window.showInformationMessage(
        `Model "${model.id}" has been deleted.`,
      );
    }
    return;
  }

  // Edit specific field
  const modelIndex = provider.models.findIndex((m) => m.id === model.id);
  if (modelIndex === -1) {
    return;
  }

  switch (selected.field) {
    case 'id': {
      const newId = await vscode.window.showInputBox({
        prompt: 'Enter the new model ID',
        value: model.id,
        validateInput: (value) => {
          if (!value.trim()) {
            return 'Model ID is required';
          }
          if (
            value.trim() !== model.id &&
            provider.models.some((m) => m.id === value.trim())
          ) {
            return 'A model with this ID already exists';
          }
          return null;
        },
      });
      if (newId !== undefined && newId.trim() !== model.id) {
        provider.models[modelIndex] = { ...model, id: newId.trim() };
        await configStore.upsertProvider(provider);
        vscode.window.showInformationMessage('Model ID updated.');
      }
      break;
    }
    case 'name': {
      const newName = await vscode.window.showInputBox({
        prompt: 'Enter display name (leave blank to remove)',
        value: model.name || '',
      });
      if (newName !== undefined) {
        provider.models[modelIndex] = {
          ...model,
          name: newName.trim() || undefined,
        };
        await configStore.upsertProvider(provider);
        vscode.window.showInformationMessage('Display name updated.');
      }
      break;
    }
    case 'maxInputTokens': {
      const value = await vscode.window.showInputBox({
        prompt: 'Enter max input tokens (leave blank for default)',
        value: model.maxInputTokens?.toString() || '',
        validateInput: (v) => {
          if (v && (isNaN(Number(v)) || Number(v) <= 0)) {
            return 'Please enter a positive number';
          }
          return null;
        },
      });
      if (value !== undefined) {
        provider.models[modelIndex] = {
          ...model,
          maxInputTokens: value ? Number(value) : undefined,
        };
        await configStore.upsertProvider(provider);
        vscode.window.showInformationMessage('Max input tokens updated.');
      }
      break;
    }
    case 'maxOutputTokens': {
      const value = await vscode.window.showInputBox({
        prompt: 'Enter max output tokens (leave blank for default)',
        value: model.maxOutputTokens?.toString() || '',
        validateInput: (v) => {
          if (v && (isNaN(Number(v)) || Number(v) <= 0)) {
            return 'Please enter a positive number';
          }
          return null;
        },
      });
      if (value !== undefined) {
        provider.models[modelIndex] = {
          ...model,
          maxOutputTokens: value ? Number(value) : undefined,
        };
        await configStore.upsertProvider(provider);
        vscode.window.showInformationMessage('Max output tokens updated.');
      }
      break;
    }
  }
}

import * as vscode from 'vscode';
import { ConfigStore } from '../config/store';
import { ProviderConfig, ModelConfig, ProviderType } from '../types';

/**
 * Available provider types with display labels
 */
const PROVIDER_TYPE_OPTIONS: { label: string; value: ProviderType; description: string }[] = [
  { label: 'Anthropic', value: 'anthropic', description: 'Anthropic Messages API format' },
];

/**
 * Register all extension commands
 */
export function registerCommands(context: vscode.ExtensionContext, configStore: ConfigStore): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('unifyChatProviders.addProvider', () => addProvider(configStore)),
    vscode.commands.registerCommand('unifyChatProviders.removeProvider', () => removeProvider(configStore)),
    vscode.commands.registerCommand('unifyChatProviders.manageProviders', () => manageProviders(configStore))
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
    }
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

  // Select default model
  let defaultModel: string | undefined;
  if (modelIds.length > 1) {
    defaultModel = await vscode.window.showQuickPick(modelIds, {
      placeHolder: 'Select the default model (optional)',
    });
  } else {
    defaultModel = modelIds[0];
  }

  // Create and save the provider
  const provider: ProviderConfig = {
    type: providerType,
    name: name.trim(),
    baseUrl: baseUrl.trim(),
    apiKey: apiKey || undefined,
    models,
    defaultModel,
  };

  await configStore.upsertProvider(provider);
  vscode.window.showInformationMessage(`Provider "${name}" has been added successfully.`);
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
    detail: `${p.models.length} model(s): ${p.models.map((m) => m.id).join(', ')}`,
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
    'Remove'
  );

  if (confirm !== 'Remove') {
    return;
  }

  await configStore.removeProvider(selected.label);
  vscode.window.showInformationMessage(`Provider "${selected.label}" has been removed.`);
}

/**
 * Open settings to manage providers
 */
async function manageProviders(_configStore: ConfigStore): Promise<void> {
  await vscode.commands.executeCommand('workbench.action.openSettings', 'unifyChatProviders.endpoints');
}

import * as vscode from 'vscode';
import { t } from './i18n';
import { pickLanguageModel } from './language-model-picker';
import type { LanguageModelReference } from './language-model-picker';
import { NoLanguageModelsAvailableError } from './commit-message/types';

export type VSCodeDefaultModelValueType =
  | 'vendor/id'
  | 'name-vendor'
  | 'only-copilot-id';

export interface VSCodeDefaultModelConfiguration {
  name: string;
  configurationKey: string;
  detail: string;
  functional: boolean;
  valueType: VSCodeDefaultModelValueType;
}

interface ConfigurationQuickPickItem extends vscode.QuickPickItem {
  itemType: 'configuration';
  configuration: VSCodeDefaultModelConfiguration;
}

interface FunctionalModelsQuickPickItem extends vscode.QuickPickItem {
  itemType: 'functionalModels';
}

type VSCodeDefaultModelQuickPickItem =
  | ConfigurationQuickPickItem
  | FunctionalModelsQuickPickItem
  | vscode.QuickPickItem;

type VSCodeDefaultModelActionItem =
  | ConfigurationQuickPickItem
  | FunctionalModelsQuickPickItem;

export const VSCODE_DEFAULT_MODEL_CONFIGURATIONS = [
  {
    name: 'Chat: Utility Model',
    configurationKey: 'chat.utilityModel',
    detail:
      'Override the language model used by built-in utility flows. Leave empty to use the default model.',
    functional: true,
    valueType: 'vendor/id',
  },
  {
    name: 'Chat: Utility Small Model',
    configurationKey: 'chat.utilitySmallModel',
    detail:
      'Override the language model used by built-in small/fast utility flows. A fast and inexpensive model is recommended. Leave empty to use the default model.',
    functional: true,
    valueType: 'vendor/id',
  },
  {
    name: 'Chat: Explore Agent Default Model',
    configurationKey: 'chat.exploreAgent.defaultModel',
    detail:
      'Select the default language model to use for the Explore subagent from the available providers.',
    functional: true,
    valueType: 'name-vendor',
  },
  {
    name: 'GitHub Copilot Chat: Explore Agent Model',
    configurationKey: 'github.copilot.chat.exploreAgent.model',
    detail:
      'Override the language model used by the Explore subagent. Defaults to a fast, small model. Leave empty to use the built-in fallback list.',
    functional: true,
    valueType: 'name-vendor',
  },
  {
    name: 'Inline Chat: Default Model',
    configurationKey: 'inlineChat.defaultModel',
    detail:
      "Select the default language model to use for inline chat from the available providers. Model names may include the provider in parentheses, for example 'Claude Haiku 4.5 (copilot)'.",
    functional: false,
    valueType: 'name-vendor',
  },
  {
    name: 'Chat: Plan Agent Default Model',
    configurationKey: 'chat.planAgent.defaultModel',
    detail:
      'Select the default language model to use for the Plan agent from the available providers.',
    functional: false,
    valueType: 'name-vendor',
  },
  {
    name: 'GitHub Copilot Chat: Ask Agent Model',
    configurationKey: 'github.copilot.chat.askAgent.model',
    detail:
      'Override the language model used by the Ask agent. Leave empty to use the default model.',
    functional: false,
    valueType: 'name-vendor',
  },
  {
    name: 'GitHub Copilot Chat: Implement Agent Model',
    configurationKey: 'github.copilot.chat.implementAgent.model',
    detail:
      "Override the language model used when starting implementation from the Plan agent's handoff. Use the format `Model Name (vendor)` (e.g., `GPT-5 (copilot)`). Leave empty to use the default model.",
    functional: false,
    valueType: 'name-vendor',
  },
] as const satisfies readonly VSCodeDefaultModelConfiguration[];

function readGlobalConfigurationValue(configurationKey: string): string {
  const inspection = vscode.workspace
    .getConfiguration()
    .inspect<unknown>(configurationKey);
  const value = inspection?.globalValue;
  return typeof value === 'string' && value.trim() ? value : t('Default');
}

function createConfigurationItem(
  configuration: VSCodeDefaultModelConfiguration,
): ConfigurationQuickPickItem {
  return {
    label: configuration.functional
      ? `★ ${configuration.name}`
      : configuration.name,
    description: readGlobalConfigurationValue(configuration.configurationKey),
    detail: t(configuration.detail),
    itemType: 'configuration',
    configuration,
  };
}

function createFunctionalModelsItem(): FunctionalModelsQuickPickItem {
  return {
    label: `$(sparkle) ${t('Change All Built-in Utility Models')}`,
    itemType: 'functionalModels',
  };
}

function createConfigurationItems(): VSCodeDefaultModelQuickPickItem[] {
  return [
    ...VSCODE_DEFAULT_MODEL_CONFIGURATIONS.map(createConfigurationItem),
    {
      label: '',
      kind: vscode.QuickPickItemKind.Separator,
    },
    createFunctionalModelsItem(),
  ];
}

function isVSCodeDefaultModelActionItem(
  item: VSCodeDefaultModelQuickPickItem,
): item is VSCodeDefaultModelActionItem {
  return 'itemType' in item;
}

async function pickVSCodeDefaultModelConfigurations(): Promise<
  readonly VSCodeDefaultModelConfiguration[] | undefined
> {
  const selected = await vscode.window.showQuickPick(createConfigurationItems(), {
    placeHolder: t('Choose a VS Code default model setting'),
    matchOnDescription: true,
    matchOnDetail: true,
  });

  if (!selected || !isVSCodeDefaultModelActionItem(selected)) {
    return undefined;
  }

  if (selected.itemType === 'configuration') {
    return [selected.configuration];
  }

  return VSCODE_DEFAULT_MODEL_CONFIGURATIONS.filter(
    (configuration) => configuration.functional,
  );
}

async function updateVSCodeDefaultModelConfiguration(
  configurationKey: string,
  value: string | undefined,
): Promise<void> {
  const config = vscode.workspace.getConfiguration();
  await config.update(
    configurationKey,
    value,
    vscode.ConfigurationTarget.Global,
  );
}

function formatLanguageModelSettingValue(
  configuration: VSCodeDefaultModelConfiguration,
  model: LanguageModelReference,
): string {
  switch (configuration.valueType) {
    case 'vendor/id':
      return `${model.vendor}/${model.id}`;
    case 'name-vendor':
      return `${model.name} (${model.vendor})`;
    case 'only-copilot-id':
      return model.id;
  }
}

async function updateVSCodeDefaultModelConfigurations(
  configurations: readonly VSCodeDefaultModelConfiguration[],
  model: LanguageModelReference | undefined,
): Promise<void> {
  await Promise.all(
    configurations.map((configuration) =>
      updateVSCodeDefaultModelConfiguration(
        configuration.configurationKey,
        model ? formatLanguageModelSettingValue(configuration, model) : undefined,
      ),
    ),
  );
}

function showVSCodeDefaultModelUpdateMessage(
  configurations: readonly VSCodeDefaultModelConfiguration[],
  modelName: string | undefined,
): void {
  if (modelName === undefined) {
    vscode.window.showInformationMessage(
      t('Reset {0} VS Code default model setting(s).', configurations.length),
    );
    return;
  }

  vscode.window.showInformationMessage(
    t(
      'Updated {0} VS Code default model setting(s): {1}',
      configurations.length,
      modelName,
    ),
  );
}

function shouldIncludeCopilotUtilityModels(
  configurations: readonly VSCodeDefaultModelConfiguration[],
): boolean {
  if (configurations.length !== 1) {
    return false;
  }

  return ![
    'chat.utilityModel',
    'chat.utilitySmallModel',
  ].includes(configurations[0].configurationKey);
}

export async function changeVSCodeDefaultModel(): Promise<void> {
  const configurations = await pickVSCodeDefaultModelConfigurations();
  if (!configurations || configurations.length === 0) {
    return;
  }

  const selectedModel = await pickLanguageModel({
    placeHolder: t('Choose a language model for VS Code default model settings'),
    includeDefault: true,
    includeCopilotUtilityModels:
      shouldIncludeCopilotUtilityModels(configurations),
  });
  if (!selectedModel) {
    return;
  }

  if (selectedModel.kind === 'default') {
    await updateVSCodeDefaultModelConfigurations(configurations, undefined);
    showVSCodeDefaultModelUpdateMessage(configurations, undefined);
    return;
  }

  await updateVSCodeDefaultModelConfigurations(configurations, selectedModel.model);
  showVSCodeDefaultModelUpdateMessage(
    configurations,
    selectedModel.model.name,
  );
}

export async function handleVSCodeDefaultModelError(
  error: unknown,
): Promise<void> {
  if (error instanceof vscode.CancellationError) {
    return;
  }

  if (error instanceof NoLanguageModelsAvailableError) {
    vscode.window.showWarningMessage(
      t('No available language models were found.'),
    );
    return;
  }

  const message = error instanceof Error ? error.message : String(error);
  vscode.window.showErrorMessage(
    t('Failed to update VS Code default model settings: {0}', message),
  );
}

import * as vscode from 'vscode';
import { t } from './i18n';
import { pickLanguageModel } from './language-model-picker';
import { NoLanguageModelsAvailableError } from './commit-message/types';

export interface VSCodeDefaultModelConfiguration {
  name: string;
  configurationKey: string;
  detail: string;
  functional: boolean;
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
  | FunctionalModelsQuickPickItem;

export const VSCODE_DEFAULT_MODEL_CONFIGURATIONS = [
  {
    name: 'Chat: Utility Model',
    configurationKey: 'chat.utilityModel',
    detail:
      'Override the language model used by built-in utility flows. Leave empty to use the default model.',
    functional: true,
  },
  {
    name: 'Chat: Utility Small Model',
    configurationKey: 'chat.utilitySmallModel',
    detail:
      'Override the smaller language model used by built-in utility flows. Leave empty to use the default model.',
    functional: true,
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
    label: configuration.name,
    description: readGlobalConfigurationValue(configuration.configurationKey),
    detail: t(configuration.detail),
    itemType: 'configuration',
    configuration,
  };
}

function createFunctionalModelsItem(): FunctionalModelsQuickPickItem {
  return {
    label: t('Change Built-in functional model'),
    detail: t('Update every built-in functional model setting.'),
    itemType: 'functionalModels',
  };
}

function createConfigurationItems(): VSCodeDefaultModelQuickPickItem[] {
  return [
    ...VSCODE_DEFAULT_MODEL_CONFIGURATIONS.map(createConfigurationItem),
    createFunctionalModelsItem(),
  ];
}

async function pickVSCodeDefaultModelConfigurations(): Promise<
  readonly VSCodeDefaultModelConfiguration[] | undefined
> {
  const selected = await vscode.window.showQuickPick(createConfigurationItems(), {
    placeHolder: t('Choose a VS Code default model setting'),
    matchOnDescription: true,
    matchOnDetail: true,
  });

  if (!selected) {
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
  model: vscode.LanguageModelChat,
): string {
  return `${model.vendor}/${model.id}`;
}

async function updateVSCodeDefaultModelConfigurations(
  configurations: readonly VSCodeDefaultModelConfiguration[],
  value: string | undefined,
): Promise<void> {
  await Promise.all(
    configurations.map((configuration) =>
      updateVSCodeDefaultModelConfiguration(configuration.configurationKey, value),
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

export async function changeVSCodeDefaultModel(): Promise<void> {
  const configurations = await pickVSCodeDefaultModelConfigurations();
  if (!configurations || configurations.length === 0) {
    return;
  }

  const selectedModel = await pickLanguageModel({
    placeHolder: t('Choose a language model for VS Code default model settings'),
    includeDefault: true,
  });
  if (!selectedModel) {
    return;
  }

  if (selectedModel.kind === 'default') {
    await updateVSCodeDefaultModelConfigurations(configurations, undefined);
    showVSCodeDefaultModelUpdateMessage(configurations, undefined);
    return;
  }

  await updateVSCodeDefaultModelConfigurations(
    configurations,
    formatLanguageModelSettingValue(selectedModel.model),
  );
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

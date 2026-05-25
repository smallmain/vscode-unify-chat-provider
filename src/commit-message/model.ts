import * as vscode from 'vscode';
import {
  inspectCommitMessageModelConfiguration,
  readCommitMessageGenerationConfiguration,
  updateCommitMessageModelConfiguration,
} from './config';
import type { CommitMessageGenerationModelConfiguration } from './types';
import { NoLanguageModelsAvailableError } from './types';
import { t } from '../i18n';
import {
  getLanguageModelVendorDisplayName,
  isUnifyChatProviderVendor,
} from '../language-model-vendors';

const MODEL_NAME_COLLATOR = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: 'base',
});

interface ConfigurationTargetQuickPickItem extends vscode.QuickPickItem {
  target: vscode.ConfigurationTarget;
}

interface ModelQuickPickItem extends vscode.QuickPickItem {
  model: vscode.LanguageModelChat;
}

function formatConfiguredModel(
  model: CommitMessageGenerationModelConfiguration | undefined,
): string {
  if (!model || !model.vendor || !model.id) {
    return t('Not configured');
  }

  if (isUnifyChatProviderVendor(model.vendor)) {
    const parsed = parseExtensionModelId(model.id);
    if (parsed) {
      return `${getLanguageModelVendorDisplayName(model.vendor)} / ${parsed.providerName} / ${parsed.modelId}`;
    }
  }

  return `${model.vendor}/${model.id}`;
}

function parseExtensionModelId(
  modelId: string,
): { providerName: string; modelId: string } | undefined {
  const slashIndex = modelId.indexOf('/');
  if (slashIndex === -1) {
    return undefined;
  }

  const encodedProviderName = modelId.slice(0, slashIndex);
  const resolvedModelId = modelId.slice(slashIndex + 1);
  try {
    return {
      providerName: decodeURIComponent(encodedProviderName),
      modelId: resolvedModelId,
    };
  } catch {
    return {
      providerName: encodedProviderName,
      modelId: resolvedModelId,
    };
  }
}

function getExtensionProviderName(model: vscode.LanguageModelChat): string {
  if (!isUnifyChatProviderVendor(model.vendor)) {
    return '';
  }

  return parseExtensionModelId(model.id)?.providerName ?? '';
}

function getModelVendorLabel(model: vscode.LanguageModelChat): string {
  return isUnifyChatProviderVendor(model.vendor)
    ? getLanguageModelVendorDisplayName(model.vendor)
    : model.vendor;
}

async function getAvailableLanguageModels(): Promise<vscode.LanguageModelChat[]> {
  const models = await vscode.lm.selectChatModels();
  const dedupedModels = new Map<string, vscode.LanguageModelChat>();

  for (const model of models) {
    dedupedModels.set(`${model.vendor}/${model.id}`, model);
  }

  return [...dedupedModels.values()].sort((left, right) => {
    const vendorComparison = MODEL_NAME_COLLATOR.compare(
      getModelVendorLabel(left),
      getModelVendorLabel(right),
    );
    if (vendorComparison !== 0) {
      return vendorComparison;
    }

    const providerComparison = MODEL_NAME_COLLATOR.compare(
      getExtensionProviderName(left),
      getExtensionProviderName(right),
    );
    if (providerComparison !== 0) {
      return providerComparison;
    }

    const nameComparison = MODEL_NAME_COLLATOR.compare(left.name, right.name);
    if (nameComparison !== 0) {
      return nameComparison;
    }

    return MODEL_NAME_COLLATOR.compare(left.id, right.id);
  });
}

function createConfigurationTargetItems(): ConfigurationTargetQuickPickItem[] {
  const inspection = inspectCommitMessageModelConfiguration();

  const items: ConfigurationTargetQuickPickItem[] = [
    {
      label: t('User'),
      detail: t('Current: {0}', formatConfiguredModel(inspection.globalValue)),
      target: vscode.ConfigurationTarget.Global,
    },
  ];

  if (vscode.workspace.workspaceFolders?.length) {
    items.push({
      label: t('Workspace'),
      detail: t(
        'Current: {0}',
        formatConfiguredModel(inspection.workspaceValue),
      ),
      target: vscode.ConfigurationTarget.Workspace,
    });
  }

  return items;
}

async function pickConfigurationTarget(): Promise<vscode.ConfigurationTarget | undefined> {
  const items = createConfigurationTargetItems();
  if (items.length === 1) {
    return items[0].target;
  }

  const selected = await vscode.window.showQuickPick(items, {
    placeHolder: t('Choose settings scope for the commit message model'),
    matchOnDescription: true,
    matchOnDetail: true,
  });

  return selected?.target;
}

async function pickModel(): Promise<vscode.LanguageModelChat | undefined> {
  const models = await getAvailableLanguageModels();
  if (models.length === 0) {
    throw new NoLanguageModelsAvailableError();
  }

  const items: ModelQuickPickItem[] = models.map((model) => ({
    label: model.name,
    description: getExtensionProviderName(model) || getModelVendorLabel(model),
    detail: isUnifyChatProviderVendor(model.vendor)
      ? `${getModelVendorLabel(model)} | ${model.id}`
      : model.id,
    model,
  }));

  const selected = await vscode.window.showQuickPick(items, {
    placeHolder: t('Choose a language model for commit message generation'),
    matchOnDescription: true,
    matchOnDetail: true,
  });

  return selected?.model;
}

export async function changeCommitMessageModelConfiguration(): Promise<
  vscode.LanguageModelChat | undefined
> {
  const target = await pickConfigurationTarget();
  if (target === undefined) {
    return undefined;
  }

  const model = await pickModel();
  if (!model) {
    return undefined;
  }

  const configuration = {
    vendor: model.vendor,
    id: model.id,
  };
  await updateCommitMessageModelConfiguration(configuration, target);

  const targetLabel =
    target === vscode.ConfigurationTarget.Workspace ? t('Workspace') : t('User');
  vscode.window.showInformationMessage(
    t('Updated commit message model for {0}: {1}', targetLabel, model.name),
  );

  return model;
}

async function resolveConfiguredModel(
  model: CommitMessageGenerationModelConfiguration,
): Promise<vscode.LanguageModelChat | undefined> {
  if (!model.vendor || !model.id) {
    return undefined;
  }

  const models = await vscode.lm.selectChatModels({
    vendor: model.vendor,
    id: model.id,
  });
  if (models[0]) {
    return models[0];
  }

  if (!isUnifyChatProviderVendor(model.vendor)) {
    return undefined;
  }

  const fallbackModels = await vscode.lm.selectChatModels({ id: model.id });
  return fallbackModels.find((candidate) =>
    isUnifyChatProviderVendor(candidate.vendor),
  );
}

export async function resolveCommitMessageGenerationModel(): Promise<vscode.LanguageModelChat> {
  const configuredModel = readCommitMessageGenerationConfiguration().model;
  const resolvedConfiguredModel = await resolveConfiguredModel(configuredModel);
  if (resolvedConfiguredModel) {
    return resolvedConfiguredModel;
  }

  const selectedModel = await changeCommitMessageModelConfiguration();
  if (!selectedModel) {
    throw new vscode.CancellationError();
  }

  return selectedModel;
}

import * as vscode from 'vscode';
import { pickLanguageModel } from '../language-model-picker';
import {
  inspectCommitMessageModelConfiguration,
  readCommitMessageGenerationConfiguration,
  updateCommitMessageModelConfiguration,
} from './config';
import type { CommitMessageGenerationModelConfiguration } from './types';
import { t } from '../i18n';

interface ConfigurationTargetQuickPickItem extends vscode.QuickPickItem {
  target: vscode.ConfigurationTarget;
}

function formatConfiguredModel(
  model: CommitMessageGenerationModelConfiguration | undefined,
): string {
  if (!model || !model.vendor || !model.id) {
    return t('Not configured');
  }

  return `${model.vendor}/${model.id}`;
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

export async function changeCommitMessageModelConfiguration(): Promise<
  vscode.LanguageModelChat | undefined
> {
  const target = await pickConfigurationTarget();
  if (target === undefined) {
    return undefined;
  }

  const selectedModel = await pickLanguageModel({
    placeHolder: t('Choose a language model for commit message generation'),
  });
  if (!selectedModel) {
    return undefined;
  }
  if (selectedModel.kind === 'default') {
    return undefined;
  }
  const model = selectedModel.model;

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

  return models[0];
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

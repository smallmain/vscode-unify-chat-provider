import * as vscode from 'vscode';
import { t } from './i18n';
import { NoLanguageModelsAvailableError } from './commit-message/types';
import { decodeVsCodeProviderSegment } from './model-id-utils';

const EXTENSION_VENDOR_ID = 'unify-chat-provider';
const MODEL_NAME_COLLATOR = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: 'base',
});

export interface ModelQuickPickItem extends vscode.QuickPickItem {
  model: vscode.LanguageModelChat;
}

export interface DefaultModelQuickPickItem extends vscode.QuickPickItem {
  isDefault: true;
}

export type LanguageModelQuickPickItem =
  | ModelQuickPickItem
  | DefaultModelQuickPickItem;

export type LanguageModelPickResult =
  | { kind: 'model'; model: vscode.LanguageModelChat }
  | { kind: 'default' };

export interface PickLanguageModelOptions {
  placeHolder: string;
  includeDefault?: boolean;
}

function getExtensionProviderName(model: vscode.LanguageModelChat): string {
  if (model.vendor !== EXTENSION_VENDOR_ID) {
    return '';
  }

  const slashIndex = model.id.indexOf('/');
  if (slashIndex === -1) {
    return '';
  }

  const encodedProviderName = model.id.slice(0, slashIndex);
  return decodeVsCodeProviderSegment(encodedProviderName) ?? encodedProviderName;
}

export async function getAvailableLanguageModels(): Promise<
  vscode.LanguageModelChat[]
> {
  const models = await vscode.lm.selectChatModels();
  const dedupedModels = new Map<string, vscode.LanguageModelChat>();

  for (const model of models) {
    dedupedModels.set(`${model.vendor}/${model.id}`, model);
  }

  return [...dedupedModels.values()].sort((left, right) => {
    const vendorComparison = MODEL_NAME_COLLATOR.compare(
      left.vendor,
      right.vendor,
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

function createModelQuickPickItem(
  model: vscode.LanguageModelChat,
): ModelQuickPickItem {
  return {
    label: model.name,
    description: model.vendor,
    detail: model.id,
    model,
  };
}

function createDefaultModelQuickPickItem(): DefaultModelQuickPickItem {
  return {
    label: t('Default'),
    detail: t('Use the VS Code default model.'),
    isDefault: true,
  };
}

function isDefaultModelQuickPickItem(
  item: LanguageModelQuickPickItem,
): item is DefaultModelQuickPickItem {
  return 'isDefault' in item;
}

export async function pickLanguageModel(
  options: PickLanguageModelOptions,
): Promise<LanguageModelPickResult | undefined> {
  const models = await getAvailableLanguageModels();
  if (models.length === 0 && !options.includeDefault) {
    throw new NoLanguageModelsAvailableError();
  }

  const modelItems = models.map(createModelQuickPickItem);
  const items: LanguageModelQuickPickItem[] = options.includeDefault
    ? [createDefaultModelQuickPickItem(), ...modelItems]
    : modelItems;

  const selected = await vscode.window.showQuickPick(items, {
    placeHolder: options.placeHolder,
    matchOnDescription: true,
    matchOnDetail: true,
  });

  if (!selected) {
    return undefined;
  }

  if (isDefaultModelQuickPickItem(selected)) {
    return { kind: 'default' };
  }

  return { kind: 'model', model: selected.model };
}

import * as vscode from 'vscode';
import { ConfigStore } from '../config-store';
import {
  deepClone,
  mergePartialByKeys,
  PROVIDER_CONFIG_KEYS,
} from '../config-ops';
import { showValidationErrors } from './component';
import {
  normalizeProviderDraft,
  validateProviderForm,
  type ProviderFormDraft,
} from './form-utils';
import { ProviderConfig } from '../types';

export async function saveProviderDraft(options: {
  draft: ProviderFormDraft;
  store: ConfigStore;
  existing?: ProviderConfig;
  originalName?: string;
}): Promise<'saved' | 'invalid'> {
  const errors = validateProviderForm(
    options.draft,
    options.store,
    options.originalName,
  );
  if (errors.length > 0) {
    await showValidationErrors(errors);
    return 'invalid';
  }

  const provider = normalizeProviderDraft(options.draft);
  if (options.originalName && provider.name !== options.originalName) {
    await options.store.removeProvider(options.originalName);
  }
  await options.store.upsertProvider(provider);
  vscode.window.showInformationMessage(
    options.existing
      ? `Provider "${provider.name}" updated.`
      : `Provider "${provider.name}" added.`,
  );
  return 'saved';
}

export async function duplicateProvider(
  store: ConfigStore,
  provider: ProviderConfig,
): Promise<void> {
  let baseName = provider.name;
  let newName = `${baseName} (copy)`;
  let counter = 2;

  while (store.getProvider(newName)) {
    newName = `${baseName} (copy ${counter})`;
    counter++;
  }

  const duplicated = deepClone(provider);
  duplicated.name = newName;

  await store.upsertProvider(duplicated);
  vscode.window.showInformationMessage(`Provider duplicated as "${newName}".`);
}

export function buildProviderConfigFromDraft(
  draft: ProviderFormDraft,
): Partial<ProviderConfig> {
  const source: Partial<ProviderConfig> = {
    ...deepClone(draft),
    name: draft.name?.trim() || undefined,
    baseUrl: draft.baseUrl?.trim() || undefined,
    apiKey: draft.apiKey?.trim() || undefined,
    models: draft.models.length > 0 ? deepClone(draft.models) : undefined,
  };

  const config: Partial<ProviderConfig> = {};
  mergePartialByKeys(config, source, PROVIDER_CONFIG_KEYS);
  return config;
}

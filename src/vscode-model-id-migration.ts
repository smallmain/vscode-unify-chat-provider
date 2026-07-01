import * as vscode from 'vscode';
import { ConfigStore } from './config-store';
import {
  createLegacyVsCodeModelId,
  createVsCodeModelId,
} from './model-id-utils';
import type { ProviderConfig } from './types';
import { officialModelsManager } from './official-models-manager';
import { isPlaceholderModelId } from './utils';
import { VSCODE_DEFAULT_MODEL_CONFIGURATIONS } from './vscode-default-model';
import type { CommitMessageGenerationModelConfiguration } from './commit-message/types';

const EXTENSION_VENDOR_ID = 'unify-chat-provider';
const COMMIT_MESSAGE_MODEL_CONFIGURATION_KEY =
  'unifyChatProvider.commitMessageGeneration.model';

interface ModelIdMigrationEntry {
  legacyId: string;
  migratedId: string;
}

interface ModelConfigurationMigrationResult {
  changed: boolean;
  value: CommitMessageGenerationModelConfiguration;
}

function buildLegacyModelIdMap(
  providers: readonly ProviderConfig[],
): Map<string, string> {
  const map = new Map<string, string>();

  for (const provider of providers) {
    const userModelIds = new Set(provider.models.map((model) => model.id));
    const officialModels = provider.autoFetchOfficialModels
      ? (officialModelsManager.getProviderState(provider.name)?.models ?? [])
      : [];
    const models = [
      ...provider.models,
      ...officialModels.filter((model) => !userModelIds.has(model.id)),
    ];

    for (const model of models) {
      if (isPlaceholderModelId(model.id)) {
        continue;
      }

      const legacyId = createLegacyVsCodeModelId(provider.name, model.id);
      const migratedId = createVsCodeModelId(provider.name, model.id);

      if (legacyId !== migratedId) {
        map.set(legacyId, migratedId);
      }
    }
  }

  return map;
}

function splitLanguageModelSettingValue(
  value: string,
): { vendor: string; modelId: string } | undefined {
  const slashIndex = value.indexOf('/');
  if (slashIndex === -1) {
    return undefined;
  }

  return {
    vendor: value.slice(0, slashIndex),
    modelId: value.slice(slashIndex + 1),
  };
}

function migrateLanguageModelSettingValue(
  value: unknown,
  legacyIdMap: ReadonlyMap<string, string>,
): string | undefined {
  if (typeof value !== 'string' || !value.trim()) {
    return undefined;
  }

  const parsed = splitLanguageModelSettingValue(value);
  if (!parsed || parsed.vendor !== EXTENSION_VENDOR_ID) {
    return undefined;
  }

  const migratedId = legacyIdMap.get(parsed.modelId);
  if (!migratedId) {
    return undefined;
  }

  return `${parsed.vendor}/${migratedId}`;
}

async function migrateDefaultModelSetting(
  configurationKey: string,
  legacyIdMap: ReadonlyMap<string, string>,
): Promise<ModelIdMigrationEntry | undefined> {
  const config = vscode.workspace.getConfiguration();
  const inspection = config.inspect<unknown>(configurationKey);
  const globalValue = inspection?.globalValue;
  const migrated = migrateLanguageModelSettingValue(globalValue, legacyIdMap);

  if (!migrated || typeof globalValue !== 'string') {
    return undefined;
  }

  await config.update(
    configurationKey,
    migrated,
    vscode.ConfigurationTarget.Global,
  );

  return {
    legacyId: globalValue,
    migratedId: migrated,
  };
}

async function migrateDefaultModelSettings(
  legacyIdMap: ReadonlyMap<string, string>,
): Promise<number> {
  let count = 0;

  for (const configuration of VSCODE_DEFAULT_MODEL_CONFIGURATIONS) {
    const result = await migrateDefaultModelSetting(
      configuration.configurationKey,
      legacyIdMap,
    );
    if (result) {
      count++;
    }
  }

  return count;
}

function isCommitMessageModelConfiguration(
  value: unknown,
): value is CommitMessageGenerationModelConfiguration {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }

  const record = value as Record<string, unknown>;
  return typeof record['vendor'] === 'string' && typeof record['id'] === 'string';
}

function migrateCommitMessageModelConfigurationValue(
  value: unknown,
  legacyIdMap: ReadonlyMap<string, string>,
): ModelConfigurationMigrationResult | undefined {
  if (!isCommitMessageModelConfiguration(value)) {
    return undefined;
  }

  if (value.vendor !== EXTENSION_VENDOR_ID) {
    return undefined;
  }

  const migratedId = legacyIdMap.get(value.id);
  if (!migratedId) {
    return undefined;
  }

  return {
    changed: true,
    value: {
      vendor: value.vendor,
      id: migratedId,
    },
  };
}

async function migrateCommitMessageModelConfigurationScope(options: {
  value: unknown;
  target: vscode.ConfigurationTarget;
  legacyIdMap: ReadonlyMap<string, string>;
}): Promise<boolean> {
  const migrated = migrateCommitMessageModelConfigurationValue(
    options.value,
    options.legacyIdMap,
  );

  if (!migrated?.changed) {
    return false;
  }

  const config = vscode.workspace.getConfiguration();
  await config.update(
    COMMIT_MESSAGE_MODEL_CONFIGURATION_KEY,
    migrated.value,
    options.target,
  );
  return true;
}

async function migrateCommitMessageModelConfiguration(
  legacyIdMap: ReadonlyMap<string, string>,
): Promise<number> {
  const config = vscode.workspace.getConfiguration();
  const inspection = config.inspect<unknown>(
    COMMIT_MESSAGE_MODEL_CONFIGURATION_KEY,
  );
  let count = 0;

  if (
    await migrateCommitMessageModelConfigurationScope({
      value: inspection?.globalValue,
      target: vscode.ConfigurationTarget.Global,
      legacyIdMap,
    })
  ) {
    count++;
  }

  if (
    await migrateCommitMessageModelConfigurationScope({
      value: inspection?.workspaceValue,
      target: vscode.ConfigurationTarget.Workspace,
      legacyIdMap,
    })
  ) {
    count++;
  }

  return count;
}

export async function migrateLegacyVSCodeModelIds(
  configStore: ConfigStore,
): Promise<number> {
  const legacyIdMap = buildLegacyModelIdMap(configStore.endpoints);
  if (legacyIdMap.size === 0) {
    return 0;
  }

  const defaultModelCount = await migrateDefaultModelSettings(legacyIdMap);
  const commitMessageModelCount = await migrateCommitMessageModelConfiguration(
    legacyIdMap,
  );

  return defaultModelCount + commitMessageModelCount;
}

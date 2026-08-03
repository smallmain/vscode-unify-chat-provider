import { t } from '../i18n';
import type { ModelConfig, ProviderConfig } from '../types';
import { MODEL_CONFIG_KEYS, mergePartialFromRecordByKeys } from '../config-ops';
import { promptForConfigValue, type ConfigValue } from './base64-config';
import {
  isProviderConfigInput,
  parseModelConfigArray,
  parseProviderConfigInput,
  parseProviderConfigArray,
} from './import-config';

export type ProviderImportConfig =
  | { kind: 'single'; config: Partial<ProviderConfig> }
  | { kind: 'multiple'; configs: Partial<ProviderConfig>[] };

export async function promptForProviderImportConfig(options?: {
  title?: string;
  placeholder?: string;
}): Promise<ProviderImportConfig | undefined> {
  const config = await promptForConfigValue({
    title: options?.title ?? t('Import Provider From Config'),
    placeholder:
      options?.placeholder ?? t('Paste configuration JSON or Base64 string...'),
    validate: (value: ConfigValue) => {
      if (Array.isArray(value)) {
        return parseProviderConfigArray(value)
          ? null
          : t('Invalid provider configuration array.');
      }
      return parseProviderConfigInput(value)
        ? null
        : t('Invalid provider configuration.');
    },
  });
  if (!config) return undefined;

  if (Array.isArray(config)) {
    const configs = parseProviderConfigArray(config);
    if (!configs) return undefined;
    return { kind: 'multiple', configs };
  }

  const parsed = parseProviderConfigInput(config);
  return parsed ? { kind: 'single', config: parsed } : undefined;
}

export type ModelImportConfig =
  | { kind: 'single'; config: Partial<ModelConfig> }
  | { kind: 'multiple'; models: ModelConfig[] };

function parseModelConfigRecord(
  value: Record<string, unknown>,
): Partial<ModelConfig> {
  const config: Partial<ModelConfig> = {};
  mergePartialFromRecordByKeys(config, value, MODEL_CONFIG_KEYS);
  return config;
}

export async function promptForModelImportConfig(options?: {
  title?: string;
  placeholder?: string;
}): Promise<ModelImportConfig | undefined> {
  const value = await promptForConfigValue({
    title: options?.title ?? t('Import From Config'),
    placeholder:
      options?.placeholder ?? t('Paste configuration JSON or Base64 string...'),
    validate: (input: ConfigValue) => {
      if (Array.isArray(input)) {
        return parseModelConfigArray(input)
          ? null
          : t('Invalid model configuration array.');
      }
      if (isProviderConfigInput(input)) {
        return t('Provider configuration is not allowed here.');
      }
      return null;
    },
  });

  if (!value) return undefined;

  if (Array.isArray(value)) {
    const models = parseModelConfigArray(value);
    if (!models) return undefined;
    return { kind: 'multiple', models };
  }

  if (isProviderConfigInput(value)) return undefined;
  return { kind: 'single', config: parseModelConfigRecord(value) };
}

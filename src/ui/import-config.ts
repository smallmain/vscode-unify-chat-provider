import type { ModelConfig, ProviderConfig } from '../types';
import { MODEL_CONFIG_KEYS, mergePartialFromRecordByKeys } from '../config-ops';
import { mergePartialProviderConfig } from './base64-config';
import { createProviderDraft, type ProviderFormDraft } from './form-utils';

/**
 * Import compatibility: migrate legacy top-level `apiKey` field to `auth`.
 */
export function normalizeLegacyApiKeyProviderConfig(
  config: Partial<ProviderConfig>,
): Partial<ProviderConfig> {
  if (!Object.prototype.hasOwnProperty.call(config, 'apiKey')) {
    return config;
  }

  const next: Partial<ProviderConfig> = { ...config };

  if (!next.auth && typeof next.apiKey === 'string' && next.apiKey.trim()) {
    next.auth = {
      method: 'api-key',
      apiKey: next.apiKey,
    };
  }

  delete next.apiKey;
  return next;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasProviderIndicators(value: Record<string, unknown>): boolean {
  return (
    'type' in value ||
    'baseUrl' in value ||
    'models' in value ||
    'apiKey' in value ||
    'timeout' in value ||
    'autoFetchOfficialModels' in value
  );
}

export function isProviderConfigInput(
  value: unknown,
): value is Partial<ProviderConfig> {
  return isObjectRecord(value) && hasProviderIndicators(value);
}

export function parseProviderConfigArray(
  value: unknown,
): Partial<ProviderConfig>[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const configs: Partial<ProviderConfig>[] = [];

  for (const item of value) {
    if (!isObjectRecord(item)) return undefined;
    if (!isProviderConfigInput(item)) return undefined;
    configs.push(item);
  }

  return configs;
}

export function parseModelConfigArray(
  value: unknown,
): ModelConfig[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const models: ModelConfig[] = [];

  for (const item of value) {
    if (typeof item === 'string') {
      models.push({ id: item });
      continue;
    }
    if (!isObjectRecord(item)) return undefined;
    if (isProviderConfigInput(item)) return undefined;

    const draft: ModelConfig = { id: '' };
    mergePartialFromRecordByKeys(draft, item, MODEL_CONFIG_KEYS);
    models.push(draft);
  }

  return models;
}

export function buildProviderDraftFromConfig(
  config: Partial<ProviderConfig>,
): ProviderFormDraft {
  const draft = createProviderDraft();
  mergePartialProviderConfig(draft, normalizeLegacyApiKeyProviderConfig(config));
  return draft;
}

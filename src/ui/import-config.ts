import type { ModelConfig, ProviderConfig } from '../types';
import {
  MODEL_CONFIG_KEYS,
  PROVIDER_CONFIG_KEYS,
  mergePartialFromRecordByKeys,
} from '../config-ops';
import { mergePartialProviderConfig } from './base64-config';
import { createProviderDraft, type ProviderFormDraft } from './form-utils';
import { getRenamedProviderType } from '../secret/migration';
import { parseAuthTransferConfig } from '../auth/auth-transfer-parser';

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

/**
 * Import compatibility: rename legacy provider types.
 */
export function normalizeLegacyProviderTypeProviderConfig(
  config: Partial<ProviderConfig>,
): Partial<ProviderConfig> {
  const rawType: unknown = Reflect.get(config, 'type');
  if (typeof rawType !== 'string') {
    return config;
  }

  const renamed = getRenamedProviderType(rawType);
  if (!renamed) {
    return config;
  }

  return { ...config, type: renamed };
}

export function normalizeLegacyProviderConfig(
  config: Partial<ProviderConfig>,
): Partial<ProviderConfig> {
  return normalizeLegacyApiKeyProviderConfig(
    normalizeLegacyProviderTypeProviderConfig(config),
  );
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasProviderIndicators(value: Record<string, unknown>): boolean {
  return (
    'type' in value ||
    'baseUrl' in value ||
    'models' in value ||
    'auth' in value ||
    'apiKey' in value ||
    'balanceProvider' in value ||
    'timeout' in value ||
    'autoFetchOfficialModels' in value
  );
}

export function isProviderConfigInput(
  value: unknown,
): value is Partial<ProviderConfig> {
  return parseProviderConfigInput(value) !== undefined;
}

export function parseProviderConfigInput(
  value: unknown,
): Partial<ProviderConfig> | undefined {
  if (!isObjectRecord(value) || !hasProviderIndicators(value)) {
    return undefined;
  }

  const config: Partial<ProviderConfig> = {};
  mergePartialFromRecordByKeys(config, value, PROVIDER_CONFIG_KEYS);

  const hasAuth = Object.prototype.hasOwnProperty.call(value, 'auth');
  const hasLegacyApiKey = Object.prototype.hasOwnProperty.call(value, 'apiKey');
  const legacyApiKey = value['apiKey'];
  if (!hasAuth && hasLegacyApiKey && typeof legacyApiKey !== 'string') {
    return undefined;
  }
  const authValue = hasAuth
    ? value['auth']
    : typeof legacyApiKey === 'string' && legacyApiKey.trim() !== ''
      ? { method: 'api-key', apiKey: legacyApiKey }
      : undefined;
  if (authValue !== undefined) {
    const auth = parseAuthTransferConfig(authValue);
    if (!auth) return undefined;
    config.auth = auth;
  } else {
    delete config.auth;
  }

  return normalizeLegacyProviderTypeProviderConfig(config);
}

export function parseProviderConfigArray(
  value: unknown,
): Partial<ProviderConfig>[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const configs: Partial<ProviderConfig>[] = [];

  for (const item of value) {
    const config = parseProviderConfigInput(item);
    if (!config) return undefined;
    configs.push(config);
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
  mergePartialProviderConfig(draft, config);
  return draft;
}

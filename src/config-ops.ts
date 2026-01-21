import { ModelConfig, ProviderConfig, type ProviderConfigPersistedKey } from './types';

export const MODEL_CONFIG_KEYS = [
  'id',
  'type',
  'name',
  'family',
  'maxInputTokens',
  'maxOutputTokens',
  'capabilities',
  'stream',
  'temperature',
  'topK',
  'topP',
  'frequencyPenalty',
  'presencePenalty',
  'parallelToolCalling',
  'verbosity',
  'thinking',
  'webSearch',
  'memoryTool',
  'extraHeaders',
  'extraBody',
] as const satisfies ReadonlyArray<keyof ModelConfig>;

export const PROVIDER_CONFIG_KEYS = [
  'type',
  'name',
  'baseUrl',
  'auth',
  'models',
  'extraHeaders',
  'extraBody',
  'timeout',
  'autoFetchOfficialModels',
] as const satisfies ReadonlyArray<ProviderConfigPersistedKey>;

type AssertNever<T extends never> = T;

export type _AssertModelConfigKeysComplete = AssertNever<
  Exclude<keyof ModelConfig, (typeof MODEL_CONFIG_KEYS)[number]>
>;

export type _AssertProviderConfigKeysComplete = AssertNever<
  Exclude<ProviderConfigPersistedKey, (typeof PROVIDER_CONFIG_KEYS)[number]>
>;

export function deepClone<T>(value: T): T {
  return structuredClone(value);
}

function sortForStableJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortForStableJson);
  }

  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      const normalized = sortForStableJson(record[key]);
      if (normalized !== undefined) {
        out[key] = normalized;
      }
    }
    return out;
  }

  return value;
}

export function stableStringify(value: unknown): string {
  const json = JSON.stringify(sortForStableJson(value));
  return json ?? 'undefined';
}

export function mergePartialByKeys<T extends object, K extends keyof T>(
  draft: Partial<T>,
  source: Partial<T>,
  keys: readonly K[],
): void {
  for (const key of keys) {
    const value = source[key];
    if (value !== undefined) {
      draft[key] = deepClone(value);
    }
  }
}

export function withoutKey<K extends string, Omit extends K>(
  keys: readonly K[],
  omit: Omit,
): Array<Exclude<K, Omit>> {
  return keys.filter((k): k is Exclude<K, Omit> => k !== omit);
}

export function withoutKeys<K extends string, Omit extends K>(
  keys: readonly K[],
  omit: readonly Omit[],
): Array<Exclude<K, Omit>> {
  const omitSet = new Set<string>(omit);
  return keys.filter((k): k is Exclude<K, Omit> => !omitSet.has(k));
}

export function mergePartialFromRecordByKeys<
  T extends object,
  K extends keyof T & string,
>(
  draft: Partial<T>,
  source: Record<string, unknown>,
  keys: readonly K[],
): void {
  for (const key of keys) {
    const value = source[key];
    if (value !== undefined) {
      draft[key] = deepClone(value as T[K]);
    }
  }
}

export function toComparableModelConfig(model: ModelConfig): ModelConfig {
  const cloned = deepClone(model);
  cloned.id = cloned.id.trim();
  cloned.name = cloned.name?.trim() ?? '';
  cloned.family = cloned.family?.trim() ?? '';

  const capabilities = cloned.capabilities ?? {};
  cloned.capabilities = {
    ...capabilities,
    toolCalling: capabilities.toolCalling ?? false,
    imageInput: capabilities.imageInput ?? false,
  };

  return cloned;
}

export function toComparableProviderConfig(
  provider: ProviderConfig,
): ProviderConfig {
  const cloned = deepClone(provider);
  cloned.name = cloned.name.trim();
  cloned.baseUrl = cloned.baseUrl.trim();
  cloned.models = cloned.models.map(toComparableModelConfig);
  return cloned;
}

export function modelConfigEquals(a: ModelConfig, b: ModelConfig): boolean {
  return (
    stableStringify(toComparableModelConfig(a)) ===
    stableStringify(toComparableModelConfig(b))
  );
}

export function providerConfigEquals(
  a: ProviderConfig,
  b: ProviderConfig,
): boolean {
  return (
    stableStringify(toComparableProviderConfig(a)) ===
    stableStringify(toComparableProviderConfig(b))
  );
}

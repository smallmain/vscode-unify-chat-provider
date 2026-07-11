import * as vscode from 'vscode';
import type {
  ModelConfig,
  PresetTemplate,
  PresetTemplateOverrideConfig,
  PresetTemplateOverrideKey,
  PresetTemplatePreset,
  ServiceTier,
} from './types';

export const PRESET_TEMPLATE_OVERRIDE_KEYS = [
  'maxOutputTokens',
  'stream',
  'temperature',
  'topK',
  'topP',
  'frequencyPenalty',
  'presencePenalty',
  'parallelToolCalling',
  'serviceTier',
  'verbosity',
  'thinking',
  'webSearch',
  'memoryTool',
  'extraHeaders',
  'extraBody',
] as const satisfies ReadonlyArray<PresetTemplateOverrideKey>;

export function normalizePresetTemplates(
  raw: unknown,
): PresetTemplate[] | undefined {
  if (!Array.isArray(raw)) {
    return undefined;
  }

  const templates: PresetTemplate[] = [];
  const seenTemplateIds = new Set<string>();

  for (const item of raw) {
    const template = normalizePresetTemplate(item, seenTemplateIds);
    if (template) {
      templates.push(template);
    }
  }

  return templates.length > 0 ? templates : undefined;
}

export function buildPresetTemplateConfigurationSchema(
  model: ModelConfig,
): vscode.LanguageModelConfigurationSchema | undefined {
  const templates = model.presetTemplates;
  if (!templates || templates.length === 0) {
    return undefined;
  }

  const properties: Record<string, Record<string, unknown>> = {};

  for (const template of templates) {
    const enumValues = template.presets.map((preset) => preset.id);
    const enumItemLabels = template.presets.map((preset) => preset.name);
    const enumDescriptions = template.presets.map(
      (preset) => preset.description ?? '',
    );

    properties[template.id] = {
      type: 'string',
      title: template.name,
      enum: enumValues,
      enumItemLabels,
      ...(enumDescriptions.some((description) => description !== '')
        ? { enumDescriptions }
        : {}),
      default: resolvePresetTemplateConfigurationDefault(model, template),
      group: 'navigation',
    };
  }

  return { properties };
}

export function applyPresetTemplateSelections(
  model: ModelConfig,
  modelConfiguration: { readonly [key: string]: unknown } | undefined,
): ModelConfig {
  const templates = model.presetTemplates;
  if (!templates || templates.length === 0) {
    return model;
  }

  const resolved = structuredClone(model);

  for (const template of templates) {
    const selectedPreset = resolveSelectedPreset(template, modelConfiguration);
    if (!selectedPreset) {
      continue;
    }

    for (const key of PRESET_TEMPLATE_OVERRIDE_KEYS) {
      if (key === 'thinking') {
        const thinkingOverride = selectedPreset.config.thinking;
        if (thinkingOverride !== undefined) {
          applyThinkingPresetOverride(resolved, thinkingOverride);
        }
        continue;
      }

      const value = selectedPreset.config[key];
      if (value !== undefined) {
        assignPresetOverrideValue(resolved, key, value);
      }
    }
  }

  return resolved;
}

function normalizePresetTemplate(
  raw: unknown,
  seenTemplateIds: Set<string>,
): PresetTemplate | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }

  const id = normalizeNonEmptyString(raw['id']);
  const name = normalizeNonEmptyString(raw['name']);
  if (!id || !name || seenTemplateIds.has(id)) {
    return undefined;
  }

  const presetsRaw = raw['presets'];
  if (!Array.isArray(presetsRaw)) {
    return undefined;
  }

  const presets: PresetTemplatePreset[] = [];
  const seenPresetIds = new Set<string>();
  for (const presetRaw of presetsRaw) {
    const preset = normalizePresetTemplatePreset(presetRaw, seenPresetIds);
    if (preset) {
      presets.push(preset);
    }
  }

  if (presets.length === 0) {
    return undefined;
  }

  const defaultPresetId = normalizeNonEmptyString(raw['default']);
  const resolvedDefault =
    defaultPresetId &&
    presets.some((preset) => preset.id === defaultPresetId)
      ? defaultPresetId
      : presets[0].id;

  seenTemplateIds.add(id);
  return {
    id,
    name,
    presets,
    default: resolvedDefault,
  };
}

function normalizePresetTemplatePreset(
  raw: unknown,
  seenPresetIds: Set<string>,
): PresetTemplatePreset | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }

  const id = normalizeNonEmptyString(raw['id']);
  const name = normalizeNonEmptyString(raw['name']);
  if (!id || !name || seenPresetIds.has(id)) {
    return undefined;
  }

  const config = normalizePresetTemplateOverrideConfig(raw['config']);
  if (!config) {
    return undefined;
  }

  seenPresetIds.add(id);
  return {
    id,
    name,
    description: normalizeOptionalString(raw['description']),
    config,
  };
}

function normalizePresetTemplateOverrideConfig(
  raw: unknown,
): PresetTemplateOverrideConfig | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }

  const config: PresetTemplateOverrideConfig = {};

  for (const key of PRESET_TEMPLATE_OVERRIDE_KEYS) {
    const value = raw[key];
    if (value !== undefined) {
      assignPresetOverrideConfigValue(config, key, value);
    }
  }

  config.serviceTier = normalizeServiceTier(config.serviceTier);
  config.extraHeaders = normalizeStringRecord(config.extraHeaders);
  config.extraBody = normalizeObjectRecord(config.extraBody);

  return config;
}

function resolveSelectedPreset(
  template: PresetTemplate,
  modelConfiguration: { readonly [key: string]: unknown } | undefined,
): PresetTemplatePreset | undefined {
  const configuredId = modelConfiguration?.[template.id];
  if (typeof configuredId === 'string') {
    return template.presets.find((item) => item.id === configuredId);
  }

  return undefined;
}

function resolvePresetTemplateConfigurationDefault(
  model: ModelConfig,
  template: PresetTemplate,
): string {
  const matchingConfiguredPreset = template.presets.find(
    (preset) =>
      !isPresetTemplateOverrideConfigEmpty(preset.config) &&
      presetOverrideConfigMatchesModel(model, preset.config),
  );
  if (matchingConfiguredPreset) {
    return matchingConfiguredPreset.id;
  }

  const noOpPreset = template.presets.find((preset) =>
    isPresetTemplateOverrideConfigEmpty(preset.config),
  );
  return noOpPreset?.id ?? template.default;
}

function isPresetTemplateOverrideConfigEmpty(
  config: PresetTemplateOverrideConfig,
): boolean {
  return PRESET_TEMPLATE_OVERRIDE_KEYS.every((key) => config[key] === undefined);
}

function presetOverrideConfigMatchesModel(
  model: ModelConfig,
  config: PresetTemplateOverrideConfig,
): boolean {
  for (const key of PRESET_TEMPLATE_OVERRIDE_KEYS) {
    const value = config[key];
    if (value === undefined) {
      continue;
    }

    const matches =
      key === 'thinking'
        ? presetValueIsSubset(model.thinking, value)
        : deepEqualPresetValue(model[key], value);
    if (!matches) {
      return false;
    }
  }

  return true;
}

function deepEqualPresetValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) {
    return true;
  }

  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
      return false;
    }

    return a.every((item, index) => deepEqualPresetValue(item, b[index]));
  }

  if (isRecord(a) || isRecord(b)) {
    if (!isRecord(a) || !isRecord(b)) {
      return false;
    }

    const aKeys = Object.keys(a).filter((key) => a[key] !== undefined);
    const bKeys = Object.keys(b).filter((key) => b[key] !== undefined);
    if (aKeys.length !== bKeys.length) {
      return false;
    }

    return aKeys.every((key) =>
      Object.prototype.hasOwnProperty.call(b, key)
        ? deepEqualPresetValue(a[key], b[key])
        : false,
    );
  }

  return false;
}

function presetValueIsSubset(actual: unknown, expected: unknown): boolean {
  if (!isRecord(expected)) {
    return deepEqualPresetValue(actual, expected);
  }
  if (!isRecord(actual)) {
    return false;
  }

  return Object.keys(expected)
    .filter((key) => expected[key] !== undefined)
    .every(
      (key) =>
        Object.prototype.hasOwnProperty.call(actual, key) &&
        presetValueIsSubset(actual[key], expected[key]),
    );
}

function applyThinkingPresetOverride(
  model: ModelConfig,
  override: NonNullable<PresetTemplateOverrideConfig['thinking']>,
): void {
  const cloned = structuredClone(override);
  if (cloned.type !== undefined) {
    model.thinking = {
      ...model.thinking,
      ...cloned,
      type: cloned.type,
    };
    return;
  }

  if (model.thinking !== undefined) {
    model.thinking = {
      ...model.thinking,
      ...cloned,
      type: model.thinking.type,
    };
  }
}

function assignPresetOverrideValue<
  K extends Exclude<PresetTemplateOverrideKey, 'thinking'>,
>(
  model: ModelConfig,
  key: K,
  value: PresetTemplateOverrideConfig[K],
): void {
  model[key] = structuredClone(value) as ModelConfig[K];
}

function assignPresetOverrideConfigValue<K extends PresetTemplateOverrideKey>(
  config: PresetTemplateOverrideConfig,
  key: K,
  value: unknown,
): void {
  config[key] = structuredClone(value) as PresetTemplateOverrideConfig[K];
}

function normalizeServiceTier(raw: unknown): ServiceTier | undefined {
  switch (raw) {
    case 'auto':
    case 'standard':
    case 'flex':
    case 'scale':
    case 'priority':
      return raw;
    default:
      return undefined;
  }
}

function normalizeStringRecord(
  raw: unknown,
): Record<string, string> | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }

  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value !== 'string') {
      return undefined;
    }
    out[key] = value;
  }

  return out;
}

function normalizeObjectRecord(
  raw: unknown,
): Record<string, unknown> | undefined {
  return isRecord(raw) ? raw : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function normalizeNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== ''
    ? value.trim()
    : undefined;
}

function normalizeOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== ''
    ? value.trim()
    : undefined;
}

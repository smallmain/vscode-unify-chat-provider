import * as vscode from 'vscode';
import { ConfigStore } from '../config-store';
import {
  deepClone,
  modelConfigEquals,
  stableStringify,
  toComparableModelConfig,
} from '../config-ops';
import { normalizeBaseUrlInput } from '../utils';
import { showValidationErrors } from './component';
import { PROVIDER_TYPES } from '../client/definitions';
import { ProviderConfig, ModelConfig } from '../types';

/**
 * Draft type for provider form editing.
 */
export type ProviderFormDraft = Omit<Partial<ProviderConfig>, 'models'> & {
  models: ModelConfig[];
  /** Internal: Session ID for official models draft state (not persisted) */
  _officialModelsSessionId?: string;
};

/**
 * Clone a provider config for editing.
 */
export function createProviderDraft(
  existing?: ProviderConfig,
): ProviderFormDraft {
  return existing ? deepClone(existing) : { models: [] };
}

/**
 * Deep clone an array of model configs.
 */
export function cloneModels(models: ModelConfig[]): ModelConfig[] {
  return deepClone(models);
}

/**
 * Create a model draft for editing.
 */
export function createModelDraft(existing?: ModelConfig): ModelConfig {
  if (!existing) {
    return { id: '' };
  }
  return { ...existing };
}

/**
 * Remove a model from a list by ID.
 */
export function removeModel(models: ModelConfig[], id: string): void {
  const idx = models.findIndex((m) => m.id === id);
  if (idx !== -1) models.splice(idx, 1);
}

/**
 * Normalize a provider draft to a valid ProviderConfig.
 */
export function normalizeProviderDraft(
  draft: ProviderFormDraft,
): ProviderConfig {
  return {
    ...deepClone(draft),
    type: draft.type!,
    name: draft.name!.trim(),
    baseUrl: normalizeBaseUrlInput(draft.baseUrl!),
    apiKey: draft.apiKey?.trim() || undefined,
  };
}

/**
 * Normalize a model draft.
 */
export function normalizeModelDraft(draft: ModelConfig): ModelConfig {
  const normalized = deepClone(draft);
  normalized.id = normalized.id.trim();
  normalized.name = normalized.name?.trim() || undefined;
  normalized.family = normalized.family?.trim() || undefined;
  return normalized;
}

/**
 * Check if thinking configs are equal.
 */
export function thinkingEqual(
  a?: ModelConfig['thinking'],
  b?: ModelConfig['thinking'],
): boolean {
  return stableStringify(a) === stableStringify(b);
}

function toComparableProviderDraft(draft: ProviderFormDraft): unknown {
  const { _officialModelsSessionId: _, ...rest } = deepClone(draft);
  return {
    ...rest,
    name: rest.name?.trim() ?? '',
    baseUrl: rest.baseUrl?.trim() ?? '',
    apiKey: rest.apiKey?.trim() ?? '',
    models: rest.models.map(toComparableModelConfig),
  };
}

/**
 * Check if a provider draft has changes from the original.
 */
export function hasProviderChanges(
  draft: ProviderFormDraft,
  original?: ProviderFormDraft,
): boolean {
  const baseline: ProviderFormDraft = { models: [] };
  return original
    ? stableStringify(toComparableProviderDraft(draft)) !==
        stableStringify(toComparableProviderDraft(original))
    : stableStringify(toComparableProviderDraft(draft)) !==
        stableStringify(toComparableProviderDraft(baseline));
}

/**
 * Check if a model draft has changes from the original.
 */
export function hasModelChanges(
  draft: ModelConfig,
  original?: ModelConfig,
): boolean {
  const baseline: ModelConfig = { id: '' };
  return original
    ? !modelConfigEquals(draft, original)
    : !modelConfigEquals(draft, baseline);
}

/**
 * Check if two model arrays have changed.
 */
export function modelsChanged(
  next: ModelConfig[],
  original: ModelConfig[],
): boolean {
  if (next.length !== original.length) return true;
  return next.some((model, idx) => !modelsEqual(model, original[idx]));
}

/**
 * Check if two model configs are equal.
 */
export function modelsEqual(a: ModelConfig, b: ModelConfig): boolean {
  return modelConfigEquals(a, b);
}

/**
 * Confirm discarding provider changes.
 */
export async function confirmDiscardProviderChanges(
  draft: ProviderFormDraft,
  original?: ProviderFormDraft,
): Promise<'discard' | 'save' | 'stay'> {
  if (!hasProviderChanges(draft, original)) return 'discard';
  const choice = await vscode.window.showWarningMessage(
    'Discard unsaved provider changes?',
    { modal: true },
    'Discard',
    'Save',
  );
  if (choice === 'Discard') return 'discard';
  if (choice === 'Save') return 'save';
  return 'stay';
}

/**
 * Confirm discarding model changes.
 */
export async function confirmDiscardModelChanges(
  draft: ModelConfig,
  models: ModelConfig[],
  original?: ModelConfig,
  originalId?: string,
): Promise<'discard' | 'save' | 'stay'> {
  if (!hasModelChanges(draft, original)) return 'discard';
  const choice = await vscode.window.showWarningMessage(
    'Discard unsaved model changes?',
    { modal: true },
    'Discard',
    'Save',
  );
  if (choice === 'Discard') return 'discard';
  if (choice === 'Save') {
    const err = validateModelIdUnique(draft.id, models, originalId);
    if (err) {
      await showValidationErrors([err]);
      return 'stay';
    }
    return 'save';
  }
  return 'stay';
}

/**
 * Format a model for display in lists.
 */
export function formatModelDetail(model: ModelConfig): string | undefined {
  const parts: string[] = [];
  if (model.maxInputTokens) {
    parts.push(`Input: ${model.maxInputTokens.toLocaleString()}`);
  }
  if (model.maxOutputTokens) {
    parts.push(`Output: ${model.maxOutputTokens.toLocaleString()}`);
  }
  if (model.capabilities?.toolCalling) {
    if (typeof model.capabilities.toolCalling === 'number') {
      parts.push(`Tool (max ${model.capabilities.toolCalling})`);
    } else {
      parts.push('Tool');
    }
  }
  if (model.capabilities?.imageInput) {
    parts.push('Image');
  }
  return parts.length > 0 ? parts.join(' | ') : undefined;
}

/**
 * Validate a base URL.
 */
export function validateBaseUrl(url: string): string | null {
  if (!url.trim()) return 'API base URL is required';
  try {
    normalizeBaseUrlInput(url);
    return null;
  } catch {
    return 'Please enter a valid base URL';
  }
}

/**
 * Validate a positive integer or empty string.
 */
export function validatePositiveIntegerOrEmpty(s: string): string | null {
  if (!s) return null;
  const n = Number(s);
  if (Number.isNaN(n) || n <= 0) return 'Please enter a positive number';
  return null;
}

/**
 * Validate provider name uniqueness.
 */
export function validateProviderNameUnique(
  name: string,
  store: ConfigStore,
  originalName?: string,
): string | null {
  const trimmed = name.trim();
  if (!trimmed) return 'Provider name is required';
  if (originalName && trimmed === originalName) return null;
  if (store.getProvider(trimmed))
    return 'A provider with this name already exists';
  return null;
}

/**
 * Validate model ID uniqueness.
 */
export function validateModelIdUnique(
  id: string,
  models: ModelConfig[],
  originalId?: string,
): string | null {
  const trimmed = id.trim();
  if (!trimmed) return 'Model ID is required';
  if (originalId && trimmed === originalId) return null;
  if (models.some((m) => m.id === trimmed))
    return 'A model with this ID already exists';
  return null;
}

/**
 * Options for validating the provider form.
 */
export interface ValidateProviderFormOptions {
  /** Skip the name uniqueness check (for conflict resolution) */
  skipNameUniquenessCheck?: boolean;
}

/**
 * Validate the provider form.
 */
export function validateProviderForm(
  data: ProviderFormDraft,
  store: ConfigStore,
  originalName?: string,
  options?: ValidateProviderFormOptions,
): string[] {
  const errors: string[] = [];
  if (!data.type) errors.push('API Format is required');

  if (options?.skipNameUniquenessCheck) {
    if (!data.name?.trim()) {
      errors.push('Provider name is required');
    }
  } else {
    const nameErr = data.name
      ? validateProviderNameUnique(data.name, store, originalName)
      : 'Provider name is required';
    if (nameErr) errors.push(nameErr);
  }

  const urlErr = data.baseUrl
    ? validateBaseUrl(data.baseUrl)
    : 'API base URL is required';
  if (urlErr) errors.push(urlErr);

  if (data.mimic !== undefined) {
    if (!data.type) {
      errors.push('Select an API Format before choosing a mimic option');
    } else {
      const supported = PROVIDER_TYPES[data.type].supportMimics;
      if (!supported.includes(data.mimic)) {
        errors.push(
          'The selected mimic is not supported by this provider type',
        );
      }
    }
  }
  return errors;
}

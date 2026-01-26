import * as vscode from 'vscode';
import { t } from '../i18n';
import { ConfigStore } from '../config-store';
import {
  deepClone,
  modelConfigEquals,
  stableStringify,
  toComparableModelConfig,
} from '../config-ops';
import { normalizeBaseUrlInput } from '../utils';
import { showValidationErrors } from './component';
import {
  ProviderConfig,
  ModelConfig,
  type DeprecatedProviderConfigKey,
} from '../types';

/**
 * Draft type for provider form editing.
 */
export type ProviderFormDraft = Omit<
  Partial<ProviderConfig>,
  'models' | DeprecatedProviderConfigKey
> & {
  models: ModelConfig[];
  /** Internal: Session ID for draft-only state (official models, oauth2 token, etc.) (not persisted) */
  _draftSessionId?: string;
};

type AssertNever<T extends never> = T;

export type _AssertProviderDraftDoesNotExposeDeprecatedKeys = AssertNever<
  Extract<DeprecatedProviderConfigKey, keyof ProviderFormDraft>
>;

/**
 * Clone a provider config for editing.
 */
export function createProviderDraft(
  existing?: ProviderConfig,
): ProviderFormDraft {
  return existing ? deepClone(existing) : { models: [] };
}

function generateDraftSessionId(): string {
  return `draft-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}

/** Ensure draft has a stable session ID (used as key for all draft-only state). */
export function ensureDraftSessionId(draft: ProviderFormDraft): string {
  if (draft._draftSessionId) return draft._draftSessionId;
  const id = generateDraftSessionId();
  draft._draftSessionId = id;
  return id;
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
    return { id: '', capabilities: { toolCalling: true } };
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
  const cloned = deepClone(draft);
  const { _draftSessionId: _, ...rest } = cloned;
  return {
    ...rest,
    type: draft.type!,
    name: draft.name!.trim(),
    baseUrl: normalizeBaseUrlInput(draft.baseUrl!),
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
  const { _draftSessionId: _, ...rest } = deepClone(draft);
  return {
    ...rest,
    name: rest.name?.trim() ?? '',
    baseUrl: rest.baseUrl?.trim() ?? '',
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
  const discardButton = t('Discard');
  const saveButton = t('Save');
  const choice = await vscode.window.showWarningMessage(
    t('Discard unsaved provider changes?'),
    { modal: true },
    discardButton,
    saveButton,
  );
  if (choice === discardButton) return 'discard';
  if (choice === saveButton) return 'save';
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
  const discardButton = t('Discard');
  const saveButton = t('Save');
  const choice = await vscode.window.showWarningMessage(
    t('Discard unsaved model changes?'),
    { modal: true },
    discardButton,
    saveButton,
  );
  if (choice === discardButton) return 'discard';
  if (choice === saveButton) {
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
  parts.push(model.id);
  if (model.maxInputTokens) {
    parts.push(t('Input: {0}', model.maxInputTokens.toLocaleString()));
  }
  if (model.maxOutputTokens) {
    parts.push(t('Output: {0}', model.maxOutputTokens.toLocaleString()));
  }
  if (model.capabilities?.toolCalling) {
    if (typeof model.capabilities.toolCalling === 'number') {
      parts.push(t('Tool (max {0})', model.capabilities.toolCalling));
    } else {
      parts.push(t('Tool'));
    }
  }
  if (model.capabilities?.imageInput) {
    parts.push(t('Image'));
  }
  return parts.length > 0 ? parts.join(' | ') : undefined;
}

/**
 * Validate a base URL.
 */
export function validateBaseUrl(url: string): string | null {
  if (!url.trim()) return t('API base URL is required');
  try {
    normalizeBaseUrlInput(url);
    return null;
  } catch {
    return t('Please enter a valid base URL');
  }
}

/**
 * Validate a positive integer or empty string.
 */
export function validatePositiveIntegerOrEmpty(s: string): string | null {
  if (!s) return null;
  const n = Number(s);
  if (Number.isNaN(n) || n <= 0) return t('Please enter a positive number');
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
  if (!trimmed) return t('Provider name is required');
  if (originalName && trimmed === originalName) return null;
  if (store.getProvider(trimmed))
    return t('A provider with this name already exists');
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
  if (!trimmed) return t('Model ID is required');
  if (originalId && trimmed === originalId) return null;
  if (models.some((m) => m.id === trimmed))
    return t('A model with this ID already exists');
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
  if (!data.type) errors.push(t('API Format is required'));

  if (options?.skipNameUniquenessCheck) {
    if (!data.name?.trim()) {
      errors.push(t('Provider name is required'));
    }
  } else {
    const nameErr = data.name
      ? validateProviderNameUnique(data.name, store, originalName)
      : t('Provider name is required');
    if (nameErr) errors.push(nameErr);
  }

  const urlErr = data.baseUrl
    ? validateBaseUrl(data.baseUrl)
    : t('API base URL is required');
  if (urlErr) errors.push(urlErr);

  return errors;
}

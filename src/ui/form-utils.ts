import * as vscode from 'vscode';
import { PROVIDERS } from '../client';
import type { ModelConfig, ProviderConfig } from '../client/interface';
import { ConfigStore } from '../config-store';
import { normalizeBaseUrlInput } from '../utils';
import { showValidationErrors } from './component';

/**
 * Draft type for provider form editing.
 */
export type ProviderFormDraft = {
  type?: ProviderConfig['type'];
  name?: string;
  baseUrl?: string;
  apiKey?: string;
  mimic?: ProviderConfig['mimic'];
  models: ModelConfig[];
  extraHeaders?: Record<string, string>;
  extraBody?: Record<string, unknown>;
};

/**
 * Clone a provider config for editing.
 */
export function createProviderDraft(
  existing?: ProviderConfig,
): ProviderFormDraft {
  if (!existing) {
    return { models: [] };
  }
  return {
    ...existing,
    models: cloneModels(existing.models),
    extraHeaders: existing.extraHeaders
      ? { ...existing.extraHeaders }
      : undefined,
    extraBody: existing.extraBody ? { ...existing.extraBody } : undefined,
  };
}

/**
 * Deep clone an array of model configs.
 */
export function cloneModels(models: ModelConfig[]): ModelConfig[] {
  return models.map((m) => ({
    id: m.id,
    name: m.name,
    family: m.family,
    maxInputTokens: m.maxInputTokens,
    maxOutputTokens: m.maxOutputTokens,
    capabilities: m.capabilities ? { ...m.capabilities } : undefined,
    stream: m.stream,
    temperature: m.temperature,
    topK: m.topK,
    topP: m.topP,
    verbosity: m.verbosity,
    parallelToolCalling: m.parallelToolCalling,
    frequencyPenalty: m.frequencyPenalty,
    presencePenalty: m.presencePenalty,
    thinking: m.thinking ? { ...m.thinking } : undefined,
    interleavedThinking: m.interleavedThinking,
    webSearch: m.webSearch ? { ...m.webSearch } : undefined,
    memoryTool: m.memoryTool,
    extraHeaders: m.extraHeaders ? { ...m.extraHeaders } : undefined,
    extraBody: m.extraBody ? { ...m.extraBody } : undefined,
  }));
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
    type: draft.type!,
    name: draft.name!.trim(),
    baseUrl: normalizeBaseUrlInput(draft.baseUrl!),
    apiKey: draft.apiKey?.trim() || undefined,
    mimic: draft.mimic,
    models: cloneModels(draft.models),
    extraHeaders: draft.extraHeaders,
    extraBody: draft.extraBody,
  };
}

/**
 * Normalize a model draft.
 */
export function normalizeModelDraft(draft: ModelConfig): ModelConfig {
  return {
    id: draft.id.trim(),
    name: draft.name?.trim() || undefined,
    family: draft.family?.trim() || undefined,
    maxInputTokens: draft.maxInputTokens,
    maxOutputTokens: draft.maxOutputTokens,
    capabilities: draft.capabilities ? { ...draft.capabilities } : undefined,
    stream: draft.stream,
    temperature: draft.temperature,
    topK: draft.topK,
    topP: draft.topP,
    verbosity: draft.verbosity,
    parallelToolCalling: draft.parallelToolCalling,
    frequencyPenalty: draft.frequencyPenalty,
    presencePenalty: draft.presencePenalty,
    thinking: draft.thinking ? { ...draft.thinking } : undefined,
    interleavedThinking: draft.interleavedThinking,
    webSearch: draft.webSearch ? { ...draft.webSearch } : undefined,
    memoryTool: draft.memoryTool,
    extraHeaders: draft.extraHeaders ? { ...draft.extraHeaders } : undefined,
    extraBody: draft.extraBody ? { ...draft.extraBody } : undefined,
  };
}

/**
 * Check if thinking configs are equal.
 */
export function thinkingEqual(
  a?: ModelConfig['thinking'],
  b?: ModelConfig['thinking'],
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.type === b.type &&
    a.budgetTokens === b.budgetTokens &&
    a.effort === b.effort
  );
}

/**
 * Check if a provider draft has changes from the original.
 */
export function hasProviderChanges(
  draft: ProviderFormDraft,
  original?: ProviderConfig,
): boolean {
  const trimmedName = draft.name?.trim();
  const trimmedBaseUrl = draft.baseUrl?.trim();
  const trimmedApiKey = draft.apiKey?.trim();

  if (!original) {
    return (
      !!draft.type ||
      !!trimmedName ||
      !!trimmedBaseUrl ||
      !!trimmedApiKey ||
      !!draft.mimic ||
      draft.models.length > 0
    );
  }

  if (draft.type !== original.type) return true;
  if ((trimmedName ?? '') !== original.name) return true;
  if ((trimmedBaseUrl ?? '') !== original.baseUrl) return true;
  if ((trimmedApiKey ?? '') !== (original.apiKey ?? '')) return true;
  if (draft.mimic !== original.mimic) return true;
  if (
    JSON.stringify(draft.extraHeaders) !== JSON.stringify(original.extraHeaders)
  )
    return true;
  if (JSON.stringify(draft.extraBody) !== JSON.stringify(original.extraBody))
    return true;
  return modelsChanged(draft.models, original.models);
}

/**
 * Check if a model draft has changes from the original.
 */
export function hasModelChanges(
  draft: ModelConfig,
  original?: ModelConfig,
): boolean {
  const trimmedId = draft.id.trim();
  const trimmedName = draft.name?.trim() ?? '';
  const inputTokens = draft.maxInputTokens ?? null;
  const outputTokens = draft.maxOutputTokens ?? null;
  const toolCalling = draft.capabilities?.toolCalling ?? false;
  const imageInput = draft.capabilities?.imageInput ?? false;

  const stream = draft.stream;
  const temperature = draft.temperature;
  const topK = draft.topK;
  const topP = draft.topP;
  const verbosity = draft.verbosity;
  const parallelToolCalling = draft.parallelToolCalling;
  const frequencyPenalty = draft.frequencyPenalty;
  const presencePenalty = draft.presencePenalty;
  const thinking = draft.thinking;
  const interleavedThinking = draft.interleavedThinking;
  const webSearch = draft.webSearch;
  const memoryTool = draft.memoryTool;
  const extraHeaders = draft.extraHeaders;
  const extraBody = draft.extraBody;

  if (!original) {
    return (
      !!trimmedId ||
      !!trimmedName ||
      inputTokens !== null ||
      outputTokens !== null ||
      !!toolCalling ||
      imageInput ||
      stream !== undefined ||
      temperature !== undefined ||
      topK !== undefined ||
      topP !== undefined ||
      verbosity !== undefined ||
      parallelToolCalling !== undefined ||
      frequencyPenalty !== undefined ||
      presencePenalty !== undefined ||
      thinking !== undefined ||
      interleavedThinking !== undefined ||
      webSearch !== undefined ||
      memoryTool !== undefined ||
      extraHeaders !== undefined ||
      extraBody !== undefined
    );
  }

  return (
    trimmedId !== original.id ||
    trimmedName !== (original.name ?? '') ||
    inputTokens !== (original.maxInputTokens ?? null) ||
    outputTokens !== (original.maxOutputTokens ?? null) ||
    toolCalling !== (original.capabilities?.toolCalling ?? false) ||
    imageInput !== (original.capabilities?.imageInput ?? false) ||
    stream !== original.stream ||
    temperature !== original.temperature ||
    topK !== original.topK ||
    topP !== original.topP ||
    verbosity !== original.verbosity ||
    parallelToolCalling !== original.parallelToolCalling ||
    frequencyPenalty !== original.frequencyPenalty ||
    presencePenalty !== original.presencePenalty ||
    !thinkingEqual(thinking, original.thinking) ||
    interleavedThinking !== original.interleavedThinking ||
    JSON.stringify(webSearch) !== JSON.stringify(original.webSearch) ||
    memoryTool !== original.memoryTool ||
    JSON.stringify(extraHeaders) !== JSON.stringify(original.extraHeaders) ||
    JSON.stringify(extraBody) !== JSON.stringify(original.extraBody)
  );
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
  return (
    a.id === b.id &&
    (a.name ?? '') === (b.name ?? '') &&
    (a.maxInputTokens ?? null) === (b.maxInputTokens ?? null) &&
    (a.maxOutputTokens ?? null) === (b.maxOutputTokens ?? null) &&
    (a.capabilities?.toolCalling ?? false) ===
      (b.capabilities?.toolCalling ?? false) &&
    (a.capabilities?.imageInput ?? false) ===
      (b.capabilities?.imageInput ?? false) &&
    a.stream === b.stream &&
    a.temperature === b.temperature &&
    a.topK === b.topK &&
    a.topP === b.topP &&
    a.verbosity === b.verbosity &&
    a.parallelToolCalling === b.parallelToolCalling &&
    a.frequencyPenalty === b.frequencyPenalty &&
    a.presencePenalty === b.presencePenalty &&
    thinkingEqual(a.thinking, b.thinking) &&
    a.interleavedThinking === b.interleavedThinking &&
    JSON.stringify(a.webSearch) === JSON.stringify(b.webSearch) &&
    a.memoryTool === b.memoryTool &&
    JSON.stringify(a.extraHeaders) === JSON.stringify(b.extraHeaders) &&
    JSON.stringify(a.extraBody) === JSON.stringify(b.extraBody)
  );
}

/**
 * Confirm discarding provider changes.
 */
export async function confirmDiscardProviderChanges(
  draft: ProviderFormDraft,
  original?: ProviderConfig,
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
 * Validate the provider form.
 */
export function validateProviderForm(
  data: ProviderFormDraft,
  store: ConfigStore,
  originalName?: string,
): string[] {
  const errors: string[] = [];
  if (!data.type) errors.push('API Format is required');

  const nameErr = data.name
    ? validateProviderNameUnique(data.name, store, originalName)
    : 'Provider name is required';
  if (nameErr) errors.push(nameErr);

  const urlErr = data.baseUrl
    ? validateBaseUrl(data.baseUrl)
    : 'API base URL is required';
  if (urlErr) errors.push(urlErr);

  if (data.mimic !== undefined) {
    if (!data.type) {
      errors.push('Select an API Format before choosing a mimic option');
    } else {
      const supported = PROVIDERS[data.type].supportMimics;
      if (!supported.includes(data.mimic)) {
        errors.push(
          'The selected mimic is not supported by this provider type',
        );
      }
    }
  }
  return errors;
}

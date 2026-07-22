import { t } from '../../i18n';
import { isRecord } from '../configuration';
import type { CompletionModelReference } from '../types';

export const DEFAULT_ZED_MAX_TOKENS = 64;
export const DEFAULT_MISTRAL_MAX_TOKENS = 150;

export interface ZedAlgorithmOptions {
  readonly model: CompletionModelReference;
  readonly maxTokens: number;
}

export interface InceptionAlgorithmOptions {
  readonly model: CompletionModelReference;
}

export interface MistralAlgorithmOptions {
  readonly model: CompletionModelReference;
  readonly maxTokens: number;
}

export type EditAlgorithmOptionsResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: string };

function normalizeModelReference(
  raw: unknown,
): CompletionModelReference | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }
  const vendor = typeof raw.vendor === 'string' ? raw.vendor.trim() : '';
  const id = typeof raw.id === 'string' ? raw.id.trim() : '';
  return vendor && id ? { vendor, id } : undefined;
}

function positiveInteger(raw: unknown, fallback: number): number | undefined {
  if (raw === undefined) {
    return fallback;
  }
  return Number.isSafeInteger(raw) && typeof raw === 'number' && raw > 0
    ? raw
    : undefined;
}

export function normalizeZedAlgorithmOptions(
  raw: unknown,
): EditAlgorithmOptionsResult<ZedAlgorithmOptions> {
  if (!isRecord(raw)) {
    return { ok: false, error: t('Zed options must be an object.') };
  }
  const model = normalizeModelReference(raw.model);
  if (!model) {
    return {
      ok: false,
      error: t('Zed options require model.vendor and model.id.'),
    };
  }
  const maxTokens = positiveInteger(raw.maxTokens, DEFAULT_ZED_MAX_TOKENS);
  return maxTokens === undefined
    ? { ok: false, error: t('Zed maxTokens must be a positive integer.') }
    : { ok: true, value: { model, maxTokens } };
}

export function normalizeInceptionAlgorithmOptions(
  raw: unknown,
): EditAlgorithmOptionsResult<InceptionAlgorithmOptions> {
  if (!isRecord(raw)) {
    return { ok: false, error: t('Inception options must be an object.') };
  }
  const model = normalizeModelReference(raw.model);
  return model
    ? { ok: true, value: { model } }
    : {
        ok: false,
        error: t('Inception options require model.vendor and model.id.'),
      };
}

export function normalizeMistralAlgorithmOptions(
  raw: unknown,
): EditAlgorithmOptionsResult<MistralAlgorithmOptions> {
  if (!isRecord(raw)) {
    return { ok: false, error: t('Mistral options must be an object.') };
  }
  const model = normalizeModelReference(raw.model);
  if (!model) {
    return {
      ok: false,
      error: t('Mistral options require model.vendor and model.id.'),
    };
  }
  const maxTokens = positiveInteger(
    raw.maxTokens,
    DEFAULT_MISTRAL_MAX_TOKENS,
  );
  return maxTokens === undefined
    ? { ok: false, error: t('Mistral maxTokens must be a positive integer.') }
    : { ok: true, value: { model, maxTokens } };
}

import { isRecord } from '../configuration';
import type { CompletionModelReference } from '../types';
import { t } from '../../i18n';

export interface SimpleAlgorithmOptions {
  model: CompletionModelReference;
}

export type SimpleAlgorithmOptionsResult =
  | { ok: true; value: SimpleAlgorithmOptions }
  | { ok: false; error: string };

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

export function normalizeSimpleAlgorithmOptions(
  raw: unknown,
): SimpleAlgorithmOptionsResult {
  if (!isRecord(raw)) {
    return { ok: false, error: t('Simple options must be an object.') };
  }
  const model = normalizeModelReference(raw.model);
  return model
    ? { ok: true, value: { model } }
    : {
        ok: false,
        error: t('Simple options require model.vendor and model.id.'),
      };
}

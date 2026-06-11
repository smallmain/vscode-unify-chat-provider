import { PROVIDER_TYPES } from '../client/definitions';
import type { UsageRecord } from './types';

export function isUsageRecord(value: unknown): value is UsageRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }

  const record = value as Partial<UsageRecord>;
  return (
    typeof record.id === 'string' &&
    typeof record.timestamp === 'number' &&
    Number.isFinite(record.timestamp) &&
    typeof record.providerName === 'string' &&
    typeof record.providerType === 'string' &&
    Object.prototype.hasOwnProperty.call(PROVIDER_TYPES, record.providerType) &&
    typeof record.vscodeModelId === 'string' &&
    typeof record.modelId === 'string' &&
    (record.outcome === 'success' ||
      record.outcome === 'error' ||
      record.outcome === 'cancelled')
  );
}

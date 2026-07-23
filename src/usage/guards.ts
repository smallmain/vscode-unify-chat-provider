import { PROVIDER_TYPES } from '../client/definitions';
import type { UsageRecord, UsageStoreState, UsageTotals } from './types';

const USAGE_TOTAL_KEYS = [
  'requests',
  'successes',
  'errors',
  'cancelled',
  'promptTokens',
  'completionTokens',
  'totalTokens',
  'cachedInputTokens',
  'cacheCreationInputTokens',
  'cacheReadInputTokens',
  'uncachedInputTokens',
  'usageRecords',
  'missingUsageRecords',
  'totalLatencyMs',
  'latencyRecords',
] satisfies readonly (keyof UsageTotals)[];

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

export function isUsageTotals(value: unknown): value is UsageTotals {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }

  const totals = value as Partial<UsageTotals>;
  return USAGE_TOTAL_KEYS.every((key) => {
    const field = totals[key];
    return typeof field === 'number' && Number.isFinite(field) && field >= 0;
  });
}

export function isUsageStoreState(value: unknown): value is UsageStoreState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }

  const state = value as Partial<UsageStoreState>;
  return isUsageTotals(state.archivedTotals) &&
    Array.isArray(state.records) &&
    state.records.every(isUsageRecord);
}

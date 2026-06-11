import type { ProviderType } from '../client/definitions';

export interface NormalizedUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cachedInputTokens?: number;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
  uncachedInputTokens?: number;
}

export type UsageRequestOutcome = 'success' | 'error' | 'cancelled';

export interface UsageRecord {
  id: string;
  timestamp: number;
  providerName: string;
  providerType: ProviderType;
  vscodeModelId: string;
  modelId: string;
  modelName?: string;
  outcome: UsageRequestOutcome;
  latencyMs?: number;
  usage?: NormalizedUsage;
}

export interface PersistedUsageState {
  version: number;
  records: UsageRecord[];
}

export interface UsageTimeRange {
  id: string;
  label: string;
  since?: number;
  until?: number;
}

export interface UsageTotals {
  requests: number;
  successes: number;
  errors: number;
  cancelled: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cachedInputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  uncachedInputTokens: number;
  usageRecords: number;
  missingUsageRecords: number;
  totalLatencyMs: number;
  latencyRecords: number;
}

export interface UsageSummaryItem extends UsageTotals {
  key: string;
  label: string;
  detail?: string;
}

export interface UsageDayItem extends UsageTotals {
  dateKey: string;
  timestamp: number;
}

export type UsageTrendGranularity = 'hour' | 'day';

export interface UsageTrendItem extends UsageTotals {
  key: string;
  label: string;
  timestamp: number;
}

export interface UsageTrend {
  granularity: UsageTrendGranularity;
  items: UsageTrendItem[];
}

export interface UsageSnapshot {
  range: UsageTimeRange;
  totals: UsageTotals;
  byProvider: UsageSummaryItem[];
  byModel: UsageSummaryItem[];
  byDay: UsageDayItem[];
  trend: UsageTrend;
  recent: UsageRecord[];
}

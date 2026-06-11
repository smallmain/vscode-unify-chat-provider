import type { UsageTotals } from './types';

export function formatInteger(value: number): string {
  return Math.round(value).toLocaleString();
}

export function formatTokens(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1_000_000) {
    return `${(value / 1_000_000).toLocaleString(undefined, {
      minimumFractionDigits: 0,
      maximumFractionDigits: 2,
    })}M`;
  }
  if (abs >= 1_000) {
    return `${(value / 1_000).toLocaleString(undefined, {
      minimumFractionDigits: 0,
      maximumFractionDigits: 2,
    })}K`;
  }
  return formatInteger(value);
}

export function formatPercent(value: number): string {
  if (!Number.isFinite(value)) {
    return 'N/A';
  }
  return `${Math.max(0, Math.min(100, value)).toLocaleString(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: 1,
  })}%`;
}

export function formatCacheHitRate(totals: UsageTotals): string {
  const denominator = totals.cachedInputTokens + totals.uncachedInputTokens;
  if (denominator <= 0) {
    return 'N/A';
  }
  return formatPercent((totals.cachedInputTokens / denominator) * 100);
}

export function formatAverageLatency(totals: UsageTotals): string {
  if (totals.latencyRecords <= 0) {
    return 'N/A';
  }
  return `${formatInteger(totals.totalLatencyMs / totals.latencyRecords)}ms`;
}

export function formatDateTime(timestamp: number): string {
  return new Date(timestamp).toLocaleString();
}

export function formatDate(timestamp: number): string {
  return new Date(timestamp).toLocaleDateString();
}

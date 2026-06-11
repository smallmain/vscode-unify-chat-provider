import type {
  UsageDayItem,
  UsageRecord,
  UsageSnapshot,
  UsageSummaryItem,
  UsageTimeRange,
  UsageTotals,
  UsageTrend,
  UsageTrendItem,
} from './types';

const EMPTY_TOTALS: UsageTotals = {
  requests: 0,
  successes: 0,
  errors: 0,
  cancelled: 0,
  promptTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
  cachedInputTokens: 0,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0,
  uncachedInputTokens: 0,
  usageRecords: 0,
  missingUsageRecords: 0,
  totalLatencyMs: 0,
  latencyRecords: 0,
};

function createTotals(): UsageTotals {
  return { ...EMPTY_TOTALS };
}

function addRecordToTotals(totals: UsageTotals, record: UsageRecord): void {
  totals.requests++;

  switch (record.outcome) {
    case 'success':
      totals.successes++;
      break;
    case 'error':
      totals.errors++;
      break;
    case 'cancelled':
      totals.cancelled++;
      break;
    default:
      break;
  }

  if (typeof record.latencyMs === 'number' && Number.isFinite(record.latencyMs)) {
    totals.totalLatencyMs += Math.max(record.latencyMs, 0);
    totals.latencyRecords++;
  }

  const usage = record.usage;
  if (!usage) {
    totals.missingUsageRecords++;
    return;
  }

  totals.usageRecords++;
  totals.promptTokens += usage.promptTokens;
  totals.completionTokens += usage.completionTokens;
  totals.totalTokens += usage.totalTokens;
  totals.cachedInputTokens += usage.cachedInputTokens ?? 0;
  totals.cacheCreationInputTokens += usage.cacheCreationInputTokens ?? 0;
  totals.cacheReadInputTokens += usage.cacheReadInputTokens ?? 0;
  totals.uncachedInputTokens += usage.uncachedInputTokens ?? 0;
}

function sortSummaryItems(items: UsageSummaryItem[]): UsageSummaryItem[] {
  return items.sort((a, b) => {
    if (b.totalTokens !== a.totalTokens) {
      return b.totalTokens - a.totalTokens;
    }
    if (b.requests !== a.requests) {
      return b.requests - a.requests;
    }
    return a.label.localeCompare(b.label);
  });
}

function toDateKey(timestamp: number): string {
  const date = new Date(timestamp);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function toHourKey(timestamp: number): string {
  const date = new Date(timestamp);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hour = String(date.getHours()).padStart(2, '0');
  return `${year}-${month}-${day}T${hour}`;
}

function formatHourLabel(timestamp: number): string {
  const date = new Date(timestamp);
  return `${String(date.getHours()).padStart(2, '0')}:00`;
}

function startOfLocalDay(timestamp: number): number {
  const date = new Date(timestamp);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

function startOfLocalHour(timestamp: number): number {
  const date = new Date(timestamp);
  date.setMinutes(0, 0, 0);
  return date.getTime();
}

function filterRecordsByRange(
  records: readonly UsageRecord[],
  range: UsageTimeRange,
): UsageRecord[] {
  const filtered = records.filter((record) => {
    if (range.since !== undefined && record.timestamp < range.since) {
      return false;
    }
    if (range.until !== undefined && record.timestamp > range.until) {
      return false;
    }
    return true;
  });

  return filtered.sort((a, b) => b.timestamp - a.timestamp);
}

function createHourlyTrend(filtered: readonly UsageRecord[], since?: number): UsageTrend {
  const start = since ?? startOfLocalDay(Date.now());
  const startHour = startOfLocalHour(start);
  const trendMap = new Map<string, UsageTrendItem>();

  for (let hour = 0; hour < 24; hour++) {
    const timestamp = startHour + hour * 60 * 60 * 1000;
    const key = toHourKey(timestamp);
    trendMap.set(key, {
      ...createTotals(),
      key,
      label: formatHourLabel(timestamp),
      timestamp,
    });
  }

  for (const record of filtered) {
    const key = toHourKey(record.timestamp);
    const bucket = trendMap.get(key);
    if (bucket) {
      addRecordToTotals(bucket, record);
    }
  }

  return {
    granularity: 'hour',
    items: [...trendMap.values()].sort((a, b) => a.timestamp - b.timestamp),
  };
}

function createDailyTrend(days: readonly UsageDayItem[]): UsageTrend {
  return {
    granularity: 'day',
    items: days.map((day) => ({
      ...day,
      key: day.dateKey,
      label: day.dateKey.slice(5),
    })),
  };
}

function isSingleLocalDayRange(range: UsageTimeRange): boolean {
  if (range.since === undefined || range.until === undefined) {
    return false;
  }
  return startOfLocalDay(range.since) === startOfLocalDay(range.until);
}

export function createUsageSnapshot(
  records: readonly UsageRecord[],
  range: UsageTimeRange,
  recentLimit: number,
): UsageSnapshot {
  const filtered = filterRecordsByRange(records, range);
  const totals = createTotals();
  const providerMap = new Map<string, UsageSummaryItem>();
  const modelMap = new Map<string, UsageSummaryItem>();
  const dayMap = new Map<string, UsageDayItem>();

  for (const record of filtered) {
    addRecordToTotals(totals, record);

    let provider = providerMap.get(record.providerName);
    if (!provider) {
      provider = {
        ...createTotals(),
        key: record.providerName,
        label: record.providerName,
        detail: record.providerType,
      };
      providerMap.set(record.providerName, provider);
    }
    addRecordToTotals(provider, record);

    const modelKey = `${record.providerName}/${record.modelId}`;
    let model = modelMap.get(modelKey);
    if (!model) {
      model = {
        ...createTotals(),
        key: modelKey,
        label: record.modelName ?? record.modelId,
        detail: record.providerName,
      };
      modelMap.set(modelKey, model);
    }
    addRecordToTotals(model, record);

    const dateKey = toDateKey(record.timestamp);
    let day = dayMap.get(dateKey);
    if (!day) {
      day = {
        ...createTotals(),
        dateKey,
        timestamp: startOfLocalDay(record.timestamp),
      };
      dayMap.set(dateKey, day);
    }
    addRecordToTotals(day, record);
  }

  const byDay = [...dayMap.values()].sort((a, b) => a.timestamp - b.timestamp);
  const trend = range.id === 'today' || isSingleLocalDayRange(range)
    ? createHourlyTrend(filtered, range.since)
    : createDailyTrend(byDay);

  return {
    range,
    totals,
    byProvider: sortSummaryItems([...providerMap.values()]),
    byModel: sortSummaryItems([...modelMap.values()]),
    byDay,
    trend,
    recent: filtered.slice(0, recentLimit),
  };
}

export function createUsageRange(id: string, label: string, days?: number): UsageTimeRange {
  return {
    id,
    label,
    since: days === undefined ? undefined : Date.now() - days * 24 * 60 * 60 * 1000,
  };
}

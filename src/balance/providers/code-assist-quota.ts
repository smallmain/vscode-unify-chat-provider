import { t } from '../../i18n';
import { createSimpleHttpLogger } from '../../logger';
import { getToken } from '../../client/utils';
import { fetchWithRetry, normalizeBaseUrlInput } from '../../utils';
import type {
  BalanceMetric,
  BalanceRefreshInput,
  BalanceRefreshResult,
} from '../types';

export interface CodeAssistQuotaRefreshOptions {
  providerName: string;
  endpointFallbacks: readonly string[];
  requestHeaders?: Readonly<Record<string, string>>;
  resolveProjectId: (input: BalanceRefreshInput) => string | undefined;
}

type ParsedResetAt = {
  value: string;
  timestampMs?: number;
};

type ParsedBucketMetric = {
  label: string;
  scope?: string;
  usedPercent: number;
  resetAt?: ParsedResetAt;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function pickString(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}

function pickNumberLike(
  record: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = record[key];
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(100, value));
}

function parseErrorMessage(text: string): string | undefined {
  const normalized = text.trim();
  if (!normalized) {
    return undefined;
  }

  try {
    const parsed: unknown = JSON.parse(normalized);
    if (!isRecord(parsed)) {
      return normalized;
    }

    const direct = pickString(parsed, 'message')?.trim();
    if (direct) {
      return direct;
    }

    const error = parsed['error'];
    if (isRecord(error)) {
      const message = pickString(error, 'message')?.trim();
      if (message) {
        return message;
      }
    }
  } catch {
    return normalized;
  }

  return normalized;
}

function maybeNormalizeBaseUrl(raw: string): string | undefined {
  try {
    return normalizeBaseUrlInput(raw);
  } catch {
    return undefined;
  }
}

function resolveQuotaEndpoints(
  rawBaseUrl: string,
  fallbackBases: readonly string[],
): string[] {
  const seen = new Set<string>();
  const endpoints: string[] = [];

  const candidates = [rawBaseUrl, ...fallbackBases];
  for (const candidate of candidates) {
    const normalized = maybeNormalizeBaseUrl(candidate);
    if (!normalized || seen.has(normalized)) {
      continue;
    }

    seen.add(normalized);
    endpoints.push(
      new URL('/v1internal:retrieveUserQuota', `${normalized}/`).toString(),
    );
  }

  return endpoints;
}

function normalizeResetAt(value: unknown): ParsedResetAt | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const millis = value > 1e12 ? Math.trunc(value) : Math.trunc(value * 1000);
    return {
      value: new Date(millis).toISOString(),
      timestampMs: millis,
    };
  }

  if (typeof value !== 'string') {
    return undefined;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }

  const numeric = Number(trimmed);
  if (Number.isFinite(numeric)) {
    const millis =
      numeric > 1e12 ? Math.trunc(numeric) : Math.trunc(numeric * 1000);
    return {
      value: new Date(millis).toISOString(),
      timestampMs: millis,
    };
  }

  const parsedDate = new Date(trimmed);
  const timestampMs = parsedDate.getTime();
  if (Number.isFinite(timestampMs)) {
    return {
      value: parsedDate.toISOString(),
      timestampMs,
    };
  }

  return { value: trimmed };
}

function findBuckets(
  value: unknown,
  depth = 0,
): Record<string, unknown>[] {
  if (depth > 4 || !isRecord(value)) {
    return [];
  }

  const directBuckets = value['buckets'];
  if (Array.isArray(directBuckets)) {
    return directBuckets.filter((item) => isRecord(item));
  }

  const nestedKeys = ['quota', 'userQuota', 'data', 'result', 'payload'];
  for (const key of nestedKeys) {
    const nested = value[key];
    const buckets = findBuckets(nested, depth + 1);
    if (buckets.length > 0) {
      return buckets;
    }
  }

  return [];
}

function parseBucketMetrics(payload: unknown): ParsedBucketMetric[] {
  const buckets = findBuckets(payload);
  if (buckets.length === 0) {
    return [];
  }

  const metrics: ParsedBucketMetric[] = [];
  for (let index = 0; index < buckets.length; index++) {
    const bucket = buckets[index];
    const remainingFraction = pickNumberLike(bucket, 'remainingFraction');
    if (remainingFraction === undefined) {
      continue;
    }

    const usedPercent = clampPercent((1 - remainingFraction) * 100);

    const modelId = pickString(bucket, 'modelId')?.trim();
    const tokenType = pickString(bucket, 'tokenType')?.trim();
    const quotaId = pickString(bucket, 'quotaId')?.trim();

    const label =
      modelId || quotaId || tokenType || `Quota Bucket ${index + 1}`;

    const scope = tokenType || quotaId;
    const resetAt = normalizeResetAt(
      bucket['resetTime'] ?? bucket['resetAt'] ?? bucket['reset_at'],
    );

    metrics.push({
      label,
      scope,
      usedPercent,
      resetAt,
    });
  }

  return metrics;
}

function buildSnapshotItems(metrics: ParsedBucketMetric[]): BalanceMetric[] {
  const items: BalanceMetric[] = [];

  let primaryMetricIndex = -1;
  let highestUsedPercent = Number.NEGATIVE_INFINITY;

  for (let index = 0; index < metrics.length; index++) {
    const metric = metrics[index];
    const metricIdPrefix = `quota-bucket-${index + 1}`;

    const percentMetricIndex = items.length;
    items.push({
      id: `${metricIdPrefix}-used-percent`,
      type: 'percent',
      period: 'current',
      label: metric.label,
      ...(metric.scope ? { scope: metric.scope } : {}),
      value: metric.usedPercent,
      basis: 'used',
    });

    if (metric.usedPercent > highestUsedPercent) {
      highestUsedPercent = metric.usedPercent;
      primaryMetricIndex = percentMetricIndex;
    }

    if (metric.resetAt) {
      items.push({
        id: `${metricIdPrefix}-reset-at`,
        type: 'time',
        period: 'current',
        kind: 'resetAt',
        label: metric.label,
        ...(metric.scope ? { scope: metric.scope } : {}),
        value: metric.resetAt.value,
        ...(typeof metric.resetAt.timestampMs === 'number'
          ? { timestampMs: metric.resetAt.timestampMs }
          : {}),
      });
    }
  }

  if (primaryMetricIndex >= 0) {
    const primaryMetric = items[primaryMetricIndex];
    if (primaryMetric?.type === 'percent') {
      primaryMetric.primary = true;
    }
  }

  return items;
}

export async function refreshCodeAssistQuota(
  input: BalanceRefreshInput,
  options: CodeAssistQuotaRefreshOptions,
): Promise<BalanceRefreshResult> {
  const token = getToken(input.credential);
  if (!token) {
    return {
      success: false,
      error: t('{0} access token is required to query usage.', options.providerName),
    };
  }

  const projectId = options.resolveProjectId(input)?.trim();
  if (!projectId) {
    return {
      success: false,
      error: t('{0} project ID is required to query usage quota.', options.providerName),
    };
  }

  const endpoints = resolveQuotaEndpoints(
    input.provider.baseUrl,
    options.endpointFallbacks,
  );
  if (endpoints.length === 0) {
    return {
      success: false,
      error: t('Failed to query {0} usage.', options.providerName),
    };
  }

  const logger = createSimpleHttpLogger({
    purpose: 'Balance refresh',
    providerName: input.provider.name,
    providerType: input.provider.type,
  });

  const endpointErrors: string[] = [];
  let missingPercentError: string | undefined;

  for (const endpoint of endpoints) {
    try {
      const response = await fetchWithRetry(endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
          'Content-Type': 'application/json',
          ...options.requestHeaders,
        },
        body: JSON.stringify({ project: projectId }),
        logger,
      });

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        const reason =
          parseErrorMessage(text) ||
          t('HTTP {0}', `${response.status}`);
        endpointErrors.push(`${endpoint}: ${reason}`);
        continue;
      }

      const payload: unknown = await response.json().catch(() => undefined);
      const bucketMetrics = parseBucketMetrics(payload);
      if (bucketMetrics.length === 0) {
        missingPercentError = t(
          '{0} usage response from {1} does not include quota percentages.',
          options.providerName,
          endpoint,
        );
        continue;
      }

      return {
        success: true,
        snapshot: {
          updatedAt: Date.now(),
          items: buildSnapshotItems(bucketMetrics),
        },
      };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      endpointErrors.push(`${endpoint}: ${reason}`);
    }
  }

  if (missingPercentError) {
    return {
      success: false,
      error: missingPercentError,
    };
  }

  if (endpointErrors.length > 0) {
    return {
      success: false,
      error: t(
        'Failed to query {0} usage from all endpoints: {1}.',
        options.providerName,
        endpointErrors.join(' | '),
      ),
    };
  }

  return {
    success: false,
    error: t('Failed to query {0} usage.', options.providerName),
  };
}

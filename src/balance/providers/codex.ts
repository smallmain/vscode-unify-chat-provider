import { t } from '../../i18n';
import { createSimpleHttpLogger } from '../../logger';
import { getToken } from '../../client/utils';
import { fetchWithRetry, normalizeBaseUrlInput } from '../../utils';
import type { SecretStore } from '../../secret';
import type {
  BalanceMetric,
  BalanceConfig,
  BalanceRefreshInput,
  BalanceRefreshResult,
} from '../types';
import { isCodexBalanceConfig } from '../types';
import type {
  BalanceConfigureResult,
  BalanceProvider,
  BalanceProviderContext,
  BalanceProviderDefinition,
} from '../balance-provider';

type ParsedResetAt = {
  value: string;
  timestampMs?: number;
};

type ParsedRateLimitWindow = {
  usedPercent: number;
  resetAt?: ParsedResetAt;
};

type ParsedLimitMetric = {
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

function normalizePath(pathname: string): string {
  const collapsed = pathname.replace(/\/{2,}/g, '/').replace(/\/+$/, '');
  return collapsed === '/' ? '' : collapsed;
}

function joinPath(prefix: string, suffix: string): string {
  const combined = `${prefix}/${suffix}`.replace(/\/{2,}/g, '/');
  return combined.startsWith('/') ? combined : `/${combined}`;
}

function derivePathPrefix(pathname: string): string {
  const normalized = normalizePath(pathname);
  if (!normalized) {
    return '';
  }

  const lower = normalized.toLowerCase();
  const knownSegments = [
    '/backend-api/wham/usage',
    '/backend-api/codex/responses',
    '/backend-api/codex',
    '/backend-api',
    '/api/codex/usage',
    '/api/codex',
    '/api',
    '/v1/responses',
    '/v1',
  ];

  for (const segment of knownSegments) {
    const index = lower.indexOf(segment);
    if (index < 0) {
      continue;
    }
    return index === 0 ? '' : normalized.slice(0, index);
  }

  return normalized;
}

function buildCodexUsageEndpoints(rawBaseUrl: string): string[] {
  const baseUrl = normalizeBaseUrlInput(rawBaseUrl);
  const parsed = new URL(`${baseUrl}/`);

  const prefixes = new Set<string>([
    derivePathPrefix(parsed.pathname),
    '',
  ]);

  const endpoints: string[] = [];
  for (const prefix of prefixes) {
    const whamUrl = new URL(parsed.origin);
    whamUrl.pathname = joinPath(prefix, 'backend-api/wham/usage');
    whamUrl.search = '';
    whamUrl.hash = '';
    endpoints.push(whamUrl.toString());

    const codexApiUrl = new URL(parsed.origin);
    codexApiUrl.pathname = joinPath(prefix, 'api/codex/usage');
    codexApiUrl.search = '';
    codexApiUrl.hash = '';
    endpoints.push(codexApiUrl.toString());
  }

  return Array.from(new Set(endpoints));
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

  const date = new Date(trimmed);
  const timestampMs = date.getTime();
  if (Number.isFinite(timestampMs)) {
    return {
      value: date.toISOString(),
      timestampMs,
    };
  }

  return { value: trimmed };
}

function parseRateLimitWindow(
  rateLimit: Record<string, unknown>,
  key: 'primary_window' | 'secondary_window',
): ParsedRateLimitWindow | undefined {
  const rawWindow = rateLimit[key];
  if (!isRecord(rawWindow)) {
    return undefined;
  }

  const usedPercent = pickNumberLike(rawWindow, 'used_percent');
  if (usedPercent === undefined) {
    return undefined;
  }

  return {
    usedPercent: clampPercent(usedPercent),
    resetAt: normalizeResetAt(rawWindow['reset_at']),
  };
}

function pickTighterWindow(
  left: ParsedRateLimitWindow | undefined,
  right: ParsedRateLimitWindow | undefined,
): ParsedRateLimitWindow | undefined {
  if (!left) {
    return right;
  }
  if (!right) {
    return left;
  }
  return right.usedPercent > left.usedPercent ? right : left;
}

function parseRateLimitMetric(
  rateLimit: Record<string, unknown>,
  label: string,
  scope?: string,
): ParsedLimitMetric | undefined {
  const chosenWindow = pickTighterWindow(
    parseRateLimitWindow(rateLimit, 'primary_window'),
    parseRateLimitWindow(rateLimit, 'secondary_window'),
  );

  if (!chosenWindow) {
    return undefined;
  }

  return {
    label,
    scope,
    usedPercent: chosenWindow.usedPercent,
    resetAt: chosenWindow.resetAt,
  };
}

function hasUsageQuotaShape(record: Record<string, unknown>): boolean {
  return (
    isRecord(record['rate_limit']) ||
    Array.isArray(record['additional_rate_limits'])
  );
}

function resolveUsagePayload(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  if (hasUsageQuotaShape(value)) {
    return value;
  }

  const nestedCandidates = ['data', 'usage', 'result', 'payload'];
  for (const key of nestedCandidates) {
    const nested = value[key];
    if (isRecord(nested) && hasUsageQuotaShape(nested)) {
      return nested;
    }
  }

  return value;
}

function parseUsageMetrics(payload: unknown): ParsedLimitMetric[] {
  const body = resolveUsagePayload(payload);
  if (!body) {
    return [];
  }

  const metrics: ParsedLimitMetric[] = [];

  const primaryRateLimit = body['rate_limit'];
  if (isRecord(primaryRateLimit)) {
    const metric = parseRateLimitMetric(
      primaryRateLimit,
      'Primary rate limit',
      'primary',
    );
    if (metric) {
      metrics.push(metric);
    }
  }

  const rawAdditionalRateLimits = body['additional_rate_limits'];
  if (Array.isArray(rawAdditionalRateLimits)) {
    for (let index = 0; index < rawAdditionalRateLimits.length; index++) {
      const item = rawAdditionalRateLimits[index];
      if (!isRecord(item)) {
        continue;
      }

      const rateLimit = item['rate_limit'];
      if (!isRecord(rateLimit)) {
        continue;
      }

      const name =
        pickString(item, 'name')?.trim() ||
        pickString(item, 'label')?.trim() ||
        pickString(item, 'scope')?.trim() ||
        pickString(item, 'id')?.trim();

      const label = name || `Additional rate limit ${index + 1}`;
      const metric = parseRateLimitMetric(rateLimit, label, name);
      if (metric) {
        metrics.push(metric);
      }
    }
  }

  return metrics;
}

function buildSnapshotItems(metrics: ParsedLimitMetric[]): BalanceMetric[] {
  const items: BalanceMetric[] = [];

  let primaryMetricIndex = -1;
  let highestUsedPercent = Number.NEGATIVE_INFINITY;

  for (let index = 0; index < metrics.length; index++) {
    const metric = metrics[index];
    const metricIdPrefix = `rate-limit-${index + 1}`;

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

function resolveAccountId(input: BalanceRefreshInput): string | undefined {
  const auth = input.provider.auth;
  if (auth?.method !== 'openai-codex') {
    return undefined;
  }

  const accountId = auth.accountId?.trim();
  return accountId || undefined;
}

export class CodexBalanceProvider implements BalanceProvider {
  static supportsSensitiveDataInSettings(_config: BalanceConfig): boolean {
    return false;
  }

  static redactForExport(config: BalanceConfig): BalanceConfig {
    return isCodexBalanceConfig(config) ? config : { method: 'codex' };
  }

  static async resolveForExport(
    config: BalanceConfig,
    _secretStore: SecretStore,
  ): Promise<BalanceConfig> {
    return CodexBalanceProvider.redactForExport(config);
  }

  static async normalizeOnImport(
    config: BalanceConfig,
    _options: {
      secretStore: SecretStore;
      storeSecretsInSettings: boolean;
      existing?: BalanceConfig;
    },
  ): Promise<BalanceConfig> {
    return CodexBalanceProvider.redactForExport(config);
  }

  static async prepareForDuplicate(
    config: BalanceConfig,
    _options: { secretStore: SecretStore; storeSecretsInSettings: boolean },
  ): Promise<BalanceConfig> {
    return CodexBalanceProvider.redactForExport(config);
  }

  get definition(): BalanceProviderDefinition {
    return {
      id: 'codex',
      label: t('Codex Usage'),
      description: t('Monitor usage percentages via Codex usage APIs'),
    };
  }

  private config: BalanceConfig;

  constructor(
    private readonly context: BalanceProviderContext,
    config?: BalanceConfig,
  ) {
    this.config = isCodexBalanceConfig(config) ? config : { method: 'codex' };
  }

  getConfig(): BalanceConfig | undefined {
    return this.config;
  }

  async configure(): Promise<BalanceConfigureResult> {
    const next: BalanceConfig = { method: 'codex' };
    this.config = next;
    await this.context.persistBalanceConfig?.(next);
    return { success: true, config: next };
  }

  async refresh(input: BalanceRefreshInput): Promise<BalanceRefreshResult> {
    const token = getToken(input.credential);
    if (!token) {
      return {
        success: false,
        error: t('Codex access token is required to query usage.'),
      };
    }

    const endpoints = buildCodexUsageEndpoints(input.provider.baseUrl);
    if (endpoints.length === 0) {
      return {
        success: false,
        error: t('Failed to query Codex usage.'),
      };
    }

    const logger = createSimpleHttpLogger({
      purpose: 'Balance refresh',
      providerName: input.provider.name,
      providerType: input.provider.type,
    });

    const accountId = resolveAccountId(input);

    const endpointErrors: string[] = [];
    let missingPercentError: string | undefined;

    for (const endpoint of endpoints) {
      try {
        const response = await fetchWithRetry(endpoint, {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/json',
            ...(accountId ? { 'ChatGPT-Account-Id': accountId } : {}),
          },
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
        const usageMetrics = parseUsageMetrics(payload);
        if (usageMetrics.length === 0) {
          missingPercentError = t(
            'Codex usage response from {0} does not include quota percentages.',
            endpoint,
          );
          continue;
        }

        return {
          success: true,
          snapshot: {
            updatedAt: Date.now(),
            items: buildSnapshotItems(usageMetrics),
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
          'Failed to query Codex usage from all endpoints: {0}.',
          endpointErrors.join(' | '),
        ),
      };
    }

    return {
      success: false,
      error: t('Failed to query Codex usage.'),
    };
  }
}

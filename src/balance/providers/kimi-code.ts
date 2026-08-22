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
import { isKimiCodeBalanceConfig } from '../types';
import type {
  BalanceConfigureResult,
  BalanceProvider,
  BalanceProviderContext,
  BalanceProviderDefinition,
} from '../balance-provider';

type UsageRow = {
  label: string;
  used: number;
  limit: number;
  resetHint?: string;
  resetAt?: string;
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

function toInt(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.trunc(value);
  }
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.trunc(parsed) : undefined;
  }
  return undefined;
}

function formatDurationShort(seconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(seconds));
  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }

  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) {
    return `${totalMinutes}m`;
  }

  const totalHours = Math.floor(totalMinutes / 60);
  if (totalHours < 24) {
    const minutes = totalMinutes % 60;
    return minutes ? `${totalHours}h ${minutes}m` : `${totalHours}h`;
  }

  const days = Math.floor(totalHours / 24);
  const hours = totalHours % 24;
  return hours ? `${days}d ${hours}h` : `${days}d`;
}

function formatResetAt(value: string): string {
  const date = new Date(value);
  const timestamp = date.getTime();
  if (!Number.isFinite(timestamp)) {
    return t('Resets at {0}', value);
  }

  const deltaSeconds = Math.floor((timestamp - Date.now()) / 1000);
  if (deltaSeconds <= 0) {
    return t('Reset');
  }

  return t('Resets in {0}', formatDurationShort(deltaSeconds));
}

function formatExpiration(value: string): string {
  const direct = value.match(
    /^(\d{4})[./-](\d{1,2})[./-](\d{1,2})(?:[ T](\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?$/,
  );
  if (direct) {
    const [, y, m, d, hh, mm, ss] = direct;
    const hours = String(Number(hh ?? '0')).padStart(2, '0');
    const minutes = String(Number(mm ?? '0')).padStart(2, '0');
    const seconds = String(Number(ss ?? '0')).padStart(2, '0');
    return `${Number(y)}.${Number(m)}.${Number(d)} ${hours}:${minutes}:${seconds}`;
  }

  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    return value;
  }

  const year = date.getFullYear();
  const month = date.getMonth() + 1;
  const day = date.getDate();
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  const seconds = String(date.getSeconds()).padStart(2, '0');
  return `${year}.${month}.${day} ${hours}:${minutes}:${seconds}`;
}

function resolveResetAt(data: Record<string, unknown>): string | undefined {
  for (const key of ['reset_at', 'resetAt', 'reset_time', 'resetTime']) {
    const raw = data[key];
    if (raw === undefined || raw === null) {
      continue;
    }

    const value = String(raw).trim();
    if (!value) {
      continue;
    }

    return value;
  }

  return undefined;
}

function resetHint(data: Record<string, unknown>): string | undefined {
  const resetAt = resolveResetAt(data);
  if (resetAt) {
    return formatResetAt(resetAt);
  }

  for (const key of ['reset_in', 'resetIn', 'ttl', 'window']) {
    const seconds = toInt(data[key]);
    if (seconds === undefined) {
      continue;
    }
    return t('Resets in {0}', formatDurationShort(seconds));
  }

  return undefined;
}

function toUsageRow(
  data: Record<string, unknown>,
  options: { defaultLabel: string },
): UsageRow | undefined {
  const limit = toInt(data['limit']);
  let used = toInt(data['used']);

  if (used === undefined) {
    const remaining = toInt(data['remaining']);
    if (remaining !== undefined && limit !== undefined) {
      used = limit - remaining;
    }
  }

  if (used === undefined && limit === undefined) {
    return undefined;
  }

  const label =
    String(
      pickString(data, 'name') ??
        pickString(data, 'title') ??
        options.defaultLabel,
    ) || options.defaultLabel;

  return {
    label,
    used: used ?? 0,
    limit: limit ?? 0,
    resetHint: resetHint(data),
    resetAt: resolveResetAt(data),
  };
}

function remainingRatio(row: UsageRow): number | undefined {
  if (row.limit <= 0) {
    return undefined;
  }
  return (row.limit - row.used) / row.limit;
}

function windowLabel(options: {
  item: Record<string, unknown>;
  detail: Record<string, unknown>;
  window: Record<string, unknown>;
  index: number;
}): string {
  const { item, detail, window, index } = options;

  for (const key of ['name', 'title', 'scope']) {
    const value = pickString(item, key) ?? pickString(detail, key);
    if (value && value.trim()) {
      return value.trim();
    }
  }

  const duration = toInt(
    window['duration'] ?? item['duration'] ?? detail['duration'],
  );
  const rawTimeUnit =
    pickString(window, 'timeUnit') ??
    pickString(item, 'timeUnit') ??
    pickString(detail, 'timeUnit') ??
    '';
  const timeUnit = rawTimeUnit.toUpperCase();

  if (duration !== undefined) {
    if (timeUnit.includes('MINUTE')) {
      if (duration >= 60 && duration % 60 === 0) {
        return `${duration / 60}h`;
      }
      return `${duration}m`;
    }
    if (timeUnit.includes('HOUR')) {
      return `${duration}h`;
    }
    if (timeUnit.includes('DAY')) {
      return `${duration}d`;
    }
    if (timeUnit) {
      return `${duration} ${timeUnit.toLowerCase()}`;
    }
    return `${duration}s`;
  }

  return t('Window #{0}', `${index + 1}`);
}

function resolvePayload(
  value: Record<string, unknown>,
): Record<string, unknown> {
  const data = value['data'];
  return isRecord(data) ? data : value;
}

function parseUsagePayload(payload: Record<string, unknown>): {
  usage?: UsageRow;
  limits: UsageRow[];
} {
  const limits: UsageRow[] = [];

  const rawUsage = payload['usage'];
  const usage = isRecord(rawUsage)
    ? toUsageRow(rawUsage, { defaultLabel: t('Weekly usage') })
    : undefined;

  const rawLimits = payload['limits'];
  if (Array.isArray(rawLimits)) {
    for (let index = 0; index < rawLimits.length; index++) {
      const item = rawLimits[index];
      if (!isRecord(item)) {
        continue;
      }

      const detailRaw = item['detail'];
      const detail = isRecord(detailRaw) ? detailRaw : item;

      const windowRaw = item['window'];
      const window = isRecord(windowRaw) ? windowRaw : {};

      const label = windowLabel({ item, detail, window, index });
      const row = toUsageRow(detail, { defaultLabel: label });
      if (row) {
        limits.push(row);
      }
    }
  }

  return { usage, limits };
}

function pickSummaryRow(parsed: {
  usage?: UsageRow;
  limits: UsageRow[];
}): UsageRow | undefined {
  if (parsed.usage) {
    return parsed.usage;
  }

  if (parsed.limits.length === 0) {
    return undefined;
  }

  let best: UsageRow | undefined;
  let bestRatio: number | undefined;

  for (const row of parsed.limits) {
    const ratio = remainingRatio(row);
    if (ratio === undefined) {
      continue;
    }

    if (!best || bestRatio === undefined || ratio < bestRatio) {
      best = row;
      bestRatio = ratio;
    }
  }

  return best ?? parsed.limits[0];
}

function inferPeriodFromLabel(label: string): BalanceMetric['period'] {
  const lower = label.toLowerCase();
  if (lower.includes('day') || lower.includes('today')) {
    return 'day';
  }
  if (lower.includes('week')) {
    return 'week';
  }
  if (lower.includes('month')) {
    return 'month';
  }
  if (lower.includes('total')) {
    return 'total';
  }
  return 'custom';
}

export class KimiCodeBalanceProvider implements BalanceProvider {
  static supportsSensitiveDataInSettings(_config: BalanceConfig): boolean {
    return false;
  }

  static redactForExport(config: BalanceConfig): BalanceConfig {
    return isKimiCodeBalanceConfig(config) ? config : { method: 'kimi-code' };
  }

  static async resolveForExport(
    config: BalanceConfig,
    _secretStore: SecretStore,
  ): Promise<BalanceConfig> {
    return KimiCodeBalanceProvider.redactForExport(config);
  }

  static async normalizeOnImport(
    config: BalanceConfig,
    _options: {
      secretStore: SecretStore;
      storeSecretsInSettings: boolean;
      existing?: BalanceConfig;
    },
  ): Promise<BalanceConfig> {
    return KimiCodeBalanceProvider.redactForExport(config);
  }

  static async prepareForDuplicate(
    config: BalanceConfig,
    _options: { secretStore: SecretStore; storeSecretsInSettings: boolean },
  ): Promise<BalanceConfig> {
    return KimiCodeBalanceProvider.redactForExport(config);
  }

  get definition(): BalanceProviderDefinition {
    return {
      id: 'kimi-code',
      label: t('Kimi Code Usage'),
      description: t('Monitor usage and quotas via Kimi Code usages API'),
    };
  }

  constructor(
    private readonly context: BalanceProviderContext,
    config?: BalanceConfig,
  ) {
    this.config = isKimiCodeBalanceConfig(config)
      ? config
      : { method: 'kimi-code' };
  }

  private config: BalanceConfig;

  getConfig(): BalanceConfig | undefined {
    return this.config;
  }

  async configure(): Promise<BalanceConfigureResult> {
    const next: BalanceConfig = { method: 'kimi-code' };
    this.config = next;
    await this.context.persistBalanceConfig?.(next);
    return { success: true, config: next };
  }

  async refresh(input: BalanceRefreshInput): Promise<BalanceRefreshResult> {
    const token = getToken(input.credential);
    if (!token) {
      return {
        success: false,
        error: t('API key is required to query Kimi Code usage.'),
      };
    }

    const logger = createSimpleHttpLogger({
      purpose: 'Balance refresh',
      providerName: input.provider.name,
      providerType: input.provider.type,
    });

    const baseUrl = normalizeBaseUrlInput(input.provider.baseUrl);
    const usagePath = baseUrl.toLowerCase().endsWith('/v1')
      ? 'usages'
      : 'v1/usages';
    const endpoint = new URL(usagePath, `${baseUrl}/`).toString();

    try {
      const response = await fetchWithRetry(endpoint, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
        },
        logger,
        ignoreSSLErrors: input.provider.ignoreSSLErrors,
        proxy: input.provider.proxy,
      });

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        if (response.status === 401) {
          return {
            success: false,
            error: t('Authorization failed. Please check your API key.'),
          };
        }
        if (response.status === 404) {
          return {
            success: false,
            error: t('Usage endpoint not available. Try Kimi For Coding.'),
          };
        }
        return {
          success: false,
          error:
            text.trim() ||
            t(
              'Failed to query Kimi Code usage (HTTP {0}).',
              `${response.status}`,
            ),
        };
      }

      const json: unknown = await response.json().catch(() => undefined);
      if (!isRecord(json)) {
        return {
          success: false,
          error: t('Unexpected Kimi Code usage response.'),
        };
      }

      const parsed = parseUsagePayload(resolvePayload(json));
      const summaryRow = pickSummaryRow(parsed);

      const rows: UsageRow[] = [];
      if (parsed.usage) {
        rows.push(parsed.usage);
        rows.push(...parsed.limits);
      } else if (summaryRow) {
        rows.push(summaryRow);
        for (const row of parsed.limits) {
          if (row === summaryRow) {
            continue;
          }
          rows.push(row);
        }
      }

      const items: BalanceMetric[] = [];
      for (let index = 0; index < rows.length; index++) {
        const row = rows[index];
        const period = inferPeriodFromLabel(row.label);
        const remaining =
          row.limit > 0 ? Math.max(0, row.limit - row.used) : undefined;

        items.push({
          id: `tokens-${index + 1}`,
          type: 'token',
          period,
          ...(period === 'custom' ? { periodLabel: row.label } : {}),
          label: row.label,
          used: row.used,
          ...(row.limit > 0 ? { limit: row.limit } : {}),
          ...(remaining !== undefined ? { remaining } : {}),
        });
      }

      let primaryId: string | undefined;
      const ratio = summaryRow ? remainingRatio(summaryRow) : undefined;
      if (summaryRow && ratio !== undefined) {
        const primaryRow = summaryRow;
        const percentValue = Math.round(ratio * 100);
        const period = inferPeriodFromLabel(primaryRow.label);
        const percentId = 'remaining-percent';
        items.push({
          id: percentId,
          type: 'percent',
          period,
          ...(period === 'custom' ? { periodLabel: primaryRow.label } : {}),
          label: t('Remaining'),
          value: percentValue,
          basis: 'remaining',
        });
        primaryId = percentId;
      }

      if (summaryRow?.resetAt) {
        const value = summaryRow.resetAt;
        const timestampMs = new Date(value).getTime();
        const period = inferPeriodFromLabel(summaryRow.label);
        const timeId = 'reset-time';
        items.push({
          id: timeId,
          type: 'time',
          period,
          ...(period === 'custom' ? { periodLabel: summaryRow.label } : {}),
          label: t('Resets'),
          kind: 'resetAt',
          value: formatExpiration(value),
          ...(Number.isFinite(timestampMs) ? { timestampMs } : {}),
        });
        if (!primaryId) {
          primaryId = timeId;
        }
      }

      if (!primaryId && summaryRow) {
        const summaryToken = items.find(
          (item) => item.type === 'token' && item.label === summaryRow.label,
        );
        primaryId = summaryToken?.id;
      }
      if (!primaryId) {
        primaryId = items[0]?.id;
      }

      const normalizedItems = items.map((item) => ({
        ...item,
        primary: item.id === primaryId,
      }));

      return {
        success: true,
        snapshot: {
          updatedAt: Date.now(),
          items: normalizedItems,
        },
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

import { t } from '../../i18n';
import { createSimpleHttpLogger } from '../../logger';
import { getToken } from '../../client/utils';
import { fetchWithRetry, normalizeBaseUrlInput } from '../../utils';
import type { SecretStore } from '../../secret';
import type {
  BalanceConfig,
  BalanceProviderState,
  BalanceRefreshInput,
  BalanceRefreshResult,
  BalanceStatusViewItem,
  BalanceUiStatusSnapshot,
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

function resetHint(data: Record<string, unknown>): string | undefined {
  for (const key of ['reset_at', 'resetAt', 'reset_time', 'resetTime']) {
    const raw = data[key];
    if (raw === undefined || raw === null) {
      continue;
    }
    const value = String(raw).trim();
    if (!value) {
      continue;
    }
    return formatResetAt(value);
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
  };
}

function remainingRatio(row: UsageRow): number | undefined {
  if (row.limit <= 0) {
    return undefined;
  }
  return (row.limit - row.used) / row.limit;
}

function formatRow(row: UsageRow): string {
  const hint = row.resetHint ? ` (${row.resetHint})` : '';

  if (row.limit <= 0) {
    return `${row.label}: ${row.used} used${hint}`;
  }

  const ratio = remainingRatio(row);
  const percent =
    ratio !== undefined ? Math.round(ratio * 100) : undefined;
  const percentPart =
    percent !== undefined ? ` (${percent}%)` : '';

  return `${row.label}: ${row.used}/${row.limit}${percentPart}${hint}`;
}

function limitLabel(options: {
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

  const duration = toInt(window['duration'] ?? item['duration'] ?? detail['duration']);
  const rawTimeUnit =
    pickString(window, 'timeUnit') ??
    pickString(item, 'timeUnit') ??
    pickString(detail, 'timeUnit') ??
    '';
  const timeUnit = rawTimeUnit.toUpperCase();

  if (duration !== undefined) {
    if (timeUnit.includes('MINUTE')) {
      if (duration >= 60 && duration % 60 === 0) {
        return `${duration / 60}h limit`;
      }
      return `${duration}m limit`;
    }
    if (timeUnit.includes('HOUR')) {
      return `${duration}h limit`;
    }
    if (timeUnit.includes('DAY')) {
      return `${duration}d limit`;
    }
    if (timeUnit) {
      return `${duration} ${timeUnit.toLowerCase()} limit`;
    }
    return `${duration}s limit`;
  }

  return t('Limit #{0}', `${index + 1}`);
}

function resolvePayload(value: Record<string, unknown>): Record<string, unknown> {
  const data = value['data'];
  return isRecord(data) ? data : value;
}

function parseUsagePayload(
  payload: Record<string, unknown>,
): { usage?: UsageRow; limits: UsageRow[] } {
  const limits: UsageRow[] = [];

  const rawUsage = payload['usage'];
  const usage = isRecord(rawUsage)
    ? toUsageRow(rawUsage, { defaultLabel: t('Weekly limit') })
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

      const label = limitLabel({ item, detail, window, index });
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
    this.config = isKimiCodeBalanceConfig(config) ? config : { method: 'kimi-code' };
  }

  private config: BalanceConfig;

  getConfig(): BalanceConfig | undefined {
    return this.config;
  }

  async getFieldDetail(
    state: BalanceProviderState | undefined,
  ): Promise<string | undefined> {
    if (state?.snapshot?.summary) {
      return state.snapshot.summary;
    }
    if (state?.lastError) {
      return t('Error: {0}', state.lastError);
    }
    return t('Not refreshed yet');
  }

  async getStatusSnapshot(
    state: BalanceProviderState | undefined,
  ): Promise<BalanceUiStatusSnapshot> {
    if (state?.isRefreshing) {
      return { kind: 'loading' };
    }
    if (state?.lastError) {
      return { kind: 'error', message: state.lastError };
    }
    if (state?.snapshot) {
      return {
        kind: 'valid',
        updatedAt: state.snapshot.updatedAt,
        summary: state.snapshot.summary,
      };
    }
    return { kind: 'not-configured' };
  }

  async getStatusViewItems(options: {
    state: BalanceProviderState | undefined;
    refresh: () => Promise<void>;
  }): Promise<BalanceStatusViewItem[]> {
    const state = options.state;
    const snapshot = state?.snapshot;

    const description = state?.isRefreshing
      ? t('Refreshing...')
      : snapshot
        ? t('Last updated: {0}', new Date(snapshot.updatedAt).toLocaleTimeString())
        : state?.lastError
          ? t('Error')
          : t('No data');

    const details =
      snapshot?.details?.join(' | ') || state?.lastError || t('Not refreshed yet');

    return [
      {
        label: `$(pulse) ${this.definition.label}`,
        description,
        detail: details,
      },
      {
        label: `$(refresh) ${t('Refresh now')}`,
        description: t('Fetch latest balance info'),
        action: {
          kind: 'inline',
          run: async () => {
            await options.refresh();
          },
        },
      },
    ];
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
    const usagePath = baseUrl.toLowerCase().endsWith('/v1') ? 'usages' : 'v1/usages';
    const endpoint = new URL(usagePath, `${baseUrl}/`).toString();

    try {
      const response = await fetchWithRetry(endpoint, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
        },
        logger,
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
            t('Failed to query Kimi Code usage (HTTP {0}).', `${response.status}`),
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

      const details: string[] = [];
      if (parsed.usage) {
        details.push(formatRow(parsed.usage));
        details.push(...parsed.limits.map((row) => formatRow(row)));
      } else if (summaryRow) {
        details.push(formatRow(summaryRow));
        for (const row of parsed.limits) {
          if (row === summaryRow) {
            continue;
          }
          details.push(formatRow(row));
        }
      }

      const summary = summaryRow ? formatRow(summaryRow) : t('No data');
      if (details.length === 0) {
        details.push(t('No data'));
      }

      return {
        success: true,
        snapshot: {
          summary,
          details,
          updatedAt: Date.now(),
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

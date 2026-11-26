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
import { isOpenCodeGoBalanceConfig } from '../types';
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

type UsageWindowKey = 'rolling' | 'weekly' | 'monthly';

type ParsedUsageWindow = {
  key: UsageWindowKey;
  label: string;
  usedPercent: number;
  rateLimited: boolean;
  resetAt?: ParsedResetAt;
};

const USAGE_WINDOW_KEYS: readonly UsageWindowKey[] = [
  'rolling',
  'weekly',
  'monthly',
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
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

    const direct = parsed['message'];
    if (typeof direct === 'string' && direct.trim()) {
      return direct.trim();
    }

    const error = parsed['error'];
    if (isRecord(error)) {
      const message = error['message'];
      if (typeof message === 'string' && message.trim()) {
        return message.trim();
      }
    }
  } catch {
    return normalized;
  }

  return normalized;
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

function hasUsageWindowShape(record: Record<string, unknown>): boolean {
  return USAGE_WINDOW_KEYS.some((key) => isRecord(record[key]));
}

function resolveUsageBody(
  payload: unknown,
): Record<string, unknown> | undefined {
  const nestedKeys = ['usage', 'data', 'result', 'payload'];
  let current: unknown = payload;

  for (let depth = 0; depth <= nestedKeys.length; depth += 1) {
    if (!isRecord(current)) {
      return undefined;
    }

    const record = current;
    if (hasUsageWindowShape(record)) {
      return record;
    }

    const next = nestedKeys
      .map((key) => record[key])
      .find((candidate) => isRecord(candidate));
    current = next;
  }

  return undefined;
}

function resolveWindowLabel(key: UsageWindowKey): string {
  if (key === 'rolling') {
    return t('5-hour window');
  }
  if (key === 'weekly') {
    return t('Weekly window');
  }
  return t('Monthly window');
}

function parseUsageWindow(
  body: Record<string, unknown>,
  key: UsageWindowKey,
): ParsedUsageWindow | undefined {
  const rawWindow = body[key];
  if (!isRecord(rawWindow)) {
    return undefined;
  }

  const percent = pickNumberLike(rawWindow, 'percent');
  if (percent === undefined) {
    return undefined;
  }

  const status = rawWindow['status'];
  const exhaustedStatus =
    typeof status === 'string' && status.trim().toLowerCase() === 'rate-limited';

  return {
    key,
    label: resolveWindowLabel(key),
    usedPercent: clampPercent(percent),
    rateLimited: exhaustedStatus || percent >= 100,
    resetAt: normalizeResetAt(rawWindow['resetsAt']),
  };
}

function parseUsageWindows(payload: unknown): ParsedUsageWindow[] {
  const body = resolveUsageBody(payload);
  if (!body) {
    return [];
  }

  const windows: ParsedUsageWindow[] = [];
  for (const key of USAGE_WINDOW_KEYS) {
    const parsed = parseUsageWindow(body, key);
    if (parsed) {
      windows.push(parsed);
    }
  }

  return windows;
}

function buildSnapshotItems(windows: ParsedUsageWindow[]): BalanceMetric[] {
  const items: BalanceMetric[] = [];

  let primaryPercentIndex = -1;
  let highestUsedPercent = Number.NEGATIVE_INFINITY;
  let rateLimited = false;

  windows.forEach((window) => {
    const metricIdPrefix = `opencode-go-${window.key}`;

    const percentMetricIndex = items.length;
    items.push({
      id: `${metricIdPrefix}-used-percent`,
      type: 'percent',
      period: 'current',
      label: window.label,
      value: window.usedPercent,
      basis: 'used',
    });

    if (window.usedPercent > highestUsedPercent) {
      highestUsedPercent = window.usedPercent;
      primaryPercentIndex = percentMetricIndex;
    }

    if (window.rateLimited) {
      rateLimited = true;
    }

    if (window.resetAt) {
      items.push({
        id: `${metricIdPrefix}-reset-at`,
        type: 'time',
        period: 'current',
        kind: 'resetAt',
        label: window.label,
        value: window.resetAt.value,
        ...(typeof window.resetAt.timestampMs === 'number'
          ? { timestampMs: window.resetAt.timestampMs }
          : {}),
      });
    }
  });

  if (rateLimited) {
    items.push({
      id: 'opencode-go-status',
      type: 'status',
      period: 'current',
      label: t('OpenCode Go quota'),
      value: 'exhausted',
      primary: true,
    });
    return items;
  }

  if (primaryPercentIndex >= 0) {
    const primaryMetric = items[primaryPercentIndex];
    if (primaryMetric?.type === 'percent') {
      primaryMetric.primary = true;
    }
  }

  return items;
}

function buildUsageEndpoints(rawBaseUrl: string): string[] {
  let baseUrl: string;
  try {
    baseUrl = normalizeBaseUrlInput(rawBaseUrl);
  } catch {
    return [];
  }

  const candidates: string[] = [`${baseUrl}/usage`];

  try {
    const parsed = new URL(`${baseUrl}/`);
    candidates.push(
      new URL('/inference/go/v1/usage', parsed.origin).toString(),
      new URL('/zen/go/v1/usage', parsed.origin).toString(),
    );
  } catch {
    // Keep the provider-relative endpoint only.
  }

  const endpoints: string[] = [];
  for (const candidate of candidates) {
    if (!endpoints.includes(candidate)) {
      endpoints.push(candidate);
    }
  }

  return endpoints;
}

export class OpenCodeGoBalanceProvider implements BalanceProvider {
  static supportsSensitiveDataInSettings(_config: BalanceConfig): boolean {
    return false;
  }

  static redactForExport(config: BalanceConfig): BalanceConfig {
    return isOpenCodeGoBalanceConfig(config) ? config : { method: 'opencode-go' };
  }

  static async resolveForExport(
    config: BalanceConfig,
    _secretStore: SecretStore,
  ): Promise<BalanceConfig> {
    return OpenCodeGoBalanceProvider.redactForExport(config);
  }

  static async normalizeOnImport(
    config: BalanceConfig,
    _options: {
      secretStore: SecretStore;
      storeSecretsInSettings: boolean;
      existing?: BalanceConfig;
    },
  ): Promise<BalanceConfig> {
    return OpenCodeGoBalanceProvider.redactForExport(config);
  }

  static async prepareForDuplicate(
    config: BalanceConfig,
    _options: { secretStore: SecretStore; storeSecretsInSettings: boolean },
  ): Promise<BalanceConfig> {
    return OpenCodeGoBalanceProvider.redactForExport(config);
  }

  get definition(): BalanceProviderDefinition {
    return {
      id: 'opencode-go',
      label: t('OpenCode Go Usage'),
      description: t('Monitor usage percentages via OpenCode Go usage API'),
    };
  }

  private config: BalanceConfig;

  constructor(
    private readonly context: BalanceProviderContext,
    config?: BalanceConfig,
  ) {
    this.config = isOpenCodeGoBalanceConfig(config)
      ? config
      : { method: 'opencode-go' };
  }

  getConfig(): BalanceConfig | undefined {
    return this.config;
  }

  async configure(): Promise<BalanceConfigureResult> {
    const next: BalanceConfig = { method: 'opencode-go' };
    this.config = next;
    await this.context.persistBalanceConfig?.(next);
    return { success: true, config: next };
  }

  async refresh(input: BalanceRefreshInput): Promise<BalanceRefreshResult> {
    const token = getToken(input.credential);
    if (!token) {
      return {
        success: false,
        error: t('OpenCode Go API key is required to query usage.'),
      };
    }

    const endpoints = buildUsageEndpoints(input.provider.baseUrl);
    if (endpoints.length === 0) {
      return {
        success: false,
        error: t('Failed to query OpenCode Go usage.'),
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
          method: 'GET',
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/json',
          },
          logger,
          proxy: input.provider.proxy,
        });

        if (!response.ok) {
          const text = await response.text().catch(() => '');
          const reason =
            parseErrorMessage(text) || t('HTTP {0}', `${response.status}`);
          endpointErrors.push(`${endpoint}: ${reason}`);
          continue;
        }

        const payload: unknown = await response.json().catch(() => undefined);
        const usageWindows = parseUsageWindows(payload);
        if (usageWindows.length === 0) {
          missingPercentError = t(
            'OpenCode Go usage response from {0} does not include quota percentages.',
            endpoint,
          );
          continue;
        }

        return {
          success: true,
          snapshot: {
            updatedAt: Date.now(),
            items: buildSnapshotItems(usageWindows),
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
          'Failed to query OpenCode Go usage from all endpoints: {0}.',
          endpointErrors.join(' | '),
        ),
      };
    }

    return {
      success: false,
      error: t('Failed to query OpenCode Go usage.'),
    };
  }
}

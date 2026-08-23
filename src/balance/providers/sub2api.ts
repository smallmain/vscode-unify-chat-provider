import { t } from '../../i18n';
import { createSimpleHttpLogger } from '../../logger';
import { getToken } from '../../client/utils';
import { fetchWithRetry, normalizeBaseUrlInput } from '../../utils';
import type { SecretStore } from '../../secret';
import type {
  BalanceConfig,
  BalanceMetric,
  BalanceMetricPeriod,
  BalanceRefreshInput,
  BalanceRefreshResult,
} from '../types';
import { isSub2APIBalanceConfig } from '../types';
import type {
  BalanceConfigureResult,
  BalanceProvider,
  BalanceProviderContext,
  BalanceProviderDefinition,
} from '../balance-provider';

type SubscriptionWindow = {
  id: string;
  period: BalanceMetricPeriod;
  usageField: string;
  limitField: string;
};

type QuotaConstraint = {
  metricId: string;
  remaining: number;
};

type Sub2APIBalanceProviderContext = Pick<
  BalanceProviderContext,
  'persistBalanceConfig'
>;

const SUBSCRIPTION_WINDOWS: readonly SubscriptionWindow[] = [
  {
    id: 'daily',
    period: 'day',
    usageField: 'daily_usage_usd',
    limitField: 'daily_limit_usd',
  },
  {
    id: 'weekly',
    period: 'week',
    usageField: 'weekly_usage_usd',
    limitField: 'weekly_limit_usd',
  },
  {
    id: 'monthly',
    period: 'month',
    usageField: 'monthly_usage_usd',
    limitField: 'monthly_limit_usd',
  },
];

const DAY_MS = 24 * 60 * 60 * 1000;

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

function pickString(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = record[key];
  return typeof value === 'string' && value.trim()
    ? value.trim()
    : undefined;
}

function addDaysIso(
  value: string | undefined,
  days: number,
): string | undefined {
  if (!value) {
    return undefined;
  }
  const timestampMs = Date.parse(value);
  return Number.isFinite(timestampMs)
    ? new Date(timestampMs + days * DAY_MS).toISOString()
    : undefined;
}

function pickTightestConstraint(
  constraints: readonly QuotaConstraint[],
): string | undefined {
  return constraints.reduce<QuotaConstraint | undefined>(
    (selected, constraint) =>
      !selected || constraint.remaining < selected.remaining
        ? constraint
        : selected,
    undefined,
  )?.metricId;
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

    const direct = pickString(parsed, 'message');
    if (direct) {
      return direct;
    }

    const error = parsed['error'];
    if (isRecord(error)) {
      return pickString(error, 'message') ?? normalized;
    }
  } catch {
    return normalized;
  }

  return normalized;
}

function resolveUsageEndpoint(baseUrl: string): string {
  const parsed = new URL(baseUrl);
  return /\/v1$/i.test(parsed.pathname)
    ? new URL('usage', `${baseUrl}/`).toString()
    : new URL('/v1/usage', `${baseUrl}/`).toString();
}

function resolveCurrencySymbol(payload: Record<string, unknown>): string {
  const unit = pickString(payload, 'unit');
  if (!unit || unit.toUpperCase() === 'USD') {
    return '$';
  }
  return unit;
}

function appendAmountGroup(
  items: BalanceMetric[],
  options: {
    id: string;
    scope: string;
    period: BalanceMetricPeriod;
    periodLabel?: string;
    label: string;
    currencySymbol: string;
    remaining?: number;
    used?: number;
    limit?: number;
  },
): void {
  const shared = {
    period: options.period,
    scope: options.scope,
    periodLabel: options.periodLabel,
    label: options.label,
    currencySymbol: options.currencySymbol,
  };

  if (options.remaining !== undefined) {
    items.push({
      ...shared,
      id: `${options.id}-remaining`,
      type: 'amount',
      direction: 'remaining',
      value: options.remaining,
    });
  }
  if (options.used !== undefined) {
    items.push({
      ...shared,
      id: `${options.id}-used`,
      type: 'amount',
      direction: 'used',
      value: options.used,
    });
  }
  if (options.limit !== undefined) {
    items.push({
      ...shared,
      id: `${options.id}-limit`,
      type: 'amount',
      direction: 'limit',
      value: options.limit,
    });
  }
}

function appendTimeMetric(
  items: BalanceMetric[],
  options: {
    id: string;
    scope: string;
    period: BalanceMetricPeriod;
    periodLabel?: string;
    kind: 'expiresAt' | 'resetAt';
    value: string | undefined;
  },
): void {
  if (!options.value) {
    return;
  }
  const timestampMs = Date.parse(options.value);
  items.push({
    id: options.id,
    type: 'time',
    period: options.period,
    periodLabel: options.periodLabel,
    scope: options.scope,
    label: options.kind === 'resetAt' ? t('Reset') : t('Expires'),
    kind: options.kind,
    value: options.value,
    timestampMs: Number.isFinite(timestampMs) ? timestampMs : undefined,
  });
}

function parseUsageMetrics(payload: Record<string, unknown>): BalanceMetric[] {
  const mode = pickString(payload, 'mode');
  if (mode !== 'quota_limited' && mode !== 'unrestricted') {
    return [];
  }

  const items: BalanceMetric[] = [];
  const currencySymbol = resolveCurrencySymbol(payload);
  const quota = isRecord(payload['quota']) ? payload['quota'] : undefined;
  const subscription = isRecord(payload['subscription'])
    ? payload['subscription']
    : undefined;
  const constraints: QuotaConstraint[] = [];
  let unavailablePrimaryId: string | undefined;
  let exhaustedPrimaryId: string | undefined;
  let defaultPrimaryId: string | undefined;

  const apiKeyStatus = pickString(payload, 'status')?.toLowerCase();
  const isValid = payload['isValid'];
  if (apiKeyStatus === 'expired') {
    unavailablePrimaryId = 'api-key-expired';
    items.push({
      id: unavailablePrimaryId,
      type: 'status',
      period: 'current',
      scope: 'api-key',
      label: t('API Key balance'),
      value: 'unavailable',
      message: t('Expired'),
    });
  } else if (apiKeyStatus === 'disabled' || isValid === false) {
    unavailablePrimaryId = 'api-key-unavailable';
    items.push({
      id: unavailablePrimaryId,
      type: 'status',
      period: 'current',
      scope: 'api-key',
      label: t('API Key balance'),
      value: 'unavailable',
      message: apiKeyStatus === 'disabled' ? t('Disabled') : undefined,
    });
  } else if (apiKeyStatus === 'quota_exhausted') {
    exhaustedPrimaryId = 'api-key-quota-exhausted';
    items.push({
      id: exhaustedPrimaryId,
      type: 'status',
      period: 'current',
      scope: 'api-key',
      label: t('API Key balance'),
      value: 'exhausted',
    });
  }

  if (mode === 'quota_limited' && quota) {
    const limit = pickNumberLike(quota, 'limit');
    const used = pickNumberLike(quota, 'used');
    const remaining =
      pickNumberLike(quota, 'remaining') ??
      (limit !== undefined && used !== undefined
        ? Math.max(0, limit - used)
        : undefined);
    appendAmountGroup(items, {
      id: 'api-key-quota',
      scope: 'api-key',
      period: 'current',
      label: t('API Key balance'),
      currencySymbol,
      remaining,
      used,
      limit,
    });
    if (remaining !== undefined) {
      constraints.push({
        metricId: 'api-key-quota-remaining',
        remaining,
      });
    }
  } else if (mode === 'unrestricted' && subscription) {
    const topLevelRemaining = pickNumberLike(payload, 'remaining');
    if (topLevelRemaining === -1) {
      defaultPrimaryId = 'subscription-unlimited';
      items.push({
        id: defaultPrimaryId,
        type: 'status',
        period: 'current',
        scope: 'subscription',
        label: t('Subscription'),
        value: 'unlimited',
      });
    } else if (topLevelRemaining !== undefined) {
      defaultPrimaryId = 'subscription-quota-remaining';
      appendAmountGroup(items, {
        id: 'subscription-quota',
        scope: 'subscription',
        period: 'current',
        label: t('Subscription'),
        currencySymbol,
        remaining: topLevelRemaining,
      });
    }
  } else if (mode === 'unrestricted') {
    const walletBalance =
      pickNumberLike(payload, 'balance') ??
      pickNumberLike(payload, 'remaining');
    if (walletBalance !== undefined) {
      defaultPrimaryId = 'wallet-balance-remaining';
      appendAmountGroup(items, {
        id: 'wallet-balance',
        scope: 'user',
        period: 'current',
        label: t('Balance'),
        currencySymbol,
        remaining: walletBalance,
      });
    }
  }

  if (subscription) {
    for (const window of SUBSCRIPTION_WINDOWS) {
      const limit = pickNumberLike(subscription, window.limitField);
      const used = pickNumberLike(subscription, window.usageField);
      if (limit === undefined || limit <= 0) {
        continue;
      }
      appendAmountGroup(items, {
        id: `subscription-${window.id}`,
        scope: 'subscription',
        period: window.period,
        label: t('Subscription'),
        currencySymbol,
        remaining: Math.max(0, limit - (used ?? 0)),
        used,
        limit,
      });
    }

    appendTimeMetric(items, {
      id: 'subscription-weekly-reset',
      scope: 'subscription',
      period: 'week',
      kind: 'resetAt',
      value: addDaysIso(
        pickString(subscription, 'weekly_window_start'),
        7,
      ),
    });

    appendTimeMetric(items, {
      id: 'subscription-expires',
      scope: 'subscription',
      period: 'current',
      kind: 'expiresAt',
      value: pickString(subscription, 'expires_at'),
    });
  }

  const rateLimits = payload['rate_limits'];
  if (Array.isArray(rateLimits)) {
    for (const [index, value] of rateLimits.entries()) {
      if (!isRecord(value)) {
        continue;
      }
      const window = pickString(value, 'window') ?? `${index + 1}`;
      const limit = pickNumberLike(value, 'limit');
      const used = pickNumberLike(value, 'used');
      const remaining =
        pickNumberLike(value, 'remaining') ??
        (limit !== undefined && used !== undefined
          ? Math.max(0, limit - used)
          : undefined);
      const period =
        window === '1d' ? 'day' : window === '7d' ? 'week' : 'custom';
      appendAmountGroup(items, {
        id: `rate-limit-${index}`,
        scope: 'api-key-rate-limit',
        period,
        periodLabel: window,
        label: t('API Key balance'),
        currencySymbol,
        remaining,
        used,
        limit,
      });
      if (remaining !== undefined) {
        constraints.push({
          metricId: `rate-limit-${index}-remaining`,
          remaining,
        });
        if (remaining <= 0) {
          const statusId = `rate-limit-${index}-exhausted`;
          exhaustedPrimaryId ??= statusId;
          items.push({
            id: statusId,
            type: 'status',
            period,
            periodLabel: window,
            scope: 'api-key-rate-limit',
            label: t('API Key balance'),
            value: 'exhausted',
          });
        }
      }
      appendTimeMetric(items, {
        id: `rate-limit-${index}-reset`,
        scope: 'api-key-rate-limit',
        period,
        periodLabel: window,
        kind: 'resetAt',
        value: pickString(value, 'reset_at'),
      });
    }
  }

  appendTimeMetric(items, {
    id: 'api-key-expires',
    scope: 'api-key',
    period: 'current',
    kind: 'expiresAt',
    value: pickString(payload, 'expires_at'),
  });

  const selected =
    unavailablePrimaryId ??
    exhaustedPrimaryId ??
    (mode === 'quota_limited'
      ? pickTightestConstraint(constraints)
      : defaultPrimaryId) ??
    items.find((item) => item.type === 'status')?.id ??
    items.find(
      (item) => item.type === 'amount' && item.direction === 'remaining',
    )?.id ??
    items[0]?.id;

  return items.map((item) => ({
    ...item,
    primary: item.id === selected,
  }));
}

export class Sub2APIBalanceProvider implements BalanceProvider {
  static supportsSensitiveDataInSettings(_config: BalanceConfig): boolean {
    return false;
  }

  static redactForExport(config: BalanceConfig): BalanceConfig {
    return isSub2APIBalanceConfig(config) ? config : { method: 'sub2api' };
  }

  static async resolveForExport(
    config: BalanceConfig,
    _secretStore: SecretStore,
  ): Promise<BalanceConfig> {
    return Sub2APIBalanceProvider.redactForExport(config);
  }

  static async normalizeOnImport(
    config: BalanceConfig,
    _options: {
      secretStore: SecretStore;
      storeSecretsInSettings: boolean;
      existing?: BalanceConfig;
    },
  ): Promise<BalanceConfig> {
    return Sub2APIBalanceProvider.redactForExport(config);
  }

  static async prepareForDuplicate(
    config: BalanceConfig,
    _options: { secretStore: SecretStore; storeSecretsInSettings: boolean },
  ): Promise<BalanceConfig> {
    return Sub2APIBalanceProvider.redactForExport(config);
  }

  get definition(): BalanceProviderDefinition {
    return {
      id: 'sub2api',
      label: t('Sub2API Balance'),
      description: t('Monitor balance and quotas via Sub2API usage API'),
    };
  }

  private config: BalanceConfig;

  constructor(
    private readonly context: Sub2APIBalanceProviderContext,
    config?: BalanceConfig,
  ) {
    this.config = isSub2APIBalanceConfig(config)
      ? config
      : { method: 'sub2api' };
  }

  getConfig(): BalanceConfig | undefined {
    return this.config;
  }

  async configure(): Promise<BalanceConfigureResult> {
    const next: BalanceConfig = { method: 'sub2api' };
    this.config = next;
    await this.context.persistBalanceConfig?.(next);
    return { success: true, config: next };
  }

  async refresh(input: BalanceRefreshInput): Promise<BalanceRefreshResult> {
    const apiKey = getToken(input.credential);
    if (!apiKey) {
      return {
        success: false,
        error: t('API key is required to query {0} balance.', 'Sub2API'),
      };
    }

    const logger = createSimpleHttpLogger({
      purpose: 'Balance refresh',
      providerName: input.provider.name,
      providerType: input.provider.type,
    });
    const baseUrl = normalizeBaseUrlInput(input.provider.baseUrl);
    const endpoint = resolveUsageEndpoint(baseUrl);

    try {
      const response = await fetchWithRetry(endpoint, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          Accept: 'application/json',
        },
        logger,
        proxy: input.provider.proxy,
      });

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        return {
          success: false,
          error:
            parseErrorMessage(text) ??
            t(
              'Failed to query {0} balance (HTTP {1}).',
              'Sub2API',
              `${response.status}`,
            ),
        };
      }

      const json: unknown = await response.json().catch(() => undefined);
      if (!isRecord(json)) {
        return {
          success: false,
          error: t('Unexpected {0} balance response.', 'Sub2API'),
        };
      }

      const items = parseUsageMetrics(json);
      if (items.length === 0) {
        return {
          success: false,
          error: t('Unexpected {0} balance response.', 'Sub2API'),
        };
      }

      return {
        success: true,
        snapshot: {
          updatedAt: Date.now(),
          items,
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

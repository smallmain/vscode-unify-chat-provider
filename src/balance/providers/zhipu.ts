import { t } from '../../i18n';
import { createSimpleHttpLogger } from '../../logger';
import { getToken } from '../../client/utils';
import { fetchWithRetry } from '../../utils';
import type { SecretStore } from '../../secret';
import type {
  BalanceConfig,
  BalanceMetric,
  BalanceMetricPeriod,
  BalanceRefreshInput,
  BalanceRefreshResult,
  BalanceSnapshot,
} from '../types';
import { isZhiPuBalanceConfig } from '../types';
import type {
  BalanceConfigureResult,
  BalanceProvider,
  BalanceProviderContext,
  BalanceProviderDefinition,
} from '../balance-provider';

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

    const msg = pickString(parsed, 'msg')?.trim();
    if (msg) {
      return msg;
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

const ZHIPU_QUOTA_PATH = '/api/monitor/usage/quota/limit';
const ZHIPU_BALANCE_PATH = '/api/biz/account/query-customer-account-report';
const ZHIPU_GLOBAL_ORIGIN = 'https://api.z.ai';
const ZHIPU_CHINA_ORIGIN = 'https://bigmodel.cn';
const ZHIPU_GLOBAL_HOSTS = new Set(['z.ai', 'api.z.ai', 'www.z.ai']);
const ZHIPU_CHINA_HOSTS = new Set([
  'bigmodel.cn',
  'www.bigmodel.cn',
  'open.bigmodel.cn',
]);

export function resolveZhiPuApiOrigin(baseUrl: string): string {
  const base = new URL(baseUrl);
  const hostname = base.hostname.toLowerCase();
  if (ZHIPU_GLOBAL_HOSTS.has(hostname)) {
    return ZHIPU_GLOBAL_ORIGIN;
  }
  if (ZHIPU_CHINA_HOSTS.has(hostname)) {
    return ZHIPU_CHINA_ORIGIN;
  }
  return base.origin;
}

export function resolveZhiPuQuotaEndpoint(baseUrl: string): string {
  return new URL(ZHIPU_QUOTA_PATH, resolveZhiPuApiOrigin(baseUrl)).toString();
}

export function resolveZhiPuBalanceEndpoint(baseUrl: string): string {
  return new URL(ZHIPU_BALANCE_PATH, resolveZhiPuApiOrigin(baseUrl)).toString();
}

function isValidPercent(value: number | undefined): value is number {
  return value !== undefined && value >= 0 && value <= 100;
}

function isValidTimestamp(value: number | undefined): value is number {
  return value !== undefined && value > 0;
}

interface ZhiPuWindowDefinition {
  id: string;
  label?: string;
  period: BalanceMetricPeriod;
}

function resolveQuotaWindowDefinition(
  type: string | undefined,
  unit: number,
  number: number | undefined,
): ZhiPuWindowDefinition {
  // The limit type differs across plans and sites (CREDIT_LIMIT and
  // TOKENS_LIMIT both observed), so 5-hour and weekly windows are identified
  // by the unit/number pair alone.
  if (unit === 3 && number === 5) {
    return {
      id: 'zhipu-quota-5-hour',
      label: t('5-hour limit'),
      period: 'custom',
    };
  }
  if (unit === 6) {
    return {
      id: 'zhipu-quota-weekly',
      label: t('Weekly limit'),
      period: 'week',
    };
  }
  if (type === 'TIME_LIMIT' && unit === 5) {
    return { id: 'zhipu-quota-monthly', period: 'month' };
  }
  if (unit === 3) {
    return { id: 'zhipu-quota-hourly', period: 'custom' };
  }
  return { id: `zhipu-quota-unit-${unit}`, period: 'custom' };
}

function parseQuotaWindow(
  limit: Record<string, unknown>,
  definition: ZhiPuWindowDefinition,
): BalanceMetric[] {
  const items: BalanceMetric[] = [];
  const metricContext = {
    period: definition.period,
    ...(definition.label ? { label: definition.label } : {}),
  } as const;

  const percentage = pickNumberLike(limit, 'percentage');
  if (isValidPercent(percentage)) {
    items.push({
      id: `${definition.id}-remaining-percent`,
      type: 'percent',
      ...metricContext,
      // The server reports `percentage` as the used share (currentValue /
      // usage), so store the remaining share for the display layer.
      value: 100 - percentage,
      basis: 'remaining',
    });
  }

  const nextResetTime = pickNumberLike(limit, 'nextResetTime');
  if (isValidTimestamp(nextResetTime)) {
    items.push({
      id: `${definition.id}-reset`,
      type: 'time',
      ...metricContext,
      kind: 'resetAt',
      value: new Date(nextResetTime).toISOString(),
      timestampMs: nextResetTime,
    });
  }

  if (pickString(limit, 'type') === 'TIME_LIMIT') {
    const usage = pickNumberLike(limit, 'usage');
    const currentValue = pickNumberLike(limit, 'currentValue');
    const rawRemaining = pickNumberLike(limit, 'remaining');
    const hasCountQuota = usage !== undefined && usage > 0;
    const remaining =
      hasCountQuota && currentValue !== undefined
        ? rawRemaining !== undefined
          ? Math.max(0, Math.min(usage, rawRemaining))
          : Math.max(0, usage - currentValue)
        : undefined;
    if (
      remaining !== undefined &&
      usage !== undefined &&
      currentValue !== undefined
    ) {
      items.push(
        {
          id: `${definition.id}-remaining`,
          type: 'integer',
          ...metricContext,
          direction: 'remaining',
          value: remaining,
        },
        {
          id: `${definition.id}-used`,
          type: 'integer',
          ...metricContext,
          direction: 'used',
          value: Math.max(0, currentValue),
        },
        {
          id: `${definition.id}-limit`,
          type: 'integer',
          ...metricContext,
          direction: 'limit',
          value: usage,
        },
      );
    }
  }

  return items;
}

export function parseZhiPuQuotaSnapshot(
  value: unknown,
  updatedAt = Date.now(),
): BalanceSnapshot | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const data = value['data'];
  if (!isRecord(data)) {
    return undefined;
  }
  const limits = data['limits'];
  if (!Array.isArray(limits) || limits.length === 0) {
    return undefined;
  }

  const items: BalanceMetric[] = [];
  const seenWindows = new Set<string>();
  for (const limit of limits) {
    if (!isRecord(limit)) {
      continue;
    }
    const unit = pickNumberLike(limit, 'unit');
    if (unit === undefined) {
      continue;
    }
    const windowKey = `${unit}:${pickNumberLike(limit, 'number') ?? ''}`;
    if (seenWindows.has(windowKey)) {
      continue;
    }
    const windowItems = parseQuotaWindow(
      limit,
      resolveQuotaWindowDefinition(
        pickString(limit, 'type'),
        unit,
        pickNumberLike(limit, 'number'),
      ),
    );
    if (windowItems.length === 0) {
      continue;
    }
    seenWindows.add(windowKey);
    items.push(...windowItems);
  }

  if (items.length === 0) {
    return undefined;
  }

  const primaryId =
    items.find(
      (item) =>
        item.type === 'percent' &&
        item.id === 'zhipu-quota-5-hour-remaining-percent',
    )?.id ?? items.find((item) => item.type === 'percent')?.id;

  return {
    updatedAt,
    items: items.map((item) => ({
      ...item,
      ...(item.id === primaryId ? { primary: true } : {}),
    })),
  };
}

export function parseZhiPuBalanceSnapshot(
  value: unknown,
  updatedAt = Date.now(),
): BalanceSnapshot | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const data = value['data'];
  if (!isRecord(data)) {
    return undefined;
  }
  const amount =
    pickNumberLike(data, 'balance') ?? pickNumberLike(data, 'availableBalance');
  if (amount === undefined) {
    return undefined;
  }

  return {
    updatedAt,
    items: [
      {
        id: 'zhipu-balance',
        type: 'amount',
        period: 'current',
        direction: 'remaining',
        value: amount,
        currencySymbol: '¥',
      },
    ],
  };
}

export class ZhiPuBalanceProvider implements BalanceProvider {
  static supportsSensitiveDataInSettings(_config: BalanceConfig): boolean {
    return false;
  }

  static redactForExport(config: BalanceConfig): BalanceConfig {
    return isZhiPuBalanceConfig(config) ? config : { method: 'zhipu' };
  }

  static async resolveForExport(
    config: BalanceConfig,
    _secretStore: SecretStore,
  ): Promise<BalanceConfig> {
    return ZhiPuBalanceProvider.redactForExport(config);
  }

  static async normalizeOnImport(
    config: BalanceConfig,
    _options: {
      secretStore: SecretStore;
      storeSecretsInSettings: boolean;
      existing?: BalanceConfig;
    },
  ): Promise<BalanceConfig> {
    return ZhiPuBalanceProvider.redactForExport(config);
  }

  static async prepareForDuplicate(
    config: BalanceConfig,
    _options: { secretStore: SecretStore; storeSecretsInSettings: boolean },
  ): Promise<BalanceConfig> {
    return ZhiPuBalanceProvider.redactForExport(config);
  }

  get definition(): BalanceProviderDefinition {
    return {
      id: 'zhipu',
      label: t('ZhiPu Balance'),
      description: t('Monitor ZhiPu Coding Plan quota and PayGo balance'),
    };
  }

  private config: BalanceConfig;

  constructor(
    private readonly context: BalanceProviderContext,
    config?: BalanceConfig,
  ) {
    this.config = isZhiPuBalanceConfig(config) ? config : { method: 'zhipu' };
  }

  getConfig(): BalanceConfig | undefined {
    return this.config;
  }

  async configure(): Promise<BalanceConfigureResult> {
    const next: BalanceConfig = { method: 'zhipu' };
    this.config = next;
    await this.context.persistBalanceConfig?.(next);
    return { success: true, config: next };
  }

  async refresh(input: BalanceRefreshInput): Promise<BalanceRefreshResult> {
    const apiKey = getToken(input.credential);
    if (!apiKey) {
      return {
        success: false,
        error: t('API key is required to query {0} balance.', 'ZhiPu'),
      };
    }

    const logger = createSimpleHttpLogger({
      purpose: 'Balance refresh',
      providerName: input.provider.name,
      providerType: input.provider.type,
    });

    const queryEndpoint = async (
      endpoint: string,
      parseSnapshot: (value: unknown) => BalanceSnapshot | undefined,
    ): Promise<BalanceRefreshResult> => {
      try {
        const response = await fetchWithRetry(endpoint, {
          method: 'GET',
          headers: {
            Authorization: apiKey,
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
              parseErrorMessage(text) ||
              t(
                'Failed to query {0} balance (HTTP {1}).',
                'ZhiPu',
                `${response.status}`,
              ),
          };
        }

        const json: unknown = await response.json().catch(() => undefined);
        if (!isRecord(json)) {
          return {
            success: false,
            error: t('Unexpected {0} balance response.', 'ZhiPu'),
          };
        }

        if (json['success'] !== true || pickNumberLike(json, 'code') !== 200) {
          const message = pickString(json, 'msg')?.trim();
          return {
            success: false,
            error: message || t('Unexpected {0} balance response.', 'ZhiPu'),
          };
        }

        const snapshot = parseSnapshot(json);
        if (!snapshot) {
          return {
            success: false,
            error: t('Unexpected {0} balance response.', 'ZhiPu'),
          };
        }

        return { success: true, snapshot };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    };

    const quotaResult = await queryEndpoint(
      resolveZhiPuQuotaEndpoint(input.provider.baseUrl),
      parseZhiPuQuotaSnapshot,
    );
    const balanceResult = await queryEndpoint(
      resolveZhiPuBalanceEndpoint(input.provider.baseUrl),
      parseZhiPuBalanceSnapshot,
    );

    if (
      quotaResult.success &&
      balanceResult.success &&
      quotaResult.snapshot &&
      balanceResult.snapshot
    ) {
      return {
        success: true,
        snapshot: {
          updatedAt: Math.max(
            quotaResult.snapshot.updatedAt,
            balanceResult.snapshot.updatedAt,
          ),
          items: [
            ...quotaResult.snapshot.items,
            ...balanceResult.snapshot.items,
          ],
        },
      };
    }
    if (quotaResult.success) {
      return quotaResult;
    }
    if (balanceResult.success) {
      return balanceResult;
    }
    return quotaResult;
  }
}

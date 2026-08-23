import { t } from '../../i18n';
import { createSimpleHttpLogger } from '../../logger';
import { getToken } from '../../client/utils';
import { fetchWithRetry } from '../../utils';
import type { SecretStore } from '../../secret';
import type {
  BalanceConfig,
  BalanceMetric,
  BalanceRefreshInput,
  BalanceRefreshResult,
  BalanceSnapshot,
} from '../types';
import { isMiniMaxBalanceConfig } from '../types';
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

const MINIMAX_TOKEN_PLAN_PATH = '/v1/token_plan/remains';
const MINIMAX_CODING_PLAN_PATH = '/v1/api/openplatform/coding_plan/remains';
// Match the MiniMax CLI ceiling so boosted quota text stays readable.
const MINIMAX_WEEKLY_PERCENT_DISPLAY_MAXIMUM = 200;
const MINIMAX_GLOBAL_HOSTS = new Set([
  'minimax.io',
  'api.minimax.io',
  'platform.minimax.io',
  'www.minimax.io',
]);
const MINIMAX_CHINA_HOSTS = new Set([
  'minimaxi.com',
  'api.minimaxi.com',
  'platform.minimaxi.com',
  'www.minimaxi.com',
]);

export function resolveMiniMaxTokenPlanEndpoint(baseUrl: string): string {
  const base = new URL(baseUrl);
  const hostname = base.hostname.toLowerCase();
  if (MINIMAX_GLOBAL_HOSTS.has(hostname)) {
    return new URL(
      MINIMAX_TOKEN_PLAN_PATH,
      'https://www.minimax.io',
    ).toString();
  }
  if (MINIMAX_CHINA_HOSTS.has(hostname)) {
    return new URL(
      MINIMAX_TOKEN_PLAN_PATH,
      'https://www.minimaxi.com',
    ).toString();
  }
  return new URL(MINIMAX_TOKEN_PLAN_PATH, base).toString();
}

export function resolveMiniMaxCodingPlanEndpoint(baseUrl: string): string {
  return new URL(MINIMAX_CODING_PLAN_PATH, baseUrl).toString();
}

function isValidPercent(value: number | undefined): value is number {
  return value !== undefined && value >= 0 && value <= 100;
}

function isValidTimestamp(value: number | undefined): value is number {
  return value !== undefined && value > 0;
}

function hasQuotaWindow(model: Record<string, unknown>): boolean {
  const intervalPercent = pickNumberLike(
    model,
    'current_interval_remaining_percent',
  );
  const weeklyPercent = pickNumberLike(
    model,
    'current_weekly_remaining_percent',
  );
  const intervalTotal = pickNumberLike(model, 'current_interval_total_count');
  const weeklyTotal = pickNumberLike(model, 'current_weekly_total_count');
  return (
    isValidPercent(intervalPercent) ||
    isValidPercent(weeklyPercent) ||
    (intervalTotal !== undefined && intervalTotal > 0) ||
    (weeklyTotal !== undefined && weeklyTotal > 0)
  );
}

function isUnavailableQuotaModel(model: Record<string, unknown>): boolean {
  return (
    pickNumberLike(model, 'current_interval_total_count') === 0 &&
    pickNumberLike(model, 'current_weekly_total_count') === 0 &&
    pickNumberLike(model, 'current_interval_status') === 3 &&
    pickNumberLike(model, 'current_weekly_status') === 3
  );
}

function isCodingQuotaModel(model: Record<string, unknown>): boolean {
  const name = pickString(model, 'model_name')?.trim().toLowerCase();
  if (!name) {
    return false;
  }
  return (
    name === 'general' ||
    name === 'text' ||
    name.startsWith('minimax-') ||
    name.startsWith('minimax_m')
  );
}

function hasFiveHourWindow(model: Record<string, unknown>): boolean {
  const startTime = pickNumberLike(model, 'start_time');
  const endTime = pickNumberLike(model, 'end_time');
  if (startTime === undefined || endTime === undefined) {
    return false;
  }
  const durationMs = endTime - startTime;
  return (
    durationMs >= 4 * 60 * 60 * 1000 &&
    durationMs <= 6 * 60 * 60 * 1000
  );
}

function pickTokenPlanModel(
  modelRemains: unknown[],
): Record<string, unknown> | undefined {
  const models = modelRemains
    .filter(isRecord)
    .filter((model) => !isUnavailableQuotaModel(model));
  return (
    models.find((model) => isCodingQuotaModel(model) && hasQuotaWindow(model)) ??
    models.find((model) => hasFiveHourWindow(model) && hasQuotaWindow(model)) ??
    models.find(hasQuotaWindow)
  );
}

interface MiniMaxWindowDefinition {
  id: string;
  label: string;
  period: 'custom' | 'week';
  totalKey: string;
  remainingKey: string;
  remainingPercentKey: string;
  endTimeKey: string;
  statusKey: string;
  boostPermilleKey?: string;
}

function parseTokenPlanWindow(
  model: Record<string, unknown>,
  definition: MiniMaxWindowDefinition,
): BalanceMetric[] {
  const items: BalanceMetric[] = [];
  const total = pickNumberLike(model, definition.totalKey);
  const rawRemaining = pickNumberLike(model, definition.remainingKey);
  const rawRemainingPercent = pickNumberLike(
    model,
    definition.remainingPercentKey,
  );
  const endTime = pickNumberLike(model, definition.endTimeKey);
  const status = pickNumberLike(model, definition.statusKey);
  const boostPermille = definition.boostPermilleKey
    ? pickNumberLike(model, definition.boostPermilleKey)
    : undefined;
  const hasCountQuota = total !== undefined && total > 0;
  const remaining =
    hasCountQuota && rawRemaining !== undefined
      ? Math.max(0, Math.min(total, rawRemaining))
      : undefined;
  const remainingPercent = isValidPercent(rawRemainingPercent)
    ? rawRemainingPercent
    : remaining !== undefined && total !== undefined
      ? (remaining / total) * 100
      : undefined;
  const boostedRemainingPercent =
    remainingPercent !== undefined && boostPermille !== undefined
      ? Math.min(
          MINIMAX_WEEKLY_PERCENT_DISPLAY_MAXIMUM,
          remainingPercent * (Math.max(0, boostPermille) / 1000),
        )
      : remainingPercent;
  const isUnlimited = status === 3;
  const metricContext = {
    period: definition.period,
    label: definition.label,
  } as const;

  if (!isUnlimited && remaining !== undefined && total !== undefined) {
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
        value: Math.max(0, total - remaining),
      },
      {
        id: `${definition.id}-limit`,
        type: 'integer',
        ...metricContext,
        direction: 'limit',
        value: total,
      },
    );
  }

  if (isUnlimited) {
    items.push({
      id: `${definition.id}-status`,
      type: 'status',
      ...metricContext,
      value: 'unlimited',
    });
  } else if (boostedRemainingPercent !== undefined) {
    items.push({
      id: `${definition.id}-remaining-percent`,
      type: 'percent',
      ...metricContext,
      value: boostedRemainingPercent,
      basis: 'remaining',
      ...(boostedRemainingPercent > 100
        ? { displayMaximum: MINIMAX_WEEKLY_PERCENT_DISPLAY_MAXIMUM }
        : {}),
    });
  } else if (status === 2) {
    items.push({
      id: `${definition.id}-status`,
      type: 'status',
      ...metricContext,
      value: 'exhausted',
    });
  }

  if (items.length > 0 && isValidTimestamp(endTime)) {
    items.push({
      id: `${definition.id}-reset`,
      type: 'time',
      ...metricContext,
      kind: 'resetAt',
      value: new Date(endTime).toISOString(),
      timestampMs: endTime,
    });
  }

  return items;
}

export function parseMiniMaxTokenPlanSnapshot(
  value: unknown,
  updatedAt = Date.now(),
): BalanceSnapshot | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const modelRemains = value['model_remains'];
  if (!Array.isArray(modelRemains) || modelRemains.length === 0) {
    return undefined;
  }
  const model = pickTokenPlanModel(modelRemains);
  if (!model) {
    return undefined;
  }

  const intervalItems = parseTokenPlanWindow(model, {
    id: 'minimax-token-plan-5-hour',
    label: t('5-hour limit'),
    period: 'custom',
    totalKey: 'current_interval_total_count',
    remainingKey: 'current_interval_usage_count',
    remainingPercentKey: 'current_interval_remaining_percent',
    endTimeKey: 'end_time',
    statusKey: 'current_interval_status',
  });
  const weeklyItems = parseTokenPlanWindow(model, {
    id: 'minimax-token-plan-weekly',
    label: t('Weekly limit'),
    period: 'week',
    totalKey: 'current_weekly_total_count',
    remainingKey: 'current_weekly_usage_count',
    remainingPercentKey: 'current_weekly_remaining_percent',
    endTimeKey: 'weekly_end_time',
    statusKey: 'current_weekly_status',
    boostPermilleKey: 'weekly_boost_permille',
  });
  const items = [...intervalItems, ...weeklyItems];
  if (items.length === 0) {
    return undefined;
  }

  const primaryId =
    intervalItems.find((item) => item.type === 'percent')?.id ??
    intervalItems.find(
      (item) => item.type === 'integer' && item.direction === 'remaining',
    )?.id ??
    intervalItems[0]?.id ??
    weeklyItems[0]?.id;

  return {
    updatedAt,
    items: items.map((item) => ({
      ...item,
      primary: item.id === primaryId,
    })),
  };
}

export function parseMiniMaxCodingPlanSnapshot(
  value: unknown,
  updatedAt = Date.now(),
): BalanceSnapshot | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const modelRemains = value['model_remains'];
  if (!Array.isArray(modelRemains) || modelRemains.length === 0) {
    return undefined;
  }
  const firstModel = modelRemains[0];
  if (!isRecord(firstModel)) {
    return undefined;
  }

  const totalCount = pickNumberLike(
    firstModel,
    'current_interval_total_count',
  );
  const currentIntervalRemainingCount = pickNumberLike(
    firstModel,
    'current_interval_usage_count',
  );
  const endTime = pickNumberLike(firstModel, 'end_time');
  if (
    totalCount === undefined ||
    currentIntervalRemainingCount === undefined ||
    endTime === undefined
  ) {
    return undefined;
  }

  const usedCount = Math.max(0, totalCount - currentIntervalRemainingCount);
  const usedPercent =
    totalCount > 0
      ? Math.max(0, Math.min(100, (usedCount / totalCount) * 100))
      : 0;

  return {
    updatedAt,
    items: [
      {
        id: 'minimax-requests',
        type: 'integer',
        period: 'current',
        direction: 'used',
        value: usedCount,
        primary: true,
      },
      {
        id: 'minimax-requests-limit',
        type: 'integer',
        period: 'current',
        direction: 'limit',
        value: totalCount,
      },
      {
        id: 'minimax-used-percent',
        type: 'percent',
        period: 'current',
        value: usedPercent,
        basis: 'used',
      },
      {
        id: 'minimax-period-end',
        type: 'time',
        period: 'current',
        kind: 'resetAt',
        value: new Date(endTime).toISOString(),
        timestampMs: endTime,
      },
    ],
  };
}

export class MiniMaxBalanceProvider implements BalanceProvider {
  static supportsSensitiveDataInSettings(_config: BalanceConfig): boolean {
    return false;
  }

  static redactForExport(config: BalanceConfig): BalanceConfig {
    return isMiniMaxBalanceConfig(config)
      ? config
      : { method: 'minimax' };
  }

  static async resolveForExport(
    config: BalanceConfig,
    _secretStore: SecretStore,
  ): Promise<BalanceConfig> {
    return MiniMaxBalanceProvider.redactForExport(config);
  }

  static async normalizeOnImport(
    config: BalanceConfig,
    _options: {
      secretStore: SecretStore;
      storeSecretsInSettings: boolean;
      existing?: BalanceConfig;
    },
  ): Promise<BalanceConfig> {
    return MiniMaxBalanceProvider.redactForExport(config);
  }

  static async prepareForDuplicate(
    config: BalanceConfig,
    _options: { secretStore: SecretStore; storeSecretsInSettings: boolean },
  ): Promise<BalanceConfig> {
    return MiniMaxBalanceProvider.redactForExport(config);
  }

  get definition(): BalanceProviderDefinition {
    return {
      id: 'minimax',
      label: t('MiniMax Balance'),
      description: t('Monitor MiniMax Token Plan and Coding Plan quotas'),
    };
  }

  private config: BalanceConfig;

  constructor(
    private readonly context: BalanceProviderContext,
    config?: BalanceConfig,
  ) {
    this.config = isMiniMaxBalanceConfig(config)
      ? config
      : { method: 'minimax' };
  }

  getConfig(): BalanceConfig | undefined {
    return this.config;
  }

  async configure(): Promise<BalanceConfigureResult> {
    const next: BalanceConfig = { method: 'minimax' };
    this.config = next;
    await this.context.persistBalanceConfig?.(next);
    return { success: true, config: next };
  }

  async refresh(input: BalanceRefreshInput): Promise<BalanceRefreshResult> {
    const apiKey = getToken(input.credential);
    if (!apiKey) {
      return {
        success: false,
        error: t('API key is required to query {0} balance.', 'MiniMax'),
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
              parseErrorMessage(text) ||
              t(
                'Failed to query {0} balance (HTTP {1}).',
                'MiniMax',
                `${response.status}`,
              ),
          };
        }

        const json: unknown = await response.json().catch(() => undefined);
        if (!isRecord(json)) {
          return {
            success: false,
            error: t('Unexpected {0} balance response.', 'MiniMax'),
          };
        }

        const baseResp = json['base_resp'];
        if (isRecord(baseResp)) {
          const statusCode = pickNumberLike(baseResp, 'status_code');
          if (statusCode !== undefined && statusCode !== 0) {
            const statusMsg = pickString(baseResp, 'status_msg')?.trim();
            return {
              success: false,
              error:
                statusMsg || t('Unexpected {0} balance response.', 'MiniMax'),
            };
          }
        }

        const snapshot = parseSnapshot(json);
        if (!snapshot) {
          return {
            success: false,
            error: t('Unexpected {0} balance response.', 'MiniMax'),
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

    const tokenPlanResult = await queryEndpoint(
      resolveMiniMaxTokenPlanEndpoint(input.provider.baseUrl),
      parseMiniMaxTokenPlanSnapshot,
    );
    if (tokenPlanResult.success) {
      return tokenPlanResult;
    }

    const codingPlanResult = await queryEndpoint(
      resolveMiniMaxCodingPlanEndpoint(input.provider.baseUrl),
      parseMiniMaxCodingPlanSnapshot,
    );
    return codingPlanResult.success ? codingPlanResult : tokenPlanResult;
  }
}

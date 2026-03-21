import { t } from '../../i18n';
import { createSimpleHttpLogger } from '../../logger';
import { getToken } from '../../client/utils';
import { fetchWithRetry } from '../../utils';
import type { SecretStore } from '../../secret';
import type {
  BalanceConfig,
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

const MINIMAX_BALANCE_PATH = '/v1/api/openplatform/coding_plan/remains';

function resolveMiniMaxBalanceEndpoint(baseUrl: string): string {
  return new URL(MINIMAX_BALANCE_PATH, baseUrl).toString();
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
      description: t('Monitor balance via MiniMax coding plan API'),
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

    try {
      const balanceEndpoint = resolveMiniMaxBalanceEndpoint(input.provider.baseUrl);
      const response = await fetchWithRetry(balanceEndpoint, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          Accept: 'application/json',
        },
        logger,
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
            error: statusMsg || t('Unexpected {0} balance response.', 'MiniMax'),
          };
        }
      }

      const modelRemains = json['model_remains'];
      if (!Array.isArray(modelRemains) || modelRemains.length === 0) {
        return {
          success: false,
          error: t('Unexpected {0} balance response.', 'MiniMax'),
        };
      }

      // Use the first entry since all models have the same interval data.
      const firstModel = modelRemains[0];
      if (!isRecord(firstModel)) {
        return {
          success: false,
          error: t('Unexpected {0} balance response.', 'MiniMax'),
        };
      }

      const totalCount = pickNumberLike(
        firstModel,
        'current_interval_total_count',
      );
      const currentIntervalUsageCount = pickNumberLike(
        firstModel,
        'current_interval_usage_count',
      );
      const endTime = pickNumberLike(firstModel, 'end_time');
      if (
        totalCount === undefined ||
        currentIntervalUsageCount === undefined ||
        endTime === undefined
      ) {
        return {
          success: false,
          error: t('Unexpected {0} balance response.', 'MiniMax'),
        };
      }

      // MiniMax's current_interval_usage_count is remaining quota for the current interval.
      const usedCount = Math.max(0, totalCount - currentIntervalUsageCount);

      const usedPercent = totalCount > 0
        ? Math.max(0, Math.min(100, (usedCount / totalCount) * 100))
        : 0;

      const snapshot: BalanceSnapshot = {
        updatedAt: Date.now(),
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

      return {
        success: true,
        snapshot,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

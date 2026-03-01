import { t } from '../../i18n';
import { createSimpleHttpLogger } from '../../logger';
import { getToken } from '../../client/utils';
import { fetchWithRetry } from '../../utils';
import type { SecretStore } from '../../secret';
import type {
  BalanceConfig,
  BalanceRefreshInput,
  BalanceRefreshResult,
  BalanceMetric,
  BalanceAmountMetric,
} from '../types';
import { isSyntheticBalanceConfig } from '../types';
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

export class SyntheticBalanceProvider implements BalanceProvider {
  static supportsSensitiveDataInSettings(_config: BalanceConfig): boolean {
    return false;
  }

  static redactForExport(config: BalanceConfig): BalanceConfig {
    return isSyntheticBalanceConfig(config)
      ? config
      : { method: 'synthetic' };
  }

  static async resolveForExport(
    config: BalanceConfig,
    _secretStore: SecretStore,
  ): Promise<BalanceConfig> {
    return SyntheticBalanceProvider.redactForExport(config);
  }

  static async normalizeOnImport(
    config: BalanceConfig,
    _options: {
      secretStore: SecretStore;
      storeSecretsInSettings: boolean;
      existing?: BalanceConfig;
    },
  ): Promise<BalanceConfig> {
    return SyntheticBalanceProvider.redactForExport(config);
  }

  static async prepareForDuplicate(
    config: BalanceConfig,
    _options: { secretStore: SecretStore; storeSecretsInSettings: boolean },
  ): Promise<BalanceConfig> {
    return SyntheticBalanceProvider.redactForExport(config);
  }

  get definition(): BalanceProviderDefinition {
    return {
      id: 'synthetic',
      label: t('Synthetic.new Quota'),
      description: t('Monitor subscription and tool usage quotas via Synthetic API'),
    };
  }

  private config: BalanceConfig;

  constructor(
    private readonly context: BalanceProviderContext,
    config?: BalanceConfig,
  ) {
    this.config = isSyntheticBalanceConfig(config)
      ? config
      : { method: 'synthetic' };
  }

  getConfig(): BalanceConfig | undefined {
    return this.config;
  }

  async configure(): Promise<BalanceConfigureResult> {
    const next: BalanceConfig = { method: 'synthetic' };
    this.config = next;
    await this.context.persistBalanceConfig?.(next);
    return { success: true, config: next };
  }

  async refresh(input: BalanceRefreshInput): Promise<BalanceRefreshResult> {
    const apiKey = getToken(input.credential);
    if (!apiKey) {
      return {
        success: false,
        error: t('API key is required to query {0} balance.', 'Synthetic.new'),
      };
    }

    const logger = createSimpleHttpLogger({
      purpose: 'Balance refresh',
      providerName: input.provider.name,
      providerType: input.provider.type,
    });

    const endpoint = 'https://api.synthetic.new/v2/quotas';

    try {
      const response = await fetchWithRetry(endpoint, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
        logger,
      });

      if (!response.ok) {
        return {
          success: false,
          error: t(
            'Failed to query {0} balance (HTTP {1}).',
            'Synthetic.new',
            `${response.status}`,
          ),
        };
      }

      const json: unknown = await response.json().catch(() => undefined);
      if (!isRecord(json)) {
        return {
          success: false,
          error: t('Unexpected {0} balance response.', 'Synthetic.new'),
        };
      }

      const items: BalanceMetric[] = [];

      // Subscription (Primary)
      const sub = json['subscription'];
      if (isRecord(sub)) {
        const limit = pickNumberLike(sub, 'limit');
        const requests = pickNumberLike(sub, 'requests');
        const renewsAt = pickString(sub, 'renewsAt');

        if (limit !== undefined && requests !== undefined) {
          items.push({
            id: 'subscription-quota',
            type: 'amount',
            direction: 'used',
            period: 'custom',
            periodLabel: t('Subscription'),
            primary: true,
            label: t('Subscription Requests'),
            value: requests,
            limit: limit,
          } as BalanceAmountMetric);
        }
        if (renewsAt) {
          items.push({
            id: 'subscription-renews',
            type: 'time',
            period: 'custom',
            kind: 'resetAt',
            label: t('Subscription Renews'),
            value: renewsAt,
            timestampMs: Date.parse(renewsAt),
          });
        }
      }

      // Search
      const search = json['search'];
      if (isRecord(search)) {
        const hourly = search['hourly'];
        if (isRecord(hourly)) {
          const limit = pickNumberLike(hourly, 'limit');
          const requests = pickNumberLike(hourly, 'requests');
          if (limit !== undefined && requests !== undefined) {
            items.push({
              id: 'search-hourly-quota',
              type: 'amount',
              direction: 'used',
              period: 'day',
              periodLabel: t('Hourly'),
              label: t('Web Search'),
              value: requests,
              limit: limit,
            } as BalanceAmountMetric);
          }
        }
      }

      // Free Tool Calls
      const freeToolCalls = json['freeToolCalls'];
      if (isRecord(freeToolCalls)) {
        const limit = pickNumberLike(freeToolCalls, 'limit');
        const requests = pickNumberLike(freeToolCalls, 'requests');
        if (limit !== undefined && requests !== undefined) {
          items.push({
            id: 'free-tool-calls-quota',
            type: 'amount',
            direction: 'used',
            period: 'day',
            periodLabel: t('Free'),
            label: t('Free Tool Calls'),
            value: requests,
            limit: limit,
          } as BalanceAmountMetric);
        }
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

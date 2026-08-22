import { t } from '../../i18n';
import { createSimpleHttpLogger } from '../../logger';
import { getToken } from '../../client/utils';
import { fetchWithRetry, normalizeBaseUrlInput } from '../../utils';
import type { SecretStore } from '../../secret';
import type {
  BalanceConfig,
  BalanceRefreshInput,
  BalanceRefreshResult,
} from '../types';
import { isDeepSeekBalanceConfig } from '../types';
import type {
  BalanceConfigureResult,
  BalanceProvider,
  BalanceProviderContext,
  BalanceProviderDefinition,
} from '../balance-provider';

type DeepSeekBalanceItem = {
  currency: string;
  total: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function pickBoolean(
  record: Record<string, unknown>,
  key: string,
): boolean | undefined {
  const value = record[key];
  return typeof value === 'boolean' ? value : undefined;
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

function getCurrencySymbol(currency: string): string | undefined {
  if (currency === 'USD') {
    return '$';
  }
  if (currency === 'CNY') {
    return '¥';
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

function parseBalances(body: Record<string, unknown>): DeepSeekBalanceItem[] {
  const payload = isRecord(body['data']) ? body['data'] : body;
  const rawItems = payload['balance_infos'];
  if (!Array.isArray(rawItems)) {
    return [];
  }

  const balances: DeepSeekBalanceItem[] = [];
  for (const item of rawItems) {
    if (!isRecord(item)) {
      continue;
    }

    const currency = pickString(item, 'currency') ?? 'CNY';
    const toppedUp = pickNumberLike(item, 'topped_up_balance') ?? 0;
    const granted = pickNumberLike(item, 'granted_balance') ?? 0;
    const total = pickNumberLike(item, 'total_balance') ?? toppedUp + granted;

    balances.push({
      currency,
      total,
    });
  }

  return balances;
}

function pickPrimaryBalance(
  balances: readonly DeepSeekBalanceItem[],
): DeepSeekBalanceItem | undefined {
  return (
    balances.find((item) => item.currency === 'CNY') ??
    balances.find((item) => item.currency === 'USD') ??
    balances[0]
  );
}

export class DeepSeekBalanceProvider implements BalanceProvider {
  static supportsSensitiveDataInSettings(_config: BalanceConfig): boolean {
    return false;
  }

  static redactForExport(config: BalanceConfig): BalanceConfig {
    return isDeepSeekBalanceConfig(config) ? config : { method: 'deepseek' };
  }

  static async resolveForExport(
    config: BalanceConfig,
    _secretStore: SecretStore,
  ): Promise<BalanceConfig> {
    return DeepSeekBalanceProvider.redactForExport(config);
  }

  static async normalizeOnImport(
    config: BalanceConfig,
    _options: {
      secretStore: SecretStore;
      storeSecretsInSettings: boolean;
      existing?: BalanceConfig;
    },
  ): Promise<BalanceConfig> {
    return DeepSeekBalanceProvider.redactForExport(config);
  }

  static async prepareForDuplicate(
    config: BalanceConfig,
    _options: { secretStore: SecretStore; storeSecretsInSettings: boolean },
  ): Promise<BalanceConfig> {
    return DeepSeekBalanceProvider.redactForExport(config);
  }

  get definition(): BalanceProviderDefinition {
    return {
      id: 'deepseek',
      label: t('DeepSeek Balance'),
      description: t('Monitor balance via DeepSeek user balance API'),
    };
  }

  private config: BalanceConfig;

  constructor(
    private readonly context: BalanceProviderContext,
    config?: BalanceConfig,
  ) {
    this.config = isDeepSeekBalanceConfig(config) ? config : { method: 'deepseek' };
  }

  getConfig(): BalanceConfig | undefined {
    return this.config;
  }

  async configure(): Promise<BalanceConfigureResult> {
    const next: BalanceConfig = { method: 'deepseek' };
    this.config = next;
    await this.context.persistBalanceConfig?.(next);
    return { success: true, config: next };
  }

  async refresh(input: BalanceRefreshInput): Promise<BalanceRefreshResult> {
    const apiKey = getToken(input.credential);
    if (!apiKey) {
      return {
        success: false,
        error: t('API key is required to query {0} balance.', 'DeepSeek'),
      };
    }

    const logger = createSimpleHttpLogger({
      purpose: 'Balance refresh',
      providerName: input.provider.name,
      providerType: input.provider.type,
    });

    const baseUrl = normalizeBaseUrlInput(input.provider.baseUrl);
    const endpoint = baseUrl.toLowerCase().endsWith('/v1')
      ? new URL('user/balance', `${baseUrl}/`).toString()
      : new URL('/v1/user/balance', `${baseUrl}/`).toString();

    try {
      const response = await fetchWithRetry(endpoint, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          Accept: 'application/json',
        },
        logger,
        ignoreSSLErrors: input.provider.ignoreSSLErrors,
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
              'DeepSeek',
              `${response.status}`,
            ),
        };
      }

      const json: unknown = await response.json().catch(() => undefined);
      if (!isRecord(json)) {
        return {
          success: false,
          error: t('Unexpected {0} balance response.', 'DeepSeek'),
        };
      }

      const isAvailable = pickBoolean(json, 'is_available');
      if (isAvailable === false) {
        return {
          success: false,
          error: t('Unexpected {0} balance response.', 'DeepSeek'),
        };
      }

      const balances = parseBalances(json);
      const primary = pickPrimaryBalance(balances);
      if (!primary) {
        return {
          success: false,
          error: t('Unexpected {0} balance response.', 'DeepSeek'),
        };
      }

      const items = balances
        .filter((item) => Number.isFinite(item.total))
        .map((item) => {
          const currencySymbol = getCurrencySymbol(item.currency);
          const isPrimary =
            item.currency === primary.currency && item.total === primary.total;

          return {
            id: `balance-current-${item.currency.toLowerCase()}`,
            type: 'amount' as const,
            period: 'current' as const,
            direction: 'remaining' as const,
            value: item.total,
            ...(currencySymbol ? { currencySymbol } : {}),
            ...(isPrimary ? { primary: true } : {}),
            label: t('Balance'),
            scope: item.currency.toUpperCase(),
          };
        });

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

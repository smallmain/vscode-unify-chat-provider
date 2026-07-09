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
import { isLiteLLMBalanceConfig } from '../types';
import type {
  BalanceConfigureResult,
  BalanceProvider,
  BalanceProviderContext,
  BalanceProviderDefinition,
} from '../balance-provider';

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function pickNumber(
  record: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = record[key];
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  return undefined;
}

function pickString(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
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

export class LiteLLMBalanceProvider implements BalanceProvider {
  static supportsSensitiveDataInSettings(_config: BalanceConfig): boolean {
    return false;
  }

  static redactForExport(config: BalanceConfig): BalanceConfig {
    return isLiteLLMBalanceConfig(config) ? config : { method: 'litellm' };
  }

  static async resolveForExport(
    config: BalanceConfig,
    _secretStore: SecretStore,
  ): Promise<BalanceConfig> {
    return LiteLLMBalanceProvider.redactForExport(config);
  }

  static async normalizeOnImport(
    config: BalanceConfig,
    _options: {
      secretStore: SecretStore;
      storeSecretsInSettings: boolean;
      existing?: BalanceConfig;
    },
  ): Promise<BalanceConfig> {
    return LiteLLMBalanceProvider.redactForExport(config);
  }

  static async prepareForDuplicate(
    config: BalanceConfig,
    _options: { secretStore: SecretStore; storeSecretsInSettings: boolean },
  ): Promise<BalanceConfig> {
    return LiteLLMBalanceProvider.redactForExport(config);
  }

  get definition(): BalanceProviderDefinition {
    return {
      id: 'litellm',
      label: t('LiteLLM Budget'),
      description: t('Monitor budget via LiteLLM key info API'),
    };
  }

  private config: BalanceConfig;

  constructor(
    private readonly context: BalanceProviderContext,
    config?: BalanceConfig,
  ) {
    this.config = isLiteLLMBalanceConfig(config) ? config : { method: 'litellm' };
  }

  getConfig(): BalanceConfig | undefined {
    return this.config;
  }

  async configure(): Promise<BalanceConfigureResult> {
    const next: BalanceConfig = { method: 'litellm' };
    this.config = next;
    await this.context.persistBalanceConfig?.(next);
    return { success: true, config: next };
  }

  async refresh(input: BalanceRefreshInput): Promise<BalanceRefreshResult> {
    const apiKey = getToken(input.credential);
    if (!apiKey) {
      return {
        success: false,
        error: t('API key is required to query {0} balance.', 'LiteLLM'),
      };
    }

    const logger = createSimpleHttpLogger({
      purpose: 'Balance refresh',
      providerName: input.provider.name,
      providerType: input.provider.type,
    });

    const baseUrl = normalizeBaseUrlInput(input.provider.baseUrl);
    const endpoint = new URL('/key/info', baseUrl).toString();

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
              'LiteLLM',
              `${response.status}`,
            ),
        };
      }

      const json: unknown = await response.json().catch(() => undefined);
      if (!isRecord(json)) {
        return {
          success: false,
          error: t('Unexpected {0} balance response.', 'LiteLLM'),
        };
      }

      // LiteLLM /key/info returns { key, info, ... }
      // info contains max_budget, spend, etc.
      const info = isRecord(json['info']) ? json['info'] : json;
      const maxBudget = pickNumber(info, 'max_budget');
      const spend = pickNumber(info, 'spend') ?? 0;

      const items = [];

      if (maxBudget !== undefined && maxBudget > 0) {
        const remaining = maxBudget - spend;
        items.push({
          id: 'budget-remaining',
          type: 'amount' as const,
          period: 'current' as const,
          direction: 'remaining' as const,
          value: remaining,
          currencySymbol: '$',
          primary: true,
          label: t('Budget Remaining'),
        });
        items.push({
          id: 'budget-used',
          type: 'amount' as const,
          period: 'current' as const,
          direction: 'used' as const,
          value: spend,
          currencySymbol: '$',
          label: t('Spent'),
        });
        items.push({
          id: 'budget-limit',
          type: 'amount' as const,
          period: 'current' as const,
          direction: 'limit' as const,
          value: maxBudget,
          currencySymbol: '$',
          label: t('Budget Limit'),
        });
      } else {
        // No budget limit set, just report spend
        if (spend > 0) {
          items.push({
            id: 'budget-used',
            type: 'amount' as const,
            period: 'current' as const,
            direction: 'used' as const,
            value: spend,
            currencySymbol: '$',
            primary: true,
            label: t('Spent'),
          });
        } else {
          items.push({
            id: 'budget-status',
            type: 'status' as const,
            period: 'current' as const,
            value: 'unlimited' as const,
            primary: true,
            label: t('Budget'),
            message: t('No budget limit configured'),
          });
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

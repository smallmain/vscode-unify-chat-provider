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
import { isSiliconFlowBalanceConfig } from '../types';
import type {
  BalanceConfigureResult,
  BalanceProvider,
  BalanceProviderContext,
  BalanceProviderDefinition,
} from '../balance-provider';

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

function resolveUserInfoEndpoint(baseUrl: string): string {
  return baseUrl.toLowerCase().endsWith('/v1')
    ? new URL('user/info', `${baseUrl}/`).toString()
    : new URL('/v1/user/info', `${baseUrl}/`).toString();
}

export class SiliconFlowBalanceProvider implements BalanceProvider {
  static supportsSensitiveDataInSettings(_config: BalanceConfig): boolean {
    return false;
  }

  static redactForExport(config: BalanceConfig): BalanceConfig {
    return isSiliconFlowBalanceConfig(config)
      ? config
      : { method: 'siliconflow' };
  }

  static async resolveForExport(
    config: BalanceConfig,
    _secretStore: SecretStore,
  ): Promise<BalanceConfig> {
    return SiliconFlowBalanceProvider.redactForExport(config);
  }

  static async normalizeOnImport(
    config: BalanceConfig,
    _options: {
      secretStore: SecretStore;
      storeSecretsInSettings: boolean;
      existing?: BalanceConfig;
    },
  ): Promise<BalanceConfig> {
    return SiliconFlowBalanceProvider.redactForExport(config);
  }

  static async prepareForDuplicate(
    config: BalanceConfig,
    _options: { secretStore: SecretStore; storeSecretsInSettings: boolean },
  ): Promise<BalanceConfig> {
    return SiliconFlowBalanceProvider.redactForExport(config);
  }

  get definition(): BalanceProviderDefinition {
    return {
      id: 'siliconflow',
      label: t('SiliconFlow Balance'),
      description: t('Monitor balance via SiliconFlow user info API'),
    };
  }

  private config: BalanceConfig;

  constructor(
    private readonly context: BalanceProviderContext,
    config?: BalanceConfig,
  ) {
    this.config = isSiliconFlowBalanceConfig(config)
      ? config
      : { method: 'siliconflow' };
  }

  getConfig(): BalanceConfig | undefined {
    return this.config;
  }

  async configure(): Promise<BalanceConfigureResult> {
    const next: BalanceConfig = { method: 'siliconflow' };
    this.config = next;
    await this.context.persistBalanceConfig?.(next);
    return { success: true, config: next };
  }

  async refresh(input: BalanceRefreshInput): Promise<BalanceRefreshResult> {
    const apiKey = getToken(input.credential);
    if (!apiKey) {
      return {
        success: false,
        error: t('API key is required to query {0} balance.', 'SiliconFlow'),
      };
    }

    const logger = createSimpleHttpLogger({
      purpose: 'Balance refresh',
      providerName: input.provider.name,
      providerType: input.provider.type,
    });

    const baseUrl = normalizeBaseUrlInput(input.provider.baseUrl);
    const endpoint = resolveUserInfoEndpoint(baseUrl);

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
              'SiliconFlow',
              `${response.status}`,
            ),
        };
      }

      const json: unknown = await response.json().catch(() => undefined);
      if (!isRecord(json)) {
        return {
          success: false,
          error: t('Unexpected {0} balance response.', 'SiliconFlow'),
        };
      }

      const code = pickNumberLike(json, 'code');
      const status = pickBoolean(json, 'status');
      if (
        (code !== undefined && code !== 20000) ||
        (status !== undefined && !status)
      ) {
        const message = pickString(json, 'message')?.trim();
        return {
          success: false,
          error: message || t('Unexpected {0} balance response.', 'SiliconFlow'),
        };
      }

      const payload = json['data'];
      if (!isRecord(payload)) {
        return {
          success: false,
          error: t('Unexpected {0} balance response.', 'SiliconFlow'),
        };
      }

      const granted = pickNumberLike(payload, 'balance') ?? 0;
      const paid = pickNumberLike(payload, 'chargeBalance') ?? 0;
      const total = pickNumberLike(payload, 'totalBalance') ?? paid + granted;

      return {
        success: true,
        snapshot: {
          updatedAt: Date.now(),
          items: [
            {
              id: 'balance-current',
              type: 'amount',
              period: 'current',
              direction: 'remaining',
              value: total,
              currencySymbol: '¥',
              primary: true,
              label: t('Balance'),
            },
            {
              id: 'charge-current',
              type: 'amount',
              period: 'current',
              direction: 'remaining',
              value: paid,
              currencySymbol: '¥',
              label: t('Charge balance'),
            },
            {
              id: 'granted-current',
              type: 'amount',
              period: 'current',
              direction: 'remaining',
              value: granted,
              currencySymbol: '¥',
              label: t('Granted balance'),
            },
          ],
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

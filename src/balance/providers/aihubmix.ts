import { t } from '../../i18n';
import { createSimpleHttpLogger } from '../../logger';
import { getToken } from '../../client/utils';
import {
  fetchWithRetry,
  getHeaderValueIgnoreCase,
  normalizeBaseUrlInput,
} from '../../utils';
import type { SecretStore } from '../../secret';
import type {
  BalanceMetric,
  BalanceConfig,
  BalanceRefreshInput,
  BalanceRefreshResult,
} from '../types';
import type {
  BalanceConfigureResult,
  BalanceProvider,
  BalanceProviderContext,
  BalanceProviderDefinition,
} from '../balance-provider';

const AIHUBMIX_INFINITE_REMAINING = -0.000002;

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

function parseAiHubMixError(text: string): {
  message?: string;
  quotaExhausted: boolean;
} {
  const normalized = text.trim();
  if (!normalized) {
    return { quotaExhausted: false };
  }

  let message = normalized;
  try {
    const parsed: unknown = JSON.parse(normalized);
    if (isRecord(parsed)) {
      const direct = pickString(parsed, 'message')?.trim();
      if (direct) {
        message = direct;
      }

      const error = parsed['error'];
      if (isRecord(error)) {
        const errorMessage = pickString(error, 'message')?.trim();
        if (errorMessage) {
          message = errorMessage;
        }
      }
    }
  } catch {
    // Keep original text.
  }

  return {
    message,
    quotaExhausted: message.toLowerCase().includes('quota exhausted'),
  };
}

function toAiHubMixConfig(_config: BalanceConfig | undefined): BalanceConfig {
  return { method: 'aihubmix' };
}

function resolveRemainEndpoint(baseUrl: string): string {
  const origin = new URL(`${baseUrl}/`).origin;
  return new URL('/dashboard/billing/remain', `${origin}/`).toString();
}

function buildExhaustedSnapshot(): {
  items: BalanceMetric[];
} {
  return {
    items: [
      {
        id: 'status-current',
        type: 'status',
        period: 'current',
        value: 'exhausted',
        message: t('Exhausted'),
        primary: true,
        label: t('Status'),
      },
    ],
  };
}

function buildUnlimitedSnapshot(): {
  items: BalanceMetric[];
} {
  return {
    items: [
      {
        id: 'status-current',
        type: 'status',
        period: 'current',
        value: 'unlimited',
        primary: true,
        label: t('Status'),
      },
    ],
  };
}

export class AiHubMixBalanceProvider implements BalanceProvider {
  static supportsSensitiveDataInSettings(_config: BalanceConfig): boolean {
    return false;
  }

  static redactForExport(config: BalanceConfig): BalanceConfig {
    return toAiHubMixConfig(config);
  }

  static async resolveForExport(
    config: BalanceConfig,
    _secretStore: SecretStore,
  ): Promise<BalanceConfig> {
    return AiHubMixBalanceProvider.redactForExport(config);
  }

  static async normalizeOnImport(
    config: BalanceConfig,
    _options: {
      secretStore: SecretStore;
      storeSecretsInSettings: boolean;
      existing?: BalanceConfig;
    },
  ): Promise<BalanceConfig> {
    return AiHubMixBalanceProvider.redactForExport(config);
  }

  static async prepareForDuplicate(
    config: BalanceConfig,
    _options: { secretStore: SecretStore; storeSecretsInSettings: boolean },
  ): Promise<BalanceConfig> {
    return AiHubMixBalanceProvider.redactForExport(config);
  }

  get definition(): BalanceProviderDefinition {
    return {
      id: 'aihubmix',
      label: t('AIHubMix Balance'),
      description: t('Monitor balance via AIHubMix remain API'),
    };
  }

  private config: BalanceConfig;

  constructor(
    private readonly context: BalanceProviderContext,
    config?: BalanceConfig,
  ) {
    this.config = toAiHubMixConfig(config);
  }

  getConfig(): BalanceConfig | undefined {
    return this.config;
  }

  async configure(): Promise<BalanceConfigureResult> {
    const next: BalanceConfig = { method: 'aihubmix' };
    this.config = next;
    await this.context.persistBalanceConfig?.(next);
    return { success: true, config: next };
  }

  async refresh(input: BalanceRefreshInput): Promise<BalanceRefreshResult> {
    const apiKey = getToken(input.credential);
    if (!apiKey) {
      return {
        success: false,
        error: t('API key is required to query {0} balance.', 'AIHubMix'),
      };
    }

    const logger = createSimpleHttpLogger({
      purpose: 'Balance refresh',
      providerName: input.provider.name,
      providerType: input.provider.type,
    });

    const baseUrl = normalizeBaseUrlInput(input.provider.baseUrl);
    const endpoint = resolveRemainEndpoint(baseUrl);
    const appCode = input.provider.extraHeaders
      ? getHeaderValueIgnoreCase(input.provider.extraHeaders, 'APP-Code')?.trim()
      : undefined;

    const headers: Record<string, string> = {
      Authorization: `Bearer ${apiKey}`,
      Accept: 'application/json',
    };
    if (appCode) {
      headers['APP-Code'] = appCode;
    }

    try {
      const response = await fetchWithRetry(endpoint, {
        method: 'GET',
        headers,
        logger,
        ignoreSSLErrors: input.provider.ignoreSSLErrors,
        proxy: input.provider.proxy,
      });

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        const parsed = parseAiHubMixError(text);
        if (parsed.quotaExhausted) {
          const snapshot = buildExhaustedSnapshot();
          return {
            success: true,
            snapshot: {
              ...snapshot,
              updatedAt: Date.now(),
            },
          };
        }
        return {
          success: false,
          error:
            parsed.message ||
            t(
              'Failed to query {0} balance (HTTP {1}).',
              'AIHubMix',
              `${response.status}`,
            ),
        };
      }

      const json: unknown = await response.json().catch(() => undefined);
      if (!isRecord(json)) {
        return {
          success: false,
          error: t('Unexpected {0} balance response.', 'AIHubMix'),
        };
      }

      const payload = isRecord(json['data']) ? json['data'] : json;
      const remaining = pickNumberLike(payload, 'total_usage');
      if (remaining === undefined) {
        return {
          success: false,
          error: t('Unexpected {0} balance response.', 'AIHubMix'),
        };
      }

      if (remaining === AIHUBMIX_INFINITE_REMAINING) {
        const snapshot = buildUnlimitedSnapshot();
        return {
          success: true,
          snapshot: {
            ...snapshot,
            updatedAt: Date.now(),
          },
        };
      }

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
              value: remaining,
              currencySymbol: '$',
              primary: true,
              label: t('Balance'),
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

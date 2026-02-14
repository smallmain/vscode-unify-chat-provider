import { t } from '../../i18n';
import { createSimpleHttpLogger } from '../../logger';
import { getToken } from '../../client/utils';
import { fetchWithRetry, normalizeBaseUrlInput } from '../../utils';
import type {
  BalanceConfig,
  BalanceProviderState,
  BalanceRefreshInput,
  BalanceRefreshResult,
  BalanceStatusViewItem,
  BalanceUiStatusSnapshot,
} from '../types';
import {
  isMoonshotAIBalanceConfig,
} from '../types';
import type {
  BalanceConfigureResult,
  BalanceProvider,
  BalanceProviderContext,
  BalanceProviderDefinition,
} from '../balance-provider';
import type { SecretStore } from '../../secret';

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
  return typeof value === 'string' ? value : undefined;
}

function formatNumber(value: number): string {
  return value.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function formatSignedNumber(value: number): string {
  return value < 0 ? `-${formatNumber(Math.abs(value))}` : formatNumber(value);
}

function resolvePayload(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const data = value['data'];
  if (isRecord(data)) {
    return data;
  }
  return value;
}

export class MoonshotAIBalanceProvider implements BalanceProvider {
  static supportsSensitiveDataInSettings(_config: BalanceConfig): boolean {
    return false;
  }

  static redactForExport(config: BalanceConfig): BalanceConfig {
    return isMoonshotAIBalanceConfig(config) ? config : { method: 'moonshot-ai' };
  }

  static async resolveForExport(
    config: BalanceConfig,
    _secretStore: SecretStore,
  ): Promise<BalanceConfig> {
    return MoonshotAIBalanceProvider.redactForExport(config);
  }

  static async normalizeOnImport(
    config: BalanceConfig,
    _options: {
      secretStore: SecretStore;
      storeSecretsInSettings: boolean;
      existing?: BalanceConfig;
    },
  ): Promise<BalanceConfig> {
    return MoonshotAIBalanceProvider.redactForExport(config);
  }

  static async prepareForDuplicate(
    config: BalanceConfig,
    _options: { secretStore: SecretStore; storeSecretsInSettings: boolean },
  ): Promise<BalanceConfig> {
    return MoonshotAIBalanceProvider.redactForExport(config);
  }

  get definition(): BalanceProviderDefinition {
    return {
      id: 'moonshot-ai',
      label: t('Moonshot AI Balance'),
      description: t('Monitor balance via Moonshot balance API'),
    };
  }

  constructor(
    private readonly context: BalanceProviderContext,
    config?: BalanceConfig,
  ) {
    this.config = isMoonshotAIBalanceConfig(config)
      ? config
      : { method: 'moonshot-ai' };
  }

  private config: BalanceConfig;

  getConfig(): BalanceConfig | undefined {
    return this.config;
  }

  async getFieldDetail(
    state: BalanceProviderState | undefined,
  ): Promise<string | undefined> {
    if (state?.snapshot?.summary) {
      return state.snapshot.summary;
    }
    if (state?.lastError) {
      return t('Error: {0}', state.lastError);
    }
    return t('Not refreshed yet');
  }

  async getStatusSnapshot(
    state: BalanceProviderState | undefined,
  ): Promise<BalanceUiStatusSnapshot> {
    if (state?.isRefreshing) {
      return { kind: 'loading' };
    }
    if (state?.lastError) {
      return { kind: 'error', message: state.lastError };
    }
    if (state?.snapshot) {
      return {
        kind: 'valid',
        updatedAt: state.snapshot.updatedAt,
        summary: state.snapshot.summary,
      };
    }
    return { kind: 'not-configured' };
  }

  async getStatusViewItems(options: {
    state: BalanceProviderState | undefined;
    refresh: () => Promise<void>;
  }): Promise<BalanceStatusViewItem[]> {
    const state = options.state;
    const snapshot = state?.snapshot;

    const description = state?.isRefreshing
      ? t('Refreshing...')
      : snapshot
        ? t('Last updated: {0}', new Date(snapshot.updatedAt).toLocaleTimeString())
        : state?.lastError
          ? t('Error')
          : t('No data');

    const details = snapshot?.details?.join(' | ') || state?.lastError || t('Not refreshed yet');

    return [
      {
        label: `$(pulse) ${this.definition.label}`,
        description,
        detail: details,
      },
      {
        label: `$(refresh) ${t('Refresh now')}`,
        description: t('Fetch latest balance info'),
        action: {
          kind: 'inline',
          run: async () => {
            await options.refresh();
          },
        },
      },
    ];
  }

  async configure(): Promise<BalanceConfigureResult> {
    const next: BalanceConfig = { method: 'moonshot-ai' };
    this.config = next;
    await this.context.persistBalanceConfig?.(next);
    return { success: true, config: next };
  }

  async refresh(input: BalanceRefreshInput): Promise<BalanceRefreshResult> {
    const token = getToken(input.credential);
    if (!token) {
      return {
        success: false,
        error: t('API key is required to query Moonshot balance.'),
      };
    }

    const logger = createSimpleHttpLogger({
      purpose: 'Balance refresh',
      providerName: input.provider.name,
      providerType: input.provider.type,
    });

    const endpoint = new URL(
      '/v1/users/me/balance',
      `${normalizeBaseUrlInput(input.provider.baseUrl)}/`,
    ).toString();

    try {
      const response = await fetchWithRetry(endpoint, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
        },
        logger,
      });

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        return {
          success: false,
          error: text.trim() || t('Failed to query Moonshot balance (HTTP {0}).', `${response.status}`),
        };
      }

      const json: unknown = await response.json().catch(() => undefined);
      const body = isRecord(json) ? json : undefined;
      const payload = resolvePayload(json);
      if (!payload) {
        return {
          success: false,
          error: t('Unexpected Moonshot balance response.'),
        };
      }

      const status =
        (body && pickBoolean(body, 'status')) ??
        pickBoolean(payload, 'status');
      const code =
        (body && pickNumberLike(body, 'code')) ??
        pickNumberLike(payload, 'code');
      const scode =
        (body && pickString(body, 'scode')) ??
        pickString(payload, 'scode');

      const isSuccess =
        (status === undefined || status) &&
        (code === undefined || code === 0) &&
        (scode === undefined || scode === '0x0');

      if (!isSuccess) {
        const message =
          (body && pickString(body, 'message')) ??
          pickString(payload, 'message');
        return {
          success: false,
          error: message?.trim() || t('Unexpected Moonshot balance response.'),
        };
      }

      const available =
        pickNumberLike(payload, 'available_balance') ??
        pickNumberLike(payload, 'availableBalance');
      if (available === undefined) {
        return {
          success: false,
          error: t('Unexpected Moonshot balance response.'),
        };
      }

      const summary = t(
        'Balance: {0}',
        `¥${formatSignedNumber(available)}`,
      );
      const details = [summary];
      return {
        success: true,
        snapshot: {
          summary,
          details,
          updatedAt: Date.now(),
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

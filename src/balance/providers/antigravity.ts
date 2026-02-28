import {
  ANTIGRAVITY_DEFAULT_PROJECT_ID,
  CODE_ASSIST_ENDPOINT_FALLBACKS,
  CODE_ASSIST_HEADERS,
} from '../../auth/providers/antigravity-oauth/constants';
import { t } from '../../i18n';
import type { SecretStore } from '../../secret';
import type { ProviderConfig } from '../../types';
import type {
  BalanceConfig,
  BalanceRefreshInput,
  BalanceRefreshResult,
} from '../types';
import { isAntigravityBalanceConfig } from '../types';
import type {
  BalanceConfigureResult,
  BalanceProvider,
  BalanceProviderContext,
  BalanceProviderDefinition,
} from '../balance-provider';
import { refreshCodeAssistQuota } from './code-assist-quota';

function resolveAntigravityProjectId(provider: ProviderConfig): string {
  const auth = provider.auth;
  if (auth?.method === 'antigravity-oauth') {
    const managedProjectId = auth.managedProjectId?.trim();
    if (managedProjectId) {
      return managedProjectId;
    }

    const projectId = auth.projectId?.trim();
    if (projectId) {
      return projectId;
    }
  }

  return ANTIGRAVITY_DEFAULT_PROJECT_ID;
}

export class AntigravityBalanceProvider implements BalanceProvider {
  static supportsSensitiveDataInSettings(_config: BalanceConfig): boolean {
    return false;
  }

  static redactForExport(config: BalanceConfig): BalanceConfig {
    return isAntigravityBalanceConfig(config)
      ? config
      : { method: 'antigravity' };
  }

  static async resolveForExport(
    config: BalanceConfig,
    _secretStore: SecretStore,
  ): Promise<BalanceConfig> {
    return AntigravityBalanceProvider.redactForExport(config);
  }

  static async normalizeOnImport(
    config: BalanceConfig,
    _options: {
      secretStore: SecretStore;
      storeSecretsInSettings: boolean;
      existing?: BalanceConfig;
    },
  ): Promise<BalanceConfig> {
    return AntigravityBalanceProvider.redactForExport(config);
  }

  static async prepareForDuplicate(
    config: BalanceConfig,
    _options: { secretStore: SecretStore; storeSecretsInSettings: boolean },
  ): Promise<BalanceConfig> {
    return AntigravityBalanceProvider.redactForExport(config);
  }

  get definition(): BalanceProviderDefinition {
    return {
      id: 'antigravity',
      label: t('Antigravity Usage'),
      description: t(
        'Monitor usage percentages via Antigravity retrieveUserQuota API',
      ),
    };
  }

  private config: BalanceConfig;

  constructor(
    private readonly context: BalanceProviderContext,
    config?: BalanceConfig,
  ) {
    this.config = isAntigravityBalanceConfig(config)
      ? config
      : { method: 'antigravity' };
  }

  getConfig(): BalanceConfig | undefined {
    return this.config;
  }

  async configure(): Promise<BalanceConfigureResult> {
    const next: BalanceConfig = { method: 'antigravity' };
    this.config = next;
    await this.context.persistBalanceConfig?.(next);
    return { success: true, config: next };
  }

  async refresh(input: BalanceRefreshInput): Promise<BalanceRefreshResult> {
    return refreshCodeAssistQuota(input, {
      providerName: 'Antigravity',
      endpointFallbacks: CODE_ASSIST_ENDPOINT_FALLBACKS,
      requestHeaders: CODE_ASSIST_HEADERS,
      resolveProjectId: (refreshInput) =>
        resolveAntigravityProjectId(refreshInput.provider),
    });
  }
}

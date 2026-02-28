import { GEMINI_CLI_API_HEADERS, GEMINI_CLI_ENDPOINT_FALLBACKS } from '../../auth/providers/google-gemini-oauth/constants';
import { t } from '../../i18n';
import type { SecretStore } from '../../secret';
import type { ProviderConfig } from '../../types';
import type {
  BalanceConfig,
  BalanceRefreshInput,
  BalanceRefreshResult,
} from '../types';
import { isGeminiCliBalanceConfig } from '../types';
import type {
  BalanceConfigureResult,
  BalanceProvider,
  BalanceProviderContext,
  BalanceProviderDefinition,
} from '../balance-provider';
import { refreshCodeAssistQuota } from './code-assist-quota';

function resolveGeminiCliProjectId(
  provider: ProviderConfig,
): string | undefined {
  const auth = provider.auth;
  if (auth?.method !== 'google-gemini-oauth') {
    return undefined;
  }

  const managedProjectId = auth.managedProjectId?.trim();
  if (managedProjectId) {
    return managedProjectId;
  }

  const projectId = auth.projectId?.trim();
  if (projectId) {
    return projectId;
  }

  return undefined;
}

export class GeminiCliBalanceProvider implements BalanceProvider {
  static supportsSensitiveDataInSettings(_config: BalanceConfig): boolean {
    return false;
  }

  static redactForExport(config: BalanceConfig): BalanceConfig {
    return isGeminiCliBalanceConfig(config)
      ? config
      : { method: 'gemini-cli' };
  }

  static async resolveForExport(
    config: BalanceConfig,
    _secretStore: SecretStore,
  ): Promise<BalanceConfig> {
    return GeminiCliBalanceProvider.redactForExport(config);
  }

  static async normalizeOnImport(
    config: BalanceConfig,
    _options: {
      secretStore: SecretStore;
      storeSecretsInSettings: boolean;
      existing?: BalanceConfig;
    },
  ): Promise<BalanceConfig> {
    return GeminiCliBalanceProvider.redactForExport(config);
  }

  static async prepareForDuplicate(
    config: BalanceConfig,
    _options: { secretStore: SecretStore; storeSecretsInSettings: boolean },
  ): Promise<BalanceConfig> {
    return GeminiCliBalanceProvider.redactForExport(config);
  }

  get definition(): BalanceProviderDefinition {
    return {
      id: 'gemini-cli',
      label: t('Gemini CLI Usage'),
      description: t(
        'Monitor usage percentages via Gemini CLI retrieveUserQuota API',
      ),
    };
  }

  private config: BalanceConfig;

  constructor(
    private readonly context: BalanceProviderContext,
    config?: BalanceConfig,
  ) {
    this.config = isGeminiCliBalanceConfig(config)
      ? config
      : { method: 'gemini-cli' };
  }

  getConfig(): BalanceConfig | undefined {
    return this.config;
  }

  async configure(): Promise<BalanceConfigureResult> {
    const next: BalanceConfig = { method: 'gemini-cli' };
    this.config = next;
    await this.context.persistBalanceConfig?.(next);
    return { success: true, config: next };
  }

  async refresh(input: BalanceRefreshInput): Promise<BalanceRefreshResult> {
    return refreshCodeAssistQuota(input, {
      providerName: 'Gemini CLI',
      endpointFallbacks: GEMINI_CLI_ENDPOINT_FALLBACKS,
      requestHeaders: GEMINI_CLI_API_HEADERS,
      resolveProjectId: (refreshInput) =>
        resolveGeminiCliProjectId(refreshInput.provider),
    });
  }
}

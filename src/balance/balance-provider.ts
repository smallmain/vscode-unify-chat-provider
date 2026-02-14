import type { SecretStore } from '../secret';
import type { AuthManager } from '../auth';
import type {
  BalanceConfig,
  BalanceProviderState,
  BalanceRefreshInput,
  BalanceRefreshResult,
  BalanceStatusViewItem,
  BalanceUiStatusSnapshot,
} from './types';

export interface BalanceProviderDefinition {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
}

export interface BalanceConfigureResult {
  success: boolean;
  config?: BalanceConfig;
  error?: string;
}

export interface BalanceProviderContext {
  providerId: string;
  providerLabel: string;
  secretStore: SecretStore;
  authManager?: AuthManager;
  storeSecretsInSettings?: boolean;
  persistBalanceConfig?: (balanceProvider: BalanceConfig) => Promise<void>;
}

export interface BalanceProvider {
  readonly definition: BalanceProviderDefinition;

  getConfig(): BalanceConfig | undefined;

  getFieldDetail?(state: BalanceProviderState | undefined): Promise<string | undefined>;

  getStatusSnapshot?(
    state: BalanceProviderState | undefined,
  ): Promise<BalanceUiStatusSnapshot>;

  getStatusViewItems?(options: {
    state: BalanceProviderState | undefined;
    refresh: () => Promise<void>;
  }): Promise<BalanceStatusViewItem[]>;

  configure(): Promise<BalanceConfigureResult>;

  refresh(input: BalanceRefreshInput): Promise<BalanceRefreshResult>;

  dispose?(): void;
}

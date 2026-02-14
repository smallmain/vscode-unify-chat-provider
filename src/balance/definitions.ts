import { t } from '../i18n';
import type { SecretStore } from '../secret';
import type { BalanceProvider, BalanceProviderContext } from './balance-provider';
import type { BalanceConfig, BalanceMethod } from './types';
import { MoonshotAIBalanceProvider } from './providers/moonshot-ai';
import { KimiCodeBalanceProvider } from './providers/kimi-code';
import { NewAPIBalanceProvider } from './providers/newapi';

export interface BalanceMethodDefinition {
  id: Exclude<BalanceMethod, 'none'>;
  label: string;
  description?: string;
  category: string;
  ctor: new (
    context: BalanceProviderContext,
    config?: BalanceConfig,
  ) => BalanceProvider;
  supportsSensitiveDataInSettings: (config: BalanceConfig) => boolean;
  redactForExport: (config: BalanceConfig) => BalanceConfig;
  resolveForExport: (
    config: BalanceConfig,
    secretStore: SecretStore,
  ) => Promise<BalanceConfig>;
  normalizeOnImport: (
    config: BalanceConfig,
    options: {
      secretStore: SecretStore;
      storeSecretsInSettings: boolean;
      existing?: BalanceConfig;
    },
  ) => Promise<BalanceConfig>;
  prepareForDuplicate: (
    config: BalanceConfig,
    options: {
      secretStore: SecretStore;
      storeSecretsInSettings: boolean;
    },
  ) => Promise<BalanceConfig>;
  cleanupOnDiscard?: (
    config: BalanceConfig,
    secretStore: SecretStore,
  ) => Promise<void>;
}

export const BALANCE_METHODS = {
  'moonshot-ai': {
    id: 'moonshot-ai',
    label: t('Moonshot AI Balance'),
    description: t('Monitor balance via Moonshot balance API'),
    category: 'General',
    ctor: MoonshotAIBalanceProvider,
    supportsSensitiveDataInSettings:
      MoonshotAIBalanceProvider.supportsSensitiveDataInSettings,
    redactForExport: MoonshotAIBalanceProvider.redactForExport,
    resolveForExport: MoonshotAIBalanceProvider.resolveForExport,
    normalizeOnImport: MoonshotAIBalanceProvider.normalizeOnImport,
    prepareForDuplicate: MoonshotAIBalanceProvider.prepareForDuplicate,
  },
  'kimi-code': {
    id: 'kimi-code',
    label: t('Kimi Code Usage'),
    description: t('Monitor usage and quotas via Kimi Code usages API'),
    category: 'General',
    ctor: KimiCodeBalanceProvider,
    supportsSensitiveDataInSettings:
      KimiCodeBalanceProvider.supportsSensitiveDataInSettings,
    redactForExport: KimiCodeBalanceProvider.redactForExport,
    resolveForExport: KimiCodeBalanceProvider.resolveForExport,
    normalizeOnImport: KimiCodeBalanceProvider.normalizeOnImport,
    prepareForDuplicate: KimiCodeBalanceProvider.prepareForDuplicate,
  },
  newapi: {
    id: 'newapi',
    label: t('New API Balance'),
    description: t('Monitor API key and optional user balance for New API'),
    category: 'General',
    ctor: NewAPIBalanceProvider,
    supportsSensitiveDataInSettings:
      NewAPIBalanceProvider.supportsSensitiveDataInSettings,
    redactForExport: NewAPIBalanceProvider.redactForExport,
    resolveForExport: NewAPIBalanceProvider.resolveForExport,
    normalizeOnImport: NewAPIBalanceProvider.normalizeOnImport,
    prepareForDuplicate: NewAPIBalanceProvider.prepareForDuplicate,
    cleanupOnDiscard: NewAPIBalanceProvider.cleanupOnDiscard,
  },
} as const satisfies Record<
  Exclude<BalanceMethod, 'none'>,
  BalanceMethodDefinition
>;

export function getBalanceMethodDefinition<M extends keyof typeof BALANCE_METHODS>(
  method: M | 'none',
): (typeof BALANCE_METHODS)[M] | undefined {
  return method === 'none' ? undefined : BALANCE_METHODS[method];
}

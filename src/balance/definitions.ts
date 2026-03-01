import { t } from '../i18n';
import type { SecretStore } from '../secret';
import type { BalanceProvider, BalanceProviderContext } from './balance-provider';
import type { BalanceConfig, BalanceMethod } from './types';
import { MoonshotAIBalanceProvider } from './providers/moonshot-ai';
import { KimiCodeBalanceProvider } from './providers/kimi-code';
import { NewAPIBalanceProvider } from './providers/newapi';
import { DeepSeekBalanceProvider } from './providers/deepseek';
import { OpenRouterBalanceProvider } from './providers/openrouter';
import { SiliconFlowBalanceProvider } from './providers/siliconflow';
import { AiHubMixBalanceProvider } from './providers/aihubmix';
import { ClaudeRelayServiceBalanceProvider } from './providers/claude-relay-service';
import { AntigravityBalanceProvider } from './providers/antigravity';
import { GeminiCliBalanceProvider } from './providers/gemini-cli';
import { CodexBalanceProvider } from './providers/codex';
import { SyntheticBalanceProvider } from './providers/synthetic';

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
  deepseek: {
    id: 'deepseek',
    label: t('DeepSeek Balance'),
    description: t('Monitor balance via DeepSeek user balance API'),
    category: 'General',
    ctor: DeepSeekBalanceProvider,
    supportsSensitiveDataInSettings:
      DeepSeekBalanceProvider.supportsSensitiveDataInSettings,
    redactForExport: DeepSeekBalanceProvider.redactForExport,
    resolveForExport: DeepSeekBalanceProvider.resolveForExport,
    normalizeOnImport: DeepSeekBalanceProvider.normalizeOnImport,
    prepareForDuplicate: DeepSeekBalanceProvider.prepareForDuplicate,
  },
  openrouter: {
    id: 'openrouter',
    label: t('OpenRouter Balance'),
    description: t('Monitor balance via OpenRouter credits API'),
    category: 'General',
    ctor: OpenRouterBalanceProvider,
    supportsSensitiveDataInSettings:
      OpenRouterBalanceProvider.supportsSensitiveDataInSettings,
    redactForExport: OpenRouterBalanceProvider.redactForExport,
    resolveForExport: OpenRouterBalanceProvider.resolveForExport,
    normalizeOnImport: OpenRouterBalanceProvider.normalizeOnImport,
    prepareForDuplicate: OpenRouterBalanceProvider.prepareForDuplicate,
  },
  siliconflow: {
    id: 'siliconflow',
    label: t('SiliconFlow Balance'),
    description: t('Monitor balance via SiliconFlow user info API'),
    category: 'General',
    ctor: SiliconFlowBalanceProvider,
    supportsSensitiveDataInSettings:
      SiliconFlowBalanceProvider.supportsSensitiveDataInSettings,
    redactForExport: SiliconFlowBalanceProvider.redactForExport,
    resolveForExport: SiliconFlowBalanceProvider.resolveForExport,
    normalizeOnImport: SiliconFlowBalanceProvider.normalizeOnImport,
    prepareForDuplicate: SiliconFlowBalanceProvider.prepareForDuplicate,
  },
  aihubmix: {
    id: 'aihubmix',
    label: t('AIHubMix Balance'),
    description: t('Monitor balance via AIHubMix remain API'),
    category: 'General',
    ctor: AiHubMixBalanceProvider,
    supportsSensitiveDataInSettings:
      AiHubMixBalanceProvider.supportsSensitiveDataInSettings,
    redactForExport: AiHubMixBalanceProvider.redactForExport,
    resolveForExport: AiHubMixBalanceProvider.resolveForExport,
    normalizeOnImport: AiHubMixBalanceProvider.normalizeOnImport,
    prepareForDuplicate: AiHubMixBalanceProvider.prepareForDuplicate,
  },
  'claude-relay-service': {
    id: 'claude-relay-service',
    label: t('Claude Relay Service Balance'),
    description: t('Monitor balance via Claude Relay Service apiStats APIs'),
    category: 'General',
    ctor: ClaudeRelayServiceBalanceProvider,
    supportsSensitiveDataInSettings:
      ClaudeRelayServiceBalanceProvider.supportsSensitiveDataInSettings,
    redactForExport: ClaudeRelayServiceBalanceProvider.redactForExport,
    resolveForExport: ClaudeRelayServiceBalanceProvider.resolveForExport,
    normalizeOnImport: ClaudeRelayServiceBalanceProvider.normalizeOnImport,
    prepareForDuplicate: ClaudeRelayServiceBalanceProvider.prepareForDuplicate,
  },
  antigravity: {
    id: 'antigravity',
    label: t('Antigravity Usage'),
    description: t(
      'Monitor usage percentages via Antigravity retrieveUserQuota API',
    ),
    category: 'Experimental',
    ctor: AntigravityBalanceProvider,
    supportsSensitiveDataInSettings:
      AntigravityBalanceProvider.supportsSensitiveDataInSettings,
    redactForExport: AntigravityBalanceProvider.redactForExport,
    resolveForExport: AntigravityBalanceProvider.resolveForExport,
    normalizeOnImport: AntigravityBalanceProvider.normalizeOnImport,
    prepareForDuplicate: AntigravityBalanceProvider.prepareForDuplicate,
  },
  'gemini-cli': {
    id: 'gemini-cli',
    label: t('Gemini CLI Usage'),
    description: t(
      'Monitor usage percentages via Gemini CLI retrieveUserQuota API',
    ),
    category: 'Experimental',
    ctor: GeminiCliBalanceProvider,
    supportsSensitiveDataInSettings:
      GeminiCliBalanceProvider.supportsSensitiveDataInSettings,
    redactForExport: GeminiCliBalanceProvider.redactForExport,
    resolveForExport: GeminiCliBalanceProvider.resolveForExport,
    normalizeOnImport: GeminiCliBalanceProvider.normalizeOnImport,
    prepareForDuplicate: GeminiCliBalanceProvider.prepareForDuplicate,
  },
  codex: {
    id: 'codex',
    label: t('Codex Usage'),
    description: t('Monitor usage percentages via Codex usage APIs'),
    category: 'Experimental',
    ctor: CodexBalanceProvider,
    supportsSensitiveDataInSettings:
      CodexBalanceProvider.supportsSensitiveDataInSettings,
    redactForExport: CodexBalanceProvider.redactForExport,
    resolveForExport: CodexBalanceProvider.resolveForExport,
    normalizeOnImport: CodexBalanceProvider.normalizeOnImport,
    prepareForDuplicate: CodexBalanceProvider.prepareForDuplicate,
  },
  synthetic: {
    id: 'synthetic',
    label: t('Synthetic.new Quota'),
    description: t('Monitor subscription and tool usage quotas via Synthetic API'),
    category: 'General',
    ctor: SyntheticBalanceProvider,
    supportsSensitiveDataInSettings:
      SyntheticBalanceProvider.supportsSensitiveDataInSettings,
    redactForExport: SyntheticBalanceProvider.redactForExport,
    resolveForExport: SyntheticBalanceProvider.resolveForExport,
    normalizeOnImport: SyntheticBalanceProvider.normalizeOnImport,
    prepareForDuplicate: SyntheticBalanceProvider.prepareForDuplicate,
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

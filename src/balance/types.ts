import type { AuthTokenInfo } from '../auth/types';
import type { ProviderConfig } from '../types';

export type BalanceMethod =
  | 'none'
  | 'moonshot-ai'
  | 'kimi-code'
  | 'newapi'
  | 'deepseek'
  | 'openrouter'
  | 'siliconflow'
  | 'aihubmix'
  | 'claude-relay-service'
  | 'antigravity'
  | 'gemini-cli'
  | 'codex'
  | 'synthetic';

export interface NoBalanceConfig {
  method: 'none';
}

export interface MoonshotAIBalanceConfig {
  method: 'moonshot-ai';
}

export interface KimiCodeBalanceConfig {
  method: 'kimi-code';
}

export interface NewAPIBalanceConfig {
  method: 'newapi';
  /** Optional user ID for querying account-level balance. */
  userId?: string;
  /** Optional system token (plain text or secret ref). */
  systemToken?: string;
}

export interface DeepSeekBalanceConfig {
  method: 'deepseek';
}

export interface OpenRouterBalanceConfig {
  method: 'openrouter';
}

export interface SiliconFlowBalanceConfig {
  method: 'siliconflow';
}

export interface AiHubMixBalanceConfig {
  method: 'aihubmix';
}

export interface ClaudeRelayServiceBalanceConfig {
  method: 'claude-relay-service';
}

export interface AntigravityBalanceConfig {
  method: 'antigravity';
}

export interface GeminiCliBalanceConfig {
  method: 'gemini-cli';
}

export interface CodexBalanceConfig {
  method: 'codex';
}

export interface SyntheticBalanceConfig {
  method: 'synthetic';
}

export type BalanceConfig =
  | NoBalanceConfig
  | MoonshotAIBalanceConfig
  | KimiCodeBalanceConfig
  | NewAPIBalanceConfig
  | DeepSeekBalanceConfig
  | OpenRouterBalanceConfig
  | SiliconFlowBalanceConfig
  | AiHubMixBalanceConfig
  | ClaudeRelayServiceBalanceConfig
  | AntigravityBalanceConfig
  | GeminiCliBalanceConfig
  | CodexBalanceConfig
  | SyntheticBalanceConfig;

export type BalanceMetricType =
  | 'amount'
  | 'token'
  | 'percent'
  | 'time'
  | 'status';

export type BalanceMetricPeriod =
  | 'current'
  | 'day'
  | 'week'
  | 'month'
  | 'total'
  | 'custom';

export interface BalanceMetricBase {
  id: string;
  type: BalanceMetricType;
  period: BalanceMetricPeriod;
  periodLabel?: string;
  scope?: string;
  primary?: boolean;
  label?: string;
}

export interface BalanceAmountMetric extends BalanceMetricBase {
  type: 'amount';
  direction: 'remaining' | 'used' | 'limit';
  value: number;
  currencySymbol?: string;
}

export interface BalanceTokenMetric extends BalanceMetricBase {
  type: 'token';
  used?: number;
  limit?: number;
  remaining?: number;
}

export interface BalancePercentMetric extends BalanceMetricBase {
  type: 'percent';
  value: number;
  basis?: 'remaining' | 'used';
}

export interface BalanceTimeMetric extends BalanceMetricBase {
  type: 'time';
  kind: 'expiresAt' | 'resetAt';
  value: string;
  timestampMs?: number;
}

export interface BalanceStatusMetric extends BalanceMetricBase {
  type: 'status';
  value: 'ok' | 'unlimited' | 'exhausted' | 'error' | 'unavailable';
  message?: string;
}

export type BalanceMetric =
  | BalanceAmountMetric
  | BalanceTokenMetric
  | BalancePercentMetric
  | BalanceTimeMetric
  | BalanceStatusMetric;

export interface BalanceSnapshot {
  updatedAt: number;
  items: BalanceMetric[];
}

export interface BalanceProviderState {
  isRefreshing: boolean;
  snapshot?: BalanceSnapshot;
  lastError?: string;
  lastAttemptAt?: number;
  lastRefreshAt?: number;
  pendingTrailing: boolean;
  lastRequestEndAt?: number;
}

export interface BalanceRefreshInput {
  provider: ProviderConfig;
  credential: AuthTokenInfo | undefined;
}

export interface BalanceRefreshResult {
  success: boolean;
  snapshot?: BalanceSnapshot;
  error?: string;
}

export function isMoonshotAIBalanceConfig(
  config: BalanceConfig | undefined,
): config is MoonshotAIBalanceConfig {
  return config?.method === 'moonshot-ai';
}

export function isNewAPIBalanceConfig(
  config: BalanceConfig | undefined,
): config is NewAPIBalanceConfig {
  return config?.method === 'newapi';
}

export function isKimiCodeBalanceConfig(
  config: BalanceConfig | undefined,
): config is KimiCodeBalanceConfig {
  return config?.method === 'kimi-code';
}

export function isDeepSeekBalanceConfig(
  config: BalanceConfig | undefined,
): config is DeepSeekBalanceConfig {
  return config?.method === 'deepseek';
}

export function isOpenRouterBalanceConfig(
  config: BalanceConfig | undefined,
): config is OpenRouterBalanceConfig {
  return config?.method === 'openrouter';
}

export function isSiliconFlowBalanceConfig(
  config: BalanceConfig | undefined,
): config is SiliconFlowBalanceConfig {
  return config?.method === 'siliconflow';
}

export function isAiHubMixBalanceConfig(
  config: BalanceConfig | undefined,
): config is AiHubMixBalanceConfig {
  return config?.method === 'aihubmix';
}

export function isClaudeRelayServiceBalanceConfig(
  config: BalanceConfig | undefined,
): config is ClaudeRelayServiceBalanceConfig {
  return config?.method === 'claude-relay-service';
}

export function isAntigravityBalanceConfig(
  config: BalanceConfig | undefined,
): config is AntigravityBalanceConfig {
  return config?.method === 'antigravity';
}

export function isGeminiCliBalanceConfig(
  config: BalanceConfig | undefined,
): config is GeminiCliBalanceConfig {
  return config?.method === 'gemini-cli';
}

export function isCodexBalanceConfig(
  config: BalanceConfig | undefined,
): config is CodexBalanceConfig {
  return config?.method === 'codex';
}

export function isSyntheticBalanceConfig(
  config: BalanceConfig | undefined,
): config is SyntheticBalanceConfig {
  return config?.method === 'synthetic';
}

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
  BalanceMetric,
  BalancePercentMetric,
  BalanceRefreshInput,
  BalanceRefreshResult,
  BalanceSnapshot,
  BalanceTimeMetric,
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

function normalizeMetricLabel(value: string): string {
  return value.toLowerCase().replace(/[\s\-_/.]+/g, '');
}

function resolveAntigravityQuotaGroup(
  metric: BalanceMetric,
): string | undefined {
  const joined = [
    metric.label?.trim() ?? '',
    metric.scope?.trim() ?? '',
  ]
    .filter((part) => part.length > 0)
    .join(' ');
  if (!joined) {
    // Drop unlabeled entries.
    return undefined;
  }

  const normalized = normalizeMetricLabel(joined);
  const withoutRequestsPrefix = normalized
    .replace(/^requests/, '')
    .replace(/quota$/, '');

  if (
    withoutRequestsPrefix.includes('gemini25')
  ) {
    return undefined;
  }

  if (
    withoutRequestsPrefix.includes('gemini') &&
    withoutRequestsPrefix.includes('pro')
  ) {
    return 'Gemini 3.x Pro';
  }

  if (
    (withoutRequestsPrefix.includes('gemini') &&
      withoutRequestsPrefix.includes('flash'))
  ) {
    return 'Gemini 3 Flash';
  }

  if (
    withoutRequestsPrefix.includes('claude') ||
    withoutRequestsPrefix.includes('gptoss')
  ) {
    return 'Claude/GPT-OSS';
  }

  if (
    withoutRequestsPrefix.startsWith('chat') ||
    withoutRequestsPrefix.startsWith('tab')
  ) {
    return undefined;
  }

  // Drop unknown labelled buckets instead of surfacing extra noisy lines.
  return undefined;
}

function buildPercentKey(metric: BalancePercentMetric, groupLabel: string): string {
  return [
    groupLabel,
    metric.period,
    metric.periodLabel?.trim() ?? '',
    metric.basis ?? '',
  ].join('|');
}

function buildTimeKey(metric: BalanceTimeMetric, groupLabel: string): string {
  return [
    groupLabel,
    metric.period,
    metric.periodLabel?.trim() ?? '',
    metric.kind,
  ].join('|');
}

function pickEarlierReset(
  left: BalanceTimeMetric,
  right: BalanceTimeMetric,
): BalanceTimeMetric {
  const leftTs = left.timestampMs;
  const rightTs = right.timestampMs;
  if (
    typeof leftTs === 'number' &&
    Number.isFinite(leftTs) &&
    typeof rightTs === 'number' &&
    Number.isFinite(rightTs)
  ) {
    return rightTs < leftTs ? right : left;
  }
  if (typeof rightTs === 'number' && Number.isFinite(rightTs)) {
    return right;
  }
  if (typeof leftTs === 'number' && Number.isFinite(leftTs)) {
    return left;
  }
  return left;
}

function groupAntigravitySnapshot(snapshot: BalanceSnapshot): BalanceSnapshot {
  const passthrough: BalanceMetric[] = [];
  const groupedPercent = new Map<string, BalancePercentMetric>();
  const groupedTime = new Map<string, BalanceTimeMetric>();

  for (const metric of snapshot.items) {
    const groupLabel = resolveAntigravityQuotaGroup(metric);
    if (!groupLabel) {
      // Intentionally discard unlabeled/ungroupable entries to reduce duplicates.
      continue;
    }

    if (metric.type === 'percent') {
      const key = buildPercentKey(metric, groupLabel);
      const existing = groupedPercent.get(key);
      if (!existing || metric.value > existing.value) {
        groupedPercent.set(key, {
          ...metric,
          label: groupLabel,
          scope: undefined,
          primary: false,
        });
      }
      continue;
    }

    if (metric.type === 'time') {
      const key = buildTimeKey(metric, groupLabel);
      const existing = groupedTime.get(key);
      if (!existing) {
        groupedTime.set(key, {
          ...metric,
          label: groupLabel,
          scope: undefined,
        });
      } else {
        const chosen = pickEarlierReset(existing, metric);
        groupedTime.set(key, {
          ...chosen,
          label: groupLabel,
          scope: undefined,
        });
      }
      continue;
    }

    passthrough.push(metric);
  }

  const mergedItems: BalanceMetric[] = [
    ...passthrough,
    ...groupedPercent.values(),
    ...groupedTime.values(),
  ];

  let primaryPercent: BalancePercentMetric | undefined;
  for (const item of mergedItems) {
    if (item.type !== 'percent') {
      continue;
    }
    item.primary = false;
    if (!primaryPercent || item.value > primaryPercent.value) {
      primaryPercent = item;
    }
  }
  if (primaryPercent) {
    primaryPercent.primary = true;
  }

  return {
    ...snapshot,
    items: mergedItems,
  };
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
    const result = await refreshCodeAssistQuota(input, {
      providerName: 'Antigravity',
      endpointFallbacks: CODE_ASSIST_ENDPOINT_FALLBACKS,
      requestHeaders: CODE_ASSIST_HEADERS,
      resolveProjectId: (refreshInput) =>
        resolveAntigravityProjectId(refreshInput.provider),
    });

    if (!result.success || !result.snapshot) {
      return result;
    }

    return {
      ...result,
      snapshot: groupAntigravitySnapshot(result.snapshot),
    };
  }
}

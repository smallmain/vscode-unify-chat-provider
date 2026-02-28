import { isEnglish, t } from '../i18n';
import { formatTokenCountCompact } from './token-display';
import type {
  BalanceAmountMetric,
  BalanceMetric,
  BalancePercentMetric,
  BalanceProviderState,
  BalanceSnapshot,
  BalanceStatusMetric,
  BalanceTimeMetric,
  BalanceTokenMetric,
} from './types';

const PERCENT_FRACTION_DIGITS = 1;

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(100, value));
}

function formatAmount(value: number, currencySymbol?: string): string {
  const normalized = value.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return currencySymbol ? `${currencySymbol}${normalized}` : normalized;
}

function formatPercent(value: number): string {
  return `${clampPercent(value).toLocaleString(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: PERCENT_FRACTION_DIGITS,
  })}%`;
}

function resolveTimeText(metric: BalanceTimeMetric): string {
  if (
    typeof metric.timestampMs === 'number' &&
    Number.isFinite(metric.timestampMs)
  ) {
    return new Date(metric.timestampMs).toLocaleString();
  }

  const parsed = new Date(metric.value).getTime();
  if (Number.isFinite(parsed)) {
    return new Date(parsed).toLocaleString();
  }

  return metric.value;
}

function resolveStatusText(metric: BalanceStatusMetric): string {
  if (metric.value === 'unlimited') {
    return t('Unlimited');
  }
  if (metric.value === 'exhausted') {
    return t('Exhausted');
  }
  if (metric.value === 'error') {
    return metric.message?.trim() || t('Error');
  }
  if (metric.value === 'unavailable') {
    return metric.message?.trim() || t('Unavailable');
  }
  return t('OK');
}

function resolvePeriodText(metric: BalanceMetric): string | undefined {
  if (metric.periodLabel?.trim()) {
    return metric.periodLabel.trim();
  }

  if (metric.period === 'current') {
    return undefined;
  }
  if (metric.period === 'day') {
    return t('Today');
  }
  if (metric.period === 'week') {
    return t('This week');
  }
  if (metric.period === 'month') {
    return t('This month');
  }
  if (metric.period === 'total') {
    return t('Total');
  }
  return t('Custom');
}

function resolveTypeLabel(metric: BalanceMetric): string {
  if (metric.type === 'amount') {
    if (metric.direction === 'used') {
      return t('Used');
    }
    if (metric.direction === 'limit') {
      return t('Limit');
    }
    return t('Balance');
  }
  if (metric.type === 'token') {
    return t('Tokens');
  }
  if (metric.type === 'percent') {
    return t('Remaining');
  }
  if (metric.type === 'time') {
    return metric.kind === 'expiresAt' ? t('Expires') : t('Resets');
  }
  return t('Status');
}

function normalizeForCompare(value: string): string {
  return value.toLowerCase().replace(/[\s()\[\]{}\-_:|,./\\]+/g, '');
}

function resolveScopeText(scope: string | undefined): string | undefined {
  const trimmed = scope?.trim();
  if (!trimmed) {
    return undefined;
  }

  const normalized = normalizeForCompare(trimmed);
  if (normalized === 'group') {
    return t('Group');
  }
  if (normalized === 'user') {
    return t('User');
  }
  if (normalized === 'apikey') {
    return t('API Key');
  }

  return trimmed;
}

function resolveMetricBaseLabel(metric: BalanceMetric): string {
  const explicitLabel = metric.label?.trim();
  const baseLabel = explicitLabel || resolveTypeLabel(metric);

  const scope = resolveScopeText(metric.scope);
  if (!scope) {
    return baseLabel;
  }

  const normalizedBase = normalizeForCompare(baseLabel);
  const normalizedScope = normalizeForCompare(scope);
  if (normalizedScope.length > 0 && normalizedBase.includes(normalizedScope)) {
    return baseLabel;
  }

  return `${scope} ${baseLabel}`;
}

function resolveLabel(metric: BalanceMetric): string {
  const typeLabel = resolveMetricBaseLabel(metric);
  if (metric.label?.trim()) {
    return typeLabel;
  }

  const periodText = resolvePeriodText(metric);
  return periodText ? `${typeLabel} (${periodText})` : typeLabel;
}

function resolveTokenText(metric: BalanceTokenMetric): string | undefined {
  const remaining =
    typeof metric.remaining === 'number' && Number.isFinite(metric.remaining)
      ? metric.remaining
      : undefined;
  const used =
    typeof metric.used === 'number' && Number.isFinite(metric.used)
      ? metric.used
      : undefined;
  const limit =
    typeof metric.limit === 'number' && Number.isFinite(metric.limit)
      ? metric.limit
      : undefined;
  const hasLimit = limit !== undefined && limit > 0;
  const hasRemaining = remaining !== undefined && remaining >= 0;
  const hasUsed = used !== undefined && used >= 0;
  const usedForQuota = hasUsed
    ? used
    : hasRemaining && hasLimit
      ? Math.max(0, limit - remaining)
      : undefined;

  if (usedForQuota !== undefined && hasLimit) {
    return `${formatTokenCountCompact(usedForQuota)} / ${formatTokenCountCompact(limit)} ${t('used')}`;
  }
  if (hasRemaining) {
    return `${formatTokenCountCompact(remaining)} ${t('remaining')}`;
  }
  if (hasUsed) {
    return `${formatTokenCountCompact(used)} ${t('used')}`;
  }
  if (hasLimit) {
    return formatTokenCountCompact(limit);
  }

  return undefined;
}

function metricOrder(metric: BalanceMetric): number {
  if (metric.primary) {
    return -1;
  }

  if (metric.type === 'percent') {
    return 0;
  }
  if (metric.type === 'time') {
    return 1;
  }
  if (metric.type === 'amount') {
    return 2;
  }
  if (metric.type === 'token') {
    return 3;
  }
  return 4;
}

function sortMetrics(metrics: readonly BalanceMetric[]): BalanceMetric[] {
  return [...metrics].sort((a, b) => {
    const orderDelta = metricOrder(a) - metricOrder(b);
    if (orderDelta !== 0) {
      return orderDelta;
    }
    return a.id.localeCompare(b.id);
  });
}

type MetricGroupFamily = 'amount' | 'token' | 'status' | 'percent' | 'time';

interface MetricLineGroup {
  key: string;
  family: MetricGroupFamily;
  period: BalanceMetric['period'];
  periodLabel?: string;
  scope?: string;
  label?: string;
  metrics: BalanceMetric[];
}

function normalizeGroupLabel(label: string | undefined): string | undefined {
  const trimmed = label?.trim();
  return trimmed ? trimmed : undefined;
}

function groupFamilyOf(metric: BalanceMetric): MetricGroupFamily {
  return metric.type;
}

function buildBaseGroupKey(metric: BalanceMetric): string {
  const scope = metric.scope?.trim() ?? '';
  const label = normalizeGroupLabel(metric.label) ?? '';
  const periodLabel = metric.periodLabel?.trim() ?? '';
  return [groupFamilyOf(metric), scope, metric.period, periodLabel, label].join(
    '|',
  );
}

function buildStandaloneGroupKey(metric: BalanceMetric): string {
  return [
    groupFamilyOf(metric),
    metric.id,
    metric.scope?.trim() ?? '',
    metric.period,
  ].join('|');
}

function createMetricLineGroup(
  key: string,
  family: MetricGroupFamily,
  metric: BalanceMetric,
): MetricLineGroup {
  return {
    key,
    family,
    period: metric.period,
    periodLabel: metric.periodLabel?.trim() || undefined,
    scope: metric.scope?.trim() || undefined,
    label: normalizeGroupLabel(metric.label),
    metrics: [],
  };
}

function isMetricContextMatch(
  group: MetricLineGroup,
  metric: BalanceMetric,
): boolean {
  const groupScope = group.scope ?? '';
  const metricScope = metric.scope?.trim() ?? '';
  const groupPeriodLabel = group.periodLabel ?? '';
  const metricPeriodLabel = metric.periodLabel?.trim() ?? '';
  return (
    group.period === metric.period &&
    groupScope === metricScope &&
    groupPeriodLabel === metricPeriodLabel
  );
}

function isGroupPrimary(group: MetricLineGroup): boolean {
  return group.metrics.some((metric) => metric.primary);
}

function isSameLabel(
  left: string | undefined,
  right: string | undefined,
): boolean {
  if (!left || !right) {
    return false;
  }
  return normalizeForCompare(left) === normalizeForCompare(right);
}

function findGroupForDeferredMetric(
  metric: BalanceMetric,
  groups: readonly MetricLineGroup[],
): MetricLineGroup | undefined {
  const metricLabel = normalizeGroupLabel(metric.label);
  const exactDeferredGroup = groups.find(
    (group) =>
      (group.family === 'percent' || group.family === 'time') &&
      isMetricContextMatch(group, metric) &&
      isSameLabel(group.label, metricLabel),
  );
  if (exactDeferredGroup) {
    return exactDeferredGroup;
  }

  const candidates = groups.filter(
    (group) =>
      (group.family === 'amount' ||
        group.family === 'token' ||
        group.family === 'status') &&
      isMetricContextMatch(group, metric),
  );
  if (candidates.length === 0) {
    return undefined;
  }

  const exactLabel = candidates.find((candidate) =>
    isSameLabel(candidate.label, metricLabel),
  );
  if (exactLabel) {
    return exactLabel;
  }

  const primary = candidates.find((candidate) => isGroupPrimary(candidate));
  if (primary) {
    return primary;
  }

  return candidates[0];
}

function buildMetricGroups(snapshot: BalanceSnapshot): MetricLineGroup[] {
  const sorted = sortMetrics(snapshot.items);
  const groups: MetricLineGroup[] = [];
  const groupMap = new Map<string, MetricLineGroup>();
  const deferredMetrics: BalanceMetric[] = [];

  for (const metric of sorted) {
    if (metric.type === 'percent' || metric.type === 'time') {
      deferredMetrics.push(metric);
      continue;
    }

    const key = buildBaseGroupKey(metric);
    let group = groupMap.get(key);
    if (!group) {
      group = createMetricLineGroup(key, groupFamilyOf(metric), metric);
      groupMap.set(key, group);
      groups.push(group);
    }

    group.metrics.push(metric);
  }

  for (const metric of deferredMetrics) {
    const target = findGroupForDeferredMetric(metric, groups);
    if (target) {
      target.metrics.push(metric);
      continue;
    }

    const key = buildStandaloneGroupKey(metric);
    const standalone = createMetricLineGroup(
      key,
      groupFamilyOf(metric),
      metric,
    );
    standalone.metrics.push(metric);
    groups.push(standalone);
  }

  return groups;
}

function finiteMetricNumber(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined;
}

function resolveUsedForQuota(input: {
  remaining?: number;
  used?: number;
  limit?: number;
}): number | undefined {
  if (input.used !== undefined) {
    return input.used;
  }

  if (
    input.remaining === undefined ||
    input.limit === undefined ||
    input.limit <= 0
  ) {
    return undefined;
  }

  return Math.max(0, input.limit - input.remaining);
}

function pickAmountMetric(
  metrics: readonly BalanceMetric[],
  direction: BalanceAmountMetric['direction'],
): BalanceAmountMetric | undefined {
  return metrics.find(
    (metric): metric is BalanceAmountMetric =>
      metric.type === 'amount' && metric.direction === direction,
  );
}

function pickTokenMetric(
  metrics: readonly BalanceMetric[],
): BalanceTokenMetric | undefined {
  return metrics.find(
    (metric): metric is BalanceTokenMetric => metric.type === 'token',
  );
}

function pickStatusMetric(
  metrics: readonly BalanceMetric[],
): BalanceStatusMetric | undefined {
  return metrics.find(
    (metric): metric is BalanceStatusMetric => metric.type === 'status',
  );
}

function pickPercentMetric(
  metrics: readonly BalanceMetric[],
): BalancePercentMetric | undefined {
  return metrics.find(
    (metric): metric is BalancePercentMetric => metric.type === 'percent',
  );
}

function pickTimeMetric(
  metrics: readonly BalanceMetric[],
): BalanceTimeMetric | undefined {
  const expires = metrics.find(
    (metric): metric is BalanceTimeMetric =>
      metric.type === 'time' && metric.kind === 'expiresAt',
  );
  if (expires) {
    return expires;
  }

  return metrics.find(
    (metric): metric is BalanceTimeMetric =>
      metric.type === 'time' && metric.kind === 'resetAt',
  );
}

function resolveAmountValue(metrics: readonly BalanceMetric[]): {
  text?: string;
  remaining?: number;
  used?: number;
  limit?: number;
} {
  const remainingMetric = pickAmountMetric(metrics, 'remaining');
  const usedMetric = pickAmountMetric(metrics, 'used');
  const limitMetric = pickAmountMetric(metrics, 'limit');

  const remaining = finiteMetricNumber(remainingMetric?.value);
  const used = finiteMetricNumber(usedMetric?.value);
  const limit = finiteMetricNumber(limitMetric?.value);
  const usedForQuota = resolveUsedForQuota({ remaining, used, limit });

  const currencySymbol =
    remainingMetric?.currencySymbol ??
    usedMetric?.currencySymbol ??
    limitMetric?.currencySymbol;

  if (usedForQuota !== undefined && limit !== undefined && limit > 0) {
    return {
      text: `${formatAmount(usedForQuota, currencySymbol)} / ${formatAmount(limit, currencySymbol)}`,
      remaining,
      used: usedForQuota,
      limit,
    };
  }

  if (remaining !== undefined) {
    return {
      text: formatAmount(remaining, currencySymbol),
      remaining,
      used: usedForQuota,
      limit,
    };
  }

  if (used !== undefined) {
    return {
      text: formatAmount(used, currencySymbol),
      remaining,
      used: usedForQuota,
      limit,
    };
  }

  if (limit !== undefined && limit > 0) {
    return {
      text: formatAmount(limit, currencySymbol),
      remaining,
      used: usedForQuota,
      limit,
    };
  }

  return { remaining, used: usedForQuota, limit };
}

function resolveTokenValue(metric: BalanceTokenMetric): {
  text?: string;
  remaining?: number;
  used?: number;
  limit?: number;
} {
  const remaining = finiteMetricNumber(metric.remaining);
  const used = finiteMetricNumber(metric.used);
  const limit = finiteMetricNumber(metric.limit);
  const usedForQuota = resolveUsedForQuota({ remaining, used, limit });

  if (usedForQuota !== undefined && limit !== undefined && limit > 0) {
    return {
      text: `${formatTokenCountCompact(usedForQuota)} / ${formatTokenCountCompact(limit)}`,
      remaining,
      used: usedForQuota,
      limit,
    };
  }

  if (remaining !== undefined) {
    return {
      text: formatTokenCountCompact(remaining),
      remaining,
      used: usedForQuota,
      limit,
    };
  }

  if (used !== undefined) {
    return {
      text: formatTokenCountCompact(used),
      remaining,
      used: usedForQuota,
      limit,
    };
  }

  if (limit !== undefined && limit > 0) {
    return {
      text: formatTokenCountCompact(limit),
      remaining,
      used: usedForQuota,
      limit,
    };
  }

  return { remaining, used: usedForQuota, limit };
}

function deriveUsedPercentFromUsage(input: {
  remaining?: number;
  used?: number;
  limit?: number;
}): number | undefined {
  const limit = input.limit;
  if (limit === undefined || limit <= 0) {
    return undefined;
  }

  if (input.remaining !== undefined) {
    return clampPercent(((limit - input.remaining) / limit) * 100);
  }
  if (input.used !== undefined) {
    return clampPercent((input.used / limit) * 100);
  }
  return undefined;
}

function resolveGroupPercent(
  metrics: readonly BalanceMetric[],
  amount: { remaining?: number; used?: number; limit?: number },
  token: { remaining?: number; used?: number; limit?: number },
): number | undefined {
  const percentMetric = pickPercentMetric(metrics);
  if (percentMetric) {
    const normalized = clampPercent(percentMetric.value);
    return percentMetric.basis === 'used'
      ? normalized
      : clampPercent(100 - normalized);
  }

  return (
    deriveUsedPercentFromUsage(amount) ?? deriveUsedPercentFromUsage(token)
  );
}

function resolveGroupTimeText(
  metric: BalanceTimeMetric | undefined,
): string | undefined {
  if (!metric) {
    return undefined;
  }

  return resolveTimeText(metric);
}

function resolveGroupLabel(group: MetricLineGroup): string | undefined {
  const labelledMetric = group.metrics.find((metric) => metric.label?.trim());
  if (labelledMetric) {
    return resolveMetricBaseLabel(labelledMetric);
  }

  const reference = group.metrics[0];
  if (!reference) {
    return undefined;
  }

  const base = resolveMetricBaseLabel(reference);
  const periodText = resolvePeriodText(reference);
  return periodText ? `${base} (${periodText})` : base;
}

function resolvePeriodTextForGroup(group: MetricLineGroup): string | undefined {
  if (group.periodLabel?.trim()) {
    return group.periodLabel.trim();
  }
  if (group.period === 'current') {
    return undefined;
  }
  if (group.period === 'day') {
    return t('Today');
  }
  if (group.period === 'week') {
    return t('This week');
  }
  if (group.period === 'month') {
    return t('This month');
  }
  if (group.period === 'total') {
    return t('Total');
  }
  return t('Custom');
}

function resolveGroupTypeName(group: MetricLineGroup): string {
  if (group.family === 'token') {
    return t('Token');
  }
  if (group.family === 'amount') {
    return t('Amount');
  }
  if (group.family === 'status') {
    return t('Status');
  }
  if (group.family === 'percent') {
    return t('Percent');
  }
  if (group.family === 'time') {
    return t('Time');
  }
  return t('Metric');
}

type GroupDisplaySemantic = 'quota' | 'usage' | 'balance';

function isFiniteNonNegative(value: number | undefined): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isFinitePositive(value: number | undefined): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function resolveGroupDisplaySemantic(input: {
  group: MetricLineGroup;
  amount: { remaining?: number; used?: number; limit?: number };
  token: { remaining?: number; used?: number; limit?: number };
}): GroupDisplaySemantic | undefined {
  const { group, amount, token } = input;
  if (group.family === 'status') {
    return undefined;
  }

  const hasLimit =
    isFinitePositive(amount.limit) || isFinitePositive(token.limit);
  if (hasLimit) {
    return 'quota';
  }

  const hasRemaining =
    isFiniteNonNegative(amount.remaining) ||
    isFiniteNonNegative(token.remaining);
  const hasUsed =
    isFiniteNonNegative(amount.used) || isFiniteNonNegative(token.used);

  if (hasUsed && !hasRemaining) {
    return 'usage';
  }
  if (hasRemaining) {
    return 'balance';
  }
  if (hasUsed) {
    return 'usage';
  }

  return undefined;
}

function resolveDisplaySemanticText(semantic: GroupDisplaySemantic): string {
  if (semantic === 'quota') {
    return t('Quota');
  }
  if (semantic === 'usage') {
    return t('Usage');
  }
  return t('Balance');
}

function resolveLocalizedGroupTypeName(group: MetricLineGroup): string {
  if (isEnglish()) {
    return resolveGroupTypeName(group);
  }
  if (group.family === 'token') {
    return t('Token');
  }
  if (group.family === 'amount') {
    return t('Amount');
  }
  if (group.family === 'status') {
    return t('Status');
  }
  if (group.family === 'percent') {
    return t('Percent');
  }
  if (group.family === 'time') {
    return t('Time');
  }
  return t('Metric');
}

function resolveQuotaStyleTitle(input: {
  group: MetricLineGroup;
  amount: { remaining?: number; used?: number; limit?: number };
  token: { remaining?: number; used?: number; limit?: number };
}): string | undefined {
  const { group, amount, token } = input;
  const semantic = resolveGroupDisplaySemantic({ group, amount, token });
  if (!semantic) {
    return resolveGroupLabel(group);
  }

  const typeName = resolveLocalizedGroupTypeName(group);
  const periodText = resolvePeriodTextForGroup(group) ?? '';
  const scopeText = resolveScopeText(group.scope) ?? '';
  const semanticText = resolveDisplaySemanticText(semantic);

  if (isEnglish()) {
    const parts = [scopeText, periodText, typeName, semanticText].filter(
      (part) => !!part,
    );
    return parts.join(' ');
  }

  return `${scopeText}${periodText}${typeName}${semanticText}`;
}

function containsQuotaHint(label: string): boolean {
  const normalized = normalizeForCompare(label);
  const localizedQuota = normalizeForCompare(t('Quota'));
  return (
    normalized.includes('quota') ||
    normalized.includes('limit') ||
    (localizedQuota.length > 0 && normalized.includes(localizedQuota))
  );
}

function ensureQuotaLabel(label: string): string {
  if (containsQuotaHint(label)) {
    return label;
  }

  const quotaText = t('Quota');
  if (isEnglish()) {
    return `${label} ${quotaText}`;
  }
  return `${label}${quotaText}`;
}

function formatGroupLine(group: MetricLineGroup): string | undefined {
  if (group.metrics.length === 0) {
    return undefined;
  }

  const amount = resolveAmountValue(group.metrics);
  const tokenMetric = pickTokenMetric(group.metrics);
  const token = tokenMetric ? resolveTokenValue(tokenMetric) : {};
  const semantic = resolveGroupDisplaySemantic({ group, amount, token });
  const baseLabel =
    resolveQuotaStyleTitle({ group, amount, token }) ??
    resolveGroupLabel(group);
  if (!baseLabel) {
    return undefined;
  }
  const statusMetric = pickStatusMetric(group.metrics);
  const timeMetric = pickTimeMetric(group.metrics);
  const percent = resolveGroupPercent(group.metrics, amount, token);

  let value: string | undefined;
  let valueSource:
    | 'amount'
    | 'token'
    | 'status'
    | 'percent'
    | 'time'
    | undefined;

  if (amount.text) {
    value = amount.text;
    valueSource = 'amount';
  } else if (token.text) {
    value = token.text;
    valueSource = 'token';
  } else if (statusMetric) {
    value = resolveStatusText(statusMetric);
    valueSource = 'status';
  } else if (percent !== undefined) {
    value = `${formatPercent(percent)} / ${formatPercent(100)}`;
    valueSource = 'percent';
  } else if (timeMetric) {
    value = resolveTimeText(timeMetric);
    valueSource = 'time';
  }

  if (!value) {
    return undefined;
  }

  const quotaLike = semantic === 'quota' || valueSource === 'percent';
  const label = quotaLike ? ensureQuotaLabel(baseLabel) : baseLabel;
  const usedPercentText =
    percent !== undefined ? formatPercent(percent) : undefined;
  const remainingPercentText =
    percent !== undefined
      ? formatPercent(clampPercent(100 - percent))
      : undefined;
  const shouldPrefixPercentInTitle = valueSource !== 'percent';
  const title = quotaLike
    ? shouldPrefixPercentInTitle && remainingPercentText
      ? `${label} (${remainingPercentText})`
      : label
    : usedPercentText && valueSource !== 'percent'
      ? `${label} (${usedPercentText})`
      : label;

  const shouldAppendTime =
    valueSource !== 'time' &&
    !(valueSource === 'status' && statusMetric?.value === 'unlimited');
  const timeText = shouldAppendTime
    ? resolveGroupTimeText(timeMetric)
    : undefined;
  const renderedValue = timeText ? `${value} (${timeText})` : value;

  return `${title}: ${renderedValue}`;
}

function getAmountMetrics(group: MetricLineGroup): BalanceAmountMetric[] {
  return group.metrics.filter(
    (metric): metric is BalanceAmountMetric => metric.type === 'amount',
  );
}

function hasAmountDirection(
  group: MetricLineGroup,
  direction: BalanceAmountMetric['direction'],
): boolean {
  return getAmountMetrics(group).some(
    (metric) => metric.direction === direction,
  );
}

function pickAmountLimitValue(group: MetricLineGroup): number | undefined {
  const limitMetric = getAmountMetrics(group).find(
    (metric) =>
      metric.direction === 'limit' &&
      Number.isFinite(metric.value) &&
      metric.value > 0,
  );
  return limitMetric?.value;
}

function isSameAmountContext(
  left: MetricLineGroup,
  right: MetricLineGroup,
): boolean {
  return (
    left.period === right.period &&
    (left.periodLabel ?? '') === (right.periodLabel ?? '') &&
    (left.scope ?? '') === (right.scope ?? '')
  );
}

function hasCompatibleLimit(
  left: MetricLineGroup,
  right: MetricLineGroup,
): boolean {
  const leftLimit = pickAmountLimitValue(left);
  const rightLimit = pickAmountLimitValue(right);
  if (leftLimit === undefined || rightLimit === undefined) {
    return true;
  }
  return Math.abs(leftLimit - rightLimit) < 1e-9;
}

function shouldHideUsedOnlyAmountGroup(
  group: MetricLineGroup,
  allGroups: readonly MetricLineGroup[],
): boolean {
  if (group.family !== 'amount') {
    return false;
  }

  const hasRemaining = hasAmountDirection(group, 'remaining');
  const hasUsed = hasAmountDirection(group, 'used');
  if (!hasUsed || hasRemaining) {
    return false;
  }

  return allGroups.some((candidate) => {
    if (candidate === group || candidate.family !== 'amount') {
      return false;
    }
    if (!hasAmountDirection(candidate, 'remaining')) {
      return false;
    }
    if (!isSameAmountContext(candidate, group)) {
      return false;
    }
    return hasCompatibleLimit(candidate, group);
  });
}

function filterMetricGroupsForDisplay(
  groups: readonly MetricLineGroup[],
): MetricLineGroup[] {
  return groups.filter(
    (group) => !shouldHideUsedOnlyAmountGroup(group, groups),
  );
}

export function getPrimaryMetric(
  snapshot: BalanceSnapshot | undefined,
): BalanceMetric | undefined {
  const metrics = snapshot?.items;
  if (!metrics || metrics.length === 0) {
    return undefined;
  }

  const primary = metrics.find((metric) => metric.primary);
  if (primary) {
    return primary;
  }

  return sortMetrics(metrics)[0];
}

export function formatMetricValue(metric: BalanceMetric): string | undefined {
  if (metric.type === 'amount') {
    return formatAmount(metric.value, metric.currencySymbol);
  }
  if (metric.type === 'percent') {
    return formatPercent(metric.value);
  }
  if (metric.type === 'time') {
    return resolveTimeText(metric);
  }
  if (metric.type === 'token') {
    return resolveTokenText(metric);
  }
  return resolveStatusText(metric);
}

export function formatPrimaryBadge(
  snapshot: BalanceSnapshot | undefined,
): string | undefined {
  const primary = getPrimaryMetric(snapshot);
  if (!primary) {
    return undefined;
  }
  return formatMetricValue(primary);
}

export function formatSummaryLine(
  snapshot: BalanceSnapshot | undefined,
): string | undefined {
  const primary = getPrimaryMetric(snapshot);
  if (!primary) {
    return undefined;
  }

  const value = formatMetricValue(primary);
  if (!value) {
    return undefined;
  }

  return `${resolveLabel(primary)}: ${value}`;
}

export function formatDetailLines(
  state: BalanceProviderState | undefined,
): string[] {
  const lines: string[] = [];

  if (state?.lastError?.trim()) {
    lines.push(t('Error: {0}', state.lastError.trim()));
  }

  const snapshot = state?.snapshot;
  if (snapshot) {
    const metricLines = formatSnapshotLines(snapshot);

    if (metricLines.length > 0) {
      lines.push(...metricLines);
    } else {
      lines.push(t('No data'));
    }
  }

  if (lines.length === 0) {
    lines.push(t('Not refreshed yet'));
  }

  const unique = new Set<string>();
  const deduped: string[] = [];
  for (const line of lines) {
    if (unique.has(line)) {
      continue;
    }
    unique.add(line);
    deduped.push(line);
  }

  return deduped;
}

export function formatSnapshotLines(
  snapshot: BalanceSnapshot | undefined,
): string[] {
  if (!snapshot) {
    return [];
  }

  return filterMetricGroupsForDisplay(buildMetricGroups(snapshot))
    .map((group) => formatGroupLine(group))
    .filter((line): line is string => !!line);
}

function findPercentMetric(
  snapshot: BalanceSnapshot | undefined,
): BalancePercentMetric | undefined {
  if (!snapshot) {
    return undefined;
  }

  const primary = getPrimaryMetric(snapshot);
  if (primary?.type === 'percent') {
    return primary;
  }

  return snapshot.items.find(
    (metric): metric is BalancePercentMetric => metric.type === 'percent',
  );
}

function findTokenMetric(
  snapshot: BalanceSnapshot | undefined,
): BalanceTokenMetric | undefined {
  if (!snapshot) {
    return undefined;
  }

  const primary = getPrimaryMetric(snapshot);
  if (primary?.type === 'token') {
    return primary;
  }

  return snapshot.items.find(
    (metric): metric is BalanceTokenMetric => metric.type === 'token',
  );
}

export function resolveProgressPercent(
  snapshot: BalanceSnapshot | undefined,
): number | undefined {
  const percent = findPercentMetric(snapshot);
  if (percent) {
    const normalized = clampPercent(percent.value);
    if (percent.basis === 'used') {
      return normalized;
    }
    return clampPercent(100 - normalized);
  }

  const token = findTokenMetric(snapshot);
  if (!token) {
    return undefined;
  }

  const remaining =
    typeof token.remaining === 'number' && Number.isFinite(token.remaining)
      ? token.remaining
      : undefined;
  const limit =
    typeof token.limit === 'number' && Number.isFinite(token.limit)
      ? token.limit
      : undefined;

  if (remaining !== undefined && limit !== undefined && limit > 0) {
    return clampPercent(((limit - remaining) / limit) * 100);
  }

  const used =
    typeof token.used === 'number' && Number.isFinite(token.used)
      ? token.used
      : undefined;
  if (used !== undefined && limit !== undefined && limit > 0) {
    return clampPercent((used / limit) * 100);
  }

  return undefined;
}

export function isUnlimited(snapshot: BalanceSnapshot | undefined): boolean {
  if (!snapshot) {
    return false;
  }

  return snapshot.items.some(
    (metric): metric is BalanceStatusMetric =>
      metric.type === 'status' && metric.value === 'unlimited',
  );
}

export function formatProviderDetail(
  providerName: string,
  snapshot: BalanceSnapshot | undefined,
): string {
  const badge = formatPrimaryBadge(snapshot)?.trim();
  if (!badge) {
    return providerName;
  }
  return `${providerName} (${badge})`;
}

export function pickAmountMetricForWarning(
  items: readonly BalanceMetric[],
): BalanceAmountMetric | undefined {
  return items.find(
    (metric): metric is BalanceAmountMetric =>
      metric.type === 'amount' && metric.direction === 'remaining',
  );
}

import type {
  BalanceAmountMetric,
  BalanceMetric,
  BalanceTimeMetric,
  BalanceTokenMetric,
} from './types';

const DAY_MS = 24 * 60 * 60 * 1000;
const MILLION = 1_000_000;

export interface BalanceWarningThresholds {
  enabled: boolean;
  /** Time threshold in days (supports decimals). */
  timeThresholdDays: number;
  /** Unitless amount threshold (currency ignored). */
  amountThreshold: number;
  /** Token remaining threshold in millions. */
  tokenThresholdMillions: number;
}

export type BalanceWarningReason = 'time' | 'amount' | 'tokens' | 'status';

export interface BalanceWarningEvaluation {
  isNearThreshold: boolean;
  reasons: BalanceWarningReason[];
}

function clampNonNegativeFiniteNumber(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

function resolveTimeThresholdMs(timeThresholdDays: number): number {
  return clampNonNegativeFiniteNumber(timeThresholdDays) * DAY_MS;
}

function resolveTokenThreshold(tokenThresholdMillions: number): number {
  return clampNonNegativeFiniteNumber(tokenThresholdMillions) * MILLION;
}

function resolveAmountThreshold(amountThreshold: number): number {
  return clampNonNegativeFiniteNumber(amountThreshold);
}

function resolveTimeTimestampMs(time: BalanceTimeMetric): number | undefined {
  const fromField = time.timestampMs;
  if (typeof fromField === 'number' && Number.isFinite(fromField)) {
    return fromField;
  }

  const parsed = new Date(time.value).getTime();
  return Number.isFinite(parsed) ? parsed : undefined;
}

function resolveRemainingTokens(tokens: BalanceTokenMetric): number | undefined {
  const remaining = tokens.remaining;
  if (typeof remaining === 'number' && Number.isFinite(remaining)) {
    return remaining;
  }

  const used = tokens.used;
  const limit = tokens.limit;
  if (
    typeof used === 'number' &&
    Number.isFinite(used) &&
    typeof limit === 'number' &&
    Number.isFinite(limit) &&
    limit > 0
  ) {
    return Math.max(0, limit - used);
  }

  return undefined;
}

function findAmountMetric(
  items: readonly BalanceMetric[],
): BalanceAmountMetric | undefined {
  const isRemainingAmount = (
    item: BalanceMetric,
  ): item is BalanceAmountMetric =>
    item.type === 'amount' && item.direction === 'remaining';
  const remainingAmounts = items.filter(isRemainingAmount);
  return remainingAmounts.find((item) => item.primary) ?? remainingAmounts[0];
}

function findTokenMetric(
  items: readonly BalanceMetric[],
): BalanceTokenMetric | undefined {
  return items.find(
    (item): item is BalanceTokenMetric => item.type === 'token',
  );
}

function findExpiresMetric(
  items: readonly BalanceMetric[],
): BalanceTimeMetric | undefined {
  return items.find(
    (item): item is BalanceTimeMetric =>
      item.type === 'time' && item.kind === 'expiresAt',
  );
}

export function evaluateBalanceWarning(
  items: readonly BalanceMetric[] | undefined,
  thresholds: BalanceWarningThresholds,
  nowMs: number = Date.now(),
): BalanceWarningEvaluation {
  if (!thresholds.enabled) {
    return { isNearThreshold: false, reasons: [] };
  }

  if (!items || items.length === 0) {
    return { isNearThreshold: false, reasons: [] };
  }

  const reasons: BalanceWarningReason[] = [];

  const explicitPrimary = items.find((item) => item.primary);
  const statusMetric =
    explicitPrimary ?? items.find((item) => item.type === 'status');
  if (
    statusMetric?.type === 'status' &&
    (statusMetric.value === 'exhausted' ||
      statusMetric.value === 'error' ||
      statusMetric.value === 'unavailable')
  ) {
    reasons.push('status');
  }

  const amountMetric = findAmountMetric(items);
  if (
    amountMetric &&
    typeof amountMetric.value === 'number' &&
    Number.isFinite(amountMetric.value)
  ) {
    const threshold = resolveAmountThreshold(thresholds.amountThreshold);
    if (amountMetric.value <= threshold) {
      reasons.push('amount');
    }
  }

  const tokenMetric = findTokenMetric(items);
  const remainingTokens = tokenMetric
    ? resolveRemainingTokens(tokenMetric)
    : undefined;
  if (
    typeof remainingTokens === 'number' &&
    Number.isFinite(remainingTokens)
  ) {
    const threshold = resolveTokenThreshold(thresholds.tokenThresholdMillions);
    if (remainingTokens <= threshold) {
      reasons.push('tokens');
    }
  }

  const expiresMetric = findExpiresMetric(items);
  if (expiresMetric) {
    const timestampMs = resolveTimeTimestampMs(expiresMetric);
    if (timestampMs !== undefined) {
      const thresholdMs = resolveTimeThresholdMs(thresholds.timeThresholdDays);
      if (timestampMs - nowMs <= thresholdMs) {
        reasons.push('time');
      }
    }
  }

  return { isNearThreshold: reasons.length > 0, reasons };
}

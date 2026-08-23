import { describe, expect, it } from 'vitest';
import type { BalanceMetric } from '../../src/balance/types';
import { evaluateBalanceWarning } from '../../src/balance/warning-utils';

const thresholds = {
  enabled: true,
  timeThresholdDays: 1,
  amountThreshold: 10,
  tokenThresholdMillions: 1,
};

describe('balance warning status selection', () => {
  it('ignores a secondary New API query failure when key balance is healthy', () => {
    const items: BalanceMetric[] = [
      {
        id: 'api-key-balance',
        type: 'amount',
        period: 'current',
        scope: 'api-key',
        direction: 'remaining',
        value: 50,
        currencySymbol: '$',
        primary: true,
      },
      {
        id: 'user-unavailable',
        type: 'status',
        period: 'current',
        scope: 'user',
        value: 'unavailable',
      },
    ];

    expect(evaluateBalanceWarning(items, thresholds)).toEqual({
      isNearThreshold: false,
      reasons: [],
    });
  });

  it('falls back to an abnormal status when no primary is marked', () => {
    const items: BalanceMetric[] = [
      {
        id: 'balance-unavailable',
        type: 'status',
        period: 'current',
        value: 'unavailable',
      },
    ];

    expect(evaluateBalanceWarning(items, thresholds)).toEqual({
      isNearThreshold: true,
      reasons: ['status'],
    });
  });
});

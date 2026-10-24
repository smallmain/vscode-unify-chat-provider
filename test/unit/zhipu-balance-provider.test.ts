import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';
import type { BalanceProviderContext } from '../../src/balance/balance-provider';
import type { ProviderConfig } from '../../src/types';

const mocks = vi.hoisted(() => ({
  fetchWithRetry: vi.fn(),
}));

vi.mock('vscode', () => {
  class EventEmitter<T> {
    readonly event = (_listener: (value: T) => void) => ({
      dispose: () => undefined,
    });
    fire(_value: T): void {}
    dispose(): void {}
  }

  return {
    EventEmitter,
    env: { language: 'en' },
    l10n: { t: (message: string) => message },
  };
});

vi.mock('../../src/client/utils', () => ({
  getToken: (credential: { kind?: string; token?: string } | undefined) =>
    credential?.kind === 'token' ? credential.token : undefined,
}));

vi.mock('../../src/logger', () => ({
  authLog: { warn: vi.fn() },
  createSimpleHttpLogger: () => ({
    logRequest: vi.fn(),
    logResponse: vi.fn(),
    logError: vi.fn(),
  }),
}));

vi.mock('../../src/utils', () => ({
  fetchWithRetry: mocks.fetchWithRetry,
}));

import {
  ZhiPuBalanceProvider,
  parseZhiPuBalanceSnapshot,
  parseZhiPuQuotaSnapshot,
  resolveZhiPuBalanceEndpoint,
  resolveZhiPuQuotaEndpoint,
} from '../../src/balance/providers/zhipu';
import {
  formatMetricValue,
  formatSnapshotLines,
} from '../../src/balance/display';
import { SecretStore } from '../../src/secret/secret-store';

function createSecretStore(): SecretStore {
  const storage: vscode.SecretStorage = {
    onDidChange: () => ({ dispose: () => undefined }),
    keys: async () => [],
    get: async () => undefined,
    store: async () => undefined,
    delete: async () => undefined,
  };
  return new SecretStore(storage);
}

function createBalanceProvider(): ZhiPuBalanceProvider {
  const context: BalanceProviderContext = {
    providerId: 'zhipu',
    providerLabel: 'ZhiPu',
    secretStore: createSecretStore(),
  };
  return new ZhiPuBalanceProvider(context, { method: 'zhipu' });
}

function providerConfig(baseUrl: string): ProviderConfig {
  return {
    type: 'openai-chat-completion',
    name: 'ZhiPu',
    baseUrl,
    models: [],
  };
}

describe('ZhiPu balance provider', () => {
  beforeEach(() => {
    mocks.fetchWithRetry.mockReset();
  });

  it('resolves quota and balance endpoints for each ZhiPu region', () => {
    expect(
      resolveZhiPuQuotaEndpoint('https://api.z.ai/api/coding/paas/v4'),
    ).toBe('https://api.z.ai/api/monitor/usage/quota/limit');
    expect(
      resolveZhiPuBalanceEndpoint('https://api.z.ai/api/coding/paas/v4'),
    ).toBe(
      'https://api.z.ai/api/biz/account/query-customer-account-report',
    );
    expect(
      resolveZhiPuQuotaEndpoint('https://open.bigmodel.cn/api/paas/v4'),
    ).toBe('https://bigmodel.cn/api/monitor/usage/quota/limit');
    expect(
      resolveZhiPuQuotaEndpoint('https://bigmodel.cn/api/paas/v4'),
    ).toBe('https://bigmodel.cn/api/monitor/usage/quota/limit');
    expect(resolveZhiPuQuotaEndpoint('https://www.bigmodel.cn')).toBe(
      'https://bigmodel.cn/api/monitor/usage/quota/limit',
    );
    expect(
      resolveZhiPuQuotaEndpoint('https://gateway.example.test/zhipu'),
    ).toBe('https://gateway.example.test/api/monitor/usage/quota/limit');
  });

  it('parses the 5-hour and weekly TOKENS_LIMIT windows', () => {
    const fiveHourReset = 1_800_000_000_000;
    const weeklyReset = fiveHourReset + 3 * 24 * 60 * 60 * 1000;
    const snapshot = parseZhiPuQuotaSnapshot(
      {
        success: true,
        code: 200,
        msg: 'success',
        data: {
          level: 'pro',
          limits: [
            {
              type: 'TOKENS_LIMIT',
              unit: 3,
              number: 5,
              percentage: 64,
              nextResetTime: fiveHourReset,
            },
            {
              type: 'TOKENS_LIMIT',
              unit: 6,
              number: 1,
              percentage: 90,
              nextResetTime: weeklyReset,
            },
          ],
        },
      },
      123,
    );

    expect(snapshot).toMatchObject({ updatedAt: 123 });
    expect(snapshot?.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'zhipu-quota-5-hour-remaining-percent',
          type: 'percent',
          period: 'custom',
          value: 36,
          basis: 'remaining',
          primary: true,
        }),
        expect.objectContaining({
          id: 'zhipu-quota-5-hour-reset',
          type: 'time',
          kind: 'resetAt',
          timestampMs: fiveHourReset,
        }),
        expect.objectContaining({
          id: 'zhipu-quota-weekly-remaining-percent',
          type: 'percent',
          period: 'week',
          value: 10,
          basis: 'remaining',
        }),
        expect.objectContaining({
          id: 'zhipu-quota-weekly-reset',
          type: 'time',
          kind: 'resetAt',
          timestampMs: weeklyReset,
        }),
      ]),
    );
    expect(
      snapshot?.items.filter((item) => item.primary === true),
    ).toHaveLength(1);
  });

  it('parses the monthly TIME_LIMIT window with count quotas', () => {
    const monthlyReset = 1_800_000_000_000;
    const snapshot = parseZhiPuQuotaSnapshot({
      success: true,
      code: 200,
      data: {
        limits: [
          {
            type: 'TIME_LIMIT',
            unit: 5,
            number: 1,
            percentage: 70,
            nextResetTime: monthlyReset,
            usage: 1000,
            currentValue: 300,
            remaining: 700,
          },
        ],
      },
    });

    expect(snapshot?.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'zhipu-quota-monthly-remaining',
          type: 'integer',
          direction: 'remaining',
          value: 700,
        }),
        expect.objectContaining({
          id: 'zhipu-quota-monthly-used',
          type: 'integer',
          direction: 'used',
          value: 300,
        }),
        expect.objectContaining({
          id: 'zhipu-quota-monthly-limit',
          type: 'integer',
          direction: 'limit',
          value: 1000,
        }),
        expect.objectContaining({
          id: 'zhipu-quota-monthly-remaining-percent',
          type: 'percent',
          period: 'month',
          value: 30,
          basis: 'remaining',
          primary: true,
        }),
        expect.objectContaining({
          id: 'zhipu-quota-monthly-reset',
          type: 'time',
          kind: 'resetAt',
          timestampMs: monthlyReset,
        }),
      ]),
    );
  });

  it('drops out-of-range percentages and non-positive reset timestamps', () => {
    const snapshot = parseZhiPuQuotaSnapshot({
      success: true,
      code: 200,
      data: {
        limits: [
          {
            type: 'TOKENS_LIMIT',
            unit: 3,
            number: 5,
            percentage: 150,
            nextResetTime: 1_800_000_000_000,
          },
          {
            type: 'TOKENS_LIMIT',
            unit: 6,
            number: 1,
            percentage: 50,
            nextResetTime: 0,
          },
        ],
      },
    });

    expect(
      snapshot?.items.some(
        (item) => item.id === 'zhipu-quota-5-hour-remaining-percent',
      ),
    ).toBe(false);
    expect(
      snapshot?.items.some(
        (item) => item.id === 'zhipu-quota-5-hour-reset',
      ),
    ).toBe(true);
    expect(
      snapshot?.items.some(
        (item) => item.id === 'zhipu-quota-weekly-remaining-percent',
      ),
    ).toBe(true);
    expect(
      snapshot?.items.some((item) => item.id === 'zhipu-quota-weekly-reset'),
    ).toBe(false);
    expect(
      parseZhiPuQuotaSnapshot({ success: true, code: 200, data: { limits: [] } }),
    ).toBeUndefined();
    expect(
      parseZhiPuQuotaSnapshot({ success: true, code: 200 }),
    ).toBeUndefined();
  });

  it('keeps only the first entry of duplicate quota windows', () => {
    const snapshot = parseZhiPuQuotaSnapshot({
      success: true,
      code: 200,
      data: {
        limits: [
          {
            type: 'TOKENS_LIMIT',
            unit: 3,
            number: 5,
            percentage: 64,
            nextResetTime: 1_800_000_000_000,
          },
          {
            type: 'TOKENS_LIMIT',
            unit: 3,
            number: 5,
            percentage: 10,
            nextResetTime: 1_800_500_000_000,
          },
        ],
      },
    });

    expect(
      snapshot?.items.filter(
        (item) => item.id === 'zhipu-quota-5-hour-remaining-percent',
      ),
    ).toHaveLength(1);
    expect(
      snapshot?.items.find(
        (item) => item.id === 'zhipu-quota-5-hour-remaining-percent',
      ),
    ).toMatchObject({ value: 36 });
    expect(
      snapshot?.items.filter((item) => item.id === 'zhipu-quota-5-hour-reset'),
    ).toHaveLength(1);
  });

  it('parses the PayGo balance amount with an availableBalance fallback', () => {
    const snapshot = parseZhiPuBalanceSnapshot({
      success: true,
      code: 200,
      data: { balance: 42.5 },
    });

    expect(snapshot?.items).toEqual([
      expect.objectContaining({
        id: 'zhipu-balance',
        type: 'amount',
        period: 'current',
        direction: 'remaining',
        value: 42.5,
        currencySymbol: '¥',
      }),
    ]);

    const fallback = parseZhiPuBalanceSnapshot({
      success: true,
      code: 200,
      data: { balance: null, availableBalance: 7.25 },
    });
    expect(
      fallback?.items.find((item) => item.id === 'zhipu-balance'),
    ).toMatchObject({ value: 7.25 });

    expect(
      parseZhiPuBalanceSnapshot({ success: true, code: 200, data: {} }),
    ).toBeUndefined();
    expect(parseZhiPuBalanceSnapshot({ success: true, code: 200 })).toBeUndefined();
  });

  it('parses the real-world CREDIT_LIMIT quota payload with used-share percentages', () => {
    // Values genericized from a live pro-plan response; percentage must still
    // equal Math.floor(currentValue / usage * 100) to mirror server rounding.
    const fiveHourReset = 1_800_000_000_000;
    const weeklyReset = fiveHourReset + 3 * 24 * 60 * 60 * 1000;
    const snapshot = parseZhiPuQuotaSnapshot({
      code: 200,
      msg: '操作成功',
      data: {
        limits: [
          {
            type: 'CREDIT_LIMIT',
            unit: 3,
            number: 5,
            usage: 1000,
            currentValue: 96,
            remaining: 904,
            percentage: 9,
            nextResetTime: fiveHourReset,
          },
          {
            type: 'CREDIT_LIMIT',
            unit: 6,
            number: 1,
            usage: 5000,
            currentValue: 2580,
            remaining: 2420,
            percentage: 51,
            nextResetTime: weeklyReset,
          },
        ],
        level: 'pro',
      },
      success: true,
    });

    expect(snapshot?.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'zhipu-quota-5-hour-remaining-percent',
          type: 'percent',
          period: 'custom',
          value: 91,
          basis: 'remaining',
          primary: true,
        }),
        expect.objectContaining({
          id: 'zhipu-quota-5-hour-reset',
          type: 'time',
          kind: 'resetAt',
          timestampMs: fiveHourReset,
        }),
        expect.objectContaining({
          id: 'zhipu-quota-weekly-remaining-percent',
          type: 'percent',
          period: 'week',
          value: 49,
          basis: 'remaining',
        }),
        expect.objectContaining({
          id: 'zhipu-quota-weekly-reset',
          type: 'time',
          kind: 'resetAt',
          timestampMs: weeklyReset,
        }),
      ]),
    );
    expect(
      snapshot?.items.filter((item) => item.primary === true),
    ).toHaveLength(1);
    expect(snapshot?.items.some((item) => item.type === 'integer')).toBe(false);
  });

  it('parses the live PayGo balance payload with a zero balance', () => {
    const snapshot = parseZhiPuBalanceSnapshot({
      code: 200,
      msg: 'Operation successful',
      data: {
        balance: 0.0,
        rechargeAmount: 0.0,
        giveAmount: 0.0,
        totalSpendAmount: 0.0,
        todaySpendAmount: null,
        availableBalance: 0.0,
        frozenBalance: 0.0,
        creditBalance: null,
        availableCreditBalance: null,
        creditStatus: 'NOT_OPEN',
        modelSpendAmountList: null,
        isKA: false,
      },
      success: true,
    });

    expect(snapshot?.items).toEqual([
      expect.objectContaining({
        id: 'zhipu-balance',
        type: 'amount',
        period: 'current',
        direction: 'remaining',
        value: 0,
        currencySymbol: '¥',
      }),
    ]);
  });

  it('renders the remaining 5-hour percentage through the display helpers', () => {
    const snapshot = parseZhiPuQuotaSnapshot({
      success: true,
      code: 200,
      data: {
        limits: [
          {
            type: 'TOKENS_LIMIT',
            unit: 3,
            number: 5,
            percentage: 64,
            nextResetTime: 1_800_000_000_000,
          },
        ],
      },
    });

    const percent = snapshot?.items.find(
      (item) =>
        item.id === 'zhipu-quota-5-hour-remaining-percent' &&
        item.type === 'percent',
    );
    expect(percent && formatMetricValue(percent)).toBe('36%');
    expect(
      formatSnapshotLines(snapshot).some((line) =>
        line.includes('5-hour limit: 64% / 100%'),
      ),
    ).toBe(true);
  });

  it('merges quota and balance snapshots with the bare API key header', async () => {
    const fiveHourReset = 1_800_000_000_000;
    mocks.fetchWithRetry
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            success: true,
            code: 200,
            msg: 'success',
            data: {
              limits: [
                {
                  type: 'TOKENS_LIMIT',
                  unit: 3,
                  number: 5,
                  percentage: 64,
                  nextResetTime: fiveHourReset,
                },
              ],
            },
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            success: true,
            code: 200,
            msg: 'success',
            data: { balance: 42.5 },
          }),
          { status: 200 },
        ),
      );

    const result = await createBalanceProvider().refresh({
      provider: providerConfig('https://api.z.ai/api/coding/paas/v4'),
      credential: { kind: 'token', token: 'zhipu-key' },
    });

    expect(result.success).toBe(true);
    expect(mocks.fetchWithRetry).toHaveBeenCalledTimes(2);
    expect(mocks.fetchWithRetry.mock.calls.map(([url]) => url)).toEqual([
      'https://api.z.ai/api/monitor/usage/quota/limit',
      'https://api.z.ai/api/biz/account/query-customer-account-report',
    ]);
    expect(mocks.fetchWithRetry).toHaveBeenNthCalledWith(
      1,
      'https://api.z.ai/api/monitor/usage/quota/limit',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({
          Authorization: 'zhipu-key',
        }),
      }),
    );
    expect(mocks.fetchWithRetry).toHaveBeenNthCalledWith(
      2,
      'https://api.z.ai/api/biz/account/query-customer-account-report',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({
          Authorization: 'zhipu-key',
        }),
      }),
    );
    expect(result.snapshot?.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'zhipu-quota-5-hour-remaining-percent',
          value: 36,
        }),
        expect.objectContaining({
          id: 'zhipu-balance',
          value: 42.5,
        }),
      ]),
    );
  });

  it('silently degrades to quota-only when the PayGo endpoint fails', async () => {
    mocks.fetchWithRetry
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            success: true,
            code: 200,
            data: {
              limits: [
                {
                  type: 'TOKENS_LIMIT',
                  unit: 3,
                  number: 5,
                  percentage: 64,
                  nextResetTime: 1_800_000_000_000,
                },
              ],
            },
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ msg: 'account error' }), {
          status: 500,
        }),
      );

    const result = await createBalanceProvider().refresh({
      provider: providerConfig('https://api.z.ai/api/coding/paas/v4'),
      credential: { kind: 'token', token: 'zhipu-key' },
    });

    expect(result.success).toBe(true);
    expect(result.error).toBeUndefined();
    expect(result.snapshot?.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'zhipu-quota-5-hour-remaining-percent',
        }),
      ]),
    );
    expect(
      result.snapshot?.items.some((item) => item.id === 'zhipu-balance'),
    ).toBe(false);
  });

  it('degrades to balance-only when the quota endpoint reports a business error', async () => {
    mocks.fetchWithRetry
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            success: false,
            code: 500,
            msg: 'no subscription',
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            success: true,
            code: 200,
            data: { balance: 42.5 },
          }),
          { status: 200 },
        ),
      );

    const result = await createBalanceProvider().refresh({
      provider: providerConfig('https://api.z.ai/api/coding/paas/v4'),
      credential: { kind: 'token', token: 'zhipu-key' },
    });

    expect(result.success).toBe(true);
    expect(result.snapshot?.items).toEqual([
      expect.objectContaining({ id: 'zhipu-balance', value: 42.5 }),
    ]);
  });

  it('returns the quota message when both endpoints fail', async () => {
    mocks.fetchWithRetry
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            success: false,
            code: 401,
            msg: '无效的API密钥',
          }),
          { status: 200 },
        ),
      )
      .mockRejectedValueOnce(new Error('network down'));

    const result = await createBalanceProvider().refresh({
      provider: providerConfig('https://api.z.ai/api/coding/paas/v4'),
      credential: { kind: 'token', token: 'zhipu-key' },
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe('无效的API密钥');
  });

  it('fails with the missing key message when no credential is available', async () => {
    const result = await createBalanceProvider().refresh({
      provider: providerConfig('https://api.z.ai/api/coding/paas/v4'),
      credential: { kind: 'none' },
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe(
      'API key is required to query {0} balance.',
    );
    expect(mocks.fetchWithRetry).not.toHaveBeenCalled();
  });
});

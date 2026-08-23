import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderConfig } from '../../src/types';

const state = vi.hoisted(() => ({
  fetchWithRetry: vi.fn(),
}));

vi.mock('vscode', () => ({
  env: { language: 'en' },
  l10n: {
    t: (message: string, ...args: unknown[]) =>
      message.replace(/\{(\d+)\}/g, (_match, index: string) =>
        String(args[Number(index)] ?? ''),
      ),
  },
}));

vi.mock('../../src/logger', () => ({
  createSimpleHttpLogger: vi.fn(() => ({})),
}));

vi.mock('../../src/client/utils', () => ({
  getToken: (
    info: { readonly kind: string; readonly token?: string } | undefined,
  ) => (info?.kind === 'token' ? info.token : undefined),
}));

vi.mock('../../src/utils', () => ({
  fetchWithRetry: state.fetchWithRetry,
  normalizeBaseUrlInput: (raw: string) => {
    const parsed = new URL(raw.trim());
    parsed.search = '';
    parsed.hash = '';
    parsed.pathname = parsed.pathname.replace(/\/{2,}/g, '/').replace(/\/+$/, '');
    return parsed.toString().replace(/\/+$/, '');
  },
}));

import { Sub2APIBalanceProvider } from '../../src/balance/providers/sub2api';

function provider(baseUrl = 'https://relay.example.test/v1'): ProviderConfig {
  return {
    type: 'openai-chat-completion',
    name: 'Sub2API',
    baseUrl,
    models: [],
    auth: { method: 'api-key' },
    balanceProvider: { method: 'sub2api' },
  };
}

async function refresh(baseUrl?: string) {
  const balanceProvider = new Sub2APIBalanceProvider({});
  return balanceProvider.refresh({
    provider: provider(baseUrl),
    credential: { kind: 'token', token: 'sk-sub2api' },
  });
}

describe('Sub2API balance provider', () => {
  beforeEach(() => {
    state.fetchWithRetry.mockReset();
  });

  it('queries /v1/usage and maps API key quota, rate limits, and expiry', async () => {
    state.fetchWithRetry.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          mode: 'quota_limited',
          isValid: true,
          status: 'active',
          quota: { limit: 100, used: 25, remaining: 75, unit: 'USD' },
          remaining: 75,
          unit: 'USD',
          rate_limits: [
            {
              window: '5h',
              limit: 20,
              used: 8,
              remaining: 12,
              reset_at: '2026-08-23T12:00:00Z',
            },
          ],
          expires_at: '2026-09-01T00:00:00Z',
        }),
        { status: 200 },
      ),
    );

    const result = await refresh();

    expect(state.fetchWithRetry).toHaveBeenCalledWith(
      'https://relay.example.test/v1/usage',
      expect.objectContaining({
        method: 'GET',
        headers: {
          Authorization: 'Bearer sk-sub2api',
          Accept: 'application/json',
        },
      }),
    );
    expect(result.success).toBe(true);
    expect(result.snapshot?.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'api-key-quota-remaining',
          type: 'amount',
          direction: 'remaining',
          value: 75,
          primary: true,
        }),
        expect.objectContaining({
          id: 'api-key-quota-used',
          direction: 'used',
          value: 25,
        }),
        expect.objectContaining({
          id: 'rate-limit-0-remaining',
          periodLabel: '5h',
          value: 12,
        }),
        expect.objectContaining({
          id: 'rate-limit-0-reset',
          type: 'time',
          kind: 'resetAt',
        }),
        expect.objectContaining({
          id: 'api-key-expires',
          type: 'time',
          kind: 'expiresAt',
        }),
      ]),
    );
  });

  it('maps subscription windows and the effective remaining quota', async () => {
    state.fetchWithRetry.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          mode: 'unrestricted',
          isValid: true,
          planName: 'Weekly Plan',
          remaining: 35,
          unit: 'USD',
          subscription: {
            daily_usage_usd: 4,
            daily_limit_usd: 10,
            weekly_usage_usd: 15,
            weekly_limit_usd: 50,
            monthly_usage_usd: 65,
            monthly_limit_usd: 100,
            expires_at: '2026-09-30T00:00:00Z',
          },
        }),
        { status: 200 },
      ),
    );

    const result = await refresh();

    expect(result.success).toBe(true);
    expect(result.snapshot?.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'subscription-quota-remaining',
          value: 35,
          primary: true,
        }),
        expect.objectContaining({
          id: 'subscription-daily-remaining',
          period: 'day',
          value: 6,
        }),
        expect.objectContaining({
          id: 'subscription-weekly-used',
          period: 'week',
          value: 15,
        }),
        expect.objectContaining({
          id: 'subscription-monthly-limit',
          period: 'month',
          value: 100,
        }),
        expect.objectContaining({
          id: 'subscription-expires',
          kind: 'expiresAt',
        }),
      ]),
    );
  });

  it('uses the root /v1/usage endpoint and maps wallet balance', async () => {
    state.fetchWithRetry.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          mode: 'unrestricted',
          isValid: true,
          planName: 'Wallet',
          remaining: 42.5,
          balance: 42.5,
          unit: 'USD',
        }),
        { status: 200 },
      ),
    );

    const result = await refresh('https://relay.example.test');

    expect(state.fetchWithRetry).toHaveBeenCalledWith(
      'https://relay.example.test/v1/usage',
      expect.any(Object),
    );
    expect(result.snapshot?.items).toEqual([
      expect.objectContaining({
        id: 'wallet-balance-remaining',
        value: 42.5,
        currencySymbol: '$',
        primary: true,
      }),
    ]);
  });

  it('surfaces API errors and rejects unknown response schemas', async () => {
    state.fetchWithRetry
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ error: { message: 'invalid API key' } }),
          { status: 401 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ mode: 'future_mode' }), { status: 200 }),
      );

    await expect(refresh()).resolves.toEqual({
      success: false,
      error: 'invalid API key',
    });
    await expect(refresh()).resolves.toEqual({
      success: false,
      error: 'Unexpected Sub2API balance response.',
    });
  });
});

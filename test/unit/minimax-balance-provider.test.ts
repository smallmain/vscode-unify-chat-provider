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
  MiniMaxBalanceProvider,
  parseMiniMaxCodingPlanSnapshot,
  parseMiniMaxTokenPlanSnapshot,
  resolveMiniMaxCodingPlanEndpoint,
  resolveMiniMaxTokenPlanEndpoint,
} from '../../src/balance/providers/minimax';
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

function createBalanceProvider(): MiniMaxBalanceProvider {
  const context: BalanceProviderContext = {
    providerId: 'minimax',
    providerLabel: 'MiniMax',
    secretStore: createSecretStore(),
  };
  return new MiniMaxBalanceProvider(context, { method: 'minimax' });
}

function providerConfig(baseUrl: string): ProviderConfig {
  return {
    type: 'anthropic',
    name: 'MiniMax',
    baseUrl,
    models: [],
  };
}

describe('MiniMax balance provider', () => {
  beforeEach(() => {
    mocks.fetchWithRetry.mockReset();
  });

  it('resolves the current Token Plan endpoint for each MiniMax region', () => {
    expect(
      resolveMiniMaxTokenPlanEndpoint('https://api.minimax.io/anthropic'),
    ).toBe('https://www.minimax.io/v1/token_plan/remains');
    expect(
      resolveMiniMaxTokenPlanEndpoint('https://api.minimaxi.com/anthropic'),
    ).toBe('https://www.minimaxi.com/v1/token_plan/remains');
    expect(
      resolveMiniMaxCodingPlanEndpoint('https://api.minimax.io/anthropic'),
    ).toBe(
      'https://api.minimax.io/v1/api/openplatform/coding_plan/remains',
    );
  });

  it('parses the coding model 5-hour and weekly Token Plan windows', () => {
    const intervalEnd = 1_800_000_000_000;
    const weeklyEnd = intervalEnd + 5 * 24 * 60 * 60 * 1000;
    const snapshot = parseMiniMaxTokenPlanSnapshot(
      {
        model_remains: [
          {
            model_name: 'image-01',
            current_interval_total_count: 100,
            current_interval_usage_count: 1,
            current_interval_remaining_percent: 1,
          },
          {
            model_name: 'MiniMax-M3',
            start_time: intervalEnd - 5 * 60 * 60 * 1000,
            end_time: intervalEnd,
            current_interval_total_count: 1_500,
            current_interval_usage_count: 1_200,
            current_interval_remaining_percent: 80,
            current_interval_status: 1,
            current_weekly_total_count: 15_000,
            current_weekly_usage_count: 13_500,
            current_weekly_remaining_percent: 90,
            current_weekly_status: 1,
            weekly_end_time: weeklyEnd,
          },
        ],
      },
      123,
    );

    expect(snapshot).toMatchObject({ updatedAt: 123 });
    expect(snapshot?.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'minimax-token-plan-5-hour-remaining',
          direction: 'remaining',
          value: 1_200,
        }),
        expect.objectContaining({
          id: 'minimax-token-plan-5-hour-used',
          direction: 'used',
          value: 300,
        }),
        expect.objectContaining({
          id: 'minimax-token-plan-5-hour-remaining-percent',
          value: 80,
          basis: 'remaining',
          primary: true,
        }),
        expect.objectContaining({
          id: 'minimax-token-plan-weekly-used',
          direction: 'used',
          value: 1_500,
        }),
        expect.objectContaining({
          id: 'minimax-token-plan-weekly-remaining-percent',
          value: 90,
          basis: 'remaining',
        }),
        expect.objectContaining({
          id: 'minimax-token-plan-weekly-reset',
          timestampMs: weeklyEnd,
        }),
      ]),
    );
  });

  it('uses percent-only Token Plan windows when count quotas are zero', () => {
    const snapshot = parseMiniMaxTokenPlanSnapshot({
      model_remains: [
        {
          model_name: 'general',
          current_interval_total_count: 0,
          current_interval_usage_count: 0,
          current_interval_remaining_percent: 42,
          current_interval_status: 1,
          end_time: 1_800_000_000_000,
          current_weekly_total_count: 0,
          current_weekly_usage_count: 0,
          current_weekly_remaining_percent: 73,
          current_weekly_status: 1,
          weekly_end_time: 1_800_500_000_000,
        },
      ],
    });

    expect(snapshot?.items.some((item) => item.type === 'integer')).toBe(false);
    expect(snapshot?.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'minimax-token-plan-5-hour-remaining-percent',
          value: 42,
        }),
        expect.objectContaining({
          id: 'minimax-token-plan-weekly-remaining-percent',
          value: 73,
        }),
      ]),
    );
  });

  it('rejects Token Plan rows that the API marks as unavailable', () => {
    expect(
      parseMiniMaxTokenPlanSnapshot({
        model_remains: [
          {
            model_name: 'general',
            current_interval_total_count: 0,
            current_weekly_total_count: 0,
            current_interval_remaining_percent: 100,
            current_weekly_remaining_percent: 100,
            current_interval_status: 3,
            current_weekly_status: 3,
          },
        ],
      }),
    ).toBeUndefined();
  });

  it('preserves legacy Coding Plan count semantics', () => {
    const snapshot = parseMiniMaxCodingPlanSnapshot({
      model_remains: [
        {
          current_interval_total_count: 1_000,
          current_interval_usage_count: 750,
          end_time: 1_800_000_000_000,
        },
      ],
    });

    expect(snapshot?.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'minimax-requests',
          direction: 'used',
          value: 250,
          primary: true,
        }),
      ]),
    );
  });

  it('uses the Token Plan endpoint without querying the legacy endpoint', async () => {
    mocks.fetchWithRetry.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          base_resp: { status_code: 0 },
          model_remains: [
            {
              model_name: 'MiniMax-M3',
              current_interval_total_count: 1_500,
              current_interval_usage_count: 1_200,
              current_interval_remaining_percent: 80,
              end_time: 1_800_000_000_000,
              current_weekly_total_count: 15_000,
              current_weekly_usage_count: 13_500,
              current_weekly_remaining_percent: 90,
              weekly_end_time: 1_800_500_000_000,
            },
          ],
        }),
        { status: 200 },
      ),
    );

    const result = await createBalanceProvider().refresh({
      provider: providerConfig('https://api.minimax.io/anthropic'),
      credential: { kind: 'token', token: 'token-plan-key' },
    });

    expect(result.success).toBe(true);
    expect(mocks.fetchWithRetry).toHaveBeenCalledOnce();
    expect(mocks.fetchWithRetry).toHaveBeenCalledWith(
      'https://www.minimax.io/v1/token_plan/remains',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({
          Authorization: 'Bearer token-plan-key',
        }),
      }),
    );
  });

  it('falls back to the legacy Coding Plan endpoint', async () => {
    mocks.fetchWithRetry
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ message: 'not a Token Plan key' }), {
          status: 401,
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            base_resp: { status_code: 0 },
            model_remains: [
              {
                current_interval_total_count: 1_000,
                current_interval_usage_count: 900,
                end_time: 1_800_000_000_000,
              },
            ],
          }),
          { status: 200 },
        ),
      );

    const result = await createBalanceProvider().refresh({
      provider: providerConfig('https://api.minimax.io/anthropic'),
      credential: { kind: 'token', token: 'legacy-key' },
    });

    expect(result.success).toBe(true);
    expect(mocks.fetchWithRetry).toHaveBeenCalledTimes(2);
    expect(mocks.fetchWithRetry.mock.calls.map(([url]) => url)).toEqual([
      'https://www.minimax.io/v1/token_plan/remains',
      'https://api.minimax.io/v1/api/openplatform/coding_plan/remains',
    ]);
  });
});

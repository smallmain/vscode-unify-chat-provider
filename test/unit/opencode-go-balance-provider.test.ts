import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';
import type { BalanceSnapshot } from '../../src/balance/types';

const mocks = vi.hoisted(() => ({
  fetchWithRetry: vi.fn(),
  token: 'oc_sk_test' as string,
}));

vi.mock('vscode', () => ({
  EventEmitter: class {
    readonly event = () => ({ dispose: () => undefined });
    fire(): void {}
    dispose(): void {}
  },
  env: { language: 'en' },
  l10n: {
    t: (message: string, ...args: unknown[]): string =>
      message.replace(/\{(\d+)\}/g, (match, index: string) => {
        const value = args[Number(index)];
        return value === undefined ? match : String(value);
      }),
  },
}));
vi.mock('../../src/client/utils', () => ({
  getToken: () => mocks.token,
}));
vi.mock('../../src/logger', () => ({
  createSimpleHttpLogger: () => undefined,
}));
vi.mock('../../src/utils', () => ({
  fetchWithRetry: mocks.fetchWithRetry,
  normalizeBaseUrlInput: (url: string) => url.replace(/\/+$/, ''),
}));

import { OpenCodeGoBalanceProvider } from '../../src/balance/providers/opencode-go';
import { evaluateBalanceWarning } from '../../src/balance/warning-utils';
import { formatPrimaryBadge, formatSnapshotLines } from '../../src/balance/display';
import { SecretStore } from '../../src/secret/secret-store';

const thresholds = {
  enabled: true,
  timeThresholdDays: 1,
  amountThreshold: 1,
  tokenThresholdMillions: 1,
};

const usageResponse = {
  usage: {
    rolling: {
      status: 'ok',
      percent: 30,
      resetsAt: '2026-11-21T15:00:00.000Z',
    },
    weekly: {
      status: 'ok',
      percent: 50,
      resetsAt: '2026-11-23T00:00:00.000Z',
    },
    monthly: {
      status: 'ok',
      percent: 20,
      resetsAt: '2026-12-01T00:00:00.000Z',
    },
  },
};

function createProvider(): OpenCodeGoBalanceProvider {
  const storage: vscode.SecretStorage = {
    onDidChange: () => ({ dispose: () => undefined }),
    keys: async () => [],
    get: async () => undefined,
    store: async () => undefined,
    delete: async () => undefined,
  };
  return new OpenCodeGoBalanceProvider({
    providerId: 'opencode',
    providerLabel: 'OpenCode Go',
    secretStore: new SecretStore(storage),
  });
}

async function refresh(
  payload: unknown,
): Promise<BalanceSnapshot> {
  mocks.fetchWithRetry.mockResolvedValueOnce(
    new Response(JSON.stringify(payload)),
  );

  const result = await createProvider().refresh({
    provider: {
      type: 'opencode-go',
      name: 'OpenCode Go',
      baseUrl: 'https://opencode.ai/zen/go/v1',
      models: [],
    },
    credential: { kind: 'token', token: 'oc_sk_test' },
  });
  if (!result.success || !result.snapshot) {
    throw new Error(result.error ?? 'Missing OpenCode Go snapshot');
  }
  return result.snapshot;
}

async function refreshWith(
  responses: readonly Response[],
): Promise<Awaited<ReturnType<OpenCodeGoBalanceProvider['refresh']>>> {
  for (const response of responses) {
    mocks.fetchWithRetry.mockResolvedValueOnce(response);
  }
  return createProvider().refresh({
    provider: {
      type: 'opencode-go',
      name: 'OpenCode Go',
      baseUrl: 'https://opencode.ai/zen/go/v1',
      models: [],
    },
    credential: { kind: 'token', token: 'oc_sk_test' },
  });
}

beforeEach(() => {
  mocks.fetchWithRetry.mockReset();
  mocks.token = 'oc_sk_test';
});

describe('OpenCode Go usage windows', () => {
  it('orders the windows monthly, weekly, 5-hour and keeps monthly primary', async () => {
    const snapshot = await refresh(usageResponse);

    expect(snapshot.items[0]).toEqual(
      expect.objectContaining({
        id: 'opencode-go-1-monthly-used-percent',
        type: 'percent',
        label: 'Monthly window',
        value: 20,
        basis: 'used',
      }),
    );
    expect(
      snapshot.items
        .filter((item) => item.type === 'percent')
        .map((item) => item.id),
    ).toEqual([
      'opencode-go-1-monthly-used-percent',
      'opencode-go-2-weekly-used-percent',
      'opencode-go-3-rolling-used-percent',
    ]);
    expect(snapshot.items).toContainEqual(
      expect.objectContaining({
        id: 'opencode-go-2-weekly-used-percent',
        label: 'Weekly window',
        value: 50,
      }),
    );
    expect(snapshot.items).toContainEqual(
      expect.objectContaining({
        id: 'opencode-go-3-rolling-used-percent',
        label: '5-hour window',
        value: 30,
      }),
    );
    expect(snapshot.items).toContainEqual(
      expect.objectContaining({
        id: 'opencode-go-1-monthly-reset-at',
        type: 'time',
        kind: 'resetAt',
        timestampMs: Date.parse('2026-12-01T00:00:00.000Z'),
      }),
    );
    expect(snapshot.items.filter((item) => item.primary)).toEqual([
      expect.objectContaining({ id: 'opencode-go-1-monthly-used-percent' }),
    ]);
    expect(formatPrimaryBadge(snapshot)).toBe('20%');
    expect(evaluateBalanceWarning(snapshot.items, thresholds).isNearThreshold).toBe(
      false,
    );
  });

  it('honours the first usage endpoint before falling back', async () => {
    await refresh(usageResponse);
    expect(mocks.fetchWithRetry).toHaveBeenCalledTimes(1);
    expect(mocks.fetchWithRetry.mock.calls[0]?.[0]).toBe(
      'https://opencode.ai/zen/go/v1/usage',
    );
  });

  it('falls back to the documented inference endpoint when the provider path fails', async () => {
    const result = await refreshWith([
      new Response('{}', { status: 404 }),
      new Response(JSON.stringify(usageResponse)),
    ]);

    expect(result.success).toBe(true);
    expect(mocks.fetchWithRetry.mock.calls[1]?.[0]).toBe(
      'https://opencode.ai/inference/go/v1/usage',
    );
    expect(formatSnapshotLines(result.snapshot).join('\n')).toContain(
      'Weekly window',
    );
  });

  it('accepts wrapped payloads and string percentages', async () => {
    const result = await refreshWith([
      new Response(
        JSON.stringify({
          data: {
            usage: {
              rolling: { status: 'ok', percent: '12.5' },
              weekly: { status: 'ok', percent: '40' },
            },
          },
        }),
      ),
    ]);

    expect(result.success).toBe(true);
    expect(formatPrimaryBadge(result.snapshot)).toBe('40%');
    expect(result.snapshot?.items.filter((item) => item.type === 'percent')).toHaveLength(
      2,
    );
  });

  it('reports an exhausted quota when a window is rate limited', async () => {
    const result = await refreshWith([
      new Response(
        JSON.stringify({
          usage: {
            rolling: { status: 'ok', percent: 30 },
            weekly: { status: 'rate-limited', percent: 100 },
            monthly: { status: 'ok', percent: 50 },
          },
        }),
      ),
    ]);

    expect(result.success).toBe(true);
    const items = result.snapshot?.items ?? [];
    expect(items.filter((item) => item.primary)).toEqual([
      expect.objectContaining({ type: 'status', value: 'exhausted' }),
    ]);
    expect(evaluateBalanceWarning(items, thresholds)).toEqual({
      isNearThreshold: true,
      reasons: ['status'],
    });
    expect(formatPrimaryBadge(result.snapshot)).toBe('Exhausted');
  });

  it('treats a percentage above 100 as exhausted', async () => {
    const result = await refreshWith([
      new Response(
        JSON.stringify({
          usage: {
            rolling: { status: 'ok', percent: 130 },
            weekly: { status: 'ok', percent: 100 },
            monthly: { status: 'ok', percent: 0 },
          },
        }),
      ),
    ]);

    expect(result.success).toBe(true);
    expect(
      result.snapshot?.items.find(
        (item) => item.id === 'opencode-go-3-rolling-used-percent',
      ),
    ).toEqual(expect.objectContaining({ value: 100 }));
  });

  it('reports an error when the response carries no quota percentages', async () => {
    const result = await refreshWith([new Response(JSON.stringify({}))]);

    expect(result.success).toBe(false);
    expect(result.error).toContain('does not include quota percentages');
  });

  it('surfaces the entitlement error from the usage API', async () => {
    const result = await refreshWith([
      new Response(
        JSON.stringify({
          type: 'error',
          error: {
            type: 'EntitlementError',
            message: 'OpenCode Go subscription required.',
          },
        }),
        { status: 403 },
      ),
    ]);

    expect(result.success).toBe(false);
    expect(result.error).toContain('OpenCode Go subscription required.');
  });

  it('requires an API key', async () => {
    mocks.token = '';

    const result = await createProvider().refresh({
      provider: {
        type: 'opencode-go',
        name: 'OpenCode Go',
        baseUrl: 'https://opencode.ai/zen/go/v1',
        models: [],
      },
      credential: { kind: 'none' },
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('API key is required');
    expect(mocks.fetchWithRetry).not.toHaveBeenCalled();
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';
import type { BalanceSnapshot } from '../../src/balance/types';

const mocks = vi.hoisted(() => ({ fetchWithRetry: vi.fn() }));

vi.mock('vscode', () => ({
  EventEmitter: class {
    readonly event = () => ({ dispose: () => undefined });
    fire(): void {}
    dispose(): void {}
  },
  env: { language: 'en' },
  l10n: { t: (message: string) => message },
}));
vi.mock('../../src/client/utils', () => ({
  getToken: () => 'test-key',
}));
vi.mock('../../src/logger', () => ({
  createSimpleHttpLogger: () => undefined,
}));
vi.mock('../../src/utils', () => ({
  fetchWithRetry: mocks.fetchWithRetry,
  normalizeBaseUrlInput: (url: string) => url.replace(/\/+$/, ''),
}));

import { KimiCodeBalanceProvider } from '../../src/balance/providers/kimi-code';
import { evaluateBalanceWarning } from '../../src/balance/warning-utils';
import { formatPrimaryBadge, formatSnapshotLines } from '../../src/balance/display';
import { SecretStore } from '../../src/secret/secret-store';

const thresholds = {
  enabled: true,
  timeThresholdDays: 1,
  amountThreshold: 1,
  tokenThresholdMillions: 1,
};

async function refresh(payload: unknown): Promise<BalanceSnapshot> {
  const storage: vscode.SecretStorage = {
    onDidChange: () => ({ dispose: () => undefined }),
    keys: async () => [],
    get: async () => undefined,
    store: async () => undefined,
    delete: async () => undefined,
  };
  const provider = new KimiCodeBalanceProvider({
    providerId: 'kimi',
    providerLabel: 'Kimi',
    secretStore: new SecretStore(storage),
  });
  mocks.fetchWithRetry.mockResolvedValueOnce(new Response(JSON.stringify(payload)));
  const result = await provider.refresh({
    provider: {
      type: 'anthropic',
      name: 'Kimi',
      baseUrl: 'https://api.kimi.com/coding/',
      models: [],
    },
    credential: { kind: 'token', token: 'test-key' },
  });
  if (!result.success || !result.snapshot) {
    throw new Error(result.error ?? 'Missing Kimi balance snapshot');
  }
  return result.snapshot;
}

beforeEach(() => mocks.fetchWithRetry.mockReset());

describe('Kimi Code quota units', () => {
  it.each([0, 5, 99])('does not apply the token warning threshold to %i used quota units', async (used) => {
    const snapshot = await refresh({
      usage: { limit: '100', used: String(used), resetTime: '2026-09-22T01:04:34Z' },
      limits: [{
        window: { duration: 300, timeUnit: 'TIME_UNIT_MINUTE' },
        detail: { limit: '100', used: '0' },
      }],
    });

    expect(snapshot.items.some((item) => item.type === 'token')).toBe(false);
    expect(formatPrimaryBadge(snapshot)).toBe(`${100 - used}%`);
    expect(formatSnapshotLines(snapshot).join('\n')).not.toMatch(/Tokens|0\.10K/);
    expect(evaluateBalanceWarning(snapshot.items, thresholds).isNearThreshold).toBe(false);
    expect(snapshot.items).toContainEqual(expect.objectContaining({
      id: 'quota-2', type: 'percent', value: 100, basis: 'remaining', periodLabel: '5h',
    }));
    expect(snapshot.items).toContainEqual(expect.objectContaining({
      id: 'reset-time', kind: 'resetAt', timestampMs: Date.parse('2026-09-22T01:04:34Z'),
    }));
  });

  it('derives remaining percentages from wrapped usage with arbitrary quota limits', async () => {
    const snapshot = await refresh({ data: { usage: { limit: '200', remaining: '150' } } });
    expect(formatPrimaryBadge(snapshot)).toBe('75%');
    expect(evaluateBalanceWarning(snapshot.items, thresholds).isNearThreshold).toBe(false);
  });

  it.each(['weekly', 'rolling'])('warns when the %s quota is exhausted', async (window) => {
    const snapshot = await refresh({
      usage: { limit: 100, used: window === 'weekly' ? 100 : 0 },
      limits: [{
        window: { duration: 300, timeUnit: 'TIME_UNIT_MINUTE' },
        detail: { limit: 100, used: window === 'rolling' ? 105 : 0 },
      }],
    });
    expect(evaluateBalanceWarning(snapshot.items, thresholds)).toEqual({
      isNearThreshold: true, reasons: ['status'],
    });
    expect(snapshot.items.filter((item) => item.primary)).toEqual([
      expect.objectContaining({ type: 'status', value: 'exhausted' }),
    ]);
  });

  it('clears exhaustion once the quota resets', async () => {
    const exhausted = await refresh({ usage: { limit: 100, used: 100 } });
    const restored = await refresh({ usage: { limit: 100, used: 0 } });
    expect(evaluateBalanceWarning(exhausted.items, thresholds).isNearThreshold).toBe(true);
    expect(evaluateBalanceWarning(restored.items, thresholds).isNearThreshold).toBe(false);
    expect(formatPrimaryBadge(restored)).toBe('100%');
  });

  it('does not invent a percentage or token count for usage without a known limit', async () => {
    const snapshot = await refresh({ usage: { used: 50 } });
    expect(snapshot.items).toEqual([
      expect.objectContaining({ type: 'integer', direction: 'used', value: 50, primary: true }),
    ]);
    expect(evaluateBalanceWarning(snapshot.items, thresholds).isNearThreshold).toBe(false);
  });
});

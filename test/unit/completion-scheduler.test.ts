import type * as vscode from 'vscode';
import { describe, expect, it, vi } from 'vitest';
import {
  scheduleCompletionProviders,
  type CompletionScheduleRequest,
} from '../../src/completion/scheduler';
import type {
  CompletionAlgorithmEntry,
  CompletionAlgorithmResult,
  CompletionStrategy,
} from '../../src/completion/types';

function createToken(): vscode.CancellationToken {
  return {
    isCancellationRequested: false,
    onCancellationRequested: () => ({ dispose() {} }),
  };
}

function createCancellationSource(): {
  token: vscode.CancellationToken;
  cancel(): void;
} {
  const listeners = new Set<() => void>();
  let cancelled = false;
  return {
    token: {
      get isCancellationRequested(): boolean {
        return cancelled;
      },
      onCancellationRequested: (listener, thisArgs, disposables) => {
        const callback = (): void => {
          listener.call(thisArgs, undefined);
        };
        const disposable: vscode.Disposable = {
          dispose: () => listeners.delete(callback),
        };
        if (cancelled) {
          queueMicrotask(callback);
        } else {
          listeners.add(callback);
        }
        disposables?.push(disposable);
        return disposable;
      },
    },
    cancel(): void {
      if (cancelled) {
        return;
      }
      cancelled = true;
      for (const listener of [...listeners]) {
        listener();
      }
      listeners.clear();
    },
  };
}

function provider(id: string): CompletionAlgorithmEntry {
  return { id, algorithm: 'simple' };
}

function result(
  providerId: string,
  ...insertTexts: string[]
): CompletionAlgorithmResult {
  return {
    providerId,
    items: insertTexts.map((insertText) => ({ insertText })),
  };
}

const allSettled: CompletionStrategy = {
  mode: 'all',
  stopWhen: { type: 'allSettled' },
};

const schedulerMatrix: Array<{
  name: string;
  strategy: CompletionStrategy;
}> = (
  [
    { name: 'firstUsable', value: { type: 'firstUsable' } },
    { name: 'deadline', value: { type: 'deadline', timeoutMs: 100 } },
    {
      name: 'enoughResults',
      value: { type: 'enoughResults', minItems: 1 },
    },
    { name: 'allSettled', value: { type: 'allSettled' } },
  ] as const
).flatMap(({ name, value }) => [
  {
    name: `all/${name}`,
    strategy: { mode: 'all', stopWhen: value } satisfies CompletionStrategy,
  },
  {
    name: `main-first/${name}`,
    strategy: {
      mode: 'main-first',
      mainProvider: 'main',
      parallelRequestOthers: false,
      stopWhen: value,
    } satisfies CompletionStrategy,
  },
]);

describe('completion scheduler', () => {
  it.each(schedulerMatrix)('$name returns the usable fallback', async ({ strategy }) => {
    const items = await scheduleCompletionProviders(
      [
        {
          provider: provider('main'),
          run: async () => result('main'),
        },
        {
          provider: provider('fallback'),
          run: async () => result('fallback', 'fallback'),
        },
      ],
      strategy,
      createToken(),
    );

    expect(items).toEqual([{ insertText: 'fallback' }]);
  });

  it('merges in actual return order and removes duplicate items', async () => {
    vi.useFakeTimers();
    const scheduled = scheduleCompletionProviders(
      [
        {
          provider: provider('slow'),
          run: async () => {
            await new Promise((resolve) => setTimeout(resolve, 20));
            return result('slow', 'duplicate', 'slow');
          },
        },
        {
          provider: provider('fast'),
          run: async () => {
            await new Promise((resolve) => setTimeout(resolve, 5));
            return result('fast', 'duplicate', 'fast');
          },
        },
      ],
      allSettled,
      createToken(),
    );

    await vi.runAllTimersAsync();
    const items = await scheduled;
    expect(items.map((item) => item.insertText)).toEqual([
      'duplicate',
      'fast',
      'slow',
    ]);
    vi.useRealTimers();
  });

  it('returns the first usable result and cancels outstanding providers', async () => {
    let slowCancelled = false;
    const onProviderError = vi.fn();
    const items = await scheduleCompletionProviders(
      [
        {
          provider: provider('fast'),
          run: async () => result('fast', 'first'),
        },
        {
          provider: provider('slow'),
          run: (token) =>
            new Promise((_resolve, reject) => {
              token.onCancellationRequested(() => {
                slowCancelled = true;
                reject(new Error('cancelled'));
              });
            }),
        },
      ],
      { mode: 'all', stopWhen: { type: 'firstUsable', graceMs: 0 } },
      createToken(),
      { onProviderError },
    );

    expect(items.map((item) => item.insertText)).toEqual(['first']);
    expect(slowCancelled).toBe(true);
    expect(onProviderError).not.toHaveBeenCalled();
  });

  it('falls back to all/firstUsable when the main provider is missing', async () => {
    const missing = vi.fn();
    const items = await scheduleCompletionProviders(
      [
        {
          provider: provider('available'),
          run: async () => result('available', 'fallback'),
        },
      ],
      {
        mode: 'main-first',
        mainProvider: 'missing',
        stopWhen: { type: 'allSettled' },
      },
      createToken(),
      { onMissingMainProvider: missing },
    );

    expect(items.map((item) => item.insertText)).toEqual(['fallback']);
    expect(missing).toHaveBeenCalledWith('missing');
  });

  it('returns a usable sequential main provider without starting fallbacks', async () => {
    const fallback = vi.fn(async () => result('fallback', 'fallback'));
    const items = await scheduleCompletionProviders(
      [
        {
          provider: provider('main'),
          run: async () => result('main', 'main'),
        },
        { provider: provider('fallback'), run: fallback },
      ],
      {
        mode: 'main-first',
        mainProvider: 'main',
        parallelRequestOthers: false,
        stopWhen: { type: 'allSettled' },
      },
      createToken(),
    );

    expect(items.map((item) => item.insertText)).toEqual(['main']);
    expect(fallback).not.toHaveBeenCalled();
  });

  it('starts sequential fallbacks when the main provider has no result', async () => {
    const fallback = vi.fn(async () => result('fallback', 'fallback'));
    const items = await scheduleCompletionProviders(
      [
        {
          provider: provider('main'),
          run: async () => result('main'),
        },
        { provider: provider('fallback'), run: fallback },
      ],
      {
        mode: 'main-first',
        mainProvider: 'main',
        parallelRequestOthers: false,
        stopWhen: { type: 'firstUsable' },
      },
      createToken(),
    );

    expect(items.map((item) => item.insertText)).toEqual(['fallback']);
    expect(fallback).toHaveBeenCalledOnce();
  });

  it('honors a global deadline while waiting for a sequential main provider', async () => {
    vi.useFakeTimers();
    try {
      let mainCancelled = false;
      const fallback = vi.fn(async () => result('fallback', 'fallback'));
      const scheduled = scheduleCompletionProviders(
        [
          {
            provider: provider('main'),
            run: (token) =>
              new Promise((resolve) => {
                token.onCancellationRequested(() => {
                  mainCancelled = true;
                  resolve(result('main'));
                });
              }),
          },
          { provider: provider('fallback'), run: fallback },
        ],
        {
          mode: 'main-first',
          mainProvider: 'main',
          mainFirstTimeoutMs: 100,
          parallelRequestOthers: false,
          stopWhen: { type: 'deadline', timeoutMs: 10 },
        },
        createToken(),
      );

      await vi.advanceTimersByTimeAsync(10);
      expect(await scheduled).toEqual([]);
      expect(mainCancelled).toBe(true);
      expect(fallback).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('isolates provider failures', async () => {
    const onProviderError = vi.fn();
    const items = await scheduleCompletionProviders(
      [
        {
          provider: provider('broken'),
          run: async () => {
            throw new Error('broken');
          },
        },
        {
          provider: provider('working'),
          run: async () => result('working', 'ok'),
        },
      ],
      allSettled,
      createToken(),
      { onProviderError },
    );

    expect(items.map((item) => item.insertText)).toEqual(['ok']);
    expect(onProviderError).toHaveBeenCalledOnce();
  });

  it('keeps parallel fallback results behind the main-first gate', async () => {
    vi.useFakeTimers();
    try {
      const scheduled = scheduleCompletionProviders(
        [
          {
            provider: provider('main'),
            run: async () => {
              await new Promise((resolve) => setTimeout(resolve, 20));
              return result('main', 'main');
            },
          },
          {
            provider: provider('fallback'),
            run: async () => result('fallback', 'fallback'),
          },
        ],
        {
          mode: 'main-first',
          mainProvider: 'main',
          mainFirstTimeoutMs: 50,
          parallelRequestOthers: true,
          stopWhen: { type: 'firstUsable' },
        },
        createToken(),
      );

      await vi.advanceTimersByTimeAsync(20);
      expect(await scheduled).toEqual([{ insertText: 'main' }]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('releases an already-settled parallel fallback after the main-first timeout', async () => {
    vi.useFakeTimers();
    try {
      let mainCancelled = false;
      const scheduled = scheduleCompletionProviders(
        [
          {
            provider: provider('main'),
            run: (token) =>
              new Promise((resolve) => {
                token.onCancellationRequested(() => {
                  mainCancelled = true;
                  resolve(result('main'));
                });
              }),
          },
          {
            provider: provider('fallback'),
            run: async () => result('fallback', 'fallback'),
          },
        ],
        {
          mode: 'main-first',
          mainProvider: 'main',
          mainFirstTimeoutMs: 25,
          parallelRequestOthers: true,
          stopWhen: { type: 'firstUsable' },
        },
        createToken(),
      );

      await vi.advanceTimersByTimeAsync(24);
      let settled = false;
      void scheduled.then(() => {
        settled = true;
      });
      await Promise.resolve();
      expect(settled).toBe(false);

      await vi.advanceTimersByTimeAsync(1);
      expect(await scheduled).toEqual([{ insertText: 'fallback' }]);
      expect(mainCancelled).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(['empty', 'failure'] as const)(
    'opens the parallel main-first gate as soon as the main provider settles with %s',
    async (mainOutcome) => {
      vi.useFakeTimers();
      try {
        const onProviderError = vi.fn();
        const scheduled = scheduleCompletionProviders(
          [
            {
              provider: provider('main'),
              run: async () => {
                if (mainOutcome === 'failure') {
                  throw new Error('main failed');
                }
                return result('main');
              },
            },
            {
              provider: provider('fallback'),
              run: async () => result('fallback', 'fallback'),
            },
          ],
          {
            mode: 'main-first',
            mainProvider: 'main',
            mainFirstTimeoutMs: 500,
            parallelRequestOthers: true,
            stopWhen: { type: 'firstUsable' },
          },
          createToken(),
          { onProviderError },
        );

        let settledBeforeTimeout = false;
        void scheduled.then(() => {
          settledBeforeTimeout = true;
        });
        await vi.advanceTimersByTimeAsync(0);
        const observedBeforeTimeout = settledBeforeTimeout;
        await vi.runAllTimersAsync();

        expect(observedBeforeTimeout).toBe(true);
        expect(await scheduled).toEqual([{ insertText: 'fallback' }]);
        expect(onProviderError).toHaveBeenCalledTimes(
          mainOutcome === 'failure' ? 1 : 0,
        );
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it('starts sequential fallbacks when the main-first timeout expires', async () => {
    vi.useFakeTimers();
    try {
      let mainCancelled = false;
      const fallback = vi.fn(async () => result('fallback', 'fallback'));
      const scheduled = scheduleCompletionProviders(
        [
          {
            provider: provider('main'),
            run: (token) =>
              new Promise((resolve) => {
                token.onCancellationRequested(() => {
                  mainCancelled = true;
                  resolve(result('main'));
                });
              }),
          },
          { provider: provider('fallback'), run: fallback },
        ],
        {
          mode: 'main-first',
          mainProvider: 'main',
          mainFirstTimeoutMs: 25,
          parallelRequestOthers: false,
          stopWhen: { type: 'firstUsable' },
        },
        createToken(),
      );

      await vi.advanceTimersByTimeAsync(25);
      expect(await scheduled).toEqual([{ insertText: 'fallback' }]);
      expect(fallback).toHaveBeenCalledOnce();
      expect(mainCancelled).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('waits through enoughResults grace and cancels requests still running', async () => {
    vi.useFakeTimers();
    try {
      let slowCancelled = false;
      const scheduled = scheduleCompletionProviders(
        [
          {
            provider: provider('first'),
            run: async () => result('first', 'one'),
          },
          {
            provider: provider('second'),
            run: async () => {
              await new Promise((resolve) => setTimeout(resolve, 5));
              return result('second', 'two');
            },
          },
          {
            provider: provider('slow'),
            run: (token) =>
              new Promise((resolve) => {
                token.onCancellationRequested(() => {
                  slowCancelled = true;
                  resolve(result('slow'));
                });
              }),
          },
        ],
        {
          mode: 'all',
          stopWhen: { type: 'enoughResults', minItems: 1, graceMs: 10 },
        },
        createToken(),
      );

      await vi.advanceTimersByTimeAsync(9);
      let settled = false;
      void scheduled.then(() => {
        settled = true;
      });
      await Promise.resolve();
      expect(settled).toBe(false);

      await vi.advanceTimersByTimeAsync(1);
      expect((await scheduled).map((item) => item.insertText)).toEqual([
        'one',
        'two',
      ]);
      expect(slowCancelled).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('returns all available results when enoughResults cannot be reached', async () => {
    const items = await scheduleCompletionProviders(
      [
        {
          provider: provider('one'),
          run: async () => result('one', 'one'),
        },
        {
          provider: provider('empty'),
          run: async () => result('empty'),
        },
      ],
      {
        mode: 'all',
        stopWhen: { type: 'enoughResults', minItems: 2, graceMs: 100 },
      },
      createToken(),
    );

    expect(items).toEqual([{ insertText: 'one' }]);
  });

  it('returns deadline results in actual settlement order', async () => {
    vi.useFakeTimers();
    try {
      let lateCancelled = false;
      const scheduled = scheduleCompletionProviders(
        [
          {
            provider: provider('second'),
            run: async () => {
              await new Promise((resolve) => setTimeout(resolve, 10));
              return result('second', 'second');
            },
          },
          {
            provider: provider('first'),
            run: async () => {
              await new Promise((resolve) => setTimeout(resolve, 5));
              return result('first', 'first');
            },
          },
          {
            provider: provider('late'),
            run: (token) =>
              new Promise((resolve) => {
                token.onCancellationRequested(() => {
                  lateCancelled = true;
                  resolve(result('late'));
                });
              }),
          },
        ],
        { mode: 'all', stopWhen: { type: 'deadline', timeoutMs: 15 } },
        createToken(),
      );

      await vi.advanceTimersByTimeAsync(15);
      expect((await scheduled).map((item) => item.insertText)).toEqual([
        'first',
        'second',
      ]);
      expect(lateCancelled).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancels every running provider when the parent token is cancelled', async () => {
    const parent = createCancellationSource();
    const cancellations: string[] = [];
    const makePending = (id: string): CompletionScheduleRequest['run'] =>
      (token) =>
        new Promise((resolve) => {
          token.onCancellationRequested(() => {
            cancellations.push(id);
            resolve(result(id));
          });
        });

    const scheduled = scheduleCompletionProviders(
      [
        { provider: provider('one'), run: makePending('one') },
        { provider: provider('two'), run: makePending('two') },
      ],
      allSettled,
      parent.token,
    );
    await Promise.resolve();
    parent.cancel();

    expect(await scheduled).toEqual([]);
    expect(cancellations.sort()).toEqual(['one', 'two']);
  });

  it('deduplicates snippets by value and range while retaining distinct ranges', async () => {
    const rangeA = {
      start: { line: 1, character: 2 },
      end: { line: 1, character: 4 },
    } as vscode.Range;
    const rangeB = {
      start: { line: 2, character: 2 },
      end: { line: 2, character: 4 },
    } as vscode.Range;
    const snippet = { value: 'same' } as vscode.SnippetString;
    const items = await scheduleCompletionProviders(
      [
        {
          provider: provider('one'),
          run: async () => ({
            providerId: 'one',
            items: [
              { insertText: snippet, range: rangeA },
              { insertText: 'same', range: rangeB },
            ],
          }),
        },
        {
          provider: provider('two'),
          run: async () => ({
            providerId: 'two',
            items: [
              { insertText: 'same', range: rangeA },
              { insertText: { value: 'same' } as vscode.SnippetString, range: rangeB },
            ],
          }),
        },
      ],
      allSettled,
      createToken(),
    );

    expect(items).toHaveLength(2);
    expect(items.map((item) => item.range?.start.line)).toEqual([1, 2]);
  });

  it('retains otherwise identical edits targeting different documents', async () => {
    const range = {
      start: { line: 1, character: 2 },
      end: { line: 1, character: 4 },
    } as vscode.Range;
    const firstUri = {
      toString: () => 'file:///workspace/first.ts',
    } as vscode.Uri;
    const secondUri = {
      toString: () => 'file:///workspace/second.ts',
    } as vscode.Uri;

    const items = await scheduleCompletionProviders(
      [
        {
          provider: provider('one'),
          run: async () => ({
            providerId: 'one',
            items: [{ insertText: 'same', range, uri: firstUri }],
          }),
        },
        {
          provider: provider('two'),
          run: async () => ({
            providerId: 'two',
            items: [{ insertText: 'same', range, uri: secondUri }],
          }),
        },
      ],
      allSettled,
      createToken(),
    );

    expect(items.map((item) => item.uri?.toString())).toEqual([
      'file:///workspace/first.ts',
      'file:///workspace/second.ts',
    ]);
  });

  it('does not report a failure racing with scheduler cancellation', async () => {
    const onProviderError = vi.fn();
    const items = await scheduleCompletionProviders(
      [
        {
          provider: provider('winner'),
          run: async () => result('winner', 'winner'),
        },
        {
          provider: provider('cancelled'),
          run: (token) =>
            new Promise((_resolve, reject) => {
              token.onCancellationRequested(() => {
                queueMicrotask(() => reject(new Error('cancelled')));
              });
            }),
        },
      ],
      { mode: 'all', stopWhen: { type: 'firstUsable' } },
      createToken(),
      { onProviderError },
    );
    await Promise.resolve();

    expect(items).toEqual([{ insertText: 'winner' }]);
    expect(onProviderError).not.toHaveBeenCalled();
  });

  it('reports a settled result that was not selected', async () => {
    const onDiscardedItems = vi.fn();
    const items = await scheduleCompletionProviders(
      [
        {
          provider: provider('main'),
          run: async () => result('main', 'main'),
        },
        {
          provider: provider('fallback'),
          run: async () => result('fallback', 'fallback'),
        },
      ],
      {
        mode: 'main-first',
        mainProvider: 'main',
        parallelRequestOthers: true,
        mainFirstTimeoutMs: 100,
        stopWhen: { type: 'firstUsable' },
      },
      createToken(),
      { onDiscardedItems },
    );

    expect(items).toEqual([{ insertText: 'main' }]);
    expect(onDiscardedItems).toHaveBeenCalledWith(
      'fallback',
      [{ insertText: 'fallback' }],
      'not-taken',
    );
  });

  it('reports duplicate items excluded from the merged result', async () => {
    const onDiscardedItems = vi.fn();
    const duplicate = { insertText: 'same' };
    const items = await scheduleCompletionProviders(
      [
        {
          provider: provider('first'),
          run: async () => result('first', 'same'),
        },
        {
          provider: provider('second'),
          run: async () => ({ providerId: 'second', items: [duplicate] }),
        },
      ],
      allSettled,
      createToken(),
      { onDiscardedItems },
    );

    expect(items).toEqual([{ insertText: 'same' }]);
    expect(onDiscardedItems).toHaveBeenCalledWith(
      'second',
      [duplicate],
      'duplicate',
    );
  });

  it('reports a provider result that resolves after the scheduler returned', async () => {
    let resolveLate: ((value: CompletionAlgorithmResult) => void) | undefined;
    const onDiscardedItems = vi.fn();
    const items = await scheduleCompletionProviders(
      [
        {
          provider: provider('winner'),
          run: async () => result('winner', 'winner'),
        },
        {
          provider: provider('late'),
          run: () =>
            new Promise((resolve) => {
              resolveLate = resolve;
            }),
        },
      ],
      { mode: 'all', stopWhen: { type: 'firstUsable' } },
      createToken(),
      { onDiscardedItems },
    );

    const late = result('late', 'late');
    resolveLate?.(late);
    await Promise.resolve();
    await Promise.resolve();

    expect(items).toEqual([{ insertText: 'winner' }]);
    expect(onDiscardedItems).toHaveBeenCalledWith(
      'late',
      late.items,
      'lost-race',
    );
  });
});

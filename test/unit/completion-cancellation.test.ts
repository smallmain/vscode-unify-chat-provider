import type * as vscode from 'vscode';
import { describe, expect, it, vi } from 'vitest';
import { LinkedCancellationTokenSource } from '../../src/completion/cancellation';

interface TrackedCancellationSource {
  readonly token: vscode.CancellationToken;
  readonly listenerCount: number;
  readonly subscriptionDisposals: number;
  cancel(): void;
}

function createTrackedCancellationSource(): TrackedCancellationSource {
  const listeners = new Set<() => void>();
  let cancelled = false;
  let subscriptionDisposals = 0;
  return {
    token: {
      get isCancellationRequested(): boolean {
        return cancelled;
      },
      onCancellationRequested: (listener, thisArgs, disposables) => {
        const callback = (): void => listener.call(thisArgs, undefined);
        let disposed = false;
        const disposable: vscode.Disposable = {
          dispose: () => {
            if (disposed) return;
            disposed = true;
            subscriptionDisposals += 1;
            listeners.delete(callback);
          },
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
    get listenerCount(): number {
      return listeners.size;
    },
    get subscriptionDisposals(): number {
      return subscriptionDisposals;
    },
    cancel(): void {
      if (cancelled) return;
      cancelled = true;
      const pending = [...listeners];
      listeners.clear();
      for (const listener of pending) listener();
    },
  };
}

describe('LinkedCancellationTokenSource listener leases', () => {
  it('retains existing listeners across dispose and rejects new listeners', () => {
    const parent = createTrackedCancellationSource();
    const source = new LinkedCancellationTokenSource(parent.token);
    const existing = vi.fn();
    const late = vi.fn();
    source.token.onCancellationRequested(existing);

    source.dispose();
    source.token.onCancellationRequested(late);
    expect(parent.listenerCount).toBe(1);

    parent.cancel();
    expect(existing).toHaveBeenCalledTimes(1);
    expect(late).not.toHaveBeenCalled();
    expect(source.token.isCancellationRequested).toBe(true);
    expect(parent.listenerCount).toBe(0);
    expect(parent.subscriptionDisposals).toBe(1);
  });

  it('detaches from the parent when the final existing listener releases', () => {
    const parent = createTrackedCancellationSource();
    const source = new LinkedCancellationTokenSource(parent.token);
    const listener = vi.fn();
    const subscription = source.token.onCancellationRequested(listener);

    source.dispose();
    expect(parent.listenerCount).toBe(1);
    subscription.dispose();

    expect(parent.listenerCount).toBe(0);
    expect(parent.subscriptionDisposals).toBe(1);
    parent.cancel();
    expect(listener).not.toHaveBeenCalled();
  });

  it('detaches immediately when dispose has no outstanding listeners', () => {
    const parent = createTrackedCancellationSource();
    const source = new LinkedCancellationTokenSource(parent.token);

    source.dispose();

    expect(parent.listenerCount).toBe(0);
    expect(parent.subscriptionDisposals).toBe(1);
  });
});

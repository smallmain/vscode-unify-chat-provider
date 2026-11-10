import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => {
  class CancellationError extends Error {}
  class CancellationTokenSource {
    private readonly listeners = new Set<() => void>();
    readonly token = {
      isCancellationRequested: false,
      onCancellationRequested: (listener: () => void) => {
        this.listeners.add(listener);
        return { dispose: () => { this.listeners.delete(listener); } };
      },
    };
    cancel(): void {
      if (this.token.isCancellationRequested) return;
      this.token.isCancellationRequested = true;
      for (const listener of [...this.listeners]) listener();
    }
    dispose(): void { this.listeners.clear(); }
  }
  return { CancellationError, CancellationTokenSource };
});

import * as vscode from 'vscode';
import { CredentialRequestCoordinator } from '../../src/auth/credential-request';

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: Error) => void } {
  let resolve = (_value: T): void => { throw new Error('Not initialized'); };
  let reject = (_error: Error): void => { throw new Error('Not initialized'); };
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe('credential request coordination', () => {
  it('shares one interaction across concurrent requests and clears it on success', async () => {
    const coordinator = new CredentialRequestCoordinator<string>();
    const source = new vscode.CancellationTokenSource();
    const result = deferred<string>();
    const work = vi.fn(async () => result.promise);
    const requests = [0, 1, 2].map(() => coordinator.run('provider', source.token, work));
    await Promise.resolve();
    expect(work).toHaveBeenCalledTimes(1);
    result.resolve('credential');
    expect(await Promise.all(requests)).toEqual(['credential', 'credential', 'credential']);
    expect(await coordinator.run('provider', source.token, async () => 'new credential')).toBe('new credential');
    coordinator.dispose();
    source.dispose();
  });

  it('does not cancel another waiter when one caller cancels', async () => {
    const coordinator = new CredentialRequestCoordinator<string>();
    const first = new vscode.CancellationTokenSource();
    const second = new vscode.CancellationTokenSource();
    const result = deferred<string>();
    let operationToken: vscode.CancellationToken | undefined;
    const work = async (token: vscode.CancellationToken): Promise<string> => {
      operationToken = token;
      return result.promise;
    };
    const a = coordinator.run('provider', first.token, work);
    const b = coordinator.run('provider', second.token, work);
    const rejection = expect(a).rejects.toBeInstanceOf(vscode.CancellationError);
    await Promise.resolve();
    first.cancel();
    await rejection;
    expect(operationToken?.isCancellationRequested).toBe(false);
    result.resolve('credential');
    expect(await b).toBe('credential');
    coordinator.dispose();
    first.dispose();
    second.dispose();
  });

  it('cancels abandoned work and keeps a new waiter cancellable while the old modal closes', async () => {
    const coordinator = new CredentialRequestCoordinator<string>();
    const first = new vscode.CancellationTokenSource();
    const second = new vscode.CancellationTokenSource();
    const modal = deferred<string>();
    let operationToken: vscode.CancellationToken | undefined;
    const a = coordinator.run('provider', first.token, async (token) => {
      operationToken = token;
      return modal.promise;
    });
    const cancelledA = expect(a).rejects.toBeInstanceOf(vscode.CancellationError);
    await Promise.resolve();
    first.cancel();
    await cancelledA;
    expect(operationToken?.isCancellationRequested).toBe(true);
    const next = vi.fn(async () => 'new credential');
    const b = coordinator.run('provider', second.token, next);
    const cancelledB = expect(b).rejects.toBeInstanceOf(vscode.CancellationError);
    second.cancel();
    await cancelledB;
    expect(next).not.toHaveBeenCalled();
    modal.resolve('old credential');
    const third = new vscode.CancellationTokenSource();
    expect(await coordinator.run('provider', third.token, next)).toBe('new credential');
    coordinator.dispose();
    first.dispose();
    second.dispose();
    third.dispose();
  });

  it('shares failures without automatically restarting authentication', async () => {
    const coordinator = new CredentialRequestCoordinator<string>();
    const source = new vscode.CancellationTokenSource();
    const failure = new Error('Authentication cancelled');
    const work = vi.fn(async (): Promise<string> => { throw failure; });
    const results = await Promise.allSettled([coordinator.run('provider', source.token, work), coordinator.run('provider', source.token, work)]);
    expect(work).toHaveBeenCalledTimes(1);
    expect(results).toEqual([{ status: 'rejected', reason: failure }, { status: 'rejected', reason: failure }]);
    expect(await coordinator.run('provider', source.token, async () => 'retry')).toBe('retry');
    coordinator.dispose();
    source.dispose();
  });

  it('isolates authentication targets and refuses cancelled callers before starting work', async () => {
    const coordinator = new CredentialRequestCoordinator<string>();
    const source = new vscode.CancellationTokenSource();
    expect(await Promise.all([
      coordinator.run('target-a', source.token, async () => 'a'),
      coordinator.run('target-b', source.token, async () => 'b'),
    ])).toEqual(['a', 'b']);
    source.cancel();
    const work = vi.fn(async () => 'unexpected');
    await expect(coordinator.run('target-a', source.token, work)).rejects.toBeInstanceOf(vscode.CancellationError);
    expect(work).not.toHaveBeenCalled();
    coordinator.dispose();
    source.dispose();
  });

  it('cancels waiters on disposal and rejects new requests', async () => {
    const coordinator = new CredentialRequestCoordinator<string>();
    const source = new vscode.CancellationTokenSource();
    const result = deferred<string>();
    const pending = coordinator.run('provider', source.token, async () => result.promise);
    const rejected = expect(pending).rejects.toBeInstanceOf(vscode.CancellationError);
    coordinator.dispose();
    await rejected;
    await expect(coordinator.run('provider', source.token, async () => 'unexpected')).rejects.toBeInstanceOf(vscode.CancellationError);
    result.resolve('unused');
    source.dispose();
  });
});

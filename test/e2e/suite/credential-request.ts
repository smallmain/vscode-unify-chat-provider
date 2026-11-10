import * as assert from 'node:assert/strict';
import { join } from 'node:path';
import * as vscode from 'vscode';

interface CredentialRequests {
  run(key: string, token: vscode.CancellationToken, work: (token: vscode.CancellationToken) => Promise<string>): Promise<string>;
  dispose(): void;
}

function isCoordinatorConstructor(value: unknown): value is new () => CredentialRequests {
  if (typeof value !== 'function') return false;
  const prototype: unknown = Reflect.get(value, 'prototype');
  return typeof prototype === 'object' && prototype !== null &&
    typeof Reflect.get(prototype, 'run') === 'function' &&
    typeof Reflect.get(prototype, 'dispose') === 'function';
}

export async function runCredentialRequestE2E(extensionPath: string): Promise<void> {
  const loaded: unknown = require(join(extensionPath, 'out/auth/credential-request.js'));
  assert.ok(typeof loaded === 'object' && loaded !== null);
  const constructor: unknown = Reflect.get(loaded, 'CredentialRequestCoordinator');
  assert.ok(isCoordinatorConstructor(constructor));
  const coordinator = new constructor();
  const first = new vscode.CancellationTokenSource();
  const second = new vscode.CancellationTokenSource();
  let release = (_value: string): void => { throw new Error('Not initialized'); };
  const result = new Promise<string>((resolve) => { release = resolve; });
  let operationToken: vscode.CancellationToken | undefined;
  let calls = 0;
  const work = async (token: vscode.CancellationToken): Promise<string> => {
    calls++;
    operationToken = token;
    return result;
  };
  try {
    const a = coordinator.run('same-provider', first.token, work);
    const b = coordinator.run('same-provider', second.token, work);
    const rejected = assert.rejects(a, (error: unknown) => error instanceof vscode.CancellationError);
    await Promise.resolve();
    assert.equal(calls, 1);
    first.cancel();
    await rejected;
    assert.equal(operationToken?.isCancellationRequested, false);
    release('credential');
    assert.equal(await b, 'credential');

    const cancelled = new vscode.CancellationTokenSource();
    cancelled.cancel();
    await assert.rejects(coordinator.run('cancelled', cancelled.token, work), (error: unknown) => error instanceof vscode.CancellationError);
    assert.equal(calls, 1);
    cancelled.dispose();

    let finishAbandoned = (): void => { throw new Error('Not initialized'); };
    const modal = new Promise<string>((resolve) => { finishAbandoned = () => resolve('unused'); });
    const pending = coordinator.run('pending', second.token, async () => modal);
    const disposed = assert.rejects(pending, (error: unknown) => error instanceof vscode.CancellationError);
    coordinator.dispose();
    await disposed;
    finishAbandoned();
    console.log('Extension Host credential request coordination E2E passed');
  } finally {
    release('unused');
    coordinator.dispose();
    first.dispose();
    second.dispose();
  }
}

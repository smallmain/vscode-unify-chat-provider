import { mkdtemp, rm } from 'node:fs/promises';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => {
  class Disposable {
    constructor(private readonly callback: () => void = () => undefined) {}

    dispose(): void {
      this.callback();
    }
  }

  class EventEmitter<T> {
    private readonly listeners = new Set<(value: T) => void>();
    readonly event = (listener: (value: T) => void): Disposable => {
      this.listeners.add(listener);
      return new Disposable(() => this.listeners.delete(listener));
    };

    fire(value: T): void {
      for (const listener of this.listeners) {
        listener(value);
      }
    }

    dispose(): void {
      this.listeners.clear();
    }
  }

  return {
    Disposable,
    EventEmitter,
    ExtensionMode: {
      Production: 1,
      Development: 2,
      Test: 3,
    },
    env: { language: 'en', machineId: 'test-machine' },
    l10n: { t: (message: string) => message },
  };
});

vi.mock('../../src/logger', () => ({
  authLog: {
    error: vi.fn(),
    verbose: vi.fn(),
    warn: vi.fn(),
  },
}));

import { MainInstanceCoordinator } from '../../src/main-instance/coordinator';

type Deferred = {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
};

const coordinators = new Set<MainInstanceCoordinator>();
const storagePaths = new Set<string>();
const deferreds = new Set<Deferred>();

afterEach(async () => {
  for (const deferred of deferreds) {
    deferred.resolve();
  }
  deferreds.clear();

  for (const coordinator of coordinators) {
    coordinator.dispose();
  }
  await Promise.all(
    [...coordinators].map(async (coordinator) => {
      await invokePrivate(coordinator, 'disposeLeaderServer', []);
    }),
  );
  coordinators.clear();

  await Promise.all(
    [...storagePaths].map(async (storagePath) => {
      await rm(storagePath, { recursive: true, force: true });
    }),
  );
  storagePaths.clear();
});

function createDeferred(): Deferred {
  let resolvePromise: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  const deferred = { promise, resolve: resolvePromise };
  deferreds.add(deferred);
  return deferred;
}

function invokePrivate(
  target: object,
  methodName: string,
  args: readonly unknown[],
): unknown {
  const method: unknown = Reflect.get(target, methodName);
  if (typeof method !== 'function') {
    throw new Error(`Missing coordinator method ${methodName}.`);
  }
  return Reflect.apply(method, target, args);
}

async function createStoragePath(): Promise<string> {
  const storagePath = await mkdtemp(
    path.join(os.tmpdir(), 'ucp-main-instance-coordinator-'),
  );
  storagePaths.add(storagePath);
  return storagePath;
}

async function initializeCoordinator(
  coordinator: MainInstanceCoordinator,
  storagePath: string,
): Promise<void> {
  coordinators.add(coordinator);
  await invokePrivate(coordinator, 'initialize', [
    {
      extensionMode: 1,
      extension: {
        id: 'test.main-instance-coordinator',
        packageJSON: { version: '1.0.0-test' },
      },
      globalStorageUri: { fsPath: storagePath },
    },
  ]);
}

function errorCode(error: Error): string | undefined {
  if ('code' in error && typeof error.code === 'string') {
    return error.code;
  }
  return undefined;
}

async function canAcquireSocket(socketPath: string): Promise<boolean> {
  const server = net.createServer();
  return await new Promise<boolean>((resolve, reject) => {
    const onError = (error: Error): void => {
      if (errorCode(error) === 'EADDRINUSE') {
        resolve(false);
        return;
      }
      reject(error);
    };

    server.once('error', onError);
    server.listen(socketPath, () => {
      server.off('error', onError);
      server.close((error?: Error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(true);
      });
    });
  });
}

async function waitUntil(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() >= deadline) {
      throw new Error(`Condition was not met within ${timeoutMs}ms.`);
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
}

describe('main-instance leader mutation tenure', () => {
  it('executes accepted mutations serially in acceptance order', async () => {
    const storagePath = await createStoragePath();
    const coordinator = new MainInstanceCoordinator();
    await initializeCoordinator(coordinator, storagePath);

    const firstGate = createDeferred();
    const order: string[] = [];
    let active = 0;
    let maxActive = 0;
    const run = async (label: string, gate?: Deferred): Promise<string> => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      order.push(`${label}:start`);
      await gate?.promise;
      await Promise.resolve();
      order.push(`${label}:end`);
      active -= 1;
      return label;
    };

    const first = coordinator.runLeaderMutation(() => run('first', firstGate));
    const second = coordinator.runLeaderMutation(() => run('second'));
    const third = coordinator.runLeaderMutation(() => run('third'));

    await waitUntil(() => order.length > 0);
    expect(order).toEqual(['first:start']);
    expect(maxActive).toBe(1);

    firstGate.resolve();
    await expect(Promise.all([first, second, third])).resolves.toEqual([
      'first',
      'second',
      'third',
    ]);
    expect(order).toEqual([
      'first:start',
      'first:end',
      'second:start',
      'second:end',
      'third:start',
      'third:end',
    ]);
    expect(maxActive).toBe(1);
  });

  it('keeps the leader socket until every registered mutation settles', async () => {
    const storagePath = await createStoragePath();
    const coordinator = new MainInstanceCoordinator();
    await initializeCoordinator(coordinator, storagePath);

    expect(coordinator.isLeader()).toBe(true);
    const socketPath = coordinator.getSnapshot()?.socketPath;
    expect(socketPath).toBeTypeOf('string');
    if (!socketPath) {
      throw new Error('Leader socket path is unavailable.');
    }

    const firstGate = createDeferred();
    const secondGate = createDeferred();
    const firstMutation = coordinator.runLeaderMutation(async () => {
      await firstGate.promise;
      return 'first-result';
    });
    const secondMutation = coordinator
      .runLeaderMutation(async () => {
        await secondGate.promise;
        throw new Error('second-failed');
      })
      .then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error }),
      );

    coordinator.dispose();

    expect(coordinator.isLeader()).toBe(false);
    await expect(
      coordinator.runLeaderMutation(async () => 'too-late'),
    ).rejects.toMatchObject({ code: 'LEADER_GONE' });
    expect(await canAcquireSocket(socketPath)).toBe(false);

    firstGate.resolve();
    await expect(firstMutation).resolves.toBe('first-result');
    expect(await canAcquireSocket(socketPath)).toBe(false);

    secondGate.resolve();
    const secondResult = await secondMutation;
    expect(secondResult.ok).toBe(false);
    if (!secondResult.ok) {
      expect(secondResult.error).toEqual(new Error('second-failed'));
    }

    await waitUntil(async () => await canAcquireSocket(socketPath));
  });

  it('awaits mutation drain before an asynchronous re-election completes', async () => {
    const storagePath = await createStoragePath();
    const coordinator = new MainInstanceCoordinator();
    await initializeCoordinator(coordinator, storagePath);

    const mutationGate = createDeferred();
    const mutation = coordinator.runLeaderMutation(async () => {
      await mutationGate.promise;
      return 'persisted';
    });

    let reElectionSettled = false;
    const reElection = initializeCoordinator(coordinator, storagePath).finally(() => {
      reElectionSettled = true;
    });

    expect(coordinator.isLeader()).toBe(false);
    await Promise.resolve();
    expect(reElectionSettled).toBe(false);

    mutationGate.resolve();
    await expect(mutation).resolves.toBe('persisted');
    await reElection;

    expect(coordinator.isLeader()).toBe(true);
    await expect(
      coordinator.runLeaderMutation(async () => 'next-tenure'),
    ).resolves.toBe('next-tenure');
  });

  it('opens a fresh mutation tenure after normal follower re-election', async () => {
    const storagePath = await createStoragePath();
    const originalLeader = new MainInstanceCoordinator();
    const follower = new MainInstanceCoordinator();

    await initializeCoordinator(originalLeader, storagePath);
    originalLeader.setReady(true);
    await initializeCoordinator(follower, storagePath);

    expect(originalLeader.isLeader()).toBe(true);
    expect(follower.isLeader()).toBe(false);
    await expect(
      follower.runLeaderMutation(async () => 'not-leader'),
    ).rejects.toMatchObject({ code: 'LEADER_GONE' });

    originalLeader.dispose();
    expect(originalLeader.isLeader()).toBe(false);

    await waitUntil(() => follower.isLeader());
    await expect(
      follower.runLeaderMutation(async () => 'new-leader'),
    ).resolves.toBe('new-leader');
  });
});

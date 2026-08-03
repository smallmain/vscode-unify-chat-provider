import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const network = vi.hoisted(() => ({
  welcomeCompatibilityVersion: 7,
  welcomeExtensionVersion: 'leader-1.0.0',
  writes: [] as string[],
}));

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

vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(async () => 'test-token'),
}));

vi.mock('node:net', () => {
  type Listener = (...args: unknown[]) => void;

  class FakeSocket {
    destroyed = false;
    private readonly listeners = new Map<string, Set<Listener>>();

    constructor() {
      queueMicrotask(() => this.emit('connect'));
    }

    on(event: string, listener: Listener): this {
      const listeners = this.listeners.get(event) ?? new Set<Listener>();
      listeners.add(listener);
      this.listeners.set(event, listeners);
      return this;
    }

    once(event: string, listener: Listener): this {
      const onceListener: Listener = (...args) => {
        this.off(event, onceListener);
        listener(...args);
      };
      return this.on(event, onceListener);
    }

    off(event: string, listener: Listener): this {
      this.listeners.get(event)?.delete(listener);
      return this;
    }

    removeAllListeners(): this {
      this.listeners.clear();
      return this;
    }

    setTimeout(_timeout: number, _listener: Listener): this {
      return this;
    }

    write(chunk: string): boolean {
      network.writes.push(chunk);
      const welcome = {
        type: 'welcome',
        leaderId: 'leader',
        protocolVersion: 1,
        mainInstanceCompatibilityVersion:
          network.welcomeCompatibilityVersion,
        ready: true,
        extensionVersion: network.welcomeExtensionVersion,
      };
      queueMicrotask(() =>
        this.emit('data', Buffer.from(`${JSON.stringify(welcome)}\n`)),
      );
      return true;
    }

    destroy(): this {
      if (!this.destroyed) {
        this.destroyed = true;
        queueMicrotask(() => this.emit('close'));
      }
      return this;
    }

    private emit(event: string, ...args: unknown[]): void {
      for (const listener of [...(this.listeners.get(event) ?? [])]) {
        listener(...args);
      }
    }
  }

  return {
    createConnection: vi.fn(() => new FakeSocket()),
    createServer: vi.fn(),
  };
});

import { MainInstanceCoordinator } from '../../src/main-instance/coordinator';
import {
  MAIN_INSTANCE_COMPATIBILITY_VERSION,
  PROTOCOL_VERSION,
  parseMessageLine,
  type HelloMessage,
} from '../../src/main-instance/protocol';

const coordinators: MainInstanceCoordinator[] = [];

beforeEach(() => {
  network.welcomeCompatibilityVersion = 7;
  network.welcomeExtensionVersion = 'leader-1.0.0';
  network.writes = [];
});

afterEach(() => {
  for (const coordinator of coordinators.splice(0)) {
    coordinator.dispose();
  }
});

function createCoordinator(): MainInstanceCoordinator {
  const coordinator = new MainInstanceCoordinator();
  coordinators.push(coordinator);
  return coordinator;
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

function configureFollower(
  coordinator: MainInstanceCoordinator,
  extensionVersion = 'follower-9.9.9',
): void {
  Reflect.set(coordinator, 'context', {
    extension: {
      id: 'test.extension',
      packageJSON: { version: extensionVersion },
    },
    globalStorageUri: { fsPath: '/tmp/main-instance-compatibility-test' },
  });
  Reflect.set(coordinator, 'extensionVersion', extensionVersion);
  Reflect.set(coordinator, 'socketPath', '/tmp/main-instance-test.sock');
  Reflect.set(coordinator, 'authTokenPath', '/tmp/main-instance-test.token');
}

function createLeaderSocket(): {
  readonly writes: string[];
  readonly socket: object;
  isDestroyed(): boolean;
} {
  const writes: string[] = [];
  let destroyed = false;
  return {
    writes,
    socket: {
      get destroyed() {
        return destroyed;
      },
      write(line: string) {
        writes.push(line);
        return true;
      },
      destroy() {
        destroyed = true;
      },
    },
    isDestroyed: () => destroyed,
  };
}

function hello(
  compatibilityVersion: number,
  extensionVersion = 'follower-9.9.9',
): HelloMessage {
  return {
    type: 'hello',
    clientId: `client-v${compatibilityVersion}`,
    protocolVersion: PROTOCOL_VERSION,
    mainInstanceCompatibilityVersion: compatibilityVersion,
    authToken: 'test-token',
    extensionVersion,
  };
}

describe('main-instance compatibility handshake', () => {
  it('accepts a differently-versioned v7 follower at a v7 leader', () => {
    const coordinator = createCoordinator();
    Reflect.set(coordinator, 'authToken', 'test-token');
    const peer = createLeaderSocket();

    invokePrivate(coordinator, 'handleLeaderSideMessage', [
      peer.socket,
      hello(MAIN_INSTANCE_COMPATIBILITY_VERSION, 'follower-9.9.9'),
    ]);

    expect(peer.isDestroyed()).toBe(false);
    const response = parseMessageLine(peer.writes[0] ?? '');
    expect(response).toMatchObject({
      type: 'welcome',
      protocolVersion: 1,
      mainInstanceCompatibilityVersion: 7,
    });
  });

  it('rejects a v6 follower at a v7 leader', () => {
    const coordinator = createCoordinator();
    Reflect.set(coordinator, 'authToken', 'test-token');
    const peer = createLeaderSocket();

    invokePrivate(coordinator, 'handleLeaderSideMessage', [
      peer.socket,
      hello(6),
    ]);

    expect(peer.isDestroyed()).toBe(true);
    const response = parseMessageLine(peer.writes[0] ?? '');
    expect(response).toMatchObject({
      type: 'response',
      id: 'handshake',
      ok: false,
      error: { code: 'INCOMPATIBLE_VERSION' },
    });
  });

  it('connects differently-versioned v7 follower and leader releases', async () => {
    const coordinator = createCoordinator();
    configureFollower(coordinator);

    const result: unknown = await invokePrivate(
      coordinator,
      'tryConnectFollower',
      [{ attempts: 1, retryDelayMs: 0 }],
    );

    expect(result).toBe('connected');
    expect(coordinator.getCompatibilityError()).toBeUndefined();
    expect(coordinator.getSnapshot()).toMatchObject({
      role: 'follower',
      leaderId: 'leader',
      ready: true,
    });
    expect(parseMessageLine(network.writes[0] ?? '')).toMatchObject({
      type: 'hello',
      extensionVersion: 'follower-9.9.9',
      mainInstanceCompatibilityVersion: 7,
    });
  });

  it('rejects a v6 leader at a v7 follower', async () => {
    network.welcomeCompatibilityVersion = 6;
    const coordinator = createCoordinator();
    configureFollower(coordinator);

    const result: unknown = await invokePrivate(
      coordinator,
      'tryConnectFollower',
      [{ attempts: 1, retryDelayMs: 0 }],
    );

    expect(result).toBe('incompatible');
    expect(coordinator.getCompatibilityError()).toMatchObject({
      code: 'INCOMPATIBLE_VERSION',
    });
  });
});

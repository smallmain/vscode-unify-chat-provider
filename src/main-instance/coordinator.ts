import * as vscode from 'vscode';
import * as net from 'node:net';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { authLog } from '../logger';
import {
  MainInstanceError,
  asRpcError,
  buildVersionMismatchMessage,
  type RpcError,
} from './errors';
import {
  PROTOCOL_VERSION,
  parseMessageLine,
  serializeMessage,
  type EventMessage,
  type HelloMessage,
  type IpcMessage,
  type RequestMessage,
  type ResponseMessage,
  type WelcomeMessage,
} from './protocol';
import { getMainInstanceSocket } from './socket';

type Role = 'leader' | 'follower';

export type MainInstanceRoleSnapshot = {
  role: Role;
  clientId: string;
  leaderId: string;
  socketPath: string;
  ready: boolean;
};

export type RpcHandlerContext = {
  /** Abort when client cancels the request. */
  signal: AbortSignal;
  /** ID of the connected client (follower). */
  clientId: string;
};

export type RpcHandler = (
  params: unknown,
  context: RpcHandlerContext,
) => Promise<unknown>;

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: RpcError) => void;
  abortListener?: () => void;
};

type LeaderInFlight = {
  controller: AbortController;
  clientId: string;
};

type FollowerHandshakeResult = {
  kind: 'connected';
  welcome: WelcomeMessage;
  reader: SocketLineReader;
  pendingMessages: IpcMessage[];
};

type FollowerHandshakeIncompatibleResult = {
  kind: 'incompatible';
  leaderId?: string;
  message: string;
};

type FollowerConnectResult = 'connected' | 'incompatible' | 'failed';

const AUTH_TOKEN_FILENAME = 'main-instance-auth-token.txt';
const INTERNAL_READY_EVENT = '__main.ready';

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readExtensionVersion(packageJson: unknown): string | undefined {
  if (!isRecord(packageJson)) {
    return undefined;
  }
  const version = packageJson['version'];
  return typeof version === 'string' && version.trim() !== ''
    ? version
    : undefined;
}

class SocketLineReader implements vscode.Disposable {
  private buffer = '';
  private onMessage: (message: IpcMessage) => void;

  constructor(
    private readonly socket: net.Socket,
    onMessage: (message: IpcMessage) => void,
  ) {
    this.onMessage = onMessage;
    this.socket.on('data', this.onData);
  }

  setHandler(onMessage: (message: IpcMessage) => void): void {
    this.onMessage = onMessage;
  }

  dispose(): void {
    this.socket.off('data', this.onData);
  }

  private readonly onData = (chunk: Buffer): void => {
    this.buffer += chunk.toString('utf8');
    while (true) {
      const newline = this.buffer.indexOf('\n');
      if (newline === -1) {
        return;
      }
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      const message = parseMessageLine(line);
      if (message) {
        this.onMessage(message);
      }
    }
  };
}

async function safeUnlink(filePath: string): Promise<void> {
  try {
    await fs.unlink(filePath);
  } catch (error) {
    if (isRecord(error) && error['code'] === 'ENOENT') {
      return;
    }
  }
}

async function writeAuthTokenFile(
  globalStoragePath: string,
  token: string,
): Promise<void> {
  await fs.mkdir(globalStoragePath, { recursive: true });
  const filePath = path.join(globalStoragePath, AUTH_TOKEN_FILENAME);
  await fs.writeFile(filePath, token, { mode: 0o600 });
}

async function readAuthTokenFile(
  globalStoragePath: string,
): Promise<string | undefined> {
  const filePath = path.join(globalStoragePath, AUTH_TOKEN_FILENAME);
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    const token = raw.trim();
    return token ? token : undefined;
  } catch (error) {
    if (isRecord(error) && error['code'] === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
}

function asNetErrorCode(error: unknown): string | undefined {
  if (!isRecord(error)) return undefined;
  const code = error['code'];
  return typeof code === 'string' ? code : undefined;
}

function safeWrite(socket: net.Socket, message: IpcMessage): void {
  try {
    if (!socket.destroyed) {
      socket.write(serializeMessage(message));
    }
  } catch {
    // Best-effort: connection may have been closed.
  }
}

async function canConnectToUnixSocket(filePath: string): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const socket = net.createConnection(filePath);
    let settled = false;

    const finish = (connected: boolean): void => {
      if (settled) {
        return;
      }
      settled = true;
      socket.removeAllListeners();
      socket.destroy();
      resolve(connected);
    };

    socket.once('connect', () => {
      finish(true);
    });
    socket.once('error', () => {
      finish(false);
    });
    socket.setTimeout(200, () => {
      finish(false);
    });
  });
}

export class MainInstanceCoordinator implements vscode.Disposable {
  private context?: vscode.ExtensionContext;
  private role?: Role;
  private leaderId?: string;
  private socketPath?: string;
  private authToken?: string;
  private extensionVersion?: string;
  private ready = false;
  private leaderReady = false;
  private compatibilityError?: MainInstanceError;
  private readonly clientId = randomUUID();

  private server?: net.Server;
  private readonly followerSockets = new Map<string, net.Socket>();

  private leaderSocket?: net.Socket;
  private leaderReadDisposable?: SocketLineReader;

  private readonly pending = new Map<string, PendingRequest>();
  private readonly leaderInFlight = new Map<string, LeaderInFlight>();

  private reconnectTimer?: NodeJS.Timeout;

  private readonly onDidChangeRoleEmitter =
    new vscode.EventEmitter<MainInstanceRoleSnapshot>();
  readonly onDidChangeRole = this.onDidChangeRoleEmitter.event;

  private readonly onDidReceiveEventEmitter = new vscode.EventEmitter<{
    event: string;
    payload: unknown;
  }>();
  readonly onDidReceiveEvent = this.onDidReceiveEventEmitter.event;

  private readonly handlers = new Map<string, RpcHandler>();

  registerHandler(method: string, handler: RpcHandler): void {
    this.handlers.set(method, handler);
  }

  getSnapshot(): MainInstanceRoleSnapshot | undefined {
    if (!this.role || !this.leaderId || !this.socketPath) {
      return undefined;
    }
    return {
      role: this.role,
      clientId: this.clientId,
      leaderId: this.leaderId,
      socketPath: this.socketPath,
      ready: this.getReadyState(),
    };
  }

  isLeader(): boolean {
    return this.role === 'leader';
  }

  isReady(): boolean {
    return this.getReadyState();
  }

  getCompatibilityError(): MainInstanceError | undefined {
    return this.compatibilityError;
  }

  private getReadyState(): boolean {
    return this.role === 'leader' ? this.ready : this.leaderReady;
  }

  private hasLeaderConnection(): boolean {
    return this.role === 'leader' || !!this.leaderSocket;
  }

  private hasReadyLeaderConnection(): boolean {
    return this.hasLeaderConnection() && this.getReadyState();
  }

  async initialize(context: vscode.ExtensionContext): Promise<void> {
    this.context = context;
    this.extensionVersion = readExtensionVersion(context.extension.packageJSON);

    const descriptor = getMainInstanceSocket(
      context.extension.id,
      vscode.env.machineId,
      context.globalStorageUri.fsPath,
    );
    this.socketPath = descriptor.path;

    await this.elect(descriptor);
  }

  private updateRole(
    role: Role,
    leaderId: string,
    options?: { forceEmit?: boolean },
  ): void {
    const socketPath = this.socketPath;
    if (!socketPath) {
      throw new Error('Socket path not initialized');
    }

    const changed =
      options?.forceEmit === true ||
      this.role !== role ||
      this.leaderId !== leaderId ||
      this.getReadyState() !==
        (role === 'leader' ? this.ready : this.leaderReady);
    this.role = role;
    this.leaderId = leaderId;

    if (changed) {
      this.onDidChangeRoleEmitter.fire({
        role,
        clientId: this.clientId,
        leaderId,
        socketPath,
        ready: this.getReadyState(),
      });
    }
  }

  setReady(ready: boolean): void {
    if (this.role !== 'leader' || this.ready === ready) {
      return;
    }

    this.ready = ready;
    if (this.leaderId) {
      this.updateRole('leader', this.leaderId, {
        forceEmit: true,
      });
    }
    this.broadcast(INTERNAL_READY_EVENT, { ready });
  }

  private clearCompatibilityError(): void {
    this.compatibilityError = undefined;
  }

  private setCompatibilityError(error: MainInstanceError): void {
    this.compatibilityError = error;
  }

  private getVersionMismatchError(
    peerVersion: string | undefined,
  ): MainInstanceError {
    return new MainInstanceError(
      'INCOMPATIBLE_VERSION',
      buildVersionMismatchMessage(this.extensionVersion, peerVersion),
    );
  }

  private markIncompatibleLeader(
    leaderId: string | undefined,
    error: MainInstanceError,
  ): void {
    this.disposeLeaderConnection();
    this.ready = false;
    this.leaderReady = false;
    this.setCompatibilityError(error);
    if (leaderId) {
      this.updateRole('follower', leaderId, { forceEmit: true });
    }
    authLog.warn('main-instance', error.message);
    this.scheduleReconnect(1_000);
  }

  private async elect(descriptor: ReturnType<typeof getMainInstanceSocket>): Promise<void> {
    this.stopReconnectLoop();

    // Try to become leader first.
    const becameLeader = await this.tryStartLeader(descriptor);
    if (becameLeader) {
      return;
    }

    // Otherwise connect as follower.
    const connected = await this.tryConnectFollower();
    if (connected !== 'failed') {
      return;
    }

    // Stale unix socket cleanup, then retry election.
    if (descriptor.kind === 'unix') {
      const socketIsLive = await canConnectToUnixSocket(descriptor.filePath);
      if (!socketIsLive) {
        await safeUnlink(descriptor.filePath);
        if (await this.tryStartLeader(descriptor)) {
          return;
        }
      } else if (
        (await this.tryConnectFollower({ attempts: 40, retryDelayMs: 50 })) !==
        'failed'
      ) {
        return;
      }
    }

    // Final attempt to connect.
    if ((await this.tryConnectFollower()) !== 'failed') {
      return;
    }

    throw new MainInstanceError('NO_LEADER', 'Failed to elect a main instance');
  }

  private async tryStartLeader(
    descriptor: ReturnType<typeof getMainInstanceSocket>,
  ): Promise<boolean> {
    this.disposeLeaderConnection();
    this.disposeLeaderServer();
    this.clearCompatibilityError();

    const server = net.createServer((socket) => {
      this.handleIncomingFollowerSocket(socket);
    });

    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(descriptor.path, () => {
          server.off('error', reject);
          resolve();
        });
      });
    } catch (error) {
      server.close();

      const code = asNetErrorCode(error);
      if (code === 'EADDRINUSE') {
        return false;
      }
      throw error;
    }

    this.server = server;
    this.authToken = randomBytes(32).toString('base64url');
    this.ready = false;
    this.leaderReady = false;

    if (!this.context) {
      throw new Error('Extension context not initialized');
    }
    await writeAuthTokenFile(this.context.globalStorageUri.fsPath, this.authToken);

    this.updateRole('leader', this.clientId);
    authLog.verbose('main-instance', `Elected leader (clientId: ${this.clientId})`);
    return true;
  }

  private scheduleReconnect(delayMs = 300): void {
    if (this.reconnectTimer) {
      return;
    }

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      const context = this.context;
      if (!context) {
        return;
      }
      const descriptor = getMainInstanceSocket(
        context.extension.id,
        vscode.env.machineId,
        context.globalStorageUri.fsPath,
      );
      void this.elect(descriptor).catch((error) => {
        authLog.error('main-instance', 'Re-election failed', error);
        this.scheduleReconnect();
      });
    }, delayMs);
  }

  private abortInFlightForClient(clientId: string): void {
    for (const [id, inflight] of this.leaderInFlight) {
      if (inflight.clientId !== clientId) {
        continue;
      }
      inflight.controller.abort();
      this.leaderInFlight.delete(id);
    }
  }

  private stopReconnectLoop(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
  }

  private async tryConnectFollower(options?: {
    attempts?: number;
    retryDelayMs?: number;
  }): Promise<FollowerConnectResult> {
    this.disposeLeaderConnection();
    this.disposeLeaderServer();

    const context = this.context;
    const socketPath = this.socketPath;
    if (!context || !socketPath) {
      return 'failed';
    }

    const attempts = options?.attempts ?? 20;
    const retryDelayMs = options?.retryDelayMs ?? 50;

    for (let attempt = 0; attempt < attempts; attempt++) {
      const token = await readAuthTokenFile(context.globalStorageUri.fsPath).catch(
        (error) => {
          authLog.error('main-instance', 'Failed to read auth token file', error);
          return undefined;
        },
      );

      if (!token) {
        await delay(retryDelayMs);
        continue;
      }

      const socket = net.createConnection(socketPath);

      const connected = await new Promise<boolean>((resolve) => {
        const onError = (): void => resolve(false);
        socket.once('error', onError);
        socket.once('connect', () => {
          socket.off('error', onError);
          resolve(true);
        });
      });

      if (!connected) {
        socket.destroy();
        await delay(retryDelayMs);
        continue;
      }

      const handshake = await this.performFollowerHandshake(socket, token);
      if (handshake?.kind === 'connected') {
        const localVersion = this.extensionVersion;
        const peerVersion = handshake.welcome.extensionVersion;
        if (
          handshake.welcome.protocolVersion !== PROTOCOL_VERSION ||
          !localVersion ||
          !peerVersion ||
          peerVersion !== localVersion
        ) {
          socket.destroy();
          this.markIncompatibleLeader(
            handshake.welcome.leaderId,
            this.getVersionMismatchError(peerVersion),
          );
          return 'incompatible';
        }

        this.clearCompatibilityError();
        this.leaderSocket = socket;
        this.ready = false;
        this.leaderReady = handshake.welcome.ready;
        this.leaderReadDisposable = handshake.reader;
        this.leaderReadDisposable.setHandler((message) => {
          this.handleFollowerSideMessage(message);
        });
        socket.on('close', () => {
          this.onLeaderDisconnected();
        });
        socket.on('error', () => {
          // close handler will handle role changes
        });

        this.updateRole('follower', handshake.welcome.leaderId, {
          forceEmit: true,
        });
        for (const message of handshake.pendingMessages) {
          this.handleFollowerSideMessage(message);
        }
        authLog.verbose(
          'main-instance',
          `Connected to leader (leaderId: ${handshake.welcome.leaderId})`,
        );
        return 'connected';
      }

      if (handshake?.kind === 'incompatible') {
        socket.destroy();
        this.markIncompatibleLeader(
          handshake.leaderId,
          new MainInstanceError('INCOMPATIBLE_VERSION', handshake.message),
        );
        return 'incompatible';
      }

      socket.destroy();
      await delay(retryDelayMs);
    }

    return 'failed';
  }

  private async performFollowerHandshake(
    socket: net.Socket,
    token: string,
  ): Promise<
    FollowerHandshakeResult | FollowerHandshakeIncompatibleResult | undefined
  > {
    const hello: HelloMessage = {
      type: 'hello',
      clientId: this.clientId,
      protocolVersion: PROTOCOL_VERSION,
      authToken: token,
      extensionVersion: this.extensionVersion,
    };

    let resolved = false;
    let welcome: WelcomeMessage | undefined;
    const pendingMessages: IpcMessage[] = [];

    return await new Promise<
      FollowerHandshakeResult | FollowerHandshakeIncompatibleResult | undefined
    >((resolve) => {
      const reader = new SocketLineReader(socket, (message) => {
        if (!welcome) {
          if (message.type === 'welcome') {
            welcome = message;
            resolved = true;
            socket.off('close', onClose);
            socket.off('error', onError);
            resolve({ kind: 'connected', welcome, reader, pendingMessages });
            return;
          }

          if (
            message.type === 'response' &&
            !message.ok &&
            message.id === 'handshake' &&
            message.error.code === 'INCOMPATIBLE_VERSION'
          ) {
            resolved = true;
            reader.dispose();
            socket.off('close', onClose);
            socket.off('error', onError);
            resolve({
              kind: 'incompatible',
              message: message.error.message,
            });
            return;
          }
        }

        pendingMessages.push(message);
      });

      const finish = (): void => {
        if (resolved) {
          return;
        }
        resolved = true;
        reader.dispose();
        socket.off('close', onClose);
        socket.off('error', onError);
        resolve(undefined);
      };

      const onClose = (): void => {
        finish();
      };
      const onError = (): void => {
        finish();
      };

      socket.once('close', onClose);
      socket.once('error', onError);
      socket.write(serializeMessage(hello));
    });
  }

  private handleIncomingFollowerSocket(socket: net.Socket): void {
    const disposable = new SocketLineReader(socket, (message) => {
      this.handleLeaderSideMessage(socket, message);
    });

    let cleanedUp = false;
    const cleanup = (): void => {
      if (cleanedUp) {
        return;
      }
      cleanedUp = true;
      disposable.dispose();
      let clientIdToRemove: string | undefined;
      for (const [clientId, existing] of this.followerSockets) {
        if (existing === socket) {
          clientIdToRemove = clientId;
          this.followerSockets.delete(clientId);
          break;
        }
      }
      if (clientIdToRemove) {
        this.abortInFlightForClient(clientIdToRemove);
      }
    };

    socket.on('close', cleanup);
    socket.on('error', (error) => {
      authLog.verbose('main-instance', 'Follower socket error', error);
      cleanup();
      socket.destroy();
    });
  }

  private handleLeaderSideMessage(socket: net.Socket, message: IpcMessage): void {
    if (message.type === 'hello') {
      if (!this.authToken || message.authToken !== this.authToken) {
        const resp: ResponseMessage = {
          type: 'response',
          id: 'handshake',
          ok: false,
          error: {
            code: 'UNAUTHORIZED',
            message: 'Unauthorized',
          },
        };
        safeWrite(socket, resp);
        socket.destroy();
        return;
      }

      if (
        message.protocolVersion !== PROTOCOL_VERSION ||
        !this.extensionVersion ||
        !message.extensionVersion ||
        message.extensionVersion !== this.extensionVersion
      ) {
        const resp: ResponseMessage = {
          type: 'response',
          id: 'handshake',
          ok: false,
          error: {
            code: 'INCOMPATIBLE_VERSION',
            message: buildVersionMismatchMessage(
              this.extensionVersion,
              message.extensionVersion,
            ),
          },
        };
        safeWrite(socket, resp);
        socket.destroy();
        return;
      }

      this.followerSockets.set(message.clientId, socket);
      const welcome: WelcomeMessage = {
        type: 'welcome',
        leaderId: this.clientId,
        protocolVersion: PROTOCOL_VERSION,
        ready: this.ready,
        extensionVersion: this.extensionVersion,
      };
      safeWrite(socket, welcome);
      return;
    }

    const clientId = this.findFollowerClientId(socket);
    if (!clientId) {
      socket.destroy();
      return;
    }

    if (message.type === 'request') {
      void this.handleLeaderRequest(message, socket, clientId);
      return;
    }

    if (message.type === 'cancel') {
      const inflight = this.leaderInFlight.get(message.id);
      if (inflight) {
        inflight.controller.abort();
        this.leaderInFlight.delete(message.id);
      }
      return;
    }

    if (message.type === 'event') {
      // Follower -> leader events are not part of the public protocol; ignore.
      return;
    }
  }

  private async handleLeaderRequest(
    message: RequestMessage,
    socket: net.Socket,
    clientId: string,
  ): Promise<void> {
    const handler = this.handlers.get(message.method);
    if (!handler) {
      const resp: ResponseMessage = {
        type: 'response',
        id: message.id,
        ok: false,
        error: { code: 'NOT_IMPLEMENTED', message: `Unknown method: ${message.method}` },
      };
      safeWrite(socket, resp);
      return;
    }

    const controller = new AbortController();
    this.leaderInFlight.set(message.id, { controller, clientId });

    try {
      const result = await handler(message.params, {
        signal: controller.signal,
        clientId,
      });

      const resp: ResponseMessage = {
        type: 'response',
        id: message.id,
        ok: true,
        result,
      };
      safeWrite(socket, resp);
    } catch (error) {
      const resp: ResponseMessage = {
        type: 'response',
        id: message.id,
        ok: false,
        error: asRpcError(error),
      };
      safeWrite(socket, resp);
    } finally {
      this.leaderInFlight.delete(message.id);
    }
  }

  private findFollowerClientId(socket: net.Socket): string | undefined {
    for (const [clientId, existing] of this.followerSockets) {
      if (existing === socket) {
        return clientId;
      }
    }
    return undefined;
  }

  private handleFollowerSideMessage(message: IpcMessage): void {
    if (message.type === 'response') {
      const pending = this.pending.get(message.id);
      if (!pending) {
        return;
      }
      this.pending.delete(message.id);
      pending.abortListener?.();
      if (message.ok) {
        pending.resolve(message.result);
      } else {
        pending.reject(message.error);
      }
      return;
    }

    if (message.type === 'event') {
      if (message.event === INTERNAL_READY_EVENT) {
        const payload = message.payload;
        if (
          payload &&
          typeof payload === 'object' &&
          !Array.isArray(payload)
        ) {
          const ready = (payload as Record<string, unknown>)['ready'];
          if (typeof ready === 'boolean') {
            this.leaderReady = ready;
            if (this.leaderId) {
              this.updateRole('follower', this.leaderId, {
                forceEmit: true,
              });
            }
          }
        }
        return;
      }
      this.onDidReceiveEventEmitter.fire({
        event: message.event,
        payload: message.payload,
      });
      return;
    }

    if (message.type === 'welcome') {
      // welcome is handled during handshake
      return;
    }
  }

  private onLeaderDisconnected(): void {
    authLog.verbose('main-instance', 'Leader disconnected');
    const error: RpcError = { code: 'LEADER_GONE', message: 'Leader instance is gone' };
    for (const [id, pending] of this.pending) {
      pending.abortListener?.();
      pending.reject(error);
      this.pending.delete(id);
    }

    this.leaderReady = false;
    this.disposeLeaderConnection();
    this.scheduleReconnect();
  }

  async runInLeader<T = unknown>(
    method: string,
    params: unknown,
    options?: { signal?: AbortSignal },
  ): Promise<T> {
    if (this.compatibilityError) {
      throw this.compatibilityError;
    }

    if (this.role === 'leader') {
      const handler = this.handlers.get(method);
      if (!handler) {
        throw new MainInstanceError('NOT_IMPLEMENTED', `Unknown method: ${method}`);
      }
      const controller = new AbortController();
      const signal = options?.signal ?? controller.signal;
      const result = await handler(params, { signal, clientId: this.clientId });
      return result as T;
    }

    if (this.role !== 'follower' || !this.leaderSocket || !this.leaderReady) {
      throw new MainInstanceError('NO_LEADER', 'No leader available');
    }

    const id = randomUUID();
    const socket = this.leaderSocket;

    const request: RequestMessage = {
      type: 'request',
      id,
      method,
      params,
    };

    const promise = new Promise<T>((resolve, reject) => {
      const pending: PendingRequest = {
        resolve: (value) => resolve(value as T),
        reject: (error) => reject(new MainInstanceError(error.code, error.message)),
      };

      if (options?.signal) {
        const listener = (): void => {
          socket.write(serializeMessage({ type: 'cancel', id }));
          this.pending.delete(id);
          reject(new MainInstanceError('CANCELLED', 'Cancelled'));
        };
        options.signal.addEventListener('abort', listener, { once: true });
        pending.abortListener = () => {
          options.signal?.removeEventListener('abort', listener);
        };
      }

      this.pending.set(id, pending);
      socket.write(serializeMessage(request));
    });

    return await promise;
  }

  private async waitForLeader(options?: {
    signal?: AbortSignal;
    timeoutMs?: number;
  }): Promise<void> {
    if (this.compatibilityError) {
      throw this.compatibilityError;
    }

    if (this.hasReadyLeaderConnection()) {
      return;
    }

    const timeoutMs = options?.timeoutMs ?? 5_000;

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      let roleDisposable: vscode.Disposable | undefined;

      const finish = (error?: Error): void => {
        if (settled) {
          return;
        }
        settled = true;
        roleDisposable?.dispose();
        if (timeout) {
          clearTimeout(timeout);
          timeout = undefined;
        }
        if (options?.signal) {
          options.signal.removeEventListener('abort', onAbort);
        }
        if (error) {
          reject(error);
          return;
        }
        resolve();
      };

      const onAbort = (): void => {
        finish(new MainInstanceError('CANCELLED', 'Cancelled'));
      };

      roleDisposable = this.onDidChangeRole(() => {
        if (this.hasReadyLeaderConnection()) {
          finish();
        }
      });

      if (timeoutMs >= 0) {
        timeout = setTimeout(() => {
          finish(new MainInstanceError('NO_LEADER', 'No leader available'));
        }, timeoutMs);
      }

      if (options?.signal) {
        if (options.signal.aborted) {
          onAbort();
          return;
        }
        options.signal.addEventListener('abort', onAbort, { once: true });
      }

      if (this.hasReadyLeaderConnection()) {
        finish();
      }
    });
  }

  async runInLeaderWhenAvailable<T = unknown>(
    method: string,
    params: unknown,
    options?: { signal?: AbortSignal; timeoutMs?: number; maxAttempts?: number },
  ): Promise<T> {
    const maxAttempts = options?.maxAttempts ?? 3;
    let attempts = 0;
    let lastError: MainInstanceError | undefined;

    while (attempts < maxAttempts) {
      attempts += 1;

      if (!this.hasReadyLeaderConnection()) {
        await this.waitForLeader({
          signal: options?.signal,
          timeoutMs: options?.timeoutMs,
        });
      }

      try {
        return await this.runInLeader<T>(method, params, {
          signal: options?.signal,
        });
      } catch (error) {
        if (
          !(
            error instanceof MainInstanceError &&
            (error.code === 'NO_LEADER' || error.code === 'LEADER_GONE')
          )
        ) {
          throw error;
        }
        lastError = error;
        if (attempts >= maxAttempts) {
          break;
        }
        await this.waitForLeader({
          signal: options?.signal,
          timeoutMs: options?.timeoutMs,
        });
      }
    }

    throw (
      lastError ??
      new MainInstanceError('NO_LEADER', 'No leader available')
    );
  }

  broadcast(event: string, payload: unknown): void {
    if (this.role !== 'leader') {
      return;
    }
    const message: EventMessage = { type: 'event', event, payload };
    for (const socket of this.followerSockets.values()) {
      safeWrite(socket, message);
    }
  }

  dispose(): void {
    this.stopReconnectLoop();
    this.disposeLeaderConnection();
    this.disposeLeaderServer();
    this.onDidChangeRoleEmitter.dispose();
    this.onDidReceiveEventEmitter.dispose();
  }

  private disposeLeaderConnection(): void {
    this.leaderReady = false;
    if (this.leaderReadDisposable) {
      this.leaderReadDisposable.dispose();
      this.leaderReadDisposable = undefined;
    }
    if (this.leaderSocket) {
      this.leaderSocket.removeAllListeners();
      this.leaderSocket.destroy();
      this.leaderSocket = undefined;
    }
  }

  private disposeLeaderServer(): void {
    this.ready = false;
    if (this.server) {
      this.server.close();
      this.server = undefined;
    }
    for (const socket of this.followerSockets.values()) {
      socket.destroy();
    }
    this.followerSockets.clear();
  }
}

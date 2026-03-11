const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_CONNECTION_TIMEOUT_MS = 60 * 1000;
const DEFAULT_SOFT_CONNECTION_LIMIT = 32;

export type WebSocketSessionErrorKind =
  | 'connection_timeout'
  | 'unexpected_response'
  | 'socket_error'
  | 'socket_closed'
  | 'request_send_failed'
  | 'request_aborted'
  | 'protocol_error'
  | 'manager_disposed';

export type WebSocketSessionReadyState =
  | 'connecting'
  | 'open'
  | 'closing'
  | 'closed';

export interface WebSocketSessionCloseEvent {
  code?: number;
  reason?: string;
}

export interface WebSocketSessionUnexpectedResponseEvent {
  statusCode?: number;
}

export interface WebSocketSessionTransport<
  SendPayload = unknown,
  ReceiveEvent = unknown,
> {
  readonly readyState: WebSocketSessionReadyState;
  send(payload: SendPayload): void;
  close(props?: { code?: number; reason?: string }): void;
  onOpen(listener: () => void): void;
  offOpen(listener: () => void): void;
  onEvent(listener: (event: ReceiveEvent) => void): void;
  offEvent(listener: (event: ReceiveEvent) => void): void;
  onError(listener: (error: Error) => void): void;
  offError(listener: (error: Error) => void): void;
  onClose(listener: (event: WebSocketSessionCloseEvent) => void): void;
  offClose(listener: (event: WebSocketSessionCloseEvent) => void): void;
  onUnexpectedResponse?(
    listener: (event: WebSocketSessionUnexpectedResponseEvent) => void,
  ): void;
  offUnexpectedResponse?(
    listener: (event: WebSocketSessionUnexpectedResponseEvent) => void,
  ): void;
}

export interface WebSocketSessionTarget<
  SendPayload = unknown,
  ReceiveEvent = unknown,
> {
  sessionKey: string;
  connectionTimeoutMs?: number;
  createTransport(): WebSocketSessionTransport<SendPayload, ReceiveEvent>;
}

export interface WebSocketSessionRequest<ReceiveEvent = unknown> {
  readonly reusedConnection: boolean;
  readonly stream: AsyncIterable<ReceiveEvent>;
  release(): void;
  terminate(reason?: unknown): void;
}

type PendingResult<T> =
  | { kind: 'value'; value: T }
  | { kind: 'done' }
  | { kind: 'error'; error: unknown };

type ActiveRequest = {
  queue: AsyncQueue<unknown>;
  releaseTurn: () => void;
  abortSignal?: AbortSignal;
  abortListener?: () => void;
  settled: boolean;
};

function normalizeCloseCode(code: number | undefined): number | undefined {
  return typeof code === 'number' && Number.isInteger(code) && code >= 0
    ? code
    : undefined;
}

function normalizeTransportError(
  error: unknown,
  fallbackMessage: string,
): WebSocketSessionError {
  if (error instanceof WebSocketSessionError) {
    return error;
  }

  const message =
    error instanceof Error && error.message.trim()
      ? error.message
      : fallbackMessage;

  return new WebSocketSessionError(message, {
    kind: 'socket_error',
    cause: error,
  });
}

class AsyncQueue<T> implements AsyncIterable<T> {
  private readonly buffered: PendingResult<T>[] = [];
  private readonly waiters: Array<(result: IteratorResult<T>) => void> = [];
  private readonly rejecters: Array<(error: unknown) => void> = [];
  private settled = false;

  push(value: T): void {
    if (this.settled) {
      return;
    }

    const waiter = this.waiters.shift();
    const rejecter = this.rejecters.shift();
    if (waiter && rejecter) {
      waiter({ value, done: false });
      return;
    }

    this.buffered.push({ kind: 'value', value });
  }

  finish(): void {
    if (this.settled) {
      return;
    }

    this.settled = true;
    const waiter = this.waiters.shift();
    const rejecter = this.rejecters.shift();
    if (waiter && rejecter) {
      waiter({ value: undefined, done: true });
      return;
    }

    this.buffered.push({ kind: 'done' });
  }

  fail(error: unknown): void {
    if (this.settled) {
      return;
    }

    this.settled = true;
    const waiter = this.waiters.shift();
    const rejecter = this.rejecters.shift();
    if (waiter && rejecter) {
      rejecter(error);
      return;
    }

    this.buffered.push({ kind: 'error', error });
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    while (true) {
      if (this.buffered.length > 0) {
        const next = this.buffered.shift();
        if (!next) {
          continue;
        }

        switch (next.kind) {
          case 'value':
            yield next.value;
            continue;
          case 'done':
            return;
          case 'error':
            throw next.error;
        }
      }

      const result = await new Promise<IteratorResult<T>>((resolve, reject) => {
        this.waiters.push(resolve);
        this.rejecters.push(reject);
      });

      if (result.done) {
        return;
      }

      yield result.value;
    }
  }
}

export class WebSocketSessionError extends Error {
  readonly kind: WebSocketSessionErrorKind;
  readonly statusCode?: number;
  readonly closeCode?: number;

  constructor(
    message: string,
    options: {
      kind: WebSocketSessionErrorKind;
      statusCode?: number;
      closeCode?: number;
      cause?: unknown;
    },
  ) {
    super(message);
    this.name = 'WebSocketSessionError';
    this.kind = options.kind;
    this.statusCode = options.statusCode;
    this.closeCode = options.closeCode;
    if (options.cause !== undefined) {
      Object.defineProperty(this, 'cause', {
        configurable: true,
        enumerable: false,
        value: options.cause,
        writable: true,
      });
    }
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

class ManagedWebSocketConnection {
  readonly createdAt = Date.now();

  private lastActivityAt = Date.now();
  private transport:
    | WebSocketSessionTransport<unknown, unknown>
    | undefined;
  private openPromise:
    | Promise<WebSocketSessionTransport<unknown, unknown>>
    | undefined;
  private activeRequest: ActiveRequest | undefined;
  private requestTurn: Promise<void> = Promise.resolve();
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;

  constructor(
    private readonly manager: WebSocketSessionManager,
    private readonly target: WebSocketSessionTarget<unknown, unknown>,
  ) {
    this.scheduleIdleTimeout();
  }

  hasLiveSession(): boolean {
    if (this.disposed) {
      return false;
    }

    if (this.activeRequest || this.openPromise) {
      return true;
    }

    return this.transport?.readyState === 'open';
  }

  isIdle(): boolean {
    return (
      !this.disposed &&
      this.activeRequest === undefined &&
      this.openPromise === undefined &&
      this.transport?.readyState === 'open'
    );
  }

  async createRequest<ReceiveEvent>(
    payload: unknown,
    options: {
      signal?: AbortSignal;
    } = {},
  ): Promise<WebSocketSessionRequest<ReceiveEvent>> {
    if (this.disposed) {
      throw new WebSocketSessionError('WebSocket session is already disposed.', {
        kind: 'manager_disposed',
      });
    }

    let releaseTurn = (): void => {};
    const previousTurn = this.requestTurn;
    this.requestTurn = new Promise<void>((resolve) => {
      releaseTurn = resolve;
    });

    await previousTurn;

    try {
      const reusedConnection = this.transport?.readyState === 'open';
      const transport = await this.openTransport(options.signal);
      const queue = new AsyncQueue<unknown>();
      const activeRequest: ActiveRequest = {
        queue,
        releaseTurn,
        abortSignal: options.signal,
        settled: false,
      };
      this.activeRequest = activeRequest;
      this.clearIdleTimeout();

      if (options.signal) {
        if (options.signal.aborted) {
          const abortError = new WebSocketSessionError(
            'WebSocket request aborted.',
            {
              kind: 'request_aborted',
            },
          );
          this.failActiveRequest(activeRequest, abortError);
          this.close('request-aborted');
          throw abortError;
        }

        activeRequest.abortListener = (): void => {
          this.failActiveRequest(
            activeRequest,
            new WebSocketSessionError('WebSocket request aborted.', {
              kind: 'request_aborted',
            }),
          );
          this.close('request-aborted');
        };
        options.signal.addEventListener('abort', activeRequest.abortListener, {
          once: true,
        });
      }

      try {
        transport.send(payload);
        this.touch();
      } catch (error) {
        const sendError =
          error instanceof WebSocketSessionError
            ? error
            : new WebSocketSessionError('Failed to send WebSocket request.', {
                kind: 'request_send_failed',
                cause: error,
              });
        this.failActiveRequest(activeRequest, sendError);
        this.close('request-send-failed');
        throw sendError;
      }

      return {
        reusedConnection,
        stream: queue as AsyncIterable<ReceiveEvent>,
        release: (): void => {
          this.completeActiveRequest(activeRequest);
        },
        terminate: (reason?: unknown): void => {
          this.failActiveRequest(
            activeRequest,
            reason ??
              new WebSocketSessionError('WebSocket request terminated.', {
                kind: 'socket_closed',
              }),
          );
          this.close('request-terminated');
        },
      };
    } catch (error) {
      releaseTurn();
      throw error;
    }
  }

  close(reason = 'closed'): void {
    if (this.disposed) {
      return;
    }

    this.disposed = true;
    this.clearIdleTimeout();

    const activeRequest = this.activeRequest;
    this.activeRequest = undefined;
    if (activeRequest) {
      this.failActiveRequest(
        activeRequest,
        new WebSocketSessionError(`WebSocket connection closed: ${reason}`, {
          kind: 'socket_closed',
        }),
      );
    }

    const transport = this.transport;
    this.transport = undefined;
    this.openPromise = undefined;
    this.manager.removeConnection(this.target.sessionKey, this);

    if (
      transport &&
      (transport.readyState === 'open' || transport.readyState === 'connecting')
    ) {
      try {
        transport.close({
          code: 1000,
          reason,
        });
      } catch {
        // Ignore close failures while tearing down the session.
      }
    }
  }

  private async openTransport(
    signal?: AbortSignal,
  ): Promise<WebSocketSessionTransport<unknown, unknown>> {
    if (this.disposed) {
      throw new WebSocketSessionError('WebSocket session is already disposed.', {
        kind: 'manager_disposed',
      });
    }

    if (this.transport?.readyState === 'open') {
      return this.transport;
    }

    if (this.openPromise) {
      return this.openPromise;
    }

    const connectionTimeoutMs =
      this.target.connectionTimeoutMs ?? DEFAULT_CONNECTION_TIMEOUT_MS;

    let resolveOpen:
      | ((transport: WebSocketSessionTransport<unknown, unknown>) => void)
      | undefined;
    let rejectOpen: ((error: unknown) => void) | undefined;
    const openPromise = new Promise<WebSocketSessionTransport<unknown, unknown>>(
      (resolve, reject) => {
        resolveOpen = resolve;
        rejectOpen = reject;
      },
    );
    this.openPromise = openPromise;

    let transport: WebSocketSessionTransport<unknown, unknown>;
    try {
      transport = this.target.createTransport();
    } catch (error) {
      this.openPromise = undefined;
      this.close('transport-create-failed');
      throw normalizeTransportError(
        error,
        'Failed to create WebSocket transport.',
      );
    }

    this.transport = transport;
    this.installRuntimeListeners(transport);

    let settled = false;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;

    const cleanup = (): void => {
      if (timeoutId !== undefined) {
        clearTimeout(timeoutId);
        timeoutId = undefined;
      }

      transport.offOpen(handleOpen);
      transport.offError(handleError);
      transport.offClose(handleCloseBeforeOpen);
      transport.offUnexpectedResponse?.(handleUnexpectedResponse);

      if (signal && abortListener) {
        signal.removeEventListener('abort', abortListener);
      }
    };

    const settleOpen = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      if (this.openPromise === openPromise) {
        this.openPromise = undefined;
      }
      this.touch();
      resolveOpen?.(transport);
    };

    const settleError = (error: unknown): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      if (this.openPromise === openPromise) {
        this.openPromise = undefined;
      }
      this.close('open-failed');
      rejectOpen?.(error);
    };

    const handleOpen = (): void => {
      settleOpen();
    };

    const handleError = (error: Error): void => {
      settleError(
        normalizeTransportError(error, 'WebSocket connection failed.'),
      );
    };

    const handleCloseBeforeOpen = (event: WebSocketSessionCloseEvent): void => {
      settleError(
        new WebSocketSessionError(
          `WebSocket connection closed before opening (code ${
            event.code ?? 0
          }).`,
          {
            kind: 'socket_closed',
            closeCode: normalizeCloseCode(event.code),
          },
        ),
      );
    };

    const handleUnexpectedResponse = (
      event: WebSocketSessionUnexpectedResponseEvent,
    ): void => {
      settleError(
        new WebSocketSessionError(
          `Unexpected WebSocket upgrade response (${event.statusCode ?? 0}).`,
          {
            kind: 'unexpected_response',
            statusCode: event.statusCode,
          },
        ),
      );
    };

    const abortListener = signal
      ? (): void => {
          settleError(
            new WebSocketSessionError('WebSocket connection aborted.', {
              kind: 'request_aborted',
            }),
          );
        }
      : undefined;

    transport.onOpen(handleOpen);
    transport.onError(handleError);
    transport.onClose(handleCloseBeforeOpen);
    transport.onUnexpectedResponse?.(handleUnexpectedResponse);

    if (signal && abortListener) {
      signal.addEventListener('abort', abortListener, { once: true });
    }

    if (transport.readyState === 'open') {
      settleOpen();
      return openPromise;
    }

    if (transport.readyState === 'closed') {
      settleError(
        new WebSocketSessionError(
          'WebSocket connection was already closed before opening.',
          {
            kind: 'socket_closed',
          },
        ),
      );
      return openPromise;
    }

    timeoutId = setTimeout(() => {
      settleError(
        new WebSocketSessionError(
          `Timed out opening WebSocket connection after ${connectionTimeoutMs}ms.`,
          {
            kind: 'connection_timeout',
          },
        ),
      );
    }, connectionTimeoutMs);

    return openPromise;
  }

  private installRuntimeListeners(
    transport: WebSocketSessionTransport<unknown, unknown>,
  ): void {
    transport.onEvent((event) => {
      this.touch();

      const activeRequest = this.activeRequest;
      if (!activeRequest) {
        return;
      }

      activeRequest.queue.push(event);
    });

    transport.onError((error) => {
      const activeRequest = this.activeRequest;
      if (activeRequest) {
        this.failActiveRequest(
          activeRequest,
          normalizeTransportError(error, 'WebSocket runtime error.'),
        );
      }

      this.close('transport-error');
    });

    transport.onClose((event) => {
      const activeRequest = this.activeRequest;
      if (activeRequest) {
        this.failActiveRequest(
          activeRequest,
          new WebSocketSessionError(
            `WebSocket connection closed (code ${event.code ?? 0}).`,
            {
              kind: 'socket_closed',
              closeCode: normalizeCloseCode(event.code),
            },
          ),
        );
      }

      this.transport = undefined;
      this.openPromise = undefined;
      this.manager.removeConnection(this.target.sessionKey, this);
    });
  }

  private touch(): void {
    if (this.disposed) {
      return;
    }

    this.lastActivityAt = Date.now();
    this.scheduleIdleTimeout();
  }

  private scheduleIdleTimeout(): void {
    this.clearIdleTimeout();

    if (this.disposed) {
      return;
    }

    this.idleTimer = setTimeout(() => {
      const idleMs = Date.now() - this.lastActivityAt;
      if (idleMs < DEFAULT_IDLE_TIMEOUT_MS || this.activeRequest) {
        this.scheduleIdleTimeout();
        return;
      }

      this.close('idle-timeout');
    }, DEFAULT_IDLE_TIMEOUT_MS);
  }

  private clearIdleTimeout(): void {
    if (this.idleTimer !== undefined) {
      clearTimeout(this.idleTimer);
      this.idleTimer = undefined;
    }
  }

  private completeActiveRequest(activeRequest: ActiveRequest): void {
    if (this.activeRequest !== activeRequest || activeRequest.settled) {
      return;
    }

    activeRequest.settled = true;
    if (activeRequest.abortSignal && activeRequest.abortListener) {
      activeRequest.abortSignal.removeEventListener(
        'abort',
        activeRequest.abortListener,
      );
    }

    this.activeRequest = undefined;
    activeRequest.queue.finish();
    activeRequest.releaseTurn();
    this.touch();
    this.manager.trimIdleConnections();
  }

  private failActiveRequest(
    activeRequest: ActiveRequest,
    error: unknown,
  ): void {
    if (activeRequest.settled) {
      return;
    }

    activeRequest.settled = true;
    if (activeRequest.abortSignal && activeRequest.abortListener) {
      activeRequest.abortSignal.removeEventListener(
        'abort',
        activeRequest.abortListener,
      );
    }

    if (this.activeRequest === activeRequest) {
      this.activeRequest = undefined;
    }

    activeRequest.queue.fail(error);
    activeRequest.releaseTurn();
    this.manager.trimIdleConnections();
  }
}

export class WebSocketSessionManager {
  private readonly connections = new Map<string, ManagedWebSocketConnection>();
  private disposed = false;

  hasSession(sessionKey: string): boolean {
    const connection = this.connections.get(sessionKey);
    return connection?.hasLiveSession() ?? false;
  }

  closeSession(sessionKey: string, reason?: Error | string): void {
    const connection = this.connections.get(sessionKey);
    if (!connection) {
      return;
    }

    const reasonText =
      typeof reason === 'string'
        ? reason
        : reason instanceof Error
          ? reason.message
          : 'closed-session';
    connection.close(reasonText);
  }

  async createRequest<SendPayload, ReceiveEvent>(
    target: WebSocketSessionTarget<SendPayload, ReceiveEvent>,
    payload: SendPayload,
    options: {
      signal?: AbortSignal;
      forceNewConnection?: boolean;
    } = {},
  ): Promise<WebSocketSessionRequest<ReceiveEvent>> {
    if (this.disposed) {
      throw new WebSocketSessionError('WebSocket session manager is disposed.', {
        kind: 'manager_disposed',
      });
    }

    let connection = this.connections.get(target.sessionKey);

    if (options.forceNewConnection && connection) {
      connection.close('force-new-connection');
      connection = undefined;
    }

    if (!connection) {
      this.trimIdleConnections(1);
      connection = new ManagedWebSocketConnection(
        this,
        target as WebSocketSessionTarget<unknown, unknown>,
      );
      this.connections.set(target.sessionKey, connection);
    }

    return connection.createRequest<ReceiveEvent>(payload, {
      signal: options.signal,
    });
  }

  removeConnection(
    sessionKey: string,
    connection: ManagedWebSocketConnection,
  ): void {
    const current = this.connections.get(sessionKey);
    if (current === connection) {
      this.connections.delete(sessionKey);
    }
  }

  trimIdleConnections(extraNeeded = 0): void {
    while (this.connections.size + extraNeeded > DEFAULT_SOFT_CONNECTION_LIMIT) {
      const oldestIdle = [...this.connections.values()]
        .filter((connection) => connection.isIdle())
        .sort((left, right) => left.createdAt - right.createdAt)[0];

      if (!oldestIdle) {
        break;
      }

      oldestIdle.close('soft-limit-eviction');
    }
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }

    this.disposed = true;
    const connections = [...this.connections.values()];
    this.connections.clear();
    for (const connection of connections) {
      connection.close('manager-disposed');
    }
  }
}

export const webSocketSessionManager = new WebSocketSessionManager();

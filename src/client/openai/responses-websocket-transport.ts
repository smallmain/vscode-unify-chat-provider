import OpenAI from 'openai';
import type {
  ResponseErrorEvent,
  ResponsesClientEvent,
  ResponsesServerEvent,
  ResponseStreamEvent,
} from 'openai/resources/responses/responses';
import { ResponsesWS } from 'openai/resources/responses/ws';
import type {
  BetaResponsesClientEvent,
  BetaResponsesServerEvent,
  BetaResponseStreamEvent,
} from 'openai/resources/beta/responses/responses';
import { ResponsesWS as BetaResponsesWS } from 'openai/resources/beta/responses/ws';
import {
  WebSocketSessionCloseEvent,
  WebSocketSessionError,
  WebSocketSessionTransport,
  WebSocketSessionUnexpectedResponseEvent,
} from '../websocket-session-manager';

type OpenAIResponsesClientEvent =
  | ResponsesClientEvent
  | BetaResponsesClientEvent;
type OpenAIResponsesStreamEvent =
  | ResponseStreamEvent
  | BetaResponseStreamEvent;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasResponseErrorEvent(
  error: Error,
): error is Error & { error: ResponseErrorEvent } {
  if (!isRecord(error)) {
    return false;
  }

  const event = error['error'];
  return isRecord(event) && event['type'] === 'error';
}

function normalizeCloseCode(code: number): number | undefined {
  return Number.isInteger(code) && code >= 0 ? code : undefined;
}

function decodeCloseReason(reason: Buffer | string): string | undefined {
  if (typeof reason === 'string') {
    return reason || undefined;
  }

  const decoded = reason.toString('utf8');
  return decoded || undefined;
}

interface WebSocketReadyStateConstants {
  CONNECTING: number;
  OPEN: number;
  CLOSING: number;
  CLOSED: number;
}

const STANDARD_READY_STATE: WebSocketReadyStateConstants = {
  CONNECTING: 0,
  OPEN: 1,
  CLOSING: 2,
  CLOSED: 3,
};

function getReadyStateConstants(
  socket: unknown,
): WebSocketReadyStateConstants {
  if (!isRecord(socket)) {
    return STANDARD_READY_STATE;
  }

  const candidate = isRecord(socket['platformSocket'])
    ? socket['platformSocket']
    : socket;
  const constructorValue = candidate['constructor'];
  const constants = isReadyStateConstants(constructorValue)
    ? constructorValue
    : candidate;

  return isReadyStateConstants(constants) ? constants : STANDARD_READY_STATE;
}

function isReadyStateConstants(
  value: unknown,
): value is WebSocketReadyStateConstants {
  return (
    isRecord(value) &&
    typeof value['CONNECTING'] === 'number' &&
    typeof value['OPEN'] === 'number' &&
    typeof value['CLOSING'] === 'number' &&
    typeof value['CLOSED'] === 'number'
  );
}

function normalizeSDKError(error: Error): WebSocketSessionError {
  const message = error.message || 'OpenAI Responses WebSocket runtime error.';
  const normalizedMessage = message.toLowerCase();

  if (normalizedMessage.includes('could not parse websocket event')) {
    return new WebSocketSessionError(message, {
      kind: 'protocol_error',
      cause: error,
    });
  }

  if (normalizedMessage.includes('could not send data')) {
    return new WebSocketSessionError(message, {
      kind: 'request_send_failed',
      cause: error,
    });
  }

  return new WebSocketSessionError(message, {
    kind: 'socket_error',
    cause: error,
  });
}

export class OpenAIResponsesWebSocketTransport
  implements
    WebSocketSessionTransport<
      OpenAIResponsesClientEvent,
      OpenAIResponsesStreamEvent
    >
{
  private readonly sendPayload: (payload: OpenAIResponsesClientEvent) => void;
  private readonly closeSocket: (props: {
    code: number;
    reason: string;
  }) => void;
  private readonly resolveReadyState: () => WebSocketSessionTransport<
    OpenAIResponsesClientEvent,
    OpenAIResponsesStreamEvent
  >['readyState'];
  private readonly openListeners = new Set<() => void>();
  private readonly eventListeners = new Set<
    (event: OpenAIResponsesStreamEvent) => void
  >();
  private readonly errorListeners = new Set<(error: Error) => void>();
  private readonly closeListeners = new Set<
    (event: WebSocketSessionCloseEvent) => void
  >();
  private readonly unexpectedResponseListeners = new Set<
    (event: WebSocketSessionUnexpectedResponseEvent) => void
  >();

  constructor(
    client: OpenAI,
    headers: Record<string, string> | undefined,
    beta: boolean,
  ) {
    if (beta) {
      const ws = new BetaResponsesWS(client, { headers });
      this.sendPayload = (payload) => {
        ws.sendRaw(JSON.stringify(payload));
      };
      this.closeSocket = (props) => ws.close(props);
      this.resolveReadyState = () =>
        this.normalizeReadyState(
          ws.socket.readyState,
          getReadyStateConstants(ws.socket),
        );
      ws.socket.on('open', this.handleOpen);
      ws.on('event', this.handleBetaEvent);
      ws.on('error', this.handleError);
      ws.socket.on('close', this.handleClose);
      ws.socket.on(
        'unexpected-response',
        this.handleUnexpectedResponse,
      );
      return;
    }

    const ws = new ResponsesWS(client, { headers });
    this.sendPayload = (payload) => {
      ws.sendRaw(JSON.stringify(payload));
    };
    this.closeSocket = (props) => ws.close(props);
    this.resolveReadyState = () =>
      this.normalizeReadyState(
        ws.socket.readyState,
        getReadyStateConstants(ws.socket),
      );
    ws.socket.on('open', this.handleOpen);
    ws.on('event', this.handleEvent);
    ws.on('error', this.handleError);
    ws.socket.on('close', this.handleClose);
    ws.socket.on('unexpected-response', this.handleUnexpectedResponse);
  }

  get readyState(): WebSocketSessionTransport<
    OpenAIResponsesClientEvent,
    OpenAIResponsesStreamEvent
  >['readyState'] {
    return this.resolveReadyState();
  }

  private normalizeReadyState(
    readyState: number,
    constants: WebSocketReadyStateConstants,
  ): WebSocketSessionTransport<
    OpenAIResponsesClientEvent,
    OpenAIResponsesStreamEvent
  >['readyState'] {
    switch (readyState) {
      case constants.CONNECTING:
        return 'connecting';
      case constants.OPEN:
        return 'open';
      case constants.CLOSING:
        return 'closing';
      case constants.CLOSED:
      default:
        return 'closed';
    }
  }

  send(payload: OpenAIResponsesClientEvent): void {
    this.sendPayload(payload);
  }

  close(props?: { code?: number; reason?: string }): void {
    this.closeSocket({
      code: props?.code ?? 1000,
      reason: props?.reason ?? 'OK',
    });
  }

  onOpen(listener: () => void): void {
    this.openListeners.add(listener);
  }

  offOpen(listener: () => void): void {
    this.openListeners.delete(listener);
  }

  onEvent(listener: (event: OpenAIResponsesStreamEvent) => void): void {
    this.eventListeners.add(listener);
  }

  offEvent(listener: (event: OpenAIResponsesStreamEvent) => void): void {
    this.eventListeners.delete(listener);
  }

  onError(listener: (error: Error) => void): void {
    this.errorListeners.add(listener);
  }

  offError(listener: (error: Error) => void): void {
    this.errorListeners.delete(listener);
  }

  onClose(listener: (event: WebSocketSessionCloseEvent) => void): void {
    this.closeListeners.add(listener);
  }

  offClose(listener: (event: WebSocketSessionCloseEvent) => void): void {
    this.closeListeners.delete(listener);
  }

  onUnexpectedResponse(
    listener: (event: WebSocketSessionUnexpectedResponseEvent) => void,
  ): void {
    this.unexpectedResponseListeners.add(listener);
  }

  offUnexpectedResponse(
    listener: (event: WebSocketSessionUnexpectedResponseEvent) => void,
  ): void {
    this.unexpectedResponseListeners.delete(listener);
  }

  private readonly handleOpen = (): void => {
    for (const listener of this.openListeners) {
      listener();
    }
  };

  private readonly handleEvent = (event: ResponsesServerEvent): void => {
    for (const listener of this.eventListeners) {
      listener(event);
    }
  };

  private readonly handleBetaEvent = (
    event: BetaResponsesServerEvent,
  ): void => {
    if (
      event.type === 'response.inject.created' ||
      event.type === 'response.inject.failed'
    ) {
      return;
    }
    for (const listener of this.eventListeners) {
      listener(event);
    }
  };

  private readonly handleError = (error: Error): void => {
    if (hasResponseErrorEvent(error)) {
      return;
    }

    const normalized = normalizeSDKError(error);
    for (const listener of this.errorListeners) {
      listener(normalized);
    }
  };

  private readonly handleClose = (code: number, reason: Buffer): void => {
    const event: WebSocketSessionCloseEvent = {
      code: normalizeCloseCode(code),
      reason: decodeCloseReason(reason),
    };
    for (const listener of this.closeListeners) {
      listener(event);
    }
  };

  private readonly handleUnexpectedResponse = (
    _request: unknown,
    response: { statusCode?: number },
  ): void => {
    const event: WebSocketSessionUnexpectedResponseEvent = {
      statusCode: response.statusCode,
    };
    for (const listener of this.unexpectedResponseListeners) {
      listener(event);
    }
  };
}

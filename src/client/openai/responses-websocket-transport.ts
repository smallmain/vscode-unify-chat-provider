import OpenAI from 'openai';
import type {
  ResponseErrorEvent,
  ResponsesClientEvent,
  ResponsesServerEvent,
  ResponseStreamEvent,
} from 'openai/resources/responses/responses';
import { ResponsesWS } from 'openai/resources/responses/ws';
import {
  WebSocketSessionCloseEvent,
  WebSocketSessionError,
  WebSocketSessionTransport,
  WebSocketSessionUnexpectedResponseEvent,
} from '../websocket-session-manager';

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
    WebSocketSessionTransport<ResponsesClientEvent, ResponseStreamEvent>
{
  private readonly ws: ResponsesWS;
  private readonly openListeners = new Set<() => void>();
  private readonly eventListeners = new Set<
    (event: ResponseStreamEvent) => void
  >();
  private readonly errorListeners = new Set<(error: Error) => void>();
  private readonly closeListeners = new Set<
    (event: WebSocketSessionCloseEvent) => void
  >();
  private readonly unexpectedResponseListeners = new Set<
    (event: WebSocketSessionUnexpectedResponseEvent) => void
  >();

  constructor(client: OpenAI, headers?: Record<string, string>) {
    this.ws = new ResponsesWS(client, { headers });
    this.ws.socket.on('open', this.handleOpen);
    this.ws.on('event', this.handleEvent);
    this.ws.on('error', this.handleError);
    this.ws.socket.on('close', this.handleClose);
    this.ws.socket.on('unexpected-response', this.handleUnexpectedResponse);
  }

  get readyState(): WebSocketSessionTransport<
    ResponsesClientEvent,
    ResponseStreamEvent
  >['readyState'] {
    switch (this.ws.socket.readyState) {
      case this.ws.socket.CONNECTING:
        return 'connecting';
      case this.ws.socket.OPEN:
        return 'open';
      case this.ws.socket.CLOSING:
        return 'closing';
      case this.ws.socket.CLOSED:
      default:
        return 'closed';
    }
  }

  send(payload: ResponsesClientEvent): void {
    this.ws.send(payload);
  }

  close(props?: { code?: number; reason?: string }): void {
    this.ws.close({
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

  onEvent(listener: (event: ResponseStreamEvent) => void): void {
    this.eventListeners.add(listener);
  }

  offEvent(listener: (event: ResponseStreamEvent) => void): void {
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

import type { RpcError } from './errors';

export const PROTOCOL_VERSION = 1 as const;

export type HelloMessage = {
  type: 'hello';
  clientId: string;
  protocolVersion: number;
  authToken: string;
  extensionVersion?: string;
};

export type WelcomeMessage = {
  type: 'welcome';
  leaderId: string;
  protocolVersion: number;
  ready: boolean;
  extensionVersion?: string;
};

export type RequestMessage = {
  type: 'request';
  id: string;
  method: string;
  params: unknown;
};

export type ResponseMessage =
  | { type: 'response'; id: string; ok: true; result: unknown }
  | { type: 'response'; id: string; ok: false; error: RpcError };

export type CancelMessage = {
  type: 'cancel';
  id: string;
};

export type EventMessage = {
  type: 'event';
  event: string;
  payload: unknown;
};

export type IpcMessage =
  | HelloMessage
  | WelcomeMessage
  | RequestMessage
  | ResponseMessage
  | CancelMessage
  | EventMessage;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

function optionalNonEmptyString(value: unknown): string | undefined {
  return isNonEmptyString(value) ? value : undefined;
}

function isMainInstanceErrorCode(value: unknown): value is RpcError['code'] {
  switch (value) {
    case 'LEADER_GONE':
    case 'NO_LEADER':
    case 'UNAUTHORIZED':
    case 'BAD_REQUEST':
    case 'PORT_IN_USE':
    case 'BUSY':
    case 'NOT_IMPLEMENTED':
    case 'CANCELLED':
    case 'INTERNAL_ERROR':
    case 'INCOMPATIBLE_VERSION':
      return true;
    default:
      return false;
  }
}

function parseRpcError(value: unknown): RpcError | undefined {
  if (!isRecord(value)) return undefined;
  const code = value['code'];
  const message = value['message'];
  if (!isMainInstanceErrorCode(code) || !isNonEmptyString(message)) {
    return undefined;
  }
  return { code, message };
}

export function serializeMessage(message: IpcMessage): string {
  return `${JSON.stringify(message)}\n`;
}

export function parseMessageLine(line: string): IpcMessage | undefined {
  const trimmed = line.trim();
  if (!trimmed) {
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return undefined;
  }

  if (!isRecord(parsed)) {
    return undefined;
  }

  const type = parsed['type'];
  if (!isNonEmptyString(type)) {
    return undefined;
  }

  switch (type) {
    case 'hello': {
      const clientId = parsed['clientId'];
      const protocolVersion = parsed['protocolVersion'];
      const authToken = parsed['authToken'];
      const extensionVersion = optionalNonEmptyString(parsed['extensionVersion']);
      if (
        !isNonEmptyString(clientId) ||
        typeof protocolVersion !== 'number' ||
        !isNonEmptyString(authToken)
      ) {
        return undefined;
      }
      return {
        type: 'hello',
        clientId,
        protocolVersion,
        authToken,
        extensionVersion,
      };
    }
    case 'welcome': {
      const leaderId = parsed['leaderId'];
      const protocolVersion = parsed['protocolVersion'];
      const ready = parsed['ready'];
      const extensionVersion = optionalNonEmptyString(parsed['extensionVersion']);
      if (
        !isNonEmptyString(leaderId) ||
        typeof protocolVersion !== 'number' ||
        typeof ready !== 'boolean'
      ) {
        return undefined;
      }
      return {
        type: 'welcome',
        leaderId,
        protocolVersion,
        ready,
        extensionVersion,
      };
    }
    case 'request': {
      const id = parsed['id'];
      const method = parsed['method'];
      const params = parsed['params'];
      if (!isNonEmptyString(id) || !isNonEmptyString(method)) {
        return undefined;
      }
      return { type: 'request', id, method, params };
    }
    case 'response': {
      const id = parsed['id'];
      const ok = parsed['ok'];
      if (!isNonEmptyString(id) || typeof ok !== 'boolean') {
        return undefined;
      }
      if (ok) {
        return { type: 'response', id, ok: true, result: parsed['result'] };
      }
      const error = parseRpcError(parsed['error']);
      if (!error) {
        return undefined;
      }
      return { type: 'response', id, ok: false, error };
    }
    case 'cancel': {
      const id = parsed['id'];
      if (!isNonEmptyString(id)) {
        return undefined;
      }
      return { type: 'cancel', id };
    }
    case 'event': {
      const event = parsed['event'];
      const payload = parsed['payload'];
      if (!isNonEmptyString(event)) {
        return undefined;
      }
      return { type: 'event', event, payload };
    }
    default:
      return undefined;
  }
}

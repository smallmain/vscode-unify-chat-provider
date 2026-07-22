import * as vscode from 'vscode';
import type { ProviderHttpLogger } from '../../logger';
import type { CompletionRequestKind } from '../model/requests';

const COMPLETION_LOG_CHANNEL_NAME = 'Unify Chat Provider: Completion';
const CONFIG_NAMESPACE = 'unifyChatProvider';
const REDACTED = '[REDACTED]';

let channel: vscode.LogOutputChannel | undefined;
let nextRequestId = 1;

export interface CompletionRequestLogContext {
  readonly transport: 'native' | 'compatible';
  readonly requestKind: CompletionRequestKind;
  readonly model: string;
}

function isVerboseEnabled(): boolean {
  return vscode.workspace
    .getConfiguration(CONFIG_NAMESPACE)
    .get<boolean>('verbose', false);
}

function getChannel(): vscode.LogOutputChannel {
  channel ??= vscode.window.createOutputChannel(COMPLETION_LOG_CHANNEL_NAME, {
    log: true,
  });
  return channel;
}

function normalizedCredentialKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function isCredentialKey(key: string): boolean {
  const normalized = normalizedCredentialKey(key);
  switch (normalized) {
    case 'authorization':
    case 'proxyauthorization':
    case 'xapikey':
    case 'apikey':
    case 'xgoogapikey':
    case 'cookie':
    case 'setcookie':
    case 'token':
    case 'accesstoken':
    case 'refreshtoken':
    case 'idtoken':
    case 'clientsecret':
    case 'privatekey':
    case 'secretkey':
    case 'subscriptionkey':
    case 'signature':
    case 'sig':
    case 'key':
    case 'credential':
    case 'credentials':
    case 'secret':
    case 'password':
    case 'passwd':
      return true;
    default:
      return (
        normalized.endsWith('apikey') ||
        normalized.endsWith('token') ||
        normalized.endsWith('secret') ||
        normalized.endsWith('password') ||
        normalized.endsWith('privatekey') ||
        normalized.endsWith('secretkey') ||
        normalized.endsWith('subscriptionkey') ||
        normalized.endsWith('signature')
      );
  }
}

const CREDENTIAL_TEXT_NAME =
  String.raw`(?:authorization|proxy[-_ ]?authorization|cookie|set[-_ ]?cookie|key|sig|credential|credentials|[a-z0-9_.-]*(?:api[-_ ]?key|token|secret|password|passwd|private[-_ ]?key|subscription[-_ ]?key|signature))`;

function redactCredentialText(value: string): string {
  const assignmentPrefix =
    `((?:["'])?${CREDENTIAL_TEXT_NAME}(?:["'])?\\s*[:=]\\s*)`;
  const schemeAssignment = new RegExp(
    `${assignmentPrefix}(Bearer|Basic|Token)\\s+[^\\s"',}]+`,
    'gi',
  );
  const doubleQuotedAssignment = new RegExp(
    `${assignmentPrefix}"(?:\\\\.|[^"\\\\])*"`,
    'gi',
  );
  const singleQuotedAssignment = new RegExp(
    `${assignmentPrefix}'(?:\\\\.|[^'\\\\])*'`,
    'gi',
  );
  const unquotedAssignment = new RegExp(
    `(${CREDENTIAL_TEXT_NAME}\\s*[:=]\\s*)(?!["'])([^\\s,}&]+)`,
    'gi',
  );
  return value
    .replace(
      schemeAssignment,
      (_match, prefix: string, scheme: string) =>
        `${prefix}${scheme} ${REDACTED}`,
    )
    .replace(
      /\b(Bearer|Basic|Token)\s+[^\s"',}]+/gi,
      (_match, scheme: string) => `${scheme} ${REDACTED}`,
    )
    .replace(
      doubleQuotedAssignment,
      (_match, prefix: string) => `${prefix}"${REDACTED}"`,
    )
    .replace(
      singleQuotedAssignment,
      (_match, prefix: string) => `${prefix}'${REDACTED}'`,
    )
    .replace(unquotedAssignment, (_match, prefix: string) =>
      `${prefix}${REDACTED}`,
    )
    .replace(
      /(https?:\/\/)[^/\s:@]+:[^/\s@]+@/gi,
      `$1${REDACTED}:${REDACTED}@`,
    )
    .replace(/([?&][^=&#\s]+)=([^&#\s]*)/g, `$1=${REDACTED}`);
}

function redactUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return value;
  }
  let changed = parsed.username.length > 0 || parsed.password.length > 0;
  if (parsed.username.length > 0) parsed.username = REDACTED;
  if (parsed.password.length > 0) parsed.password = REDACTED;
  for (const key of new Set(parsed.searchParams.keys())) {
    parsed.searchParams.set(key, REDACTED);
    changed = true;
  }
  return changed
    ? parsed
        .toString()
        .replaceAll('%5BREDACTED%5D', REDACTED)
        .replaceAll('%5Bredacted%5D', REDACTED)
    : value;
}

function sanitizeForLog(
  value: unknown,
  seen: WeakSet<object>,
  key?: string,
): unknown {
  if (key !== undefined && isCredentialKey(key)) {
    return REDACTED;
  }
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return value;
  }
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'symbol') return value.toString();
  if (typeof value === 'function') return '[Function]';
  if (typeof value !== 'object') return String(value);
  if (value instanceof Date) return value.toISOString();
  if (ArrayBuffer.isView(value)) {
    return `[${value.constructor.name}: ${value.byteLength} bytes]`;
  }
  if (value instanceof ArrayBuffer) {
    return `[ArrayBuffer: ${value.byteLength} bytes]`;
  }
  if (
    typeof SharedArrayBuffer !== 'undefined' &&
    value instanceof SharedArrayBuffer
  ) {
    return `[SharedArrayBuffer: ${value.byteLength} bytes]`;
  }
  if (seen.has(value)) return '[Circular]';
  seen.add(value);
  if (value instanceof Error) {
    const codeDescriptor = Object.getOwnPropertyDescriptor(value, 'code');
    const causeDescriptor = Object.getOwnPropertyDescriptor(value, 'cause');
    const code =
      codeDescriptor && 'value' in codeDescriptor
        ? codeDescriptor.value
        : undefined;
    const message =
      code === 'completion-http-error'
        ? (/^(Completion request failed with HTTP \d+)/.exec(value.message)?.[1] ??
          'Completion HTTP request failed.')
        : redactCredentialText(value.message);
    const stackLines =
      typeof value.stack === 'string' ? value.stack.split('\n') : undefined;
    return {
      name: value.name,
      message,
      ...(stackLines
        ? {
            stack: [
              `${value.name}: ${message}`,
              ...stackLines.slice(1).map(redactCredentialText),
            ].join('\n'),
          }
        : {}),
      ...(code !== undefined
        ? { code: sanitizeForLog(code, seen, 'code') }
        : {}),
      ...(causeDescriptor &&
      'value' in causeDescriptor &&
      causeDescriptor.value !== undefined
        ? { cause: sanitizeForLog(causeDescriptor.value, seen) }
        : {}),
    };
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeForLog(item, seen));
  }
  const result: Record<string, unknown> = {};
  for (const childKey of Object.keys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, childKey);
    if (!descriptor) continue;
    result[childKey] =
      'value' in descriptor
        ? sanitizeForLog(descriptor.value, seen, childKey)
        : '[Getter]';
  }
  return result;
}

function stringifyForLog(value: unknown): string {
  try {
    const result = JSON.stringify(
      sanitizeForLog(value, new WeakSet()),
      null,
      2,
    );
    return result ?? 'undefined';
  } catch (error) {
    return `<<Failed to serialize log payload: ${
      error instanceof Error ? error.message : String(error)
    }>>`;
  }
}

function formatRawPayload(value: string): string {
  try {
    return stringifyForLog(JSON.parse(value));
  } catch {
    return redactCredentialText(value);
  }
}

function sanitizeHeadersForLog(
  headers: Record<string, string>,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const key of Object.keys(headers)) {
    const descriptor = Object.getOwnPropertyDescriptor(headers, key);
    if (!descriptor) continue;
    result[key] =
      'value' in descriptor && typeof descriptor.value === 'string'
        ? isCredentialKey(key)
          ? REDACTED
          : redactCredentialText(descriptor.value)
        : '[Getter]';
  }
  return result;
}

export class CompletionRequestLogger implements ProviderHttpLogger {
  private readonly output = getChannel();
  private readonly startedAt = Date.now();
  private finished = false;

  constructor(
    readonly requestId: string,
    private readonly context: CompletionRequestLogContext,
  ) {
    this.output.info(
      `${this.prefix} Request started | Model: ${context.model}`,
    );
  }

  private get prefix(): string {
    return `[${this.requestId}] [${this.context.transport}:${this.context.requestKind}]`;
  }

  providerRequest(details: {
    endpoint: string;
    method?: string;
    headers?: Record<string, string>;
    body?: unknown;
  }): void {
    const method = details.method ?? 'GET';
    this.output.info(
      `${this.prefix} -> ${method} ${redactUrl(details.endpoint)}`,
    );
    this.output.info(
      `${this.prefix} Request Headers:\n${stringifyForLog(
        sanitizeHeadersForLog(details.headers ?? {}),
      )}`,
    );
    this.output.info(
      `${this.prefix} Request Body:\n${
        typeof details.body === 'string'
          ? formatRawPayload(details.body)
          : stringifyForLog(details.body ?? null)
      }`,
    );
  }

  providerResponseMeta(response: Response): void {
    const contentType = response.headers.get('content-type') ?? 'unknown';
    this.output.info(
      `${this.prefix} <- Status ${response.status} ${
        response.statusText || ''
      } (${contentType})`.trim(),
    );
  }

  rawHttpResponseBody(body: string): void {
    this.output.info(
      `${this.prefix} Response Body:\n${formatRawPayload(body)}`,
    );
  }

  retry(
    attempt: number,
    maxRetries: number,
    statusCode: number,
    delayMs: number,
    responseBody?: string,
    errorDetail?: string,
  ): void {
    const reason = redactCredentialText(
      statusCode === 0 && errorDetail ? errorDetail : `HTTP ${statusCode}`,
    );
    this.output.warn(
      `${this.prefix} Retry ${attempt}/${maxRetries} after ${reason}, waiting ${delayMs}ms`,
    );
    if (responseBody !== undefined) {
      this.output.warn(
        `${this.prefix} Retry Response Body:\n${formatRawPayload(
          responseBody,
        )}`,
      );
    }
  }

  languageModelRequest(
    messages: readonly unknown[],
    options: unknown,
  ): void {
    this.output.info(`${this.prefix} -> LanguageModelChat.sendRequest`);
    this.output.info(
      `${this.prefix} Messages:\n${stringifyForLog(messages)}`,
    );
    this.output.info(
      `${this.prefix} Options:\n${stringifyForLog(options)}`,
    );
  }

  languageModelResponseChunk(chunk: string): void {
    this.output.info(`${this.prefix} <- LanguageModelChat chunk:\n${chunk}`);
  }

  complete(): void {
    this.finish('completed');
  }

  cancelled(): void {
    this.finish('cancelled');
  }

  error(error: unknown): void {
    if (this.finished) return;
    this.finished = true;
    this.output.error(
      `${this.prefix} Request failed | Total latency: ${
        Date.now() - this.startedAt
      }ms`,
    );
    this.output.error(
      `${this.prefix} Error:\n${stringifyForLog(error)}`,
    );
  }

  private finish(outcome: 'completed' | 'cancelled'): void {
    if (this.finished) return;
    this.finished = true;
    this.output.info(
      `${this.prefix} Request ${outcome} | Total latency: ${
        Date.now() - this.startedAt
      }ms`,
    );
  }
}

export function createCompletionRequestLogger(
  context: CompletionRequestLogContext,
): CompletionRequestLogger | undefined {
  if (!isVerboseEnabled()) return undefined;
  return new CompletionRequestLogger(`completion-${nextRequestId++}`, context);
}

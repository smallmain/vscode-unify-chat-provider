import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import type { Socket, SocketConnectOpts } from 'node:net';
import type { ConnectionOptions } from 'node:tls';
import * as tls from 'node:tls';
import { DataPartMimeTypes, StatefulMarkerData } from './client/types';
import type { ProviderHttpLogger } from './logger';
import { officialModelsManager } from './official-models-manager';
import type {
  CopilotUsage,
  ContextCacheConfig,
  ContextCacheType,
  ModelConfig,
  ProviderConfig,
  ProxyConfig,
  ProxyType,
  TimeoutConfig,
} from './types';
import * as vscode from 'vscode';
import {
  Agent,
  Dispatcher,
  EnvHttpProxyAgent,
  fetch as undiciFetch,
} from 'undici';
import type { buildConnector } from 'undici';
import { SocksClient } from 'socks';
import type { SocksProxy } from 'socks';
import { t } from './i18n';
import { PLACEHOLDER_MODEL_ID } from './model-id-utils';

export {
  isPlaceholderModelId,
  PLACEHOLDER_MODEL_ID,
} from './model-id-utils';

export const DEFAULT_CONTEXT_CACHE_TTL_SECONDS = 300;
export const DEFAULT_CONTEXT_CACHE_TYPE: ContextCacheType = 'only-free';

/**
 * HTTP status codes that should trigger a retry.
 * - 408: Request Timeout
 * - 409: Request Lock
 * - 429: Too Many Requests (rate limiting)
 * - >=500: Internal Server Errors
 */
export const RETRYABLE_STATUS_CODES = [408, 409, 429] as const;

/**
 * Fetch mode for applying defaults.
 */
export type FetchMode = 'chat' | 'normal';

/**
 * Default retry configuration following industry standards.
 * Uses exponential backoff with jitter.
 */
export const DEFAULT_NORMAL_RETRY_CONFIG = {
  /** Maximum number of retry attempts */
  maxRetries: 3,
  /** Initial delay before first retry in milliseconds */
  initialDelayMs: 1000,
  /** Maximum delay cap in milliseconds */
  maxDelayMs: 5000,
  /** Backoff multiplier (delay doubles each attempt by default) */
  backoffMultiplier: 2,
  /** Jitter factor (0-1, adds randomness to prevent thundering herd) */
  jitterFactor: 0.1,
} as const;

export const DEFAULT_CHAT_RETRY_CONFIG = {
  /** Maximum number of retry attempts */
  maxRetries: 10,
  /** Initial delay before first retry in milliseconds */
  initialDelayMs: 1000,
  /** Maximum delay cap in milliseconds */
  maxDelayMs: 60000,
  /** Backoff multiplier (delay doubles each attempt by default) */
  backoffMultiplier: 2,
  /** Jitter factor (0-1, adds randomness to prevent thundering herd) */
  jitterFactor: 0.1,
} as const;

/**
 * Default timeout configuration for HTTP requests and SSE streams.
 */
export const DEFAULT_NORMAL_TIMEOUT_CONFIG = {
  /** Connection timeout in milliseconds */
  connection: 20_000,
  /** Response/idle timeout in milliseconds */
  response: 20_000,
} as const;

export const DEFAULT_CHAT_TIMEOUT_CONFIG = {
  /** Connection timeout in milliseconds */
  connection: 60_000,
  /** Response/idle timeout in milliseconds */
  response: 300_000,
} as const;

export function buildOpencodeUserAgent(): string {
  // Matches OpenCode's GitHub Copilot / Codex user-agent style.
  return 'opencode/1.1.28 ai-sdk/provider-utils/3.0.20 runtime/bun/1.3.5';
}

export interface RetryConfig {
  maxRetries?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  backoffMultiplier?: number;
  jitterFactor?: number;
  statusCodes?: number[];
}

export interface ResolvedChatTimeoutConfig {
  connection: number;
  response: number;
}

export interface ResolvedChatRetryConfig {
  maxRetries: number;
  initialDelayMs: number;
  maxDelayMs: number;
  backoffMultiplier: number;
  jitterFactor: number;
  statusCodes?: number[];
}

export interface ResolvedChatNetworkConfig {
  timeout: ResolvedChatTimeoutConfig;
  retry: ResolvedChatRetryConfig;
  proxy?: ProxyConfig;
}

const MAX_SAFE_TIMEOUT_MS = 0x7fffffff;

export interface ChatNetworkOverrides {
  timeout?: TimeoutConfig;
  retry?: RetryConfig;
  proxy?: ProxyConfig;
}

const CHAT_NETWORK_CONFIG_NAMESPACE = 'unifyChatProvider';

function readFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined;
}

function readNonNegativeInteger(value: unknown): number | undefined {
  const n = readFiniteNumber(value);
  if (n === undefined || !Number.isInteger(n) || n < 0) {
    return undefined;
  }
  return n;
}

function readPositiveInteger(value: unknown): number | undefined {
  const n = readFiniteNumber(value);
  if (n === undefined || !Number.isInteger(n) || n <= 0) {
    return undefined;
  }
  return n;
}

export function resolveContextCacheConfig(
  raw: ContextCacheConfig | undefined,
): { type: ContextCacheType; ttlSeconds: number } {
  const type =
    raw?.type === 'only-free' || raw?.type === 'allow-paid'
      ? raw.type
      : DEFAULT_CONTEXT_CACHE_TYPE;

  const ttlSeconds =
    readPositiveInteger(raw?.ttl) ?? DEFAULT_CONTEXT_CACHE_TTL_SECONDS;

  return { type, ttlSeconds };
}

function readBackoffMultiplier(value: unknown): number | undefined {
  const n = readFiniteNumber(value);
  if (n === undefined || n < 1) {
    return undefined;
  }
  return n;
}

function readJitterFactor(value: unknown): number | undefined {
  const n = readFiniteNumber(value);
  if (n === undefined || n < 0 || n > 1) {
    return undefined;
  }
  return n;
}

function readStatusCodes(value: unknown): number[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  return value.filter(
    (item): item is number =>
      typeof item === 'number' && Number.isFinite(item),
  );
}

function applyTimeoutOverrides(
  target: ResolvedChatTimeoutConfig,
  raw: unknown,
): void {
  if (!isRecord(raw)) return;

  const connection = readPositiveInteger(raw['connection']);
  if (connection !== undefined) target.connection = connection;

  const response = readPositiveInteger(raw['response']);
  if (response !== undefined) target.response = response;
}

function applyRetryOverrides(
  target: ResolvedChatRetryConfig,
  raw: unknown,
): void {
  if (!isRecord(raw)) return;

  const maxRetries = readNonNegativeInteger(raw['maxRetries']);
  if (maxRetries !== undefined) target.maxRetries = maxRetries;

  const initialDelayMs = readNonNegativeInteger(raw['initialDelayMs']);
  if (initialDelayMs !== undefined) target.initialDelayMs = initialDelayMs;

  const maxDelayMs = readPositiveInteger(raw['maxDelayMs']);
  if (maxDelayMs !== undefined) target.maxDelayMs = maxDelayMs;

  const backoffMultiplier = readBackoffMultiplier(raw['backoffMultiplier']);
  if (backoffMultiplier !== undefined) {
    target.backoffMultiplier = backoffMultiplier;
  }

  const jitterFactor = readJitterFactor(raw['jitterFactor']);
  if (jitterFactor !== undefined) target.jitterFactor = jitterFactor;
}

function applyGlobalRetryOverrides(
  target: ResolvedChatRetryConfig,
  raw: unknown,
): void {
  applyRetryOverrides(target, raw);
  if (!isRecord(raw)) return;

  const statusCodes = readStatusCodes(raw['statusCodes']);
  if (statusCodes !== undefined) target.statusCodes = statusCodes;
}

function readConfiguredChatNetworkOverrides(): {
  timeout?: unknown;
  retry?: unknown;
  proxy?: unknown;
} {
  const config = vscode.workspace.getConfiguration(
    CHAT_NETWORK_CONFIG_NAMESPACE,
  );
  const raw = config.get<unknown>('networkSettings');
  if (!isRecord(raw)) return {};

  const timeout = raw['timeout'];
  const retry = raw['retry'];
  const proxy = raw['proxy'];

  return { timeout, retry, proxy };
}

function readProxyType(value: unknown): ProxyType | undefined {
  return value === 'vscode' || value === 'direct' || value === 'custom'
    ? value
    : undefined;
}

function normalizeProxyUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }

  return getProxyProtocol(trimmed) === undefined ? undefined : trimmed;
}

function normalizeProxyConfig(value: unknown): ProxyConfig | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const out: ProxyConfig = {};
  const type = readProxyType(value['type']);
  if (type !== undefined) {
    out.type = type;
  }

  const url = normalizeProxyUrl(value['url']);
  if (url !== undefined) {
    out.url = url;
  }

  const authorization = value['authorization'];
  if (typeof authorization === 'string' && authorization.trim()) {
    out.authorization = authorization.trim();
  }

  const strictSSL = value['strictSSL'];
  if (typeof strictSSL === 'boolean') {
    out.strictSSL = strictSSL;
  }

  const noProxy = value['noProxy'];
  if (Array.isArray(noProxy)) {
    const entries = noProxy
      .filter((entry): entry is string => typeof entry === 'string')
      .map((entry) => entry.trim())
      .filter((entry) => entry !== '');
    if (entries.length > 0) {
      out.noProxy = entries;
    }
  }

  return Object.keys(out).length > 0 ? out : undefined;
}

function resolveChatProxyConfig(
  configuredProxy: unknown,
  overrideProxy: unknown,
): ProxyConfig | undefined {
  const override = normalizeProxyConfig(overrideProxy);
  if (override?.type && override.type !== 'vscode') {
    return override;
  }

  const configured = normalizeProxyConfig(configuredProxy);
  if (configured?.type && configured.type !== 'vscode') {
    return configured;
  }

  if (configured?.type === 'vscode') {
    return { type: 'vscode' };
  }

  return undefined;
}

/**
 * Resolve effective network settings for *chat requests*.
 *
 * Merge order:
 * 1) Built-in defaults (DEFAULT_CHAT_*)
 * 2) Application-scoped settings: `unifyChatProvider.networkSettings`
 * 3) Provider overrides (stored in the provider config)
 */
export function resolveChatNetwork(
  overrides: ChatNetworkOverrides | undefined,
): ResolvedChatNetworkConfig {
  const resolved: ResolvedChatNetworkConfig = {
    timeout: {
      connection: DEFAULT_CHAT_TIMEOUT_CONFIG.connection,
      response: DEFAULT_CHAT_TIMEOUT_CONFIG.response,
    },
    retry: {
      maxRetries: DEFAULT_CHAT_RETRY_CONFIG.maxRetries,
      initialDelayMs: DEFAULT_CHAT_RETRY_CONFIG.initialDelayMs,
      maxDelayMs: DEFAULT_CHAT_RETRY_CONFIG.maxDelayMs,
      backoffMultiplier: DEFAULT_CHAT_RETRY_CONFIG.backoffMultiplier,
      jitterFactor: DEFAULT_CHAT_RETRY_CONFIG.jitterFactor,
    },
  };

  const configured = readConfiguredChatNetworkOverrides();
  applyTimeoutOverrides(resolved.timeout, configured.timeout);
  applyGlobalRetryOverrides(resolved.retry, configured.retry);

  applyTimeoutOverrides(resolved.timeout, overrides?.timeout);
  applyRetryOverrides(resolved.retry, overrides?.retry);
  resolved.proxy = resolveChatProxyConfig(configured.proxy, overrides?.proxy);

  return resolved;
}

/**
 * Resolve the total request timeout passed to SDK clients that wrap fetch with
 * their own overall request timeout.
 *
 * Some SDKs apply an overall request timeout (10 minutes by default). For
 * streaming requests, this conflicts with our own timeout model:
 * - connection timeout is enforced in `createCustomFetch`
 * - response idle timeout is enforced by `withIdleTimeout`
 *
 * To avoid the SDK aborting healthy long-running streams or retry chains before
 * our own timeout logic fires, use the largest safe timer duration for
 * streaming requests and keep non-streaming requests aligned with the
 * configured response timeout.
 */
export function resolveSdkTotalTimeoutMs(
  timeout: Pick<ResolvedChatTimeoutConfig, 'connection' | 'response'>,
  stream: boolean,
): number {
  if (!stream) {
    return Math.min(timeout.response, MAX_SAFE_TIMEOUT_MS);
  }

  return MAX_SAFE_TIMEOUT_MS;
}

/**
 * Resolve the request timeout passed to the Google GenAI SDK.
 *
 * The SDK timeout is a total request timeout and is also sent as a server
 * timeout header. For streaming requests this conflicts with our own timeout
 * model:
 * - connection timeout is enforced by `fetchWithRetryUsingFetch`
 * - response idle timeout is enforced by `withIdleTimeout`
 *
 * Omit the SDK timeout for streaming requests so long-running healthy streams
 * are not aborted by the SDK before our idle timeout can make the decision.
 */
export function resolveGoogleSdkTimeoutMs(
  timeout: Pick<ResolvedChatTimeoutConfig, 'connection' | 'response'>,
  stream: boolean,
): number | undefined {
  if (stream) {
    return undefined;
  }

  return Math.min(timeout.response, MAX_SAFE_TIMEOUT_MS);
}

export interface FetchWithRetryOptions extends RequestInit {
  retryConfig?: RetryConfig;
  logger?: ProviderHttpLogger;
  /** Connection timeout in milliseconds. If not specified, uses DEFAULT_NORMAL_TIMEOUT_CONFIG.connection */
  connectionTimeoutMs?: number;
  proxy?: ProxyConfig;
}

export function headersInitToRecord(
  headers: HeadersInit | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers) {
    return out;
  }

  if (headers instanceof Headers) {
    headers.forEach((value, key) => {
      out[key] = value;
    });
    return out;
  }

  if (Array.isArray(headers)) {
    for (const [key, value] of headers) {
      out[String(key)] = String(value);
    }
    return out;
  }

  for (const [key, value] of Object.entries(headers)) {
    out[key] = String(value);
  }
  return out;
}

export function getHeaderValueIgnoreCase(
  headers: Record<string, string>,
  name: string,
): string | undefined {
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === target) {
      return value;
    }
  }
  return undefined;
}

function isUint8Array(value: unknown): value is Uint8Array {
  return value instanceof Uint8Array;
}

function isArrayBuffer(value: unknown): value is ArrayBuffer {
  return value instanceof ArrayBuffer;
}

function isUrlSearchParams(value: unknown): value is URLSearchParams {
  return value instanceof URLSearchParams;
}

function isBlob(value: unknown): value is Blob {
  return typeof Blob !== 'undefined' && value instanceof Blob;
}

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export function bodyInitToLoggableValue(
  body: RequestInit['body'] | undefined,
  headers: Record<string, string> | undefined,
): unknown {
  if (body == null) {
    return null;
  }

  if (typeof body === 'string') {
    const contentType =
      (headers && getHeaderValueIgnoreCase(headers, 'content-type')) || '';
    if (/\bjson\b/i.test(contentType)) {
      return tryParseJson(body);
    }
    return body;
  }

  if (isUrlSearchParams(body)) {
    return body.toString();
  }

  if (isUint8Array(body)) {
    return { type: 'uint8array', bytes: body.byteLength };
  }

  if (isArrayBuffer(body)) {
    return { type: 'arraybuffer', bytes: body.byteLength };
  }

  if (isBlob(body)) {
    return { type: 'blob', bytes: body.size, mimeType: body.type || undefined };
  }

  return { type: typeof body };
}

/**
 * Runs a callback when a response body is consumed, errors, or is cancelled.
 */
export function runWhenResponseBodySettles(
  response: Response,
  callback: () => void,
): Response {
  let settled = false;
  const settle = (): void => {
    if (settled) {
      return;
    }
    settled = true;
    callback();
  };

  if (!response.body) {
    settle();
    return response;
  }

  const reader = response.body.getReader();
  const wrappedBody = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const result = await reader.read();
        if (result.done) {
          settle();
          controller.close();
          return;
        }

        controller.enqueue(result.value);
      } catch (error) {
        settle();
        controller.error(error);
      }
    },
    async cancel(reason) {
      settle();
      await reader.cancel(reason);
    },
  });

  return new Response(wrappedBody, {
    headers: response.headers,
    status: response.status,
    statusText: response.statusText,
  });
}

/**
 * Check if an HTTP status code is retryable.
 */
export function isRetryableStatusCode(
  status: number,
  statusCodes?: readonly number[],
): boolean {
  if (statusCodes !== undefined) {
    return statusCodes.includes(status);
  }

  return (
    (RETRYABLE_STATUS_CODES as readonly number[]).includes(status) ||
    status >= 500
  );
}

/**
 * Delay execution for a specified number of milliseconds.
 */
function abortReasonToError(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  if (reason instanceof Error) {
    return reason;
  }
  if (typeof DOMException !== 'undefined') {
    return new DOMException(
      reason === undefined ? 'The operation was aborted.' : String(reason),
      'AbortError',
    );
  }
  return new Error(
    reason === undefined ? 'The operation was aborted.' : String(reason),
  );
}

export function isAbortError(error: unknown): boolean {
  const hasName = (value: unknown): value is { name: unknown } =>
    typeof value === 'object' && value !== null && 'name' in value;

  if (!error) {
    return false;
  }

  if (error instanceof DOMException) {
    return error.name === 'AbortError';
  }

  if (error instanceof Error) {
    return error.name === 'AbortError';
  }

  if (hasName(error)) {
    return error.name === 'AbortError';
  }

  return false;
}

function tryGetErrorCode(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }
  if (!('code' in value)) {
    return undefined;
  }
  const code = (value as { code: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

function hasErrorCause(value: unknown): value is { cause: unknown } {
  return typeof value === 'object' && value !== null && 'cause' in value;
}

function getErrorCode(error: unknown): string | undefined {
  const seen = new Set<unknown>();
  let current: unknown = error;

  while (current && !seen.has(current)) {
    seen.add(current);

    const code = tryGetErrorCode(current);
    if (code) {
      return code;
    }

    if (!hasErrorCause(current)) {
      break;
    }

    current = current.cause;
  }

  return undefined;
}

function tryGetErrorMessage(value: unknown): string | undefined {
  if (value instanceof Error) {
    return value.message;
  }
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }
  if (!('message' in value)) {
    return undefined;
  }
  const message = (value as { message: unknown }).message;
  return typeof message === 'string' ? message : undefined;
}

function hasRetryableNetworkErrorMessageText(message: string): boolean {
  const normalizedMessage = message.toLowerCase();
  return (
    normalizedMessage.includes('fetch failed') ||
    normalizedMessage.includes('network error') ||
    normalizedMessage.includes('connection timeout') ||
    normalizedMessage.includes('socket hang up') ||
    normalizedMessage.includes('other side closed')
  );
}

function hasRetryableNetworkErrorMessage(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;

  while (current && !seen.has(current)) {
    seen.add(current);

    const message = tryGetErrorMessage(current);
    if (message && hasRetryableNetworkErrorMessageText(message)) {
      return true;
    }

    if (!hasErrorCause(current)) {
      break;
    }

    current = current.cause;
  }

  return false;
}

const RETRYABLE_NETWORK_ERROR_CODES = new Set<string>([
  'ECONNRESET',
  'ETIMEDOUT',
  'ECONNREFUSED',
  'EAI_AGAIN',
  'ENOTFOUND',
  // undici / fetch (Node) internal error codes
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_SOCKET',
]);

const ABORT_LIKE_ERROR_CODES = new Set<string>([
  'ABORT_ERR',
  'ERR_ABORTED',
  'UND_ERR_ABORTED',
]);

const GENERIC_ABORT_MESSAGES = new Set<string>([
  'aborted',
  'request aborted.',
  'request was aborted.',
  'the operation was aborted.',
  'this operation was aborted',
]);

export function createTimeoutError(message: string): Error {
  const timeoutError = new Error(message);
  timeoutError.name = 'TimeoutError';
  return timeoutError;
}

export function isAbortLikeError(error: unknown): boolean {
  if (isAbortError(error)) {
    return true;
  }

  const code = getErrorCode(error);
  if (code && ABORT_LIKE_ERROR_CODES.has(code)) {
    return true;
  }

  if (!(error instanceof Error)) {
    return false;
  }

  const message = error.message.toLowerCase();
  return (
    message.includes('aborted') ||
    (error.name === 'TypeError' && message.includes('terminated'))
  );
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function getErrorCause(error: unknown): unknown {
  if (typeof error !== 'object' || error === null || !('cause' in error)) {
    return undefined;
  }
  return (error as { cause: unknown }).cause;
}

function isGenericAbortMessage(error: Error): boolean {
  return GENERIC_ABORT_MESSAGES.has(error.message.trim().toLowerCase());
}

function shouldUnwrapMaskedError(error: Error): boolean {
  const message = error.message.trim().toLowerCase();
  return (
    isAbortLikeError(error) ||
    (error.name === 'TypeError' && message.includes('terminated'))
  );
}

function createErrorWithCause(message: string, cause: unknown): Error {
  const wrapped = new Error(message);
  if (cause !== undefined) {
    Object.defineProperty(wrapped, 'cause', {
      configurable: true,
      enumerable: false,
      value: cause,
      writable: true,
    });
  }
  return wrapped;
}

export function resolveMeaningfulError(error: unknown): Error {
  const original = toError(error);
  let resolved = original;
  const seen = new Set<unknown>([error, original]);

  while (shouldUnwrapMaskedError(resolved)) {
    const cause = getErrorCause(resolved);
    if (cause === undefined || seen.has(cause)) {
      break;
    }

    const next = toError(cause);
    if (
      next === resolved ||
      (next.name === resolved.name && next.message === resolved.message)
    ) {
      break;
    }

    seen.add(cause);
    resolved = next;
  }

  if (isAbortLikeError(resolved) && isGenericAbortMessage(resolved)) {
    return createErrorWithCause(
      t(
        'The request was aborted by the provider SDK or transport layer before a specific cause could be recovered. This was not triggered by the user and may indicate a timeout or disconnected stream.',
      ),
      original,
    );
  }

  return resolved;
}

function throwIfAborted(signal: AbortSignal | null | undefined): void {
  if (!signal) {
    return;
  }
  if (signal.aborted) {
    throw abortReasonToError(signal);
  }
}

export function delay(
  ms: number,
  abortSignal?: AbortSignal | null,
): Promise<void> {
  if (ms <= 0) {
    return Promise.resolve();
  }

  if (!abortSignal) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  if (abortSignal.aborted) {
    return Promise.reject(abortReasonToError(abortSignal));
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;

    const cleanup = (): void => {
      if (settled) return;
      settled = true;

      if (timeoutId !== undefined) {
        clearTimeout(timeoutId);
      }
      abortSignal.removeEventListener('abort', onAbort);
    };

    const onAbort = (): void => {
      cleanup();
      reject(abortReasonToError(abortSignal));
    };

    abortSignal.addEventListener('abort', onAbort, { once: true });
    timeoutId = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
  });
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Calculate retry delay using exponential backoff with jitter.
 *
 * Formula: min(maxDelay, initialDelay * multiplier^attempt) * (1 ± jitter)
 *
 * @param attempt Current attempt number (0-based)
 * @param config Retry configuration
 * @returns Delay in milliseconds
 */
export function calculateBackoffDelay(
  attempt: number,
  config: {
    initialDelayMs: number;
    maxDelayMs: number;
    backoffMultiplier: number;
    jitterFactor: number;
  },
): number {
  // Calculate base exponential delay
  const exponentialDelay =
    config.initialDelayMs * Math.pow(config.backoffMultiplier, attempt);

  // Cap at maximum delay
  const cappedDelay = Math.min(exponentialDelay, config.maxDelayMs);

  // Add jitter: random value between -jitter% and +jitter%
  const jitterRange = cappedDelay * config.jitterFactor;
  const jitter = (Math.random() * 2 - 1) * jitterRange;

  return Math.round(cappedDelay + jitter);
}

/**
 * Build a human-readable detail string for network-level errors.
 * Used when logging retries for errors that don't have an HTTP status code.
 */
export function describeNetworkError(error: unknown): string {
  const code = getErrorCode(error);
  const message = error instanceof Error ? error.message : String(error);
  if (code) {
    return `${code}: ${message}`;
  }
  return message;
}

export function isRetryableNetworkError(
  error: unknown,
  options: { timedOut?: boolean } = {},
): boolean {
  if (!error) {
    return false;
  }

  // Retry on our own connection-timeout aborts (may surface as AbortError).
  if (options.timedOut && isAbortError(error)) {
    return true;
  }

  const code = getErrorCode(error);
  if (code && RETRYABLE_NETWORK_ERROR_CODES.has(code)) {
    return true;
  }

  return hasRetryableNetworkErrorMessage(error);
}

/**
 * Fetch with automatic retry for transient HTTP errors.
 *
 * Uses exponential backoff with jitter for the following status codes:
 * 429 (Too Many Requests), 500 (Internal Server Error),
 * 502 (Bad Gateway), 503 (Service Unavailable), 504 (Gateway Timeout)
 *
 * Only logs retry attempts - does not return any text to VSCode for display.
 */
export async function fetchWithRetry(
  input: RequestInfo | URL,
  options: FetchWithRetryOptions = {},
): Promise<Response> {
  const { proxy, ...retryOptions } = options;
  return fetchWithRetryUsingFetch(
    (fetchInput, fetchInit) => fetchWithUndici(fetchInput, fetchInit, proxy),
    input,
    { ...retryOptions, proxy: { type: 'direct' } },
  );
}

type RequestInitWithDispatcher = RequestInit & { dispatcher?: Dispatcher };

type UndiciFetchInit = Parameters<typeof undiciFetch>[1];
type UndiciFetchResponse = Awaited<ReturnType<typeof undiciFetch>>;
type HttpProxySupportMode = 'off' | 'on' | 'fallback' | 'override';
type TlsCa = ConnectionOptions['ca'];
type EnvProxyDispatcherInit = NonNullable<
  ConstructorParameters<typeof EnvHttpProxyAgent>[0]
>;
type EnvProxyTlsOptions = NonNullable<EnvProxyDispatcherInit['requestTls']>;

interface ResolvedHttpProxySettings {
  proxy?: string;
  proxyAuthorization?: string;
  proxyStrictSSL: boolean;
  proxySupport: HttpProxySupportMode;
  noProxy: string[];
}

interface ResolvedUndiciDispatcherOptions {
  allowH2?: boolean;
  bodyTimeout?: number;
  connectTimeout?: number;
  headersTimeout?: number;
  proxyCA?: TlsCa;
  requestCA?: TlsCa;
  socketPath?: string;
}

interface UndiciAgentLikeOptions {
  allowH2?: unknown;
  bodyTimeout?: unknown;
  connect?: unknown;
  connectTimeout?: unknown;
  headersTimeout?: unknown;
}

interface UndiciProxyAgentLikeOptions {
  allowH2?: unknown;
  bodyTimeout?: unknown;
  connectTimeout?: unknown;
  headersTimeout?: unknown;
  proxyTls?: unknown;
  requestTls?: unknown;
}

type SocksProxyProtocol =
  | 'socks:'
  | 'socks4:'
  | 'socks4a:'
  | 'socks5:'
  | 'socks5h:';
type ProxyProtocol = 'http:' | 'https:' | SocksProxyProtocol;
type SocksClientEstablishedEvent = Awaited<
  ReturnType<typeof SocksClient.createConnection>
>;

interface ParsedNoProxyEntry {
  hostname: string;
  port: number;
}

interface ParsedSocksProxy {
  proxy: SocksProxy;
  url: string;
}

interface SocksProxyDispatcherOptions {
  agentOptions: Agent.Options;
  connect: buildConnector.connector;
  noProxy: string;
}

const defaultDispatcherCache = new Map<string, Dispatcher>();
const proxiedDispatcherCache = new WeakMap<
  Dispatcher,
  Map<string, Dispatcher>
>();

class SocksProxyDispatcher extends Dispatcher {
  private readonly directAgent: Agent;
  private readonly noProxyEntries: ParsedNoProxyEntry[];
  private readonly noProxyValue: string;
  private readonly socksAgent: Agent;

  constructor(options: SocksProxyDispatcherOptions) {
    super();
    this.noProxyValue = options.noProxy;
    this.noProxyEntries = parseNoProxyEntries(options.noProxy);
    this.directAgent = new Agent(options.agentOptions);
    this.socksAgent = new Agent({
      ...options.agentOptions,
      connect: options.connect,
    });
  }

  override dispatch(
    options: Dispatcher.DispatchOptions,
    handler: Dispatcher.DispatchHandler,
  ): boolean {
    const origin = options.origin;
    if (origin === undefined) {
      return this.socksAgent.dispatch(options, handler);
    }

    const url = new URL(origin);
    const dispatcher = shouldProxyUrl(url, this.noProxyValue, this.noProxyEntries)
      ? this.socksAgent
      : this.directAgent;
    return dispatcher.dispatch(options, handler);
  }

  override close(callback: () => void): void;
  override close(): Promise<void>;
  override close(callback?: () => void): Promise<void> | void {
    const closePromise = Promise.all([
      this.directAgent.close(),
      this.socksAgent.close(),
    ]).then(() => undefined);

    if (callback !== undefined) {
      closePromise.then(callback, callback);
      return;
    }

    return closePromise;
  }

  override destroy(callback: () => void): void;
  override destroy(error: Error | null, callback: () => void): void;
  override destroy(error?: Error | null): Promise<void>;
  override destroy(
    errorOrCallback?: Error | null | (() => void),
    callback?: () => void,
  ): Promise<void> | void {
    const error =
      typeof errorOrCallback === 'function' ? undefined : errorOrCallback;
    const closePromise = Promise.all([
      error === undefined
        ? this.directAgent.destroy()
        : this.directAgent.destroy(error),
      error === undefined
        ? this.socksAgent.destroy()
        : this.socksAgent.destroy(error),
    ]).then(() => undefined);

    if (typeof errorOrCallback === 'function') {
      closePromise.then(errorOrCallback, errorOrCallback);
      return;
    }

    if (callback !== undefined) {
      closePromise.then(callback, callback);
      return;
    }

    return closePromise;
  }
}

function readConfiguredHttpProxySupport(value: unknown): HttpProxySupportMode {
  switch (value) {
    case 'off':
    case 'on':
    case 'fallback':
    case 'override':
      return value;
    default:
      return 'override';
  }
}

function normalizeProxyString(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

function normalizeNoProxyList(value: readonly string[] | undefined): string[] {
  if (!value) {
    return [];
  }

  return value.map((entry) => entry.trim()).filter((entry) => entry !== '');
}

function getConfiguredHttpProxySettings(
  proxyConfig: ProxyConfig | undefined,
): ResolvedHttpProxySettings {
  const config = vscode.workspace.getConfiguration('http');
  const vscodeProxy = normalizeProxyString(config.get<string>('proxy'));
  const vscodeProxyAuthorization = normalizeProxyString(
    config.get<string | null>('proxyAuthorization') ?? undefined,
  );
  const vscodeProxyStrictSSL = config.get<boolean>('proxyStrictSSL') ?? true;
  const vscodeNoProxy = normalizeNoProxyList(config.get<string[]>('noProxy'));
  const proxySupport = readConfiguredHttpProxySupport(
    config.get<unknown>('proxySupport'),
  );

  if (proxyConfig?.type === 'custom') {
    return {
      proxy: normalizeProxyString(proxyConfig.url),
      proxyAuthorization: normalizeProxyString(proxyConfig.authorization),
      proxyStrictSSL: proxyConfig.strictSSL ?? vscodeProxyStrictSSL,
      proxySupport,
      noProxy: proxyConfig.noProxy
        ? normalizeNoProxyList(proxyConfig.noProxy)
        : vscodeNoProxy,
    };
  }

  return {
    proxy: vscodeProxy,
    proxyAuthorization: vscodeProxyAuthorization,
    proxyStrictSSL: vscodeProxyStrictSSL,
    proxySupport,
    noProxy: vscodeNoProxy,
  };
}

function getObjectSymbolValue(target: object, description: string): unknown {
  const symbol = Object.getOwnPropertySymbols(target).find(
    (candidate) => candidate.description === description,
  );
  return symbol === undefined ? undefined : Reflect.get(target, symbol);
}

function isTlsCa(value: unknown): value is TlsCa {
  return (
    typeof value === 'string' ||
    isUint8Array(value) ||
    (Array.isArray(value) &&
      value.every((entry) => typeof entry === 'string' || isUint8Array(entry)))
  );
}

function readTlsCa(value: unknown): TlsCa | undefined {
  return isTlsCa(value) ? value : undefined;
}

function readDispatcherConnectOptions(value: unknown): {
  requestCA?: TlsCa;
  socketPath?: string;
} {
  if (!isRecord(value)) {
    return {};
  }

  const requestCA = readTlsCa(value['ca']);
  const socketPathRaw = value['socketPath'];
  const socketPath =
    typeof socketPathRaw === 'string' && socketPathRaw.trim() !== ''
      ? socketPathRaw
      : undefined;

  return { requestCA, socketPath };
}

function readDispatcherTlsOptions(value: unknown): { ca?: TlsCa } {
  if (!isRecord(value)) {
    return {};
  }

  const ca = readTlsCa(value['ca']);
  return { ca };
}

function getDispatcherOptions(
  dispatcher: Dispatcher,
): ResolvedUndiciDispatcherOptions {
  const out: ResolvedUndiciDispatcherOptions = {};

  const rawAgentOptions = getObjectSymbolValue(dispatcher, 'options');
  if (isRecord(rawAgentOptions)) {
    const agentOptions = rawAgentOptions as UndiciAgentLikeOptions;
    const allowH2 = agentOptions.allowH2;
    if (typeof allowH2 === 'boolean') {
      out.allowH2 = allowH2;
    }

    const connectTimeout = readPositiveInteger(agentOptions.connectTimeout);
    if (connectTimeout !== undefined) {
      out.connectTimeout = connectTimeout;
    }

    const headersTimeout = readPositiveInteger(agentOptions.headersTimeout);
    if (headersTimeout !== undefined) {
      out.headersTimeout = headersTimeout;
    }

    const bodyTimeout = readPositiveInteger(agentOptions.bodyTimeout);
    if (bodyTimeout !== undefined) {
      out.bodyTimeout = bodyTimeout;
    }

    const connectOptions = readDispatcherConnectOptions(agentOptions.connect);
    if (connectOptions.requestCA !== undefined) {
      out.requestCA = connectOptions.requestCA;
    }
    if (connectOptions.socketPath !== undefined) {
      out.socketPath = connectOptions.socketPath;
    }
  }

  const rawProxyAgent = getObjectSymbolValue(dispatcher, 'proxy agent');
  if (typeof rawProxyAgent === 'object' && rawProxyAgent !== null) {
    const rawProxyOptions = getObjectSymbolValue(rawProxyAgent, 'options');
    if (isRecord(rawProxyOptions)) {
      const proxyOptions = rawProxyOptions as UndiciProxyAgentLikeOptions;
      const allowH2 = proxyOptions.allowH2;
      if (typeof allowH2 === 'boolean') {
        out.allowH2 = allowH2;
      }

      const connectTimeout = readPositiveInteger(proxyOptions.connectTimeout);
      if (connectTimeout !== undefined) {
        out.connectTimeout = connectTimeout;
      }

      const headersTimeout = readPositiveInteger(proxyOptions.headersTimeout);
      if (headersTimeout !== undefined) {
        out.headersTimeout = headersTimeout;
      }

      const bodyTimeout = readPositiveInteger(proxyOptions.bodyTimeout);
      if (bodyTimeout !== undefined) {
        out.bodyTimeout = bodyTimeout;
      }

      const requestTls = readDispatcherTlsOptions(proxyOptions.requestTls);
      if (requestTls.ca !== undefined) {
        out.requestCA = requestTls.ca;
      }

      const proxyTls = readDispatcherTlsOptions(proxyOptions.proxyTls);
      if (proxyTls.ca !== undefined) {
        out.proxyCA = proxyTls.ca;
      }
    }
  }

  return out;
}

function setIfDefined<K extends keyof EnvProxyDispatcherInit>(
  target: EnvProxyDispatcherInit,
  key: K,
  value: EnvProxyDispatcherInit[K] | undefined,
): void {
  if (value !== undefined) {
    target[key] = value;
  }
}

function hasOwnProperties(value: object): boolean {
  return Object.keys(value).length > 0;
}

const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
const DEFAULT_PROXY_PORTS: Record<string, number> = {
  'http:': 80,
  'https:': 443,
};

function getNoProxyEnv(): string {
  return process.env.no_proxy ?? process.env.NO_PROXY ?? '';
}

function getNoProxyValue(settings: ResolvedHttpProxySettings): string {
  const configuredNoProxy = settings.noProxy.join(',');
  return configuredNoProxy === '' ? getNoProxyEnv() : configuredNoProxy;
}

function parseNoProxyEntries(value: string): ParsedNoProxyEntry[] {
  const entries = value.split(/[,\s]/);
  const parsedEntries: ParsedNoProxyEntry[] = [];

  for (const entry of entries) {
    if (!entry) {
      continue;
    }

    const parsed = /^(.+):(\d+)$/.exec(entry);
    parsedEntries.push({
      hostname: (parsed ? parsed[1] : entry)
        .replace(/^\*?\./, '')
        .toLowerCase(),
      port: parsed ? Number.parseInt(parsed[2], 10) : 0,
    });
  }

  return parsedEntries;
}

function getNoProxyHostname(url: URL): string {
  return url.host.replace(/:\d*$/, '').toLowerCase();
}

function getUrlPort(url: URL): number {
  return Number.parseInt(url.port, 10) || DEFAULT_PROXY_PORTS[url.protocol] || 0;
}

function shouldProxyUrl(
  url: URL,
  noProxyValue: string,
  noProxyEntries: readonly ParsedNoProxyEntry[],
): boolean {
  if (noProxyEntries.length === 0) {
    return true;
  }
  if (noProxyValue === '*') {
    return false;
  }

  const hostname = getNoProxyHostname(url);
  const port = getUrlPort(url);

  for (const entry of noProxyEntries) {
    if (entry.port !== 0 && entry.port !== port) {
      continue;
    }
    if (hostname === entry.hostname) {
      return false;
    }
    if (hostname.slice(-(entry.hostname.length + 1)) === `.${entry.hostname}`) {
      return false;
    }
  }

  return true;
}

function getProxyProtocol(proxy: string | undefined): ProxyProtocol | undefined {
  if (proxy === undefined) {
    return undefined;
  }

  try {
    const protocol = new URL(proxy).protocol.toLowerCase();
    if (
      protocol === 'http:' ||
      protocol === 'https:' ||
      protocol === 'socks:' ||
      protocol === 'socks4:' ||
      protocol === 'socks4a:' ||
      protocol === 'socks5:' ||
      protocol === 'socks5h:'
    ) {
      return protocol;
    }
  } catch {
    return undefined;
  }

  return undefined;
}

function isSocksProxyProtocol(
  protocol: ProxyProtocol | undefined,
): protocol is SocksProxyProtocol {
  return (
    protocol === 'socks:' ||
    protocol === 'socks4:' ||
    protocol === 'socks4a:' ||
    protocol === 'socks5:' ||
    protocol === 'socks5h:'
  );
}

function normalizeSocketHost(host: string): string {
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
}

function decodeProxyUrlComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function readProxyAuthorizationCredentials(
  value: string | undefined,
): { userId: string; password?: string } | undefined {
  if (value === undefined) {
    return undefined;
  }

  const basic = /^basic\s+(.+)$/i.exec(value);
  const decoded = basic
    ? Buffer.from(basic[1], 'base64').toString('utf8')
    : value;
  const separator = decoded.indexOf(':');
  if (separator <= 0) {
    return undefined;
  }

  return {
    userId: decoded.slice(0, separator),
    password: decoded.slice(separator + 1),
  };
}

function getSocksProxyType(protocol: SocksProxyProtocol): 4 | 5 {
  return protocol === 'socks4:' || protocol === 'socks4a:' ? 4 : 5;
}

function readSocksProxy(
  proxy: string,
  protocol: SocksProxyProtocol,
  proxyAuthorization: string | undefined,
): ParsedSocksProxy {
  const url = new URL(proxy);
  const host = normalizeSocketHost(url.hostname);
  const port = url.port === '' ? 1080 : Number.parseInt(url.port, 10);
  const socksProxy: SocksProxy = {
    port,
    type: getSocksProxyType(protocol),
  };

  if (isIP(host) === 0) {
    socksProxy.host = host;
  } else {
    socksProxy.ipaddress = host;
  }

  const urlUserId = decodeProxyUrlComponent(url.username);
  const urlPassword = decodeProxyUrlComponent(url.password);
  if (urlUserId !== '') {
    socksProxy.userId = urlUserId;
    socksProxy.password = urlPassword;
  } else {
    const credentials = readProxyAuthorizationCredentials(proxyAuthorization);
    if (credentials !== undefined) {
      socksProxy.userId = credentials.userId;
      socksProxy.password = credentials.password;
    }
  }

  return {
    proxy: socksProxy,
    url: proxy,
  };
}

function createAgentOptions(
  base: ResolvedUndiciDispatcherOptions,
  settings: ResolvedHttpProxySettings,
): Agent.Options {
  const options: Agent.Options = {};

  if (base.allowH2 !== undefined) {
    options.allowH2 = base.allowH2;
  }
  if (base.bodyTimeout !== undefined) {
    options.bodyTimeout = base.bodyTimeout;
  }
  if (base.connectTimeout !== undefined) {
    options.connectTimeout = base.connectTimeout;
  }
  if (base.headersTimeout !== undefined) {
    options.headersTimeout = base.headersTimeout;
  }

  const connect: ConnectionOptions = {};
  if (base.requestCA !== undefined) {
    connect.ca = base.requestCA;
  }
  if (!settings.proxyStrictSSL) {
    connect.rejectUnauthorized = false;
  }
  if (hasOwnProperties(connect)) {
    options.connect = connect;
  }

  return options;
}

function getDestinationPort(options: buildConnector.Options): number {
  if (options.port !== '') {
    return Number.parseInt(options.port, 10);
  }
  return options.protocol === 'https:' ? 443 : 80;
}

function getTlsServerName(options: buildConnector.Options): string | undefined {
  const candidate = options.servername ?? normalizeSocketHost(options.hostname);
  return isIP(candidate) === 0 ? candidate : undefined;
}

function createSocksTimeoutError(
  proxyUrl: string,
  options: buildConnector.Options,
  timeoutMs: number,
): Error {
  const error = new Error(
    `SOCKS proxy connection timeout after ${timeoutMs}ms: ${proxyUrl} -> ${options.hostname}:${getDestinationPort(options)}`,
  );
  Object.defineProperty(error, 'code', {
    configurable: true,
    enumerable: false,
    value: 'ETIMEDOUT',
    writable: true,
  });
  return error;
}

function configureConnectedSocket(socket: Socket | tls.TLSSocket): void {
  socket.setNoDelay(true);
  socket.setKeepAlive(true, 60_000);
}

function createTlsSocketOverSocks(
  socket: Socket,
  options: buildConnector.Options,
  base: ResolvedUndiciDispatcherOptions,
  settings: ResolvedHttpProxySettings,
): Promise<tls.TLSSocket> {
  return new Promise((resolve, reject) => {
    const tlsOptions: ConnectionOptions = {
      ALPNProtocols: base.allowH2 ? ['http/1.1', 'h2'] : ['http/1.1'],
      ca: base.requestCA,
      servername: getTlsServerName(options),
      socket,
    };
    if (!settings.proxyStrictSSL) {
      tlsOptions.rejectUnauthorized = false;
    }

    const tlsSocket = tls.connect(tlsOptions);
    const cleanup = (): void => {
      tlsSocket.removeListener('secureConnect', onSecureConnect);
      tlsSocket.removeListener('error', onError);
    };
    const onSecureConnect = (): void => {
      cleanup();
      configureConnectedSocket(tlsSocket);
      resolve(tlsSocket);
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };

    tlsSocket.once('secureConnect', onSecureConnect);
    tlsSocket.once('error', onError);
  });
}

function createSocksConnector(
  socksProxy: ParsedSocksProxy,
  base: ResolvedUndiciDispatcherOptions,
  settings: ResolvedHttpProxySettings,
): buildConnector.connector {
  return (options, callback): void => {
    const timeoutMs = base.connectTimeout ?? DEFAULT_CONNECT_TIMEOUT_MS;
    let settled = false;
    let activeSocket: Socket | tls.TLSSocket | undefined;

    const settle = (
      error: Error | null,
      socket: Socket | tls.TLSSocket | null,
    ): void => {
      if (settled) {
        socket?.destroy();
        return;
      }

      settled = true;
      clearTimeout(timeoutId);
      if (error !== null) {
        callback(error, null);
        return;
      }
      if (socket === null) {
        callback(
          new Error('SOCKS proxy connection did not return a socket'),
          null,
        );
        return;
      }
      callback(null, socket);
    };

    const timeoutId = setTimeout(() => {
      activeSocket?.destroy();
      settle(createSocksTimeoutError(socksProxy.url, options, timeoutMs), null);
    }, timeoutMs);

    const destination = {
      host: normalizeSocketHost(options.hostname),
      port: getDestinationPort(options),
    };

    const proxyHost = socksProxy.proxy.host ?? socksProxy.proxy.ipaddress;
    const socketOptions: SocketConnectOpts | undefined =
      options.localAddress == null || proxyHost === undefined
        ? undefined
        : {
            host: proxyHost,
            localAddress: options.localAddress,
            port: socksProxy.proxy.port,
          };

    void SocksClient.createConnection({
      command: 'connect',
      destination,
      proxy: socksProxy.proxy,
      set_tcp_nodelay: true,
      socket_options: socketOptions,
      timeout: timeoutMs,
    }).then(
      (event: SocksClientEstablishedEvent) => {
        activeSocket = event.socket;
        configureConnectedSocket(event.socket);

        if (options.protocol !== 'https:') {
          settle(null, event.socket);
          return;
        }

        void createTlsSocketOverSocks(
          event.socket,
          options,
          base,
          settings,
        ).then(
          (tlsSocket) => {
            activeSocket = tlsSocket;
            settle(null, tlsSocket);
          },
          (error: unknown) => {
            settle(toError(error), null);
          },
        );
      },
      (error: unknown) => {
        settle(toError(error), null);
      },
    );
  };
}

function createSocksProxyDispatcher(
  base: ResolvedUndiciDispatcherOptions,
  settings: ResolvedHttpProxySettings,
  protocol: SocksProxyProtocol,
): Dispatcher {
  const proxy = settings.proxy;
  if (proxy === undefined) {
    return new Agent(createAgentOptions(base, settings));
  }

  const agentOptions = createAgentOptions(base, settings);
  const socksProxy = readSocksProxy(
    proxy,
    protocol,
    settings.proxyAuthorization,
  );

  return new SocksProxyDispatcher({
    agentOptions,
    connect: createSocksConnector(socksProxy, base, settings),
    noProxy: getNoProxyValue(settings),
  });
}

function createEnvProxyDispatcher(
  originalDispatcher: Dispatcher | undefined,
  settings: ResolvedHttpProxySettings,
): Dispatcher {
  const base =
    originalDispatcher === undefined
      ? {}
      : getDispatcherOptions(originalDispatcher);

  if (originalDispatcher !== undefined && base.socketPath !== undefined) {
    return originalDispatcher;
  }

  const proxyProtocol = getProxyProtocol(settings.proxy);
  const isSocksProxy = isSocksProxyProtocol(proxyProtocol);
  const noProxy = settings.noProxy.join(',');

  const signature = JSON.stringify({
    allowH2: base.allowH2,
    bodyTimeout: base.bodyTimeout,
    connectTimeout: base.connectTimeout,
    envHttpProxy: process.env.HTTP_PROXY ?? process.env.http_proxy ?? '',
    envHttpsProxy:
      process.env.HTTPS_PROXY ??
      process.env.https_proxy ??
      process.env.HTTP_PROXY ??
      process.env.http_proxy ??
      '',
    envNoProxy: process.env.NO_PROXY ?? process.env.no_proxy ?? '',
    headersTimeout: base.headersTimeout,
    noProxy: isSocksProxy ? getNoProxyValue(settings) : settings.noProxy,
    proxy: settings.proxy ?? '',
    proxyAuthorization: settings.proxyAuthorization ?? '',
    proxyCA: base.proxyCA ? 'custom' : '',
    proxyProtocol: proxyProtocol ?? '',
    proxyStrictSSL: settings.proxyStrictSSL,
    requestCA: base.requestCA ? 'custom' : '',
  });

  const dispatcherCache =
    originalDispatcher === undefined
      ? defaultDispatcherCache
      : (proxiedDispatcherCache.get(originalDispatcher) ??
        (() => {
          const cache = new Map<string, Dispatcher>();
          proxiedDispatcherCache.set(originalDispatcher, cache);
          return cache;
        })());

  const cached = dispatcherCache.get(signature);
  if (cached) {
    return cached;
  }

  if (isSocksProxy) {
    const dispatcher = createSocksProxyDispatcher(base, settings, proxyProtocol);
    dispatcherCache.set(signature, dispatcher);
    return dispatcher;
  }

  const init: EnvProxyDispatcherInit = {};

  setIfDefined(init, 'allowH2', base.allowH2);
  setIfDefined(init, 'bodyTimeout', base.bodyTimeout);
  setIfDefined(init, 'connectTimeout', base.connectTimeout);
  setIfDefined(init, 'headersTimeout', base.headersTimeout);
  setIfDefined(init, 'httpProxy', settings.proxy);
  setIfDefined(init, 'httpsProxy', settings.proxy);
  setIfDefined(init, 'token', settings.proxyAuthorization);

  if (noProxy !== '') {
    init.noProxy = noProxy;
  }

  const connect: ConnectionOptions = {};
  if (base.requestCA !== undefined) {
    connect.ca = base.requestCA;
  }
  if (!settings.proxyStrictSSL) {
    connect.rejectUnauthorized = false;
  }
  if (hasOwnProperties(connect)) {
    init.connect = connect;
  }

  const requestTls: EnvProxyTlsOptions = {};
  if (base.requestCA !== undefined) {
    requestTls.ca = base.requestCA;
  }
  if (!settings.proxyStrictSSL) {
    requestTls.rejectUnauthorized = false;
  }
  if (hasOwnProperties(requestTls)) {
    init.requestTls = requestTls;
  }

  const proxyTls: EnvProxyTlsOptions = {};
  const proxyCA = base.proxyCA ?? base.requestCA;
  if (proxyCA !== undefined) {
    proxyTls.ca = proxyCA;
  }
  if (!settings.proxyStrictSSL) {
    proxyTls.rejectUnauthorized = false;
  }
  if (hasOwnProperties(proxyTls)) {
    init.proxyTls = proxyTls;
  }

  const dispatcher = new EnvHttpProxyAgent(init);
  dispatcherCache.set(signature, dispatcher);
  return dispatcher;
}

function getUndiciInitWithProxySupport(
  init?: RequestInitWithDispatcher,
  proxyConfig?: ProxyConfig,
): RequestInitWithDispatcher | undefined {
  const settings = getConfiguredHttpProxySettings(proxyConfig);
  if (settings.proxySupport === 'off') {
    return init;
  }
  if (proxyConfig?.type === 'direct') {
    return init;
  }
  if (proxyConfig?.type === 'custom' && settings.proxy === undefined) {
    return init;
  }

  // The dispatcher in this extension is used for timeout behavior, not as an
  // opt-out from VS Code proxy settings. Keep proxy support enabled unless the
  // user explicitly disables it with `http.proxySupport: off`.
  const dispatcher = createEnvProxyDispatcher(init?.dispatcher, settings);
  if (dispatcher === init?.dispatcher) {
    return init;
  }

  return {
    ...init,
    dispatcher,
  };
}

function supportsUndiciRequestBody(
  body: RequestInit['body'] | null | undefined,
): boolean {
  return (
    body == null ||
    typeof body === 'string' ||
    isUrlSearchParams(body) ||
    isUint8Array(body) ||
    isArrayBuffer(body) ||
    ArrayBuffer.isView(body)
  );
}

function toUndiciRequestBody(
  body: RequestInit['body'] | null | undefined,
): NonNullable<UndiciFetchInit>['body'] | undefined {
  if (body == null) {
    return undefined;
  }

  if (
    typeof body === 'string' ||
    isUrlSearchParams(body) ||
    isUint8Array(body) ||
    isArrayBuffer(body)
  ) {
    return body;
  }

  if (ArrayBuffer.isView(body)) {
    return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
  }

  return undefined;
}

function toUndiciRequestInit(
  init?: RequestInitWithDispatcher,
): UndiciFetchInit | undefined {
  if (!init) {
    return undefined;
  }

  const next: NonNullable<UndiciFetchInit> = {};

  if (init.body !== undefined && init.body !== null) {
    next.body = toUndiciRequestBody(init.body);
  }
  if (init.cache !== undefined) {
    next.cache = init.cache;
  }
  if (init.credentials !== undefined) {
    next.credentials = init.credentials;
  }
  if (init.dispatcher !== undefined) {
    next.dispatcher = init.dispatcher;
  }
  if (init.headers !== undefined) {
    next.headers = headersInitToRecord(init.headers);
  }
  if (init.integrity !== undefined) {
    next.integrity = init.integrity;
  }
  if (init.keepalive !== undefined) {
    next.keepalive = init.keepalive;
  }
  if (init.method !== undefined) {
    next.method = init.method;
  }
  if (init.mode !== undefined) {
    next.mode = init.mode;
  }
  if (init.redirect !== undefined) {
    next.redirect = init.redirect;
  }
  if (init.referrer !== undefined) {
    next.referrer = init.referrer;
  }
  if (init.referrerPolicy !== undefined) {
    next.referrerPolicy = init.referrerPolicy;
  }
  if (init.signal !== undefined) {
    next.signal = init.signal;
  }

  return next;
}

function createWebReadableStream(
  body: NonNullable<UndiciFetchResponse['body']>,
): ReadableStream<Uint8Array> {
  const reader = body.getReader();

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) {
        controller.close();
        return;
      }

      if (value instanceof Uint8Array) {
        controller.enqueue(value);
        return;
      }

      controller.enqueue(new Uint8Array(value));
    },
    async cancel(reason) {
      await reader.cancel(reason);
    },
  });
}

function adaptUndiciResponse(response: UndiciFetchResponse): Response {
  const headers = new Headers();
  response.headers.forEach((value, key) => {
    headers.append(key, value);
  });

  const body =
    response.body === null ? null : createWebReadableStream(response.body);

  return new Response(body, {
    headers,
    status: response.status,
    statusText: response.statusText,
  });
}

function fetchWithUndici(
  input: RequestInfo | URL,
  init?: RequestInitWithDispatcher,
  proxyConfig?: ProxyConfig,
): Promise<Response> {
  if (typeof Request !== 'undefined' && input instanceof Request) {
    throw new TypeError('fetchWithRetry does not support Request input');
  }

  if (typeof input !== 'string' && !(input instanceof URL)) {
    throw new TypeError('fetchWithRetry only supports string or URL input');
  }

  if (!supportsUndiciRequestBody(init?.body)) {
    throw new TypeError('fetchWithRetry received an unsupported request body');
  }

  return undiciFetch(
    input,
    toUndiciRequestInit(getUndiciInitWithProxySupport(init, proxyConfig)),
  ).then(adaptUndiciResponse);
}

export async function fetchWithRetryUsingFetch(
  fetcher: typeof fetch,
  input: RequestInfo | URL,
  options: FetchWithRetryOptions = {},
): Promise<Response> {
  const { retryConfig, logger, connectionTimeoutMs, proxy, ...fetchOptions } =
    options;
  const maxRetries =
    retryConfig?.maxRetries ?? DEFAULT_NORMAL_RETRY_CONFIG.maxRetries;
  const initialDelayMs =
    retryConfig?.initialDelayMs ?? DEFAULT_NORMAL_RETRY_CONFIG.initialDelayMs;
  const maxDelayMs =
    retryConfig?.maxDelayMs ?? DEFAULT_NORMAL_RETRY_CONFIG.maxDelayMs;
  const backoffMultiplier =
    retryConfig?.backoffMultiplier ??
    DEFAULT_NORMAL_RETRY_CONFIG.backoffMultiplier;
  const jitterFactor =
    retryConfig?.jitterFactor ?? DEFAULT_NORMAL_RETRY_CONFIG.jitterFactor;
  const retryStatusCodes = retryConfig?.statusCodes;
  const connTimeout =
    connectionTimeoutMs ?? DEFAULT_NORMAL_TIMEOUT_CONFIG.connection;
  const timeoutMessage = t('Timeout: Request aborted after {0}ms', connTimeout);

  let lastResponse: Response | undefined;
  let lastError: Error | undefined;
  let attempt = 0;

  while (attempt <= maxRetries) {
    // Create timeout controller for connection timeout
    const timeoutController = new AbortController();
    const existingSignal = fetchOptions.signal;
    let didTimeout = false;
    let keepAbortLinkForResponseBody = false;
    let abortLinkCleanedUp = false;

    // Combine with existing signal if present
    throwIfAborted(existingSignal);

    let onExistingAbort: (() => void) | undefined;
    if (existingSignal) {
      const signal = existingSignal;
      onExistingAbort = (): void => {
        timeoutController.abort(signal.reason);
      };
      signal.addEventListener('abort', onExistingAbort, { once: true });
      if (signal.aborted) {
        timeoutController.abort(signal.reason);
      }
    }

    const cleanupAbortLink = (): void => {
      if (abortLinkCleanedUp) {
        return;
      }
      abortLinkCleanedUp = true;
      if (onExistingAbort && existingSignal) {
        existingSignal.removeEventListener('abort', onExistingAbort);
      }
    };

    const keepAbortLinkUntilBodySettles = (response: Response): Response => {
      if (!onExistingAbort || !existingSignal) {
        return response;
      }
      keepAbortLinkForResponseBody = true;
      return runWhenResponseBodySettles(response, cleanupAbortLink);
    };

    const timeoutId = setTimeout(() => {
      didTimeout = true;
      timeoutController.abort(new Error(timeoutMessage));
    }, connTimeout);

    try {
      const requestInit = getUndiciInitWithProxySupport(
        {
          ...fetchOptions,
          signal: timeoutController.signal,
        },
        proxy,
      );

      const response = await fetcher(input, requestInit);

      clearTimeout(timeoutId);

      // If successful or non-retryable error, return immediately
      if (
        response.ok ||
        !isRetryableStatusCode(response.status, retryStatusCodes)
      ) {
        return keepAbortLinkUntilBodySettles(response);
      }

      // Retryable status code - decide whether to retry
      lastResponse = response;

      if (attempt < maxRetries) {
        throwIfAborted(existingSignal);
        // Read response body for logging before closing
        let responseBody: string | undefined;
        try {
          responseBody = await response.text();
        } catch {
          // Ignore errors reading body
        }

        // Calculate delay with exponential backoff and jitter
        const delayMs = calculateBackoffDelay(attempt, {
          initialDelayMs,
          maxDelayMs,
          backoffMultiplier,
          jitterFactor,
        });

        // Log retry attempt (only to logs, not displayed in VSCode)
        throwIfAborted(existingSignal);
        logger?.retry(
          attempt + 1,
          maxRetries,
          response.status,
          delayMs,
          responseBody,
        );

        // Wait before retrying (abortable by upstream cancellation)
        await delay(delayMs, existingSignal);
      }

      attempt++;
    } catch (error) {
      clearTimeout(timeoutId);
      throwIfAborted(existingSignal);

      // Normalize undici's `TypeError: terminated` (and other abort surfaces)
      // when we know this request was cancelled due to our own timeout.
      if (didTimeout) {
        const timeoutError = createTimeoutError(timeoutMessage);
        lastError = timeoutError;

        if (attempt < maxRetries) {
          const delayMs = calculateBackoffDelay(attempt, {
            initialDelayMs,
            maxDelayMs,
            backoffMultiplier,
            jitterFactor,
          });

          throwIfAborted(existingSignal);
          logger?.retry(
            attempt + 1,
            maxRetries,
            0,
            delayMs,
            undefined,
            describeNetworkError(timeoutError),
          );
          await delay(delayMs, existingSignal);
        }

        attempt++;
        continue;
      }

      // Retryable connection/network errors.
      if (
        isRetryableNetworkError(error, {
          timedOut: timeoutController.signal.aborted,
        })
      ) {
        lastError = error instanceof Error ? error : new Error(String(error));

        if (attempt < maxRetries) {
          const delayMs = calculateBackoffDelay(attempt, {
            initialDelayMs,
            maxDelayMs,
            backoffMultiplier,
            jitterFactor,
          });

          throwIfAborted(existingSignal);
          logger?.retry(
            attempt + 1,
            maxRetries,
            0,
            delayMs,
            undefined,
            describeNetworkError(error),
          );
          await delay(delayMs, existingSignal);
        }

        attempt++;
        continue;
      }

      // Other errors (network errors, user abort) should not be retried
      throw error;
    } finally {
      if (!keepAbortLinkForResponseBody) {
        cleanupAbortLink();
      }
    }
  }

  // All retries exhausted
  if (lastError) {
    throw resolveMeaningfulError(lastError);
  }
  return lastResponse!;
}

/**
 * Wraps an async iterable with idle timeout support.
 * Throws Error if no data is received within responseTimeoutMs.
 *
 * Each time data is received (token, SSE ping, keep-alive comment, etc.),
 * the timeout timer is reset.
 *
 * @param source The source async iterable to wrap
 * @param responseTimeoutMs Maximum time to wait between data chunks
 * @param abortSignal Optional abort signal to cancel the iteration
 */
export async function* withIdleTimeout<T>(
  source: AsyncIterable<T>,
  responseTimeoutMs: number,
  abortSignal?: AbortSignal,
  onTimeout?: (error: Error) => void,
): AsyncGenerator<T> {
  const iterator = source[Symbol.asyncIterator]();
  const timeoutMessage = t(
    'Response timeout: No data received for {0}ms',
    responseTimeoutMs,
  );

  type RaceResult =
    | { kind: 'value'; result: IteratorResult<T> }
    | { kind: 'timeout' }
    | { kind: 'abort' };

  let onAbort: (() => void) | undefined;
  const abortRace: Promise<RaceResult> | undefined = abortSignal
    ? new Promise((resolve) => {
        const signal = abortSignal;
        if (signal.aborted) {
          resolve({ kind: 'abort' });
          return;
        }
        onAbort = (): void => resolve({ kind: 'abort' });
        signal.addEventListener('abort', onAbort);
      })
    : undefined;

  try {
    while (true) {
      throwIfAborted(abortSignal);

      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      const timeoutRace: Promise<RaceResult> = new Promise((resolve) => {
        timeoutId = setTimeout(
          () => resolve({ kind: 'timeout' }),
          responseTimeoutMs,
        );
      });

      try {
        const races: Array<Promise<RaceResult>> = [
          iterator
            .next()
            .then((r): RaceResult => ({ kind: 'value', result: r })),
          timeoutRace,
        ];
        if (abortRace) {
          races.push(abortRace);
        }

        let result: RaceResult;
        try {
          result = await Promise.race(races);
        } catch (error) {
          if (abortSignal?.aborted) {
            throw abortReasonToError(abortSignal);
          }
          throw resolveMeaningfulError(error);
        }

        if (result.kind === 'abort') {
          if (abortSignal) {
            throw abortReasonToError(abortSignal);
          }
          throw new Error('Aborted');
        }

        if (result.kind === 'timeout') {
          const timeoutError = createTimeoutError(timeoutMessage);
          onTimeout?.(timeoutError);
          throw timeoutError;
        }

        // Normal iteration result
        const iterResult = result.result;
        if (iterResult.done) {
          return;
        }

        // Final check before yielding
        throwIfAborted(abortSignal);

        yield iterResult.value;
      } finally {
        if (timeoutId !== undefined) {
          clearTimeout(timeoutId);
        }
      }
    }
  } finally {
    if (abortSignal && onAbort) {
      abortSignal.removeEventListener('abort', onAbort);
    }
    try {
      await iterator.return?.();
    } catch {
      // ignore
    }
  }
}

/**
 * Normalize a base URL for API calls:
 * - trims whitespace
 * - removes query/hash
 * - collapses extra slashes
 * - removes trailing slash
 */
export function normalizeBaseUrlInput(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error('Base URL is required');
  }
  const parsed = new URL(trimmed);
  parsed.search = '';
  parsed.hash = '';

  const collapsed = parsed.pathname.replace(/\/{2,}/g, '/');
  const pathname = collapsed.replace(/\/+$/, '');
  parsed.pathname = pathname;

  // URL.toString re-adds a trailing slash when pathname is empty; strip it.
  const normalized = parsed.toString().replace(/\/+$/, '');
  return normalized;
}

export function normalizeRawBaseUrlInput(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error('Base URL is required');
  }
  new URL(trimmed);
  return trimmed;
}

export function normalizeUseRawBaseUrl(raw: unknown): true | undefined {
  return raw === true ? true : undefined;
}

export function isRawBaseUrlEnabled(
  provider: Pick<ProviderConfig, 'useRawBaseUrl'>,
): boolean {
  return provider.useRawBaseUrl === true;
}

export function isCacheControlMarker(
  part: vscode.LanguageModelDataPart,
): boolean {
  return (
    part.mimeType === DataPartMimeTypes.CacheControl &&
    part.data.toString() === 'ephemeral'
  );
}

export function isInternalMarker(part: vscode.LanguageModelDataPart): boolean {
  return part.mimeType === DataPartMimeTypes.StatefulMarker;
}

export function isUsageMarker(part: vscode.LanguageModelDataPart): boolean {
  return part.mimeType === DataPartMimeTypes.Usage;
}

export function isImageMarker(part: vscode.LanguageModelDataPart): boolean {
  return part.mimeType.startsWith('image/');
}

function normalizeTokenCount(value: number | null | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.trunc(value));
}

export function normalizeCopilotUsage(usage: CopilotUsage): CopilotUsage {
  const promptTokens = normalizeTokenCount(usage.prompt_tokens);
  const completionTokens = normalizeTokenCount(usage.completion_tokens);
  const cachedTokens = normalizeTokenCount(
    usage.prompt_tokens_details.cached_tokens,
  );

  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: promptTokens + completionTokens,
    prompt_tokens_details: {
      cached_tokens: cachedTokens,
    },
  };
}

export function tryNormalizeCopilotUsage(
  usage: unknown,
): CopilotUsage | undefined {
  if (!isRecord(usage)) {
    return undefined;
  }

  const promptTokens = usage['prompt_tokens'];
  const completionTokens = usage['completion_tokens'];
  if (
    typeof promptTokens !== 'number' ||
    !Number.isFinite(promptTokens) ||
    typeof completionTokens !== 'number' ||
    !Number.isFinite(completionTokens)
  ) {
    return undefined;
  }

  const details = usage['prompt_tokens_details'];
  const cachedTokens = isRecord(details) ? details['cached_tokens'] : undefined;

  return normalizeCopilotUsage({
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens:
      typeof usage['total_tokens'] === 'number' &&
      Number.isFinite(usage['total_tokens'])
        ? usage['total_tokens']
        : promptTokens + completionTokens,
    prompt_tokens_details: {
      cached_tokens:
        typeof cachedTokens === 'number' && Number.isFinite(cachedTokens)
          ? cachedTokens
          : 0,
    },
  });
}

export function createUsageDataPart(
  usage: CopilotUsage,
): vscode.LanguageModelDataPart {
  const normalized = normalizeCopilotUsage(usage);
  return new vscode.LanguageModelDataPart(
    Buffer.from(JSON.stringify(normalized), 'utf8'),
    DataPartMimeTypes.Usage,
  );
}

export interface StatefulMarkerEnvelope<T extends object> {
  identity: string;
  data: T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Create a stable identity hash for stateful markers.
 *
 * This is used to detect cross-provider or cross-model history and decide whether
 * to restore raw state or fall back to text-only history.
 */
export function createStatefulMarkerIdentity(
  provider: ProviderConfig,
  model: ModelConfig,
): string {
  const normalizedBaseUrl = normalizeBaseUrlInput(provider.baseUrl);
  const seed = `ucp_stateful_marker:v1|${provider.type}|${normalizedBaseUrl}|${model.id}`;
  const hash = createHash('sha256').update(seed, 'utf8').digest('hex');
  return `v1:${hash}`;
}

export function encodeStatefulMarkerPart<T extends object>(
  identity: string,
  data: T,
): vscode.LanguageModelDataPart {
  const envelope: StatefulMarkerEnvelope<T> = { identity, data };
  const rawBase64: StatefulMarkerData = `[MODELID]\\${Buffer.from(
    JSON.stringify(envelope),
  ).toString('base64')}`;
  return new vscode.LanguageModelDataPart(
    Buffer.from(rawBase64),
    DataPartMimeTypes.StatefulMarker,
  );
}

export function decodeStatefulMarkerPart<T extends object>(
  expectedIdentity: string,
  modelId: string,
  part: vscode.LanguageModelDataPart,
): T {
  if (part.mimeType !== DataPartMimeTypes.StatefulMarker) {
    throw new Error(
      `Invalid raw message stateful marker data mime type: ${part.mimeType}`,
    );
  }
  const rawStr = part.data.toString();
  const match = rawStr.match(new RegExp(`^${escapeRegExp(modelId)}\\\\(.+)$`));
  if (!match) {
    throw new Error('Invalid raw message stateful marker data format');
  }
  const rawJson = Buffer.from(match[1], 'base64').toString('utf-8');
  const decoded: unknown = JSON.parse(rawJson);

  if (!isRecord(decoded)) {
    throw new Error('Invalid raw message stateful marker data format');
  }

  const identity = decoded.identity;
  const data = decoded.data;

  if (typeof identity !== 'string' || !identity.trim()) {
    throw new Error('Invalid raw message stateful marker identity');
  }

  if (typeof data !== 'object' || data === null) {
    throw new Error('Invalid raw message stateful marker data');
  }

  if (identity !== expectedIdentity) {
    throw new Error('Stateful marker identity mismatch');
  }

  return data as T;
}

export function tryDecodeStatefulMarkerPart<T extends object>(
  expectedIdentity: string,
  modelId: string,
  part: vscode.LanguageModelDataPart,
): T | undefined {
  try {
    return decodeStatefulMarkerPart<T>(expectedIdentity, modelId, part);
  } catch {
    return undefined;
  }
}

export interface SanitizedMessagesForModelSwitchResult {
  messages: vscode.LanguageModelChatRequestMessage[];
  messageOriginIndexes: number[];
  sanitizedMessageIndexes: ReadonlySet<number>;
}

export type SanitizedImagePartRetention = 'discard' | 'user-only' | 'all';

function collectExplicitToolCallIds(
  message: vscode.LanguageModelChatRequestMessage,
): string[] {
  if (message.role !== vscode.LanguageModelChatMessageRole.Assistant) {
    return [];
  }

  return message.content.flatMap((part) =>
    part instanceof vscode.LanguageModelToolCallPart ? [part.callId] : [],
  );
}

function collectExplicitToolResultIds(
  message: vscode.LanguageModelChatRequestMessage,
): string[] {
  if (message.role !== vscode.LanguageModelChatMessageRole.User) {
    return [];
  }

  return message.content.flatMap((part) =>
    part instanceof vscode.LanguageModelToolResultPart ||
    part instanceof vscode.LanguageModelToolResultPart2
      ? [part.callId]
      : [],
  );
}

function sanitizeMessageForModelSwitch(
  message: vscode.LanguageModelChatRequestMessage,
  imageRetention: SanitizedImagePartRetention,
): vscode.LanguageModelChatRequestMessage | undefined {
  // Tool calls and their sibling assistant content form one response. If the
  // tool call cannot be replayed, retaining only its text/image parts invents
  // a standalone assistant turn and can leave history ending in Assistant.
  if (collectExplicitToolCallIds(message).length > 0) {
    return undefined;
  }

  // Cross-model history must be provider-neutral. Keep only text and images
  // that the target model can safely consume; drop markers, tools, thinking,
  // usage/cache metadata, and any unknown future part types.
  const portableParts = message.content.filter(
    (
      part,
    ): part is vscode.LanguageModelTextPart | vscode.LanguageModelDataPart => {
      if (part instanceof vscode.LanguageModelTextPart) {
        return part.value.length > 0;
      }

      if (
        !(part instanceof vscode.LanguageModelDataPart) ||
        !isImageMarker(part) ||
        imageRetention === 'discard'
      ) {
        return false;
      }

      return (
        imageRetention === 'all' ||
        message.role === vscode.LanguageModelChatMessageRole.User
      );
    },
  );

  if (portableParts.length === 0) {
    return undefined;
  }

  return {
    role: message.role,
    name: message.name,
    content: portableParts,
  };
}

function propagateSanitizedToolNeighbors(
  messages: readonly vscode.LanguageModelChatRequestMessage[],
  sanitizedMessageIndexes: Set<number>,
): void {
  const toolCallMessageIndexByCallId = new Map<string, number>();
  const toolResultMessageIndexesByCallId = new Map<string, number[]>();

  for (const [index, message] of messages.entries()) {
    for (const callId of collectExplicitToolCallIds(message)) {
      toolCallMessageIndexByCallId.set(callId, index);
    }

    for (const callId of collectExplicitToolResultIds(message)) {
      const indexes = toolResultMessageIndexesByCallId.get(callId);
      if (indexes) {
        indexes.push(index);
      } else {
        toolResultMessageIndexesByCallId.set(callId, [index]);
      }
    }
  }

  let changed = true;
  while (changed) {
    changed = false;

    for (const [callId, callMessageIndex] of toolCallMessageIndexByCallId) {
      const resultMessageIndexes =
        toolResultMessageIndexesByCallId.get(callId) ?? [];
      const callMessageSanitized =
        sanitizedMessageIndexes.has(callMessageIndex);
      const hasSanitizedResultMessage = resultMessageIndexes.some((index) =>
        sanitizedMessageIndexes.has(index),
      );

      if (callMessageSanitized) {
        for (const resultMessageIndex of resultMessageIndexes) {
          if (!sanitizedMessageIndexes.has(resultMessageIndex)) {
            sanitizedMessageIndexes.add(resultMessageIndex);
            changed = true;
          }
        }
      }

      if (hasSanitizedResultMessage && !callMessageSanitized) {
        sanitizedMessageIndexes.add(callMessageIndex);
        changed = true;
      }
    }
  }
}

export function sanitizeMessagesForModelSwitchDetailed(
  messages: readonly vscode.LanguageModelChatRequestMessage[],
  options: {
    modelId: string;
    expectedIdentity: string;
    imageRetention?: SanitizedImagePartRetention;
  },
): SanitizedMessagesForModelSwitchResult {
  const sanitizedMessageIndexes = new Set<number>();

  let round: number[] = [];
  let roundHasAssistant = false;

  const flush = (): void => {
    if (round.length === 0) {
      roundHasAssistant = false;
      return;
    }

    if (roundHasAssistant) {
      let isRoundValid = true;
      for (const index of round) {
        const message = messages[index];
        if (message.role !== vscode.LanguageModelChatMessageRole.Assistant) {
          continue;
        }

        const markerParts = message.content.filter(
          (part): part is vscode.LanguageModelDataPart =>
            part instanceof vscode.LanguageModelDataPart &&
            part.mimeType === DataPartMimeTypes.StatefulMarker,
        );

        if (markerParts.length !== 1) {
          isRoundValid = false;
          break;
        }

        const decoded = tryDecodeStatefulMarkerPart<object>(
          options.expectedIdentity,
          options.modelId,
          markerParts[0],
        );
        if (!decoded) {
          isRoundValid = false;
          break;
        }
      }

      if (!isRoundValid) {
        for (const index of round) {
          sanitizedMessageIndexes.add(index);
        }
      }
    }

    round = [];
    roundHasAssistant = false;
  };

  for (const [index, message] of messages.entries()) {
    switch (message.role) {
      case vscode.LanguageModelChatMessageRole.System:
        flush();
        break;

      case vscode.LanguageModelChatMessageRole.User:
        if (roundHasAssistant) {
          flush();
        }
        round.push(index);
        break;

      case vscode.LanguageModelChatMessageRole.Assistant:
        roundHasAssistant = true;
        round.push(index);
        break;

      default:
        flush();
        break;
    }
  }

  flush();

  propagateSanitizedToolNeighbors(messages, sanitizedMessageIndexes);

  const out: vscode.LanguageModelChatRequestMessage[] = [];
  const messageOriginIndexes: number[] = [];
  for (const [index, message] of messages.entries()) {
    if (!sanitizedMessageIndexes.has(index)) {
      out.push(message);
      messageOriginIndexes.push(index);
      continue;
    }

    const sanitizedMessage = sanitizeMessageForModelSwitch(
      message,
      options.imageRetention ?? 'discard',
    );
    if (sanitizedMessage) {
      out.push(sanitizedMessage);
      messageOriginIndexes.push(index);
    }
  }

  return {
    messages: out,
    messageOriginIndexes,
    sanitizedMessageIndexes: new Set(sanitizedMessageIndexes),
  };
}

export function sanitizeMessagesForModelSwitch(
  messages: readonly vscode.LanguageModelChatRequestMessage[],
  options: {
    modelId: string;
    expectedIdentity: string;
    imageRetention?: SanitizedImagePartRetention;
  },
): vscode.LanguageModelChatRequestMessage[] {
  return sanitizeMessagesForModelSwitchDetailed(messages, options).messages;
}

const SUPPORTED_BASE64_IMAGE_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  // 'image/bmp',
] as const;

type SupportedBase64ImageMimeType =
  (typeof SUPPORTED_BASE64_IMAGE_MIME_TYPES)[number];

const OUTPUT_IMAGE_MIME_TYPE_PATTERN = /^image\/[a-z0-9.+-]+$/i;

export function normalizeImageMimeType(
  mimeType: string,
): SupportedBase64ImageMimeType | undefined {
  if (mimeType === 'image/jpg') {
    return 'image/jpeg';
  }
  return (SUPPORTED_BASE64_IMAGE_MIME_TYPES as readonly string[]).includes(
    mimeType,
  )
    ? (mimeType as SupportedBase64ImageMimeType)
    : undefined;
}

export function normalizeOutputImageMimeType(
  mimeType: string | undefined,
  fallbackMimeType = 'image/png',
): string {
  const normalizedMimeType =
    typeof mimeType === 'string' ? mimeType.trim().toLowerCase() : '';
  if (!normalizedMimeType) {
    return fallbackMimeType;
  }

  const normalizedSupportedMimeType =
    normalizeImageMimeType(normalizedMimeType);
  if (normalizedSupportedMimeType) {
    return normalizedSupportedMimeType;
  }

  return OUTPUT_IMAGE_MIME_TYPE_PATTERN.test(normalizedMimeType)
    ? normalizedMimeType
    : fallbackMimeType;
}

export function createImageDataPartFromBase64(
  base64Data: string,
  mimeType?: string,
  fallbackMimeType = 'image/png',
): vscode.LanguageModelDataPart {
  return new vscode.LanguageModelDataPart(
    Buffer.from(base64Data, 'base64'),
    normalizeOutputImageMimeType(mimeType, fallbackMimeType),
  );
}

export function createImageDataPartFromBytes(
  data: Uint8Array,
  mimeType?: string,
  fallbackMimeType = 'image/png',
): vscode.LanguageModelDataPart {
  return new vscode.LanguageModelDataPart(
    data,
    normalizeOutputImageMimeType(mimeType, fallbackMimeType),
  );
}

export interface GetAllModelsOptions {
  /**
   * Whether to force fetch official models (skip cache)
   */
  forceFetch?: boolean;
}

export interface GetAllModelsResult {
  readonly models: ModelConfig[];
  readonly error?: string;
}

export async function getAllModelsForProviderData(
  provider: ProviderConfig,
  options?: GetAllModelsOptions,
): Promise<GetAllModelsResult> {
  const userModels = provider.models;
  const userModelIds = new Set(userModels.map((model) => model.id));
  if (!provider.autoFetchOfficialModels) {
    return { models: [...userModels] };
  }

  const official = await officialModelsManager.getOfficialModelsData(provider, {
    forceFetch: options?.forceFetch,
  });
  const officialModels = official.models.filter(
    (model) => !userModelIds.has(model.id),
  );
  return {
    models: [...userModels, ...officialModels],
    ...(official.state?.lastError ? { error: official.state.lastError } : {}),
  };
}

/**
 * Get all models for a provider (user models + official models)
 * - Automatically deduplicates, user models take priority
 * - If autoFetchOfficialModels is not enabled, only returns user models
 */
export async function getAllModelsForProvider(
  provider: ProviderConfig,
  options?: GetAllModelsOptions,
): Promise<ModelConfig[]> {
  return (await getAllModelsForProviderData(provider, options)).models;
}

/**
 * Synchronous version of getAllModelsForProvider.
 * Returns cached models immediately and triggers background fetch if needed.
 *
 * Behavior:
 * - Always returns user-defined models immediately
 * - If autoFetchOfficialModels is enabled:
 *   - Returns cached official models if available
 *   - Returns placeholder model if no cache exists
 *   - Automatically triggers background fetch when needed
 */
export function getAllModelsForProviderSync(
  provider: ProviderConfig,
): ModelConfig[] {
  const userModels = provider.models;
  const userModelIds = new Set(userModels.map((m) => m.id));

  let officialModels: ModelConfig[] = [];

  if (provider.autoFetchOfficialModels) {
    // Get cached state synchronously
    const state = officialModelsManager.getProviderState(provider.name);

    if (state && state.models.length > 0) {
      // Cache exists - use it
      officialModels = state.models;
    } else {
      // No cache - return placeholder
      officialModels = [
        {
          id: PLACEHOLDER_MODEL_ID,
          name: t('Loading official models...'),
          capabilities: { toolCalling: true, imageInput: true },
        },
      ];
    }

    // Trigger background fetch (non-blocking)
    officialModelsManager.triggerBackgroundFetch(provider);
  }

  // Filter out official models that conflict with user models
  const filteredOfficialModels = officialModels.filter(
    (m) => !userModelIds.has(m.id),
  );

  return [...userModels, ...filteredOfficialModels];
}

export type PKCEMethod = 'S256' | 'plain';

export interface PKCEChallenge<M extends PKCEMethod = 'S256'> {
  verifier: string;
  challenge: string;
  method: M;
}

const PKCE_VERIFIER_CHARSET =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

function generatePkceVerifier(length: number): string {
  const bytes = randomBytes(length);
  let out = '';
  for (const byte of bytes) {
    out += PKCE_VERIFIER_CHARSET[byte & 63];
  }
  return out;
}

function generatePkceChallenge(verifier: string, method: PKCEMethod): string {
  if (method === 'plain') {
    return verifier;
  }
  return createHash('sha256').update(verifier).digest('base64url');
}

function timingSafeEqualStrings(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  const aBuf = Buffer.from(a, 'utf8');
  const bBuf = Buffer.from(b, 'utf8');
  if (aBuf.length !== bBuf.length) {
    return false;
  }
  return timingSafeEqual(aBuf, bBuf);
}

export function generatePKCE(): PKCEChallenge<'S256'>;
export function generatePKCE(length: number): PKCEChallenge<'S256'>;
export function generatePKCE<M extends PKCEMethod>(
  length: number,
  method: M,
): PKCEChallenge<M>;
export function generatePKCE(
  length: number = 64,
  method: PKCEMethod = 'S256',
): PKCEChallenge<PKCEMethod> {
  if (length < 43 || length > 128) {
    throw new Error(
      'Code verifier length must be between 43 and 128 characters',
    );
  }

  const verifier = generatePkceVerifier(length);
  const challenge = generatePkceChallenge(verifier, method);

  return { verifier, challenge, method };
}

export function validatePKCE(
  verifier: string,
  challenge: string,
  method: PKCEMethod = 'S256',
): boolean {
  const generatedChallenge = generatePkceChallenge(verifier, method);
  return timingSafeEqualStrings(generatedChallenge, challenge);
}

export interface ThinkingTagSegment {
  type: 'text' | 'thinking';
  content: string;
}

export function parseThinkingTags(text: string): ThinkingTagSegment[] {
  const segments: ThinkingTagSegment[] = [];
  // regex: match <think>...</think> or <thinking>...</thinking>
  const regex = /<(think(?:ing)?)>([\s\S]*?)<\/\1>/g;

  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      const textContent = text.slice(lastIndex, match.index);
      if (textContent) {
        segments.push({ type: 'text', content: textContent });
      }
    }

    const thinkingContent = match[2];
    if (thinkingContent) {
      segments.push({ type: 'thinking', content: thinkingContent });
    }

    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < text.length) {
    const textContent = text.slice(lastIndex);
    if (textContent) {
      segments.push({ type: 'text', content: textContent });
    }
  }

  return segments;
}

export class StreamingThinkingTagParser {
  private buffer = '';
  private inThinkingBlock = false;
  private tagType: 'think' | 'thinking' | null = null;

  push(chunk: string): ThinkingTagSegment[] {
    this.buffer += chunk;
    return this.processBuffer(false);
  }

  flush(): ThinkingTagSegment[] {
    return this.processBuffer(true);
  }

  private processBuffer(flush: boolean): ThinkingTagSegment[] {
    const segments: ThinkingTagSegment[] = [];

    while (this.buffer.length > 0) {
      if (this.inThinkingBlock) {
        segments.push(...this.processThinkingBlock(flush));
        if (!flush && this.inThinkingBlock) break;
      } else {
        segments.push(...this.processTextBlock(flush));
        if (!flush && !this.inThinkingBlock) break;
      }
    }

    return segments;
  }

  private processThinkingBlock(flush: boolean): ThinkingTagSegment[] {
    const segments: ThinkingTagSegment[] = [];
    const closeTag = this.tagType === 'think' ? '</think>' : '</thinking>';
    const closeIndex = this.buffer.indexOf(closeTag);

    if (closeIndex !== -1) {
      const thinkingContent = this.buffer.slice(0, closeIndex);
      if (thinkingContent) {
        segments.push({ type: 'thinking', content: thinkingContent });
      }
      this.buffer = this.buffer.slice(closeIndex + closeTag.length);
      this.inThinkingBlock = false;
      this.tagType = null;
    } else if (flush) {
      if (this.buffer) {
        segments.push({ type: 'thinking', content: this.buffer });
      }
      this.buffer = '';
    } else {
      const maxPartialLen = '</thinking>'.length - 1;
      const safeLen = Math.max(0, this.buffer.length - maxPartialLen);
      if (safeLen > 0) {
        segments.push({
          type: 'thinking',
          content: this.buffer.slice(0, safeLen),
        });
        this.buffer = this.buffer.slice(safeLen);
      }
    }

    return segments;
  }

  private processTextBlock(flush: boolean): ThinkingTagSegment[] {
    const segments: ThinkingTagSegment[] = [];
    const thinkIndex = this.buffer.indexOf('<think>');
    const thinkingIndex = this.buffer.indexOf('<thinking>');

    let openIndex = -1;
    let openTag = '';
    let tagType: 'think' | 'thinking' | null = null;

    if (
      thinkIndex !== -1 &&
      (thinkingIndex === -1 || thinkIndex < thinkingIndex)
    ) {
      openIndex = thinkIndex;
      openTag = '<think>';
      tagType = 'think';
    } else if (thinkingIndex !== -1) {
      openIndex = thinkingIndex;
      openTag = '<thinking>';
      tagType = 'thinking';
    }

    if (openIndex !== -1) {
      const textContent = this.buffer.slice(0, openIndex);
      if (textContent) {
        segments.push({ type: 'text', content: textContent });
      }
      this.buffer = this.buffer.slice(openIndex + openTag.length);
      this.inThinkingBlock = true;
      this.tagType = tagType;
    } else if (flush) {
      if (this.buffer) {
        segments.push({ type: 'text', content: this.buffer });
      }
      this.buffer = '';
    } else {
      const maxPartialLen = '<thinking>'.length - 1;
      const safeLen = Math.max(0, this.buffer.length - maxPartialLen);
      if (safeLen > 0) {
        segments.push({ type: 'text', content: this.buffer.slice(0, safeLen) });
        this.buffer = this.buffer.slice(safeLen);
      }
    }

    return segments;
  }
}

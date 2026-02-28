import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { DataPartMimeTypes, StatefulMarkerData } from './client/types';
import type { ProviderHttpLogger } from './logger';
import { officialModelsManager } from './official-models-manager';
import type {
  ContextCacheConfig,
  ContextCacheType,
  ModelConfig,
  ProviderConfig,
  TimeoutConfig,
} from './types';
import * as vscode from 'vscode';
import { t } from './i18n';

/**
 * Placeholder model ID used when official models are loading.
 * Uses double underscores to clearly distinguish from real model IDs.
 */
export const PLACEHOLDER_MODEL_ID = '__PLACEHOLDER__';

export const DEFAULT_CONTEXT_CACHE_TTL_SECONDS = 300;
export const DEFAULT_CONTEXT_CACHE_TYPE: ContextCacheType = 'only-free';

/**
 * Check if a model ID is a placeholder.
 * Works with both raw model ID and full model ID format (provider/model).
 */
export function isPlaceholderModelId(modelId: string): boolean {
  const slashIndex = modelId.indexOf('/');
  const modelName = slashIndex === -1 ? modelId : modelId.slice(slashIndex + 1);
  return modelName === PLACEHOLDER_MODEL_ID;
}

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
  connection: 10_000,
  /** Response/idle timeout in milliseconds */
  response: 10_000,
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
}

export interface ResolvedChatNetworkConfig {
  timeout: ResolvedChatTimeoutConfig;
  retry: ResolvedChatRetryConfig;
}

export interface ChatNetworkOverrides {
  timeout?: TimeoutConfig;
  retry?: RetryConfig;
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

function readGlobalChatNetworkOverrides(): {
  timeout?: unknown;
  retry?: unknown;
} {
  const config = vscode.workspace.getConfiguration(
    CHAT_NETWORK_CONFIG_NAMESPACE,
  );
  const raw = config.get<unknown>('networkSettings');
  if (!isRecord(raw)) return {};

  const timeout = raw['timeout'];
  const retry = raw['retry'];

  return { timeout, retry };
}

/**
 * Resolve effective network settings for *chat requests*.
 *
 * Merge order:
 * 1) Built-in defaults (DEFAULT_CHAT_*)
 * 2) Global settings: `unifyChatProvider.networkSettings`
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

  const global = readGlobalChatNetworkOverrides();
  applyTimeoutOverrides(resolved.timeout, global.timeout);
  applyRetryOverrides(resolved.retry, global.retry);

  applyTimeoutOverrides(resolved.timeout, overrides?.timeout);
  applyRetryOverrides(resolved.retry, overrides?.retry);

  return resolved;
}

export interface FetchWithRetryOptions extends RequestInit {
  retryConfig?: RetryConfig;
  logger?: ProviderHttpLogger;
  /** Connection timeout in milliseconds. If not specified, uses DEFAULT_NORMAL_TIMEOUT_CONFIG.connection */
  connectionTimeoutMs?: number;
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
 * Check if an HTTP status code is retryable.
 */
export function isRetryableStatusCode(status: number): boolean {
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

function getErrorCode(error: unknown): string | undefined {
  const direct = tryGetErrorCode(error);
  if (direct) {
    return direct;
  }
  if (typeof error === 'object' && error !== null && 'cause' in error) {
    return tryGetErrorCode((error as { cause: unknown }).cause);
  }
  return undefined;
}

const ABORT_LIKE_ERROR_CODES = new Set<string>([
  'ABORT_ERR',
  'ERR_ABORTED',
  'UND_ERR_ABORTED',
]);

const TIMEOUT_LIKE_ERROR_CODES = new Set<string>([
  'ETIMEDOUT',
  'ECONNABORTED',
  'ESOCKETTIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
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

export function isTimeoutLikeError(error: unknown): boolean {
  if (!error) {
    return false;
  }

  if (error instanceof Error && error.name === 'TimeoutError') {
    return true;
  }

  const code = getErrorCode(error);
  if (code && TIMEOUT_LIKE_ERROR_CODES.has(code)) {
    return true;
  }

  if (!(error instanceof Error)) {
    return false;
  }

  const message = error.message.toLowerCase();
  return (
    (error.name === 'TypeError' && message.includes('terminated')) ||
    message.includes('timed out') ||
    message.includes('timeout') ||
    message.includes('fetch.onaborted')
  );
}

export function normalizeTimeoutLikeError(
  error: unknown,
  timeoutMessage: string,
): Error {
  if (error instanceof Error && error.name === 'TimeoutError') {
    return error;
  }

  if (!isTimeoutLikeError(error)) {
    return error instanceof Error ? error : new Error(String(error));
  }

  return createTimeoutError(timeoutMessage);
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
  return fetchWithRetryUsingFetch(fetch, input, options);
}

export async function fetchWithRetryUsingFetch(
  fetcher: typeof fetch,
  input: RequestInfo | URL,
  options: FetchWithRetryOptions = {},
): Promise<Response> {
  const { retryConfig, logger, connectionTimeoutMs, ...fetchOptions } = options;
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
  const connTimeout =
    connectionTimeoutMs ?? DEFAULT_NORMAL_TIMEOUT_CONFIG.connection;
  const timeoutMessage = t('Timeout: Request aborted after {0}ms', connTimeout);

  let lastResponse: Response | undefined;
  let lastError: Error | undefined;
  let attempt = 0;

  const hasCause = (value: unknown): value is { cause: unknown } =>
    typeof value === 'object' && value !== null && 'cause' in value;

  const tryGetErrorCode = (value: unknown): string | undefined => {
    if (typeof value !== 'object' || value === null) {
      return undefined;
    }
    if (!('code' in value)) {
      return undefined;
    }
    const code = (value as { code: unknown }).code;
    return typeof code === 'string' ? code : undefined;
  };

  const retryableCodes = new Set<string>([
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

  const isRetryableNetworkError = (
    error: unknown,
    options: { timedOut: boolean },
  ): boolean => {
    if (!error) {
      return false;
    }

    // Retry on our own connection-timeout aborts (may surface as AbortError).
    if (options.timedOut && isAbortError(error)) {
      return true;
    }

    const directCode = tryGetErrorCode(error);
    if (directCode && retryableCodes.has(directCode)) {
      return true;
    }

    if (hasCause(error)) {
      const causeCode = tryGetErrorCode(error.cause);
      if (causeCode && retryableCodes.has(causeCode)) {
        return true;
      }
    }

    if (error instanceof Error) {
      const message = error.message.toLowerCase();
      if (
        message.includes('fetch failed') ||
        message.includes('network error') ||
        message.includes('socket hang up')
      ) {
        return true;
      }
    }

    return false;
  };

  while (attempt <= maxRetries) {
    // Create timeout controller for connection timeout
    const timeoutController = new AbortController();
    const existingSignal = fetchOptions.signal;
    let didTimeout = false;

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

    const timeoutId = setTimeout(() => {
      didTimeout = true;
      timeoutController.abort(new Error(timeoutMessage));
    }, connTimeout);

    try {
      const response = await fetcher(input, {
        ...fetchOptions,
        signal: timeoutController.signal,
      });

      clearTimeout(timeoutId);

      // If successful or non-retryable error, return immediately
      if (response.ok || !isRetryableStatusCode(response.status)) {
        return response;
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
        (error instanceof Error &&
          error.message.includes('Connection timeout')) ||
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
      if (onExistingAbort && existingSignal) {
        existingSignal.removeEventListener('abort', onExistingAbort);
      }
    }
  }

  // All retries exhausted
  if (lastError) {
    throw normalizeTimeoutLikeError(lastError, timeoutMessage);
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
          throw normalizeTimeoutLikeError(error, timeoutMessage);
        }

        if (result.kind === 'abort') {
          if (abortSignal) {
            throw abortReasonToError(abortSignal);
          }
          throw new Error('Aborted');
        }

        if (result.kind === 'timeout') {
          throw createTimeoutError(timeoutMessage);
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

export function isImageMarker(part: vscode.LanguageModelDataPart): boolean {
  return part.mimeType.startsWith('image/');
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

export function sanitizeMessagesForModelSwitch(
  messages: readonly vscode.LanguageModelChatRequestMessage[],
  options: { modelId: string; expectedIdentity: string },
): vscode.LanguageModelChatRequestMessage[] {
  const out: vscode.LanguageModelChatRequestMessage[] = [];

  let round: vscode.LanguageModelChatRequestMessage[] = [];
  let roundHasAssistant = false;

  const flush = (): void => {
    if (round.length === 0) {
      roundHasAssistant = false;
      return;
    }

    if (!roundHasAssistant) {
      out.push(...round);
      round = [];
      roundHasAssistant = false;
      return;
    }

    const isRoundValid = (): boolean => {
      for (const message of round) {
        if (message.role !== vscode.LanguageModelChatMessageRole.Assistant) {
          continue;
        }

        const markerParts = message.content.filter(
          (part): part is vscode.LanguageModelDataPart =>
            part instanceof vscode.LanguageModelDataPart &&
            part.mimeType === DataPartMimeTypes.StatefulMarker,
        );

        if (markerParts.length !== 1) {
          return false;
        }

        const decoded = tryDecodeStatefulMarkerPart<object>(
          options.expectedIdentity,
          options.modelId,
          markerParts[0],
        );
        if (!decoded) {
          return false;
        }
      }

      return true;
    };

    if (isRoundValid()) {
      out.push(...round);
      round = [];
      roundHasAssistant = false;
      return;
    }

    for (const message of round) {
      if (
        message.role !== vscode.LanguageModelChatMessageRole.User &&
        message.role !== vscode.LanguageModelChatMessageRole.Assistant
      ) {
        out.push(message);
        continue;
      }

      const textParts = message.content.filter(
        (part): part is vscode.LanguageModelTextPart =>
          part instanceof vscode.LanguageModelTextPart,
      );

      if (textParts.length === 0) {
        continue;
      }

      out.push({
        role: message.role,
        name: message.name,
        content: textParts,
      });
    }

    round = [];
    roundHasAssistant = false;
  };

  for (const message of messages) {
    switch (message.role) {
      case vscode.LanguageModelChatMessageRole.System:
        flush();
        out.push(message);
        break;

      case vscode.LanguageModelChatMessageRole.User:
        if (roundHasAssistant) {
          flush();
        }
        round.push(message);
        break;

      case vscode.LanguageModelChatMessageRole.Assistant:
        roundHasAssistant = true;
        round.push(message);
        break;

      default:
        flush();
        out.push(message);
        break;
    }
  }

  flush();

  return out;
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

export interface GetAllModelsOptions {
  /**
   * Whether to force fetch official models (skip cache)
   */
  forceFetch?: boolean;
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
  const userModels = provider.models;
  const userModelIds = new Set(userModels.map((m) => m.id));

  let officialModels: ModelConfig[] = [];
  if (provider.autoFetchOfficialModels) {
    officialModels = await officialModelsManager.getOfficialModels(
      provider,
      options?.forceFetch,
    );
  }

  // Filter out official models that conflict with user models
  const filteredOfficialModels = officialModels.filter(
    (m) => !userModelIds.has(m.id),
  );

  return [...userModels, ...filteredOfficialModels];
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

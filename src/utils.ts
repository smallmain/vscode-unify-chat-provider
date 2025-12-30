import { DataPartMimeTypes, StatefulMarkerData } from './client/types';
import type { ProviderHttpLogger } from './logger';
import { officialModelsManager } from './official-models-manager';
import type { ModelConfig, ProviderConfig } from './types';
import * as vscode from 'vscode';

/**
 * HTTP status codes that should trigger a retry.
 * - 408: Request Timeout
 * - 409: Request Lock
 * - 429: Too Many Requests (rate limiting)
 * - >=500: Internal Server Errors
 */
export const RETRYABLE_STATUS_CODES = [408, 409, 429] as const;

/**
 * Default retry configuration following industry standards.
 * Uses exponential backoff with jitter.
 */
export const DEFAULT_RETRY_CONFIG = {
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
export const DEFAULT_TIMEOUT_CONFIG = {
  /** Connection timeout in milliseconds (20 seconds) */
  connection: 20_000,
  /** Response/idle timeout in milliseconds (2 minutes) */
  response: 120_000,
} as const;

export interface RetryConfig {
  maxRetries?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  backoffMultiplier?: number;
  jitterFactor?: number;
}

export interface FetchWithRetryOptions extends RequestInit {
  retryConfig?: RetryConfig;
  logger?: ProviderHttpLogger;
  /** Connection timeout in milliseconds. If not specified, uses DEFAULT_TIMEOUT_CONFIG.connection */
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
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
function calculateBackoffDelay(
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
 * Fetch with automatic retry for transient HTTP errors.
 *
 * Uses exponential backoff with jitter for the following status codes:
 * 429 (Too Many Requests), 500 (Internal Server Error),
 * 502 (Bad Gateway), 503 (Service Unavailable), 504 (Gateway Timeout)
 *
 * Only logs retry attempts - does not return any text to VSCode for display.
 */
export async function fetchWithRetry(
  url: string,
  options: FetchWithRetryOptions = {},
): Promise<Response> {
  const { retryConfig, logger, connectionTimeoutMs, ...fetchOptions } = options;
  const maxRetries = retryConfig?.maxRetries ?? DEFAULT_RETRY_CONFIG.maxRetries;
  const initialDelayMs =
    retryConfig?.initialDelayMs ?? DEFAULT_RETRY_CONFIG.initialDelayMs;
  const maxDelayMs = retryConfig?.maxDelayMs ?? DEFAULT_RETRY_CONFIG.maxDelayMs;
  const backoffMultiplier =
    retryConfig?.backoffMultiplier ?? DEFAULT_RETRY_CONFIG.backoffMultiplier;
  const jitterFactor =
    retryConfig?.jitterFactor ?? DEFAULT_RETRY_CONFIG.jitterFactor;
  const connTimeout = connectionTimeoutMs ?? DEFAULT_TIMEOUT_CONFIG.connection;

  let lastResponse: Response | undefined;
  let lastError: Error | undefined;
  let attempt = 0;

  while (attempt <= maxRetries) {
    // Create timeout controller for connection timeout
    const timeoutController = new AbortController();
    const existingSignal = fetchOptions.signal;

    // Combine with existing signal if present
    if (existingSignal) {
      existingSignal.addEventListener('abort', () => {
        timeoutController.abort(existingSignal.reason);
      });
    }

    const timeoutId = setTimeout(() => {
      timeoutController.abort(
        new Error(`Connection timeout after ${connTimeout}ms`),
      );
    }, connTimeout);

    try {
      const response = await fetch(url, {
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
        // Calculate delay with exponential backoff and jitter
        const delayMs = calculateBackoffDelay(attempt, {
          initialDelayMs,
          maxDelayMs,
          backoffMultiplier,
          jitterFactor,
        });

        // Log retry attempt (only to logs, not displayed in VSCode)
        logger?.retry(attempt + 1, maxRetries, response.status, delayMs);

        // Wait before retrying
        await delay(delayMs);
      }

      attempt++;
    } catch (error) {
      clearTimeout(timeoutId);

      // Check if this is a connection timeout error (retryable)
      if (
        error instanceof Error &&
        error.message.includes('Connection timeout')
      ) {
        lastError = error;

        if (attempt < maxRetries) {
          const delayMs = calculateBackoffDelay(attempt, {
            initialDelayMs,
            maxDelayMs,
            backoffMultiplier,
            jitterFactor,
          });

          logger?.retry(attempt + 1, maxRetries, 0, delayMs);
          await delay(delayMs);
        }

        attempt++;
        continue;
      }

      // Other errors (network errors, user abort) should not be retried
      throw error;
    }
  }

  // All retries exhausted
  if (lastError) {
    throw lastError;
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

  const createTimeoutPromise = (): Promise<'timeout'> => {
    return new Promise((resolve) => {
      setTimeout(() => resolve('timeout'), responseTimeoutMs);
    });
  };

  const createAbortPromise = (): Promise<'abort'> => {
    if (!abortSignal) {
      return new Promise(() => {}); // Never resolves
    }
    return new Promise((resolve) => {
      if (abortSignal.aborted) {
        resolve('abort');
      } else {
        abortSignal.addEventListener('abort', () => resolve('abort'), {
          once: true,
        });
      }
    });
  };

  while (true) {
    // Check if already aborted
    if (abortSignal?.aborted) {
      throw abortSignal.reason ?? new Error('Aborted');
    }

    // Race between next value, timeout, and abort
    const result = await Promise.race([
      iterator.next().then((r) => ({ kind: 'value' as const, result: r })),
      createTimeoutPromise().then(() => ({ kind: 'timeout' as const })),
      createAbortPromise().then(() => ({ kind: 'abort' as const })),
    ]);

    if (result.kind === 'abort') {
      throw abortSignal?.reason ?? new Error('Aborted');
    }

    if (result.kind === 'timeout') {
      throw new Error(
        `Response timeout: No data received for ${responseTimeoutMs}ms`,
      );
    }

    // Normal iteration result
    const iterResult = result.result;
    if (iterResult.done) {
      return;
    }

    yield iterResult.value;
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

export function encodeStatefulMarkerPart<T extends object>(
  raw: T,
): vscode.LanguageModelDataPart {
  const rawBase64: StatefulMarkerData = `[MODELID]\\${Buffer.from(
    JSON.stringify(raw),
  ).toString('base64')}`;
  return new vscode.LanguageModelDataPart(
    Buffer.from(rawBase64),
    DataPartMimeTypes.StatefulMarker,
  );
}

export function decodeStatefulMarkerPart<T extends object>(
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
  return JSON.parse(rawJson) as T;
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

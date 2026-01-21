import * as vscode from 'vscode';
import type { PerformanceTrace } from './types';
import type { BetaUsage } from '@anthropic-ai/sdk/resources/beta/messages';
import type { CompletionUsage } from 'openai/resources/completions';
import type { ResponseUsage } from 'openai/resources/responses/responses';
import type { ApiType } from './client/definitions';

const CHANNEL_NAME = 'Unify Chat Provider';

let channel: vscode.LogOutputChannel | undefined;
let nextRequestId = 1;
let nextHttpLogId = 1;
let hasShownChannel = false;

/**
 * Lazily create and return the log output channel.
 */
function getChannel(): vscode.LogOutputChannel {
  if (!channel) {
    channel = vscode.window.createOutputChannel(CHANNEL_NAME, { log: true });
  }

  // Show the channel once so users notice new logs.
  if (!hasShownChannel) {
    hasShownChannel = true;
    channel.show(true);
  }

  return channel;
}

function isVerboseEnabled(): boolean {
  const config = vscode.workspace.getConfiguration('unifyChatProvider');
  const verbose = config.get<unknown>('verbose', false);
  return typeof verbose === 'boolean' ? verbose : false;
}

function maskSensitiveHeaders(
  headers: Record<string, string>,
): Record<string, string> {
  const masked: Record<string, string> = { ...headers };
  for (const key of Object.keys(masked)) {
    const lower = key.toLowerCase();
    if (
      lower === 'x-api-key' ||
      lower === 'authorization' ||
      lower.includes('token')
    ) {
      masked[key] = maskValue(masked[key]);
    }
  }
  return masked;
}

function maskValue(value?: string): string {
  if (!value) {
    return '';
  }
  if (value.length <= 8) {
    return '*'.repeat(value.length);
  }
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
}

function sanitizeForLog(value: unknown, seen: WeakSet<object>): unknown {
  const utf8Decoder = new TextDecoder('utf-8');

  if (value === null) {
    return null;
  }

  if (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return value;
  }
  if (typeof value === 'bigint') {
    return value.toString();
  }
  if (typeof value === 'symbol') {
    return value.toString();
  }
  if (typeof value === 'function') {
    return '[Function]';
  }
  if (typeof value !== 'object') {
    return String(value);
  }

  if (ArrayBuffer.isView(value)) {
    const bytes = new Uint8Array(
      value.buffer,
      value.byteOffset,
      value.byteLength,
    );
    return utf8Decoder.decode(bytes);
  }
  if (value instanceof ArrayBuffer) {
    return utf8Decoder.decode(new Uint8Array(value));
  }
  if (
    typeof SharedArrayBuffer !== 'undefined' &&
    value instanceof SharedArrayBuffer
  ) {
    return utf8Decoder.decode(new Uint8Array(value));
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack,
    };
  }

  if (seen.has(value)) {
    return '[Circular]';
  }
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeForLog(item, seen));
  }

  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    out[key] = sanitizeForLog(child, seen);
  }
  return out;
}

function stringifyForLog(value: unknown): string {
  try {
    const json = JSON.stringify(sanitizeForLog(value, new WeakSet()), null, 2);
    return json ?? 'undefined';
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `<<Failed to stringify for log: ${message}>>`;
  }
}

export interface ProviderHttpLogger {
  providerRequest(details: {
    endpoint: string;
    method?: string;
    headers?: Record<string, string>;
    body?: unknown;
  }): void;
  providerResponseMeta(response: Response): void;
  providerResponseBody?(body: unknown): void;
  retry(
    attempt: number,
    maxRetries: number,
    statusCode: number,
    delayMs: number,
  ): void;
}

/**
 * A logger bound to a specific request ID for contextual logging.
 *
 * Logging rules:
 * - Request start and complete are always logged (regardless of verbose setting)
 * - Performance and usage info are always logged at complete
 * - Detailed data (messages, options, request body, response chunks) only logged when verbose is enabled
 * - Errors are NOT logged here (caller handles error logging before throwing)
 */
export class RequestLogger implements ProviderHttpLogger {
  private readonly ch = getChannel();
  private providerContext: {
    label: string;
    method: string;
    endpoint: string;
    headers: Record<string, string>;
    body: unknown;
    logged: boolean;
  } | null = null;

  constructor(public readonly requestId: string) {}

  /**
   * Log the start of a request. Always printed.
   */
  start(details: {
    providerName: string;
    actualApiType: ApiType;
    baseUrl: string;
    vscodeModelId: string;
    modelId: string;
    modelName?: string;
  }): void {
    const modelLabel = details.modelName
      ? `${details.modelName} (${details.modelId})`
      : details.modelId;

    this.ch.info(
      `[${this.requestId}] ▶ Request started | Provider: ${details.providerName} | API Type: ${details.actualApiType} | Base URL: ${details.baseUrl} | VSCode Model ID: ${details.vscodeModelId} | Config Model: ${modelLabel}`,
    );
  }

  /**
   * Log the raw input received from VSCode.
   * Only logged when verbose is enabled.
   */
  vscodeInput(
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    options: vscode.ProvideLanguageModelChatResponseOptions,
  ): void {
    if (!isVerboseEnabled()) {
      return;
    }
    this.ch.info(
      `[${this.requestId}] VSCode Input Messages:\n${stringifyForLog(
        messages,
      )}`,
    );
    this.ch.info(
      `[${this.requestId}] VSCode Input Options:\n${JSON.stringify(
        options,
        null,
        2,
      )}`,
    );
  }

  /**
   * Log the HTTP request being sent to the provider.
   * Headers are always masked for sensitive values.
   * Only logged when verbose is enabled, but context is saved for error logging.
   */
  providerRequest(details: {
    endpoint: string;
    method?: string;
    headers?: Record<string, string>;
    body?: unknown;
  }): void {
    const method = details.method || 'GET';
    const maskedHeaders = maskSensitiveHeaders(details.headers ?? {});
    const label = 'HTTP';

    this.providerContext = {
      label,
      method,
      endpoint: details.endpoint,
      headers: maskedHeaders,
      body: details.body ?? null,
      logged: false,
    };

    if (isVerboseEnabled()) {
      this.ch.info(`[${this.requestId}] → ${method} ${details.endpoint}`);
      this.ch.info(
        `[${this.requestId}] Provider Request Headers:\n${JSON.stringify(
          maskedHeaders,
          null,
          2,
        )}`,
      );
      this.ch.info(
        `[${this.requestId}] Provider Request Body:\n${JSON.stringify(
          details.body ?? null,
          null,
          2,
        )}`,
      );
      this.providerContext.logged = true;
    }
  }

  /**
   * Log provider response metadata (status, content-type).
   * Always logged on error, otherwise only when verbose is enabled.
   */
  providerResponseMeta(response: Response): void {
    const contentType = response.headers.get('content-type') ?? 'unknown';
    const message = `[${this.requestId}] ← Status ${response.status} ${
      response.statusText || ''
    } (${contentType})`.trim();

    if (!response.ok) {
      this.logProviderContext();
      this.ch.error(message);
      this.logResponseBody(response);
      return;
    }

    if (isVerboseEnabled()) {
      this.ch.info(message);
    }
  }

  /**
   * Log a raw response chunk from the provider.
   * Only logged when verbose is enabled.
   */
  providerResponseChunk(data: string): void {
    if (!isVerboseEnabled()) {
      return;
    }
    this.ch.info(`[${this.requestId}] ⇦ ${data}`);
  }

  /**
   * Log a part being sent to VSCode.
   * Only logged when verbose is enabled.
   */
  vscodeOutput(part: vscode.LanguageModelResponsePart2): void {
    if (!isVerboseEnabled()) {
      return;
    }
    this.ch.info(
      `[${this.requestId}] VSCode Output:\n${stringifyForLog(part)}`,
    );
  }

  /**
   * Log verbose information. Only logged when verbose is enabled.
   */
  verbose(message: string): void {
    if (!isVerboseEnabled()) {
      return;
    }
    this.ch.info(`[${this.requestId}] ${message}`);
  }

  /**
   * Log usage information from provider. Always logged.
   * @param usage Raw usage object from provider (will be JSON stringified)
   */
  usage(usage: BetaUsage | CompletionUsage | ResponseUsage): void {
    this.ch.info(`[${this.requestId}] Usage: ${JSON.stringify(usage)}`);

    try {
      if ('cache_read_input_tokens' in usage) {
        const cacheRead = usage.cache_read_input_tokens ?? 0;
        const cacheCreation = usage.cache_creation_input_tokens ?? 0;
        const uncachedInputTokens = usage.input_tokens;
        const totalInput = cacheRead + cacheCreation + uncachedInputTokens;
        const cacheHitRatio =
          totalInput > 0 ? ((cacheRead / totalInput) * 100).toFixed(1) : '0.0';
        this.ch.info(
          `[${this.requestId}] Cache: ${cacheRead} read, ${cacheCreation} created, ${uncachedInputTokens} uncached (${cacheHitRatio}% hit ratio)`,
        );
        return;
      } else if ('input_tokens_details' in usage) {
        const cachedTokens = usage.input_tokens_details.cached_tokens ?? 0;
        const inputTokens = usage.input_tokens;
        const uncachedTokens = Math.max(inputTokens - cachedTokens, 0);
        const cacheHitRatio =
          inputTokens > 0
            ? ((cachedTokens / inputTokens) * 100).toFixed(1)
            : '0.0';

        this.ch.info(
          `[${this.requestId}] Cache: ${cachedTokens} cached, ${uncachedTokens} uncached (${cacheHitRatio}% hit ratio)`,
        );
        return;
      } else if ('total_tokens' in usage) {
        const cachedTokens = usage.prompt_tokens_details?.cached_tokens ?? 0;
        const promptTokens = usage.prompt_tokens;
        const uncachedTokens = Math.max(promptTokens - cachedTokens, 0);
        const cacheHitRatio =
          promptTokens > 0
            ? ((cachedTokens / promptTokens) * 100).toFixed(1)
            : '0.0';

        this.ch.info(
          `[${this.requestId}] Cache: ${cachedTokens} cached, ${uncachedTokens} uncached (${cacheHitRatio}% hit ratio)`,
        );
      } else {
        this.ch.info(
          `[${this.requestId}] Cache: No cache usage data available.`,
        );
      }
    } catch (error) {
      this.ch.info(
        `[${this.requestId}] Cache: Failed to parse cache usage data: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /**
   * Log request completion with performance metrics.
   * Always logged regardless of verbose setting.
   */
  complete(performanceTrace: PerformanceTrace): void {
    const perfInfo = [
      `Time to Fetch: ${performanceTrace.ttf}ms`,
      `Time to First Token: ${performanceTrace.ttft}ms`,
      `Tokens Per Second: ${
        isNaN(performanceTrace.tps)
          ? 'N/A'
          : performanceTrace.tps.toFixed(1) + '/s'
      }`,
      `Total Latency: ${performanceTrace.tl}ms`,
    ].join(', ');

    this.ch.info(`[${this.requestId}] ✓ Request completed | ${perfInfo}`);
    this.providerContext = null;
  }

  /**
   * Log a retry attempt for retryable HTTP status codes.
   * Always logged regardless of verbose setting.
   */
  retry(
    attempt: number,
    maxRetries: number,
    statusCode: number,
    delayMs: number,
  ): void {
    this.ch.warn(
      `[${this.requestId}] ⟳ Retry ${attempt}/${maxRetries} after HTTP ${statusCode}, waiting ${delayMs}ms`,
    );
  }

  /**
   * Log an error that occurred during the request.
   * This logs the provider context if not already logged.
   * Note: This should only be called when NOT re-throwing the error.
   * If re-throwing, let the caller handle error logging.
   */
  error(error: unknown): void {
    this.logProviderContext();
    this.ch.error(`[${this.requestId}] ✕ Error:`);
    this.ch.error(error instanceof Error ? error : String(error));
    this.providerContext = null;
  }

  /**
   * Log the provider context (request details) when an error occurs.
   * Only logs if not already logged.
   */
  private logProviderContext(): void {
    if (!this.providerContext || this.providerContext.logged) {
      return;
    }

    const ctx = this.providerContext;
    this.ch.error(`[${this.requestId}] → ${ctx.method} ${ctx.endpoint}`);
    this.ch.error(
      `[${this.requestId}] Provider Request Headers:\n${JSON.stringify(
        ctx.headers,
        null,
        2,
      )}`,
    );
    this.ch.error(
      `[${this.requestId}] Provider Request Body:\n${JSON.stringify(
        ctx.body,
        null,
        2,
      )}`,
    );
    ctx.logged = true;
  }

  private logResponseBody(response: Response): void {
    try {
      const clone = response.clone();
      void clone.text().then(
        (body) => {
          const trimmed = body.trim();
          if (!trimmed) {
            this.ch.error(
              `[${this.requestId}] Provider Response Body: (empty)`,
            );
            return;
          }

          const parsed = this.tryParseJson(trimmed);
          if (parsed !== undefined) {
            this.ch.error(
              `[${this.requestId}] Provider Response Body (parsed):\n${stringifyForLog(
                parsed,
              )}`,
            );
            return;
          }

          this.ch.error(
            `[${this.requestId}] Provider Response Body (text, ${trimmed.length} chars):\n${trimmed}`,
          );
        },
        (error) => {
          this.ch.error(
            `[${this.requestId}] Provider Response Body: Failed to read payload: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        },
      );
    } catch (error) {
      this.ch.error(
        `[${this.requestId}] Provider Response Body: Unable to clone response: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  private tryParseJson(text: string): unknown | undefined {
    try {
      return JSON.parse(text);
    } catch {
      return undefined;
    }
  }

}

export class SimpleHttpLogger implements ProviderHttpLogger {
  private readonly ch = getChannel();

  constructor(
    public readonly requestId: string,
    private readonly context: {
      purpose: string;
      providerName: string;
      actualApiType: string;
    },
  ) {}

  retry(
    attempt: number,
    maxRetries: number,
    statusCode: number,
    delayMs: number,
  ): void {
    this.ch.warn(
      `[${this.requestId}] ⟳ Retry ${attempt}/${maxRetries} after HTTP ${statusCode}, waiting ${delayMs}ms`,
    );
  }

  providerRequest(details: {
    endpoint: string;
    method?: string;
    headers?: Record<string, string>;
    body?: unknown;
  }): void {
    const method = details.method || 'GET';
    const maskedHeaders = maskSensitiveHeaders(details.headers ?? {});

    this.ch.info(
      `[${this.requestId}] ${this.context.purpose} | Provider: ${this.context.providerName} | API Type: ${this.context.actualApiType} → ${method} ${details.endpoint}`,
    );
    this.ch.info(
      `[${this.requestId}] Headers:\n${stringifyForLog(maskedHeaders)}`,
    );

    const body = details.body ?? null;
    if (body !== null) {
      this.ch.info(`[${this.requestId}] Request:\n${stringifyForLog(body)}`);
    }
  }

  providerResponseMeta(response: Response): void {
    const contentType = response.headers.get('content-type') ?? 'unknown';
    const message = `[${this.requestId}] ← Status ${response.status} ${
      response.statusText || ''
    } (${contentType})`.trim();
    this.ch.info(message);
  }

  providerResponseBody(body: unknown): void {
    this.ch.info(`[${this.requestId}] Response:\n${stringifyForLog(body)}`);
  }

  error(error: unknown): void {
    this.ch.error(`[${this.requestId}] ✕ Error:`);
    this.ch.error(error instanceof Error ? error : String(error));
  }
}

/**
 * Create a new RequestLogger with a unique request ID.
 */
export function createRequestLogger(): RequestLogger {
  const id = `req-${nextRequestId++}`;
  return new RequestLogger(id);
}

export function createSimpleHttpLogger(context: {
  purpose: string;
  providerName: string;
  actualApiType: string;
}): SimpleHttpLogger {
  const id = `http-${nextHttpLogId++}`;
  return new SimpleHttpLogger(id, context);
}

/**
 * Logger for authentication and authorization flows.
 * Helps debug authentication issues by logging key steps.
 *
 * Logging rules:
 * - Errors that are silently handled (not re-thrown) are always logged
 * - Verbose messages are only logged when verbose mode is enabled
 */
export class AuthLogger {
  private static nextAuthLogId = 1;
  private readonly ch = getChannel();
  public readonly id: string;

  constructor(
    private readonly context: {
      providerName: string;
      method: string;
    },
  ) {
    this.id = `auth-${AuthLogger.nextAuthLogId++}`;
  }

  private get prefix(): string {
    return `[${this.id}] [Auth:${this.context.providerName}:${this.context.method}]`;
  }

  /**
   * Log verbose information. Only logged when verbose is enabled.
   */
  verbose(message: string, data?: unknown): void {
    if (!isVerboseEnabled()) {
      return;
    }
    if (data !== undefined) {
      this.ch.info(`${this.prefix} ${message}: ${stringifyForLog(data)}`);
    } else {
      this.ch.info(`${this.prefix} ${message}`);
    }
  }

  /**
   * Log an error that is silently handled (not re-thrown).
   * Always logged regardless of verbose setting.
   */
  error(message: string, error?: unknown): void {
    if (error !== undefined) {
      this.ch.error(`${this.prefix} ${message}:`);
      this.ch.error(error instanceof Error ? error : String(error));
    } else {
      this.ch.error(`${this.prefix} ${message}`);
    }
  }

  /**
   * Log a warning. Always logged regardless of verbose setting.
   */
  warn(message: string): void {
    this.ch.warn(`${this.prefix} ${message}`);
  }
}

/**
 * Logger for secret storage operations.
 */
export class SecretLogger {
  private static nextSecretLogId = 1;
  private readonly ch = getChannel();
  public readonly id: string;

  constructor() {
    this.id = `secret-${SecretLogger.nextSecretLogId++}`;
  }

  private get prefix(): string {
    return `[${this.id}] [Secret]`;
  }

  /**
   * Log verbose information. Only logged when verbose is enabled.
   */
  verbose(message: string): void {
    if (!isVerboseEnabled()) {
      return;
    }
    this.ch.info(`${this.prefix} ${message}`);
  }

  /**
   * Log an error that is silently handled.
   * Always logged regardless of verbose setting.
   */
  error(message: string, error?: unknown): void {
    if (error !== undefined) {
      this.ch.error(`${this.prefix} ${message}:`);
      this.ch.error(error instanceof Error ? error : String(error));
    } else {
      this.ch.error(`${this.prefix} ${message}`);
    }
  }
}

/**
 * Create a new AuthLogger for authentication flows.
 */
export function createAuthLogger(context: {
  providerName: string;
  method: string;
}): AuthLogger {
  return new AuthLogger(context);
}

/**
 * Create a new SecretLogger for secret storage operations.
 */
export function createSecretLogger(): SecretLogger {
  return new SecretLogger();
}

/**
 * Global auth log function for one-off messages.
 * For verbose messages, only logged when verbose is enabled.
 * For error messages, always logged.
 */
export const authLog = {
  verbose(context: string, message: string, data?: unknown): void {
    if (!isVerboseEnabled()) {
      return;
    }
    const ch = getChannel();
    if (data !== undefined) {
      ch.info(`[Auth:${context}] ${message}: ${stringifyForLog(data)}`);
    } else {
      ch.info(`[Auth:${context}] ${message}`);
    }
  },
  error(context: string, message: string, error?: unknown): void {
    const ch = getChannel();
    if (error !== undefined) {
      ch.error(`[Auth:${context}] ${message}:`);
      ch.error(error instanceof Error ? error : String(error));
    } else {
      ch.error(`[Auth:${context}] ${message}`);
    }
  },
  warn(context: string, message: string): void {
    const ch = getChannel();
    ch.warn(`[Auth:${context}] ${message}`);
  },
};

if (isVerboseEnabled()) {
  getChannel().info('Initialized.');
}

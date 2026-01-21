import { getBaseModelId } from '../model-id-utils';
import type { ProviderHttpLogger, RequestLogger } from '../logger';
import * as vscode from 'vscode';
import type { AuthTokenInfo } from '../auth/types';
import { ModelConfig, PerformanceTrace, ProviderConfig } from '../types';
import {
  bodyInitToLoggableValue,
  DEFAULT_CHAT_RETRY_CONFIG,
  DEFAULT_NORMAL_RETRY_CONFIG,
  FetchMode,
  fetchWithRetry,
  headersInitToRecord,
  normalizeBaseUrlInput,
  type RetryConfig,
} from '../utils';
import { FeatureId, FEATURES, API_TYPES } from './definitions';
import { ApiProvider } from './interface';
import { ProviderPattern } from './types';
import { DEFAULT_PROVIDER_TYPE } from '../defaults';

export function createProvider(provider: ProviderConfig): ApiProvider {
  const providerApiType = provider.type ?? DEFAULT_PROVIDER_TYPE;
  const definition = API_TYPES[providerApiType];
  if (!definition) {
    throw new Error(`Unsupported API type: ${providerApiType}`);
  }
  return new definition.class(provider);
}

/**
 * Match a URL against a provider pattern.
 * @param url The URL to match
 * @param pattern The pattern to match against (string with wildcards or RegExp)
 * @returns true if the URL matches the pattern
 */
export function matchProvider(url: string, pattern: ProviderPattern): boolean {
  if (pattern instanceof RegExp) {
    return pattern.test(url);
  }

  const escapeRegExp = (value: string): string =>
    value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  const wildcardToRegExp = (value: string): RegExp => {
    const regexBody = escapeRegExp(value).replace(/\\\*/g, '.*');
    return new RegExp(`^${regexBody}$`);
  };

  const parseUrlLike = (input: string): URL | undefined => {
    try {
      return new URL(input);
    } catch {
      try {
        return new URL(`https://${input}`);
      } catch {
        return undefined;
      }
    }
  };

  const parsedUrl = parseUrlLike(url);
  if (!parsedUrl) {
    return false;
  }

  // Parse string pattern: [protocol?]host[path?]
  const protocolMatch = pattern.match(/^(https?:\/\/)(.*)$/i);
  const rawProtocol = protocolMatch?.[1]?.toLowerCase();
  const requiredProtocol =
    rawProtocol === 'http://'
      ? 'http:'
      : rawProtocol === 'https://'
        ? 'https:'
        : undefined;

  const rest = protocolMatch ? protocolMatch[2] : pattern;
  const slashIndex = rest.indexOf('/');
  const hostPattern = (slashIndex === -1 ? rest : rest.slice(0, slashIndex))
    .trim()
    .toLowerCase();
  const pathPattern = slashIndex === -1 ? undefined : rest.slice(slashIndex);

  // 1) Protocol
  if (requiredProtocol && parsedUrl.protocol !== requiredProtocol) {
    return false;
  }

  // 2) Host (and optional port)
  const hostname = parsedUrl.hostname.toLowerCase();
  const hostWithPort = parsedUrl.port
    ? `${hostname}:${parsedUrl.port}`
    : hostname;

  const hostPatternHasWildcard = hostPattern.includes('*');
  const hostPatternIncludesPort = hostPattern.includes(':');

  const hostTarget = hostPatternIncludesPort ? hostWithPort : hostname;

  const hostMatches = hostPatternHasWildcard
    ? wildcardToRegExp(hostPattern).test(hostTarget)
    : hostPatternIncludesPort
      ? hostWithPort === hostPattern
      : hostname === hostPattern;

  if (!hostMatches) {
    return false;
  }

  // 3) Path
  if (!pathPattern) {
    // Host-only patterns match subpaths.
    return true;
  }

  const urlPath = parsedUrl.pathname;
  if (!pathPattern.includes('*')) {
    return urlPath === pathPattern;
  }

  return wildcardToRegExp(pathPattern).test(urlPath);
}

export function matchModelId(id: string, patterns: string[]): boolean {
  return patterns.some((v) => id.toLowerCase().startsWith(v.toLowerCase()));
}

export function matchModelFamily(family: string, patterns: string[]): boolean {
  return patterns.some((v) => family.toLowerCase().startsWith(v.toLowerCase()));
}

const EXTENSION_ID = 'SmallMain.vscode-unify-chat-provider';
let cachedUnifiedUserAgent: string | undefined;

export function getUnifiedUserAgent(): string {
  if (cachedUnifiedUserAgent) {
    return cachedUnifiedUserAgent;
  }

  const version =
    vscode.extensions.getExtension(EXTENSION_ID)?.packageJSON?.version;

  cachedUnifiedUserAgent =
    typeof version === 'string' && version.trim()
      ? `ucp/${version.trim()}`
      : 'ucp/0.0.0';

  return cachedUnifiedUserAgent;
}

export function setUserAgentHeader(
  headers: Record<string, string | null>,
  userAgent: string,
): void {
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === 'user-agent') {
      return;
    }
  }
  headers['User-Agent'] = userAgent;
}

/**
 * Check if a feature is supported by a specific model and provider.
 * @param featureId The feature ID to check
 * @param model The model configuration
 * @param provider The provider configuration
 * @returns true if the feature is supported
 */
export function isFeatureSupported(
  featureId: FeatureId,
  provider: ProviderConfig,
  model: ModelConfig,
): boolean {
  const feature = FEATURES[featureId];
  if (!feature) {
    return false;
  }

  const {
    supportedModels,
    supportedFamilys,
    customCheckers,
    supportedProviders,
  } = feature;

  // Check custom checkers first - if any returns true, feature is supported
  if (customCheckers?.some((checker) => checker(model, provider))) {
    return true;
  }

  // Check supported providers
  if (
    supportedProviders?.some((pattern) =>
      matchProvider(provider.baseUrl, pattern),
    )
  ) {
    return true;
  }

  // Check supported models
  const baseId = getBaseModelId(model.id);
  if (supportedModels && matchModelId(baseId, supportedModels)) {
    return true;
  }

  // Check supported families
  const family = model.family ?? baseId;
  if (supportedFamilys && matchModelFamily(family, supportedFamilys)) {
    return true;
  }

  return false;
}

/**
 * Build a base URL with optional pattern stripping or suffix ensuring.
 */
export function buildBaseUrl(
  baseUrl: string,
  options?: {
    stripPattern?: RegExp;
    ensureSuffix?: string;
    /** Skip adding ensureSuffix if URL matches this pattern */
    skipSuffixIfMatch?: RegExp;
  },
): string {
  const normalized = normalizeBaseUrlInput(baseUrl);

  if (options?.stripPattern && options.stripPattern.test(normalized)) {
    return normalized.replace(options.stripPattern, '');
  }

  if (options?.ensureSuffix) {
    // Skip if URL already matches the skip pattern (e.g., /v\d+$)
    if (options.skipSuffixIfMatch?.test(normalized)) {
      return normalized;
    }
    if (!normalized.endsWith(options.ensureSuffix)) {
      return `${normalized}${options.ensureSuffix}`;
    }
  }

  return normalized;
}

export function getToken(info: AuthTokenInfo | undefined): string | undefined {
  if (!info || info.kind === 'none') {
    return undefined;
  }
  return info.token;
}

export function getTokenType(
  info: AuthTokenInfo | undefined,
): string | undefined {
  if (!info || info.kind === 'none') {
    return undefined;
  }
  return info.tokenType;
}

/**
 * Merge multiple header objects into one, and resolve placeholders in values.
 */
export function mergeHeaders(
  apiKey: string | undefined,
  ...sources: (Record<string, string> | undefined)[]
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const source of sources) {
    if (source) {
      Object.assign(result, source);
    }
  }

  applyHeaderValuePlaceholders(result, { APIKEY: apiKey });

  return result;
}

const HEADER_VALUE_PLACEHOLDER_PATTERN = /\$\{([A-Z0-9_]+)\}/g;

/**
 * Replace `${VARNAME}` placeholders in header values using provided variables.
 */
export function applyHeaderValuePlaceholders(
  headers: Record<string, string>,
  variables: Record<string, string | undefined>,
): void {
  for (const [key, value] of Object.entries(headers)) {
    const replaced = value.replace(
      HEADER_VALUE_PLACEHOLDER_PATTERN,
      (match: string, variableName: string): string => {
        const replacement = variables[variableName];
        return replacement !== undefined ? replacement : match;
      },
    );
    if (replaced !== value) {
      headers[key] = replaced;
    }
  }
}

/**
 * Estimate token count for text (rough approximation: ~4 characters per token).
 */
export function estimateTokenCount(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Process usage information and update performance trace.
 */
export function processUsage(
  outputTokens: number | undefined,
  performanceTrace: PerformanceTrace,
  logger: RequestLogger,
  usage: Record<string, unknown>,
): void {
  if (outputTokens) {
    performanceTrace.tps =
      (outputTokens /
        (Date.now() - (performanceTrace.tts + performanceTrace.ttf))) *
      1000;
  } else {
    performanceTrace.tps = NaN;
  }
  logger.usage(usage as unknown as Parameters<RequestLogger['usage']>[0]);
}

/**
 * Create a function to record the first token timing.
 */
export function createFirstTokenRecorder(
  performanceTrace: PerformanceTrace,
): () => void {
  let recorded = false;
  return () => {
    if (!recorded) {
      performanceTrace.ttft =
        Date.now() - (performanceTrace.tts + performanceTrace.ttf);
      recorded = true;
    }
  };
}

/**
 * Parse tool arguments from a JSON string.
 * If parsing fails, returns a special object to help the model correct itself.
 */
export function parseToolArguments(
  json: string,
  type: 'feedback' | 'loose' | 'throw' = 'feedback',
): object {
  const trimmed = json.trim();
  if (!trimmed) {
    return {};
  }
  try {
    const parsed = JSON.parse(trimmed);
    if (typeof parsed === 'object' && parsed !== null) {
      return parsed;
    }
    throw new Error('Parsed JSON is not an object');
  } catch (err) {
    switch (type) {
      case 'feedback':
        return {
          INVALID_JSON: json,
        };

      case 'loose':
        return {};

      case 'throw':
        throw new Error(
          `Failed to parse tool arguments JSON: ${(err as Error).message}`,
        );
    }
  }
}

/**
 * Options for creating a custom fetch function.
 */
export interface CreateCustomFetchOptions {
  connectionTimeoutMs: number;
  logger?: ProviderHttpLogger;
  urlTransformer?: (url: string) => string;
  retryConfig?: RetryConfig;
  type: FetchMode;
  /**
   * Optional upstream abort signal (e.g. derived from VSCode CancellationToken).
   * Used as a fallback when the caller does not provide `init.signal`.
   */
  abortSignal?: AbortSignal;
}

/**
 * Create a custom fetch function with logging, retry, and timeout support.
 */
export function createCustomFetch(
  options: CreateCustomFetchOptions,
): typeof fetch {
  const {
    connectionTimeoutMs,
    logger,
    urlTransformer,
    retryConfig,
    type,
    abortSignal,
  } = options;

  const combineAbortSignals = (
    signals: Array<AbortSignal | null | undefined>,
  ): { signal?: AbortSignal; dispose: () => void } => {
    const activeSignals: AbortSignal[] = signals.filter(
      (signal): signal is AbortSignal => signal != null,
    );

    if (activeSignals.length === 0) {
      return { signal: undefined, dispose: () => {} };
    }

    if (activeSignals.length === 1) {
      return { signal: activeSignals[0], dispose: () => {} };
    }

    const alreadyAborted = activeSignals.find((signal) => signal.aborted);
    if (alreadyAborted) {
      return { signal: alreadyAborted, dispose: () => {} };
    }

    const controller = new AbortController();
    const listeners = new Map<AbortSignal, () => void>();

    for (const signal of activeSignals) {
      const onAbort = (): void => {
        controller.abort(signal.reason);
      };
      listeners.set(signal, onAbort);
      signal.addEventListener('abort', onAbort, { once: true });
      // Avoid race: a signal might abort between initial aborted check and listener registration.
      if (signal.aborted) {
        controller.abort(signal.reason);
      }
    }

    const dispose = (): void => {
      for (const [signal, onAbort] of listeners.entries()) {
        signal.removeEventListener('abort', onAbort);
      }
    };

    return { signal: controller.signal, dispose };
  };

  return async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    let url = typeof input === 'string' ? input : input.toString();

    if (urlTransformer) {
      url = urlTransformer(url);
    }

    if (logger) {
      const requestHeaders = headersInitToRecord(init?.headers);
      logger.providerRequest({
        endpoint: url,
        method: init?.method,
        headers: requestHeaders,
        body: bodyInitToLoggableValue(init?.body, requestHeaders),
      });
    }

    const combined = combineAbortSignals([init?.signal, abortSignal]);
    try {
      const response = await fetchWithRetry(url, {
        ...init,
        signal: combined.signal,
        logger,
        retryConfig:
          retryConfig ??
          (type === 'chat'
            ? DEFAULT_CHAT_RETRY_CONFIG
            : DEFAULT_NORMAL_RETRY_CONFIG),
        connectionTimeoutMs,
      });

      if (logger) {
        logger.providerResponseMeta(response);

        if (logger.providerResponseBody) {
          const contentType = response.headers.get('content-type') ?? '';
          const isStreaming =
            contentType.includes('text/event-stream') ||
            contentType.includes('ndjson');
          if (!isStreaming) {
            const cloned = response.clone();
            cloned.json().then(
              (body) => logger.providerResponseBody!(body),
              () => {},
            );
          }
        }
      }

      return response;
    } finally {
      combined.dispose();
    }
  };
}

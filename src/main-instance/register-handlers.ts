import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { MainInstanceError } from './errors';
import { authLog } from '../logger';
import {
  mergePartialFromRecordByKeys,
  MODEL_CONFIG_KEYS,
  withoutKeys,
} from '../config-ops';
import type { AuthConfig, AuthCredential } from '../auth/types';
import type { AuthErrorType } from '../auth/auth-provider';
import type { AuthManager } from '../auth';
import type { BalanceManager } from '../balance';
import type { BalanceConfig } from '../balance/types';
import type {
  OfficialModelsFetchState,
  OfficialModelsManager,
} from '../official-models-manager';
import type { ConfigStore } from '../config-store';
import type { ContextCacheConfig, ProviderConfig } from '../types';
import { mainInstance } from './index';
import { PROVIDER_TYPES, type ProviderType } from '../client/definitions';
import type { ModelConfig, TimeoutConfig } from '../types';
import type { RetryConfig } from '../utils';

type OAuthWaitResult =
  | { type: 'success'; url: string }
  | { type: 'cancel' };

type BalanceRefreshReason =
  | 'periodic'
  | 'post-request-immediate'
  | 'post-request-trailing'
  | 'manual'
  | 'ui';

function parseBalanceRefreshReason(
  value: unknown,
): BalanceRefreshReason | undefined {
  switch (value) {
    case 'periodic':
    case 'post-request-immediate':
    case 'post-request-trailing':
    case 'manual':
    case 'ui':
      return value;
    default:
      return undefined;
  }
}

type ChatOutcome = 'success' | 'error' | 'cancelled';

function parseChatOutcome(value: unknown): ChatOutcome | undefined {
  switch (value) {
    case 'success':
    case 'error':
    case 'cancelled':
      return value;
    default:
      return undefined;
  }
}

type UriWaitParams = {
  path: string;
  expectedState: string;
};

type HttpStartParams = {
  port: number;
  redirectPath: string;
  /**
   * Optional expected state used to disambiguate concurrent sessions on fixed ports.
   * Recommended for fixed-port providers (Codex/Claude/iFlow).
   */
  expectedState?: string;
};

type HttpStartResult = {
  sessionId: string;
  redirectUri: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function requireRecord(value: unknown, method: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new MainInstanceError('BAD_REQUEST', `${method}: params must be an object`);
  }
  return value;
}

function requireString(
  value: unknown,
  method: string,
  field: string,
): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new MainInstanceError('BAD_REQUEST', `${method}: "${field}" must be a non-empty string`);
  }
  return value;
}

function requireNumber(
  value: unknown,
  method: string,
  field: string,
): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new MainInstanceError('BAD_REQUEST', `${method}: "${field}" must be a finite number`);
  }
  return value;
}

function requireStringArray(
  value: unknown,
  method: string,
  field: string,
): string[] {
  if (!Array.isArray(value)) {
    throw new MainInstanceError('BAD_REQUEST', `${method}: "${field}" must be an array`);
  }

  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string' || item.trim() === '') {
      throw new MainInstanceError(
        'BAD_REQUEST',
        `${method}: "${field}" must contain non-empty strings`,
      );
    }
    out.push(item);
  }
  return out;
}

function optionalBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function isProviderType(value: unknown): value is ProviderType {
  return (
    typeof value === 'string' &&
    Object.prototype.hasOwnProperty.call(PROVIDER_TYPES, value)
  );
}

function parseTimeoutConfig(value: unknown): TimeoutConfig | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const connection = value['connection'];
  const response = value['response'];
  const out: TimeoutConfig = {};

  if (typeof connection === 'number' && Number.isFinite(connection) && connection >= 0) {
    out.connection = connection;
  }
  if (typeof response === 'number' && Number.isFinite(response) && response >= 0) {
    out.response = response;
  }

  return out.connection === undefined && out.response === undefined ? undefined : out;
}

function parseRetryConfig(value: unknown): RetryConfig | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const out: RetryConfig = {};
  const maxRetries = value['maxRetries'];
  const initialDelayMs = value['initialDelayMs'];
  const maxDelayMs = value['maxDelayMs'];
  const backoffMultiplier = value['backoffMultiplier'];
  const jitterFactor = value['jitterFactor'];

  if (typeof maxRetries === 'number' && Number.isFinite(maxRetries) && maxRetries >= 0) {
    out.maxRetries = maxRetries;
  }
  if (
    typeof initialDelayMs === 'number' &&
    Number.isFinite(initialDelayMs) &&
    initialDelayMs >= 0
  ) {
    out.initialDelayMs = initialDelayMs;
  }
  if (typeof maxDelayMs === 'number' && Number.isFinite(maxDelayMs) && maxDelayMs >= 0) {
    out.maxDelayMs = maxDelayMs;
  }
  if (
    typeof backoffMultiplier === 'number' &&
    Number.isFinite(backoffMultiplier) &&
    backoffMultiplier >= 0
  ) {
    out.backoffMultiplier = backoffMultiplier;
  }
  if (typeof jitterFactor === 'number' && Number.isFinite(jitterFactor) && jitterFactor >= 0) {
    out.jitterFactor = jitterFactor;
  }

  return Object.keys(out).length === 0 ? undefined : out;
}

function parseContextCacheConfig(value: unknown): ContextCacheConfig | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const type = value['type'];
  const ttl = value['ttl'];
  const out: ContextCacheConfig = {};

  if (type === 'only-free' || type === 'allow-paid') {
    out.type = type;
  }
  if (typeof ttl === 'number' && Number.isFinite(ttl) && ttl >= 0) {
    out.ttl = ttl;
  }

  return out.type === undefined && out.ttl === undefined ? undefined : out;
}

function parseStringRecord(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw === 'string') {
      out[key] = raw;
    }
  }
  return Object.keys(out).length === 0 ? undefined : out;
}

function parseModels(value: unknown): ModelConfig[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const out: ModelConfig[] = [];
  for (const item of value) {
    const parsed = parseModelConfig(item);
    if (parsed) {
      out.push(parsed);
    }
  }
  return out;
}

function parseModelConfig(value: unknown): ModelConfig | null {
  if (typeof value === 'string' && value.trim() !== '') {
    return { id: value };
  }

  if (!isRecord(value)) {
    return null;
  }

  const id = value['id'];
  if (typeof id !== 'string' || id.trim() === '') {
    return null;
  }

  const model: ModelConfig = { id };
  mergePartialFromRecordByKeys(
    model,
    value,
    withoutKeys(MODEL_CONFIG_KEYS, ['id'] as const),
  );

  const extraHeaders = parseStringRecord(model.extraHeaders);
  if (extraHeaders) {
    model.extraHeaders = extraHeaders;
  } else {
    delete model.extraHeaders;
  }

  if (!isRecord(model.extraBody)) {
    delete model.extraBody;
  }

  return model;
}

function parseProviderConfig(value: unknown, method: string): ProviderConfig {
  const record = requireRecord(value, method);

  const typeRaw = record['type'];
  if (!isProviderType(typeRaw)) {
    throw new MainInstanceError('BAD_REQUEST', `${method}: invalid provider.type`);
  }

  const name = requireString(record['name'], method, 'provider.name');
  const baseUrl = requireString(record['baseUrl'], method, 'provider.baseUrl');

  const authConfig = record['authConfig'] ?? record['auth'];
  const auth =
    isRecord(authConfig) && typeof authConfig['method'] === 'string'
      ? (authConfig as unknown as AuthConfig)
      : undefined;

  const balanceProvider =
    isRecord(record['balanceProvider']) &&
    typeof record['balanceProvider']['method'] === 'string'
      ? (record['balanceProvider'] as unknown as BalanceConfig)
      : undefined;
  const extraHeaders = parseStringRecord(record['extraHeaders']);
  const timeout = parseTimeoutConfig(record['timeout']);
  const retry = parseRetryConfig(record['retry']);
  const contextCache = parseContextCacheConfig(record['contextCache']);

  return {
    type: typeRaw,
    name,
    baseUrl,
    models: parseModels(record['models']),
    ...(auth ? { auth } : {}),
    ...(balanceProvider ? { balanceProvider } : {}),
    ...(extraHeaders ? { extraHeaders } : {}),
    ...(isRecord(record['extraBody']) ? { extraBody: record['extraBody'] as Record<string, unknown> } : {}),
    ...(timeout ? { timeout } : {}),
    ...(retry ? { retry } : {}),
    ...(typeof record['autoFetchOfficialModels'] === 'boolean'
      ? { autoFetchOfficialModels: record['autoFetchOfficialModels'] }
      : {}),
    ...(contextCache ? { contextCache } : {}),
  };
}

function parseOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function parseOptionalFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function parseAuthConfig(value: unknown, method: string): AuthConfig {
  const record = requireRecord(value, method);
  requireString(record['method'], method, 'authConfig.method');
  return record as unknown as AuthConfig;
}

function resolveCurrentProvidersByNames(options: {
  configStore: ConfigStore;
  providerNames?: readonly string[];
}): ProviderConfig[] {
  if (!options.providerNames) {
    return options.configStore.endpoints;
  }

  const resolved: ProviderConfig[] = [];
  const seen = new Set<string>();
  for (const providerName of options.providerNames) {
    if (seen.has(providerName)) {
      continue;
    }
    seen.add(providerName);
    const provider = options.configStore.getProvider(providerName);
    if (provider) {
      resolved.push(provider);
    }
  }
  return resolved;
}

function parseOfficialModelsFetchState(
  value: unknown,
  method: string,
): OfficialModelsFetchState {
  const record = requireRecord(value, method);
  const lastFetchTime = requireNumber(
    record['lastFetchTime'],
    method,
    'state.lastFetchTime',
  );
  const modelsHash = requireString(
    record['modelsHash'],
    method,
    'state.modelsHash',
  );
  const consecutiveIdenticalFetches = requireNumber(
    record['consecutiveIdenticalFetches'],
    method,
    'state.consecutiveIdenticalFetches',
  );
  const currentIntervalMs = requireNumber(
    record['currentIntervalMs'],
    method,
    'state.currentIntervalMs',
  );
  const lastAttemptTime = parseOptionalFiniteNumber(record['lastAttemptTime']);
  const consecutiveErrorFetches = parseOptionalFiniteNumber(
    record['consecutiveErrorFetches'],
  );
  const currentErrorIntervalMs = parseOptionalFiniteNumber(
    record['currentErrorIntervalMs'],
  );
  const lastError = parseOptionalString(record['lastError']);
  const lastErrorTime = parseOptionalFiniteNumber(record['lastErrorTime']);
  const isFetching = optionalBoolean(record['isFetching']);

  const signatureValue = record['lastConfigSignature'];
  let lastConfigSignature: OfficialModelsFetchState['lastConfigSignature'];
  if (signatureValue !== undefined) {
    const signature = requireRecord(signatureValue, method);
    lastConfigSignature = {
      type: requireString(
        signature['type'],
        method,
        'state.lastConfigSignature.type',
      ),
      baseUrl: requireString(
        signature['baseUrl'],
        method,
        'state.lastConfigSignature.baseUrl',
      ),
      authMethod: requireString(
        signature['authMethod'],
        method,
        'state.lastConfigSignature.authMethod',
      ),
      authHash: requireString(
        signature['authHash'],
        method,
        'state.lastConfigSignature.authHash',
      ),
      extraHeadersHash: requireString(
        signature['extraHeadersHash'],
        method,
        'state.lastConfigSignature.extraHeadersHash',
      ),
      extraBodyHash: requireString(
        signature['extraBodyHash'],
        method,
        'state.lastConfigSignature.extraBodyHash',
      ),
    };
  }

  return {
    lastFetchTime,
    models: parseModels(record['models']),
    modelsHash,
    consecutiveIdenticalFetches,
    currentIntervalMs,
    ...(lastAttemptTime !== undefined ? { lastAttemptTime } : {}),
    ...(consecutiveErrorFetches !== undefined
      ? { consecutiveErrorFetches }
      : {}),
    ...(currentErrorIntervalMs !== undefined ? { currentErrorIntervalMs } : {}),
    ...(lastError !== undefined ? { lastError } : {}),
    ...(lastErrorTime !== undefined ? { lastErrorTime } : {}),
    ...(lastConfigSignature ? { lastConfigSignature } : {}),
    ...(isFetching !== undefined ? { isFetching } : {}),
  };
}

function parseUrlOrNull(raw: string): URL | null {
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

function renderHtml(text: string): string {
  const escaped = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

  return `<!doctype html><html><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width,initial-scale=1" /><title>Authentication</title></head><body style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;padding:24px;"><h2>${escaped}</h2></body></html>`;
}

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
};

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;

  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  return { promise, resolve, reject };
}

type UriWaiter = {
  path: string;
  deferred: Deferred<OAuthWaitResult>;
};

type BufferedUriCallback = {
  path: string;
  url: string;
};

function isSuccessfulOAuthCallback(url: URL): boolean {
  const error = url.searchParams.get('error')?.trim();
  if (error) {
    return false;
  }

  const code = url.searchParams.get('code')?.trim();
  const state = url.searchParams.get('state')?.trim();
  return !!code && !!state;
}

function respondWithOAuthCallbackHtml(
  res: ServerResponse,
  url: URL,
): void {
  const success = isSuccessfulOAuthCallback(url);
  res.statusCode = success ? 200 : 400;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(
    renderHtml(
      success
        ? 'Authentication complete. You may close this tab.'
        : 'Authentication failed. You may close this tab.',
    ),
  );
}

class OAuthUriWaitRegistry {
  private readonly waitersByState = new Map<string, UriWaiter>();
  private readonly bufferedCallbacksByState = new Map<string, BufferedUriCallback>();

  notify(uriString: string): void {
    const uri = parseUrlOrNull(uriString);
    if (!uri) {
      return;
    }

    const state = uri.searchParams.get('state')?.trim();
    if (!state) {
      return;
    }

    const waiter = this.waitersByState.get(state);
    if (!waiter) {
      this.bufferedCallbacksByState.set(state, {
        path: uri.pathname,
        url: uriString,
      });
      return;
    }

    if (uri.pathname !== waiter.path) {
      return;
    }

    this.waitersByState.delete(state);
    waiter.deferred.resolve({ type: 'success', url: uriString });
  }

  wait(params: UriWaitParams, signal: AbortSignal): Promise<OAuthWaitResult> {
    const existing = this.waitersByState.get(params.expectedState);
    if (existing) {
      existing.deferred.resolve({ type: 'cancel' });
      this.waitersByState.delete(params.expectedState);
    }

    const buffered = this.bufferedCallbacksByState.get(params.expectedState);
    if (buffered && buffered.path === params.path) {
      this.bufferedCallbacksByState.delete(params.expectedState);
      return Promise.resolve({ type: 'success', url: buffered.url });
    }

    const deferred = createDeferred<OAuthWaitResult>();
    this.waitersByState.set(params.expectedState, {
      path: params.path,
      deferred,
    });

    const onAbort = (): void => {
      this.cancel(params.expectedState);
    };
    if (signal.aborted) {
      onAbort();
    } else {
      signal.addEventListener('abort', onAbort, { once: true });
      void deferred.promise.finally(() => {
        signal.removeEventListener('abort', onAbort);
      });
    }

    return deferred.promise;
  }

  cancel(expectedState: string): void {
    const waiter = this.waitersByState.get(expectedState);
    if (!waiter) {
      this.bufferedCallbacksByState.delete(expectedState);
      return;
    }
    this.waitersByState.delete(expectedState);
    this.bufferedCallbacksByState.delete(expectedState);
    waiter.deferred.resolve({ type: 'cancel' });
  }
}

type HttpSession = {
  sessionId: string;
  server: HttpServer;
  redirectUri: string;
  redirectPath: string;
  expectedState?: string;
  deferred: Deferred<OAuthWaitResult>;
};

type SharedFixedServer = {
  server: HttpServer;
  origin: string;
  port: number;
  redirectPath: string;
  sessionsByState: Map<string, HttpSession>;
  closePromise?: Promise<void>;
};

class OAuthHttpSessionRegistry {
  private readonly sessionsById = new Map<string, HttpSession>();
  private readonly fixedServers = new Map<string, SharedFixedServer>();

  private closeSharedFixedServer(
    key: string,
    shared: SharedFixedServer,
  ): Promise<void> {
    if (shared.closePromise) {
      return shared.closePromise;
    }

    shared.closePromise = new Promise<void>((resolve) => {
      shared.server.close(() => {
        if (this.fixedServers.get(key) === shared) {
          this.fixedServers.delete(key);
        }
        shared.closePromise = undefined;
        resolve();
      });
    });

    return shared.closePromise;
  }

  private finishFixedSession(options: {
    key: string;
    shared: SharedFixedServer;
    session: HttpSession;
    result: OAuthWaitResult;
  }): void {
    if (options.session.expectedState) {
      options.shared.sessionsByState.delete(options.session.expectedState);
    }
    options.session.deferred.resolve(options.result);

    if (options.shared.sessionsByState.size === 0) {
      void this.closeSharedFixedServer(options.key, options.shared);
    }
  }

  async start(params: HttpStartParams): Promise<HttpStartResult> {
    const port = params.port;
    const redirectPath = params.redirectPath;

    if (!Number.isInteger(port) || port < 0 || port > 65535) {
      throw new MainInstanceError('BAD_REQUEST', 'oauth.http.start: invalid port');
    }
    if (!redirectPath.startsWith('/')) {
      throw new MainInstanceError('BAD_REQUEST', 'oauth.http.start: redirectPath must start with "/"');
    }

    if (port === 0) {
      return await this.startRandomPort({ redirectPath });
    }

    const expectedState = params.expectedState?.trim();
    if (!expectedState) {
      throw new MainInstanceError(
        'BAD_REQUEST',
        'oauth.http.start: expectedState is required for fixed ports',
      );
    }

    return await this.startFixedPort({ port, redirectPath, expectedState });
  }

  private async startRandomPort(options: {
    redirectPath: string;
  }): Promise<HttpStartResult> {
    const sessionId = randomUUID();
    const deferred = createDeferred<OAuthWaitResult>();

    let origin = 'http://127.0.0.1';
    const server = createServer((req, res) => {
      this.handleHttpRequest({
        req,
        res,
        origin,
        redirectPath: options.redirectPath,
        onMatch: (url) => {
          deferred.resolve({ type: 'success', url });
          server.close();
        },
      });
    });

    const tryListen = async (host: string): Promise<{ origin: string } | null> => {
      try {
        await new Promise<void>((resolve, reject) => {
          const onError = (error: unknown): void => {
            server.off('error', onError);
            reject(error instanceof Error ? error : new Error(String(error)));
          };
          server.once('error', onError);
          server.listen(0, host, () => {
            server.off('error', onError);
            resolve();
          });
        });

        const address = server.address();
        const info =
          address && typeof address === 'object' && 'port' in address
            ? (address as AddressInfo)
            : undefined;
        if (!info) {
          throw new Error('Failed to resolve callback port');
        }

        const hostForUrl = host === '::1' ? '[::1]' : host;
        return { origin: `http://${hostForUrl}:${info.port}` };
      } catch {
        return null;
      }
    };

    const listener =
      (await tryListen('127.0.0.1')) ?? (await tryListen('::1'));
    if (!listener) {
      server.close();
      throw new MainInstanceError('PORT_IN_USE', 'Failed to start OAuth callback server');
    }

    origin = listener.origin;
    const redirectUri = `${origin}${options.redirectPath}`;

    const session: HttpSession = {
      sessionId,
      server,
      redirectUri,
      redirectPath: options.redirectPath,
      deferred,
    };
    this.sessionsById.set(sessionId, session);

    server.on('error', (error) => {
      this.sessionsById.delete(sessionId);
      deferred.reject(error instanceof Error ? error : new Error(String(error)));
    });

    return { sessionId, redirectUri };
  }

  private async startFixedPort(options: {
    port: number;
    redirectPath: string;
    expectedState: string;
  }): Promise<HttpStartResult> {
    const key = `localhost:${options.port}${options.redirectPath}`;
    let shared = this.fixedServers.get(key);

    if (shared?.closePromise) {
      await shared.closePromise;
      shared = this.fixedServers.get(key);
    }

    if (!shared) {
      const server = createServer((req, res) => {
        const reqUrl = req.url ?? '';
        const parsed = parseUrlOrNull(`${shared!.origin}${reqUrl}`);
        if (!parsed) {
          res.statusCode = 400;
          res.setHeader('Content-Type', 'text/plain; charset=utf-8');
          res.end('Bad Request');
          return;
        }

        if (parsed.pathname === '/cancel') {
          const requestedState = parsed.searchParams.get('state')?.trim();
          const session = requestedState
            ? shared!.sessionsByState.get(requestedState)
            : shared!.sessionsByState.size === 1
              ? shared!.sessionsByState.values().next().value
              : undefined;

          if (!session) {
            res.statusCode = 404;
            res.setHeader('Content-Type', 'text/plain; charset=utf-8');
            res.end('Unknown session');
            return;
          }

          res.statusCode = 200;
          res.setHeader('Content-Type', 'text/html; charset=utf-8');
          res.end(renderHtml('Authentication cancelled. You may close this tab.'));

          this.finishFixedSession({
            key,
            shared: shared!,
            session,
            result: { type: 'cancel' },
          });
          return;
        }

        if (parsed.pathname !== options.redirectPath) {
          res.statusCode = 404;
          res.setHeader('Content-Type', 'text/plain; charset=utf-8');
          res.end('Not Found');
          return;
        }

        const state = parsed.searchParams.get('state')?.trim();
        if (!state) {
          res.statusCode = 400;
          res.setHeader('Content-Type', 'text/plain; charset=utf-8');
          res.end('Missing state');
          return;
        }

        const session = shared!.sessionsByState.get(state);
        if (!session) {
          res.statusCode = 404;
          res.setHeader('Content-Type', 'text/plain; charset=utf-8');
          res.end('Unknown session');
          return;
        }

        const fullUrl = parsed.toString();
        respondWithOAuthCallbackHtml(res, parsed);

        this.finishFixedSession({
          key,
          shared: shared!,
          session,
          result: { type: 'success', url: fullUrl },
        });
      });

      try {
        await new Promise<void>((resolve, reject) => {
          server.once('error', reject);
          server.listen(options.port, 'localhost', () => {
            server.off('error', reject);
            resolve();
          });
        });
      } catch (error) {
        server.close();
        throw new MainInstanceError(
          'PORT_IN_USE',
          error instanceof Error ? error.message : 'Port is in use',
        );
      }

      const origin = `http://localhost:${options.port}`;
      shared = {
        server,
        origin,
        port: options.port,
        redirectPath: options.redirectPath,
        sessionsByState: new Map<string, HttpSession>(),
      };
      this.fixedServers.set(key, shared);
    }

    const sessionId = randomUUID();
    const deferred = createDeferred<OAuthWaitResult>();
    const redirectUri = `${shared.origin}${options.redirectPath}`;
    const session: HttpSession = {
      sessionId,
      server: shared.server,
      redirectUri,
      redirectPath: options.redirectPath,
      expectedState: options.expectedState,
      deferred,
    };

    shared.sessionsByState.set(options.expectedState, session);
    this.sessionsById.set(sessionId, session);

    return { sessionId, redirectUri };
  }

  async wait(sessionId: string, signal: AbortSignal): Promise<OAuthWaitResult> {
    const session = this.sessionsById.get(sessionId);
    if (!session) {
      throw new MainInstanceError('BAD_REQUEST', 'oauth.http.wait: unknown sessionId');
    }

    const onAbort = (): void => {
      this.cancel(sessionId);
    };

    if (signal.aborted) {
      onAbort();
    } else {
      signal.addEventListener('abort', onAbort, { once: true });
      void session.deferred.promise.finally(() => {
        signal.removeEventListener('abort', onAbort);
      });
    }

    try {
      return await session.deferred.promise;
    } finally {
      if (this.sessionsById.get(sessionId) === session) {
        this.sessionsById.delete(sessionId);
      }
    }
  }

  cancel(sessionId: string): void {
    const session = this.sessionsById.get(sessionId);
    if (!session) {
      return;
    }
    this.sessionsById.delete(sessionId);

    if (session.expectedState) {
      const key = `localhost:${new URL(session.redirectUri).port}${session.redirectPath}`;
      const shared = this.fixedServers.get(key);
      shared?.sessionsByState.delete(session.expectedState);
      if (shared && shared.sessionsByState.size === 0) {
        void this.closeSharedFixedServer(key, shared);
      }
    } else {
      session.server.close();
    }

    session.deferred.resolve({ type: 'cancel' });
  }

  private handleHttpRequest(options: {
    req: IncomingMessage;
    res: ServerResponse;
    origin: string;
    redirectPath: string;
    onMatch: (url: string) => void;
  }): void {
    const reqUrl = options.req.url ?? '';
    const parsed = parseUrlOrNull(`${options.origin}${reqUrl}`);
    if (!parsed || parsed.pathname !== options.redirectPath) {
      options.res.statusCode = 404;
      options.res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      options.res.end('Not Found');
      return;
    }

    respondWithOAuthCallbackHtml(options.res, parsed);
    options.onMatch(parsed.toString());
  }
}

type AuthErrorSnapshot = {
  message: string;
  errorType: AuthErrorType;
};

function serializeAuthCredential(
  credential: AuthCredential | undefined,
): AuthCredential | undefined {
  if (!credential) {
    return undefined;
  }
  const value = credential.value?.trim();
  if (!value) {
    return undefined;
  }
  return {
    value,
    tokenType: credential.tokenType,
    expiresAt: credential.expiresAt,
  };
}

export function registerMainInstanceHandlers(options: {
  configStore: ConfigStore;
  authManager: AuthManager;
  balanceManager: BalanceManager;
  officialModelsManager: OfficialModelsManager;
}): void {
  const uriRegistry = new OAuthUriWaitRegistry();
  const httpRegistry = new OAuthHttpSessionRegistry();

  mainInstance.registerHandler('oauth.uri.notify', async (params) => {
    const p = requireRecord(params, 'oauth.uri.notify');
    const uri = requireString(p['uri'], 'oauth.uri.notify', 'uri');
    uriRegistry.notify(uri);
    return { ok: true };
  });

  mainInstance.registerHandler('oauth.uri.wait', async (params, ctx) => {
    const p = requireRecord(params, 'oauth.uri.wait');
    const path = requireString(p['path'], 'oauth.uri.wait', 'path');
    const expectedState = requireString(
      p['expectedState'],
      'oauth.uri.wait',
      'expectedState',
    );
    return await uriRegistry.wait({ path, expectedState }, ctx.signal);
  });

  mainInstance.registerHandler('oauth.uri.cancel', async (params) => {
    const p = requireRecord(params, 'oauth.uri.cancel');
    const expectedState = requireString(
      p['expectedState'],
      'oauth.uri.cancel',
      'expectedState',
    );
    uriRegistry.cancel(expectedState);
    return { ok: true };
  });

  mainInstance.registerHandler('oauth.http.start', async (params) => {
    const p = requireRecord(params, 'oauth.http.start');
    const port = requireNumber(p['port'], 'oauth.http.start', 'port');
    const redirectPath = requireString(
      p['redirectPath'],
      'oauth.http.start',
      'redirectPath',
    );
    const expectedStateRaw = p['expectedState'];
    const expectedState =
      typeof expectedStateRaw === 'string' ? expectedStateRaw.trim() : undefined;

    return await httpRegistry.start({ port, redirectPath, expectedState });
  });

  mainInstance.registerHandler('oauth.http.wait', async (params, ctx) => {
    const p = requireRecord(params, 'oauth.http.wait');
    const sessionId = requireString(
      p['sessionId'],
      'oauth.http.wait',
      'sessionId',
    );
    return await httpRegistry.wait(sessionId, ctx.signal);
  });

  mainInstance.registerHandler('oauth.http.cancel', async (params) => {
    const p = requireRecord(params, 'oauth.http.cancel');
    const sessionId = requireString(
      p['sessionId'],
      'oauth.http.cancel',
      'sessionId',
    );
    httpRegistry.cancel(sessionId);
    return { ok: true };
  });

  mainInstance.registerHandler('auth.getCredential', async (params) => {
    const p = requireRecord(params, 'auth.getCredential');
    const providerName = requireString(
      p['providerName'],
      'auth.getCredential',
      'providerName',
    );
    const reasonRaw = p['reason'];
    const reason =
      reasonRaw === 'background' || reasonRaw === 'user' ? reasonRaw : 'user';
    const credential = await options.authManager.getCredential(
      providerName,
      reason,
    );
    const lastError = options.authManager.getLastError(providerName);
    const errorSnapshot: AuthErrorSnapshot | undefined = lastError
      ? { message: lastError.error.message, errorType: lastError.errorType }
      : undefined;

    return {
      credential: serializeAuthCredential(credential),
      lastError: errorSnapshot,
    };
  });

  mainInstance.registerHandler('auth.retryRefresh', async (params) => {
    const p = requireRecord(params, 'auth.retryRefresh');
    const providerName = requireString(
      p['providerName'],
      'auth.retryRefresh',
      'providerName',
    );
    const ok = await options.authManager.retryRefresh(providerName);
    const lastError = options.authManager.getLastError(providerName);
    const errorSnapshot: AuthErrorSnapshot | undefined = lastError
      ? { message: lastError.error.message, errorType: lastError.errorType }
      : undefined;
    return { ok, lastError: errorSnapshot };
  });

  mainInstance.registerHandler('auth.syncPersistedAuthConfig', async (params) => {
    const p = requireRecord(params, 'auth.syncPersistedAuthConfig');
    const providerName = requireString(
      p['providerName'],
      'auth.syncPersistedAuthConfig',
      'providerName',
    );
    const authConfig = parseAuthConfig(
      p['authConfig'],
      'auth.syncPersistedAuthConfig',
    );
    await options.authManager.syncPersistedAuthConfig(providerName, authConfig);
    return { ok: true };
  });

  mainInstance.registerHandler('config.syncPersistedProvider', async (params) => {
    const p = requireRecord(params, 'config.syncPersistedProvider');
    const provider = parseProviderConfig(
      p['provider'],
      'config.syncPersistedProvider',
    );
    const originalNameValue = p['originalName'];
    if (
      originalNameValue !== undefined &&
      (typeof originalNameValue !== 'string' || originalNameValue.trim() === '')
    ) {
      throw new MainInstanceError(
        'BAD_REQUEST',
        'config.syncPersistedProvider: "originalName" must be a non-empty string',
      );
    }
    if (typeof originalNameValue === 'string') {
      options.authManager.clearProvider(originalNameValue);
    }
    options.authManager.clearProvider(provider.name);
    if (
      typeof originalNameValue === 'string' &&
      originalNameValue !== provider.name
    ) {
      await options.configStore.removeProvider(originalNameValue);
    }
    await options.configStore.upsertProvider(provider);
    return { ok: true };
  });

  mainInstance.registerHandler('balance.forceRefresh', async (params) => {
    const p = requireRecord(params, 'balance.forceRefresh');
    const providerName = requireString(
      p['providerName'],
      'balance.forceRefresh',
      'providerName',
    );
    await options.balanceManager.forceRefresh(providerName);
    return { ok: true };
  });

  mainInstance.registerHandler('balance.forceRefreshAll', async (params) => {
    const p = requireRecord(params, 'balance.forceRefreshAll');
    const providerNamesValue = p['providerNames'];
    const providerNames =
      providerNamesValue === undefined
        ? undefined
        : requireStringArray(
            providerNamesValue,
            'balance.forceRefreshAll',
            'providerNames',
          );
    const providers = resolveCurrentProvidersByNames({
      configStore: options.configStore,
      providerNames,
    });
    const count = await options.balanceManager.forceRefreshAll(providers);
    return { count };
  });

  mainInstance.registerHandler('balance.requestRefresh', async (params) => {
    const p = requireRecord(params, 'balance.requestRefresh');
    const providerName = requireString(
      p['providerName'],
      'balance.requestRefresh',
      'providerName',
    );
    const reason = parseBalanceRefreshReason(p['reason']) ?? 'manual';
    options.balanceManager.requestRefresh(providerName, reason);
    return { ok: true };
  });

  mainInstance.registerHandler('balance.notifyChatRequestStarted', async (params) => {
    const p = requireRecord(params, 'balance.notifyChatRequestStarted');
    const providerName = requireString(
      p['providerName'],
      'balance.notifyChatRequestStarted',
      'providerName',
    );
    options.balanceManager.notifyChatRequestStarted(providerName);
    return { ok: true };
  });

  mainInstance.registerHandler('balance.notifyChatRequestFinished', async (params) => {
    const p = requireRecord(params, 'balance.notifyChatRequestFinished');
    const providerName = requireString(
      p['providerName'],
      'balance.notifyChatRequestFinished',
      'providerName',
    );
    const outcome = parseChatOutcome(p['outcome']);
    if (!outcome) {
      throw new MainInstanceError(
        'BAD_REQUEST',
        'balance.notifyChatRequestFinished: invalid outcome',
      );
    }
    options.balanceManager.notifyChatRequestFinished(providerName, outcome);
    return { ok: true };
  });

  mainInstance.registerHandler('balance.getSnapshot', async () => {
    return options.balanceManager.getSnapshotForFollowers();
  });

  mainInstance.registerHandler('officialModels.getOfficialModels', async (params) => {
    const p = requireRecord(params, 'officialModels.getOfficialModels');
    const forceFetch = optionalBoolean(p['forceFetch']) ?? false;
    const providerName = requireString(
      p['providerName'],
      'officialModels.getOfficialModels',
      'providerName',
    );
    const provider = options.configStore.getProvider(providerName);
    if (!provider) {
      return { models: [], state: undefined };
    }

    const models = await options.officialModelsManager.getOfficialModels(
      provider,
      forceFetch,
    );
    const state = options.officialModelsManager.getProviderState(provider.name);
    return { models, state };
  });

  mainInstance.registerHandler('officialModels.triggerBackgroundFetch', async (params) => {
    const p = requireRecord(params, 'officialModels.triggerBackgroundFetch');
    const providerName = requireString(
      p['providerName'],
      'officialModels.triggerBackgroundFetch',
      'providerName',
    );
    const provider = options.configStore.getProvider(providerName);
    if (!provider) {
      return { ok: false };
    }
    options.officialModelsManager.triggerBackgroundFetch(provider);
    return { ok: true };
  });

  mainInstance.registerHandler('officialModels.refreshAll', async (params) => {
    const p = requireRecord(params, 'officialModels.refreshAll');
    const providerNamesValue = p['providerNames'];
    const providerNames =
      providerNamesValue === undefined
        ? undefined
        : requireStringArray(
            providerNamesValue,
            'officialModels.refreshAll',
            'providerNames',
          );
    const providers = resolveCurrentProvidersByNames({
      configStore: options.configStore,
      providerNames,
    });
    const count = await options.officialModelsManager.refreshAll(providers);
    return { count };
  });

  mainInstance.registerHandler('officialModels.clearProviderState', async (params) => {
    const p = requireRecord(params, 'officialModels.clearProviderState');
    const providerName = requireString(
      p['providerName'],
      'officialModels.clearProviderState',
      'providerName',
    );
    await options.officialModelsManager.clearProviderState(providerName);
    return { ok: true };
  });

  mainInstance.registerHandler('officialModels.applyProviderState', async (params) => {
    const p = requireRecord(params, 'officialModels.applyProviderState');
    const providerName = requireString(
      p['providerName'],
      'officialModels.applyProviderState',
      'providerName',
    );
    const state = parseOfficialModelsFetchState(
      p['state'],
      'officialModels.applyProviderState',
    );
    return await options.officialModelsManager.applyProviderStateFromSync(
      providerName,
      state,
    );
  });

  mainInstance.registerHandler('officialModels.getSnapshot', async () => {
    return options.officialModelsManager.getSnapshotForFollowers();
  });

  authLog.verbose('main-instance', 'Registered main-instance RPC handlers');
}

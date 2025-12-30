import { AsyncLocalStorage } from 'node:async_hooks';
import type { ProviderHttpLogger } from '../../logger';
import { bodyInitToLoggableValue, headersInitToRecord } from '../../utils';

type FetchLoggerContext = {
  logger: ProviderHttpLogger;
};

const fetchLoggerContext = new AsyncLocalStorage<FetchLoggerContext>();

let isInstalled = false;
let originalFetch: typeof fetch | undefined;

function getEndpoint(input: RequestInfo | URL): string {
  if (typeof input === 'string') {
    return input;
  }
  if (input instanceof URL) {
    return input.toString();
  }
  if (typeof Request !== 'undefined' && input instanceof Request) {
    return input.url;
  }
  return input.toString();
}

function ensureInstalled(): void {
  if (isInstalled) {
    return;
  }

  if (typeof fetch !== 'function') {
    throw new Error('Global fetch is not available; cannot enable HTTP logging');
  }

  originalFetch = fetch;

  const wrappedFetch: typeof fetch = async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const baseFetch = originalFetch;
    if (!baseFetch) {
      throw new Error(
        'Global fetch wrapper not initialized correctly (missing original fetch)',
      );
    }

    const ctx = fetchLoggerContext.getStore();
    if (!ctx) {
      return baseFetch(input, init);
    }

    const endpoint = getEndpoint(input);
    const headersInit: HeadersInit | undefined =
      init?.headers ??
      (typeof Request !== 'undefined' && input instanceof Request
        ? input.headers
        : undefined);
    const requestHeaders = headersInitToRecord(headersInit);
    const method =
      init?.method ??
      (typeof Request !== 'undefined' && input instanceof Request
        ? input.method
        : undefined);

    ctx.logger.providerRequest({
      endpoint,
      method,
      headers: requestHeaders,
      body: bodyInitToLoggableValue(init?.body, requestHeaders),
    });

    const response = await baseFetch(input, init);

    ctx.logger.providerResponseMeta(response);

    if (ctx.logger.providerResponseBody) {
      const contentType = response.headers.get('content-type') ?? '';
      const isStreaming =
        contentType.includes('text/event-stream') ||
        contentType.includes('ndjson');
      if (!isStreaming) {
        const cloned = response.clone();
        cloned.json().then(
          (body) => ctx.logger.providerResponseBody?.(body),
          () => {},
        );
      }
    }

    return response;
  };

  Object.defineProperty(globalThis, 'fetch', {
    value: wrappedFetch,
    configurable: true,
    writable: true,
  });

  isInstalled = true;
}

export async function withGoogleFetchLogger<T>(
  logger: ProviderHttpLogger,
  fn: () => Promise<T>,
): Promise<T> {
  ensureInstalled();
  return fetchLoggerContext.run({ logger }, fn);
}

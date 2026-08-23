import type { AuthTokenInfo } from '../auth/types';
import {
  createCustomFetch,
  getToken,
  getTokenType,
  getUnifiedUserAgent,
  mergeHeaders,
  setUserAgentHeader,
} from '../client/utils';
import { createSimpleHttpLogger } from '../logger';
import type { ModelConfig, ProviderConfig } from '../types';
import {
  DEFAULT_NORMAL_TIMEOUT_CONFIG,
  resolveChatNetwork,
} from '../utils';
import { getOpenCodeService } from './opencode-models';

export type OpenCodeCatalogFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isOpenCodeCatalogProvider(provider: ProviderConfig): boolean {
  return getOpenCodeService(provider.baseUrl) !== undefined;
}

export function getOpenCodeCatalogUrl(
  provider: ProviderConfig,
): string | undefined {
  const service = getOpenCodeService(provider.baseUrl);
  if (!service) {
    return undefined;
  }

  const url = new URL(provider.baseUrl.trim());
  url.pathname = service === 'go' ? '/zen/go/v1/models' : '/zen/v1/models';
  url.search = '';
  url.hash = '';
  return url.toString();
}

export function parseOpenCodeCatalog(payload: unknown): ModelConfig[] {
  if (
    !isRecord(payload) ||
    payload['object'] !== 'list' ||
    !Array.isArray(payload['data'])
  ) {
    throw new Error(
      'Invalid OpenCode model catalog: expected an OpenAI list response.',
    );
  }

  return payload['data'].map((entry, index) => {
    if (!isRecord(entry)) {
      throw new Error(
        `Invalid OpenCode model catalog entry at index ${index}: expected an object.`,
      );
    }

    const id = entry['id'];
    if (typeof id !== 'string' || id.trim() === '') {
      throw new Error(
        `Invalid OpenCode model catalog entry at index ${index}: expected a model ID.`,
      );
    }

    const name = entry['name'];
    return {
      id: id.trim(),
      ...(typeof name === 'string' && name.trim()
        ? { name: name.trim() }
        : {}),
    };
  });
}

function buildHeaders(
  provider: ProviderConfig,
  credential: AuthTokenInfo,
): Record<string, string> {
  const token = getToken(credential);
  const headers = mergeHeaders(token, provider.extraHeaders);
  setUserAgentHeader(headers, getUnifiedUserAgent());

  if (token) {
    headers['Authorization'] = `${getTokenType(credential) ?? 'Bearer'} ${token}`;
  }
  return headers;
}

export async function fetchOpenCodeCatalog(
  provider: ProviderConfig,
  credential: AuthTokenInfo,
  signal?: AbortSignal,
  fetcher?: OpenCodeCatalogFetch,
): Promise<ModelConfig[]> {
  const url = getOpenCodeCatalogUrl(provider);
  if (!url) {
    throw new Error('Provider is not an OpenCode catalog endpoint.');
  }

  const logger = createSimpleHttpLogger({
    purpose: 'Get Available Models',
    providerName: provider.name,
    providerType: provider.type,
  });
  const executeFetch =
    fetcher ??
    createCustomFetch({
      connectionTimeoutMs: DEFAULT_NORMAL_TIMEOUT_CONFIG.connection,
      responseTimeoutMs: DEFAULT_NORMAL_TIMEOUT_CONFIG.response,
      logger,
      proxy: resolveChatNetwork(provider).proxy,
      type: 'normal',
      abortSignal: signal,
    });

  try {
    const response = await executeFetch(url, {
      method: 'GET',
      headers: buildHeaders(provider, credential),
      signal,
    });
    if (!response.ok) {
      throw new Error(
        `Failed to get OpenCode model catalog: HTTP ${response.status}.`,
      );
    }

    const payload: unknown = await response.json();
    return parseOpenCodeCatalog(payload);
  } catch (error) {
    logger.error(error);
    throw error;
  }
}

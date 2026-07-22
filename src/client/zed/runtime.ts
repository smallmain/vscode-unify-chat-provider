import type {
  AuthTokenInfo,
  AuthTokenRefresh,
} from '../../auth/types';
import type { ProviderConfig } from '../../types';
import { resolveChatNetwork } from '../../utils';
import { createCustomFetch } from '../utils';
import {
  ZedCloudClient,
  type ZedLlmTokenSource,
} from './cloud-client';
import {
  DEFAULT_ZED_WEB_BASE_URL,
  resolveZedBaseUrls,
} from './urls';

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  const error = new Error('The Zed request was canceled.');
  error.name = 'AbortError';
  throw error;
}

function requireToken(credential: AuthTokenInfo): string {
  if (credential.kind !== 'token' || !credential.token.trim()) {
    throw new Error('Zed authentication is required.');
  }
  return credential.token;
}

export function assertZedProviderAuth(provider: ProviderConfig): string {
  if (String(provider.type) !== 'zed') {
    throw new Error('Zed transport requires provider type "zed".');
  }
  if (provider.auth?.method !== 'zed') {
    throw new Error('Zed transport requires auth method "zed".');
  }
  const providerSite = resolveZedBaseUrls(provider.baseUrl).web;
  const authSite = resolveZedBaseUrls(
    provider.auth.baseUrl?.trim() || DEFAULT_ZED_WEB_BASE_URL,
  ).web;
  if (providerSite !== authSite) {
    throw new Error(
      'The Zed provider URL changed after authentication. Sign in again before sending requests.',
    );
  }
  const organizationId = provider.auth.organizationId?.trim();
  if (!organizationId) {
    throw new Error('Select a Zed organization before sending requests.');
  }
  return organizationId;
}

export function createZedCloudClient(provider: ProviderConfig): ZedCloudClient {
  const network = resolveChatNetwork(provider);
  const fetcher = createCustomFetch({
    connectionTimeoutMs: network.timeout.connection,
    responseTimeoutMs: network.timeout.response,
    retryConfig: network.retry,
    proxy: network.proxy,
    type: 'normal',
  });
  return new ZedCloudClient(provider.baseUrl, fetcher, provider.extraHeaders);
}

export function createZedLlmTokenSource(
  credential: AuthTokenInfo,
  refreshCredential?: AuthTokenRefresh,
): ZedLlmTokenSource {
  let token = requireToken(credential);
  return {
    cached: async (signal) => {
      throwIfAborted(signal);
      return token;
    },
    refresh: async (signal) => {
      throwIfAborted(signal);
      if (!refreshCredential) {
        throw new Error('The Zed LLM token expired and could not be refreshed.');
      }
      token = requireToken(await refreshCredential());
      throwIfAborted(signal);
      return token;
    },
  };
}

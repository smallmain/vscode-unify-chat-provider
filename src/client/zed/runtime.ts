import type {
  AuthTokenInfo,
  AuthTokenRefresh,
  ZedAuthContext,
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

export function requireZedAuthContext(
  provider: ProviderConfig,
  credential: AuthTokenInfo,
): ZedAuthContext {
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
  const context =
    credential.kind === 'token' ? credential.authContext : undefined;
  if (
    context?.method !== 'zed' ||
    context.bindingId !== provider.auth.bindingId ||
    !context.organizationId.trim()
  ) {
    throw new Error('Select a Zed organization before sending requests.');
  }
  return context;
}

export function assertZedProviderAuth(
  provider: ProviderConfig,
  credential: AuthTokenInfo,
): string {
  return requireZedAuthContext(provider, credential).organizationId;
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
  const initialContext = requireZedTokenContext(credential);
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
      const refreshed = await refreshCredential();
      const refreshedContext = requireZedTokenContext(refreshed);
      if (
        refreshedContext.bindingId !== initialContext.bindingId ||
        refreshedContext.sessionId !== initialContext.sessionId ||
        refreshedContext.organizationId !== initialContext.organizationId
      ) {
        throw new Error('Zed authentication context changed during the request.');
      }
      token = requireToken(refreshed);
      throwIfAborted(signal);
      return token;
    },
  };
}

function requireZedTokenContext(credential: AuthTokenInfo): ZedAuthContext {
  const context =
    credential.kind === 'token' ? credential.authContext : undefined;
  if (context?.method !== 'zed') {
    throw new Error('Zed authentication context is required.');
  }
  return context;
}

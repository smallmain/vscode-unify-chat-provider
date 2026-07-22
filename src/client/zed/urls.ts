import { createHash } from 'node:crypto';
import type { ProviderConfig } from '../../types';
import type { ZedProviderIdentity } from './types';

export const DEFAULT_ZED_WEB_BASE_URL = 'https://zed.dev';
export const DEFAULT_ZED_CLOUD_BASE_URL = 'https://cloud.zed.dev';

function normalizeUrl(input: string): string {
  const url = new URL(input.trim());
  url.hash = '';
  url.search = '';
  url.pathname = url.pathname.replace(/\/+$/, '') || '/';
  return url.toString().replace(/\/$/, '');
}

export interface ZedBaseUrls {
  web: string;
  cloud: string;
}

export function resolveZedBaseUrls(baseUrl: string): ZedBaseUrls {
  const normalized = normalizeUrl(baseUrl || DEFAULT_ZED_WEB_BASE_URL);
  if (normalized === DEFAULT_ZED_WEB_BASE_URL) {
    return {
      web: DEFAULT_ZED_WEB_BASE_URL,
      cloud: DEFAULT_ZED_CLOUD_BASE_URL,
    };
  }
  return { web: normalized, cloud: normalized };
}

export function buildZedUrl(baseUrl: string, path: string): string {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  return `${baseUrl.replace(/\/+$/, '')}${normalizedPath}`;
}

export function createZedProviderIdentity(
  provider: Pick<ProviderConfig, 'name' | 'baseUrl'> &
    Partial<Pick<ProviderConfig, 'auth'>>,
  authSubjectId?: string,
): ZedProviderIdentity {
  const authBaseUrl =
    provider.auth?.method === 'zed' ? provider.auth.baseUrl?.trim() : undefined;
  const baseUrl = resolveZedBaseUrls(authBaseUrl || provider.baseUrl).web;
  const authIdentityId =
    provider.auth?.method === 'zed' ? provider.auth.identityId : undefined;
  const source = JSON.stringify({
    providerName: provider.name,
    baseUrl,
    authIdentityId: authIdentityId ?? '',
  });
  const providerKey = createHash('sha256').update(source).digest('hex');
  const subjectKey = authSubjectId
    ? createHash('sha256').update(authSubjectId).digest('hex')
    : undefined;
  return {
    key: subjectKey ? `${providerKey}:${subjectKey}` : providerKey,
    providerName: provider.name,
    baseUrl,
    authIdentityId,
  };
}

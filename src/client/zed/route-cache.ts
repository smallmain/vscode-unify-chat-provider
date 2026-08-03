import type { ProviderConfig } from '../../types';
import type { AuthTokenInfo } from '../../auth/types';
import type { ZedModelRoute } from './types';
import { requireZedAuthContext } from './runtime';

const routesByIdentity = new Map<string, Map<string, ZedModelRoute>>();

function cacheKey(provider: ProviderConfig, credential: AuthTokenInfo): string {
  const context = requireZedAuthContext(provider, credential);
  return `${context.bindingId}:${context.sessionId}:${context.organizationId}`;
}

export function rememberZedModelRoutes(
  provider: ProviderConfig,
  credential: AuthTokenInfo,
  routes: readonly ZedModelRoute[],
): void {
  const organizationId = requireZedAuthContext(
    provider,
    credential,
  ).organizationId;
  const byModel = new Map<string, ZedModelRoute>();
  for (const route of routes) {
    if (route.organizationId === organizationId) {
      byModel.set(route.modelId, route);
    }
  }
  routesByIdentity.set(cacheKey(provider, credential), byModel);
}

export function resolveCachedZedModelRoute(
  provider: ProviderConfig,
  credential: AuthTokenInfo,
  modelId: string,
): ZedModelRoute | undefined {
  return routesByIdentity
    .get(cacheKey(provider, credential))
    ?.get(modelId);
}

export function clearAllZedModelRoutes(): void {
  routesByIdentity.clear();
}

export function clearZedModelRoutes(bindingId: string): void {
  const prefix = `${bindingId}:`;
  for (const key of routesByIdentity.keys()) {
    if (key.startsWith(prefix)) {
      routesByIdentity.delete(key);
    }
  }
}

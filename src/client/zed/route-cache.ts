import type { ProviderConfig } from '../../types';
import type { ZedModelRoute } from './types';
import { createZedProviderIdentity } from './urls';

const routesByIdentity = new Map<string, Map<string, ZedModelRoute>>();

function cacheKey(provider: ProviderConfig, organizationId: string): string {
  return `${createZedProviderIdentity(provider).key}:${organizationId}`;
}

export function rememberZedModelRoutes(
  provider: ProviderConfig,
  organizationId: string,
  routes: readonly ZedModelRoute[],
): void {
  const byModel = new Map<string, ZedModelRoute>();
  for (const route of routes) {
    if (route.organizationId === organizationId) {
      byModel.set(route.modelId, route);
    }
  }
  routesByIdentity.set(cacheKey(provider, organizationId), byModel);
}

export function resolveCachedZedModelRoute(
  provider: ProviderConfig,
  organizationId: string,
  modelId: string,
): ZedModelRoute | undefined {
  return routesByIdentity
    .get(cacheKey(provider, organizationId))
    ?.get(modelId);
}

export function clearAllZedModelRoutes(): void {
  routesByIdentity.clear();
}

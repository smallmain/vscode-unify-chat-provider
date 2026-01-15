import { saveProviderDraft } from '../provider-ops';
import type {
  UiContext,
  UiNavAction,
  UiResume,
  WellKnownProviderAuthRoute,
} from '../router/types';
import { createAuthProvider } from '../../auth';
import { deepClone } from '../../config-ops';
import { ensureDraftSessionId } from '../form-utils';

export async function runWellKnownProviderAuthScreen(
  ctx: UiContext,
  route: WellKnownProviderAuthRoute,
  _resume: UiResume | undefined,
): Promise<UiNavAction> {
  if (!route.draft.auth) {
    route.draft.auth = { method: 'api-key' };
  }

  const authMethod = route.draft.auth.method;

  const modelListRoute = {
    kind: 'modelList' as const,
    invocation: 'addFromWellKnownProvider' as const,
    models: route.draft.models,
    providerLabel: route.draft.name ?? route.provider.name,
    requireAtLeastOne: false,
    draft: route.draft,
    confirmDiscardOnBack: true,
    onSave: async () =>
      saveProviderDraft({
        draft: route.draft,
        store: ctx.store,
        secretStore: ctx.secretStore,
      }),
    afterSave: 'popToRoot' as const,
  };

  // No authentication required - skip directly to model list
  if (authMethod === 'none') {
    return { kind: 'push', route: modelListRoute };
  }

  const providerLabel = route.draft.name?.trim() || route.provider.name;
  const providerId = ensureDraftSessionId(route.draft);

  const providerContext = {
    providerId,
    providerLabel,
    secretStore: ctx.secretStore,
    uriHandler: ctx.uriHandler,
  };

  const authProvider = route.draft.auth
    ? createAuthProvider(providerContext, deepClone(route.draft.auth))
    : null;

  if (!authProvider) {
    return { kind: 'push', route: modelListRoute };
  }

  try {
    const result = await authProvider.configure();
    if (!result.success) {
      return { kind: 'pop' };
    }
    if (result.config) {
      route.draft.auth = result.config;
    }
  } finally {
    authProvider.dispose?.();
  }

  return { kind: 'push', route: modelListRoute };
}

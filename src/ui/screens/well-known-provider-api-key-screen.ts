import { showInput } from '../component';
import { saveProviderDraft } from '../provider-ops';
import type {
  UiContext,
  UiNavAction,
  UiResume,
  WellKnownProviderApiKeyRoute,
} from '../router/types';

export async function runWellKnownProviderApiKeyScreen(
  ctx: UiContext,
  route: WellKnownProviderApiKeyRoute,
  _resume: UiResume | undefined,
): Promise<UiNavAction> {
  const apiKey = await showInput({
    title: 'API Key',
    prompt: 'Enter your API key (leave blank to remove)',
    value: route.draft.apiKey,
    password: true,
    ignoreFocusOut: true,
    showBackButton: true,
  });

  if (apiKey === undefined) {
    return { kind: 'pop' };
  }

  route.draft.apiKey = apiKey.trim() || undefined;

  return {
    kind: 'push',
    route: {
      kind: 'modelList',
      models: route.draft.models,
      providerLabel: route.draft.name ?? route.provider.name,
      requireAtLeastOne: false,
      draft: route.draft,
      onSave: async () =>
        saveProviderDraft({
          draft: route.draft,
          store: ctx.store,
        }),
      afterSave: 'popToRoot',
    },
  };
}

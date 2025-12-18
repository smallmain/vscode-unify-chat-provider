import { showInput } from '../component';
import { validateProviderNameUnique } from '../form-utils';
import type {
  UiContext,
  UiNavAction,
  UiResume,
  WellKnownProviderNameRoute,
} from '../router/types';

export async function runWellKnownProviderNameScreen(
  ctx: UiContext,
  route: WellKnownProviderNameRoute,
  _resume: UiResume | undefined,
): Promise<UiNavAction> {
  const name = await showInput({
    title: 'Provider Name',
    prompt: 'Enter a name for this provider',
    value: route.draft.name,
    placeHolder: 'e.g., My Provider, OpenRouter, Custom',
    ignoreFocusOut: true,
    showBackButton: true,
    validateInput: (value) => validateProviderNameUnique(value, ctx.store),
  });

  if (name === undefined) {
    return { kind: 'pop' };
  }

  route.draft.name = name.trim();

  return {
    kind: 'push',
    route: {
      kind: 'wellKnownProviderApiKey',
      provider: route.provider,
      draft: route.draft,
    },
  };
}


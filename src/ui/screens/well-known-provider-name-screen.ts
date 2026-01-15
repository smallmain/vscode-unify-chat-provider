import { showInput } from '../component';
import { validateProviderNameUnique } from '../form-utils';
import type {
  UiContext,
  UiNavAction,
  UiResume,
  WellKnownProviderNameRoute,
} from '../router/types';
import { t } from '../../i18n';

export async function runWellKnownProviderNameScreen(
  ctx: UiContext,
  route: WellKnownProviderNameRoute,
  _resume: UiResume | undefined,
): Promise<UiNavAction> {
  const name = await showInput({
    title: t('Provider Name'),
    prompt: t('Enter a name for this provider'),
    value: route.draft.name,
    placeHolder: t('e.g., My Provider, OpenRouter, Custom'),
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
      kind: 'wellKnownProviderAuth',
      provider: route.provider,
      draft: route.draft,
    },
  };
}


import * as vscode from 'vscode';
import {
  WELL_KNOWN_PROVIDERS,
  resolveProviderModels,
  type WellKnownProviderConfig,
} from '../../well-known/providers';
import { pickQuickItem } from '../component';
import { createProviderDraft, validateProviderNameUnique } from '../form-utils';
import type {
  UiContext,
  UiNavAction,
  UiResume,
  WellKnownProviderListRoute,
} from '../router/types';
import { t } from '../../i18n';

type WellKnownProviderItem = vscode.QuickPickItem & {
  action?: 'back';
  provider?: WellKnownProviderConfig;
};

export async function runWellKnownProviderListScreen(
  ctx: UiContext,
  _route: WellKnownProviderListRoute,
  _resume: UiResume | undefined,
): Promise<UiNavAction> {
  const picked = await pickQuickItem<WellKnownProviderItem>({
    title: t('Add From Well-Known Provider List'),
    placeholder: t('Select a provider'),
    matchOnDescription: true,
    matchOnDetail: true,
    ignoreFocusOut: true,
    items: [
      { label: `$(arrow-left) ${t('Back')}`, action: 'back' },
      { label: '', kind: vscode.QuickPickItemKind.Separator },
      ...WELL_KNOWN_PROVIDERS.map((provider) => ({
        label: t(provider.name),
        description: t(provider.name) === provider.name ? '' : provider.name,
        detail: provider.baseUrl,
        provider,
      })),
    ],
  });

  if (!picked || picked.action === 'back' || !picked.provider) {
    return { kind: 'pop' };
  }

  const { authTypes: _authTypes, models: _modelIds, ...providerConfig } =
    picked.provider;
  const draft = createProviderDraft({
    ...providerConfig,
    models: resolveProviderModels(picked.provider),
  });
  const suggestedName = draft.name ?? picked.provider.name;
  if (validateProviderNameUnique(suggestedName, ctx.store) === null) {
    draft.name = suggestedName.trim();
    return {
      kind: 'push',
      route: {
        kind: 'wellKnownProviderAuth',
        provider: picked.provider,
        draft,
      },
    };
  }

  return {
    kind: 'push',
    route: {
      kind: 'wellKnownProviderName',
      provider: picked.provider,
      draft,
    },
  };
}

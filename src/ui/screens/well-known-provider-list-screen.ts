import * as vscode from 'vscode';
import { WELL_KNOWN_PROVIDERS } from '../../well-known/providers';
import { pickQuickItem } from '../component';
import { createProviderDraft } from '../form-utils';
import type {
  UiContext,
  UiNavAction,
  UiResume,
  WellKnownProviderListRoute,
} from '../router/types';
import { ProviderConfig } from '../../types';

type WellKnownProviderItem = vscode.QuickPickItem & {
  action?: 'back';
  provider?: ProviderConfig;
};

export async function runWellKnownProviderListScreen(
  _ctx: UiContext,
  _route: WellKnownProviderListRoute,
  _resume: UiResume | undefined,
): Promise<UiNavAction> {
  const picked = await pickQuickItem<WellKnownProviderItem>({
    title: 'Add From Well-Known Provider List',
    placeholder: 'Select a provider',
    matchOnDescription: true,
    matchOnDetail: true,
    ignoreFocusOut: true,
    items: [
      { label: '$(arrow-left) Back', action: 'back' },
      { label: '', kind: vscode.QuickPickItemKind.Separator },
      ...WELL_KNOWN_PROVIDERS.map((provider) => ({
        label: provider.name,
        description: provider.type,
        detail: provider.baseUrl,
        provider,
      })),
    ],
  });

  if (!picked || picked.action === 'back' || !picked.provider) {
    return { kind: 'pop' };
  }

  const draft = createProviderDraft(picked.provider);

  return {
    kind: 'push',
    route: {
      kind: 'wellKnownProviderName',
      provider: picked.provider,
      draft,
    },
  };
}

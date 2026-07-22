import * as vscode from 'vscode';
import { saveProviderDraft } from '../provider-ops';
import type {
  UiContext,
  UiNavAction,
  UiResume,
  WellKnownProviderAuthRoute,
} from '../router/types';
import {
  AUTH_METHODS,
  createAuthProvider,
  createAuthProviderForMethod,
  getAuthMethodDefinition,
  normalizeAuthForProvider,
  type AuthMethod,
} from '../../auth';
import { deepClone } from '../../config-ops';
import { ensureDraftSessionId } from '../form-utils';
import { pickQuickItem } from '../component';
import { t } from '../../i18n';
import {
  WELL_KNOWN_AUTH_PRESETS,
  type WellKnownAuthPreset,
} from '../../well-known/auths';
import type { WellKnownAuthTypeId } from '../../well-known/providers';

type WellKnownAuthSelection =
  | { kind: 'method'; method: AuthMethod }
  | { kind: 'preset'; preset: WellKnownAuthPreset };

type WellKnownAuthPickItem = vscode.QuickPickItem & {
  selection?: WellKnownAuthSelection;
};

function isAuthMethodId(value: string): value is AuthMethod {
  if (value === 'none') {
    return true;
  }
  return Object.values(AUTH_METHODS).some((def) => def.id === value);
}

function resolveAuthSelections(
  authTypes: readonly WellKnownAuthTypeId[],
): WellKnownAuthSelection[] {
  const resolved: WellKnownAuthSelection[] = [];
  const seen = new Set<string>();

  for (const id of authTypes) {
    const preset = WELL_KNOWN_AUTH_PRESETS.find((item) => item.id === id);
    if (preset) {
      const key = `preset:${preset.id}`;
      if (!seen.has(key)) {
        seen.add(key);
        resolved.push({ kind: 'preset', preset });
      }
      continue;
    }

    if (!isAuthMethodId(id)) {
      continue;
    }

    const key = `method:${id}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    resolved.push({ kind: 'method', method: id });
  }

  return resolved;
}

function toPickItem(selection: WellKnownAuthSelection): WellKnownAuthPickItem {
  if (selection.kind === 'preset') {
    return {
      label: selection.preset.label,
      description: selection.preset.description,
      selection,
    };
  }

  if (selection.method === 'none') {
    return {
      label: t('None'),
      description: t('No authentication required'),
      selection,
    };
  }

  const def = getAuthMethodDefinition(selection.method);
  return {
    label: def?.label ?? selection.method,
    description: def?.description,
    selection,
  };
}

function buildAllAuthItems(): WellKnownAuthPickItem[] {
  const items: WellKnownAuthPickItem[] = [];

  items.push({
    label: '',
    kind: vscode.QuickPickItemKind.Separator,
    description: t('No Authentication'),
  });
  items.push({
    label: t('None'),
    description: t('No authentication required'),
    selection: { kind: 'method', method: 'none' },
  });

  const methodDefs = Object.values(AUTH_METHODS);
  const byCategory = new Map<string, typeof methodDefs>();
  const categories: string[] = [];
  for (const def of methodDefs) {
    if (!byCategory.has(def.category)) {
      byCategory.set(def.category, []);
      categories.push(def.category);
    }
    byCategory.get(def.category)!.push(def);
  }

  for (const category of categories) {
    items.push({
      label: '',
      kind: vscode.QuickPickItemKind.Separator,
      description: t(category),
    });
    const group = byCategory.get(category);
    if (!group) continue;
    for (const def of group) {
      items.push({
        label: def.label,
        description: def.description,
        selection: { kind: 'method', method: def.id },
      });
    }
  }

  if (WELL_KNOWN_AUTH_PRESETS.length > 0) {
    items.push({
      label: '',
      kind: vscode.QuickPickItemKind.Separator,
      description: t('Well-known'),
    });

    for (const preset of WELL_KNOWN_AUTH_PRESETS) {
      items.push({
        label: preset.label,
        description: preset.description,
        selection: { kind: 'preset', preset },
      });
    }
  }

  return items;
}

function getSelectableItemsCount(items: WellKnownAuthPickItem[]): number {
  return items.filter((item) => item.selection).length;
}

async function pickAuthSelection(
  items: WellKnownAuthPickItem[],
  autoPickSingle: boolean,
): Promise<WellKnownAuthSelection | undefined> {
  if (autoPickSingle && getSelectableItemsCount(items) === 1) {
    const only = items.find((item) => item.selection);
    return only?.selection;
  }

  const picked = await pickQuickItem<WellKnownAuthPickItem>({
    title: t('Authentication Method'),
    placeholder: t('Select an authentication method'),
    items,
    matchOnDescription: true,
    matchOnDetail: true,
    ignoreFocusOut: true,
  });

  return picked?.selection;
}

export async function runWellKnownProviderAuthScreen(
  ctx: UiContext,
  route: WellKnownProviderAuthRoute,
  _resume: UiResume | undefined,
): Promise<UiNavAction> {
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

  const authTypes = route.provider.authTypes;
  if (authTypes && authTypes.length === 0) {
    route.draft.auth = { method: 'none' };
    return { kind: 'push', route: modelListRoute };
  }

  const selected = await (async (): Promise<
    WellKnownAuthSelection | undefined
  > => {
    if (!authTypes) {
      return pickAuthSelection(buildAllAuthItems(), false);
    }

    const selections = resolveAuthSelections(authTypes);
    if (selections.length === 0) {
      return pickAuthSelection(buildAllAuthItems(), false);
    }

    return pickAuthSelection(selections.map(toPickItem), true);
  })();

  if (!selected) {
    return { kind: 'pop' };
  }

  // No authentication required - skip directly to model list
  if (selected.kind === 'method' && selected.method === 'none') {
    route.draft.auth = { method: 'none' };
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

  const selectedMethod =
    selected.kind === 'preset' ? selected.preset.auth.method : selected.method;
  const candidateAuth =
    selected.kind === 'preset'
      ? deepClone(selected.preset.auth)
      : route.draft.auth;
  const authForProvider = normalizeAuthForProvider(
    candidateAuth,
    {
      providerType: route.draft.type,
      baseUrl: route.draft.baseUrl,
    },
    selectedMethod,
  );
  const authProvider =
    selected.kind === 'preset'
      ? authForProvider
        ? createAuthProvider(providerContext, authForProvider)
        : null
      : createAuthProviderForMethod(
          providerContext,
          selected.method,
          authForProvider,
        );

  if (!authProvider) {
    return { kind: 'push', route: modelListRoute };
  }

  try {
    const result = await authProvider.configure();
    if (!result.success) {
      return { kind: 'pop' };
    }
    if (result.config) {
      route.draft.auth =
        normalizeAuthForProvider(result.config, {
          providerType: route.draft.type,
          baseUrl: route.draft.baseUrl,
        }) ?? result.config;
    }
  } finally {
    authProvider.dispose?.();
  }

  return { kind: 'push', route: modelListRoute };
}

import * as vscode from 'vscode';
import { t } from '../i18n';
import { ConfigStore } from '../config-store';
import type { FormSchema, FieldContext } from './field-schema';
import {
  validateBaseUrl,
  ensureDraftSessionId,
  validateProviderNameUnique,
  type ProviderFormDraft,
} from './form-utils';
import { normalizeBaseUrlInput } from '../utils';
import { ProviderType, PROVIDER_TYPES } from '../client/definitions';
import { type SecretStore } from '../secret';
import type { EventedUriHandler } from '../uri-handler';
import {
  AUTH_METHODS,
  createAuthProvider,
  createAuthProviderForMethod,
  getAuthMethodDefinition,
  type AuthConfig,
  type AuthMethod,
  type AuthStatusViewItem,
  type AuthUiStatusSnapshot,
} from '../auth';
import {
  WELL_KNOWN_AUTH_PRESETS,
  type WellKnownAuthPreset,
} from '../well-known/auths';
import { deepClone } from '../config-ops';

/**
 * Context for provider form fields.
 */
export interface ProviderFieldContext extends FieldContext {
  store: ConfigStore;
  originalName?: string;
  onEditModels: (draft: ProviderFormDraft) => Promise<void>;
  onEditTimeout: (draft: ProviderFormDraft) => Promise<void>;
  /** SecretStore for auth providers */
  secretStore?: SecretStore;
  uriHandler?: EventedUriHandler;
}

/**
 * Provider form field schema.
 */
export const providerFormSchema: FormSchema<ProviderFormDraft> = {
  sections: [
    { id: 'primary', label: t('Primary Fields') },
    { id: 'content', label: t('Content Fields') },
    { id: 'others', label: t('Other Fields') },
  ],
  fields: [
    // Name field
    {
      key: 'name',
      type: 'text',
      label: t('Name'),
      icon: 'tag',
      section: 'primary',
      prompt: t('Enter a name for this provider'),
      placeholder: t('e.g., My Provider, OpenRouter, Custom'),
      required: true,
      validate: (value, _draft, context) => {
        const ctx = context as ProviderFieldContext;
        return validateProviderNameUnique(value, ctx.store, ctx.originalName);
      },
      transform: (value) => value.trim() || undefined,
      getDescription: (draft) => draft.name || t('(required)'),
    },
    // Type field
    {
      key: 'type',
      type: 'custom',
      label: t('API Format'),
      icon: 'symbol-enum',
      section: 'primary',
      edit: async (draft) => {
        const { pickQuickItem } = await import('./component');
        const picked = await pickQuickItem<
          vscode.QuickPickItem & { typeValue: ProviderType }
        >({
          title: t('API Format'),
          placeholder: t('Select the API format'),
          items: Object.values(PROVIDER_TYPES).map((opt) => ({
            label: opt.label,
            description: opt.description,
            picked: opt.type === draft.type,
            typeValue: opt.type,
          })),
        });
        if (picked) {
          draft.type = picked.typeValue;
        }
      },
      getDescription: (draft) =>
        Object.values(PROVIDER_TYPES).find((o) => o.type === draft.type)
          ?.label || t('(required)'),
    },
    // Base URL field
    {
      key: 'baseUrl',
      type: 'text',
      label: t('API Base URL'),
      icon: 'globe',
      section: 'primary',
      prompt: t('Enter the API base URL'),
      placeholder: t('e.g., https://api.example.com'),
      required: true,
      validate: (value) => validateBaseUrl(value),
      transform: (value) => normalizeBaseUrlInput(value),
      getDescription: (draft) => draft.baseUrl || t('(required)'),
    },
    // Authentication field (new unified auth system)
    {
      key: 'auth',
      type: 'custom',
      label: t('Authentication'),
      icon: 'shield',
      section: 'primary',
      edit: async (draft, context) => {
        const ctx = context as ProviderFieldContext;
        await editAuthField(draft, ctx);
      },
      getDescription: (draft, context) => {
        return getAuthDescription(draft, context as ProviderFieldContext);
      },
    },

    // Models field (custom)
    {
      key: 'models',
      type: 'custom',
      label: t('Models'),
      icon: 'symbol-misc',
      section: 'content',
      edit: async (draft, context) => {
        const ctx = context as ProviderFieldContext;
        await ctx.onEditModels(draft);
      },
      getDescription: (draft) =>
        draft.models.length > 0
          ? t('{0} model(s)', draft.models.length)
          : t('(optional)'),
      getDetail: (draft) =>
        draft.models.length > 0
          ? draft.models.map((m) => m.name || m.id).join(', ')
          : t('(No models configured)'),
    },
    // Extra Headers
    {
      key: 'extraHeaders',
      type: 'custom',
      label: t('Extra Headers'),
      icon: 'json',
      section: 'others',
      edit: async () => {
        vscode.window
          .showInformationMessage(
            t('Extra headers must be configured in VS Code settings (JSON).'),
            t('Open Settings'),
          )
          .then((choice) => {
            if (choice === t('Open Settings')) {
              vscode.commands.executeCommand(
                'workbench.action.openSettingsJson',
              );
            }
          });
      },
      getDescription: (draft) =>
        draft.extraHeaders
          ? t('{0} headers', Object.keys(draft.extraHeaders).length)
          : t('Not configured'),
    },
    // Extra Body
    {
      key: 'extraBody',
      type: 'custom',
      label: t('Extra Body'),
      icon: 'json',
      section: 'others',
      edit: async () => {
        vscode.window
          .showInformationMessage(
            t(
              'Extra body parameters must be configured in VS Code settings (JSON).',
            ),
            t('Open Settings'),
          )
          .then((choice) => {
            if (choice === t('Open Settings')) {
              vscode.commands.executeCommand(
                'workbench.action.openSettingsJson',
              );
            }
          });
      },
      getDescription: (draft) =>
        draft.extraBody
          ? t('{0} properties', Object.keys(draft.extraBody).length)
          : t('Not configured'),
    },
    // Timeout
    {
      key: 'timeout',
      type: 'custom',
      label: t('Network Timeout'),
      icon: 'clock',
      section: 'others',
      edit: async (draft, context) => {
        const ctx = context as ProviderFieldContext;
        await ctx.onEditTimeout(draft);
      },
      getDescription: (draft) => {
        if (!draft.timeout?.connection && !draft.timeout?.response) {
          return t('default');
        }
        const parts: string[] = [];
        if (draft.timeout?.connection) {
          parts.push(t('conn: {0}ms', draft.timeout.connection));
        }
        if (draft.timeout?.response) {
          parts.push(t('resp: {0}ms', draft.timeout.response));
        }
        return parts.join(', ');
      },
    },
  ],
};

type AuthAction =
  | { kind: 'none' }
  | { kind: 'method'; method: Exclude<AuthMethod, 'none'> }
  | { kind: 'preset'; method: Exclude<AuthMethod, 'none'>; presetId: string };

type AuthPickItem = vscode.QuickPickItem & {
  authAction?: AuthAction;
  preset?: WellKnownAuthPreset;
};

type AuthStatusPickItem = AuthStatusViewItem & {
  viewAction?: 'reconfigure';
};

function getAuthDisplayLabel(auth: AuthConfig | undefined): string | undefined {
  if (!auth || typeof auth !== 'object' || Array.isArray(auth)) {
    return undefined;
  }
  const record = auth as unknown as Record<string, unknown>;
  const label = record['label'];
  return typeof label === 'string' ? label : undefined;
}

async function pickAuthMethod(
  draft: ProviderFormDraft,
): Promise<AuthPickItem | undefined> {
  const { pickQuickItem } = await import('./component');

  const items: AuthPickItem[] = [];

  items.push({
    label: '',
    kind: vscode.QuickPickItemKind.Separator,
    description: t('No Authentication'),
  });
  items.push({
    label: t('None'),
    description: t('No authentication required'),
    authAction: { kind: 'none' },
    picked: !draft.auth || draft.auth.method === 'none',
  });

  items.push({
    label: '',
    kind: vscode.QuickPickItemKind.Separator,
    description: t('Methods'),
  });

  const draftLabel = getAuthDisplayLabel(draft.auth);
  const pickedByPreset = (method: string): boolean => {
    return WELL_KNOWN_AUTH_PRESETS.some((preset) => {
      const presetLabel = getAuthDisplayLabel(preset.auth);
      return (
        preset.method === method &&
        draft.auth?.method === method &&
        !!presetLabel &&
        presetLabel === draftLabel
      );
    });
  };

  for (const def of Object.values(AUTH_METHODS)) {
    items.push({
      label: def.label,
      description: def.description,
      authAction: { kind: 'method', method: def.id },
      picked: draft.auth?.method === def.id && !pickedByPreset(def.id),
    });
  }

  if (WELL_KNOWN_AUTH_PRESETS.length > 0) {
    items.push({
      label: '',
      kind: vscode.QuickPickItemKind.Separator,
      description: t('Well-known'),
    });

    for (const preset of WELL_KNOWN_AUTH_PRESETS) {
      const presetLabel = getAuthDisplayLabel(preset.auth);
      items.push({
        label: preset.label,
        description: preset.description,
        authAction: {
          kind: 'preset',
          method: preset.method,
          presetId: preset.id,
        },
        preset,
        picked:
          draft.auth?.method === preset.method &&
          !!presetLabel &&
          presetLabel === draftLabel,
      });
    }
  }

  return pickQuickItem<AuthPickItem>({
    title: t('Authentication Method'),
    placeholder: t('Select an authentication method'),
    items,
  });
}

function intervalMsFromSnapshot(
  snapshot: AuthUiStatusSnapshot | undefined,
): number {
  if (snapshot?.kind !== 'valid' && snapshot?.kind !== 'expired') {
    return 5_000;
  }

  const expiresAt = snapshot.expiresAt;
  if (expiresAt === undefined) {
    return 5_000;
  }

  const remainingMs = expiresAt - Date.now();
  if (remainingMs > 0 && remainingMs < 60_000) {
    return 1_000;
  }

  return 5_000;
}

async function showAuthStatusView(options: {
  draft: ProviderFormDraft;
  ctx: ProviderFieldContext;
  auth: AuthConfig;
}): Promise<'exit' | 'reconfigure' | 'stay'> {
  const { pickQuickItem } = await import('./component');

  if (!options.ctx.secretStore) {
    vscode.window.showInformationMessage(
      t('Authentication configuration is not available.'),
    );
    return 'exit';
  }

  const providerLabel =
    options.draft.name?.trim() || options.ctx.originalName || t('Provider');
  const providerId =
    options.ctx.originalName ?? ensureDraftSessionId(options.draft);

  const providerContext = {
    providerId,
    providerLabel,
    secretStore: options.ctx.secretStore,
    uriHandler: options.ctx.uriHandler,
    persistAuthConfig: async (auth: AuthConfig) => {
      options.draft.auth = normalizeAuthDisplay(auth);
    },
  };

  const authProvider = createAuthProvider(
    providerContext,
    deepClone(options.auth),
  );
  if (!authProvider) {
    return 'exit';
  }

  const reconfigureItem: AuthStatusPickItem = {
    label: `$(gear) ${t('Reconfigure authentication method...')}`,
    description: t('Select a different authentication method'),
    viewAction: 'reconfigure',
  };

  const buildItems = async (): Promise<AuthStatusPickItem[]> => {
    const provided = await authProvider.getStatusViewItems?.();
    const items = provided && provided.length > 0 ? [...provided] : [];
    items.push(reconfigureItem);
    return items;
  };

  try {
    const picked = await pickQuickItem<AuthStatusPickItem>({
      title: t('Authentication'),
      placeholder: t('View authentication status'),
      ignoreFocusOut: true,
      items: [{ label: t('Loading...') }],
      onInlineAction: async (item) => {
        if (!item.action || item.action.kind !== 'inline') {
          return;
        }
        await item.action.run();
        return true;
      },
      onExternalRefresh: (refreshItems) => {
        let disposed = false;
        let refreshInFlight = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        let currentIntervalMs = 5_000;

        const schedule = () => {
          if (disposed) return;
          if (timer) clearTimeout(timer);
          timer = setTimeout(() => {
            void refresh();
          }, currentIntervalMs);
        };

        const refresh = async () => {
          if (disposed) return;
          if (refreshInFlight) return;
          refreshInFlight = true;
          try {
            const nextItems = await buildItems();
            refreshItems(nextItems);

            const snapshot = await authProvider.getStatusSnapshot?.();
            const nextInterval = intervalMsFromSnapshot(snapshot);
            if (nextInterval !== currentIntervalMs) {
              currentIntervalMs = nextInterval;
            }
          } finally {
            refreshInFlight = false;
            schedule();
          }
        };

        const subscription = authProvider.onDidChangeStatus(() => {
          void refresh();
        });

        void refresh();

        return {
          dispose: () => {
            disposed = true;
            subscription.dispose();
            if (timer) clearTimeout(timer);
          },
        };
      },
    });

    if (picked?.viewAction === 'reconfigure') {
      return 'reconfigure';
    }

    if (picked?.action?.kind === 'close') {
      await picked.action.run();
      options.draft.auth = normalizeAuthDisplay(
        authProvider.getConfig() ?? options.auth,
      );
      return 'stay';
    }

    return 'exit';
  } finally {
    authProvider.dispose?.();
  }
}

async function editAuthField(
  draft: ProviderFormDraft,
  ctx: ProviderFieldContext,
): Promise<void> {
  if (!ctx.secretStore) {
    vscode.window.showInformationMessage(
      t('Authentication configuration is not available.'),
    );
    return;
  }

  while (true) {
    const currentAuth = draft.auth;

    if (!currentAuth || currentAuth.method === 'none') {
      const selected = await pickAuthMethod(draft);
      if (!selected?.authAction) {
        return;
      }

      const authAction = selected.authAction;
      if (!authAction) {
        return;
      }

      if (authAction.kind === 'none') {
        draft.auth = { method: 'none' };
        return;
      }

      const providerLabel =
        draft.name?.trim() || ctx.originalName || t('Provider');
      const providerId = ctx.originalName ?? ensureDraftSessionId(draft);

      const providerContext = {
        providerId,
        providerLabel,
        secretStore: ctx.secretStore,
        uriHandler: ctx.uriHandler,
        persistAuthConfig: async (auth: AuthConfig) => {
          draft.auth = normalizeAuthDisplay(auth);
        },
      };

      let authProvider: ReturnType<typeof createAuthProvider> | null = null;

      if (authAction.kind === 'method') {
        const method = authAction.method;
        const current = draft.auth?.method === method ? draft.auth : undefined;
        authProvider = createAuthProviderForMethod(
          providerContext,
          method,
          current,
        );
      } else if (authAction.kind === 'preset') {
        const preset =
          selected.preset ??
          WELL_KNOWN_AUTH_PRESETS.find((p) => p.id === authAction.presetId);
        if (!preset) {
          return;
        }
        authProvider = createAuthProvider(
          providerContext,
          deepClone(preset.auth),
        );
      }

      if (!authProvider) {
        vscode.window.showErrorMessage(
          t('Failed to create authentication provider'),
        );
        return;
      }

      try {
        const result = await authProvider.configure();
        if (result.success && result.config) {
          draft.auth = normalizeAuthDisplay(result.config);
          return;
        }
        return;
      } finally {
        authProvider.dispose?.();
      }
    }

    const action = await showAuthStatusView({ draft, ctx, auth: currentAuth });
    if (action === 'exit') {
      return;
    }

    if (action === 'stay') {
      continue;
    }

    const baseline = deepClone(draft.auth);

    const selected = await pickAuthMethod(draft);
    if (!selected?.authAction) {
      continue;
    }

    const authAction = selected.authAction;
    if (!authAction) {
      continue;
    }

    if (authAction.kind === 'none') {
      draft.auth = { method: 'none' };
      return;
    }

    const providerLabel =
      draft.name?.trim() || ctx.originalName || t('Provider');
    const providerId = ctx.originalName ?? ensureDraftSessionId(draft);

    const providerContext = {
      providerId,
      providerLabel,
      secretStore: ctx.secretStore,
      uriHandler: ctx.uriHandler,
      persistAuthConfig: async (auth: AuthConfig) => {
        draft.auth = normalizeAuthDisplay(auth);
      },
    };

    let authProvider: ReturnType<typeof createAuthProvider> | null = null;

    if (authAction.kind === 'method') {
      const method = authAction.method;
      const current = draft.auth?.method === method ? draft.auth : undefined;
      authProvider = createAuthProviderForMethod(
        providerContext,
        method,
        current,
      );
    } else if (authAction.kind === 'preset') {
      const preset =
        selected.preset ??
        WELL_KNOWN_AUTH_PRESETS.find((p) => p.id === authAction.presetId);
      if (!preset) {
        continue;
      }
      authProvider = createAuthProvider(
        providerContext,
        deepClone(preset.auth),
      );
    }

    if (!authProvider) {
      vscode.window.showErrorMessage(
        t('Failed to create authentication provider'),
      );
      continue;
    }

    try {
      const result = await authProvider.configure();
      if (result.success && result.config) {
        draft.auth = normalizeAuthDisplay(result.config);
      } else {
        draft.auth = baseline;
      }
    } finally {
      authProvider.dispose?.();
    }
  }
}

function getStringProp(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const raw = record[key];
  return typeof raw === 'string' ? raw : undefined;
}

function normalizeAuthDisplay(config: AuthConfig): AuthConfig {
  if (config.method === 'none') {
    return config;
  }

  const def = getAuthMethodDefinition(config.method);
  const label = getStringProp(config, 'label');
  const description = getStringProp(config, 'description');

  return {
    ...config,
    label: label ?? def?.label,
    description: description ?? def?.description,
  };
}

/**
 * Get description for auth field based on current configuration
 */
function getAuthDescription(
  draft: ProviderFormDraft,
  ctx: ProviderFieldContext,
): string {
  if (!draft.auth || draft.auth.method === 'none') {
    return t('None');
  }

  const label = getStringProp(draft.auth, 'label');
  if (label) {
    return label;
  }

  const def = getAuthMethodDefinition(draft.auth.method);
  return def?.label ?? t('Authentication');
}

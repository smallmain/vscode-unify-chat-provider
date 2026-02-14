import * as vscode from 'vscode';
import { t } from '../i18n';
import { ConfigStore } from '../config-store';
import type { FormSchema, FieldContext } from './field-schema';
import {
  validateBaseUrl,
  ensureDraftSessionId,
  normalizeProviderDraft,
  validateProviderNameUnique,
  type ProviderFormDraft,
} from './form-utils';
import {
  DEFAULT_CONTEXT_CACHE_TTL_SECONDS,
  DEFAULT_CONTEXT_CACHE_TYPE,
  normalizeBaseUrlInput,
  resolveContextCacheConfig,
} from '../utils';
import { ProviderType, PROVIDER_TYPES } from '../client/definitions';
import type { ContextCacheConfig, ContextCacheType, ProviderConfig } from '../types';
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
import type { AuthTokenInfo } from '../auth/types';
import {
  BALANCE_METHODS,
  balanceManager,
  createBalanceProvider,
  createBalanceProviderForMethod,
  getBalanceMethodDefinition,
  type BalanceConfig,
  type BalanceMethod,
  type BalanceProviderState,
  type BalanceStatusViewItem,
} from '../balance';
import {
  WELL_KNOWN_AUTH_PRESETS,
  type WellKnownAuthPreset,
} from '../well-known/auths';
import { deepClone, stableStringify } from '../config-ops';

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
        type ProviderTypePickItem = vscode.QuickPickItem & {
          typeValue?: ProviderType;
        };

        const items: ProviderTypePickItem[] = [];
        const defs = Object.values(PROVIDER_TYPES);
        const byCategory = new Map<string, typeof defs>();
        const categories: string[] = [];
        for (const def of defs) {
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
              picked: def.type === draft.type,
              typeValue: def.type,
            });
          }
        }

        const picked = await pickQuickItem<ProviderTypePickItem>({
          title: t('API Format'),
          placeholder: t('Select the API format'),
          items,
        });
        if (picked?.typeValue) {
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
    {
      key: 'contextCache',
      type: 'custom',
      label: t('Context Cache'),
      icon: 'database',
      section: 'primary',
      edit: async (draft) => {
        await editContextCacheField(draft);
      },
      getDescription: (draft) => {
        const resolved = resolveContextCacheConfig(draft.contextCache);
        const typeLabel =
          resolved.type === 'only-free' ? t('Only Free') : t('Allow Paid');
        const hasCustomTtl =
          typeof draft.contextCache?.ttl === 'number' &&
          Number.isFinite(draft.contextCache.ttl) &&
          Number.isInteger(draft.contextCache.ttl) &&
          draft.contextCache.ttl > 0;
        const ttlLabel = hasCustomTtl ? `${resolved.ttlSeconds}s` : t('default');
        const summary = `${typeLabel}, ${ttlLabel}`;
        const isDefault =
          resolved.type === DEFAULT_CONTEXT_CACHE_TYPE && !hasCustomTtl;
        return isDefault ? t('default') : summary;
      },
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
    {
      key: 'balanceProvider',
      type: 'custom',
      label: t('Balance Monitor'),
      icon: 'pulse',
      section: 'primary',
      edit: async (draft, context) => {
        const ctx = context as ProviderFieldContext;
        await editBalanceField(draft, ctx);
      },
      getDescription: (draft) => {
        return getBalanceDescription(draft);
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
      label: t('Network Settings'),
      icon: 'globe',
      section: 'others',
      edit: async (draft, context) => {
        const ctx = context as ProviderFieldContext;
        await ctx.onEditTimeout(draft);
      },
      getDescription: (draft) => {
        const hasTimeout =
          draft.timeout?.connection !== undefined ||
          draft.timeout?.response !== undefined;
        const hasRetry =
          draft.retry?.maxRetries !== undefined ||
          draft.retry?.initialDelayMs !== undefined ||
          draft.retry?.maxDelayMs !== undefined ||
          draft.retry?.backoffMultiplier !== undefined ||
          draft.retry?.jitterFactor !== undefined;

        if (!hasTimeout && !hasRetry) return t('default');

        const parts: string[] = [];
        if (draft.timeout?.connection !== undefined) {
          parts.push(t('conn: {0}ms', draft.timeout.connection));
        }
        if (draft.timeout?.response !== undefined) {
          parts.push(t('resp: {0}ms', draft.timeout.response));
        }

        if (
          draft.type === 'google-antigravity' ||
          draft.type === 'google-gemini-cli'
        ) {
          parts.push(t('retry: internal'));
        } else if (hasRetry) {
          parts.push(t('retry: custom'));
        }

        return parts.join(', ');
      },
    },
  ],
};

type ContextCacheSettingsItem = vscode.QuickPickItem & {
  action?: 'back' | 'reset';
  edit?: 'type' | 'ttl';
};

type ContextCacheTypePickItem = vscode.QuickPickItem & {
  typeValue: ContextCacheType;
};

function validatePositiveFiniteIntegerOrEmpty(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const n = Number(trimmed);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
    return t('Please enter a positive integer');
  }
  return null;
}

async function editContextCacheField(draft: ProviderFormDraft): Promise<void> {
  const { pickQuickItem, showInput } = await import('./component');

  let typeValue: ContextCacheType | undefined = draft.contextCache?.type;
  let ttlValue: number | undefined = draft.contextCache?.ttl;

  const buildItems = (): ContextCacheSettingsItem[] => {
    const resolved = resolveContextCacheConfig({ type: typeValue, ttl: ttlValue });
    const resolvedTypeLabel =
      resolved.type === 'only-free' ? t('Only Free') : t('Allow Paid');

    const typeDesc =
      resolved.type === DEFAULT_CONTEXT_CACHE_TYPE
        ? t('default ({0})', resolvedTypeLabel)
        : resolvedTypeLabel;

    const ttlDesc =
      typeof ttlValue === 'number' &&
      Number.isFinite(ttlValue) &&
      Number.isInteger(ttlValue) &&
      ttlValue > 0
        ? `${resolved.ttlSeconds}s`
        : t('default');

    return [
      { label: `$(arrow-left) ${t('Back')}`, action: 'back' },
      { label: '', kind: vscode.QuickPickItemKind.Separator },
      {
        label: `$(symbol-enum) ${t('Cache Type')}`,
        description: typeDesc,
        edit: 'type',
      },
      {
        label: `$(clock) ${t('TTL (seconds)')}`,
        description: ttlDesc,
        edit: 'ttl',
      },
      { label: '', kind: vscode.QuickPickItemKind.Separator },
      { label: `$(refresh) ${t('Reset to Defaults')}`, action: 'reset' },
    ];
  };

  while (true) {
    const picked = await pickQuickItem<ContextCacheSettingsItem>({
      title: t('Context Cache'),
      placeholder: t('Select a setting to edit'),
      ignoreFocusOut: true,
      items: buildItems(),
    });

    if (!picked || picked.action === 'back') {
      break;
    }

    if (picked.action === 'reset') {
      typeValue = undefined;
      ttlValue = undefined;
      continue;
    }

    if (picked.edit === 'type') {
      const resolved = resolveContextCacheConfig({
        type: typeValue,
        ttl: ttlValue,
      });
      const typePicked = await pickQuickItem<ContextCacheTypePickItem>({
        title: t('Cache Type'),
        placeholder: t('Select cache type'),
        ignoreFocusOut: true,
        items: [
          {
            label: t('Only Free'),
            description: t('Use context cache only when free'),
            detail: t('default'),
            picked: resolved.type === 'only-free',
            typeValue: 'only-free',
          },
          {
            label: t('Allow Paid'),
            description: t('Use context cache even if it incurs cost'),
            picked: resolved.type === 'allow-paid',
            typeValue: 'allow-paid',
          },
        ],
      });
      if (typePicked) {
        typeValue = typePicked.typeValue;
      }
      continue;
    }

    if (picked.edit === 'ttl') {
      const resolved = resolveContextCacheConfig({
        type: typeValue,
        ttl: ttlValue,
      });
      const ttlRaw = await showInput({
        title: t('TTL (seconds)'),
        prompt: t('Enter TTL in seconds'),
        placeHolder: t('Leave blank for default'),
        value: ttlValue?.toString() ?? '',
        ignoreFocusOut: true,
        validateInput: validatePositiveFiniteIntegerOrEmpty,
      });
      if (ttlRaw !== undefined) {
        const trimmed = ttlRaw.trim();
        if (!trimmed) {
          ttlValue = undefined;
        } else {
          const parsed = Number(trimmed);
          ttlValue =
            Number.isFinite(parsed) && Number.isInteger(parsed) && parsed > 0
              ? parsed
              : resolved.ttlSeconds;
        }
      }
      continue;
    }
  }

  const resolved = resolveContextCacheConfig({ type: typeValue, ttl: ttlValue });

  const isDefault =
    resolved.type === DEFAULT_CONTEXT_CACHE_TYPE &&
    resolved.ttlSeconds === DEFAULT_CONTEXT_CACHE_TTL_SECONDS;

  if (isDefault) {
    draft.contextCache = undefined;
    return;
  }

  const next: ContextCacheConfig = {};
  if (resolved.type !== DEFAULT_CONTEXT_CACHE_TYPE) {
    next.type = resolved.type;
  }
  if (resolved.ttlSeconds !== DEFAULT_CONTEXT_CACHE_TTL_SECONDS) {
    next.ttl = resolved.ttlSeconds;
  }
  draft.contextCache = next;
}

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

type BalanceAction =
  | { kind: 'none' }
  | { kind: 'method'; method: Exclude<BalanceMethod, 'none'> };

type BalancePickItem = vscode.QuickPickItem & {
  balanceAction?: BalanceAction;
};

type BalanceStatusPickItem = BalanceStatusViewItem & {
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
        authAction: { kind: 'method', method: def.id },
        picked: draft.auth?.method === def.id && !pickedByPreset(def.id),
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

function getBalanceDescription(draft: ProviderFormDraft): string {
  const balanceProvider = draft.balanceProvider;
  if (!balanceProvider || balanceProvider.method === 'none') {
    return t('Not configured');
  }

  const definition = getBalanceMethodDefinition(balanceProvider.method);
  return definition?.label ?? t('Balance monitor');
}

async function pickBalanceMethod(
  draft: ProviderFormDraft,
): Promise<BalancePickItem | undefined> {
  const { pickQuickItem } = await import('./component');
  const items: BalancePickItem[] = [];

  items.push({
    label: '',
    kind: vscode.QuickPickItemKind.Separator,
    description: t('No Monitoring'),
  });
  items.push({
    label: t('Not configured'),
    description: t('Disable balance monitoring'),
    balanceAction: { kind: 'none' },
    picked:
      !draft.balanceProvider || draft.balanceProvider.method === 'none',
  });

  const methodDefs = Object.values(BALANCE_METHODS);
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
        balanceAction: { kind: 'method', method: def.id },
        picked: draft.balanceProvider?.method === def.id,
      });
    }
  }

  return pickQuickItem<BalancePickItem>({
    title: t('Balance Monitor'),
    placeholder: t('Select a balance monitoring method'),
    items,
    ignoreFocusOut: true,
  });
}

function toAuthTokenInfo(
  credential: { value: string; tokenType?: string; expiresAt?: number } | undefined,
): AuthTokenInfo {
  if (!credential?.value) {
    return { kind: 'none' };
  }

  return {
    kind: 'token',
    token: credential.value,
    tokenType: credential.tokenType,
    expiresAt: credential.expiresAt,
  };
}

function resolveDraftProviderConfig(
  draft: ProviderFormDraft,
): ProviderConfig | undefined {
  if (!draft.name?.trim()) {
    return undefined;
  }

  try {
    return normalizeProviderDraft(draft);
  } catch {
    return undefined;
  }
}

async function resolveDraftCredential(
  draft: ProviderFormDraft,
  ctx: ProviderFieldContext,
): Promise<AuthTokenInfo | undefined> {
  const auth = draft.auth;
  if (!auth || auth.method === 'none') {
    return { kind: 'none' };
  }

  if (!ctx.secretStore) {
    return undefined;
  }

  const providerLabel = draft.name?.trim() || ctx.originalName || t('Provider');
  const providerId = ctx.originalName ?? ensureDraftSessionId(draft);
  const authProvider = createAuthProvider(
    {
      providerId,
      providerLabel,
      secretStore: ctx.secretStore,
      uriHandler: ctx.uriHandler,
    },
    deepClone(auth),
  );

  if (!authProvider) {
    return undefined;
  }

  try {
    const credential = await authProvider.getCredential();
    return toAuthTokenInfo(credential);
  } finally {
    authProvider.dispose?.();
  }
}

async function showBalanceStatusView(options: {
  draft: ProviderFormDraft;
  ctx: ProviderFieldContext;
  balanceProviderConfig: BalanceConfig;
}): Promise<'exit' | 'reconfigure' | 'stay'> {
  const { pickQuickItem } = await import('./component');

  if (!options.ctx.secretStore) {
    vscode.window.showInformationMessage(
      t('Balance monitor configuration is not available.'),
    );
    return 'exit';
  }

  const providerLabel =
    options.draft.name?.trim() || options.ctx.originalName || t('Provider');
  const providerId =
    options.ctx.originalName ?? ensureDraftSessionId(options.draft);

  const context = {
    providerId,
    providerLabel,
    secretStore: options.ctx.secretStore,
    authManager: undefined,
    storeSecretsInSettings: options.ctx.store.storeApiKeyInSettings,
    persistBalanceConfig: async (balanceProvider: BalanceConfig) => {
      options.draft.balanceProvider = deepClone(balanceProvider);
    },
  };

  const balanceProvider = createBalanceProvider(
    context,
    deepClone(options.balanceProviderConfig),
  );
  if (!balanceProvider) {
    return 'exit';
  }

  const draftProviderConfig = resolveDraftProviderConfig(options.draft);
  const savedProvider = (() => {
    const name = options.draft.name?.trim();
    if (!name) return undefined;
    return options.ctx.store.getProvider(name);
  })();

  const canUseManagerRefresh =
    !!savedProvider &&
    !!draftProviderConfig &&
    savedProvider.type === draftProviderConfig.type &&
    savedProvider.baseUrl === draftProviderConfig.baseUrl &&
    stableStringify(savedProvider.auth) ===
      stableStringify(draftProviderConfig.auth) &&
    stableStringify(savedProvider.balanceProvider) ===
      stableStringify(draftProviderConfig.balanceProvider);

  const existingState =
    canUseManagerRefresh && savedProvider
      ? balanceManager.getProviderState(savedProvider.name)
      : undefined;
  let localState: BalanceProviderState | undefined = existingState
    ? {
        ...existingState,
        pendingTrailing: false,
      }
    : undefined;

  const refresh = async (): Promise<void> => {
    if (canUseManagerRefresh && savedProvider) {
      await balanceManager.forceRefresh(savedProvider.name);
      const refreshed = balanceManager.getProviderState(savedProvider.name);
      localState = refreshed
        ? {
            ...refreshed,
            pendingTrailing: false,
          }
        : localState;
      return;
    }

    const providerConfig = resolveDraftProviderConfig(options.draft);
    if (!providerConfig) {
      localState = {
        isRefreshing: false,
        pendingTrailing: false,
        lastError: t(
          'Please configure Name, API Format, and API Base URL first.',
        ),
      };
      return;
    }

    localState = {
      ...(localState ?? { pendingTrailing: false }),
      isRefreshing: true,
      pendingTrailing: false,
    };

    const credential = await resolveDraftCredential(options.draft, options.ctx);
    const result = await balanceProvider.refresh({
      provider: providerConfig,
      credential,
    });

    if (result.success && result.snapshot) {
      localState = {
        isRefreshing: false,
        pendingTrailing: false,
        snapshot: result.snapshot,
        lastError: undefined,
        lastAttemptAt: Date.now(),
        lastRefreshAt: Date.now(),
      };
      return;
    }

    localState = {
      isRefreshing: false,
      pendingTrailing: false,
      lastAttemptAt: Date.now(),
      lastError: result.error ?? t('Balance refresh failed.'),
      snapshot: localState?.snapshot,
    };
  };

  const reconfigureItem: BalanceStatusPickItem = {
    label: `$(gear) ${t('Reconfigure balance monitor...')}`,
    description: t('Select a different balance monitoring method'),
    viewAction: 'reconfigure',
  };

  const buildItems = async (): Promise<BalanceStatusPickItem[]> => {
    const provided = await balanceProvider.getStatusViewItems?.({
      state: localState,
      refresh,
    });
    const items = provided && provided.length > 0 ? [...provided] : [];
    items.push(reconfigureItem);
    return items;
  };

  try {
    const picked = await pickQuickItem<BalanceStatusPickItem>({
      title: t('Balance Monitor'),
      placeholder: t('View balance monitoring status'),
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
        const disposables: vscode.Disposable[] = [];

        const refreshView = async (): Promise<void> => {
          if (disposed || refreshInFlight) {
            return;
          }
          refreshInFlight = true;
          try {
            if (canUseManagerRefresh && savedProvider) {
              const next = balanceManager.getProviderState(savedProvider.name);
              localState = next
                ? {
                    ...next,
                    pendingTrailing: false,
                  }
                : localState;
            }
            const nextItems = await buildItems();
            refreshItems(nextItems);
          } finally {
            refreshInFlight = false;
          }
        };

        const triggerInitialRefresh = async (): Promise<void> => {
          if (localState?.snapshot || localState?.isRefreshing || localState?.lastError) {
            return;
          }
          await refresh();
          await refreshView();
        };

        if (canUseManagerRefresh && savedProvider) {
          disposables.push(
            balanceManager.onDidUpdate((providerName) => {
              if (providerName === savedProvider.name) {
                void refreshView();
              }
            }),
          );
        }

        const timer = setInterval(() => {
          void refreshView();
        }, 5_000);

        void refreshView();
        void triggerInitialRefresh();

        return {
          dispose: () => {
            disposed = true;
            clearInterval(timer);
            for (const disposable of disposables) {
              disposable.dispose();
            }
          },
        };
      },
    });

    if (picked?.viewAction === 'reconfigure') {
      return 'reconfigure';
    }

    if (picked?.action?.kind === 'close') {
      await picked.action.run();
      options.draft.balanceProvider =
        deepClone(balanceProvider.getConfig() ?? options.balanceProviderConfig);
      return 'stay';
    }

    if (picked) {
      return 'stay';
    }

    return 'exit';
  } finally {
    balanceProvider.dispose?.();
  }
}

async function editBalanceField(
  draft: ProviderFormDraft,
  ctx: ProviderFieldContext,
): Promise<void> {
  if (!ctx.secretStore) {
    vscode.window.showInformationMessage(
      t('Balance monitor configuration is not available.'),
    );
    return;
  }

  while (true) {
    const current = draft.balanceProvider;

    if (!current || current.method === 'none') {
      const selected = await pickBalanceMethod(draft);
      if (!selected?.balanceAction) {
        return;
      }

      const action = selected.balanceAction;
      if (action.kind === 'none') {
        draft.balanceProvider = undefined;
        return;
      }

      const providerLabel =
        draft.name?.trim() || ctx.originalName || t('Provider');
      const providerId = ctx.originalName ?? ensureDraftSessionId(draft);

      const balanceProvider = createBalanceProviderForMethod(
        {
          providerId,
          providerLabel,
          secretStore: ctx.secretStore,
          authManager: undefined,
          storeSecretsInSettings: ctx.store.storeApiKeyInSettings,
          persistBalanceConfig: async (balanceProvider: BalanceConfig) => {
            draft.balanceProvider = deepClone(balanceProvider);
          },
        },
        action.method,
        current,
      );

      if (!balanceProvider) {
        vscode.window.showErrorMessage(
          t('Failed to create balance monitor provider'),
        );
        return;
      }

      try {
        const result = await balanceProvider.configure();
        if (result.success && result.config) {
          draft.balanceProvider = deepClone(result.config);
          return;
        }
        return;
      } finally {
        balanceProvider.dispose?.();
      }
    }

    const viewAction = await showBalanceStatusView({
      draft,
      ctx,
      balanceProviderConfig: current,
    });

    if (viewAction === 'exit') {
      return;
    }

    if (viewAction === 'stay') {
      continue;
    }

    const selected = await pickBalanceMethod(draft);
    if (!selected?.balanceAction) {
      continue;
    }

    const action = selected.balanceAction;
    if (action.kind === 'none') {
      draft.balanceProvider = undefined;
      return;
    }

    const providerLabel = draft.name?.trim() || ctx.originalName || t('Provider');
    const providerId = ctx.originalName ?? ensureDraftSessionId(draft);

    const balanceProvider = createBalanceProviderForMethod(
      {
        providerId,
        providerLabel,
        secretStore: ctx.secretStore,
        authManager: undefined,
        storeSecretsInSettings: ctx.store.storeApiKeyInSettings,
        persistBalanceConfig: async (balanceProvider: BalanceConfig) => {
          draft.balanceProvider = deepClone(balanceProvider);
        },
      },
      action.method,
      current,
    );

    if (!balanceProvider) {
      vscode.window.showErrorMessage(
        t('Failed to create balance monitor provider'),
      );
      continue;
    }

    try {
      const result = await balanceProvider.configure();
      if (result.success && result.config) {
        draft.balanceProvider = deepClone(result.config);
      }
    } finally {
      balanceProvider.dispose?.();
    }
  }
}

export async function editBalanceMonitorField(
  draft: ProviderFormDraft,
  ctx: ProviderFieldContext,
): Promise<void> {
  await editBalanceField(draft, ctx);
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

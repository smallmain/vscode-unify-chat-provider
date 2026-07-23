import * as vscode from 'vscode';
import { t } from '../i18n';
import { ConfigStore } from '../config-store';
import {
  deepClone,
  mergePartialByKeys,
  PROVIDER_CONFIG_KEYS,
} from '../config-ops';
import { showValidationErrors } from './component';
import {
  LocalAuthStateConflictError,
  isLocalAuthStateConflictError,
  SecretStore,
  type LocalAuthCommitGuard,
  type LocalAuthSessionTransaction,
} from '../secret';
import { resolveAuthForExportOrShowError } from '../auth/auth-transfer';
import { showCopiedBase64Config } from './base64-config';
import { resolveBalanceForExportOrShowError } from '../balance/balance-transfer';
import {
  normalizeProviderDraft,
  validateProviderForm,
  validateProviderNameUnique,
  type ProviderFormDraft,
} from './form-utils';
import { ProviderConfig } from '../types';
import { officialModelsManager } from '../official-models-manager';
import {
  promptConflictResolution,
  generateUniqueProviderName,
} from './conflict-resolution';
import {
  normalizeAuthForProvider,
  normalizeAuthOnImport,
  prepareAuthForDuplicate,
  supportsSensitiveAuthInSettings,
} from '../auth';
import { getBalanceMethodDefinition } from '../balance';
import { mainInstance } from '../main-instance';
import {
  isLeaderUnavailableError,
  isVersionIncompatibleError,
} from '../main-instance/errors';
import { migrateLegacyVSCodeModelIds } from '../vscode-model-id-migration';
import {
  assertValidInlineSessionAuthToken,
  createAuthBindingId,
  discardMismatchedLocalSessionState,
  isSessionAuthConfig,
  isValidAuthBindingId,
  renewSessionAuthBinding,
  stripSessionAuthState,
  type AuthBindingDescriptor,
} from '../auth/local-auth-state';
import type { AuthRuntimeConfig } from '../auth/types';
import {
  captureProviderSourceGuard,
  isProviderSourceGuardCurrent,
  type ProviderSourceGuard,
} from '../auth/provider-source-guard';

export function captureDraftAuthCommitGuard(
  draft: ProviderFormDraft,
  secretStore: SecretStore,
  options: {
    auth?: AuthRuntimeConfig;
    descriptor?: AuthBindingDescriptor;
    force?: boolean;
  } = {},
): void {
  const auth = options.auth ?? draft.auth;
  if (
    !auth ||
    !isSessionAuthConfig(auth) ||
    !isValidAuthBindingId(auth.bindingId)
  ) {
    if (options.force) draft._authCommitGuard = undefined;
    return;
  }

  if (
    !options.force &&
    draft._authCommitGuard?.bindingId === auth.bindingId
  ) {
    return;
  }

  const descriptor =
    options.descriptor ??
    (draft.type && draft.baseUrl
      ? {
          providerName: draft.name?.trim() ?? '',
          providerType: draft.type,
          baseUrl: draft.baseUrl,
          useRawBaseUrl: draft.useRawBaseUrl,
        }
      : undefined);
  if (!descriptor) return;

  draft._authCommitGuard = {
    bindingId: auth.bindingId,
    method: auth.method,
    guard: secretStore.getLocalAuthCommitGuard(descriptor, auth),
  };
}

function resolveDraftAuthCommitGuard(
  draft: ProviderFormDraft,
  auth: AuthRuntimeConfig | undefined,
): LocalAuthCommitGuard | undefined {
  if (!auth || !isSessionAuthConfig(auth)) return undefined;
  return draft._authCommitGuard?.bindingId === auth.bindingId
    ? draft._authCommitGuard.guard
    : undefined;
}

export function discardDraftAuthState(
  draft: Pick<ProviderFormDraft, 'auth'>,
  secretStore: SecretStore,
  original?: { auth?: AuthRuntimeConfig },
): void {
  const draftAuth = draft.auth;
  const originalAuth = original?.auth;
  if (draftAuth && isSessionAuthConfig(draftAuth)) {
    secretStore.discardDraftSessionAuth(
      draftAuth,
      originalAuth && isSessionAuthConfig(originalAuth)
        ? originalAuth
        : undefined,
    );
  }
  if (
    originalAuth &&
    isSessionAuthConfig(originalAuth) &&
    (!draftAuth ||
      !isSessionAuthConfig(draftAuth) ||
      draftAuth.bindingId !== originalAuth.bindingId)
  ) {
    secretStore.discardDraftSessionAuth(originalAuth, originalAuth);
  }
}

export function assertValidProviderDraftSessionAuthToken(
  draft: Pick<ProviderFormDraft, 'auth'>,
): void {
  if (draft.auth && isSessionAuthConfig(draft.auth)) {
    assertValidInlineSessionAuthToken(draft.auth);
  }
}

async function applyAuthStoragePolicy(options: {
  store: ConfigStore;
  secretStore: SecretStore;
  provider: ProviderConfig;
  existing?: ProviderConfig;
}): Promise<ProviderConfig> {
  const next = options.provider;
  let auth = normalizeAuthForProvider(
    next.auth,
    {
      providerType: next.type,
      baseUrl: next.baseUrl,
      previousProviderType: options.existing?.type,
      previousBaseUrl: options.existing?.baseUrl,
      previousAuth: options.existing?.auth,
    },
  );
  next.auth = auth;
  if (!auth || auth.method === 'none') {
    return next;
  }

  const storeSecretsInSettings =
    options.store.storeApiKeyInSettings &&
    supportsSensitiveAuthInSettings(auth);
  const existingAuth = options.existing?.auth;

  if (isSessionAuthConfig(auth)) {
    const existingBinding =
      existingAuth &&
      isSessionAuthConfig(existingAuth) &&
      isValidAuthBindingId(existingAuth.bindingId)
        ? existingAuth.bindingId
        : undefined;
    auth = {
      ...auth,
      bindingId:
        existingBinding ??
        (isValidAuthBindingId(auth.bindingId)
          ? auth.bindingId
          : createAuthBindingId()),
    };
    assertValidInlineSessionAuthToken(auth);
    auth = discardMismatchedLocalSessionState(
      {
        providerName: next.name,
        providerType: next.type,
        baseUrl: next.baseUrl,
        useRawBaseUrl: next.useRawBaseUrl,
      },
      auth,
    );
    if (auth.method === 'zed' && !auth.token?.trim()) {
      auth = stripSessionAuthState(auth);
    }
  }

  let normalized = await normalizeAuthOnImport(auth, {
    secretStore: options.secretStore,
    storeSecretsInSettings,
    existing: existingAuth?.method === auth.method ? existingAuth : undefined,
  });
  if (isSessionAuthConfig(normalized)) {
    const descriptor = {
      providerName: next.name,
      providerType: next.type,
      baseUrl: next.baseUrl,
      useRawBaseUrl: next.useRawBaseUrl,
    };
    const bound = {
      ...normalized,
      bindingId: normalized.bindingId,
    };
    const intent = await options.secretStore.prepareSessionAuthCommitIntent(
      descriptor,
      bound,
    );
    options.secretStore.discardPendingSessionAuth(descriptor, bound);
    normalized = intent;
  }
  next.auth = normalized;
  return next;
}

async function applyBalanceStoragePolicy(options: {
  store: ConfigStore;
  secretStore: SecretStore;
  provider: ProviderConfig;
  existing?: ProviderConfig;
}): Promise<ProviderConfig> {
  const next = options.provider;
  const balanceProvider = next.balanceProvider;
  if (!balanceProvider || balanceProvider.method === 'none') {
    return next;
  }

  const definition = getBalanceMethodDefinition(balanceProvider.method);
  if (!definition) {
    return next;
  }

  const storeSecretsInSettings =
    options.store.storeApiKeyInSettings &&
    definition.supportsSensitiveDataInSettings(balanceProvider);
  const existingBalanceProvider = options.existing?.balanceProvider;

  const normalized = await definition.normalizeOnImport(balanceProvider, {
    secretStore: options.secretStore,
    storeSecretsInSettings,
    existing:
      existingBalanceProvider?.method === balanceProvider.method
        ? existingBalanceProvider
        : undefined,
  });

  next.balanceProvider = normalized;
  return next;
}

async function syncPersistedProvider(options: {
  store: ConfigStore;
  secretStore: SecretStore;
  provider: ProviderConfig;
  authGuard?: LocalAuthCommitGuard;
  sourceGuard?: ProviderSourceGuard;
  originalName?: string;
  modelSourceIds?: Readonly<Record<string, string>>;
  commitLocalProvider?: (provider: ProviderConfig) => Promise<void>;
}): Promise<{ provider: ProviderConfig; committedByLeader: boolean }> {
  const sessionAuth = options.provider.auth;
  if (!sessionAuth || !isSessionAuthConfig(sessionAuth)) {
    if (mainInstance.isLeader()) {
      return { provider: options.provider, committedByLeader: false };
    }
    try {
      await mainInstance.runInLeaderWhenAvailable(
        'config.syncPersistedProvider',
        {
          provider: options.provider,
          ...(options.originalName &&
          options.originalName !== options.provider.name
            ? { originalName: options.originalName }
            : {}),
          ...(options.modelSourceIds === undefined
            ? {}
            : { modelSourceIds: options.modelSourceIds }),
        },
      );
    } catch (error) {
      if (
        !isLeaderUnavailableError(error) &&
        !isVersionIncompatibleError(error)
      ) {
        throw error;
      }
    }
    return { provider: options.provider, committedByLeader: false };
  }

  const assertSourceCurrent = (): void => {
    const guard = options.sourceGuard;
    if (
      !guard ||
      !isProviderSourceGuardCurrent(guard, (providerName) =>
        options.store.getProvider(providerName),
      )
    ) {
      throw new LocalAuthStateConflictError();
    }
  };

  const persistLocally = async () => {
    const auth = options.provider.auth;
    if (!auth || !isSessionAuthConfig(auth)) {
      throw new Error('Expected session authentication.');
    }
    const descriptor = {
      providerName: options.provider.name,
      providerType: options.provider.type,
      baseUrl: options.provider.baseUrl,
      useRawBaseUrl: options.provider.useRawBaseUrl,
    };
    let transaction: LocalAuthSessionTransaction | undefined;
    try {
      assertSourceCurrent();
      transaction = await options.secretStore.prepareSessionAuthTransaction(
        descriptor,
        auth,
        {
          reason: 'import',
          emptyToken: 'preserve',
          binding: 'existing-or-random',
          guard: options.authGuard,
          assertSourceCurrent,
        },
      );
      assertSourceCurrent();
      return {
        provider: { ...options.provider, auth: transaction.auth },
        transaction,
      };
    } catch (error) {
      await transaction?.rollback();
      options.secretStore.discardPendingSessionAuth(descriptor, auth);
      throw error;
    }
  };

  const persistAndCommitLocally = async (): Promise<{
    provider: ProviderConfig;
    committedByLeader: boolean;
  }> =>
    mainInstance.runLeaderMutation(async () => {
      const prepared = await persistLocally();
      try {
        await options.commitLocalProvider?.(prepared.provider);
        prepared.transaction.commit();
        return {
          provider: prepared.provider,
          committedByLeader: options.commitLocalProvider !== undefined,
        };
      } catch (error) {
        await prepared.transaction.rollback();
        throw error;
      }
    });

  if (mainInstance.isLeader() && mainInstance.isReady()) {
    return await persistAndCommitLocally();
  }

  try {
    await mainInstance.runInLeaderWhenAvailable(
      'config.syncPersistedProvider',
      {
        provider: options.provider,
        ...(options.originalName &&
        options.originalName !== options.provider.name
          ? { originalName: options.originalName }
          : {}),
        ...(options.modelSourceIds === undefined
          ? {}
          : { modelSourceIds: options.modelSourceIds }),
        ...(options.authGuard === undefined
          ? {}
          : { authGuard: options.authGuard }),
        ...(options.sourceGuard === undefined
          ? {}
          : { sourceGuard: options.sourceGuard }),
      },
    );
    const auth = options.provider.auth;
    if (!auth || !isSessionAuthConfig(auth)) {
      return { provider: options.provider, committedByLeader: true };
    }
    const descriptor = {
      providerName: options.provider.name,
      providerType: options.provider.type,
      baseUrl: options.provider.baseUrl,
      useRawBaseUrl: options.provider.useRawBaseUrl,
    };
    await options.secretStore.reloadLocalAuthState(auth.bindingId);
    options.secretStore.clearPendingSessionAuth(descriptor, auth);
    return {
      provider: { ...options.provider, auth: stripSessionAuthState(auth) },
      committedByLeader: true,
    };
  } catch (error) {
    if (isLeaderUnavailableError(error) || isVersionIncompatibleError(error)) {
      if (mainInstance.isLeader() && mainInstance.isReady()) {
        return await persistAndCommitLocally();
      }
    }
    throw error;
  }
}

function captureSaveProviderSourceGuard(options: {
  store: ConfigStore;
  provider: ProviderConfig;
  sourceProvider?: ProviderConfig;
  targetProvider?: ProviderConfig;
  originalName?: string;
}): ProviderSourceGuard {
  const sourceName =
    options.originalName ??
    options.sourceProvider?.name ??
    options.provider.name;
  const sourceProvider =
    options.sourceProvider?.name === sourceName
      ? options.sourceProvider
      : options.store.getProvider(sourceName);
  const captures = [{ providerName: sourceName, provider: sourceProvider }];
  if (sourceName !== options.provider.name) {
    const targetProvider =
      options.targetProvider?.name === options.provider.name
        ? options.targetProvider
        : options.store.getProvider(options.provider.name);
    captures.push({
      providerName: options.provider.name,
      provider: targetProvider,
    });
  }
  return captureProviderSourceGuard(captures);
}

export async function saveProviderDraft(options: {
  draft: ProviderFormDraft;
  store: ConfigStore;
  secretStore: SecretStore;
  existing?: ProviderConfig;
  originalName?: string;
  /** Skip conflict resolution prompt (caller has already handled it) */
  skipConflictResolution?: boolean;
}): Promise<'saved' | 'invalid' | 'cancelled'> {
  // First validate without name uniqueness check
  const errors = validateProviderForm(
    options.draft,
    options.store,
    options.originalName,
    { skipNameUniquenessCheck: true },
  );
  if (errors.length > 0) {
    await showValidationErrors(errors);
    return 'invalid';
  }

  let finalDraft = options.draft;
  let existingToOverwrite: ProviderConfig | undefined;

  // Check for name conflict separately (unless caller already handled it)
  if (!options.skipConflictResolution) {
    const nameConflict = validateProviderNameUnique(
      options.draft.name!,
      options.store,
      options.originalName,
    );

    if (nameConflict) {
      // Name conflicts with an existing provider
      const resolution = await promptConflictResolution({
        kind: 'provider',
        conflicts: [options.draft.name!.trim()],
      });

      if (resolution === 'cancel') {
        return 'cancelled';
      }

      if (resolution === 'rename') {
        // Generate a unique name
        const uniqueName = generateUniqueProviderName(
          options.draft.name!.trim(),
          options.store,
        );
        finalDraft = { ...options.draft, name: uniqueName };
      } else if (resolution === 'overwrite') {
        // Mark the existing provider to be overwritten
        existingToOverwrite = options.store.getProvider(
          options.draft.name!.trim(),
        );
      }
    }
  } else {
    // Caller handled conflict - check if we're overwriting an existing provider
    existingToOverwrite = options.store.getProvider(options.draft.name!.trim());
  }

  const previousProvider = options.existing ?? existingToOverwrite;
  if (
    previousProvider?.auth &&
    isSessionAuthConfig(previousProvider.auth) &&
    options.draft._authCommitGuard?.bindingId !==
      previousProvider.auth.bindingId
  ) {
    captureDraftAuthCommitGuard(options.draft, options.secretStore, {
      auth: previousProvider.auth,
      descriptor: {
        providerName: previousProvider.name,
        providerType: previousProvider.type,
        baseUrl: previousProvider.baseUrl,
        useRawBaseUrl: previousProvider.useRawBaseUrl,
      },
      force: true,
    });
  } else if (!options.draft._authCommitGuard) {
    captureDraftAuthCommitGuard(options.draft, options.secretStore);
  }
  const normalizedProvider = normalizeProviderDraft(finalDraft);
  const sourceGuard = captureSaveProviderSourceGuard({
    store: options.store,
    provider: normalizedProvider,
    sourceProvider: previousProvider,
    targetProvider: existingToOverwrite,
    originalName: options.originalName,
  });

  const providerWithAuth = await applyAuthStoragePolicy({
    store: options.store,
    secretStore: options.secretStore,
    provider: normalizedProvider,
    existing: previousProvider,
  });
  const providerIntent = await applyBalanceStoragePolicy({
    store: options.store,
    secretStore: options.secretStore,
    provider: providerWithAuth,
    existing: options.existing ?? existingToOverwrite,
  });
  let provider = providerIntent;
  const hasSessionAuth =
    providerIntent.auth !== undefined &&
    isSessionAuthConfig(providerIntent.auth);
  const syncOptions = {
    store: options.store,
    secretStore: options.secretStore,
    provider: providerIntent,
    authGuard: resolveDraftAuthCommitGuard(
      options.draft,
      providerIntent.auth,
    ),
    sourceGuard,
    originalName: options.originalName,
    modelSourceIds: options.draft._completionModelSourceIds,
    commitLocalProvider: async (candidate: ProviderConfig) => {
      const updated = await options.store.upsertProviderIfUnchanged(
        candidate,
        {
          ...(options.originalName === undefined
            ? {}
            : { originalName: options.originalName }),
          ...(options.draft._completionModelSourceIds === undefined
            ? {}
            : { modelSourceIds: options.draft._completionModelSourceIds }),
        },
        () =>
          isProviderSourceGuardCurrent(sourceGuard, (providerName) =>
            options.store.getProvider(providerName),
          ),
      );
      if (!updated) throw new LocalAuthStateConflictError();
    },
  };
  try {
    let sessionCommittedByLeader = false;
    if (hasSessionAuth) {
      const synced = await syncPersistedProvider(syncOptions);
      provider = synced.provider;
      sessionCommittedByLeader = synced.committedByLeader;
    }
    if (!sessionCommittedByLeader) {
      await options.store.upsertProvider(provider, {
        ...(options.originalName === undefined
          ? {}
          : { originalName: options.originalName }),
        ...(options.draft._completionModelSourceIds === undefined
          ? {}
          : { modelSourceIds: options.draft._completionModelSourceIds }),
      });
    }
    if (!hasSessionAuth) {
      await syncPersistedProvider(syncOptions);
    }
  } catch (error) {
    if (!isLocalAuthStateConflictError(error)) throw error;
    discardDraftAuthState(options.draft, options.secretStore, previousProvider);
    await vscode.window.showErrorMessage(
      t(
        'Authentication changed on this device while this operation was in progress. Please try again.',
      ),
      { modal: true },
    );
    return 'invalid';
  }
  const draftSessionId = finalDraft._draftSessionId;

  // Handle official models state migration
  if (draftSessionId) {
    if (finalDraft.autoFetchOfficialModels) {
      await officialModelsManager.migrateDraftToProvider(
        draftSessionId,
        provider.name,
      );
    } else {
      officialModelsManager.clearDraftSession(draftSessionId);
    }
  }

  if (mainInstance.isLeader()) {
    await migrateLegacyVSCodeModelIds(options.store);
  }

  vscode.window.showInformationMessage(
    options.existing || existingToOverwrite
      ? t('Provider "{0}" updated.', provider.name)
      : t('Provider "{0}" added.', provider.name),
  );
  return 'saved';
}

export async function duplicateProvider(
  store: ConfigStore,
  secretStore: SecretStore,
  provider: ProviderConfig,
): Promise<void> {
  let baseName = provider.name;
  let newName = `${baseName} (copy)`;
  let counter = 2;

  while (store.getProvider(newName)) {
    newName = `${baseName} (copy ${counter})`;
    counter++;
  }

  const duplicated = deepClone(provider);
  duplicated.name = newName;

  const auth = duplicated.auth;
  if (auth && auth.method !== 'none') {
    const storeSecretsInSettings =
      store.storeApiKeyInSettings && supportsSensitiveAuthInSettings(auth);

    try {
      const authForDuplicate = isSessionAuthConfig(auth)
        ? await secretStore.prepareSessionAuthCommitIntent(
            {
              providerName: provider.name,
              providerType: provider.type,
              baseUrl: provider.baseUrl,
              useRawBaseUrl: provider.useRawBaseUrl,
            },
            secretStore.hydrateSessionAuth(
              {
                providerName: provider.name,
                providerType: provider.type,
                baseUrl: provider.baseUrl,
                useRawBaseUrl: provider.useRawBaseUrl,
              },
              auth,
            ),
          )
        : auth;
      duplicated.auth = await prepareAuthForDuplicate(authForDuplicate, {
        secretStore,
        storeSecretsInSettings,
      });
      if (duplicated.auth) {
        duplicated.auth = renewSessionAuthBinding(duplicated.auth);
      }
    } catch {
      vscode.window.showErrorMessage(
        t(
          'Provider "{0}" authentication data is missing. Please re-enter it before duplicating.',
          provider.name,
        ),
        { modal: true },
      );
      return;
    }
  }

  const balanceProvider = duplicated.balanceProvider;
  if (balanceProvider && balanceProvider.method !== 'none') {
    const definition = getBalanceMethodDefinition(balanceProvider.method);
    if (!definition) {
      vscode.window.showErrorMessage(
        t('Unsupported balance monitor: {0}', balanceProvider.method),
        { modal: true },
      );
      return;
    }

    const storeSecretsInSettings =
      store.storeApiKeyInSettings &&
      definition.supportsSensitiveDataInSettings(balanceProvider);

    try {
      duplicated.balanceProvider = await definition.prepareForDuplicate(
        balanceProvider,
        {
          secretStore,
          storeSecretsInSettings,
        },
      );
    } catch {
      vscode.window.showErrorMessage(
        t(
          'Provider \"{0}\" balance monitor data is missing. Please reconfigure it before duplicating.',
          provider.name,
        ),
        { modal: true },
      );
      return;
    }
  }

  if (duplicated.auth && isSessionAuthConfig(duplicated.auth)) {
    const duplicateSourceGuard = captureProviderSourceGuard([
      { providerName: duplicated.name, provider: undefined },
    ]);
    const persistedDuplicate = await syncPersistedProvider({
      store,
      secretStore,
      provider: duplicated,
      sourceGuard: duplicateSourceGuard,
      commitLocalProvider: async (candidate) => {
        const updated = await store.upsertProviderIfUnchanged(
          candidate,
          {},
          () =>
            isProviderSourceGuardCurrent(duplicateSourceGuard, (providerName) =>
              store.getProvider(providerName),
            ),
        );
        if (!updated) throw new LocalAuthStateConflictError();
      },
    });
    if (!persistedDuplicate.committedByLeader) {
      await store.upsertProvider(persistedDuplicate.provider);
    }
  } else {
    await store.upsertProvider(duplicated);
    await syncPersistedProvider({ store, secretStore, provider: duplicated });
  }
  vscode.window.showInformationMessage(
    t('Provider duplicated as "{0}".', newName),
  );
}

export function buildProviderConfigFromDraft(
  draft: ProviderFormDraft,
): Partial<ProviderConfig> {
  const {
    _draftSessionId: _draftSessionId,
    _completionModelSourceIds: _completionModelSourceIds,
    _authCommitGuard: _authCommitGuard,
    ...rest
  } = deepClone(draft);
  const source: Partial<ProviderConfig> = {
    ...rest,
    name: draft.name?.trim() || undefined,
    baseUrl: draft.baseUrl?.trim() || undefined,
    models: draft.models.length > 0 ? deepClone(draft.models) : undefined,
  };

  const config: Partial<ProviderConfig> = {};
  mergePartialByKeys(config, source, PROVIDER_CONFIG_KEYS);
  return config;
}

type ProviderExportSection = 'models' | 'settings';

async function promptForProviderExportSections(): Promise<
  Set<ProviderExportSection> | undefined
> {
  return new Promise<Set<ProviderExportSection> | undefined>((resolve) => {
    const qp = vscode.window.createQuickPick<
      vscode.QuickPickItem & { section: ProviderExportSection }
    >();
    qp.title = t('Export Provider Configuration');
    qp.placeholder = t('Select what to export');
    qp.matchOnDescription = true;
    qp.matchOnDetail = true;
    qp.canSelectMany = true;
    qp.ignoreFocusOut = true;
    qp.items = [
      {
        label: t('Models'),
        detail: t('Export model configuration array'),
        section: 'models',
        picked: true,
      },
      {
        label: t('Settings'),
        detail: t('Export provider settings'),
        section: 'settings',
        picked: true,
      },
    ];
    qp.selectedItems = qp.items.filter((item) => item.picked);

    let resolved = false;
    const finish = (value: Set<ProviderExportSection> | undefined) => {
      if (resolved) return;
      resolved = true;
      resolve(value);
    };

    qp.onDidAccept(() => {
      const sections = new Set(qp.selectedItems.map((item) => item.section));
      if (sections.size === 0) {
        vscode.window.showErrorMessage(
          t('Select at least one export option.'),
          {
            modal: true,
          },
        );
        return;
      }
      qp.hide();
      finish(sections);
    });

    qp.onDidHide(() => {
      qp.dispose();
      finish(undefined);
    });

    qp.show();
  });
}

export async function promptForSensitiveDataInclusion(): Promise<
  boolean | undefined
> {
  const result = await vscode.window.showQuickPick(
    [
      {
        label: '$(lock) ' + t('Exclude Sensitive Data (Safer)'),
        detail: t(
          'API keys, OAuth tokens, balance system tokens, and client secrets will be removed',
        ),
        picked: true,
        value: false,
      },
      {
        label: '$(unlock) ' + t('Include Sensitive Data (Riskier)'),
        detail: t(
          'API keys, OAuth tokens, balance system tokens, and client secrets will be included in plain text',
        ),
        value: true,
      },
    ],
    {
      placeHolder: t('Select export mode'),
      ignoreFocusOut: true,
      matchOnDescription: true,
      matchOnDetail: true,
    },
  );

  return result ? result.value : undefined;
}

export async function exportProviderConfigFromDraft(options: {
  draft: ProviderFormDraft;
  secretStore: SecretStore;
  allowPartial?: boolean;
}): Promise<void> {
  const sections = options.allowPartial
    ? await promptForProviderExportSections()
    : new Set<ProviderExportSection>(['models', 'settings']);

  if (!sections || sections.size === 0) return;

  const includeSensitive = await promptForSensitiveDataInclusion();
  if (includeSensitive === undefined) return;

  if (sections.has('models') && !sections.has('settings')) {
    await showCopiedBase64Config(options.draft.models);
    return;
  }

  const config = buildProviderConfigFromDraft(options.draft);

  if (!sections.has('models')) {
    const settingsOnly = { ...config };
    delete settingsOnly.models;

    const ok = await resolveAuthForExportOrShowError(
      options.secretStore,
      settingsOnly,
      { includeSensitive },
    );
    if (!ok) return;
    const balanceOk = await resolveBalanceForExportOrShowError(
      options.secretStore,
      settingsOnly,
      { includeSensitive },
    );
    if (!balanceOk) return;
    await showCopiedBase64Config(settingsOnly);
    return;
  }

  const ok = await resolveAuthForExportOrShowError(
    options.secretStore,
    config,
    { includeSensitive },
  );
  if (!ok) return;
  const balanceOk = await resolveBalanceForExportOrShowError(
    options.secretStore,
    config,
    { includeSensitive },
  );
  if (!balanceOk) return;
  await showCopiedBase64Config(config);
}

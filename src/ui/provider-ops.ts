import * as vscode from 'vscode';
import { t } from '../i18n';
import { ConfigStore } from '../config-store';
import {
  deepClone,
  mergePartialByKeys,
  PROVIDER_CONFIG_KEYS,
} from '../config-ops';
import { showValidationErrors } from './component';
import { SecretStore } from '../secret';
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
import { getAuthMethodCtor } from '../auth';
import { getBalanceMethodDefinition } from '../balance';

async function applyAuthStoragePolicy(options: {
  store: ConfigStore;
  secretStore: SecretStore;
  provider: ProviderConfig;
  existing?: ProviderConfig;
}): Promise<ProviderConfig> {
  const next = options.provider;
  const auth = next.auth;
  if (!auth || auth.method === 'none') {
    return next;
  }

  const ctor = getAuthMethodCtor(auth.method);
  if (!ctor) {
    return next;
  }

  const storeSecretsInSettings =
    options.store.storeApiKeyInSettings &&
    ctor.supportsSensitiveDataInSettings(auth);
  const existingAuth = options.existing?.auth;

  const normalized = await ctor.normalizeOnImport(auth, {
    secretStore: options.secretStore,
    storeSecretsInSettings,
    existing: existingAuth?.method === auth.method ? existingAuth : undefined,
  });
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

  const providerWithAuth = await applyAuthStoragePolicy({
    store: options.store,
    secretStore: options.secretStore,
    provider: normalizeProviderDraft(finalDraft),
    existing: options.existing ?? existingToOverwrite,
  });
  const provider = await applyBalanceStoragePolicy({
    store: options.store,
    secretStore: options.secretStore,
    provider: providerWithAuth,
    existing: options.existing ?? existingToOverwrite,
  });

  if (options.originalName && provider.name !== options.originalName) {
    await options.store.removeProvider(options.originalName);
  }
  await options.store.upsertProvider(provider);

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
    const ctor = getAuthMethodCtor(auth.method);
    if (!ctor) {
      vscode.window.showErrorMessage(
        t('Unsupported auth method: {0}', auth.method),
        { modal: true },
      );
      return;
    }

    const storeSecretsInSettings =
      store.storeApiKeyInSettings && ctor.supportsSensitiveDataInSettings(auth);

    try {
      duplicated.auth = await ctor.prepareForDuplicate(auth, {
        secretStore,
        storeSecretsInSettings,
      });
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

  await store.upsertProvider(duplicated);
  vscode.window.showInformationMessage(
    t('Provider duplicated as "{0}".', newName),
  );
}

export function buildProviderConfigFromDraft(
  draft: ProviderFormDraft,
): Partial<ProviderConfig> {
  const { _draftSessionId: _, ...rest } = deepClone(draft);
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

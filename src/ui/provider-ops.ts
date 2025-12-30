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
  ApiKeySecretStore,
  createApiKeySecretRef,
  isApiKeySecretRef,
} from '../api-key-secret-store';
import { resolveApiKeyForExportOrShowError } from '../api-key-utils';
import { showCopiedBase64Config } from './base64-config';
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

async function applyApiKeyStoragePolicy(options: {
  store: ConfigStore;
  apiKeyStore: ApiKeySecretStore;
  provider: ProviderConfig;
  existing?: ProviderConfig;
}): Promise<ProviderConfig> {
  const next = options.provider;
  const storeApiKeyInSettings = options.store.storeApiKeyInSettings;

  const existingRef =
    options.existing?.apiKey && isApiKeySecretRef(options.existing.apiKey)
      ? options.existing.apiKey
      : undefined;

  const status = await options.apiKeyStore.getStatus(next.apiKey);

  if (storeApiKeyInSettings) {
    if (status.kind === 'unset') {
      next.apiKey = undefined;
      return next;
    }
    if (status.kind === 'plain') {
      next.apiKey = status.apiKey;
      return next;
    }
    if (status.kind === 'secret') {
      next.apiKey = status.apiKey;
      return next;
    }
    next.apiKey = status.ref;
    return next;
  }

  // Store in VS Code Secret Storage by default
  if (status.kind === 'unset') {
    next.apiKey = undefined;
    return next;
  }
  if (status.kind === 'plain') {
    const ref = existingRef ?? createApiKeySecretRef();
    await options.apiKeyStore.set(ref, status.apiKey);
    next.apiKey = ref;
    return next;
  }
  if (status.kind === 'secret') {
    next.apiKey = status.ref;
    return next;
  }
  next.apiKey = status.ref;
  return next;
}

export async function saveProviderDraft(options: {
  draft: ProviderFormDraft;
  store: ConfigStore;
  apiKeyStore: ApiKeySecretStore;
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

  const provider = await applyApiKeyStoragePolicy({
    store: options.store,
    apiKeyStore: options.apiKeyStore,
    provider: normalizeProviderDraft(finalDraft),
    existing: options.existing ?? existingToOverwrite,
  });

  if (options.originalName && provider.name !== options.originalName) {
    await options.store.removeProvider(options.originalName);
  }
  await options.store.upsertProvider(provider);

  // Handle official models state migration
  const sessionId = finalDraft._officialModelsSessionId;
  if (sessionId) {
    if (finalDraft.autoFetchOfficialModels) {
      await officialModelsManager.migrateDraftToProvider(
        sessionId,
        provider.name,
      );
    } else {
      officialModelsManager.clearDraftSession(sessionId);
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
  apiKeyStore: ApiKeySecretStore,
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

  const ok = await resolveApiKeyForExportOrShowError(
    apiKeyStore,
    duplicated,
    t(
      'Provider "{0}" API key is missing. Please re-enter it before duplicating.',
      provider.name,
    ),
  );
  if (!ok) return;

  if (!store.storeApiKeyInSettings) {
    if (duplicated.apiKey) {
      const newRef = createApiKeySecretRef();
      await apiKeyStore.set(newRef, duplicated.apiKey);
      duplicated.apiKey = newRef;
    } else {
      duplicated.apiKey = undefined;
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
  const source: Partial<ProviderConfig> = {
    ...deepClone(draft),
    name: draft.name?.trim() || undefined,
    baseUrl: draft.baseUrl?.trim() || undefined,
    apiKey: draft.apiKey?.trim() || undefined,
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

export async function exportProviderConfigFromDraft(options: {
  draft: ProviderFormDraft;
  apiKeyStore: ApiKeySecretStore;
  allowPartial?: boolean;
}): Promise<void> {
  const sections = options.allowPartial
    ? await promptForProviderExportSections()
    : new Set<ProviderExportSection>(['models', 'settings']);

  if (!sections || sections.size === 0) return;

  if (sections.has('models') && !sections.has('settings')) {
    await showCopiedBase64Config(options.draft.models);
    return;
  }

  const config = buildProviderConfigFromDraft(options.draft);

  if (!sections.has('models')) {
    const settingsOnly = { ...config };
    delete settingsOnly.models;

    const ok = await resolveApiKeyForExportOrShowError(
      options.apiKeyStore,
      settingsOnly,
    );
    if (!ok) return;
    await showCopiedBase64Config(settingsOnly);
    return;
  }

  const ok = await resolveApiKeyForExportOrShowError(
    options.apiKeyStore,
    config,
  );
  if (!ok) return;
  await showCopiedBase64Config(config);
}

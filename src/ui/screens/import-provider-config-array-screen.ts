import * as vscode from 'vscode';
import { deepClone } from '../../config-ops';
import {
  confirmCancelImport,
  confirmFinalizeImport,
  showImportReviewPicker,
  type ImportReviewItem,
} from '../import-review';
import { buildProviderDraftFromConfig } from '../import-config';
import { showValidationErrors } from '../component';
import { validateProviderForm, type ProviderFormDraft } from '../form-utils';
import type {
  ImportProviderConfigArrayRoute,
  UiContext,
  UiNavAction,
  UiResume,
} from '../router/types';
import { saveProviderDraft } from '../provider-ops';
import { officialModelsManager } from '../../official-models-manager';
import {
  promptConflictResolution,
  generateUniqueProviderName,
} from '../conflict-resolution';
import { t } from '../../i18n';
import { cleanupUnusedSecrets } from '../../secret';

const editButton: vscode.QuickInputButton = {
  iconPath: new vscode.ThemeIcon('edit'),
  tooltip: t('Edit Provider'),
};

function getProviderDisplayName(
  draft: ProviderFormDraft,
  fallbackIndex: number,
): string {
  const name = draft.name?.trim();
  if (name) return name;
  return t('Provider {0}', fallbackIndex + 1);
}

function buildProviderImportItems(
  drafts: ProviderFormDraft[],
  selectedIds: Set<number>,
): ImportReviewItem[] {
  return drafts.map((draft, index) => {
    const name = getProviderDisplayName(draft, index);
    const modelNames = draft.models
      .map((m) => m.name || m.id)
      .filter((value): value is string => !!value);
    const detail =
      modelNames.length > 0
        ? t('Models: {0}', modelNames.join(', '))
        : t('No models');

    return {
      label: name,
      description: draft.baseUrl,
      detail,
      entryId: index,
      picked: selectedIds.has(index),
      buttons: [editButton],
    };
  });
}

function findDuplicates(values: string[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();

  for (const value of values) {
    if (seen.has(value)) {
      duplicates.add(value);
    } else {
      seen.add(value);
    }
  }

  return [...duplicates];
}

/**
 * Validate selected providers for internal errors only.
 * Does NOT check conflicts with existing store providers.
 */
function validateSelectedProviders(options: {
  drafts: ProviderFormDraft[];
  selectedIds: Set<number>;
  store: UiContext['store'];
}): string[] {
  const selected = [...options.selectedIds]
    .map((id) => ({ id, draft: options.drafts[id] }))
    .filter((entry): entry is { id: number; draft: ProviderFormDraft } =>
      Boolean(entry.draft),
    );

  if (selected.length === 0) {
    return [t('Select at least one provider to import.')];
  }

  const errors: string[] = [];

  const names = selected.map(({ draft }) => draft.name?.trim() ?? '');
  if (names.some((name) => !name)) {
    errors.push(t('Some providers are missing names. Please edit them first.'));
  }

  // Check for duplicates within imported configs (invalid config error)
  const duplicates = findDuplicates(names.filter((name) => !!name));
  if (duplicates.length > 0) {
    errors.push(t('Provider name conflicts: {0}', duplicates.join(', ')));
  }

  // Validate each provider, but skip name uniqueness check (handled separately)
  for (const { id, draft } of selected) {
    const providerErrors = validateProviderForm(
      draft,
      options.store,
      undefined,
      {
        skipNameUniquenessCheck: true,
      },
    );
    if (providerErrors.length > 0) {
      const displayName = getProviderDisplayName(draft, id);
      for (const err of providerErrors) {
        errors.push(t('{0}: {1}', displayName, err));
      }
    }
  }

  return errors;
}

/**
 * Find providers that conflict with existing store providers.
 */
function findStoreConflicts(options: {
  drafts: ProviderFormDraft[];
  selectedIds: Set<number>;
  store: UiContext['store'];
}): string[] {
  const conflicts: string[] = [];

  for (const id of options.selectedIds) {
    const draft = options.drafts[id];
    if (!draft) continue;

    const name = draft.name?.trim();
    if (name && options.store.getProvider(name)) {
      conflicts.push(name);
    }
  }

  return [...new Set(conflicts)];
}

export async function runImportProviderConfigArrayScreen(
  ctx: UiContext,
  route: ImportProviderConfigArrayRoute,
  resume: UiResume | undefined,
): Promise<UiNavAction> {
  if (resume?.kind === 'providerDraftFormResult') {
    const entryId = route.editingEntryId;
    route.editingEntryId = undefined;

    if (entryId !== undefined && route.drafts?.[entryId]) {
      if (resume.result.kind === 'saved') {
        route.drafts[entryId] = resume.result.draft;
      }
    }
  }

  if (!route.drafts) {
    route.drafts = route.configs.map(buildProviderDraftFromConfig);
  }
  const drafts = route.drafts;
  if (drafts.length === 0) {
    vscode.window.showInformationMessage(t('No providers found to import.'));
    return { kind: 'pop' };
  }
  if (!route.selectedIds) {
    route.selectedIds = new Set(drafts.map((_, index) => index));
  }

  const pickerResult = await showImportReviewPicker({
    title: t('Import Providers From Config'),
    placeholder: t('Select providers to import'),
    items: buildProviderImportItems(drafts, route.selectedIds),
  });

  if (pickerResult.kind === 'back') {
    const confirmed = await confirmCancelImport();
    if (!confirmed) return { kind: 'stay' };

    for (const draft of drafts) {
      const sessionId = draft._draftSessionId;
      if (sessionId) {
        officialModelsManager.clearDraftSession(sessionId);
      }
    }

    await cleanupUnusedSecrets(ctx.secretStore);

    return { kind: 'pop' };
  }

  route.selectedIds = pickerResult.selectedIds;

  if (pickerResult.kind === 'edit') {
    const draft = drafts[pickerResult.entryId];
    if (!draft) {
      vscode.window.showErrorMessage(t('Provider not found.'));
      return { kind: 'stay' };
    }

    route.editingEntryId = pickerResult.entryId;
    const editable = deepClone(draft);
    return {
      kind: 'push',
      route: {
        kind: 'providerDraftForm',
        draft: editable,
        original: deepClone(editable),
      },
    };
  }

  // Step 1: Validate for internal errors (excluding store conflicts)
  const validationErrors = validateSelectedProviders({
    drafts,
    selectedIds: route.selectedIds,
    store: ctx.store,
  });
  if (validationErrors.length > 0) {
    await showValidationErrors(validationErrors);
    return { kind: 'stay' };
  }

  // Step 2: Check for conflicts with existing store providers
  const storeConflicts = findStoreConflicts({
    drafts,
    selectedIds: route.selectedIds,
    store: ctx.store,
  });

  if (storeConflicts.length > 0) {
    const resolution = await promptConflictResolution({
      kind: 'provider',
      conflicts: storeConflicts,
    });

    if (resolution === 'cancel') {
      return { kind: 'stay' };
    }

    // Apply resolution to all conflicting drafts
    for (const id of route.selectedIds) {
      const draft = drafts[id];
      if (!draft) continue;

      const name = draft.name?.trim();
      if (!name || !storeConflicts.includes(name)) continue;

      if (resolution === 'rename') {
        draft.name = generateUniqueProviderName(name, ctx.store);
      }
      // For 'overwrite', we don't need to modify the draft - upsertProvider will handle it
    }
  }

  const selectedDrafts = [...route.selectedIds]
    .map((id) => drafts[id])
    .filter((draft): draft is ProviderFormDraft => Boolean(draft));
  const ok = await confirmFinalizeImport({
    count: selectedDrafts.length,
    itemLabel: 'provider',
  });
  if (!ok) return { kind: 'stay' };

  for (const draft of selectedDrafts) {
    const saved = await saveProviderDraft({
      draft,
      store: ctx.store,
      secretStore: ctx.secretStore,
      skipConflictResolution: true,
    });
    if (saved !== 'saved') {
      return { kind: 'stay' };
    }
  }

  return { kind: 'pop' };
}

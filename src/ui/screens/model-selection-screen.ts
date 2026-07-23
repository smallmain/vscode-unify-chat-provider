import * as vscode from 'vscode';
import { formatModelDetail } from '../form-utils';
import type {
  ModelSelectionRoute,
  UiContext,
  UiNavAction,
  UiResume,
} from '../router/types';
import { ModelConfig } from '../../types';
import {
  promptConflictResolution,
  generateUniqueModelIdAndName,
} from '../conflict-resolution';
import { t } from '../../i18n';
import { pickAsyncQuickItems } from '../component';

type ModelSelectionItem = vscode.QuickPickItem & {
  model: ModelConfig;
};

export async function runModelSelectionScreen(
  _ctx: UiContext,
  route: ModelSelectionRoute,
  _resume: UiResume | undefined,
): Promise<UiNavAction> {
  const selected = await showModelSelectionPicker(route);
  if (!selected) return { kind: 'pop' };

  const resume: UiResume = { kind: 'modelSelectionResult', models: selected };
  return { kind: 'pop', resume };
}

async function showModelSelectionPicker(
  route: ModelSelectionRoute,
): Promise<ModelConfig[] | undefined> {
  let acceptedModels: ModelConfig[] | undefined;
  const selected = await pickAsyncQuickItems<ModelSelectionItem>({
    title: route.title,
    loadingPlaceholder: t('Loading models...'),
    placeholder: t('Select models to add'),
    matchOnDescription: true,
    matchOnDetail: true,
    canSelectMany: true,
    ignoreFocusOut: true,
    emptyItem: {
      label: `$(info) ${t('No models available')}`,
      description: t('The API returned no models'),
    },
    loadItems: async () => ({
      items: (await route.fetchModels()).map((model) => ({
        label: model.name || model.id,
        description: model.name ? model.id : undefined,
        detail: formatModelDetail(model),
        model,
        picked: false,
      })),
    }),
    onWillAccept: async (selectedItems) => {
      const selectedModels = selectedItems.map((item) => ({ ...item.model }));
      const existingIds = new Set(route.existingModels.map((m) => m.id));
      const conflicts = selectedModels
        .map((m) => m.id)
        .filter((id) => existingIds.has(id));

      if (conflicts.length > 0) {
        // Prompt user for conflict resolution
        const resolution = await promptConflictResolution({
          kind: 'model',
          conflicts: [...new Set(conflicts)],
        });

        if (resolution === 'cancel') {
          return false;
        }

        const allExistingModels = [...route.existingModels];

        for (const model of selectedModels) {
          if (!existingIds.has(model.id)) continue;

          if (resolution === 'rename') {
            const result = generateUniqueModelIdAndName(
              model.id,
              model.name,
              allExistingModels,
            );
            model.id = result.id;
            if (result.name) {
              model.name = result.name;
            }
            allExistingModels.push({ id: model.id });
          } else if (resolution === 'overwrite') {
            const existingIndex = route.existingModels.findIndex(
              (m) => m.id === model.id,
            );
            if (existingIndex !== -1) {
              route.existingModels.splice(existingIndex, 1);
            }
          }
        }
      }

      const seenIds = new Set<string>();
      const allExistingForDupes = [...route.existingModels];
      for (const model of selectedModels) {
        if (seenIds.has(model.id)) {
          const result = generateUniqueModelIdAndName(
            model.id,
            model.name,
            allExistingForDupes,
          );
          model.id = result.id;
          if (result.name) {
            model.name = result.name;
          }
        }
        seenIds.add(model.id);
        allExistingForDupes.push({ id: model.id });
      }
      acceptedModels = selectedModels;
      return true;
    },
  });

  if (!selected || !acceptedModels) return undefined;
  vscode.window.showInformationMessage(
    t(
      'Added {0} model(s): {1}',
      acceptedModels.length,
      acceptedModels.map((model) => model.name || model.id).join(', '),
    ),
  );
  return acceptedModels;
}

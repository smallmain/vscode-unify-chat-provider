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

type ModelSelectionItem = vscode.QuickPickItem & {
  model?: ModelConfig;
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
  return new Promise<ModelConfig[] | undefined>((resolve) => {
    const qp = vscode.window.createQuickPick<ModelSelectionItem>();
    qp.title = route.title;
    qp.placeholder = 'Loading models...';
    qp.canSelectMany = true;
    qp.ignoreFocusOut = true;
    qp.busy = true;
    qp.buttons = [vscode.QuickInputButtons.Back];
    qp.items = [];

    let resolved = false;
    let isLoading = true;

    const finish = (value: ModelConfig[] | undefined) => {
      if (resolved) return;
      resolved = true;
      resolve(value);
    };

    route
      .fetchModels()
      .then((models) => {
        isLoading = false;
        qp.busy = false;
        qp.placeholder = 'Select models to add';

        const items: ModelSelectionItem[] = [];

        for (const model of models) {
          items.push({
            label: model.name || model.id,
            description: model.name ? model.id : undefined,
            detail: formatModelDetail(model),
            model,
            picked: false,
          });
        }

        if (models.length === 0) {
          items.push({
            label: '$(info) No models available',
            description: 'The API returned no models',
          });
        }

        qp.items = items;
      })
      .catch((error) => {
        isLoading = false;
        qp.busy = false;
        qp.placeholder = 'Failed to load models';
        qp.canSelectMany = false;
        qp.items = [
          {
            label: '$(error) Failed to load models',
            description: error instanceof Error ? error.message : String(error),
          },
        ];
      });

    qp.onDidTriggerButton((button) => {
      if (button === vscode.QuickInputButtons.Back) {
        qp.hide();
        finish(undefined);
      }
    });

    qp.onDidAccept(async () => {
      const selectedItems = qp.selectedItems;

      if (isLoading || selectedItems.length === 0) {
        return;
      }

      // Collect selected models
      const selectedModels = selectedItems
        .filter((item) => item.model)
        .map((item) => ({ ...item.model! }));

      if (selectedModels.length === 0) {
        return;
      }

      // Find conflicts with existing models
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
          return;
        }

        // Build a list of all existing models for generating unique IDs
        const allExistingModels = [...route.existingModels];

        // Apply resolution to all models
        for (const model of selectedModels) {
          if (!existingIds.has(model.id)) continue;

          if (resolution === 'rename') {
            // Generate unique model ID and name
            const result = generateUniqueModelIdAndName(
              model.id,
              model.name,
              allExistingModels,
            );
            model.id = result.id;
            if (result.name) {
              model.name = result.name;
            }
            // Track for subsequent conflict checks
            allExistingModels.push({ id: model.id });
          } else if (resolution === 'overwrite') {
            // Remove the existing model from existingModels
            const existingIndex = route.existingModels.findIndex(
              (m) => m.id === model.id,
            );
            if (existingIndex !== -1) {
              route.existingModels.splice(existingIndex, 1);
            }
          }
        }
      }

      // Handle duplicates within the selection itself (same model selected twice won't happen,
      // but if well-known list has duplicates we need to handle it)
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

      vscode.window.showInformationMessage(
        `Added ${selectedModels.length} model(s): ${selectedModels
          .map((m) => m.name || m.id)
          .join(', ')}`,
      );

      qp.hide();
      finish(selectedModels);
    });

    qp.onDidHide(() => {
      qp.dispose();
      finish(undefined);
    });

    qp.show();
  });
}

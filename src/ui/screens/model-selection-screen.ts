import * as vscode from 'vscode';
import { generateAutoVersionedId } from '../../model-id-utils';
import { formatModelDetail } from '../form-utils';
import type {
  ModelSelectionRoute,
  UiContext,
  UiNavAction,
  UiResume,
} from '../router/types';
import { ModelConfig } from '../../types';

type ModelSelectionItem = vscode.QuickPickItem & {
  model?: ModelConfig;
  action?: 'back';
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
    qp.items = [{ label: '$(arrow-left) Back', action: 'back' }];

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

        const existingIds = new Set(route.existingModels.map((m) => m.id));
        const items: ModelSelectionItem[] = [
          { label: '$(arrow-left) Back', action: 'back' },
          { label: '', kind: vscode.QuickPickItemKind.Separator },
        ];

        for (const model of models) {
          const alreadyExists = existingIds.has(model.id);
          let detail: string | undefined;

          if (alreadyExists) {
            const newId = generateAutoVersionedId(
              model.id,
              route.existingModels,
            );
            detail = `(already exists, will add as ${newId})`;
          } else {
            detail = formatModelDetail(model);
          }

          items.push({
            label: model.name || model.id,
            description: model.name ? model.id : undefined,
            detail,
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
          { label: '$(arrow-left) Back', action: 'back' },
          { label: '', kind: vscode.QuickPickItemKind.Separator },
          {
            label: '$(error) Failed to load models',
            description: error instanceof Error ? error.message : String(error),
          },
        ];
      });

    qp.onDidAccept(() => {
      const selectedItems = qp.selectedItems;

      if (selectedItems.some((item) => item.action === 'back')) {
        qp.hide();
        finish(undefined);
        return;
      }

      if (isLoading || selectedItems.length === 0) {
        return;
      }

      const existingIds = new Set(route.existingModels.map((m) => m.id));
      const newModels: ModelConfig[] = [];
      const addedInBatch: ModelConfig[] = [];

      for (const item of selectedItems) {
        if (!item.model) continue;

        const combinedModels = [...route.existingModels, ...addedInBatch];
        let newId = item.model.id;

        if (
          existingIds.has(item.model.id) ||
          addedInBatch.some((m) => m.id === item.model!.id)
        ) {
          newId = generateAutoVersionedId(item.model.id, combinedModels);
        }

        const newModel = { ...item.model, id: newId };
        newModels.push(newModel);
        addedInBatch.push(newModel);
      }

      if (newModels.length > 0) {
        vscode.window.showInformationMessage(
          `Added ${newModels.length} model(s): ${newModels
            .map((m) => m.name || m.id)
            .join(', ')}`,
        );
      }

      qp.hide();
      finish(newModels.length > 0 ? newModels : undefined);
    });

    qp.onDidChangeSelection((items) => {
      if (items.some((item) => item.action === 'back')) {
        qp.hide();
        finish(undefined);
      }
    });

    qp.onDidHide(() => {
      qp.dispose();
      finish(undefined);
    });

    qp.show();
  });
}

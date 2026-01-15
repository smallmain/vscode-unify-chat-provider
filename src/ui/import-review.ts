import * as vscode from 'vscode';
import { t } from '../i18n';

export type ImportReviewItem = vscode.QuickPickItem & {
  entryId?: number;
};

export type ImportReviewResult =
  | { kind: 'back' }
  | { kind: 'edit'; entryId: number; selectedIds: Set<number> }
  | { kind: 'accept'; selectedIds: Set<number> };

function collectSelectedIds(items: readonly ImportReviewItem[]): Set<number> {
  return new Set(
    items
      .map((item) => item.entryId)
      .filter((id): id is number => typeof id === 'number'),
  );
}

export async function showImportReviewPicker(options: {
  title: string;
  placeholder: string;
  items: ImportReviewItem[];
}): Promise<ImportReviewResult> {
  return new Promise<ImportReviewResult>((resolve) => {
    const qp = vscode.window.createQuickPick<ImportReviewItem>();
    qp.title = options.title;
    qp.placeholder = options.placeholder;
    qp.canSelectMany = true;
    qp.ignoreFocusOut = true;
    qp.buttons = [vscode.QuickInputButtons.Back];
    qp.items = options.items;
    qp.selectedItems = qp.items.filter((item) => item.picked);

    let resolved = false;

    const finish = (value: ImportReviewResult) => {
      if (resolved) return;
      resolved = true;
      resolve(value);
    };

    qp.onDidTriggerButton((button) => {
      if (button !== vscode.QuickInputButtons.Back) return;
      finish({ kind: 'back' });
      qp.hide();
    });

    qp.onDidTriggerItemButton((event) => {
      const entryId = event.item.entryId;
      if (entryId === undefined) return;

      const selectedIds = collectSelectedIds(qp.selectedItems);
      finish({ kind: 'edit', entryId, selectedIds });
      qp.hide();
    });

    qp.onDidAccept(() => {
      const selectedIds = collectSelectedIds(qp.selectedItems);
      finish({ kind: 'accept', selectedIds });
      qp.hide();
    });

    qp.onDidHide(() => {
      if (!resolved) {
        finish({ kind: 'back' });
      }
      qp.dispose();
    });

    qp.show();
  });
}

export async function confirmCancelImport(): Promise<boolean> {
  const choice = await vscode.window.showWarningMessage(
    t('Cancel import? Your changes will be lost.'),
    { modal: true },
    t('Cancel Import'),
  );
  return choice === t('Cancel Import');
}

export async function confirmFinalizeImport(options: {
  count: number;
  itemLabel: 'provider' | 'model';
}): Promise<boolean> {
  const labelKey: 'provider' | 'providers' | 'model' | 'models' =
    options.count === 1
      ? options.itemLabel
      : options.itemLabel === 'provider'
        ? 'providers'
        : 'models';
  const label =
    labelKey === 'provider'
      ? t('provider')
      : labelKey === 'providers'
        ? t('providers')
        : labelKey === 'model'
          ? t('model')
          : t('models');
  const choice = await vscode.window.showWarningMessage(
    t('Import {0} {1}?', options.count, label),
    { modal: true },
    t('Import'),
  );
  return choice === t('Import');
}

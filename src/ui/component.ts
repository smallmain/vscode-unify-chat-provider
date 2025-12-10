import * as vscode from 'vscode';

export interface QuickPickConfig<T extends vscode.QuickPickItem> {
  title?: string;
  placeholder?: string;
  items: readonly T[];
  matchOnDescription?: boolean;
  matchOnDetail?: boolean;
  ignoreFocusOut?: boolean;
  /**
   * Return false to keep the picker open (e.g., failed validation).
   */
  onWillAccept?: (
    item: T,
    quickPick: vscode.QuickPick<T>,
  ) => Promise<boolean | void> | boolean | void;
  onDidTriggerItemButton?: (
    event: vscode.QuickPickItemButtonEvent<T>,
    quickPick: vscode.QuickPick<T>,
  ) => void | Promise<void>;
}

export async function pickQuickItem<T extends vscode.QuickPickItem>(
  config: QuickPickConfig<T>,
): Promise<T | undefined> {
  const qp = vscode.window.createQuickPick<T>();
  qp.title = config.title;
  qp.placeholder = config.placeholder;
  qp.matchOnDescription = config.matchOnDescription ?? false;
  qp.matchOnDetail = config.matchOnDetail ?? false;
  qp.ignoreFocusOut = config.ignoreFocusOut ?? false;
  qp.items = [...config.items];

  let resolved = false;

  return new Promise<T | undefined>((resolve) => {
    const finish = (value: T | undefined) => {
      if (resolved) return;
      resolved = true;
      resolve(value);
    };

    const accept = async (item?: T) => {
      let shouldClose = true;
      if (!item) return;
      try {
        if (config.onWillAccept) {
          const result = await config.onWillAccept(item, qp);
          if (result === false) {
            qp.selectedItems = [];
            shouldClose = false;
          }
        }
        if (shouldClose) {
          finish(item);
          qp.hide();
        }
      } catch {
        // ignore and allow further interaction
      }
    };

    qp.onDidChangeSelection((items) => accept(items[0]));
    qp.onDidAccept(() => accept(qp.selectedItems[0]));

    if (config.onDidTriggerItemButton) {
      qp.onDidTriggerItemButton(async (event) => {
        await config.onDidTriggerItemButton?.(event, qp);
      });
    }

    qp.onDidHide(() => {
      finish(undefined);
      qp.dispose();
    });

    qp.show();
  });
}

export async function showInput(options: {
  prompt: string;
  value?: string;
  placeHolder?: string;
  password?: boolean;
  validateInput?: (s: string) => string | null;
}): Promise<string | undefined> {
  const { prompt, value, placeHolder, password, validateInput } = options;
  return vscode.window.showInputBox({
    prompt,
    value,
    placeHolder,
    password,
    validateInput,
  });
}

export async function showValidationErrors(errors: string[]): Promise<void> {
  if (errors.length === 0) return;
  await vscode.window.showErrorMessage(
    `Please fix the following:\n${errors.join('\n')}`,
  );
}

/**
 * Show a confirmation dialog for delete actions.
 * Returns true if the user confirmed.
 */
export async function confirmDelete(
  itemName: string,
  itemType = 'item',
): Promise<boolean> {
  const result = await vscode.window.showWarningMessage(
    `Delete ${itemType} "${itemName}"?`,
    { modal: true },
    'Delete',
  );
  return result === 'Delete';
}

/**
 * Show a confirmation dialog for remove actions.
 * Returns true if the user confirmed.
 */
export async function confirmRemove(
  itemName: string,
  itemType = 'item',
): Promise<boolean> {
  const result = await vscode.window.showWarningMessage(
    `Are you sure you want to remove ${itemType} "${itemName}"?`,
    { modal: true },
    'Remove',
  );
  return result === 'Remove';
}

/**
 * Show a success message for item deletion.
 */
export function showDeletedMessage(itemName: string, itemType = 'item'): void {
  vscode.window.showInformationMessage(
    `${capitalize(itemType)} "${itemName}" has been deleted.`,
  );
}

/**
 * Show a success message for item removal.
 */
export function showRemovedMessage(itemName: string, itemType = 'item'): void {
  vscode.window.showInformationMessage(
    `${capitalize(itemType)} "${itemName}" has been removed.`,
  );
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

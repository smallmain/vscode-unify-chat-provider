import * as vscode from 'vscode';
import { t } from '../i18n';

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
  ) => void | T | Promise<void | T>;
  /**
   * Title-bar buttons shown in the top-right of the QuickPick.
   * Clicks do not close the picker; update `quickPick.buttons` to reflect state.
   */
  buttons?: readonly vscode.QuickInputButton[];
  onDidTriggerButton?: (
    button: vscode.QuickInputButton,
    quickPick: vscode.QuickPick<T>,
  ) => void | Promise<void>;
  /**
   * Handle inline actions that should not close the picker.
   * Return true to keep the picker open (action was handled inline).
   * Return false or undefined to close the picker normally.
   */
  onInlineAction?: (
    item: T,
    quickPick: vscode.QuickPick<T>,
  ) => Promise<boolean | void> | boolean | void;
  /**
   * Subscribe to external events that should trigger an items refresh.
   * The callback receives a function to rebuild items when external state changes,
   * plus the QuickPick instance (e.g. to update `buttons` alongside items).
   * Returns a disposable to unsubscribe.
   */
  onExternalRefresh?: (
    refreshItems: (newItems: readonly T[]) => void,
    quickPick: vscode.QuickPick<T>,
  ) => vscode.Disposable;
}

export async function pickQuickItem<T extends vscode.QuickPickItem>(
  config: QuickPickConfig<T>,
): Promise<T | undefined> {
  const qp = vscode.window.createQuickPick<T>();
  qp.title = config.title;
  qp.placeholder = config.placeholder;
  qp.matchOnDescription = config.matchOnDescription ?? true;
  qp.matchOnDetail = config.matchOnDetail ?? true;
  qp.ignoreFocusOut = config.ignoreFocusOut ?? false;
  qp.items = [...config.items];
  if (config.buttons) {
    qp.buttons = [...config.buttons];
  }

  let resolved = false;
  let accepting = false;

  return new Promise<T | undefined>((resolve) => {
    const finish = (value: T | undefined) => {
      if (resolved) return;
      resolved = true;
      resolve(value);
    };

    const accept = async (item?: T) => {
      let shouldClose = true;
      if (!item) return;
      if (accepting) return;
      accepting = true;
      try {
        // Check for inline action first
        if (config.onInlineAction) {
          const handled = await config.onInlineAction(item, qp);
          if (handled === true) {
            qp.selectedItems = [];
            return; // Action handled inline, keep picker open
          }
        }
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
      } finally {
        accepting = false;
      }
    };

    qp.onDidChangeSelection((items) => accept(items[0]));
    qp.onDidAccept(() => accept(qp.selectedItems[0]));

    if (config.onDidTriggerItemButton) {
      qp.onDidTriggerItemButton(async (event) => {
        try {
          const result = await config.onDidTriggerItemButton?.(event, qp);
          if (result !== undefined) {
            finish(result);
            qp.hide();
          }
        } catch {
          // ignore and allow further interaction
        }
      });
    }

    // Subscribe to external refresh events
    let externalRefreshDisposable: vscode.Disposable | undefined;
    if (config.onExternalRefresh) {
      externalRefreshDisposable = config.onExternalRefresh(
        (newItems) => {
          qp.items = [...newItems];
        },
        qp,
      );
    }

    if (config.onDidTriggerButton) {
      let handlingButton = false;
      qp.onDidTriggerButton(async (button) => {
        if (handlingButton) return;
        handlingButton = true;
        try {
          await config.onDidTriggerButton?.(button, qp);
        } catch {
          // ignore and allow further interaction
        } finally {
          handlingButton = false;
        }
      });
    }

    qp.onDidHide(() => {
      externalRefreshDisposable?.dispose();
      finish(undefined);
      qp.dispose();
    });

    qp.show();
  });
}

export interface AsyncQuickPickFailure {
  readonly label?: string;
  readonly message: string;
}

export interface AsyncQuickPickLoadResult<T extends vscode.QuickPickItem> {
  readonly items: readonly T[];
  readonly failures?: readonly AsyncQuickPickFailure[];
  readonly retry?: () => Promise<AsyncQuickPickLoadResult<T>>;
}

export interface AsyncQuickPickConfig<T extends vscode.QuickPickItem> {
  readonly title?: string;
  readonly loadingPlaceholder?: string;
  readonly placeholder: string;
  readonly loadItems: () => Promise<AsyncQuickPickLoadResult<T>>;
  readonly emptyItem?: vscode.QuickPickItem;
  readonly retryLabel?: string;
  readonly matchOnDescription?: boolean;
  readonly matchOnDetail?: boolean;
  readonly ignoreFocusOut?: boolean;
  readonly canSelectMany?: boolean;
  readonly buttons?: readonly vscode.QuickInputButton[];
  readonly onWillAccept?: (
    items: readonly T[],
  ) => Promise<boolean | void> | boolean | void;
}

const ASYNC_ITEM_VALUE = Symbol('asyncQuickPickValue');
const ASYNC_ITEM_ACTION = Symbol('asyncQuickPickAction');

type AsyncQuickPickAction = 'status' | 'retry';

type InternalAsyncQuickPickItem<T extends vscode.QuickPickItem> =
  | (vscode.QuickPickItem & { readonly [ASYNC_ITEM_VALUE]: T })
  | (vscode.QuickPickItem & {
      readonly [ASYNC_ITEM_ACTION]: AsyncQuickPickAction;
    });

function toInternalAsyncValue<T extends vscode.QuickPickItem>(
  item: T,
): InternalAsyncQuickPickItem<T> {
  return { ...item, [ASYNC_ITEM_VALUE]: item };
}

function asyncItemValue<T extends vscode.QuickPickItem>(
  item: InternalAsyncQuickPickItem<T>,
): T | undefined {
  return ASYNC_ITEM_VALUE in item ? item[ASYNC_ITEM_VALUE] : undefined;
}

function asyncItemAction<T extends vscode.QuickPickItem>(
  item: InternalAsyncQuickPickItem<T>,
): AsyncQuickPickAction | undefined {
  return ASYNC_ITEM_ACTION in item ? item[ASYNC_ITEM_ACTION] : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Shows a QuickPick immediately while its items load. Loading failures stay in
 * the picker and can be retried; closing the picker does not cancel the loader.
 */
export async function pickAsyncQuickItems<T extends vscode.QuickPickItem>(
  config: AsyncQuickPickConfig<T>,
): Promise<readonly T[] | undefined> {
  const qp = vscode.window.createQuickPick<InternalAsyncQuickPickItem<T>>();
  qp.title = config.title;
  qp.placeholder = config.loadingPlaceholder ?? t('Loading...');
  qp.matchOnDescription = config.matchOnDescription ?? true;
  qp.matchOnDetail = config.matchOnDetail ?? true;
  qp.ignoreFocusOut = config.ignoreFocusOut ?? false;
  qp.canSelectMany = config.canSelectMany ?? false;
  qp.buttons = config.buttons
    ? [...config.buttons]
    : [vscode.QuickInputButtons.Back];
  qp.items = [];
  qp.busy = true;

  let accepting = false;
  let closed = false;
  let resolved = false;
  let currentResult: AsyncQuickPickLoadResult<T> | undefined;

  return new Promise<readonly T[] | undefined>((resolve) => {
    const finish = (value: readonly T[] | undefined) => {
      if (resolved) return;
      resolved = true;
      resolve(value);
    };

    const render = (result: AsyncQuickPickLoadResult<T>) => {
      if (closed) return;
      currentResult = result;
      const items: InternalAsyncQuickPickItem<T>[] = result.items.map(
        toInternalAsyncValue,
      );

      if (result.items.length === 0) {
        items.push({
          ...(config.emptyItem ?? {
            label: `$(info) ${t('No items available')}`,
          }),
          [ASYNC_ITEM_ACTION]: 'status',
        });
      }

      for (const failure of result.failures ?? []) {
        items.push({
          label: `$(warning) ${failure.label ?? t('Failed to load')}`,
          detail: failure.message,
          [ASYNC_ITEM_ACTION]: 'status',
        });
      }

      if (result.retry) {
        items.push({
          label: `$(refresh) ${config.retryLabel ?? t('Retry')}`,
          [ASYNC_ITEM_ACTION]: 'retry',
        });
      }

      qp.items = items;
      qp.placeholder = config.placeholder;
      qp.busy = false;
    };

    const load = async (
      loader: () => Promise<AsyncQuickPickLoadResult<T>>,
      preserveItems: boolean,
    ) => {
      if (closed) return;
      qp.busy = true;
      qp.placeholder = config.loadingPlaceholder ?? t('Loading...');
      if (!preserveItems) qp.items = [];
      try {
        render(await loader());
      } catch (error) {
        render({
          items: preserveItems ? (currentResult?.items ?? []) : [],
          failures: [{ message: errorMessage(error) }],
          retry: loader,
        });
      }
    };

    const accept = async () => {
      if (accepting || qp.busy) return;
      const retryItem = qp.selectedItems.find(
        (item) => asyncItemAction(item) === 'retry',
      );
      if (retryItem) {
        const retry = currentResult?.retry ?? config.loadItems;
        await load(retry, true);
        return;
      }

      const values = qp.selectedItems
        .map(asyncItemValue)
        .filter((item): item is T => item !== undefined);
      if (values.length === 0) return;

      accepting = true;
      try {
        if ((await config.onWillAccept?.(values)) === false) return;
        finish(values);
        qp.hide();
      } catch {
        // Keep the picker open so the user can retry the action.
      } finally {
        accepting = false;
      }
    };

    qp.onDidChangeSelection(() => {
      if (!qp.canSelectMany) void accept();
    });
    qp.onDidAccept(() => void accept());
    qp.onDidTriggerButton((button) => {
      if (button === vscode.QuickInputButtons.Back) qp.hide();
    });
    qp.onDidHide(() => {
      closed = true;
      finish(undefined);
      qp.dispose();
    });

    qp.show();
    void load(config.loadItems, false);
  });
}

/**
 * Show an input box with optional async validation on accept.
 * If onWillAccept returns false, the input box stays open with the user's input preserved.
 * If onWillAccept returns { value: string }, that value is used instead of the input value.
 */
export async function showInput(options: {
  title?: string;
  prompt: string;
  value?: string;
  placeHolder?: string;
  password?: boolean;
  ignoreFocusOut?: boolean;
  showBackButton?: boolean;
  validateInput?: (s: string) => string | null;
  /**
   * Called when user presses Enter. Return false to keep the input box open.
   * Return { value: string } to override the accepted value.
   * Can be used for async validation or confirmation dialogs.
   */
  onWillAccept?: (
    value: string,
  ) =>
    | Promise<boolean | { value: string } | void>
    | boolean
    | { value: string }
    | void;
}): Promise<string | undefined> {
  const {
    title,
    prompt,
    value,
    placeHolder,
    password,
    ignoreFocusOut,
    showBackButton,
    validateInput,
    onWillAccept,
  } = options;

  const isPasswordInput = password ?? false;
  const hasBackButton = showBackButton ?? false;

  const inputBox = vscode.window.createInputBox();
  inputBox.title = title;
  inputBox.prompt = prompt;
  inputBox.value = value ?? '';
  inputBox.placeholder = placeHolder;
  inputBox.password = isPasswordInput;
  inputBox.ignoreFocusOut = ignoreFocusOut ?? false;

  const showValueButton: vscode.QuickInputButton = {
    iconPath: new vscode.ThemeIcon('eye'),
    tooltip: t('Show'),
  };
  const hideValueButton: vscode.QuickInputButton = {
    iconPath: new vscode.ThemeIcon('eye-closed'),
    tooltip: t('Hide'),
  };

  const updateButtons = () => {
    const buttons: vscode.QuickInputButton[] = [];
    if (hasBackButton) {
      buttons.push(vscode.QuickInputButtons.Back);
    }
    if (isPasswordInput) {
      buttons.push(inputBox.password ? showValueButton : hideValueButton);
    }
    inputBox.buttons = buttons;
  };

  if (hasBackButton || isPasswordInput) {
    updateButtons();
  }

  let resolved = false;

  return new Promise<string | undefined>((resolve) => {
    const finish = (result: string | undefined) => {
      if (resolved) return;
      resolved = true;
      resolve(result);
    };

    if (hasBackButton || isPasswordInput) {
      inputBox.onDidTriggerButton((button) => {
        if (button === vscode.QuickInputButtons.Back) {
          finish(undefined);
          inputBox.hide();
          return;
        }

        if (
          isPasswordInput &&
          (button === showValueButton || button === hideValueButton)
        ) {
          inputBox.password = !inputBox.password;
          updateButtons();
        }
      });
    }

    // Sync validation on every keystroke
    inputBox.onDidChangeValue((text) => {
      if (validateInput) {
        const error = validateInput(text);
        inputBox.validationMessage = error ?? undefined;
      }
    });

    // Trigger initial validation
    if (validateInput && inputBox.value) {
      const error = validateInput(inputBox.value);
      inputBox.validationMessage = error ?? undefined;
    }

    inputBox.onDidAccept(async () => {
      // Don't accept if there's a sync validation error
      if (inputBox.validationMessage) {
        return;
      }

      const currentValue = inputBox.value;
      let finalValue = currentValue;

      // Run async validation/confirmation
      if (onWillAccept) {
        try {
          inputBox.ignoreFocusOut = true;
          const result = await onWillAccept(currentValue);
          inputBox.ignoreFocusOut = false;
          if (result === false) {
            // Keep input box open with user's input preserved
            return;
          }
          if (typeof result === 'object' && 'value' in result) {
            // Use the override value
            finalValue = result.value;
          }
        } catch {
          // On error, keep input open
          return;
        }
      }

      // Accept and close
      finish(finalValue);
      inputBox.hide();
    });

    inputBox.onDidHide(() => {
      finish(undefined);
      inputBox.dispose();
    });

    inputBox.show();
  });
}

export async function showValidationErrors(errors: string[]): Promise<void> {
  if (errors.length === 0) return;
  await vscode.window.showErrorMessage(
    t('Please fix:\n{0}', errors.join('\n')),
    {
      modal: true,
    },
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
  const deleteButton = t('Delete');
  const result = await vscode.window.showWarningMessage(
    t('Delete {0} "{1}"?', itemType, itemName),
    { modal: true },
    deleteButton,
  );
  return result === deleteButton;
}

/**
 * Show a confirmation dialog for remove actions.
 * Returns true if the user confirmed.
 */
export async function confirmRemove(
  itemName: string,
  itemType = 'item',
): Promise<boolean> {
  const removeButton = t('Remove');
  const result = await vscode.window.showWarningMessage(
    t('Are you sure you want to remove {0} "{1}"?', itemType, itemName),
    { modal: true },
    removeButton,
  );
  return result === removeButton;
}

/**
 * Show a success message for item deletion.
 */
export function showDeletedMessage(itemName: string, itemType = 'item'): void {
  vscode.window.showInformationMessage(
    t('{0} "{1}" has been deleted.', capitalize(itemType), itemName),
  );
}

/**
 * Show a success message for item removal.
 */
export function showRemovedMessage(itemName: string, itemType = 'item'): void {
  vscode.window.showInformationMessage(
    t('{0} "{1}" has been removed.', capitalize(itemType), itemName),
  );
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

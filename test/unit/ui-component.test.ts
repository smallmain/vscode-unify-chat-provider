import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { QuickInputButton } from 'vscode';

interface TestItem {
  label: string;
}

const harness = vi.hoisted(() => {
  const listeners: {
    accept?: () => void;
    button?: (button: QuickInputButton) => void | Promise<void>;
    hide?: () => void;
    itemButton?: (event: {
      item: TestItem;
      button: QuickInputButton;
    }) => void | Promise<void>;
    selection?: (items: readonly TestItem[]) => void | Promise<void>;
  } = {};
  const disposable = { dispose() {} };
  const quickPick = {
    activeItems: [] as TestItem[],
    busy: false,
    buttons: [] as QuickInputButton[],
    dispose: vi.fn(),
    hide: vi.fn(() => listeners.hide?.()),
    ignoreFocusOut: false,
    items: [] as TestItem[],
    matchOnDescription: false,
    matchOnDetail: false,
    onDidAccept: (listener: () => void) => {
      listeners.accept = listener;
      return disposable;
    },
    onDidChangeSelection: (
      listener: (items: readonly TestItem[]) => void | Promise<void>,
    ) => {
      listeners.selection = listener;
      return disposable;
    },
    onDidHide: (listener: () => void) => {
      listeners.hide = listener;
      return disposable;
    },
    onDidTriggerButton: (
      listener: (button: QuickInputButton) => void | Promise<void>,
    ) => {
      listeners.button = listener;
      return disposable;
    },
    onDidTriggerItemButton: (
      listener: (event: {
        item: TestItem;
        button: QuickInputButton;
      }) => void | Promise<void>,
    ) => {
      listeners.itemButton = listener;
      return disposable;
    },
    placeholder: undefined as string | undefined,
    selectedItems: [] as TestItem[],
    show: vi.fn(),
    title: undefined as string | undefined,
  };
  return { listeners, quickPick };
});

vi.mock('vscode', () => ({
  QuickInputButtons: {
    Back: { iconPath: { id: 'arrow-left' } },
  },
  env: { language: 'en' },
  l10n: { t: (message: string) => message },
  window: { createQuickPick: () => harness.quickPick },
}));

import * as vscodeApi from 'vscode';
import {
  pickAsyncQuickItems,
  pickQuickItem,
} from '../../src/ui/component';

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolvePromise: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve: (value) => resolvePromise?.(value),
  };
}

beforeEach(() => {
  harness.listeners.accept = undefined;
  harness.listeners.button = undefined;
  harness.listeners.hide = undefined;
  harness.listeners.itemButton = undefined;
  harness.listeners.selection = undefined;
  harness.quickPick.activeItems = [];
  harness.quickPick.buttons = [];
  harness.quickPick.items = [];
  harness.quickPick.selectedItems = [];
  vi.clearAllMocks();
});

describe('pickQuickItem lifecycle', () => {
  it('resolves the selected item once when selection also hides the picker', async () => {
    const item = { label: 'Selected' };
    const result = pickQuickItem({ items: [item] });

    await harness.listeners.selection?.([item]);

    await expect(result).resolves.toBe(item);
    expect(harness.quickPick.hide).toHaveBeenCalledOnce();
    expect(harness.quickPick.dispose).toHaveBeenCalledOnce();
  });

  it('lets a title-bar back handler close the picker without a selection', async () => {
    const back = vscodeApi.QuickInputButtons.Back;
    const result = pickQuickItem({
      items: [{ label: 'Item' }],
      buttons: [back],
      onDidTriggerButton: (button, quickPick) => {
        if (button === back) quickPick.hide();
      },
    });

    await harness.listeners.button?.(back);

    await expect(result).resolves.toBeUndefined();
    expect(harness.quickPick.hide).toHaveBeenCalledOnce();
  });

  it('keeps the picker open after an inline item-button action', async () => {
    const item = { label: 'Provider' };
    const button: QuickInputButton = { iconPath: { id: 'files' } };
    const onButton = vi.fn();
    const result = pickQuickItem({
      items: [item],
      onDidTriggerItemButton: onButton,
    });

    await harness.listeners.itemButton?.({ item, button });

    expect(onButton).toHaveBeenCalledWith(
      { item, button },
      harness.quickPick,
    );
    expect(harness.quickPick.hide).not.toHaveBeenCalled();
    harness.quickPick.hide();
    await expect(result).resolves.toBeUndefined();
  });
});

describe('pickAsyncQuickItems lifecycle', () => {
  it('opens busy immediately and lets Back close without cancelling the loader', async () => {
    const pending = deferred<{ items: TestItem[] }>();
    const loadItems = vi.fn(() => pending.promise);
    const result = pickAsyncQuickItems({
      placeholder: 'Select an item',
      loadingPlaceholder: 'Loading items...',
      loadItems,
    });

    expect(harness.quickPick.show).toHaveBeenCalledOnce();
    expect(harness.quickPick.busy).toBe(true);
    expect(harness.quickPick.placeholder).toBe('Loading items...');

    await harness.listeners.button?.(vscodeApi.QuickInputButtons.Back);
    await expect(result).resolves.toBeUndefined();
    expect(loadItems).toHaveBeenCalledOnce();

    pending.resolve({ items: [{ label: 'Late result' }] });
    await Promise.resolve();
    expect(loadItems).toHaveBeenCalledOnce();
  });

  it('keeps successful items visible while retrying partial failures', async () => {
    const retry = deferred<{ items: TestItem[] }>();
    const model = { label: 'Cached model' };
    const result = pickAsyncQuickItems({
      placeholder: 'Select a model',
      retryLabel: 'Retry Failed Providers',
      loadItems: async () => ({
        items: [model],
        failures: [{ label: 'Provider', message: 'Unavailable' }],
        retry: () => retry.promise,
      }),
    });

    await vi.waitFor(() => {
      expect(harness.quickPick.busy).toBe(false);
      expect(
        harness.quickPick.items.map((item) => item.label),
      ).toContain('$(refresh) Retry Failed Providers');
    });
    const retryItem = harness.quickPick.items.find((item) =>
      item.label.includes('Retry Failed Providers'),
    );
    expect(retryItem).toBeDefined();
    harness.quickPick.selectedItems = retryItem ? [retryItem] : [];
    await harness.listeners.selection?.(harness.quickPick.selectedItems);

    await vi.waitFor(() => expect(harness.quickPick.busy).toBe(true));
    expect(harness.quickPick.items.some((item) => item.label === model.label)).toBe(
      true,
    );

    retry.resolve({ items: [model] });
    await vi.waitFor(() => expect(harness.quickPick.busy).toBe(false));
    const modelItem = harness.quickPick.items.find(
      (item) => item.label === model.label,
    );
    expect(modelItem).toBeDefined();
    harness.quickPick.selectedItems = modelItem ? [modelItem] : [];
    await harness.listeners.selection?.(harness.quickPick.selectedItems);

    await expect(result).resolves.toEqual([model]);
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  models: [] as {
    readonly name: string;
    readonly id: string;
    readonly vendor: string;
    readonly family: string;
  }[],
  shownItems: [] as { readonly label: string; readonly detail?: string }[],
}));

vi.mock('vscode', () => ({
  env: { language: 'en' },
  l10n: { t: (message: string) => message },
  lm: {
    selectChatModels: async () => state.models,
  },
  window: {},
}));

vi.mock('../../src/ui/component', () => ({
  pickAsyncQuickItems: async (config: {
    loadItems(): Promise<{
      items: { readonly label: string; readonly detail?: string }[];
    }>;
  }) => {
    state.shownItems = (await config.loadItems()).items;
    return undefined;
  },
}));

import { pickLanguageModel } from '../../src/language-model-picker';

beforeEach(() => {
  state.models = [
    { name: 'Alpha', id: 'alpha', vendor: 'vendor', family: 'test' },
    { name: 'Beta', id: 'beta', vendor: 'vendor', family: 'test' },
  ];
  state.shownItems = [];
});

describe('language model picker current model', () => {
  it('marks the current model directly in the model list', async () => {
    await pickLanguageModel({
      placeHolder: 'Select a model',
      current: { vendor: 'vendor', id: 'beta' },
    });

    expect(state.shownItems.map((item) => item.label)).toEqual([
      'Alpha',
      '$(check) Beta',
    ]);
  });

  it('shows only eligible models and supports a semantic default item', async () => {
    await pickLanguageModel({
      placeHolder: 'Select a cursor model',
      includeDefault: true,
      defaultLabel: 'Use NES/Unified Model',
      defaultDetail: 'Reuse the current NES or Unified model.',
      filter: async (model) => model.id === 'beta',
    });

    expect(state.shownItems).toEqual([
      {
        label: 'Use NES/Unified Model',
        detail: 'Reuse the current NES or Unified model.',
        isDefault: true,
      },
      expect.objectContaining({ label: 'Beta', detail: 'beta' }),
    ]);
  });
});

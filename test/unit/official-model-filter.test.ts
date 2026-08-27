import { beforeEach, describe, expect, it, vi } from 'vitest';

const officialModelsManager = vi.hoisted(() => ({
  getOfficialModelsData: vi.fn(),
  getProviderState: vi.fn(),
  triggerBackgroundFetch: vi.fn(),
}));

vi.mock('vscode', () => ({}));
vi.mock('../../src/i18n', () => ({
  t: (message: string) => message,
}));
vi.mock('../../src/official-models-manager', () => ({
  officialModelsManager,
}));

import {
  applyAutoFetchOfficialModelsFilterChange,
  filterAutoFetchedOfficialModels,
  getAutoFetchOfficialModelsFilterItemIds,
  normalizeAutoFetchOfficialModelsFilter,
  resolveAutoFetchOfficialModelsFilter,
} from '../../src/official-model-filter';
import type { ProviderConfig } from '../../src/types';
import {
  getAllModelsForProviderData,
  getAllModelsForProviderSync,
} from '../../src/utils';

const officialModels = [
  { id: 'model-a', maxInputTokens: 128_000 },
  { id: 'model-b', maxInputTokens: 256_000 },
  { id: 'model-c', maxInputTokens: 64_000 },
];

function provider(
  autoFetchOfficialModelsFilter: string[] | undefined,
): ProviderConfig {
  return {
    type: 'openai-chat-completion',
    name: 'Provider',
    baseUrl: 'https://example.test/v1',
    models: [{ id: 'manual-model' }],
    autoFetchOfficialModels: true,
    autoFetchOfficialModelsFilter,
  };
}

beforeEach(() => {
  officialModelsManager.getOfficialModelsData.mockReset();
  officialModelsManager.getProviderState.mockReset();
  officialModelsManager.triggerBackgroundFetch.mockReset();
});

describe('auto-fetched official model filter', () => {
  it('keeps the backward-compatible all-model behavior when unset', () => {
    expect(
      filterAutoFetchedOfficialModels({}, officialModels).map(
        (model) => model.id,
      ),
    ).toEqual(['model-a', 'model-b', 'model-c']);
  });

  it('includes configured IDs in provider order with their latest parameters', () => {
    expect(
      filterAutoFetchedOfficialModels(
        { autoFetchOfficialModelsFilter: ['model-c', 'model-b'] },
        officialModels,
      ),
    ).toEqual([
      { id: 'model-b', maxInputTokens: 256_000 },
      { id: 'model-c', maxInputTokens: 64_000 },
    ]);
  });

  it('supports an explicit empty allowlist', () => {
    expect(
      filterAutoFetchedOfficialModels(
        { autoFetchOfficialModelsFilter: [] },
        officialModels,
      ),
    ).toEqual([]);
  });

  it('normalizes imported IDs without changing their order', () => {
    expect(
      normalizeAutoFetchOfficialModelsFilter([
        ' model-b ',
        'model-a',
        'model-b',
        '',
        42,
      ]),
    ).toEqual(['model-b', 'model-a']);
  });

  it('stores subsets but leaves the all-model selection unfiltered', () => {
    expect(
      resolveAutoFetchOfficialModelsFilter(
        ['model-a', 'model-b'],
        ['model-b'],
        undefined,
      ),
    ).toEqual(['model-b']);
    expect(
      resolveAutoFetchOfficialModelsFilter(
        ['model-a', 'model-b'],
        ['model-b', 'model-a'],
        undefined,
      ),
    ).toBeUndefined();
    expect(
      resolveAutoFetchOfficialModelsFilter([], [], undefined),
    ).toBeUndefined();
  });

  it('keeps an explicit allowlist when every displayed model is selected', () => {
    expect(
      resolveAutoFetchOfficialModelsFilter(
        ['model-a', 'model-b'],
        ['model-a', 'model-b'],
        ['model-a', 'model-b'],
      ),
    ).toEqual(['model-a', 'model-b']);

    expect(
      filterAutoFetchedOfficialModels(
        { autoFetchOfficialModelsFilter: ['model-a', 'model-b'] },
        officialModels,
      ).map((model) => model.id),
    ).toEqual(['model-a', 'model-b']);
  });

  it('preserves filtering through disappearance, cancel, re-entry, and new models', () => {
    const configuredFilter = ['model-a', 'model-b'];
    const itemsAfterDisappearance =
      getAutoFetchOfficialModelsFilterItemIds(
        ['model-a'],
        configuredFilter,
      );
    expect(itemsAfterDisappearance).toEqual(['model-a', 'model-b']);

    const afterCancel = applyAutoFetchOfficialModelsFilterChange(
      configuredFilter,
      undefined,
    );
    expect(afterCancel).toBe(configuredFilter);

    const itemsAfterReentry = getAutoFetchOfficialModelsFilterItemIds(
      ['model-a'],
      afterCancel,
    );
    expect(itemsAfterReentry).toEqual(['model-a', 'model-b']);

    const afterRemovingDisappearedModel =
      applyAutoFetchOfficialModelsFilterChange(afterCancel, {
        kind: 'selection',
        displayedModelIds: itemsAfterReentry,
        selectedModelIds: ['model-a'],
      });
    expect(afterRemovingDisappearedModel).toEqual(['model-a']);
    expect(
      filterAutoFetchedOfficialModels(
        { autoFetchOfficialModelsFilter: afterRemovingDisappearedModel },
        [
          ...officialModels,
          { id: 'model-d', maxInputTokens: 32_000 },
        ],
      ).map((model) => model.id),
    ).toEqual(['model-a']);
  });

  it('only includes future models after the explicit include-all action', () => {
    expect(
      applyAutoFetchOfficialModelsFilterChange(['model-a'], {
        kind: 'include-all',
      }),
    ).toBeUndefined();
  });

  it('applies the filter to asynchronously fetched provider models', async () => {
    officialModelsManager.getOfficialModelsData.mockResolvedValue({
      models: officialModels,
      state: undefined,
    });

    const result = await getAllModelsForProviderData(provider(['model-b']));

    expect(result.models.map((model) => model.id)).toEqual([
      'manual-model',
      'model-b',
    ]);
  });

  it('applies the filter to the synchronous cached model path', () => {
    officialModelsManager.getProviderState.mockReturnValue({
      models: officialModels,
    });

    expect(
      getAllModelsForProviderSync(provider(['model-c'])).map(
        (model) => model.id,
      ),
    ).toEqual(['manual-model', 'model-c']);
    expect(officialModelsManager.triggerBackgroundFetch).toHaveBeenCalledOnce();
  });
});

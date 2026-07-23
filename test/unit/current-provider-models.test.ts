import { describe, expect, it, vi } from 'vitest';
import {
  candidateSupportsAlgorithm,
  CurrentProviderModelCatalog,
} from '../../src/completion/current-provider-models';
import type { CompletionModelResolver } from '../../src/completion/types';
import type { ProviderConfig } from '../../src/types';

function provider(name: string, modelId = 'shared'): ProviderConfig {
  return {
    name,
    type: 'openai-chat-completion',
    baseUrl: 'https://example.test/v1',
    models: [{ id: modelId, name: `${name} Model` }],
  };
}

describe('current provider completion model catalog', () => {
  it('keeps provider/model pairs distinct and infers every eligible algorithm', async () => {
    const providers = [provider('Alpha'), provider('Beta')];
    const resolver: CompletionModelResolver = {
      resolveCompletionModel: vi.fn(),
      evaluateModelForRequest: async (reference, sourceKind) => ({
        eligible:
          sourceKind === 'simple' ||
          sourceKind === 'copilot-replica/fim' ||
          (reference.id.startsWith('Beta/') && sourceKind === 'zed'),
      }),
    };
    const catalog = new CurrentProviderModelCatalog(
      {
        getProviders: () => providers,
        getCachedModels: (configuredProvider) => configuredProvider.models,
        getModels: async (configuredProvider) => ({
          models: configuredProvider.models,
        }),
      },
      resolver,
    );

    const snapshot = await catalog.load();

    expect(snapshot.candidates.map((candidate) => candidate.reference)).toEqual([
      { vendor: 'unify-chat-provider', id: 'Alpha/shared' },
      { vendor: 'unify-chat-provider', id: 'Beta/shared' },
    ]);
    expect(
      snapshot.candidates.every((candidate) =>
        candidateSupportsAlgorithm(candidate, 'simple'),
      ),
    ).toBe(true);
    expect(
      snapshot.candidates.every((candidate) =>
        candidateSupportsAlgorithm(candidate, 'copilot-replica'),
      ),
    ).toBe(true);
    expect(candidateSupportsAlgorithm(snapshot.candidates[1]!, 'zed')).toBe(
      true,
    );
  });

  it('retains cached models on failure and force-retries only failed providers', async () => {
    const alpha = provider('Alpha', 'cached-alpha');
    const beta = provider('Beta', 'cached-beta');
    const getModels = vi.fn(
      async (configuredProvider: ProviderConfig, forceFetch: boolean) => {
        if (configuredProvider.name === 'Alpha' && !forceFetch) {
          return {
            models: [
              ...configuredProvider.models,
              { id: '__PLACEHOLDER__' },
            ],
            error: 'Alpha unavailable',
          };
        }
        return {
          models: [
            {
              id:
                configuredProvider.name === 'Alpha'
                  ? 'fresh-alpha'
                  : 'fresh-beta',
            },
          ],
        };
      },
    );
    const resolver: CompletionModelResolver = {
      resolveCompletionModel: vi.fn(),
      evaluateModelForRequest: async () => ({ eligible: true }),
    };
    const catalog = new CurrentProviderModelCatalog(
      {
        getProviders: () => [alpha, beta],
        getCachedModels: (configuredProvider) => configuredProvider.models,
        getModels,
      },
      resolver,
    );

    const initial = await catalog.load();
    expect(initial.failures).toEqual([
      { providerName: 'Alpha', message: 'Alpha unavailable' },
    ]);
    expect(initial.candidates.map((candidate) => candidate.model.id)).toEqual([
      'cached-alpha',
      'fresh-beta',
    ]);
    expect(
      initial.candidates.some(
        (candidate) => candidate.model.id === '__PLACEHOLDER__',
      ),
    ).toBe(false);

    const retried = await catalog.retryFailures();
    expect(retried.failures).toEqual([]);
    expect(retried.candidates.map((candidate) => candidate.model.id)).toEqual([
      'fresh-alpha',
      'fresh-beta',
    ]);
    expect(getModels.mock.calls).toEqual([
      [alpha, false],
      [beta, false],
      [alpha, true],
    ]);
  });
});

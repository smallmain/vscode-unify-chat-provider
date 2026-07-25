import type { ModelConfig, ProviderConfig } from '../types';
import {
  createVsCodeModelId,
  isPlaceholderModelId,
} from '../model-id-utils';
import type {
  CompletionAlgorithmId,
  CompletionModelReference,
  CompletionModelResolver,
} from './types';
import { INTERNAL_COMPLETION_VENDOR } from './types';
import type { AlgorithmRequestKind } from './model/requests';

const CANDIDATE_REQUEST_KINDS = [
  'simple',
  'copilot-replica/fim',
  'copilot-replica/nes',
  'copilot-replica/cursor-prediction',
  'zed',
  'inception',
  'mistral',
] as const satisfies readonly AlgorithmRequestKind[];

const MODEL_NAME_COLLATOR = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: 'base',
});

export interface CurrentProviderModelSource {
  getProviders(): readonly ProviderConfig[];
  getCachedModels(provider: ProviderConfig): readonly ModelConfig[];
  getModels(
    provider: ProviderConfig,
    forceFetch: boolean,
  ): Promise<{
    readonly models: readonly ModelConfig[];
    readonly error?: string;
  }>;
}

export interface CurrentProviderModelCandidate {
  readonly providerName: string;
  readonly model: ModelConfig;
  readonly reference: CompletionModelReference;
  readonly supportedRequests: ReadonlySet<AlgorithmRequestKind>;
}

export interface CurrentProviderCatalogFailure {
  readonly providerName: string;
  readonly message: string;
}

export interface CurrentProviderCatalogSnapshot {
  readonly candidates: readonly CurrentProviderModelCandidate[];
  readonly failures: readonly CurrentProviderCatalogFailure[];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function eligibleModels(models: readonly ModelConfig[]): ModelConfig[] {
  const byId = new Map<string, ModelConfig>();
  for (const model of models) {
    if (!isPlaceholderModelId(model.id) && !byId.has(model.id)) {
      byId.set(model.id, model);
    }
  }
  return [...byId.values()];
}

async function evaluateModel(
  provider: ProviderConfig,
  model: ModelConfig,
  modelResolver: CompletionModelResolver,
): Promise<CurrentProviderModelCandidate> {
  const reference: CompletionModelReference = {
    vendor: INTERNAL_COMPLETION_VENDOR,
    id: createVsCodeModelId(provider.name, model.id),
  };
  const supportedRequests = new Set<AlgorithmRequestKind>();

  await Promise.all(
    CANDIDATE_REQUEST_KINDS.map(async (sourceKind) => {
      try {
        const eligibility = await modelResolver.evaluateModelForRequest?.(
          reference,
          sourceKind,
        );
        if (eligibility?.eligible ?? true) supportedRequests.add(sourceKind);
      } catch {
        // One unsupported request kind must not hide other valid algorithms.
      }
    }),
  );

  return {
    providerName: provider.name,
    model,
    reference,
    supportedRequests,
  };
}

async function evaluateProviderModels(
  provider: ProviderConfig,
  models: readonly ModelConfig[],
  modelResolver: CompletionModelResolver,
): Promise<CurrentProviderModelCandidate[]> {
  return Promise.all(
    eligibleModels(models).map((model) =>
      evaluateModel(provider, model, modelResolver),
    ),
  );
}

export function candidateSupportsAlgorithm(
  candidate: CurrentProviderModelCandidate,
  algorithm: CompletionAlgorithmId,
): boolean {
  switch (algorithm) {
    case 'simple':
      return candidate.supportedRequests.has('simple');
    case 'copilot-replica':
      return (
        candidate.supportedRequests.has('copilot-replica/fim') ||
        candidateSupportsCopilotNes(candidate)
      );
    case 'zed':
      return candidate.supportedRequests.has('zed');
    case 'inception':
      return candidate.supportedRequests.has('inception');
    case 'mistral':
      return candidate.supportedRequests.has('mistral');
  }
}

export function candidateSupportsCopilotNes(
  candidate: CurrentProviderModelCandidate,
): boolean {
  return (
    candidate.supportedRequests.has('copilot-replica/nes') &&
    candidate.supportedRequests.has('copilot-replica/cursor-prediction')
  );
}

export class CurrentProviderModelCatalog {
  private readonly candidatesByProvider = new Map<
    string,
    readonly CurrentProviderModelCandidate[]
  >();
  private readonly failuresByProvider = new Map<string, string>();
  private providerOrder: string[] = [];
  private initialized = false;

  constructor(
    private readonly source: CurrentProviderModelSource,
    private readonly modelResolver: CompletionModelResolver,
  ) {}

  async load(): Promise<CurrentProviderCatalogSnapshot> {
    if (this.initialized) return this.snapshot();
    this.initialized = true;
    const providers = [...this.source.getProviders()];
    this.providerOrder = providers.map((provider) => provider.name);
    this.candidatesByProvider.clear();
    this.failuresByProvider.clear();
    await this.loadProviders(providers, false);
    return this.snapshot();
  }

  async retryFailures(): Promise<CurrentProviderCatalogSnapshot> {
    const failedNames = new Set(this.failuresByProvider.keys());
    const currentProviders = [...this.source.getProviders()];
    const currentNames = new Set(
      currentProviders.map((provider) => provider.name),
    );
    this.providerOrder = [...currentNames];
    for (const providerName of this.failuresByProvider.keys()) {
      if (!currentNames.has(providerName)) {
        this.failuresByProvider.delete(providerName);
        this.candidatesByProvider.delete(providerName);
      }
    }
    const providers = currentProviders
      .filter((provider) => failedNames.has(provider.name));
    await this.loadProviders(providers, true);
    return this.snapshot();
  }

  reset(): void {
    this.initialized = false;
    this.providerOrder = [];
    this.candidatesByProvider.clear();
    this.failuresByProvider.clear();
  }

  private async loadProviders(
    providers: readonly ProviderConfig[],
    forceFetch: boolean,
  ): Promise<void> {
    await Promise.all(
      providers.map(async (provider) => {
        let fallbackModels: readonly ModelConfig[] = provider.models;
        try {
          fallbackModels = this.source.getCachedModels(provider);
        } catch {
          // User-configured models remain a usable fallback.
        }

        try {
          const result = await this.source.getModels(provider, forceFetch);
          this.candidatesByProvider.set(
            provider.name,
            await evaluateProviderModels(
              provider,
              result.models,
              this.modelResolver,
            ),
          );
          if (result.error) {
            this.failuresByProvider.set(provider.name, result.error);
          } else {
            this.failuresByProvider.delete(provider.name);
          }
        } catch (error) {
          this.candidatesByProvider.set(
            provider.name,
            await evaluateProviderModels(
              provider,
              fallbackModels,
              this.modelResolver,
            ),
          );
          this.failuresByProvider.set(provider.name, errorMessage(error));
        }
      }),
    );
  }

  private snapshot(): CurrentProviderCatalogSnapshot {
    const candidates = this.providerOrder
      .flatMap(
        (providerName) => this.candidatesByProvider.get(providerName) ?? [],
      )
      .sort((left, right) => {
        const providerComparison = MODEL_NAME_COLLATOR.compare(
          left.providerName,
          right.providerName,
        );
        if (providerComparison !== 0) return providerComparison;
        const nameComparison = MODEL_NAME_COLLATOR.compare(
          left.model.name ?? left.model.id,
          right.model.name ?? right.model.id,
        );
        return nameComparison !== 0
          ? nameComparison
          : MODEL_NAME_COLLATOR.compare(left.model.id, right.model.id);
      });
    const failures = this.providerOrder.flatMap((providerName) => {
      const message = this.failuresByProvider.get(providerName);
      return message ? [{ providerName, message }] : [];
    });
    return { candidates, failures };
  }
}

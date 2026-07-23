import { randomUUID } from 'node:crypto';
import * as vscode from 'vscode';
import type {
  GhostTextContextProviderItemSource,
  GhostTextContextProviderPromptMatcher,
} from '../../chat-lib/core/ghost-text';

export type CopilotContextProviderTarget = 'completions' | 'nes';

export const COPILOT_DEFAULT_COMPLETION_CONTEXT_PROVIDER_IDS = [
  'ms-vscode.cpptools',
  'promptfile-ai-context-provider',
  'scm-context-provider',
  'chat-session-context-provider',
  'typescript-ai-context-provider',
] as const;

export const COPILOT_DEFAULT_NES_CONTEXT_PROVIDER_IDS = [
  'typescript-ai-context-provider',
  'diagnostics-context-provider',
] as const;

const defaultCompletionContextProviderIds: ReadonlySet<string> = new Set(
  COPILOT_DEFAULT_COMPLETION_CONTEXT_PROVIDER_IDS,
);
const defaultNesContextProviderIds: ReadonlySet<string> = new Set(
  COPILOT_DEFAULT_NES_CONTEXT_PROVIDER_IDS,
);

export interface CopilotContextItemBase {
  readonly id?: string;
  readonly importance?: number;
  readonly origin?: 'request' | 'update';
}

export interface CopilotContextTrait extends CopilotContextItemBase {
  readonly name: string;
  readonly value: string;
}

export interface CopilotContextCodeSnippet extends CopilotContextItemBase {
  readonly uri: string;
  readonly value: string;
  readonly additionalUris?: readonly string[];
}

export interface CopilotContextDiagnosticBag extends CopilotContextItemBase {
  readonly uri: vscode.Uri;
  readonly values: readonly vscode.Diagnostic[];
}

export type CopilotContextProviderItem =
  | CopilotContextTrait
  | CopilotContextCodeSnippet
  | CopilotContextDiagnosticBag;

export type CopilotContextProviderResolutionStatus =
  | 'full'
  | 'partial'
  | 'none'
  | 'error';

export type CopilotContextProviderUsageStatus =
  | CopilotContextProviderResolutionStatus
  | 'partial_content_excluded'
  | 'none_content_excluded';

export type CopilotContextItemUsageDetails = {
  readonly id: string;
  readonly type: GhostTextContextProviderItemSource['itemType'];
  readonly origin?: 'request' | 'update';
} &
  (
    | {
        readonly usage:
          | 'full'
          | 'partial'
          | 'none'
          | 'partial_content_excluded';
        readonly expectedTokens: number;
        readonly actualTokens: number;
      }
    | {
        readonly usage: 'none_content_excluded' | 'error';
      }
  );

export interface CopilotContextUsageStatistics {
  readonly usage: CopilotContextProviderUsageStatus;
  readonly resolution: CopilotContextProviderResolutionStatus;
  readonly usageDetails?: readonly CopilotContextItemUsageDetails[];
}

export interface CopilotProposedTextEdit {
  readonly range: {
    readonly start: { readonly line: number; readonly character: number };
    readonly end: { readonly line: number; readonly character: number };
  };
  readonly newText: string;
  readonly positionAfterEdit: {
    readonly line: number;
    readonly character: number;
  };
  readonly source?: 'selectedCompletionInfo';
}

export interface CopilotContextProviderRequest {
  readonly completionId: string;
  readonly opportunityId: string;
  readonly documentContext: {
    readonly uri: string;
    readonly languageId: string;
    readonly version: number;
    readonly offset: number;
    readonly position: vscode.Position;
    readonly proposedEdits?: readonly CopilotProposedTextEdit[];
  };
  readonly activeExperiments: ReadonlyMap<
    string,
    string | number | boolean | readonly string[]
  >;
  readonly timeBudget: number;
  readonly timeoutEnd: number;
  readonly previousUsageStatistics?: CopilotContextUsageStatistics;
  readonly data?: unknown;
  readonly source?: string;
}

export type CopilotContextProviderResolveResult =
  | PromiseLike<
      CopilotContextProviderItem | readonly CopilotContextProviderItem[]
    >
  | AsyncIterable<CopilotContextProviderItem>;

export interface CopilotContextProvider {
  readonly id: string;
  readonly selector: vscode.DocumentSelector;
  readonly resolver: {
    resolve(
      request: CopilotContextProviderRequest,
      token: vscode.CancellationToken,
    ): CopilotContextProviderResolveResult;
    resolveOnTimeout?(
      request: CopilotContextProviderRequest,
    ):
      | CopilotContextProviderItem
      | readonly CopilotContextProviderItem[]
      | undefined;
  };
}

export interface CopilotContextProviderResolutionInput {
  readonly target: CopilotContextProviderTarget;
  readonly document: vscode.TextDocument;
  readonly offset: number;
  /** NES uses this absolute deadline for its shared context/debounce window. */
  readonly timeoutEndMs?: number;
  readonly completionId?: string;
  readonly opportunityId?: string;
  readonly proposedEdits?: readonly CopilotProposedTextEdit[];
  readonly data?: unknown;
}

export interface CopilotResolvedContextProviderItem {
  readonly providerId: string;
  readonly completionId: string;
  readonly matchScore: number;
  readonly resolution: CopilotContextProviderResolutionStatus;
  readonly source: GhostTextContextProviderItemSource;
  readonly item: CopilotContextProviderItem & {
    readonly id: string;
    readonly type: GhostTextContextProviderItemSource['itemType'];
  };
  readonly onTimeout: boolean;
}

export interface CopilotContextProviderResolver {
  resolve(
    input: CopilotContextProviderResolutionInput,
    token: vscode.CancellationToken,
  ): Promise<readonly CopilotResolvedContextProviderItem[]>;
  markContentExcluded?(
    completionId: string,
    source: GhostTextContextProviderItemSource,
  ): void;
  submitPromptUsage?(
    completionId: string,
    matchers: readonly GhostTextContextProviderPromptMatcher[],
  ): void;
}

export interface CopilotContextProviderRegistryOptions {
  readonly timeoutMs?: number;
  readonly enabledProviderIds?: '*' | readonly string[];
  readonly itemIdFactory?: () => string;
}

interface RegisteredProvider {
  readonly provider: CopilotContextProvider;
  readonly targets: ReadonlySet<CopilotContextProviderTarget>;
}

interface ProviderOutcome {
  readonly providerId: string;
  readonly matchScore: number;
  readonly resolution: CopilotContextProviderResolutionStatus;
  readonly items: readonly {
    readonly value: unknown;
    readonly onTimeout: boolean;
  }[];
}

interface MatchedProvider {
  readonly registration: RegisteredProvider;
  readonly score: number;
}

interface MutableNesProviderState {
  readonly providerId: string;
  readonly matchScore: number;
  readonly items: Array<{ readonly value: unknown; readonly onTimeout: false }>;
  resolution: CopilotContextProviderResolutionStatus;
  settled: boolean;
  acceptingItems: boolean;
}

type PromptExpectation = 'included' | 'content_excluded';

interface ContextProviderExpectation {
  readonly source: GhostTextContextProviderItemSource;
  expectation: PromptExpectation;
}

interface CompletionContextProviderStatistics {
  readonly resolutions: Map<
    string,
    CopilotContextProviderResolutionStatus
  >;
  readonly expectations: Map<string, ContextProviderExpectation[]>;
  readonly usage: Map<string, CopilotContextUsageStatistics>;
  finalized: boolean;
}

const CONTEXT_PROVIDER_STATISTICS_CAPACITY = 25;

type CancellationRace<T> =
  | { readonly type: 'value'; readonly value: T }
  | { readonly type: 'error' }
  | { readonly type: 'cancelled' };

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null;
}

function hasValidBaseFields(value: Readonly<Record<string, unknown>>): boolean {
  const importance = Reflect.get(value, 'importance');
  if (
    importance !== undefined &&
    (typeof importance !== 'number' ||
      !Number.isInteger(importance) ||
      importance < 0 ||
      importance > 100)
  ) {
    return false;
  }
  const id = Reflect.get(value, 'id');
  if (id !== undefined && typeof id !== 'string') {
    return false;
  }
  const origin = Reflect.get(value, 'origin');
  return origin === undefined || origin === 'request' || origin === 'update';
}

function normalizedBase(
  value: Readonly<Record<string, unknown>>,
): CopilotContextItemBase {
  const id = Reflect.get(value, 'id');
  const importance = Reflect.get(value, 'importance');
  const origin = Reflect.get(value, 'origin');
  return {
    ...(typeof id === 'string' ? { id } : {}),
    ...(typeof importance === 'number' ? { importance } : {}),
    ...(origin === 'request' || origin === 'update' ? { origin } : {}),
  };
}

function normalizeContextItem(value: unknown): CopilotContextProviderItem | undefined {
  if (!isRecord(value) || !hasValidBaseFields(value)) {
    return undefined;
  }
  const name = Reflect.get(value, 'name');
  const itemValue = Reflect.get(value, 'value');
  if (typeof name === 'string' && typeof itemValue === 'string') {
    return { ...normalizedBase(value), name, value: itemValue };
  }
  const uri = Reflect.get(value, 'uri');
  const additionalUris = Reflect.get(value, 'additionalUris');
  if (
    typeof uri === 'string' &&
    typeof itemValue === 'string' &&
    (additionalUris === undefined ||
      (Array.isArray(additionalUris) &&
        additionalUris.every((candidate) => typeof candidate === 'string')))
  ) {
    return {
      ...normalizedBase(value),
      uri,
      value: itemValue,
      ...(Array.isArray(additionalUris)
        ? { additionalUris: additionalUris.filter((candidate): candidate is string =>
            typeof candidate === 'string',
          ) }
        : {}),
    };
  }
  const diagnostics = Reflect.get(value, 'values');
  if (
    uri instanceof vscode.Uri &&
    Array.isArray(diagnostics) &&
    diagnostics.every(
      (diagnostic): diagnostic is vscode.Diagnostic =>
        diagnostic instanceof vscode.Diagnostic,
    )
  ) {
    return {
      ...normalizedBase(value),
      uri,
      values: diagnostics,
    };
  }
  return undefined;
}

function contextItemType(
  item: CopilotContextProviderItem,
): GhostTextContextProviderItemSource['itemType'] {
  if ('name' in item) return 'Trait';
  if ('value' in item) return 'CodeSnippet';
  return 'DiagnosticBag';
}

function isValidContextItemId(id: string): boolean {
  return id.length > 0 && /^[a-zA-Z0-9-]+$/.test(id);
}

function contextProviderSourceKey(
  source: GhostTextContextProviderItemSource,
): string {
  return `${source.providerId}\u0000${source.itemId}`;
}

function rawItems(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [value];
}

function isAsyncIterable(
  value: CopilotContextProviderResolveResult,
): value is AsyncIterable<CopilotContextProviderItem> {
  return (
    typeof value === 'object' &&
    value !== null &&
    Symbol.asyncIterator in value
  );
}

function raceCancellation<T>(
  promise: PromiseLike<T>,
  token: vscode.CancellationToken,
): Promise<CancellationRace<T>> {
  if (token.isCancellationRequested) {
    return Promise.resolve({ type: 'cancelled' });
  }
  return new Promise((resolve) => {
    let settled = false;
    let subscription: vscode.Disposable | undefined;
    const finish = (outcome: CancellationRace<T>): void => {
      if (settled) return;
      settled = true;
      subscription?.dispose();
      resolve(outcome);
    };
    subscription = token.onCancellationRequested(() => {
      finish({ type: 'cancelled' });
    });
    if (settled) subscription.dispose();
    promise.then(
      (value) => finish({ type: 'value', value }),
      () => finish({ type: 'error' }),
    );
  });
}

export class CopilotContextProviderRegistry
  implements CopilotContextProviderResolver, vscode.Disposable
{
  private readonly providers = new Map<string, RegisteredProvider>();
  private readonly timeoutMs: number;
  private readonly enabledProviderIds: '*' | ReadonlySet<string>;
  private readonly itemIdFactory: () => string;
  private readonly cachedResults = new Map<
    string,
    readonly CopilotResolvedContextProviderItem[]
  >();
  private readonly statistics = new Map<
    string,
    CompletionContextProviderStatistics
  >();
  private readonly pendingStatistics = new Map<
    string,
    CompletionContextProviderStatistics
  >();

  constructor(options: CopilotContextProviderRegistryOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? 150;
    this.enabledProviderIds =
      options.enabledProviderIds === '*'
        ? '*'
        : new Set(options.enabledProviderIds ?? []);
    this.itemIdFactory = options.itemIdFactory ?? randomUUID;
  }

  register(
    provider: CopilotContextProvider,
    targets: readonly CopilotContextProviderTarget[],
  ): vscode.Disposable {
    if (!provider.id || provider.id.includes(',') || provider.id.includes('*')) {
      throw new Error(`Invalid context provider id: ${provider.id}`);
    }
    if (this.providers.has(provider.id)) {
      throw new Error(`Context provider ${provider.id} is already registered.`);
    }
    if (targets.length === 0) {
      throw new Error(`Context provider ${provider.id} has no targets.`);
    }
    const registration: RegisteredProvider = {
      provider,
      targets: new Set(targets),
    };
    this.providers.set(provider.id, registration);
    return {
      dispose: () => {
        if (this.providers.get(provider.id) === registration) {
          this.providers.delete(provider.id);
        }
      },
    };
  }

  async resolve(
    input: CopilotContextProviderResolutionInput,
    token: vscode.CancellationToken,
  ): Promise<readonly CopilotResolvedContextProviderItem[]> {
    if (token.isCancellationRequested) {
      return [];
    }
    const cacheKey = input.target === 'completions' && input.completionId
      ? `${input.target}\u0000${input.completionId}`
      : undefined;
    if (cacheKey) {
      const cached = this.cachedResults.get(cacheKey);
      if (cached && cached.length > 0) {
        this.cachedResults.delete(cacheKey);
        this.cachedResults.set(cacheKey, cached);
        return cached;
      }
    }
    const matched: MatchedProvider[] = [...this.providers.values()]
      .filter(
        ({ provider, targets }) =>
          targets.has(input.target) &&
          this.isProviderEnabled(provider.id, input.target),
      )
      .map((registration) => {
        let score = 0;
        try {
          score = vscode.languages.match(
            registration.provider.selector,
            input.document,
          );
        } catch {
          score = 0;
        }
        return { registration, score };
      })
      .filter(({ score }) => score > 0)
      .sort((left, right) => right.score - left.score);
    if (matched.length === 0) {
      return [];
    }

    const requestStartedAt = Date.now();
    const timeoutEnd =
      input.target === 'nes'
        ? (input.timeoutEndMs ?? requestStartedAt + this.timeoutMs)
        : requestStartedAt + this.timeoutMs;
    const timeBudget =
      input.target === 'nes'
        ? Math.max(0, timeoutEnd - requestStartedAt)
        : this.timeoutMs;
    const position = input.document.positionAt(input.offset);
    const generatedId = `${input.document.uri.toString()}#${input.document.version}:${input.offset}`;
    const completionId = input.completionId ?? generatedId;
    const request: CopilotContextProviderRequest = {
      completionId,
      opportunityId: input.opportunityId ?? input.completionId ?? generatedId,
      documentContext: {
        uri: input.document.uri.toString(),
        languageId: input.document.languageId,
        version: input.document.version,
        offset: input.offset,
        position,
        proposedEdits:
          input.proposedEdits && input.proposedEdits.length > 0
            ? input.proposedEdits
            : undefined,
      },
      activeExperiments: new Map(),
      timeBudget,
      timeoutEnd,
      data: input.data,
      ...(input.target === 'nes' ? { source: 'nes' } : {}),
    };
    const previousStatistics =
      input.target === 'completions'
        ? this.getPreviousStatistics(completionId)
        : undefined;

    const outcomes =
      input.target === 'nes'
        ? await this.resolveNesProviders(matched, request, token, timeoutEnd)
        : await this.resolveCompletionProviders(
            matched,
            request,
            token,
            previousStatistics,
          );
    if (token.isCancellationRequested) {
      return [];
    }
    const normalized = this.normalizeOutcomes(
      completionId,
      outcomes,
      input.target === 'completions',
    );
    if (cacheKey && normalized.length > 0) {
      this.cachedResults.set(cacheKey, normalized);
      while (this.cachedResults.size > 5) {
        const oldest = this.cachedResults.keys().next().value;
        if (oldest === undefined) break;
        this.cachedResults.delete(oldest);
      }
    }
    return normalized;
  }

  dispose(): void {
    this.providers.clear();
    this.cachedResults.clear();
    this.statistics.clear();
    this.pendingStatistics.clear();
  }

  markContentExcluded(
    completionId: string,
    source: GhostTextContextProviderItemSource,
  ): void {
    const statistics = this.pendingStatistics.get(completionId);
    const expectations = statistics?.expectations.get(source.providerId);
    if (!expectations) return;
    const expectation = expectations.find(
      (candidate) =>
        contextProviderSourceKey(candidate.source) ===
        contextProviderSourceKey(source),
    );
    if (expectation) {
      expectation.expectation = 'content_excluded';
    }
  }

  submitPromptUsage(
    completionId: string,
    matchers: readonly GhostTextContextProviderPromptMatcher[],
  ): void {
    if (this.statistics.has(completionId)) return;
    const statistics = this.pendingStatistics.get(completionId);
    if (!statistics || statistics.finalized) return;

    for (const [providerId, expectations] of statistics.expectations) {
      if (expectations.length === 0) continue;
      const resolution = statistics.resolutions.get(providerId) ?? 'none';
      if (resolution === 'none' || resolution === 'error') {
        statistics.usage.set(providerId, { usage: 'none', resolution });
        continue;
      }

      const usageDetails = expectations.map(
        ({ source, expectation }): CopilotContextItemUsageDetails => {
          const identity = {
            id: source.itemId,
            type: source.itemType,
            ...(source.origin ? { origin: source.origin } : {}),
          };
          if (expectation === 'content_excluded') {
            return {
              ...identity,
              usage: 'none_content_excluded',
            };
          }
          const matcher = matchers.find(
            (candidate) =>
              contextProviderSourceKey(candidate.source) ===
              contextProviderSourceKey(source),
          );
          if (!matcher) {
            return { ...identity, usage: 'error' };
          }
          if (
            matcher.expectedTokens > 0 &&
            matcher.expectedTokens === matcher.actualTokens
          ) {
            return {
              ...identity,
              usage: 'full',
              expectedTokens: matcher.expectedTokens,
              actualTokens: matcher.actualTokens,
            };
          }
          if (matcher.actualTokens > 0) {
            return {
              ...identity,
              usage: 'partial',
              expectedTokens: matcher.expectedTokens,
              actualTokens: matcher.actualTokens,
            };
          }
          return {
            ...identity,
            usage: 'none',
            expectedTokens: matcher.expectedTokens,
            actualTokens: matcher.actualTokens,
          };
        },
      );
      const usedItems = usageDetails.reduce((total, item) => {
        if (item.usage === 'full') return total + 1;
        if (item.usage === 'partial') return total + 0.5;
        return total;
      }, 0);
      const usedPercentage = usedItems / expectations.length;
      const usage: CopilotContextProviderUsageStatus =
        usedPercentage === 1
          ? 'full'
          : usedPercentage === 0
            ? 'none'
            : 'partial';
      statistics.usage.set(providerId, {
        resolution,
        usage,
        usageDetails,
      });
    }

    statistics.finalized = true;
    statistics.expectations.clear();
    statistics.resolutions.clear();
    this.pendingStatistics.delete(completionId);
    this.statistics.set(completionId, statistics);
    this.trimStatistics(this.statistics);
  }

  getUsageStatistics(
    completionId: string,
    providerId: string,
  ): CopilotContextUsageStatistics | undefined {
    return this.statistics.get(completionId)?.usage.get(providerId);
  }

  private async resolveCompletionProviders(
    matched: readonly MatchedProvider[],
    request: CopilotContextProviderRequest,
    token: vscode.CancellationToken,
    previousStatistics: CompletionContextProviderStatistics | undefined,
  ): Promise<readonly ProviderOutcome[]> {
    const source = new vscode.CancellationTokenSource();
    let timedOut = false;
    let parentCancelled = token.isCancellationRequested;
    const parentSubscription = token.onCancellationRequested(() => {
      parentCancelled = true;
      source.cancel();
    });
    if (token.isCancellationRequested) {
      source.cancel();
    }
    const timeout = setTimeout(() => {
      timedOut = true;
      source.cancel();
    }, this.timeoutMs);

    try {
      const outcomes = await Promise.all(
        matched.map(({ registration, score }) => {
          const previousUsageStatistics = previousStatistics?.usage.get(
            registration.provider.id,
          );
          return this.resolveProvider(
            registration.provider,
            score,
            {
              ...request,
              ...(previousUsageStatistics
                ? { previousUsageStatistics }
                : {}),
            },
            source.token,
            () => timedOut,
          );
        }),
      );
      return parentCancelled || token.isCancellationRequested ? [] : outcomes;
    } finally {
      clearTimeout(timeout);
      parentSubscription.dispose();
      source.dispose();
    }
  }

  private async resolveNesProviders(
    matched: readonly MatchedProvider[],
    request: CopilotContextProviderRequest,
    token: vscode.CancellationToken,
    timeoutEnd: number,
  ): Promise<readonly ProviderOutcome[]> {
    const states = matched.map(({ registration, score }) => {
      const state: MutableNesProviderState = {
        providerId: registration.provider.id,
        matchScore: score,
        items: [],
        resolution: 'none',
        settled: false,
        acceptingItems: true,
      };
      return {
        provider: registration.provider,
        state,
        completion: this.consumeNesProvider(
          registration.provider,
          request,
          token,
          state,
        ),
      };
    });
    const allSettled = Promise.all(
      states.map(({ completion }) => completion),
    ).then(() => 'settled' as const);
    let deadlineTimer: NodeJS.Timeout | undefined;
    const deadline = new Promise<'deadline'>((resolve) => {
      const delay = Math.max(0, timeoutEnd - Date.now());
      deadlineTimer = setTimeout(() => resolve('deadline'), delay);
    });
    let cancellationSubscription: vscode.Disposable | undefined;
    const cancelled = new Promise<'cancelled'>((resolve) => {
      cancellationSubscription = token.onCancellationRequested(() => {
        resolve('cancelled');
      });
      if (token.isCancellationRequested) {
        resolve('cancelled');
      }
    });

    const boundary = await Promise.race([allSettled, deadline, cancelled]);
    if (deadlineTimer) clearTimeout(deadlineTimer);
    cancellationSubscription?.dispose();
    if (boundary === 'cancelled' || token.isCancellationRequested) {
      return [];
    }

    for (const { state } of states) {
      state.acceptingItems = false;
    }

    return states.map(({ provider, state }): ProviderOutcome => {
      const items: Array<{ readonly value: unknown; readonly onTimeout: boolean }> =
        state.items.map((item) => ({ ...item }));
      let resolution = state.settled
        ? state.resolution
        : items.length > 0
          ? 'partial'
          : 'none';
      if (provider.resolver.resolveOnTimeout && !token.isCancellationRequested) {
        try {
          const fallback = provider.resolver.resolveOnTimeout(request);
          if (fallback !== undefined) {
            const fallbackItems = rawItems(fallback);
            for (const value of fallbackItems) {
              items.push({ value, onTimeout: true });
            }
            if (
              fallbackItems.length > 0 &&
              (resolution === 'none' || resolution === 'error')
            ) {
              resolution = 'partial';
            }
          }
        } catch {
          // A provider fallback is isolated from the completion request.
        }
      }
      return {
        providerId: state.providerId,
        matchScore: state.matchScore,
        resolution,
        items,
      };
    });
  }

  private async consumeNesProvider(
    provider: CopilotContextProvider,
    request: CopilotContextProviderRequest,
    token: vscode.CancellationToken,
    state: MutableNesProviderState,
  ): Promise<void> {
    try {
      const result = provider.resolver.resolve(request, token);
      if (isAsyncIterable(result)) {
        const iterator = result[Symbol.asyncIterator]();
        while (!token.isCancellationRequested) {
          const outcome = await raceCancellation(iterator.next(), token);
          if (outcome.type !== 'value') {
            if (outcome.type === 'cancelled') {
              void iterator.return?.();
            } else {
              state.resolution = 'error';
              state.items.length = 0;
            }
            return;
          }
          if (outcome.value.done) {
            state.resolution = 'full';
            return;
          }
          if (state.acceptingItems) {
            state.items.push({ value: outcome.value.value, onTimeout: false });
          }
          state.resolution = 'partial';
        }
        void iterator.return?.();
        return;
      }

      const outcome = await raceCancellation(result, token);
      if (outcome.type === 'value') {
        if (state.acceptingItems) {
          for (const value of rawItems(outcome.value)) {
            state.items.push({ value, onTimeout: false });
          }
        }
        state.resolution = 'full';
      } else if (outcome.type === 'error') {
        state.resolution = 'error';
      }
    } catch {
      state.resolution = 'error';
      state.items.length = 0;
    } finally {
      state.settled = true;
    }
  }

  private async resolveProvider(
    provider: CopilotContextProvider,
    matchScore: number,
    request: CopilotContextProviderRequest,
    token: vscode.CancellationToken,
    didTimeOut: () => boolean,
  ): Promise<ProviderOutcome> {
    const items: Array<{ value: unknown; onTimeout: boolean }> = [];
    let completed = false;
    let resolution: CopilotContextProviderResolutionStatus = 'none';
    try {
      const result = provider.resolver.resolve(request, token);
      if (isAsyncIterable(result)) {
        const iterator = result[Symbol.asyncIterator]();
        while (!token.isCancellationRequested) {
          const outcome = await raceCancellation(iterator.next(), token);
          if (outcome.type !== 'value') {
            if (outcome.type === 'cancelled') {
              void iterator.return?.();
            } else {
              resolution = 'error';
              items.length = 0;
            }
            break;
          }
          if (outcome.value.done) {
            completed = true;
            resolution = 'full';
            break;
          }
          items.push({ value: outcome.value.value, onTimeout: false });
          resolution = 'partial';
        }
      } else {
        const outcome = await raceCancellation(result, token);
        if (outcome.type === 'value') {
          completed = true;
          resolution = 'full';
          for (const value of rawItems(outcome.value)) {
            items.push({ value, onTimeout: false });
          }
        } else if (outcome.type === 'error') {
          completed = true;
          resolution = 'error';
        }
      }
    } catch {
      completed = true;
      resolution = 'error';
      items.length = 0;
    }

    if (
      !completed &&
      (resolution === 'none' || resolution === 'partial') &&
      didTimeOut() &&
      provider.resolver.resolveOnTimeout
    ) {
      try {
        const fallback = provider.resolver.resolveOnTimeout(request);
        if (fallback !== undefined) {
          for (const value of rawItems(fallback)) {
            items.push({ value, onTimeout: true });
          }
          if (items.length > 0) {
            resolution = 'partial';
          }
        }
      } catch {
        // A provider fallback is isolated from the completion request.
      }
    }
    return { providerId: provider.id, matchScore, resolution, items };
  }

  private normalizeOutcomes(
    completionId: string,
    outcomes: readonly ProviderOutcome[],
    trackUsage: boolean,
  ): readonly CopilotResolvedContextProviderItem[] {
    const statistics = trackUsage
      ? this.getOrCreatePendingStatistics(completionId)
      : undefined;
    const normalized: CopilotResolvedContextProviderItem[] = [];
    for (const outcome of outcomes) {
      statistics?.resolutions.set(outcome.providerId, outcome.resolution);
      const expectations =
        statistics?.expectations.get(outcome.providerId) ?? [];
      statistics?.expectations.set(outcome.providerId, expectations);
      const seenIds = new Set<string>();
      for (const candidate of outcome.items) {
        const rawItem = normalizeContextItem(candidate.value);
        if (!rawItem) continue;
        const itemType = contextItemType(rawItem);
        let id = rawItem.id;
        if (!id || !isValidContextItemId(id) || seenIds.has(id)) {
          do {
            id = this.itemIdFactory();
          } while (!isValidContextItemId(id) || seenIds.has(id));
        }
        seenIds.add(id);
        const item = { ...rawItem, id, type: itemType };
        const source: GhostTextContextProviderItemSource = {
          providerId: outcome.providerId,
          itemId: id,
          itemType,
          ...(rawItem.origin ? { origin: rawItem.origin } : {}),
        };
        if (statistics) {
          expectations.push({ source, expectation: 'included' });
        }
        normalized.push({
          providerId: outcome.providerId,
          completionId,
          matchScore: outcome.matchScore,
          resolution: outcome.resolution,
          source,
          item,
          onTimeout: candidate.onTimeout,
        });
      }
    }
    return normalized;
  }

  private getOrCreatePendingStatistics(
    completionId: string,
  ): CompletionContextProviderStatistics {
    const existing = this.pendingStatistics.get(completionId);
    if (existing) return existing;
    const statistics: CompletionContextProviderStatistics = {
      resolutions: new Map(),
      expectations: new Map(),
      usage: new Map(),
      finalized: false,
    };
    this.pendingStatistics.set(completionId, statistics);
    this.trimStatistics(this.pendingStatistics);
    return statistics;
  }

  private getPreviousStatistics(
    completionId: string,
  ): CompletionContextProviderStatistics | undefined {
    const keys = [...this.statistics.keys()];
    for (let index = keys.length - 1; index >= 0; index--) {
      const key = keys[index];
      if (key !== completionId) {
        return this.statistics.get(key);
      }
    }
    return undefined;
  }

  private trimStatistics(
    values: Map<string, CompletionContextProviderStatistics>,
  ): void {
    while (values.size > CONTEXT_PROVIDER_STATISTICS_CAPACITY) {
      const oldest = values.keys().next().value;
      if (oldest === undefined) return;
      values.delete(oldest);
    }
  }

  private isProviderEnabled(
    providerId: string,
    target: CopilotContextProviderTarget,
  ): boolean {
    if (this.enabledProviderIds === '*' || this.enabledProviderIds.has(providerId)) {
      return true;
    }
    return (target === 'completions'
      ? defaultCompletionContextProviderIds
      : defaultNesContextProviderIds
    ).has(providerId);
  }
}

export const copilotContextProviderRegistry =
  new CopilotContextProviderRegistry();

export function registerCopilotContextProvider(
  provider: CopilotContextProvider,
  targets: readonly CopilotContextProviderTarget[],
): vscode.Disposable {
  return copilotContextProviderRegistry.register(provider, targets);
}

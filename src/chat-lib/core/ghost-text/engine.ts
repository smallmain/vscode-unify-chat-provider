import type * as vscode from 'vscode';
import { resolveGhostTextBehavior } from './behavior';
import {
  buildGhostTextNetworkStrategy,
  determineGhostTextMultilineStrategy,
  forceSingleLine,
  splitGhostTextCompletion,
  trimMultilineCompletion,
  type GhostTextMultilineStrategy,
  type GhostTextNetworkStrategy,
} from './multiline';
import {
  createGhostTextItem,
  determineInlineSuggestionPosition,
  processGhostTextChoice,
  type ProcessedGhostTextChoice,
} from './postprocess';
import {
  GhostTextPromptFactory,
  lineBoundsAtOffset,
  offsetAt,
  positionAt,
  trimLastLine,
} from './prompt';
import {
  GhostTextCompletionCache,
  GhostTextCurrentCompletion,
} from './state';
import { O200kGhostTextTokenizer } from './tokenizer';
import type {
  GhostTextClock,
  GhostTextCompletionItem,
  GhostTextCompletionList,
  GhostTextDebugState,
  GhostTextEndOfLifeReason,
  GhostTextEngineDependencies,
  GhostTextModelChoice,
  GhostTextPrompt,
  GhostTextProvideResult,
  GhostTextRequest,
  GhostTextResultSource,
  GhostTextTokenizer,
} from './types';

interface AsyncCompletionEntry {
  id: string;
  prefix: string;
  suffix: string;
  promise: Promise<readonly GhostTextModelChoice[]>;
  pending: boolean;
  generation: number;
  source: GhostTextCancellationSource;
}

interface ItemState {
  readonly item: GhostTextCompletionItem;
  listId: string;
  location: string;
  shown: boolean;
  finalized: boolean;
}

interface ListState {
  itemIds: readonly string[];
  disposed: boolean;
}

interface LocalChoices {
  choices: readonly GhostTextModelChoice[];
  source: GhostTextResultSource;
}

const DEFAULT_CLOCK: GhostTextClock = {
  now: () => Date.now(),
  sleep: (milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds)),
};

const SPECULATIVE_REQUEST_CAPACITY = 100;
const ASYNC_REQUEST_CAPACITY = 100;

export class GhostTextEngine {
  private readonly behavior;
  private readonly tokenizer;
  private readonly idFactory;
  private readonly clock;
  private readonly promptFactory;
  private readonly cache;
  private readonly current = new GhostTextCurrentCompletion();
  private readonly asyncEntries = new Map<string, AsyncCompletionEntry>();
  private readonly activeNetworkSources = new Set<GhostTextCancellationSource>();
  private readonly speculativeRequests = new Map<string, () => Promise<void>>();
  private readonly activeSpeculativeSources =
    new Set<GhostTextCancellationSource>();
  private readonly itemStates = new Map<string, ItemState>();
  private readonly listStates = new Map<string, ListState>();
  private lastShownItemIds: string[] = [];
  private lastShownChoiceIndex?: number;
  private lastLocation?: string;
  private latestRequestId?: string;
  private generation = 0;
  private disposed = false;

  constructor(private readonly dependencies: GhostTextEngineDependencies) {
    this.behavior = resolveGhostTextBehavior(dependencies.behavior);
    this.tokenizer =
      dependencies.tokenizer ?? new O200kGhostTextTokenizer();
    this.idFactory = dependencies.idFactory ?? defaultIdFactory;
    this.clock = dependencies.clock ?? DEFAULT_CLOCK;
    this.promptFactory = new GhostTextPromptFactory(
      this.behavior,
      this.tokenizer,
    );
    this.cache = new GhostTextCompletionCache(this.behavior.cacheSize);
  }

  provide(
    request: GhostTextRequest,
    token: vscode.CancellationToken,
  ): Promise<GhostTextProvideResult> {
    return this.provideInternal(request, token, false);
  }

  handleDidShowCompletionItem(itemId: string): void {
    const state = this.itemStates.get(itemId);
    if (!state || state.shown || state.finalized) {
      return;
    }
    state.shown = true;
    this.lastShownChoiceIndex = state.item.metadata.choiceIndex;
    if (
      state.location === this.lastLocation &&
      !this.lastShownItemIds.includes(itemId)
    ) {
      this.lastShownItemIds.push(itemId);
    }
    const speculative = this.speculativeRequests.get(
      state.item.metadata.clientCompletionId,
    );
    if (speculative) {
      this.speculativeRequests.delete(state.item.metadata.clientCompletionId);
      void speculative();
    }
  }

  handleEndOfLifetime(
    itemId: string,
    reason: GhostTextEndOfLifeReason,
  ): void {
    const state = this.itemStates.get(itemId);
    if (!state || state.finalized) {
      return;
    }
    state.finalized = true;
    if (reason === 'accepted') {
      this.lastShownItemIds = [];
    }
    this.cleanupDisposedList(state.listId);
  }

  handleListEndOfLifetime(listId: string): void {
    const state = this.listStates.get(listId);
    if (!state || state.disposed) {
      return;
    }
    state.disposed = true;
    this.cleanupDisposedList(listId);
  }

  invalidate(): void {
    this.generation++;
    for (const entry of this.asyncEntries.values()) {
      entry.source.cancel();
    }
    for (const source of this.activeNetworkSources) {
      source.cancel();
    }
    for (const source of this.activeSpeculativeSources.values()) {
      source.cancel();
    }
    this.cache.clear();
    this.current.clear();
    this.promptFactory.clearSuffixCache();
    this.asyncEntries.clear();
    this.activeNetworkSources.clear();
    this.speculativeRequests.clear();
    this.activeSpeculativeSources.clear();
  }

  getDebugState(): GhostTextDebugState {
    return {
      cacheEntries: this.cache.size,
      inFlightEntries: this.activeNetworkSources.size,
      speculativeEntries:
        this.speculativeRequests.size + this.activeSpeculativeSources.size,
      ...(this.current.clientCompletionId
        ? { currentClientCompletionId: this.current.clientCompletionId }
        : {}),
      lastShownItemIds: [...this.lastShownItemIds],
      trackedItemCount: this.itemStates.size,
      trackedListCount: this.listStates.size,
    };
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.invalidate();
    for (const [listId, state] of this.listStates) {
      if (!state.disposed) {
        this.handleListEndOfLifetime(listId);
      }
    }
    this.itemStates.clear();
    this.listStates.clear();
  }

  private async provideInternal(
    request: GhostTextRequest,
    token: vscode.CancellationToken,
    speculative: boolean,
  ): Promise<GhostTextProvideResult> {
    if (this.disposed) {
      return { type: 'failed', reason: 'GhostText engine is disposed' };
    }
    const issuedAt = this.clock.now();
    const requestId = this.idFactory();
    const requestGeneration = this.generation;
    if (!speculative) {
      this.latestRequestId = requestId;
    }
    if (this.isCancelled(requestId, token, speculative, requestGeneration)) {
      return { type: 'cancelled', reason: 'cancelled before prompt extraction' };
    }

    const promptResult = this.promptFactory.build(request, token);
    if (promptResult.type !== 'prompt') {
      if (promptResult.type === 'cancelled') {
        return { type: 'cancelled', reason: promptResult.reason };
      }
      return { type: 'empty', reason: promptResult.reason };
    }
    const prompt = promptResult.prompt;
    const line = lineBoundsAtOffset(
      prompt.virtualDocumentText,
      prompt.virtualCursorOffset,
    );
    const inlineSuggestion = determineInlineSuggestionPosition(
      line.text.slice(prompt.virtualCursorOffset - line.start),
    );
    if (inlineSuggestion === undefined) {
      return {
        type: 'empty',
        reason: 'invalid middle-of-line position',
        prompt,
      };
    }
    if (!prompt.prefix && !prompt.suffix) {
      return { type: 'empty', reason: 'empty prompt', prompt };
    }

    const [documentPrefix] = trimLastLine(
      prompt.virtualDocumentText.slice(0, prompt.virtualCursorOffset),
    );
    const afterAcceptedCompletion = this.current.hasAccepted(
      documentPrefix,
      prompt.suffix,
    );
    const multilineStrategy = await determineGhostTextMultilineStrategy(
      request,
      prompt,
      this.behavior,
      afterAcceptedCompletion,
    );
    const multiline = multilineStrategy.requestMultiline;
    if (this.isCancelled(requestId, token, speculative, requestGeneration)) {
      return { type: 'cancelled', reason: 'cancelled during multiline parsing' };
    }

    let local = this.localChoices(documentPrefix, prompt, multiline);
    if (!local && request.trigger !== 'invoke') {
      const asyncChoice = await this.waitForAsyncChoice(
        requestId,
        documentPrefix,
        prompt,
      );
      if (asyncChoice) {
        local = { choices: asyncChoice, source: 'async' };
      }
      if (this.isCancelled(requestId, token, speculative, requestGeneration)) {
        return { type: 'cancelled', reason: 'cancelled while awaiting in-flight request' };
      }
    }

    let source = local?.source;
    let choices = local?.choices ?? [];
    let processed = await processChoices(
      request,
      prompt,
      choices,
      multiline,
      afterAcceptedCompletion,
      this.behavior,
      this.tokenizer,
      multilineStrategy,
    );
    if (this.isCancelled(requestId, token, speculative, requestGeneration)) {
      return { type: 'cancelled', reason: 'cancelled during post-processing' };
    }
    if (local && processed.length === 0) {
      return {
        type: 'empty',
        reason: 'local completions empty after post-processing',
        prompt,
      };
    }

    const needsNetwork =
      !local || (request.trigger === 'invoke' && choices.length <= 1);
    if (needsNetwork) {
      let networkChoices: readonly GhostTextModelChoice[];
      try {
        const candidateCount =
          request.trigger === 'invoke'
            ? this.behavior.cyclingCandidateCount
            : 1;
        networkChoices = await waitForPromiseOrCancellation(
          this.startNetworkRequest(
            requestId,
            documentPrefix,
            prompt,
            request,
            multiline,
            afterAcceptedCompletion,
            multilineStrategy,
            candidateCount,
            token,
          ),
          token,
        );
      } catch (error) {
        if (
          token.isCancellationRequested ||
          isAbortError(error) ||
          this.isCancelled(requestId, token, speculative, requestGeneration)
        ) {
          return { type: 'cancelled', reason: 'FIM model request cancelled' };
        }
        return {
          type: 'failed',
          reason: 'FIM model request failed',
          ...(error instanceof Error ? { error } : {}),
        };
      }
      if (this.isCancelled(requestId, token, speculative, requestGeneration)) {
        return { type: 'cancelled', reason: 'cancelled after FIM model request' };
      }
      const sanitized = sanitizeChoices(networkChoices);
      choices =
        request.trigger === 'invoke'
          ? deduplicateChoices([...choices, ...sanitized])
          : sanitized.slice(0, 1);
      source = request.trigger === 'invoke' ? 'cycling' : 'async';
      processed = await processChoices(
        request,
        prompt,
        choices,
        multiline,
        afterAcceptedCompletion,
        this.behavior,
        this.tokenizer,
        multilineStrategy,
      );
      if (this.isCancelled(requestId, token, speculative, requestGeneration)) {
        return { type: 'cancelled', reason: 'cancelled during post-processing' };
      }
    }

    if (!source || processed.length === 0) {
      return {
        type: 'empty',
        reason: 'no completions after post-processing',
        prompt,
      };
    }
    if (source === 'typing-as-suggested' && this.lastShownChoiceIndex !== undefined) {
      processed = reorderLastShown(processed, this.lastShownChoiceIndex);
    }

    const elapsed = this.clock.now() - issuedAt;
    const delay = Math.max(this.behavior.completionDelayMs - elapsed, 0);
    if (
      source !== 'typing-as-suggested' &&
      request.trigger !== 'invoke' &&
      delay > 0
    ) {
      await this.clock.sleep(delay);
      if (this.isCancelled(requestId, token, speculative, requestGeneration)) {
        return { type: 'cancelled', reason: 'cancelled during completion delay' };
      }
    }

    const finalChoices = processed.map((value) => value.choice);
    if (!speculative) {
      this.current.set(
        documentPrefix,
        prompt.suffix,
        finalChoices,
        source === 'typing-as-suggested',
      );
    }
    if (this.isCancelled(requestId, token, speculative, requestGeneration)) {
      return { type: 'cancelled', reason: 'cancelled before result publication' };
    }
    const list = this.createList(request, prompt, source, processed, speculative);
    if (!list || speculative) {
      return speculative
        ? { type: 'empty', reason: 'speculative result cached', prompt }
        : { type: 'empty', reason: 'no non-no-op completion items', prompt };
    }
    this.updateLastLocation(request, source);
    return { type: 'success', list };
  }

  private localChoices(
    prefix: string,
    prompt: GhostTextPrompt,
    multiline: boolean,
  ): LocalChoices | undefined {
    const typing = this.current.forTyping(prefix, prompt.suffix);
    const cached = this.cache.findAll(prefix, prompt.suffix).map((choice) => ({
      ...choice,
      completionText: multiline
        ? choice.completionText
        : singleLineForCache(choice.completionText),
    }));
    if (typing?.length) {
      return {
        choices: deduplicateChoices([...typing, ...cached]),
        source: 'typing-as-suggested',
      };
    }
    return cached.length > 0 ? { choices: cached, source: 'cache' } : undefined;
  }

  private async waitForAsyncChoice(
    requestId: string,
    prefix: string,
    prompt: GhostTextPrompt,
  ): Promise<readonly GhostTextModelChoice[] | undefined> {
    const candidates: AsyncCompletionEntry[] = [];
    for (const [entryId, entry] of this.asyncEntries) {
      if (entry.suffix === prompt.suffix && prefix.startsWith(entry.prefix)) {
        candidates.push(entry);
        continue;
      }
      if (entry.pending && this.latestRequestId === requestId) {
        entry.source.cancel();
        this.asyncEntries.delete(entryId);
      }
    }
    if (candidates.length === 0) {
      return undefined;
    }
    const remainingById = new Map(
      candidates.map((entry) => [entry.id, prefix.slice(entry.prefix.length)]),
    );
    const matching = candidates.map(async (entry) => {
      try {
        const choices = await entry.promise;
        const remaining = remainingById.get(entry.id) ?? '';
        const adjusted = choices
          .filter(
            (choice) =>
              choice.completionText.startsWith(remaining) &&
              choice.completionText.trimEnd().length > remaining.length,
          )
          .map((choice) => ({
            ...choice,
            completionText: choice.completionText.slice(remaining.length),
          }));
        return adjusted.length > 0 ? adjusted : undefined;
      } catch {
        return undefined;
      }
    });
    const completion = firstDefined(matching);
    const timeout = this.clock
      .sleep(this.behavior.asyncCompletionTimeoutMs)
      .then(() => undefined);
    const result = await Promise.race([completion, timeout]);
    if (this.latestRequestId !== requestId) {
      return undefined;
    }
    return result;
  }

  private startNetworkRequest(
    requestId: string,
    prefix: string,
    prompt: GhostTextPrompt,
    request: GhostTextRequest,
    multiline: boolean,
    afterAcceptedCompletion: boolean,
    multilineStrategy: GhostTextMultilineStrategy,
    candidateCount: number,
    parentToken: vscode.CancellationToken,
  ): Promise<readonly GhostTextModelChoice[]> {
    const generation = this.generation;
    const source = new GhostTextCancellationSource(parentToken);
    this.activeNetworkSources.add(source);
    const strategy = buildGhostTextNetworkStrategy(
      request,
      prompt,
      this.behavior,
      multiline,
      afterAcceptedCompletion,
      multilineStrategy,
    );
    let promise: Promise<readonly GhostTextModelChoice[]>;
    try {
      promise = this.dependencies.model
        .complete(
          {
            requestId,
            prompt,
            filePath: request.document.relativePath,
            candidateCount,
            ...(strategy.stop === undefined
              ? {}
              : { stop: strategy.stop }),
            ...(strategy.maxTokens === undefined
              ? {}
              : { maxTokens: strategy.maxTokens }),
            languageId: request.document.languageId,
            nextIndent: strategy.nextIndent,
            trimByIndentation: strategy.trimByIndentation,
            promptTokens: prompt.prefixTokens,
            suffixTokens: prompt.suffixTokens,
            codeAnnotations: false,
          },
          source.token,
        )
        .then((choices) =>
          finishNetworkChoices(
            choices,
            strategy,
            request,
            prompt,
            prefix,
            multiline,
            afterAcceptedCompletion,
            multilineStrategy,
            this.behavior,
            (prefixAddition, choice) => {
              if (
                this.disposed ||
                source.token.isCancellationRequested ||
                generation !== this.generation
              ) {
                return;
              }
              this.cache.append(prefix + prefixAddition, prompt.suffix, {
                ...choice,
                clientCompletionId: this.idFactory(),
              });
            },
          ),
        );
    } catch (error) {
      this.activeNetworkSources.delete(source);
      source.dispose();
      throw error;
    }
    const entry: AsyncCompletionEntry = {
      id: requestId,
      prefix,
      suffix: prompt.suffix,
      promise,
      pending: true,
      generation,
      source,
    };
    this.asyncEntries.set(requestId, entry);
    this.trimAsyncEntries();
    void promise.then(
      (choices) => {
        entry.pending = false;
        this.activeNetworkSources.delete(source);
        source.dispose();
        if (
          this.disposed ||
          source.token.isCancellationRequested ||
          generation !== this.generation
        ) {
          this.asyncEntries.delete(requestId);
          return;
        }
        for (const choice of sanitizeChoices(choices)) {
          this.cache.append(prefix, prompt.suffix, choice);
        }
        this.asyncEntries.delete(requestId);
        this.asyncEntries.set(requestId, entry);
        this.trimAsyncEntries();
      },
      () => {
        entry.pending = false;
        this.activeNetworkSources.delete(source);
        source.dispose();
        this.asyncEntries.delete(requestId);
      },
    );
    return promise;
  }

  private trimAsyncEntries(): void {
    while (this.asyncEntries.size > ASYNC_REQUEST_CAPACITY) {
      const oldest = this.asyncEntries.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      this.asyncEntries.delete(oldest);
    }
  }

  private createList(
    request: GhostTextRequest,
    prompt: GhostTextPrompt,
    source: GhostTextResultSource,
    processed: readonly ProcessedGhostTextChoice[],
    speculative: boolean,
  ): GhostTextCompletionList | undefined {
    if (speculative || this.disposed) {
      return undefined;
    }
    const listId = this.idFactory();
    const location = requestLocation(request);
    const items = processed.flatMap((choice): GhostTextCompletionItem[] => {
      const item = createGhostTextItem(
        this.idFactory(),
        source,
        request,
        prompt,
        choice,
      );
      return item ? [item] : [];
    });
    if (items.length === 0) {
      return undefined;
    }
    for (const item of items) {
      this.itemStates.set(item.id, {
        item,
        listId,
        location,
        shown: false,
        finalized: false,
      });
    }
    this.listStates.set(listId, {
      itemIds: items.map((item) => item.id),
      disposed: false,
    });
    if (source !== 'typing-as-suggested') {
      const first = items[0];
      const speculativeRequest = createSpeculativeRequest(request, first);
      if (speculativeRequest) {
        this.speculativeRequests.delete(first.metadata.clientCompletionId);
        this.speculativeRequests.set(
          first.metadata.clientCompletionId,
          async () => {
            if (this.disposed) {
              return;
            }
            const source = new GhostTextCancellationSource();
            this.activeSpeculativeSources.add(source);
            try {
              await this.provideInternal(speculativeRequest, source.token, true);
            } finally {
              this.activeSpeculativeSources.delete(source);
              source.dispose();
            }
          },
        );
        while (this.speculativeRequests.size > SPECULATIVE_REQUEST_CAPACITY) {
          const oldest = this.speculativeRequests.keys().next().value;
          if (oldest === undefined) {
            break;
          }
          this.speculativeRequests.delete(oldest);
        }
      }
    }
    return { id: listId, items, prompt, source };
  }

  private updateLastLocation(
    request: GhostTextRequest,
    source: GhostTextResultSource,
  ): void {
    const location = requestLocation(request);
    if (
      this.lastLocation &&
      this.lastLocation !== location &&
      source !== 'typing-as-suggested'
    ) {
      for (const itemId of this.lastShownItemIds) {
        this.handleEndOfLifetime(itemId, 'discarded');
      }
    }
    this.lastLocation = location;
    this.lastShownItemIds = [];
  }

  private isCancelled(
    requestId: string,
    token: vscode.CancellationToken,
    speculative: boolean,
    generation: number,
  ): boolean {
    return (
      this.disposed ||
      generation !== this.generation ||
      token.isCancellationRequested ||
      (!speculative && requestId !== this.latestRequestId)
    );
  }

  private cleanupDisposedList(listId: string): void {
    const list = this.listStates.get(listId);
    if (
      !list?.disposed ||
      !list.itemIds.every((itemId) => this.itemStates.get(itemId)?.finalized)
    ) {
      return;
    }
    for (const itemId of list.itemIds) {
      this.itemStates.delete(itemId);
    }
    this.listStates.delete(listId);
  }

}

class GhostTextCancellationSource {
  private readonly listeners = new Set<() => void>();
  private readonly parentSubscription?: vscode.Disposable;
  private cancelled = false;

  readonly token: vscode.CancellationToken;

  constructor(parent?: vscode.CancellationToken) {
    const source = this;
    this.token = {
      get isCancellationRequested(): boolean {
        return source.cancelled;
      },
      onCancellationRequested(listener, thisArgs, disposables) {
        const callback = (): void => listener.call(thisArgs, undefined);
        const disposable: vscode.Disposable = {
          dispose: () => source.listeners.delete(callback),
        };
        if (source.cancelled) {
          callback();
        } else {
          source.listeners.add(callback);
        }
        disposables?.push(disposable);
        return disposable;
      },
    };
    if (parent?.isCancellationRequested) {
      this.cancel();
    } else if (parent) {
      this.parentSubscription = parent.onCancellationRequested(() => this.cancel());
    }
  }

  cancel(): void {
    if (this.cancelled) {
      return;
    }
    this.cancelled = true;
    for (const listener of this.listeners) {
      listener();
    }
    this.listeners.clear();
  }

  dispose(): void {
    this.parentSubscription?.dispose();
    this.listeners.clear();
  }
}

function sanitizeChoices(
  choices: readonly GhostTextModelChoice[],
): readonly GhostTextModelChoice[] {
  return deduplicateChoices(
    choices.flatMap((choice): GhostTextModelChoice[] => {
      const completionText = choice.completionText.trimEnd();
      return completionText ? [{ ...choice, completionText }] : [];
    }),
  );
}

async function finishNetworkChoices(
  choices: readonly GhostTextModelChoice[],
  strategy: GhostTextNetworkStrategy,
  request: GhostTextRequest,
  prompt: GhostTextPrompt,
  documentPrefix: string,
  multiline: boolean,
  afterAcceptedCompletion: boolean,
  multilineStrategy: GhostTextMultilineStrategy,
  behavior: ReturnType<typeof resolveGhostTextBehavior>,
  cacheSplitChoice: (
    prefixAddition: string,
    choice: GhostTextModelChoice,
  ) => void,
): Promise<readonly GhostTextModelChoice[]> {
  return Promise.all(
    choices.map(async (choice) => {
      const stopped = truncateAtStops(choice.completionText, strategy.stop);
      if (
        multiline &&
        strategy.blockMode === 'more-multiline' &&
        !strategy.afterAcceptFallback &&
        strategy.trimmerLookahead !== undefined
      ) {
        const segments = await splitGhostTextCompletion(
          documentPrefix,
          stopped,
          request.document.languageId,
          strategy.trimmerLookahead,
        );
        const first = segments[0];
        for (const segment of segments.slice(1)) {
          cacheSplitChoice(segment.prefixAddition, {
            ...choice,
            completionText: segment.completionText,
            generatedChoiceIndex: segment.generatedChoiceIndex,
          });
        }
        return {
          ...choice,
          completionText: first?.completionText ?? stopped,
        };
      }
      const completionText = multiline
        ? await trimMultilineCompletion(
            stopped,
            request.document.languageId,
            behavior,
            afterAcceptedCompletion,
            prompt.virtualDocumentText,
            prompt.virtualCursorOffset,
            multilineStrategy,
          )
        : forceSingleLine(stopped);
      return { ...choice, completionText };
    }),
  );
}

function truncateAtStops(
  value: string,
  stops: readonly string[] | undefined,
): string {
  let end = value.length;
  for (const stop of stops ?? []) {
    if (!stop) {
      continue;
    }
    const index = value.indexOf(stop);
    if (index >= 0 && index < end) {
      end = index;
    }
  }
  return value.slice(0, end);
}

async function processChoices(
  request: GhostTextRequest,
  prompt: GhostTextPrompt,
  choices: readonly GhostTextModelChoice[],
  multiline: boolean,
  afterAcceptedCompletion: boolean,
  behavior: ReturnType<typeof resolveGhostTextBehavior>,
  tokenizer: GhostTextTokenizer,
  multilineStrategy: GhostTextMultilineStrategy,
): Promise<ProcessedGhostTextChoice[]> {
  const seen = new Set<string>();
  const result: ProcessedGhostTextChoice[] = [];
  for (const choice of choices) {
    const processed = await processGhostTextChoice(
      request,
      prompt,
      choice,
      multiline,
      afterAcceptedCompletion,
      behavior,
      tokenizer,
      multilineStrategy,
    );
    const key = processed?.displayText.trim();
    if (!processed || !key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(processed);
  }
  return result;
}

function deduplicateChoices(
  choices: readonly GhostTextModelChoice[],
): GhostTextModelChoice[] {
  const seen = new Set<string>();
  return choices.filter((choice) => {
    const key = choice.completionText.trim();
    if (!key || seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function reorderLastShown(
  choices: readonly ProcessedGhostTextChoice[],
  index: number,
): ProcessedGhostTextChoice[] {
  const shown = choices.find((choice) => choice.choice.choiceIndex === index);
  return shown
    ? [shown, ...choices.filter((choice) => choice !== shown)]
    : [...choices];
}

function singleLineForCache(value: string): string {
  const initial = value.match(/^\r?\n/);
  return initial
    ? initial[0] + (value.split('\n')[1] ?? '')
    : value.split('\n')[0];
}

async function firstDefined<T>(
  promises: readonly Promise<T | undefined>[],
): Promise<T | undefined> {
  return new Promise((resolve) => {
    let pending = promises.length;
    for (const promise of promises) {
      void promise.then((value) => {
        if (value !== undefined) {
          resolve(value);
          return;
        }
        pending--;
        if (pending === 0) {
          resolve(undefined);
        }
      });
    }
  });
}

function createSpeculativeRequest(
  request: GhostTextRequest,
  item: GhostTextCompletionItem,
): GhostTextRequest | undefined {
  const start = offsetAt(request.document.text, item.range.start);
  const end = offsetAt(request.document.text, item.range.end);
  if (start === undefined || end === undefined) {
    return undefined;
  }
  const text =
    request.document.text.slice(0, start) +
    item.insertText +
    request.document.text.slice(end);
  return {
    ...request,
    document: {
      ...request.document,
      text,
      version: request.document.version + 1,
    },
    position: positionAt(text, start + item.insertText.length),
    trigger: 'automatic',
    selectedCompletionInfo: undefined,
  };
}

function isAbortError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === 'AbortError' || /cancel/i.test(error.message))
  );
}

function waitForPromiseOrCancellation<T>(
  promise: Promise<T>,
  token: vscode.CancellationToken,
): Promise<T> {
  if (token.isCancellationRequested) {
    return Promise.reject(createAbortError());
  }
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let subscription: vscode.Disposable | undefined;
    const finish = (callback: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      subscription?.dispose();
      callback();
    };
    subscription = token.onCancellationRequested(() => {
      finish(() => reject(createAbortError()));
    });
    if (settled) {
      subscription.dispose();
    }
    void promise.then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(error)),
    );
  });
}

function createAbortError(): Error {
  const error = new Error('cancelled');
  error.name = 'AbortError';
  return error;
}

function requestLocation(request: GhostTextRequest): string {
  return `${request.document.uri}:${request.position.line}:${request.position.character}`;
}

function defaultIdFactory(): string {
  return globalThis.crypto.randomUUID();
}

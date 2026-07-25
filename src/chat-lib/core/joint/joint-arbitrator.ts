import {
  applyItemEdit,
  BranchFailure,
  disposeAndCancel,
  filterMeaningful,
  isCancellationRaceResult,
  observeRequest,
  raceCancellation,
  systemJointClock,
  type ObservedRequest,
} from "./shared";
import type {
  JointArbitrationInput,
  JointArbitrationResult,
  JointClock,
  JointCompletionList,
  JointDisposeReason,
  JointSource,
  JointStartedRequest,
} from "./types";

const DEFAULT_CACHE_WAIT_MS = 10;

interface DecisionContext<TFimItem, TNesItem> {
  readonly input: JointArbitrationInput<TFimItem, TNesItem>;
  readonly clock: JointClock;
  fimRequest?: ObservedRequest<TFimItem>;
  nesRequest?: ObservedRequest<TNesItem>;
}

type AwaitedBranch<TItem> =
  | {
      readonly kind: "value";
      readonly list: JointCompletionList<TItem> | undefined;
    }
  | { readonly kind: "cancelled" };

function finish<TFimItem, TNesItem>(
  outcome:
    | {
        readonly kind: "result";
        readonly source: "fim";
        readonly list: JointCompletionList<TFimItem>;
      }
    | {
        readonly kind: "result";
        readonly source: "nes";
        readonly list: JointCompletionList<TNesItem>;
      }
    | { readonly kind: "empty" }
    | { readonly kind: "cancelled" }
    | {
        readonly kind: "failed";
        readonly source: JointSource;
        readonly error: unknown;
      },
): JointArbitrationResult<TFimItem, TNesItem> {
  return outcome;
}

function startFim<TFimItem, TNesItem>(
  context: DecisionContext<TFimItem, TNesItem>,
): ObservedRequest<TFimItem> | undefined {
  if (!context.input.fim) {
    return undefined;
  }
  let started: JointStartedRequest<TFimItem>;
  try {
    started = context.input.fim.start();
  } catch (error: unknown) {
    throw new BranchFailure("fim", error);
  }
  const request = observeRequest("fim", started);
  context.fimRequest = request;
  return request;
}

function startNes<TFimItem, TNesItem>(
  context: DecisionContext<TFimItem, TNesItem>,
  enforceCacheDelay: boolean,
): ObservedRequest<TNesItem> | undefined {
  if (!context.input.nes) {
    return undefined;
  }
  let started: JointStartedRequest<TNesItem>;
  try {
    started = context.input.nes.start(enforceCacheDelay);
  } catch (error: unknown) {
    throw new BranchFailure("nes", error);
  }
  const request = observeRequest("nes", started);
  context.nesRequest = request;
  return request;
}

async function awaitBranch<TItem>(
  request: ObservedRequest<TItem> | undefined,
  cancellation: JointArbitrationInput<unknown, unknown>["cancellation"],
): Promise<AwaitedBranch<TItem>> {
  if (!request) {
    return { kind: "value", list: undefined };
  }
  const value = await raceCancellation(request.result, cancellation);
  return isCancellationRaceResult(value)
    ? { kind: "cancelled" }
    : { kind: "value", list: value };
}

function cancelAll<TFimItem, TNesItem>(
  context: DecisionContext<TFimItem, TNesItem>,
): JointArbitrationResult<TFimItem, TNesItem> {
  disposeAndCancel(context.fimRequest, "token-cancellation");
  disposeAndCancel(context.nesRequest, "token-cancellation");
  return finish<TFimItem, TNesItem>({ kind: "cancelled" });
}

function chooseFim<TFimItem, TNesItem>(
  context: DecisionContext<TFimItem, TNesItem>,
  list: JointCompletionList<TFimItem>,
  nesDisposeReason: JointDisposeReason,
): JointArbitrationResult<TFimItem, TNesItem> {
  disposeAndCancel(context.nesRequest, nesDisposeReason);
  return finish<TFimItem, TNesItem>({ kind: "result", source: "fim", list });
}

function chooseNes<TFimItem, TNesItem>(
  context: DecisionContext<TFimItem, TNesItem>,
  list: JointCompletionList<TNesItem>,
  fimDisposeReason: JointDisposeReason,
): JointArbitrationResult<TFimItem, TNesItem> {
  disposeAndCancel(context.fimRequest, fimDisposeReason);
  return finish<TFimItem, TNesItem>({ kind: "result", source: "nes", list });
}

async function preferFimOtherwiseNes<TFimItem, TNesItem>(
  context: DecisionContext<TFimItem, TNesItem>,
): Promise<JointArbitrationResult<TFimItem, TNesItem>> {
  const fimOutcome = await awaitBranch(
    context.fimRequest,
    context.input.cancellation,
  );
  if (fimOutcome.kind === "cancelled") {
    return cancelAll(context);
  }
  const filteredFim = fimOutcome.list
    ? filterMeaningful(
        fimOutcome.list,
        context.input.documentText,
        context.input.fimSemantics,
      )
    : undefined;
  if (filteredFim && filteredFim.items.length > 0) {
    return chooseFim(context, filteredFim, "lost-race");
  }

  const nesOutcome = await awaitBranch(
    context.nesRequest,
    context.input.cancellation,
  );
  if (nesOutcome.kind === "cancelled") {
    return cancelAll(context);
  }
  const filteredNes = nesOutcome.list
    ? filterMeaningful(
        nesOutcome.list,
        context.input.documentText,
        context.input.nesSemantics,
      )
    : undefined;
  if (filteredNes && filteredNes.items.length > 0) {
    return chooseNes(context, filteredNes, "not-taken");
  }

  if (filteredFim) {
    return chooseFim(context, filteredFim, "not-taken");
  }
  disposeAndCancel(context.nesRequest, "not-taken");
  return finish<TFimItem, TNesItem>({ kind: "empty" });
}

function nesAgrees<TFimItem, TNesItem>(
  context: DecisionContext<TFimItem, TNesItem>,
  list: JointCompletionList<TNesItem> | undefined,
  expectedDocumentText: string,
): boolean {
  const actualDocumentText = applyItemEdit(
    context.input.documentText,
    list?.items[0],
    context.input.nesSemantics,
  );
  return actualDocumentText === expectedDocumentText;
}

async function arbitrate<TFimItem, TNesItem>(
  context: DecisionContext<TFimItem, TNesItem>,
): Promise<JointArbitrationResult<TFimItem, TNesItem>> {
  if (context.input.cancellation?.isCancellationRequested) {
    return cancelAll(context);
  }

  let lastNesSuggestion = context.input.lastNesSuggestion;
  if (
    lastNesSuggestion &&
    lastNesSuggestion.documentUri !== context.input.documentUri
  ) {
    lastNesSuggestion = undefined;
  }

  if (!lastNesSuggestion?.wasShown) {
    if (!context.input.selectionTriggered) {
      startFim(context);
    }
    startNes(context, context.input.enforceCacheDelay ?? true);
    return preferFimOtherwiseNes(context);
  }

  const enforceCacheDelay =
    context.input.enforceCacheDelay ??
    lastNesSuggestion.documentVersion !== context.input.documentVersion;
  const nesRequest = startNes(context, enforceCacheDelay);
  if (!nesRequest) {
    if (!context.input.selectionTriggered) {
      startFim(context);
    }
    return preferFimOtherwiseNes(context);
  }

  const cacheWaitMs = context.input.cacheWaitMs ?? DEFAULT_CACHE_WAIT_MS;
  const fastResult = await raceCancellation(
    Promise.race([
      nesRequest.result.then((list) => ({ type: "nes" as const, list })),
      context.clock
        .sleep(cacheWaitMs)
        .then(() => ({ type: "timeout" as const })),
    ]),
    context.input.cancellation,
  );
  if (isCancellationRaceResult(fastResult)) {
    return cancelAll(context);
  }
  if (fastResult.type === "nes") {
    if (
      fastResult.list &&
      nesAgrees(
        context,
        fastResult.list,
        lastNesSuggestion.documentWithEditApplied,
      )
    ) {
      return finish<TFimItem, TNesItem>({
        kind: "result",
        source: "nes",
        list: fastResult.list,
      });
    }
  }

  if (!context.input.selectionTriggered) {
    startFim(context);
  }

  type RacedBranch =
    | {
        readonly source: "fim";
        readonly list: JointCompletionList<TFimItem> | undefined;
      }
    | {
        readonly source: "nes";
        readonly list: JointCompletionList<TNesItem> | undefined;
      };
  const racedBranches: Promise<RacedBranch>[] = [
    nesRequest.result.then((list) => ({ source: "nes", list })),
  ];
  if (context.fimRequest) {
    racedBranches.push(
      context.fimRequest.result.then((list) => ({ source: "fim", list })),
    );
  }
  const raced = await raceCancellation(
    Promise.race(racedBranches),
    context.input.cancellation,
  );
  if (isCancellationRaceResult(raced)) {
    return cancelAll(context);
  }
  if (
    raced.source === "nes" &&
    raced.list &&
    nesAgrees(context, raced.list, lastNesSuggestion.documentWithEditApplied)
  ) {
    return chooseNes(context, raced.list, "not-taken");
  }
  return preferFimOtherwiseNes(context);
}

export async function arbitrateJointCompletions<TFimItem, TNesItem>(
  input: JointArbitrationInput<TFimItem, TNesItem>,
): Promise<JointArbitrationResult<TFimItem, TNesItem>> {
  const clock = input.clock ?? systemJointClock;
  const context: DecisionContext<TFimItem, TNesItem> = {
    input,
    clock,
  };
  try {
    return await arbitrate(context);
  } catch (error: unknown) {
    if (error instanceof BranchFailure) {
      if (error.source === "fim") {
        disposeAndCancel(context.nesRequest, "token-cancellation");
      } else {
        disposeAndCancel(context.fimRequest, "token-cancellation");
      }
      return finish<TFimItem, TNesItem>({
        kind: "failed",
        source: error.source,
        error: error.error,
      });
    }
    return finish<TFimItem, TNesItem>({
      kind: "failed",
      source: "nes",
      error,
    });
  }
}

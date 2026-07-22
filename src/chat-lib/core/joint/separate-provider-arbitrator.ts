import {
  BranchFailure,
  disposeAndCancel,
  disposeReasonForSettledList,
  filterMeaningful,
  isCancellationRaceResult,
  observeRequest,
  raceCancellation,
  type ObservedRequest,
} from "./shared";
import type {
  JointCompletionList,
  JointItemSemantics,
  SeparateProviderArbitrationInput,
  SeparateProviderArbitrationResult,
  SeparateProviderItem,
} from "./types";

interface SeparateProviderContext<TFimItem, TNesItem> {
  readonly input: SeparateProviderArbitrationInput<TFimItem, TNesItem>;
  fimRequest?: ObservedRequest<TFimItem>;
  nesRequest?: ObservedRequest<TNesItem>;
}

type SettledBranch<TFimItem, TNesItem> =
  | {
      readonly source: "fim";
      readonly kind: "value";
      readonly list: JointCompletionList<TFimItem> | undefined;
    }
  | {
      readonly source: "nes";
      readonly kind: "value";
      readonly list: JointCompletionList<TNesItem> | undefined;
    }
  | { readonly source: "fim" | "nes"; readonly kind: "failed" };

interface FimBatch<TFimItem> {
  readonly source: "fim";
  readonly list: JointCompletionList<TFimItem>;
}

interface NesBatch<TNesItem> {
  readonly source: "nes";
  readonly list: JointCompletionList<TNesItem>;
}

type ResolvedBatch<TFimItem, TNesItem> =
  FimBatch<TFimItem> | NesBatch<TNesItem>;

interface CandidateBase {
  readonly inlineEdit: boolean;
  readonly showInlineEditMenu: boolean;
  readonly visible: boolean;
  readonly batchOrder: number;
  readonly itemOrder: number;
}

type PresentationCandidate<TFimItem, TNesItem> =
  | (CandidateBase & { readonly source: "fim"; readonly item: TFimItem })
  | (CandidateBase & { readonly source: "nes"; readonly item: TNesItem });

function finish<TFimItem, TNesItem>(
  outcome: SeparateProviderArbitrationResult<TFimItem, TNesItem>,
): SeparateProviderArbitrationResult<TFimItem, TNesItem> {
  return outcome;
}

function cancelAll<TFimItem, TNesItem>(
  context: SeparateProviderContext<TFimItem, TNesItem>,
): SeparateProviderArbitrationResult<TFimItem, TNesItem> {
  disposeAndCancel(context.fimRequest, "token-cancellation");
  disposeAndCancel(context.nesRequest, "token-cancellation");
  return finish<TFimItem, TNesItem>({ kind: "cancelled" });
}

function settledFim<TFimItem, TNesItem>(
  request: ObservedRequest<TFimItem>,
): Promise<SettledBranch<TFimItem, TNesItem>> {
  return request.result.then(
    (list) => ({ source: "fim", kind: "value", list }),
    (error: unknown) => {
      if (!(error instanceof BranchFailure)) {
        return { source: "fim", kind: "failed" };
      }
      return { source: error.source, kind: "failed" };
    },
  );
}

function settledNes<TFimItem, TNesItem>(
  request: ObservedRequest<TNesItem>,
): Promise<SettledBranch<TFimItem, TNesItem>> {
  return request.result.then(
    (list) => ({ source: "nes", kind: "value", list }),
    (error: unknown) => {
      if (!(error instanceof BranchFailure)) {
        return { source: "nes", kind: "failed" };
      }
      return { source: error.source, kind: "failed" };
    },
  );
}

function isInlineEdit<TItem>(
  source: "fim" | "nes",
  item: TItem,
  semantics: JointItemSemantics<TItem>,
): boolean {
  return semantics.isInlineEdit?.(item) ?? source === "nes";
}

function showInlineEditMenu<TItem>(
  item: TItem,
  semantics: JointItemSemantics<TItem>,
): boolean {
  return semantics.showInlineEditMenu?.(item) ?? false;
}

function retainRequestedItems<TItem>(
  source: "fim" | "nes",
  list: JointCompletionList<TItem>,
  semantics: JointItemSemantics<TItem>,
  includeInlineCompletions: boolean,
  includeInlineEdits: boolean,
): JointCompletionList<TItem> {
  const items = list.items.filter((item) => {
    const editPresentation =
      isInlineEdit(source, item, semantics) ||
      showInlineEditMenu(item, semantics);
    return editPresentation ? includeInlineEdits : includeInlineCompletions;
  });
  return items.length === list.items.length ? list : { ...list, items };
}

function hasEarlyVisibleCompletion<TItem>(
  list: JointCompletionList<TItem>,
  documentText: string,
  source: "fim" | "nes",
  semantics: JointItemSemantics<TItem>,
): boolean {
  return list.items.some(
    (item) =>
      !isInlineEdit(source, item, semantics) &&
      !showInlineEditMenu(item, semantics) &&
      semantics.isVisible(item, documentText),
  );
}

function disposeUnselected<TItem>(
  request: ObservedRequest<TItem> | undefined,
): void {
  if (!request || (request.settled && !request.fulfilled)) {
    return;
  }
  disposeAndCancel(
    request,
    request.settled ? disposeReasonForSettledList(request) : "lost-race",
  );
}

function disposeAllSettled<TFimItem, TNesItem>(
  context: SeparateProviderContext<TFimItem, TNesItem>,
): void {
  if (context.fimRequest?.fulfilled) {
    disposeAndCancel(
      context.fimRequest,
      disposeReasonForSettledList(context.fimRequest),
    );
  }
  if (context.nesRequest?.fulfilled) {
    disposeAndCancel(
      context.nesRequest,
      disposeReasonForSettledList(context.nesRequest),
    );
  }
}

function selectPresentation<TFimItem, TNesItem>(
  context: SeparateProviderContext<TFimItem, TNesItem>,
  batches: readonly ResolvedBatch<TFimItem, TNesItem>[],
): SeparateProviderArbitrationResult<TFimItem, TNesItem> {
  const candidates: PresentationCandidate<TFimItem, TNesItem>[] = [];
  batches.forEach((batch, batchOrder) => {
    if (batch.source === "fim") {
      batch.list.items.forEach((item, itemOrder) => {
        candidates.push({
          source: "fim",
          item,
          inlineEdit: isInlineEdit("fim", item, context.input.fimSemantics),
          showInlineEditMenu: showInlineEditMenu(
            item,
            context.input.fimSemantics,
          ),
          visible: context.input.fimSemantics.isVisible(
            item,
            context.input.documentText,
          ),
          batchOrder,
          itemOrder,
        });
      });
    } else {
      batch.list.items.forEach((item, itemOrder) => {
        candidates.push({
          source: "nes",
          item,
          inlineEdit: isInlineEdit("nes", item, context.input.nesSemantics),
          showInlineEditMenu: showInlineEditMenu(
            item,
            context.input.nesSemantics,
          ),
          visible: context.input.nesSemantics.isVisible(
            item,
            context.input.documentText,
          ),
          batchOrder,
          itemOrder,
        });
      });
    }
  });

  const preferInlineCompletions = candidates.some(
    (candidate) => !candidate.inlineEdit && candidate.visible,
  );
  const retained = candidates
    .filter((candidate) =>
      preferInlineCompletions ? !candidate.inlineEdit : candidate.inlineEdit,
    )
    .sort(
      (left, right) =>
        Number(left.showInlineEditMenu) - Number(right.showInlineEditMenu) ||
        left.batchOrder - right.batchOrder ||
        left.itemOrder - right.itemOrder,
    );
  const selected = preferInlineCompletions
    ? retained[0]
    : retained[retained.length - 1];
  if (!selected) {
    disposeAllSettled(context);
    return finish<TFimItem, TNesItem>({ kind: "empty" });
  }
  const items: SeparateProviderItem<TFimItem, TNesItem>[] = retained.map(
    (candidate) =>
      candidate.source === "fim"
        ? { source: "fim", item: candidate.item }
        : { source: "nes", item: candidate.item },
  );
  if (!retained.some((candidate) => candidate.source === "fim")) {
    disposeUnselected(context.fimRequest);
  }
  if (!retained.some((candidate) => candidate.source === "nes")) {
    disposeUnselected(context.nesRequest);
  }
  return finish<TFimItem, TNesItem>({
    kind: "result",
    source: selected.source,
    list: { items },
  });
}

async function run<TFimItem, TNesItem>(
  context: SeparateProviderContext<TFimItem, TNesItem>,
): Promise<SeparateProviderArbitrationResult<TFimItem, TNesItem>> {
  if (context.input.cancellation?.isCancellationRequested) {
    return cancelAll(context);
  }

  const scope = context.input.requestScope ?? "all";
  const allowFim = scope !== "nes";
  const allowNes = scope !== "fim";
  const startFim = (): void => {
    if (context.fimRequest || !allowFim || !context.input.fim) {
      return;
    }
    try {
      context.fimRequest = observeRequest("fim", context.input.fim.start());
    } catch {}
  };
  const startNes = (): void => {
    if (context.nesRequest || !allowNes || !context.input.nes) {
      return;
    }
    try {
      context.nesRequest = observeRequest(
        "nes",
        context.input.nes.start(context.input.enforceCacheDelay ?? false),
      );
    } catch {}
  };
  startNes();
  startFim();

  const fimSettled = context.fimRequest
    ? settledFim<TFimItem, TNesItem>(context.fimRequest)
    : undefined;
  const nesSettled = context.nesRequest
    ? settledNes<TFimItem, TNesItem>(context.nesRequest)
    : undefined;
  let waitForFim = fimSettled !== undefined;
  let waitForNes = nesSettled !== undefined;
  const batches: ResolvedBatch<TFimItem, TNesItem>[] = [];

  while (waitForFim || waitForNes) {
    const active: Promise<SettledBranch<TFimItem, TNesItem>>[] = [];
    if (waitForFim && fimSettled) {
      active.push(fimSettled);
    }
    if (waitForNes && nesSettled) {
      active.push(nesSettled);
    }
    const outcome = await raceCancellation(
      Promise.race(active),
      context.input.cancellation,
    );
    if (isCancellationRaceResult(outcome)) {
      return cancelAll(context);
    }
    if (outcome.source === "fim") {
      waitForFim = false;
    } else {
      waitForNes = false;
    }
    if (outcome.kind === "failed" || !outcome.list) {
      continue;
    }

    if (outcome.source === "fim") {
      const meaningful = filterMeaningful(
        outcome.list,
        context.input.documentText,
        context.input.fimSemantics,
      );
      const requested = retainRequestedItems(
        "fim",
        meaningful,
        context.input.fimSemantics,
        context.input.includeInlineCompletions ?? true,
        context.input.includeInlineEdits ?? true,
      );
      batches.push({ source: "fim", list: requested });
      if (
        context.input.trigger === "automatic" &&
        hasEarlyVisibleCompletion(
          requested,
          context.input.documentText,
          "fim",
          context.input.fimSemantics,
        )
      ) {
        return selectPresentation(context, batches);
      }
    } else {
      const meaningful = filterMeaningful(
        outcome.list,
        context.input.documentText,
        context.input.nesSemantics,
      );
      const requested = retainRequestedItems(
        "nes",
        meaningful,
        context.input.nesSemantics,
        context.input.includeInlineCompletions ?? true,
        context.input.includeInlineEdits ?? true,
      );
      batches.push({ source: "nes", list: requested });
      if (
        context.input.trigger === "automatic" &&
        hasEarlyVisibleCompletion(
          requested,
          context.input.documentText,
          "nes",
          context.input.nesSemantics,
        )
      ) {
        return selectPresentation(context, batches);
      }
    }
  }

  return selectPresentation(context, batches);
}

export async function arbitrateSeparateProviderCompletions<TFimItem, TNesItem>(
  input: SeparateProviderArbitrationInput<TFimItem, TNesItem>,
): Promise<SeparateProviderArbitrationResult<TFimItem, TNesItem>> {
  const context: SeparateProviderContext<TFimItem, TNesItem> = {
    input,
  };
  return run(context);
}

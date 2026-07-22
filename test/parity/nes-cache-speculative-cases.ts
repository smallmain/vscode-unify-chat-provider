import { expect } from "vitest";
import { COPILOT_BEHAVIOR_CONFIG } from "../../src/chat-lib/core/behavior-config";
import {
  NextEditCache,
  type NesCacheEntry,
  type NesCacheLookup,
} from "../../src/chat-lib/core/nes/cache";
import {
  canReuseNesPendingSpeculative,
  NesSpeculativeState,
  resolveNesSpeculativeEditWindowLines,
} from "../../src/chat-lib/core/nes/speculative";
import { computeReducedNesWindow } from "../../src/chat-lib/core/nes/cache-window";
import { runNesCrossFileOpenContinuation } from "../../src/chat-lib/core/nes/cursor-predictor";
import {
  hasUserTypedSinceNesRequestStarted,
  NesStringEdit,
  NesStringReplacement,
} from "../../src/chat-lib/core/nes/string-edit";
import type { NesTextEdit } from "../../src/chat-lib/core/nes/types";
import { expectedFor, type ParityCase } from "./support";

const uri = "file:///workspace/cache.ts";

function edit(
  startOffset: number,
  endOffset: number,
  newText: string,
  patchIndex?: number,
): NesTextEdit {
  return {
    uri,
    startOffset,
    endOffset,
    newText,
    kind: startOffset === endOffset ? "insert" : "replace",
    ...(patchIndex === undefined ? {} : { patchIndex }),
  };
}

function stringEdit(
  start: number,
  endOffset: number,
  newText: string,
): NesStringEdit {
  return NesStringEdit.single(
    new NesStringReplacement({ start, endOffset }, newText),
  );
}

function entry(
  documentText: string,
  edits: readonly NesTextEdit[],
  requestId: string,
  overrides: Partial<NesCacheEntry> = {},
): NesCacheEntry {
  return {
    documentUri: uri,
    documentText,
    editWindow: { startOffset: 0, endOffset: documentText.length },
    cursorOffset: 0,
    requestId,
    createdAt: 1,
    edits,
    source: "llm",
    subsequentN: 0,
    speculative: false,
    rejected: false,
    wasShown: false,
    wasRenderedAsInlineSuggestion: false,
    ...overrides,
  };
}

function replacement(editValue: NesTextEdit): readonly {
  readonly start: number;
  readonly endExclusive: number;
  readonly newText: string;
}[] {
  return [
    {
      start: editValue.startOffset,
      endExclusive: editValue.endOffset,
      newText: editValue.newText,
    },
  ];
}

function summarizeLookup(
  lookup: NesCacheLookup | undefined,
): Readonly<Record<string, unknown>> {
  if (!lookup) return { hit: false };
  const editValue = lookup.edit;
  const rebasedIndex =
    lookup.rebased && editValue
      ? lookup.entry.edits.findIndex(
          (candidate) =>
            candidate.patchIndex === editValue.patchIndex &&
            candidate.newText === editValue.newText,
        )
      : -1;
  return {
    hit: true,
    hasEdit: editValue !== undefined,
    replacement: editValue ? replacement(editValue) : null,
    rebased: lookup.rebased,
    rebasedEditIndex: rebasedIndex >= 0 ? rebasedIndex : null,
    subsequentN: editValue ? lookup.entry.subsequentN : null,
    patchIndex: editValue?.patchIndex ?? null,
    rejected: lookup.entry.rejected,
    requestId: lookup.entry.requestId,
  };
}

function cacheEffects(): Readonly<Record<string, unknown>> {
  const exactCache = new NextEditCache(10);
  exactCache.put(
    entry("abc", [edit(1, 1, "hello", 3)], "exact-request", {
      editWindow: { startOffset: 0, endOffset: 3 },
      cursorOffset: 1,
    }),
  );
  const exact = summarizeLookup(exactCache.lookup(uri, "abc", 1));
  const outsideWindow = summarizeLookup(exactCache.lookup(uri, "abc", 4));

  const negativeCache = new NextEditCache(10);
  negativeCache.put(
    entry("abc", [], "negative-request", {
      editWindow: { startOffset: 0, endOffset: 3 },
      cursorOffset: 1,
    }),
  );
  const negativeRepeat = [
    summarizeLookup(negativeCache.lookup(uri, "abc", 1)),
    summarizeLookup(negativeCache.lookup(uri, "abc", 1)),
  ];

  const rebaseCache = new NextEditCache(10);
  rebaseCache.put(
    entry("abc", [edit(1, 1, "XYZ", 5)], "rebase-request", {
      editWindow: { startOffset: 0, endOffset: 3 },
      cursorOffset: 1,
      userEditSince: stringEdit(1, 1, "X"),
    }),
  );
  const rebased = summarizeLookup(rebaseCache.lookup(uri, "aXbc", 2));

  const laterCache = new NextEditCache(10);
  laterCache.put(
    entry("ahellobc", [edit(8, 8, "!", 7)], "later-request", {
      editWindow: { startOffset: 0, endOffset: 8 },
      cursorOffset: 8,
      subsequentN: 1,
    }),
  );
  const laterEdit = summarizeLookup(laterCache.lookup(uri, "ahellobc", 8));

  const sequentialOriginal = "one\ntwo\nthree";
  const sequentialAfterFirst = "first\ntwo\nthree";
  const first = edit(0, 3, "first", 4);
  const second = edit(6, 9, "second", 7);
  const sequentialCache = new NextEditCache(10);
  const firstEntry = entry(
    sequentialOriginal,
    [first, second],
    "sequential-request",
    { cursorOffset: 0 },
  );
  sequentialCache.put(firstEntry);
  sequentialCache.createSubsequent("sequential-request", firstEntry);
  const acceptedKthExact = summarizeLookup(
    sequentialCache.lookup(uri, sequentialAfterFirst, 6),
  );

  const evictionCache = new NextEditCache(1);
  const shownEntry = entry(
    "function fi",
    [edit(11, 11, "bonacci")],
    "shown-request",
    { cursorOffset: 11 },
  );
  evictionCache.put(shownEntry);
  evictionCache.markRejected(
    "shown-request",
    shownEntry.edits[0],
    shownEntry.documentText,
    shownEntry,
  );
  evictionCache.put(entry("unrelated-key", [], "evicting-request"));
  const shownEntryAfterEviction = summarizeLookup(
    evictionCache.lookup(uri, "function fi", 11),
  );
  const lateEntry = entry(
    "function fib",
    [edit(12, 12, "onacci")],
    "shown-request",
    { cursorOffset: 12, subsequentN: 1 },
  );
  evictionCache.put(lateEntry);
  const lateLookup = summarizeLookup(
    evictionCache.lookup(uri, "function fib", 12),
  );

  const ownerAUri = "file:///workspace/owner-a.ts";
  const ownerBUri = "file:///workspace/owner-b.ts";
  const crossOwnerCache = new NextEditCache(
    10,
    undefined,
    false,
    COPILOT_BEHAVIOR_CONFIG.nextEdit.triggerOnEditorChangeAfterSeconds >= 0,
  );
  crossOwnerCache.put(
    entry(
      "abc",
      [{ ...edit(1, 1, "XYZ", 8), uri: ownerAUri }],
      "owner-a-request",
      {
        documentUri: ownerAUri,
        editWindow: { startOffset: 0, endOffset: 3 },
        cursorOffset: 1,
        userEditSince: NesStringEdit.empty,
      },
    ),
  );
  crossOwnerCache.put(
    entry(
      "owner-b",
      [{ ...edit(1, 1, "B"), uri: ownerBUri }],
      "owner-b-request",
      {
        documentUri: ownerBUri,
        editWindow: { startOffset: 0, endOffset: 7 },
        cursorOffset: 1,
      },
    ),
  );
  crossOwnerCache.handleDocumentEdit(ownerAUri, stringEdit(1, 1, "X"), "aXbc");
  const crossOwnerInvalidation = {
    triggerOnEditorChangeAfterSeconds:
      COPILOT_BEHAVIOR_CONFIG.nextEdit.triggerOnEditorChangeAfterSeconds,
    ownerBAfterOwnerAEdit: summarizeLookup(
      crossOwnerCache.lookup(ownerBUri, "owner-b", 1),
    ),
    ownerAAfterOwnEdit: summarizeLookup(
      crossOwnerCache.lookup(ownerAUri, "aXbc", 2),
    ),
  };
  const lifecycleUri = "file:///workspace/lifecycle.ts";
  const lifecycleCache = new NextEditCache(10);
  lifecycleCache.put(
    entry(
      "lifecycle",
      [{ ...edit(9, 9, " next", 11), uri: lifecycleUri }],
      "lifecycle-request",
      {
        documentUri: lifecycleUri,
        editWindow: { startOffset: 0, endOffset: 9 },
        cursorOffset: 9,
        userEditSince: NesStringEdit.empty,
      },
    ),
  );
  lifecycleCache.removeDocument(lifecycleUri);
  const documentLifecycle = {
    exactAfterReopen: summarizeLookup(
      lifecycleCache.lookup(lifecycleUri, "lifecycle", 9),
    ),
    changedAfterReopen: summarizeLookup(
      lifecycleCache.lookup(lifecycleUri, "lifecycle!", 10),
    ),
  };

  return {
    exact,
    outsideWindow,
    negativeRepeat,
    rebased,
    laterEdit,
    sequentialCoordinates: {
      bundled: firstEntry.edits.map(replacement),
      patchIndices: firstEntry.edits.map((candidate) => candidate.patchIndex),
      acceptedKthExact,
    },
    rejectionEviction: {
      capacityBoundary: 1,
      shownEntryAfterEviction,
      lateUnshownAtInsertion: {
        rejected: lateEntry.rejected,
        lookup: lateLookup,
      },
    },
    crossOwnerInvalidation,
    documentLifecycle,
  };
}

function crossFileStreamCacheEffects(): Readonly<
  Record<string, unknown>
> {
  const activeUri = "file:///workspace/active.ts";
  const targetBUri = "file:///workspace/target-b.ts";
  const targetCUri = "file:///workspace/target-c.ts";
  const activeText = "active-before";
  const targetBText = "target-b-before";
  const targetCText = "target-c-before";
  const targetBAfterFirst = "target-b-after-0";
  const targetBAfterSecond = "target-b-after-2";
  const targetCAfterFirst = "target-c-after-1";
  const cache = new NextEditCache(10);
  const context = {
    activeDocumentUri: activeUri,
    activeDocumentText: activeText,
    activeDocumentIsOpen: true,
    firstEditWindow: { startOffset: 10, endOffset: 20 },
    firstOriginalEditWindow: { startOffset: 30, endOffset: 40 },
    activeCursorOffset: 3,
    requestId: "cross-file-stream",
    createdAt: 1,
    source: "llm" as const,
    speculative: false,
    userEditSince: NesStringEdit.empty,
  };
  const streamedEdit = (
    targetUri: string,
    id: string,
    patchIndex: number,
  ): NesTextEdit => ({
    uri: targetUri,
    startOffset: 0,
    endOffset: 0,
    newText: id,
    kind: "insert",
    patchIndex,
  });
  const firstB = cache.putStreamedEdit(context, {
    edit: streamedEdit(targetBUri, "B0", 0),
    documentBeforeEdit: targetBText,
    currentTargetDocumentText: targetBText,
    subsequentN: 0,
  });
  const firstC = cache.putStreamedEdit(context, {
    edit: streamedEdit(targetCUri, "C1", 1),
    documentBeforeEdit: targetCText,
    currentTargetDocumentText: targetCText,
    subsequentN: 1,
    bundledEntry: firstB.bundledEntry,
  });
  const secondB = cache.putStreamedEdit(context, {
    edit: streamedEdit(targetBUri, "B2", 2),
    documentBeforeEdit: targetBAfterFirst,
    currentTargetDocumentText: targetBText,
    subsequentN: 2,
    bundledEntry: firstB.bundledEntry,
  });
  const range = (
    value:
      { readonly startOffset: number; readonly endOffset: number } | undefined,
  ): string | null =>
    value ? `${value.startOffset}-${value.endOffset}` : null;
  const summarize = (entryValue: NesCacheEntry) => ({
    kind:
      entryValue.targetDocumentText === undefined ? "target" : "activeAlias",
    ownerUri: entryValue.documentUri,
    targetUri: entryValue.edits[0]?.uri ?? entryValue.documentUri,
    documentBeforeEdit: entryValue.documentText,
    targetSnapshot: entryValue.targetDocumentText ?? null,
    edit: entryValue.edits[0]?.newText ?? "",
    subsequentN: entryValue.subsequentN,
    editWindow: range(entryValue.editWindow),
    originalEditWindow: range(entryValue.originalEditWindow),
    bundled:
      entryValue.targetDocumentText === undefined &&
      entryValue.subsequentN === 0
        ? entryValue.edits.map((candidate) => candidate.newText)
        : null,
    patchIndices:
      entryValue.targetDocumentText === undefined &&
      entryValue.subsequentN === 0
        ? entryValue.edits.map((candidate) => candidate.patchIndex ?? null)
        : null,
    tracked: entryValue.userEditSince !== undefined,
    cursorOffset: entryValue.cursorOffset ?? null,
    speculative: entryValue.speculative,
  });
  if (!firstB.activeAlias) {
    throw new Error("Expected the global-zero active alias.");
  }
  const unavailableCache = new NextEditCache(10);
  const unavailableContext = {
    ...context,
    activeDocumentIsOpen: false,
    requestId: "unavailable-alias",
  };
  const globalZeroCross = unavailableCache.putStreamedEdit(
    unavailableContext,
    {
      edit: streamedEdit(targetBUri, "unavailable-alias", 0),
      documentBeforeEdit: targetBText,
      currentTargetDocumentText: targetBText,
      subsequentN: 0,
    },
  );
  const globalOneCross = unavailableCache.putStreamedEdit(
    unavailableContext,
    {
      edit: streamedEdit(targetBUri, "unavailable-global-one", 1),
      documentBeforeEdit: targetBText,
      currentTargetDocumentText: targetBText,
      subsequentN: 1,
    },
  );
  const globalZeroSameDocument = unavailableCache.putStreamedEdit(context, {
    edit: streamedEdit(activeUri, "same-document", 0),
    documentBeforeEdit: activeText,
    currentTargetDocumentText: activeText,
    subsequentN: 0,
  });
  return {
    callOrder: [
      summarize(firstB.targetEntry),
      summarize(firstB.activeAlias),
      summarize(firstC.targetEntry),
      summarize(secondB.targetEntry),
    ],
    firstResultOwnerUri: firstB.targetEntry.documentUri,
    aliasCreated: true,
    finalTargetContents: {
      targetB: targetBAfterSecond,
      targetC: targetCAfterFirst,
    },
    unavailableAliasAttempts: {
      globalZeroCross: {
        handled: globalZeroCross.activeAliasAttempted,
        setCalls: globalZeroCross.activeAliasAttempted ? 1 : 0,
        entryCreated: globalZeroCross.activeAlias !== undefined,
      },
      globalOneCross: {
        handled: globalOneCross.activeAliasAttempted,
        setCalls: globalOneCross.activeAliasAttempted ? 1 : 0,
        entryCreated: globalOneCross.activeAlias !== undefined,
      },
      globalZeroSameDocument: {
        handled: globalZeroSameDocument.activeAliasAttempted,
        setCalls: globalZeroSameDocument.activeAliasAttempted ? 1 : 0,
        entryCreated: globalZeroSameDocument.activeAlias !== undefined,
      },
    },
  };
}

async function cursorRetryCacheEffects(): Promise<
  Readonly<Record<string, unknown>>
> {
  const sourceUri = "file:///workspace/active.ts";
  const targetUri = "file:///workspace/target-b.ts";
  const sourceText = "active-before";
  const targetText = "target-b-before";
  const targetWindow = { startOffset: 10, endOffset: 20 };
  const originalSourceWindow = { startOffset: 30, endOffset: 40 };
  const cache = new NextEditCache(10);
  const streamed = cache.putStreamedEdit(
    {
      activeDocumentUri: sourceUri,
      activeDocumentText: sourceText,
      activeDocumentIsOpen: true,
      firstEditWindow: targetWindow,
      firstOriginalEditWindow: originalSourceWindow,
      activeCursorOffset: 3,
      requestId: "cursor-retry-stream",
      createdAt: 1,
      source: "llm",
      speculative: false,
      userEditSince: NesStringEdit.empty,
    },
    {
      edit: {
        uri: targetUri,
        startOffset: 0,
        endOffset: 0,
        newText: "B0",
        kind: "insert",
        patchIndex: 0,
      },
      documentBeforeEdit: targetText,
      currentTargetDocumentText: targetText,
      subsequentN: 0,
    },
  );
  if (!streamed.activeAlias) {
    throw new Error("Expected cursor-retry active alias.");
  }
  const windowRange = (
    value:
      { readonly startOffset: number; readonly endOffset: number } | undefined,
  ): string | null =>
    value ? `${value.startOffset}-${value.endOffset}` : null;

  const terminalSourceUri = "file:///workspace/cursor-source.ts";
  const terminalTargetText = [
    "line0",
    "line1-long",
    "line2-longer",
    "line3-longest",
    "line4-target",
    "line5-long",
    "line6",
  ].join("\n");
  const terminalWindow = {
    startOffset: 0,
    endOffset: terminalTargetText.length,
  };
  const originalSourceCursorOffset = 0;
  const targetCursorOffset = terminalTargetText.indexOf("line4-target");
  const reducedFromOriginal = computeReducedNesWindow(
    terminalTargetText,
    terminalWindow,
    originalSourceCursorOffset,
  );
  const reducedFromTarget = computeReducedNesWindow(
    terminalTargetText,
    terminalWindow,
    targetCursorOffset,
  );
  const terminalEntry: NesCacheEntry = {
    documentUri: terminalSourceUri,
    documentText: terminalTargetText,
    editWindow: reducedFromOriginal,
    cursorOffset: originalSourceCursorOffset,
    requestId: "cursor-terminal-request",
    createdAt: 1,
    edits: [],
    source: "llm",
    subsequentN: 0,
    speculative: false,
    rejected: false,
    wasShown: false,
    wasRenderedAsInlineSuggestion: false,
  };
  cache.put(terminalEntry);

  const runCrossFileOpen = async (options: {
    readonly openFails?: boolean;
    readonly cancelled?: boolean;
    readonly typed?: boolean;
  }) => {
    const events: string[] = [];
    const result = await runNesCrossFileOpenContinuation<
      { readonly getText: () => string },
      {
        readonly kind: string;
        readonly reason: string | null;
        readonly nextCursorPosition: string | null;
        readonly targetUri: string | null;
      }
    >({
      open: async () => {
        events.push("open");
        if (options.openFails) throw new Error("missing target");
        return {
          getText: () => {
            events.push("getText");
            return "target line 0\ntarget line 1";
          },
        };
      },
      isCancellationRequested: () => {
        events.push("token");
        return options.cancelled === true;
      },
      hasUserTypedSinceRequestStarted: () => {
        events.push("typed");
        return options.typed === true;
      },
      onOpenFailed: () => ({
        value: {
          kind: "NoSuggestions",
          reason: null,
          nextCursorPosition: "1:1",
          targetUri: "file:///workspace/target.ts",
        },
      }),
      onCancelled: (reason) => ({
        value: {
          kind: "GotCancelled",
          reason,
          nextCursorPosition: null,
          targetUri: null,
        },
      }),
      onOpened: (document) => {
        document.getText();
        events.push("retry");
        return {
          value: {
            kind: "Retry",
            reason: null,
            nextCursorPosition: null,
            targetUri: null,
          },
        };
      },
    });
    return { events, terminal: result.value };
  };

  return {
    streamedEdit: {
      targetOwner: streamed.targetEntry.documentUri,
      targetCursorOffset: streamed.targetEntry.cursorOffset ?? null,
      targetWindow: windowRange(streamed.targetEntry.editWindow),
      targetOriginalWindow: windowRange(
        streamed.targetEntry.originalEditWindow,
      ),
      aliasOwner: streamed.activeAlias.documentUri,
      aliasTarget: streamed.activeAlias.edits[0]?.uri,
      aliasCursorOffset: streamed.activeAlias.cursorOffset ?? null,
      aliasWindow: windowRange(streamed.activeAlias.editWindow),
      aliasOriginalWindow: windowRange(streamed.activeAlias.originalEditWindow),
    },
    emptyTerminal: {
      ownerUri: terminalEntry.documentUri,
      documentBeforeEdit: terminalEntry.documentText,
      reducedWindow: windowRange(terminalEntry.editWindow),
      matchesOriginalCursorReduction:
        windowRange(terminalEntry.editWindow) ===
        windowRange(reducedFromOriginal),
      matchesTargetCursorReduction:
        windowRange(terminalEntry.editWindow) ===
        windowRange(reducedFromTarget),
    },
    userTypedSinceRequestStarted: {
      empty: hasUserTypedSinceNesRequestStarted(NesStringEdit.empty),
      nonEmpty: hasUserTypedSinceNesRequestStarted(stringEdit(0, 0, "typed")),
      undefined: hasUserTypedSinceNesRequestStarted(undefined),
    },
    crossFileOpen: {
      relativeWithoutRoot: {
        events: [],
        terminal: {
          kind: "NoSuggestions",
          reason: null,
          nextCursorPosition: null,
          targetUri: null,
        },
      },
      openFailure: await runCrossFileOpen({
        openFails: true,
        cancelled: true,
        typed: true,
      }),
      cancelledAfterOpen: await runCrossFileOpen({
        cancelled: true,
        typed: true,
      }),
      typedAfterOpen: await runCrossFileOpen({ typed: true }),
      cleanOpen: await runCrossFileOpen({}),
    },
  };
}

function rejectionEffects(): Readonly<Record<string, unknown>> {
  const requestCache = new NextEditCache(10);
  const firstRequestEntry = entry(
    "first text",
    [edit(1, 1, "first")],
    "shared-request",
  );
  const secondRequestEntry = entry(
    "second text",
    [edit(2, 2, "second")],
    "shared-request",
    { subsequentN: 1 },
  );
  const differentRequestEntry = entry(
    "different text",
    [edit(3, 3, "different")],
    "different-request",
  );
  requestCache.put(firstRequestEntry);
  requestCache.put(secondRequestEntry);
  requestCache.put(differentRequestEntry);
  requestCache.markRejected(
    "shared-request",
    firstRequestEntry.edits[0],
    firstRequestEntry.documentText,
    firstRequestEntry,
  );
  const requestScope = {
    sameRequestEntriesRejected: [
      firstRequestEntry.rejected,
      secondRequestEntry.rejected,
    ],
    differentRequestRejected: differentRequestEntry.rejected,
    persistentCollector: {
      shown: requestCache.isPersistentlyRejected(
        uri,
        firstRequestEntry.documentText,
        firstRequestEntry.edits[0],
      ),
      unshownSameRequest: requestCache.isPersistentlyRejected(
        uri,
        secondRequestEntry.documentText,
        secondRequestEntry.edits[0],
      ),
    },
  };
  const cache = new NextEditCache(1);
  const shown = entry(
    "function fi",
    [edit(11, 11, "bonacci")],
    "shown-request",
    { cursorOffset: 11 },
  );
  cache.put(shown);
  cache.markRejected(
    "shown-request",
    shown.edits[0],
    shown.documentText,
    shown,
  );
  const shownIsRejected = cache.isRejected(uri, "function fi", shown.edits[0]);
  const typeThrough = stringEdit(11, 11, "b");
  cache.handleDocumentEdit(uri, typeThrough, "function fib");
  const continuation = edit(12, 12, "onacci");
  const overlappingTypeThrough = {
    document: "function fib",
    candidate: replacement(continuation),
    isRejected: cache.isPersistentlyRejected(uri, "function fib", continuation),
  };
  const conflict = stringEdit(12, 12, "x");
  cache.handleDocumentEdit(uri, conflict, "function fibx");
  const conflictingOverlap = {
    document: "function fibx",
    isRejected: cache.isPersistentlyRejected(
      uri,
      "function fibx",
      edit(13, 13, "onacci"),
    ),
  };
  const cacheOutput = cacheEffects();
  return {
    requestScope,
    shownIsRejected,
    overlappingTypeThrough,
    conflictingOverlap,
    lateUnshownCacheEntry: cacheOutput.rejectionEviction,
  };
}

function pendingReuse(
  pendingCancellationRequested: boolean,
  cursorOffset: number,
): Readonly<Record<string, unknown>> {
  const state = new NesSpeculativeState<never, string>();
  state.setPending({
    documentUri: uri,
    postEditContent: "post-edit",
    trajectoryPrefix: "",
    trajectorySuffix: "",
    trajectoryNewText: "post-edit",
    value: "speculative-cache",
    cancel: () => undefined,
  });
  const order: string[] = [];
  const reusable = canReuseNesPendingSpeculative({
    documentUri: uri,
    documentText: "post-edit",
    cursorOffset,
    pendingDocumentUri: uri,
    pendingDocumentText: "post-edit",
    pendingEditWindow: { startOffset: 2, endOffset: 8 },
    pendingCancellationRequested,
  });
  let source = "fresh-request";
  if (reusable) {
    const value = state.consumePending(uri, "post-edit");
    order.push("consumePending");
    source = value ?? source;
    order.push("join");
  } else {
    order.push("fresh");
  }
  return {
    order,
    source,
    isFromSpeculativeRequest: reusable,
    pendingDetached: state.pending === undefined,
  };
}

export const nesCacheSpeculativeCases: readonly ParityCase[] = [
  {
    id: "nes-cache-lookup",
    assertion:
      "local cache states match official exact, rebase, sequential, and eviction outputs",
    run() {
      expect(cacheEffects()).toEqual(expectedFor("nes-cache-lookup"));
    },
  },
  {
    id: "nes-cross-file-stream-cache",
    assertion:
      "local per-target streamed entries, active alias, and global-zero bundle match the official B/C/B flow",
    run() {
      expect(crossFileStreamCacheEffects()).toEqual(
        expectedFor("nes-cross-file-stream-cache"),
      );
    },
  },
  {
    id: "nes-cursor-retry-cache-ownership",
    assertion:
      "local cursor-retry target/alias ownership, empty terminal cache, and user-edit tri-state match the official path",
    async run() {
      expect(await cursorRetryCacheEffects()).toEqual(
        expectedFor("nes-cursor-retry-cache-ownership"),
      );
    },
  },
  {
    id: "nes-rejection-tracking",
    assertion:
      "local shown-only rejection tracking matches official overlap and eviction behavior",
    run() {
      expect(rejectionEffects()).toEqual(
        expectedFor("nes-rejection-tracking"),
      );
    },
  },
  {
    id: "nes-speculative-provider",
    assertion:
      "local pending gate, detach order, and auto-expand modes match official provider behavior",
    run() {
      const configuredLines =
        COPILOT_BEHAVIOR_CONFIG.nextEdit.autoExpandEditWindowLines;
      const configuredMode =
        COPILOT_BEHAVIOR_CONFIG.nextEdit
          .speculativeRequestsAutoExpandEditWindowLines;
      const output = {
        pendingReuse: {
          matched: pendingReuse(false, 5),
          cancelledToken: pendingReuse(true, 5),
          cursorOutsideRequestWindow: pendingReuse(false, 9),
        },
        autoExpand: {
          configuredDefaultLines: configuredLines,
          configuredDefaultMode: configuredMode,
          off:
            resolveNesSpeculativeEditWindowLines(
              "off",
              configuredLines,
              true,
              true,
            ) ?? null,
          always:
            resolveNesSpeculativeEditWindowLines(
              "always",
              configuredLines,
              false,
              false,
            ) ?? null,
          smartCold:
            resolveNesSpeculativeEditWindowLines(
              "smart",
              configuredLines,
              false,
              false,
            ) ?? null,
          smartSpeculative:
            resolveNesSpeculativeEditWindowLines(
              "smart",
              configuredLines,
              true,
              false,
            ) ?? null,
          smartSubsequent:
            resolveNesSpeculativeEditWindowLines(
              "smart",
              configuredLines,
              false,
              true,
            ) ?? null,
        },
      };
      expect(output).toEqual(expectedFor("nes-speculative-provider"));
    },
  },
];

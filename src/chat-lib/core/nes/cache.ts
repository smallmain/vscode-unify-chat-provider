import { tryRebaseNesEdits, type NesRebaseConfig } from "./edit-rebase";
import { NesStringEdit, NesStringReplacement } from "./string-edit";
import type { NesTextEdit } from "./types";

export interface NesCacheEntry {
  readonly documentUri: string;
  readonly documentText: string;
  /** Snapshot for an edit targeting a document other than documentUri. */
  readonly targetDocumentText?: string;
  readonly editWindow?: {
    readonly startOffset: number;
    readonly endOffset: number;
  };
  readonly originalEditWindow?: {
    readonly startOffset: number;
    readonly endOffset: number;
  };
  readonly cursorOffset?: number;
  readonly requestId: string;
  readonly createdAt: number;
  edits: readonly NesTextEdit[];
  readonly source: "llm" | "diagnostics";
  readonly subsequentN: number;
  readonly speculative: boolean;
  userEditSince?: NesStringEdit;
  rebaseFailed?: boolean;
  rejected: boolean;
  wasShown: boolean;
  wasRenderedAsInlineSuggestion: boolean;
}

export interface NesCacheLookup {
  readonly entry: NesCacheEntry;
  readonly edit?: NesTextEdit;
  readonly rebased: boolean;
  readonly subsequent: boolean;
  readonly speculative: boolean;
  readonly noSuggestions: boolean;
}

export interface NesStreamCacheContext {
  readonly activeDocumentUri: string;
  readonly activeDocumentText: string;
  readonly activeDocumentIsOpen: boolean;
  readonly firstEditWindow?: {
    readonly startOffset: number;
    readonly endOffset: number;
  };
  readonly firstOriginalEditWindow?: {
    readonly startOffset: number;
    readonly endOffset: number;
  };
  readonly activeCursorOffset: number;
  readonly requestId: string;
  readonly createdAt: number;
  readonly source: NesCacheEntry["source"];
  readonly speculative: boolean;
  readonly userEditSince?: NesStringEdit;
}

export interface NesStreamCacheEdit {
  readonly edit: NesTextEdit;
  /** Target-document contents immediately before this streamed edit. */
  readonly documentBeforeEdit: string;
  /** Live target contents, or undefined when its document cache is unavailable. */
  readonly currentTargetDocumentText: string | undefined;
  /** Global order in the model stream, even when targets are interleaved. */
  readonly subsequentN: number;
  /** Global edit-zero entry carrying the mutable same-target bundle. */
  readonly bundledEntry?: NesCacheEntry;
}

export interface NesStreamCacheResult {
  /** The real target entry, absent when that document cache is unavailable. */
  readonly targetEntry?: NesCacheEntry;
  /** Present only when the stream's global edit-zero entry owns the bundle. */
  readonly bundledEntry?: NesCacheEntry;
  /** Official helper handled global edit zero as cross-file, even if its owner was closed. */
  readonly activeAliasAttempted: boolean;
  /** Exact-only active-document alias for the first cross-file edit. */
  readonly activeAlias?: NesCacheEntry;
}

interface RejectedEdit {
  readonly documentUri: string;
  documentText: string;
  edit: NesTextEdit;
}

const DEFAULT_REBASE_CONFIG: NesRebaseConfig = {
  absorbSubsequenceTyping: false,
  reverseAgreement: true,
  maxImperfectAgreementLength: 1,
};

const REJECTION_REBASE_CONFIG: NesRebaseConfig = {
  absorbSubsequenceTyping: false,
  reverseAgreement: false,
  maxImperfectAgreementLength: 5,
};

function cacheKey(uri: string, text: string): string {
  return JSON.stringify([uri, text]);
}

function applyEdit(text: string, edit: NesTextEdit): string {
  return `${text.slice(0, edit.startOffset)}${edit.newText}${text.slice(edit.endOffset)}`;
}

function minimizeEdit(text: string, edit: NesTextEdit): NesTextEdit {
  const original = text.slice(edit.startOffset, edit.endOffset);
  let prefix = 0;
  const maxPrefix = Math.min(original.length, edit.newText.length);
  while (prefix < maxPrefix && original[prefix] === edit.newText[prefix]) {
    prefix += 1;
  }
  let suffix = 0;
  while (
    suffix < original.length - prefix &&
    suffix < edit.newText.length - prefix &&
    original[original.length - suffix - 1] ===
      edit.newText[edit.newText.length - suffix - 1]
  ) {
    suffix += 1;
  }
  return {
    ...edit,
    startOffset: edit.startOffset + prefix,
    endOffset: edit.endOffset - suffix,
    newText: edit.newText.slice(prefix, edit.newText.length - suffix),
  };
}

function editsEqual(
  text: string,
  left: NesTextEdit,
  right: NesTextEdit,
): boolean {
  const normalizedLeft = minimizeEdit(text, left);
  const normalizedRight = minimizeEdit(text, right);
  return (
    normalizedLeft.uri === normalizedRight.uri &&
    normalizedLeft.startOffset === normalizedRight.startOffset &&
    normalizedLeft.endOffset === normalizedRight.endOffset &&
    normalizedLeft.newText === normalizedRight.newText
  );
}

function shiftRangeAfterAccepted(
  range: { readonly startOffset: number; readonly endOffset: number },
  accepted: NesTextEdit,
): { readonly startOffset: number; readonly endOffset: number } {
  const delta =
    accepted.newText.length - (accepted.endOffset - accepted.startOffset);
  return {
    startOffset:
      range.startOffset >= accepted.endOffset
        ? range.startOffset + delta
        : range.startOffset,
    endOffset:
      range.endOffset >= accepted.endOffset
        ? range.endOffset + delta
        : range.endOffset,
  };
}

function rebaseNextCachedEdit(
  entry: NesCacheEntry,
  initialWindow:
    { readonly startOffset: number; readonly endOffset: number } | undefined,
  currentText: string,
  cursorOffset: number,
  config: NesRebaseConfig,
):
  | { readonly kind: "success"; readonly edit?: NesTextEdit }
  | { readonly kind: "outsideEditWindow" }
  | { readonly kind: "rebaseFailed" }
  | { readonly kind: "inconsistentEdits" }
  | { readonly kind: "error" } {
  let modelText = entry.documentText;
  let window = initialWindow;
  let userEdit = entry.userEditSince;
  if (userEdit === undefined) return { kind: "inconsistentEdits" };
  for (const edit of entry.edits) {
    if (edit.uri !== entry.documentUri) return { kind: "rebaseFailed" };
    const result = tryRebaseNesEdits(
      modelText,
      window
        ? { start: window.startOffset, endOffset: window.endOffset }
        : undefined,
      [edit],
      userEdit,
      currentText,
      cursorOffset,
      "strict",
      config,
    );
    if (result.kind !== "success") return result;
    const rebased = result.edits[0];
    if (rebased) return { kind: "success", edit: rebased };
    modelText = applyEdit(modelText, edit);
    if (window) window = shiftRangeAfterAccepted(window, edit);
    userEdit = NesStringEdit.fromDiff(modelText, currentText);
  }
  return { kind: "success" };
}

export class NextEditCache {
  private readonly entries = new Map<string, NesCacheEntry>();
  private readonly tracked = new Map<string, NesCacheEntry[]>();
  private readonly rejectedEdits: RejectedEdit[] = [];

  constructor(
    private readonly maxEntries: number,
    private readonly rebaseConfig: NesRebaseConfig = DEFAULT_REBASE_CONFIG,
    private readonly cacheCursorDistanceCheck = false,
    private readonly invalidateOtherDocumentsOnEdit = true,
  ) {}

  put(entry: NesCacheEntry): void {
    const key = cacheKey(entry.documentUri, entry.documentText);
    const replaced = this.entries.get(key);
    if (replaced) this.removeTracked(replaced);
    this.entries.delete(key);
    this.entries.set(key, entry);
    if (
      entry.edits.length > 0 &&
      entry.edits[0]?.uri === entry.documentUri &&
      entry.userEditSince !== undefined
    ) {
      const tracked = this.tracked.get(entry.documentUri) ?? [];
      if (!tracked.includes(entry)) {
        tracked.unshift(entry);
        this.tracked.set(entry.documentUri, tracked.slice(0, this.maxEntries));
      }
    }
    while (this.entries.size > this.maxEntries) {
      const oldestKey = this.entries.keys().next().value;
      if (typeof oldestKey !== "string") break;
      const evicted = this.entries.get(oldestKey);
      this.entries.delete(oldestKey);
      if (evicted) this.removeTracked(evicted);
    }
  }

  putStreamedEdit(
    context: NesStreamCacheContext,
    streamed: NesStreamCacheEdit & {
      readonly currentTargetDocumentText: string;
    },
  ): NesStreamCacheResult & { readonly targetEntry: NesCacheEntry };
  putStreamedEdit(
    context: NesStreamCacheContext,
    streamed: NesStreamCacheEdit,
  ): NesStreamCacheResult;
  putStreamedEdit(
    context: NesStreamCacheContext,
    streamed: NesStreamCacheEdit,
  ): NesStreamCacheResult {
    const targetUri = streamed.edit.uri;
    const targetsActiveDocument = targetUri === context.activeDocumentUri;
    const baseEntry: NesCacheEntry = {
      documentUri: targetUri,
      documentText: streamed.documentBeforeEdit,
      ...(streamed.subsequentN === 0 && context.firstEditWindow
        ? { editWindow: context.firstEditWindow }
        : {}),
      ...(streamed.subsequentN === 0 && context.firstOriginalEditWindow
        ? { originalEditWindow: context.firstOriginalEditWindow }
        : {}),
      ...(targetsActiveDocument
        ? { cursorOffset: context.activeCursorOffset }
        : {}),
      requestId: context.requestId,
      createdAt: context.createdAt,
      edits: [streamed.edit],
      source: context.source,
      subsequentN: streamed.subsequentN,
      speculative: context.speculative,
      ...(!context.speculative &&
      streamed.subsequentN === 0 &&
      context.userEditSince !== undefined &&
      streamed.currentTargetDocumentText !== undefined &&
      context.userEditSince.apply(streamed.documentBeforeEdit) ===
        streamed.currentTargetDocumentText
        ? { userEditSince: context.userEditSince }
        : {}),
      rejected: false,
      wasShown: false,
      wasRenderedAsInlineSuggestion: false,
    };
    const targetEntry =
      streamed.currentTargetDocumentText === undefined ? undefined : baseEntry;
    if (targetEntry) this.put(targetEntry);

    const bundledEntry =
      streamed.bundledEntry?.subsequentN === 0 &&
      streamed.bundledEntry.documentUri === targetUri
        ? streamed.bundledEntry
        : streamed.subsequentN === 0
          ? targetEntry
          : undefined;
    if (bundledEntry && bundledEntry !== targetEntry) {
      bundledEntry.edits = [...bundledEntry.edits, streamed.edit];
    }

    const activeAliasAttempted =
      streamed.subsequentN === 0 && !targetsActiveDocument;
    let activeAlias: NesCacheEntry | undefined;
    if (activeAliasAttempted && context.activeDocumentIsOpen) {
      activeAlias = {
        ...baseEntry,
        documentUri: context.activeDocumentUri,
        documentText: context.activeDocumentText,
        targetDocumentText: streamed.documentBeforeEdit,
        ...(context.firstEditWindow
          ? { editWindow: context.firstEditWindow }
          : { editWindow: undefined }),
        cursorOffset: undefined,
        edits: [streamed.edit],
        userEditSince: undefined,
        rebaseFailed: false,
      };
      this.put(activeAlias);
    }

    return {
      activeAliasAttempted,
      ...(targetEntry ? { targetEntry } : {}),
      ...(bundledEntry ? { bundledEntry } : {}),
      ...(activeAlias ? { activeAlias } : {}),
    };
  }

  handleDocumentEdit(
    documentUri: string,
    edit: NesStringEdit,
    currentText: string,
  ): void {
    if (edit.isEmpty()) return;
    if (this.invalidateOtherDocumentsOnEdit) {
      for (const [key, entry] of this.entries) {
        if (entry.documentUri === documentUri) continue;
        this.entries.delete(key);
        this.removeTracked(entry);
      }
    }
    for (let index = this.rejectedEdits.length - 1; index >= 0; index -= 1) {
      const rejected = this.rejectedEdits[index];
      if (rejected.documentUri !== documentUri) continue;
      const rebased = NesStringEdit.single(
        new NesStringReplacement(
          {
            start: rejected.edit.startOffset,
            endOffset: rejected.edit.endOffset,
          },
          rejected.edit.newText,
        ),
      ).tryRebase(edit);
      if (!rebased || rebased.replacements.length !== 1) {
        this.rejectedEdits.splice(index, 1);
        continue;
      }
      const replacement = rebased.replacements[0];
      rejected.documentText = currentText;
      rejected.edit = {
        ...rejected.edit,
        startOffset: replacement.range.start,
        endOffset: replacement.range.endOffset,
        newText: replacement.newText,
        kind:
          replacement.range.start === replacement.range.endOffset
            ? "insert"
            : "replace",
      };
    }
    for (const entry of this.tracked.get(documentUri) ?? []) {
      if (entry.userEditSince === undefined) continue;
      const composed = entry.userEditSince.compose(edit);
      entry.userEditSince = composed;
      entry.rebaseFailed = false;
      if (composed.apply(entry.documentText) === currentText) {
        continue;
      } else {
        entry.userEditSince = undefined;
      }
    }
  }

  appendEdit(entry: NesCacheEntry, edit: NesTextEdit): void {
    if (entry.edits.includes(edit)) return;
    entry.edits = [...entry.edits, edit];
    this.createSubsequent(entry.requestId, entry);
  }

  lookup(
    documentUri: string,
    documentText: string,
    cursorOffset: number,
    resolveDocumentText?: (uri: string) => string | undefined,
  ): NesCacheLookup | undefined {
    const exactKey = cacheKey(documentUri, documentText);
    const exact = this.entries.get(exactKey);
    if (
      exact &&
      this.isCursorRelevant(exact, cursorOffset) &&
      this.isTargetDocumentValid(exact, resolveDocumentText)
    ) {
      if (this.movedFartherFromEdit(exact, documentText, cursorOffset)) {
        exact.rejected = true;
      }
      this.entries.delete(exactKey);
      this.entries.set(exactKey, exact);
      return this.lookupResult(exact, exact.edits[0], false);
    }

    for (const entry of this.tracked.get(documentUri) ?? []) {
      if (
        entry.rejected ||
        entry.rebaseFailed ||
        entry.userEditSince === undefined
      ) {
        continue;
      }
      const first = entry.edits[0];
      if (first && first.uri !== documentUri) continue;
      const windows = entry.originalEditWindow
        ? [entry.editWindow, entry.originalEditWindow]
        : [entry.editWindow];
      for (const window of windows) {
        const result = rebaseNextCachedEdit(
          entry,
          window,
          documentText,
          cursorOffset,
          this.rebaseConfig,
        );
        if (result.kind === "rebaseFailed") {
          entry.rebaseFailed = true;
          break;
        }
        if (result.kind === "inconsistentEdits" || result.kind === "error") {
          entry.userEditSince = undefined;
          break;
        }
        if (result.kind === "outsideEditWindow") continue;
        if (!first) return this.lookupResult(entry, undefined, true);
        const rebased = result.edit;
        if (rebased) {
          if (this.isRejected(documentUri, documentText, rebased)) {
            entry.rejected = true;
          }
          return this.lookupResult(entry, rebased, true);
        }
      }
    }
    return undefined;
  }

  markShown(
    requestId: string,
    renderedInline: boolean,
    sourceEntry?: NesCacheEntry,
  ): void {
    const entry =
      sourceEntry ??
      this.allEntriesForRequest(requestId).sort(
        (left, right) => left.subsequentN - right.subsequentN,
      )[0];
    if (!entry) return;
    entry.wasShown = true;
    entry.wasRenderedAsInlineSuggestion ||= renderedInline;
  }

  markRejected(
    requestId: string,
    shownEdit?: NesTextEdit,
    shownDocumentText?: string,
    sourceEntry?: NesCacheEntry,
  ): void {
    const requestEntries = this.allEntriesForRequest(requestId);
    if (sourceEntry && !requestEntries.includes(sourceEntry)) {
      requestEntries.push(sourceEntry);
    }
    for (const requestEntry of requestEntries) {
      requestEntry.rejected = true;
    }
    const entry =
      sourceEntry ??
      requestEntries.sort(
        (left, right) => left.subsequentN - right.subsequentN,
      )[0];
    if (!entry) return;
    const edit = shownEdit ?? entry.edits[0];
    if (!edit) return;
    const documentText =
      shownDocumentText ??
      (edit.uri === entry.documentUri
        ? entry.documentText
        : entry.targetDocumentText);
    if (documentText === undefined) return;
    this.recordPersistentRejection(edit.uri, documentText, edit);
  }

  recordPersistentRejection(
    documentUri: string,
    documentText: string,
    edit: NesTextEdit,
  ): void {
    const rejected = {
      documentUri,
      documentText,
      edit: minimizeEdit(documentText, edit),
    };
    if (
      this.rejectedEdits.some(
        (candidate) =>
          candidate.documentUri === rejected.documentUri &&
          candidate.documentText === rejected.documentText &&
          editsEqual(documentText, candidate.edit, rejected.edit),
      )
    ) {
      return;
    }
    this.rejectedEdits.push(rejected);
    if (this.rejectedEdits.length > 20) this.rejectedEdits.shift();
  }

  isRejected(
    documentUri: string,
    documentText: string,
    edit: NesTextEdit,
  ): boolean {
    if (this.isPersistentlyRejected(documentUri, documentText, edit)) {
      return true;
    }
    return (this.tracked.get(documentUri) ?? []).some((entry) => {
      if (!entry.rejected || entry.rebaseFailed || entry.edits.length === 0) {
        return false;
      }
      const userEdit = NesStringEdit.fromDiff(entry.documentText, documentText);
      const rebased = tryRebaseNesEdits(
        entry.documentText,
        undefined,
        entry.edits,
        userEdit,
        documentText,
        undefined,
        "lenient",
        REJECTION_REBASE_CONFIG,
      );
      return (
        rebased.kind === "success" &&
        rebased.edits.some((candidateEdit) =>
          editsEqual(documentText, candidateEdit, edit),
        )
      );
    });
  }

  isPersistentlyRejected(
    documentUri: string,
    documentText: string,
    edit: NesTextEdit,
  ): boolean {
    return this.rejectedEdits.some((candidate) => {
      if (candidate.documentUri !== documentUri) return false;
      const userEdit = NesStringEdit.fromDiff(
        candidate.documentText,
        documentText,
      );
      const rebased = NesStringEdit.single(
        new NesStringReplacement(
          {
            start: candidate.edit.startOffset,
            endOffset: candidate.edit.endOffset,
          },
          candidate.edit.newText,
        ),
      ).tryRebase(userEdit);
      if (!rebased || rebased.replacements.length !== 1) return false;
      const replacement = rebased.replacements[0];
      return editsEqual(
        documentText,
        {
          ...candidate.edit,
          startOffset: replacement.range.start,
          endOffset: replacement.range.endOffset,
          newText: replacement.newText,
        },
        edit,
      );
    });
  }

  markAccepted(entry: NesCacheEntry): NesCacheEntry | undefined {
    return this.createSubsequent(entry.requestId, entry);
  }

  createSubsequent(
    requestId: string,
    sourceEntry?: NesCacheEntry,
  ): NesCacheEntry | undefined {
    const entry =
      sourceEntry ??
      this.allEntriesForRequest(requestId).sort(
        (left, right) => left.subsequentN - right.subsequentN,
      )[0];
    const accepted = entry?.edits[0];
    if (!entry || !accepted || accepted.uri !== entry.documentUri) {
      return undefined;
    }
    const remaining = entry.edits.slice(1);
    if (remaining.length === 0) return undefined;
    const nextDocumentText = applyEdit(entry.documentText, accepted);
    const alreadyCached = this.entries.get(
      cacheKey(entry.documentUri, nextDocumentText),
    );
    if (
      alreadyCached?.requestId === entry.requestId &&
      !alreadyCached.rejected &&
      alreadyCached.edits[0] !== undefined &&
      editsEqual(nextDocumentText, alreadyCached.edits[0], remaining[0])
    ) {
      return alreadyCached;
    }
    const next: NesCacheEntry = {
      ...entry,
      documentText: nextDocumentText,
      edits: remaining,
      ...(entry.editWindow
        ? { editWindow: shiftRangeAfterAccepted(entry.editWindow, accepted) }
        : { editWindow: undefined }),
      ...(entry.originalEditWindow
        ? {
            originalEditWindow: shiftRangeAfterAccepted(
              entry.originalEditWindow,
              accepted,
            ),
          }
        : {}),
      ...(entry.cursorOffset !== undefined
        ? {
            cursorOffset:
              entry.cursorOffset >= accepted.endOffset
                ? entry.cursorOffset +
                  accepted.newText.length -
                  (accepted.endOffset - accepted.startOffset)
                : entry.cursorOffset,
          }
        : { cursorOffset: undefined }),
      subsequentN: entry.subsequentN + 1,
      userEditSince: undefined,
      rebaseFailed: false,
      rejected: false,
      wasShown: false,
      wasRenderedAsInlineSuggestion: false,
    };
    this.put(next);
    return next;
  }

  removeDocument(documentUri: string): void {
    // Shared exact entries outlive the per-open-document tracking state.
    this.tracked.delete(documentUri);
    for (let index = this.rejectedEdits.length - 1; index >= 0; index -= 1) {
      if (this.rejectedEdits[index]?.documentUri === documentUri) {
        this.rejectedEdits.splice(index, 1);
      }
    }
  }

  clear(): void {
    this.entries.clear();
    this.tracked.clear();
    this.rejectedEdits.length = 0;
  }

  get size(): number {
    return this.entries.size;
  }

  hasPositiveEntry(documentUri: string, documentText: string): boolean {
    return (
      (this.entries.get(cacheKey(documentUri, documentText))?.edits.length ??
        0) > 0
    );
  }

  private lookupResult(
    entry: NesCacheEntry,
    edit: NesTextEdit | undefined,
    rebased: boolean,
  ): NesCacheLookup {
    return {
      entry,
      ...(edit ? { edit } : {}),
      rebased,
      subsequent: entry.subsequentN > 0,
      speculative: entry.speculative,
      noSuggestions: edit === undefined,
    };
  }

  private isCursorRelevant(
    entry: NesCacheEntry,
    cursorOffset: number,
  ): boolean {
    const inWindow =
      entry.editWindow === undefined ||
      (cursorOffset >= entry.editWindow.startOffset &&
        cursorOffset <= entry.editWindow.endOffset);
    const original = entry.originalEditWindow;
    return (
      inWindow ||
      (original !== undefined &&
        cursorOffset >= original.startOffset &&
        cursorOffset <= original.endOffset)
    );
  }

  private movedFartherFromEdit(
    entry: NesCacheEntry,
    documentText: string,
    cursorOffset: number,
  ): boolean {
    const edit = entry.edits[0];
    if (
      !this.cacheCursorDistanceCheck ||
      !edit ||
      edit.uri !== entry.documentUri ||
      entry.cursorOffset === undefined ||
      entry.subsequentN > 0
    ) {
      return false;
    }
    const editLine = lineAtOffset(documentText, edit.startOffset);
    const originalCursorLine = lineAtOffset(documentText, entry.cursorOffset);
    const currentCursorLine = lineAtOffset(documentText, cursorOffset);
    return (
      Math.abs(currentCursorLine - editLine) >
      Math.abs(originalCursorLine - editLine)
    );
  }

  private isTargetDocumentValid(
    entry: NesCacheEntry,
    resolveDocumentText: ((uri: string) => string | undefined) | undefined,
  ): boolean {
    const targetUri = entry.edits[0]?.uri;
    if (!targetUri || targetUri === entry.documentUri) return true;
    return (
      entry.targetDocumentText !== undefined &&
      resolveDocumentText?.(targetUri) === entry.targetDocumentText
    );
  }

  private removeTracked(entry: NesCacheEntry): void {
    const entries = this.tracked.get(entry.documentUri);
    if (!entries) return;
    const retained = entries.filter((candidate) => candidate !== entry);
    if (retained.length === 0) this.tracked.delete(entry.documentUri);
    else this.tracked.set(entry.documentUri, retained);
  }

  private allEntriesForRequest(requestId: string): NesCacheEntry[] {
    const matches: NesCacheEntry[] = [];
    const seen = new Set<NesCacheEntry>();
    for (const entry of this.entries.values()) {
      if (entry.requestId === requestId && !seen.has(entry)) {
        matches.push(entry);
        seen.add(entry);
      }
    }
    for (const entries of this.tracked.values()) {
      for (const entry of entries) {
        if (entry.requestId === requestId && !seen.has(entry)) {
          matches.push(entry);
          seen.add(entry);
        }
      }
    }
    return matches;
  }
}

function lineAtOffset(text: string, offset: number): number {
  let line = 0;
  const limit = Math.max(0, Math.min(offset, text.length));
  for (let index = 0; index < limit; index += 1) {
    if (text[index] === "\n") line += 1;
  }
  return line;
}

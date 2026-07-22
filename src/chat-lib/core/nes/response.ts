import type {
  NesAggressivenessLevel,
  NesPromptStrategy,
} from "../behavior-config";
import {
  PromptTags,
  ResponseTags,
} from "../../upstream/extension/xtab/common/tags";
import type {
  NesDocumentContext,
  NesHistoryContext,
  NesParsedResponse,
  NesPromptBuildResult,
  NesTextEdit,
} from "./types";
import { parseNesEditIntent, shouldShowNesEditIntent } from "./edit-intent";

export interface NesEditFilterOptions {
  readonly substrings: readonly string[];
  readonly undoInsertionFiltering: false | "v1" | "v2";
  readonly relatedDocuments?: readonly NesDocumentContext[];
  readonly allowImportChanges?: boolean;
  readonly allowWhitespaceOnlyChanges?: boolean;
  readonly filterNotebookCellMarkers?: boolean;
}

export interface NesStreamingResponseOptions {
  readonly filters?: NesEditFilterOptions;
  readonly history?: readonly NesHistoryContext[];
  readonly getEarlyTerminationReason?: () => string | undefined;
  readonly onEarlyDivergence?: (reason: string) => void;
  readonly checkModelLine?: (
    localLineIndex: number,
    modelLine: string,
  ) => boolean;
  readonly responseFormat?: NesParsedResponse["format"];
  readonly aggressivenessLevel?: NesAggressivenessLevel;
  readonly onParseResultKind?: (kind: NesResponseParseResultKind) => void;
  readonly beforeFirstEditWindowCandidate?: () => Promise<boolean>;
}

export type NesResponseParseResultKind =
  "done" | "directEdits" | "editWindowLines";

interface DiffHunk {
  readonly oldStart: number;
  readonly oldEndExclusive: number;
  readonly newLines: readonly string[];
}

interface ResponseStreamState {
  rawText: string;
  diverged: boolean;
  divergenceReported: boolean;
}

interface DivergenceState {
  readonly startLineIdx: number;
  readonly newLines: string[];
}

const DEFAULT_FILTER_OPTIONS: NesEditFilterOptions = {
  substrings: [],
  undoInsertionFiltering: false,
  allowImportChanges: false,
  allowWhitespaceOnlyChanges: true,
  filterNotebookCellMarkers: false,
};

function responseFormat(
  strategy: NesPromptStrategy,
  override?: NesParsedResponse["format"],
): NesParsedResponse["format"] {
  if (override) return override;
  switch (strategy) {
    case "copilotNesXtab":
      return "codeBlock";
    case "xtab275":
    case "xtabAggressiveness":
    case "xtab275Aggressiveness":
    case "xtab275AggressivenessHighLow":
      return "editWindowOnly";
    case "xtabUnifiedModel":
      return "unifiedXml";
    case "xtab275EditIntent":
      return "editWindowWithEditIntent";
    case "xtab275EditIntentShort":
      return "editWindowWithEditIntentShort";
  }
}

function reportDivergence(
  state: ResponseStreamState,
  options: NesStreamingResponseOptions,
  reason: string,
): void {
  state.diverged = true;
  if (!state.divergenceReported) {
    state.divergenceReported = true;
    options.onEarlyDivergence?.(reason);
  }
}

function canContinue(
  state: ResponseStreamState,
  options: NesStreamingResponseOptions,
): boolean {
  const reason = options.getEarlyTerminationReason?.();
  if (reason === undefined) {
    return true;
  }
  reportDivergence(state, options, reason);
  return false;
}

async function* splitStreamLines(
  chunks: AsyncIterable<string>,
  state: ResponseStreamState,
  options: NesStreamingResponseOptions,
): AsyncGenerator<string, void, void> {
  let pending: string | null = null;
  for await (const chunk of chunks) {
    if (!canContinue(state, options)) {
      return;
    }
    state.rawText += chunk;
    pending ??= "";
    pending += chunk;
    const parts: string[] = pending.split(/\r?\n/);
    pending = parts.pop() ?? "";
    for (const line of parts) {
      if (!canContinue(state, options)) {
        return;
      }
      yield line;
    }
  }
  if (pending !== null && canContinue(state, options)) {
    yield pending;
  }
}

async function* remainingLines(
  iterator: AsyncIterator<string>,
): AsyncGenerator<string, void, void> {
  let next = await iterator.next();
  while (!next.done) {
    yield next.value;
    next = await iterator.next();
  }
}

async function* linesUntilTag(
  iterator: AsyncIterator<string>,
  endTag: string,
): AsyncGenerator<string, void, void> {
  let next = await iterator.next();
  while (!next.done) {
    if (next.value.includes(endTag)) {
      return;
    }
    yield next.value;
    next = await iterator.next();
  }
}

async function* linesWithBackticksRemoved(
  lines: AsyncIterable<string>,
): AsyncGenerator<string, void, void> {
  let lineNumber = -1;
  let bufferedFence: string | undefined;
  for await (const line of lines) {
    lineNumber += 1;
    if (bufferedFence !== undefined) {
      yield bufferedFence;
      bufferedFence = undefined;
    }
    if (/^```[a-z]*$/.test(line)) {
      if (lineNumber !== 0) {
        bufferedFence = line;
      }
    } else {
      yield line;
    }
  }
}

async function* linesWithCompatibilityCheck(
  lines: AsyncIterable<string>,
  state: ResponseStreamState,
  options: NesStreamingResponseOptions,
): AsyncGenerator<string, void, void> {
  let lineIndex = 0;
  for await (const line of lines) {
    if (options.checkModelLine?.(lineIndex, line) === false) {
      reportDivergence(
        state,
        options,
        `model line ${lineIndex} diverged from intermediate user input`,
      );
      return;
    }
    yield line;
    lineIndex += 1;
  }
}

function isSignificant(line: string): boolean {
  return /[a-zA-Z1-9]+/.test(line);
}

function convergenceFor(
  originalLines: readonly string[],
  lineToIndexes: ReadonlyMap<string, readonly number[]>,
  state: DivergenceState,
  editWindowIdx: number,
): { readonly hunk: DiffHunk; readonly convergenceEndIdx: number } | undefined {
  let newLinesIdx = state.newLines.length - 1;
  let candidates = (lineToIndexes.get(state.newLines[newLinesIdx]) ?? []).map(
    (index): [number, number] => [index, index],
  );
  if (candidates.length === 0 || state.newLines.length < 2) {
    return undefined;
  }

  let nonSignificantMatches = 1;
  let significantMatches = isSignificant(state.newLines[newLinesIdx]) ? 1 : 0;
  newLinesIdx -= 1;
  let found = false;
  let match: [number, number] = candidates[0];
  if (match[0] - state.startLineIdx === state.newLines.length - 1) {
    found = true;
  }

  for (; newLinesIdx >= 0; newLinesIdx -= 1) {
    candidates = candidates
      .map(([endIndex, currentIndex]): [number, number] => [
        endIndex,
        currentIndex - 1,
      ])
      .filter(([, currentIndex]) => currentIndex >= editWindowIdx)
      .filter(
        ([, currentIndex]) =>
          originalLines[currentIndex] === state.newLines[newLinesIdx],
      );
    if (candidates.length === 0) {
      break;
    }
    nonSignificantMatches += 1;
    if (isSignificant(state.newLines[newLinesIdx])) {
      significantMatches += 1;
    }
    if (significantMatches === 2) {
      found = true;
      match = candidates[0];
    }
    if (nonSignificantMatches === 3) {
      found = true;
      match = candidates[0];
      break;
    }
  }
  if (!found) {
    return undefined;
  }

  const convergenceStartIdx = match[1];
  const convergenceEndIdx = match[0];
  const convergenceLineCount = convergenceEndIdx - convergenceStartIdx + 1;
  const inserted = state.newLines.slice(
    0,
    state.newLines.length - convergenceLineCount,
  );
  const removedLineCount = convergenceStartIdx - state.startLineIdx;
  if (removedLineCount - inserted.length > 1 && inserted.length > 0) {
    return undefined;
  }
  return {
    hunk: {
      oldStart: state.startLineIdx,
      oldEndExclusive: convergenceStartIdx,
      newLines: inserted,
    },
    convergenceEndIdx: convergenceEndIdx + 1,
  };
}

async function* streamDiffHunks(
  originalLines: readonly string[],
  modifiedLines: AsyncIterable<string>,
): AsyncGenerator<DiffHunk, void, void> {
  const lineToIndexes = new Map<string, number[]>();
  for (const [index, line] of originalLines.entries()) {
    const indexes = lineToIndexes.get(line) ?? [];
    indexes.push(index);
    lineToIndexes.set(line, indexes);
  }

  let editWindowIdx = 0;
  let state: DivergenceState | undefined;
  for await (const line of modifiedLines) {
    if (editWindowIdx >= originalLines.length) {
      if (state) {
        state.newLines.push(line);
      } else {
        state = { startLineIdx: editWindowIdx, newLines: [line] };
      }
      continue;
    }
    if (!state) {
      if (originalLines[editWindowIdx] === line) {
        editWindowIdx += 1;
        continue;
      }
      state = { startLineIdx: editWindowIdx, newLines: [] };
    }
    state.newLines.push(line);
    const convergence = convergenceFor(
      originalLines,
      lineToIndexes,
      state,
      editWindowIdx,
    );
    if (convergence) {
      yield convergence.hunk;
      editWindowIdx = convergence.convergenceEndIdx;
      state = undefined;
    }
  }
  if (state) {
    yield {
      oldStart: state.startLineIdx,
      oldEndExclusive: originalLines.length,
      newLines: state.newLines,
    };
  } else if (editWindowIdx < originalLines.length) {
    yield {
      oldStart: editWindowIdx,
      oldEndExclusive: originalLines.length,
      newLines: [],
    };
  }
}

function lineStartOffsets(lines: readonly string[], eol: string): number[] {
  const starts: number[] = [];
  let offset = 0;
  for (let index = 0; index < lines.length; index += 1) {
    starts.push(offset);
    offset += lines[index].length;
    if (index < lines.length - 1) {
      offset += eol.length;
    }
  }
  starts.push(offset);
  return starts;
}

function trimCommonText(
  original: string,
  replacement: string,
): { readonly prefix: number; readonly suffix: number; readonly text: string } {
  let prefix = 0;
  const maxPrefix = Math.min(original.length, replacement.length);
  while (prefix < maxPrefix && original[prefix] === replacement[prefix]) {
    prefix += 1;
  }
  let suffix = 0;
  while (
    suffix < original.length - prefix &&
    suffix < replacement.length - prefix &&
    original[original.length - suffix - 1] ===
      replacement[replacement.length - suffix - 1]
  ) {
    suffix += 1;
  }
  return {
    prefix,
    suffix,
    text: replacement.slice(prefix, replacement.length - suffix),
  };
}

function editForHunk(
  prompt: NesPromptBuildResult,
  uri: string,
  hunk: DiffHunk,
): NesTextEdit | undefined {
  const window = prompt.editWindow;
  const starts = lineStartOffsets(window.lines, window.eol);
  let relativeStart = starts[hunk.oldStart];
  let relativeEnd = starts[hunk.oldEndExclusive];
  const newLines = hunk.newLines.map((line) =>
    line.split(PromptTags.CURSOR).join(""),
  );
  let replacement = newLines.join(window.eol);
  if (hunk.oldEndExclusive < window.lines.length && newLines.length > 0) {
    replacement += window.eol;
  } else if (
    hunk.oldStart === window.lines.length &&
    newLines.length > 0 &&
    window.lines.length > 0
  ) {
    replacement = `${window.eol}${replacement}`;
  }
  const original = window.text.slice(relativeStart, relativeEnd);
  const trimmed = trimCommonText(original, replacement);
  relativeStart += trimmed.prefix;
  relativeEnd -= trimmed.suffix;
  if (relativeStart === relativeEnd && trimmed.text.length === 0) {
    return undefined;
  }
  const startOffset = window.startOffset + relativeStart;
  const endOffset = window.startOffset + relativeEnd;
  return {
    uri,
    startOffset,
    endOffset,
    newText: trimmed.text,
    kind: startOffset === endOffset ? "insert" : "replace",
  };
}

function isImportLine(line: string): boolean {
  return /^(?:\s*)(?:import\b|export\s+.+\s+from\b|const\s+.+?=\s*require\b|require\s*\(|using\b|#include\b|use\b|package\b)/.test(
    line,
  );
}

function simpleInsertion(
  before: string,
  after: string,
): { readonly startOffset: number; readonly endOffset: number } | undefined {
  let prefix = 0;
  const maxPrefix = Math.min(before.length, after.length);
  while (prefix < maxPrefix && before[prefix] === after[prefix]) {
    prefix += 1;
  }
  let suffix = 0;
  while (
    suffix < before.length - prefix &&
    suffix < after.length - prefix &&
    before[before.length - suffix - 1] === after[after.length - suffix - 1]
  ) {
    suffix += 1;
  }
  const removed = before.slice(prefix, before.length - suffix);
  const inserted = after.slice(prefix, after.length - suffix);
  return removed.length === 0 && inserted.length > 0
    ? { startOffset: prefix, endOffset: prefix + inserted.length }
    : undefined;
}

function isUndoOfRecentInsertion(
  edit: NesTextEdit,
  current: NesDocumentContext,
  history: readonly NesHistoryContext[],
  mode: "v1" | "v2",
): boolean {
  if (
    edit.uri !== current.uri ||
    edit.newText.length !== 0 ||
    edit.startOffset === edit.endOffset
  ) {
    return false;
  }
  let documentText = current.text;
  for (const entry of history) {
    if (entry.uri !== current.uri || entry.after !== documentText) {
      continue;
    }
    const inserted = simpleInsertion(entry.before, entry.after);
    if (
      inserted &&
      (mode === "v1"
        ? edit.startOffset < inserted.endOffset &&
          edit.endOffset > inserted.startOffset
        : edit.startOffset === inserted.startOffset &&
          edit.endOffset === inserted.endOffset)
    ) {
      return true;
    }
    documentText = entry.before;
  }
  return false;
}

function isWhitespaceOnlyChange(
  original: string,
  replacement: string,
): boolean {
  const originalLines = original.split(/\r?\n/);
  const newLines = replacement.split(/\r?\n/);
  if (
    (replacement.length === 0 && originalLines.every((line) => !line.trim())) ||
    (replacement.length > 0 && newLines.every((line) => !line.trim()))
  ) {
    return true;
  }
  if (
    originalLines.length === newLines.length &&
    originalLines.every((line, index) => line.trim() === newLines[index].trim())
  ) {
    return true;
  }
  return original.replace(/\s/g, "") === replacement.replace(/\s/g, "");
}

function documentForEdit(
  edit: NesTextEdit,
  current: NesDocumentContext,
  related: readonly NesDocumentContext[],
): NesDocumentContext | undefined {
  return edit.uri === current.uri
    ? current
    : related.find((document) => document.uri === edit.uri);
}

export function filterOfficialNesEdits(
  edits: readonly NesTextEdit[],
  current: NesDocumentContext,
  history: readonly NesHistoryContext[],
  options: NesEditFilterOptions,
): readonly NesTextEdit[] {
  const related = options.relatedDocuments ?? [];
  return edits.filter((edit) => {
    const target = documentForEdit(edit, current, related);
    if (
      !target ||
      edit.startOffset < 0 ||
      edit.endOffset < edit.startOffset ||
      edit.endOffset > target.text.length
    ) {
      return false;
    }
    const original = target.text.slice(edit.startOffset, edit.endOffset);
    if (original === edit.newText) {
      return false;
    }
    if (
      edit.newText.length > 0 &&
      target.text.slice(edit.endOffset).startsWith(edit.newText)
    ) {
      return false;
    }
    if (
      !options.allowWhitespaceOnlyChanges &&
      isWhitespaceOnlyChange(original, edit.newText)
    ) {
      return false;
    }
    if (
      !options.allowImportChanges &&
      [...original.split(/\r?\n/), ...edit.newText.split(/\r?\n/)].some(
        isImportLine,
      )
    ) {
      return false;
    }
    if (
      options.filterNotebookCellMarkers !== false &&
      edit.newText.includes("%% vscode.cell [id=")
    ) {
      return false;
    }
    if (
      options.substrings.some(
        (substring) => substring.length > 0 && edit.newText.includes(substring),
      )
    ) {
      return false;
    }
    return (
      options.undoInsertionFiltering === false ||
      !isUndoOfRecentInsertion(
        edit,
        current,
        history,
        options.undoInsertionFiltering,
      )
    );
  });
}

export async function* streamOfficialNesResponse(
  chunks: AsyncIterable<string>,
  strategy: NesPromptStrategy,
  prompt: NesPromptBuildResult,
  current: NesDocumentContext,
  related: readonly NesDocumentContext[],
  options: NesStreamingResponseOptions = {},
): AsyncGenerator<NesTextEdit, NesParsedResponse, void> {
  const state: ResponseStreamState = {
    rawText: "",
    diverged: false,
    divergenceReported: false,
  };
  const emitted: NesTextEdit[] = [];
  let filteredOut = false;
  const filters: NesEditFilterOptions = {
    ...DEFAULT_FILTER_OPTIONS,
    ...options.filters,
    relatedDocuments: options.filters?.relatedDocuments ?? related,
  };
  const history = options.history ?? [];
  const format = responseFormat(strategy, options.responseFormat);
  let parseResultReported = false;
  let parseResultKind: NesResponseParseResultKind | undefined;
  let firstEditWindowCandidateHandled = false;
  const reportParseResult = (kind: NesResponseParseResultKind): void => {
    if (parseResultReported) return;
    parseResultReported = true;
    parseResultKind = kind;
    options.onParseResultKind?.(kind);
  };
  const lines = splitStreamLines(chunks, state, options);
  let iterator: AsyncIterator<string> = lines[Symbol.asyncIterator]();
  let editIntentMetadata:
    | {
        readonly editIntent: NonNullable<NesParsedResponse["editIntent"]>;
        readonly editIntentParseError?: string;
      }
    | undefined;

  if (
    format === "editWindowWithEditIntent" ||
    format === "editWindowWithEditIntentShort"
  ) {
    reportParseResult("editWindowLines");
    const parsed = await parseNesEditIntent(
      remainingLines(iterator),
      format === "editWindowWithEditIntentShort" ? "shortName" : "tags",
    );
    editIntentMetadata = {
      editIntent: parsed.editIntent,
      ...(parsed.parseError ? { editIntentParseError: parsed.parseError } : {}),
    };
    iterator = parsed.remainingLines[Symbol.asyncIterator]();
    if (
      !shouldShowNesEditIntent(
        parsed.editIntent,
        options.aggressivenessLevel ?? prompt.aggressivenessLevel,
      )
    ) {
      return {
        edits: [],
        rawText: state.rawText,
        noChange: true,
        filteredOut: true,
        editIntentFilteredOut: true,
        format,
        ...editIntentMetadata,
      };
    }
  }

  const emit = async function* (
    candidates: AsyncIterable<DiffHunk> | readonly DiffHunk[],
  ): AsyncGenerator<NesTextEdit, void, void> {
    for await (const hunk of candidates) {
      if (!canContinue(state, options)) {
        return;
      }
      const edit = editForHunk(prompt, current.uri, hunk);
      if (!edit) {
        continue;
      }
      if (
        !firstEditWindowCandidateHandled &&
        parseResultKind === "editWindowLines" &&
        options.beforeFirstEditWindowCandidate
      ) {
        firstEditWindowCandidateHandled = true;
        if (!(await options.beforeFirstEditWindowCandidate())) {
          return;
        }
      }
      const filtered = filterOfficialNesEdits(
        [edit],
        current,
        history,
        filters,
      );
      if (filtered.length === 0) {
        filteredOut = true;
        continue;
      }
      emitted.push(filtered[0]);
      yield filtered[0];
    }
  };

  if (format === "unifiedXml") {
    const first = await iterator.next();
    if (first.done) {
      reportParseResult("done");
      return { edits: [], rawText: state.rawText, noChange: true, format };
    }
    const tag = first.value.trim();
    if (tag === ResponseTags.NO_CHANGE.start) {
      reportParseResult("done");
      return { edits: [], rawText: state.rawText, noChange: true, format };
    }
    if (tag === ResponseTags.INSERT.start) {
      reportParseResult("directEdits");
      const continuation = await iterator.next();
      if (
        continuation.done ||
        continuation.value.includes(ResponseTags.INSERT.end)
      ) {
        return { edits: [], rawText: state.rawText, noChange: true, format };
      }
      const localCursorLine = Math.max(
        0,
        Math.min(
          prompt.editWindow.lines.length - 1,
          prompt.editWindow.cursorLineOffset - prompt.editWindow.startLine,
        ),
      );
      const cursorLine = prompt.editWindow.lines[localCursorLine] ?? "";
      const continuedLine = continuation.value
        .split(PromptTags.CURSOR)
        .join("");
      yield* emit([
        {
          oldStart: localCursorLine,
          oldEndExclusive: localCursorLine + 1,
          newLines: [
            `${cursorLine.slice(0, prompt.editWindow.cursorColumn)}${continuedLine}${cursorLine.slice(prompt.editWindow.cursorColumn)}`,
          ],
        },
      ]);
      const following: string[] = [];
      let next = await iterator.next();
      while (!next.done && !next.value.includes(ResponseTags.INSERT.end)) {
        following.push(next.value);
        next = await iterator.next();
      }
      if (following.length > 0) {
        yield* emit([
          {
            oldStart: localCursorLine + 1,
            oldEndExclusive: localCursorLine + 1,
            newLines: following,
          },
        ]);
      }
      return {
        edits: emitted,
        rawText: state.rawText,
        noChange: emitted.length === 0,
        ...(filteredOut ? { filteredOut: true } : {}),
        format,
      };
    }
    if (tag === ResponseTags.EDIT.start) {
      reportParseResult("editWindowLines");
      yield* emit(
        streamDiffHunks(
          prompt.editWindow.lines,
          linesWithCompatibilityCheck(
            linesUntilTag(iterator, ResponseTags.EDIT.end),
            state,
            options,
          ),
        ),
      );
      return {
        edits: emitted,
        rawText: state.rawText,
        noChange: emitted.length === 0,
        ...(filteredOut ? { filteredOut: true } : {}),
        format,
      };
    }
    reportDivergence(
      state,
      options,
      `unexpected unified response tag: ${tag || "<empty>"}`,
    );
    reportParseResult("done");
    return { edits: [], rawText: state.rawText, noChange: true, format };
  }

  reportParseResult("editWindowLines");
  const responseLines = remainingLines(iterator);
  const cleanedLines =
    format === "codeBlock"
      ? linesWithBackticksRemoved(responseLines)
      : responseLines;
  yield* emit(
    streamDiffHunks(
      prompt.editWindow.lines,
      linesWithCompatibilityCheck(cleanedLines, state, options),
    ),
  );
  return {
    edits: emitted,
    rawText: state.rawText,
    noChange: emitted.length === 0,
    ...(filteredOut ? { filteredOut: true } : {}),
    format,
    ...editIntentMetadata,
  };
}

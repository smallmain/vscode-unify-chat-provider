import { realpath as nodeRealpath } from 'node:fs/promises';
import * as nodePath from 'node:path';
import * as vscode from 'vscode';
import type {
  EditAlgorithmDiagnostic,
  EditHistoryEntry,
  Zeta3InternalCompletionRequest,
  ZetaCompletionRequest,
} from '../model/requests';
import type { BufferedCompletionResponse } from '../model/responses';
import { CompletionRuntimeError } from '../model/errors';
import {
  computeDocumentLegacyRanges,
  utf16SyntaxRangeToByteRange,
} from '../edit/ranges';
import { transformEditRangeThroughChange } from '../edit/lifecycle';
import {
  utf16OffsetToUtf8ByteOffset,
  utf16OffsetToUtf8Point,
  utf8ByteOffsetToUtf16Offset,
} from '../edit/utf8';
import { parseSingleFileUnifiedDiff } from '../template/unified-diff';
import {
  rejectZedPrediction,
  setZedPredictionSampleData,
  trackZedPrediction,
} from '../zed/feedback';
import type {
  ZedActiveBufferDiagnostic,
  ZedBufferChangeEvent,
  ZedRelatedFile,
  ZedSettledEditPredictionSampleData,
} from '../../client/zed/types';
import { getZedCompletionSessionPort } from '../zed/session-port';
import {
  evaluateZedDataCollection,
  NO_ZED_DATA_COLLECTION,
  type ZedDataCollectionDecision,
} from '../zed/privacy';
import { runNativeCompletionOperation } from './http';
import type { CompletionRequestLogger } from './logging';
import { runWithCompletionConcurrency } from './concurrency';
import type {
  CompletionApiCapabilities,
  CompletionApiOperation,
  NativeCompletionApiContext,
} from './provider';
import { defineNativeCompletionApiProvider } from './provider';

function lineCount(text: string): number {
  return text.split('\n').length;
}

function fallbackDiff(entry: EditHistoryEntry): string {
  const oldLines = entry.oldText.split('\n');
  const newLines = entry.newText.split('\n');
  return [
    `@@ -1,${oldLines.length} +1,${newLines.length} @@`,
    ...oldLines.map((line) => `-${line}`),
    ...newLines.map((line) => `+${line}`),
    '',
  ].join('\n');
}

function eventDiff(
  entry: EditHistoryEntry,
  fallbackPath: string,
  isInOpenSourceRepo: boolean,
): ZedBufferChangeEvent {
  const path = entry.path ?? fallbackPath;
  const oldRange = entry.oldRange ?? {
    startOffset: 0,
    endOffset: entry.oldText.length,
  };
  const newRange = entry.newRange ?? {
    startOffset: 0,
    endOffset: entry.newText.length,
  };
  return {
    event: 'BufferChange',
    path,
    old_path: path,
    diff: entry.diff ?? fallbackDiff(entry),
    old_range: {
      start: utf16OffsetToUtf8ByteOffset(entry.oldText, oldRange.startOffset),
      end: utf16OffsetToUtf8ByteOffset(entry.oldText, oldRange.endOffset),
    },
    new_range: {
      start: utf16OffsetToUtf8ByteOffset(entry.newText, newRange.startOffset),
      end: utf16OffsetToUtf8ByteOffset(entry.newText, newRange.endOffset),
    },
    predicted: entry.predicted === true,
    in_open_source_repo: isInOpenSourceRepo,
  };
}

function relatedFile(
  path: string,
  text: string,
  contextSource: 'current_file' | 'edit_history' | 'lsp',
  isInOpenSourceRepo: boolean,
  order = 0,
  rowStart = 0,
  rowEnd = Math.max(0, lineCount(text) - 1),
  maxRow = Math.max(0, lineCount(text) - 1),
): ZedRelatedFile {
  return {
    path,
    max_row: maxRow,
    excerpts: [
      {
        row_range: { start: rowStart, end: rowEnd },
        text,
        order,
        context_source: contextSource,
      },
    ],
    in_open_source_repo: isInOpenSourceRepo,
  };
}

function diagnostics(
  values: readonly EditAlgorithmDiagnostic[],
): ZedActiveBufferDiagnostic[] {
  return values.slice(0, 20).map((diagnostic) => {
    const snippet = clampZedText(diagnostic.snippet, 512);
    const snippetBytes = Buffer.byteLength(snippet);
    return {
      severity:
        diagnostic.severity === 0
          ? 1
          : diagnostic.severity === 1
            ? 2
            : diagnostic.severity === 2
              ? 3
              : diagnostic.severity === 3
                ? 4
                : null,
      message: clampZedText(diagnostic.message, 512),
      snippet,
      snippet_buffer_row_range: {
        start: diagnostic.diagnosticStartRow ?? diagnostic.snippetStartRow,
        end: diagnostic.diagnosticEndRow ?? diagnostic.snippetEndRow,
      },
      diagnostic_range_in_snippet: {
        start: Math.min(diagnostic.diagnosticStartByte, snippetBytes),
        end: Math.min(diagnostic.diagnosticEndByte, snippetBytes),
      },
    };
  });
}

function clampZedText(text: string, maxTokens: number): string {
  const maxBytes = maxTokens * 3;
  if (Buffer.byteLength(text) <= maxBytes) return text;
  let bytes = 0;
  let result = '';
  for (const line of text.match(/.*(?:\n|$)/g) ?? []) {
    if (!line) continue;
    const lineBytes = Buffer.byteLength(line);
    if (bytes + lineBytes > maxBytes) break;
    result += line;
    bytes += lineBytes;
  }
  return result;
}

function excerptRanges(
  ranges: ReturnType<typeof computeDocumentLegacyRanges>['ranges'],
): object {
  return {
    editable_150: ranges.editable150,
    editable_180: ranges.editable180,
    editable_350: ranges.editable350,
    editable_512: ranges.editable512,
    editable_150_context_350: ranges.editable150Context350,
    editable_180_context_350: ranges.editable180Context350,
    editable_350_context_150: ranges.editable350Context150,
    editable_350_context_512: ranges.editable350Context512,
    editable_350_context_1024: ranges.editable350Context1024,
    context_4096: ranges.context4096,
    context_8192: ranges.context8192,
  };
}

export function buildZedV3RequestBody(
  request: CompletionRequestZeta21,
  collection: ZedDataCollectionDecision = NO_ZED_DATA_COLLECTION,
): Record<string, unknown> {
  const path = request.document.path ?? 'untitled';
  const selected = computeDocumentLegacyRanges(request.document);
  return {
    cursor_path: path,
    cursor_excerpt: selected.excerpt.text,
    cursor_offset_in_excerpt: selected.excerpt.cursorByteOffset,
    excerpt_start_row: selected.excerpt.startRow,
    events: request.editHistory
      .slice(-10)
      .map((entry) => eventDiff(entry, path, collection.isInOpenSourceRepo)),
    related_files: request.contexts.map((context) =>
      relatedFile(
        context.path ?? 'context',
        context.content,
        'lsp',
        collection.isInOpenSourceRepo,
      ),
    ),
    active_buffer_diagnostics: diagnostics(request.diagnostics),
    excerpt_ranges: excerptRanges(selected.ranges),
    syntax_ranges: selected.syntaxRanges,
    in_open_source_repo: collection.isInOpenSourceRepo,
    can_collect_data: collection.canCollectData,
    ...(collection.repoUrl === undefined ? {} : { repo_url: collection.repoUrl }),
  };
}

type CompletionRequestZeta21 = ZetaCompletionRequest & {
  readonly kind: 'zeta2.1';
};

function lineStartOffsets(text: string): readonly number[] {
  const starts = [0];
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 10) starts.push(index + 1);
  }
  return starts;
}

function rowAtOffset(starts: readonly number[], offset: number): number {
  let row = 0;
  while ((starts[row + 1] ?? Number.POSITIVE_INFINITY) <= offset) row += 1;
  return row;
}

const CONTEXT_BOUNDARY_SNAP_LINES = 5;

function lineText(
  text: string,
  starts: readonly number[],
  row: number,
): string {
  const start = starts[row] ?? text.length;
  const next = starts[row + 1];
  return text.slice(start, next === undefined ? text.length : next - 1);
}

function isGoodBlockStart(line: string): boolean {
  const trimmed = line.trim();
  if (
    !trimmed ||
    trimmed.startsWith('}') ||
    trimmed.startsWith(']') ||
    trimmed.startsWith(')')
  ) {
    return false;
  }
  return !['break', 'continue', 'return', 'throw', 'end'].includes(
    trimmed.replace(/;$/, ''),
  );
}

function snapStartRow(
  text: string,
  starts: readonly number[],
  row: number,
  coreRow: number,
): number {
  const maxRow = starts.length - 1;
  const limit = Math.min(coreRow, row + CONTEXT_BOUNDARY_SNAP_LINES, maxRow);
  let firstGood: number | undefined;
  for (let candidate = row; candidate <= limit; candidate += 1) {
    const line = lineText(text, starts, candidate);
    if (!isGoodBlockStart(line)) continue;
    if (
      candidate > 0 &&
      lineText(text, starts, candidate - 1).trim().length === 0
    ) {
      return candidate;
    }
    firstGood ??= candidate;
  }
  return firstGood ?? row;
}

function snapEndRow(
  text: string,
  starts: readonly number[],
  row: number,
  coreRow: number,
): number {
  const maxRow = starts.length - 1;
  const bounded = Math.min(row, maxRow);
  if (bounded === maxRow) return bounded;
  const limit = Math.max(coreRow, bounded - CONTEXT_BOUNDARY_SNAP_LINES);
  for (let candidate = bounded; candidate >= limit; candidate -= 1) {
    if (lineText(text, starts, candidate).trim().length === 0) continue;
    if (lineText(text, starts, candidate + 1).trim().length === 0) {
      return candidate;
    }
  }
  return bounded;
}

interface EditableContextExcerpt {
  readonly row_range: { readonly start: number; readonly end: number };
  readonly text: string;
  readonly order: number;
  readonly context_source: 'current_file' | 'edit_history';
}

function historyExcerpt(
  text: string,
  range: NonNullable<EditHistoryEntry['newRange']>,
  order: number,
): EditableContextExcerpt {
  const starts = lineStartOffsets(text);
  const maxRow = starts.length - 1;
  const coreStart = rowAtOffset(starts, range.startOffset);
  const coreEnd = rowAtOffset(starts, range.endOffset);
  const startRow = snapStartRow(
    text,
    starts,
    Math.max(0, coreStart - 20),
    coreStart,
  );
  const endRow = snapEndRow(
    text,
    starts,
    Math.min(maxRow, coreEnd + 20),
    coreEnd,
  );
  const textStart = starts[startRow] ?? 0;
  const nextStart = starts[endRow + 1];
  const textEnd = nextStart === undefined ? text.length : nextStart - 1;
  return {
    row_range: { start: startRow, end: endRow },
    text: text.slice(textStart, textEnd),
    order,
    context_source: 'edit_history',
  };
}

function excerptTextForRowRange(
  text: string,
  startRow: number,
  endRow: number,
): string {
  const starts = lineStartOffsets(text);
  const textStart = starts[startRow] ?? text.length;
  const textEnd = starts[endRow] ?? text.length;
  return text.slice(textStart, textEnd);
}

function splitHistoryExcerpts(
  text: string,
  excerpts: readonly EditableContextExcerpt[],
): readonly EditableContextExcerpt[] {
  if (excerpts.length < 2) return excerpts;
  const sorted = [...excerpts].sort(
    (left, right) =>
      left.row_range.start - right.row_range.start ||
      left.row_range.end - right.row_range.end,
  );
  const result: EditableContextExcerpt[] = [];
  let cluster: EditableContextExcerpt[] = [];
  let clusterEnd = -1;

  const flush = (): void => {
    if (cluster.length === 0) return;
    if (cluster.length === 1) {
      result.push(cluster[0]!);
      cluster = [];
      clusterEnd = -1;
      return;
    }
    const boundaries = [
      ...new Set(
        cluster.flatMap((excerpt) => [
          excerpt.row_range.start,
          excerpt.row_range.end + 1,
        ]),
      ),
    ].sort((left, right) => left - right);
    for (let index = 0; index < boundaries.length - 1; index += 1) {
      const start = boundaries[index]!;
      const endExclusive = boundaries[index + 1]!;
      const covering = cluster
        .filter(
          (excerpt) =>
            excerpt.row_range.start <= start &&
            excerpt.row_range.end + 1 >= endExclusive,
        )
        .sort((left, right) => left.order - right.order);
      const selected = covering[0];
      if (!selected) {
        const previous = result.at(-1);
        if (previous && previous.row_range.end === start) {
          result[result.length - 1] = {
            ...previous,
            row_range: {
              start: previous.row_range.start,
              end: endExclusive,
            },
            text: excerptTextForRowRange(
              text,
              previous.row_range.start,
              endExclusive,
            ),
          };
        }
        continue;
      }
      const previous = result.at(-1);
      if (
        previous &&
        previous.order === selected.order &&
        previous.row_range.end === start
      ) {
        result[result.length - 1] = {
          ...previous,
          row_range: {
            start: previous.row_range.start,
            end: endExclusive,
          },
          text: excerptTextForRowRange(
            text,
            previous.row_range.start,
            endExclusive,
          ),
        };
      } else {
        result.push({
          ...selected,
          row_range: { start, end: endExclusive },
          text: excerptTextForRowRange(text, start, endExclusive),
        });
      }
    }
    cluster = [];
    clusterEnd = -1;
  };

  for (const excerpt of sorted) {
    if (cluster.length === 0 || excerpt.row_range.start <= clusterEnd + 3) {
      cluster.push(excerpt);
      clusterEnd = Math.max(clusterEnd, excerpt.row_range.end);
    } else {
      flush();
      cluster.push(excerpt);
      clusterEnd = excerpt.row_range.end;
    }
  }
  flush();
  return result;
}

function snapshotChange(
  before: string,
  after: string,
): {
  readonly oldStart: number;
  readonly oldEnd: number;
  readonly newLength: number;
} | undefined {
  if (before === after) return undefined;
  let prefix = 0;
  const shared = Math.min(before.length, after.length);
  while (
    prefix < shared &&
    before.charCodeAt(prefix) === after.charCodeAt(prefix)
  ) {
    prefix += 1;
  }
  let suffix = 0;
  while (
    suffix < before.length - prefix &&
    suffix < after.length - prefix &&
    before.charCodeAt(before.length - suffix - 1) ===
      after.charCodeAt(after.length - suffix - 1)
  ) {
    suffix += 1;
  }
  return {
    oldStart: prefix,
    oldEnd: before.length - suffix,
    newLength: after.length - prefix - suffix,
  };
}

function relocateHistoryRange(
  before: string,
  after: string,
  range: { readonly startOffset: number; readonly endOffset: number },
): { readonly startOffset: number; readonly endOffset: number } {
  const boundedStart = Math.max(0, Math.min(before.length, range.startOffset));
  const boundedEnd = Math.max(
    boundedStart,
    Math.min(before.length, range.endOffset),
  );
  const selected = before.slice(boundedStart, boundedEnd);
  if (selected) {
    const found = after.indexOf(selected);
    if (found >= 0 && after.indexOf(selected, found + 1) < 0) {
      return { startOffset: found, endOffset: found + selected.length };
    }
  }
  const change = snapshotChange(before, after);
  if (!change) return { startOffset: boundedStart, endOffset: boundedEnd };
  const transformed = transformEditRangeThroughChange(
    boundedStart,
    boundedEnd,
    change.oldStart,
    change.oldEnd,
    change.newLength,
  );
  return {
    startOffset: Math.max(0, Math.min(after.length, transformed.start)),
    endOffset: Math.max(0, Math.min(after.length, transformed.end)),
  };
}

function rangeInLatestSnapshot(
  entries: readonly EditHistoryEntry[],
  index: number,
): {
  readonly snapshot: string;
  readonly range: { readonly startOffset: number; readonly endOffset: number };
} {
  const entry = entries[index]!;
  let snapshot = entry.newText;
  let range = entry.newRange ?? {
    startOffset: 0,
    endOffset: snapshot.length,
  };
  for (let nextIndex = index + 1; nextIndex < entries.length; nextIndex += 1) {
    const next = entries[nextIndex]!;
    range = relocateHistoryRange(snapshot, next.newText, range);
    snapshot = next.newText;
  }
  return { snapshot, range };
}

function editableContext(
  request: Zeta3InternalCompletionRequest,
  isInOpenSourceRepo: boolean,
): ZedRelatedFile[] {
  return editableContextFor(
    request.document,
    request.editHistory,
    isInOpenSourceRepo,
  );
}

function editableContextFor(
  document: Zeta3InternalCompletionRequest['document'],
  editHistory: readonly EditHistoryEntry[],
  isInOpenSourceRepo: boolean,
): ZedRelatedFile[] {
  const currentPath = document.path ?? 'untitled';
  const recentHistory = editHistory.slice(-10);
  const snapshots = new Map<string, string>([[currentPath, document.text]]);
  const entriesByPath = new Map<string, EditHistoryEntry[]>();
  for (const entry of recentHistory) {
    const entryPath = entry.path ?? currentPath;
    snapshots.set(entryPath, entry.newText);
    const entries = entriesByPath.get(entryPath) ?? [];
    entries.push(entry);
    entriesByPath.set(entryPath, entries);
  }
  snapshots.set(currentPath, document.text);

  const excerpts = new Map<string, EditableContextExcerpt[]>();
  const currentMaxRow = lineStartOffsets(document.text).length - 1;
  excerpts.set(currentPath, [
    {
      row_range: { start: 0, end: currentMaxRow },
      text: document.text,
      order: 0,
      context_source: 'current_file',
    },
  ]);
  recentHistory.forEach((entry, index) => {
    const entryPath = entry.path ?? currentPath;
    // CurrentFile has order 0 and covers the full active buffer, so Zed's
    // split_overlapping_ranges coalesces same-file history back into it.
    if (entryPath === currentPath) return;
    const pathEntries = entriesByPath.get(entryPath) ?? [entry];
    const pathIndex = pathEntries.indexOf(entry);
    const located = rangeInLatestSnapshot(
      pathEntries,
      pathIndex < 0 ? 0 : pathIndex,
    );
    const values = excerpts.get(entryPath) ?? [];
    values.push(historyExcerpt(located.snapshot, located.range, index + 1));
    excerpts.set(entryPath, values);
  });
  return [...excerpts].map(([path, fileExcerpts]) => {
    const snapshot = snapshots.get(path) ?? '';
    return {
      path,
      max_row: lineStartOffsets(snapshot).length - 1,
      excerpts:
        path === currentPath
          ? fileExcerpts
          : [...splitHistoryExcerpts(snapshot, fileExcerpts)],
      in_open_source_repo: isInOpenSourceRepo,
    };
  });
}

function settledSampleData(
  collection: ZedDataCollectionDecision,
  document: Zeta3InternalCompletionRequest['document'],
  editHistory: readonly EditHistoryEntry[],
  activeDiagnostics: readonly EditAlgorithmDiagnostic[],
  editablePath: string,
  editableSnapshot: string,
  editableStart: number,
  editableEnd: number,
  nextCursor?: {
    readonly snapshot: string;
    readonly offset: number;
  },
): ZedSettledEditPredictionSampleData {
  const bufferDiagnostics = diagnostics(activeDiagnostics);
  const context = editableContextFor(
    document,
    editHistory,
    collection.isInOpenSourceRepo,
  );
  return {
    repository_url: collection.repoUrl ?? null,
    revision: null,
    editable_path: editablePath,
    editable_offset_range: {
      start: utf16OffsetToUtf8ByteOffset(editableSnapshot, editableStart),
      end: utf16OffsetToUtf8ByteOffset(editableSnapshot, editableEnd),
    },
    ...(bufferDiagnostics.length === 0
      ? {}
      : { buffer_diagnostics: bufferDiagnostics }),
    ...(context.length === 0 ? {} : { editable_context: context }),
    edit_events_before_quiescence: 0,
    ...(nextCursor === undefined
      ? {}
      : {
          next_edit_cursor_offset: utf16OffsetToUtf8ByteOffset(
            nextCursor.snapshot,
            nextCursor.offset,
          ),
        }),
  };
}

function changedRange(
  before: string,
  after: string,
): { readonly start: number; readonly end: number } | undefined {
  if (before === after) return undefined;
  let start = 0;
  const shared = Math.min(before.length, after.length);
  while (start < shared && before.charCodeAt(start) === after.charCodeAt(start)) {
    start += 1;
  }
  let suffix = 0;
  while (
    suffix < before.length - start &&
    suffix < after.length - start &&
    before.charCodeAt(before.length - suffix - 1) ===
      after.charCodeAt(after.length - suffix - 1)
  ) {
    suffix += 1;
  }
  return { start, end: before.length - suffix };
}

export function buildZedV4RequestBody(
  request: Zeta3InternalCompletionRequest,
  collection: ZedDataCollectionDecision = NO_ZED_DATA_COLLECTION,
): Record<string, unknown> {
  const path = request.document.path ?? 'untitled';
  return {
    cursor_path: path,
    cursor_position: utf16OffsetToUtf8Point(
      request.document.text,
      request.document.cursorOffset,
    ),
    events: request.editHistory
      .slice(-10)
      .map((entry) => eventDiff(entry, path, collection.isInOpenSourceRepo)),
    editable_context: editableContext(
      request,
      collection.isInOpenSourceRepo,
    ),
    syntax_ranges: (request.document.fullSyntaxRanges ?? []).map((range) =>
      utf16SyntaxRangeToByteRange(request.document.text, range),
    ),
    active_buffer_diagnostics: diagnostics(request.diagnostics),
    in_open_source_repo: collection.isInOpenSourceRepo,
    can_collect_data: collection.canCollectData,
    ...(collection.repoUrl === undefined ? {} : { repo_url: collection.repoUrl }),
  };
}

function emptyResponse(): BufferedCompletionResponse {
  return { mode: 'buffered', choices: [] };
}

const backoffUntil = new Map<string, number>();

function inBackoff(key: string): boolean {
  return (backoffUntil.get(key) ?? 0) > Date.now();
}

function isHttp408(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  return Reflect.get(error, 'status') === 408;
}

async function executeV3(
  context: NativeCompletionApiContext,
  request: CompletionRequestZeta21,
  token: vscode.CancellationToken,
  logger: CompletionRequestLogger | undefined,
): Promise<BufferedCompletionResponse> {
  const startedAt = Date.now();
  let backoffKey: string | undefined;
  try {
    const port = getZedCompletionSessionPort();
    const policy = await port.getPolicySnapshot(context, token);
    backoffKey = policy.backoffKey;
    if (inBackoff(backoffKey)) return emptyResponse();
    const collection = await evaluateZedDataCollection(
      request,
      policy,
    );
    const body = buildZedV3RequestBody(request, collection);
    const result = await port.predictV3(
      context,
      body,
      {
        trigger: request.trigger,
        onRequestPrepared: (prepared) => logger?.providerRequest(prepared),
      },
      token,
    );
    const { response } = result;
    logger?.rawHttpResponseBody(JSON.stringify(response));
    trackZedPrediction({
      requestId: response.requestId,
      ...(response.modelVersion === undefined
        ? {}
        : { modelVersion: response.modelVersion }),
      startedAt,
      transport: result.feedback,
      canCollectData: collection.canCollectData,
      isInOpenSourceRepo: collection.isInOpenSourceRepo,
    });
    if (result.canceledAfterDispatch || token.isCancellationRequested) {
      rejectZedPrediction(response.requestId, 'canceled', false);
      return emptyResponse();
    }
    const selected = computeDocumentLegacyRanges(request.document);
    const editableStartInExcerpt = utf8ByteOffsetToUtf16Offset(
      selected.excerpt.text,
      response.editableRange.start,
    );
    const editableEndInExcerpt = utf8ByteOffsetToUtf16Offset(
      selected.excerpt.text,
      response.editableRange.end,
    );
    const cursorInOutput =
      response.cursorOffset === undefined
        ? undefined
        : utf8ByteOffsetToUtf16Offset(response.output, response.cursorOffset);
    if (
      editableStartInExcerpt === undefined ||
      editableEndInExcerpt === undefined ||
      (response.cursorOffset !== undefined && cursorInOutput === undefined)
    ) {
      rejectZedPrediction(response.requestId, 'interpolate_failed', false);
      throw new CompletionRuntimeError(
        'completion-invalid-response',
        'Zed v3 returned an invalid UTF-8 byte range.',
      );
    }
    const editableStart =
      selected.excerpt.utf16Range.start + editableStartInExcerpt;
    const editableEnd = selected.excerpt.utf16Range.start + editableEndInExcerpt;
    const text = response.output;
    const hasReplacement = text.length > 0 || editableEnd > editableStart;
    if (collection.canCollectData) {
      const predictedSnapshot = `${request.document.text.slice(0, editableStart)}${text}${request.document.text.slice(editableEnd)}`;
      setZedPredictionSampleData(
        response.requestId,
        settledSampleData(
          collection,
          request.document,
          request.editHistory,
          request.diagnostics,
          request.document.path ?? 'untitled',
          request.document.text,
          editableStart,
          editableEnd,
          cursorInOutput === undefined
            ? undefined
            : {
                snapshot: predictedSnapshot,
                offset: editableStart + cursorInOutput,
              },
        ),
      );
    }
    if (!hasReplacement) {
      rejectZedPrediction(response.requestId, 'empty', false);
    }
    return {
      mode: 'buffered',
      choices: hasReplacement ? [{ text }] : [],
      edit: {
        requestId: response.requestId,
        ...(response.modelVersion === undefined
          ? {}
          : { modelVersion: response.modelVersion }),
        targetUri: request.document.uri,
        startOffset: editableStart,
        endOffset: editableEnd,
        ...(cursorInOutput === undefined
          ? {}
          : {
              jumpOffset: editableStart + cursorInOutput,
            }),
      },
    };
  } catch (error) {
    if (backoffKey !== undefined && isHttp408(error)) {
      backoffUntil.set(backoffKey, Date.now() + 10_000);
    }
    throw error;
  }
}

async function resolvePatchUri(
  request: Zeta3InternalCompletionRequest,
  path: string,
): Promise<
  { readonly uri: vscode.Uri; readonly snapshot: string } | undefined
> {
  let snapshot: string | undefined;
  if (path === request.document.path) snapshot = request.document.text;
  if (snapshot === undefined) {
    for (let index = request.editHistory.length - 1; index >= 0; index -= 1) {
      const entry = request.editHistory[index];
      if (entry?.path === path) {
        snapshot = entry.newText;
        break;
      }
    }
  }
  if (snapshot === undefined) return undefined;
  const sourceUri = vscode.Uri.parse(request.document.uri, true);
  const folder = vscode.workspace.getWorkspaceFolder(sourceUri);
  if (!folder) return undefined;
  const target = vscode.Uri.joinPath(folder.uri, ...path.split('/'));
  if (
    vscode.workspace.getWorkspaceFolder(target)?.uri.toString() !==
    folder.uri.toString()
  ) {
    return undefined;
  }
  if (target.scheme === 'file' && folder.uri.scheme === 'file') {
    try {
      const [rootRealpath, targetRealpath] = await Promise.all([
        nodeRealpath(folder.uri.fsPath),
        nodeRealpath(target.fsPath),
      ]);
      const relative = nodePath.relative(rootRealpath, targetRealpath);
      if (
        !relative ||
        relative === '..' ||
        relative.startsWith(`..${nodePath.sep}`) ||
        nodePath.isAbsolute(relative)
      ) {
        return undefined;
      }
    } catch {
      return undefined;
    }
  }
  return { uri: target, snapshot };
}

async function executeV4(
  context: NativeCompletionApiContext,
  request: Zeta3InternalCompletionRequest,
  token: vscode.CancellationToken,
  logger: CompletionRequestLogger | undefined,
): Promise<BufferedCompletionResponse> {
  const startedAt = Date.now();
  let backoffKey: string | undefined;
  try {
    const port = getZedCompletionSessionPort();
    const policy = await port.getPolicySnapshot(context, token);
    backoffKey = policy.backoffKey;
    if (inBackoff(backoffKey)) return emptyResponse();
    const collection = await evaluateZedDataCollection(
      request,
      policy,
    );
    const body = buildZedV4RequestBody(request, collection);
    const result = await port.predictV4(
      context,
      body,
      {
        trigger: request.trigger,
        onRequestPrepared: (prepared) => logger?.providerRequest(prepared),
      },
      token,
    );
    const { response } = result;
    logger?.rawHttpResponseBody(JSON.stringify(response));
    trackZedPrediction({
      requestId: response.requestId,
      ...(response.modelVersion === undefined
        ? {}
        : { modelVersion: response.modelVersion }),
      startedAt,
      transport: result.feedback,
      canCollectData: collection.canCollectData,
      isInOpenSourceRepo: collection.isInOpenSourceRepo,
    });
    if (result.canceledAfterDispatch || token.isCancellationRequested) {
      rejectZedPrediction(response.requestId, 'canceled', false);
      return emptyResponse();
    }
    try {
      const patch = parseSingleFileUnifiedDiff(response.patch);
      if (!patch) {
        rejectZedPrediction(response.requestId, 'empty', false);
        return emptyResponse();
      }
      const target = await resolvePatchUri(request, patch.path);
      if (!target) {
        throw new CompletionRuntimeError(
          'completion-invalid-response',
          'Zed v4 patch targets a file outside the workspace.',
        );
      }
      if (target.uri.toString() !== request.document.uri) {
        await vscode.workspace.openTextDocument(target.uri);
      }
      const resolved = patch.resolve(target.snapshot);
      if (resolved.edits.length === 0) {
        rejectZedPrediction(response.requestId, 'empty', false);
        return emptyResponse();
      }
      const text = resolved.text;
      if (collection.canCollectData) {
        const range = changedRange(target.snapshot, text);
        if (range) {
          setZedPredictionSampleData(
            response.requestId,
            settledSampleData(
              collection,
              request.document,
              request.editHistory,
              request.diagnostics,
              patch.path,
              target.snapshot,
              range.start,
              range.end,
              resolved.cursorOffset === undefined
                ? undefined
                : { snapshot: text, offset: resolved.cursorOffset },
            ),
          );
        }
      }
      return {
        mode: 'buffered',
        choices: [{ text }],
        edit: {
          requestId: response.requestId,
          ...(response.modelVersion === undefined
            ? {}
            : { modelVersion: response.modelVersion }),
          targetUri: target.uri.toString(),
          requestSnapshot: target.snapshot,
          edits: resolved.edits,
          ...(resolved.cursorOffset === undefined
            ? {}
            : { jumpOffset: resolved.cursorOffset }),
        },
      };
    } catch {
      rejectZedPrediction(response.requestId, 'patch_apply_failed', false);
      return emptyResponse();
    }
  } catch (error) {
    if (backoffKey !== undefined && isHttp408(error)) {
      backoffUntil.set(backoffKey, Date.now() + 10_000);
    }
    throw error;
  }
}

const CAPABILITY = {
  responseMode: 'buffered',
  multiCandidateSupport: 'single-result-only',
} as const;

export const ZED_PREDICT_EDITS_CAPABILITIES = {
  'zeta2.1': CAPABILITY,
  'zeta3-internal': CAPABILITY,
} as const satisfies CompletionApiCapabilities;

function createV3Operation(
  context: NativeCompletionApiContext,
): CompletionApiOperation<'zeta2.1'> {
  return {
    execute: (request, token) =>
      runWithCompletionConcurrency(
        `zed-cloud:${context.provider.name}:${context.model.id}`,
        2,
        token,
        () =>
          runNativeCompletionOperation(context, request.kind, token, (logger) =>
            executeV3(context, request, token, logger),
          ),
      ),
  };
}

function createV4Operation(
  context: NativeCompletionApiContext,
): CompletionApiOperation<'zeta3-internal'> {
  return {
    execute: (request, token) =>
      runWithCompletionConcurrency(
        `zed-cloud:${context.provider.name}:${context.model.id}`,
        2,
        token,
        () =>
          runNativeCompletionOperation(context, request.kind, token, (logger) =>
            executeV4(context, request, token, logger),
          ),
      ),
  };
}

export const ZED_PREDICT_EDITS_PROVIDER_DEFINITION =
  defineNativeCompletionApiProvider({
    capabilities: ZED_PREDICT_EDITS_CAPABILITIES,
    operationFactories: {
      'zeta2.1': createV3Operation,
      'zeta3-internal': createV4Operation,
    },
  });

export function clearZedRequestBackoffForTests(): void {
  backoffUntil.clear();
}

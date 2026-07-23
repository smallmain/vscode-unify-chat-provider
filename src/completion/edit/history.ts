import * as vscode from 'vscode';
import type { EditHistoryEntry } from '../model/requests';
import { transformEditRangeThroughChange } from './lifecycle';
import { documentWorkspacePath, relativeWorkspaceUriPath } from './workspace-path';

const EVENT_COUNT_MAX = 10;
const CHANGE_GROUPING_LINE_SPAN = 8;
const LAST_CHANGE_GROUPING_TIME_MS = 1_000;

interface MinimalChange {
  readonly oldStart: number;
  readonly oldEnd: number;
  readonly newStart: number;
  readonly newEnd: number;
}

interface DiffLine {
  readonly text: string;
  readonly hasNewline: boolean;
}

interface PendingHistoryEvent {
  readonly workspaceKey: string;
  readonly uri: string;
  readonly path: string;
  readonly oldText: string;
  newText: string;
  predicted: boolean;
  latestRange: { startOffset: number; endOffset: number };
  lastEditAt: number;
  timer?: NodeJS.Timeout;
}

function minimalChange(before: string, after: string): MinimalChange | undefined {
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
    newStart: prefix,
    newEnd: after.length - suffix,
  };
}

function diffLines(text: string): readonly DiffLine[] {
  const normalized = text.replaceAll('\r\n', '\n');
  if (!normalized) return [];
  const result: DiffLine[] = [];
  let start = 0;
  for (let index = 0; index < normalized.length; index += 1) {
    if (normalized.charCodeAt(index) !== 10) continue;
    result.push({ text: normalized.slice(start, index), hasNewline: true });
    start = index + 1;
  }
  if (start < normalized.length) {
    result.push({ text: normalized.slice(start), hasNewline: false });
  }
  return result;
}

function sameLine(left: DiffLine, right: DiffLine): boolean {
  return left.text === right.text && left.hasNewline === right.hasNewline;
}

type LineOperation =
  | { readonly kind: 'context'; readonly line: DiffLine }
  | { readonly kind: 'delete'; readonly line: DiffLine }
  | { readonly kind: 'add'; readonly line: DiffLine };

function lineOperations(
  oldLines: readonly DiffLine[],
  newLines: readonly DiffLine[],
): readonly LineOperation[] {
  const width = newLines.length + 1;
  const cellCount = (oldLines.length + 1) * width;
  if (cellCount > 250_000) {
    return [
      ...oldLines.map((line): LineOperation => ({ kind: 'delete', line })),
      ...newLines.map((line): LineOperation => ({ kind: 'add', line })),
    ];
  }
  const lengths = new Uint32Array(cellCount);
  for (let oldIndex = oldLines.length - 1; oldIndex >= 0; oldIndex -= 1) {
    for (let newIndex = newLines.length - 1; newIndex >= 0; newIndex -= 1) {
      const index = oldIndex * width + newIndex;
      lengths[index] = sameLine(oldLines[oldIndex]!, newLines[newIndex]!)
        ? 1 + lengths[(oldIndex + 1) * width + newIndex + 1]!
        : Math.max(
            lengths[(oldIndex + 1) * width + newIndex]!,
            lengths[oldIndex * width + newIndex + 1]!,
          );
    }
  }

  const operations: LineOperation[] = [];
  let oldIndex = 0;
  let newIndex = 0;
  while (oldIndex < oldLines.length || newIndex < newLines.length) {
    if (
      oldIndex < oldLines.length &&
      newIndex < newLines.length &&
      sameLine(oldLines[oldIndex]!, newLines[newIndex]!)
    ) {
      operations.push({ kind: 'context', line: oldLines[oldIndex]! });
      oldIndex += 1;
      newIndex += 1;
    } else if (
      newIndex >= newLines.length ||
      (oldIndex < oldLines.length &&
        lengths[(oldIndex + 1) * width + newIndex]! >=
          lengths[oldIndex * width + newIndex + 1]!)
    ) {
      operations.push({ kind: 'delete', line: oldLines[oldIndex]! });
      oldIndex += 1;
    } else {
      operations.push({ kind: 'add', line: newLines[newIndex]! });
      newIndex += 1;
    }
  }
  return operations;
}

function renderOperation(operation: LineOperation): readonly string[] {
  const prefix =
    operation.kind === 'context' ? ' ' : operation.kind === 'delete' ? '-' : '+';
  return operation.line.hasNewline
    ? [`${prefix}${operation.line.text}`]
    : [`${prefix}${operation.line.text}`, '\\ No newline at end of file'];
}

function hunkStart(index: number, count: number): number {
  return count === 0 ? index : index + 1;
}

function unifiedDiff(
  before: string,
  after: string,
  _change: MinimalChange,
): string {
  const oldLines = diffLines(before);
  const newLines = diffLines(after);
  let prefix = 0;
  while (
    prefix < oldLines.length &&
    prefix < newLines.length &&
    sameLine(oldLines[prefix]!, newLines[prefix]!)
  ) {
    prefix += 1;
  }
  let suffix = 0;
  while (
    suffix < oldLines.length - prefix &&
    suffix < newLines.length - prefix &&
    sameLine(
      oldLines[oldLines.length - suffix - 1]!,
      newLines[newLines.length - suffix - 1]!,
    )
  ) {
    suffix += 1;
  }

  const leading = Math.min(3, prefix);
  const trailing = Math.min(3, suffix);
  const oldStart = prefix - leading;
  const newStart = prefix - leading;
  const oldEnd = oldLines.length - suffix + trailing;
  const newEnd = newLines.length - suffix + trailing;
  const oldRegion = oldLines.slice(oldStart, oldEnd);
  const newRegion = newLines.slice(newStart, newEnd);
  const body = lineOperations(oldRegion, newRegion).flatMap(renderOperation);
  return [
    `@@ -${hunkStart(oldStart, oldRegion.length)},${oldRegion.length} +${hunkStart(newStart, newRegion.length)},${newRegion.length} @@`,
    ...body,
    '',
  ].join('\n');
}

function folderKey(folder: vscode.WorkspaceFolder | undefined): string | undefined {
  return folder?.uri.toString();
}

function relativeDocumentPath(
  document: vscode.TextDocument,
  folder: vscode.WorkspaceFolder,
): string | undefined {
  return documentWorkspacePath(document, folder);
}

function rowAtOffset(text: string, offset: number): number {
  let row = 0;
  const end = Math.max(0, Math.min(text.length, offset));
  for (let index = 0; index < end; index += 1) {
    if (text.charCodeAt(index) === 10) row += 1;
  }
  return row;
}

function linesBetween(
  text: string,
  left: { readonly startOffset: number; readonly endOffset: number },
  right: { readonly startOffset: number; readonly endOffset: number },
): number {
  const leftStart = rowAtOffset(text, left.startOffset);
  const leftEnd = rowAtOffset(text, left.endOffset);
  const rightStart = rowAtOffset(text, right.startOffset);
  const rightEnd = rowAtOffset(text, right.endOffset);
  if (leftStart > rightEnd) return leftStart - rightEnd;
  if (rightStart > leftEnd) return rightStart - leftEnd;
  return 0;
}

function historyEntry(input: {
  readonly uri: string;
  readonly path: string;
  readonly oldText: string;
  readonly newText: string;
  readonly predicted: boolean;
}): EditHistoryEntry | undefined {
  const change = minimalChange(input.oldText, input.newText);
  if (!change) return undefined;
  return {
    uri: input.uri,
    path: input.path,
    oldText: input.oldText,
    newText: input.newText,
    oldRange: { startOffset: change.oldStart, endOffset: change.oldEnd },
    newRange: { startOffset: change.newStart, endOffset: change.newEnd },
    diff: unifiedDiff(input.oldText, input.newText, change),
    predicted: input.predicted,
  };
}

function entryRangeInLatestSnapshot(
  history: readonly EditHistoryEntry[],
  index: number,
): { readonly startOffset: number; readonly endOffset: number } | undefined {
  const entry = history[index];
  if (!entry) return undefined;
  let snapshot = entry.newText;
  let range = entry.newRange;
  if (!range) {
    const change = minimalChange(entry.oldText, entry.newText);
    if (!change) return undefined;
    range = { startOffset: change.newStart, endOffset: change.newEnd };
  }
  for (let nextIndex = index + 1; nextIndex < history.length; nextIndex += 1) {
    const next = history[nextIndex];
    if (!next || next.uri !== entry.uri || next.oldText !== snapshot) {
      return undefined;
    }
    const change = minimalChange(next.oldText, next.newText);
    if (!change) return undefined;
    const transformed = transformEditRangeThroughChange(
      range.startOffset,
      range.endOffset,
      change.oldStart,
      change.oldEnd,
      change.newEnd - change.newStart,
    );
    range = { startOffset: transformed.start, endOffset: transformed.end };
    snapshot = next.newText;
  }
  return range;
}

function mergeTrailingEvents(
  history: EditHistoryEntry[],
  uri: string,
  latestSnapshot: string,
  latestRange: { readonly startOffset: number; readonly endOffset: number },
): void {
  const newest = history.at(-1);
  if (
    !newest ||
    newest.uri !== uri ||
    newest.newText !== latestSnapshot ||
    history.length < 2
  ) {
    return;
  }

  let mergeStart = history.length - 1;
  for (let index = history.length - 2; index >= 0; index -= 1) {
    const left = history[index];
    const right = history[index + 1];
    if (
      !left ||
      !right ||
      left.uri !== uri ||
      right.uri !== uri ||
      left.newText !== right.oldText ||
      left.predicted === right.predicted
    ) {
      break;
    }
    const leftRange = entryRangeInLatestSnapshot(history, index);
    const rightRange = entryRangeInLatestSnapshot(history, index + 1);
    if (
      !leftRange ||
      !rightRange ||
      Math.min(
        linesBetween(latestSnapshot, leftRange, latestRange),
        linesBetween(latestSnapshot, rightRange, latestRange),
      ) <= CHANGE_GROUPING_LINE_SPAN ||
      linesBetween(latestSnapshot, leftRange, rightRange) >
        CHANGE_GROUPING_LINE_SPAN
    ) {
      break;
    }
    mergeStart = index;
  }
  if (mergeStart === history.length - 1) return;

  const oldest = history[mergeStart]!;
  const merged = historyEntry({
    uri,
    path: oldest.path ?? newest.path ?? '',
    oldText: oldest.oldText,
    newText: newest.newText,
    predicted: history.slice(mergeStart).every((entry) => entry.predicted),
  });
  if (!merged) return;
  history.splice(mergeStart, history.length - mergeStart, merged);
}

export class WorkspaceEditHistory implements vscode.Disposable {
  private readonly snapshots = new Map<string, string>();
  private readonly entries = new Map<string, EditHistoryEntry[]>();
  private readonly pending = new Map<string, PendingHistoryEvent>();
  private readonly subscriptions: vscode.Disposable[] = [];
  private readonly predictedUris = new Set<string>();
  private readonly listeners = new Set<(entry: EditHistoryEntry) => void>();

  constructor() {
    for (const document of vscode.workspace.textDocuments ?? []) {
      this.snapshots.set(document.uri.toString(), document.getText());
    }
    if (typeof vscode.workspace.onDidOpenTextDocument === 'function') {
      this.subscriptions.push(
        vscode.workspace.onDidOpenTextDocument((document) => {
          this.snapshots.set(document.uri.toString(), document.getText());
        }),
      );
    }
    if (typeof vscode.workspace.onDidCloseTextDocument === 'function') {
      this.subscriptions.push(
        vscode.workspace.onDidCloseTextDocument((document) => {
          this.snapshots.delete(document.uri.toString());
        }),
      );
    }
    if (typeof vscode.workspace.onDidChangeTextDocument === 'function') {
      this.subscriptions.push(
        vscode.workspace.onDidChangeTextDocument((event) => {
          this.record(event.document);
        }),
      );
    }
  }

  seed(document: vscode.TextDocument): void {
    const key = document.uri.toString();
    if (!this.snapshots.has(key)) {
      this.snapshots.set(key, document.getText());
    }
  }

  onDidRecord(listener: (entry: EditHistoryEntry) => void): vscode.Disposable {
    this.listeners.add(listener);
    return {
      dispose: () => {
        this.listeners.delete(listener);
      },
    };
  }

  private emit(entry: EditHistoryEntry): void {
    for (const listener of this.listeners) listener({ ...entry });
  }

  markNextChangePredicted(uri: vscode.Uri): void {
    this.predictedUris.add(uri.toString());
  }

  recordAcceptedPrediction(input: {
    readonly uri: vscode.Uri;
    readonly path?: string;
    readonly before: string;
    readonly after: string;
  }): void {
    const folder = vscode.workspace.getWorkspaceFolder(input.uri);
    const key = folderKey(folder);
    if (!folder || !key || input.before === input.after) return;
    const pending = this.pending.get(key);
    if (
      pending?.uri === input.uri.toString() &&
      pending.oldText === input.before &&
      pending.newText === input.after
    ) {
      pending.predicted = true;
      this.predictedUris.delete(input.uri.toString());
      return;
    }
    if (
      pending?.uri === input.uri.toString() &&
      pending.newText === input.after &&
      pending.oldText !== input.before
    ) {
      pending.newText = input.before;
      this.finalizePending(key);
    }
    const history = this.entries.get(key) ?? [];
    for (let index = history.length - 1; index >= 0; index -= 1) {
      const entry = history[index];
      if (
        entry?.uri === input.uri.toString() &&
        entry.oldText === input.before &&
        entry.newText === input.after
      ) {
        history[index] = { ...entry, predicted: true };
        this.predictedUris.delete(input.uri.toString());
        return;
      }
    }
    const path = input.path ?? relativeWorkspaceUriPath(folder.uri, input.uri);
    if (!path) return;
    this.appendChange({
      workspaceKey: key,
      uri: input.uri.toString(),
      path,
      before: input.before,
      after: input.after,
      predicted: true,
      now: Date.now(),
    });
    this.snapshots.set(input.uri.toString(), input.after);
    this.predictedUris.delete(input.uri.toString());
  }

  read(document: vscode.TextDocument): readonly EditHistoryEntry[] {
    this.seed(document);
    const key = folderKey(vscode.workspace.getWorkspaceFolder(document.uri));
    if (!key) return [];
    const result = [...(this.entries.get(key) ?? [])];
    const pending = this.pending.get(key);
    if (pending) {
      const entry = historyEntry({
        uri: pending.uri,
        path: pending.path,
        oldText: pending.oldText,
        newText: pending.newText,
        predicted: pending.predicted,
      });
      if (entry) result.push(entry);
    }
    return result.slice(-EVENT_COUNT_MAX).map((entry) => ({ ...entry }));
  }

  private record(document: vscode.TextDocument): void {
    const uri = document.uri.toString();
    const after = document.getText();
    const before = this.snapshots.get(uri);
    this.snapshots.set(uri, after);
    if (before === undefined || before === after) return;
    const folder = vscode.workspace.getWorkspaceFolder(document.uri);
    const key = folderKey(folder);
    if (!folder || !key) return;
    const path = relativeDocumentPath(document, folder);
    if (!path) return;
    this.appendChange({
      workspaceKey: key,
      uri,
      path,
      before,
      after,
      predicted: this.predictedUris.delete(uri),
      now: Date.now(),
    });
  }

  private appendChange(input: {
    readonly workspaceKey: string;
    readonly uri: string;
    readonly path: string;
    readonly before: string;
    readonly after: string;
    readonly predicted: boolean;
    readonly now: number;
  }): void {
    const change = minimalChange(input.before, input.after);
    if (!change) return;
    const previous = this.pending.get(input.workspaceKey);
    const canCoalesce =
      previous !== undefined &&
      previous.uri === input.uri &&
      previous.path === input.path &&
      previous.newText === input.before &&
      previous.predicted === input.predicted &&
      input.now - previous.lastEditAt < LAST_CHANGE_GROUPING_TIME_MS &&
      linesBetween(input.before, previous.latestRange, {
        startOffset: change.oldStart,
        endOffset: change.oldEnd,
      }) <= CHANGE_GROUPING_LINE_SPAN;
    if (canCoalesce) {
      previous.newText = input.after;
      previous.latestRange = {
        startOffset: change.newStart,
        endOffset: change.newEnd,
      };
      previous.lastEditAt = input.now;
      this.scheduleFinalize(previous);
      return;
    }
    this.finalizePending(input.workspaceKey);
    const history = this.entries.get(input.workspaceKey);
    if (history) {
      mergeTrailingEvents(history, input.uri, input.before, {
        startOffset: change.oldStart,
        endOffset: change.oldEnd,
      });
    }
    const pending: PendingHistoryEvent = {
      workspaceKey: input.workspaceKey,
      uri: input.uri,
      path: input.path,
      oldText: input.before,
      newText: input.after,
      predicted: input.predicted,
      latestRange: {
        startOffset: change.newStart,
        endOffset: change.newEnd,
      },
      lastEditAt: input.now,
    };
    this.pending.set(input.workspaceKey, pending);
    this.scheduleFinalize(pending);
  }

  private scheduleFinalize(pending: PendingHistoryEvent): void {
    if (pending.timer) clearTimeout(pending.timer);
    pending.timer = setTimeout(() => {
      if (this.pending.get(pending.workspaceKey) === pending) {
        this.finalizePending(pending.workspaceKey);
      }
    }, LAST_CHANGE_GROUPING_TIME_MS);
    pending.timer.unref?.();
  }

  private finalizePending(key: string): void {
    const pending = this.pending.get(key);
    if (!pending) return;
    if (pending.timer) clearTimeout(pending.timer);
    this.pending.delete(key);
    const entry = historyEntry({
      uri: pending.uri,
      path: pending.path,
      oldText: pending.oldText,
      newText: pending.newText,
      predicted: pending.predicted,
    });
    if (!entry) return;
    const history = this.entries.get(key) ?? [];
    history.push(entry);
    if (history.length > EVENT_COUNT_MAX) {
      history.splice(0, history.length - EVENT_COUNT_MAX);
    }
    this.entries.set(key, history);
    this.emit(entry);
  }

  dispose(): void {
    for (const subscription of this.subscriptions) subscription.dispose();
    for (const pending of this.pending.values()) {
      if (pending.timer) clearTimeout(pending.timer);
    }
    this.subscriptions.length = 0;
    this.snapshots.clear();
    this.entries.clear();
    this.pending.clear();
    this.predictedUris.clear();
    this.listeners.clear();
  }
}

export const editHistoryTesting = {
  minimalChange,
  unifiedDiff,
  linesBetween,
  mergeTrailingEvents,
  constants: {
    EVENT_COUNT_MAX,
    CHANGE_GROUPING_LINE_SPAN,
    LAST_CHANGE_GROUPING_TIME_MS,
  },
};

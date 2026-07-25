import type { GhostTextRecentEdit } from './types';

export interface FimRecentEditsConfig {
  readonly maxFiles: number;
  readonly maxEdits: number;
  readonly diffContextLines: number;
  readonly editMergeLineDistance: number;
  readonly maxCharsPerEdit: number;
  readonly debounceTimeoutMs: number;
  readonly maxLinesPerEdit: number;
}

export const FIM_RECENT_EDITS_CONFIG: FimRecentEditsConfig = Object.freeze({
  maxFiles: 20,
  maxEdits: 8,
  diffContextLines: 3,
  editMergeLineDistance: 1,
  maxCharsPerEdit: 2_000,
  debounceTimeoutMs: 500,
  maxLinesPerEdit: 10,
});

export interface FimRecentEditEvent {
  readonly uri: string;
  readonly path: string;
  readonly before: string;
  readonly after: string;
  readonly timestamp: number;
}

interface DiffHunk {
  readonly file: string;
  readonly pre: number;
  readonly before: readonly string[];
  readonly removed: readonly string[];
  readonly added: readonly string[];
  readonly after: readonly string[];
}

interface RecentEdit {
  readonly path: string;
  readonly file: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly diff: DiffHunk;
  readonly timestamp: number;
}

interface FileState {
  readonly originalContent: string;
  readonly currentContent: string;
  readonly edits: readonly RecentEdit[];
}

interface PendingEdit {
  readonly uri: string;
  readonly path: string;
  readonly after: string;
  readonly timestamp: number;
  readonly deadline: number;
}

function changeSpan(
  previous: readonly string[],
  next: readonly string[],
): { start: number; endPrevious: number; endNext: number } | undefined {
  let start = 0;
  while (
    start < previous.length &&
    start < next.length &&
    previous[start] === next[start]
  ) {
    start++;
  }
  let endPrevious = previous.length - 1;
  let endNext = next.length - 1;
  while (
    endPrevious >= start &&
    endNext >= start &&
    previous[endPrevious] === next[endNext]
  ) {
    endPrevious--;
    endNext--;
  }
  return start > endPrevious && start > endNext
    ? undefined
    : { start, endPrevious, endNext };
}

function buildEdit(
  uri: string,
  file: string,
  previous: readonly string[],
  next: readonly string[],
  span: { readonly start: number; readonly endPrevious: number; readonly endNext: number },
  timestamp: number,
  config: FimRecentEditsConfig,
): RecentEdit {
  const pre = Math.max(0, span.start - config.diffContextLines);
  const post = Math.min(next.length, span.endNext + config.diffContextLines + 1);
  return {
    file: uri,
    path: file,
    startLine: span.start,
    endLine: span.endPrevious,
    timestamp,
    diff: {
      file,
      pre,
      before: previous.slice(pre, span.start),
      removed: previous.slice(span.start, span.endPrevious + 1),
      added: next.slice(span.start, span.endNext + 1),
      after: next.slice(span.endNext + 1, post),
    },
  };
}

function applyEdits(lines: readonly string[], edits: readonly RecentEdit[]): string[] {
  let result = [...lines];
  for (const edit of edits) {
    result = [
      ...result.slice(0, edit.startLine),
      ...edit.diff.added,
      ...result.slice(edit.endLine + 1),
    ];
  }
  return result;
}

function overlap(
  incoming: RecentEdit,
  previous: RecentEdit,
  distance: number,
): boolean {
  const previousEnd = previous.startLine + previous.diff.added.length;
  const incomingEnd = incoming.endLine + 1;
  return (
    incoming.startLine <= previousEnd + distance &&
    incomingEnd >= previous.startLine - distance
  );
}

function diffSize(diff: DiffHunk): number {
  return [diff.before, diff.removed, diff.added, diff.after]
    .flat()
    .reduce((total, line) => total + line.length + 1, 0);
}

function reduceFile(
  previous: FileState | undefined,
  uri: string,
  path: string,
  contents: string,
  timestamp: number,
  config: FimRecentEditsConfig,
): FileState | undefined {
  if (contents.length > 2 * 1024 * 1024) {
    return previous;
  }
  if (!previous) {
    return { originalContent: contents, currentContent: contents, edits: [] };
  }
  if (previous.currentContent === contents) {
    return previous;
  }
  const previousLines = previous.currentContent.split('\n');
  const nextLines = contents.split('\n');
  const span = changeSpan(previousLines, nextLines);
  if (!span) {
    return { ...previous, currentContent: contents };
  }
  let incoming = buildEdit(
    uri,
    path,
    previousLines,
    nextLines,
    span,
    timestamp,
    config,
  );
  if (diffSize(incoming.diff) > config.maxCharsPerEdit) {
    return { originalContent: contents, currentContent: contents, edits: [] };
  }

  let edits = [...previous.edits];
  if (
    edits.length > 0 &&
    overlap(incoming, edits[edits.length - 1], config.editMergeLineDistance)
  ) {
    const base = applyEdits(
      previous.originalContent.split('\n'),
      edits.slice(0, -1),
    );
    const mergedSpan = changeSpan(base, nextLines);
    if (mergedSpan) {
      incoming = buildEdit(
        uri,
        path,
        base,
        nextLines,
        mergedSpan,
        timestamp,
        config,
      );
      edits = [...edits.slice(0, -1), incoming];
    } else {
      edits = edits.slice(0, -1);
    }
  } else {
    edits.push(incoming);
  }

  let originalContent = previous.originalContent;
  if (edits.length > config.maxEdits) {
    const stale = edits.slice(0, edits.length - config.maxEdits);
    edits = edits.slice(-config.maxEdits);
    originalContent = applyEdits(originalContent.split('\n'), stale).join('\n');
  }
  return { originalContent, currentContent: contents, edits };
}

function summarize(edit: RecentEdit, config: FimRecentEditsConfig): string | undefined {
  const removed = edit.diff.removed.filter((line) => line.trim().length > 0);
  const added = edit.diff.added.filter((line) => line.trim().length > 0);
  if (
    (removed.length === 0 && added.length === 0) ||
    removed.join('').trim() === added.join('').trim() ||
    edit.diff.added.length > config.maxLinesPerEdit ||
    edit.diff.removed.length > config.maxLinesPerEdit
  ) {
    return undefined;
  }
  const oldLength =
    edit.diff.before.length + edit.diff.removed.length + edit.diff.after.length;
  const newLength =
    edit.diff.before.length + edit.diff.added.length + edit.diff.after.length;
  const lines = [
    ...(edit.diff.file
      ? [`--- a/${edit.diff.file}`, `+++ b/${edit.diff.file}`]
      : []),
    `@@ -${edit.diff.pre + 1},${oldLength} +${edit.diff.pre + 1},${newLength} @@`,
    ...edit.diff.before.map((line) => ` ${line}`),
    ...edit.diff.added.map((line) => `+${line}`),
    ...edit.diff.removed.map((line) => `-${line} --- IGNORE ---`),
    ...edit.diff.after.map((line) => ` ${line}`),
  ];
  return `${lines.join('\n')}\n`;
}

/** Stateful adapter for the official debounced FullRecentEditsProvider behavior. */
export class FimRecentEditsTracker {
  private readonly files = new Map<string, FileState>();
  private readonly pending = new Map<string, PendingEdit>();
  private readonly seenEvents = new Set<string>();

  constructor(
    private readonly config: FimRecentEditsConfig = FIM_RECENT_EDITS_CONFIG,
  ) {}

  ingest(
    events: readonly FimRecentEditEvent[],
    now: number,
    includedUris?: ReadonlySet<string>,
  ): readonly GhostTextRecentEdit[] {
    const unseen = events
      .filter((event) => {
        const key = this.eventKey(event);
        if (this.seenEvents.has(key)) return false;
        this.seenEvents.add(key);
        return true;
      })
      .sort((left, right) => left.timestamp - right.timestamp);

    for (const event of unseen) {
      this.flushThrough(event.timestamp);
      if (!this.files.has(event.uri)) {
        const initial = reduceFile(
          undefined,
          event.uri,
          event.path,
          event.before,
          event.timestamp,
          this.config,
        );
        if (initial) this.files.set(event.uri, initial);
      }
      this.pending.set(event.uri, {
        uri: event.uri,
        path: event.path,
        after: event.after,
        timestamp: event.timestamp,
        deadline: event.timestamp + this.config.debounceTimeoutMs,
      });
    }
    this.flushThrough(now);
    this.trimSeenEvents();
    return this.summaries(includedUris);
  }

  getState(): {
    readonly trackedFiles: number;
    readonly pendingFiles: number;
    readonly edits: number;
    readonly documents: readonly {
      readonly uri: string;
      readonly currentContent: string;
      readonly editCount: number;
    }[];
  } {
    return {
      trackedFiles: this.files.size,
      pendingFiles: this.pending.size,
      edits: [...this.files.values()].reduce(
        (total, file) => total + file.edits.length,
        0,
      ),
      documents: [...this.files.entries()].map(([uri, file]) => ({
        uri,
        currentContent: file.currentContent,
        editCount: file.edits.length,
      })),
    };
  }

  private flushThrough(timestamp: number): void {
    const ready = [...this.pending.values()]
      .filter((pending) => pending.deadline <= timestamp)
      .sort((left, right) => left.deadline - right.deadline);
    for (const pending of ready) {
      const current = this.pending.get(pending.uri);
      if (current !== pending) continue;
      const next = reduceFile(
        this.files.get(pending.uri),
        pending.uri,
        pending.path,
        pending.after,
        pending.timestamp,
        this.config,
      );
      if (next) this.files.set(pending.uri, next);
      this.pending.delete(pending.uri);
      this.trimFiles();
    }
  }

  private trimFiles(): void {
    const edited = [...this.files.entries()]
      .filter(([, file]) => file.edits.length > 0)
      .sort(([, left], [, right]) => {
        const leftEdit = left.edits[left.edits.length - 1];
        const rightEdit = right.edits[right.edits.length - 1];
        return leftEdit.timestamp - rightEdit.timestamp;
      });
    for (const [uri] of edited.slice(0, Math.max(0, edited.length - this.config.maxFiles))) {
      this.files.delete(uri);
      this.pending.delete(uri);
    }
  }

  private summaries(
    includedUris: ReadonlySet<string> | undefined,
  ): readonly GhostTextRecentEdit[] {
    return [...this.files.values()]
      .flatMap((file) => file.edits)
      .filter((edit) => !includedUris || includedUris.has(edit.file))
      .sort((left, right) => left.timestamp - right.timestamp)
      .flatMap((edit) => {
        const summary = summarize(edit, this.config);
        return summary
          ? [{
              uri: edit.file,
              path: edit.path,
              summary,
              startLine: edit.startLine,
              endLine: edit.endLine,
            }]
          : [];
      });
  }

  private eventKey(event: FimRecentEditEvent): string {
    return [event.uri, event.timestamp, event.before, event.after].join('\u0000');
  }

  private trimSeenEvents(): void {
    if (this.seenEvents.size <= 500) return;
    const retained = [...this.seenEvents].slice(-250);
    this.seenEvents.clear();
    for (const key of retained) this.seenEvents.add(key);
  }
}

import { computeDetailedTextEdits } from '../edit/text-edits';
import { CompletionRuntimeError } from '../model/errors';
import type { CompletionTextEdit } from '../model/responses';
import { ZETA_CURSOR_MARKER } from './zeta';

export interface ResolvedUnifiedDiff {
  readonly edits: readonly CompletionTextEdit[];
  readonly text: string;
  readonly cursorOffset?: number;
}

export interface ParsedUnifiedDiff {
  readonly path: string;
  resolve(original: string): ResolvedUnifiedDiff;
  apply(original: string): string;
}

interface ParsedEdit {
  range: { start: number; end: number };
  text: string;
}

interface Hunk {
  context: string;
  edits: ParsedEdit[];
  startLine?: number;
}

interface PatchFile {
  oldPath: string;
  newPath: string;
}

type DiffEvent =
  | { readonly kind: 'hunk'; readonly file: PatchFile; readonly hunk: Hunk }
  | { readonly kind: 'file-end'; readonly file: PatchFile };

type DiffLine =
  | { readonly kind: 'old-path'; readonly path: string }
  | { readonly kind: 'new-path'; readonly path: string }
  | { readonly kind: 'hunk-header'; readonly startLine?: number }
  | { readonly kind: 'context'; readonly text: string }
  | { readonly kind: 'deletion'; readonly text: string }
  | { readonly kind: 'addition'; readonly text: string }
  | { readonly kind: 'no-newline' }
  | { readonly kind: 'garbage' };

type LastDiffOperation = 'none' | 'context' | 'deletion' | 'addition';

interface WorkingEdit extends CompletionTextEdit {
  readonly id: number;
}

interface CursorLocation {
  readonly editId: number;
  readonly offset: number;
}

function invalidPatch(message: string): CompletionRuntimeError {
  return new CompletionRuntimeError('completion-invalid-response', message);
}

function parseHeaderPath(stripPrefix: string, header: string): string {
  if (!header.includes('"') && !header.includes('\\')) {
    const path = header.trimStart().split(/[\t ]/, 1)[0] ?? header;
    return path.startsWith(stripPrefix) ? path.slice(stripPrefix.length) : path;
  }

  let path = '';
  let inQuote = false;
  let prefix = stripPrefix;
  const characters = [...header.trimStart()];
  for (let index = 0; index < characters.length; index += 1) {
    const character = characters[index]!;
    if (character === '"') {
      inQuote = !inQuote;
    } else if (character === '\\') {
      const next = characters[index + 1];
      if (next === undefined) break;
      path += next;
      index += 1;
    } else if ((character === ' ' || character === '\t') && !inQuote) {
      break;
    } else {
      path += character;
    }
    if (prefix && path === prefix) {
      path = '';
      prefix = '';
    }
  }
  return path;
}

function safePath(path: string): string {
  const normalized = path.replaceAll('\\', '/');
  if (
    !normalized ||
    normalized === '/dev/null' ||
    normalized.startsWith('/') ||
    /^[A-Za-z]:\//.test(normalized) ||
    normalized
      .split('/')
      .some((part) => part === '' || part === '.' || part === '..')
  ) {
    throw invalidPatch('Zed v4 returned an unsafe or unsupported patch path.');
  }
  return normalized;
}

function parseRangeStart(token: string): number | undefined {
  const values = token.split(',');
  if (values.length > 2) return undefined;
  const value = values[0];
  const count = values[1] ?? '1';
  if (!value || !/^\d+$/.test(value) || !/^\d+$/.test(count)) {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || !Number.isSafeInteger(Number(count))) {
    return undefined;
  }
  return Math.max(0, parsed - 1);
}

function parseDiffLine(line: string): DiffLine {
  if (line.startsWith('\\ No newline')) return { kind: 'no-newline' };
  const oldPath = /^---[\t ]+(.+)$/.exec(line);
  if (oldPath) {
    return { kind: 'old-path', path: parseHeaderPath('a/', oldPath[1]!) };
  }
  const newPath = /^\+\+\+[\t ]+(.+)$/.exec(line);
  if (newPath) {
    return { kind: 'new-path', path: parseHeaderPath('b/', newPath[1]!) };
  }
  const hunkHeader = /^@@[\t ]+(.+)$/.exec(line);
  if (hunkHeader) {
    const header = hunkHeader[1]!.trimStart();
    if (header.startsWith('...')) return { kind: 'hunk-header' };
    const tokens = header.split(/[\t ]+/);
    const oldRange = tokens[0];
    const newRange = tokens[1];
    if (!oldRange?.startsWith('-') || !newRange?.startsWith('+')) {
      return { kind: 'garbage' };
    }
    const startLine = parseRangeStart(oldRange.slice(1));
    if (startLine === undefined || parseRangeStart(newRange.slice(1)) === undefined) {
      return { kind: 'garbage' };
    }
    return { kind: 'hunk-header', startLine };
  }
  if (line.startsWith('-')) return { kind: 'deletion', text: line.slice(1) };
  if (line === '') return { kind: 'context', text: '' };
  if (line.startsWith(' ')) return { kind: 'context', text: line.slice(1) };
  if (line.startsWith('+')) return { kind: 'addition', text: line.slice(1) };
  return { kind: 'garbage' };
}

function patchLines(patch: string): readonly string[] {
  const lines = patch.split(/\r\n|\n|\r/);
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

function parseEvents(patch: string): readonly DiffEvent[] {
  const events: DiffEvent[] = [];
  let currentFile: PatchFile | undefined;
  let hunk: Hunk = { context: '', edits: [] };
  let processedNoNewline = false;
  let lastOperation: LastDiffOperation = 'none';

  const flushHunk = (): void => {
    if (currentFile && (hunk.context || hunk.edits.length > 0)) {
      events.push({
        kind: 'hunk',
        file: { ...currentFile },
        hunk: {
          context: hunk.context,
          edits: hunk.edits.map((edit) => ({
            range: { ...edit.range },
            text: edit.text,
          })),
          ...(hunk.startLine === undefined ? {} : { startLine: hunk.startLine }),
        },
      });
    }
    hunk = { context: '', edits: [] };
    processedNoNewline = false;
    lastOperation = 'none';
  };
  const flushFile = (): void => {
    if (currentFile) {
      events.push({ kind: 'file-end', file: { ...currentFile } });
      currentFile = undefined;
    }
  };

  for (const line of patchLines(patch)) {
    const parsed = parseDiffLine(line);
    const hunkDone =
      parsed.kind === 'old-path' ||
      parsed.kind === 'garbage' ||
      parsed.kind === 'hunk-header';
    const fileDone = parsed.kind === 'old-path' || parsed.kind === 'garbage';
    if (hunkDone) flushHunk();
    if (fileDone) flushFile();

    switch (parsed.kind) {
      case 'old-path':
        currentFile = { oldPath: parsed.path, newPath: '' };
        break;
      case 'new-path':
        if (currentFile) currentFile.newPath = parsed.path;
        break;
      case 'hunk-header':
        if (parsed.startLine !== undefined) hunk.startLine = parsed.startLine;
        break;
      case 'context':
        if (currentFile) {
          hunk.context += `${parsed.text}\n`;
          lastOperation = 'context';
        }
        break;
      case 'deletion':
        if (currentFile) {
          const range = {
            start: hunk.context.length,
            end: hunk.context.length + parsed.text.length + 1,
          };
          const previous = hunk.edits.at(-1);
          if (previous?.range.end === range.start) {
            previous.range.end = range.end;
          } else {
            hunk.edits.push({ range, text: '' });
          }
          hunk.context += `${parsed.text}\n`;
          lastOperation = 'deletion';
        }
        break;
      case 'addition':
        if (currentFile) {
          const offset = hunk.context.length;
          const previous = hunk.edits.at(-1);
          if (previous?.range.end === offset) {
            previous.text += `${parsed.text}\n`;
          } else {
            hunk.edits.push({
              range: { start: offset, end: offset },
              text: `${parsed.text}\n`,
            });
          }
          lastOperation = 'addition';
        }
        break;
      case 'no-newline':
        if (!processedNoNewline) {
          processedNoNewline = true;
          if (lastOperation === 'addition') {
            const previous = hunk.edits.at(-1);
            if (previous?.text.endsWith('\n')) previous.text = previous.text.slice(0, -1);
          } else if (lastOperation === 'deletion') {
            if (hunk.context.endsWith('\n')) hunk.context = hunk.context.slice(0, -1);
            const previous = hunk.edits.at(-1);
            if (previous && previous.range.end > previous.range.start) {
              previous.range.end -= 1;
            }
          } else if (hunk.context.endsWith('\n')) {
            hunk.context = hunk.context.slice(0, -1);
          }
        }
        break;
      case 'garbage':
        break;
    }
  }
  flushHunk();
  flushFile();
  return events;
}

function occurrences(text: string, query: string): number[] {
  const result: number[] = [];
  let offset = 0;
  while (offset <= text.length - query.length) {
    const found = text.indexOf(query, offset);
    if (found < 0) break;
    result.push(found);
    offset = found + Math.max(1, query.length);
  }
  return result;
}

function findContextCandidates(text: string, hunk: Hunk): readonly number[] {
  const exact = occurrences(text, hunk.context);
  if (exact.length > 0) return exact;
  if (!hunk.context.endsWith('\n') || hunk.context.length === 0) return [];

  const context = hunk.context.slice(0, -1);
  if (!context) return [];
  const candidates = occurrences(text, context).filter(
    (offset) => offset + context.length === text.length,
  );
  if (candidates.length === 0) return [];
  const previousLength = hunk.context.length;
  hunk.context = context;
  for (const edit of hunk.edits) {
    const touchedPhantom = edit.range.end > context.length;
    edit.range.start = Math.min(edit.range.start, context.length);
    edit.range.end = Math.min(edit.range.end, context.length);
    if (touchedPhantom && edit.text.endsWith('\n')) {
      edit.text = edit.text.slice(0, -1);
    }
  }
  if (previousLength !== context.length + 1) {
    throw invalidPatch('Zed v4 returned invalid EOF context.');
  }
  return candidates;
}

function rowAtOffset(text: string, offset: number): number {
  let row = 0;
  for (let index = 0; index < offset; index += 1) {
    if (text.charCodeAt(index) === 10) row += 1;
  }
  return row;
}

function resolveContextOffset(text: string, hunk: Hunk): number {
  if (!hunk.context) return 0;
  const candidates = findContextCandidates(text, hunk);
  if (candidates.length === 1) return candidates[0]!;
  if (candidates.length > 1 && hunk.startLine !== undefined) {
    const candidate = candidates.find(
      (offset) => rowAtOffset(text, offset) === hunk.startLine,
    );
    if (candidate !== undefined) return candidate;
  }
  throw invalidPatch(
    candidates.length === 0
      ? `Zed v4 patch context did not match the target file: ${hunk.context}`
      : 'Zed v4 patch context is not unique enough.',
  );
}

function resolveHunks(text: string, hunks: readonly Hunk[]): WorkingEdit[] {
  const edits: WorkingEdit[] = [];
  let nextId = 0;
  for (const sourceHunk of hunks) {
    const hunk: Hunk = {
      context: sourceHunk.context,
      edits: sourceHunk.edits.map((edit) => ({
        range: { ...edit.range },
        text: edit.text,
      })),
      ...(sourceHunk.startLine === undefined
        ? {}
        : { startLine: sourceHunk.startLine }),
    };
    const contextOffset = resolveContextOffset(text, hunk);
    for (const edit of hunk.edits) {
      const start = contextOffset + edit.range.start;
      const end = contextOffset + edit.range.end;
      if (start < 0 || end < start || end > text.length) {
        throw invalidPatch('Zed v4 patch edit exceeds the target file.');
      }
      const oldText = text.slice(start, end);
      for (const inner of computeDetailedTextEdits(oldText, edit.text)) {
        edits.push({
          id: nextId,
          startOffset: start + inner.startOffset,
          endOffset: start + inner.endOffset,
          text: inner.text,
        });
        nextId += 1;
      }
    }
  }
  edits.sort(
    (left, right) =>
      left.startOffset - right.startOffset ||
      left.endOffset - right.endOffset ||
      left.id - right.id,
  );
  let previousEnd = 0;
  for (const edit of edits) {
    if (edit.startOffset < previousEnd) {
      throw invalidPatch('Zed v4 returned overlapping patch edits.');
    }
    previousEnd = edit.endOffset;
  }
  return edits;
}

function matchingPrefixLength(left: string, right: string): number {
  const length = Math.min(left.length, right.length);
  let index = 0;
  while (index < length && left.charCodeAt(index) === right.charCodeAt(index)) {
    index += 1;
  }
  return index;
}

function markerPrefixAtEnd(text: string): number | undefined {
  for (
    let length = Math.min(ZETA_CURSOR_MARKER.length, text.length);
    length > 0;
    length -= 1
  ) {
    if (text.endsWith(ZETA_CURSOR_MARKER.slice(0, length))) return length;
  }
  return undefined;
}

function stripCursorMarkers(edits: readonly WorkingEdit[]): {
  readonly edits: readonly WorkingEdit[];
  readonly cursor?: CursorLocation;
} {
  const output: WorkingEdit[] = [];
  let cursor: CursorLocation | undefined;
  let pending:
    | { readonly edit: WorkingEdit; readonly text: string; readonly offset: number }
    | undefined;

  for (const edit of edits) {
    let remaining = edit.text;
    let clean = '';
    if (pending) {
      const matched = matchingPrefixLength(
        ZETA_CURSOR_MARKER.slice(pending.text.length),
        remaining,
      );
      if (matched === 0) {
        output.push({ ...pending.edit, text: pending.text });
      } else {
        const markerLength = pending.text.length + matched;
        if (markerLength === ZETA_CURSOR_MARKER.length) {
          cursor ??= { editId: pending.edit.id, offset: pending.offset };
          const pendingEditId = pending.edit.id;
          if (!output.some((candidate) => candidate.id === pendingEditId)) {
            output.push({ ...pending.edit, text: '' });
          }
          remaining = remaining.slice(matched);
        } else if (matched === remaining.length) {
          pending = {
            edit: pending.edit,
            text: pending.text + ZETA_CURSOR_MARKER.slice(pending.text.length, markerLength),
            offset: pending.offset,
          };
          continue;
        } else {
          output.push({
            ...pending.edit,
            text: pending.text + remaining.slice(0, matched),
          });
          remaining = remaining.slice(matched);
        }
      }
      pending = undefined;
    }

    let markerOffset = remaining.indexOf(ZETA_CURSOR_MARKER);
    while (markerOffset >= 0) {
      clean += remaining.slice(0, markerOffset);
      cursor ??= { editId: edit.id, offset: clean.length };
      remaining = remaining.slice(markerOffset + ZETA_CURSOR_MARKER.length);
      markerOffset = remaining.indexOf(ZETA_CURSOR_MARKER);
    }

    const prefixLength = markerPrefixAtEnd(remaining);
    if (prefixLength !== undefined) {
      const markerStart = remaining.length - prefixLength;
      clean += remaining.slice(0, markerStart);
      pending = {
        edit,
        text: remaining.slice(markerStart),
        offset: clean.length,
      };
    } else {
      clean += remaining;
    }
    if (edit.startOffset !== edit.endOffset || clean) {
      output.push({ ...edit, text: clean });
    } else if (cursor?.editId === edit.id) {
      output.push({ ...edit, text: '' });
    }
  }
  if (pending) output.push({ ...pending.edit, text: pending.text });
  return { edits: output, ...(cursor === undefined ? {} : { cursor }) };
}

function applyWorkingEdits(
  source: string,
  edits: readonly WorkingEdit[],
  cursor: CursorLocation | undefined,
): { readonly text: string; readonly cursorOffset?: number } {
  const output: string[] = [];
  let sourceOffset = 0;
  let outputLength = 0;
  let cursorOffset: number | undefined;
  for (const edit of edits) {
    if (edit.startOffset < sourceOffset || edit.endOffset < edit.startOffset) {
      throw invalidPatch('Zed v4 returned overlapping patch edits.');
    }
    const unchanged = source.slice(sourceOffset, edit.startOffset);
    output.push(unchanged);
    outputLength += unchanged.length;
    if (cursor?.editId === edit.id && cursorOffset === undefined) {
      cursorOffset = outputLength + cursor.offset;
    }
    output.push(edit.text);
    outputLength += edit.text.length;
    sourceOffset = edit.endOffset;
  }
  output.push(source.slice(sourceOffset));
  return {
    text: output.join(''),
    ...(cursorOffset === undefined ? {} : { cursorOffset }),
  };
}

function coalesceWorkingEdits(
  edits: readonly WorkingEdit[],
): readonly WorkingEdit[] {
  const result: WorkingEdit[] = [];
  for (const edit of edits) {
    const previous = result.at(-1);
    if (
      previous?.id === edit.id &&
      previous.startOffset === edit.startOffset &&
      previous.endOffset === edit.endOffset
    ) {
      result[result.length - 1] = {
        ...previous,
        text: previous.text + edit.text,
      };
    } else {
      result.push(edit);
    }
  }
  return result;
}

function resolvePatch(
  original: string,
  hunks: readonly Hunk[],
): ResolvedUnifiedDiff {
  const usesCrlf = original.includes('\r\n');
  const normalized = usesCrlf ? original.replaceAll('\r\n', '\n') : original;
  const markerResult = stripCursorMarkers(resolveHunks(normalized, hunks));
  const cleanedEdits = coalesceWorkingEdits(markerResult.edits);
  const applied = applyWorkingEdits(
    normalized,
    cleanedEdits,
    markerResult.cursor,
  );
  const text = usesCrlf ? applied.text.replaceAll('\n', '\r\n') : applied.text;
  const cursorOffset =
    applied.cursorOffset === undefined
      ? undefined
      : usesCrlf
        ? applied.text.slice(0, applied.cursorOffset).replaceAll('\n', '\r\n').length
        : applied.cursorOffset;
  const edits = computeDetailedTextEdits(original, text);
  return {
    edits,
    text,
    ...(cursorOffset === undefined ? {} : { cursorOffset }),
  };
}

export function parseSingleFileUnifiedDiff(
  patch: string,
): ParsedUnifiedDiff | undefined {
  const events = parseEvents(patch);
  let targetPath: string | undefined;
  const hunks: Hunk[] = [];
  for (const event of events) {
    const oldPath = event.file.oldPath;
    const newPath = event.file.newPath;
    if (event.kind === 'file-end') {
      if (oldPath !== newPath && oldPath !== '/dev/null') {
        throw invalidPatch('Zed v4 rename patches are unsupported.');
      }
      continue;
    }
    if (oldPath === '/dev/null' || newPath === '/dev/null') {
      throw invalidPatch('Zed v4 only supports modifying existing files.');
    }
    if (oldPath !== newPath) {
      throw invalidPatch('Zed v4 rename patches are unsupported.');
    }
    const path = safePath(oldPath);
    if (targetPath !== undefined && targetPath !== path) {
      throw invalidPatch('Zed v4 must return a single-file unified diff.');
    }
    targetPath = path;
    hunks.push(event.hunk);
  }
  if (!targetPath || hunks.length === 0) return undefined;
  return {
    path: targetPath,
    resolve(original: string): ResolvedUnifiedDiff {
      return resolvePatch(original, hunks);
    },
    apply(original: string): string {
      return resolvePatch(original, hunks).text;
    },
  };
}

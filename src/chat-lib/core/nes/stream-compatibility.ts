import { NesStringEdit } from './string-edit';

export type NesEarlyDivergenceMode = 'off' | 'cursor' | 'editWindow';

interface LineDiff {
  readonly startOffset: number;
  readonly endOffset: number;
  readonly replaced: string;
  readonly inserted: string;
}

const AUTO_CLOSE_PAIRS = new Set(['()', '[]', '{}', '<>', '""', "''", '``']);

export function getCurrentLineAfterIntermediateEdit(
  originalText: string,
  originalLineIndex: number,
  intermediateEdit: NesStringEdit,
): string | undefined {
  const lineStarts = getLineStarts(originalText);
  const lineStart = lineStarts[originalLineIndex];
  if (lineStart === undefined) return undefined;
  let delta = 0;
  for (const replacement of intermediateEdit.replacements) {
    if (replacement.range.endOffset <= lineStart) {
      delta += replacement.lengthDelta;
    } else if (replacement.range.start < lineStart) {
      return undefined;
    } else {
      break;
    }
  }
  const mapped = lineStart + delta;
  const current = intermediateEdit.apply(originalText);
  return lineAtOffset(current, mapped);
}

export function isModelLineCompatible(
  originalLine: string,
  currentLine: string,
  modelLine: string,
): boolean {
  const userEdit = diffLine(originalLine, currentLine);
  const modelEdit = diffLine(originalLine, modelLine);
  if (!userEdit.replaced && !userEdit.inserted) return true;
  if (
    userEdit.startOffset < modelEdit.startOffset ||
    userEdit.endOffset > modelEdit.endOffset
  ) {
    return false;
  }
  if (userEdit.replaced) {
    return (
      currentLine === modelLine ||
      (userEdit.startOffset === modelEdit.startOffset &&
        userEdit.endOffset === modelEdit.endOffset &&
        userEdit.replaced === modelEdit.replaced &&
        userEdit.inserted.length > 0 &&
        isTypingCompatible(userEdit.inserted, modelEdit.inserted))
    );
  }
  return isTypingCompatible(userEdit.inserted, modelEdit.inserted);
}

export function isIntermediateModelLineCompatible(options: {
  readonly mode: Exclude<NesEarlyDivergenceMode, 'off'>;
  readonly localLineIndex: number;
  readonly cursorLineIndex: number;
  readonly editWindowStartLine: number;
  readonly editWindowLines: readonly string[];
  readonly originalText: string;
  readonly intermediateEdit: NesStringEdit;
  readonly modelLine: string;
}): boolean {
  if (
    options.localLineIndex >= options.editWindowLines.length ||
    (options.mode === 'cursor' &&
      options.localLineIndex !== options.cursorLineIndex)
  ) {
    return true;
  }
  const originalLine = options.editWindowLines[options.localLineIndex];
  const currentLine = getCurrentLineAfterIntermediateEdit(
    options.originalText,
    options.editWindowStartLine + options.localLineIndex,
    options.intermediateEdit,
  );
  return (
    currentLine === undefined ||
    currentLine === originalLine ||
    isModelLineCompatible(originalLine, currentLine, options.modelLine)
  );
}

function diffLine(before: string, after: string): LineDiff {
  let prefix = 0;
  while (
    prefix < before.length &&
    prefix < after.length &&
    before[prefix] === after[prefix]
  ) {
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
  return {
    startOffset: prefix,
    endOffset: before.length - suffix,
    replaced: before.slice(prefix, before.length - suffix),
    inserted: after.slice(prefix, after.length - suffix),
  };
}

function isTypingCompatible(typed: string, modelText: string): boolean {
  if (modelText.startsWith(typed)) return true;
  return AUTO_CLOSE_PAIRS.has(typed) && isSubsequence(typed, modelText);
}

function isSubsequence(value: string, expected: string): boolean {
  let offset = 0;
  for (const character of value) {
    const found = expected.indexOf(character, offset);
    if (found === -1) return false;
    offset = found + 1;
  }
  return true;
}

function getLineStarts(text: string): readonly number[] {
  const starts = [0];
  const eol = /\r\n|\r|\n/g;
  let match: RegExpExecArray | null;
  while ((match = eol.exec(text)) !== null) {
    starts.push(match.index + match[0].length);
  }
  return starts;
}

function lineAtOffset(text: string, offset: number): string | undefined {
  if (offset < 0 || offset > text.length) return undefined;
  let start = 0;
  const eol = /\r\n|\r|\n/g;
  let match: RegExpExecArray | null;
  while ((match = eol.exec(text)) !== null) {
    if (offset <= match.index) return text.slice(start, match.index);
    start = match.index + match[0].length;
  }
  return text.slice(start);
}

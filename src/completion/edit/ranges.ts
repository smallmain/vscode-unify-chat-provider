import type {
  EditAlgorithmDocument,
  EditAlgorithmSyntaxRange,
} from '../model/requests';
import {
  utf16OffsetToUtf8ByteOffset,
  utf8ByteLength,
  utf8ByteOffsetToUtf16Offset,
  type Utf8Range,
} from './utf8';

export const CURSOR_EXCERPT_TOKEN_BUDGET = 8_192;
export const BYTES_PER_TOKEN_GUESS = 3;

export interface CursorExcerpt {
  readonly text: string;
  readonly utf16Range: Utf8Range;
  readonly byteRange: Utf8Range;
  readonly startRow: number;
  readonly endRow: number;
  readonly cursorByteOffset: number;
}

export interface LegacyExcerptRanges {
  readonly editable150: Utf8Range;
  readonly editable180: Utf8Range;
  readonly editable350: Utf8Range;
  readonly editable512: Utf8Range;
  readonly editable150Context350: Utf8Range;
  readonly editable180Context350: Utf8Range;
  readonly editable350Context150: Utf8Range;
  readonly editable350Context512: Utf8Range;
  readonly editable350Context1024: Utf8Range;
  readonly context4096: Utf8Range;
  readonly context8192: Utf8Range;
}

interface LineIndex {
  readonly utf16Starts: readonly number[];
  readonly byteStarts: readonly number[];
}

function buildLineIndex(text: string): LineIndex {
  const utf16Starts = [0];
  const byteStarts = [0];
  let byteOffset = 0;
  for (let index = 0; index < text.length; ) {
    const codePoint = text.codePointAt(index);
    if (codePoint === undefined) break;
    const character = String.fromCodePoint(codePoint);
    byteOffset += utf8ByteLength(character);
    index += character.length;
    if (codePoint === 10) {
      utf16Starts.push(index);
      byteStarts.push(byteOffset);
    }
  }
  return { utf16Starts, byteStarts };
}

function offsetToRow(starts: readonly number[], offset: number): number {
  let low = 0;
  let high = starts.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if ((starts[middle] ?? 0) <= offset) low = middle + 1;
    else high = middle;
  }
  return Math.max(0, low - 1);
}

function rowEndUtf16(text: string, index: LineIndex, row: number): number {
  const next = index.utf16Starts[row + 1];
  if (next === undefined) return text.length;
  return Math.max(0, next - (text.charCodeAt(next - 2) === 13 ? 2 : 1));
}

function rowEndByte(text: string, index: LineIndex, row: number): number {
  const next = index.byteStarts[row + 1];
  if (next === undefined) return utf8ByteLength(text);
  const nextUtf16 = index.utf16Starts[row + 1] ?? 0;
  return Math.max(0, next - (text.charCodeAt(nextUtf16 - 2) === 13 ? 2 : 1));
}

function estimatedTokens(byteLength: number): number {
  return Math.floor(byteLength / BYTES_PER_TOKEN_GUESS);
}

function lineTokenCount(
  text: string,
  index: LineIndex,
  row: number,
): number {
  const start = index.byteStarts[row] ?? 0;
  return Math.max(estimatedTokens(rowEndByte(text, index, row) - start), 1);
}

function expandSymmetric(
  cursorRow: number,
  maxRow: number,
  tokenBudget: number,
  tokenCountForRow: (row: number) => number,
): { readonly startRow: number; readonly endRow: number; readonly remaining: number } {
  let startRow = cursorRow;
  let endRow = cursorRow;
  let remaining = Math.max(
    0,
    tokenBudget - tokenCountForRow(cursorRow),
  );

  while (remaining > 0 && (startRow > 0 || endRow < maxRow)) {
    if (endRow < maxRow) {
      const tokens = tokenCountForRow(endRow + 1);
      if (tokens > remaining) break;
      endRow += 1;
      remaining -= tokens;
    }
    if (startRow > 0 && remaining > 0) {
      const tokens = tokenCountForRow(startRow - 1);
      if (tokens > remaining) break;
      startRow -= 1;
      remaining -= tokens;
    }
  }
  return { startRow, endRow, remaining };
}

export function computeCursorExcerpt(
  text: string,
  cursorUtf16Offset: number,
): CursorExcerpt {
  const index = buildLineIndex(text);
  const cursorUtf16 = Math.max(0, Math.min(text.length, cursorUtf16Offset));
  const cursorByte = utf16OffsetToUtf8ByteOffset(text, cursorUtf16);
  const cursorRow = offsetToRow(index.utf16Starts, cursorUtf16);
  const maxRow = index.utf16Starts.length - 1;
  const expanded = expandSymmetric(
    cursorRow,
    maxRow,
    CURSOR_EXCERPT_TOKEN_BUDGET,
    (row) => lineTokenCount(text, index, row),
  );
  const utf16Start = index.utf16Starts[expanded.startRow] ?? 0;
  const utf16End = rowEndUtf16(text, index, expanded.endRow);
  const byteStart = index.byteStarts[expanded.startRow] ?? 0;
  const byteEnd = rowEndByte(text, index, expanded.endRow);
  return {
    text: text.slice(utf16Start, utf16End),
    utf16Range: { start: utf16Start, end: utf16End },
    byteRange: { start: byteStart, end: byteEnd },
    startRow: expanded.startRow,
    endRow: expanded.endRow,
    cursorByteOffset: cursorByte - byteStart,
  };
}

export function syntaxRangesInCursorExcerpt(
  document: EditAlgorithmDocument,
  excerpt: CursorExcerpt,
): readonly Utf8Range[] {
  const ranges = document.syntaxRanges ?? [];
  const excerptStart = excerpt.utf16Range.start;
  const excerptEnd = excerpt.utf16Range.end;
  const result: Utf8Range[] = [];
  for (const range of ranges) {
    const start = Math.max(excerptStart, range.startOffset);
    const end = Math.min(excerptEnd, range.endOffset);
    if (end < start) continue;
    result.push({
      start: utf16OffsetToUtf8ByteOffset(
        document.text,
        start,
      ) - excerpt.byteRange.start,
      end: utf16OffsetToUtf8ByteOffset(
        document.text,
        end,
      ) - excerpt.byteRange.start,
    });
  }
  return result;
}

function computeLineStarts(text: string): number[] {
  const starts = [0];
  let byteOffset = 0;
  for (const character of text) {
    byteOffset += utf8ByteLength(character);
    if (character === '\n') starts.push(byteOffset);
  }
  return starts;
}

function rowStartOffset(lineStarts: readonly number[], row: number): number {
  return lineStarts[row] ?? 0;
}

function rowEndOffset(
  text: string,
  textByteLength: number,
  lineStarts: readonly number[],
  row: number,
): number {
  const next = lineStarts[row + 1];
  if (next === undefined) return textByteLength;
  const nextUtf16 = utf8ByteOffsetToUtf16Offset(text, next) ?? 0;
  const newlineBytes = text.charCodeAt(nextUtf16 - 2) === 13 ? 2 : 1;
  return Math.min(textByteLength, Math.max(0, next - newlineBytes));
}

function estimateTokensForRows(
  text: string,
  textByteLength: number,
  lineStarts: readonly number[],
  startRow: number,
  endRowExclusive: number,
): number {
  let tokens = 0;
  for (let row = startRow; row < endRowExclusive; row += 1) {
    tokens += Math.max(
      estimatedTokens(
        rowEndOffset(text, textByteLength, lineStarts, row) -
          rowStartOffset(lineStarts, row),
      ),
      1,
    );
  }
  return tokens;
}

function containingSyntaxBoundaries(
  lineStarts: readonly number[],
  syntaxRanges: readonly Utf8Range[],
  startRow: number,
  endRow: number,
): readonly { readonly start: number; readonly end: number }[] {
  const boundaries: { start: number; end: number }[] = [];
  let lastStart = -1;
  let lastEnd = -1;
  for (const range of syntaxRanges) {
    const nodeStart = offsetToRow(lineStarts, range.start);
    const nodeEnd = offsetToRow(lineStarts, range.end);
    if (nodeStart >= startRow && nodeEnd <= endRow) continue;
    if (nodeStart === lastStart && nodeEnd === lastEnd) continue;
    boundaries.push({ start: nodeStart, end: nodeEnd });
    lastStart = nodeStart;
    lastEnd = nodeEnd;
  }
  return boundaries;
}

function expandLinewise(
  text: string,
  textByteLength: number,
  lineStarts: readonly number[],
  start: number,
  end: number,
  maxRow: number,
  budget: number,
  preferUp: boolean,
): { readonly start: number; readonly end: number; readonly remaining: number } {
  let startRow = start;
  let endRow = end;
  let remaining = budget;
  const tryUp = (): boolean => {
    if (startRow <= 0) return false;
    const tokens = estimateTokensForRows(
      text,
      textByteLength,
      lineStarts,
      startRow - 1,
      startRow,
    );
    if (tokens > remaining) return false;
    startRow -= 1;
    remaining -= tokens;
    return true;
  };
  const tryDown = (): boolean => {
    if (endRow >= maxRow) return false;
    const tokens = estimateTokensForRows(
      text,
      textByteLength,
      lineStarts,
      endRow + 1,
      endRow + 2,
    );
    if (tokens > remaining) return false;
    endRow += 1;
    remaining -= tokens;
    return true;
  };
  while (remaining > 0 && (startRow > 0 || endRow < maxRow)) {
    const first = preferUp ? tryUp() : tryDown();
    const second = remaining > 0 ? (preferUp ? tryDown() : tryUp()) : false;
    if (!first && !second) break;
  }
  return { start: startRow, end: endRow, remaining };
}

function byteRangeForRows(
  text: string,
  textByteLength: number,
  lineStarts: readonly number[],
  startRow: number,
  endRow: number,
): Utf8Range {
  return {
    start: rowStartOffset(lineStarts, startRow),
    end: rowEndOffset(text, textByteLength, lineStarts, endRow),
  };
}

export function computeEditableAndContextRanges(
  text: string,
  cursorByteOffset: number,
  syntaxRanges: readonly Utf8Range[],
  editableTokenLimit: number,
  contextTokenLimit: number,
): { readonly editable: Utf8Range; readonly context: Utf8Range } {
  const lineStarts = computeLineStarts(text);
  const textByteLength = utf8ByteLength(text);
  const maxRow = lineStarts.length - 1;
  const cursorRow = offsetToRow(lineStarts, cursorByteOffset);
  const initialBudget = Math.floor((editableTokenLimit * 3) / 4);
  const initial = expandSymmetric(
    cursorRow,
    maxRow,
    initialBudget,
    (row) =>
      Math.max(
        estimateTokensForRows(
          text,
          textByteLength,
          lineStarts,
          row,
          row + 1,
        ),
        1,
      ),
  );
  let startRow = initial.startRow;
  let endRow = initial.endRow;
  let remaining =
    initial.remaining + Math.max(0, editableTokenLimit - initialBudget);
  const originalStart = startRow;
  const originalEnd = endRow;

  for (const boundary of containingSyntaxBoundaries(
    lineStarts,
    syntaxRanges,
    startRow,
    endRow,
  )) {
    const startTokens =
      boundary.start < startRow
        ? estimateTokensForRows(
            text,
            textByteLength,
            lineStarts,
            boundary.start,
            startRow,
          )
        : 0;
    const endTokens =
      boundary.end > endRow
        ? estimateTokensForRows(
            text,
            textByteLength,
            lineStarts,
            endRow + 1,
            boundary.end + 1,
          )
        : 0;
    const needed = startTokens + endTokens;
    if (needed > remaining) break;
    startRow = Math.min(startRow, boundary.start);
    endRow = Math.max(endRow, boundary.end);
    remaining -= needed;
  }
  const editableExpanded = expandLinewise(
    text,
    textByteLength,
    lineStarts,
    startRow,
    endRow,
    maxRow,
    remaining,
    originalStart - startRow <= endRow - originalEnd,
  );
  const editable = byteRangeForRows(
    text,
    textByteLength,
    lineStarts,
    editableExpanded.start,
    editableExpanded.end,
  );

  startRow = offsetToRow(lineStarts, editable.start);
  endRow = offsetToRow(lineStarts, editable.end);
  remaining = contextTokenLimit;
  let syntaxExpanded = false;
  for (const boundary of containingSyntaxBoundaries(
    lineStarts,
    syntaxRanges,
    startRow,
    endRow,
  )) {
    const startTokens =
      boundary.start < startRow
        ? estimateTokensForRows(
            text,
            textByteLength,
            lineStarts,
            boundary.start,
            startRow,
          )
        : 0;
    const endTokens =
      boundary.end > endRow
        ? estimateTokensForRows(
            text,
            textByteLength,
            lineStarts,
            endRow + 1,
            boundary.end + 1,
          )
        : 0;
    const needed = startTokens + endTokens;
    if (needed > remaining) break;
    startRow = Math.min(startRow, boundary.start);
    endRow = Math.max(endRow, boundary.end);
    remaining -= needed;
    syntaxExpanded = true;
  }
  if (!syntaxExpanded) {
    const expanded = expandLinewise(
      text,
      textByteLength,
      lineStarts,
      startRow,
      endRow,
      maxRow,
      remaining,
      true,
    );
    startRow = expanded.start;
    endRow = expanded.end;
  }
  return {
    editable,
    context: byteRangeForRows(
      text,
      textByteLength,
      lineStarts,
      startRow,
      endRow,
    ),
  };
}

export function computeLegacyExcerptRanges(
  text: string,
  cursorByteOffset: number,
  syntaxRanges: readonly Utf8Range[],
): LegacyExcerptRanges {
  const editable150 = computeEditableAndContextRanges(
    text,
    cursorByteOffset,
    syntaxRanges,
    150,
    350,
  );
  const editable180 = computeEditableAndContextRanges(
    text,
    cursorByteOffset,
    syntaxRanges,
    180,
    350,
  );
  const editable350 = computeEditableAndContextRanges(
    text,
    cursorByteOffset,
    syntaxRanges,
    350,
    150,
  );
  const editable512 = computeEditableAndContextRanges(
    text,
    cursorByteOffset,
    syntaxRanges,
    512,
    0,
  );
  const context512 = computeEditableAndContextRanges(
    text,
    cursorByteOffset,
    syntaxRanges,
    350,
    512,
  );
  const context1024 = computeEditableAndContextRanges(
    text,
    cursorByteOffset,
    syntaxRanges,
    350,
    1_024,
  );
  const context4096 = computeEditableAndContextRanges(
    text,
    cursorByteOffset,
    syntaxRanges,
    350,
    4_096,
  );
  const context8192 = computeEditableAndContextRanges(
    text,
    cursorByteOffset,
    syntaxRanges,
    350,
    8_192,
  );
  return {
    editable150: editable150.editable,
    editable180: editable180.editable,
    editable350: editable350.editable,
    editable512: editable512.editable,
    editable150Context350: editable150.context,
    editable180Context350: editable180.context,
    editable350Context150: editable350.context,
    editable350Context512: context512.context,
    editable350Context1024: context1024.context,
    context4096: context4096.context,
    context8192: context8192.context,
  };
}

export interface DocumentLegacyRanges {
  readonly excerpt: CursorExcerpt;
  readonly syntaxRanges: readonly Utf8Range[];
  readonly ranges: LegacyExcerptRanges;
}

export function computeDocumentLegacyRanges(
  document: EditAlgorithmDocument,
): DocumentLegacyRanges {
  const excerpt = computeCursorExcerpt(document.text, document.cursorOffset);
  const syntaxRanges = syntaxRangesInCursorExcerpt(document, excerpt);
  return {
    excerpt,
    syntaxRanges,
    ranges: computeLegacyExcerptRanges(
      excerpt.text,
      excerpt.cursorByteOffset,
      syntaxRanges,
    ),
  };
}

export function excerptByteRangeToDocumentUtf16Range(
  selection: DocumentLegacyRanges,
  range: Utf8Range,
): Utf8Range | undefined {
  const startInExcerpt = utf8ByteOffsetToUtf16Offset(
    selection.excerpt.text,
    range.start,
  );
  const endInExcerpt = utf8ByteOffsetToUtf16Offset(
    selection.excerpt.text,
    range.end,
  );
  return startInExcerpt === undefined || endInExcerpt === undefined
    ? undefined
    : {
        start: selection.excerpt.utf16Range.start + startInExcerpt,
        end: selection.excerpt.utf16Range.start + endInExcerpt,
      };
}

export function utf16SyntaxRangeToByteRange(
  text: string,
  range: EditAlgorithmSyntaxRange,
): Utf8Range {
  return {
    start: utf16OffsetToUtf8ByteOffset(text, range.startOffset),
    end: utf16OffsetToUtf8ByteOffset(text, range.endOffset),
  };
}

export interface Utf8Range {
  readonly start: number;
  readonly end: number;
}

export function utf8ByteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

export function utf16OffsetToUtf8ByteOffset(
  text: string,
  offset: number,
): number {
  const clamped = Math.max(0, Math.min(text.length, offset));
  return utf8ByteLength(text.slice(0, clamped));
}

export function utf8ByteOffsetToUtf16Offset(
  text: string,
  byteOffset: number,
): number | undefined {
  if (!Number.isSafeInteger(byteOffset) || byteOffset < 0) {
    return undefined;
  }
  if (byteOffset === 0) return 0;

  let bytes = 0;
  let utf16Offset = 0;
  for (const character of text) {
    bytes += utf8ByteLength(character);
    utf16Offset += character.length;
    if (bytes === byteOffset) return utf16Offset;
    if (bytes > byteOffset) return undefined;
  }
  return bytes === byteOffset ? utf16Offset : undefined;
}

export function utf8ByteRangeToUtf16Range(
  text: string,
  range: Utf8Range,
): Utf8Range | undefined {
  if (range.end < range.start) return undefined;
  const start = utf8ByteOffsetToUtf16Offset(text, range.start);
  const end = utf8ByteOffsetToUtf16Offset(text, range.end);
  return start === undefined || end === undefined ? undefined : { start, end };
}

export function utf16RangeToUtf8ByteRange(
  text: string,
  range: Utf8Range,
): Utf8Range {
  return {
    start: utf16OffsetToUtf8ByteOffset(text, range.start),
    end: utf16OffsetToUtf8ByteOffset(text, range.end),
  };
}

export function utf16OffsetToUtf8Point(
  text: string,
  offset: number,
): { readonly row: number; readonly column: number } {
  const clamped = Math.max(0, Math.min(text.length, offset));
  const rowStart = text.lastIndexOf('\n', Math.max(0, clamped - 1)) + 1;
  let row = 0;
  for (let index = 0; index < rowStart; index += 1) {
    if (text.charCodeAt(index) === 10) row += 1;
  }
  return {
    row,
    column: utf8ByteLength(text.slice(rowStart, clamped)),
  };
}

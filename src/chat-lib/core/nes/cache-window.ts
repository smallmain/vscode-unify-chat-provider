export interface NesOffsetWindow {
  readonly startOffset: number;
  readonly endOffset: number;
}

interface TextLines {
  readonly starts: readonly number[];
  readonly ends: readonly number[];
}

export function computeReducedNesWindow(
  text: string,
  window: NesOffsetWindow,
  cursorOffset: number,
): NesOffsetWindow {
  const lines = textLines(text);
  const cursor = positionAt(lines, cursorOffset);
  const windowStart = positionAt(lines, window.startOffset);
  const reducedStart = offsetAt(lines, windowStart.line + 1, windowStart.column);
  const windowEnd = positionAt(lines, window.endOffset);
  const reducedEndLine = Math.max(0, windowEnd.line - 2);
  const reducedEnd =
    windowEnd.column > 0
      ? lines.ends[Math.min(reducedEndLine, lines.ends.length - 1)]
      : offsetAt(lines, reducedEndLine, 0);
  return {
    startOffset: Math.min(reducedStart, lines.starts[cursor.line]),
    endOffset: Math.max(reducedEnd, lines.ends[cursor.line]),
  };
}

export function cursorAfterNesEditWindow(
  text: string,
  endOffset: number,
): number {
  if (!text) return 0;
  const lines = textLines(text);
  const position = positionAt(
    lines,
    Math.max(0, Math.min(text.length, endOffset - 1)),
  );
  return position.line + 1 < lines.starts.length
    ? lines.starts[position.line + 1]
    : lines.starts[position.line];
}

function textLines(text: string): TextLines {
  const starts = [0];
  const ends: number[] = [];
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== '\n') continue;
    ends.push(index > 0 && text[index - 1] === '\r' ? index - 1 : index);
    starts.push(index + 1);
  }
  ends.push(text.length);
  return { starts, ends };
}

function positionAt(
  lines: TextLines,
  rawOffset: number,
): { readonly line: number; readonly column: number } {
  const offset = Math.max(
    0,
    Math.min(rawOffset, lines.ends[lines.ends.length - 1]),
  );
  let line = 0;
  while (line + 1 < lines.starts.length && lines.starts[line + 1] <= offset) {
    line += 1;
  }
  return { line, column: offset - lines.starts[line] };
}

function offsetAt(lines: TextLines, rawLine: number, rawColumn: number): number {
  const line = Math.max(0, Math.min(rawLine, lines.starts.length - 1));
  const lineLength = lines.ends[line] - lines.starts[line];
  return lines.starts[line] + Math.max(0, Math.min(rawColumn, lineLength));
}

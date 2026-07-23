// Ported from microsoft/vscode@fc3def6774c76082adf699d366f31a557ce5573f:
// extensions/copilot/src/extension/inlineEdits/common/informationDelta.tsx

const UNDO_NGRAM_RATIO = 0.7;

export interface OffsetTextReplacement {
  readonly startOffset: number;
  readonly endOffset: number;
  readonly newText: string;
}

interface NormalizedReplacement {
  readonly start: number;
  readonly end: number;
  readonly newText: string;
}

export class InformationDelta {
  constructor(
    readonly inserted: ReadonlySet<string> = new Set<string>(),
    readonly deleted: ReadonlySet<string> = new Set<string>(),
  ) {}

  combine(other: InformationDelta): InformationDelta {
    return new InformationDelta(
      new Set([...this.inserted, ...other.inserted]),
      new Set([...this.deleted, ...other.deleted]),
    );
  }

  isUndoneBy(other: InformationDelta): boolean {
    const otherReallyInserted = setMinus(other.inserted, other.deleted);
    const otherReallyDeleted = setMinus(other.deleted, other.inserted);
    const deletesMyInsertions = intersectionCount(
      otherReallyDeleted,
      this.inserted,
    );
    const insertsMyDeletions = intersectionCount(
      otherReallyInserted,
      this.deleted,
    );
    return (
      (otherReallyDeleted.size > 6 &&
        deletesMyInsertions / otherReallyDeleted.size > UNDO_NGRAM_RATIO) ||
      (otherReallyInserted.size > 6 &&
        insertsMyDeletions / otherReallyInserted.size > UNDO_NGRAM_RATIO)
    );
  }
}

export function getInformationDelta(
  source: string,
  replacements: OffsetTextReplacement | readonly OffsetTextReplacement[],
): InformationDelta {
  const inserted = new Set<string>();
  const deleted = new Set<string>();
  const edits = Array.isArray(replacements) ? replacements : [replacements];
  for (const edit of edits) {
    const replacement = {
      start: edit.startOffset,
      end: edit.endOffset,
      newText: edit.newText,
    };
    const prefixFirst = removeCommonSuffix(
      removeCommonPrefix(replacement, source),
      source,
    );
    const suffixFirst = removeCommonPrefix(
      removeCommonSuffix(replacement, source),
      source,
    );
    if (
      prefixFirst.start === prefixFirst.end &&
      prefixFirst.newText.length === 0
    ) {
      continue;
    }
    addDeletedNgrams(source, prefixFirst.start, prefixFirst.end, deleted);
    addDeletedNgrams(source, suffixFirst.start, suffixFirst.end, deleted);
    addDeletedNgrams(
      source,
      Math.max(prefixFirst.start, suffixFirst.start),
      Math.min(prefixFirst.end, suffixFirst.end),
      deleted,
    );
    addInsertedNgrams(
      trimOverlap(prefixFirst.newText, suffixFirst.newText),
      inserted,
    );
  }
  return new InformationDelta(inserted, deleted);
}

export function applyOffsetTextReplacements(
  source: string,
  replacements: readonly OffsetTextReplacement[],
): string {
  let result = source;
  for (const replacement of [...replacements].sort(
    (left, right) => right.startOffset - left.startOffset,
  )) {
    result = `${result.slice(0, replacement.startOffset)}${replacement.newText}${result.slice(replacement.endOffset)}`;
  }
  return result;
}

function removeCommonPrefix(
  replacement: NormalizedReplacement,
  source: string,
): NormalizedReplacement {
  const oldText = source.slice(replacement.start, replacement.end);
  const length = commonPrefixLength(oldText, replacement.newText);
  return length === 0
    ? replacement
    : {
        start: replacement.start + length,
        end: replacement.end,
        newText: replacement.newText.slice(length),
      };
}

function removeCommonSuffix(
  replacement: NormalizedReplacement,
  source: string,
): NormalizedReplacement {
  const oldText = source.slice(replacement.start, replacement.end);
  const length = commonSuffixLength(oldText, replacement.newText);
  return length === 0
    ? replacement
    : {
        start: replacement.start,
        end: replacement.end - length,
        newText: replacement.newText.slice(0, -length),
      };
}

function commonPrefixLength(left: string, right: string): number {
  const limit = Math.min(left.length, right.length);
  let index = 0;
  while (index < limit && left[index] === right[index]) {
    index += 1;
  }
  return index;
}

function commonSuffixLength(left: string, right: string): number {
  const limit = Math.min(left.length, right.length);
  let index = 0;
  while (
    index < limit &&
    left[left.length - index - 1] === right[right.length - index - 1]
  ) {
    index += 1;
  }
  return index;
}

function trimOverlap(endSource: string, startSource: string): string {
  const length = Math.min(endSource.length, startSource.length);
  for (let trimLength = 0; trimLength < length; trimLength += 1) {
    const endTrimmed = endSource.slice(0, endSource.length - trimLength);
    const startTrimmed = startSource.slice(trimLength);
    if (endTrimmed === startTrimmed) {
      return endTrimmed;
    }
  }
  return '';
}

function addDeletedNgrams(
  source: string,
  start: number,
  end: number,
  target: Set<string>,
): void {
  if (start > end) {
    return;
  }
  addInsertedNgrams(source.slice(start, end), target);
}

function addInsertedNgrams(text: string, target: Set<string>): void {
  for (let line of text.split(/\r\n|\r|\n/)) {
    line = line.trim();
    for (let index = 4; index < line.length; index += 1) {
      target.add(line.slice(index - 4, index));
    }
  }
}

function setMinus(
  left: ReadonlySet<string>,
  right: ReadonlySet<string>,
): Set<string> {
  return new Set([...left].filter((value) => !right.has(value)));
}

function intersectionCount(
  left: ReadonlySet<string>,
  right: ReadonlySet<string>,
): number {
  let count = 0;
  for (const value of left) {
    if (right.has(value)) {
      count += 1;
    }
  }
  return count;
}

import { DefaultLinesDiffComputer } from '../src/chat-lib/upstream/util/vs/editor/common/diff/defaultLinesDiffComputer/defaultLinesDiffComputer';
import { StringText } from '../src/chat-lib/upstream/util/vs/editor/common/core/text/abstractText';
import { ensureDependenciesAreSet } from '../src/chat-lib/upstream/util/vs/editor/common/core/text/positionToOffset';
import { MyersDiffAlgorithm } from '../src/chat-lib/upstream/util/vs/editor/common/diff/defaultLinesDiffComputer/algorithms/myersDiffAlgorithm';
import type { ISequence } from '../src/chat-lib/upstream/util/vs/editor/common/diff/defaultLinesDiffComputer/algorithms/diffAlgorithm';

export interface DetailedDiffChange {
  readonly startOffset: number;
  readonly endOffset: number;
  readonly newText: string;
}

const PRECISE_DIFF_CELL_LIMIT = 1_000_000;

class CodePointSequence implements ISequence {
  private readonly values: readonly number[];
  private readonly utf16Offsets: readonly number[];

  constructor(text: string) {
    const values: number[] = [];
    const utf16Offsets = [0];
    let offset = 0;
    for (const character of text) {
      values.push(character.codePointAt(0) ?? -1);
      offset += character.length;
      utf16Offsets.push(offset);
    }
    this.values = values;
    this.utf16Offsets = utf16Offsets;
  }

  get length(): number {
    return this.values.length;
  }

  getElement(offset: number): number {
    return this.values[offset] ?? -1;
  }

  isStronglyEqual(offset1: number, offset2: number): boolean {
    return this.getElement(offset1) === this.getElement(offset2);
  }

  utf16Offset(offset: number): number {
    return this.utf16Offsets[offset] ?? this.utf16Offsets.at(-1) ?? 0;
  }
}

ensureDependenciesAreSet();

export function computeDetailedChanges(
  original: string,
  modified: string,
): readonly DetailedDiffChange[] | undefined {
  const result = new DefaultLinesDiffComputer().computeDiff(
    original.split(/\r\n|\r|\n/),
    modified.split(/\r\n|\r|\n/),
    {
      ignoreTrimWhitespace: false,
      computeMoves: false,
      extendToSubwords: true,
      maxComputationTimeMs: 500,
    },
  );
  if (result.hitTimeout) return undefined;

  const originalText = new StringText(original);
  const modifiedText = new StringText(modified);
  return result.changes.flatMap((change) =>
    (change.innerChanges ?? []).map((innerChange) => {
      const originalRange = originalText
        .getTransformer()
        .getOffsetRange(innerChange.originalRange);
      return {
        startOffset: originalRange.start,
        endOffset: originalRange.endExclusive,
        newText: modifiedText.getValueOfRange(innerChange.modifiedRange),
      };
    }),
  );
}

export function computePreciseChanges(
  original: string,
  modified: string,
): readonly DetailedDiffChange[] | undefined {
  const originalSequence = new CodePointSequence(original);
  const modifiedSequence = new CodePointSequence(modified);
  if (
    originalSequence.length > 0 &&
    modifiedSequence.length > 0 &&
    originalSequence.length * modifiedSequence.length > PRECISE_DIFF_CELL_LIMIT
  ) {
    return undefined;
  }
  const result = new MyersDiffAlgorithm().compute(
    originalSequence,
    modifiedSequence,
  );
  if (result.hitTimeout) return undefined;
  return result.diffs.map((diff) => {
    const startOffset = originalSequence.utf16Offset(diff.seq1Range.start);
    const endOffset = originalSequence.utf16Offset(
      diff.seq1Range.endExclusive,
    );
    const modifiedStart = modifiedSequence.utf16Offset(diff.seq2Range.start);
    const modifiedEnd = modifiedSequence.utf16Offset(
      diff.seq2Range.endExclusive,
    );
    return {
      startOffset,
      endOffset,
      newText: modified.slice(modifiedStart, modifiedEnd),
    };
  });
}

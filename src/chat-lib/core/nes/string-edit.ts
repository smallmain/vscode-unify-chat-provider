// Host-neutral port of VS Code's StringEdit offset semantics.

export interface NesOffsetRange {
  readonly start: number;
  readonly endOffset: number;
}

export class NesStringReplacement {
  constructor(
    readonly range: NesOffsetRange,
    readonly newText: string,
  ) {
    if (range.start > range.endOffset) {
      throw new Error("String replacement range is invalid.");
    }
  }

  get oldLength(): number {
    return this.range.endOffset - this.range.start;
  }

  get lengthDelta(): number {
    return this.newText.length - this.oldLength;
  }

  delta(offset: number): NesStringReplacement {
    return new NesStringReplacement(
      {
        start: this.range.start + offset,
        endOffset: this.range.endOffset + offset,
      },
      this.newText,
    );
  }

  slice(
    range: NesOffsetRange,
    newTextRange?: NesOffsetRange,
  ): NesStringReplacement {
    return new NesStringReplacement(
      range,
      newTextRange
        ? this.newText.slice(newTextRange.start, newTextRange.endOffset)
        : this.newText,
    );
  }

  removeCommonSuffixAndPrefix(source: string): NesStringReplacement {
    const original = source.slice(this.range.start, this.range.endOffset);
    let suffix = 0;
    while (
      suffix < original.length &&
      suffix < this.newText.length &&
      original[original.length - suffix - 1] ===
        this.newText[this.newText.length - suffix - 1]
    ) {
      suffix += 1;
    }
    const suffixTrimmedOriginal = original.slice(0, original.length - suffix);
    const suffixTrimmedNewText = this.newText.slice(
      0,
      this.newText.length - suffix,
    );
    let prefix = 0;
    while (
      prefix < suffixTrimmedOriginal.length &&
      prefix < suffixTrimmedNewText.length &&
      suffixTrimmedOriginal[prefix] === suffixTrimmedNewText[prefix]
    ) {
      prefix += 1;
    }
    return new NesStringReplacement(
      {
        start: this.range.start + prefix,
        endOffset: this.range.endOffset - suffix,
      },
      suffixTrimmedNewText.slice(prefix),
    );
  }
}

export class NesStringEdit {
  static readonly empty = new NesStringEdit([]);

  static single(replacement: NesStringReplacement): NesStringEdit {
    return new NesStringEdit([replacement]);
  }

  static fromDiff(original: string, current: string): NesStringEdit {
    if (original === current) {
      return NesStringEdit.empty;
    }
    let prefix = 0;
    while (
      prefix < original.length &&
      prefix < current.length &&
      original[prefix] === current[prefix]
    ) {
      prefix += 1;
    }
    let suffix = 0;
    while (
      suffix < original.length - prefix &&
      suffix < current.length - prefix &&
      original[original.length - suffix - 1] ===
        current[current.length - suffix - 1]
    ) {
      suffix += 1;
    }
    return NesStringEdit.single(
      new NesStringReplacement(
        {
          start: prefix,
          endOffset: original.length - suffix,
        },
        current.slice(prefix, current.length - suffix),
      ),
    );
  }

  constructor(readonly replacements: readonly NesStringReplacement[]) {
    let previousEnd = -1;
    for (const replacement of replacements) {
      if (replacement.range.start < previousEnd) {
        throw new Error("String replacements must be sorted and disjoint.");
      }
      previousEnd = replacement.range.endOffset;
    }
  }

  isEmpty(): boolean {
    return this.replacements.length === 0;
  }

  apply(source: string): string {
    const parts: string[] = [];
    let offset = 0;
    for (const replacement of this.replacements) {
      parts.push(source.slice(offset, replacement.range.start));
      parts.push(replacement.newText);
      offset = replacement.range.endOffset;
    }
    parts.push(source.slice(offset));
    return parts.join("");
  }

  normalize(): NesStringEdit {
    const normalized: NesStringReplacement[] = [];
    for (const replacement of this.replacements) {
      if (replacement.oldLength === 0 && replacement.newText.length === 0) {
        continue;
      }
      const previous = normalized.at(-1);
      if (previous?.range.endOffset === replacement.range.start) {
        normalized[normalized.length - 1] = new NesStringReplacement(
          {
            start: previous.range.start,
            endOffset: replacement.range.endOffset,
          },
          previous.newText + replacement.newText,
        );
      } else {
        normalized.push(replacement);
      }
    }
    return new NesStringEdit(normalized);
  }

  removeCommonSuffixAndPrefix(source: string): NesStringEdit {
    return new NesStringEdit(
      this.replacements.map((replacement) =>
        replacement.removeCommonSuffixAndPrefix(source),
      ),
    ).normalize();
  }

  compose(other: NesStringEdit): NesStringEdit {
    const first = this.normalize();
    const second = other.normalize();
    if (first.isEmpty()) return second;
    if (second.isEmpty()) return first;

    const firstQueue = [...first.replacements];
    const result: NesStringReplacement[] = [];
    let firstToSecond = 0;

    for (const secondReplacement of second.replacements) {
      while (true) {
        const firstReplacement = firstQueue[0];
        if (
          !firstReplacement ||
          firstReplacement.range.start +
            firstToSecond +
            firstReplacement.newText.length >=
            secondReplacement.range.start
        ) {
          break;
        }
        firstQueue.shift();
        result.push(firstReplacement);
        firstToSecond += firstReplacement.lengthDelta;
      }

      const initialFirstToSecond = firstToSecond;
      let firstIntersecting: NesStringReplacement | undefined;
      let lastIntersecting: NesStringReplacement | undefined;
      while (true) {
        const firstReplacement = firstQueue[0];
        if (
          !firstReplacement ||
          firstReplacement.range.start + firstToSecond >
            secondReplacement.range.endOffset
        ) {
          break;
        }
        firstIntersecting ??= firstReplacement;
        lastIntersecting = firstReplacement;
        firstQueue.shift();
        firstToSecond += firstReplacement.lengthDelta;
      }

      if (!firstIntersecting) {
        result.push(secondReplacement.delta(-firstToSecond));
        continue;
      }

      const replaceStart = Math.min(
        firstIntersecting.range.start,
        secondReplacement.range.start - initialFirstToSecond,
      );
      const prefixLength =
        secondReplacement.range.start -
        (firstIntersecting.range.start + initialFirstToSecond);
      if (prefixLength > 0) {
        result.push(
          firstIntersecting.slice(
            { start: replaceStart, endOffset: replaceStart },
            { start: 0, endOffset: prefixLength },
          ),
        );
      }
      if (!lastIntersecting) {
        throw new Error("String edit compose invariant failed.");
      }
      const suffixLength =
        lastIntersecting.range.endOffset +
        firstToSecond -
        secondReplacement.range.endOffset;
      if (suffixLength > 0) {
        const suffix = lastIntersecting.slice(
          {
            start: lastIntersecting.range.endOffset,
            endOffset: lastIntersecting.range.endOffset,
          },
          {
            start: lastIntersecting.newText.length - suffixLength,
            endOffset: lastIntersecting.newText.length,
          },
        );
        firstQueue.unshift(suffix);
        firstToSecond -= suffix.lengthDelta;
      }
      result.push(
        secondReplacement.slice({
          start: replaceStart,
          endOffset: secondReplacement.range.endOffset - firstToSecond,
        }),
      );
    }

    result.push(...firstQueue);
    return new NesStringEdit(result).normalize();
  }

  tryRebase(base: NesStringEdit): NesStringEdit | undefined {
    const rebased: NesStringReplacement[] = [];
    let baseIndex = 0;
    let ourIndex = 0;
    let offset = 0;
    while (
      ourIndex < this.replacements.length ||
      baseIndex < base.replacements.length
    ) {
      const baseReplacement = base.replacements[baseIndex];
      const ourReplacement = this.replacements[ourIndex];
      if (!ourReplacement) {
        break;
      }
      if (!baseReplacement) {
        rebased.push(ourReplacement.delta(offset));
        ourIndex += 1;
        continue;
      }
      if (rangesConflict(ourReplacement.range, baseReplacement.range)) {
        return undefined;
      }
      if (
        ourReplacement.range.start < baseReplacement.range.start ||
        (isEmptyRange(ourReplacement.range) &&
          ourReplacement.range.start === baseReplacement.range.start)
      ) {
        rebased.push(ourReplacement.delta(offset));
        ourIndex += 1;
      } else {
        baseIndex += 1;
        offset += baseReplacement.lengthDelta;
      }
    }
    return new NesStringEdit(rebased);
  }

  applyToOffset(offset: number): number {
    let delta = 0;
    for (const replacement of this.replacements) {
      if (replacement.range.start > offset) break;
      if (offset < replacement.range.endOffset) {
        return replacement.range.start + delta;
      }
      delta += replacement.lengthDelta;
    }
    return offset + delta;
  }

  applyToOffsetOrUndefined(offset: number): number | undefined {
    let delta = 0;
    for (const replacement of this.replacements) {
      if (replacement.range.start > offset) break;
      if (offset < replacement.range.endOffset) {
        return undefined;
      }
      delta += replacement.lengthDelta;
    }
    return offset + delta;
  }

  applyToOffsetRangeOrUndefined(
    range: NesOffsetRange,
  ): NesOffsetRange | undefined {
    const start = this.applyToOffsetOrUndefined(range.start);
    const endOffset = this.applyToOffsetOrUndefined(range.endOffset);
    return start === undefined || endOffset === undefined
      ? undefined
      : { start, endOffset };
  }
}

export function hasUserTypedSinceNesRequestStarted(
  userEdit: NesStringEdit | undefined,
): boolean {
  return userEdit === undefined || !userEdit.isEmpty();
}

function isEmptyRange(range: NesOffsetRange): boolean {
  return range.start === range.endOffset;
}

function rangesIntersect(left: NesOffsetRange, right: NesOffsetRange): boolean {
  return (
    Math.max(left.start, right.start) <
    Math.min(left.endOffset, right.endOffset)
  );
}

function rangesConflict(left: NesOffsetRange, right: NesOffsetRange): boolean {
  const concurrentInserts =
    isEmptyRange(left) && isEmptyRange(right) && left.start === right.start;
  const leftInsideRight =
    isEmptyRange(left) &&
    right.start < left.start &&
    left.start < right.endOffset;
  const rightInsideLeft =
    isEmptyRange(right) &&
    left.start < right.start &&
    right.start < left.endOffset;
  return (
    rangesIntersect(left, right) ||
    concurrentInserts ||
    leftInsideRight ||
    rightInsideLeft
  );
}

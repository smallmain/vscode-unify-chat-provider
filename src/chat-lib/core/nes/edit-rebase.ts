import type { NesTextEdit } from './types';
import { computeNesDetailedChanges } from './diff-runtime';
import {
  NesStringEdit,
  NesStringReplacement,
  type NesOffsetRange,
} from './string-edit';

export interface NesRebaseConfig {
  readonly absorbSubsequenceTyping: boolean;
  readonly reverseAgreement: boolean;
  readonly maxImperfectAgreementLength: number;
}

export type NesRebaseResult =
  | { readonly kind: 'success'; readonly edits: readonly NesTextEdit[] }
  | { readonly kind: 'outsideEditWindow' }
  | { readonly kind: 'rebaseFailed' }
  | { readonly kind: 'inconsistentEdits' }
  | { readonly kind: 'error' };

interface IndexedReplacement {
  readonly replacement: NesStringReplacement;
  readonly index: number;
}

const MAX_AGREEMENT_OFFSET = 10;
const AUTO_CLOSE_PAIRS = new Set(['()', '[]', '{}', '<>', '""', "''", '``']);

export function tryRebaseNesEdits(
  originalDocument: string,
  editWindow: NesOffsetRange | undefined,
  originalEdits: readonly NesTextEdit[],
  userEditSince: NesStringEdit,
  currentDocument: string,
  cursorOffset: number | undefined,
  resolution: 'strict' | 'lenient',
  config: NesRebaseConfig,
): NesRebaseResult {
  try {
    if (userEditSince.apply(originalDocument) !== currentDocument) {
      return { kind: 'inconsistentEdits' };
    }
    const normalizedUserEdit =
      userEditSince.removeCommonSuffixAndPrefix(originalDocument);
    if (editWindow && cursorOffset !== undefined) {
      const updatedWindow =
        normalizedUserEdit.applyToOffsetRangeOrUndefined(editWindow);
      if (
        !updatedWindow ||
        cursorOffset < updatedWindow.start ||
        cursorOffset > updatedWindow.endOffset
      ) {
        return { kind: 'outsideEditWindow' };
      }
    }

    let indexed: readonly IndexedReplacement[] = [];
    let intermediateDocument = originalDocument;
    for (const [index, edit] of originalEdits.entries()) {
      if (
        edit.startOffset < 0 ||
        edit.endOffset < edit.startOffset ||
        edit.endOffset > intermediateDocument.length
      ) {
        throw new Error('Sequential NES edit range is invalid.');
      }
      const detailed = detailedReplacements(intermediateDocument, edit, index);
      indexed = composeIndexedEdits(indexed, detailed);
      intermediateDocument = applyNesEdit(intermediateDocument, edit);
    }
    const rebased = rebaseIndexedReplacements(
      originalDocument,
      indexed,
      normalizedUserEdit,
      resolution,
      config,
    );
    if (!rebased) {
      return { kind: 'rebaseFailed' };
    }

    const grouped = new Map<number, NesStringReplacement[]>();
    for (const item of rebased) {
      const replacements = grouped.get(item.index) ?? [];
      replacements.push(item.replacement);
      grouped.set(item.index, replacements);
    }
    const edits: NesTextEdit[] = [];
    for (const [index, replacements] of [...grouped].sort(
      ([left], [right]) => left - right,
    )) {
      const source = originalEdits[index];
      if (!source || replacements.length === 0) continue;
      const startOffset = replacements[0].range.start;
      const endOffset = replacements.at(-1)?.range.endOffset ?? startOffset;
      const newText = replacements
        .map((replacement, replacementIndex) => {
          const previous = replacements[replacementIndex - 1];
          return `${
            previous
              ? currentDocument.slice(
                  previous.range.endOffset,
                  replacement.range.start,
                )
              : ''
          }${replacement.newText}`;
        })
        .join('');
      const minimized = new NesStringReplacement(
        { start: startOffset, endOffset },
        newText,
      ).removeCommonSuffixAndPrefix(currentDocument);
      if (minimized.oldLength === 0 && minimized.newText.length === 0) {
        continue;
      }
      edits.push({
        ...source,
        startOffset,
        endOffset,
        newText,
        kind: startOffset === endOffset ? 'insert' : 'replace',
      });
    }

    if (resolution === 'strict' && edits.length > 0) {
      const originalResult = applySequentialNesEdits(
        originalDocument,
        originalEdits,
      );
      const currentResult = applySimultaneousNesEdits(currentDocument, edits);
      if (originalResult !== currentResult) {
        return { kind: 'inconsistentEdits' };
      }
    }
    return { kind: 'success', edits };
  } catch {
    return { kind: 'error' };
  }
}

function rebaseIndexedReplacements(
  content: string,
  ours: readonly IndexedReplacement[],
  base: NesStringEdit,
  resolution: 'strict' | 'lenient',
  config: NesRebaseConfig,
): readonly IndexedReplacement[] | undefined {
  const result: IndexedReplacement[] = [];
  const baseReplacements = base.replacements;
  let baseIndex = 0;
  let ourIndex = 0;
  let offset = 0;

  while (ourIndex < ours.length || baseIndex < baseReplacements.length) {
    const baseReplacement = baseReplacements[baseIndex];
    const originalOur = ours[ourIndex];
    if (!originalOur) {
      return resolution === 'strict' && baseReplacement ? undefined : result;
    }
    if (!baseReplacement) {
      result.push({
        ...originalOur,
        replacement: originalOur.replacement.delta(offset),
      });
      ourIndex += 1;
      continue;
    }

    let ourReplacement = originalOur.replacement;
    if (!containsRange(ourReplacement.range, baseReplacement.range)) {
      if (ourReplacement.range.start > baseReplacement.range.start) {
        const added = content.slice(
          baseReplacement.range.start,
          ourReplacement.range.start,
        );
        const updated = added + ourReplacement.newText;
        if (updated.endsWith(added)) {
          ourReplacement = new NesStringReplacement(
            {
              start: baseReplacement.range.start,
              endOffset: ourReplacement.range.endOffset - added.length,
            },
            updated.slice(0, updated.length - added.length),
          );
        }
      } else if (
        ourIndex === ours.length - 1 &&
        ourReplacement.range.endOffset < baseReplacement.range.endOffset
      ) {
        const added = content.slice(
          ourReplacement.range.endOffset,
          baseReplacement.range.endOffset,
        );
        const updated = ourReplacement.newText + added;
        if (updated.startsWith(added)) {
          ourReplacement = new NesStringReplacement(
            {
              start: ourReplacement.range.start + added.length,
              endOffset: baseReplacement.range.endOffset,
            },
            updated.slice(added.length),
          );
        }
      }
    }

    if (intersectsOrTouches(ourReplacement.range, baseReplacement.range)) {
      if (
        containsRange(ourReplacement.range, baseReplacement.range) &&
        ourReplacement.newText.length >= baseReplacement.newText.length
      ) {
        let delta = 0;
        let ourTextOffset = 0;
        let currentBase: NesStringReplacement | undefined = baseReplacement;
        let previousBase: NesStringReplacement | undefined;
        while (
          currentBase &&
          containsRange(ourReplacement.range, currentBase.range)
        ) {
          ourTextOffset = agreementIndexOf(
            content,
            ourReplacement,
            currentBase,
            previousBase,
            ourTextOffset,
            resolution,
            config,
          );
          if (ourTextOffset === -1) return undefined;
          delta += currentBase.lengthDelta;
          previousBase = currentBase;
          baseIndex += 1;
          currentBase = baseReplacements[baseIndex];
        }
        result.push({
          ...originalOur,
          replacement: new NesStringReplacement(
            {
              start: ourReplacement.range.start + offset,
              endOffset: ourReplacement.range.endOffset + offset + delta,
            },
            ourReplacement.newText,
          ),
        });
        ourIndex += 1;
        offset += delta;
        continue;
      }

      if (
        config.reverseAgreement &&
        rangesEqual(originalOur.replacement.range, baseReplacement.range)
      ) {
        let baseTextOffset = 0;
        let previousOur: NesStringReplacement | undefined;
        while (
          ourIndex < ours.length &&
          containsRange(
            baseReplacement.range,
            ours[ourIndex].replacement.range,
          )
        ) {
          const currentOur = ours[ourIndex];
          const gapStart = previousOur
            ? previousOur.range.endOffset
            : baseReplacement.range.start;
          const gapText =
            gapStart < currentOur.replacement.range.start
              ? content.slice(gapStart, currentOur.replacement.range.start)
              : '';
          const effectiveText = gapText + currentOur.replacement.newText;
          const match = baseReplacement.newText.indexOf(
            effectiveText,
            baseTextOffset,
          );
          const strictRejected =
            match !== -1 &&
            resolution === 'strict' &&
            (match - baseTextOffset > MAX_AGREEMENT_OFFSET ||
              (match - baseTextOffset > 0 &&
                effectiveText.length > config.maxImperfectAgreementLength));
          if (match !== -1 && !strictRejected) {
            baseTextOffset = match + effectiveText.length;
            previousOur = currentOur.replacement;
            ourIndex += 1;
            continue;
          }
          const remainingBase = baseReplacement.newText.slice(baseTextOffset);
          if (remainingBase && effectiveText.startsWith(remainingBase)) {
            const consumed = Math.max(
              0,
              remainingBase.length - gapText.length,
            );
            const unconsumed = currentOur.replacement.newText.slice(consumed);
            if (unconsumed) {
              result.push({
                ...currentOur,
                replacement: new NesStringReplacement(
                  {
                    start:
                      baseReplacement.range.start +
                      offset +
                      baseReplacement.newText.length,
                    endOffset:
                      baseReplacement.range.start +
                      offset +
                      baseReplacement.newText.length,
                  },
                  unconsumed,
                ),
              });
            }
            baseTextOffset = baseReplacement.newText.length;
            previousOur = currentOur.replacement;
            ourIndex += 1;
            break;
          }
          return undefined;
        }
        if (baseTextOffset < baseReplacement.newText.length && resolution === 'strict') {
          const lastEnd = previousOur
            ? previousOur.range.endOffset
            : baseReplacement.range.start;
          const trailingGap = content.slice(
            lastEnd,
            baseReplacement.range.endOffset,
          );
          if (
            trailingGap &&
            !baseReplacement.newText
              .slice(baseTextOffset)
              .startsWith(trailingGap)
          ) {
            return undefined;
          }
        }
        baseIndex += 1;
        offset += baseReplacement.lengthDelta;
        continue;
      }
      return undefined;
    }

    if (originalOur.replacement.range.start < baseReplacement.range.start) {
      result.push({
        ...originalOur,
        replacement: originalOur.replacement.delta(offset),
      });
      ourIndex += 1;
    } else {
      if (resolution === 'strict') return undefined;
      baseIndex += 1;
      offset += baseReplacement.lengthDelta;
    }
  }
  return result;
}

function agreementIndexOf(
  content: string,
  ours: NesStringReplacement,
  originalBase: NesStringReplacement,
  previousBase: NesStringReplacement | undefined,
  ourTextOffset: number,
  resolution: 'strict' | 'lenient',
  config: NesRebaseConfig,
): number {
  let base = originalBase;
  const minStart = previousBase
    ? previousBase.range.endOffset
    : ours.range.start;
  if (minStart < base.range.start) {
    base = new NesStringReplacement(
      { start: minStart, endOffset: base.range.endOffset },
      content.slice(minStart, base.range.start) + base.newText,
    );
  }
  const match = ours.newText.indexOf(base.newText, ourTextOffset);
  const strictRejected =
    match !== -1 &&
    resolution === 'strict' &&
    (match > MAX_AGREEMENT_OFFSET ||
      (match > 0 &&
        base.newText.length > config.maxImperfectAgreementLength));
  if (match !== -1 && !strictRejected) {
    return match + base.newText.length;
  }
  if (
    config.absorbSubsequenceTyping &&
    AUTO_CLOSE_PAIRS.has(originalBase.newText) &&
    isSubsequence(originalBase.newText, ours.newText.slice(ourTextOffset))
  ) {
    return ourTextOffset;
  }
  return -1;
}

function applyNesEdit(text: string, edit: NesTextEdit): string {
  return `${text.slice(0, edit.startOffset)}${edit.newText}${text.slice(edit.endOffset)}`;
}

function applySequentialNesEdits(
  text: string,
  edits: readonly NesTextEdit[],
): string {
  let result = text;
  for (const edit of edits) {
    result = applyNesEdit(result, edit);
  }
  return result;
}

function applySimultaneousNesEdits(
  text: string,
  edits: readonly NesTextEdit[],
): string {
  let result = '';
  let offset = 0;
  for (const edit of edits) {
    if (edit.startOffset < offset || edit.endOffset < edit.startOffset) {
      throw new Error('Simultaneous NES edits must be sorted and disjoint.');
    }
    result += text.slice(offset, edit.startOffset);
    result += edit.newText;
    offset = edit.endOffset;
  }
  return result + text.slice(offset);
}

function detailedReplacements(
  document: string,
  edit: NesTextEdit,
  index: number,
): readonly IndexedReplacement[] {
  const original = document.slice(edit.startOffset, edit.endOffset);
  if (original === edit.newText) return [];
  const detailed = computeNesDetailedChanges(original, edit.newText);
  if (!detailed) {
    return [
      {
        replacement: new NesStringReplacement(
          { start: edit.startOffset, endOffset: edit.endOffset },
          edit.newText,
        ),
        index,
      },
    ];
  }
  return detailed.map((change) => ({
    replacement: new NesStringReplacement(
      {
        start: edit.startOffset + change.startOffset,
        endOffset: edit.startOffset + change.endOffset,
      },
      change.newText,
    ),
    index,
  }));
}

function composeIndexedEdits(
  firstInput: readonly IndexedReplacement[],
  secondInput: readonly IndexedReplacement[],
): readonly IndexedReplacement[] {
  const firstQueue = [...normalizeIndexed(firstInput)];
  const second = normalizeIndexed(secondInput);
  if (firstQueue.length === 0) return second;
  if (second.length === 0) return firstQueue;
  const result: IndexedReplacement[] = [];
  let firstToSecond = 0;

  for (const secondItem of second) {
    const secondReplacement = secondItem.replacement;
    while (true) {
      const first = firstQueue[0];
      if (
        !first ||
        first.replacement.range.start +
          firstToSecond +
          first.replacement.newText.length >=
          secondReplacement.range.start
      ) {
        break;
      }
      firstQueue.shift();
      result.push(first);
      firstToSecond += first.replacement.lengthDelta;
    }

    const initialDelta = firstToSecond;
    let firstIntersecting: IndexedReplacement | undefined;
    let lastIntersecting: IndexedReplacement | undefined;
    while (true) {
      const first = firstQueue[0];
      if (
        !first ||
        first.replacement.range.start + firstToSecond >
          secondReplacement.range.endOffset
      ) {
        break;
      }
      firstIntersecting ??= first;
      lastIntersecting = first;
      firstQueue.shift();
      firstToSecond += first.replacement.lengthDelta;
    }

    if (!firstIntersecting) {
      result.push({
        ...secondItem,
        replacement: secondReplacement.delta(-firstToSecond),
      });
      continue;
    }

    const replaceStart = Math.min(
      firstIntersecting.replacement.range.start,
      secondReplacement.range.start - initialDelta,
    );
    const prefixLength =
      secondReplacement.range.start -
      (firstIntersecting.replacement.range.start + initialDelta);
    if (prefixLength > 0) {
      result.push({
        ...firstIntersecting,
        replacement: firstIntersecting.replacement.slice(
          { start: replaceStart, endOffset: replaceStart },
          { start: 0, endOffset: prefixLength },
        ),
      });
    }
    if (!lastIntersecting) {
      throw new Error('Annotated compose invariant failed.');
    }
    const suffixLength =
      lastIntersecting.replacement.range.endOffset +
      firstToSecond -
      secondReplacement.range.endOffset;
    if (suffixLength > 0) {
      const suffix = {
        ...lastIntersecting,
        replacement: lastIntersecting.replacement.slice(
          {
            start: lastIntersecting.replacement.range.endOffset,
            endOffset: lastIntersecting.replacement.range.endOffset,
          },
          {
            start: lastIntersecting.replacement.newText.length - suffixLength,
            endOffset: lastIntersecting.replacement.newText.length,
          },
        ),
      };
      firstQueue.unshift(suffix);
      firstToSecond -= suffix.replacement.lengthDelta;
    }
    result.push({
      ...secondItem,
      replacement: secondReplacement.slice({
        start: replaceStart,
        endOffset: secondReplacement.range.endOffset - firstToSecond,
      }),
    });
  }
  result.push(...firstQueue);
  return normalizeIndexed(result);
}

function normalizeIndexed(
  replacements: readonly IndexedReplacement[],
): readonly IndexedReplacement[] {
  const result: IndexedReplacement[] = [];
  for (const item of replacements) {
    if (
      item.replacement.oldLength === 0 &&
      item.replacement.newText.length === 0
    ) {
      continue;
    }
    const previous = result.at(-1);
    if (
      previous?.index === item.index &&
      previous.replacement.range.endOffset === item.replacement.range.start
    ) {
      result[result.length - 1] = {
        index: item.index,
        replacement: new NesStringReplacement(
          {
            start: previous.replacement.range.start,
            endOffset: item.replacement.range.endOffset,
          },
          previous.replacement.newText + item.replacement.newText,
        ),
      };
    } else {
      result.push(item);
    }
  }
  return result;
}

function containsRange(outer: NesOffsetRange, inner: NesOffsetRange): boolean {
  return outer.start <= inner.start && inner.endOffset <= outer.endOffset;
}

function intersectsOrTouches(
  left: NesOffsetRange,
  right: NesOffsetRange,
): boolean {
  return Math.max(left.start, right.start) <=
    Math.min(left.endOffset, right.endOffset);
}

function rangesEqual(left: NesOffsetRange, right: NesOffsetRange): boolean {
  return left.start === right.start && left.endOffset === right.endOffset;
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

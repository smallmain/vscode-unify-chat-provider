import type { CompletionTextEdit } from '../model/responses';
import {
  computeNesDetailedChanges,
  computeNesPreciseChanges,
} from '../../chat-lib/core/nes/diff-runtime';

function fallbackTextEdit(
  original: string,
  modified: string,
): CompletionTextEdit | undefined {
  if (original === modified) return undefined;
  let prefix = 0;
  const shared = Math.min(original.length, modified.length);
  while (
    prefix < shared &&
    original.charCodeAt(prefix) === modified.charCodeAt(prefix)
  ) {
    prefix += 1;
  }
  let suffix = 0;
  while (
    suffix < original.length - prefix &&
    suffix < modified.length - prefix &&
    original.charCodeAt(original.length - suffix - 1) ===
      modified.charCodeAt(modified.length - suffix - 1)
  ) {
    suffix += 1;
  }
  return {
    startOffset: prefix,
    endOffset: original.length - suffix,
    text: modified.slice(prefix, modified.length - suffix),
  };
}

function preciseTextEdits(
  original: string,
  modified: string,
): readonly CompletionTextEdit[] | undefined {
  return computeNesPreciseChanges(original, modified)?.map((change) => ({
    startOffset: change.startOffset,
    endOffset: change.endOffset,
    text: change.newText,
  }));
}

export function computeDetailedTextEdits(
  original: string,
  modified: string,
): readonly CompletionTextEdit[] {
  if (original === modified) return [];
  const detailed = computeNesDetailedChanges(original, modified);
  if (detailed && detailed.length > 0) {
    const refined = detailed.flatMap((change) => {
      const oldText = original.slice(change.startOffset, change.endOffset);
      const precise = preciseTextEdits(oldText, change.newText);
      const inner = precise ?? [fallbackTextEdit(oldText, change.newText)].filter(
        (edit): edit is CompletionTextEdit => edit !== undefined,
      );
      return inner.map((edit) => ({
        startOffset: change.startOffset + edit.startOffset,
        endOffset: change.startOffset + edit.endOffset,
        text: edit.text,
      }));
    });
    if (applyTextEdits(original, refined) === modified) return refined;
  }
  const fallback = fallbackTextEdit(original, modified);
  return fallback ? [fallback] : [];
}

export function validateTextEdits(
  sourceLength: number,
  edits: readonly CompletionTextEdit[],
): boolean {
  let previousEnd = 0;
  return edits.every((edit) => {
    const valid =
      Number.isSafeInteger(edit.startOffset) &&
      Number.isSafeInteger(edit.endOffset) &&
      edit.startOffset >= previousEnd &&
      edit.endOffset >= edit.startOffset &&
      edit.endOffset <= sourceLength;
    previousEnd = edit.endOffset;
    return valid;
  });
}

export function applyTextEdits(
  source: string,
  edits: readonly CompletionTextEdit[],
): string | undefined {
  if (!validateTextEdits(source.length, edits)) return undefined;
  const output: string[] = [];
  let offset = 0;
  for (const edit of edits) {
    output.push(source.slice(offset, edit.startOffset), edit.text);
    offset = edit.endOffset;
  }
  output.push(source.slice(offset));
  return output.join('');
}

export type InterpolatedTextEditsResult =
  | { readonly kind: 'edits'; readonly edits: readonly CompletionTextEdit[] }
  | { readonly kind: 'empty' }
  | { readonly kind: 'interpolated-empty' }
  | { readonly kind: 'failed' };

function transformOffsetThroughEdits(
  offset: number,
  edits: readonly CompletionTextEdit[],
  affinity: 'before' | 'after',
): number | undefined {
  let delta = 0;
  for (const edit of edits) {
    if (offset < edit.startOffset) break;
    if (offset > edit.endOffset) {
      delta += edit.text.length - (edit.endOffset - edit.startOffset);
      continue;
    }
    if (edit.startOffset === edit.endOffset && offset === edit.startOffset) {
      return offset + delta + (affinity === 'after' ? edit.text.length : 0);
    }
    if (offset === edit.startOffset) return edit.startOffset + delta;
    if (offset === edit.endOffset) return edit.startOffset + delta + edit.text.length;
    return undefined;
  }
  return offset + delta;
}

function transformModelEdit(
  edit: CompletionTextEdit,
  userEdits: readonly CompletionTextEdit[],
): CompletionTextEdit | undefined {
  const startOffset = transformOffsetThroughEdits(
    edit.startOffset,
    userEdits,
    'after',
  );
  const endOffset = transformOffsetThroughEdits(
    edit.endOffset,
    userEdits,
    'before',
  );
  if (startOffset === undefined || endOffset === undefined || endOffset < startOffset) {
    return undefined;
  }
  return { startOffset, endOffset, text: edit.text };
}

/**
 * Port of Zed's interpolate_edits contract. User changes are accepted only when
 * they exactly replace a predicted range with a prefix of its predicted text.
 */
export function interpolateTextEdits(
  requestSnapshot: string,
  currentSnapshot: string,
  modelEdits: readonly CompletionTextEdit[],
): InterpolatedTextEditsResult {
  if (modelEdits.length === 0) return { kind: 'empty' };
  if (!validateTextEdits(requestSnapshot.length, modelEdits)) {
    return { kind: 'failed' };
  }
  if (requestSnapshot === currentSnapshot) {
    return { kind: 'edits', edits: modelEdits };
  }

  const userEdits = computeDetailedTextEdits(requestSnapshot, currentSnapshot);
  if (!validateTextEdits(requestSnapshot.length, userEdits)) {
    return { kind: 'failed' };
  }
  const output: CompletionTextEdit[] = [];
  let modelIndex = 0;
  for (const userEdit of userEdits) {
    while (
      modelIndex < modelEdits.length &&
      (modelEdits[modelIndex]?.endOffset ?? 0) < userEdit.startOffset
    ) {
      const transformed = transformModelEdit(
        modelEdits[modelIndex]!,
        userEdits,
      );
      if (!transformed) return { kind: 'failed' };
      output.push(transformed);
      modelIndex += 1;
    }

    const modelEdit = modelEdits[modelIndex];
    if (
      !modelEdit ||
      modelEdit.startOffset !== userEdit.startOffset ||
      modelEdit.endOffset !== userEdit.endOffset ||
      !modelEdit.text.startsWith(userEdit.text)
    ) {
      return { kind: 'failed' };
    }
    const suffix = modelEdit.text.slice(userEdit.text.length);
    if (suffix) {
      const insertionOffset =
        transformOffsetThroughEdits(modelEdit.endOffset, userEdits, 'after');
      if (insertionOffset === undefined) return { kind: 'failed' };
      output.push({
        startOffset: insertionOffset,
        endOffset: insertionOffset,
        text: suffix,
      });
    }
    modelIndex += 1;
  }

  for (; modelIndex < modelEdits.length; modelIndex += 1) {
    const transformed = transformModelEdit(modelEdits[modelIndex]!, userEdits);
    if (!transformed) return { kind: 'failed' };
    output.push(transformed);
  }
  output.sort(
    (left, right) =>
      left.startOffset - right.startOffset || left.endOffset - right.endOffset,
  );
  if (!validateTextEdits(currentSnapshot.length, output)) {
    return { kind: 'failed' };
  }
  return output.length === 0
    ? { kind: 'interpolated-empty' }
    : { kind: 'edits', edits: output };
}

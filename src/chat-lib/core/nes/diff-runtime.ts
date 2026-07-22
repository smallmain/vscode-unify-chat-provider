import { resolve } from 'node:path';

export interface NesDetailedDiffChange {
  readonly startOffset: number;
  readonly endOffset: number;
  readonly newText: string;
}

interface NesDiffRuntime {
  computeDetailedChanges(
    original: string,
    modified: string,
  ): readonly NesDetailedDiffChange[] | undefined;
  computePreciseChanges(
    original: string,
    modified: string,
  ): readonly NesDetailedDiffChange[] | undefined;
}

let diffRuntime: NesDiffRuntime | undefined;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isNesDiffRuntime(value: unknown): value is NesDiffRuntime {
  return (
    isRecord(value) &&
    typeof value.computeDetailedChanges === 'function' &&
    typeof value.computePreciseChanges === 'function'
  );
}

function isDetailedChange(
  value: unknown,
): value is NesDetailedDiffChange {
  if (!isRecord(value)) return false;
  return (
    typeof value.startOffset === 'number' &&
    typeof value.endOffset === 'number' &&
    typeof value.newText === 'string' &&
    Number.isInteger(value.startOffset) &&
    Number.isInteger(value.endOffset) &&
    value.startOffset >= 0 &&
    value.endOffset >= value.startOffset
  );
}

function isDetailedChangeList(
  value: unknown,
  originalLength: number,
): value is readonly NesDetailedDiffChange[] {
  if (!Array.isArray(value)) return false;
  let previousEnd = 0;
  for (const change of value) {
    if (
      !isDetailedChange(change) ||
      change.startOffset < previousEnd ||
      change.endOffset > originalLength
    ) {
      return false;
    }
    previousEnd = change.endOffset;
  }
  return true;
}

function getDiffRuntime(): NesDiffRuntime {
  if (diffRuntime) return diffRuntime;
  const bundlePath = resolve(
    __dirname,
    '../../../../dist/chat-lib-diff.cjs',
  );
  const loaded: unknown = require(bundlePath);
  if (!isNesDiffRuntime(loaded)) {
    throw new Error(`Invalid NES diff runtime at ${bundlePath}.`);
  }
  diffRuntime = loaded;
  return loaded;
}

export function computeNesDetailedChanges(
  original: string,
  modified: string,
): readonly NesDetailedDiffChange[] | undefined {
  const result = getDiffRuntime().computeDetailedChanges(original, modified);
  if (result !== undefined && !isDetailedChangeList(result, original.length)) {
    throw new Error('NES diff runtime returned invalid detailed changes.');
  }
  return result;
}

export function computeNesPreciseChanges(
  original: string,
  modified: string,
): readonly NesDetailedDiffChange[] | undefined {
  const result = getDiffRuntime().computePreciseChanges(original, modified);
  if (result !== undefined && !isDetailedChangeList(result, original.length)) {
    throw new Error('NES diff runtime returned invalid precise changes.');
  }
  return result;
}

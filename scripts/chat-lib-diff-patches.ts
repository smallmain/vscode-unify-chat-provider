import { relative, resolve } from 'node:path';

const workspaceRoot = process.cwd();
const upstreamRoot = resolve(workspaceRoot, 'src/chat-lib/upstream');
const abstractTextPath = resolve(
  upstreamRoot,
  'util/vs/editor/common/core/text/abstractText.ts',
);
const arraysPath = resolve(
  upstreamRoot,
  'util/vs/base/common/arrays.ts',
);
const assertPath = resolve(
  upstreamRoot,
  'util/vs/base/common/assert.ts',
);
const defaultLinesDiffComputerPath = resolve(
  upstreamRoot,
  'util/vs/editor/common/diff/defaultLinesDiffComputer/defaultLinesDiffComputer.ts',
);
const heuristicSequenceOptimizationsPath = resolve(
  upstreamRoot,
  'util/vs/editor/common/diff/defaultLinesDiffComputer/heuristicSequenceOptimizations.ts',
);
const positionToOffsetPath = resolve(
  upstreamRoot,
  'util/vs/editor/common/core/text/positionToOffset.ts',
);
const positionToOffsetImplPath = resolve(
  upstreamRoot,
  'util/vs/editor/common/core/text/positionToOffsetImpl.ts',
);
const rangeMappingPath = resolve(
  upstreamRoot,
  'util/vs/editor/common/diff/rangeMapping.ts',
);

export const CHAT_LIB_DIFF_PATCHED_SOURCE_PATHS = [
  arraysPath,
  assertPath,
  abstractTextPath,
  defaultLinesDiffComputerPath,
  heuristicSequenceOptimizationsPath,
  positionToOffsetPath,
  positionToOffsetImplPath,
  rangeMappingPath,
] as const;

function replaceOnce(
  source: string,
  expected: string,
  replacement: string,
  filePath: string,
): string {
  const first = source.indexOf(expected);
  if (first < 0 || source.indexOf(expected, first + expected.length) >= 0) {
    throw new Error(
      `NES diff patch anchor is missing or ambiguous in ${relative(workspaceRoot, filePath)}.`,
    );
  }
  return `${source.slice(0, first)}${replacement}${source.slice(first + expected.length)}`;
}

function patchAbstractText(filePath: string, source: string): string {
  return replaceOnce(
    source,
    "import { splitLines } from '../../../../base/common/strings';",
    [
      'function splitLines(value: string): string[] {',
      '\treturn value.split(/\\r\\n|\\r|\\n/);',
      '}',
    ].join('\n'),
    filePath,
  );
}

function patchArrays(filePath: string, source: string): string {
  let patched = replaceOnce(
    source,
    "import { CancellationToken } from './cancellation';\n",
    [
      'interface CancellationToken {',
      '\treadonly isCancellationRequested: boolean;',
      '}',
      '',
    ].join('\n'),
    filePath,
  );
  patched = replaceOnce(
    patched,
    "import { ISplice } from './sequence';\n",
    [
      'interface ISplice<T> {',
      '\treadonly start: number;',
      '\treadonly deleteCount: number;',
      '\treadonly toInsert: readonly T[];',
      '}',
      '',
    ].join('\n'),
    filePath,
  );
  return patched;
}

function patchAssert(filePath: string, source: string): string {
  let patched = replaceOnce(
    source,
    'export function assertNever(value: never,',
    'export function assertNever(_value: never,',
    filePath,
  );
  patched = replaceOnce(
    patched,
    'export function softAssertNever(value: never): void {',
    'export function softAssertNever(_value: never): void {',
    filePath,
  );
  return patched;
}

function patchHeuristicSequenceOptimizations(
  filePath: string,
  source: string,
): string {
  return replaceOnce(
    source,
    'export function removeShortMatches(sequence1: ISequence, sequence2: ISequence, sequenceDiffs: SequenceDiff[]): SequenceDiff[] {',
    'export function removeShortMatches(_sequence1: ISequence, _sequence2: ISequence, sequenceDiffs: SequenceDiff[]): SequenceDiff[] {',
    filePath,
  );
}

function patchDefaultLinesDiffComputer(
  filePath: string,
  source: string,
): string {
  let patched = replaceOnce(
    source,
    "import { ILinesDiffComputer, ILinesDiffComputerOptions, LinesDiff, MovedText } from '../linesDiffComputer';",
    "import { ILinesDiffComputer, ILinesDiffComputerOptions, LinesDiff } from '../linesDiffComputer';",
    filePath,
  );
  patched = replaceOnce(
    patched,
    "import { computeMovedLines } from './computeMovedLines';\n",
    '',
    filePath,
  );
  patched = replaceOnce(
    patched,
    [
      '\t\tlet moves: MovedText[] = [];',
      '\t\tif (options.computeMoves) {',
      '\t\t\tmoves = this.computeMoves(changes, originalLines, modifiedLines, originalLinesHashes, modifiedLinesHashes, timeout, considerWhitespaceChanges, options);',
      '\t\t}',
    ].join('\n'),
    '',
    filePath,
  );
  patched = replaceOnce(
    patched,
    [
      '\tprivate computeMoves(',
      '\t\tchanges: DetailedLineRangeMapping[],',
      '\t\toriginalLines: string[],',
      '\t\tmodifiedLines: string[],',
      '\t\thashedOriginalLines: number[],',
      '\t\thashedModifiedLines: number[],',
      '\t\ttimeout: ITimeout,',
      '\t\tconsiderWhitespaceChanges: boolean,',
      '\t\toptions: ILinesDiffComputerOptions,',
      '\t): MovedText[] {',
      '\t\tconst moves = computeMovedLines(',
      '\t\t\tchanges,',
      '\t\t\toriginalLines,',
      '\t\t\tmodifiedLines,',
      '\t\t\thashedOriginalLines,',
      '\t\t\thashedModifiedLines,',
      '\t\t\ttimeout,',
      '\t\t);',
      '\t\tconst movesWithDiffs = moves.map(m => {',
      '\t\t\tconst moveChanges = this.refineDiff(originalLines, modifiedLines, new SequenceDiff(',
      '\t\t\t\tm.original.toOffsetRange(),',
      '\t\t\t\tm.modified.toOffsetRange(),',
      '\t\t\t), timeout, considerWhitespaceChanges, options);',
      '\t\t\tconst mappings = lineRangeMappingFromRangeMappings(moveChanges.mappings, new ArrayText(originalLines), new ArrayText(modifiedLines), true);',
      '\t\t\treturn new MovedText(m, mappings);',
      '\t\t});',
      '\t\treturn movesWithDiffs;',
      '\t}',
      '',
    ].join('\n'),
    '',
    filePath,
  );
  patched = replaceOnce(
    patched,
    '\t\treturn new LinesDiff(changes, moves, hitTimeout);',
    '\t\treturn new LinesDiff(changes, [], hitTimeout);',
    filePath,
  );
  return patched;
}

function patchPositionToOffset(filePath: string, source: string): string {
  let patched = replaceOnce(
    source,
    [
      "import { StringEdit, StringReplacement } from '../edits/stringEdit';",
      "import { TextEdit, TextReplacement } from '../edits/textEdit';",
      "import { _setPositionOffsetTransformerDependencies } from './positionToOffsetImpl';",
      "import { TextLength } from './textLength';",
    ].join('\n'),
    [
      "import { _setPositionOffsetTransformerDependencies } from './positionToOffsetImpl';",
      "import { TextLength } from './textLength';",
    ].join('\n'),
    filePath,
  );
  patched = replaceOnce(
    patched,
    [
      '_setPositionOffsetTransformerDependencies({',
      '\tStringEdit: StringEdit,',
      '\tStringReplacement: StringReplacement,',
      '\tTextReplacement: TextReplacement,',
      '\tTextEdit: TextEdit,',
      '\tTextLength: TextLength,',
      '});',
    ].join('\n'),
    [
      '_setPositionOffsetTransformerDependencies({',
      '\tTextLength,',
      '});',
    ].join('\n'),
    filePath,
  );
  return patched;
}

function patchPositionToOffsetImpl(filePath: string, source: string): string {
  let patched = replaceOnce(
    source,
    "import { StringEdit, StringReplacement } from '../edits/stringEdit';\n",
    '',
    filePath,
  );
  patched = replaceOnce(
    patched,
    "import type { TextReplacement, TextEdit } from '../edits/textEdit';\n",
    '',
    filePath,
  );
  patched = replaceOnce(
    patched,
    [
      '\tgetStringEdit(edit: TextEdit): StringEdit {',
      '\t\tconst edits = edit.replacements.map(e => this.getStringReplacement(e));',
      '\t\treturn new Deps.deps.StringEdit(edits);',
      '\t}',
      '',
      '\tgetStringReplacement(edit: TextReplacement): StringReplacement {',
      '\t\treturn new Deps.deps.StringReplacement(this.getOffsetRange(edit.range), edit.text);',
      '\t}',
      '',
      '\tgetTextReplacement(edit: StringReplacement): TextReplacement {',
      '\t\treturn new Deps.deps.TextReplacement(this.getRange(edit.replaceRange), edit.newText);',
      '\t}',
      '',
      '\tgetTextEdit(edit: StringEdit): TextEdit {',
      '\t\tconst edits = edit.replacements.map(e => this.getTextReplacement(e));',
      '\t\treturn new Deps.deps.TextEdit(edits);',
      '\t}',
    ].join('\n'),
    '',
    filePath,
  );
  patched = replaceOnce(
    patched,
    [
      'interface IDeps {',
      '\tStringEdit: typeof StringEdit;',
      '\tStringReplacement: typeof StringReplacement;',
      '\tTextReplacement: typeof TextReplacement;',
      '\tTextEdit: typeof TextEdit;',
      '\tTextLength: typeof TextLength;',
      '}',
    ].join('\n'),
    [
      'interface IDeps {',
      '\tTextLength: typeof TextLength;',
      '}',
    ].join('\n'),
    filePath,
  );
  return patched;
}

function patchRangeMapping(filePath: string, source: string): string {
  let patched = replaceOnce(
    source,
    "import { TextReplacement, TextEdit } from '../core/edits/textEdit';\n",
    '',
    filePath,
  );
  patched = replaceOnce(
    patched,
    "import { IChange } from './legacyLinesDiffComputer';\n",
    '',
    filePath,
  );
  patched = replaceOnce(
    patched,
    [
      '\tpublic static toTextEdit(mapping: readonly DetailedLineRangeMapping[], modified: AbstractText): TextEdit {',
      '\t\tconst replacements: TextReplacement[] = [];',
      '\t\tfor (const m of mapping) {',
      '\t\t\tfor (const r of m.innerChanges ?? []) {',
      '\t\t\t\tconst replacement = r.toTextEdit(modified);',
      '\t\t\t\treplacements.push(replacement);',
      '\t\t\t}',
      '\t\t}',
      '\t\treturn new TextEdit(replacements);',
      '\t}',
      '',
    ].join('\n'),
    '',
    filePath,
  );
  patched = replaceOnce(
    patched,
    [
      '\tpublic static fromEdit(edit: TextEdit): RangeMapping[] {',
      '\t\tconst newRanges = edit.getNewRanges();',
      '\t\tconst result = edit.replacements.map((e, idx) => new RangeMapping(e.range, newRanges[idx]));',
      '\t\treturn result;',
      '\t}',
      '',
      '\tpublic static fromEditJoin(edit: TextEdit): RangeMapping {',
      '\t\tconst newRanges = edit.getNewRanges();',
      '\t\tconst result = edit.replacements.map((e, idx) => new RangeMapping(e.range, newRanges[idx]));',
      '\t\treturn RangeMapping.join(result);',
      '\t}',
      '',
    ].join('\n'),
    '',
    filePath,
  );
  patched = replaceOnce(
    patched,
    [
      '\t/**',
      '\t * Creates a single text edit that describes the change from the original to the modified text.',
      '\t*/',
      '\tpublic toTextEdit(modified: AbstractText): TextReplacement {',
      '\t\tconst newText = modified.getValueOfRange(this.modifiedRange);',
      '\t\treturn new TextReplacement(this.originalRange, newText);',
      '\t}',
      '',
    ].join('\n'),
    '',
    filePath,
  );
  patched = replaceOnce(
    patched,
    [
      'export function lineRangeMappingFromChange(change: IChange): LineRangeMapping {',
      '\tlet originalRange: LineRange;',
      '\tif (change.originalEndLineNumber === 0) {',
      '\t\t// Insertion',
      '\t\toriginalRange = new LineRange(change.originalStartLineNumber + 1, change.originalStartLineNumber + 1);',
      '\t} else {',
      '\t\toriginalRange = new LineRange(change.originalStartLineNumber, change.originalEndLineNumber + 1);',
      '\t}',
      '',
      '\tlet modifiedRange: LineRange;',
      '\tif (change.modifiedEndLineNumber === 0) {',
      '\t\t// Deletion',
      '\t\tmodifiedRange = new LineRange(change.modifiedStartLineNumber + 1, change.modifiedStartLineNumber + 1);',
      '\t} else {',
      '\t\tmodifiedRange = new LineRange(change.modifiedStartLineNumber, change.modifiedEndLineNumber + 1);',
      '\t}',
      '',
      '\treturn new LineRangeMapping(originalRange, modifiedRange);',
      '}',
    ].join('\n'),
    '',
    filePath,
  );
  return patched;
}

export function patchChatLibDiffSource(
  filePath: string,
  source: string,
): string {
  const resolved = resolve(filePath);
  if (resolved === arraysPath) {
    return patchArrays(filePath, source);
  }
  if (resolved === assertPath) {
    return patchAssert(filePath, source);
  }
  if (resolved === abstractTextPath) {
    return patchAbstractText(filePath, source);
  }
  if (resolved === defaultLinesDiffComputerPath) {
    return patchDefaultLinesDiffComputer(filePath, source);
  }
  if (resolved === heuristicSequenceOptimizationsPath) {
    return patchHeuristicSequenceOptimizations(filePath, source);
  }
  if (resolved === positionToOffsetPath) {
    return patchPositionToOffset(filePath, source);
  }
  if (resolved === positionToOffsetImplPath) {
    return patchPositionToOffsetImpl(filePath, source);
  }
  if (resolved === rangeMappingPath) {
    return patchRangeMapping(filePath, source);
  }
  return source;
}

import { contextualFilterCharacterMap } from '../../upstream/extension/completions-core/vscode-node/lib/src/ghostText/contextualFilterConstants';
import {
  blockPositionTypeAt,
  isBlockBodyFinished,
  isEmptyBlockStart,
  isSupportedBlockTrimmerLanguage,
  isSupportedParserLanguage,
  trimWithTerseBlockTrimmer,
  type GhostTextBlockPosition,
} from './parser-runtime';
import { multilineModelPredict } from '../../upstream/extension/completions-core/vscode-node/lib/src/ghostText/multilineModelWeights';
import type {
  GhostTextBehavior,
  GhostTextBlockMode,
  GhostTextPrompt,
  GhostTextRequest,
} from './types';
import { lineBoundsAtOffset, offsetAt } from './prompt';

const MAX_SINGLELINE_TOKENS = 20;
export const GHOST_TEXT_LONG_LOOKAHEAD = 9;
export const GHOST_TEXT_SHORT_LOOKAHEAD = 3;

export interface GhostTextNetworkStrategy {
  blockMode: GhostTextBlockMode;
  afterAcceptFallback: boolean;
  stop?: readonly string[];
  maxTokens?: number;
  trimmerLookahead?: number;
  nextIndent: number;
  trimByIndentation: boolean;
}

export interface GhostTextMultilineStrategy {
  requestMultiline: boolean;
  blockMode: GhostTextBlockMode;
  afterAcceptFallback: boolean;
  blockPosition?: GhostTextBlockPosition;
}

export interface GhostTextSplitCompletionSegment {
  readonly prefixAddition: string;
  readonly completionText: string;
  readonly generatedChoiceIndex?: number;
  readonly hasMore: boolean;
}

export function buildGhostTextNetworkStrategy(
  request: GhostTextRequest,
  prompt: GhostTextPrompt,
  behavior: GhostTextBehavior,
  multiline: boolean,
  afterAcceptedCompletion: boolean,
  multilineStrategy?: GhostTextMultilineStrategy,
): GhostTextNetworkStrategy {
  const resolvedBlockMode = resolveGhostTextBlockMode(
    behavior,
    request.document.languageId,
  );
  const afterAcceptFallback =
    multilineStrategy?.afterAcceptFallback ??
    (afterAcceptedCompletion && resolvedBlockMode !== 'more-multiline');
  const blockMode =
    multilineStrategy?.blockMode ??
    (afterAcceptFallback ? 'parsing' : resolvedBlockMode);
  const simulateSingleline =
    blockMode === 'more-multiline' &&
    isSupportedBlockTrimmerLanguage(request.document.languageId) &&
    !behavior.modelAlwaysTerminatesSingleline;
  const stop = !multiline && !simulateSingleline
    ? ['\n']
    : afterAcceptFallback
      ? ['\n\n']
      : undefined;
  const maxTokens = afterAcceptFallback
    ? MAX_SINGLELINE_TOKENS * behavior.multilineAfterAcceptLines
    : multiline &&
        blockMode === 'more-multiline' &&
        isSupportedBlockTrimmerLanguage(request.document.languageId)
      ? behavior.maxMultilineTokens
      : undefined;
  const requestOffset = offsetAt(request.document.text, request.position);
  const trimmerLookahead =
    multiline &&
    blockMode === 'more-multiline' &&
    isSupportedBlockTrimmerLanguage(request.document.languageId)
      ? ghostTextTrimmerLookahead(multilineStrategy?.blockPosition)
      : undefined;

  return {
    blockMode,
    afterAcceptFallback,
    ...(stop === undefined ? {} : { stop }),
    ...(maxTokens === undefined ? {} : { maxTokens }),
    ...(trimmerLookahead === undefined ? {} : { trimmerLookahead }),
    nextIndent: nextIndentation(
      requestOffset === undefined
        ? prompt.virtualDocumentText
        : request.document.text,
      requestOffset ?? prompt.virtualCursorOffset,
    ),
    trimByIndentation:
      blockMode === 'server' || blockMode === 'parsing-and-server',
  };
}

const TRIMMED_BY_DEFAULT_LANGUAGES = new Set([
  'javascript',
  'javascriptreact',
  'jsx',
  'typescript',
  'typescriptreact',
  'go',
]);

export function resolveGhostTextBlockMode(
  behavior: GhostTextBehavior,
  languageId: string,
): GhostTextBlockMode {
  if (behavior.blockMode !== 'default') {
    if (
      behavior.blockMode === 'more-multiline' &&
      isSupportedBlockTrimmerLanguage(languageId)
    ) {
      return behavior.blockMode;
    }
    if (
      behavior.blockMode !== 'server' &&
      !isSupportedParserLanguage(languageId)
    ) {
      return 'server';
    }
    return behavior.blockMode;
  }
  if (TRIMMED_BY_DEFAULT_LANGUAGES.has(languageId)) {
    return 'more-multiline';
  }
  if (languageId === 'ruby') {
    return 'parsing';
  }
  return isSupportedParserLanguage(languageId)
    ? 'parsing-and-server'
    : 'server';
}

const LANGUAGE_FEATURES: Readonly<Record<string, number>> = {
  javascript: 1,
  javascriptreact: 2,
  typescript: 3,
  typescriptreact: 4,
  python: 5,
  go: 6,
  ruby: 7,
};

const COMMENT_MARKERS: Readonly<Record<string, readonly string[]>> = {
  javascript: ['//'],
  typescript: ['//'],
  typescriptreact: ['//'],
  javascriptreact: ['//'],
  vue: ['//', '-->'],
  php: ['//', '#'],
  dart: ['//'],
  go: ['//'],
  cpp: ['//'],
  scss: ['//'],
  csharp: ['//'],
  java: ['//'],
  c: ['//'],
  rust: ['//'],
  python: ['#'],
  markdown: ['#', '-->'],
  css: ['*/'],
};

interface TextFeatures {
  numeric: readonly number[];
  lastCharacter: string;
  trimmedLastCharacter: string;
  firstCharacter: string;
  leftTrimmedFirstCharacter: string;
}

export async function determineGhostTextMultilineStrategy(
  request: GhostTextRequest,
  prompt: GhostTextPrompt,
  behavior: GhostTextBehavior,
  afterAcceptedCompletion: boolean,
): Promise<GhostTextMultilineStrategy> {
  const configuredBlockMode = resolveGhostTextBlockMode(
    behavior,
    request.document.languageId,
  );
  if (request.multiline === 'multi') {
    return {
      requestMultiline: true,
      blockMode: configuredBlockMode,
      afterAcceptFallback: false,
      ...(await blockPositionForStrategy(request, prompt, configuredBlockMode)),
    };
  }
  if (request.multiline === 'single') {
    return {
      requestMultiline: false,
      blockMode: configuredBlockMode,
      afterAcceptFallback: false,
    };
  }
  if (configuredBlockMode === 'server') {
    return {
      requestMultiline: true,
      blockMode: afterAcceptedCompletion ? 'parsing' : 'server',
      afterAcceptFallback: afterAcceptedCompletion,
    };
  }
  const naturallyMultiline = await shouldNaturallyRequestMultiline(
    request,
    prompt,
    configuredBlockMode,
    afterAcceptedCompletion,
  );
  if (
    naturallyMultiline &&
    (!behavior.singleLineUnlessAccepted || afterAcceptedCompletion)
  ) {
    return {
      requestMultiline: true,
      blockMode: configuredBlockMode,
      afterAcceptFallback: false,
      ...(await blockPositionForStrategy(request, prompt, configuredBlockMode)),
    };
  }
  if (afterAcceptedCompletion) {
    return {
      requestMultiline: true,
      blockMode:
        configuredBlockMode === 'more-multiline'
          ? 'more-multiline'
          : 'parsing',
      afterAcceptFallback: true,
    };
  }
  return {
    requestMultiline: false,
    blockMode: configuredBlockMode,
    afterAcceptFallback: false,
  };
}

async function blockPositionForStrategy(
  request: GhostTextRequest,
  prompt: GhostTextPrompt,
  blockMode: GhostTextBlockMode,
): Promise<{ blockPosition: GhostTextBlockPosition } | Record<string, never>> {
  if (
    blockMode !== 'more-multiline' ||
    !isSupportedBlockTrimmerLanguage(request.document.languageId)
  ) {
    return {};
  }
  try {
    return {
      blockPosition: await blockPositionTypeAt(
        request.document.languageId,
        prompt.virtualDocumentText,
        prompt.virtualCursorOffset,
      ),
    };
  } catch {
    return {};
  }
}

export async function splitGhostTextCompletion(
  prefix: string,
  completion: string,
  languageId: string,
  lookAhead: number,
  trim: GhostTextCompletionTrimmer = trimGhostTextCompletionSegment,
): Promise<readonly GhostTextSplitCompletionSegment[]> {
  const segments: GhostTextSplitCompletionSegment[] = [];
  let startOffset = 0;
  let generatedChoiceIndex = 0;
  while (startOffset < completion.length) {
    const effectiveText = completion.slice(startOffset);
    const offset = await trim(
      languageId,
      prefix + completion.slice(0, startOffset),
      effectiveText,
      lookAhead,
    );
    const segmentLength =
      offset === undefined || offset <= 0
        ? effectiveText.length
        : Math.min(offset, effectiveText.length);
    const rawCompletionText = effectiveText.slice(0, segmentLength);
    const completionText =
      generatedChoiceIndex === 0
        ? rawCompletionText
        : rawCompletionText.trimEnd();
    if (generatedChoiceIndex === 0 || completionText.trim().length > 0) {
      segments.push({
        prefixAddition: completion.slice(0, startOffset),
        completionText,
        ...(generatedChoiceIndex === 0 ? {} : { generatedChoiceIndex }),
        hasMore: offset !== undefined && segmentLength < effectiveText.length,
      });
    }
    startOffset += segmentLength;
    generatedChoiceIndex++;
    if (offset === undefined || segmentLength >= effectiveText.length) {
      break;
    }
  }
  return segments;
}

export type GhostTextCompletionTrimmer = (
  languageId: string,
  prefix: string,
  completion: string,
  lookAhead: number,
) => Promise<number | undefined>;

async function trimGhostTextCompletionSegment(
  languageId: string,
  prefix: string,
  completion: string,
  lookAhead: number,
): Promise<number | undefined> {
  return trimWithTerseBlockTrimmer(
    languageId,
    prefix,
    completion,
    3,
    lookAhead,
  );
}

export function ghostTextTrimmerLookahead(
  blockPosition: GhostTextBlockPosition | undefined,
): number {
  return blockPosition === 'empty-block' || blockPosition === 'block-end'
    ? GHOST_TEXT_LONG_LOOKAHEAD
    : GHOST_TEXT_SHORT_LOOKAHEAD;
}

async function shouldNaturallyRequestMultiline(
  request: GhostTextRequest,
  prompt: GhostTextPrompt,
  blockMode: GhostTextBlockMode,
  afterAcceptedCompletion: boolean,
): Promise<boolean> {
  const lineCount = request.document.text.split('\n').length;
  if (lineCount >= 8000) {
    return false;
  }
  if (blockMode === 'more-multiline') {
    return afterAcceptedCompletion;
  }
  const currentLine = lineBoundsAtOffset(
    prompt.virtualDocumentText,
    prompt.virtualCursorOffset,
  );
  if (
    (request.document.languageId === 'typescript' ||
      request.document.languageId === 'typescriptreact') &&
    currentLine.text.trim().length === 0
  ) {
    return true;
  }
  const languageId = request.document.languageId;
  if (isSupportedParserLanguage(languageId)) {
    const textAfterCursor = currentLine.text.slice(
      prompt.virtualCursorOffset - currentLine.start,
    );
    const inlineSuggestion = textAfterCursor.trim().length > 0;
    if (
      (await safelyIsEmptyBlockStart(
        languageId,
        prompt.virtualDocumentText,
        prompt.virtualCursorOffset,
      )) ||
      (inlineSuggestion &&
        (await safelyIsEmptyBlockStart(
          languageId,
          prompt.virtualDocumentText,
          currentLine.end,
        )))
    ) {
      return true;
    }
  }
  if (
    request.document.languageId === 'javascript' ||
    request.document.languageId === 'javascriptreact' ||
    request.document.languageId === 'python'
  ) {
    return (
      multilineScore(
        prompt.prefix,
        prompt.suffix,
        request.document.languageId,
      ) > 0.5
    );
  }
  return false;
}

function nextIndentation(source: string, offset: number): number {
  const nextLines = source.slice(offset).split('\n');
  for (let index = 1; index < nextLines.length; index++) {
    const match = /^(\s*)([^]*)$/.exec(nextLines[index] ?? '');
    if (match?.[2]) {
      return match[1]?.length ?? 0;
    }
  }
  return 0;
}

export function forceSingleLine(completion: string): string {
  const firstBreak = completion.match(/^\r?\n/);
  if (firstBreak) {
    return firstBreak[0] + (completion.split('\n')[1] ?? '');
  }
  return completion.split('\n')[0];
}

export async function trimMultilineCompletion(
  completion: string,
  languageId: string,
  behavior: GhostTextBehavior,
  afterAcceptedCompletion: boolean,
  documentText?: string,
  cursorOffset?: number,
  multilineStrategy?: GhostTextMultilineStrategy,
): Promise<string> {
  const blockMode =
    multilineStrategy?.blockMode ??
    resolveGhostTextBlockMode(behavior, languageId);
  if (multilineStrategy?.afterAcceptFallback) {
    return takeLines(completion, behavior.multilineAfterAcceptLines);
  }
  if (documentText === undefined || cursorOffset === undefined) {
    return completion;
  }
  const prefix = documentText.slice(0, cursorOffset);
  try {
    if (
      blockMode === 'more-multiline' &&
      isSupportedBlockTrimmerLanguage(languageId)
    ) {
      const offset = await trimWithTerseBlockTrimmer(
        languageId,
        prefix,
        completion,
      );
      return offset === undefined ? completion : completion.slice(0, offset);
    }
    if (afterAcceptedCompletion && multilineStrategy === undefined) {
      return takeLines(completion, behavior.multilineAfterAcceptLines);
    }
    if (!isSupportedParserLanguage(languageId)) {
      return completion;
    }
    const offset = await isBlockBodyFinished(
      languageId,
      prefix,
      completion,
      cursorOffset,
    );
    return offset === undefined ? completion : completion.slice(0, offset);
  } catch {
    // Unsupported or unavailable parsers leave the server result untrimmed.
    return completion;
  }
}

function takeLines(value: string, count: number): string {
  const lines = value.split('\n');
  return lines.length > count + 1
    ? lines.slice(0, count + 1).join('\n')
    : value;
}

async function safelyIsEmptyBlockStart(
  languageId: string,
  text: string,
  offset: number,
): Promise<boolean> {
  try {
    return await isEmptyBlockStart(languageId, text, offset);
  } catch {
    return false;
  }
}

function multilineScore(
  prefix: string,
  suffix: string,
  languageId: string,
): number {
  const prefixFeatures = textFeatures(prefix, languageId);
  const suffixFeatures = textFeatures(suffix, languageId);
  const numerical = [
    ...prefixFeatures.numeric.slice(0, 8),
    ...suffixFeatures.numeric.slice(0, 3),
    hasComment(prefix, -2, languageId) ? 1 : 0,
    hasComment(prefix.trimEnd(), -2, languageId) ? 1 : 0,
    prefix.endsWith('\n') ? 1 : 0,
  ];
  const language = oneHot(
    Object.keys(LANGUAGE_FEATURES).length + 1,
    LANGUAGE_FEATURES[languageId] ?? 0,
  );
  const mapSize = Object.keys(contextualFilterCharacterMap).length + 1;
  const features = numerical.concat(
    language,
    oneHot(
      mapSize,
      contextualFilterCharacterMap[prefixFeatures.lastCharacter] ?? 0,
    ),
    oneHot(
      mapSize,
      contextualFilterCharacterMap[prefixFeatures.trimmedLastCharacter] ?? 0,
    ),
    oneHot(
      mapSize,
      contextualFilterCharacterMap[suffixFeatures.firstCharacter] ?? 0,
    ),
    oneHot(
      mapSize,
      contextualFilterCharacterMap[suffixFeatures.leftTrimmedFirstCharacter] ?? 0,
    ),
  );
  return multilineModelPredict(features)[1];
}

function textFeatures(value: string, languageId: string): TextFeatures {
  const [firstLine, lastLine] = firstAndLast(value);
  const trimmed = value.trimEnd();
  const trimmedLastLine = firstAndLast(trimmed)[1];
  return {
    numeric: [
      value.length,
      firstLine.length,
      lastLine.length,
      lastLine.trimEnd().length,
      lastLine.trim().length,
      trimmed.length,
      trimmedLastLine.length,
      trimmedLastLine.trim().length,
      value.length,
      firstLine.length,
      lastLine.length,
      hasComment(value, -2, languageId) ? 1 : 0,
      hasComment(trimmed, -2, languageId) ? 1 : 0,
      value.endsWith('\n') ? 1 : 0,
    ],
    lastCharacter: value.slice(-1),
    trimmedLastCharacter: trimmed.slice(-1),
    firstCharacter: value[0] ?? '',
    leftTrimmedFirstCharacter: value.trimStart().slice(0, 1),
  };
}

function firstAndLast(value: string): [string, string] {
  const lines = value.split('\n');
  let last = lines[lines.length - 1] ?? '';
  if (last === '' && lines.length > 1) {
    last = lines[lines.length - 2] ?? '';
  }
  return [lines[0] ?? '', last];
}

function hasComment(
  value: string,
  lineNumber: number,
  languageId: string,
): boolean {
  const lines = value.split('\n').filter((line) => line.trim().length > 0);
  let index = lineNumber;
  if (Math.abs(index) > lines.length || index >= lines.length) {
    return false;
  }
  if (index < 0) {
    index = lines.length + index;
  }
  const line = lines[index] ?? '';
  return (COMMENT_MARKERS[languageId] ?? []).some((marker) =>
    line.includes(marker),
  );
}

function oneHot(size: number, index: number): number[] {
  const result = new Array<number>(size).fill(0);
  result[index] = 1;
  return result;
}

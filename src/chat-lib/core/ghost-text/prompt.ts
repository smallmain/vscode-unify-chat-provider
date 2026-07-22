import type * as vscode from 'vscode';
import type {
  GhostTextBehavior,
  GhostTextCodeSnippet,
  GhostTextContextProviderItemSource,
  GhostTextContextProviderPromptMatcher,
  GhostTextDiagnostic,
  GhostTextDocument,
  GhostTextPosition,
  GhostTextPromptContext,
  GhostTextPromptResult,
  GhostTextRecentEdit,
  GhostTextRequest,
  GhostTextSimilarFile,
  GhostTextTokenizer,
} from './types';
import {
  CPP_NES_SIMILAR_FILES_OPTIONS,
  DEFAULT_NES_SIMILAR_FILES_OPTIONS,
  selectSimilarFileSnippets,
} from '../nes/similar-files';

const MAX_SUFFIX_COMPARISON_TOKENS = 50;
const TOKENS_RESERVED_FOR_SUFFIX_ENCODING = 5;

export interface GhostTextPromptRenderBlock {
  path: string;
  type: 'context' | 'prefix';
  value: string;
  weight: number;
  group?: 'stable' | 'volatile';
  chunk?: string;
  source?: GhostTextContextProviderItemSource;
}

type WeightedPromptBlock = GhostTextPromptRenderBlock;

export interface GhostTextPromptRenderedBlock {
  readonly path: string;
  readonly type: 'context' | 'prefix';
  readonly value: string;
  readonly tokens: number;
  readonly group?: 'stable' | 'volatile';
  readonly chunk?: string;
  readonly source?: GhostTextContextProviderItemSource;
  readonly expectedTokens: number;
}

export interface GhostTextSplitContextRenderResult {
  readonly prefix: string;
  readonly context: readonly string[];
  readonly suffix: string;
  readonly prefixTokens: number;
  readonly suffixTokens: number;
  readonly prefixTokenLimit: number;
  readonly suffixTokenLimit: number;
  readonly adjustedPrefixTokenLimit: number;
  readonly blocks: readonly GhostTextPromptRenderedBlock[];
}

interface ElidablePromptBlock extends WeightedPromptBlock {
  originalIndex: number;
  tokens: number;
  lines: readonly PromptLine[];
  removed: boolean;
}

interface PromptLine {
  value: string;
  path: string;
  tokens: number;
}

interface ElidedPromptBlock extends WeightedPromptBlock {
  value: string;
  originalValue: string;
  tokens: number;
  expectedTokens: number;
}

interface PreparedDocument {
  text: string;
  cursorOffset: number;
  lineLengthIncrease: number;
}

/**
 * Behavior-equivalent port of the split-context CompletionsPromptFactory and
 * WishlistElision used by VS Code 1.128.0. The host supplies workspace data,
 * while this class owns suffix stability across requests.
 */
export class GhostTextPromptFactory {
  private cachedSuffix = '';

  constructor(
    private readonly behavior: GhostTextBehavior,
    private readonly tokenizer: GhostTextTokenizer,
  ) {}

  build(
    request: GhostTextRequest,
    token: vscode.CancellationToken,
  ): GhostTextPromptResult {
    if (token.isCancellationRequested) {
      return { type: 'cancelled', reason: 'cancelled before prompt extraction' };
    }
    if (request.context?.ignored) {
      return {
        type: 'content-excluded',
        reason: 'document is excluded from completions',
      };
    }

    const originalOffset = offsetAt(
      request.document.text,
      request.position,
    );
    if (originalOffset === undefined) {
      return { type: 'invalid-position', reason: 'cursor is outside document' };
    }
    const prepared = prepareDocument(request, originalOffset);
    if (!prepared) {
      return {
        type: 'invalid-position',
        reason: 'selected completion range is outside document',
      };
    }

    const promptTokenLimit =
      this.behavior.maxPromptCompletionTokens -
      this.behavior.maxCompletionTokens;
    const approximateMaximumCharacters = Math.floor(
      promptTokenLimit * 4.1,
    );
    const rawPrefix = prepared.text
      .slice(0, prepared.cursorOffset)
      .slice(-approximateMaximumCharacters);
    const rawSuffix = prepared.text
      .slice(prepared.cursorOffset)
      .slice(0, approximateMaximumCharacters);
    const suffix = this.stableSuffix(rawSuffix);

    const eligibleCharacters =
      this.behavior.suffixPercent > 0
        ? prepared.text.length
        : prepared.cursorOffset;
    if (
      eligibleCharacters < this.behavior.minPromptCharacters &&
      request.document.languageId !== 'scminput'
    ) {
      return { type: 'context-too-short', reason: 'not enough context' };
    }

    const contextBlocks = buildContextBlocks(
      request.document,
      request.position,
      prepared.cursorOffset,
      request.context,
      this.behavior,
    );
    const prefixBlock: WeightedPromptBlock = {
      path: '$.DocumentPrefix',
      type: 'prefix',
      value: normalizeLineEndings(rawPrefix),
      weight: 1,
    };
    const rendered = renderGhostTextSplitContextPrompt(
      [...contextBlocks, prefixBlock],
      suffix,
      promptTokenLimit,
      this.behavior.suffixPercent,
      this.tokenizer,
    );
    const [prefix, trailingWhitespace] = trimLastLine(rendered.prefix);
    const contextFiles = rendered.context.map((content) => ({
      path: '',
      content,
    }));

    if (token.isCancellationRequested) {
      return { type: 'cancelled', reason: 'cancelled during prompt extraction' };
    }

    request.context?.contextProviderFeedback?.submit(
      rendered.blocks
        .filter(
          (
            block,
          ): block is typeof block & {
            readonly source: GhostTextContextProviderItemSource;
          } => block.source !== undefined && block.expectedTokens > 0,
        )
        .map(
          (block): GhostTextContextProviderPromptMatcher => ({
            source: block.source,
            expectedTokens: block.expectedTokens,
            actualTokens: block.tokens,
          }),
        ),
    );

    return {
      type: 'prompt',
      prompt: {
        prefix,
        suffix: rendered.suffix,
        contextFiles,
        prefixTokens: rendered.prefixTokens,
        suffixTokens: rendered.suffixTokens,
        trailingWhitespace,
        selectedCompletionLineLengthIncrease: prepared.lineLengthIncrease,
        virtualDocumentText: prepared.text,
        virtualCursorOffset: prepared.cursorOffset,
      },
    };
  }

  clearSuffixCache(): void {
    this.cachedSuffix = '';
  }

  private stableSuffix(rawSuffix: string): string {
    const trimmed = rawSuffix.replace(/^.*/, '').trimStart();
    if (trimmed.length === 0) {
      return '';
    }
    if (trimmed === this.cachedSuffix) {
      return this.cachedSuffix;
    }

    let suffix = trimmed;
    if (this.cachedSuffix.length > 0) {
      const next = this.tokenizer
        .takeFirst(trimmed, MAX_SUFFIX_COMPARISON_TOKENS)
        .tokens;
      const cached = this.tokenizer
        .takeFirst(this.cachedSuffix, MAX_SUFFIX_COMPARISON_TOKENS)
        .tokens;
      if (next.length > 0 && cached.length > 0 && next[0] === cached[0]) {
        const distance = levenshteinDistance(next, cached);
        if (
          100 * distance <
          this.behavior.suffixMatchThreshold * next.length
        ) {
          suffix = this.cachedSuffix;
        }
      }
    }
    this.cachedSuffix = suffix;
    return suffix;
  }
}

export function positionAt(text: string, offset: number): GhostTextPosition {
  const bounded = Math.max(0, Math.min(offset, text.length));
  let line = 0;
  let lineStart = 0;
  for (let index = 0; index < bounded; index++) {
    if (text.charCodeAt(index) === 10) {
      line++;
      lineStart = index + 1;
    }
  }
  return { line, character: bounded - lineStart };
}

export function offsetAt(
  text: string,
  position: GhostTextPosition,
): number | undefined {
  if (
    !Number.isInteger(position.line) ||
    !Number.isInteger(position.character) ||
    position.line < 0 ||
    position.character < 0
  ) {
    return undefined;
  }
  let line = 0;
  let start = 0;
  while (line < position.line) {
    const newline = text.indexOf('\n', start);
    if (newline < 0) {
      return undefined;
    }
    start = newline + 1;
    line++;
  }
  const newline = text.indexOf('\n', start);
  let end = newline < 0 ? text.length : newline;
  if (end > start && text.charCodeAt(end - 1) === 13) {
    end--;
  }
  if (position.character > end - start) {
    return undefined;
  }
  return start + position.character;
}

export function lineBoundsAtOffset(
  text: string,
  offset: number,
): { start: number; end: number; text: string } {
  const bounded = Math.max(0, Math.min(offset, text.length));
  const previousNewline = text.lastIndexOf('\n', Math.max(0, bounded - 1));
  const start = previousNewline < 0 ? 0 : previousNewline + 1;
  const nextNewline = text.indexOf('\n', bounded);
  let end = nextNewline < 0 ? text.length : nextNewline;
  if (end > start && text.charCodeAt(end - 1) === 13) {
    end--;
  }
  return { start, end, text: text.slice(start, end) };
}

export function trimLastLine(source: string): [string, string] {
  const lastLine = source.slice(source.lastIndexOf('\n') + 1);
  const trailingCount = lastLine.length - lastLine.trimEnd().length;
  const trimmed = source.slice(0, source.length - trailingCount);
  const trailingWhitespace = source.slice(trimmed.length);
  return [
    lastLine.length === trailingCount ? trimmed : source,
    trailingWhitespace,
  ];
}

function prepareDocument(
  request: GhostTextRequest,
  originalOffset: number,
): PreparedDocument | undefined {
  const selected = request.selectedCompletionInfo;
  if (!selected?.text || selected.text.includes(')')) {
    return {
      text: request.document.text,
      cursorOffset: originalOffset,
      lineLengthIncrease: 0,
    };
  }
  const { start, end } = selected.range;
  if (
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    start < 0 ||
    end < start ||
    end > request.document.text.length
  ) {
    return undefined;
  }
  const text =
    request.document.text.slice(0, start) +
    selected.text +
    request.document.text.slice(end);
  let cursorOffset = originalOffset;
  if (originalOffset >= start) {
    const base = originalOffset < end ? end : originalOffset;
    cursorOffset = base + selected.text.length - (end - start);
  }
  const virtualPosition = positionAt(text, cursorOffset);
  const selectedEndPosition = positionAt(request.document.text, end);
  return {
    text,
    cursorOffset,
    lineLengthIncrease:
      virtualPosition.line === selectedEndPosition.line
        ? virtualPosition.character - selectedEndPosition.character
        : 0,
  };
}

interface RenderedBlockComponent {
  blocks: readonly ElidedPromptBlock[];
  cost: number;
}

interface RenderedSplitContextPrompt {
  prefix: RenderedBlockComponent;
  suffix: { text: string; tokens: readonly number[] };
  adjustedPrefixTokenLimit: number;
}

function renderSplitContextPromptFromLimits(
  blocks: readonly WeightedPromptBlock[],
  suffix: string,
  prefixTokenLimit: number,
  suffixTokenLimit: number,
  tokenizer: GhostTextTokenizer,
): RenderedSplitContextPrompt {
  if (prefixTokenLimit <= 0) {
    throw new Error('Prefix limit must be greater than 0.');
  }

  const maximumPrefixTokens = prepareBlocks(blocks, tokenizer).reduce(
    (sum, block) => sum + block.tokens,
    0,
  );
  let renderedSuffix: { text: string; tokens: readonly number[] };
  if (suffix.length === 0 || suffixTokenLimit <= 0) {
    renderedSuffix = { text: '', tokens: [] };
  } else {
    if (maximumPrefixTokens < prefixTokenLimit) {
      suffixTokenLimit += prefixTokenLimit - maximumPrefixTokens;
      prefixTokenLimit = maximumPrefixTokens;
    }
    renderedSuffix = tokenizer.takeFirst(suffix, suffixTokenLimit);
  }
  const adjustedPrefixTokenLimit =
    prefixTokenLimit +
    Math.max(0, suffixTokenLimit - renderedSuffix.tokens.length);

  return {
    prefix: renderBlockComponent(
      blocks,
      adjustedPrefixTokenLimit,
      tokenizer,
    ),
    suffix: renderedSuffix,
    adjustedPrefixTokenLimit,
  };
}

export function renderGhostTextSplitContextPrompt(
  blocks: readonly GhostTextPromptRenderBlock[],
  suffix: string,
  promptTokenLimit: number,
  suffixPercent: number,
  tokenizer: GhostTextTokenizer,
): GhostTextSplitContextRenderResult {
  const normalizedBlocks = blocks.map((block) => ({
    ...block,
    value: normalizeLineEndings(block.value),
  }));
  const normalizedSuffix = normalizeLineEndings(suffix);
  let prefixTokenLimit = promptTokenLimit;
  let suffixTokenLimit = 0;
  if (normalizedSuffix.length > 0 && suffixPercent > 0) {
    const availableTokens =
      promptTokenLimit - TOKENS_RESERVED_FOR_SUFFIX_ENCODING;
    suffixTokenLimit = Math.ceil(availableTokens * (suffixPercent / 100));
    prefixTokenLimit = availableTokens - suffixTokenLimit;
  }
  const rendered = renderSplitContextPromptFromLimits(
    normalizedBlocks,
    normalizedSuffix,
    prefixTokenLimit,
    suffixTokenLimit,
    tokenizer,
  );
  const prefix = rendered.prefix.blocks
    .filter((block) => block.type === 'prefix')
    .map((block) => block.value)
    .join('');
  return {
    prefix,
    context: contextGroups(rendered.prefix.blocks).map((file) => file.content),
    suffix: rendered.suffix.text,
    prefixTokens: rendered.prefix.cost,
    suffixTokens: rendered.suffix.tokens.length,
    prefixTokenLimit,
    suffixTokenLimit,
    adjustedPrefixTokenLimit: rendered.adjustedPrefixTokenLimit,
    blocks: rendered.prefix.blocks.map((block) => ({
      path: block.path,
      type: block.type,
      value: block.value,
      tokens: block.tokens,
      ...(block.group === undefined ? {} : { group: block.group }),
      ...(block.chunk === undefined ? {} : { chunk: block.chunk }),
      ...(block.source === undefined ? {} : { source: block.source }),
      expectedTokens: block.expectedTokens,
    })),
  };
}

function renderBlockComponent(
  blocks: readonly WeightedPromptBlock[],
  limit: number,
  tokenizer: GhostTextTokenizer,
): RenderedBlockComponent {
  const prepared = prepareBlocks(blocks, tokenizer);
  const maximumPrefixTokens = prepared.reduce(
    (sum, block) => sum + block.tokens,
    0,
  );
  const blocksWithinBudget = removeLowWeightBlocks(
    prepared,
    limit,
    maximumPrefixTokens,
  );
  const retainedLines = blocksWithinBudget
    .filter((block) => !block.removed)
    .flatMap((block) => block.lines);
  const fitted = fitLines(retainedLines, limit, tokenizer);
  let usedTokens = fitted.tokens;
  const result = blocksWithinBudget.map((block): ElidedPromptBlock => {
    if (block.removed) {
      if (!block.chunk && usedTokens + block.tokens <= limit) {
        usedTokens += block.tokens;
        return {
          ...block,
          originalValue: block.value,
          expectedTokens: block.tokens,
          tokens: block.tokens,
        };
      }
      return {
        ...block,
        originalValue: block.value,
        expectedTokens: block.tokens,
        value: '',
        tokens: 0,
      };
    }
    const value = fitted.lines
      .filter((line) => line.path === block.path)
      .map((line) => line.value)
      .join('');
    return {
      ...block,
      originalValue: block.value,
      expectedTokens: block.tokens,
      value,
      tokens: value === block.value ? block.tokens : tokenizer.count(value),
    };
  });
  return {
    blocks: result,
    cost: result.reduce((sum, block) => sum + block.tokens, 0),
  };
}

function prepareBlocks(
  blocks: readonly WeightedPromptBlock[],
  tokenizer: GhostTextTokenizer,
): ElidablePromptBlock[] {
  const paths = new Set<string>();
  return blocks.map((block, originalIndex) => {
    if (paths.has(block.path)) {
      throw new Error(`Duplicate prompt component path: ${block.path}`);
    }
    paths.add(block.path);
    const lines = block.value
      .split(/([^\n]*\n+)/)
      .filter((line) => line.length > 0)
      .map((value): PromptLine => ({
        value,
        path: block.path,
        tokens: tokenizer.count(value),
      }));
    return {
      ...block,
      originalIndex,
      tokens: lines.reduce((sum, line) => sum + line.tokens, 0),
      lines,
      removed: false,
    };
  });
}

function removeLowWeightBlocks(
  blocks: ElidablePromptBlock[],
  limit: number,
  maximumTokens: number,
): ElidablePromptBlock[] {
  let total = maximumTokens;
  const byWeight = [...blocks].sort((left, right) => left.weight - right.weight);
  for (const block of byWeight) {
    if (total <= limit) {
      break;
    }
    if (block.weight === 1 || block.removed) {
      continue;
    }
    if (block.chunk) {
      for (const related of byWeight) {
        if (!related.removed && related.chunk === block.chunk) {
          related.removed = true;
          total -= related.tokens;
        }
      }
    } else {
      block.removed = true;
      total -= block.tokens;
    }
  }
  return byWeight.sort(
    (left, right) => left.originalIndex - right.originalIndex,
  );
}

function fitLines(
  lines: readonly PromptLine[],
  limit: number,
  tokenizer: GhostTextTokenizer,
): { lines: readonly PromptLine[]; tokens: number } {
  const result: PromptLine[] = [];
  let tokens = 0;
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index];
    if (tokens + line.tokens > limit) {
      break;
    }
    result.unshift(line);
    tokens += line.tokens;
  }
  if (result.length > 0 || lines.length === 0) {
    return { lines: result, tokens };
  }
  const last = lines[lines.length - 1];
  const partial = tokenizer.takeLast(last.value, limit);
  return {
    lines: [
      { value: partial.text, path: last.path, tokens: partial.tokens.length },
    ],
    tokens: partial.tokens.length,
  };
}

function contextGroups(
  blocks: readonly ElidedPromptBlock[],
): readonly { path: string; content: string }[] {
  const groups = new Map<number, string[]>();
  for (const block of blocks) {
    if (block.type !== 'context' || block.group === undefined) {
      continue;
    }
    const index = block.group === 'stable' ? 0 : 1;
    const values = groups.get(index) ?? [];
    groups.set(index, values);
    const value = block.value.trim();
    if (value.length > 0) {
      values.push(value);
    }
  }
  const maximumIndex = Math.max(...groups.keys(), -1);
  return Array.from({ length: maximumIndex + 1 }, (_value, index) => ({
    path: '',
    content: (groups.get(index) ?? []).join('\n').trim(),
  }));
}

function buildContextBlocks(
  document: GhostTextDocument,
  position: GhostTextPosition,
  cursorOffset: number,
  context: GhostTextPromptContext | undefined,
  behavior: GhostTextBehavior,
): WeightedPromptBlock[] {
  const blocks: WeightedPromptBlock[] = [];
  const marker = documentMarker(document);
  if (marker) {
    blocks.push(contextBlock('DocumentMarker', marker, 0.7, 'stable'));
  }

  if (context?.traits?.length) {
    blocks.push(
      contextBlock(
        'Traits.Header',
        'Consider this related information:',
        0.6,
        'stable',
      ),
      ...context.traits.map((trait, index) =>
        contextBlock(
          'Traits.Text',
          `${trait.name}: ${trait.value}`,
          0.6,
          'stable',
          index,
          undefined,
          trait.contextProviderSource,
        ),
      ),
    );
  }
  blocks.push(...diagnosticBlocks(document, position, context?.diagnostics));
  blocks.push(...codeSnippetBlocks(context?.codeSnippets));
  blocks.push(
    ...similarFileBlocks(
      document,
      cursorOffset,
      context?.similarFiles,
      behavior,
    ),
  );
  const recent = recentEditsBlock(
    document,
    position,
    context?.recentEdits,
  );
  if (recent) {
    blocks.push(recent);
  }
  return blocks;
}

function contextBlock(
  name: string,
  value: string,
  weight: number,
  group: 'stable' | 'volatile',
  index = 0,
  chunk?: string,
  source?: GhostTextContextProviderItemSource,
): WeightedPromptBlock {
  return {
    path: `$.${name}${index > 0 ? `[${index}]` : ''}`,
    type: 'context',
    value: value.endsWith('\n') ? value : `${value}\n`,
    weight,
    group,
    ...(chunk ? { chunk } : {}),
    ...(source ? { source } : {}),
  };
}

function diagnosticBlocks(
  document: GhostTextDocument,
  position: GhostTextPosition,
  diagnostics: readonly GhostTextDiagnostic[] | undefined,
): WeightedPromptBlock[] {
  if (!diagnostics?.length) {
    return [];
  }
  const grouped = new Map<
    string,
    {
      readonly path: string;
      readonly source?: GhostTextContextProviderItemSource;
      readonly values: GhostTextDiagnostic[];
    }
  >();
  for (const diagnostic of diagnostics) {
    const source = diagnostic.contextProviderSource;
    const key = source
      ? `provider:${source.providerId}\u0000${source.itemId}`
      : `path:${diagnostic.path}`;
    const group = grouped.get(key) ?? {
      path: diagnostic.path,
      ...(source ? { source } : {}),
      values: [],
    };
    group.values.push(diagnostic);
    grouped.set(key, group);
  }
  return [...grouped.values()]
    .map((group) => ({
      ...group,
      importance: Math.max(
        ...group.values.map((value) => value.importance ?? 0),
      ),
    }))
    .sort((left, right) => right.importance - left.importance)
    .reverse()
    .flatMap(({ path, source, values }, index) => {
      const sorted =
        path === (document.relativePath ?? document.filePath)
          ? [...values].sort(
              (left, right) =>
                Math.abs(left.line - position.line) -
                Math.abs(right.line - position.line),
            )
          : values;
      const chunk = source
        ? `diagnostics:${source.providerId}:${source.itemId}`
        : `diagnostics:${path}`;
      return [
        contextBlock(
          `Diagnostics.Header[${index}]`,
          path
            ? `Consider the following ${normalizeLanguageId(document.languageId)} diagnostics from ${path}:`
            : `Consider the following ${normalizeLanguageId(document.languageId)} diagnostics:`,
          0.65,
          'stable',
          0,
          chunk,
          source,
        ),
        contextBlock(
          `Diagnostics.Text[${index}]`,
          sorted.map(formatDiagnostic).join('\n'),
          0.65,
          'stable',
          0,
          chunk,
        ),
      ];
    });
}

function formatDiagnostic(diagnostic: GhostTextDiagnostic): string {
  const code =
    diagnostic.code === undefined
      ? ''
      : ` ${(diagnostic.source ?? '').toUpperCase()}${String(diagnostic.code)}`;
  return `${diagnostic.line + 1}:${diagnostic.character + 1} - ${diagnostic.severity}${code}: ${diagnostic.message}`;
}

function codeSnippetBlocks(
  snippets: readonly GhostTextCodeSnippet[] | undefined,
): WeightedPromptBlock[] {
  if (!snippets?.length) {
    return [];
  }
  const grouped = new Map<string, GhostTextCodeSnippet[]>();
  for (const snippet of snippets) {
    if (!snippet.value) {
      continue;
    }
    const values = grouped.get(snippet.path) ?? [];
    values.push(snippet);
    grouped.set(snippet.path, values);
  }
  return [...grouped.entries()]
    .map(([path, values]) => ({
      path,
      values,
      importance: Math.max(...values.map((value) => value.importance ?? 0)),
    }))
    .sort((left, right) => right.importance - left.importance)
    .reverse()
    .flatMap(({ path, values }, index) => {
      const chunk = `code-snippets:${path}`;
      const blocks: WeightedPromptBlock[] = [
        contextBlock(
          `CodeSnippets.Header[${index}]`,
          path
            ? `Compare ${values.length > 1 ? 'these snippets' : 'this snippet'} from ${path}:`
            : `Compare ${values.length > 1 ? 'these snippets' : 'this snippet'}:`,
          0.9,
          'stable',
          0,
          chunk,
        ),
      ];
      for (const [itemIndex, value] of values.entries()) {
        blocks.push(
          contextBlock(
            `CodeSnippets.Text[${index}][${itemIndex}]`,
            value.value,
            0.9,
            'stable',
            0,
            chunk,
            value.contextProviderSource,
          ),
        );
        if (itemIndex < values.length - 1) {
          blocks.push(
            contextBlock(
              `CodeSnippets.Separator[${index}][${itemIndex}]`,
              '---',
              0.9,
              'stable',
              0,
              chunk,
            ),
          );
        }
      }
      return blocks;
    });
}

function similarFileBlocks(
  document: GhostTextDocument,
  cursorOffset: number,
  files: readonly GhostTextSimilarFile[] | undefined,
  behavior: GhostTextBehavior,
): WeightedPromptBlock[] {
  if (!files?.length || behavior.numberOfSnippets === 0) {
    return [];
  }
  const options = document.languageId === 'cpp'
    ? CPP_NES_SIMILAR_FILES_OPTIONS
    : {
        ...DEFAULT_NES_SIMILAR_FILES_OPTIONS,
        snippetLength: behavior.similarFileWindowLines,
        maxTopSnippets: behavior.numberOfSnippets,
        maxCharPerFile: behavior.maximumCharactersPerSimilarFile,
        maxNumberOfFiles: behavior.maximumSimilarFiles,
      };
  const snippets = selectSimilarFileSnippets(
    document.text,
    cursorOffset,
    files.map((file) => ({
      uri: file.path,
      path: file.path,
      text: file.content,
    })),
    options,
  );
  return snippets.map((snippet, index) =>
    contextBlock(
      'SimilarFiles',
      snippet.path
        ? `Compare this snippet from ${snippet.path}:\n${snippet.snippet}`
        : `Compare this snippet:\n${snippet.snippet}`,
      0.8,
      'stable',
      index,
      `similar:${snippet.path}:${snippet.startLine}`,
    ),
  );
}

function recentEditsBlock(
  document: GhostTextDocument,
  position: GhostTextPosition,
  edits: readonly GhostTextRecentEdit[] | undefined,
): WeightedPromptBlock | undefined {
  if (!edits?.length) {
    return undefined;
  }
  const selected: string[] = [];
  const files = new Set<string>();
  for (let index = edits.length - 1; index >= 0; index--) {
    if (selected.length >= 8) {
      break;
    }
    const edit = edits[index];
    if (
      edit.uri === document.uri &&
      edit.startLine !== undefined &&
      edit.endLine !== undefined &&
      (Math.abs(edit.startLine - 1 - position.line) <= 100 ||
        Math.abs(edit.endLine - 1 - position.line) <= 100)
    ) {
      continue;
    }
    if (!files.has(edit.uri) && files.size >= 20) {
      break;
    }
    files.add(edit.uri);
    selected.unshift(
      edit.path
        ? `File: ${edit.path}\n${ensureNewline(edit.summary)}`
        : `Recently edited file:\n${ensureNewline(edit.summary)}`,
    );
  }
  if (!selected.length) {
    return undefined;
  }
  return contextBlock(
    'RecentEdits',
    'These are recently edited files. Do not suggest code that has been deleted.\n' +
      selected.join('') +
      'End of recent edits\n',
    0.99,
    'volatile',
    0,
    'recent-edits',
  );
}

function ensureNewline(value: string): string {
  return value.endsWith('\n') ? value : `${value}\n`;
}

function documentMarker(document: GhostTextDocument): string {
  if (document.relativePath && !document.notebook) {
    return `Path: ${document.relativePath}`;
  }
  if (
    document.languageId === 'php' ||
    document.languageId === 'plaintext' ||
    document.text.startsWith('#!') ||
    document.text.startsWith('<!DOCTYPE')
  ) {
    return '';
  }
  const shebangMarkers: Readonly<Record<string, string>> = {
    html: '<!DOCTYPE html>',
    python: '#!/usr/bin/env python3',
    ruby: '#!/usr/bin/env ruby',
    shellscript: '#!/bin/sh',
    yaml: '# YAML data',
  };
  return shebangMarkers[document.languageId] ??
    `Language: ${document.languageId}`;
}

function normalizeLanguageId(languageId: string): string {
  const normalized = languageId.toLowerCase();
  const aliases: Readonly<Record<string, string>> = {
    javascriptreact: 'javascript',
    jsx: 'javascript',
    typescriptreact: 'typescript',
    jade: 'pug',
    cshtml: 'razor',
    c: 'cpp',
  };
  return aliases[normalized] ?? normalized;
}

function levenshteinDistance(
  left: readonly number[],
  right: readonly number[],
): number {
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex++) {
    const current = [leftIndex];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex++) {
      current[rightIndex] = Math.min(
        current[rightIndex - 1] + 1,
        previous[rightIndex] + 1,
        previous[rightIndex - 1] +
          (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[right.length];
}

function normalizeLineEndings(value: string): string {
  return value.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

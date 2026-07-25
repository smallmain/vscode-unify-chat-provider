import type {
  CopilotBehaviorConfig,
  NesAggressivenessLevel,
  NesGlobalBudgetConfig,
  NesGlobalBudgetPart,
  NesLineNumberStyle,
  NesPromptStrategy,
} from '../behavior-config';
import {
  COPILOT_BEHAVIOR_CONFIG,
  validateCopilotBehaviorConfig,
} from '../behavior-config';
import {
  nes41Miniv3SystemPrompt,
  systemPromptTemplate,
  unifiedModelSystemPrompt,
  xtab275SystemPrompt,
} from '../../upstream/extension/xtab/common/systemMessages';
import { PromptTags } from '../../upstream/extension/xtab/common/tags';
import { countNesLineTokens, countNesTokens } from './tokenizer';
import type {
  NesDiagnosticContext,
  NesDocumentContext,
  NesEditWindow,
  NesHistoryContext,
  NesLanguageContextItem,
  NesNeighborSnippet,
  NesPromptBuildResult,
  NesPromptBudgetTraceEntry,
  NesPromptContext,
  NesPromptHistoryEvent,
  NesTextChangeContext,
} from './types';

interface LineDocument {
  readonly lines: string[];
  readonly starts: number[];
  readonly eol: '\n' | '\r\n';
}

interface ClippedLines {
  readonly lines: string[];
  readonly startLine: number;
  readonly truncated: boolean;
  readonly remainingTokens: number;
}

function splitDocument(text: string): LineDocument {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const starts: number[] = [];
  let offset = 0;
  for (let index = 0; index < lines.length; index += 1) {
    starts.push(offset);
    offset += lines[index].length;
    if (index < lines.length - 1) {
      offset += eol.length;
    }
  }
  return { lines, starts, eol };
}

function lineAtOffset(document: LineDocument, offset: number): number {
  const bounded = Math.max(0, offset);
  let low = 0;
  let high = document.starts.length - 1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (document.starts[middle] <= bounded) {
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return Math.max(0, high);
}

function editWindowForDocument(
  document: LineDocument,
  text: string,
  cursorOffsetValue: number,
  config: CopilotBehaviorConfig,
  linesBelowEditWindow = config.prompt.linesBelowEditWindow,
): NesEditWindow {
  const cursorOffset = Math.max(
    0,
    Math.min(text.length, cursorOffsetValue),
  );
  const cursorLineOffset = lineAtOffset(document, cursorOffset);
  const cursorColumn = cursorOffset - document.starts[cursorLineOffset];
  const startLine = Math.max(
    0,
    cursorLineOffset - config.prompt.linesAboveEditWindow,
  );
  const endLineExclusive = Math.min(
    document.lines.length,
    cursorLineOffset + linesBelowEditWindow + 1,
  );
  const startOffset = document.starts[startLine] ?? 0;
  const lastLine = Math.max(startLine, endLineExclusive - 1);
  const endOffset =
    (document.starts[lastLine] ?? text.length) +
    (document.lines[lastLine]?.length ?? 0);
  return {
    startLine,
    endLineExclusive,
    startOffset,
    endOffset,
    cursorOffset,
    cursorLineOffset,
    cursorColumn,
    text: text.slice(startOffset, endOffset),
    lines: document.lines.slice(startLine, endLineExclusive),
    eol: document.eol,
  };
}

export function computeNesEditWindow(
  text: string,
  cursorOffset: number,
  config: CopilotBehaviorConfig,
  linesBelowEditWindow = config.prompt.linesBelowEditWindow,
): NesEditWindow {
  const document = splitDocument(text);
  return editWindowForDocument(
    document,
    text,
    cursorOffset,
    config,
    linesBelowEditWindow,
  );
}

function createEditWindow(
  context: NesPromptContext,
  config: CopilotBehaviorConfig,
  linesBelowEditWindow = config.prompt.linesBelowEditWindow,
): { readonly document: LineDocument; readonly window: NesEditWindow } {
  const document = splitDocument(context.current.text);
  return {
    document,
    window: editWindowForDocument(
      document,
      context.current.text,
      context.cursorOffset,
      config,
      linesBelowEditWindow,
    ),
  };
}

function expandPageRange(
  lines: readonly string[],
  preserveStart: number,
  preserveEndExclusive: number,
  maxTokens: number,
  pageSize: number,
  prioritizeAbove: boolean,
  useLeftoverBudgetFromAbove: boolean,
): {
  readonly start: number;
  readonly endExclusive: number;
  readonly remainingTokens: number;
} {
  const totalPages = Math.ceil(lines.length / pageSize);
  let firstPage = Math.floor(preserveStart / pageSize);
  let lastPage = Math.floor(
    Math.max(preserveStart, preserveEndExclusive - 1) / pageSize,
  );
  const pageTokens = (page: number): number =>
    countNesLineTokens(
      lines.slice(
        page * pageSize,
        Math.min((page + 1) * pageSize, lines.length),
      ),
    );
  let available = maxTokens;
  for (let page = firstPage; page <= lastPage; page += 1) {
    available -= pageTokens(page);
  }
  if (available < 0) {
    return {
      start: firstPage * pageSize,
      endExclusive: Math.min(lines.length, (lastPage + 1) * pageSize),
      remainingTokens: available,
    };
  }

  const aboveBudget = prioritizeAbove ? available : Math.floor(available / 2);
  let above = aboveBudget;
  for (let page = firstPage - 1; page >= 0; page -= 1) {
    const cost = pageTokens(page);
    if (cost > above) {
      break;
    }
    above -= cost;
    firstPage = page;
  }
  let below = prioritizeAbove
    ? above
    : Math.floor(available / 2) + (useLeftoverBudgetFromAbove ? above : 0);
  for (let page = lastPage + 1; page < totalPages; page += 1) {
    const cost = pageTokens(page);
    if (cost > below) {
      break;
    }
    below -= cost;
    lastPage = page;
  }
  return {
    start: firstPage * pageSize,
    endExclusive: Math.min(lines.length, (lastPage + 1) * pageSize),
    remainingTokens: below,
  };
}

function clipAroundRange(
  lines: readonly string[],
  start: number,
  endExclusive: number,
  maxTokens: number,
  pageSize: number,
  prioritizeAbove = false,
  useLeftoverBudgetFromAbove = false,
): ClippedLines {
  const range = expandPageRange(
    lines,
    start,
    endExclusive,
    maxTokens,
    pageSize,
    prioritizeAbove,
    useLeftoverBudgetFromAbove,
  );
  return {
    lines: lines.slice(range.start, range.endExclusive),
    startLine: range.start,
    truncated: range.start > 0 || range.endExclusive < lines.length,
    remainingTokens: range.remainingTokens,
  };
}

function insertCursor(
  lines: readonly string[],
  window: NesEditWindow,
): string[] {
  return lines.map((line, index) =>
    index === window.cursorLineOffset
      ? `${line.slice(0, window.cursorColumn)}${PromptTags.CURSOR}${line.slice(window.cursorColumn)}`
      : line,
  );
}

function addLineNumbers(
  lines: readonly string[],
  style: NesLineNumberStyle,
  startLine = 0,
): string[] {
  switch (style) {
    case 'withSpaceAfter':
      return lines.map((line, index) => `${startLine + index}| ${line}`);
    case 'withoutSpaceAfter':
      return lines.map((line, index) => `${startLine + index}|${line}`);
    case 'none':
      return [...lines];
  }
}

function buildCurrentFile(
  context: NesPromptContext,
  document: LineDocument,
  window: NesEditWindow,
  config: CopilotBehaviorConfig,
  includeTags: boolean,
  maxTokens = config.prompt.currentFileTokens,
  forcedRange?: { readonly start: number; readonly endExclusive: number },
  forcedArea?: { readonly start: number; readonly endExclusive: number },
): {
  readonly content: string;
  readonly area: string;
  readonly tokens: number;
} {
  const areaStart = Math.max(
    0,
    Math.min(
      document.lines.length,
      forcedArea?.start ??
        window.cursorLineOffset - config.prompt.surroundingLines,
    ),
  );
  const areaEnd = Math.max(
    areaStart,
    Math.min(
      document.lines.length,
      forcedArea?.endExclusive ??
        window.cursorLineOffset + config.prompt.surroundingLines + 1,
    ),
  );
  const linesWithCursor = insertCursor(document.lines, window);
  const areaLines = [
    PromptTags.AREA_AROUND.start,
    ...linesWithCursor.slice(areaStart, window.startLine),
    PromptTags.EDIT_WINDOW.start,
    ...linesWithCursor.slice(window.startLine, window.endLineExclusive),
    PromptTags.EDIT_WINDOW.end,
    ...linesWithCursor.slice(window.endLineExclusive, areaEnd),
    PromptTags.AREA_AROUND.end,
  ];
  const numberedCurrentLines = addLineNumbers(
    document.lines,
    config.prompt.currentFileLineNumbers,
  );
  const currentFileCursorLines = addLineNumbers(
    config.prompt.currentFileIncludeCursorTag
      ? linesWithCursor
      : document.lines,
    config.prompt.currentFileLineNumbers,
  );
  const areaForCurrent =
    includeTags && config.prompt.currentFileLineNumbers === 'none'
      ? areaLines
      : [
          ...currentFileCursorLines.slice(areaStart, window.startLine),
          ...currentFileCursorLines.slice(
            window.startLine,
            window.endLineExclusive,
          ),
          ...currentFileCursorLines.slice(window.endLineExclusive, areaEnd),
        ];
  const normalizedForcedRange = forcedRange
    ? {
        start: Math.max(0, Math.min(document.lines.length, forcedRange.start)),
        endExclusive: Math.max(
          0,
          Math.min(document.lines.length, forcedRange.endExclusive),
        ),
      }
    : undefined;
  const clipped = normalizedForcedRange
    ? (() => {
        const start = Math.min(
          normalizedForcedRange.start,
          normalizedForcedRange.endExclusive,
        );
        const endExclusive = Math.max(
          normalizedForcedRange.start,
          normalizedForcedRange.endExclusive,
        );
        const selected = numberedCurrentLines.slice(start, endExclusive);
        return {
          lines: selected,
          startLine: start,
          truncated: start > 0 || endExclusive < numberedCurrentLines.length,
          remainingTokens: maxTokens - countNesLineTokens(selected),
        };
      })()
    : clipAroundRange(
        numberedCurrentLines,
        areaStart,
        areaEnd,
        maxTokens,
        config.prompt.pageSize,
        config.prompt.currentFilePrioritizeAboveCursor,
        config.prompt.currentFileUseLeftoverBudgetFromAbove,
      );
  if (clipped.remainingTokens < 0) {
    throw new NesPromptTooLargeError('currentFile');
  }
  let currentLines = clipped.lines;
  if (areaForCurrent.length > 0) {
    const localAreaStart = areaStart - clipped.startLine;
    const localAreaEnd = areaEnd - clipped.startLine;
    currentLines = [
      ...clipped.lines.slice(0, Math.max(0, localAreaStart)),
      ...areaForCurrent,
      ...clipped.lines.slice(Math.max(0, localAreaEnd)),
    ];
  }
  const content = currentLines.join('\n');
  return {
    content,
    area: areaLines.join('\n'),
    tokens: countNesTokens(content),
  };
}

interface OffsetSpan {
  readonly start: number;
  readonly endExclusive: number;
}

interface RecentDocumentCandidate {
  readonly document: NesDocumentContext;
  readonly focalRanges?: readonly OffsetSpan[];
  readonly editEntryCount: number;
}

function normalizedPath(value: string): string {
  return value.replace(/\\/g, '/');
}

function pathFromUri(uri: string): string {
  try {
    const parsed = new URL(uri);
    const path = decodeURIComponent(parsed.pathname);
    return parsed.protocol === 'vscode-notebook-cell:' && parsed.hash
      ? `${path}#${parsed.hash.slice(1)}`
      : path;
  } catch {
    return uri;
  }
}

function documentPromptPath(document: NesDocumentContext): string {
  const base = normalizedPath(document.path || pathFromUri(document.uri));
  if (!document.uri.startsWith('vscode-notebook-cell:') || base.includes('#')) {
    return base;
  }
  try {
    const fragment = new URL(document.uri).hash.slice(1);
    return fragment ? `${base}#${fragment}` : base;
  } catch {
    return base;
  }
}

function fallbackChange(entry: NesHistoryContext): NesTextChangeContext[] {
  if (entry.before === entry.after) return [];
  let prefix = 0;
  while (
    prefix < entry.before.length &&
    prefix < entry.after.length &&
    entry.before[prefix] === entry.after[prefix]
  ) {
    prefix += 1;
  }
  let suffix = 0;
  while (
    suffix < entry.before.length - prefix &&
    suffix < entry.after.length - prefix &&
    entry.before[entry.before.length - suffix - 1] ===
      entry.after[entry.after.length - suffix - 1]
  ) {
    suffix += 1;
  }
  return [
    {
      rangeOffset: prefix,
      rangeLength: entry.before.length - prefix - suffix,
      text: entry.after.slice(prefix, entry.after.length - suffix),
    },
  ];
}

function applyChanges(
  text: string,
  changes: readonly NesTextChangeContext[],
): string | undefined {
  let result = text;
  const sorted = [...changes].sort(
    (left, right) => right.rangeOffset - left.rangeOffset,
  );
  let boundary = text.length;
  for (const change of sorted) {
    const end = change.rangeOffset + change.rangeLength;
    if (change.rangeOffset < 0 || change.rangeLength < 0 || end > boundary) {
      return undefined;
    }
    result = `${result.slice(0, change.rangeOffset)}${change.text}${result.slice(end)}`;
    boundary = change.rangeOffset;
  }
  return result;
}

function changesForEntry(
  entry: NesHistoryContext,
): readonly NesTextChangeContext[] {
  const changes = [...(entry.changes ?? [])].sort(
    (left, right) => left.rangeOffset - right.rangeOffset,
  );
  return changes.length > 0 &&
    applyChanges(entry.before, changes) === entry.after
    ? changes
    : fallbackChange(entry);
}

function newRangesForEntry(entry: NesHistoryContext): OffsetSpan[] {
  let delta = 0;
  return changesForEntry(entry).map((change) => {
    const start = change.rangeOffset + delta;
    delta += change.text.length - change.rangeLength;
    return { start, endExclusive: start + change.text.length };
  });
}

function mapOffsetThroughChanges(
  offset: number,
  changes: readonly NesTextChangeContext[],
  affinity: 'left' | 'right',
): number {
  let delta = 0;
  for (const change of changes) {
    const start = change.rangeOffset;
    const end = start + change.rangeLength;
    if (offset < start || (offset === start && affinity === 'left')) break;
    if (offset > end || (offset === end && affinity === 'right')) {
      delta += change.text.length - change.rangeLength;
      continue;
    }
    return start + delta + (affinity === 'right' ? change.text.length : 0);
  }
  return offset + delta;
}

function transformRangeForward(
  range: OffsetSpan,
  entry: NesHistoryContext,
): OffsetSpan {
  const changes = changesForEntry(entry);
  return {
    start: mapOffsetThroughChanges(range.start, changes, 'left'),
    endExclusive: mapOffsetThroughChanges(range.endExclusive, changes, 'right'),
  };
}

export function projectNesHistoryFocalRanges(
  entriesNewestFirst: readonly NesHistoryContext[],
): readonly { readonly start: number; readonly endExclusive: number }[] {
  const newerEdits: NesHistoryContext[] = [];
  const focalRanges: OffsetSpan[] = [];
  for (const entry of entriesNewestFirst) {
    let ranges = newRangesForEntry(entry);
    for (let index = newerEdits.length - 1; index >= 0; index -= 1) {
      ranges = ranges.map((range) =>
        transformRangeForward(range, newerEdits[index]),
      );
    }
    focalRanges.push(...ranges);
    newerEdits.push(entry);
  }
  return focalRanges;
}

function synthesizedHistoryEvents(
  context: NesPromptContext,
): NesPromptHistoryEvent[] {
  if (context.historyEvents) {
    return [...context.historyEvents].sort(
      (left, right) => right.timestamp - left.timestamp,
    );
  }
  return [
    ...context.editHistory.map((entry) => ({
      ...entry,
      kind: 'edit' as const,
    })),
    ...context.recentDocuments
      .filter((document) => (document.visibleRanges?.length ?? 0) > 0)
      .map((document) => ({
        kind: 'visibleRanges' as const,
        uri: document.uri,
        path: document.path,
        relativePath: document.relativePath,
        languageId: document.languageId,
        text: document.text,
        timestamp: document.lastViewedAt ?? 0,
        visibleRanges: document.visibleRanges ?? [],
      })),
  ].sort((left, right) => right.timestamp - left.timestamp);
}

function documentForHistoryEvent(
  event: NesPromptHistoryEvent,
): NesDocumentContext {
  return {
    uri: event.uri,
    path: event.path || pathFromUri(event.uri),
    relativePath: event.relativePath ?? (event.path || pathFromUri(event.uri)),
    languageId: event.languageId,
    version: 0,
    text: event.kind === 'edit' ? event.after : event.text,
  };
}

function collectRecentCandidates(
  context: NesPromptContext,
  config: CopilotBehaviorConfig,
): RecentDocumentCandidate[] {
  const events = synthesizedHistoryEvents(context).filter(
    (event) =>
      event.uri !== context.current.uri &&
      (event.kind === 'edit' || config.prompt.recentFilesIncludeViewed),
  );
  if (config.prompt.recentFilesClippingStrategy === 'aroundEditRange') {
    const seen = new Set<string>();
    const result: RecentDocumentCandidate[] = [];
    for (const event of events) {
      if (seen.has(event.uri)) continue;
      seen.add(event.uri);
      result.push({
        document: documentForHistoryEvent(event),
        focalRanges:
          event.kind === 'edit'
            ? newRangesForEntry(event)
            : event.visibleRanges.map((range) => ({
                start: range.start,
                endExclusive: range.end,
              })),
        editEntryCount: 1,
      });
      if (result.length >= config.prompt.recentFileCount) break;
    }
    return result;
  }

  const order: string[] = [];
  const grouped = new Map<string, NesPromptHistoryEvent[]>();
  for (const event of events) {
    const existing = grouped.get(event.uri);
    if (existing) {
      existing.push(event);
    } else if (order.length < config.prompt.recentFileCount) {
      order.push(event.uri);
      grouped.set(event.uri, [event]);
    }
  }
  return order.map((uri) => {
    const entries = grouped.get(uri) ?? [];
    const mostRecent = entries[0];
    const editEntries = entries.filter(
      (event): event is Extract<NesPromptHistoryEvent, { kind: 'edit' }> =>
        event.kind === 'edit',
    );
    const focalRanges = projectNesHistoryFocalRanges(editEntries);
    const editEntryCount = editEntries.length;
    return {
      document: documentForHistoryEvent(mostRecent),
      ...(focalRanges.length > 0 ? { focalRanges } : {}),
      editEntryCount: Math.max(editEntryCount, 1),
    };
  });
}

function clipDocumentFromStart(
  lines: readonly string[],
  budget: number,
  pageSize: number,
): ClippedLines {
  let remainingTokens = budget;
  let endExclusive = 0;
  while (endExclusive < lines.length) {
    const nextEnd = Math.min(lines.length, endExclusive + pageSize);
    const cost = countNesLineTokens(lines.slice(endExclusive, nextEnd));
    if (cost > remainingTokens) {
      break;
    }
    remainingTokens -= cost;
    endExclusive = nextEnd;
  }
  return {
    lines: lines.slice(0, endExclusive),
    startLine: 0,
    truncated: endExclusive < lines.length,
    remainingTokens,
  };
}

interface RenderedRecentCandidate {
  readonly snippet: string;
  readonly remainingTokens: number;
}

function renderRecentCandidate(
  candidate: RecentDocumentCandidate,
  budget: number,
  config: CopilotBehaviorConfig,
): RenderedRecentCandidate | undefined {
  const document = candidate.document;
  const parsed = splitDocument(document.text);
  const lines = parsed.lines;
  const cappedRanges = selectFocalRangesWithinSpanCap(
    candidate.focalRanges ?? [],
    parsed,
    config.prompt.pageSize * 3,
  );
  const focalStart =
    cappedRanges.length === 0
      ? undefined
      : Math.min(...cappedRanges.map((range) => range.start));
  const focalEnd =
    cappedRanges.length === 0
      ? undefined
      : Math.max(
          ...cappedRanges.map((range) =>
            Math.max(range.start, range.endExclusive - 1),
          ),
        );
  const clipped =
    focalStart === undefined || focalEnd === undefined
      ? clipDocumentFromStart(lines, budget, config.prompt.pageSize)
      : clipAroundRange(
          lines,
          lineAtOffset(parsed, focalStart),
          lineAtOffset(parsed, focalEnd) + 1,
          budget,
          config.prompt.pageSize,
          false,
          config.prompt.recentFilesUseLeftoverBudgetFromAbove,
        );
  if (clipped.lines.length === 0 || clipped.remainingTokens < 0) {
    return undefined;
  }
  const renderedLines = addLineNumbers(
    clipped.lines,
    config.prompt.recentFilesLineNumbers,
    clipped.startLine,
  );
  const header = `code_snippet_file_path: ${documentPromptPath(document)}${clipped.truncated ? ' (truncated)' : ''}`;
  return {
    snippet: [
      PromptTags.RECENT_FILE.start,
      header,
      ...renderedLines,
      PromptTags.RECENT_FILE.end,
    ].join('\n'),
    remainingTokens: clipped.remainingTokens,
  };
}

function candidateFocalCost(
  candidate: RecentDocumentCandidate,
  config: CopilotBehaviorConfig,
): number {
  if (!candidate.focalRanges || candidate.focalRanges.length === 0) {
    return 0;
  }
  const parsed = splitDocument(candidate.document.text);
  const lines = parsed.lines;
  const capped = selectFocalRangesWithinSpanCap(
    candidate.focalRanges,
    parsed,
    config.prompt.pageSize * 3,
  );
  if (capped.length === 0) return 0;
  const startOffset = Math.min(...capped.map((range) => range.start));
  const endOffset = Math.max(
    ...capped.map((range) => Math.max(range.start, range.endExclusive - 1)),
  );
  const startLine = lineAtOffset(parsed, startOffset);
  const endLine = lineAtOffset(parsed, endOffset) + 1;
  const lastPage = Math.floor(
    Math.max(startLine, endLine - 1) / config.prompt.pageSize,
  );
  const firstPage = Math.floor(startLine / config.prompt.pageSize);
  let cost = 0;
  for (let page = firstPage; page <= lastPage; page += 1) {
    cost += countNesLineTokens(
      lines.slice(
        page * config.prompt.pageSize,
        Math.min(lines.length, (page + 1) * config.prompt.pageSize),
      ),
    );
  }
  return cost;
}

function selectFocalRangesWithinSpanCap(
  ranges: readonly OffsetSpan[],
  document: LineDocument,
  maxSpanLines: number,
): readonly OffsetSpan[] {
  if (ranges.length <= 1) return ranges;
  const selected: OffsetSpan[] = [ranges[0]];
  let startLine = lineAtOffset(document, ranges[0].start);
  let endLine = lineAtOffset(
    document,
    Math.max(ranges[0].start, ranges[0].endExclusive - 1),
  );
  for (let index = 1; index < ranges.length; index += 1) {
    const range = ranges[index];
    const candidateStart = Math.min(
      startLine,
      lineAtOffset(document, range.start),
    );
    const candidateEnd = Math.max(
      endLine,
      lineAtOffset(document, Math.max(range.start, range.endExclusive - 1)),
    );
    if (candidateEnd - candidateStart > maxSpanLines) break;
    selected.push(range);
    startLine = candidateStart;
    endLine = candidateEnd;
  }
  return selected;
}

function buildRecentFiles(
  context: NesPromptContext,
  config: CopilotBehaviorConfig,
  maxTokens = config.prompt.recentFileTokens,
): {
  readonly text: string;
  readonly tokens: number;
  readonly documents: ReadonlySet<string>;
} {
  let budget = maxTokens;
  const snippets: string[] = [];
  const documents = new Set<string>();
  const candidates = collectRecentCandidates(context, config);
  if (config.prompt.recentFilesClippingStrategy === 'proportional') {
    const focalCosts = candidates.map((candidate) =>
      candidateFocalCost(candidate, config),
    );
    let includedCount = candidates.length;
    let totalFocalCost = focalCosts.reduce((sum, cost) => sum + cost, 0);
    while (includedCount > 0 && totalFocalCost > maxTokens) {
      includedCount -= 1;
      totalFocalCost -= focalCosts[includedCount];
    }
    const expansionBudget = maxTokens - totalFocalCost;
    const weights = candidates
      .slice(0, includedCount)
      .map((candidate) => candidate.editEntryCount);
    const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
    let unspent = 0;
    for (let index = 0; index < includedCount; index += 1) {
      const share =
        totalWeight === 0
          ? 0
          : Math.floor(expansionBudget * (weights[index] / totalWeight));
      const effectiveBudget = focalCosts[index] + share + unspent;
      const rendered = renderRecentCandidate(
        candidates[index],
        effectiveBudget,
        config,
      );
      if (!rendered) {
        unspent = effectiveBudget;
        continue;
      }
      snippets.push(rendered.snippet);
      documents.add(candidates[index].document.uri);
      unspent = rendered.remainingTokens;
    }
    budget = unspent;
  } else {
    for (const candidate of candidates) {
      const rendered = renderRecentCandidate(candidate, budget, config);
      if (!rendered) {
        break;
      }
      snippets.push(rendered.snippet);
      documents.add(candidate.document.uri);
      budget = rendered.remainingTokens;
    }
  }
  return {
    text: snippets.reverse().join('\n\n'),
    tokens: maxTokens - budget,
    documents,
  };
}

function buildNeighborFiles(
  context: NesPromptContext,
  documentsInPrompt: ReadonlySet<string>,
  config: CopilotBehaviorConfig,
  maxTokens = config.prompt.neighborFileTokens,
): {
  readonly text: string;
  readonly tokens: number;
  readonly documents: ReadonlySet<string>;
} {
  if (!config.prompt.neighborFilesEnabled || maxTokens <= 0) {
    return { text: '', tokens: 0, documents: new Set<string>() };
  }
  const candidates = context.neighborSnippets ?? [];
  let budget = maxTokens;
  const selected: NesNeighborSnippet[] = [];
  const selectedDocuments = new Set<string>();
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    const candidate = candidates[index];
    if (
      documentsInPrompt.has(candidate.uri) ||
      selectedDocuments.has(candidate.uri)
    )
      continue;
    const cost = countNesTokens(candidate.snippet);
    if (cost > budget) continue;
    selected.push(candidate);
    selectedDocuments.add(candidate.uri);
    budget -= cost;
  }
  const snippets = selected
    .reverse()
    .map((candidate) =>
      [
        PromptTags.RECENT_FILE.start,
        `code_snippet_file_path: ${candidate.path ?? pathFromUri(candidate.uri)}`,
        ...addLineNumbers(
          candidate.snippet.split(/\r?\n/),
          config.prompt.recentFilesLineNumbers,
          candidate.startLine,
        ),
        PromptTags.RECENT_FILE.end,
      ].join('\n'),
    );
  return {
    text: snippets.join('\n\n'),
    tokens: maxTokens - budget,
    documents: selectedDocuments,
  };
}

interface TextPosition {
  readonly lineNumber: number;
  readonly column: number;
}

interface LineReplacementContext {
  readonly startLineNumber: number;
  readonly endLineNumberExclusive: number;
  readonly newLines: readonly string[];
}

function positionAt(text: string, offset: number): TextPosition {
  const document = splitDocument(text);
  const line = lineAtOffset(
    document,
    Math.max(0, Math.min(text.length, offset)),
  );
  return {
    lineNumber: line + 1,
    column: Math.max(0, offset - document.starts[line]) + 1,
  };
}

function lineEndOffset(document: LineDocument, lineNumber: number): number {
  const index = lineNumber - 1;
  return (document.starts[index] ?? 0) + (document.lines[index]?.length ?? 0);
}

function lineReplacements(entry: NesHistoryContext): LineReplacementContext[] {
  const document = splitDocument(entry.before);
  const edits = changesForEntry(entry).map((change) => ({
    startOffset: change.rangeOffset,
    endOffset: change.rangeOffset + change.rangeLength,
    text: change.text,
    start: positionAt(entry.before, change.rangeOffset),
    end: positionAt(entry.before, change.rangeOffset + change.rangeLength),
  }));
  const groups: Array<typeof edits> = [];
  for (const edit of edits) {
    const group = groups.at(-1);
    if (group && edit.start.lineNumber === group.at(-1)?.end.lineNumber) {
      group.push(edit);
    } else {
      groups.push([edit]);
    }
  }
  return groups.map((group) => {
    const first = group[0];
    const last = group[group.length - 1];
    let text = '';
    for (let index = 0; index < group.length; index += 1) {
      const edit = group[index];
      text += edit.text;
      const next = group[index + 1];
      if (next) text += entry.before.slice(edit.endOffset, next.startOffset);
    }
    const newLines = text.split(/\r?\n/);
    const prefix = entry.before.slice(
      document.starts[first.start.lineNumber - 1],
      first.startOffset,
    );
    const suffix = entry.before.slice(
      last.endOffset,
      lineEndOffset(document, last.end.lineNumber),
    );
    newLines[0] = prefix + (newLines[0] ?? '');
    newLines[newLines.length - 1] =
      (newLines[newLines.length - 1] ?? '') + suffix;
    let startLineNumber = first.start.lineNumber;
    let endLineNumberExclusive = last.end.lineNumber + 1;
    const firstLineLength =
      document.lines[first.start.lineNumber - 1]?.length ?? 0;
    if (
      first.start.column === firstLineLength + 1 &&
      newLines[0].length === prefix.length
    ) {
      startLineNumber += 1;
      newLines.shift();
    }
    if (
      newLines.length > 0 &&
      startLineNumber < endLineNumberExclusive &&
      last.end.column === 1 &&
      newLines[newLines.length - 1].length === suffix.length
    ) {
      endLineNumberExclusive -= 1;
      newLines.pop();
    }
    return { startLineNumber, endLineNumberExclusive, newLines };
  });
}

export function createUnifiedHistoryDiff(
  entry: NesHistoryContext,
): string | undefined {
  if (entry.before === entry.after) {
    return undefined;
  }
  const before = entry.before.split(/\r?\n/);
  const replacements = lineReplacements(entry);
  const groups: LineReplacementContext[][] = [];
  for (const replacement of replacements) {
    const group = groups.at(-1);
    if (
      group &&
      (group.at(-1)?.endLineNumberExclusive ?? -1) >=
        replacement.startLineNumber
    ) {
      group.push(replacement);
    } else {
      groups.push([replacement]);
    }
  }
  const hunks: string[] = [];
  for (const group of groups) {
    const oldLines: string[] = [];
    const newLines: string[] = [];
    let previousEnd = group[0].startLineNumber;
    for (const replacement of group) {
      if (previousEnd < replacement.startLineNumber) {
        const unchanged = before.slice(
          previousEnd - 1,
          replacement.startLineNumber - 1,
        );
        oldLines.push(...unchanged);
        newLines.push(...unchanged);
      }
      oldLines.push(
        ...before.slice(
          replacement.startLineNumber - 1,
          replacement.endLineNumberExclusive - 1,
        ),
      );
      newLines.push(...replacement.newLines);
      previousEnd = replacement.endLineNumberExclusive;
    }
    if (
      (oldLines.every((line) => line.trim().length === 0) &&
        newLines.every((line) => line.trim().length === 0)) ||
      (oldLines.length === newLines.length &&
        oldLines.every((line, index) => line === newLines[index]))
    ) {
      continue;
    }
    const start = group[0].startLineNumber - 1;
    hunks.push(
      [
        `@@ -${start},${oldLines.length} +${start},${newLines.length} @@`,
        ...oldLines.map((line) => `-${line}`),
        ...newLines.map((line) => `+${line}`),
      ].join('\n'),
    );
  }
  if (hunks.length === 0) return undefined;
  return [`--- ${entry.path}`, `+++ ${entry.path}`, ...hunks].join('\n');
}

function buildDiffHistory(
  context: NesPromptContext,
  documentsInPrompt: ReadonlySet<string>,
  config: CopilotBehaviorConfig,
  maxTokens = config.prompt.diffHistoryTokens,
): { readonly text: string; readonly tokens: number } {
  let budget = maxTokens;
  const newestFirst: string[] = [];
  const documentsByUri = new Map(
    [context.current, ...context.recentDocuments].map((document) => [
      document.uri,
      document,
    ]),
  );
  const history = [...context.editHistory].sort(
    (left, right) => right.timestamp - left.timestamp,
  );
  for (const entry of history) {
    if (newestFirst.length >= config.prompt.diffHistoryEntries) {
      break;
    }
    if (
      config.prompt.diffHistoryOnlyForDocumentsInPrompt &&
      entry.uri !== context.current.uri &&
      !documentsInPrompt.has(entry.uri)
    ) {
      continue;
    }
    const document = documentsByUri.get(entry.uri);
    const path = config.prompt.diffHistoryUseRelativePaths
      ? (document?.relativePath ?? entry.path)
      : (document?.path ?? entry.path);
    const diff = createUnifiedHistoryDiff({ ...entry, path });
    if (!diff) {
      continue;
    }
    const cost = countNesTokens(diff);
    if (cost > budget) {
      break;
    }
    newestFirst.push(diff);
    budget -= cost;
  }
  const entries = newestFirst.reverse();
  return {
    text: entries.length === 0 ? '' : `${entries.join('\n\n')}\n`,
    tokens: maxTokens - Math.max(0, budget),
  };
}

function buildDiagnostics(
  context: NesPromptContext,
  diagnostics: readonly NesDiagnosticContext[],
  cursorLine: number,
  cursorColumn: number,
  config: CopilotBehaviorConfig,
): string {
  const options = config.prompt.lintOptions;
  if (!options) {
    return '';
  }
  const current = context.current;
  const severity = (diagnostic: NesDiagnosticContext): 'error' | 'warning' =>
    diagnostic.severity === 'error' ? 'error' : 'warning';
  let relevant = diagnostics
    .filter(
      (diagnostic) =>
        (diagnostic.uri === undefined || diagnostic.uri === current.uri) &&
        Math.abs(diagnostic.startLine - cursorLine) <= options.maxLineDistance,
    )
    .sort(
      (left, right) =>
        Math.abs(left.startLine - cursorLine) -
          Math.abs(right.startLine - cursorLine) ||
        Math.abs((left.startCharacter ?? 0) - cursorColumn) -
          Math.abs((right.startCharacter ?? 0) - cursorColumn),
    );
  if (options.warnings === 'no') {
    relevant = relevant.filter(
      (diagnostic) => severity(diagnostic) === 'error',
    );
  } else if (options.warnings === 'yesIfNoErrors') {
    const errors = relevant.filter(
      (diagnostic) => severity(diagnostic) === 'error',
    );
    relevant = errors.length > 0 ? errors : relevant;
  }
  let selected = relevant.slice(0, options.maxLints);
  if (options.nRecentFiles > 0 && selected.length < options.maxLints) {
    const recentUris: string[] = [];
    const seen = new Set<string>([current.uri]);
    for (const event of synthesizedHistoryEvents(context)) {
      if (seen.has(event.uri)) continue;
      seen.add(event.uri);
      recentUris.push(event.uri);
      if (recentUris.length >= options.nRecentFiles) break;
    }
    for (const uri of recentUris) {
      let fileDiagnostics = diagnostics
        .filter((diagnostic) => diagnostic.uri === uri)
        .sort((left, right) => left.startLine - right.startLine);
      if (options.warnings === 'no') {
        fileDiagnostics = fileDiagnostics.filter(
          (diagnostic) => severity(diagnostic) === 'error',
        );
      } else if (options.warnings === 'yesIfNoErrors') {
        const errors = fileDiagnostics.filter(
          (diagnostic) => severity(diagnostic) === 'error',
        );
        fileDiagnostics = errors.length > 0 ? errors : fileDiagnostics;
      }
      selected = [...selected, ...fileDiagnostics].slice(0, options.maxLints);
    }
  }
  const lines = splitDocument(current.text).lines;
  const formatted = selected.flatMap((diagnostic) => {
    const sourceCode = diagnostic.code
      ? `${diagnostic.source?.toUpperCase() ?? ''}${diagnostic.code}`
      : '';
    const result = [
      `${diagnostic.startLine}:${diagnostic.startCharacter ?? 0} - ${severity(diagnostic)}${sourceCode ? ` ${sourceCode}` : ''}: ${diagnostic.message}`,
    ];
    if (
      (diagnostic.uri === undefined || diagnostic.uri === current.uri) &&
      options.showCode !== 'no'
    ) {
      const padding = options.showCode === 'yesWithSurroundingLines' ? 1 : 0;
      const start = Math.max(0, diagnostic.startLine - padding);
      const end = Math.min(lines.length, diagnostic.endLine + padding + 1);
      for (let line = start; line < end; line += 1) {
        result.push(`${line}|${lines[line] ?? ''}`);
      }
    }
    return result;
  });
  const tag = PromptTags.createLintTag(options.tagName);
  return [tag.start, ...formatted, tag.end].join('\n');
}

function languageItems(
  context: NesPromptContext['languageContext'],
): readonly NesLanguageContextItem[] {
  if (context.items) return context.items;
  return (context.symbols ?? []).map((symbol) => ({
    kind: 'trait' as const,
    name: symbol.name,
    value: symbol.detail ?? symbol.kind,
  }));
}

export function determineNesLanguageContextOptions(
  languageId: string,
  config: CopilotBehaviorConfig,
): {
  readonly enabled: boolean;
  readonly maxTokens: number;
  readonly traitPosition: 'before' | 'after';
} {
  const enabledLanguages = config.prompt.languageContextEnabledLanguages;
  let enabled: boolean;
  if (languageId in enabledLanguages) {
    enabled = enabledLanguages[languageId] ?? false;
  } else if (config.diagnosticsContextProvider.enabled) {
    enabled = true;
  } else {
    enabled = config.prompt.languageContextEnabled;
  }
  return {
    enabled,
    maxTokens: config.prompt.languageContextTokens,
    traitPosition: config.prompt.languageContextTraitPosition,
  };
}

function languageContextEnabled(
  context: NesPromptContext,
  config: CopilotBehaviorConfig,
): boolean {
  return determineNesLanguageContextOptions(context.current.languageId, config)
    .enabled;
}

function buildLanguageSnippets(
  context: NesPromptContext,
  budget: number,
  config: CopilotBehaviorConfig,
): { readonly text: string; readonly tokens: number } {
  if (!languageContextEnabled(context, config)) {
    return { text: '', tokens: 0 };
  }
  const snippets: string[] = [];
  let remaining = budget;
  for (const item of languageItems(context.languageContext)) {
    if (item.kind !== 'snippet' || item.onTimeout) continue;
    const cost = countNesTokens(item.value);
    if (cost > remaining) break;
    snippets.push(
      [
        PromptTags.RECENT_FILE.start,
        `code_snippet_file_path: ${item.path ?? pathFromUri(item.uri)}`,
        ...addLineNumbers(
          item.value.split(/\r?\n/),
          config.prompt.recentFilesLineNumbers,
        ),
        PromptTags.RECENT_FILE.end,
      ].join('\n'),
    );
    remaining -= cost;
  }
  return { text: snippets.join('\n\n'), tokens: budget - remaining };
}

function buildLanguageTraits(
  context: NesPromptContext,
  config: CopilotBehaviorConfig,
): string {
  if (!languageContextEnabled(context, config)) return '';
  const traits = languageItems(context.languageContext)
    .filter(
      (item): item is Extract<NesLanguageContextItem, { kind: 'trait' }> =>
        item.kind === 'trait',
    )
    .map((item) => `${item.name}: ${item.value}`);
  return traits.length === 0
    ? ''
    : `Consider this related information:\n${traits.join('\n')}`;
}

function systemPrompt(strategy: NesPromptStrategy): string {
  switch (strategy) {
    case 'copilotNesXtab':
      return systemPromptTemplate || nes41Miniv3SystemPrompt;
    case 'xtab275':
    case 'xtabAggressiveness':
    case 'xtab275Aggressiveness':
    case 'xtab275AggressivenessHighLow':
    case 'xtab275EditIntent':
    case 'xtab275EditIntentShort':
      return xtab275SystemPrompt;
    case 'xtabUnifiedModel':
      return unifiedModelSystemPrompt;
  }
}

function postscript(
  strategy: NesPromptStrategy,
  path: string,
  aggressivenessLevel: NesAggressivenessLevel,
): string {
  const xtab275Base = `The developer was working on a section of code within the tags \`code_to_edit\` in the file located at \`${path}\`. Using the given \`recently_viewed_code_snippets\`, \`current_file_content\`, \`edit_diff_history\`, \`area_around_code_to_edit\`, and the cursor position marked as \`${PromptTags.CURSOR}\`, please continue the developer's work. Update the \`code_to_edit\` section by predicting and completing the changes they would have made next. Provide the revised code that was between the \`${PromptTags.EDIT_WINDOW.start}\` and \`${PromptTags.EDIT_WINDOW.end}\` tags, but do not include the tags themselves. Avoid undoing or reverting the developer's last change unless there are obvious typos or errors. Don't include the line numbers or the form #| in your response. Do not skip any lines. Do not be lazy.`;
  switch (strategy) {
    case 'xtab275':
    case 'xtab275EditIntent':
    case 'xtab275EditIntentShort':
      return xtab275Base;
    case 'xtabAggressiveness':
      return `<|aggressive|>${aggressivenessLevel}<|/aggressive|>`;
    case 'xtab275Aggressiveness':
      return `${xtab275Base}\n<|aggressive|>${aggressivenessLevel}<|/aggressive|>`;
    case 'xtab275AggressivenessHighLow':
      return aggressivenessLevel === 'medium'
        ? xtab275Base
        : `${xtab275Base}\n<|aggressive|>${aggressivenessLevel}<|/aggressive|>`;
    case 'xtabUnifiedModel':
      return `The developer was working on a section of code within the tags \`code_to_edit\` in the file located at \`${path}\`. Using the given \`recently_viewed_code_snippets\`, \`current_file_content\`, \`edit_diff_history\`, \`area_around_code_to_edit\`, and the cursor position marked as \`${PromptTags.CURSOR}\`, please continue the developer's work. Update the \`code_to_edit\` section by predicting and completing the changes they would have made next. Start your response with <EDIT>, <INSERT>, or <NO_CHANGE>. If you are making an edit, start with <EDIT> and then provide the rewritten code window followed by </EDIT>. If you are inserting new code, start with <INSERT> and then provide only the new code that will be inserted at the cursor position followed by </INSERT>. If no changes are necessary, reply only with <NO_CHANGE>. Avoid undoing or reverting the developer's last change unless there are obvious typos or errors.`;
    case 'copilotNesXtab':
      return `The developer was working on a section of code within the tags \`code_to_edit\` in the file located at \`${path}\`. Using the given \`recently_viewed_code_snippets\`, \`current_file_content\`, \`edit_diff_history\`, \`area_around_code_to_edit\`, and the cursor position marked as \`${PromptTags.CURSOR}\`, please continue the developer's work. Update the \`code_to_edit\` section by predicting and completing the changes they would have made next. Provide the revised code that was between the \`${PromptTags.EDIT_WINDOW.start}\` and \`${PromptTags.EDIT_WINDOW.end}\` tags with the following format, but do not include the tags themselves.\n\`\`\`\n// Your revised code goes here\n\`\`\``;
  }
}

export type NesPromptTooLargePart = 'currentFile' | 'editWindow' | 'final';

export class NesPromptTooLargeError extends Error {
  constructor(readonly part: NesPromptTooLargePart) {
    super(`NES prompt is too large: ${part}.`);
    this.name = 'NesPromptTooLargeError';
  }
}

export function runNesBudgetCascade(
  globalBudget: NesGlobalBudgetConfig,
  consume: (part: NesGlobalBudgetPart, allocatedTokens: number) => number,
): {
  readonly finalSurplus: number;
  readonly trace: readonly NesPromptBudgetTraceEntry[];
} {
  let surplus = 0;
  const trace: NesPromptBudgetTraceEntry[] = [];
  for (const part of globalBudget.order) {
    const allocatedTokens = Math.max(
      0,
      Math.floor(
        surplus + globalBudget.totalTokens * globalBudget.shares[part],
      ),
    );
    const consumedTokens = consume(part, allocatedTokens);
    if (
      !Number.isFinite(consumedTokens) ||
      consumedTokens < 0 ||
      consumedTokens > allocatedTokens
    ) {
      throw new Error(
        `NES global budget part '${part}' consumed ${consumedTokens} tokens from ${allocatedTokens}.`,
      );
    }
    surplus = Math.max(0, allocatedTokens - consumedTokens);
    trace.push({
      part,
      allocatedTokens,
      consumedTokens,
      remainingTokens: surplus,
      cascadesToNextPart: true,
    });
  }
  return { finalSurplus: surplus, trace };
}

export function buildOfficialNesPrompt(
  context: NesPromptContext,
  strategy: NesPromptStrategy,
  config: CopilotBehaviorConfig = COPILOT_BEHAVIOR_CONFIG,
  overrides: {
    readonly linesBelowEditWindow?: number;
    readonly currentFileTokens?: number;
    readonly currentFileRange?: {
      readonly start: number;
      readonly endExclusive: number;
    };
    readonly areaAroundEditWindow?: {
      readonly start: number;
      readonly endExclusive: number;
    };
    readonly aggressivenessLevel?: NesAggressivenessLevel;
  } = {},
): NesPromptBuildResult {
  validateCopilotBehaviorConfig(config);
  const { document, window } = createEditWindow(
    context,
    config,
    overrides.linesBelowEditWindow,
  );
  if (countNesLineTokens(window.lines) > config.prompt.editWindowTokens) {
    throw new NesPromptTooLargeError('editWindow');
  }
  const documentsInPrompt = new Set<string>([context.current.uri]);
  let recent: ReturnType<typeof buildRecentFiles> = {
    text: '',
    tokens: 0,
    documents: new Set<string>(),
  };
  let neighbors: ReturnType<typeof buildNeighborFiles> = {
    text: '',
    tokens: 0,
    documents: new Set<string>(),
  };
  let history: ReturnType<typeof buildDiffHistory> = { text: '', tokens: 0 };
  let language: ReturnType<typeof buildLanguageSnippets> = {
    text: '',
    tokens: 0,
  };
  let currentBudget = config.prompt.currentFileTokens;
  const budgetTrace: NesPromptBudgetTraceEntry[] = [];
  const globalBudget = config.prompt.globalBudget;
  if (globalBudget) {
    const cascade = runNesBudgetCascade(globalBudget, (part, allocated) => {
      let consumed = 0;
      switch (part) {
        case 'recentlyViewedDocuments':
          recent = buildRecentFiles(context, config, allocated);
          consumed = recent.tokens;
          for (const uri of recent.documents) {
            documentsInPrompt.add(uri);
          }
          break;
        case 'languageContext':
          language = buildLanguageSnippets(context, allocated, config);
          consumed = language.tokens;
          break;
        case 'neighborFiles':
          neighbors = buildNeighborFiles(
            context,
            documentsInPrompt,
            config,
            allocated,
          );
          consumed = neighbors.tokens;
          for (const uri of neighbors.documents) {
            documentsInPrompt.add(uri);
          }
          break;
        case 'diffHistory':
          history = buildDiffHistory(
            context,
            documentsInPrompt,
            config,
            allocated,
          );
          consumed = history.tokens;
          break;
      }
      return consumed;
    });
    budgetTrace.push(...cascade.trace);
    currentBudget =
      Math.floor(globalBudget.totalTokens * globalBudget.shares.currentFile) +
      cascade.finalSurplus;
  } else {
    recent = buildRecentFiles(context, config);
    for (const uri of recent.documents) {
      documentsInPrompt.add(uri);
    }
    language = buildLanguageSnippets(
      context,
      config.prompt.languageContextTokens,
      config,
    );
    neighbors = buildNeighborFiles(context, documentsInPrompt, config);
    for (const uri of neighbors.documents) {
      documentsInPrompt.add(uri);
    }
    history = buildDiffHistory(context, documentsInPrompt, config);
    budgetTrace.push(
      {
        part: 'recentlyViewedDocuments',
        allocatedTokens: config.prompt.recentFileTokens,
        consumedTokens: recent.tokens,
        remainingTokens: Math.max(
          0,
          config.prompt.recentFileTokens - recent.tokens,
        ),
        cascadesToNextPart: false,
      },
      {
        part: 'languageContext',
        allocatedTokens: config.prompt.languageContextTokens,
        consumedTokens: language.tokens,
        remainingTokens: Math.max(
          0,
          config.prompt.languageContextTokens - language.tokens,
        ),
        cascadesToNextPart: false,
      },
      {
        part: 'neighborFiles',
        allocatedTokens: config.prompt.neighborFileTokens,
        consumedTokens: neighbors.tokens,
        remainingTokens: Math.max(
          0,
          config.prompt.neighborFileTokens - neighbors.tokens,
        ),
        cascadesToNextPart: false,
      },
      {
        part: 'diffHistory',
        allocatedTokens: config.prompt.diffHistoryTokens,
        consumedTokens: history.tokens,
        remainingTokens: Math.max(
          0,
          config.prompt.diffHistoryTokens - history.tokens,
        ),
        cascadesToNextPart: false,
      },
    );
  }
  const current = buildCurrentFile(
    context,
    document,
    window,
    config,
    config.prompt.currentFileIncludeTags[strategy],
    overrides.currentFileTokens ?? currentBudget,
    overrides.currentFileRange,
    overrides.areaAroundEditWindow,
  );
  const effectiveCurrentBudget = overrides.currentFileTokens ?? currentBudget;
  budgetTrace.push({
    part: 'currentFile',
    allocatedTokens: effectiveCurrentBudget,
    consumedTokens: current.tokens,
    remainingTokens: Math.max(0, effectiveCurrentBudget - current.tokens),
    cascadesToNextPart: false,
  });
  const diagnostics = buildDiagnostics(
    context,
    context.diagnostics,
    window.cursorLineOffset,
    window.cursorColumn,
    config,
  );
  const recentContent = [recent.text, language.text, neighbors.text]
    .filter((value) => value.length > 0)
    .join('\n\n');
  const lintsWithNewLinePadding = config.prompt.lintOptions
    ? `\n${diagnostics}\n`
    : '';
  const currentFilePath =
    context.current.relativePath ?? pathFromUri(context.current.uri);
  const aggressivenessLevel = overrides.aggressivenessLevel ?? 'medium';
  const base = `${PromptTags.RECENT_FILES.start}
${recentContent}
${PromptTags.RECENT_FILES.end}

${PromptTags.CURRENT_FILE.start}
current_file_path: ${currentFilePath}
${current.content}
${PromptTags.CURRENT_FILE.end}
${lintsWithNewLinePadding}
${PromptTags.EDIT_HISTORY.start}
${history.text}
${PromptTags.EDIT_HISTORY.end}

${current.area}`;
  const packaged = `\`\`\`\n${base}\n\`\`\``;
  const traits = buildLanguageTraits(context, config);
  const withLanguage = traits
    ? config.prompt.languageContextTraitPosition === 'before'
      ? `${traits}\n\n${packaged}`
      : `${packaged}\n\n${traits}`
    : packaged;
  const user = config.prompt.includePostScript
    ? `${withLanguage}\n\n${postscript(
        strategy,
        currentFilePath,
        aggressivenessLevel,
      )}`.trim()
    : withLanguage.trim();
  const system = systemPrompt(strategy);
  if (system.length + user.length > config.prompt.hardCharacterLimit) {
    throw new NesPromptTooLargeError('final');
  }
  return {
    strategy,
    aggressivenessLevel,
    messages: { system, user },
    editWindow: window,
    budgetTrace,
    tokenUsage: {
      currentFile: current.tokens,
      recentFiles: recent.tokens + neighbors.tokens,
      diffHistory: history.tokens,
      languageContext: language.tokens,
      total: countNesTokens(system) + countNesTokens(user),
    },
  };
}

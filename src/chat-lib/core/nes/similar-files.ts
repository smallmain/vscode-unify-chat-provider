import type { NesDocumentContext, NesNeighborSnippet } from './types';

export interface NesSimilarFilesOptions {
  readonly snippetLength: number;
  readonly threshold: number;
  readonly maxTopSnippets: number;
  readonly maxCharPerFile: number;
  readonly maxNumberOfFiles: number;
  readonly maxSnippetsPerFile: number;
  readonly useSubsetMatching: false;
}

export const DEFAULT_NES_SIMILAR_FILES_OPTIONS: NesSimilarFilesOptions = {
  snippetLength: 60,
  threshold: 0,
  maxTopSnippets: 4,
  maxCharPerFile: 10_000,
  maxNumberOfFiles: 20,
  maxSnippetsPerFile: 1,
  useSubsetMatching: false,
};

export const CPP_NES_SIMILAR_FILES_OPTIONS: NesSimilarFilesOptions = {
  snippetLength: 60,
  threshold: 0,
  maxTopSnippets: 16,
  maxCharPerFile: 100_000,
  maxNumberOfFiles: 200,
  maxSnippetsPerFile: 4,
  useSubsetMatching: false,
};

const ENGLISH_STOPS = [
  'we', 'our', 'you', 'it', 'its', 'they', 'them', 'their', 'this', 'that',
  'these', 'those', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'having', 'do', 'does', 'did', 'doing', 'can',
  'don', 't', 's', 'will', 'would', 'should', 'what', 'which', 'who',
  'when', 'where', 'why', 'how', 'a', 'an', 'the', 'and', 'or', 'not',
  'no', 'but', 'because', 'as', 'until', 'again', 'further', 'then',
  'once', 'here', 'there', 'all', 'any', 'both', 'each', 'few', 'more',
  'most', 'other', 'some', 'such', 'above', 'below', 'to', 'during',
  'before', 'after', 'of', 'at', 'by', 'about', 'between', 'into',
  'through', 'from', 'up', 'down', 'in', 'out', 'on', 'off', 'over',
  'under', 'only', 'own', 'same', 'so', 'than', 'too', 'very', 'just',
  'now',
] as const;

const GENERIC_STOPS = new Set<string>([
  'if', 'then', 'else', 'for', 'while', 'with', 'def', 'function',
  'return', 'TODO', 'import', 'try', 'catch', 'raise', 'finally', 'repeat',
  'switch', 'case', 'match', 'assert', 'continue', 'break', 'const',
  'class', 'enum', 'struct', 'static', 'new', 'super', 'this', 'var',
  ...ENGLISH_STOPS,
]);

interface ScoredWindow {
  score: number;
  startLine: number;
  endLine: number;
}

export interface SimilarFileSelectionDocument {
  readonly uri: string;
  readonly path: string;
  readonly text: string;
}

export interface SelectedSimilarFileSnippet {
  readonly uri: string;
  readonly path: string;
  readonly snippet: string;
  readonly startLine: number;
  readonly score: number;
}

function tokenize(value: string): Set<string> {
  return new Set(
    value
      .split(/[^a-zA-Z0-9]/)
      .filter((word) => word.length > 0 && !GENERIC_STOPS.has(word)),
  );
}

function jaccardScore(left: ReadonlySet<string>, right: ReadonlySet<string>): number {
  let intersection = 0;
  for (const token of left) {
    if (right.has(token)) intersection += 1;
  }
  return intersection / (left.size + right.size - intersection);
}

function windowDelineations(
  lineCount: number,
  windowLength: number,
): readonly (readonly [number, number])[] {
  if (lineCount === 0) return [];
  if (lineCount < windowLength) return [[0, lineCount]];
  return Array.from(
    { length: lineCount - windowLength + 1 },
    (_value, startLine) => [startLine, startLine + windowLength] as const,
  );
}

function scoreWindows(
  source: string,
  referenceTokens: ReadonlySet<string>,
  windowLength: number,
): ScoredWindow[] {
  if (source.length === 0 || referenceTokens.size === 0) return [];
  const lines = source.split('\n');
  const tokenizedLines = lines.map(tokenize);
  const snippets: ScoredWindow[] = [];
  for (const [startLine, endLine] of windowDelineations(lines.length, windowLength)) {
    const tokens = new Set<string>();
    for (let line = startLine; line < endLine; line += 1) {
      for (const token of tokenizedLines[line]) tokens.add(token);
    }
    const score = jaccardScore(tokens, referenceTokens);
    const previous = snippets.at(-1);
    if (previous && startLine > 0 && previous.endLine > startLine) {
      if (previous.score < score) {
        previous.score = score;
        previous.startLine = startLine;
        previous.endLine = endLine;
      }
      continue;
    }
    snippets.push({ score, startLine, endLine });
  }
  return snippets.sort((left, right) => left.score > right.score ? -1 : 1);
}

export function selectNesNeighborSnippets(
  current: NesDocumentContext,
  cursorOffset: number,
  documents: readonly NesDocumentContext[],
  options: NesSimilarFilesOptions = current.languageId === 'cpp'
    ? CPP_NES_SIMILAR_FILES_OPTIONS
    : DEFAULT_NES_SIMILAR_FILES_OPTIONS,
): readonly NesNeighborSnippet[] {
  return selectSimilarFileSnippets(
    current.text,
    cursorOffset,
    documents.map((document) => ({
      uri: document.uri,
      path: document.relativePath ?? document.path,
      text: document.text,
    })),
    options,
  );
}

export function selectSimilarFileSnippets(
  currentText: string,
  cursorOffset: number,
  documents: readonly SimilarFileSelectionDocument[],
  options: NesSimilarFilesOptions,
): readonly SelectedSimilarFileSnippet[] {
  if (options.maxTopSnippets === 0) return [];
  const referenceTokens = tokenize(
    currentText
      .slice(0, Math.max(0, Math.min(cursorOffset, currentText.length)))
      .split('\n')
      .slice(-options.snippetLength)
      .join('\n'),
  );
  const snippets: SelectedSimilarFileSnippet[] = [];
  for (const document of documents
    .filter(
      (candidate) =>
        candidate.text.length < options.maxCharPerFile &&
        candidate.text.length > 0,
    )
    .slice(0, options.maxNumberOfFiles)) {
    const lines = document.text.split('\n');
    const matches = scoreWindows(
      document.text,
      referenceTokens,
      options.snippetLength,
    );
    for (
      let index = 0;
      index < matches.length && index < options.maxSnippetsPerFile;
      index += 1
    ) {
      const match = matches[index];
      if (match.score === 0) continue;
      snippets.push({
        uri: document.uri,
        path: document.path,
        snippet: lines.slice(match.startLine, match.endLine).join('\n'),
        startLine: match.startLine,
        score: match.score,
      });
    }
  }
  return snippets
    .filter(
      (snippet) =>
        Boolean(snippet.score) &&
        snippet.snippet.length > 0 &&
        snippet.score > options.threshold,
    )
    .sort((left, right) => left.score - right.score)
    .slice(-options.maxTopSnippets)
    .sort((left, right) => left.score - right.score);
}

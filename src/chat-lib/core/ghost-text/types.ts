import type * as vscode from 'vscode';

export const GHOST_TEXT_UPSTREAM_COMMIT =
  'fc3def6774c76082adf699d366f31a557ce5573f';

export type GhostTextTrigger = 'automatic' | 'invoke';
export type GhostTextResultSource =
  | 'network'
  | 'cache'
  | 'typing-as-suggested'
  | 'cycling'
  | 'async';

export interface GhostTextPosition {
  line: number;
  character: number;
}

export interface GhostTextOffsetRange {
  start: number;
  end: number;
}

export interface GhostTextDocument {
  uri: string;
  filePath: string;
  relativePath?: string;
  notebook?: boolean;
  languageId: string;
  text: string;
  version: number;
}

export interface GhostTextSelectedCompletionInfo {
  text: string;
  range: GhostTextOffsetRange;
}

export interface GhostTextSimilarFile {
  path: string;
  content: string;
  score?: number;
}

export interface GhostTextRecentEdit {
  uri: string;
  path: string;
  summary: string;
  startLine?: number;
  endLine?: number;
}

export type GhostTextDiagnosticSeverity =
  | 'error'
  | 'warning'
  | 'information'
  | 'hint';

export interface GhostTextDiagnostic {
  path: string;
  line: number;
  character: number;
  message: string;
  severity: GhostTextDiagnosticSeverity;
  code?: string | number;
  source?: string;
  importance?: number;
  contextProviderSource?: GhostTextContextProviderItemSource;
}

export interface GhostTextTrait {
  name: string;
  value: string;
  importance?: number;
  contextProviderSource?: GhostTextContextProviderItemSource;
}

export interface GhostTextCodeSnippet {
  path: string;
  value: string;
  importance?: number;
  contextProviderSource?: GhostTextContextProviderItemSource;
}

export type GhostTextContextProviderItemType =
  | 'Trait'
  | 'CodeSnippet'
  | 'DiagnosticBag';

export interface GhostTextContextProviderItemSource {
  readonly providerId: string;
  readonly itemId: string;
  readonly itemType: GhostTextContextProviderItemType;
  readonly origin?: 'request' | 'update';
}

export interface GhostTextContextProviderPromptMatcher {
  readonly source: GhostTextContextProviderItemSource;
  readonly expectedTokens: number;
  readonly actualTokens: number;
}

export interface GhostTextContextProviderFeedback {
  readonly completionId: string;
  submit(
    matchers: readonly GhostTextContextProviderPromptMatcher[],
  ): void;
}

export interface GhostTextPromptContext {
  ignored?: boolean;
  similarFiles?: readonly GhostTextSimilarFile[];
  recentEdits?: readonly GhostTextRecentEdit[];
  diagnostics?: readonly GhostTextDiagnostic[];
  traits?: readonly GhostTextTrait[];
  codeSnippets?: readonly GhostTextCodeSnippet[];
  contextProviderFeedback?: GhostTextContextProviderFeedback;
}

export interface GhostTextFormattingOptions {
  tabSize?: number;
  insertSpaces?: boolean;
}

export interface GhostTextRequest {
  document: GhostTextDocument;
  position: GhostTextPosition;
  trigger: GhostTextTrigger;
  context?: GhostTextPromptContext;
  selectedCompletionInfo?: GhostTextSelectedCompletionInfo;
  formattingOptions?: GhostTextFormattingOptions;
  opportunityId?: string;
  multiline?: 'auto' | 'single' | 'multi';
}

export interface GhostTextTokenizer {
  encode(text: string): readonly number[];
  decode(tokens: readonly number[]): string;
  count(text: string): number;
  takeFirst(text: string, maxTokens: number): {
    text: string;
    tokens: readonly number[];
  };
  takeLast(text: string, maxTokens: number): {
    text: string;
    tokens: readonly number[];
  };
  tokenizeStrings(text: string): readonly string[];
}

export type GhostTextBlockMode =
  | 'parsing'
  | 'parsing-and-server'
  | 'more-multiline'
  | 'server';

export interface GhostTextBehavior {
  upstreamCommit: typeof GHOST_TEXT_UPSTREAM_COMMIT;
  maxPromptCompletionTokens: number;
  maxCompletionTokens: number;
  suffixPercent: number;
  suffixMatchThreshold: number;
  minPromptCharacters: number;
  numberOfSnippets: number;
  maximumSimilarFiles: number;
  maximumCharactersPerSimilarFile: number;
  similarFileWindowLines: number;
  cacheSize: number;
  asyncCompletionTimeoutMs: number;
  completionDelayMs: number;
  cyclingCandidateCount: number;
  blockMode: GhostTextBlockMode | 'default';
  modelAlwaysTerminatesSingleline: boolean;
  singleLineUnlessAccepted: boolean;
  maxMultilineTokens: number;
  multilineAfterAcceptLines: number;
}

export interface GhostTextPromptContextFile {
  path: string;
  content: string;
}

export interface GhostTextPrompt {
  prefix: string;
  suffix: string;
  contextFiles: readonly GhostTextPromptContextFile[];
  prefixTokens: number;
  suffixTokens: number;
  trailingWhitespace: string;
  selectedCompletionLineLengthIncrease: number;
  virtualDocumentText: string;
  virtualCursorOffset: number;
}

export type GhostTextPromptResult =
  | { type: 'prompt'; prompt: GhostTextPrompt }
  | { type: 'cancelled'; reason: string }
  | { type: 'content-excluded'; reason: string }
  | { type: 'context-too-short'; reason: string }
  | { type: 'invalid-position'; reason: string };

export interface GhostTextModelChoice {
  choiceIndex: number;
  completionText: string;
  requestId: string;
  clientCompletionId: string;
  finishReason?: string;
  generatedChoiceIndex?: number;
  usage?: unknown;
}

export interface GhostTextModelRequest {
  requestId: string;
  prompt: GhostTextPrompt;
  filePath?: string;
  candidateCount: number;
  stop?: readonly string[];
  maxTokens?: number;
  languageId: string;
  nextIndent: number;
  trimByIndentation: boolean;
  promptTokens: number;
  suffixTokens: number;
  codeAnnotations: false;
}

export interface GhostTextModelBoundary {
  complete(
    request: GhostTextModelRequest,
    token: vscode.CancellationToken,
  ): Promise<readonly GhostTextModelChoice[]>;
}

export interface GhostTextRange {
  start: GhostTextPosition;
  end: GhostTextPosition;
}

export interface GhostTextCompletionMetadata {
  requestId: string;
  clientCompletionId: string;
  opportunityId?: string;
  choiceIndex: number;
  generatedChoiceIndex?: number;
  source: GhostTextResultSource;
  isMiddleOfLine: boolean;
  suffixCoverage: number;
  finishReason?: string;
  usage?: unknown;
}

export interface GhostTextCompletionItem {
  id: string;
  insertText: string;
  displayText: string;
  range: GhostTextRange;
  metadata: GhostTextCompletionMetadata;
}

export interface GhostTextCompletionList {
  id: string;
  items: readonly GhostTextCompletionItem[];
  prompt: GhostTextPrompt;
  source: GhostTextResultSource;
}

export type GhostTextProvideResult =
  | { type: 'success'; list: GhostTextCompletionList }
  | { type: 'empty'; reason: string; prompt?: GhostTextPrompt }
  | { type: 'cancelled'; reason: string }
  | { type: 'failed'; reason: string; error?: Error };

export type GhostTextEndOfLifeReason = 'accepted' | 'discarded';

export interface GhostTextClock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export interface GhostTextEngineDependencies {
  model: GhostTextModelBoundary;
  tokenizer?: GhostTextTokenizer;
  behavior?: Partial<Omit<GhostTextBehavior, 'upstreamCommit'>>;
  idFactory?: () => string;
  clock?: GhostTextClock;
}

export interface GhostTextDebugState {
  cacheEntries: number;
  inFlightEntries: number;
  speculativeEntries: number;
  currentClientCompletionId?: string;
  lastShownItemIds: readonly string[];
  trackedItemCount: number;
  trackedListCount: number;
}

import type {
  NesAggressivenessLevel,
  NesEditIntent,
  NesGlobalBudgetPart,
  NesPromptStrategy,
  NesResponseFormat,
} from '../behavior-config';

export interface NesDocumentContext {
  readonly uri: string;
  readonly path: string;
  readonly relativePath?: string;
  readonly languageId: string;
  readonly version: number;
  readonly text: string;
  readonly workspaceRoot?: string;
  readonly workspaceRootUri?: string;
  readonly selection?: {
    readonly start: number;
    readonly end: number;
    readonly active: number;
  };
  readonly visibleRanges?: readonly {
    readonly start: number;
    readonly end: number;
  }[];
  readonly lastViewedAt?: number;
  readonly lastEditedAt?: number;
}

export interface NesTextChangeContext {
  readonly rangeOffset: number;
  readonly rangeLength: number;
  readonly text: string;
}

export interface NesHistoryContext {
  readonly uri: string;
  readonly path: string;
  readonly languageId: string;
  readonly before: string;
  readonly after: string;
  readonly timestamp: number;
  readonly reason?: 'undo' | 'redo' | 'other';
  readonly relativePath?: string;
  readonly startLine?: number;
  readonly endLine?: number;
  readonly changes?: readonly NesTextChangeContext[];
}

export type NesPromptHistoryEvent =
  | ({ readonly kind: 'edit' } & NesHistoryContext)
  | {
      readonly kind: 'visibleRanges';
      readonly uri: string;
      readonly path: string;
      readonly relativePath?: string;
      readonly languageId: string;
      readonly text: string;
      readonly timestamp: number;
      readonly visibleRanges: readonly {
        readonly start: number;
        readonly end: number;
      }[];
    };

export interface NesDiagnosticContext {
  readonly uri?: string;
  readonly path?: string;
  readonly message: string;
  readonly severity: 'error' | 'warning' | 'information' | 'hint';
  readonly startLine: number;
  readonly startCharacter?: number;
  readonly endLine: number;
  readonly endCharacter?: number;
  readonly source?: string;
  readonly code?: string;
}

export type NesLanguageContextItem =
  | {
      readonly kind: 'snippet';
      readonly uri: string;
      readonly path?: string;
      readonly value: string;
      readonly importance?: number;
      readonly additionalUris?: readonly string[];
      readonly onTimeout?: boolean;
    }
  | {
      readonly kind: 'trait';
      readonly name: string;
      readonly value: string;
      readonly importance?: number;
      readonly onTimeout?: boolean;
    };

export interface NesLanguageContext {
  readonly items?: readonly NesLanguageContextItem[];
  /** Compatibility input for callers that have not adopted context-provider items. */
  readonly symbols?: readonly {
    readonly name: string;
    readonly detail?: string;
    readonly kind: string;
    readonly startLine: number;
    readonly endLine: number;
  }[];
}

export interface NesNeighborSnippet {
  readonly uri: string;
  readonly path?: string;
  readonly snippet: string;
  readonly startLine: number;
  readonly score?: number;
}

export interface NesPromptContext {
  readonly current: NesDocumentContext;
  readonly cursorOffset: number;
  readonly selectedCompletionText?: string;
  readonly recentDocuments: readonly NesDocumentContext[];
  readonly editHistory: readonly NesHistoryContext[];
  readonly historyEvents?: readonly NesPromptHistoryEvent[];
  /** Ordered from lowest to highest similarity, matching the upstream service. */
  readonly neighborSnippets?: readonly NesNeighborSnippet[];
  readonly diagnostics: readonly NesDiagnosticContext[];
  readonly languageContext: NesLanguageContext;
  readonly gitDiff?: string;
}

export interface NesEditWindow {
  readonly startLine: number;
  readonly endLineExclusive: number;
  readonly startOffset: number;
  readonly endOffset: number;
  readonly cursorOffset: number;
  readonly cursorLineOffset: number;
  readonly cursorColumn: number;
  readonly text: string;
  readonly lines: readonly string[];
  readonly eol: '\n' | '\r\n';
}

export interface NesPromptMessages {
  readonly system: string;
  readonly user: string;
}

export interface NesPromptBudgetTraceEntry {
  readonly part: NesGlobalBudgetPart | 'currentFile';
  readonly allocatedTokens: number;
  readonly consumedTokens: number;
  readonly remainingTokens: number;
  readonly cascadesToNextPart: boolean;
}

export interface NesPromptBuildResult {
  readonly strategy: NesPromptStrategy;
  readonly aggressivenessLevel: NesAggressivenessLevel;
  readonly messages: NesPromptMessages;
  readonly editWindow: NesEditWindow;
  readonly budgetTrace: readonly NesPromptBudgetTraceEntry[];
  readonly tokenUsage: {
    readonly currentFile: number;
    readonly recentFiles: number;
    readonly diffHistory: number;
    readonly languageContext: number;
    readonly total: number;
  };
}

export interface NesTextEdit {
  readonly uri: string;
  readonly startOffset: number;
  readonly endOffset: number;
  readonly newText: string;
  readonly kind: 'insert' | 'replace' | 'cursorJump';
  readonly cursorTarget?: { readonly line: number; readonly character: number };
  /** Source edit index retained across streamed cache and rebase operations. */
  readonly patchIndex?: number;
}

export interface NesParsedResponse {
  readonly edits: readonly NesTextEdit[];
  readonly rawText: string;
  readonly noChange: boolean;
  readonly filteredOut?: boolean;
  readonly editIntentFilteredOut?: boolean;
  readonly format: NesResponseFormat;
  readonly editIntent?: NesEditIntent;
  readonly editIntentParseError?: string;
}

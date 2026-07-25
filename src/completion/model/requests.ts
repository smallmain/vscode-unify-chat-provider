export type { CompletionTemplate, CompletionTemplates } from '../../types';

export interface CompletionExecutionOptions {
  readonly candidateCount?: number;
  readonly maxTokens?: number;
  readonly stop?: readonly string[];
}

export interface CompletionSourceContext {
  readonly uri?: string;
  readonly path?: string;
  readonly content: string;
  readonly range?: EditAlgorithmSyntaxRange;
}

export interface SimpleAlgorithmRequest {
  readonly kind: 'simple';
  readonly prefix: string;
  readonly suffix: string;
}

export type EditPredictionTrigger =
  | 'explicit'
  | 'buffer_edit'
  | 'prediction_accepted'
  | 'prediction_partially_accepted'
  | 'provider_changed'
  | 'user_info_changed'
  | 'settings_changed'
  | 'other';

export interface EditAlgorithmDocument {
  readonly uri: string;
  readonly path?: string;
  readonly languageId: string;
  readonly version: number;
  readonly text: string;
  readonly cursorOffset: number;
  readonly syntaxRanges?: readonly EditAlgorithmSyntaxRange[];
  readonly fullSyntaxRanges?: readonly EditAlgorithmSyntaxRange[];
}

export interface EditAlgorithmSyntaxRange {
  readonly startOffset: number;
  readonly endOffset: number;
}

export interface EditAlgorithmDiagnostic {
  readonly severity?: number | null;
  readonly message: string;
  readonly snippet: string;
  readonly snippetStartRow: number;
  readonly snippetEndRow: number;
  readonly diagnosticStartRow?: number;
  readonly diagnosticEndRow?: number;
  readonly diagnosticStartByte: number;
  readonly diagnosticEndByte: number;
}

export interface EditHistoryEntry {
  readonly uri?: string;
  readonly path?: string;
  readonly oldText: string;
  readonly newText: string;
  readonly oldRange?: EditAlgorithmSyntaxRange;
  readonly newRange?: EditAlgorithmSyntaxRange;
  readonly diff?: string;
  readonly predicted?: boolean;
}

export interface ZedAlgorithmRequest {
  readonly kind: 'zed';
  readonly document: EditAlgorithmDocument;
  readonly trigger: EditPredictionTrigger;
  readonly editHistory: readonly EditHistoryEntry[];
  readonly contexts: readonly CompletionSourceContext[];
  readonly diagnostics: readonly EditAlgorithmDiagnostic[];
  readonly maxTokens: number;
}

export interface InceptionAlgorithmRequest {
  readonly kind: 'inception';
  readonly document: EditAlgorithmDocument;
  readonly editHistory: readonly EditHistoryEntry[];
  readonly contexts: readonly CompletionSourceContext[];
}

export interface MistralAlgorithmRequest {
  readonly kind: 'mistral';
  readonly document: EditAlgorithmDocument;
  readonly maxTokens: number;
}

export interface CopilotReplicaFimMetadata {
  readonly languageId?: string;
  readonly nextIndent?: number;
  readonly trimByIndentation?: boolean;
  readonly promptTokens?: number;
  readonly suffixTokens?: number;
  readonly codeAnnotations?: boolean;
}

export interface CopilotReplicaAlgorithmFimRequest {
  readonly kind: 'copilot-replica/fim';
  readonly targetPath?: string;
  readonly prefix: string;
  readonly suffix: string;
  readonly contexts: readonly CompletionSourceContext[];
  readonly options: CompletionExecutionOptions;
  readonly metadata?: CopilotReplicaFimMetadata;
}

export interface CompletionChatMessage {
  readonly role: 'system' | 'user';
  readonly content: string;
}

export type CopilotReplicaNesResponseFormat =
  | 'codeBlock'
  | 'editWindowOnly'
  | 'unifiedXml'
  | 'editWindowWithEditIntent'
  | 'editWindowWithEditIntentShort';

export type CopilotReplicaResponseFormat =
  | {
      readonly kind: 'nes';
      readonly format: CopilotReplicaNesResponseFormat;
    }
  | { readonly kind: 'cursor-prediction' };

export interface CompletionPrediction {
  readonly type: 'content';
  readonly content: string;
}

export interface CopilotReplicaAlgorithmNesRequest {
  readonly kind: 'copilot-replica/nes';
  readonly messages: readonly CompletionChatMessage[];
  readonly maxTokens?: number;
  readonly prediction?: CompletionPrediction;
  readonly responseFormat: Extract<
    CopilotReplicaResponseFormat,
    { readonly kind: 'nes' }
  >;
}

export interface CopilotReplicaAlgorithmCursorPredictionRequest {
  readonly kind: 'copilot-replica/cursor-prediction';
  readonly messages: readonly CompletionChatMessage[];
  readonly maxTokens?: number;
  readonly responseFormat: Extract<
    CopilotReplicaResponseFormat,
    { readonly kind: 'cursor-prediction' }
  >;
}

export interface FimCompletionRequest {
  readonly kind: 'fim';
  readonly prefix: string;
  readonly suffix: string;
  readonly options: CompletionExecutionOptions;
}

export interface CodeGemmaCompletionContext {
  readonly path?: string;
  readonly content: string;
}

export interface CodeGemmaCompletionRequest {
  readonly kind: 'codegemma';
  readonly targetPath?: string;
  readonly prefix: string;
  readonly suffix: string;
  readonly contexts: readonly CodeGemmaCompletionContext[];
  readonly options: CompletionExecutionOptions;
}

export interface CopilotReplicaNesCompletionRequest {
  readonly kind: 'copilot-replica-nes';
  readonly messages: readonly CompletionChatMessage[];
  readonly maxTokens?: number;
  readonly prediction?: CompletionPrediction;
  readonly responseFormat: CopilotReplicaResponseFormat;
}

export interface ZetaCompletionRequest {
  readonly kind: 'zeta1' | 'zeta2' | 'zeta2.1';
  readonly document: EditAlgorithmDocument;
  readonly trigger: EditPredictionTrigger;
  readonly editHistory: readonly EditHistoryEntry[];
  readonly contexts: readonly CompletionSourceContext[];
  readonly diagnostics: readonly EditAlgorithmDiagnostic[];
  readonly options: CompletionExecutionOptions;
}

export interface Zeta3InternalCompletionRequest {
  readonly kind: 'zeta3-internal';
  readonly document: EditAlgorithmDocument;
  readonly trigger: EditPredictionTrigger;
  readonly editHistory: readonly EditHistoryEntry[];
  readonly diagnostics: readonly EditAlgorithmDiagnostic[];
}

export interface MercuryEditCompletionRequest {
  readonly kind: 'mercury-edit-2';
  readonly document: EditAlgorithmDocument;
  readonly editHistory: readonly EditHistoryEntry[];
  readonly contexts: readonly CompletionSourceContext[];
}

export interface CodestralCompletionRequest {
  readonly kind: 'codestral';
  readonly prefix: string;
  readonly suffix: string;
  readonly options: CompletionExecutionOptions;
}

export interface AlgorithmRequestMap {
  readonly simple: SimpleAlgorithmRequest;
  readonly 'copilot-replica/fim': CopilotReplicaAlgorithmFimRequest;
  readonly 'copilot-replica/nes': CopilotReplicaAlgorithmNesRequest;
  readonly 'copilot-replica/cursor-prediction':
    CopilotReplicaAlgorithmCursorPredictionRequest;
  readonly zed: ZedAlgorithmRequest;
  readonly inception: InceptionAlgorithmRequest;
  readonly mistral: MistralAlgorithmRequest;
}

export interface CompletionRequestMap {
  readonly fim: FimCompletionRequest;
  readonly codegemma: CodeGemmaCompletionRequest;
  readonly 'copilot-replica-nes': CopilotReplicaNesCompletionRequest;
  readonly zeta1: ZetaCompletionRequest & { readonly kind: 'zeta1' };
  readonly zeta2: ZetaCompletionRequest & { readonly kind: 'zeta2' };
  readonly 'zeta2.1': ZetaCompletionRequest & { readonly kind: 'zeta2.1' };
  readonly 'zeta3-internal': Zeta3InternalCompletionRequest;
  readonly 'mercury-edit-2': MercuryEditCompletionRequest;
  readonly codestral: CodestralCompletionRequest;
}

export type AlgorithmRequestKind = keyof AlgorithmRequestMap;
export type CompletionRequestKind = keyof CompletionRequestMap;
export type AlgorithmRequest = AlgorithmRequestMap[AlgorithmRequestKind];
export type CompletionRequest = CompletionRequestMap[CompletionRequestKind];

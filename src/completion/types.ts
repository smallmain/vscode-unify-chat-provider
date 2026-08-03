import type * as vscode from "vscode";
import type {
  AlgorithmRequestKind,
  CopilotReplicaAlgorithmCursorPredictionRequest,
  CopilotReplicaAlgorithmFimRequest,
  CopilotReplicaAlgorithmNesRequest,
  InceptionAlgorithmRequest,
  MistralAlgorithmRequest,
  SimpleAlgorithmRequest,
  ZedAlgorithmRequest,
} from "./model/requests";
import type {
  CopilotReplicaAlgorithmCursorPredictionResponse,
  CopilotReplicaAlgorithmFimResponse,
  CopilotReplicaAlgorithmNesResponse,
  InceptionAlgorithmResponse,
  MistralAlgorithmResponse,
  SimpleAlgorithmResponse,
  ZedAlgorithmResponse,
} from "./model/responses";
import type { CompletionErrorCode } from "./model/errors";

export const INTERNAL_COMPLETION_VENDOR = "unify-chat-provider";

export type CompletionAlgorithmId =
  | "simple"
  | "copilot-replica"
  | "zed"
  | "inception"
  | "mistral";

export interface CompletionAlgorithmEntry {
  id: string;
  algorithm: CompletionAlgorithmId;
  options?: Record<string, unknown>;
}

export type CompletionStopCondition =
  | { type: "firstUsable"; graceMs?: number }
  | { type: "deadline"; timeoutMs: number }
  | { type: "enoughResults"; minItems: number; graceMs?: number }
  | { type: "allSettled" };

export interface CompletionStrategy {
  mode: "all" | "main-first";
  disableVSCodeBuiltinCompletion?: boolean;
  mainProvider?: string;
  mainFirstTimeoutMs?: number;
  parallelRequestOthers?: boolean;
  disabledGlobs?: readonly string[];
  stopWhen: CompletionStopCondition;
}

export interface CompletionConfiguration {
  enabled: boolean;
  providers: CompletionAlgorithmEntry[];
  strategy: CompletionStrategy;
}

export interface CompletionModelReference {
  vendor: string;
  id: string;
}

export interface CompletionModel {
  getCapabilities(): Promise<CompletionModelCapabilities>;
  complete(
    request: SimpleAlgorithmRequest,
    token: vscode.CancellationToken,
  ): Promise<SimpleAlgorithmResponse>;
  complete(
    request: CopilotReplicaAlgorithmFimRequest,
    token: vscode.CancellationToken,
  ): Promise<CopilotReplicaAlgorithmFimResponse>;
  complete(
    request: CopilotReplicaAlgorithmNesRequest,
    token: vscode.CancellationToken,
  ): Promise<CopilotReplicaAlgorithmNesResponse>;
  complete(
    request: CopilotReplicaAlgorithmCursorPredictionRequest,
    token: vscode.CancellationToken,
  ): Promise<CopilotReplicaAlgorithmCursorPredictionResponse>;
  complete(
    request: ZedAlgorithmRequest,
    token: vscode.CancellationToken,
  ): Promise<ZedAlgorithmResponse>;
  complete(
    request: InceptionAlgorithmRequest,
    token: vscode.CancellationToken,
  ): Promise<InceptionAlgorithmResponse>;
  complete(
    request: MistralAlgorithmRequest,
    token: vscode.CancellationToken,
  ): Promise<MistralAlgorithmResponse>;
}

export interface CompletionModelCapabilities {
  readonly supportsNextCursorLinePrediction: boolean;
  readonly minimumCursorPredictionTokens?: number;
}

export interface CompletionModelEligibility {
  readonly eligible: boolean;
  readonly code?: CompletionErrorCode;
  readonly message?: string;
}

export interface CompletionModelResolver {
  getConfigurationFingerprint?(reference: CompletionModelReference): string;
  resolveCompletionModel(
    reference: CompletionModelReference,
    token: vscode.CancellationToken,
  ): Promise<CompletionModel>;
  evaluateModelForRequest?(
    reference: CompletionModelReference,
    sourceKind: AlgorithmRequestKind,
  ): Promise<CompletionModelEligibility>;
}

export interface CompletionAlgorithmInput {
  document: vscode.TextDocument;
  position: vscode.Position;
  context: vscode.InlineCompletionContext;
}

export interface CompletionAlgorithmResult {
  providerId: string;
  items: vscode.InlineCompletionItem[];
  metadata?: Record<string, unknown>;
}

export interface CompletionAlgorithmChange {
  branch?: "fim" | "nes" | "diagnostics";
  reason: string;
  data?: unknown;
}

export type CompletionEnvironmentChangeReason =
  | "auth-changed"
  | "provider-changed"
  | "settings-changed";

export interface CompletionAlgorithm {
  readonly onDidChange?: vscode.Event<CompletionAlgorithmChange | void>;
  handleEnvironmentChange?(reason: CompletionEnvironmentChangeReason): void;
  handleDidChangeChatModels?(): void;
  provideInlineCompletions(
    input: CompletionAlgorithmInput,
    token: vscode.CancellationToken,
  ): Promise<CompletionAlgorithmResult | undefined>;
  handleDidShowCompletionItem?(
    item: vscode.InlineCompletionItem,
    updatedInsertText: string,
  ): void;
  handleDidPartiallyAcceptCompletionItem?(
    item: vscode.InlineCompletionItem,
    info: vscode.PartialAcceptInfo | number,
  ): void;
  handleEndOfLifetime?(
    item: vscode.InlineCompletionItem,
    reason: vscode.InlineCompletionEndOfLifeReason,
  ): void;
  handleListEndOfLifetime?(
    list: vscode.InlineCompletionList,
    reason: vscode.InlineCompletionsDisposeReason,
  ): void;
  trackCompletionList?(
    list: vscode.InlineCompletionList,
    items: readonly vscode.InlineCompletionItem[],
  ): void;
  handleDiscardedCompletionItems?(
    items: readonly vscode.InlineCompletionItem[],
    reason: CompletionDiscardReason,
  ): void;
  updateOptions?(normalizedOptions: unknown): boolean;
  getDebugState?(): unknown;
  dispose?(): void;
}

export type CompletionDiscardReason = "lost-race" | "not-taken" | "duplicate";

export interface CompletionAlgorithmContext {
  entry: CompletionAlgorithmEntry;
  options: unknown;
  modelResolver: CompletionModelResolver;
  reportConfigurationError(key: string, message: string): void;
  reportRuntimeError?(source: string, message: string, error: unknown): void;
}

export type CompletionAlgorithmOptionsResult =
  { ok: true; value: unknown } | { ok: false; error: string };

export interface CompletionAlgorithmDefinition {
  id: CompletionAlgorithmId;
  label: string;
  description?: string;
  getSettingsDetail?(rawOptions: unknown): string;
  getModelReferences?(
    normalizedOptions: unknown,
  ): readonly CompletionModelReference[];
  getRuntimeIdentity?(normalizedOptions: unknown): unknown;
  create(context: CompletionAlgorithmContext): CompletionAlgorithm;
  normalizeOptions(raw: unknown): CompletionAlgorithmOptionsResult;
}

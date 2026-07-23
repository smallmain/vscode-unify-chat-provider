import { randomUUID } from "node:crypto";
import { isAbsolute, resolve } from "node:path";
import * as vscode from "vscode";
import { t } from "../../i18n";
import {
  COPILOT_BEHAVIOR_CONFIG,
  type CopilotBehaviorConfig,
  type NesAggressivenessSetting,
  type NesPromptStrategy,
} from "../../chat-lib/core/behavior-config";
import {
  NextEditCache,
  type NesCacheEntry,
} from "../../chat-lib/core/nes/cache";
import {
  computeReducedNesWindow,
  cursorAfterNesEditWindow,
} from "../../chat-lib/core/nes/cache-window";
import { tryRebaseNesEdits } from "../../chat-lib/core/nes/edit-rebase";
import {
  buildCursorPredictionPrompt,
  decideCursorPrediction,
  parseCursorPredictionResponse,
  runNesCrossFileOpenContinuation,
  type CursorJumpPrediction,
  type CursorPredictionPrompt,
} from "../../chat-lib/core/nes/cursor-predictor";
import { raceNesDiagnostics } from "../../chat-lib/core/nes/diagnostics-race";
import {
  buildOfficialNesPrompt,
  computeNesEditWindow,
  determineNesLanguageContextOptions,
  NesPromptTooLargeError,
} from "../../chat-lib/core/nes/prompt";
import { streamOfficialNesResponse } from "../../chat-lib/core/nes/response";
import {
  canReuseNesPendingSpeculative,
  NesSpeculativeState,
  resolveNesSpeculativeEditWindowLines,
  type NesSpeculativeCancelReason,
} from "../../chat-lib/core/nes/speculative";
import {
  hasUserTypedSinceNesRequestStarted,
  NesStringEdit,
  NesStringReplacement,
} from "../../chat-lib/core/nes/string-edit";
import { isIntermediateModelLineCompatible } from "../../chat-lib/core/nes/stream-compatibility";
import {
  NesDelaySession,
  NesUserInteractionMonitor,
  shouldRecordNesIgnored,
} from "../../chat-lib/core/nes/user-interaction";
import type {
  NesDocumentContext,
  NesParsedResponse,
  NesPromptBuildResult,
  NesPromptContext,
  NesTextEdit,
} from "../../chat-lib/core/nes/types";
import { LinkedCancellationTokenSource } from "../cancellation";
import type {
  CompletionAlgorithmContext,
  CompletionAlgorithmInput,
  CompletionModel,
  CompletionModelCapabilities,
  CompletionModelReference,
} from "../types";
import type {
  CopilotReplicaAlgorithmCursorPredictionRequest,
  CopilotReplicaAlgorithmNesRequest,
  CopilotReplicaNesResponseFormat,
} from "../model/requests";
import type { CopilotReplicaAlgorithmNesResponse } from "../model/responses";
import { CompletionConfigurationError } from "../model/errors";
import {
  DiagnosticsNextEditProvider,
  type DiagnosticsNesSuggestion,
} from "./diagnostics-provider";
import type { InlineEditTriggerState } from "../../chat-lib/core/nes/triggerer";
import type {
  CopilotWorkspaceAdapter,
  CopilotWorkspaceContext,
} from "./workspace";

export type NextEditWorkspaceAdapter = Pick<
  CopilotWorkspaceAdapter,
  | "snapshot"
  | "hasEditHistory"
  | "gatherContext"
  | "isDocumentIgnored"
  | "isDocumentIgnoredWithRules"
  | "isTracked"
>;

export interface NesBranchSuggestion {
  readonly branch: "nes" | "diagnostics";
  readonly source: "llm" | "diagnostics";
  readonly requestId: string;
  readonly sourceRequestId: string;
  readonly edit?: NesTextEdit;
  readonly command?: vscode.Command;
  readonly prompt?: NesPromptBuildResult;
  readonly cacheEntry?: NesCacheEntry;
  readonly fromCache: boolean;
  readonly rebased: boolean;
  readonly subsequent: boolean;
  readonly speculative: boolean;
  readonly sourceIsSpeculative: boolean;
  readonly createdAt: number;
  readonly seed?: SpeculativeSeed;
  readonly cursorJump?: NesCursorJumpSource;
  readonly diagnosticsSuggestion?: DiagnosticsNesSuggestion;
  readonly documentGuards?: readonly NesDocumentContext[];
}

export interface NesCursorJumpSource {
  readonly kind: "sameFile" | "differentFile";
  readonly sourceUri: string;
  readonly targetUri: string;
  readonly lineNumber: number;
  readonly fallbackOnly?: boolean;
}

export interface NesCursorPredictionDebugState {
  readonly outcome:
    | "disabled"
    | "model-unavailable"
    | "request-failed"
    | "prompt-failed"
    | "parse-failed"
    | "within-edit-window"
    | "out-of-bounds"
    | "target-unavailable"
    | "document-changed"
    | "retry-empty"
    | "retry-edit";
  readonly reason?: string;
  readonly targetUri?: string;
  readonly lineNumber?: number;
}

interface SpeculativeSeed {
  readonly generation: NesRequestGeneration;
  readonly targetBeforeEdit: NesDocumentContext;
  readonly edit: NesTextEdit;
  readonly strategy: NesPromptStrategy;
  readonly modelReference: CompletionModelReference;
  readonly originStream: OriginStreamState;
}

interface OriginStreamState {
  readonly requestId: string;
  done: boolean;
  activeDocumentEditSeen: boolean;
}

interface ConsumerAttachedRequest {
  readonly source: vscode.CancellationTokenSource;
  readonly attachmentCompletion: Promise<unknown>;
  readonly cancelCleanup?: () => void;
  readonly lifecycle: ConsumerRequestLifecycle;
  dependents: number;
  settled: boolean;
  cancellationTimer?: ReturnType<typeof setTimeout>;
}

interface ConsumerRequestLifecycle {
  transportStarted: boolean;
}

interface NesRequestGeneration {
  readonly id: number;
  readonly cache: NextEditCache;
}

const DETACHED_REQUEST_CANCELLATION_GRACE_MS = 1_000;

interface NesRequestEditTracking {
  readonly sourceUri: string;
  readonly sourceText: string;
  readonly documentGuards: NesDocumentContext[];
  intermediateUserEdit: NesStringEdit | undefined;
  currentSourceText: string;
  documentChangeReason?: string;
  subscription?: vscode.Disposable;
  disposed: boolean;
}

interface InFlightRequest extends ConsumerAttachedRequest {
  readonly generation: NesRequestGeneration;
  readonly documentUri: string;
  readonly documentText: string;
  readonly requestId: string;
  readonly editTracking: NesRequestEditTracking;
  readonly metadata: {
    contextKey?: string;
    editWindow?: {
      readonly startOffset: number;
      readonly endOffset: number;
    };
    originalEditWindow?: {
      readonly startOffset: number;
      readonly endOffset: number;
    };
  };
  readonly promise: Promise<NesBranchSuggestion | undefined>;
  readonly completion: Promise<void>;
  readonly activeDocumentEditSeen: Promise<boolean>;
}

interface NesFetchOperation {
  readonly suggestion: NesBranchSuggestion;
  readonly completion: Promise<void>;
  readonly originStream?: OriginStreamState;
}

type NesCursorRetryResult =
  | {
      readonly kind: "operation";
      readonly operation: NesFetchOperation;
    }
  | {
      readonly kind: "noSuggestions" | "cancelled";
    };

interface NesCursorRetryTarget {
  readonly document?: vscode.TextDocument;
  readonly snapshot: NesDocumentContext;
  readonly lineNumber: number;
  readonly cursorOffset: number;
}

type NesCrossFileRetryResolution =
  | NesCursorRetryResult
  | {
      readonly kind: "target";
      readonly target: NesCursorRetryTarget;
    };

interface NesActiveCacheContext {
  readonly documentUri: string;
  readonly documentText: string;
  readonly cursorOffset: number;
  readonly editTracking?: NesRequestEditTracking;
}

interface StreamedCandidate {
  readonly original: NesTextEdit;
  readonly current: NesTextEdit;
  readonly documentBeforeEdit: string;
  readonly subsequentN: number;
}

type StreamedCandidateResult =
  | {
      readonly done: false;
      readonly value: StreamedCandidate | undefined;
    }
  | { readonly done: true; readonly value: NesParsedResponse | undefined };

interface PendingSpeculativeOperation extends ConsumerAttachedRequest {
  readonly generation: NesRequestGeneration;
  readonly source: vscode.CancellationTokenSource;
  readonly operation: Promise<NesFetchOperation>;
  readonly editWindow: {
    readonly startOffset: number;
    readonly endOffset: number;
  };
}

function selectedCompletionText(
  context: vscode.InlineCompletionContext,
): string | undefined {
  const selected = context.selectedCompletionInfo;
  return selected?.text;
}

function textAfterOffsetOnLine(text: string, offset: number): string {
  const boundedOffset = Math.max(0, Math.min(offset, text.length));
  const lineEnd = text.indexOf("\n", boundedOffset);
  return text.slice(boundedOffset, lineEnd === -1 ? text.length : lineEnd);
}

function toPromptContext(
  workspace: CopilotWorkspaceContext,
  cursorOffset: number,
  selectedText: string | undefined,
): NesPromptContext {
  const historyEvents = [
    ...workspace.editHistory.map((entry) => ({
      ...entry,
      kind: "edit" as const,
    })),
    ...workspace.recentDocuments
      .filter((document) => document.visibleRanges.length > 0)
      .map((document) => ({
        kind: "visibleRanges" as const,
        uri: document.uri,
        path: document.path,
        relativePath: document.relativePath,
        languageId: document.languageId,
        text: document.text,
        timestamp: document.lastViewedAt,
        visibleRanges: document.visibleRanges,
      })),
  ].sort((left, right) => right.timestamp - left.timestamp);
  return {
    current: workspace.current,
    cursorOffset,
    ...(selectedText ? { selectedCompletionText: selectedText } : {}),
    recentDocuments: workspace.recentDocuments,
    editHistory: workspace.editHistory,
    historyEvents,
    neighborSnippets: workspace.neighborSnippets,
    diagnostics: workspace.promptDiagnostics,
    languageContext: workspace.languageContext,
    ...(workspace.gitDiff ? { gitDiff: workspace.gitDiff } : {}),
  };
}

function applyEdit(text: string, edit: NesTextEdit): string {
  return `${text.slice(0, edit.startOffset)}${edit.newText}${text.slice(edit.endOffset)}`;
}

function preciseEdit(text: string, edit: NesTextEdit): NesTextEdit {
  const original = text.slice(edit.startOffset, edit.endOffset);
  let prefix = 0;
  while (
    prefix < original.length &&
    prefix < edit.newText.length &&
    original[prefix] === edit.newText[prefix]
  ) {
    prefix += 1;
  }
  let suffix = 0;
  while (
    suffix < original.length - prefix &&
    suffix < edit.newText.length - prefix &&
    original[original.length - suffix - 1] ===
      edit.newText[edit.newText.length - suffix - 1]
  ) {
    suffix += 1;
  }
  const startOffset = edit.startOffset + prefix;
  const endOffset = edit.endOffset - suffix;
  return {
    ...edit,
    startOffset,
    endOffset,
    newText: edit.newText.slice(prefix, edit.newText.length - suffix),
    kind: startOffset === endOffset ? "insert" : "replace",
  };
}

export function predictionForNesPrompt(prompt: NesPromptBuildResult): string {
  switch (prompt.strategy) {
    case "copilotNesXtab":
      return `\`\`\`\n${prompt.editWindow.lines.join("\n")}\n\`\`\``;
    case "xtab275":
    case "xtabAggressiveness":
    case "xtab275Aggressiveness":
    case "xtab275AggressivenessHighLow":
      return prompt.editWindow.lines.join("\n");
    case "xtabUnifiedModel":
      return `<EDIT>\n${prompt.editWindow.lines.join("\n")}\n</EDIT>`;
    case "xtab275EditIntent":
      return `<|edit_intent|>high<|/edit_intent|>\n${prompt.editWindow.lines.join("\n")}`;
    case "xtab275EditIntentShort":
      return `H\n${prompt.editWindow.lines.join("\n")}`;
  }
}

function createModelRequest(
  prompt: NesPromptBuildResult,
  usePrediction: boolean,
  responseFormat: CopilotReplicaNesResponseFormat,
): CopilotReplicaAlgorithmNesRequest {
  return {
    kind: "copilot-replica/nes",
    messages: [
      { role: "system", content: prompt.messages.system },
      { role: "user", content: prompt.messages.user },
    ],
    ...(usePrediction
      ? {
          prediction: {
            type: "content",
            content: predictionForNesPrompt(prompt),
          },
        }
      : {}),
    responseFormat: { kind: "nes", format: responseFormat },
  };
}

function createCursorPredictionRequest(
  prompt: CursorPredictionPrompt,
  maxResponseTokens: number,
): CopilotReplicaAlgorithmCursorPredictionRequest {
  return {
    kind: "copilot-replica/cursor-prediction",
    messages: prompt.messages.map((message) => ({
      role: message.role,
      content: message.content,
    })),
    maxTokens: maxResponseTokens,
    responseFormat: { kind: "cursor-prediction" },
  };
}

function isLanguageModelNotFound(error: unknown): boolean {
  const seen = new Set<object>();
  let current = error;
  while (typeof current === "object" && current !== null) {
    if (seen.has(current)) return false;
    seen.add(current);
    const code = Reflect.get(current, "code");
    if (code === "NotFound" || code === "completion-model-not-found") {
      return true;
    }
    current = Reflect.get(current, "cause");
  }
  return false;
}

async function collectResponseText(
  chunks: AsyncIterable<string>,
  token: vscode.CancellationToken,
): Promise<string | undefined> {
  let text = "";
  for await (const chunk of chunks) {
    if (token.isCancellationRequested) {
      return undefined;
    }
    text += chunk;
  }
  return token.isCancellationRequested ? undefined : text;
}

function delay(
  delayMs: number,
  token: vscode.CancellationToken,
): Promise<boolean> {
  if (delayMs <= 0) {
    return Promise.resolve(!token.isCancellationRequested);
  }
  return new Promise((resolve) => {
    let subscription: vscode.Disposable | undefined;
    const handle = setTimeout(() => {
      subscription?.dispose();
      resolve(!token.isCancellationRequested);
    }, delayMs);
    subscription = token.onCancellationRequested(() => {
      clearTimeout(handle);
      subscription?.dispose();
      resolve(false);
    });
  });
}

function delayWithoutCancellation(delayMs: number): Promise<void> {
  if (delayMs <= 0) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });
}

function stringEditForDocumentChange(
  event: vscode.TextDocumentChangeEvent,
): NesStringEdit {
  const replacements = event.contentChanges
    .map(
      (change) =>
        new NesStringReplacement(
          {
            start: change.rangeOffset,
            endOffset: change.rangeOffset + change.rangeLength,
          },
          change.text,
        ),
    )
    .sort((left, right) => left.range.start - right.range.start);
  return new NesStringEdit(replacements);
}

export class OfficialNextEditProvider implements vscode.Disposable {
  private readonly diagnostics: DiagnosticsNextEditProvider;
  private generation: NesRequestGeneration;
  private inFlight: InFlightRequest | undefined;
  private readonly detachedInFlight = new Set<InFlightRequest>();
  private readonly suggestionGenerations = new WeakMap<
    NesBranchSuggestion,
    NesRequestGeneration
  >();
  private lastShownSuggestionId: string | undefined;
  private lastShownTime = 0;
  private readonly speculativeState = new NesSpeculativeState<
    NesBranchSuggestion,
    PendingSpeculativeOperation
  >();
  private readonly speculativeSources =
    new Set<vscode.CancellationTokenSource>();
  private readonly documentChangeSubscription: vscode.Disposable;
  private readonly cursorPredictionModelReference: CompletionModelReference;
  private readonly userInteractionMonitor: NesUserInteractionMonitor;
  private cursorPredictionModel: CompletionModel | undefined;
  private cursorPredictionModelResolution:
    Promise<CompletionModel | undefined> | undefined;
  private cursorPredictionModelGeneration = 0;
  private cursorPredictionDisabled = false;
  private disposed = false;
  private lastRejectionTime = Number.NEGATIVE_INFINITY;
  private lastOutcome: "accepted" | "rejected" | "ignored" | undefined;
  private lastCursorPrediction: NesCursorPredictionDebugState | undefined;
  private lastProvidedSuggestion: NesBranchSuggestion | undefined;
  private shouldExpandEditWindow = false;
  constructor(
    private readonly algorithmContext: CompletionAlgorithmContext,
    private readonly workspace: NextEditWorkspaceAdapter,
    private readonly triggerState: InlineEditTriggerState,
    private readonly modelReference: CompletionModelReference,
    private readonly strategy: NesPromptStrategy,
    private readonly config: CopilotBehaviorConfig = COPILOT_BEHAVIOR_CONFIG,
    private readonly now: () => number = Date.now,
    cursorPredictionModelReference?: CompletionModelReference,
    aggressivenessSetting: NesAggressivenessSetting = config.nextEdit
      .defaultAggressivenessSetting,
  ) {
    this.cursorPredictionModelReference =
      cursorPredictionModelReference ?? modelReference;
    this.userInteractionMonitor = new NesUserInteractionMonitor(
      config.nextEdit,
      aggressivenessSetting,
      { now: this.now },
    );
    this.generation = { id: 0, cache: this.createCache() };
    this.diagnostics = new DiagnosticsNextEditProvider(
      config.nextEdit.diagnosticsStartDelayMs,
      this.now,
      config.nextEdit,
    );
    this.documentChangeSubscription = vscode.workspace.onDidChangeTextDocument(
      (event) => {
        const edit = stringEditForDocumentChange(event);
        const uri = event.document.uri.toString();
        this.generation.cache.handleDocumentEdit(
          uri,
          edit,
          event.document.getText(),
        );
        if (!this.config.nextEdit.asyncCompletions) {
          const request = this.inFlight;
          if (
            request?.documentUri === uri &&
            request.documentText !== event.document.getText()
          ) {
            this.cancelAttachedRequest(request);
          }
        }
      },
    );
  }

  async provide(
    input: CompletionAlgorithmInput,
    token: vscode.CancellationToken,
    enforceCacheDelay: boolean,
  ): Promise<NesBranchSuggestion | undefined> {
    const generation = this.generation;
    if (this.disposed || token.isCancellationRequested) {
      return undefined;
    }
    const currentDocumentIgnored =
      await this.workspace.isDocumentIgnoredWithRules(input.document, token);
    if (currentDocumentIgnored || token.isCancellationRequested) {
      if (currentDocumentIgnored) {
        this.diagnostics.removeDocument(input.document.uri.toString());
      }
      return undefined;
    }
    this.triggerState.recordProviderTrigger();
    const diagnosticsSource = new LinkedCancellationTokenSource(token);
    try {
      const llmPromise = this.provideLlm(
        input,
        token,
        enforceCacheDelay,
        generation,
      );
      const diagnosticsPromise = this.diagnostics
        .provide(input.document, input.position, diagnosticsSource.token)
        .then<NesBranchSuggestion | undefined>((suggestion) =>
          suggestion
            ? {
                branch: "diagnostics",
                source: "diagnostics",
                requestId: input.context.requestUuid,
                sourceRequestId: input.context.requestUuid,
                edit: suggestion.edit,
                diagnosticsSuggestion: suggestion,
                ...(suggestion.command ? { command: suggestion.command } : {}),
                fromCache: false,
                rebased: false,
                subsequent: false,
                speculative: false,
                sourceIsSpeculative: false,
                createdAt: this.now(),
              }
            : undefined,
        );
      const race = await raceNesDiagnostics({
        llm: {
          result: llmPromise,
          cancel: () => undefined,
        },
        diagnostics: {
          result: diagnosticsPromise,
          cancel: () => diagnosticsSource.cancel(),
        },
        isLlmResult: (suggestion): suggestion is NesBranchSuggestion =>
          suggestion?.edit !== undefined ||
          suggestion?.cursorJump !== undefined,
        isDiagnosticsResult: (suggestion): suggestion is NesBranchSuggestion =>
          suggestion?.edit !== undefined,
        requestIssuedAtMs: input.context.requestIssuedDateTime,
        diagnosticsDeadlineMs: this.config.nextEdit.diagnosticsRaceDeadlineMs,
        clock: {
          now: this.now,
          sleep: (delayMs) =>
            new Promise<void>((resolve) => {
              setTimeout(resolve, delayMs);
            }),
        },
      });
      if (race.kind === "failed") {
        throw race.error;
      }
      if (race.kind !== "winner" || token.isCancellationRequested) {
        if (generation === this.generation) {
          this.lastProvidedSuggestion = undefined;
        }
        return undefined;
      }
      const suggestion =
        race.value.source === "diagnostics" &&
        !this.isSuggestionCurrent(race.value)
          ? undefined
          : race.value;
      if (generation === this.generation) {
        this.lastProvidedSuggestion = suggestion;
      }
      return suggestion;
    } finally {
      diagnosticsSource.dispose();
    }
  }

  handleShown(suggestion: NesBranchSuggestion, renderedInline: boolean): void {
    if (suggestion.source === "diagnostics") {
      return;
    }
    const generation = this.generationForSuggestion(suggestion);
    if (generation === this.generation) {
      this.speculativeState.clearScheduled();
    }
    this.triggerState.recordShown();
    this.lastOutcome = undefined;
    this.lastShownSuggestionId = suggestion.requestId;
    this.lastShownTime = this.now();
    generation.cache.markShown(
      suggestion.sourceRequestId,
      renderedInline,
      suggestion.cacheEntry,
    );
    if (
      this.config.nextEdit.speculativeRequests === "on" &&
      suggestion.seed &&
      generation === this.generation &&
      suggestion.edit
    ) {
      this.scheduleSpeculative(suggestion);
    }
  }

  setEagerness(setting: NesAggressivenessSetting | undefined): void {
    this.userInteractionMonitor.setAggressivenessSetting(
      setting ?? this.config.nextEdit.defaultAggressivenessSetting,
    );
  }

  handleDidChangeChatModels(): void {
    this.cursorPredictionModelGeneration += 1;
    this.cursorPredictionModel = undefined;
    this.cursorPredictionModelResolution = undefined;
    this.cursorPredictionDisabled = false;
  }

  handleAuthChange(): void {
    if (this.disposed) {
      return;
    }
    const previous = this.generation;
    this.generation = {
      id: previous.id + 1,
      cache: this.createCache(),
    };
    const request = this.inFlight;
    if (request) {
      this.inFlight = undefined;
      this.detachedInFlight.add(request);
    }
    this.speculativeState.clearScheduled();
    this.speculativeState.clearPending();
    this.lastProvidedSuggestion = undefined;
    this.lastCursorPrediction = undefined;
    this.shouldExpandEditWindow = false;
    this.handleDidChangeChatModels();
  }

  handleAccepted(suggestion: NesBranchSuggestion): void {
    if (suggestion.source === "diagnostics") {
      if (suggestion.diagnosticsSuggestion) {
        this.diagnostics.handleAccepted(suggestion.diagnosticsSuggestion);
      }
      return;
    }
    this.userInteractionMonitor.handleAcceptance();
    this.lastOutcome = "accepted";
    this.triggerState.recordOutcome("accepted");
    if (
      suggestion.source === "llm" &&
      suggestion === this.lastProvidedSuggestion
    ) {
      this.shouldExpandEditWindow = true;
    }
    const generation = this.generationForSuggestion(suggestion);
    const cache = generation.cache;
    if (suggestion.cacheEntry) {
      cache.markAccepted(suggestion.cacheEntry);
    } else {
      cache.createSubsequent(suggestion.sourceRequestId);
    }
  }

  handleRejected(suggestion: NesBranchSuggestion): void {
    if (suggestion.source === "diagnostics") {
      if (suggestion.diagnosticsSuggestion) {
        this.diagnostics.handleRejected(suggestion.diagnosticsSuggestion);
      }
      return;
    }
    this.userInteractionMonitor.handleRejection();
    this.lastOutcome = "rejected";
    this.lastRejectionTime = this.now();
    this.triggerState.recordOutcome("rejected");
    const shownEdit = suggestion.edit;
    const shownDocumentText = shownEdit
      ? this.findOpenDocument(shownEdit.uri)?.getText()
      : undefined;
    const generation = this.generationForSuggestion(suggestion);
    const cache = generation.cache;
    if (this.now() - this.lastShownTime > 1_000) {
      if (shownEdit && shownDocumentText !== undefined) {
        cache.recordPersistentRejection(
          shownEdit.uri,
          shownDocumentText,
          shownEdit,
        );
      }
      cache.markRejected(
        suggestion.sourceRequestId,
        shownEdit,
        shownDocumentText,
      );
    }
    if (generation === this.generation) {
      this.speculativeState.cancelAll("rejected");
    }
  }

  handleIgnored(
    suggestion: NesBranchSuggestion,
    supersededBy?: NesBranchSuggestion,
  ): void {
    if (suggestion.source === "diagnostics") {
      if (suggestion.diagnosticsSuggestion) {
        this.diagnostics.handleIgnored(suggestion.diagnosticsSuggestion);
      }
      return;
    }
    this.lastOutcome = "ignored";
    this.triggerState.recordOutcome("ignored");
    const generation = this.generationForSuggestion(suggestion);
    const wasShown = this.lastShownSuggestionId === suggestion.requestId;
    if (shouldRecordNesIgnored(wasShown, supersededBy !== undefined)) {
      this.userInteractionMonitor.handleIgnored();
      if (generation === this.generation) {
        this.speculativeState.cancelAll("ignoredDismissed");
      }
    }
  }

  removeDocument(uri: string): void {
    this.generation.cache.removeDocument(uri);
    this.diagnostics.removeDocument(uri);
    this.speculativeState.onDocumentClosed(uri);
  }

  getState(): {
    readonly cacheSize: number;
    readonly inFlight: number;
    readonly hasSpeculativeRequest: boolean;
    readonly speculative: ReturnType<
      NesSpeculativeState<
        NesBranchSuggestion,
        PendingSpeculativeOperation
      >["getState"]
    >;
    readonly lastRejectionTime: number;
    readonly lastOutcome: "accepted" | "rejected" | "ignored" | undefined;
    readonly expandNextFreshRequest: boolean;
    readonly diagnostics: ReturnType<DiagnosticsNextEditProvider["getState"]>;
    readonly userInteraction: ReturnType<NesUserInteractionMonitor["getState"]>;
    readonly cursorPrediction?: NesCursorPredictionDebugState;
  } {
    const speculative = this.speculativeState.getState();
    return {
      cacheSize: this.generation.cache.size,
      inFlight: this.inFlight ? 1 : 0,
      hasSpeculativeRequest: speculative.pending || speculative.scheduled,
      speculative,
      lastRejectionTime: this.lastRejectionTime,
      lastOutcome: this.lastOutcome,
      expandNextFreshRequest: this.shouldExpandEditWindow,
      diagnostics: this.diagnostics.getState(),
      userInteraction: this.userInteractionMonitor.getState(),
      ...(this.lastCursorPrediction
        ? { cursorPrediction: this.lastCursorPrediction }
        : {}),
    };
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    const request = this.inFlight;
    if (request) {
      this.cancelAttachedRequest(request);
      request.source.dispose();
    }
    this.inFlight = undefined;
    for (const detached of this.detachedInFlight) {
      this.cancelAttachedRequest(detached);
      detached.source.dispose();
    }
    this.detachedInFlight.clear();
    this.speculativeState.cancelAll("disposed");
    for (const source of this.speculativeSources) {
      source.cancel();
      source.dispose();
    }
    this.speculativeSources.clear();
    this.documentChangeSubscription.dispose();
    this.generation.cache.clear();
    this.diagnostics.dispose();
  }

  private async provideLlm(
    input: CompletionAlgorithmInput,
    token: vscode.CancellationToken,
    enforceCacheDelay: boolean,
    generation: NesRequestGeneration,
  ): Promise<NesBranchSuggestion | undefined> {
    return this.provideLlmCore(input, token, enforceCacheDelay, generation);
  }

  private async provideLlmCore(
    input: CompletionAlgorithmInput,
    token: vscode.CancellationToken,
    enforceCacheDelay: boolean,
    generation: NesRequestGeneration,
    afterFailedRebase = false,
  ): Promise<NesBranchSuggestion | undefined> {
    const current = this.workspace.snapshot(input.document);
    const shouldExpandEditWindow = this.shouldExpandEditWindow;
    const cursorOffset = input.document.offsetAt(input.position);
    if (afterFailedRebase) {
      const replacementRequest =
        this.inFlight?.generation === generation ? this.inFlight : undefined;
      if (
        replacementRequest &&
        replacementRequest.documentText === current.text &&
        !replacementRequest.source.token.isCancellationRequested
      ) {
        return this.awaitInFlightRequest(
          replacementRequest,
          input,
          token,
          enforceCacheDelay,
          true,
        );
      }
      if (replacementRequest) {
        this.cancelAttachedRequest(replacementRequest);
        if (this.inFlight === replacementRequest) {
          this.inFlight = undefined;
        }
        this.speculativeState.clearScheduled();
      }
      if (generation === this.generation) {
        this.speculativeState.cancelIfMismatch(current.uri, current.text);
      }
    } else {
      const cached = generation.cache.lookup(
        current.uri,
        current.text,
        cursorOffset,
        (uri) => this.findOpenDocument(uri)?.getText(),
      );
      if (cached?.noSuggestions) {
        return undefined;
      }
      if (cached?.entry.rejected) {
        if (cached.edit) {
          const targetText = this.findOpenDocument(cached.edit.uri)?.getText();
          if (targetText !== undefined) {
            generation.cache.recordPersistentRejection(
              cached.edit.uri,
              targetText,
              cached.edit,
            );
          }
        }
        return undefined;
      }
      if (cached?.edit) {
        const cachedEdit = cached.edit;
        const guards = await this.cacheGuards(
          current,
          cached.entry,
          cachedEdit,
          token,
        );
        if (!guards) {
          return undefined;
        }
        const suggestion = this.trackSuggestion(
          {
            branch: "nes",
            source: "llm",
            requestId: input.context.requestUuid || randomUUID(),
            sourceRequestId: cached.entry.requestId,
            edit: cachedEdit,
            cacheEntry: cached.entry,
            fromCache: true,
            rebased: cached.rebased,
            subsequent: cached.subsequent,
            speculative: cached.speculative,
            sourceIsSpeculative: cached.entry.speculative,
            createdAt: this.now(),
            documentGuards: guards,
            ...this.speculativeSeedForCachedSuggestion(
              current,
              cachedEdit,
              cached.entry,
              generation,
            ),
          },
          generation,
        );
        if (this.isSuggestionRejected(suggestion, generation.cache)) {
          return undefined;
        }
        return (await this.enforceMinimumDelay(
          suggestion,
          input.context.requestIssuedDateTime,
          enforceCacheDelay,
          token,
        ))
          ? suggestion
          : undefined;
      }

      const pending =
        generation === this.generation
          ? this.speculativeState.pending
          : undefined;
      if (
        pending &&
        pending.value.generation === generation &&
        canReuseNesPendingSpeculative({
          documentUri: current.uri,
          documentText: current.text,
          cursorOffset,
          pendingDocumentUri: pending.documentUri,
          pendingDocumentText: pending.postEditContent,
          pendingEditWindow: pending.value.editWindow,
          pendingCancellationRequested:
            pending.value.source.token.isCancellationRequested,
        })
      ) {
        const pendingOperation = this.speculativeState.consumePending(
          current.uri,
          current.text,
        );
        if (!pendingOperation) return undefined;
        return this.awaitSpeculativeRequest(
          pendingOperation,
          current,
          input,
          token,
          enforceCacheDelay,
        );
      }
      const activeRequest =
        this.inFlight?.generation === generation ? this.inFlight : undefined;
      const activeEditWindow = activeRequest?.metadata.editWindow;
      const originalActiveEditWindow =
        activeRequest?.metadata.originalEditWindow;
      const cursorWithinActiveWindow =
        (activeEditWindow === undefined &&
          originalActiveEditWindow === undefined) ||
        (activeEditWindow !== undefined &&
          cursorOffset >= activeEditWindow.startOffset &&
          cursorOffset <= activeEditWindow.endOffset) ||
        (originalActiveEditWindow !== undefined &&
          cursorOffset >= originalActiveEditWindow.startOffset &&
          cursorOffset <= originalActiveEditWindow.endOffset);
      if (
        activeRequest &&
        (activeRequest.documentText === current.text ||
          this.config.nextEdit.asyncCompletions) &&
        cursorWithinActiveWindow &&
        !activeRequest.source.token.isCancellationRequested
      ) {
        if (activeRequest.documentText !== current.text) {
          const reused = await this.rebaseChangedInFlightRequest(
            activeRequest,
            current,
            cursorOffset,
            input,
            token,
            enforceCacheDelay,
          );
          if (reused || token.isCancellationRequested) return reused;
          return this.provideLlmCore(
            input,
            token,
            enforceCacheDelay,
            generation,
            true,
          );
        }
        return this.awaitInFlightRequest(
          activeRequest,
          input,
          token,
          enforceCacheDelay,
          true,
        );
      }

      if (activeRequest) {
        this.cancelAttachedRequest(activeRequest);
        if (this.inFlight === activeRequest) {
          this.inFlight = undefined;
        }
        this.speculativeState.clearScheduled();
      }
      if (generation === this.generation) {
        this.speculativeState.cancelIfMismatch(current.uri, current.text);
      }
    }
    if (!this.workspace.hasEditHistory()) {
      return undefined;
    }
    const source = new vscode.CancellationTokenSource();
    const editTracking = this.createFreshEditTracking(current, source);
    const initialEditWindow = computeNesEditWindow(
      current.text,
      cursorOffset,
      this.config,
      shouldExpandEditWindow
        ? this.config.nextEdit.autoExpandEditWindowLines
        : this.config.prompt.linesBelowEditWindow,
    );
    const metadata: InFlightRequest["metadata"] = {
      editWindow: {
        startOffset: initialEditWindow.startOffset,
        endOffset: initialEditWindow.endOffset,
      },
    };
    const requestId = input.context.requestUuid || randomUUID();
    const lifecycle: ConsumerRequestLifecycle = { transportStarted: false };
    const operation = this.prepareFreshRequest(
      input,
      current,
      cursorOffset,
      shouldExpandEditWindow,
      requestId,
      source.token,
      metadata,
      editTracking,
      lifecycle,
      generation,
    );
    const completion = operation.then(async (result) => {
      await result?.completion;
    });
    const activeDocumentEditSeen = operation.then(async (result) => {
      await result?.completion;
      return result?.originStream?.activeDocumentEditSeen ?? false;
    });
    const created: InFlightRequest = {
      generation,
      documentUri: current.uri,
      documentText: current.text,
      requestId,
      editTracking,
      cancelCleanup: () => this.disposeEditTracking(editTracking),
      metadata,
      source,
      promise: operation.then((result) => result?.suggestion),
      completion,
      activeDocumentEditSeen,
      attachmentCompletion: completion,
      lifecycle,
      dependents: 0,
      settled: false,
    };
    if (generation === this.generation) {
      this.inFlight = created;
    } else {
      this.detachedInFlight.add(created);
    }
    const cleanup = (): void => {
      created.settled = true;
      if (this.inFlight === created) {
        this.inFlight = undefined;
      }
      this.detachedInFlight.delete(created);
      created.source.dispose();
      this.disposeEditTracking(created.editTracking);
    };
    void created.completion.then(cleanup, cleanup);
    return this.awaitInFlightRequest(
      created,
      input,
      token,
      enforceCacheDelay,
      false,
    );
  }

  private async prepareFreshRequest(
    input: CompletionAlgorithmInput,
    current: NesDocumentContext,
    cursorOffset: number,
    shouldExpandEditWindow: boolean,
    requestId: string,
    token: vscode.CancellationToken,
    metadata: InFlightRequest["metadata"],
    editTracking: NesRequestEditTracking,
    lifecycle: ConsumerRequestLifecycle,
    generation: NesRequestGeneration,
  ): Promise<NesFetchOperation | undefined> {
    const delaySession = this.userInteractionMonitor.createDelaySession(
      this.config.nextEdit.debounceUseCoreRequestTime
        ? input.context.requestIssuedDateTime
        : undefined,
    );
    this.userInteractionMonitor.configureDelayForRequest(
      delaySession,
      this.strategy,
      textAfterOffsetOnLine(current.text, cursorOffset),
      false,
    );
    const workspaceContext = await this.workspace.gatherContext(
      input.document,
      token,
      cursorOffset,
      {
        target: "nes",
        timeoutEndMs: this.now() + delaySession.getDebounceTime(),
        includeLanguageContext: determineNesLanguageContextOptions(
          current.languageId,
          this.config,
        ).enabled,
        ...(input.context.requestUuid
          ? {
              completionId: input.context.requestUuid,
              opportunityId: input.context.requestUuid,
            }
          : {}),
      },
    );
    if (token.isCancellationRequested) {
      return undefined;
    }
    const promptContext = toPromptContext(
      {
        ...workspaceContext,
        current: { ...workspaceContext.current, ...current },
      },
      cursorOffset,
      selectedCompletionText(input.context),
    );
    if (workspaceContext.ignored) {
      return undefined;
    }
    const liveSource = this.findOpenDocument(current.uri);
    const sourceTrackedThroughPreparation =
      this.config.nextEdit.asyncCompletions &&
      liveSource?.getText() === editTracking.currentSourceText;
    if (
      !this.documentsAreCurrent([current]) &&
      !sourceTrackedThroughPreparation
    ) {
      if (generation === this.generation) {
        this.lastCursorPrediction = {
          outcome: "document-changed",
          reason: "during-context-gathering",
        };
      }
      return undefined;
    }
    let prompt: NesPromptBuildResult;
    const { aggressivenessLevel } =
      this.userInteractionMonitor.getAggressivenessLevel();
    try {
      prompt = buildOfficialNesPrompt(
        promptContext,
        this.strategy,
        this.config,
        shouldExpandEditWindow
          ? {
              linesBelowEditWindow:
                this.config.nextEdit.autoExpandEditWindowLines,
              aggressivenessLevel,
            }
          : { aggressivenessLevel },
      );
    } catch (error) {
      if (error instanceof NesPromptTooLargeError) {
        return undefined;
      }
      throw error;
    }
    metadata.editWindow = {
      startOffset: prompt.editWindow.startOffset,
      endOffset: prompt.editWindow.endOffset,
    };
    return this.fetch(
      promptContext,
      this.strategy,
      this.modelReference,
      requestId,
      token,
      false,
      delaySession,
      false,
      true,
      [current],
      prompt,
      editTracking,
      metadata,
      undefined,
      lifecycle,
      generation,
    );
  }

  private createFreshEditTracking(
    current: NesDocumentContext,
    source: vscode.CancellationTokenSource,
  ): NesRequestEditTracking {
    const tracking: NesRequestEditTracking = {
      sourceUri: current.uri,
      sourceText: current.text,
      documentGuards: [current],
      intermediateUserEdit: NesStringEdit.empty,
      currentSourceText: current.text,
      disposed: false,
    };
    if (!this.config.nextEdit.asyncCompletions) return tracking;
    tracking.subscription = vscode.workspace.onDidChangeTextDocument(
      (event) => {
        const changedUri = event.document.uri.toString();
        if (changedUri === tracking.sourceUri) {
          const incrementalEdit = stringEditForDocumentChange(event);
          if (incrementalEdit.isEmpty()) return;
          if (tracking.intermediateUserEdit === undefined) return;
          const composed =
            tracking.intermediateUserEdit.compose(incrementalEdit);
          tracking.currentSourceText = event.document.getText();
          if (
            composed.apply(tracking.sourceText) === tracking.currentSourceText
          ) {
            tracking.intermediateUserEdit = composed;
          } else {
            tracking.intermediateUserEdit = undefined;
          }
          return;
        }
      },
    );
    return tracking;
  }

  private async awaitSpeculativeRequest(
    request: PendingSpeculativeOperation,
    current: NesDocumentContext,
    input: CompletionAlgorithmInput,
    token: vscode.CancellationToken,
    enforceCacheDelay: boolean,
  ): Promise<NesBranchSuggestion | undefined> {
    this.attachRequestConsumer(request, token);
    const operation = await request.operation;
    if (token.isCancellationRequested) return undefined;
    const edit = operation.suggestion.edit;
    if (!edit) return undefined;
    if (token.isCancellationRequested) return undefined;
    const callerRequestId = input.context.requestUuid || randomUUID();
    const suggestion = this.trackSuggestion(
      {
        ...operation.suggestion,
        requestId: callerRequestId,
        sourceRequestId: callerRequestId,
        edit,
        fromCache: false,
        speculative: true,
        sourceIsSpeculative: false,
        documentGuards: [current],
      },
      request.generation,
    );
    if (this.isSuggestionRejected(suggestion, request.generation.cache)) {
      return undefined;
    }
    return (await this.enforceMinimumDelay(
      suggestion,
      input.context.requestIssuedDateTime,
      enforceCacheDelay,
      token,
    ))
      ? suggestion
      : undefined;
  }

  private attachRequestConsumer(
    request: ConsumerAttachedRequest,
    token: vscode.CancellationToken,
  ): void {
    if (request.cancellationTimer !== undefined) {
      clearTimeout(request.cancellationTimer);
      request.cancellationTimer = undefined;
    }
    request.dependents += 1;
    let attached = true;
    const detach = (cancelled: boolean): void => {
      if (!attached) return;
      attached = false;
      request.dependents = Math.max(0, request.dependents - 1);
      if (cancelled && request.dependents === 0 && !request.settled) {
        if (!request.lifecycle.transportStarted) {
          this.cancelAttachedRequest(request);
          return;
        }
        request.cancellationTimer ??= setTimeout(() => {
          request.cancellationTimer = undefined;
          if (request.dependents === 0 && !request.settled) {
            this.cancelAttachedRequest(request);
          }
        }, DETACHED_REQUEST_CANCELLATION_GRACE_MS);
      }
    };
    const cancellationSubscription = token.onCancellationRequested(() =>
      detach(true),
    );
    const releaseOnCompletion = (): void => {
      request.settled = true;
      if (request.cancellationTimer !== undefined) {
        clearTimeout(request.cancellationTimer);
        request.cancellationTimer = undefined;
      }
      cancellationSubscription.dispose();
      detach(false);
    };
    void request.attachmentCompletion.then(
      releaseOnCompletion,
      releaseOnCompletion,
    );
    if (token.isCancellationRequested) {
      detach(true);
    }
  }

  private cancelAttachedRequest(request: ConsumerAttachedRequest): void {
    if (request.cancellationTimer !== undefined) {
      clearTimeout(request.cancellationTimer);
      request.cancellationTimer = undefined;
    }
    request.cancelCleanup?.();
    request.source.cancel();
  }

  private disposeEditTracking(tracking: NesRequestEditTracking): void {
    if (tracking.disposed) return;
    tracking.disposed = true;
    tracking.subscription?.dispose();
  }

  private hasUserTypedSinceRequestStarted(
    tracking: NesRequestEditTracking,
  ): boolean {
    return hasUserTypedSinceNesRequestStarted(tracking.intermediateUserEdit);
  }

  private cursorOffsetAtLineIndent(text: string, lineNumber: number): number {
    let lineStart = 0;
    for (let line = 0; line < lineNumber; line += 1) {
      const lineEnd = text.indexOf("\n", lineStart);
      if (lineEnd === -1) return text.length;
      lineStart = lineEnd + 1;
    }
    const lineEnd = text.indexOf("\n", lineStart);
    const lineText = text.slice(
      lineStart,
      lineEnd === -1 ? text.length : lineEnd,
    );
    return lineStart + (lineText.match(/^\s*/)?.[0].length ?? 0);
  }

  private async awaitInFlightRequest(
    request: InFlightRequest,
    input: CompletionAlgorithmInput,
    token: vscode.CancellationToken,
    enforceCacheDelay: boolean,
    joined: boolean,
  ): Promise<NesBranchSuggestion | undefined> {
    this.attachRequestConsumer(request, token);
    if (joined) {
      await request.completion;
      if (!(await request.activeDocumentEditSeen)) {
        return undefined;
      }
    }
    const suggestion = await request.promise;
    if (!suggestion || token.isCancellationRequested) {
      return undefined;
    }
    if (
      !joined &&
      suggestion.edit?.uri === request.documentUri &&
      this.findOpenDocument(request.documentUri)?.getText() !==
        request.documentText
    ) {
      return undefined;
    }
    const callerRequestId = input.context.requestUuid || randomUUID();
    const callerSuggestion = this.trackSuggestion(
      {
        ...suggestion,
        requestId: callerRequestId,
        sourceRequestId: callerRequestId,
      },
      request.generation,
    );
    if (
      this.isSuggestionRejected(callerSuggestion, request.generation.cache)
    ) {
      return undefined;
    }
    return (await this.enforceMinimumDelay(
      callerSuggestion,
      input.context.requestIssuedDateTime,
      enforceCacheDelay,
      token,
    ))
      ? callerSuggestion
      : undefined;
  }

  private async rebaseChangedInFlightRequest(
    request: InFlightRequest,
    current: NesDocumentContext,
    cursorOffset: number,
    input: CompletionAlgorithmInput,
    token: vscode.CancellationToken,
    enforceCacheDelay: boolean,
  ): Promise<NesBranchSuggestion | undefined> {
    this.attachRequestConsumer(request, token);
    await request.completion;
    const sourceSuggestion = await request.promise;
    if (!sourceSuggestion?.edit || token.isCancellationRequested) {
      return undefined;
    }
    const cacheEntry = sourceSuggestion.cacheEntry;
    const originalEdit = cacheEntry?.edits[0] ?? sourceSuggestion.edit;
    const ownerUri = cacheEntry?.documentUri ?? originalEdit.uri;
    if (
      originalEdit.uri !== ownerUri ||
      (ownerUri !== request.documentUri && current.uri !== ownerUri)
    ) {
      return undefined;
    }
    let documentBeforeEdit: string;
    let userEdit: NesStringEdit;
    if (ownerUri === request.documentUri) {
      const trackedUserEdit = request.editTracking.intermediateUserEdit;
      if (
        trackedUserEdit === undefined ||
        trackedUserEdit.apply(request.documentText) !== current.text
      ) {
        return undefined;
      }
      documentBeforeEdit = request.documentText;
      userEdit = trackedUserEdit;
    } else {
      if (!cacheEntry) return undefined;
      documentBeforeEdit = cacheEntry.documentText;
      userEdit =
        cacheEntry.userEditSince ??
        NesStringEdit.fromDiff(documentBeforeEdit, current.text);
      if (userEdit.apply(documentBeforeEdit) !== current.text) {
        return undefined;
      }
    }
    const targetDocument = this.findOpenDocument(ownerUri);
    if (!targetDocument || targetDocument.getText() !== current.text) {
      return undefined;
    }
    const editWindow = cacheEntry?.editWindow ??
      (ownerUri === request.documentUri
        ? (request.metadata.originalEditWindow ?? request.metadata.editWindow)
        : request.metadata.editWindow) ?? {
        startOffset: 0,
        endOffset: documentBeforeEdit.length,
      };
    const rebased = tryRebaseNesEdits(
      documentBeforeEdit,
      {
        start: editWindow.startOffset,
        endOffset: editWindow.endOffset,
      },
      [originalEdit],
      userEdit,
      current.text,
      cursorOffset,
      "strict",
      {
        absorbSubsequenceTyping: this.config.nextEdit.absorbSubsequenceTyping,
        reverseAgreement: this.config.nextEdit.reverseAgreement,
        maxImperfectAgreementLength:
          this.config.nextEdit.maxImperfectAgreementLength,
      },
    );
    const edit = rebased.kind === "success" ? rebased.edits[0] : undefined;
    if (!edit) return undefined;
    const callerRequestId = input.context.requestUuid || randomUUID();
    const suggestion = this.trackSuggestion(
      {
        ...sourceSuggestion,
        requestId: callerRequestId,
        sourceRequestId: callerRequestId,
        edit,
        rebased: sourceSuggestion.rebased || !userEdit.isEmpty(),
        documentGuards: [this.workspace.snapshot(targetDocument)],
      },
      request.generation,
    );
    if (this.isSuggestionRejected(suggestion, request.generation.cache)) {
      return undefined;
    }
    return (await this.enforceMinimumDelay(
      suggestion,
      input.context.requestIssuedDateTime,
      enforceCacheDelay,
      token,
    ))
      ? suggestion
      : undefined;
  }

  private async fetch(
    promptContext: NesPromptContext,
    strategy: NesPromptStrategy,
    modelReference: CompletionModelReference,
    requestId: string,
    token: vscode.CancellationToken,
    speculative: boolean,
    delaySession: NesDelaySession,
    skipDebounce: boolean,
    allowCursorPrediction = !speculative,
    documentGuards: readonly NesDocumentContext[] = speculative
      ? []
      : [promptContext.current],
    builtPrompt?: NesPromptBuildResult,
    requestEditTracking?: NesRequestEditTracking,
    requestMetadata?: InFlightRequest["metadata"],
    activeCacheContext?: NesActiveCacheContext,
    lifecycle?: ConsumerRequestLifecycle,
    generation: NesRequestGeneration = this.generation,
  ): Promise<NesFetchOperation> {
    if (
      allowCursorPrediction &&
      !speculative &&
      generation === this.generation
    ) {
      this.lastCursorPrediction = undefined;
    }
    if (!skipDebounce) {
      const delayMs = delaySession.getDebounceTime();
      if (!(await delay(delayMs, token))) {
        return this.completedOperation(
          this.emptySuggestion(requestId, speculative, generation),
        );
      }
    }
    const prompt =
      builtPrompt ??
      buildOfficialNesPrompt(promptContext, strategy, this.config, {
        aggressivenessLevel:
          this.userInteractionMonitor.getAggressivenessLevel()
            .aggressivenessLevel,
      });
    const cacheNoSuggestionsForRequest = (): void =>
      this.cacheNoSuggestions(
        generation.cache,
        promptContext,
        prompt,
        requestId,
        activeCacheContext?.documentUri,
        activeCacheContext?.cursorOffset,
      );
    let model: CompletionModel;
    try {
      const eligibility =
        await this.algorithmContext.modelResolver.evaluateModelForRequest?.(
          modelReference,
          'copilot-replica/nes',
        );
      if (eligibility && !eligibility.eligible) {
        this.algorithmContext.reportConfigurationError(
          `nes-model:${eligibility.code ?? 'model-ineligible'}:${modelReference.vendor}:${modelReference.id}`,
          eligibility.message ?? t("The selected NES model is unavailable."),
        );
        return this.completedOperation(
          this.emptySuggestion(requestId, speculative, generation, prompt),
        );
      }
      model = await this.algorithmContext.modelResolver.resolveCompletionModel(
        modelReference,
        token,
      );
    } catch (error) {
      this.algorithmContext.reportConfigurationError(
        `nes-model:${modelReference.vendor}:${modelReference.id}`,
        error instanceof Error ? error.message : String(error),
      );
      return this.completedOperation(
        this.emptySuggestion(requestId, speculative, generation, prompt),
      );
    }
    if (token.isCancellationRequested) {
      return this.completedOperation(
        this.emptySuggestion(requestId, speculative, generation, prompt),
      );
    }
    const transportSource = new LinkedCancellationTokenSource(token);
    const ownsEditTracking = requestEditTracking === undefined;
    const editTracking: NesRequestEditTracking = requestEditTracking ?? {
      sourceUri: promptContext.current.uri,
      sourceText: promptContext.current.text,
      documentGuards: [...documentGuards],
      intermediateUserEdit: NesStringEdit.empty,
      currentSourceText: promptContext.current.text,
      disposed: false,
    };
    for (const guard of documentGuards) {
      if (
        !editTracking.documentGuards.some(
          (candidate) => candidate.uri === guard.uri,
        )
      ) {
        editTracking.documentGuards.push(guard);
      }
    }
    let responseDiverged = false;
    const staticGuardsAreCurrent = (): boolean =>
      speculative ||
      editTracking.documentGuards
        .filter((guard) => guard.uri !== editTracking.sourceUri)
        .every((guard) => this.documentsAreCurrent([guard]));
    const changeSubscription =
      ownsEditTracking && !speculative && this.config.nextEdit.asyncCompletions
        ? vscode.workspace.onDidChangeTextDocument((event) => {
            const changedUri = event.document.uri.toString();
            if (!speculative && changedUri === editTracking.sourceUri) {
              const incrementalEdit = stringEditForDocumentChange(event);
              if (incrementalEdit.isEmpty()) return;
              if (editTracking.intermediateUserEdit === undefined) return;
              const composed =
                editTracking.intermediateUserEdit.compose(incrementalEdit);
              editTracking.currentSourceText = event.document.getText();
              if (
                composed.apply(editTracking.sourceText) ===
                editTracking.currentSourceText
              ) {
                editTracking.intermediateUserEdit = composed;
              } else {
                editTracking.intermediateUserEdit = undefined;
              }
              return;
            }
          })
        : undefined;
    const disposeTransport = (): void => {
      changeSubscription?.dispose();
      transportSource.dispose();
    };
    let response: CopilotReplicaAlgorithmNesResponse;
    try {
      const modelRequest = createModelRequest(
        prompt,
        this.config.nextEdit.usePrediction,
        this.config.nextEdit.responseFormatByStrategy[strategy],
      );
      if (lifecycle) {
        lifecycle.transportStarted = true;
      }
      response = await model.complete(
        modelRequest,
        transportSource.token,
      );
    } catch (error) {
      disposeTransport();
      throw error;
    }
    const divergenceIntermediateEdit = editTracking.intermediateUserEdit;
    const stream = streamOfficialNesResponse(
      response.text,
      strategy,
      prompt,
      promptContext.current,
      promptContext.recentDocuments,
      {
        responseFormat: this.config.nextEdit.responseFormatByStrategy[strategy],
        beforeFirstEditWindowCandidate: async () => {
          const artificialDelay = delaySession.getArtificialDelay();
          if (artificialDelay <= 0) {
            return true;
          }
          await delayWithoutCancellation(artificialDelay);
          const completed = !token.isCancellationRequested;
          if (!completed) {
            responseDiverged = true;
          }
          return completed;
        },
        aggressivenessLevel: prompt.aggressivenessLevel,
        filters: {
          substrings: this.config.nextEdit.filterSubstrings,
          undoInsertionFiltering: this.config.nextEdit.undoInsertionFiltering,
          relatedDocuments: promptContext.recentDocuments,
          allowWhitespaceOnlyChanges:
            this.config.nextEdit.allowWhitespaceOnlyChanges,
          filterNotebookCellMarkers:
            vscode.Uri.parse(promptContext.current.uri).scheme ===
            "vscode-notebook-cell",
        },
        history: promptContext.editHistory,
        checkModelLine:
          !speculative &&
          this.config.nextEdit.earlyDivergenceCancellation !== "off"
            ? (localLineIndex, modelLine) => {
                const intermediateEdit = divergenceIntermediateEdit;
                return (
                  intermediateEdit === undefined ||
                  intermediateEdit.isEmpty() ||
                  isIntermediateModelLineCompatible({
                    mode: this.config.nextEdit.earlyDivergenceCancellation as
                      "cursor" | "editWindow",
                    localLineIndex,
                    cursorLineIndex: Math.max(
                      0,
                      prompt.editWindow.cursorLineOffset -
                        prompt.editWindow.startLine,
                    ),
                    editWindowStartLine: prompt.editWindow.startLine,
                    editWindowLines: prompt.editWindow.lines,
                    originalText: promptContext.current.text,
                    intermediateEdit,
                    modelLine,
                  })
                );
              }
            : undefined,
        getEarlyTerminationReason: () => {
          if (editTracking.documentChangeReason) {
            return editTracking.documentChangeReason;
          }
          return transportSource.token.isCancellationRequested
            ? "request cancelled while streaming"
            : undefined;
        },
        onEarlyDivergence: () => {
          responseDiverged = true;
          transportSource.cancel();
        },
      },
    );
    const modelStateByDocument = new Map<
      string,
      {
        readonly baseText: string;
        editsSoFar: NesStringEdit;
      }
    >();
    const toSequentialModelEdit = (
      candidate: NesTextEdit,
    ):
      | {
          readonly edit: NesTextEdit;
          readonly documentBeforeEdit: string;
        }
      | undefined => {
      const baseText = this.documentTextForEdit(promptContext, candidate);
      if (baseText === undefined) return undefined;
      const state = modelStateByDocument.get(candidate.uri) ?? {
        baseText,
        editsSoFar: NesStringEdit.empty,
      };
      modelStateByDocument.set(candidate.uri, state);
      const documentBeforeEdit = state.editsSoFar.apply(state.baseText);
      const rebased = NesStringEdit.single(
        new NesStringReplacement(
          {
            start: candidate.startOffset,
            endOffset: candidate.endOffset,
          },
          candidate.newText,
        ),
      ).tryRebase(state.editsSoFar);
      if (!rebased) return undefined;
      state.editsSoFar = state.editsSoFar.compose(rebased);
      if (rebased.replacements.length !== 1) return undefined;
      const replacement = rebased.replacements[0];
      return {
        edit: {
          ...candidate,
          startOffset: replacement.range.start,
          endOffset: replacement.range.endOffset,
          newText: replacement.newText,
          kind:
            replacement.range.start === replacement.range.endOffset
              ? "insert"
              : "replace",
        },
        documentBeforeEdit,
      };
    };
    let yieldedModelCandidate = false;
    let providerCandidateCount = 0;
    const originStream: OriginStreamState = {
      requestId,
      done: false,
      activeDocumentEditSeen: false,
    };
    const activeDocumentUri =
      activeCacheContext?.documentUri ?? editTracking.sourceUri;
    const nextUsableEdit = async (): Promise<StreamedCandidateResult> => {
      let next = await stream.next();
      while (!next.done) {
        yieldedModelCandidate = true;
        const candidateN = providerCandidateCount;
        if (providerCandidateCount > 0) {
          if (generation === this.generation) {
            this.speculativeState.clearScheduled(requestId);
          }
        }
        providerCandidateCount += 1;
        if (!speculative && generation === this.generation) {
          this.shouldExpandEditWindow = false;
        }
        const sequential = toSequentialModelEdit(next.value);
        if (!sequential) {
          return { done: false, value: undefined };
        }
        const originalCandidate = sequential.edit;
        const currentCandidate = originalCandidate;
        const targetText = sequential.documentBeforeEdit;
        if (
          currentCandidate.kind !== "cursorJump" &&
          targetText !== undefined
        ) {
          if (currentCandidate.uri === activeDocumentUri) {
            originStream.activeDocumentEditSeen = true;
          }
          return {
            done: false,
            value: {
              original: originalCandidate,
              current: currentCandidate,
              documentBeforeEdit: sequential.documentBeforeEdit,
              subsequentN: candidateN,
            },
          };
        }
        return { done: false, value: undefined };
      }
      return { done: true, value: next.value };
    };
    let first: StreamedCandidateResult;
    try {
      first = await nextUsableEdit();
      while (speculative && !first.done && !first.value) {
        first = await nextUsableEdit();
      }
    } catch (error) {
      disposeTransport();
      if (transportSource.token.isCancellationRequested) {
        return this.completedOperation(
          this.emptySuggestion(requestId, speculative, generation, prompt),
        );
      }
      throw error;
    }
    const sourceTrackingIsInconsistent =
      !speculative &&
      editTracking.intermediateUserEdit === undefined &&
      editTracking.currentSourceText !== editTracking.sourceText;
    const completionResult = first.done ? first.value : undefined;
    const recordNoSuggestions = (): void => {
      if (generation === this.generation) {
        this.shouldExpandEditWindow = false;
      }
    };
    if (
      first.done ||
      transportSource.token.isCancellationRequested ||
      !staticGuardsAreCurrent()
    ) {
      disposeTransport();
      if (
        editTracking.documentChangeReason &&
        generation === this.generation
      ) {
        this.lastCursorPrediction = {
          outcome: "document-changed",
          reason: editTracking.documentChangeReason,
        };
      }
      const suggestion = this.emptySuggestion(
        requestId,
        speculative,
        generation,
        prompt,
      );
      if (completionResult?.editIntentFilteredOut === true) {
        return this.completedOperation(suggestion);
      }
      if (
        speculative ||
        !allowCursorPrediction ||
        this.config.nextEdit.cursorPrediction.mode !== "onlyWithEdit" ||
        token.isCancellationRequested ||
        editTracking.documentChangeReason !== undefined ||
        responseDiverged
      ) {
        if (
          !speculative &&
          !yieldedModelCandidate &&
          !token.isCancellationRequested &&
          editTracking.documentChangeReason === undefined &&
          !responseDiverged
        ) {
          recordNoSuggestions();
          cacheNoSuggestionsForRequest();
        }
        return this.completedOperation(suggestion);
      }
      const retry = await this.retryFromCursorPrediction(
        promptContext,
        prompt,
        strategy,
        modelReference,
        requestId,
        token,
        documentGuards,
        delaySession,
        editTracking,
        requestMetadata,
        generation,
      );
      if (retry.kind === "operation") {
        if (
          retry.operation.suggestion.cursorJump &&
          !retry.operation.suggestion.edit
        ) {
          recordNoSuggestions();
          cacheNoSuggestionsForRequest();
        }
        return retry.operation;
      }
      if (retry.kind === "noSuggestions" && !yieldedModelCandidate) {
        recordNoSuggestions();
        cacheNoSuggestionsForRequest();
      }
      return this.completedOperation(suggestion);
    }
    const finalIntermediateUserEdit =
      editTracking.intermediateUserEdit ?? NesStringEdit.empty;
    const cacheEditTracking = activeCacheContext?.editTracking ?? editTracking;
    const cacheCreatedAt = this.now();
    let didCacheCrossFileActiveAlias = false;
    const cacheActiveDocumentUri =
      activeCacheContext?.documentUri ?? promptContext.current.uri;
    const cacheActiveDocumentText =
      activeCacheContext?.documentText ?? promptContext.current.text;
    const cacheActiveCursorOffset =
      activeCacheContext?.cursorOffset ?? promptContext.cursorOffset;
    const streamedCacheContext = () => ({
      activeDocumentUri: cacheActiveDocumentUri,
      activeDocumentText: cacheActiveDocumentText,
      activeDocumentIsOpen:
        this.findOpenDocument(cacheActiveDocumentUri) !== undefined,
      firstEditWindow: {
        startOffset: prompt.editWindow.startOffset,
        endOffset: prompt.editWindow.endOffset,
      },
      ...(requestMetadata?.originalEditWindow
        ? { firstOriginalEditWindow: requestMetadata.originalEditWindow }
        : {}),
      activeCursorOffset: cacheActiveCursorOffset,
      requestId,
      createdAt: cacheCreatedAt,
      source: "llm" as const,
      speculative,
      ...(!speculative && cacheEditTracking.intermediateUserEdit !== undefined
        ? { userEditSince: cacheEditTracking.intermediateUserEdit }
        : {}),
    });
    const cacheStreamCandidate = (
      candidate: StreamedCandidate,
      bundledEntry?: NesCacheEntry,
    ) => {
      const result = generation.cache.putStreamedEdit(streamedCacheContext(), {
        edit: candidate.original,
        documentBeforeEdit: candidate.documentBeforeEdit,
        currentTargetDocumentText: this.findOpenDocument(
          candidate.original.uri,
        )?.getText(),
        subsequentN: candidate.subsequentN,
        ...(bundledEntry ? { bundledEntry } : {}),
      });
      didCacheCrossFileActiveAlias ||= result.activeAliasAttempted;
      return result;
    };
    const completeStream = (bundledEntry?: NesCacheEntry): Promise<void> =>
      (async (): Promise<void> => {
        try {
          let next = await nextUsableEdit();
          while (!next.done) {
            if (
              transportSource.token.isCancellationRequested ||
              !staticGuardsAreCurrent()
            ) {
              transportSource.cancel();
              return;
            }
            if (next.value) {
              cacheStreamCandidate(next.value, bundledEntry);
            }
            next = await nextUsableEdit();
          }
          if (
            !speculative &&
            !originStream.activeDocumentEditSeen &&
            !didCacheCrossFileActiveAlias &&
            !transportSource.token.isCancellationRequested &&
            editTracking.documentChangeReason === undefined &&
            !responseDiverged &&
            next.value?.editIntentFilteredOut !== true
          ) {
            cacheNoSuggestionsForRequest();
          }
        } catch (error) {
          if (!transportSource.token.isCancellationRequested) {
            responseDiverged = true;
          }
        } finally {
          originStream.done = true;
          disposeTransport();
          const scheduled =
            generation === this.generation
              ? this.speculativeState.consumeScheduled(requestId)
              : undefined;
          if (scheduled) {
            this.triggerSpeculative(scheduled.suggestion);
          }
        }
      })();
    if (!first.value) {
      return {
        suggestion: this.emptySuggestion(
          requestId,
          speculative,
          generation,
          prompt,
        ),
        completion: completeStream(),
        originStream,
      };
    }
    let settledCandidate = first.value;
    let firstCacheResult = cacheStreamCandidate(settledCandidate);
    while (speculative && !firstCacheResult.targetEntry) {
      const next = await nextUsableEdit();
      if (next.done) {
        originStream.done = true;
        disposeTransport();
        return {
          suggestion: this.emptySuggestion(requestId, true, generation, prompt),
          completion: Promise.resolve(),
          originStream,
        };
      }
      if (!next.value) continue;
      settledCandidate = next.value;
      firstCacheResult = cacheStreamCandidate(settledCandidate);
    }
    const entry = firstCacheResult.targetEntry;
    if (!entry) {
      return {
        suggestion: this.emptySuggestion(
          requestId,
          speculative,
          generation,
          prompt,
        ),
        completion: completeStream(firstCacheResult.bundledEntry),
        originStream,
      };
    }
    const edit = settledCandidate.current;
    const bundledEntry = firstCacheResult.bundledEntry;
    const sourceDocument = this.findOpenDocument(promptContext.current.uri);
    const currentContext =
      !speculative &&
      editTracking.intermediateUserEdit !== undefined &&
      !editTracking.intermediateUserEdit.isEmpty() &&
      sourceDocument &&
      sourceDocument.getText() !== promptContext.current.text
        ? {
            ...promptContext,
            current: this.workspace.snapshot(sourceDocument),
            cursorOffset: this.cursorOffsetForDocument(
              sourceDocument,
              finalIntermediateUserEdit.applyToOffset(
                promptContext.cursorOffset,
              ),
            ),
          }
        : promptContext;
    const speculativeTarget = this.speculativeContextForEdit(
      currentContext,
      edit,
    )?.current;
    const trackedSourceDocument = this.findOpenDocument(editTracking.sourceUri);
    const suggestionGuards = speculative
      ? []
      : sourceTrackingIsInconsistent
        ? edit.uri === editTracking.sourceUri
          ? [promptContext.current]
          : []
        : trackedSourceDocument
          ? [this.workspace.snapshot(trackedSourceDocument)]
          : [promptContext.current];
    const suggestion = this.trackSuggestion({
      branch: "nes",
      source: "llm",
      requestId: entry.requestId,
      sourceRequestId: entry.requestId,
      edit,
      prompt,
      cacheEntry: entry,
      fromCache: false,
      rebased:
        edit.uri === editTracking.sourceUri &&
        !finalIntermediateUserEdit.isEmpty(),
      subsequent: entry.subsequentN > 0,
      speculative,
      sourceIsSpeculative: speculative,
      createdAt: this.now(),
      documentGuards: suggestionGuards,
      ...(speculativeTarget
        ? {
            seed: {
              generation,
              targetBeforeEdit: speculativeTarget,
              edit,
              strategy,
              modelReference,
              originStream,
            },
          }
        : {}),
    }, generation);
    const completion = completeStream(bundledEntry);
    return { suggestion, completion, originStream };
  }

  private async retryFromCursorPrediction(
    sourceContext: NesPromptContext,
    sourcePrompt: NesPromptBuildResult,
    strategy: NesPromptStrategy,
    modelReference: CompletionModelReference,
    requestId: string,
    token: vscode.CancellationToken,
    documentGuards: readonly NesDocumentContext[],
    delaySession: NesDelaySession,
    editTracking: NesRequestEditTracking,
    requestMetadata?: InFlightRequest["metadata"],
    generation: NesRequestGeneration = this.generation,
  ): Promise<NesCursorRetryResult> {
    const cursorModelGeneration = this.cursorPredictionModelGeneration;
    const recordCursorPrediction = (
      state: NesCursorPredictionDebugState,
    ): void => {
      if (
        cursorModelGeneration === this.cursorPredictionModelGeneration &&
        generation === this.generation
      ) {
        this.lastCursorPrediction = state;
      }
    };
    if (this.cursorPredictionDisabled) {
      recordCursorPrediction({
        outcome: "disabled",
        reason: "session-disabled",
      });
      return { kind: "noSuggestions" };
    }
    let cursorModel: CompletionModel | undefined;
    let cursorModelCapabilities: CompletionModelCapabilities | undefined;
    try {
      cursorModel = await this.resolveCursorPredictionModel(token);
      cursorModelCapabilities = await cursorModel?.getCapabilities();
    } catch (error) {
      if (token.isCancellationRequested) {
        return { kind: "cancelled" };
      }
      recordCursorPrediction({
        outcome: "request-failed",
        reason: error instanceof Error ? error.message : String(error),
      });
      if (error instanceof CompletionConfigurationError) {
        this.algorithmContext.reportConfigurationError(
          `cursor-model:${error.code}:${this.cursorPredictionModelReference.vendor}:${this.cursorPredictionModelReference.id}`,
          error.message,
        );
      } else {
        this.algorithmContext.reportRuntimeError?.(
          "cursor-prediction",
          "Cursor prediction model resolution failed",
          error,
        );
      }
      return { kind: "noSuggestions" };
    }
    if (!cursorModel || token.isCancellationRequested) {
      if (!token.isCancellationRequested) {
        recordCursorPrediction({
          outcome: "model-unavailable",
          reason: `${this.cursorPredictionModelReference.vendor}/${this.cursorPredictionModelReference.id}`,
        });
      }
      return {
        kind: token.isCancellationRequested ? "cancelled" : "noSuggestions",
      };
    }
    if (!cursorModelCapabilities?.supportsNextCursorLinePrediction) {
      recordCursorPrediction({
        outcome: "disabled",
        reason: "cursor-model-capability",
      });
      return { kind: "noSuggestions" };
    }
    if (this.hasUserTypedSinceRequestStarted(editTracking)) {
      recordCursorPrediction({
        outcome: "document-changed",
        reason: "before-cursor-request",
      });
      return { kind: "cancelled" };
    }
    const cursorPromptResult = buildCursorPredictionPrompt(
      sourceContext,
      sourcePrompt,
      {
        maxCurrentFileTokens:
          this.config.nextEdit.cursorPrediction.currentFileMaxTokens,
        behaviorConfig: this.config,
      },
    );
    if (!cursorPromptResult.ok) {
      recordCursorPrediction({
        outcome: "prompt-failed",
        reason: cursorPromptResult.reason,
      });
      return { kind: "noSuggestions" };
    }
    const maxResponseTokens = Math.max(
      this.config.nextEdit.cursorPrediction.maxResponseTokens,
      cursorModelCapabilities?.minimumCursorPredictionTokens ?? 0,
    );
    const cursorRequest = createCursorPredictionRequest(
      cursorPromptResult.prompt,
      maxResponseTokens,
    );
    let cursorText: string | undefined;
    try {
      const cursorResponse = await cursorModel.complete(cursorRequest, token);
      cursorText = await collectResponseText(cursorResponse.text, token);
    } catch (error) {
      if (token.isCancellationRequested) {
        return { kind: "cancelled" };
      }
      if (isLanguageModelNotFound(error)) {
        if (cursorModelGeneration === this.cursorPredictionModelGeneration) {
          this.cursorPredictionDisabled = true;
        }
        recordCursorPrediction({
          outcome: "disabled",
          reason: "model-not-found",
        });
        this.algorithmContext.reportConfigurationError(
          `cursor-model:completion-model-not-found:${this.cursorPredictionModelReference.vendor}:${this.cursorPredictionModelReference.id}`,
          t("The selected cursor prediction model is unavailable."),
        );
      } else {
        recordCursorPrediction({
          outcome: "request-failed",
          reason: error instanceof Error ? error.message : String(error),
        });
      }
      this.algorithmContext.reportRuntimeError?.(
        "cursor-prediction",
        "Cursor prediction request failed",
        error,
      );
      return {
        kind: "noSuggestions",
      };
    }
    if (cursorText === undefined) {
      return {
        kind: token.isCancellationRequested ? "cancelled" : "noSuggestions",
      };
    }
    if (token.isCancellationRequested) {
      return { kind: "cancelled" };
    }
    if (this.hasUserTypedSinceRequestStarted(editTracking)) {
      recordCursorPrediction({
        outcome: "document-changed",
        reason: "after-cursor-response",
      });
      return { kind: "cancelled" };
    }
    const parsed = parseCursorPredictionResponse(
      cursorText,
      cursorPromptResult.prompt.keptRange,
    );
    if (!parsed.ok) {
      recordCursorPrediction({
        outcome: "parse-failed",
        reason: parsed.reason,
      });
      return { kind: "noSuggestions" };
    }
    let target: NesCursorRetryTarget;
    if (parsed.prediction.kind === "sameFile") {
      const sameFileTarget = this.resolveSameFileCursorRetryTarget(
        sourceContext,
        sourcePrompt,
        parsed.prediction,
        recordCursorPrediction,
      );
      if (!sameFileTarget) {
        return { kind: "noSuggestions" };
      }
      target = sameFileTarget;
    } else {
      const crossFileUri = this.crossFileUri(
        sourceContext.current,
        parsed.prediction.filePath,
      );
      if (!crossFileUri) {
        recordCursorPrediction({
          outcome: "target-unavailable",
          reason: "crossFile:noWorkspaceRoot",
          lineNumber: parsed.prediction.lineNumber,
        });
        return { kind: "noSuggestions" };
      }
      const crossFileResolution = await runNesCrossFileOpenContinuation<
        vscode.TextDocument,
        NesCrossFileRetryResolution
      >({
        open: () => vscode.workspace.openTextDocument(crossFileUri),
        isCancellationRequested: () => token.isCancellationRequested,
        hasUserTypedSinceRequestStarted: () =>
          this.hasUserTypedSinceRequestStarted(editTracking),
        onOpenFailed: () => {
          recordCursorPrediction({
            outcome: "target-unavailable",
            reason: "crossFile:openFailed",
            targetUri: crossFileUri.toString(),
            lineNumber: parsed.prediction.lineNumber,
          });
          const cursorJump: NesCursorJumpSource = {
            kind: "differentFile",
            sourceUri: sourceContext.current.uri,
            targetUri: crossFileUri.toString(),
            lineNumber: parsed.prediction.lineNumber,
            fallbackOnly: true,
          };
          return {
            value: {
              kind: "operation",
              operation: this.completedOperation(
                this.trackSuggestion(
                  {
                    ...this.emptySuggestion(
                      requestId,
                      false,
                      generation,
                      sourcePrompt,
                    ),
                    cursorJump,
                    documentGuards,
                  },
                  generation,
                ),
              ),
            },
          };
        },
        onCancelled: (reason) => {
          if (reason === "afterCrossFileOpenTextDocumentUserTyped") {
            recordCursorPrediction({
              outcome: "document-changed",
              reason: "after-target-resolution",
            });
          }
          return { value: { kind: "cancelled" } };
        },
        onOpened: (crossFileDocument) => {
          if (
            parsed.prediction.lineNumber < 0 ||
            parsed.prediction.lineNumber >= crossFileDocument.lineCount
          ) {
            recordCursorPrediction({
              outcome: "out-of-bounds",
              reason: "crossFile:exceedsDocumentLines",
              targetUri: crossFileDocument.uri.toString(),
              lineNumber: parsed.prediction.lineNumber,
            });
            return { value: { kind: "noSuggestions" } };
          }
          return {
            value: {
              kind: "target",
              target: {
                document: crossFileDocument,
                snapshot: this.workspace.snapshot(crossFileDocument),
                lineNumber: parsed.prediction.lineNumber,
                cursorOffset: crossFileDocument.offsetAt(
                  new vscode.Position(parsed.prediction.lineNumber, 0),
                ),
              },
            },
          };
        },
      });
      if (crossFileResolution.value.kind !== "target") {
        return crossFileResolution.value;
      }
      target = crossFileResolution.value.target;
    }
    const targetGuard = target.snapshot;
    const retryEditWindow = computeNesEditWindow(
      targetGuard.text,
      target.cursorOffset,
      this.config,
      this.config.prompt.linesBelowEditWindow,
    );
    const sourceEditWindow = {
      startOffset: sourcePrompt.editWindow.startOffset,
      endOffset: sourcePrompt.editWindow.endOffset,
    };
    const retryMetadata: InFlightRequest["metadata"] = {
      editWindow: {
        startOffset: retryEditWindow.startOffset,
        endOffset: retryEditWindow.endOffset,
      },
      originalEditWindow: sourceEditWindow,
    };
    if (parsed.prediction.kind === "sameFile" && requestMetadata) {
      requestMetadata.originalEditWindow ??=
        requestMetadata.editWindow ?? sourceEditWindow;
      requestMetadata.editWindow = retryMetadata.editWindow;
    }
    let targetContext: NesPromptContext;
    if (target.document) {
      const targetWorkspace = await this.workspace.gatherContext(
        target.document,
        token,
        target.cursorOffset,
        {
          target: "nes",
          completionId: requestId,
          opportunityId: requestId,
          timeoutEndMs: this.now() + delaySession.getDebounceTime(),
          includeLanguageContext: determineNesLanguageContextOptions(
            targetGuard.languageId,
            this.config,
          ).enabled,
        },
      );
      if (token.isCancellationRequested) {
        return { kind: "cancelled" };
      }
      const enrichedTarget = toPromptContext(
        targetWorkspace,
        target.cursorOffset,
        undefined,
      );
      targetContext = {
        ...sourceContext,
        current: targetGuard,
        cursorOffset: target.cursorOffset,
        selectedCompletionText: undefined,
        recentDocuments:
          parsed.prediction.kind === "sameFile"
            ? sourceContext.recentDocuments
            : [],
        neighborSnippets: enrichedTarget.neighborSnippets,
        diagnostics: enrichedTarget.diagnostics,
        languageContext: enrichedTarget.languageContext,
        gitDiff: enrichedTarget.gitDiff,
      };
    } else {
      targetContext = {
        ...sourceContext,
        current: targetGuard,
        cursorOffset: target.cursorOffset,
        selectedCompletionText: undefined,
      };
    }
    const retryEditTracking: NesRequestEditTracking =
      parsed.prediction.kind === "sameFile"
        ? editTracking
        : {
            sourceUri: targetGuard.uri,
            sourceText: targetGuard.text,
            documentGuards: [],
            intermediateUserEdit: NesStringEdit.empty,
            currentSourceText: targetGuard.text,
            disposed: false,
          };
    const retry = await this.fetch(
      targetContext,
      strategy,
      modelReference,
      requestId,
      token,
      false,
      delaySession,
      true,
      false,
      [],
      undefined,
      retryEditTracking,
      retryMetadata,
      {
        documentUri: sourceContext.current.uri,
        documentText: sourceContext.current.text,
        cursorOffset: sourceContext.cursorOffset,
        editTracking,
      },
      undefined,
      generation,
    );
    const cursorJump: NesCursorJumpSource = {
      kind: parsed.prediction.kind,
      sourceUri: sourceContext.current.uri,
      targetUri: target.snapshot.uri,
      lineNumber: target.lineNumber,
    };
    if (!retry.suggestion.edit) {
      recordCursorPrediction({
        outcome: "retry-empty",
        targetUri: cursorJump.targetUri,
        lineNumber: cursorJump.lineNumber,
      });
      return { kind: "operation", operation: retry };
    }
    recordCursorPrediction({
      outcome: "retry-edit",
      targetUri: cursorJump.targetUri,
      lineNumber: cursorJump.lineNumber,
    });
    return {
      kind: "operation",
      operation: {
        ...retry,
        suggestion: {
          ...retry.suggestion,
          cursorJump,
        },
      },
    };
  }

  private async resolveCursorPredictionModel(
    token: vscode.CancellationToken,
  ): Promise<
    CompletionModel | undefined
  > {
    if (this.cursorPredictionModel) {
      return this.cursorPredictionModel;
    }
    if (!this.cursorPredictionModelResolution) {
      const generation = this.cursorPredictionModelGeneration;
      this.cursorPredictionModelResolution = (async () => {
        const eligibility =
          await this.algorithmContext.modelResolver.evaluateModelForRequest?.(
            this.cursorPredictionModelReference,
            'copilot-replica/cursor-prediction',
          );
        if (eligibility && !eligibility.eligible) {
          if (generation === this.cursorPredictionModelGeneration) {
            this.cursorPredictionDisabled = true;
          }
          this.algorithmContext.reportConfigurationError(
            `cursor-model:${eligibility.code ?? 'model-ineligible'}:${this.cursorPredictionModelReference.vendor}:${this.cursorPredictionModelReference.id}`,
            eligibility.message ??
              t("The selected cursor prediction model is unavailable."),
          );
          return undefined;
        }
        const model =
          await this.algorithmContext.modelResolver.resolveCompletionModel(
          this.cursorPredictionModelReference,
          token,
        );
        if (model && generation === this.cursorPredictionModelGeneration) {
          this.cursorPredictionModel = model;
        }
        return model;
      })();
    }
    const resolution = this.cursorPredictionModelResolution;
    try {
      return await resolution;
    } finally {
      if (
        this.cursorPredictionModelResolution === resolution &&
        !this.cursorPredictionModel
      ) {
        this.cursorPredictionModelResolution = undefined;
      }
    }
  }

  private resolveSameFileCursorRetryTarget(
    sourceContext: NesPromptContext,
    sourcePrompt: NesPromptBuildResult,
    prediction: Extract<CursorJumpPrediction, { readonly kind: "sameFile" }>,
    recordCursorPrediction: (state: NesCursorPredictionDebugState) => void,
  ): NesCursorRetryTarget | undefined {
    const decision = decideCursorPrediction(
      prediction,
      sourceContext.current.text.split(/\r?\n/).length,
      {
        start: sourcePrompt.editWindow.startLine,
        endExclusive: sourcePrompt.editWindow.endLineExclusive,
      },
    );
    if (decision.kind === "withinEditWindow") {
      recordCursorPrediction({
        outcome: "within-edit-window",
        reason: "withinEditWindow",
        targetUri: sourceContext.current.uri,
        lineNumber: prediction.lineNumber,
      });
      return undefined;
    }
    if (decision.kind === "outOfBounds") {
      recordCursorPrediction({
        outcome: "out-of-bounds",
        reason: decision.reason,
        targetUri: sourceContext.current.uri,
        lineNumber: prediction.lineNumber,
      });
      return undefined;
    }
    return {
      document: this.findOpenDocument(sourceContext.current.uri),
      snapshot: sourceContext.current,
      lineNumber: prediction.lineNumber,
      cursorOffset: this.cursorOffsetAtLineIndent(
        sourceContext.current.text,
        prediction.lineNumber,
      ),
    };
  }

  private crossFileUri(
    source: NesDocumentContext,
    filePath: string,
  ): vscode.Uri | undefined {
    if (/^[A-Za-z][A-Za-z\d+.-]*:\/\//.test(filePath)) {
      return vscode.Uri.parse(filePath);
    }
    if (isAbsolute(filePath) || /^[A-Za-z]:[\\/]/.test(filePath)) {
      return vscode.Uri.file(filePath);
    }
    if (source.workspaceRootUri) {
      return vscode.Uri.joinPath(
        vscode.Uri.parse(source.workspaceRootUri),
        filePath.replace(/\\/g, "/"),
      );
    }
    return source.workspaceRoot
      ? vscode.Uri.file(resolve(source.workspaceRoot, filePath))
      : undefined;
  }

  private findOpenDocument(uri: string): vscode.TextDocument | undefined {
    return vscode.workspace.textDocuments.find(
      (document) => !document.isClosed && document.uri.toString() === uri,
    );
  }

  private documentsAreCurrent(
    snapshots: readonly NesDocumentContext[],
  ): boolean {
    return snapshots.every((snapshot) => {
      const document = this.findOpenDocument(snapshot.uri);
      return document !== undefined && document.getText() === snapshot.text;
    });
  }

  private async cacheGuards(
    current: NesDocumentContext,
    entry: NesCacheEntry,
    edit: NesTextEdit,
    token: vscode.CancellationToken,
  ): Promise<readonly NesDocumentContext[] | undefined> {
    if (edit.uri === current.uri) {
      return [current];
    }
    const target = this.findOpenDocument(edit.uri);
    if (
      !target ||
      (await this.workspace.isDocumentIgnoredWithRules(target, token)) ||
      token.isCancellationRequested ||
      entry.targetDocumentText === undefined ||
      target.getText() !== entry.targetDocumentText
    ) {
      return undefined;
    }
    return [current, this.workspace.snapshot(target)];
  }

  private isSuggestionRejected(
    suggestion: NesBranchSuggestion,
    cache: NextEditCache,
  ): boolean {
    const edit = suggestion.edit;
    if (!edit) return false;
    if (suggestion.cacheEntry?.rejected) return true;
    const liveTargetText = this.findOpenDocument(edit.uri)?.getText();
    const cachedTargetText =
      suggestion.cacheEntry?.documentUri === edit.uri
        ? suggestion.cacheEntry.documentText
        : suggestion.cacheEntry?.targetDocumentText;
    const targetText = liveTargetText ?? cachedTargetText;
    return (
      targetText !== undefined &&
      cache.isRejected(edit.uri, targetText, edit)
    );
  }

  private isSuggestionCurrent(suggestion: NesBranchSuggestion): boolean {
    if (suggestion.diagnosticsSuggestion) {
      const source = this.findOpenDocument(
        suggestion.diagnosticsSuggestion.sourceDocument.uri,
      );
      return (
        source !== undefined &&
        !this.workspace.isDocumentIgnored(source) &&
        this.diagnostics.isCurrent(suggestion.diagnosticsSuggestion)
      );
    }
    return (
      suggestion.documentGuards !== undefined &&
      this.documentsAreCurrent(suggestion.documentGuards) &&
      suggestion.documentGuards.every((guard) => {
        const document = this.findOpenDocument(guard.uri);
        return (
          document !== undefined && !this.workspace.isDocumentIgnored(document)
        );
      })
    );
  }

  private async enforceMinimumDelay(
    suggestion: NesBranchSuggestion,
    requestIssuedAt: number,
    enabled: boolean,
    token: vscode.CancellationToken,
  ): Promise<boolean> {
    if (!enabled || !suggestion.edit) {
      return !token.isCancellationRequested;
    }
    const minimumDelay =
      suggestion.fromCache && suggestion.rebased
        ? this.config.nextEdit.rebasedCacheDelayMs
        : suggestion.subsequent
          ? this.config.nextEdit.subsequentCacheDelayMs
          : suggestion.speculative
            ? this.config.nextEdit.speculativeCacheDelayMs
            : this.config.nextEdit.cacheDelayMs;
    const elapsed = this.now() - requestIssuedAt;
    await delayWithoutCancellation(Math.max(0, minimumDelay - elapsed));
    return !token.isCancellationRequested;
  }

  private completedOperation(
    suggestion: NesBranchSuggestion,
  ): NesFetchOperation {
    return { suggestion, completion: Promise.resolve() };
  }

  private createCache(): NextEditCache {
    return new NextEditCache(
      this.config.nextEdit.maxCacheEntries,
      {
        absorbSubsequenceTyping: this.config.nextEdit.absorbSubsequenceTyping,
        reverseAgreement: this.config.nextEdit.reverseAgreement,
        maxImperfectAgreementLength:
          this.config.nextEdit.maxImperfectAgreementLength,
      },
      this.config.nextEdit.cacheCursorDistanceCheck,
      this.config.nextEdit.triggerOnEditorChangeAfterSeconds >= 0,
    );
  }

  private trackSuggestion(
    suggestion: NesBranchSuggestion,
    generation: NesRequestGeneration,
  ): NesBranchSuggestion {
    this.suggestionGenerations.set(suggestion, generation);
    return suggestion;
  }

  private generationForSuggestion(
    suggestion: NesBranchSuggestion,
  ): NesRequestGeneration {
    return this.suggestionGenerations.get(suggestion) ?? this.generation;
  }

  private documentTextForEdit(
    context: NesPromptContext,
    edit: NesTextEdit,
  ): string | undefined {
    if (edit.uri === context.current.uri) {
      return context.current.text;
    }
    const related = context.recentDocuments.find(
      (document) => document.uri === edit.uri,
    );
    return related?.text ?? this.findOpenDocument(edit.uri)?.getText();
  }

  private emptySuggestion(
    requestId: string,
    speculative: boolean,
    generation: NesRequestGeneration,
    prompt?: NesPromptBuildResult,
  ): NesBranchSuggestion {
    return this.trackSuggestion({
      branch: "nes",
      source: "llm",
      requestId,
      sourceRequestId: requestId,
      ...(prompt ? { prompt } : {}),
      fromCache: false,
      rebased: false,
      subsequent: false,
      speculative,
      sourceIsSpeculative: speculative,
      createdAt: this.now(),
    }, generation);
  }

  private cursorOffsetForDocument(
    document: vscode.TextDocument,
    fallback: number,
  ): number {
    const editor = (vscode.window.visibleTextEditors ?? []).find(
      (candidate) => candidate.document === document,
    );
    return editor
      ? document.offsetAt(editor.selection.active)
      : Math.max(0, Math.min(fallback, document.getText().length));
  }

  private cacheNoSuggestions(
    cache: NextEditCache,
    context: NesPromptContext,
    prompt: NesPromptBuildResult,
    requestId: string,
    documentUri = context.current.uri,
    cursorOffset = context.cursorOffset,
  ): void {
    if (!this.findOpenDocument(documentUri)) {
      return;
    }
    const editWindow = computeReducedNesWindow(
      context.current.text,
      {
        startOffset: prompt.editWindow.startOffset,
        endOffset: prompt.editWindow.endOffset,
      },
      cursorOffset,
    );
    cache.put({
      documentUri,
      documentText: context.current.text,
      editWindow,
      cursorOffset,
      requestId,
      createdAt: this.now(),
      edits: [],
      source: "llm",
      subsequentN: 0,
      speculative: false,
      rejected: false,
      wasShown: false,
      wasRenderedAsInlineSuggestion: false,
    });
  }

  private speculativeContextForEdit(
    context: NesPromptContext,
    edit: NesTextEdit,
  ): NesPromptContext | undefined {
    if (edit.uri === context.current.uri) return context;
    const related = context.recentDocuments.find(
      (document) => document.uri === edit.uri,
    );
    const open = this.findOpenDocument(edit.uri);
    const target = open ? this.workspace.snapshot(open) : related;
    if (!target) return undefined;
    return {
      ...context,
      current: target,
      cursorOffset: Math.max(0, Math.min(edit.startOffset, target.text.length)),
      recentDocuments: [
        context.current,
        ...context.recentDocuments.filter(
          (document) => document.uri !== target.uri,
        ),
      ],
    };
  }

  private speculativeSeedForCachedSuggestion(
    current: NesDocumentContext,
    edit: NesTextEdit,
    entry: NesCacheEntry,
    generation: NesRequestGeneration,
  ): { readonly seed?: SpeculativeSeed } {
    const targetDocument =
      edit.uri === current.uri ? undefined : this.findOpenDocument(edit.uri);
    const targetBeforeEdit =
      edit.uri === current.uri
        ? current
        : targetDocument
          ? this.workspace.snapshot(targetDocument)
          : undefined;
    if (!targetBeforeEdit) return {};
    return {
      seed: {
        generation,
        targetBeforeEdit,
        edit,
        strategy: this.strategy,
        modelReference: this.modelReference,
        originStream: {
          requestId: entry.requestId,
          done: true,
          activeDocumentEditSeen: edit.uri === current.uri,
        },
      },
    };
  }

  private scheduleSpeculative(suggestion: NesBranchSuggestion): void {
    const seed = suggestion.seed;
    if (!seed || seed.generation !== this.generation) {
      return;
    }
    this.speculativeState.clearScheduled();
    if (
      !seed.originStream.done &&
      this.inFlight?.generation === seed.generation &&
      this.inFlight.requestId === suggestion.sourceRequestId
    ) {
      this.speculativeState.schedule({
        originRequestId: suggestion.sourceRequestId,
        documentUri: seed.targetBeforeEdit.uri,
        suggestion,
      });
      return;
    }
    this.triggerSpeculative(suggestion);
  }

  private triggerSpeculative(suggestion: NesBranchSuggestion): void {
    const seed = suggestion.seed;
    if (!seed || seed.generation !== this.generation) return;
    const targetBeforeEdit = seed.targetBeforeEdit;
    const nextText = applyEdit(targetBeforeEdit.text, seed.edit);
    const exactEdit = preciseEdit(targetBeforeEdit.text, seed.edit);
    let cursorOffset = exactEdit.startOffset + exactEdit.newText.length;
    let cached = seed.generation.cache.lookup(
      targetBeforeEdit.uri,
      nextText,
      cursorOffset,
      (uri) => this.findOpenDocument(uri)?.getText(),
    );
    if (cached?.edit) return;
    if (
      cached?.noSuggestions &&
      cached.entry.editWindow !== undefined &&
      this.config.nextEdit.speculativeRequestsCursorPlacement ===
        "afterEditWindow"
    ) {
      cursorOffset = cursorAfterNesEditWindow(
        nextText,
        cached.entry.editWindow.endOffset,
      );
      cached = seed.generation.cache.lookup(
        targetBeforeEdit.uri,
        nextText,
        cursorOffset,
        (uri) => this.findOpenDocument(uri)?.getText(),
      );
      if (cached?.edit) return;
    }
    const targetDocument = this.findOpenDocument(targetBeforeEdit.uri);
    if (!targetDocument || targetDocument.getText() !== targetBeforeEdit.text) {
      return;
    }
    if (
      (this.inFlight?.generation === seed.generation &&
        this.inFlight.documentText === nextText) ||
      (this.speculativeState.pending?.value.generation === seed.generation &&
        this.speculativeState.pending.documentUri === targetBeforeEdit.uri &&
        this.speculativeState.pending.postEditContent === nextText)
    ) {
      return;
    }
    const delaySession = this.userInteractionMonitor.createDelaySession();
    this.userInteractionMonitor.configureDelayForRequest(
      delaySession,
      seed.strategy,
      textAfterOffsetOnLine(nextText, cursorOffset),
      true,
    );
    const expandedEditWindowLines = resolveNesSpeculativeEditWindowLines(
      this.config.nextEdit.speculativeRequestsAutoExpandEditWindowLines,
      this.config.nextEdit.autoExpandEditWindowLines,
      suggestion.sourceIsSpeculative,
      suggestion.subsequent,
    );
    const source = new vscode.CancellationTokenSource();
    this.speculativeSources.add(source);
    const precomputedWindow = computeNesEditWindow(
      nextText,
      cursorOffset,
      this.config,
      expandedEditWindowLines ?? this.config.prompt.linesBelowEditWindow,
    );
    const pendingEditWindow = {
      startOffset: precomputedWindow.startOffset,
      endOffset: precomputedWindow.endOffset,
    };
    const speculativeRequestId = `sp-${randomUUID()}`;
    const lifecycle: ConsumerRequestLifecycle = { transportStarted: false };
    const operation = Promise.resolve().then(() =>
      this.prepareSpeculativeRequest(
        speculativeRequestId,
        seed,
        targetDocument,
        nextText,
        cursorOffset,
        delaySession,
        source.token,
        expandedEditWindowLines,
        pendingEditWindow,
        lifecycle,
      ),
    );
    const pending: PendingSpeculativeOperation = {
      generation: seed.generation,
      source,
      operation,
      attachmentCompletion: operation,
      lifecycle,
      dependents: 0,
      settled: false,
      editWindow: pendingEditWindow,
    };
    this.speculativeState.setPending({
      documentUri: targetBeforeEdit.uri,
      postEditContent: nextText,
      trajectoryPrefix: targetBeforeEdit.text.slice(0, exactEdit.startOffset),
      trajectorySuffix: targetBeforeEdit.text.slice(exactEdit.endOffset),
      trajectoryNewText: exactEdit.newText,
      value: pending,
      cancel: (_reason: NesSpeculativeCancelReason) => {
        source.cancel();
        source.dispose();
      },
    });
    void operation.then(
      () => {
        pending.settled = true;
      },
      () => {
        pending.settled = true;
      },
    );
    void operation
      .then((result) => result.completion)
      .catch(() => {
        this.speculativeState.clearPending(pending);
      })
      .finally(() => {
        this.speculativeSources.delete(source);
        source.dispose();
      });
  }

  private async prepareSpeculativeRequest(
    requestId: string,
    seed: SpeculativeSeed,
    targetDocument: vscode.TextDocument,
    nextText: string,
    cursorOffset: number,
    delaySession: NesDelaySession,
    token: vscode.CancellationToken,
    expandedEditWindowLines: number | undefined,
    pendingEditWindow: { startOffset: number; endOffset: number },
    lifecycle: ConsumerRequestLifecycle,
  ): Promise<NesFetchOperation> {
    const workspaceContext = await this.workspace.gatherContext(
      targetDocument,
      token,
      cursorOffset,
      {
        target: "nes",
        completionId: requestId,
        opportunityId: requestId,
        timeoutEndMs: this.now() + delaySession.getDebounceTime(),
        includeLanguageContext: determineNesLanguageContextOptions(
          seed.targetBeforeEdit.languageId,
          this.config,
        ).enabled,
      },
    );
    if (token.isCancellationRequested || workspaceContext.ignored) {
      return this.completedOperation(
        this.emptySuggestion(requestId, true, seed.generation),
      );
    }
    const freshContext = toPromptContext(
      {
        ...workspaceContext,
        current: {
          ...workspaceContext.current,
          text: nextText,
          version: workspaceContext.current.version + 1,
        },
      },
      cursorOffset,
      undefined,
    );
    const shownEditHistory = {
      uri: seed.targetBeforeEdit.uri,
      path: seed.targetBeforeEdit.relativePath ?? seed.targetBeforeEdit.path,
      languageId: seed.targetBeforeEdit.languageId,
      before: seed.targetBeforeEdit.text,
      after: nextText,
      timestamp: this.now(),
      reason: "other" as const,
    };
    const nextContext: NesPromptContext = {
      ...freshContext,
      editHistory: [shownEditHistory, ...freshContext.editHistory],
      historyEvents: [
        { ...shownEditHistory, kind: "edit" },
        ...(freshContext.historyEvents ?? []),
      ],
    };
    let prompt: NesPromptBuildResult;
    try {
      prompt = buildOfficialNesPrompt(
        nextContext,
        seed.strategy,
        this.config,
        expandedEditWindowLines === undefined
          ? {
              aggressivenessLevel:
                this.userInteractionMonitor.getAggressivenessLevel()
                  .aggressivenessLevel,
            }
          : {
              linesBelowEditWindow: expandedEditWindowLines,
              aggressivenessLevel:
                this.userInteractionMonitor.getAggressivenessLevel()
                  .aggressivenessLevel,
            },
      );
    } catch (error) {
      if (error instanceof NesPromptTooLargeError) {
        return this.completedOperation(
          this.emptySuggestion(requestId, true, seed.generation),
        );
      }
      throw error;
    }
    pendingEditWindow.startOffset = prompt.editWindow.startOffset;
    pendingEditWindow.endOffset = prompt.editWindow.endOffset;
    return this.fetch(
      nextContext,
      seed.strategy,
      seed.modelReference,
      requestId,
      token,
      true,
      delaySession,
      false,
      false,
      [],
      prompt,
      undefined,
      undefined,
      undefined,
      lifecycle,
      seed.generation,
    );
  }
}

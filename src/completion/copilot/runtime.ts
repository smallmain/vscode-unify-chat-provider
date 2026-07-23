import * as vscode from "vscode";
import {
  createFimGhostTextEngine,
  positionAt as ghostTextPositionAt,
  type GhostTextCompletionList,
  type GhostTextEngine,
  type GhostTextRequest,
} from "../../chat-lib/core/ghost-text";
import {
  COPILOT_BEHAVIOR_CONFIG,
  type CopilotBehaviorConfig,
  validateCopilotBehaviorConfig,
} from "../../chat-lib/core/behavior-config";
import {
  arbitrateJointCompletions,
  arbitrateSeparateProviderCompletions,
  type JointItemSemantics,
  type JointStartedRequest,
} from "../../chat-lib/core/joint";
import {
  InlineEditTriggerState,
  type NesTriggerChange,
} from "../../chat-lib/core/nes/triggerer";
import { authLog } from "../../logger";
import { t } from "../../i18n";
import { LinkedCancellationTokenSource } from "../cancellation";
import { readRoutedCompletionChange } from "../change-hint";
import type {
  CompletionAlgorithm,
  CompletionAlgorithmChange,
  CompletionAlgorithmContext,
  CompletionEnvironmentChangeReason,
  CompletionAlgorithmInput,
  CompletionAlgorithmResult,
  CompletionDiscardReason,
  CompletionModel,
} from "../types";
import {
  OfficialNextEditProvider,
  type NesBranchSuggestion,
} from "./nes-provider";
import {
  normalizeCopilotReplicaAlgorithmOptions,
  type CopilotReplicaAlgorithmOptions,
} from "./options";
import { CopilotWorkspaceAdapter } from "./workspace";
import {
  FimWorkspaceContextAdapter,
  isCopilotLanguageEnabled,
  selectedCompletionProposedEdits,
} from "./fim-runtime-utils";
import {
  fimNotebookLineInActiveCell,
  prepareFimNotebookContext,
} from "./fim-notebook-context";
import { convertNesSuggestionToItem } from "./nes-item";
import {
  CopilotPresentedBranchState,
  FimListDiscardTracker,
  isPresentableNesSuggestion,
  quickSuggestionsDisabled,
  resolveCopilotRuntimeAvailability,
  resolveJointCursorBranch,
  shouldCaptureNesSuggestion,
  shouldEnforceRoutedNesCacheDelay,
  shouldRespectSelectedCompletionInfo,
  shouldSuppressNesProviderChange,
} from "./runtime-routing";

interface FimBranchResult {
  readonly source: "fim";
  readonly items: readonly vscode.InlineCompletionItem[];
  readonly coreList: GhostTextCompletionList;
  readonly engine: GhostTextEngine;
}

interface NesBranchResult {
  readonly source: "nes";
  readonly items: readonly vscode.InlineCompletionItem[];
  readonly suggestion: NesBranchSuggestion;
}

type RuntimeSingleBranchResult = FimBranchResult | NesBranchResult;

interface MixedBranchResult {
  readonly source: "mixed";
  readonly items: readonly vscode.InlineCompletionItem[];
  readonly branches: readonly RuntimeSingleBranchResult[];
}

type RuntimeBranchResult = RuntimeSingleBranchResult | MixedBranchResult;

interface FimItemRoute {
  readonly branch: "fim";
  readonly engine: GhostTextEngine;
  readonly itemId: string;
  readonly listId: string;
  shown: boolean;
  finalized: boolean;
}

interface NesItemRoute {
  readonly branch: "nes";
  readonly suggestion: NesBranchSuggestion;
  readonly renderedInline: boolean;
  shown: boolean;
  finalized: boolean;
}

type RuntimeItemRoute = FimItemRoute | NesItemRoute;

interface FimListRoute {
  readonly engine: GhostTextEngine;
  readonly listId: string;
}

interface FimEngineUsage {
  inFlight: number;
  itemRoutes: number;
  listRoutes: number;
  retired: boolean;
}

interface LastNesSuggestion {
  readonly documentUri: string;
  readonly documentVersion: number;
  readonly documentWithEditApplied: string;
  readonly item: vscode.InlineCompletionItem;
  readonly suggestion: NesBranchSuggestion;
  wasShown: boolean;
}

interface ArbitrationCandidate {
  readonly branch: RuntimeSingleBranchResult;
  readonly item: vscode.InlineCompletionItem;
  readonly edit?: {
    readonly start: number;
    readonly end: number;
    readonly newText: string;
  };
  readonly visible: boolean;
}

function applyItemToDocument(
  document: vscode.TextDocument,
  item: vscode.InlineCompletionItem,
): string | undefined {
  if (!item.range || typeof item.insertText !== "string") {
    return undefined;
  }
  const text = document.getText();
  const start = document.offsetAt(item.range.start);
  const end = document.offsetAt(item.range.end);
  return `${text.slice(0, start)}${item.insertText}${text.slice(end)}`;
}

function normalizeTabSize(
  value: string | number | undefined,
): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : undefined;
}

function normalizeInsertSpaces(
  value: string | boolean | undefined,
): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function isPreReleaseBuild(): boolean {
  const packageJson: unknown = vscode.extensions.getExtension(
    "SmallMain.vscode-unify-chat-provider",
  )?.packageJSON;
  if (typeof packageJson !== "object" || packageJson === null) {
    return false;
  }
  const preview = Reflect.get(packageJson, "preview");
  const version = Reflect.get(packageJson, "version");
  return (
    preview === true || (typeof version === "string" && version.includes("-"))
  );
}

function areQuickSuggestionsDisabled(): boolean {
  const configuration = vscode.workspace.getConfiguration(
    "editor.quickSuggestions",
  );
  return quickSuggestionsDisabled({
    other: configuration.get<unknown>("other"),
    comments: configuration.get<unknown>("comments"),
    strings: configuration.get<unknown>("strings"),
  });
}

export class CopilotRuntime implements CompletionAlgorithm {
  private readonly behaviorConfig: CopilotBehaviorConfig;
  private readonly workspace: CopilotWorkspaceAdapter;
  private readonly trigger: InlineEditTriggerState;
  private readonly nesProvider: OfficialNextEditProvider | undefined;
  private readonly changeEmitter =
    new vscode.EventEmitter<CompletionAlgorithmChange | void>();
  private readonly subscriptions: vscode.Disposable[] = [];
  private readonly itemRoutes = new WeakMap<
    vscode.InlineCompletionItem,
    RuntimeItemRoute
  >();
  private readonly listRoutes = new WeakMap<
    vscode.InlineCompletionList,
    readonly FimListRoute[]
  >();
  private readonly fimListDiscardTracker = new FimListDiscardTracker();
  private fimEngine: GhostTextEngine | undefined;
  private fimEnginePromise: Promise<GhostTextEngine | undefined> | undefined;
  private readonly fimEngineUsages = new Map<GhostTextEngine, FimEngineUsage>();
  private fimModelGeneration = 0;
  private readonly fimContextAdapter: FimWorkspaceContextAdapter;
  private lastNesSuggestion: LastNesSuggestion | undefined;
  private invocationCount = 0;
  private fimRequestsInFlight = 0;
  private readonly presentedBranch = new CopilotPresentedBranchState();
  private disposed = false;

  readonly onDidChange = this.changeEmitter.event;

  constructor(
    private readonly algorithmContext: CompletionAlgorithmContext,
    private options: CopilotReplicaAlgorithmOptions,
    behaviorConfig: unknown = COPILOT_BEHAVIOR_CONFIG,
  ) {
    validateCopilotBehaviorConfig(behaviorConfig);
    this.behaviorConfig = behaviorConfig;
    this.fimContextAdapter = new FimWorkspaceContextAdapter(
      behaviorConfig.fim.defaultDiagnostics,
    );
    this.workspace = new CopilotWorkspaceAdapter();
    this.trigger = new InlineEditTriggerState(
      behaviorConfig.trigger,
      (change) => this.handleTrigger(change),
    );
    const nesRuntimeModel = options.modelUnification
      ? options.unifiedModel
      : options.nesModel;
    if (options.enableNES && nesRuntimeModel) {
      this.nesProvider = new OfficialNextEditProvider(
        algorithmContext,
        this.workspace,
        this.trigger,
        nesRuntimeModel,
        options.modelUnification
          ? "xtabUnifiedModel"
          : (options.strategy ?? "copilotNesXtab"),
        behaviorConfig,
        Date.now,
        options.cursorPredictionModel,
        options.eagerness,
      );
    }
    this.subscriptions.push(
      this.workspace.onDidChangeDocument((event) => {
        this.trigger.handleDocumentChange({
          uri: event.document.uri.toString(),
          scheme: event.document.uri.scheme,
          documentIdentity: event.document,
          reason: event.reason,
          isTracked:
            event.isTracked &&
            this.workspace.isEligibleForNesTrigger(event.document),
        });
      }),
      this.workspace.onDidChangeSelection((event) => {
        const selection = event.selections[0];
        this.trigger.handleSelectionChange({
          uri: event.textEditor.document.uri.toString(),
          scheme: event.textEditor.document.uri.scheme,
          documentIdentity: event.textEditor.document,
          isNotebookCell:
            event.textEditor.document.uri.scheme === "vscode-notebook-cell",
          selectionCount: event.selections.length,
          isEmpty: selection?.isEmpty ?? false,
          line: selection?.active.line ?? 0,
          isTracked: this.workspace.isEligibleForNesTrigger(
            event.textEditor.document,
          ),
        });
      }),
      this.workspace.onDidCloseDocument((uri) => {
        this.nesProvider?.removeDocument(uri);
      }),
    );
  }

  updateOptions(normalizedOptions: unknown): boolean {
    const normalized = normalizeCopilotReplicaAlgorithmOptions(normalizedOptions);
    if (!normalized.ok) {
      return false;
    }
    this.options = normalized.value;
    this.nesProvider?.setEagerness(normalized.value.eagerness);
    return true;
  }

  handleEnvironmentChange(reason: CompletionEnvironmentChangeReason): void {
    if (this.disposed || reason !== "auth-changed") {
      return;
    }
    this.invocationCount += 1;
    this.lastNesSuggestion = undefined;
    this.nesProvider?.handleAuthChange();
    this.changeEmitter.fire({ reason });
  }

  async provideInlineCompletions(
    input: CompletionAlgorithmInput,
    token: vscode.CancellationToken,
  ): Promise<CompletionAlgorithmResult | undefined> {
    if (this.disposed || token.isCancellationRequested) {
      return undefined;
    }
    const availability = resolveCopilotRuntimeAvailability({
      enableFIM: this.options.enableFIM,
      enableNES: this.options.enableNES,
      modelUnification: this.options.modelUnification ?? false,
      trigger:
        input.context.triggerKind === vscode.InlineCompletionTriggerKind.Invoke
          ? "invoke"
          : "automatic",
      completionsEnabled: isCopilotLanguageEnabled(
        input.document.languageId,
        this.options.enabledLanguages,
      ),
      inlineEditsEnabled: isCopilotLanguageEnabled(
        input.document.languageId,
        this.options.inlineEditsEnabledLanguages,
      ),
    });
    const invocationId = ++this.invocationCount;
    const routed = readRoutedCompletionChange(input.context);
    const useJointCursorStrategy =
      this.behaviorConfig.joint.enabled &&
      this.behaviorConfig.joint.strategy === "cursorEndOfLine";
    let branch: RuntimeBranchResult | undefined;
    if (
      !useJointCursorStrategy &&
      availability.nesEnabled &&
      (routed?.change?.branch === "nes" ||
        routed?.change?.branch === "diagnostics")
    ) {
      branch = await this.provideNesBranch(
        input,
        token,
        shouldEnforceRoutedNesCacheDelay(
          this.lastNesSuggestion,
          input.document.uri.toString(),
          input.document.version,
        ),
        availability.serveAsCompletionsProvider,
      );
    } else if (
      !useJointCursorStrategy &&
      availability.fimEnabled &&
      routed?.change?.branch === "fim"
    ) {
      branch = await this.provideFimBranch(input, token);
    } else if (
      !useJointCursorStrategy &&
      routed?.change?.branch !== undefined
    ) {
      branch = undefined;
    } else if (availability.fimEnabled && availability.nesEnabled) {
      branch = this.behaviorConfig.joint.enabled
        ? this.behaviorConfig.joint.strategy === "cursorEndOfLine"
          ? await this.provideJointCursorEndOfLine(input, token)
          : await this.provideJoint(
              input,
              token,
              availability.serveAsCompletionsProvider,
            )
        : await this.provideSeparateProviders(input, token);
    } else if (availability.fimEnabled) {
      branch = await this.provideFimBranch(input, token);
    } else if (availability.nesEnabled) {
      branch = await this.provideNesBranch(
        input,
        token,
        true,
        availability.serveAsCompletionsProvider,
      );
    }

    if (invocationId === this.invocationCount) {
      this.captureLastNesSuggestion(input, branch);
    }
    if (!branch || branch.items.length === 0) {
      return undefined;
    }
    return {
      providerId: this.algorithmContext.entry.id,
      items: [...branch.items],
      metadata: {
        source: branch.source,
        modelUnification: this.options.modelUnification ?? false,
        providerRouting: this.behaviorConfig.joint.enabled
          ? "joint"
          : "separate",
        strategy: this.options.modelUnification
          ? "xtabUnifiedModel"
          : (this.options.strategy ?? "copilotNesXtab"),
        serveAsCompletionsProvider: availability.serveAsCompletionsProvider,
      },
    };
  }

  handleDidShowCompletionItem(
    item: vscode.InlineCompletionItem,
    _updatedInsertText: string,
  ): void {
    const route = this.itemRoutes.get(item);
    if (!route || route.finalized) {
      return;
    }
    this.presentedBranch.show(item, route.branch);
    if (route.shown) {
      return;
    }
    route.shown = true;
    if (route.branch === "fim") {
      route.engine.handleDidShowCompletionItem(route.itemId);
    } else {
      this.nesProvider?.handleShown(route.suggestion, route.renderedInline);
      if (this.lastNesSuggestion?.suggestion === route.suggestion) {
        this.lastNesSuggestion.wasShown = true;
      }
    }
  }

  handleEndOfLifetime(
    item: vscode.InlineCompletionItem,
    reason: vscode.InlineCompletionEndOfLifeReason,
  ): void {
    this.presentedBranch.end(item);
    const route = this.itemRoutes.get(item);
    if (!route || route.finalized) {
      return;
    }
    route.finalized = true;
    if (route.branch === "fim") {
      route.engine.handleEndOfLifetime(
        route.itemId,
        reason.kind === vscode.InlineCompletionEndOfLifeReasonKind.Accepted
          ? "accepted"
          : "discarded",
      );
    } else {
      switch (reason.kind) {
        case vscode.InlineCompletionEndOfLifeReasonKind.Accepted:
          this.nesProvider?.handleAccepted(route.suggestion);
          break;
        case vscode.InlineCompletionEndOfLifeReasonKind.Rejected:
          this.nesProvider?.handleRejected(route.suggestion);
          break;
        case vscode.InlineCompletionEndOfLifeReasonKind.Ignored: {
          const superseded = reason.supersededBy
            ? this.itemRoutes.get(reason.supersededBy)
            : undefined;
          this.nesProvider?.handleIgnored(
            route.suggestion,
            superseded?.branch === "nes" ? superseded.suggestion : undefined,
          );
          break;
        }
      }
    }
    this.itemRoutes.delete(item);
    if (route.branch === "fim") {
      this.releaseFimItemRoute(route.engine);
    }
  }

  handleListEndOfLifetime(
    list: vscode.InlineCompletionList,
    _reason: vscode.InlineCompletionsDisposeReason,
  ): void {
    for (const route of this.listRoutes.get(list) ?? []) {
      this.fimListDiscardTracker.endList(route.listId);
      route.engine.handleListEndOfLifetime(route.listId);
      this.releaseFimListRoute(route.engine);
    }
    this.listRoutes.delete(list);
  }

  trackCompletionList(
    list: vscode.InlineCompletionList,
    items: readonly vscode.InlineCompletionItem[],
  ): void {
    const listIdsByEngine = new Map<GhostTextEngine, Set<string>>();
    for (const item of items) {
      const route = this.itemRoutes.get(item);
      if (route?.branch === "fim") {
        const listIds = listIdsByEngine.get(route.engine) ?? new Set<string>();
        listIds.add(route.listId);
        listIdsByEngine.set(route.engine, listIds);
      }
    }
    const routes = [...listIdsByEngine].flatMap(([engine, listIds]) =>
      [...listIds].map((listId) => ({ engine, listId })),
    );
    for (const route of routes) {
      this.retainFimListRoute(route.engine);
    }
    this.listRoutes.set(list, routes);
  }

  handleDiscardedCompletionItems(
    items: readonly vscode.InlineCompletionItem[],
    reason: CompletionDiscardReason,
  ): void {
    const fimListIds = new Map<GhostTextEngine, Set<string>>();
    for (const item of items) {
      this.presentedBranch.end(item);
      const route = this.itemRoutes.get(item);
      if (!route || route.finalized) {
        continue;
      }
      route.finalized = true;
      if (route.branch === "fim") {
        route.engine.handleEndOfLifetime(route.itemId, "discarded");
        if (this.fimListDiscardTracker.recordDiscardedItem(route.listId)) {
          const listIds = fimListIds.get(route.engine) ?? new Set<string>();
          listIds.add(route.listId);
          fimListIds.set(route.engine, listIds);
        }
      } else {
        this.nesProvider?.handleIgnored(route.suggestion);
      }
      this.itemRoutes.delete(item);
      if (route.branch === "fim") {
        this.releaseFimItemRoute(route.engine);
      }
    }
    for (const [engine, listIds] of fimListIds) {
      for (const listId of listIds) {
        engine.handleListEndOfLifetime(listId);
      }
    }
  }

  getState(): {
    readonly disposed: boolean;
    readonly workspace: ReturnType<CopilotWorkspaceAdapter["getState"]>;
    readonly trigger: ReturnType<InlineEditTriggerState["getState"]>;
    readonly activePresentedBranch?: "fim" | "nes";
    readonly fim?: ReturnType<GhostTextEngine["getDebugState"]>;
    readonly nes?: ReturnType<OfficialNextEditProvider["getState"]>;
  } {
    return {
      disposed: this.disposed,
      workspace: this.workspace.getState(),
      trigger: this.trigger.getState(),
      ...(this.presentedBranch.branch
        ? { activePresentedBranch: this.presentedBranch.branch }
        : {}),
      ...(this.fimEngine ? { fim: this.fimEngine.getDebugState() } : {}),
      ...(this.nesProvider ? { nes: this.nesProvider.getState() } : {}),
    };
  }

  getDebugState(): ReturnType<CopilotRuntime["getState"]> {
    return this.getState();
  }

  handleDidChangeChatModels(): void {
    if (this.disposed) {
      return;
    }
    this.fimModelGeneration += 1;
    const currentFimEngine = this.fimEngine;
    this.fimEngine = undefined;
    this.fimEnginePromise = undefined;
    if (currentFimEngine) {
      this.retireFimEngine(currentFimEngine);
    }
    this.nesProvider?.handleDidChangeChatModels();
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.fimModelGeneration += 1;
    for (const subscription of this.subscriptions.splice(0)) {
      subscription.dispose();
    }
    this.trigger.dispose();
    this.nesProvider?.dispose();
    this.fimEngine = undefined;
    this.fimEnginePromise = undefined;
    for (const engine of this.fimEngineUsages.keys()) {
      engine.dispose();
    }
    this.fimEngineUsages.clear();
    this.fimListDiscardTracker.clear();
    this.presentedBranch.clear();
    this.workspace.dispose();
    this.changeEmitter.dispose();
    this.lastNesSuggestion = undefined;
  }

  private handleTrigger(change: NesTriggerChange): void {
    if (
      this.disposed ||
      shouldSuppressNesProviderChange({
        jointProviderEnabled: this.behaviorConfig.joint.enabled,
        suppressWhileFimInFlight:
          this.behaviorConfig.joint.suppressChangeWhileFimInFlight,
        fimRequestsInFlight: this.fimRequestsInFlight,
        activePresentedBranch: this.presentedBranch.branch,
      })
    ) {
      return;
    }
    this.changeEmitter.fire({
      branch: "nes",
      reason: change.reason,
      data: change,
    });
  }

  private async getFimEngine(
    token: vscode.CancellationToken,
  ): Promise<GhostTextEngine | undefined> {
    if (this.fimEngine) {
      return this.fimEngine;
    }
    if (!this.options.fimModel) {
      return undefined;
    }
    if (this.fimEnginePromise) {
      return this.fimEnginePromise;
    }
    const generation = this.fimModelGeneration;
    const reference = this.options.fimModel;
    const resolution = (async (): Promise<GhostTextEngine | undefined> => {
      const eligibility =
        await this.algorithmContext.modelResolver.evaluateModelForRequest?.(
          reference,
          'copilot-replica/fim',
        );
      if (eligibility && !eligibility.eligible) {
        if (!this.disposed && generation === this.fimModelGeneration) {
          this.algorithmContext.reportConfigurationError(
            `fim-model:${eligibility.code ?? 'model-ineligible'}:${reference.vendor}:${reference.id}`,
            eligibility.message ?? t("The selected FIM model is unavailable."),
          );
        }
        return undefined;
      }
      const model: CompletionModel =
        await this.algorithmContext.modelResolver.resolveCompletionModel(
          reference,
          token,
        );
      if (this.disposed) {
        return undefined;
      }
      const engine = createFimGhostTextEngine(model, {
        behavior: {
          cyclingCandidateCount: this.options.n,
        },
      });
      const isCurrent = generation === this.fimModelGeneration;
      this.fimEngineUsages.set(engine, {
        inFlight: 0,
        itemRoutes: 0,
        listRoutes: 0,
        retired: !isCurrent,
      });
      if (isCurrent) {
        this.fimEngine = engine;
      } else {
        // Let every continuation awaiting this shared resolution retain the
        // engine before the normal retirement microtask checks its usage.
        setTimeout(() => this.retireFimEngine(engine), 0);
      }
      return engine;
    })().catch((error: unknown) => {
      if (!this.disposed && generation === this.fimModelGeneration) {
        this.algorithmContext.reportConfigurationError(
          `fim-model:${reference.vendor}:${reference.id}`,
          error instanceof Error ? error.message : String(error),
        );
      }
      return undefined;
    });
    this.fimEnginePromise = resolution;
    const clearResolution = (): void => {
      if (this.fimEnginePromise === resolution) {
        this.fimEnginePromise = undefined;
      }
    };
    void resolution.then(clearResolution, clearResolution);
    return resolution;
  }

  private retireFimEngine(engine: GhostTextEngine): void {
    const usage = this.fimEngineUsages.get(engine);
    if (!usage) {
      return;
    }
    usage.retired = true;
    queueMicrotask(() => {
      const currentUsage = this.fimEngineUsages.get(engine);
      if (currentUsage === usage) {
        this.disposeRetiredFimEngineIfUnused(engine, usage);
      }
    });
  }

  private retainFimItemRoute(engine: GhostTextEngine): void {
    const usage = this.fimEngineUsages.get(engine);
    if (usage) {
      usage.itemRoutes += 1;
    }
  }

  private releaseFimItemRoute(engine: GhostTextEngine): void {
    const usage = this.fimEngineUsages.get(engine);
    if (!usage) {
      return;
    }
    usage.itemRoutes = Math.max(0, usage.itemRoutes - 1);
    this.disposeRetiredFimEngineIfUnused(engine, usage);
  }

  private retainFimListRoute(engine: GhostTextEngine): void {
    const usage = this.fimEngineUsages.get(engine);
    if (usage) {
      usage.listRoutes += 1;
    }
  }

  private releaseFimListRoute(engine: GhostTextEngine): void {
    const usage = this.fimEngineUsages.get(engine);
    if (!usage) {
      return;
    }
    usage.listRoutes = Math.max(0, usage.listRoutes - 1);
    this.disposeRetiredFimEngineIfUnused(engine, usage);
  }

  private disposeRetiredFimEngineIfUnused(
    engine: GhostTextEngine,
    usage: FimEngineUsage,
  ): void {
    if (
      !usage.retired ||
      usage.inFlight > 0 ||
      usage.itemRoutes > 0 ||
      usage.listRoutes > 0
    ) {
      return;
    }
    engine.dispose();
    this.fimEngineUsages.delete(engine);
  }

  private async provideFimBranch(
    input: CompletionAlgorithmInput,
    token: vscode.CancellationToken,
  ): Promise<FimBranchResult | undefined> {
    this.fimRequestsInFlight += 1;
    let activeEngine:
      | { readonly engine: GhostTextEngine; readonly usage: FimEngineUsage }
      | undefined;
    try {
      const engine = await this.getFimEngine(token);
      if (!engine || token.isCancellationRequested) {
        return undefined;
      }
      const usage = this.fimEngineUsages.get(engine);
      if (!usage) {
        return undefined;
      }
      usage.inFlight += 1;
      activeEngine = { engine, usage };
      const notebook = this.workspace.fimNotebookContext(input.document);
      const selected = shouldRespectSelectedCompletionInfo(
        this.options.respectSelectedCompletionInfo,
        areQuickSuggestionsDisabled(),
        isPreReleaseBuild(),
      )
        ? input.context.selectedCompletionInfo
        : undefined;
      const proposedEdits = selectedCompletionProposedEdits(
        input.document,
        input.position,
        selected,
      );
      const workspace = await this.workspace.gatherContext(
        input.document,
        token,
        input.document.offsetAt(input.position),
        {
          target: "completions",
          ...(input.context.requestUuid
            ? {
                completionId: input.context.requestUuid,
                opportunityId: input.context.requestUuid,
              }
            : {}),
          ...(proposedEdits ? { proposedEdits } : {}),
        },
      );
      if (token.isCancellationRequested) {
        return undefined;
      }
      const editor = vscode.window.visibleTextEditors.find(
        (candidate) => candidate.document === input.document,
      );
      const notebookContext = notebook
        ? prepareFimNotebookContext({
            ...notebook,
            activeLanguageId: input.document.languageId,
            activeText: input.document.getText(),
            activeCursorOffset: input.document.offsetAt(input.position),
          })
        : undefined;
      const requestText = notebookContext?.text ?? input.document.getText();
      const requestPosition = notebookContext
        ? ghostTextPositionAt(requestText, notebookContext.cursorOffset)
        : { line: input.position.line, character: input.position.character };
      const request: GhostTextRequest = {
        document: {
          uri: input.document.uri.toString(),
          filePath: input.document.uri.fsPath || input.document.uri.path,
          ...(workspace.current.relativePath
            ? { relativePath: workspace.current.relativePath }
            : {}),
          ...(notebookContext ? { notebook: true } : {}),
          languageId: input.document.languageId,
          text: requestText,
          version: input.document.version,
        },
        position: requestPosition,
        trigger:
          input.context.triggerKind ===
          vscode.InlineCompletionTriggerKind.Invoke
            ? "invoke"
            : "automatic",
        context: this.fimContextAdapter.adapt(
          workspace,
          Date.now(),
          input.document.offsetAt(input.position),
        ),
        ...(selected
          ? {
              selectedCompletionInfo: {
                text: selected.text,
                range: {
                  start:
                    (notebookContext?.activeCellOffset ?? 0) +
                    input.document.offsetAt(selected.range.start),
                  end:
                    (notebookContext?.activeCellOffset ?? 0) +
                    input.document.offsetAt(selected.range.end),
                },
              },
            }
          : {}),
        formattingOptions: {
          ...(normalizeTabSize(editor?.options.tabSize) === undefined
            ? {}
            : { tabSize: normalizeTabSize(editor?.options.tabSize) }),
          ...(normalizeInsertSpaces(editor?.options.insertSpaces) === undefined
            ? {}
            : {
                insertSpaces: normalizeInsertSpaces(
                  editor?.options.insertSpaces,
                ),
              }),
        },
        opportunityId: input.context.requestUuid,
        multiline: "auto",
      };
      const result = await engine.provide(request, token);
      if (result.type === "failed") {
        if (result.error) {
          throw result.error;
        }
        return undefined;
      }
      if (result.type !== "success") {
        return undefined;
      }
      const items = result.list.items.map((coreItem) => {
        const startLine = notebookContext
          ? fimNotebookLineInActiveCell(
              coreItem.range.start.line,
              notebookContext.activeCellLineOffset,
            )
          : coreItem.range.start.line;
        const endLine = notebookContext
          ? fimNotebookLineInActiveCell(
              coreItem.range.end.line,
              notebookContext.activeCellLineOffset,
            )
          : coreItem.range.end.line;
        const item = new vscode.InlineCompletionItem(
          coreItem.insertText,
          new vscode.Range(
            new vscode.Position(startLine, coreItem.range.start.character),
            new vscode.Position(endLine, coreItem.range.end.character),
          ),
        );
        item.correlationId = coreItem.metadata.clientCompletionId;
        this.itemRoutes.set(item, {
          branch: "fim",
          engine,
          itemId: coreItem.id,
          listId: result.list.id,
          shown: false,
          finalized: false,
        });
        this.retainFimItemRoute(engine);
        return item;
      });
      this.fimListDiscardTracker.register(result.list.id, items.length);
      return {
        source: "fim",
        items,
        coreList: result.list,
        engine,
      };
    } finally {
      if (activeEngine) {
        activeEngine.usage.inFlight = Math.max(
          0,
          activeEngine.usage.inFlight - 1,
        );
        this.disposeRetiredFimEngineIfUnused(
          activeEngine.engine,
          activeEngine.usage,
        );
      }
      this.fimRequestsInFlight = Math.max(0, this.fimRequestsInFlight - 1);
    }
  }

  private async provideNesBranch(
    input: CompletionAlgorithmInput,
    token: vscode.CancellationToken,
    enforceCacheDelay: boolean,
    serveAsCompletionsProvider = false,
  ): Promise<NesBranchResult | undefined> {
    if (!this.isNesRequestEligible(input)) {
      return undefined;
    }
    const suggestion = await this.nesProvider?.provide(
      input,
      token,
      enforceCacheDelay,
    );
    if (
      !suggestion ||
      !isPresentableNesSuggestion(
        suggestion.edit !== undefined,
        suggestion.cursorJump?.fallbackOnly === true,
      ) ||
      token.isCancellationRequested
    ) {
      return undefined;
    }
    const converted = this.convertNesItem(
      input,
      suggestion,
      serveAsCompletionsProvider,
    );
    return converted
      ? { source: "nes", items: [converted], suggestion }
      : undefined;
  }

  private convertNesItem(
    input: CompletionAlgorithmInput,
    suggestion: NesBranchSuggestion,
    serveAsCompletionsProvider = false,
  ): vscode.InlineCompletionItem | undefined {
    const presentationOptions: CopilotReplicaAlgorithmOptions =
      serveAsCompletionsProvider
        ? {
            ...this.options,
            modelUnification: true,
            includeInlineCompletions: true,
            includeInlineEdits: false,
          }
        : this.options;
    const converted = convertNesSuggestionToItem(
      input,
      suggestion,
      presentationOptions,
      this.behaviorConfig,
      serveAsCompletionsProvider,
    );
    if (!converted) {
      return undefined;
    }
    const { item, renderedInline } = converted;
    this.itemRoutes.set(item, {
      branch: "nes",
      suggestion,
      renderedInline,
      shown: false,
      finalized: false,
    });
    return item;
  }

  private async safeFim(
    input: CompletionAlgorithmInput,
    token: vscode.CancellationToken,
  ): Promise<FimBranchResult | undefined> {
    try {
      return await this.provideFimBranch(input, token);
    } catch (error) {
      if (!token.isCancellationRequested) {
        authLog.error(
          `completion:${this.algorithmContext.entry.id}:fim`,
          "Copilot FIM request failed",
          error,
        );
      }
      return undefined;
    }
  }

  private async safeNes(
    input: CompletionAlgorithmInput,
    token: vscode.CancellationToken,
    enforceCacheDelay: boolean,
    serveAsCompletionsProvider: boolean,
  ): Promise<NesBranchResult | undefined> {
    try {
      return await this.provideNesBranch(
        input,
        token,
        enforceCacheDelay,
        serveAsCompletionsProvider,
      );
    } catch (error) {
      if (!token.isCancellationRequested) {
        authLog.error(
          `completion:${this.algorithmContext.entry.id}:nes`,
          "Copilot NES request failed",
          error,
        );
      }
      return undefined;
    }
  }

  private async provideJoint(
    input: CompletionAlgorithmInput,
    token: vscode.CancellationToken,
    serveAsCompletionsProvider: boolean,
  ): Promise<RuntimeBranchResult | undefined> {
    const result = await arbitrateJointCompletions({
      documentUri: input.document.uri.toString(),
      documentVersion: input.document.version,
      documentText: input.document.getText(),
      fim: {
        start: () =>
          this.startArbitrationBranch("fim", input, token, true, false),
      },
      nes: {
        start: (enforceCacheDelay) =>
          this.startArbitrationBranch(
            "nes",
            input,
            token,
            enforceCacheDelay,
            false,
            serveAsCompletionsProvider,
          ),
      },
      fimSemantics: this.arbitrationSemantics(),
      nesSemantics: this.arbitrationSemantics(),
      ...(this.lastNesSuggestion
        ? {
            lastNesSuggestion: {
              documentUri: this.lastNesSuggestion.documentUri,
              documentVersion: this.lastNesSuggestion.documentVersion,
              documentWithEditApplied:
                this.lastNesSuggestion.documentWithEditApplied,
              wasShown: this.lastNesSuggestion.wasShown,
            },
          }
        : {}),
      selectionTriggered: false,
      cancellation: this.cancellationSignal(token),
      cacheWaitMs: this.behaviorConfig.joint.nesCacheWaitMs,
    });
    if (result.kind === "failed") {
      authLog.error(
        `completion:${this.algorithmContext.entry.id}:${result.source}`,
        "Copilot joint arbitration failed",
        result.error,
      );
      return undefined;
    }
    return result.kind === "result"
      ? this.rebuildArbitratedBranch(result.list.items)
      : undefined;
  }

  private async provideJointCursorEndOfLine(
    input: CompletionAlgorithmInput,
    token: vscode.CancellationToken,
  ): Promise<RuntimeBranchResult | undefined> {
    const line = input.document.lineAt(input.position.line).text;
    return resolveJointCursorBranch(line, input.position.character) === "fim"
      ? this.provideFimBranch(input, token)
      : this.provideNesBranch(input, token, false);
  }

  private async provideSeparateProviders(
    input: CompletionAlgorithmInput,
    token: vscode.CancellationToken,
  ): Promise<RuntimeBranchResult | undefined> {
    const result = await arbitrateSeparateProviderCompletions({
      documentText: input.document.getText(),
      fim: {
        start: () =>
          this.startArbitrationBranch("fim", input, token, true, true),
      },
      nes: {
        start: (enforceCacheDelay) =>
          this.startArbitrationBranch(
            "nes",
            input,
            token,
            enforceCacheDelay,
            true,
          ),
      },
      fimSemantics: this.arbitrationSemantics(),
      nesSemantics: this.arbitrationSemantics(),
      trigger:
        input.context.triggerKind === vscode.InlineCompletionTriggerKind.Invoke
          ? "explicit"
          : "automatic",
      includeInlineCompletions: this.options.includeInlineCompletions ?? true,
      includeInlineEdits: this.options.includeInlineEdits ?? true,
      enforceCacheDelay: true,
      cancellation: this.cancellationSignal(token),
    });
    return result.kind === "result"
      ? this.rebuildArbitratedBranch(
          result.list.items.map((candidate) => candidate.item),
        )
      : undefined;
  }

  private startArbitrationBranch(
    source: "fim" | "nes",
    input: CompletionAlgorithmInput,
    token: vscode.CancellationToken,
    enforceCacheDelay: boolean,
    isolateErrors: boolean,
    serveAsCompletionsProvider = false,
  ): JointStartedRequest<ArbitrationCandidate> {
    const cancellation = new LinkedCancellationTokenSource(token);
    const branchPromise =
      source === "fim"
        ? isolateErrors
          ? this.safeFim(input, cancellation.token)
          : this.provideFimBranch(input, cancellation.token)
        : isolateErrors
          ? this.safeNes(
              input,
              cancellation.token,
              enforceCacheDelay,
              serveAsCompletionsProvider,
            )
          : this.provideNesBranch(
              input,
              cancellation.token,
              enforceCacheDelay,
              serveAsCompletionsProvider,
            );
    const result = branchPromise.then((branch) =>
      branch
        ? {
            items: branch.items.map((item) =>
              this.toArbitrationCandidate(input.document, branch, item),
            ),
          }
        : undefined,
    );
    const cleanup = (): void => cancellation.dispose();
    void result.then(cleanup, cleanup);
    return {
      result,
      cancel: () => cancellation.cancel(),
      disposeWhenSettled: (_reason) => {
        void branchPromise.then(
          (branch) => {
            if (branch) {
              this.disposeArbitrationBranch(branch);
            }
          },
          () => undefined,
        );
      },
    };
  }

  private disposeArbitrationBranch(branch: RuntimeSingleBranchResult): void {
    for (const item of branch.items) {
      this.presentedBranch.end(item);
      const route = this.itemRoutes.get(item);
      if (!route || route.finalized) {
        continue;
      }
      route.finalized = true;
      if (route.branch === "fim") {
        route.engine.handleEndOfLifetime(route.itemId, "discarded");
      } else {
        this.nesProvider?.handleIgnored(route.suggestion);
      }
      this.itemRoutes.delete(item);
      if (route.branch === "fim") {
        this.releaseFimItemRoute(route.engine);
      }
    }
    if (branch.source === "fim") {
      this.fimListDiscardTracker.endList(branch.coreList.id);
      branch.engine.handleListEndOfLifetime(branch.coreList.id);
    }
  }

  private rebuildArbitratedBranch(
    candidates: readonly ArbitrationCandidate[],
  ): RuntimeBranchResult | undefined {
    const first = candidates[0];
    if (!first) {
      return undefined;
    }
    const items = candidates.map((candidate) => candidate.item);
    const branches = [
      ...new Set(candidates.map((candidate) => candidate.branch)),
    ];
    const retainedItems = new Set(items);
    for (const branch of branches) {
      for (const item of branch.items) {
        if (!retainedItems.has(item)) {
          this.disposeFilteredArbitrationItem(item);
        }
      }
    }
    if (branches.length === 1) {
      return { ...first.branch, items };
    }
    return {
      source: "mixed",
      items,
      branches,
    };
  }

  private disposeFilteredArbitrationItem(
    item: vscode.InlineCompletionItem,
  ): void {
    this.presentedBranch.end(item);
    const route = this.itemRoutes.get(item);
    if (!route || route.finalized) {
      return;
    }
    route.finalized = true;
    if (route.branch === "fim") {
      route.engine.handleEndOfLifetime(route.itemId, "discarded");
      if (this.fimListDiscardTracker.recordDiscardedItem(route.listId)) {
        route.engine.handleListEndOfLifetime(route.listId);
      }
    } else {
      this.nesProvider?.handleIgnored(route.suggestion);
    }
    this.itemRoutes.delete(item);
    if (route.branch === "fim") {
      this.releaseFimItemRoute(route.engine);
    }
  }

  private toArbitrationCandidate(
    document: vscode.TextDocument,
    branch: RuntimeSingleBranchResult,
    item: vscode.InlineCompletionItem,
  ): ArbitrationCandidate {
    const sameDocument =
      item.uri === undefined || item.uri.toString() === document.uri.toString();
    const edit =
      item.range && typeof item.insertText === "string" && sameDocument
        ? {
            start: document.offsetAt(item.range.start),
            end: document.offsetAt(item.range.end),
            newText: item.insertText,
          }
        : undefined;
    return {
      branch,
      item,
      ...(edit ? { edit } : {}),
      visible: item.isInlineEdit !== true,
    };
  }

  private arbitrationSemantics(): JointItemSemantics<ArbitrationCandidate> {
    return {
      getEdit: (candidate) => candidate.edit,
      isVisible: (candidate) => candidate.visible,
      isInlineEdit: (candidate) => candidate.item.isInlineEdit === true,
      showInlineEditMenu: (candidate) =>
        candidate.item.showInlineEditMenu === true,
    };
  }

  private isNesRequestEligible(input: CompletionAlgorithmInput): boolean {
    if (!this.nesProvider || !this.workspace.isTracked(input.document)) {
      return false;
    }
    if (
      this.behaviorConfig.nextEdit.ignoreWhenSuggestVisible &&
      input.context.selectedCompletionInfo !== undefined &&
      !(this.options.modelUnification ?? false)
    ) {
      return false;
    }
    return (
      (this.options.includeInlineCompletions ?? true) ||
      (this.options.includeInlineEdits ?? true)
    );
  }

  private cancellationSignal(token: vscode.CancellationToken) {
    return {
      get isCancellationRequested(): boolean {
        return token.isCancellationRequested;
      },
      onCancellationRequested(listener: () => void) {
        return token.onCancellationRequested(listener);
      },
    };
  }

  private captureLastNesSuggestion(
    input: CompletionAlgorithmInput,
    branch: RuntimeBranchResult | undefined,
  ): void {
    const item =
      branch?.source === "nes"
        ? branch.items[0]
        : branch?.source === "mixed"
          ? branch.items.find(
              (candidate) => this.itemRoutes.get(candidate)?.branch === "nes",
            )
          : undefined;
    const route = item ? this.itemRoutes.get(item) : undefined;
    if (!item || route?.branch !== "nes") {
      this.lastNesSuggestion = undefined;
      return;
    }
    const applied = applyItemToDocument(input.document, item);
    if (
      !applied ||
      !shouldCaptureNesSuggestion(
        item.uri?.toString(),
        route.suggestion.edit?.uri,
        input.document.uri.toString(),
      )
    ) {
      this.lastNesSuggestion = undefined;
      return;
    }
    this.lastNesSuggestion = {
      documentUri: input.document.uri.toString(),
      documentVersion: input.document.version,
      documentWithEditApplied: applied,
      item,
      suggestion: route.suggestion,
      wasShown: false,
    };
  }
}

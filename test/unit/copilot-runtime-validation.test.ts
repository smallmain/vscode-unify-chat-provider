import { describe, expect, it, vi } from "vitest";
import type {
  CompletionAlgorithmContext,
  CompletionModel,
} from "../../src/completion/types";
import type {
  AlgorithmRequest,
  CopilotReplicaAlgorithmCursorPredictionRequest,
  CopilotReplicaAlgorithmFimRequest,
  CopilotReplicaAlgorithmNesRequest,
  InceptionAlgorithmRequest,
  MistralAlgorithmRequest,
  SimpleAlgorithmRequest,
  ZedAlgorithmRequest,
} from "../../src/completion/model/requests";
import type {
  AlgorithmResponse,
  CopilotReplicaAlgorithmCursorPredictionResponse,
  CopilotReplicaAlgorithmFimResponse,
  CopilotReplicaAlgorithmNesResponse,
  InceptionAlgorithmResponse,
  MistralAlgorithmResponse,
  SimpleAlgorithmResponse,
  ZedAlgorithmResponse,
} from "../../src/completion/model/responses";

interface FakeEngineRecord {
  disposed: boolean;
  endCount: number;
  listEndCount: number;
  shownCount: number;
  cyclingCandidateCount?: number;
}

const state = vi.hoisted(() => ({
  workspaceConstructions: 0,
  workspaceDisposals: 0,
  nesCatalogChanges: 0,
  nesAuthChanges: 0,
  nesDisposals: 0,
  nesIgnored: 0,
  nesShown: 0,
  triggerEmit: undefined as
    | ((change: {
        readonly reason: "selectionChange" | "activeDocumentSwitch";
        readonly uuid: string;
      }) => void)
    | undefined,
  engines: [] as FakeEngineRecord[],
}));

vi.mock("vscode", () => {
  class EventEmitter<T> {
    private readonly listeners = new Set<(event: T) => void>();
    readonly event = (listener: (event: T) => void) => {
      this.listeners.add(listener);
      return { dispose: () => this.listeners.delete(listener) };
    };

    fire(event: T): void {
      for (const listener of this.listeners) {
        listener(event);
      }
    }

    dispose(): void {
      this.listeners.clear();
    }
  }

  class Position {
    constructor(
      readonly line: number,
      readonly character: number,
    ) {}
  }

  class Range {
    constructor(
      readonly start: Position,
      readonly end: Position,
    ) {}
  }

  class InlineCompletionItem {
    correlationId: string | undefined;
    isInlineEdit: boolean | undefined;
    showInlineEditMenu: boolean | undefined;

    constructor(
      readonly insertText: string,
      readonly range?: Range,
    ) {}
  }

  class InlineCompletionList {
    constructor(readonly items: InlineCompletionItem[]) {}
  }

  return {
    EventEmitter,
    env: { language: "en" },
    l10n: { t: (message: string) => message },
    Position,
    Range,
    InlineCompletionItem,
    InlineCompletionList,
    InlineCompletionTriggerKind: { Automatic: 0, Invoke: 1 },
    InlineCompletionEndOfLifeReasonKind: {
      Accepted: 0,
      Rejected: 1,
      Ignored: 2,
    },
    InlineCompletionsDisposeReasonKind: { Other: 4 },
    window: { visibleTextEditors: [] },
    workspace: {
      getConfiguration: () => ({ get: () => "on" }),
    },
    extensions: { getExtension: () => undefined },
  };
});

vi.mock("../../src/logger", () => ({
  authLog: { error: vi.fn() },
}));

vi.mock("../../src/chat-lib/core/nes/triggerer", () => ({
  InlineEditTriggerState: class {
    constructor(
      _config: unknown,
      emit: (change: {
        readonly reason: "selectionChange" | "activeDocumentSwitch";
        readonly uuid: string;
      }) => void,
    ) {
      state.triggerEmit = emit;
    }

    handleDocumentChange(_event: unknown): void {}

    handleSelectionChange(_event: unknown): void {}

    recordProviderTrigger(): void {}

    recordOutcome(_outcome: unknown): void {}

    recordShown(): void {}

    getState() {
      return {
        trackedDocuments: 0,
        lastTriggerTime: 0,
        lastRejectionTime: Number.NEGATIVE_INFINITY,
        lastOutcome: undefined,
      };
    }

    dispose(): void {}
  },
}));

vi.mock("../../src/completion/copilot/workspace", () => ({
  CopilotWorkspaceAdapter: class {
    readonly onDidChangeDocument = () => ({ dispose() {} });
    readonly onDidChangeSelection = () => ({ dispose() {} });
    readonly onDidCloseDocument = () => ({ dispose() {} });

    constructor() {
      state.workspaceConstructions += 1;
    }

    getState() {
      return { historyCount: 7, trackedDocuments: 1 };
    }

    fimNotebookContext() {
      return undefined;
    }

    isTracked() {
      return true;
    }

    async gatherContext() {
      return {
        current: {
          uri: "file:///workspace/main.ts",
          path: "/workspace/main.ts",
          relativePath: "main.ts",
          scheme: "file",
          languageId: "typescript",
          version: 1,
          text: "const value = 1;",
          visibleRanges: [],
          lastViewedAt: 1,
          lastEditedAt: 1,
        },
        ignored: false,
        recentDocuments: [],
        editHistory: [],
        neighborSnippets: [],
        diagnostics: [],
        promptDiagnostics: [],
        languageContext: { items: [], symbols: [] },
      };
    }

    dispose(): void {
      state.workspaceDisposals += 1;
    }
  },
}));

vi.mock("../../src/chat-lib/core/ghost-text", () => ({
  FimRecentEditsTracker: class {
    ingest() {
      return [];
    }
  },
  positionAt: (_text: string, offset: number) => ({
    line: 0,
    character: offset,
  }),
  createFimGhostTextEngine: (
    model: CompletionModel,
    options?: { behavior?: { cyclingCandidateCount?: number } },
  ) => {
    const record: FakeEngineRecord = {
      disposed: false,
      endCount: 0,
      listEndCount: 0,
      shownCount: 0,
      cyclingCandidateCount: options?.behavior?.cyclingCandidateCount,
    };
    state.engines.push(record);
    return {
      async provide(
        _request: unknown,
        token: { readonly isCancellationRequested: boolean },
      ) {
        await model.complete(
          {
            kind: "copilot-replica/fim",
            prefix: "",
            suffix: "",
            targetPath: "main.ts",
            contexts: [],
            options: {},
            metadata: { languageId: "typescript" },
          },
          {
            isCancellationRequested: token.isCancellationRequested,
            onCancellationRequested: () => ({ dispose() {} }),
          },
        );
        return {
          type: "success",
          list: {
            id: `list-${state.engines.length}`,
            items: [
              {
                id: `item-${state.engines.length}`,
                insertText: "completion",
                range: {
                  start: { line: 0, character: 0 },
                  end: { line: 0, character: 0 },
                },
                metadata: { clientCompletionId: "completion-id" },
              },
            ],
          },
        };
      },
      handleDidShowCompletionItem() {
        record.shownCount += 1;
      },
      handleEndOfLifetime() {
        record.endCount += 1;
      },
      handleListEndOfLifetime() {
        record.listEndCount += 1;
      },
      getDebugState() {
        return { cacheEntries: 0 };
      },
      dispose() {
        record.disposed = true;
      },
    };
  },
}));

vi.mock("../../src/completion/copilot/nes-provider", () => ({
  OfficialNextEditProvider: class {
    async provide() {
      return {
        branch: "nes",
        source: "llm",
        requestId: "nes-request",
        sourceRequestId: "nes-request",
        edit: {
          uri: "file:///workspace/main.ts",
          startOffset: 16,
          endOffset: 16,
          newText: "nes-completion",
          kind: "insert",
        },
        fromCache: false,
        rebased: false,
        subsequent: false,
        speculative: false,
        sourceIsSpeculative: false,
        createdAt: 1,
      };
    }

    handleShown(): void {
      state.nesShown += 1;
    }

    handleIgnored(): void {
      state.nesIgnored += 1;
    }

    handleAccepted(): void {}

    handleRejected(): void {}

    handleDidChangeChatModels(): void {
      state.nesCatalogChanges += 1;
    }

    handleAuthChange(): void {
      state.nesAuthChanges += 1;
    }

    getState() {
      return { cacheSize: 3, inFlight: 1 };
    }

    dispose(): void {
      state.nesDisposals += 1;
    }
  },
}));

vi.mock("../../src/completion/copilot/nes-item", () => ({
  convertNesSuggestionToItem: () => ({
    item: {
      insertText: "nes-completion",
      range: {
        start: { line: 0, character: 16 },
        end: { line: 0, character: 16 },
      },
      isInlineEdit: false,
      showInlineEditMenu: true,
      correlationId: "nes-request",
    },
    renderedInline: true,
  }),
}));

import * as vscode from "vscode";
import { COPILOT_BEHAVIOR_CONFIG } from "../../src/chat-lib/core/behavior-config";
import { CopilotRuntime } from "../../src/completion/copilot/runtime";

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolvePromise: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve(value): void {
      if (!resolvePromise) {
        throw new Error("Deferred promise is not initialized.");
      }
      resolvePromise(value);
    },
  };
}

class ControlledCompletionModel implements CompletionModel {
  constructor(
    private readonly onFimRequest: (
      token: vscode.CancellationToken,
    ) => Promise<void> | void = () => undefined,
  ) {}

  getCapabilities() {
    return Promise.resolve({ supportsNextCursorLinePrediction: false });
  }

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
  async complete(
    request: AlgorithmRequest,
    token: vscode.CancellationToken,
  ): Promise<AlgorithmResponse> {
    if (request.kind !== "copilot-replica/fim") {
      throw new Error(`Unexpected completion request kind "${request.kind}".`);
    }
    await this.onFimRequest(token);
    return { kind: "copilot-replica/fim", text: "completion" };
  }
}

function completionInput(): Parameters<
  CopilotRuntime["provideInlineCompletions"]
>[0] {
  const text = "const value = 1;";
  const uri = {
    scheme: "file",
    path: "/workspace/main.ts",
    fsPath: "/workspace/main.ts",
    toString: () => "file:///workspace/main.ts",
  } as vscode.Uri;
  const document = {
    uri,
    languageId: "typescript",
    version: 1,
    getText: () => text,
    offsetAt: (position: vscode.Position) => position.character,
    positionAt: (offset: number) => new vscode.Position(0, offset),
  } as vscode.TextDocument;
  return {
    document,
    position: new vscode.Position(0, text.length),
    context: {
      triggerKind: vscode.InlineCompletionTriggerKind.Invoke,
      selectedCompletionInfo: undefined,
      requestUuid: "catalog-request",
      requestIssuedDateTime: 1,
      earliestShownDateTime: 1,
    },
  };
}

function cancellationToken(): vscode.CancellationToken {
  return {
    isCancellationRequested: false,
    onCancellationRequested: () => ({ dispose() {} }),
  };
}

function controllableCancellationToken(): {
  readonly token: vscode.CancellationToken;
  cancel(): void;
} {
  let cancelled = false;
  return {
    token: {
      get isCancellationRequested(): boolean {
        return cancelled;
      },
      onCancellationRequested: () => ({ dispose() {} }),
    },
    cancel(): void {
      cancelled = true;
    },
  };
}

describe("CopilotRuntime behavior config startup validation", () => {
  it("fails before constructing the workspace adapter", () => {
    const invalid = JSON.parse(
      JSON.stringify(COPILOT_BEHAVIOR_CONFIG),
    ) as Record<string, unknown>;
    delete invalid.nextEdit;
    const context: CompletionAlgorithmContext = {
      entry: { id: "copilot", algorithm: "copilot-replica" },
      options: {},
      modelResolver: {
        async resolveCompletionModel() {
          throw new Error("not reached");
        },
      },
      reportConfigurationError() {},
    };

    expect(
      () =>
        new CopilotRuntime(
          context,
          { enableFIM: false, enableNES: false, n: 1 },
          invalid,
        ),
    ).toThrow(/nextEdit/);
    expect(state.workspaceConstructions).toBe(0);
  });

  it("preserves workspace and NES state across model catalog changes", () => {
    const context: CompletionAlgorithmContext = {
      entry: { id: "copilot", algorithm: "copilot-replica" },
      options: {},
      modelResolver: {
        async resolveCompletionModel() {
          throw new Error("not reached");
        },
      },
      reportConfigurationError() {},
    };
    const runtime = new CopilotRuntime(context, {
      enableFIM: false,
      enableNES: true,
      n: 1,
      nesModel: { vendor: "test", id: "controlled" },
    });
    const before = runtime.getState();

    runtime.handleDidChangeChatModels();
    runtime.handleDidChangeChatModels();

    const after = runtime.getState();
    expect(after.disposed).toBe(false);
    expect(after.workspace).toEqual(before.workspace);
    expect(after.nes).toEqual(before.nes);
    expect(state.nesCatalogChanges).toBe(2);
    expect(state.workspaceDisposals).toBe(0);
    expect(state.nesDisposals).toBe(0);
    runtime.dispose();
  });

  it("forwards only auth environment changes to the NES generation", () => {
    const context: CompletionAlgorithmContext = {
      entry: { id: "copilot-auth", algorithm: "copilot-replica" },
      options: {},
      modelResolver: {
        async resolveCompletionModel() {
          throw new Error("not reached");
        },
      },
      reportConfigurationError() {},
    };
    const runtime = new CopilotRuntime(context, {
      enableFIM: false,
      enableNES: true,
      n: 1,
      nesModel: { vendor: "test", id: "controlled" },
    });
    const changes: string[] = [];
    const subscription = runtime.onDidChange((change) => {
      if (change) changes.push(change.reason);
    });
    const authChangesBefore = state.nesAuthChanges;

    runtime.handleEnvironmentChange("provider-changed");
    runtime.handleEnvironmentChange("settings-changed");
    runtime.handleEnvironmentChange("auth-changed");

    expect(state.nesAuthChanges).toBe(authChangesBefore + 1);
    expect(changes).toEqual(["auth-changed"]);
    subscription.dispose();
    runtime.dispose();
  });

  it("keeps an in-flight FIM select and send alive while late models stay retired", async () => {
    state.engines.length = 0;
    const firstResolution = deferred<CompletionModel>();
    const firstSend = deferred<void>();
    let firstSendStarted = false;
    let resolutionCount = 0;
    const firstModel = new ControlledCompletionModel(async () => {
      firstSendStarted = true;
      await firstSend.promise;
    });
    const secondModel = new ControlledCompletionModel();
    const context: CompletionAlgorithmContext = {
      entry: { id: "copilot-fim", algorithm: "copilot-replica" },
      options: {},
      modelResolver: {
        async resolveCompletionModel() {
          resolutionCount += 1;
          return resolutionCount === 1
            ? await firstResolution.promise
            : secondModel;
        },
      },
      reportConfigurationError() {},
    };
    const runtime = new CopilotRuntime(context, {
      enableFIM: true,
      enableNES: false,
      n: 4,
      fimModel: { vendor: "test", id: "controlled" },
    });
    const firstRequest = runtime.provideInlineCompletions(
      completionInput(),
      cancellationToken(),
    );
    await vi.waitFor(() => expect(resolutionCount).toBe(1));

    runtime.handleDidChangeChatModels();
    firstResolution.resolve(firstModel);
    await vi.waitFor(() => expect(firstSendStarted).toBe(true));
    runtime.handleDidChangeChatModels();
    firstSend.resolve();

    const first = await firstRequest;
    expect(first?.items.map((item) => item.insertText)).toEqual(["completion"]);
    expect(state.engines).toHaveLength(1);
    expect(state.engines[0].disposed).toBe(false);
    expect(state.engines[0].cyclingCandidateCount).toBe(4);

    const second = await runtime.provideInlineCompletions(
      completionInput(),
      cancellationToken(),
    );
    expect(second?.items.map((item) => item.insertText)).toEqual([
      "completion",
    ]);
    expect(resolutionCount).toBe(2);
    expect(state.engines).toHaveLength(2);

    const firstItem = first?.items[0];
    if (!firstItem) {
      throw new Error("Expected the first FIM item.");
    }
    runtime.handleEndOfLifetime(firstItem, {
      kind: vscode.InlineCompletionEndOfLifeReasonKind.Accepted,
    });
    await Promise.resolve();
    expect(state.engines[0].endCount).toBe(1);
    expect(state.engines[0].disposed).toBe(true);
    runtime.dispose();
  });

  it("disposes a retired FIM engine when its pending caller is cancelled", async () => {
    state.engines.length = 0;
    const firstResolution = deferred<CompletionModel>();
    let resolutionCount = 0;
    let sendCount = 0;
    const model = new ControlledCompletionModel(() => {
      sendCount += 1;
    });
    const context: CompletionAlgorithmContext = {
      entry: { id: "copilot-fim", algorithm: "copilot-replica" },
      options: {},
      modelResolver: {
        async resolveCompletionModel() {
          resolutionCount += 1;
          return await firstResolution.promise;
        },
      },
      reportConfigurationError() {},
    };
    const runtime = new CopilotRuntime(context, {
      enableFIM: true,
      enableNES: false,
      n: 1,
      fimModel: { vendor: "test", id: "controlled" },
    });
    const cancellation = controllableCancellationToken();
    const pending = runtime.provideInlineCompletions(
      completionInput(),
      cancellation.token,
    );
    await vi.waitFor(() => expect(resolutionCount).toBe(1));

    runtime.handleDidChangeChatModels();
    cancellation.cancel();
    firstResolution.resolve(model);

    expect(await pending).toBeUndefined();
    expect(sendCount).toBe(0);
    await vi.waitFor(() => {
      expect(state.engines).toHaveLength(1);
      expect(state.engines[0].disposed).toBe(true);
    });
    expect(runtime.getState().disposed).toBe(false);
    runtime.dispose();
  });

  it("preserves mixed provider ownership through cycling, changes, and disposal", async () => {
    state.engines.length = 0;
    state.nesIgnored = 0;
    state.nesShown = 0;
    const model = new ControlledCompletionModel();
    const context: CompletionAlgorithmContext = {
      entry: { id: "copilot-mixed", algorithm: "copilot-replica" },
      options: {},
      modelResolver: {
        async resolveCompletionModel() {
          return model;
        },
      },
      reportConfigurationError() {},
    };
    const runtime = new CopilotRuntime(context, {
      enableFIM: true,
      enableNES: true,
      n: 1,
      fimModel: { vendor: "test", id: "fim" },
      nesModel: { vendor: "test", id: "nes" },
    });
    const changes: Array<{ readonly branch?: string }> = [];
    const subscription = runtime.onDidChange((change) => {
      if (change) {
        changes.push(change);
      }
    });

    const result = await runtime.provideInlineCompletions(
      completionInput(),
      cancellationToken(),
    );
    expect(result?.metadata?.source).toBe("mixed");
    expect(result?.items.map((item) => item.insertText)).toEqual([
      "completion",
      "nes-completion",
    ]);
    const fimItem = result?.items[0];
    const nesItem = result?.items[1];
    if (!fimItem || !nesItem) {
      throw new Error("Expected mixed FIM and NES completion items.");
    }
    expect(nesItem.showInlineEditMenu).toBe(true);

    const list = new vscode.InlineCompletionList([...result.items]);
    runtime.trackCompletionList(list, result.items);
    runtime.handleDidShowCompletionItem(fimItem, "completion");
    expect(runtime.getState().activePresentedBranch).toBe("fim");
    state.triggerEmit?.({ reason: "selectionChange", uuid: "blocked" });
    expect(changes).toEqual([]);

    runtime.handleDidShowCompletionItem(nesItem, "nes-completion");
    expect(runtime.getState().activePresentedBranch).toBe("nes");
    state.triggerEmit?.({ reason: "selectionChange", uuid: "allowed" });
    expect(changes.map((change) => change.branch)).toEqual(["nes"]);

    runtime.handleEndOfLifetime(fimItem, {
      kind: vscode.InlineCompletionEndOfLifeReasonKind.Ignored,
      supersededBy: nesItem,
      userTypingDisagreed: false,
    });
    expect(runtime.getState().activePresentedBranch).toBe("nes");
    runtime.handleDiscardedCompletionItems([nesItem], "not-taken");
    expect(runtime.getState().activePresentedBranch).toBeUndefined();
    runtime.handleListEndOfLifetime(list, {
      kind: vscode.InlineCompletionsDisposeReasonKind.Other,
    });

    expect(state.engines).toHaveLength(1);
    expect(state.engines[0]).toMatchObject({
      shownCount: 1,
      endCount: 1,
      listEndCount: 1,
    });
    expect(state.nesShown).toBe(1);
    expect(state.nesIgnored).toBe(1);
    subscription.dispose();
    runtime.dispose();
  });
});

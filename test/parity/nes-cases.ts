import "./vscode-mock";

import * as vscode from "vscode";
import { expect, vi } from "vitest";

vi.mock("../../src/i18n", () => ({
  isEnglish: () => true,
  t: (message: string) => message,
}));

import {
  COPILOT_BEHAVIOR_CONFIG,
  type CopilotBehaviorConfig,
  type NesAggressivenessLevel,
  type NesAggressivenessSetting,
  type NesEditIntent,
  type NesGlobalBudgetConfig,
  type NesPromptStrategy,
} from "../../src/chat-lib/core/behavior-config";
import {
  NextEditCache,
  type NesCacheEntry,
} from "../../src/chat-lib/core/nes/cache";
import { NesStringEdit } from "../../src/chat-lib/core/nes/string-edit";
import {
  buildOfficialNesPrompt,
  createUnifiedHistoryDiff,
  determineNesLanguageContextOptions,
  NesPromptTooLargeError,
  projectNesHistoryFocalRanges,
  runNesBudgetCascade,
} from "../../src/chat-lib/core/nes/prompt";
import {
  buildCursorPredictionPrompt,
  CURSOR_PREDICTION_CURRENT_FILE_MAX_TOKENS,
  CURSOR_PREDICTION_PROMPT_CONFIG,
  NEXT_CURSOR_PREDICTION_SYSTEM_MESSAGE,
} from "../../src/chat-lib/core/nes/cursor-predictor";
import { selectNesNeighborSnippets } from "../../src/chat-lib/core/nes/similar-files";
import { parseOfficialNesResponse } from "../support/nes-response";
import { InlineEditTriggerState } from "../../src/chat-lib/core/nes/triggerer";
import {
  getUserHappinessScore,
  NesUserInteractionMonitor,
} from "../../src/chat-lib/core/nes/user-interaction";
import {
  parseNesEditIntent,
  shouldShowNesEditIntent,
} from "../../src/chat-lib/core/nes/edit-intent";
import type {
  NesDocumentContext,
  NesHistoryContext,
  NesPromptContext,
  NesPromptHistoryEvent,
  NesTextEdit,
} from "../../src/chat-lib/core/nes/types";
import {
  CopilotContextProviderRegistry,
  type CopilotContextProviderRequest,
  type CopilotResolvedContextProviderItem,
} from "../../src/completion/copilot/context-provider";
import { createDiagnosticsContextProvider } from "../../src/completion/copilot/default-context-providers";
import {
  OfficialNextEditProvider,
  type NextEditWorkspaceAdapter,
  type NesBranchSuggestion,
} from "../../src/completion/copilot/nes-provider";
import { createCompatibleApiProvider } from "../../src/completion/api/compatible-provider";
import { ConfiguredCompletionModel } from "../../src/completion/model/completion-model";
import {
  CopilotWorkspaceAdapter,
  type CopilotWorkspaceContext,
} from "../../src/completion/copilot/workspace";
import {
  createRoutedCompletionChange,
  readRoutedCompletionChange,
} from "../../src/completion/change-hint";
import type {
  CompletionAlgorithmContext,
  CompletionAlgorithmInput,
  CompletionModelResolver,
  CompletionModelReference,
} from "../../src/completion/types";
import {
  completionInput,
  chunks,
  createCancellationSource,
  createDeferred,
  expectedFor,
  flushMicrotasks,
  makeNesPromptContext,
  ManualTriggerClock,
  offsetAtPosition,
  sequenceId,
  sha256,
  type ParityCase,
} from "./support";
import { vscodeMockState } from "./vscode-mock";

type BaseNesStrategy = Extract<
  NesPromptStrategy,
  "copilotNesXtab" | "xtab275" | "xtabUnifiedModel"
>;

function externalModelResolver(): CompletionModelResolver {
  return {
    async resolveCompletionModel(reference) {
      const models = await vscode.lm.selectChatModels({
        vendor: reference.vendor,
        id: reference.id,
      });
      const model = models.find(
        (candidate) =>
          candidate.vendor === reference.vendor &&
          candidate.id === reference.id,
      );
      if (!model) {
        throw new Error(
          `Missing completion model ${reference.vendor}/${reference.id}.`,
        );
      }
      return new ConfiguredCompletionModel({
        completion: { transport: "compatible", templates: "all" },
        resolveCompatible: async () =>
          createCompatibleApiProvider(model, { model: 'test/parity-nes' }),
        resolveCapabilities: async () => ({
          supportsNextCursorLinePrediction:
            Reflect.get(model, "supportsNextCursorLinePrediction") !== false,
        }),
      });
    },
  };
}

const strategies: readonly BaseNesStrategy[] = [
  "copilotNesXtab",
  "xtab275",
  "xtabUnifiedModel",
];

function configWithNextEdit(
  overrides: Partial<CopilotBehaviorConfig["nextEdit"]>,
): CopilotBehaviorConfig {
  return {
    ...COPILOT_BEHAVIOR_CONFIG,
    nextEdit: { ...COPILOT_BEHAVIOR_CONFIG.nextEdit, ...overrides },
  };
}

function workspaceContext(
  promptContext: NesPromptContext,
): CopilotWorkspaceContext {
  const diagnostics = promptContext.diagnostics.map((diagnostic) => ({
    ...diagnostic,
    uri: diagnostic.uri ?? promptContext.current.uri,
    path: diagnostic.path ?? promptContext.current.path,
    startCharacter: diagnostic.startCharacter ?? 0,
    endCharacter: diagnostic.endCharacter ?? diagnostic.startCharacter ?? 0,
  }));
  return {
    current: {
      ...promptContext.current,
      scheme: "file",
      visibleRanges: promptContext.current.visibleRanges ?? [],
      lastViewedAt: promptContext.current.lastViewedAt ?? 0,
      lastEditedAt: promptContext.current.lastEditedAt ?? 0,
    },
    ignored: false,
    recentDocuments: promptContext.recentDocuments.map((document) => ({
      ...document,
      scheme: "file",
      visibleRanges: document.visibleRanges ?? [],
      lastViewedAt: document.lastViewedAt ?? 0,
      lastEditedAt: document.lastEditedAt ?? 0,
    })),
    editHistory: promptContext.editHistory.map((entry) => ({
      ...entry,
      reason: entry.reason ?? "other",
      changes: entry.changes ?? [],
    })),
    neighborSnippets: (promptContext.neighborSnippets ?? []).map((snippet) => ({
      ...snippet,
      source: "open-tab" as const,
    })),
    diagnostics,
    promptDiagnostics: diagnostics,
    languageContext: {
      items: promptContext.languageContext.items ?? [],
      symbols: promptContext.languageContext.symbols ?? [],
    },
    ...(promptContext.gitDiff ? { gitDiff: promptContext.gitDiff } : {}),
  };
}

function textDocument(context: NesPromptContext): vscode.TextDocument {
  const document = context.current;
  const uri = vscode.Uri.parse(document.uri);
  const positionAt = (offset: number): vscode.Position => {
    const lines = document.text.slice(0, offset).split("\n");
    return new vscode.Position(
      lines.length - 1,
      lines[lines.length - 1].length,
    );
  };
  const lineAt = (
    lineOrPosition: number | vscode.Position,
  ): vscode.TextLine => {
    const lineNumber =
      typeof lineOrPosition === "number" ? lineOrPosition : lineOrPosition.line;
    const lines = document.text.split("\n");
    const lineText = lines[lineNumber] ?? "";
    const start = new vscode.Position(lineNumber, 0);
    const end = new vscode.Position(lineNumber, lineText.length);
    return {
      lineNumber,
      text: lineText,
      range: new vscode.Range(start, end),
      rangeIncludingLineBreak: new vscode.Range(
        start,
        lineNumber < lines.length - 1
          ? new vscode.Position(lineNumber + 1, 0)
          : end,
      ),
      firstNonWhitespaceCharacterIndex: lineText.match(/^\s*/)?.[0].length ?? 0,
      isEmptyOrWhitespace:
        (lineText.match(/^\s*/)?.[0].length ?? 0) === lineText.length,
    };
  };
  return {
    uri,
    fileName: uri.fsPath,
    isUntitled: false,
    languageId: document.languageId,
    encoding: "utf8",
    version: document.version,
    isDirty: false,
    isClosed: false,
    eol: 1,
    get lineCount() {
      return document.text.split("\n").length;
    },
    save: async () => true,
    lineAt,
    getText: (range?: vscode.Range) =>
      range
        ? document.text.slice(
            offsetAtPosition(document.text, range.start),
            offsetAtPosition(document.text, range.end),
          )
        : document.text,
    offsetAt: (position: vscode.Position) =>
      offsetAtPosition(document.text, position),
    positionAt,
    getWordRangeAtPosition: () => undefined,
    validateRange: (range) => range,
    validatePosition: (position) => position,
  };
}

function algorithmInput(
  promptContext: NesPromptContext,
  requestIssuedDateTime: number,
): CompletionAlgorithmInput {
  const selectedOffset = promptContext.current.selection?.active;
  const selectedPosition =
    selectedOffset === undefined
      ? completionInput.document.position
      : (() => {
          const prefix = promptContext.current.text.slice(0, selectedOffset);
          const lines = prefix.split("\n");
          return {
            line: lines.length - 1,
            character: lines.at(-1)?.length ?? 0,
          };
        })();
  return {
    document: textDocument(promptContext),
    position: new vscode.Position(
      selectedPosition.line,
      selectedPosition.character,
    ),
    context: {
      triggerKind: vscode.InlineCompletionTriggerKind.Invoke,
      selectedCompletionInfo: undefined,
      requestUuid: "completion-request",
      requestIssuedDateTime,
      earliestShownDateTime: requestIssuedDateTime,
    },
  };
}

interface ProviderHarness {
  readonly provider: OfficialNextEditProvider;
  readonly requests: readonly CapturedNesRequest[];
  readonly tokens: readonly vscode.CancellationToken[];
  readonly trigger: InlineEditTriggerState;
}

interface CapturedNesRequest {
  readonly messages: readonly {
    readonly role: "system" | "user";
    readonly content: string;
  }[];
  readonly modelOptions: Readonly<Record<string, unknown>>;
}

function languageModelMessageText(
  message:
    | vscode.LanguageModelChatMessage
    | vscode.LanguageModelChatMessage2,
): string {
  let text = "";
  for (const part of message.content) {
    if (part instanceof vscode.LanguageModelTextPart) {
      text += part.value;
    }
  }
  return text;
}

function chatResponse(
  text: AsyncIterable<string>,
): vscode.LanguageModelChatResponse {
  return {
    text,
    stream:
      (async function* (): vscode.LanguageModelChatResponse["stream"] {})(),
  };
}

function providerHarness(options: {
  readonly output: readonly string[];
  readonly outputProvider?: () => readonly string[];
  readonly responseProvider?: (
    request: CapturedNesRequest,
    requestIndex: number,
    token: vscode.CancellationToken | undefined,
  ) => AsyncIterable<string>;
  readonly now?: () => number;
  readonly config?: CopilotBehaviorConfig;
  readonly strategy?: NesPromptStrategy;
  readonly eagerness?: NesAggressivenessSetting;
  readonly cursorModelReference?: CompletionModelReference;
  readonly hasEditHistory?: () => boolean;
  readonly promptContext?: NesPromptContext;
  readonly promptContextProvider?: () => NesPromptContext;
}): ProviderHarness {
  const promptContext = options.promptContext ?? makeNesPromptContext();
  const currentPromptContext = () =>
    options.promptContextProvider?.() ?? promptContext;
  const gathered = () => workspaceContext(currentPromptContext());
  const requests: CapturedNesRequest[] = [];
  const tokens: vscode.CancellationToken[] = [];
  const config =
    options.config ??
    configWithNextEdit({
      requestDebounceMs: 0,
      diagnosticsStartDelayMs: 10_000,
    });
  const now =
    options.now ?? (() => completionInput.clock.requestIssuedDateTime);
  if (
    !vscodeMockState.documents.some(
      (document) => document.uri === promptContext.current.uri,
    )
  ) {
    vscodeMockState.documents.push({
      uri: promptContext.current.uri,
      version: promptContext.current.version,
      text: promptContext.current.text,
      languageId: promptContext.current.languageId,
      offsetAt: (position) =>
        offsetAtPosition(promptContext.current.text, position),
    });
  }
  const trigger = new InlineEditTriggerState(config.trigger, () => undefined, {
    now,
    setTimeout: (callback, delayMs) => {
      const handle = setTimeout(callback, delayMs);
      return { dispose: () => clearTimeout(handle) };
    },
  });
  const workspace: NextEditWorkspaceAdapter = {
    snapshot: () => gathered().current,
    hasEditHistory: options.hasEditHistory ?? (() => true),
    gatherContext: async () => gathered(),
    isDocumentIgnored: () => false,
    isDocumentIgnoredWithRules: async () => false,
    isTracked: () => true,
  };
  const model: vscode.LanguageModelChat = {
    name: "Parity NES",
    id: "nes-parity",
    vendor: "copilot",
    family: "copilot",
    version: "1",
    maxInputTokens: 128_000,
    capabilities: {
      supportsToolCalling: false,
      supportsImageToText: false,
    },
    async sendRequest(messages, requestOptions = {}, token) {
      if (token) tokens.push(token);
      const capturedRequest: CapturedNesRequest = {
        messages: messages.map((message) => ({
          role:
            message.role === vscode.LanguageModelChatMessageRole.System
              ? "system"
              : "user",
          content: languageModelMessageText(message),
        })),
        modelOptions: { ...(requestOptions.modelOptions ?? {}) },
      };
      requests.push(capturedRequest);
      return chatResponse(
        options.responseProvider?.(capturedRequest, requests.length, token) ??
          chunks(options.outputProvider?.() ?? options.output),
      );
    },
    countTokens: async (value) =>
      typeof value === "string"
        ? value.length
        : languageModelMessageText(value).length,
  };
  vscodeMockState.models.push(model);
  const algorithmContext: CompletionAlgorithmContext = {
    entry: { id: "parity", algorithm: "copilot-replica" },
    options: {},
    modelResolver: externalModelResolver(),
    reportConfigurationError: (_key, message) => {
      throw new Error(message);
    },
  };
  return {
    provider: new OfficialNextEditProvider(
      algorithmContext,
      workspace,
      trigger,
      { vendor: "copilot", id: "nes-parity" },
      options.strategy ?? "xtabUnifiedModel",
      config,
      now,
      options.cursorModelReference,
      options.eagerness,
    ),
    requests,
    tokens,
    trigger,
  };
}

function cacheEntry(
  context: NesPromptContext,
  edits: readonly NesTextEdit[],
  overrides: Partial<NesCacheEntry> = {},
): NesCacheEntry {
  return {
    documentUri: context.current.uri,
    documentText: context.current.text,
    editWindow: { startOffset: 0, endOffset: context.current.text.length },
    cursorOffset: context.cursorOffset,
    requestId: "cache-vector",
    createdAt: completionInput.clock.requestIssuedDateTime,
    edits,
    source: "llm",
    subsequentN: 0,
    speculative: false,
    rejected: false,
    wasShown: false,
    wasRenderedAsInlineSuggestion: false,
    ...overrides,
  };
}

function lifecycleSuggestion(id: string): NesBranchSuggestion {
  return {
    branch: "nes",
    source: "llm",
    requestId: id,
    sourceRequestId: id,
    fromCache: false,
    rebased: false,
    subsequent: false,
    speculative: false,
    sourceIsSpeculative: false,
    createdAt: 1_000,
  };
}

function promptFixtureDocument(
  relativePath: string,
  text: string,
  overrides: Partial<NesDocumentContext> = {},
): NesDocumentContext {
  return {
    uri: `file:///workspace/${relativePath}`,
    path: `/workspace/${relativePath}`,
    relativePath,
    languageId: "typescript",
    version: 1,
    text,
    workspaceRoot: "/workspace",
    ...overrides,
  };
}

const ordinaryPromptLines = [
  "const alpha = 1;",
  "const beta = alpha + 1;",
  "console.log(beta);",
] as const;
const ordinaryPromptText = ordinaryPromptLines.join("\n");
const ordinaryCursorOffset =
  ordinaryPromptLines[0].length + 1 + "const beta = ".length;
const multiBefore = "alpha\nbeta\ngamma\ndelta\nepsilon";
const multiAfter = "ALPHA\nbeta\nGAMMA\nDELTA\nepsilon";
const multiChanges = [
  { rangeOffset: 0, rangeLength: 5, text: "ALPHA" },
  { rangeOffset: multiBefore.indexOf("gamma"), rangeLength: 5, text: "GAMMA" },
  { rangeOffset: multiBefore.indexOf("delta"), rangeLength: 5, text: "DELTA" },
] as const;

function ordinaryPromptContext(
  current = promptFixtureDocument("src/prompt.ts", ordinaryPromptText),
  cursorOffset = ordinaryCursorOffset,
): NesPromptContext {
  const recent = promptFixtureDocument(
    "src/recent.ts",
    "export const recent = true;",
    {
      lastViewedAt: 1,
      visibleRanges: [{ start: 0, end: 27 }],
    },
  );
  const multi = promptFixtureDocument("src/multi.ts", multiAfter);
  return {
    current: {
      ...current,
      selection: {
        start: cursorOffset,
        end: cursorOffset,
        active: cursorOffset,
      },
    },
    cursorOffset,
    recentDocuments: [recent, multi],
    editHistory: [
      {
        uri: multi.uri,
        path: multi.path,
        relativePath: multi.relativePath,
        languageId: multi.languageId,
        before: multiBefore,
        after: multiAfter,
        timestamp: 2,
        reason: "other",
        changes: multiChanges,
      },
    ],
    neighborSnippets: [
      {
        uri: "file:///workspace/src/neighbor.ts",
        path: "/workspace/src/neighbor.ts",
        snippet: "export const neighborValue = alpha;",
        startLine: 0,
        score: 1,
      },
    ],
    diagnostics: [
      {
        uri: current.uri,
        path: current.path,
        message: "beta is unused",
        severity: "warning",
        startLine: 1,
        startCharacter: 6,
        endLine: 1,
        endCharacter: 10,
        source: "ts",
        code: "6133",
      },
    ],
    languageContext: {
      items: [
        {
          kind: "snippet",
          uri: "file:///workspace/src/types.ts",
          path: "/workspace/src/types.ts",
          value: "export interface Widget { id: string; }",
        },
        {
          kind: "trait",
          name: "Test framework",
          value: "Vitest",
        },
      ],
    },
  };
}

function ordinaryPromptConfig(
  overrides: Partial<CopilotBehaviorConfig["prompt"]> = {},
): CopilotBehaviorConfig {
  return {
    ...COPILOT_BEHAVIOR_CONFIG,
    prompt: {
      ...COPILOT_BEHAVIOR_CONFIG.prompt,
      recentFilesIncludeViewed: true,
      languageContextEnabled: true,
      neighborFilesEnabled: true,
      lintOptions: {
        tagName: "linter",
        warnings: "yes",
        showCode: "yesWithSurroundingLines",
        maxLints: 5,
        maxLineDistance: 10,
        nRecentFiles: 0,
      },
      ...overrides,
    },
  };
}

interface AsyncCompletionStreamResult {
  readonly cancelled: boolean;
  readonly observerAttached: boolean;
  readonly composeCount: number;
  readonly consistencyChecks: number;
  readonly composedEditRetained: boolean;
}

interface AsyncCompletionPendingResult {
  readonly order: string[];
  readonly source: string;
}

interface AsyncCompletionsExpected {
  readonly configuration: {
    readonly id: string;
    readonly type: string;
    readonly defaultValue: boolean;
    readonly strategies: Record<NesPromptStrategy, boolean>;
  };
  readonly documentChangeCancellation: {
    readonly asyncEnabled: boolean;
    readonly asyncDisabled: boolean;
  };
  readonly pendingReuse: Record<
    "unchangedAsyncDisabled" | "changedAsyncDisabled" | "changedAsyncEnabled",
    AsyncCompletionPendingResult
  >;
  readonly streamRebaseTracking: {
    readonly asyncEnabled: Omit<AsyncCompletionStreamResult, "cancelled">;
    readonly asyncDisabled: Omit<AsyncCompletionStreamResult, "cancelled">;
  };
}

function createAsyncCompletionsParityCase(): ParityCase {
  const expected = expectedFor<AsyncCompletionsExpected>(
    "nes-async-completions",
  );
  const resetScenario = (): void => {
    vscodeMockState.models.length = 0;
    vscodeMockState.documents.length = 0;
  };
  const originalText = Array.from(
    { length: 12 },
    (_value, index) => `const value${index} = ${index};`,
  ).join("\n");
  const cursorOffset =
    originalText
      .split("\n")
      .slice(0, 5)
      .reduce((total, line) => total + line.length + 1, 0) + 12;
  const insertionOffset =
    originalText.indexOf("5;", originalText.indexOf("value5")) + 1;
  const baseContext = (): NesPromptContext => {
    const base = makeNesPromptContext();
    return {
      ...base,
      current: {
        ...base.current,
        text: originalText,
        selection: {
          start: cursorOffset,
          end: cursorOffset,
          active: cursorOffset,
        },
      },
      cursorOffset,
    };
  };
  const changedContext = (context: NesPromptContext): NesPromptContext => {
    const text = `${context.current.text.slice(0, insertionOffset)}0${context.current.text.slice(insertionOffset)}`;
    return {
      ...context,
      current: {
        ...context.current,
        version: context.current.version + 1,
        text,
      },
      cursorOffset,
    };
  };
  const fireInsertion = (context: NesPromptContext, offset: number): void => {
    const document = algorithmInput(
      context,
      completionInput.clock.requestIssuedDateTime,
    ).document;
    const position = context.current.text.slice(0, offset).split("\n");
    const rangePosition = new vscode.Position(
      position.length - 1,
      position.at(-1)?.length ?? 0,
    );
    const event: vscode.TextDocumentChangeEvent = {
      document,
      reason: undefined,
      detailedReason: undefined,
      contentChanges: [
        {
          range: new vscode.Range(rangePosition, rangePosition),
          rangeOffset: offset,
          rangeLength: 0,
          text: "0",
        },
      ],
    };
    for (const listener of vscodeMockState.textDocumentChangeListeners) {
      listener(event);
    }
  };
  const streamingResponse = (
    requestText: string,
    gate: ReturnType<typeof createDeferred<void>>,
  ): AsyncIterable<string> =>
    (async function* (): AsyncIterable<string> {
      yield "<EDIT>\n";
      await gate.promise;
      const lines = requestText.split("\n").slice(3, 11);
      lines[2] = "const value5 = 500;";
      yield `${lines.join("\n")}\n</EDIT>`;
    })();
  const runStream = async (
    asyncCompletions: boolean,
  ): Promise<AsyncCompletionStreamResult> => {
    let context = baseContext();
    const gate = createDeferred<void>();
    const listenerBaseline = vscodeMockState.textDocumentChangeListeners.size;
    const harness = providerHarness({
      output: [],
      promptContext: context,
      promptContextProvider: () => context,
      config: configWithNextEdit({
        asyncCompletions,
        requestDebounceMs: 0,
        diagnosticsStartDelayMs: 10_000,
      }),
      responseProvider: () => streamingResponse(context.current.text, gate),
    });
    const pending = harness.provider.provide(
      algorithmInput(
        context,
        completionInput.clock.requestIssuedDateTime,
      ),
      createCancellationSource().token,
      false,
    );
    try {
      await vi.waitFor(() => expect(harness.requests).toHaveLength(1));
      const observerAttached =
        asyncCompletions &&
        vscodeMockState.textDocumentChangeListeners.size > listenerBaseline;
      context = changedContext(context);
      const document = vscodeMockState.documents.find(
        (candidate) => candidate.uri === context.current.uri,
      );
      if (document) {
        document.text = context.current.text;
        document.version = context.current.version;
      }
      fireInsertion(context, insertionOffset);
      const cancelled = harness.tokens[0]?.isCancellationRequested ?? false;
      gate.resolve(undefined);
      const result = await pending;
      const requestCountAfterFresh = harness.requests.length;
      const cached = asyncCompletions
        ? await harness.provider.provide(
            algorithmInput(
              context,
              completionInput.clock.requestIssuedDateTime + 1,
            ),
            createCancellationSource().token,
            false,
          )
        : undefined;
      const retained =
        asyncCompletions &&
        result === undefined &&
        harness.requests.length === requestCountAfterFresh &&
        cached?.fromCache === true &&
        cached.rebased &&
        cached.edit !== undefined;
      return {
        cancelled,
        observerAttached,
        composeCount: asyncCompletions && retained ? 1 : 0,
        consistencyChecks: asyncCompletions && retained ? 1 : 0,
        composedEditRetained: retained,
      };
    } finally {
      gate.resolve(undefined);
      harness.provider.dispose();
      resetScenario();
    }
  };
  const runPending = async (
    asyncCompletions: boolean,
    changed: boolean,
  ): Promise<AsyncCompletionPendingResult> => {
    let context = baseContext();
    const gate = createDeferred<void>();
    const harness = providerHarness({
      output: [],
      promptContext: context,
      promptContextProvider: () => context,
      config: configWithNextEdit({
        asyncCompletions,
        requestDebounceMs: 0,
        diagnosticsStartDelayMs: 10_000,
      }),
      responseProvider: () => streamingResponse(context.current.text, gate),
    });
    const first = harness.provider.provide(
      algorithmInput(
        context,
        completionInput.clock.requestIssuedDateTime,
      ),
      createCancellationSource().token,
      false,
    );
    try {
      await vi.waitFor(() => expect(harness.requests).toHaveLength(1));
      if (changed) {
        context = changedContext(context);
        const document = vscodeMockState.documents.find(
          (candidate) => candidate.uri === context.current.uri,
        );
        if (document) {
          document.text = context.current.text;
          document.version = context.current.version;
        }
        fireInsertion(context, insertionOffset);
      }
      const second = harness.provider.provide(
        algorithmInput(
          context,
          completionInput.clock.requestIssuedDateTime + 1,
        ),
        createCancellationSource().token,
        false,
      );
      await vi.waitFor(() =>
        expect(harness.requests).toHaveLength(
          changed && !asyncCompletions ? 2 : 1,
        ),
      );
      const requestCount = harness.requests.length;
      gate.resolve(undefined);
      const [, secondResult] = await Promise.all([first, second]);
      const joined = requestCount === 1;
      const rebased = joined && changed && secondResult?.edit !== undefined;
      return joined
        ? {
            order: ["join", ...(rebased ? ["rebase"] : [])],
            source: rebased ? "rebased-stream" : "pending-stream",
          }
        : { order: ["fresh"], source: "fresh-request" };
    } finally {
      gate.resolve(undefined);
      harness.provider.dispose();
      resetScenario();
    }
  };
  const streamTracking = (
    result: AsyncCompletionStreamResult,
  ): Omit<AsyncCompletionStreamResult, "cancelled"> => ({
    observerAttached: result.observerAttached,
    composeCount: result.composeCount,
    consistencyChecks: result.consistencyChecks,
    composedEditRetained: result.composedEditRetained,
  });

  return {
    id: "nes-async-completions",
    assertion:
      "async completion configuration controls streaming cancellation, reuse, and edit rebasing",
    parts: [
      {
        assertion: "pins configuration and strategy defaults",
        run() {
          expect(Object.keys(expected).sort()).toEqual([
            "configuration",
            "documentChangeCancellation",
            "pendingReuse",
            "streamRebaseTracking",
          ]);
          expect(Object.keys(expected.pendingReuse).sort()).toEqual([
            "changedAsyncDisabled",
            "changedAsyncEnabled",
            "unchangedAsyncDisabled",
          ]);
          expect({
            id: "chat.advanced.inlineEdits.asyncCompletions",
            type: "experiment-based",
            defaultValue: COPILOT_BEHAVIOR_CONFIG.nextEdit.asyncCompletions,
            strategies: Object.fromEntries(
              strategies.map((strategy) => [
                strategy,
                COPILOT_BEHAVIOR_CONFIG.nextEdit.asyncCompletions,
              ]),
            ) as Record<NesPromptStrategy, boolean>,
          }).toEqual(expected.configuration);
        },
      },
      {
        assertion: "tracks and rebases an enabled async stream",
        async run() {
          const result = await runStream(true);
          expect(result.cancelled).toBe(
            expected.documentChangeCancellation.asyncEnabled,
          );
          expect(streamTracking(result)).toEqual(
            expected.streamRebaseTracking.asyncEnabled,
          );
        },
      },
      {
        assertion: "cancels and does not track a disabled async stream",
        async run() {
          const result = await runStream(false);
          expect(result.cancelled).toBe(
            expected.documentChangeCancellation.asyncDisabled,
          );
          expect(streamTracking(result)).toEqual(
            expected.streamRebaseTracking.asyncDisabled,
          );
        },
      },
      {
        assertion: "joins an unchanged pending request when async is disabled",
        async run() {
          expect(await runPending(false, false)).toEqual(
            expected.pendingReuse.unchangedAsyncDisabled,
          );
        },
      },
      {
        assertion: "starts fresh after a change when async is disabled",
        async run() {
          expect(await runPending(false, true)).toEqual(
            expected.pendingReuse.changedAsyncDisabled,
          );
        },
      },
      {
        assertion: "rebases a changed pending request when async is enabled",
        async run() {
          expect(await runPending(true, true)).toEqual(
            expected.pendingReuse.changedAsyncEnabled,
          );
        },
      },
    ],
  };
}

export const nesCases: readonly ParityCase[] = [
  {
    id: "nes-accept-edit-window-expansion",
    assertion:
      "latest acceptance expands one fresh request and edit/no-suggestion outcomes reset it",
    async run() {
      const expected = expectedFor<{
        acceptance: { nonLatest: boolean; latest: boolean };
        freshRequest: { cold: number | null; afterLatestAcceptance: number };
        reset: { afterEdit: boolean; afterNoSuggestions: boolean };
      }>("nes-accept-edit-window-expansion");
      const base = makeNesPromptContext();
      const lines = Array.from(
        { length: 40 },
        (_value, index) => `const expansion${index} = ${index};`,
      );
      const initialText = lines.join("\n");
      const initialContext: NesPromptContext = {
        ...base,
        current: {
          ...base.current,
          uri: "file:///workspace/src/expansion-a.ts",
          path: "/workspace/src/expansion-a.ts",
          relativePath: "src/expansion-a.ts",
          text: initialText,
          selection: {
            start: initialText.indexOf("expansion5"),
            end: initialText.indexOf("expansion5"),
            active: initialText.indexOf("expansion5"),
          },
        },
        cursorOffset: initialText.indexOf("expansion5"),
      };
      let currentContext = initialContext;
      let currentOutput: readonly string[] =
        completionInput.modelOutputs.xtabUnifiedModel;
      const config = configWithNextEdit({
        requestDebounceMs: 0,
        diagnosticsStartDelayMs: 10_000,
        autoExpandEditWindowLines: expected.freshRequest.afterLatestAcceptance,
      });
      const harness = providerHarness({
        output: currentOutput,
        outputProvider: () => currentOutput,
        promptContext: initialContext,
        promptContextProvider: () => currentContext,
        config,
      });
      const first = await harness.provider.provide(
        algorithmInput(
          currentContext,
          completionInput.clock.requestIssuedDateTime,
        ),
        createCancellationSource().token,
        false,
      );
      await vi.waitFor(() =>
        expect(harness.provider.getState().inFlight).toBe(0),
      );
      const latest = await harness.provider.provide(
        algorithmInput(
          currentContext,
          completionInput.clock.requestIssuedDateTime + 1,
        ),
        createCancellationSource().token,
        false,
      );
      if (!first || !latest) throw new Error("Expected expansion suggestions.");
      const cold = harness.provider.getState().expandNextFreshRequest
        ? config.nextEdit.autoExpandEditWindowLines
        : null;
      harness.provider.handleAccepted(first);
      const nonLatest = harness.provider.getState().expandNextFreshRequest;
      harness.provider.handleAccepted(latest);
      const latestAccepted = harness.provider.getState().expandNextFreshRequest;
      const afterLatestAcceptance = latestAccepted
        ? config.nextEdit.autoExpandEditWindowLines
        : 0;
      harness.provider.dispose();
      vscodeMockState.models.length = 0;
      vscodeMockState.documents.length = 0;

      const resetAfter = async (
        output: readonly string[],
        suffix: string,
      ): Promise<boolean> => {
        let context = initialContext;
        let response = completionInput.modelOutputs.xtabUnifiedModel;
        const resetHarness = providerHarness({
          output: response,
          outputProvider: () => response,
          promptContext: context,
          promptContextProvider: () => context,
          config,
        });
        const accepted = await resetHarness.provider.provide(
          algorithmInput(
            context,
            completionInput.clock.requestIssuedDateTime,
          ),
          createCancellationSource().token,
          false,
        );
        if (!accepted) throw new Error("Expected reset seed suggestion.");
        await vi.waitFor(() =>
          expect(resetHarness.provider.getState().inFlight).toBe(0),
        );
        resetHarness.provider.handleAccepted(accepted);
        const nextText = `${initialText}\nconst ${suffix} = true;`;
        context = {
          ...initialContext,
          current: {
            ...initialContext.current,
            uri: `file:///workspace/src/${suffix}.ts`,
            path: `/workspace/src/${suffix}.ts`,
            relativePath: `src/${suffix}.ts`,
            version: initialContext.current.version + 1,
            text: nextText,
          },
          cursorOffset: initialContext.cursorOffset,
        };
        vscodeMockState.documents.push({
          uri: context.current.uri,
          version: context.current.version,
          text: context.current.text,
          languageId: context.current.languageId,
          offsetAt: (position) =>
            offsetAtPosition(context.current.text, position),
        });
        response = output;
        await resetHarness.provider.provide(
          algorithmInput(
            context,
            completionInput.clock.requestIssuedDateTime + 2,
          ),
          createCancellationSource().token,
          false,
        );
        await vi.waitFor(() =>
          expect(resetHarness.provider.getState().inFlight).toBe(0),
        );
        const expanded =
          resetHarness.provider.getState().expandNextFreshRequest;
        resetHarness.provider.dispose();
        vscodeMockState.models.length = 0;
        vscodeMockState.documents.length = 0;
        return expanded;
      };
      const output = {
        acceptance: { nonLatest, latest: latestAccepted },
        freshRequest: { cold, afterLatestAcceptance },
        reset: {
          afterEdit: await resetAfter(
            completionInput.modelOutputs.xtabUnifiedModel,
            "after-edit",
          ),
          afterNoSuggestions: await resetAfter(["<NO_CHANGE>"], "after-empty"),
        },
      };
      expect(output).toEqual(expected);
    },
  },
  createAsyncCompletionsParityCase(),
  {
    id: "nes-transport-prompt",
    assertion:
      "provider emits exact official prompt bytes, request options, and parsed edit",
    async run() {
      const expected = expectedFor<{
        roles: string[];
        messages: Array<{ role: "system" | "user"; content: string }>;
        strategyMessages: Record<
          NesPromptStrategy,
          { system: string; user: string }
        >;
        adaptivePromptMessages: unknown;
        adaptiveInteraction: {
          windows: {
            aggressiveness: Array<{ kind: string }>;
            lastActionWasAcceptance: boolean;
          };
          happiness: unknown;
          levels: unknown;
        };
        editIntent: unknown;
        prediction: string;
      }>("nes-transport-prompt");
      const promptContext = ordinaryPromptContext();
      const config = ordinaryPromptConfig();
      const harness = providerHarness({
        output: completionInput.modelOutputs.xtabUnifiedModel,
        strategy: "xtabUnifiedModel",
        promptContext,
        config: {
          ...config,
          nextEdit: {
            ...config.nextEdit,
            requestDebounceMs: 0,
            diagnosticsStartDelayMs: 10_000,
          },
        },
      });
      const result = await harness.provider.provide(
        algorithmInput(
          promptContext,
          completionInput.clock.requestIssuedDateTime,
        ),
        createCancellationSource().token,
        false,
      );

      expect(harness.requests).toHaveLength(1);
      const request = harness.requests[0];
      expect(request.messages.map((message) => message.role)).toEqual(
        expected.roles,
      );
      expect(request.messages).toEqual(expected.messages);
      for (const strategy of strategies) {
        expect(
          buildOfficialNesPrompt(promptContext, strategy, config).messages,
        ).toEqual(expected.strategyMessages[strategy]);
      }
      const adaptiveStrategies = [
        "xtabAggressiveness",
        "xtab275Aggressiveness",
        "xtab275AggressivenessHighLow",
        "xtab275EditIntent",
        "xtab275EditIntentShort",
      ] as const;
      const levels: readonly NesAggressivenessLevel[] = [
        "low",
        "medium",
        "high",
      ];
      const adaptivePromptMessages = Object.fromEntries(
        adaptiveStrategies.map((strategy) => [
          strategy,
          Object.fromEntries(
            levels.map((level) => [
              level,
              buildOfficialNesPrompt(promptContext, strategy, config, {
                aggressivenessLevel: level,
              }).messages,
            ]),
          ),
        ]),
      );
      expect(adaptivePromptMessages).toEqual(expected.adaptivePromptMessages);

      const interactionClock = { now: () => 1_000 };
      const retained = new NesUserInteractionMonitor(
        COPILOT_BEHAVIOR_CONFIG.nextEdit,
        "auto",
        interactionClock,
      );
      for (let index = 0; index < 35; index += 1) {
        retained.handleAcceptance();
      }
      retained.handleIgnored();
      const retainedState = retained.getState();
      const actions = (kind: "accepted" | "rejected") =>
        Array.from({ length: 10 }, () => ({ kind }));
      const localLevel = (
        setting: NesAggressivenessSetting,
        kinds: readonly ("accepted" | "rejected")[],
      ): unknown => {
        const monitor = new NesUserInteractionMonitor(
          COPILOT_BEHAVIOR_CONFIG.nextEdit,
          setting,
          interactionClock,
        );
        for (const kind of kinds) {
          if (kind === "accepted") monitor.handleAcceptance();
          else monitor.handleRejection();
        }
        const value = monitor.getAggressivenessLevel();
        return value.userHappinessScore === undefined
          ? { aggressivenessLevel: value.aggressivenessLevel }
          : value;
      };
      const adaptiveInteraction = {
        windows: {
          aggressiveness: retainedState.aggressivenessActions,
          lastActionWasAcceptance: retainedState.wasLastActionAcceptance,
        },
        happiness: {
          neutral: getUserHappinessScore(
            [],
            COPILOT_BEHAVIOR_CONFIG.nextEdit.userHappinessScore,
          ),
          accepted: getUserHappinessScore(
            actions("accepted"),
            COPILOT_BEHAVIOR_CONFIG.nextEdit.userHappinessScore,
          ),
          rejected: getUserHappinessScore(
            actions("rejected"),
            COPILOT_BEHAVIOR_CONFIG.nextEdit.userHappinessScore,
          ),
        },
        levels: {
          neutral: localLevel("auto", []),
          accepted: localLevel(
            "auto",
            actions("accepted").map((item) => item.kind),
          ),
          rejected: localLevel(
            "auto",
            actions("rejected").map((item) => item.kind),
          ),
          explicitLow: localLevel(
            "low",
            actions("accepted").map((item) => item.kind),
          ),
        },
      };
      expect(adaptiveInteraction).toEqual({
        windows: {
          aggressiveness:
            expected.adaptiveInteraction.windows.aggressiveness.map(
              ({ kind }) => ({ kind }),
            ),
          lastActionWasAcceptance:
            expected.adaptiveInteraction.windows.lastActionWasAcceptance,
        },
        happiness: expected.adaptiveInteraction.happiness,
        levels: expected.adaptiveInteraction.levels,
      });

      const intentLines = (values: readonly string[]) =>
        (async function* (): AsyncIterable<string> {
          for (const value of values) yield value;
        })();
      const summarizeIntent = async (
        mode: "tags" | "shortName",
        values: readonly string[],
      ) => {
        const parsed = await parseNesEditIntent(intentLines(values), mode);
        const remainingLines: string[] = [];
        for await (const line of parsed.remainingLines) {
          remainingLines.push(line);
        }
        return {
          editIntent: parsed.editIntent,
          parseError: parsed.parseError ?? null,
          remainingLines,
        };
      };
      const intents: readonly NesEditIntent[] = [
        "no_edit",
        "low",
        "medium",
        "high",
      ];
      const editIntent = {
        tags: {
          valid: await summarizeIntent("tags", [
            "prefix<|edit_intent|> Medium <|/edit_intent|> first",
            "second",
          ]),
          unknown: await summarizeIntent("tags", [
            "<|edit_intent|>maybe<|/edit_intent|>",
            "code",
          ]),
          malformed: await summarizeIntent("tags", [
            "<|edit_intent|>low",
            "code",
          ]),
          empty: await summarizeIntent("tags", []),
        },
        short: {
          valid: await summarizeIntent("shortName", ["L", "code"]),
          invalid: await summarizeIntent("shortName", ["l", "code"]),
        },
        matrix: Object.fromEntries(
          intents.map((intent) => [
            intent,
            Object.fromEntries(
              levels.map((level) => [
                level,
                shouldShowNesEditIntent(intent, level),
              ]),
            ),
          ]),
        ),
      };
      expect(editIntent).toEqual(expected.editIntent);
      expect(request.modelOptions).toEqual({
        prediction: { type: "content", content: expected.prediction },
      });
      expect(Object.keys(request.modelOptions)).toEqual(["prediction"]);
      expect(result?.prompt?.strategy).toBe("xtabUnifiedModel");
      expect(result?.edit).toMatchObject({
        kind: "insert",
        newText: " + STEP",
        startOffset: promptContext.cursorOffset,
        endOffset: promptContext.cursorOffset,
      });
      expect(
        (request.modelOptions["prediction"] as { content: string }).content,
      ).toBe(expected.prediction);
      harness.provider.dispose();
    },
  },
  {
    id: "nes-cursor-prediction-prompt",
    assertion:
      "dedicated cursor prompt bytes, clipping, diagnostics, traits, and request limits match the reviewed effect baseline",
    run() {
      const expected = expectedFor<{
        lintOptions: typeof CURSOR_PREDICTION_PROMPT_CONFIG.lintOptions;
        messages: Array<{ role: "system" | "user"; content: string }>;
        keptRange: { start: number; endExclusive: number };
        currentFile: {
          maxTokens: number;
          sourceLineCount: number;
          clipped: boolean;
          firstNumberedLine: string;
          lastNumberedLine: string;
        };
        signals: {
          defaultDiagnosticBytes: string;
          hasDefaultDiagnostic: boolean;
          hasRecentSnippet: boolean;
          hasLanguageTrait: boolean;
          hasOrdinaryPostScript: boolean;
        };
        model: {
          name: string;
          chatCompletions: { max_tokens: number };
          responses: { max_tokens: number };
        };
        crossFileResolution: {
          authorityA: string;
          authorityB: string;
          distinctAuthoritiesRemainDistinct: boolean;
        };
      }>("nes-cursor-prediction-prompt");
      const base = makeNesPromptContext();
      const cursorLines = Array.from(
        { length: expected.currentFile.sourceLineCount },
        (_value, index) =>
          `const cursorPredictionLine${index} = sharedContext + "cursor-prediction-context-${index}";`,
      );
      const cursorLine = 250;
      const cursorText = cursorLines.join("\n");
      const cursorOffset =
        cursorLines
          .slice(0, cursorLine)
          .reduce((total, line) => total + line.length + 1, 0) + 12;
      const context: NesPromptContext = {
        current: {
          ...base.current,
          uri: "file:///workspace/src/cursor-prediction.ts",
          path: "/workspace/src/cursor-prediction.ts",
          relativePath: "src/cursor-prediction.ts",
          text: cursorText,
          selection: {
            start: cursorOffset,
            end: cursorOffset,
            active: cursorOffset,
          },
        },
        cursorOffset,
        recentDocuments: [
          {
            ...base.current,
            uri: "file:///workspace/src/recent.ts",
            path: "/workspace/src/recent.ts",
            relativePath: "src/recent.ts",
            text: "export const recent = true;",
            visibleRanges: [{ start: 0, end: 27 }],
            lastViewedAt: completionInput.clock.requestIssuedDateTime,
          },
          {
            ...base.current,
            uri: "file:///workspace/src/multi.ts",
            path: "/workspace/src/multi.ts",
            relativePath: "src/multi.ts",
            text: "ALPHA\nbeta\nGAMMA\nDELTA\nepsilon",
            visibleRanges: [{ start: 0, end: 36 }],
            lastViewedAt: completionInput.clock.requestIssuedDateTime - 1,
          },
        ],
        editHistory: [
          {
            uri: "file:///workspace/src/multi.ts",
            path: "/workspace/src/multi.ts",
            relativePath: "src/multi.ts",
            languageId: "typescript",
            before: "alpha\nbeta\ngamma\ndelta\nepsilon",
            after: "ALPHA\nbeta\nGAMMA\nDELTA\nepsilon",
            timestamp: completionInput.clock.requestIssuedDateTime,
            reason: "other",
            changes: multiChanges,
          },
        ],
        diagnostics: [
          {
            message: "controlled cursor diagnostic",
            severity: "error",
            startLine: cursorLine,
            startCharacter: 6,
            endLine: cursorLine,
            endCharacter: 20,
            source: "ts",
            code: "CURSOR001",
          },
        ],
        languageContext: {
          items: [
            {
              kind: "snippet",
              uri: "file:///workspace/src/types.ts",
              path: "/workspace/src/types.ts",
              value: "export interface Widget { id: string; }",
            },
            {
              kind: "trait",
              name: "Cursor trait",
              value: "dedicated prompt",
            },
          ],
          symbols: [],
        },
        neighborSnippets: [
          {
            uri: "file:///workspace/src/neighbor.ts",
            path: "/workspace/src/neighbor.ts",
            snippet: "export const neighborValue = alpha;",
            startLine: 0,
          },
        ],
      };
      const cursorBehavior = ordinaryPromptConfig();
      const currentPrompt = buildOfficialNesPrompt(
        context,
        "xtabUnifiedModel",
        cursorBehavior,
      );
      const result = buildCursorPredictionPrompt(context, currentPrompt, {
        behaviorConfig: cursorBehavior,
        areaAroundEditWindow: {
          start: cursorLine - 15,
          endExclusive: cursorLine + 16,
        },
      });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(`Cursor prompt failed: ${result.reason}`);
      const prompt = result.prompt;
      expect(CURSOR_PREDICTION_PROMPT_CONFIG.lintOptions).toEqual(
        expected.lintOptions,
      );
      expect(prompt.messages).toEqual(expected.messages);
      expect(prompt.messages[0].content).toBe(
        NEXT_CURSOR_PREDICTION_SYSTEM_MESSAGE,
      );
      expect(prompt.keptRange).toEqual(expected.keptRange);
      expect(CURSOR_PREDICTION_CURRENT_FILE_MAX_TOKENS).toBe(
        expected.currentFile.maxTokens,
      );
      expect(cursorLines).toHaveLength(expected.currentFile.sourceLineCount);
      expect(
        prompt.keptRange.start > 0 &&
          prompt.keptRange.endExclusive < cursorLines.length,
      ).toBe(expected.currentFile.clipped);
      expect(prompt.currentFileContent.split("\n")[0]).toBe(
        expected.currentFile.firstNumberedLine,
      );
      expect(prompt.currentFileContent.split("\n").at(-1)).toBe(
        expected.currentFile.lastNumberedLine,
      );
      const diagnosticBytes =
        prompt.messages[1].content.match(
          /<\|linter\|>[\s\S]*?<\|\/linter\|>/,
        )?.[0] ?? "";
      expect(diagnosticBytes).toBe(expected.signals.defaultDiagnosticBytes);
      expect(prompt.messages[1].content.includes(diagnosticBytes)).toBe(
        expected.signals.hasDefaultDiagnostic,
      );
      expect(
        prompt.messages[1].content.includes("export const recent = true;"),
      ).toBe(expected.signals.hasRecentSnippet);
      expect(
        prompt.messages[1].content.includes("Cursor trait: dedicated prompt"),
      ).toBe(expected.signals.hasLanguageTrait);
      expect(
        prompt.messages[1].content.includes(
          "The developer was working on a section of code within the tags",
        ),
      ).toBe(expected.signals.hasOrdinaryPostScript);
      expect(
        COPILOT_BEHAVIOR_CONFIG.nextEdit.cursorPrediction.maxResponseTokens,
      ).toBe(expected.model.chatCompletions.max_tokens);

      const resolveTarget = (authority: string) =>
        vscode.Uri.joinPath(
          vscode.Uri.parse(`vscode-remote://${authority}/workspace/project`),
          "src/target.ts",
        ).toString();
      const authorityA = resolveTarget("ssh-remote+host-a");
      const authorityB = resolveTarget("ssh-remote+host-b");
      expect({
        authorityA,
        authorityB,
        distinctAuthoritiesRemainDistinct: authorityA !== authorityB,
      }).toEqual(expected.crossFileResolution);
    },
  },
  {
    id: "nes-diagnostics-context-provider",
    assertion:
      "production resolver preserves fixed gating, immediate empty primary resolution, fresh fallback sampling, whole-range ordering, cap, and exact trait bytes",
    async run() {
      vi.useFakeTimers();
      const expected = expectedFor<{
        primary: readonly unknown[];
        disabledLanguage: readonly unknown[];
        enabledTraits: readonly {
          readonly name: string;
          readonly value: string;
        }[];
        languageContextOptions: {
          readonly enableAll: {
            readonly enabled: boolean;
            readonly maxTokens: number;
            readonly traitPosition: "before" | "after";
          };
          readonly explicitFalse: {
            readonly enabled: boolean;
            readonly maxTokens: number;
            readonly traitPosition: "before" | "after";
          };
        };
      }>("nes-diagnostics-context-provider");
      expect(createDiagnosticsContextProvider()).toBeUndefined();

      const behavior: CopilotBehaviorConfig = {
        ...COPILOT_BEHAVIOR_CONFIG,
        diagnosticsContextProvider: {
          enabled: true,
          enabledLanguages: { typescript: true },
        },
      };
      expect(
        determineNesLanguageContextOptions("typescript", behavior),
      ).toEqual(expected.languageContextOptions.enableAll);
      const explicitlyDisabled: CopilotBehaviorConfig = {
        ...behavior,
        prompt: {
          ...behavior.prompt,
          languageContextEnabledLanguages: { typescript: false },
        },
      };
      expect(
        determineNesLanguageContextOptions("typescript", explicitlyDisabled),
      ).toEqual(expected.languageContextOptions.explicitFalse);

      const text = Array.from(
        { length: 12 },
        (_value, index) => `line ${index}`,
      ).join("\n");
      const offsetAt = (position: {
        readonly line: number;
        readonly character: number;
      }): number =>
        text
          .split("\n")
          .slice(0, position.line)
          .reduce((total, line) => total + line.length + 1, 0) +
        position.character;
      vscodeMockState.documents.push({
        uri: "file:///workspace/src/counter.ts",
        version: 1,
        text,
        languageId: "typescript",
        offsetAt,
      });
      const document = vscode.workspace.textDocuments[0];
      if (!document) throw new Error("Diagnostics parity document is missing.");
      const position = new vscode.Position(4, 2);
      const request: CopilotContextProviderRequest = {
        completionId: "diagnostics-parity",
        opportunityId: "diagnostics-parity",
        documentContext: {
          uri: document.uri.toString(),
          languageId: document.languageId,
          version: document.version,
          offset: document.offsetAt(position),
          position,
        },
        activeExperiments: new Map(),
        timeBudget: 150,
        timeoutEnd: 150,
        source: "nes",
      };
      const disabledProvider = createDiagnosticsContextProvider({
        ...behavior,
        diagnosticsContextProvider: {
          enabled: true,
          enabledLanguages: {},
        },
      });
      if (!disabledProvider) {
        throw new Error("Disabled-language diagnostics provider is missing.");
      }
      expect(disabledProvider.resolver.resolveOnTimeout?.(request)).toEqual(
        expected.disabledLanguage,
      );

      vscodeMockState.diagnostics.push(
        {
          message: "stable-left",
          severity: 1,
          source: "eslint",
          code: "W1",
          start: { line: 4, character: 0 },
          end: { line: 4, character: 2 },
        },
        {
          message: "stable-right",
          severity: 2,
          code: "",
          start: { line: 6, character: 3 },
          end: { line: 6, character: 5 },
        },
        {
          message: "closest",
          severity: 0,
          source: "ts",
          code: 6133,
          start: { line: 5, character: 1 },
          end: { line: 5, character: 4 },
        },
        {
          message: "top-boundary",
          severity: 1,
          code: "",
          start: { line: 2, character: 0 },
          end: { line: 2, character: 1 },
        },
        {
          message: "bottom-boundary",
          severity: 0,
          code: "",
          start: { line: 9, character: 0 },
          end: { line: 9, character: 1 },
        },
        {
          message: "crosses-top",
          severity: 0,
          code: "",
          start: { line: 1, character: 0 },
          end: { line: 2, character: 1 },
        },
        {
          message: "crosses-bottom",
          severity: 0,
          code: "",
          start: { line: 9, character: 0 },
          end: { line: 10, character: 1 },
        },
      );
      const provider = createDiagnosticsContextProvider(behavior);
      if (!provider) throw new Error("Diagnostics parity provider is missing.");
      await expect(
        provider.resolver.resolve(request, createCancellationSource().token),
      ).resolves.toEqual(expected.primary);
      const registry = new CopilotContextProviderRegistry({ timeoutMs: 150 });
      registry.register(provider, ["nes"]);
      let settled = false;
      const pending = registry.resolve(
        {
          target: "nes",
          document,
          offset: document.offsetAt(position),
          completionId: "diagnostics-parity",
        },
        createCancellationSource().token,
      );
      void pending.then(() => {
        settled = true;
      });

      await flushMicrotasks(10);
      expect(settled).toBe(true);
      const resolved = await pending;

      expect(resolved).toHaveLength(1);
      expect(resolved[0]).toMatchObject({
        providerId: "diagnostics-context-provider",
        resolution: "full",
        onTimeout: true,
      });
      expect(resolved[0]?.item).toMatchObject(expected.enabledTraits[0] ?? {});
      expect(resolved[0]?.item).not.toHaveProperty("importance");
      registry.dispose();
    },
  },
  {
    id: "nes-language-context-deadline",
    assertion:
      "production NES registry and workspace preserve settle-or-deadline fallback, partial snapshots, late continuation, cancellation, freshness, language gating, and base context",
    async run() {
      vi.useFakeTimers();
      vi.setSystemTime(1_000);
      const expected = expectedFor<{
        onlyDiagnostics: {
          elapsedMs: number;
          items: readonly {
            readonly value: string;
            readonly onTimeout: boolean;
          }[];
          fallbackCalls: number;
          request: { readonly timeBudget: number; readonly timeoutEnd: number };
        };
        settledBeforeDeadline: {
          elapsedMs: number;
          items: readonly {
            readonly value: string;
            readonly onTimeout: boolean;
          }[];
          fallbackCalls: number;
        };
        deadline: {
          elapsedMs: number;
          itemsAtReturn: readonly {
            readonly value: string;
            readonly onTimeout: boolean;
          }[];
          fallbackCalls: number;
          providerTokenCancelled: boolean;
          latePrimarySideEffect: boolean;
          raceBudgets: readonly number[];
          request: { readonly timeBudget: number; readonly timeoutEnd: number };
        };
        freshFallback: readonly string[];
        parentCancellation: {
          result: null;
          tokenCancelled: boolean;
          fallbackCalls: number;
        };
      }>("nes-language-context-deadline");
      const createBackingDocument = (
        uri: string,
        text: string,
      ): (typeof vscodeMockState.documents)[number] => {
        const document: (typeof vscodeMockState.documents)[number] = {
          uri,
          version: 1,
          text,
          languageId: "typescript",
          offsetAt: (position) =>
            document.text
              .split("\n")
              .slice(0, position.line)
              .reduce((total, line) => total + line.length + 1, 0) +
            position.character,
        };
        return document;
      };
      const resolvedSummary = (
        items: readonly CopilotResolvedContextProviderItem[],
      ) =>
        items.map((item) => ({
          value: "value" in item.item ? item.item.value : "",
          onTimeout: item.onTimeout,
        }));
      const resolvedValue = (
        item: CopilotResolvedContextProviderItem | undefined,
      ): string | undefined =>
        item && "value" in item.item ? item.item.value : undefined;

      const registryDocumentBacking = createBackingDocument(
        "untitled:/deadline-registry.ts",
        "value\n",
      );
      vscodeMockState.documents.push(registryDocumentBacking);
      const registryDocument = vscode.workspace.textDocuments[0];
      if (!registryDocument) {
        throw new Error("Deadline parity registry document is missing.");
      }

      let settledFallbackCalls = 0;
      let settledRequest: CopilotContextProviderRequest | undefined;
      let settledToken: vscode.CancellationToken | undefined;
      const settledRegistry = new CopilotContextProviderRegistry({
        enabledProviderIds: ["deadline-settled"],
      });
      settledRegistry.register(
        {
          id: "deadline-settled",
          selector: "typescript",
          resolver: {
            resolve: async (request, token) => {
              settledRequest = request;
              settledToken = token;
              return [
                {
                  id: "settled-primary",
                  name: "Settled primary",
                  value: "settled-primary",
                },
              ];
            },
            resolveOnTimeout: () => {
              settledFallbackCalls += 1;
              return {
                id: "settled-fallback",
                name: "Settled fallback",
                value: "settled-fallback",
              };
            },
          },
        },
        ["nes"],
      );
      const settledStartedAt = Date.now();
      const settledItems = await settledRegistry.resolve(
        {
          target: "nes",
          document: registryDocument,
          offset: 0,
          timeoutEndMs: 1_040,
        },
        createCancellationSource().token,
      );
      expect({
        elapsedMs: Date.now() - settledStartedAt,
        items: resolvedSummary(settledItems),
        fallbackCalls: settledFallbackCalls,
      }).toEqual(expected.settledBeforeDeadline);
      expect(settledRequest).toMatchObject(expected.onlyDiagnostics.request);
      expect(settledToken?.isCancellationRequested).toBe(false);
      settledRegistry.dispose();

      let freshFallbackInvocation = 0;
      const freshRegistry = new CopilotContextProviderRegistry({
        enabledProviderIds: ["deadline-fresh"],
      });
      freshRegistry.register(
        {
          id: "deadline-fresh",
          selector: "typescript",
          resolver: {
            resolve: async () => [],
            resolveOnTimeout: () => ({
              id: `fresh-${freshFallbackInvocation + 1}`,
              name: "Fresh fallback",
              value: `fresh-${++freshFallbackInvocation}`,
            }),
          },
        },
        ["nes"],
      );
      const freshInput = {
        target: "nes" as const,
        document: registryDocument,
        offset: 0,
        completionId: "same-completion",
        timeoutEndMs: 1_040,
      };
      const freshFirst = await freshRegistry.resolve(
        freshInput,
        createCancellationSource().token,
      );
      const freshSecond = await freshRegistry.resolve(
        freshInput,
        createCancellationSource().token,
      );
      expect([
        resolvedValue(freshFirst[0]),
        resolvedValue(freshSecond[0]),
      ]).toEqual(expected.freshFallback);
      freshRegistry.dispose();

      let cancelledFallbackCalls = 0;
      let cancelledProviderToken: vscode.CancellationToken | undefined;
      const cancelledRegistry = new CopilotContextProviderRegistry({
        enabledProviderIds: ["deadline-cancelled"],
      });
      cancelledRegistry.register(
        {
          id: "deadline-cancelled",
          selector: "typescript",
          resolver: {
            resolve: (_request, token) => {
              cancelledProviderToken = token;
              return new Promise(() => undefined);
            },
            resolveOnTimeout: () => {
              cancelledFallbackCalls += 1;
              return { name: "Cancelled fallback", value: "must-not-run" };
            },
          },
        },
        ["nes"],
      );
      const cancellation = new vscode.CancellationTokenSource();
      const cancelledPending = cancelledRegistry.resolve(
        {
          target: "nes",
          document: registryDocument,
          offset: 0,
          timeoutEndMs: 1_040,
        },
        cancellation.token,
      );
      await flushMicrotasks();
      cancellation.cancel();
      const cancelledItems = await cancelledPending;
      expect({
        result: cancelledItems.length === 0 ? null : cancelledItems,
        tokenCancelled:
          cancelledProviderToken?.isCancellationRequested ?? false,
        fallbackCalls: cancelledFallbackCalls,
      }).toEqual(expected.parentCancellation);
      cancellation.dispose();
      cancelledRegistry.dispose();

      vi.setSystemTime(2_000);
      vscodeMockState.documents.splice(
        0,
        vscodeMockState.documents.length,
        createBackingDocument("untitled:/disabled.ts", "disabled\n"),
      );
      let disabledResolverCalls = 0;
      const disabledAdapter = new CopilotWorkspaceAdapter(() => Date.now(), {
        resolve: async () => {
          disabledResolverCalls += 1;
          return [];
        },
      });
      const disabledDocument = vscode.workspace.textDocuments[0];
      if (!disabledDocument) {
        throw new Error("Language-disabled parity document is missing.");
      }
      const disabledContext = await disabledAdapter.gatherContext(
        disabledDocument,
        createCancellationSource().token,
        0,
        {
          target: "nes",
          timeoutEndMs: 2_040,
          includeLanguageContext: false,
        },
      );
      expect(disabledResolverCalls).toBe(0);
      expect(disabledContext.current.text).toBe("disabled\n");
      expect(disabledContext.ignored).toBe(false);
      expect(disabledContext.languageContext.items).toEqual([]);
      disabledAdapter.dispose();

      vi.setSystemTime(3_000);
      const currentBacking = createBackingDocument(
        "untitled:/deadline-current.ts",
        "value\n",
      );
      const recentBacking = createBackingDocument(
        "untitled:/deadline-recent.ts",
        "recent\n",
      );
      vscodeMockState.documents.splice(
        0,
        vscodeMockState.documents.length,
        currentBacking,
        recentBacking,
      );
      const lateRelease = createDeferred<void>();
      let lateSideEffect = false;
      let deadlineFallbackCalls = 0;
      let deadlineProviderToken: vscode.CancellationToken | undefined;
      let deadlineRequest: CopilotContextProviderRequest | undefined;
      const deadlineRegistry = new CopilotContextProviderRegistry({
        enabledProviderIds: ["deadline-partial"],
      });
      deadlineRegistry.register(
        {
          id: "deadline-partial",
          selector: "typescript",
          resolver: {
            resolve: async function* (request, token) {
              deadlineRequest = request;
              deadlineProviderToken = token;
              yield {
                id: "deadline-partial",
                name: "Deadline partial",
                value: "deadline-partial",
              };
              await lateRelease.promise;
              lateSideEffect = true;
              yield {
                id: "late-primary",
                name: "Late primary",
                value: "late-primary",
              };
            },
            resolveOnTimeout: () => {
              deadlineFallbackCalls += 1;
              return {
                id: "deadline-fallback",
                name: "Deadline fallback",
                value: "deadline-fallback",
              };
            },
          },
        },
        ["nes"],
      );
      const deadlineAdapter = new CopilotWorkspaceAdapter(
        () => Date.now(),
        deadlineRegistry,
      );
      const initialCurrentDocument = vscode.workspace.textDocuments[0];
      if (!initialCurrentDocument) {
        throw new Error("Deadline workspace document is missing.");
      }
      currentBacking.text = "updated\n";
      currentBacking.version += 1;
      const changedCurrentDocument = vscode.workspace.textDocuments[0];
      if (!changedCurrentDocument) {
        throw new Error("Changed deadline workspace document is missing.");
      }
      for (const listener of vscodeMockState.textDocumentChangeListeners) {
        listener({
          document: changedCurrentDocument,
          contentChanges: [
            {
              range: new vscode.Range(
                new vscode.Position(0, 0),
                new vscode.Position(0, 5),
              ),
              rangeOffset: 0,
              rangeLength: 5,
              text: "updated",
            },
          ],
          reason: undefined,
          detailedReason: undefined,
        });
      }
      let workspaceSettled = false;
      const workspacePending = deadlineAdapter
        .gatherContext(
          changedCurrentDocument,
          createCancellationSource().token,
          0,
          {
            target: "nes",
            completionId: "deadline-workspace",
            timeoutEndMs: 3_040,
            includeLanguageContext: true,
          },
        )
        .then((context) => {
          workspaceSettled = true;
          return context;
        });
      await flushMicrotasks(10);
      await vi.advanceTimersByTimeAsync(39);
      expect(workspaceSettled).toBe(false);
      expect(deadlineFallbackCalls).toBe(0);
      await vi.advanceTimersByTimeAsync(1);
      const workspaceContext = await workspacePending;
      const workspaceItemsAtReturn = workspaceContext.languageContext.items.map(
        (item) => ({ value: item.value, onTimeout: item.onTimeout ?? false }),
      );
      expect({
        elapsedMs: Date.now() - 3_000,
        itemsAtReturn: workspaceItemsAtReturn,
        fallbackCalls: deadlineFallbackCalls,
        providerTokenCancelled:
          deadlineProviderToken?.isCancellationRequested ?? false,
        raceBudgets: [deadlineRequest?.timeBudget],
        request: {
          timeBudget: deadlineRequest?.timeBudget,
          timeoutEnd: deadlineRequest?.timeoutEnd,
        },
      }).toEqual({
        elapsedMs: expected.deadline.elapsedMs,
        itemsAtReturn: expected.deadline.itemsAtReturn,
        fallbackCalls: expected.deadline.fallbackCalls,
        providerTokenCancelled: expected.deadline.providerTokenCancelled,
        raceBudgets: expected.deadline.raceBudgets,
        request: expected.deadline.request,
      });
      expect(workspaceContext.ignored).toBe(false);
      expect(workspaceContext.current.text).toBe("updated\n");
      expect(workspaceContext.editHistory).toHaveLength(1);
      expect(workspaceContext.editHistory[0]).toMatchObject({
        before: "value\n",
        after: "updated\n",
      });
      expect(
        workspaceContext.recentDocuments.map((document) => document.uri),
      ).toContain(recentBacking.uri);
      lateRelease.resolve(undefined);
      await flushMicrotasks(10);
      expect(lateSideEffect).toBe(expected.deadline.latePrimarySideEffect);
      expect(
        workspaceContext.languageContext.items.map((item) => item.value),
      ).toEqual(expected.deadline.itemsAtReturn.map((item) => item.value));
      deadlineAdapter.dispose();
      deadlineRegistry.dispose();
    },
  },
  {
    id: "nes-system-prompt-strategy",
    assertion: "each strategy selects the reviewed pinned system prompt",
    run() {
      const expected = expectedFor<{
        prompts: Record<BaseNesStrategy, string>;
      }>("nes-system-prompt-strategy");
      for (const strategy of strategies) {
        const prompt = buildOfficialNesPrompt(makeNesPromptContext(), strategy);
        expect(prompt.messages.system).toBe(expected.prompts[strategy]);
      }
    },
  },
  {
    id: "nes-system-prompt-bytes",
    assertion:
      "all pinned system prompt bytes retain reviewed hashes and lengths",
    run() {
      const expected = expectedFor<{
        sha256: Record<BaseNesStrategy, string>;
        lengths: Record<BaseNesStrategy, number>;
      }>("nes-system-prompt-bytes");
      const prompts = expectedFor<{
        prompts: Record<BaseNesStrategy, string>;
      }>("nes-system-prompt-strategy").prompts;
      expect(strategies).toHaveLength(Object.keys(expected.sha256).length);
      for (const strategy of strategies) {
        const actual = prompts[strategy];
        expect(sha256(actual)).toBe(expected.sha256[strategy]);
        expect(actual).toHaveLength(expected.lengths[strategy]);
        expect(
          buildOfficialNesPrompt(makeNesPromptContext(), strategy).messages
            .system,
        ).toBe(actual);
      }
    },
  },
  {
    id: "nes-prompt-message-bytes",
    assertion:
      "ordinary, long, lint, over-budget, and cascade prompt behavior matches the reviewed effect baseline",
    run() {
      const expected = expectedFor<{
        messages: Record<NesPromptStrategy, { system: string; user: string }>;
        longPrompt: Record<
          BaseNesStrategy,
          {
            system: string;
            user: string;
            currentFileLines: string[];
          }
        >;
        overBudget: Record<
          BaseNesStrategy,
          { isError: boolean; error: string }
        >;
        budgetCascade: {
          trace: Array<{
            part: string;
            allocatedTokens: number;
            consumedTokens: number;
            remainingTokens: number;
            cascadesToNextPart: boolean;
          }>;
          finalSurplus: number;
        };
      }>("nes-prompt-message-bytes");
      const context = ordinaryPromptContext();
      const config = ordinaryPromptConfig();
      for (const strategy of strategies) {
        expect(
          buildOfficialNesPrompt(context, strategy, config).messages,
        ).toEqual(expected.messages[strategy]);
      }

      const longLines = Array.from(
        { length: 240 },
        (_value, index) =>
          `const longIdentifier${index} = sharedValue + ${index};`,
      );
      const longText = longLines.join("\n");
      const longCursorOffset =
        longLines
          .slice(0, 120)
          .reduce((total, line) => total + line.length + 1, 0) + 12;
      const longContext = ordinaryPromptContext(
        promptFixtureDocument("src/prompt.ts", longText),
        longCursorOffset,
      );
      for (const strategy of strategies) {
        const longPrompt = buildOfficialNesPrompt(
          longContext,
          strategy,
          ordinaryPromptConfig({
            currentFileTokens: 500,
            lintOptions: undefined,
          }),
        );
        expect(longPrompt.messages).toEqual({
          system: expected.longPrompt[strategy].system,
          user: expected.longPrompt[strategy].user,
        });
        const currentSection = longPrompt.messages.user
          .split("<|current_file_content|>\n")[1]
          ?.split("\n<|/current_file_content|>")[0]
          ?.split("\n")
          .slice(1);
        expect(currentSection).toEqual(
          expected.longPrompt[strategy].currentFileLines,
        );

        expect(expected.overBudget[strategy]).toEqual({
          isError: true,
          error: "outOfBudget",
        });
        let overBudgetError: unknown;
        try {
          buildOfficialNesPrompt(
            context,
            strategy,
            ordinaryPromptConfig({
              currentFileTokens: 1,
              lintOptions: undefined,
            }),
          );
        } catch (error) {
          overBudgetError = error;
        }
        expect(overBudgetError).toBeInstanceOf(NesPromptTooLargeError);
        expect(overBudgetError).toMatchObject({
          name: "NesPromptTooLargeError",
          part: "currentFile",
        });
      }

      const globalBudget: NesGlobalBudgetConfig = {
        totalTokens: 100,
        order: [
          "recentlyViewedDocuments",
          "languageContext",
          "neighborFiles",
          "diffHistory",
        ],
        shares: {
          currentFile: 0.2,
          recentlyViewedDocuments: 0.2,
          languageContext: 0.2,
          neighborFiles: 0.2,
          diffHistory: 0.2,
        },
      };
      const consumed = {
        recentlyViewedDocuments: 10,
        languageContext: 8,
        neighborFiles: 6,
        diffHistory: 4,
      } as const;
      expect(
        runNesBudgetCascade(globalBudget, (part) => consumed[part]),
      ).toEqual(expected.budgetCascade);
    },
  },
  {
    id: "nes-recent-history",
    assertion:
      "mixed viewed/edit recency and multi-edit focal projections match official history functions",
    run() {
      const expected = expectedFor<{
        includeViewedTimeline: Array<{
          docId: string;
          kind: string;
          marker: string;
        }>;
        editOnlyTimeline: Array<{
          docId: string;
          kind: string;
          marker: string;
        }>;
        groupedTimeline: Array<{ docId: string; markers: string[] }>;
        focalRanges: Array<{ start: number; endExclusive: number }>;
        editEntryCount: number;
      }>("nes-recent-history");
      const current = promptFixtureDocument("src/current.ts", "current");
      const eventDocument = (relativePath: string, marker: string) => ({
        uri: `file:///workspace/${relativePath}`,
        path: relativePath,
        relativePath,
        languageId: "typescript",
        text: marker,
      });
      const editEvent = (
        relativePath: string,
        marker: string,
        timestamp: number,
      ): NesPromptHistoryEvent => {
        const document = eventDocument(relativePath, marker);
        return {
          kind: "edit",
          ...document,
          before: `old-${marker}`,
          after: marker,
          timestamp,
          reason: "other",
        };
      };
      const viewedEvent = (
        relativePath: string,
        marker: string,
        timestamp: number,
      ): NesPromptHistoryEvent => ({
        kind: "visibleRanges",
        ...eventDocument(relativePath, marker),
        timestamp,
        visibleRanges: [{ start: 0, end: marker.length }],
      });
      const historyEvents: NesPromptHistoryEvent[] = [
        editEvent("src/a.ts", "a-old", 1),
        viewedEvent("src/b.ts", "b-view", 2),
        editEvent("src/a.ts", "a-edit", 3),
        viewedEvent("src/a.ts", "a-view", 4),
        editEvent("src/c.ts", "c-edit", 5),
      ];
      const timelineContext: NesPromptContext = {
        current,
        cursorOffset: 0,
        recentDocuments: [],
        editHistory: [],
        historyEvents,
        diagnostics: [],
        languageContext: {},
      };
      const promptPaths = (includeViewed: boolean): string[] =>
        [
          ...buildOfficialNesPrompt(
            timelineContext,
            "xtab275",
            ordinaryPromptConfig({
              recentFilesIncludeViewed: includeViewed,
              languageContextEnabled: false,
              neighborFilesEnabled: false,
              lintOptions: undefined,
            }),
          ).messages.user.matchAll(/code_snippet_file_path: ([^\n]+)/g),
        ].map((match) => match[1]);
      expect(promptPaths(true)).toEqual(
        expected.includeViewedTimeline.map((entry) => entry.docId).reverse(),
      );
      expect(promptPaths(false)).toEqual(
        expected.editOnlyTimeline.map((entry) => entry.docId).reverse(),
      );
      expect(expected.groupedTimeline).toEqual([
        { docId: "src/c.ts", markers: ["c-edit"] },
        { docId: "src/a.ts", markers: ["a-view", "a-edit", "a-old"] },
        { docId: "src/b.ts", markers: ["b-view"] },
      ]);

      const olderBefore = "abcdefghijklmnopqrstuvwxyz0123456789";
      const olderChanges = [
        { rangeOffset: 2, rangeLength: 2, text: "YY" },
        { rangeOffset: 20, rangeLength: 2, text: "ZZ" },
      ];
      const olderAfter =
        `${olderBefore.slice(0, 2)}YY${olderBefore.slice(4, 20)}` +
        `ZZ${olderBefore.slice(22)}`;
      const older: NesHistoryContext = {
        uri: "file:///workspace/src/a.ts",
        path: "src/a.ts",
        languageId: "typescript",
        before: olderBefore,
        after: olderAfter,
        timestamp: 1,
        changes: olderChanges,
      };
      const newer: NesHistoryContext = {
        uri: older.uri,
        path: older.path,
        languageId: older.languageId,
        before: olderAfter,
        after: `xxx${olderAfter}`,
        timestamp: 2,
        changes: [{ rangeOffset: 0, rangeLength: 0, text: "xxx" }],
      };
      expect(projectNesHistoryFocalRanges([newer, older])).toEqual(
        expected.focalRanges,
      );
      expect(expected.editEntryCount).toBe(2);
    },
  },
  {
    id: "nes-similar-file-selection",
    assertion:
      "fixed-window Jaccard neighbor snippets match the official module output exactly",
    run() {
      const expected = expectedFor<{
        snippets: Array<{
          relativePath: string;
          snippet: string;
          score: number;
          startLine: number;
          endLine: number;
        }>;
      }>("nes-similar-file-selection");
      const referenceLines = Array.from(
        { length: 60 },
        (_value, index) => `needle${index}`,
      );
      const current = promptFixtureDocument(
        "src/current.ts",
        ["outsideCursorWindow", ...referenceLines].join("\n"),
      );
      const documents = [
        promptFixtureDocument(
          "src/exact.ts",
          [
            ...Array.from({ length: 5 }, (_value, index) => `noise${index}`),
            ...referenceLines,
          ].join("\n"),
        ),
        promptFixtureDocument("src/partial.ts", "needle0"),
        promptFixtureDocument("src/wrong-case.ts", "NEEDLE0"),
      ];
      const actual = selectNesNeighborSnippets(
        current,
        current.text.length,
        documents,
      ).map((snippet) => ({
        relativePath: snippet.path,
        snippet: snippet.snippet,
        score: snippet.score,
        startLine: snippet.startLine,
        endLine: snippet.startLine + snippet.snippet.split("\n").length,
      }));
      expect(actual).toEqual(expected.snippets);
    },
  },
  {
    id: "nes-diff-history",
    assertion:
      "multi-location replacements retain official adjacent grouping and disjoint hunks",
    run() {
      const expected = expectedFor<{ diff: string }>("nes-diff-history");
      expect(
        createUnifiedHistoryDiff({
          uri: "file:///workspace/src/multi.ts",
          path: "/workspace/src/multi.ts",
          languageId: "typescript",
          before: multiBefore,
          after: multiAfter,
          timestamp: 1,
          changes: multiChanges,
        }),
      ).toBe(expected.diff);
    },
  },
  {
    id: "nes-response-formats",
    assertion:
      "unified insert/no-change/divergence and custom patch parse to frozen edits",
    async run() {
      const expected = expectedFor<{
        insertNewLines: string[];
        noChangeKind: string;
        invalidKind: string;
        invalidMessage: string;
      }>("nes-response-formats");
      const context = makeNesPromptContext();
      const prompt = buildOfficialNesPrompt(context, "xtabUnifiedModel");
      const inserted = await parseOfficialNesResponse(
        chunks(completionInput.modelOutputs.xtabUnifiedModel),
        "xtabUnifiedModel",
        prompt,
        context.current,
        context.recentDocuments,
      );
      const currentLine =
        prompt.editWindow.lines[prompt.editWindow.cursorLineOffset];
      const insertedEdit = inserted.edits[0];
      expect(
        `${currentLine.slice(0, prompt.editWindow.cursorColumn)}${insertedEdit.newText}${currentLine.slice(prompt.editWindow.cursorColumn)}`,
      ).toBe(expected.insertNewLines[0]);
      const noChange = await parseOfficialNesResponse(
        chunks(["<NO_CHANGE>"]),
        "xtabUnifiedModel",
        prompt,
        context.current,
        context.recentDocuments,
      );
      expect(noChange.noChange).toBe(true);
      expect(expected.noChangeKind).toBe("NoSuggestions");
      const reasons: string[] = [];
      const invalid = await parseOfficialNesResponse(
        chunks(["<invalid>\nignored"]),
        "xtabUnifiedModel",
        prompt,
        context.current,
        context.recentDocuments,
        (reason) => reasons.push(reason),
      );
      expect(invalid.noChange).toBe(true);
      expect(reasons[0]).toContain(
        expected.invalidMessage.match(/<[^>]+>/)?.[0],
      );
      expect(expected.invalidKind).toBe("Unexpected");
    },
  },
  {
    id: "nes-cache-rebase-filter",
    assertion:
      "provider rejection filtering and cached source patch attribution match the frozen vector",
    run() {
      const expected = expectedFor<{
        rejectedResult: null;
        rejectedEditCount: number;
        sourcePatchIndex: {
          exact: number;
          rebased: number;
          missingRebaseIndex: null;
        };
      }>("nes-cache-rebase-filter");
      const context = makeNesPromptContext();
      const rejectedEdit: NesTextEdit = {
        uri: context.current.uri,
        startOffset: context.cursorOffset,
        endOffset: context.cursorOffset,
        newText: "XYZ",
        kind: "insert",
        patchIndex: 2,
      };
      const rejectedCache = new NextEditCache(10);
      rejectedCache.put(cacheEntry(context, [rejectedEdit]));
      rejectedCache.markRejected("cache-vector");
      const rejectedLookup = rejectedCache.lookup(
        context.current.uri,
        context.current.text,
        context.cursorOffset,
      );
      const rejectedResult = rejectedLookup?.entry.rejected
        ? null
        : (rejectedLookup?.edit ?? null);
      const rejectedEditCount = rejectedCache.isRejected(
        context.current.uri,
        context.current.text,
        rejectedEdit,
      )
        ? 1
        : 0;

      const rebasedEdit: NesTextEdit = {
        uri: context.current.uri,
        startOffset: context.cursorOffset,
        endOffset: context.cursorOffset,
        newText: "XYZ",
        kind: "insert",
        patchIndex: 7,
      };
      const rebaseConfig = {
        absorbSubsequenceTyping: true,
        reverseAgreement: true,
        maxImperfectAgreementLength: 1,
      };
      const typedText = `${context.current.text.slice(0, context.cursorOffset)}X${context.current.text.slice(context.cursorOffset)}`;
      const rebasedCache = new NextEditCache(10, rebaseConfig);
      const userEditSince = NesStringEdit.fromDiff(
        context.current.text,
        typedText,
      );
      rebasedCache.put(cacheEntry(context, [rebasedEdit], { userEditSince }));
      const rebasedLookup = rebasedCache.lookup(
        context.current.uri,
        typedText,
        context.cursorOffset + 1,
      );

      const missingPatchCache = new NextEditCache(10, rebaseConfig);
      missingPatchCache.put(
        cacheEntry(context, [{ ...rebasedEdit, patchIndex: undefined }], {
          userEditSince,
        }),
      );
      const missingPatchLookup = missingPatchCache.lookup(
        context.current.uri,
        typedText,
        context.cursorOffset + 1,
      );

      expect({
        rejectedResult,
        rejectedEditCount,
        sourcePatchIndex: {
          exact: rejectedLookup?.edit?.patchIndex ?? null,
          rebased: rebasedLookup?.edit?.patchIndex ?? null,
          missingRebaseIndex: missingPatchLookup?.edit?.patchIndex ?? null,
        },
      }).toEqual(expected);
    },
  },
  {
    id: "nes-history-context",
    assertion:
      "recent files, edit history, git diff, and undo filtering reach prompt bytes",
    run() {
      const expected = expectedFor<{
        documentPaths: string[];
        budgetCalls: number[];
      }>("nes-history-context");
      const base = makeNesPromptContext();
      const recent = base.recentDocuments[0];
      const context: NesPromptContext = {
        ...base,
        editHistory: [
          {
            uri: recent.uri,
            path: recent.relativePath ?? recent.uri,
            languageId: "typescript",
            before: "",
            after: recent.text,
            timestamp: completionInput.clock.requestIssuedDateTime,
            reason: "other",
          },
          ...base.editHistory,
        ],
      };
      const user = buildOfficialNesPrompt(context, "xtabUnifiedModel").messages
        .user;
      for (const path of expected.documentPaths) expect(user).toContain(path);
      expect(expected.budgetCalls).toEqual([5, 4]);
    },
  },
  {
    id: "nes-trigger-state-machine",
    assertion:
      "selection debounce, line/rejection cooldowns, and document switch are deterministic",
    run() {
      const expected = expectedFor<{
        reasons: string[];
        debounceMs: number;
        sameLineBlocked: boolean;
        rejectionBlocked: boolean;
        documentSwitch: boolean;
        documentSwitchReasons: string[];
      }>("nes-trigger-state-machine");
      const clock = new ManualTriggerClock(1_000);
      const changes: string[] = [];
      const state = new InlineEditTriggerState(
        COPILOT_BEHAVIOR_CONFIG.trigger,
        (change) => changes.push(change.reason),
        clock,
        sequenceId("trigger"),
      );
      const documentIdentity = {};
      state.handleDocumentChange({
        uri: "file:///a.ts",
        scheme: "file",
        documentIdentity,
        reason: "other",
        isTracked: true,
      });
      state.recordProviderTrigger();
      const select = (
        uri: string,
        line: number,
        identity = documentIdentity,
      ): void =>
        state.handleSelectionChange({
          uri,
          scheme: "file",
          documentIdentity: identity,
          isNotebookCell: false,
          selectionCount: 1,
          isEmpty: true,
          line,
          isTracked: true,
        });
      select("file:///a.ts", 1);
      select("file:///a.ts", 2);
      select("file:///a.ts", 3);
      clock.advance(expected.debounceMs - 1);
      expect(changes).toHaveLength(2);
      clock.advance(1);
      select("file:///a.ts", 1);
      expect(expected.sameLineBlocked).toBe(true);
      expect(changes).toHaveLength(3);
      state.recordOutcome("rejected");
      select("file:///a.ts", 4);
      expect(expected.rejectionBlocked).toBe(true);
      expect(changes).toHaveLength(3);
      clock.advance(COPILOT_BEHAVIOR_CONFIG.trigger.rejectionCooldownMs);
      state.recordOutcome("accepted");
      state.recordProviderTrigger();
      select("file:///b.ts", 0, {});
      expect(expected.documentSwitch).toBe(true);
      expect(changes).toEqual([
        ...expected.reasons,
        ...expected.documentSwitchReasons,
      ]);
      state.dispose();
    },
  },
  {
    id: "nes-change-hint",
    assertion:
      "routed changes preserve the trigger UUID, reason, and target branch",
    run() {
      const expected = expectedFor<{
        hint: { data: { uuid: string; reason: string } };
      }>("nes-change-hint");
      const routed = createRoutedCompletionChange("copilot", {
        reason: expected.hint.data.reason,
        branch: "nes",
        data: expected.hint,
      });
      const parsed = readRoutedCompletionChange({
        triggerKind: vscode.InlineCompletionTriggerKind.Invoke,
        selectedCompletionInfo: undefined,
        requestUuid: "change-hint-parity",
        requestIssuedDateTime: 0,
        earliestShownDateTime: 0,
        changeHint: { data: routed },
      });
      expect(parsed).toEqual(routed);
      expect(parsed?.change?.data).toEqual(expected.hint);
    },
  },
  {
    id: "nes-diagnostics-race",
    assertion:
      "diagnostics waits 50ms then beats an empty LLM result with exact edit",
    async run() {
      const expected = expectedFor<{
        winner: string;
        editText: { edit: string };
        diagnosticsStartDelayMs: number;
        deadlineDelayMs: number;
      }>("nes-diagnostics-race");
      vi.useFakeTimers();
      vi.setSystemTime(1_000);
      const baseContext = makeNesPromptContext();
      const diagnosticStart = completionInput.document.position;
      const diagnosticEnd = {
        line: diagnosticStart.line,
        character: diagnosticStart.character + "STEP".length,
      };
      const insertionOffset = offsetAtPosition(
        baseContext.current.text,
        diagnosticStart,
      );
      const context: NesPromptContext = {
        ...baseContext,
        current: {
          ...baseContext.current,
          version: baseContext.current.version + 1,
          text: `${baseContext.current.text.slice(0, insertionOffset)}STEP${baseContext.current.text.slice(insertionOffset)}`,
          selection: {
            start: insertionOffset + "STEP".length,
            end: insertionOffset + "STEP".length,
            active: insertionOffset + "STEP".length,
          },
        },
        cursorOffset: insertionOffset + "STEP".length,
      };
      vscodeMockState.codeAction = {
        uri: context.current.uri,
        start: { line: 0, character: 0 },
        end: { line: 0, character: 0 },
        newText: expected.editText.edit,
      };
      vscodeMockState.codeActionTitle = "Add import from './math'";
      vscodeMockState.diagnostics.push({
        message: "Cannot find name STEP.",
        code: "2304",
        severity: 0,
        start: diagnosticStart,
        end: diagnosticEnd,
      });
      const harness = providerHarness({
        output: ["<NO_CHANGE>"],
        promptContext: baseContext,
        promptContextProvider: () => context,
        config: configWithNextEdit({
          requestDebounceMs: 0,
          diagnosticsStartDelayMs: expected.diagnosticsStartDelayMs,
        }),
        now: Date.now,
      });
      const storedDocument = vscodeMockState.documents.find(
        (document) => document.uri === context.current.uri,
      );
      if (!storedDocument) {
        throw new Error("Diagnostics parity document was not registered.");
      }
      storedDocument.text = context.current.text;
      storedDocument.version = context.current.version;
      storedDocument.offsetAt = (position) =>
        offsetAtPosition(storedDocument.text, position);
      const providerInput = algorithmInput(context, Date.now());
      const insertionPosition = new vscode.Position(
        diagnosticStart.line,
        diagnosticStart.character,
      );
      const recentRange = new vscode.Range(
        insertionPosition,
        insertionPosition,
      );
      for (const listener of vscodeMockState.diagnosticChangeListeners) {
        listener({ uris: [providerInput.document.uri] });
      }
      for (const listener of vscodeMockState.textDocumentChangeListeners) {
        listener({
          document: providerInput.document,
          reason: undefined,
          detailedReason: undefined,
          contentChanges: [
            {
              range: recentRange,
              rangeOffset: insertionOffset,
              rangeLength: 0,
              text: "STEP",
            },
          ],
        });
      }
      let settled = false;
      const pending = harness.provider
        .provide(providerInput, createCancellationSource().token, false)
        .then((value) => {
          settled = true;
          return value;
        });
      await flushMicrotasks(8);
      await vi.advanceTimersByTimeAsync(expected.diagnosticsStartDelayMs - 1);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(harness.provider.getState().diagnostics).toMatchObject({
        lastComputation: "suggestion",
        lastValidity: "current",
      });
      const result = await pending;
      expect(settled).toBe(true);
      expect(result?.source).toBe(expected.winner);
      expect(result?.edit?.newText).toBe(expected.editText.edit);
      expect(COPILOT_BEHAVIOR_CONFIG.nextEdit.diagnosticsRaceDeadlineMs).toBe(
        expected.deadlineDelayMs,
      );
      harness.provider.dispose();
      vi.useRealTimers();
    },
  },
  {
    id: "nes-lifecycle",
    assertion:
      "shown/accepted/rejected/ignored update interaction and trigger state",
    run() {
      const expected = expectedFor<{
        outcomes: string[];
        interactionKinds: string[];
        lastRejectionTime: number;
        triggerOutcome: string;
      }>("nes-lifecycle");
      const now = () => 10_000;
      const harness = providerHarness({ output: [], now });
      const outcomes: string[] = [];
      const accepted = lifecycleSuggestion("accepted");
      harness.provider.handleShown(accepted, true);
      harness.provider.handleAccepted(accepted);
      outcomes.push(harness.provider.getState().lastOutcome ?? "missing");
      const rejected = lifecycleSuggestion("rejected");
      harness.provider.handleShown(rejected, false);
      harness.provider.handleRejected(rejected);
      outcomes.push(harness.provider.getState().lastOutcome ?? "missing");
      const ignored = lifecycleSuggestion("ignored");
      harness.provider.handleShown(ignored, false);
      harness.provider.handleIgnored(ignored);
      outcomes.push(harness.provider.getState().lastOutcome ?? "missing");
      expect(outcomes).toEqual(expected.outcomes);
      expect(
        harness.provider
          .getState()
          .userInteraction.aggressivenessActions.map((action) => action.kind),
      ).toEqual(expected.interactionKinds);
      expect(harness.provider.getState().lastRejectionTime).toBe(
        expected.lastRejectionTime,
      );
      expect(harness.trigger.getState().lastOutcome).toBe(
        expected.triggerOutcome,
      );
      harness.provider.dispose();
    },
  },
];

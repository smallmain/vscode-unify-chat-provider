import type * as vscode from "vscode";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const vscodeState = vi.hoisted(() => ({
  documents: [] as vscode.TextDocument[],
  activeEditor: undefined as vscode.TextEditor | undefined,
  openListeners: new Set<(document: vscode.TextDocument) => void>(),
  changeListeners: new Set<(event: vscode.TextDocumentChangeEvent) => void>(),
  diagnosticListeners: new Set<(event: vscode.DiagnosticChangeEvent) => void>(),
  selectionListeners: new Set<
    (event: vscode.TextEditorSelectionChangeEvent) => void
  >(),
  activeEditorListeners: new Set<
    (editor: vscode.TextEditor | undefined) => void
  >(),
  closeListeners: new Set<(document: vscode.TextDocument) => void>(),
  diagnosticsReads: 0,
  models: [] as vscode.LanguageModelChat[],
  selectors: [] as vscode.LanguageModelChatSelector[],
  selectHandler: undefined as
    | ((
        selector: vscode.LanguageModelChatSelector,
      ) => Promise<readonly vscode.LanguageModelChat[]>)
    | undefined,
  openableDocuments: new Map<string, vscode.TextDocument>(),
  openFailures: new Set<string>(),
  openHandlers: new Map<string, () => Promise<vscode.TextDocument>>(),
  openCalls: [] as string[],
  documentsReadHook: undefined as (() => void) | undefined,
}));

vi.mock("vscode", () => {
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

    contains(position: Position): boolean {
      return position.line >= this.start.line && position.line <= this.end.line;
    }

    isEqual(other: Range): boolean {
      return (
        this.start.line === other.start.line &&
        this.start.character === other.start.character &&
        this.end.line === other.end.line &&
        this.end.character === other.end.character
      );
    }
  }

  class Uri {
    static parse(value: string): Uri {
      return new Uri(value);
    }

    static joinPath(base: Uri, ...parts: string[]): Uri {
      return new Uri(
        new URL(parts.join("/"), `${base.toString()}/`).toString(),
      );
    }

    static file(path: string): Uri {
      return new Uri(`file://${path.startsWith("/") ? "" : "/"}${path}`);
    }

    readonly scheme: string;
    readonly authority: string;
    readonly path: string;
    readonly fsPath: string;

    constructor(private readonly value: string) {
      const parsed = new URL(value);
      this.scheme = parsed.protocol.slice(0, -1);
      this.authority = parsed.host;
      this.path = parsed.pathname;
      this.fsPath = parsed.pathname;
    }

    toString(): string {
      return this.value;
    }
  }

  class CancellationTokenSource {
    private cancelled = false;
    private readonly listeners = new Set<() => void>();
    readonly token: vscode.CancellationToken;

    constructor() {
      const owner = this;
      this.token = {
        get isCancellationRequested(): boolean {
          return owner.cancelled;
        },
        onCancellationRequested: (listener, thisArgs, disposables) => {
          const callback = (): void => listener.call(thisArgs, undefined);
          owner.listeners.add(callback);
          const disposable: vscode.Disposable = {
            dispose: () => {
              owner.listeners.delete(callback);
            },
          };
          disposables?.push(disposable);
          return disposable;
        },
      };
    }

    cancel(): void {
      if (this.cancelled) {
        return;
      }
      this.cancelled = true;
      for (const listener of [...this.listeners]) {
        listener();
      }
      this.listeners.clear();
    }

    dispose(): void {
      this.listeners.clear();
    }
  }

  class LanguageModelTextPart {
    constructor(readonly value: string) {}
  }

  class LanguageModelChatMessage {
    static User(content: string): LanguageModelChatMessage {
      return new LanguageModelChatMessage(1, content);
    }

    readonly content: LanguageModelTextPart[];
    readonly name = undefined;

    constructor(
      readonly role: number,
      content: string,
    ) {
      this.content = [new LanguageModelTextPart(content)];
    }
  }

  const subscribe =
    <T>(listeners: Set<(value: T) => void>) =>
    (listener: (value: T) => void) => {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    };

  return {
    Position,
    Range,
    Uri,
    env: { language: "en" },
    l10n: { t: (message: string) => message },
    CancellationTokenSource,
    LanguageModelTextPart,
    LanguageModelChatMessage,
    LanguageModelChatMessageRole: { User: 1, Assistant: 2, System: 3 },
    InlineCompletionTriggerKind: { Invoke: 0, Automatic: 1 },
    DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
    CodeActionKind: {
      QuickFix: { value: "quickfix", contains: () => true },
    },
    FileType: { Directory: 2 },
    languages: {
      getDiagnostics: () => {
        vscodeState.diagnosticsReads += 1;
        return [];
      },
      onDidChangeDiagnostics: subscribe(vscodeState.diagnosticListeners),
    },
    commands: { executeCommand: async () => [] },
    lm: {
      selectChatModels: async (selector: vscode.LanguageModelChatSelector) => {
        vscodeState.selectors.push(selector);
        if (vscodeState.selectHandler) {
          return await vscodeState.selectHandler(selector);
        }
        return vscodeState.models.filter(
          (model) =>
            (selector.vendor === undefined ||
              model.vendor === selector.vendor) &&
            (selector.id === undefined || model.id === selector.id),
        );
      },
    },
    window: {
      get activeTextEditor() {
        return vscodeState.activeEditor;
      },
      onDidChangeActiveTextEditor: subscribe(vscodeState.activeEditorListeners),
      onDidChangeTextEditorSelection: subscribe(vscodeState.selectionListeners),
    },
    workspace: {
      getConfiguration: () => ({
        get: (_key: string, fallback: unknown) => fallback,
      }),
      get textDocuments() {
        const hook = vscodeState.documentsReadHook;
        vscodeState.documentsReadHook = undefined;
        hook?.();
        return vscodeState.documents;
      },
      workspaceFolders: [],
      fs: { readDirectory: async () => [] },
      onDidOpenTextDocument: subscribe(vscodeState.openListeners),
      onDidChangeTextDocument: subscribe(vscodeState.changeListeners),
      onDidCloseTextDocument: subscribe(vscodeState.closeListeners),
      openTextDocument: async (uri: Uri) => {
        const key = uri.toString();
        vscodeState.openCalls.push(key);
        if (vscodeState.openFailures.has(key)) {
          throw new Error(`Cannot open ${key}`);
        }
        const handler = vscodeState.openHandlers.get(key);
        if (handler) {
          const handled = await handler();
          if (!vscodeState.documents.includes(handled)) {
            vscodeState.documents.push(handled);
          }
          return handled;
        }
        const document =
          vscodeState.documents.find(
            (candidate) => candidate.uri.toString() === key,
          ) ?? vscodeState.openableDocuments.get(key);
        if (!document) throw new Error(`Missing document ${key}`);
        if (!vscodeState.documents.includes(document)) {
          vscodeState.documents.push(document);
        }
        return document;
      },
    },
  };
});

import * as vscodeApi from "vscode";
import { COPILOT_BEHAVIOR_CONFIG } from "../../src/chat-lib/core/behavior-config";
import { InlineEditTriggerState } from "../../src/chat-lib/core/nes/triggerer";
import { NesUserInteractionMonitor } from "../../src/chat-lib/core/nes/user-interaction";
import { OfficialNextEditProvider } from "../../src/completion/copilot/nes-provider";
import { createCompatibleApiProvider } from "../../src/completion/api/compatible-provider";
import { ConfiguredCompletionModel } from "../../src/completion/model/completion-model";
import { scheduleCompletionProviders } from "../../src/completion/scheduler";
import type {
  NextEditWorkspaceAdapter,
  NesBranchSuggestion,
} from "../../src/completion/copilot/nes-provider";
import type {
  CopilotBehaviorConfig,
  NesAggressivenessSetting,
  NesPromptStrategy,
} from "../../src/chat-lib/core/behavior-config";
import type {
  CompletionAlgorithmContext,
  CompletionAlgorithmInput,
  CompletionModelCapabilities,
  CompletionModelResolver,
  CompletionModelReference,
} from "../../src/completion/types";
import type {
  CopilotWorkspaceContext,
  CopilotWorkspaceContextRequest,
} from "../../src/completion/copilot/workspace";

interface MutableDocument {
  readonly document: vscode.TextDocument;
  setText(text: string): void;
}

function offsetAt(text: string, position: vscode.Position): number {
  const lines = text.split("\n");
  return (
    lines
      .slice(0, position.line)
      .reduce((total, line) => total + line.length + 1, 0) + position.character
  );
}

function positionAt(text: string, offset: number): vscode.Position {
  const before = text.slice(0, offset).split("\n");
  return new vscodeApi.Position(
    before.length - 1,
    before[before.length - 1].length,
  );
}

function mutableDocument(
  initialText: string,
  uriString = "file:///workspace/main.ts",
): MutableDocument {
  let text = initialText;
  let version = 1;
  const uri = vscodeApi.Uri.parse(uriString);
  const lineAt = (
    lineOrPosition: number | vscode.Position,
  ): vscode.TextLine => {
    const lineNumber =
      typeof lineOrPosition === "number" ? lineOrPosition : lineOrPosition.line;
    const lines = text.split("\n");
    const lineText = lines[lineNumber] ?? "";
    const start = new vscodeApi.Position(lineNumber, 0);
    const end = new vscodeApi.Position(lineNumber, lineText.length);
    const hasLineBreak = lineNumber < lines.length - 1;
    return {
      lineNumber,
      text: lineText,
      range: new vscodeApi.Range(start, end),
      rangeIncludingLineBreak: new vscodeApi.Range(
        start,
        hasLineBreak ? new vscodeApi.Position(lineNumber + 1, 0) : end,
      ),
      firstNonWhitespaceCharacterIndex: lineText.match(/^\s*/)?.[0].length ?? 0,
      isEmptyOrWhitespace:
        (lineText.match(/^\s*/)?.[0].length ?? 0) === lineText.length,
    };
  };
  const document: vscode.TextDocument = {
    uri,
    fileName: uri.fsPath,
    isUntitled: false,
    languageId: "typescript",
    encoding: "utf8",
    isDirty: false,
    isClosed: false,
    eol: 1,
    get version() {
      return version;
    },
    get lineCount() {
      return text.split("\n").length;
    },
    getText: () => text,
    offsetAt: (position: vscode.Position) => offsetAt(text, position),
    positionAt: (offset: number) => positionAt(text, offset),
    lineAt,
    getWordRangeAtPosition: () => undefined,
    validateRange: (range) => range,
    validatePosition: (position) => position,
    save: async () => true,
  };
  return {
    document,
    setText: (value) => {
      text = value;
      version += 1;
    },
  };
}

function workspaceFor(
  document: vscode.TextDocument,
  related: readonly vscode.TextDocument[] = [],
  ignoredUris: ReadonlySet<string> = new Set(),
  gatherContextDelayMs = 0,
  onGatherContextRequest?: (request: CopilotWorkspaceContextRequest) => void,
  hasEditHistory: () => boolean = () => true,
  onGatherContextToken?: (token: vscode.CancellationToken) => void,
  visibleDocumentUris: ReadonlySet<string> = new Set(),
  editHistory: () => CopilotWorkspaceContext["editHistory"] = () => [],
  withoutWorkspaceRoot = false,
): NextEditWorkspaceAdapter {
  const snapshot = (target: vscode.TextDocument = document) => ({
    uri: target.uri.toString(),
    path: target.uri.fsPath,
    relativePath: target.uri.fsPath.split("/").pop() ?? "unknown.ts",
    scheme: target.uri.scheme,
    languageId: target.languageId,
    version: target.version,
    text: target.getText(),
    ...(!withoutWorkspaceRoot
      ? {
          workspaceRoot: "/workspace",
          workspaceRootUri:
            target.uri.scheme === "file"
              ? "file:///workspace"
              : `${target.uri.scheme}://${target.uri.authority}/workspace`,
        }
      : {}),
    visibleRanges: visibleDocumentUris.has(target.uri.toString())
      ? [{ start: 0, end: target.getText().length }]
      : [],
    lastViewedAt: 0,
    lastEditedAt: 0,
  });
  return {
    snapshot,
    hasEditHistory,
    gatherContext: async (
      target: vscode.TextDocument,
      token: vscode.CancellationToken,
      _cursorOffset?: number,
      request: CopilotWorkspaceContextRequest = {},
    ): Promise<CopilotWorkspaceContext> => {
      onGatherContextRequest?.(request);
      onGatherContextToken?.(token);
      if (gatherContextDelayMs > 0) {
        await new Promise<void>((resolve) => {
          if (token.isCancellationRequested) {
            resolve();
            return;
          }
          let subscription: vscode.Disposable | undefined;
          const handle = setTimeout(() => {
            subscription?.dispose();
            resolve();
          }, gatherContextDelayMs);
          subscription = token.onCancellationRequested(() => {
            clearTimeout(handle);
            subscription?.dispose();
            resolve();
          });
        });
      }
      return {
        current: snapshot(target),
        ignored: ignoredUris.has(target.uri.toString()),
        recentDocuments: [document, ...related]
          .filter(
            (candidate, index, all) =>
              candidate.uri.toString() !== target.uri.toString() &&
              !ignoredUris.has(candidate.uri.toString()) &&
              all.findIndex(
                (entry) => entry.uri.toString() === candidate.uri.toString(),
              ) === index,
          )
          .map((candidate) => snapshot(candidate)),
        editHistory: editHistory(),
        neighborSnippets: [],
        diagnostics: [],
        promptDiagnostics: [],
        languageContext: { items: [], symbols: [] },
      };
    },
    isTracked: () => true,
    isDocumentIgnored: (target: vscode.TextDocument) =>
      ignoredUris.has(target.uri.toString()),
    isDocumentIgnoredWithRules: async (target: vscode.TextDocument) =>
      ignoredUris.has(target.uri.toString()),
  };
}

function cancellationToken(): vscode.CancellationToken {
  return new vscodeApi.CancellationTokenSource().token;
}

function trackedCancellationSource(): {
  readonly token: vscode.CancellationToken;
  readonly listenerCount: number;
  cancel(): void;
} {
  const listeners = new Set<() => void>();
  let cancelled = false;
  return {
    token: {
      get isCancellationRequested(): boolean {
        return cancelled;
      },
      onCancellationRequested: (listener, thisArgs, disposables) => {
        const callback = (): void => listener.call(thisArgs, undefined);
        const disposable: vscode.Disposable = {
          dispose: () => listeners.delete(callback),
        };
        if (cancelled) {
          queueMicrotask(callback);
        } else {
          listeners.add(callback);
        }
        disposables?.push(disposable);
        return disposable;
      },
    },
    get listenerCount(): number {
      return listeners.size;
    },
    cancel(): void {
      if (cancelled) return;
      cancelled = true;
      const pending = [...listeners];
      listeners.clear();
      for (const listener of pending) listener();
    },
  };
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

type TestModelMessage =
  | vscode.LanguageModelChatMessage
  | vscode.LanguageModelChatMessage2;

type TestModelRequest = (
  messages: readonly TestModelMessage[],
  options: vscode.LanguageModelChatRequestOptions,
  token: vscode.CancellationToken,
) => Promise<vscode.LanguageModelChatResponse>;

function languageModel(
  send: TestModelRequest,
  descriptor: {
    readonly name?: string;
    readonly id?: string;
    readonly vendor?: string;
    readonly supportsNextCursorLinePrediction?: boolean;
    readonly usesResponsesApi?: boolean;
  } = {},
): vscode.LanguageModelChat {
  const model: vscode.LanguageModelChat = {
    name: descriptor.name ?? "Test NES",
    id: descriptor.id ?? "nes",
    vendor: descriptor.vendor ?? "test",
    family: "test",
    version: "1",
    maxInputTokens: 128_000,
    capabilities: {
      supportsToolCalling: false,
      supportsImageToText: false,
    },
    sendRequest: (messages, options = {}, token = cancellationToken()) =>
      send(messages, options, token),
    countTokens: async (value) =>
      typeof value === "string"
        ? value.length
        : value.content.reduce(
            (total, part) =>
              total +
              (part instanceof vscodeApi.LanguageModelTextPart
                ? part.value.length
                : 0),
            0,
          ),
  };
  if (descriptor.supportsNextCursorLinePrediction !== undefined) {
    Object.defineProperty(model, "supportsNextCursorLinePrediction", {
      value: descriptor.supportsNextCursorLinePrediction,
    });
  }
  if (descriptor.usesResponsesApi !== undefined) {
    Object.defineProperty(model, "usesResponsesApi", {
      value: descriptor.usesResponsesApi,
    });
  }
  return model;
}

function modelProperty(model: vscode.LanguageModelChat, key: string): unknown {
  return Reflect.get(model, key);
}

function nestedModelProperty(
  model: vscode.LanguageModelChat,
  key: string,
): unknown {
  const capabilities = modelProperty(model, "capabilities");
  return typeof capabilities === "object" && capabilities !== null
    ? Reflect.get(capabilities, key)
    : undefined;
}

function completionCapabilities(
  model: vscode.LanguageModelChat,
): CompletionModelCapabilities {
  const cursorCapability =
    modelProperty(model, "supportsNextCursorLinePrediction") ??
    nestedModelProperty(model, "supportsNextCursorLinePrediction");
  const responsesCapability =
    modelProperty(model, "usesResponsesApi") ??
    nestedModelProperty(model, "usesResponsesApi");
  const usesResponsesApi =
    typeof responsesCapability === "boolean"
      ? responsesCapability
      : modelProperty(model, "apiType") === "responses" ||
        nestedModelProperty(model, "apiType") === "responses";
  return {
    supportsNextCursorLinePrediction: cursorCapability !== false,
    ...(usesResponsesApi ? { minimumCursorPredictionTokens: 2_048 } : {}),
  };
}

function externalModelResolver(): CompletionModelResolver {
  return {
    async resolveCompletionModel(reference) {
      const models = await vscodeApi.lm.selectChatModels({
        vendor: reference.vendor,
        id: reference.id,
      });
      const model = models.find(
        (candidate) =>
          candidate.vendor === reference.vendor &&
          candidate.id === reference.id,
      );
      if (!model) {
        const error = new Error(
          `Missing completion model ${reference.vendor}/${reference.id}.`,
        );
        Object.defineProperty(error, "code", {
          value: "completion-model-not-found",
        });
        throw error;
      }
      return new ConfiguredCompletionModel({
        completion: { transport: "compatible", templates: "all" },
        resolveCompatible: async () =>
          createCompatibleApiProvider(model, { model: 'test/nes-provider' }),
        resolveCapabilities: async () => completionCapabilities(model),
      });
    },
  };
}

function messageText(message: TestModelMessage): string {
  let text = "";
  for (const part of message.content) {
    if (part instanceof vscodeApi.LanguageModelTextPart) {
      text += part.value;
    }
  }
  return text;
}

function config(
  nextEdit: Partial<CopilotBehaviorConfig["nextEdit"]> = {},
): CopilotBehaviorConfig {
  return {
    ...COPILOT_BEHAVIOR_CONFIG,
    nextEdit: {
      ...COPILOT_BEHAVIOR_CONFIG.nextEdit,
      requestDebounceMs: 0,
      cacheDelayMs: 0,
      diagnosticsStartDelayMs: 0,
      diagnosticsRaceDeadlineMs: 0,
      ...nextEdit,
    },
  };
}

function input(
  document: vscode.TextDocument,
  line = 5,
  requestUuid = "request-1",
): CompletionAlgorithmInput {
  return {
    document,
    position: new vscodeApi.Position(line, 12),
    context: {
      triggerKind: vscodeApi.InlineCompletionTriggerKind.Invoke,
      selectedCompletionInfo: undefined,
      requestUuid,
      requestIssuedDateTime: Date.now(),
      earliestShownDateTime: Date.now(),
    },
  };
}

function unifiedEditWindow(
  text: string,
  replacements: Readonly<Record<number, string>>,
  cursorLine = 5,
  linesBelow = 5,
): string {
  const lines = text.split("\n");
  const startLine = Math.max(0, cursorLine - 2);
  const endLine = Math.min(lines.length, cursorLine + linesBelow + 1);
  const edited = lines
    .slice(startLine, endLine)
    .map((line, index) => replacements[startLine + index] ?? line);
  return `<EDIT>\n${edited.join("\n")}\n</EDIT>`;
}

function splitUnifiedEditWindow(
  text: string,
  replacements: Readonly<Record<number, string>>,
  splitAfterLine: number,
  cursorLine = 5,
  linesBelow = 5,
): readonly [string, string] {
  const lines = text.split("\n");
  const startLine = Math.max(0, cursorLine - 2);
  const endLine = Math.min(lines.length, cursorLine + linesBelow + 1);
  const edited = lines
    .slice(startLine, endLine)
    .map((line, index) => replacements[startLine + index] ?? line);
  const splitIndex = Math.max(
    0,
    Math.min(edited.length, splitAfterLine - startLine + 1),
  );
  return [
    `<EDIT>\n${edited.slice(0, splitIndex).join("\n")}\n`,
    `${edited.slice(splitIndex).join("\n")}\n</EDIT>`,
  ];
}

function automaticInput(
  document: vscode.TextDocument,
  line = 5,
  requestUuid = "automatic-request",
): CompletionAlgorithmInput {
  const value = input(document, line, requestUuid);
  return {
    ...value,
    context: {
      ...value.context,
      triggerKind: vscodeApi.InlineCompletionTriggerKind.Automatic,
    },
  };
}

function providerFor(
  document: vscode.TextDocument,
  model: vscode.LanguageModelChat,
  now: () => number = Date.now,
  options: {
    readonly related?: readonly vscode.TextDocument[];
    readonly ignoredUris?: ReadonlySet<string>;
    readonly nextEdit?: Partial<CopilotBehaviorConfig["nextEdit"]>;
    readonly cursorModel?: vscode.LanguageModelChat;
    readonly cursorModelReference?: CompletionModelReference;
    readonly strategy?: NesPromptStrategy;
    readonly eagerness?: NesAggressivenessSetting;
    readonly gatherContextDelayMs?: number;
    readonly onGatherContextRequest?: (
      request: CopilotWorkspaceContextRequest,
    ) => void;
    readonly hasEditHistory?: () => boolean;
    readonly onGatherContextToken?: (token: vscode.CancellationToken) => void;
    readonly visibleRelated?: boolean;
    readonly workspaceEditHistory?: () => CopilotWorkspaceContext["editHistory"];
    readonly withoutWorkspaceRoot?: boolean;
    readonly onRuntimeError?: (
      source: string,
      message: string,
      error: unknown,
    ) => void;
  } = {},
): OfficialNextEditProvider {
  const cursorModel = options.cursorModel ?? model;
  vscodeState.models = cursorModel === model ? [model] : [model, cursorModel];
  const algorithmContext: CompletionAlgorithmContext = {
    entry: { id: "test", algorithm: "copilot-replica" },
    options: {},
    modelResolver: externalModelResolver(),
    reportConfigurationError: () => undefined,
    ...(options.onRuntimeError === undefined
      ? {}
      : { reportRuntimeError: options.onRuntimeError }),
  };
  return new OfficialNextEditProvider(
    algorithmContext,
    workspaceFor(
      document,
      options.related,
      options.ignoredUris,
      options.gatherContextDelayMs,
      options.onGatherContextRequest,
      options.hasEditHistory,
      options.onGatherContextToken,
      options.visibleRelated
        ? new Set(options.related?.map((item) => item.uri.toString()))
        : new Set(),
      options.workspaceEditHistory,
      options.withoutWorkspaceRoot,
    ),
    new InlineEditTriggerState(
      config(options.nextEdit).trigger,
      () => undefined,
    ),
    { vendor: "test", id: "nes" },
    options.strategy ?? "xtabUnifiedModel",
    config(options.nextEdit),
    now,
    options.cursorModelReference ?? {
      vendor: cursorModel.vendor,
      id: cursorModel.id,
    },
    options.eagerness,
  );
}

function fireDocumentChange(
  document: vscode.TextDocument,
  contentChanges: readonly vscode.TextDocumentContentChangeEvent[] = [],
): void {
  for (const listener of [...vscodeState.changeListeners]) {
    listener({ document, contentChanges } as vscode.TextDocumentChangeEvent);
  }
}

beforeEach(() => {
  vscodeState.documents = [];
  vscodeState.activeEditor = undefined;
  vscodeState.openListeners.clear();
  vscodeState.changeListeners.clear();
  vscodeState.diagnosticListeners.clear();
  vscodeState.selectionListeners.clear();
  vscodeState.activeEditorListeners.clear();
  vscodeState.closeListeners.clear();
  vscodeState.diagnosticsReads = 0;
  vscodeState.models = [];
  vscodeState.selectors = [];
  vscodeState.selectHandler = undefined;
  vscodeState.openableDocuments.clear();
  vscodeState.openFailures.clear();
  vscodeState.openHandlers.clear();
  vscodeState.openCalls = [];
  vscodeState.documentsReadHook = undefined;
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("OfficialNextEditProvider streaming lifecycle", () => {
  it.each([
    {
      name: "Automatic",
      makeInput: automaticInput,
    },
    {
      name: "Invoke",
      makeInput: input,
    },
  ])(
    "returns before session, context, and transport for fresh $name requests without edit history",
    async ({ makeInput }) => {
      const source = mutableDocument(
        Array.from(
          { length: 12 },
          (_value, index) => `const value${index} = ${index};`,
        ).join("\n"),
      );
      vscodeState.documents.push(source.document);
      let contextCalls = 0;
      let transportCalls = 0;
      const sessionSpy = vi.spyOn(
        NesUserInteractionMonitor.prototype,
        "createDelaySession",
      );
      const provider = providerFor(
        source.document,
        languageModel(async () => {
          transportCalls += 1;
          return chatResponse((async function* (): AsyncIterable<string> {})());
        }),
        Date.now,
        {
          hasEditHistory: () => false,
          onGatherContextRequest: () => {
            contextCalls += 1;
          },
        },
      );

      expect(
        await provider.provide(
          makeInput(source.document),
          cancellationToken(),
          false,
        ),
      ).toBeUndefined();
      expect(sessionSpy).not.toHaveBeenCalled();
      expect(contextCalls).toBe(0);
      expect(transportCalls).toBe(0);
      provider.dispose();
    },
  );

  it("serves a stateful cache hit after edit history becomes empty", async () => {
    const source = mutableDocument(
      Array.from(
        { length: 12 },
        (_value, index) => `const value${index} = ${index};`,
      ).join("\n"),
    );
    vscodeState.documents.push(source.document);
    let hasEditHistory = true;
    let contextCalls = 0;
    let transportCalls = 0;
    const model = languageModel(async () => {
      transportCalls += 1;
      return chatResponse(
        (async function* (): AsyncIterable<string> {
          yield "<INSERT>\n + cached\n</INSERT>";
        })(),
      );
    });
    const provider = providerFor(source.document, model, Date.now, {
      hasEditHistory: () => hasEditHistory,
      onGatherContextRequest: () => {
        contextCalls += 1;
      },
    });
    const request = input(source.document, 5, "history-cache");
    expect(
      await provider.provide(request, cancellationToken(), false),
    ).toMatchObject({ fromCache: false });
    hasEditHistory = false;

    expect(
      await provider.provide(request, cancellationToken(), false),
    ).toMatchObject({ fromCache: true });
    expect(contextCalls).toBe(1);
    expect(transportCalls).toBe(1);
    provider.dispose();
  });

  it("joins a matching regular request after edit history becomes empty", async () => {
    const source = mutableDocument(
      Array.from(
        { length: 12 },
        (_value, index) => `const value${index} = ${index};`,
      ).join("\n"),
    );
    vscodeState.documents.push(source.document);
    let hasEditHistory = true;
    let contextCalls = 0;
    let transportCalls = 0;
    let releaseResponse: (() => void) | undefined;
    const responseReleased = new Promise<void>((resolve) => {
      releaseResponse = resolve;
    });
    const sessionSpy = vi.spyOn(
      NesUserInteractionMonitor.prototype,
      "createDelaySession",
    );
    const provider = providerFor(
      source.document,
      languageModel(async () => {
        transportCalls += 1;
        return chatResponse(
          (async function* (): AsyncIterable<string> {
            await responseReleased;
            yield "<INSERT>\n + joined\n</INSERT>";
          })(),
        );
      }),
      Date.now,
      {
        hasEditHistory: () => hasEditHistory,
        onGatherContextRequest: () => {
          contextCalls += 1;
        },
      },
    );
    const first = provider.provide(
      input(source.document, 5, "history-regular-source"),
      cancellationToken(),
      false,
    );
    await vi.waitFor(() => expect(transportCalls).toBe(1));
    const sessionCalls = sessionSpy.mock.calls.length;
    hasEditHistory = false;
    const joined = provider.provide(
      input(source.document, 5, "history-regular-caller"),
      cancellationToken(),
      false,
    );
    await Promise.resolve();

    expect(contextCalls).toBe(1);
    expect(transportCalls).toBe(1);
    expect(sessionSpy).toHaveBeenCalledTimes(sessionCalls);
    releaseResponse?.();
    const [sourceResult, joinedResult] = await Promise.all([first, joined]);
    expect(sourceResult).not.toBe(joinedResult);
    expect(joinedResult).toMatchObject({
      requestId: "history-regular-caller",
      sourceRequestId: "history-regular-caller",
    });
    provider.dispose();
  });

  it("does not start fresh after a failed async rebase when history becomes empty", async () => {
    const sourceA = mutableDocument(
      Array.from(
        { length: 12 },
        (_value, index) => `const aaaaa${index} = ${index};`,
      ).join("\n"),
      "file:///workspace/a.ts",
    );
    const sourceB = mutableDocument(
      Array.from(
        { length: 12 },
        (_value, index) => `const bbbbb${index} = ${index};`,
      ).join("\n"),
      "file:///workspace/b.ts",
    );
    vscodeState.documents.push(sourceA.document, sourceB.document);
    let hasEditHistory = true;
    let contextCalls = 0;
    let requestCount = 0;
    let releaseResponse: (() => void) | undefined;
    const responseReleased = new Promise<void>((resolve) => {
      releaseResponse = resolve;
    });
    const provider = providerFor(
      sourceA.document,
      languageModel(async () => {
        requestCount += 1;
        return chatResponse(
          (async function* (): AsyncIterable<string> {
            await responseReleased;
            yield "<INSERT>\n + source-only\n</INSERT>";
          })(),
        );
      }),
      Date.now,
      {
        related: [sourceB.document],
        hasEditHistory: () => hasEditHistory,
        onGatherContextRequest: () => {
          contextCalls += 1;
        },
        nextEdit: { asyncCompletions: true },
      },
    );
    const source = provider.provide(
      input(sourceA.document, 5, "history-failed-rebase-source"),
      cancellationToken(),
      false,
    );
    await vi.waitFor(() => expect(requestCount).toBe(1));
    const incompatible = provider.provide(
      input(sourceB.document, 5, "history-failed-rebase-caller"),
      cancellationToken(),
      false,
    );
    hasEditHistory = false;
    releaseResponse?.();

    expect(await source).toBeDefined();
    expect(await incompatible).toBeUndefined();
    expect(requestCount).toBe(1);
    expect(contextCalls).toBe(1);
    provider.dispose();
  });

  it("keeps caller feedback isolated across wrappers for one source", async () => {
    const source = mutableDocument(
      Array.from(
        { length: 12 },
        (_value, index) => `const value${index} = ${index};`,
      ).join("\n"),
    );
    vscodeState.documents.push(source.document);
    let now = 1_000;
    let transportCalls = 0;
    let releaseResponse: (() => void) | undefined;
    const responseReleased = new Promise<void>((resolve) => {
      releaseResponse = resolve;
    });
    const provider = providerFor(
      source.document,
      languageModel(async () => {
        transportCalls += 1;
        return chatResponse(
          (async function* (): AsyncIterable<string> {
            await responseReleased;
            yield "<INSERT>\n + isolated\n</INSERT>";
          })(),
        );
      }),
      () => now,
    );
    const fresh = provider.provide(
      input(source.document, 5, "wrapper-fresh"),
      cancellationToken(),
      false,
    );
    await vi.waitFor(() => expect(transportCalls).toBe(1));
    const joined = provider.provide(
      input(source.document, 5, "wrapper-joined"),
      cancellationToken(),
      false,
    );
    releaseResponse?.();
    const [freshResult, joinedResult] = await Promise.all([fresh, joined]);
    const cachedResult = await provider.provide(
      input(source.document, 5, "wrapper-cached"),
      cancellationToken(),
      false,
    );
    if (!freshResult || !joinedResult || !cachedResult) {
      throw new Error("Expected fresh, joined, and cached wrappers.");
    }
    expect(new Set([freshResult, joinedResult, cachedResult]).size).toBe(3);
    expect(
      new Set([
        freshResult.sourceRequestId,
        joinedResult.sourceRequestId,
        cachedResult.sourceRequestId,
      ]),
    ).toEqual(new Set(["wrapper-fresh", "wrapper-joined"]));
    expect(cachedResult.sourceRequestId).toBe("wrapper-fresh");

    provider.handleShown(freshResult, true);
    now = 1_200;
    provider.handleShown(joinedResult, true);
    now = 1_400;
    provider.handleShown(cachedResult, true);
    const interactionBeforeOldIgnore = provider.getState().userInteraction;
    provider.handleIgnored(freshResult, joinedResult);
    expect(provider.getState().userInteraction).toEqual(
      interactionBeforeOldIgnore,
    );
    now = 2_301;
    provider.handleRejected(joinedResult);

    expect(
      await provider.provide(
        input(source.document, 5, "wrapper-before-global-threshold"),
        cancellationToken(),
        false,
      ),
    ).toMatchObject({ fromCache: true });
    expect(transportCalls).toBe(1);
    now = 2_501;
    provider.handleRejected(cachedResult);
    expect(
      await provider.provide(
        input(source.document, 5, "wrapper-after-global-threshold"),
        cancellationToken(),
        false,
      ),
    ).toBeUndefined();
    provider.dispose();
  });

  it("caches later streamed edits in post-edit coordinates", async () => {
    const source = Array.from(
      { length: 12 },
      (_value, index) => `const value${index} = ${index};`,
    ).join("\n");
    const mutable = mutableDocument(source);
    vscodeState.documents.push(mutable.document);
    let requestCount = 0;
    const model = languageModel(async () => {
      requestCount += 1;
      return chatResponse(
        (async function* (): AsyncIterable<string> {
          yield unifiedEditWindow(source, {
            5: "const expandedValue5 = 500;",
            7: "const value7 = 700;",
          });
        })(),
      );
    });
    const provider = providerFor(mutable.document, model);

    const first = await provider.provide(
      input(mutable.document),
      cancellationToken(),
      false,
    );
    if (!first?.edit) throw new Error("Expected the first streamed edit.");
    await vi.waitFor(() => expect(provider.getState().inFlight).toBe(0));
    const firstEdit = first.edit;
    const acceptedText = `${source.slice(0, firstEdit.startOffset)}${
      firstEdit.newText
    }${source.slice(firstEdit.endOffset)}`;
    const firstDelta =
      firstEdit.newText.length - (firstEdit.endOffset - firstEdit.startOffset);
    mutable.setText(acceptedText);
    provider.handleAccepted(first);

    const second = await provider.provide(
      input(mutable.document, 7, "request-2"),
      cancellationToken(),
      false,
    );
    expect(requestCount).toBe(1);
    expect(second).toMatchObject({
      fromCache: true,
      subsequent: true,
      edit: {
        startOffset:
          source.indexOf("7;", source.indexOf("value7")) + firstDelta + 1,
        newText: "00",
      },
    });
    provider.dispose();
  });

  it("expands only after accepting the latest returned suggestion", async () => {
    const source = mutableDocument(
      Array.from(
        { length: 12 },
        (_value, index) => `const value${index} = ${index};`,
      ).join("\n"),
    );
    vscodeState.documents.push(source.document);
    const model = languageModel(async () =>
      chatResponse(
        (async function* (): AsyncIterable<string> {
          yield "<INSERT>\n + latest\n</INSERT>";
        })(),
      ),
    );
    const provider = providerFor(source.document, model);
    const first = await provider.provide(
      input(source.document),
      cancellationToken(),
      false,
    );
    await vi.waitFor(() => expect(provider.getState().inFlight).toBe(0));
    const latest = await provider.provide(
      input(source.document, 5, "request-2"),
      cancellationToken(),
      false,
    );
    if (!first || !latest) throw new Error("Expected both suggestions.");

    provider.handleAccepted(first);
    expect(provider.getState().expandNextFreshRequest).toBe(false);
    provider.handleAccepted(latest);
    expect(provider.getState().expandNextFreshRequest).toBe(true);
    provider.dispose();
  });

  it("consumes ordinary acceptance expansion on the next completed fresh request", async () => {
    const originalText = Array.from(
      { length: 60 },
      (_value, index) => `const value${index} = ${index};`,
    ).join("\n");
    const source = mutableDocument(originalText);
    vscodeState.documents.push(source.document);
    const requestTexts: string[] = [];
    let requestCount = 0;
    const model = languageModel(async (messages) => {
      requestCount += 1;
      requestTexts.push(messages.map(messageText).join("\n"));
      return requestCount === 1
        ? chatResponse(
            (async function* (): AsyncIterable<string> {
              yield "<INSERT>\n + accepted\n</INSERT>";
            })(),
          )
        : chatResponse((async function* (): AsyncIterable<string> {})());
    });
    const provider = providerFor(source.document, model);
    const first = await provider.provide(
      input(source.document),
      cancellationToken(),
      false,
    );
    if (!first?.edit) throw new Error("Expected the accepted edit.");
    await vi.waitFor(() => expect(provider.getState().inFlight).toBe(0));
    provider.handleAccepted(first);
    expect(provider.getState().expandNextFreshRequest).toBe(true);
    const acceptedText = `${originalText.slice(0, first.edit.startOffset)}${
      first.edit.newText
    }${originalText.slice(first.edit.endOffset)}`;
    source.setText(acceptedText);
    fireDocumentChange(source.document, [
      {
        range: new vscodeApi.Range(
          new vscodeApi.Position(5, 0),
          new vscodeApi.Position(5, 0),
        ),
        rangeOffset: first.edit.startOffset,
        rangeLength: first.edit.endOffset - first.edit.startOffset,
        text: first.edit.newText,
      },
    ]);

    expect(
      await provider.provide(
        input(source.document, 5, "request-2"),
        cancellationToken(),
        false,
      ),
    ).toBeUndefined();
    expect(requestCount).toBe(3);
    const expandedWindow = requestTexts[1].match(
      /<\|code_to_edit\|>\n([\s\S]*?)\n<\|\/code_to_edit\|>/,
    )?.[1];
    expect(expandedWindow).toContain("const value15 = 15;");
    expect(expandedWindow).not.toContain("const value16 = 16;");
    expect(provider.getState().expandNextFreshRequest).toBe(false);
    provider.dispose();
  });

  it("retains acceptance expansion for intent filtering and resets it for no suggestions", async () => {
    const sourceLines = Array.from(
      { length: 20 },
      (_value, index) => `const value${index} = ${index};`,
    );
    const source = mutableDocument(sourceLines.join("\n"));
    vscodeState.documents.push(source.document);
    const ordinaryWindow = sourceLines.slice(3, 11);
    const expandedWindow = sourceLines.slice(3, 16);
    const changedWindow = ordinaryWindow.map((line, index) =>
      index === 2 ? "const value5 = 500;" : line,
    );
    let requestCount = 0;
    const model = languageModel(
      async () => {
        requestCount += 1;
        const response =
          requestCount === 1
            ? `<|edit_intent|>high<|/edit_intent|>\n${changedWindow.join("\n")}`
            : requestCount === 2
              ? "<|edit_intent|>no_edit<|/edit_intent|>"
              : `<|edit_intent|>high<|/edit_intent|>\n${expandedWindow.join("\n")}`;
        return chatResponse(
          (async function* (): AsyncIterable<string> {
            yield response;
          })(),
        );
      },
      { supportsNextCursorLinePrediction: false },
    );
    const provider = providerFor(source.document, model, Date.now, {
      strategy: "xtab275EditIntent",
      eagerness: "high",
    });
    const first = await provider.provide(
      input(source.document, 5, "expansion-source"),
      cancellationToken(),
      false,
    );
    if (!first?.edit) throw new Error("Expected the accepted source edit.");
    await vi.waitFor(() => expect(provider.getState().inFlight).toBe(0));
    provider.handleAccepted(first);
    expect(provider.getState().expandNextFreshRequest).toBe(true);
    source.setText(`${source.document.getText()}\n// force a fresh request`);

    expect(
      await provider.provide(
        input(source.document, 5, "expansion-intent-filter"),
        cancellationToken(),
        false,
      ),
    ).toBeUndefined();
    expect(provider.getState().expandNextFreshRequest).toBe(true);

    expect(
      await provider.provide(
        input(source.document, 5, "expansion-no-suggestions"),
        cancellationToken(),
        false,
      ),
    ).toBeUndefined();
    expect(provider.getState().expandNextFreshRequest).toBe(false);
    provider.dispose();
  });

  it("reuses an in-flight request across compatible typing only when async completions are enabled", async () => {
    const run = async (asyncCompletions: boolean) => {
      const originalText = Array.from(
        { length: 12 },
        (_value, index) => `const value${index} = ${index};`,
      ).join("\n");
      const source = mutableDocument(originalText);
      vscodeState.documents = [source.document];
      let release: (() => void) | undefined;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let requestCount = 0;
      const tokens: vscode.CancellationToken[] = [];
      const model = languageModel(async (_messages, _options, token) => {
        requestCount += 1;
        tokens.push(token);
        const requestText = source.document.getText();
        return chatResponse(
          (async function* (): AsyncIterable<string> {
            yield "<EDIT>\n";
            await gate;
            const lines = requestText.split("\n").slice(3, 11);
            lines[2] = "const value5 = 500;";
            yield `${lines.join("\n")}\n</EDIT>`;
          })(),
        );
      });
      const provider = providerFor(source.document, model, Date.now, {
        nextEdit: {
          asyncCompletions,
          earlyDivergenceCancellation: "cursor",
        },
      });
      const first = provider.provide(
        input(source.document),
        cancellationToken(),
        false,
      );
      await vi.waitFor(() => expect(requestCount).toBe(1));
      const insertionOffset =
        originalText.indexOf("5;", originalText.indexOf("value5")) + 1;
      const currentText = `${originalText.slice(
        0,
        insertionOffset,
      )}0${originalText.slice(insertionOffset)}`;
      source.setText(currentText);
      fireDocumentChange(source.document, [
        {
          range: new vscodeApi.Range(
            new vscodeApi.Position(5, 16),
            new vscodeApi.Position(5, 16),
          ),
          rangeOffset: insertionOffset,
          rangeLength: 0,
          text: "0",
        },
      ]);
      const second = provider.provide(
        input(source.document, 5, "request-2"),
        cancellationToken(),
        false,
      );
      await vi.waitFor(() =>
        expect(requestCount).toBe(asyncCompletions ? 1 : 2),
      );
      release?.();
      const [firstResult, secondResult] = await Promise.all([first, second]);
      const result = {
        requestCount,
        firstCancelled: tokens[0]?.isCancellationRequested ?? false,
        firstNewText: firstResult?.edit?.newText,
        secondNewText: secondResult?.edit?.newText,
      };
      provider.dispose();
      return result;
    };

    await expect(run(true)).resolves.toMatchObject({
      requestCount: 1,
      firstCancelled: false,
      firstNewText: undefined,
      secondNewText: "00",
    });
    await expect(run(false)).resolves.toMatchObject({
      requestCount: 2,
      firstCancelled: true,
      firstNewText: undefined,
      secondNewText: "0",
    });
  });

  it("returns the first unified edit while consuming the remainder in background", async () => {
    const source = Array.from(
      { length: 12 },
      (_value, index) => `const value${index} = ${index};`,
    ).join("\n");
    const mutable = mutableDocument(source);
    vscodeState.documents.push(mutable.document);
    let releaseRemainder: (() => void) | undefined;
    const remainder = new Promise<void>((resolve) => {
      releaseRemainder = resolve;
    });
    const model = languageModel(async () =>
      chatResponse(
        (async function* (): AsyncIterable<string> {
          yield "<INSERT>\n + suffix\n";
          await remainder;
          yield "console.log(value5);\n</INSERT>";
        })(),
      ),
    );
    const provider = providerFor(mutable.document, model);
    const suggestion = await provider.provide(
      input(mutable.document),
      cancellationToken(),
      false,
    );
    expect(suggestion?.edit).toBeDefined();
    expect(provider.getState().inFlight).toBe(1);
    releaseRemainder?.();
    await vi.waitFor(() => expect(provider.getState().inFlight).toBe(0));
    provider.dispose();
  });

  it("keeps compatible type-through while streaming and returns the remainder", async () => {
    const source = Array.from(
      { length: 12 },
      (_value, index) => `const value${index} = ${index};`,
    ).join("\n");
    const mutable = mutableDocument(source);
    vscodeState.documents.push(mutable.document);
    let transportToken: vscode.CancellationToken | undefined;
    let release: (() => void) | undefined;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let firstChunk: (() => void) | undefined;
    const firstChunkYielded = new Promise<void>((resolve) => {
      firstChunk = resolve;
    });
    const model = languageModel(async (_messages, _options, token) => {
      transportToken = token;
      return chatResponse(
        (async function* (): AsyncIterable<string> {
          firstChunk?.();
          yield "<EDIT>\n";
          await released;
          const lines = source.split("\n").slice(3, 11);
          lines[2] = "const value5 = 500;";
          yield `${lines.join("\n")}\n</EDIT>`;
        })(),
      );
    });
    const provider = providerFor(mutable.document, model, Date.now, {
      nextEdit: { earlyDivergenceCancellation: "cursor" },
    });
    const result = provider.provide(
      input(mutable.document),
      cancellationToken(),
      false,
    );
    await firstChunkYielded;
    const insertionOffset = source.indexOf("5;", source.indexOf("value5")) + 1;
    mutable.setText(
      `${source.slice(0, insertionOffset)}0${source.slice(insertionOffset)}`,
    );
    fireDocumentChange(mutable.document, [
      {
        range: new vscodeApi.Range(
          new vscodeApi.Position(5, 16),
          new vscodeApi.Position(5, 16),
        ),
        rangeOffset: insertionOffset,
        rangeLength: 0,
        text: "0",
      },
    ]);
    expect(transportToken?.isCancellationRequested).toBe(false);
    release?.();
    expect(await result).toBeUndefined();
    expect(
      await provider.provide(
        input(mutable.document, 5, "type-through-cache"),
        cancellationToken(),
        false,
      ),
    ).toMatchObject({
      fromCache: true,
      rebased: true,
      edit: { newText: "00" },
    });
    expect(transportToken?.isCancellationRequested).toBe(false);
    provider.dispose();
  });

  it("keeps a fresh request when edit and undo restore the original bytes", async () => {
    const sourceText = Array.from(
      { length: 12 },
      (_value, index) => `const value${index} = ${index};`,
    ).join("\n");
    const source = mutableDocument(sourceText);
    vscodeState.documents.push(source.document);
    let releaseResponse: (() => void) | undefined;
    const responseReleased = new Promise<void>((resolve) => {
      releaseResponse = resolve;
    });
    let requestCount = 0;
    const provider = providerFor(
      source.document,
      languageModel(async () => {
        requestCount += 1;
        return chatResponse(
          (async function* (): AsyncIterable<string> {
            await responseReleased;
            yield "<INSERT>\n + restored\n</INSERT>";
          })(),
        );
      }),
      Date.now,
      { nextEdit: { asyncCompletions: true } },
    );
    const pending = provider.provide(
      input(source.document, 5, "edit-undo-restored"),
      cancellationToken(),
      false,
    );
    await vi.waitFor(() => expect(requestCount).toBe(1));
    source.setText(`X${sourceText}`);
    fireDocumentChange(source.document, [
      {
        range: new vscodeApi.Range(
          new vscodeApi.Position(0, 0),
          new vscodeApi.Position(0, 0),
        ),
        rangeOffset: 0,
        rangeLength: 0,
        text: "X",
      },
    ]);
    source.setText(sourceText);
    fireDocumentChange(source.document, [
      {
        range: new vscodeApi.Range(
          new vscodeApi.Position(0, 0),
          new vscodeApi.Position(0, 1),
        ),
        rangeOffset: 0,
        rangeLength: 1,
        text: "",
      },
    ]);
    releaseResponse?.();

    expect(await pending).toMatchObject({
      fromCache: false,
      edit: { newText: "+ restored " },
    });
    expect(source.document.version).toBe(3);
    provider.dispose();
  });

  it("freezes early-divergence input before later user typing", async () => {
    const source = Array.from(
      { length: 12 },
      (_value, index) => `const value${index} = ${index};`,
    ).join("\n");
    const mutable = mutableDocument(source);
    vscodeState.documents.push(mutable.document);
    let transportToken: vscode.CancellationToken | undefined;
    let release: (() => void) | undefined;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let firstChunk: (() => void) | undefined;
    const firstChunkYielded = new Promise<void>((resolve) => {
      firstChunk = resolve;
    });
    const model = languageModel(async (_messages, _options, token) => {
      transportToken = token;
      return chatResponse(
        (async function* (): AsyncIterable<string> {
          firstChunk?.();
          yield "<EDIT>\n";
          await released;
          const lines = source.split("\n").slice(3, 11);
          lines[2] = "const value5 = 500;";
          yield `${lines.join("\n")}\n</EDIT>`;
        })(),
      );
    });
    const provider = providerFor(mutable.document, model, Date.now, {
      nextEdit: { earlyDivergenceCancellation: "cursor" },
    });
    const result = provider.provide(
      input(mutable.document),
      cancellationToken(),
      false,
    );
    await firstChunkYielded;
    const insertionOffset = source.indexOf("5;", source.indexOf("value5")) + 1;
    mutable.setText(
      `${source.slice(0, insertionOffset)}x${source.slice(insertionOffset)}`,
    );
    fireDocumentChange(mutable.document, [
      {
        range: new vscodeApi.Range(
          new vscodeApi.Position(5, 16),
          new vscodeApi.Position(5, 16),
        ),
        rangeOffset: insertionOffset,
        rangeLength: 0,
        text: "x",
      },
    ]);
    expect(transportToken?.isCancellationRequested).toBe(false);
    release?.();
    expect(await result).toBeUndefined();
    expect(transportToken?.isCancellationRequested).toBe(false);
    provider.dispose();
  });

  it("reuses compatible work and supersedes a cursor outside the edit window", async () => {
    const source = Array.from(
      { length: 12 },
      (_value, index) => `const value${index} = ${index};`,
    ).join("\n");
    const mutable = mutableDocument(source);
    vscodeState.documents.push(mutable.document);
    const releases: Array<() => void> = [];
    const tokens: vscode.CancellationToken[] = [];
    let requestCount = 0;
    const model = languageModel(async (_messages, _options, token) => {
      requestCount += 1;
      tokens.push(token);
      let release: (() => void) | undefined;
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      releases.push(() => release?.());
      return chatResponse(
        (async function* (): AsyncIterable<string> {
          await Promise.race([
            released,
            new Promise<void>((resolve) =>
              token.onCancellationRequested(resolve),
            ),
          ]);
          if (!token.isCancellationRequested) {
            yield "<INSERT>\n + shared\n</INSERT>";
          }
        })(),
      );
    });
    const provider = providerFor(mutable.document, model);
    const first = provider.provide(
      input(mutable.document, 5, "first"),
      cancellationToken(),
      false,
    );
    await vi.waitFor(() => expect(requestCount).toBe(1));
    const reused = provider.provide(
      input(mutable.document, 6, "reused"),
      cancellationToken(),
      false,
    );
    await Promise.resolve();
    expect(requestCount).toBe(1);

    const superseding = provider.provide(
      input(mutable.document, 0, "superseding"),
      cancellationToken(),
      false,
    );
    await vi.waitFor(() => expect(requestCount).toBe(2));
    expect(tokens[0].isCancellationRequested).toBe(true);
    releases[1]?.();
    await Promise.all([first, reused, superseding]);
    provider.dispose();
  });

  it("routes diagnostics lifecycle immediately without mutating LLM state", () => {
    const mutable = mutableDocument("const value = 1;");
    vscodeState.documents.push(mutable.document);
    let now = 0;
    const provider = providerFor(
      mutable.document,
      languageModel(async () =>
        chatResponse((async function* (): AsyncIterable<string> {})()),
      ),
      () => now,
    );
    const diagnosticsSuggestion = {
      source: "diagnostics" as const,
      kind: "import" as const,
      id: "diagnostic-1",
      rejectionKey: "diagnostic-1",
      edit: {
        uri: mutable.document.uri.toString(),
        startOffset: 0,
        endOffset: 0,
        newText: "import value;\n",
        kind: "insert" as const,
      },
      title: "Add import",
      sourceDocument: {
        uri: mutable.document.uri.toString(),
        version: mutable.document.version,
        text: mutable.document.getText(),
      },
      targetDocument: {
        uri: mutable.document.uri.toString(),
        version: mutable.document.version,
        text: mutable.document.getText(),
      },
      diagnostic: {
        uri: mutable.document.uri.toString(),
        message: "missing import",
        start: 0,
        end: 1,
      },
    };
    const suggestion: NesBranchSuggestion = {
      branch: "diagnostics" as const,
      source: "diagnostics" as const,
      requestId: "diagnostics-request",
      sourceRequestId: "diagnostics-request",
      edit: diagnosticsSuggestion.edit,
      diagnosticsSuggestion,
      fromCache: false,
      rebased: false,
      subsequent: false,
      speculative: false,
      sourceIsSpeculative: false,
      createdAt: now,
    };
    provider.handleShown(suggestion, true);
    expect(provider.getState()).toMatchObject({
      lastOutcome: undefined,
      lastRejectionTime: Number.NEGATIVE_INFINITY,
      diagnostics: { lastOutcome: undefined, rejectedCount: 0 },
    });

    now = 1;
    provider.handleRejected(suggestion);
    expect(provider.getState()).toMatchObject({
      lastOutcome: undefined,
      lastRejectionTime: Number.NEGATIVE_INFINITY,
      diagnostics: {
        lastOutcome: "rejected",
        lastRejectionTime: 1,
        rejectedCount: 1,
      },
    });

    const accepted: NesBranchSuggestion = {
      ...suggestion,
      requestId: "diagnostics-request-2",
      sourceRequestId: "diagnostics-request-2",
      diagnosticsSuggestion: {
        ...diagnosticsSuggestion,
        id: "diagnostic-2",
        rejectionKey: "diagnostic-2",
      },
    };
    provider.handleAccepted(accepted);
    expect(provider.getState()).toMatchObject({
      lastOutcome: undefined,
      diagnostics: { lastOutcome: "accepted" },
    });

    const ignored: NesBranchSuggestion = {
      ...accepted,
      requestId: "diagnostics-request-3",
      sourceRequestId: "diagnostics-request-3",
    };
    provider.handleIgnored(ignored);
    expect(provider.getState()).toMatchObject({
      lastOutcome: undefined,
      diagnostics: { lastOutcome: "ignored" },
      userInteraction: { aggressivenessActions: [] },
    });
    provider.dispose();
  });

  it("persists feedback across requests and injects its adaptive level into the prompt", async () => {
    const source = Array.from(
      { length: 12 },
      (_value, index) => `const value${index} = ${index};`,
    ).join("\n");
    const mutable = mutableDocument(source);
    vscodeState.documents.push(mutable.document);
    const requests: string[] = [];
    const output = Array.from({ length: 8 }, (_value, index) =>
      index === 2
        ? "const value5 = 500;"
        : `const value${index + 3} = ${index + 3};`,
    ).join("\n");
    const model = languageModel(async (messages, options) => {
      if (options.modelOptions?.max_tokens === undefined) {
        requests.push(messages.map(messageText).join("\n"));
      }
      return chatResponse(
        (async function* (): AsyncIterable<string> {
          yield output;
        })(),
      );
    });
    const provider = providerFor(mutable.document, model, Date.now, {
      strategy: "xtab275Aggressiveness",
    });
    const feedback: NesBranchSuggestion = {
      branch: "nes" as const,
      source: "llm" as const,
      requestId: "feedback",
      sourceRequestId: "feedback",
      fromCache: false,
      rebased: false,
      subsequent: false,
      speculative: false,
      sourceIsSpeculative: false,
      createdAt: Date.now(),
    };
    for (let index = 0; index < 10; index += 1) {
      const requestId = `feedback-${index}`;
      provider.handleAccepted({
        ...feedback,
        requestId,
        sourceRequestId: requestId,
      });
    }
    expect(provider.getState().userInteraction).toMatchObject({
      aggressivenessLevel: "high",
      aggressivenessActions: expect.arrayContaining([
        expect.objectContaining({ kind: "accepted" }),
      ]),
    });

    const suggestion = await provider.provide(
      input(mutable.document, 5, "after-feedback"),
      cancellationToken(),
      false,
    );
    expect(suggestion?.edit).toBeDefined();
    expect(requests).toHaveLength(1);
    expect(requests[0]).toContain("<|aggressive|>high<|/aggressive|>");
    provider.dispose();
  });

  it("does not apply artificial delay to Unified DirectEdits", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const source = Array.from(
      { length: 12 },
      (_value, index) => `const value${index} = ${index};`,
    ).join("\n");
    const mutable = mutableDocument(source);
    vscodeState.documents.push(mutable.document);
    let requestCount = 0;
    const model = languageModel(async () => {
      requestCount += 1;
      return chatResponse(
        (async function* (): AsyncIterable<string> {
          yield "<INSERT>\n + delayed\n</INSERT>";
        })(),
      );
    });
    const provider = providerFor(mutable.document, model, Date.now, {
      eagerness: "low",
      nextEdit: {
        requestDebounceMs: 100,
        backoffDebounceEnabled: true,
        diagnosticsStartDelayMs: 10_000,
        diagnosticsRaceDeadlineMs: 5_000,
      },
    });
    let settled = false;
    const result = provider
      .provide(
        automaticInput(mutable.document, 5, "low-delay"),
        cancellationToken(),
        false,
      )
      .then((value) => {
        settled = true;
        return value;
      });
    await vi.advanceTimersByTimeAsync(99);
    expect(requestCount).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(requestCount).toBe(1);
    await vi.advanceTimersByTimeAsync(0);
    expect((await result)?.edit?.newText).toContain("delayed");
    expect(settled).toBe(true);
    provider.dispose();
  });

  it("applies low eagerness artificial delay to EditWindowLines", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const source = Array.from(
      { length: 12 },
      (_value, index) => `const value${index} = ${index};`,
    ).join("\n");
    const mutable = mutableDocument(source);
    vscodeState.documents.push(mutable.document);
    let requestCount = 0;
    const output = Array.from({ length: 8 }, (_value, index) =>
      index === 2
        ? "const value5 = 500;"
        : `const value${index + 3} = ${index + 3};`,
    ).join("\n");
    const model = languageModel(async () => {
      requestCount += 1;
      return chatResponse(
        (async function* (): AsyncIterable<string> {
          yield output;
        })(),
      );
    });
    const provider = providerFor(mutable.document, model, Date.now, {
      strategy: "xtab275",
      eagerness: "low",
      nextEdit: {
        requestDebounceMs: 100,
      },
    });
    let settled = false;
    const result = provider
      .provide(
        automaticInput(mutable.document, 5, "edit-window-delay"),
        cancellationToken(),
        false,
      )
      .then((value) => {
        settled = true;
        return value;
      });
    await vi.advanceTimersByTimeAsync(100);
    expect(requestCount).toBe(1);
    await vi.advanceTimersByTimeAsync(1_399);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect((await result)?.edit?.newText).toBe("00");
    provider.dispose();
  });

  it("finishes artificial delay before observing cancellation", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const source = mutableDocument(
      Array.from(
        { length: 12 },
        (_value, index) => `const value${index} = ${index};`,
      ).join("\n"),
    );
    vscodeState.documents.push(source.document);
    const output = Array.from({ length: 8 }, (_value, index) =>
      index === 2
        ? "const value5 = 500;"
        : `const value${index + 3} = ${index + 3};`,
    ).join("\n");
    let requestCount = 0;
    const provider = providerFor(
      source.document,
      languageModel(async () => {
        requestCount += 1;
        return chatResponse(
          (async function* (): AsyncIterable<string> {
            yield output;
          })(),
        );
      }),
      Date.now,
      {
        strategy: "xtab275",
        eagerness: "low",
        nextEdit: {
          requestDebounceMs: 100,
          diagnosticsStartDelayMs: 10_000,
          diagnosticsRaceDeadlineMs: 5_000,
        },
      },
    );
    const consumer = new vscodeApi.CancellationTokenSource();
    let settled = false;
    const result = provider
      .provide(
        automaticInput(source.document, 5, "cancel-artificial-delay"),
        consumer.token,
        false,
      )
      .then((value) => {
        settled = true;
        return value;
      });
    await vi.advanceTimersByTimeAsync(100);
    expect(requestCount).toBe(1);
    expect(provider.getState().inFlight).toBe(1);

    consumer.cancel();
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    expect(provider.getState().inFlight).toBe(1);
    await vi.advanceTimersByTimeAsync(999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(false);
    expect(provider.getState().inFlight).toBe(1);
    await vi.advanceTimersByTimeAsync(399);
    expect(settled).toBe(false);
    expect(provider.getState().inFlight).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(await result).toBeUndefined();
    expect(provider.getState().inFlight).toBe(0);
    consumer.dispose();
    provider.dispose();
  });

  it("lets the next consumer reattach during the cancellation grace window", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const source = mutableDocument(
      Array.from(
        { length: 12 },
        (_value, index) => `const value${index} = ${index};`,
      ).join("\n"),
    );
    vscodeState.documents.push(source.document);
    let releaseResponse: (() => void) | undefined;
    const responseReleased = new Promise<void>((resolve) => {
      releaseResponse = resolve;
    });
    let requestCount = 0;
    let requestToken: vscode.CancellationToken | undefined;
    const provider = providerFor(
      source.document,
      languageModel(async (_messages, _options, token) => {
        requestCount += 1;
        requestToken = token;
        return chatResponse(
          (async function* (): AsyncIterable<string> {
            await responseReleased;
            yield "<INSERT>\n + shared\n</INSERT>";
          })(),
        );
      }),
      Date.now,
      {
        nextEdit: {
          requestDebounceMs: 0,
          asyncCompletions: true,
          diagnosticsStartDelayMs: 10_000,
        },
      },
    );
    const cancelledConsumer = new vscodeApi.CancellationTokenSource();
    const activeConsumer = new vscodeApi.CancellationTokenSource();
    let cancelledSettled = false;
    let activeSettled = false;
    const cancelledResult = provider
      .provide(
        input(source.document, 5, "shared-cancelled"),
        cancelledConsumer.token,
        false,
      )
      .then((value) => {
        cancelledSettled = true;
        return value;
      });
    await vi.waitFor(() => expect(requestCount).toBe(1));

    cancelledConsumer.cancel();
    await vi.advanceTimersByTimeAsync(0);
    expect(cancelledSettled).toBe(false);
    expect(requestToken?.isCancellationRequested).toBe(false);
    const activeResult = provider
      .provide(
        input(source.document, 5, "shared-active"),
        activeConsumer.token,
        false,
      )
      .then((value) => {
        activeSettled = true;
        return value;
      });
    await vi.advanceTimersByTimeAsync(1_001);
    expect(activeSettled).toBe(false);
    expect(requestCount).toBe(1);
    expect(requestToken?.isCancellationRequested).toBe(false);
    releaseResponse?.();
    await vi.advanceTimersByTimeAsync(0);

    expect(await cancelledResult).toBeUndefined();
    expect((await activeResult)?.edit?.newText).toContain("shared");
    expect(requestToken?.isCancellationRequested).toBe(false);
    cancelledConsumer.dispose();
    activeConsumer.dispose();
    provider.dispose();
  });

  it.each([true, false])(
    "single-flights context preparation before the edit window exists (async=%s)",
    async (asyncCompletions) => {
      vi.useFakeTimers();
      vi.setSystemTime(1_000);
      const source = mutableDocument(
        Array.from(
          { length: 12 },
          (_value, index) => `const value${index} = ${index};`,
        ).join("\n"),
      );
      vscodeState.documents.push(source.document);
      let requestCount = 0;
      let requestToken: vscode.CancellationToken | undefined;
      const model = languageModel(async (_messages, _options, token) => {
        requestCount += 1;
        requestToken = token;
        return chatResponse(
          (async function* (): AsyncIterable<string> {
            yield "<INSERT>\n + prepared\n</INSERT>";
          })(),
        );
      });
      const gatherRequests: CopilotWorkspaceContextRequest[] = [];
      const provider = providerFor(source.document, model, Date.now, {
        gatherContextDelayMs: 100,
        onGatherContextRequest: (request) => gatherRequests.push(request),
        nextEdit: {
          asyncCompletions,
          requestDebounceMs: 0,
          diagnosticsStartDelayMs: 10_000,
        },
      });
      const cancelledConsumer = new vscodeApi.CancellationTokenSource();
      const first = provider.provide(
        input(source.document, 5, "prepare-first"),
        cancelledConsumer.token,
        false,
      );
      await vi.waitFor(() => expect(gatherRequests).toHaveLength(1));
      const second = provider.provide(
        input(source.document, 5, "prepare-second"),
        cancellationToken(),
        false,
      );
      await vi.advanceTimersByTimeAsync(0);
      cancelledConsumer.cancel();
      await vi.advanceTimersByTimeAsync(100);

      expect(await first).toBeUndefined();
      expect((await second)?.edit?.newText).toContain("prepared");
      expect(requestCount).toBe(1);
      expect(requestToken?.isCancellationRequested).toBe(false);
      expect(gatherRequests).toHaveLength(1);
      cancelledConsumer.dispose();
      provider.dispose();
    },
  );

  it("cancels preparation immediately before the model request is issued", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const source = mutableDocument(
      Array.from(
        { length: 12 },
        (_value, index) => `const value${index} = ${index};`,
      ).join("\n"),
    );
    vscodeState.documents.push(source.document);
    let requestCount = 0;
    let gatherToken: vscode.CancellationToken | undefined;
    const provider = providerFor(
      source.document,
      languageModel(async () => {
        requestCount += 1;
        return chatResponse(
          (async function* (): AsyncIterable<string> {
            yield "<INSERT>\n + unexpected\n</INSERT>";
          })(),
        );
      }),
      Date.now,
      {
        gatherContextDelayMs: 10_000,
        onGatherContextToken: (token) => {
          gatherToken = token;
        },
        nextEdit: { requestDebounceMs: 0 },
      },
    );
    const consumer = new vscodeApi.CancellationTokenSource();
    const result = provider.provide(
      input(source.document, 5, "cancel-preparation"),
      consumer.token,
      false,
    );
    await vi.waitFor(() => expect(gatherToken).toBeDefined());
    consumer.cancel();
    await vi.advanceTimersByTimeAsync(0);

    expect(gatherToken?.isCancellationRequested).toBe(true);
    expect(await result).toBeUndefined();
    expect(requestCount).toBe(0);
    consumer.dispose();
    provider.dispose();
  });

  it("supersedes preparation when the next cursor is outside its edit window", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const source = mutableDocument(
      Array.from(
        { length: 40 },
        (_value, index) => `const value${index} = ${index};`,
      ).join("\n"),
    );
    vscodeState.documents.push(source.document);
    const gatherTokens: vscode.CancellationToken[] = [];
    let requestCount = 0;
    const provider = providerFor(
      source.document,
      languageModel(async () => {
        requestCount += 1;
        return chatResponse(
          (async function* (): AsyncIterable<string> {
            yield "<INSERT>\n + outside-window\n</INSERT>";
          })(),
        );
      }),
      Date.now,
      {
        gatherContextDelayMs: 100,
        onGatherContextToken: (token) => gatherTokens.push(token),
        nextEdit: {
          asyncCompletions: true,
          requestDebounceMs: 0,
          diagnosticsStartDelayMs: 10_000,
        },
      },
    );
    const first = provider.provide(
      input(source.document, 5, "inside-window"),
      cancellationToken(),
      false,
    );
    await vi.waitFor(() => expect(gatherTokens).toHaveLength(1));
    const second = provider.provide(
      input(source.document, 30, "outside-window"),
      cancellationToken(),
      false,
    );
    await vi.waitFor(() => expect(gatherTokens).toHaveLength(2));
    expect(gatherTokens[0].isCancellationRequested).toBe(true);
    await vi.advanceTimersByTimeAsync(100);

    expect(await first).toBeUndefined();
    expect((await second)?.edit?.newText).toContain("outside-window");
    expect(requestCount).toBe(1);
    provider.dispose();
  });

  it("starts fresh after a cancelled pending request exhausts its grace window", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const source = mutableDocument(
      Array.from(
        { length: 12 },
        (_value, index) => `const value${index} = ${index};`,
      ).join("\n"),
    );
    vscodeState.documents.push(source.document);
    let releaseCancelledRequest: (() => void) | undefined;
    const cancelledRequestReleased = new Promise<void>((resolve) => {
      releaseCancelledRequest = resolve;
    });
    let requestCount = 0;
    let firstRequestToken: vscode.CancellationToken | undefined;
    const model = languageModel(async (_messages, _options, token) => {
      requestCount += 1;
      if (requestCount === 1) {
        firstRequestToken = token;
        return chatResponse(
          (async function* (): AsyncIterable<string> {
            await cancelledRequestReleased;
            if (token.isCancellationRequested) return;
            yield "<INSERT>\n + stale\n</INSERT>";
          })(),
        );
      }
      return chatResponse(
        (async function* (): AsyncIterable<string> {
          yield "<INSERT>\n + fresh\n</INSERT>";
        })(),
      );
    });
    const provider = providerFor(source.document, model, Date.now, {
      nextEdit: {
        requestDebounceMs: 0,
        diagnosticsStartDelayMs: 10_000,
      },
    });
    const firstConsumer = new vscodeApi.CancellationTokenSource();
    const first = provider.provide(
      input(source.document, 5, "cancelled-pending"),
      firstConsumer.token,
      false,
    );
    await vi.waitFor(() => expect(requestCount).toBe(1));
    firstConsumer.cancel();
    expect(firstRequestToken?.isCancellationRequested).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(firstRequestToken?.isCancellationRequested).toBe(true);

    const second = provider.provide(
      input(source.document, 5, "fresh-after-cancel"),
      cancellationToken(),
      false,
    );
    await vi.waitFor(() => expect(requestCount).toBe(2));
    releaseCancelledRequest?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(await first).toBeUndefined();
    expect((await second)?.edit?.newText).toContain("fresh");
    firstConsumer.dispose();
    provider.dispose();
  });

  it("keeps only one regular pending request across documents", async () => {
    const sourceA = mutableDocument(
      Array.from(
        { length: 12 },
        (_value, index) => `const alpha${index} = ${index};`,
      ).join("\n"),
      "file:///workspace/a.ts",
    );
    const sourceB = mutableDocument(
      Array.from(
        { length: 12 },
        (_value, index) => `const beta${index} = ${index};`,
      ).join("\n"),
      "file:///workspace/b.ts",
    );
    vscodeState.documents.push(sourceA.document, sourceB.document);
    let requestCount = 0;
    let firstRequestToken: vscode.CancellationToken | undefined;
    const model = languageModel(async (_messages, _options, token) => {
      requestCount += 1;
      if (requestCount === 1) {
        firstRequestToken = token;
        return chatResponse(
          (async function* (): AsyncIterable<string> {
            await new Promise<void>((resolve) =>
              token.onCancellationRequested(resolve),
            );
          })(),
        );
      }
      return chatResponse(
        (async function* (): AsyncIterable<string> {
          yield "<INSERT>\n + document-b\n</INSERT>";
        })(),
      );
    });
    const provider = providerFor(sourceA.document, model, Date.now, {
      related: [sourceB.document],
      nextEdit: {
        asyncCompletions: false,
        requestDebounceMs: 0,
        diagnosticsStartDelayMs: 10_000,
      },
    });
    const first = provider.provide(
      input(sourceA.document, 5, "document-a"),
      cancellationToken(),
      false,
    );
    await vi.waitFor(() => expect(requestCount).toBe(1));
    expect(provider.getState().inFlight).toBe(1);
    const second = provider.provide(
      input(sourceB.document, 5, "document-b"),
      cancellationToken(),
      false,
    );
    await vi.waitFor(() => expect(requestCount).toBe(2));

    expect(firstRequestToken?.isCancellationRequested).toBe(true);
    expect(provider.getState().inFlight).toBeLessThanOrEqual(1);
    expect(await first).toBeUndefined();
    expect((await second)?.edit?.newText).toContain("document-b");
    provider.dispose();
  });

  it("waits for and then replaces an incompatible async request from another document", async () => {
    const textA = Array.from(
      { length: 12 },
      (_value, index) => `const alpha${index} = ${index};`,
    ).join("\n");
    const textB = Array.from(
      { length: 12 },
      (_value, index) => `function beta${index}() { return ${index * 7}; }`,
    ).join("\n");
    const sourceA = mutableDocument(textA, "file:///workspace/a.ts");
    const sourceB = mutableDocument(textB, "file:///workspace/b.ts");
    vscodeState.documents.push(sourceA.document, sourceB.document);
    let releaseFirstEdit: (() => void) | undefined;
    const firstEditReleased = new Promise<void>((resolve) => {
      releaseFirstEdit = resolve;
    });
    let releaseRemainder: (() => void) | undefined;
    const remainderReleased = new Promise<void>((resolve) => {
      releaseRemainder = resolve;
    });
    let requestCount = 0;
    const model = languageModel(async () => {
      requestCount += 1;
      if (requestCount === 1) {
        return chatResponse(
          (async function* (): AsyncIterable<string> {
            await firstEditReleased;
            yield "<INSERT>\n + alpha-result\n";
            await remainderReleased;
            yield "</INSERT>";
          })(),
        );
      }
      return chatResponse(
        (async function* (): AsyncIterable<string> {
          yield "<INSERT>\n + beta-result\n</INSERT>";
        })(),
      );
    });
    const provider = providerFor(sourceA.document, model, Date.now, {
      related: [sourceB.document],
      nextEdit: {
        asyncCompletions: true,
        requestDebounceMs: 0,
        diagnosticsStartDelayMs: 10_000,
      },
    });
    const first = provider.provide(
      input(sourceA.document, 5, "async-a"),
      cancellationToken(),
      false,
    );
    await vi.waitFor(() => expect(requestCount).toBe(1));
    const second = provider.provide(
      input(sourceB.document, 5, "async-b"),
      cancellationToken(),
      false,
    );
    releaseFirstEdit?.();
    expect((await first)?.edit?.newText).toContain("alpha-result");
    expect(requestCount).toBe(1);
    releaseRemainder?.();
    await vi.waitFor(() => expect(requestCount).toBe(2));
    const secondResult = await second;

    expect(secondResult).toMatchObject({
      requestId: "async-b",
      sourceRequestId: "async-b",
      edit: { uri: sourceB.document.uri.toString() },
    });
    expect(secondResult?.edit?.newText).toContain("beta-result");
    provider.dispose();
  });

  it("shares a same-text global pending request across document URIs", async () => {
    const text = Array.from(
      { length: 12 },
      (_value, index) => `const shared${index} = ${index};`,
    ).join("\n");
    const sourceA = mutableDocument(text, "file:///workspace/a.ts");
    const sourceB = mutableDocument(text, "file:///workspace/b.ts");
    vscodeState.documents.push(sourceA.document, sourceB.document);
    let release: (() => void) | undefined;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let requestCount = 0;
    const provider = providerFor(
      sourceA.document,
      languageModel(async () => {
        requestCount += 1;
        return chatResponse(
          (async function* (): AsyncIterable<string> {
            await released;
            yield "<INSERT>\n + shared-result\n</INSERT>";
          })(),
        );
      }),
      Date.now,
      {
        related: [sourceB.document],
        nextEdit: {
          asyncCompletions: true,
          requestDebounceMs: 0,
          diagnosticsStartDelayMs: 10_000,
        },
      },
    );
    const first = provider.provide(
      input(sourceA.document, 5, "same-text-a"),
      cancellationToken(),
      false,
    );
    await vi.waitFor(() => expect(requestCount).toBe(1));
    const second = provider.provide(
      input(sourceB.document, 5, "same-text-b"),
      cancellationToken(),
      false,
    );
    release?.();
    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(requestCount).toBe(1);
    expect(firstResult).not.toBe(secondResult);
    expect(secondResult).toMatchObject({
      requestId: "same-text-b",
      sourceRequestId: "same-text-b",
      edit: { uri: sourceA.document.uri.toString() },
    });
    provider.dispose();
  });

  it("rebases a cross-URI join only through the source request's tracked edit", async () => {
    const sourceText = Array.from(
      { length: 12 },
      (_value, index) => `const value${index} = ${index};`,
    ).join("\n");
    const sourceCursorOffset = offsetAt(
      sourceText,
      new vscodeApi.Position(5, 12),
    );
    const typedPrefix = " +";
    const trackedText = `${sourceText.slice(0, sourceCursorOffset)}${typedPrefix}${sourceText.slice(sourceCursorOffset)}`;
    const sourceA = mutableDocument(sourceText, "file:///workspace/a.ts");
    const sourceB = mutableDocument(trackedText, "file:///workspace/b.ts");
    vscodeState.documents.push(sourceA.document, sourceB.document);
    let releaseResponse: (() => void) | undefined;
    const responseReleased = new Promise<void>((resolve) => {
      releaseResponse = resolve;
    });
    let requestCount = 0;
    const provider = providerFor(
      sourceA.document,
      languageModel(async () => {
        requestCount += 1;
        return chatResponse(
          (async function* (): AsyncIterable<string> {
            await responseReleased;
            yield "<INSERT>\n + tracked-result\n</INSERT>";
          })(),
        );
      }),
      Date.now,
      {
        related: [sourceB.document],
        nextEdit: { asyncCompletions: true },
      },
    );
    const sourceRequest = provider.provide(
      input(sourceA.document, 5, "tracked-source-a"),
      cancellationToken(),
      false,
    );
    await vi.waitFor(() => expect(requestCount).toBe(1));
    sourceA.setText(trackedText);
    fireDocumentChange(sourceA.document, [
      {
        range: new vscodeApi.Range(
          new vscodeApi.Position(5, 12),
          new vscodeApi.Position(5, 12),
        ),
        rangeOffset: sourceCursorOffset,
        rangeLength: 0,
        text: typedPrefix,
      },
    ]);
    const callerInput = input(sourceB.document, 5, "tracked-caller-b");
    const crossUriCaller = provider.provide(
      {
        ...callerInput,
        position: new vscodeApi.Position(5, 12 + typedPrefix.length),
      },
      cancellationToken(),
      false,
    );
    releaseResponse?.();
    const [sourceResult, callerResult] = await Promise.all([
      sourceRequest,
      crossUriCaller,
    ]);

    expect(requestCount).toBe(1);
    expect(sourceResult).toBeUndefined();
    expect(callerResult).toMatchObject({
      requestId: "tracked-caller-b",
      sourceRequestId: "tracked-caller-b",
      rebased: true,
      edit: { uri: sourceA.document.uri.toString() },
    });
    provider.dispose();
  });

  it("joins the exact replacement pending after async rebase failure outside its cursor window", async () => {
    const sourceA = mutableDocument(
      Array.from(
        { length: 40 },
        (_value, index) => `const aaaaa${index} = ${index};`,
      ).join("\n"),
      "file:///workspace/a.ts",
    );
    const sourceB = mutableDocument(
      Array.from(
        { length: 40 },
        (_value, index) => `const bbbbb${index} = ${index};`,
      ).join("\n"),
      "file:///workspace/b.ts",
    );
    vscodeState.documents.push(sourceA.document, sourceB.document);
    let releaseOldRemainder: (() => void) | undefined;
    const oldRemainderReleased = new Promise<void>((resolve) => {
      releaseOldRemainder = resolve;
    });
    let releaseReplacement: (() => void) | undefined;
    const replacementReleased = new Promise<void>((resolve) => {
      releaseReplacement = resolve;
    });
    let requestCount = 0;
    const provider = providerFor(
      sourceA.document,
      languageModel(async () => {
        requestCount += 1;
        if (requestCount === 1) {
          return chatResponse(
            (async function* (): AsyncIterable<string> {
              yield "<INSERT>\n + old\n";
              await oldRemainderReleased;
              yield "</INSERT>";
            })(),
          );
        }
        return chatResponse(
          (async function* (): AsyncIterable<string> {
            await replacementReleased;
            yield "<INSERT>\n + replacement\n</INSERT>";
          })(),
        );
      }),
      Date.now,
      {
        related: [sourceB.document],
        nextEdit: { asyncCompletions: true },
      },
    );
    expect(
      await provider.provide(
        input(sourceA.document, 20, "async-race-origin"),
        cancellationToken(),
        false,
      ),
    ).toBeDefined();
    const nearCaller = provider.provide(
      input(sourceB.document, 18, "async-race-near"),
      cancellationToken(),
      false,
    );
    const farCaller = provider.provide(
      input(sourceB.document, 28, "async-race-far"),
      cancellationToken(),
      false,
    );
    await Promise.resolve();
    expect(requestCount).toBe(1);
    releaseOldRemainder?.();
    await vi.waitFor(() => expect(requestCount).toBe(2));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(requestCount).toBe(2);
    releaseReplacement?.();
    const [nearResult, farResult] = await Promise.all([nearCaller, farCaller]);

    expect(requestCount).toBe(2);
    expect(nearResult).toMatchObject({
      requestId: "async-race-near",
      sourceRequestId: "async-race-near",
      edit: { uri: sourceB.document.uri.toString() },
    });
    expect(farResult).toMatchObject({
      requestId: "async-race-far",
      sourceRequestId: "async-race-far",
      edit: { uri: sourceB.document.uri.toString() },
    });
    provider.dispose();
  });

  it.each(["context", "debounce"] as const)(
    "suppresses the fresh caller but caches source edits tracked during $phase preparation",
    async (phase) => {
      vi.useFakeTimers();
      vi.setSystemTime(1_000);
      const sourceText = Array.from(
        { length: 12 },
        (_value, index) => `const value${index} = ${index};`,
      ).join("\n");
      const source = mutableDocument(sourceText);
      vscodeState.documents.push(source.document);
      let requestCount = 0;
      const provider = providerFor(
        source.document,
        languageModel(async () => {
          requestCount += 1;
          return chatResponse(
            (async function* (): AsyncIterable<string> {
              const lines = sourceText.split("\n").slice(3, 11);
              lines[2] = "const value5 = 500;";
              yield `<EDIT>\n${lines.join("\n")}\n</EDIT>`;
            })(),
          );
        }),
        Date.now,
        {
          gatherContextDelayMs: phase === "context" ? 100 : 0,
          nextEdit: {
            asyncCompletions: true,
            requestDebounceMs: phase === "debounce" ? 100 : 0,
            diagnosticsStartDelayMs: 10_000,
          },
        },
      );
      const originalInput = input(source.document, 5, `track-during-${phase}`);
      const pending = provider.provide(
        originalInput,
        cancellationToken(),
        false,
      );
      await vi.advanceTimersByTimeAsync(0);
      const insertionOffset =
        sourceText.indexOf("5;", sourceText.indexOf("value5")) + 1;
      source.setText(
        `${sourceText.slice(0, insertionOffset)}0${sourceText.slice(insertionOffset)}`,
      );
      fireDocumentChange(source.document, [
        {
          range: new vscodeApi.Range(
            new vscodeApi.Position(5, 16),
            new vscodeApi.Position(5, 16),
          ),
          rangeOffset: insertionOffset,
          rangeLength: 0,
          text: "0",
        },
      ]);
      await vi.advanceTimersByTimeAsync(100);
      const result = await pending;

      expect(requestCount).toBe(1);
      expect(result).toBeUndefined();
      const cached = await provider.provide(
        input(source.document, 5, `track-after-${phase}`),
        cancellationToken(),
        false,
      );
      expect(cached).toMatchObject({
        fromCache: true,
        rebased: true,
        edit: {
          newText: "00",
        },
      });
      provider.dispose();
    },
  );

  it("suppresses an inconsistent caller while preserving its streamed cache", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const sourceText = Array.from(
      { length: 12 },
      (_value, index) => `const value${index} = ${index};`,
    ).join("\n");
    const source = mutableDocument(sourceText);
    vscodeState.documents.push(source.document);
    let requestCount = 0;
    let requestToken: vscode.CancellationToken | undefined;
    let releaseRemainder: (() => void) | undefined;
    const remainderReleased = new Promise<void>((resolve) => {
      releaseRemainder = resolve;
    });
    const [firstChunk, remainderChunk] = splitUnifiedEditWindow(
      sourceText,
      {
        5: "const value5 = 500;",
        7: "const value7 = 700;",
      },
      6,
    );
    const provider = providerFor(
      source.document,
      languageModel(async (_messages, _options, token) => {
        requestCount += 1;
        requestToken = token;
        return chatResponse(
          (async function* (): AsyncIterable<string> {
            yield firstChunk;
            await remainderReleased;
            yield remainderChunk;
          })(),
        );
      }),
      Date.now,
      {
        gatherContextDelayMs: 100,
        nextEdit: {
          asyncCompletions: true,
          requestDebounceMs: 0,
          diagnosticsStartDelayMs: 0,
          diagnosticsRaceDeadlineMs: 0,
        },
      },
    );
    const pending = provider.provide(
      input(source.document, 5, "inconsistent-preparation"),
      cancellationToken(),
      false,
    );
    await vi.advanceTimersByTimeAsync(0);
    source.setText(`Y${sourceText}`);
    fireDocumentChange(source.document, [
      {
        range: new vscodeApi.Range(
          new vscodeApi.Position(0, 0),
          new vscodeApi.Position(0, 0),
        ),
        rangeOffset: 0,
        rangeLength: 0,
        text: "X",
      },
    ]);
    expect(requestToken?.isCancellationRequested ?? false).toBe(false);
    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(0);

    expect(await pending).toBeUndefined();
    expect(requestCount).toBe(1);
    releaseRemainder?.();
    await vi.advanceTimersByTimeAsync(0);
    await vi.waitFor(() => expect(provider.getState().inFlight).toBe(0));

    source.setText(sourceText);
    fireDocumentChange(source.document, [
      {
        range: new vscodeApi.Range(
          new vscodeApi.Position(0, 0),
          new vscodeApi.Position(0, 1),
        ),
        rangeOffset: 0,
        rangeLength: 1,
        text: "",
      },
    ]);
    const cached = await provider.provide(
      input(source.document, 5, "inconsistent-restored-cache"),
      cancellationToken(),
      false,
    );
    expect(cached).toMatchObject({
      fromCache: true,
      sourceRequestId: "inconsistent-preparation",
    });
    expect(cached?.cacheEntry?.edits).toHaveLength(2);
    expect(requestCount).toBe(1);
    provider.dispose();
  });

  it("disposes fresh edit tracking even when transport ignores cancellation", async () => {
    const source = mutableDocument(
      Array.from(
        { length: 12 },
        (_value, index) => `const value${index} = ${index};`,
      ).join("\n"),
    );
    vscodeState.documents.push(source.document);
    let requestCount = 0;
    let transportToken: vscode.CancellationToken | undefined;
    const never = new Promise<void>(() => undefined);
    const provider = providerFor(
      source.document,
      languageModel(async (_messages, _options, token) => {
        requestCount += 1;
        transportToken = token;
        return chatResponse(
          (async function* (): AsyncIterable<string> {
            await never;
          })(),
        );
      }),
      Date.now,
      { nextEdit: { asyncCompletions: true } },
    );
    const providerListenerCount = vscodeState.changeListeners.size;
    expect(providerListenerCount).toBeGreaterThan(0);
    void provider.provide(
      input(source.document, 5, "hanging-edit-tracker"),
      cancellationToken(),
      false,
    );
    await vi.waitFor(() => expect(requestCount).toBe(1));
    expect(vscodeState.changeListeners.size).toBe(providerListenerCount + 1);

    provider.dispose();

    expect(transportToken?.isCancellationRequested).toBe(true);
    expect(vscodeState.changeListeners.size).toBe(0);
  });

  it("preserves the first edit when the stream remainder throws", async () => {
    const sourceText = Array.from(
      { length: 12 },
      (_value, index) => `const value${index} = ${index};`,
    ).join("\n");
    const source = mutableDocument(sourceText);
    vscodeState.documents.push(source.document);
    let releaseFirstEdit: (() => void) | undefined;
    const firstEditReleased = new Promise<void>((resolve) => {
      releaseFirstEdit = resolve;
    });
    const [firstChunk] = splitUnifiedEditWindow(
      sourceText,
      { 5: "const stableValue5 = 500;" },
      6,
    );
    let requestCount = 0;
    const model = languageModel(async () => {
      requestCount += 1;
      return chatResponse(
        (async function* (): AsyncIterable<string> {
          await firstEditReleased;
          yield firstChunk;
          throw new Error("remainder failed");
        })(),
      );
    });
    const provider = providerFor(source.document, model, Date.now, {
      nextEdit: {
        requestDebounceMs: 0,
        diagnosticsStartDelayMs: 10_000,
      },
    });
    const request = input(source.document, 5, "throwing-remainder");
    const fresh = provider.provide(request, cancellationToken(), false);
    await vi.waitFor(() => expect(requestCount).toBe(1));
    const joined = provider.provide(request, cancellationToken(), false);
    releaseFirstEdit?.();
    const [freshResult, joinedResult] = await Promise.all([fresh, joined]);

    expect(freshResult?.edit?.newText).toContain("stableValue5");
    expect(joinedResult?.edit).toEqual(freshResult?.edit);
    expect(provider.getState().cacheSize).toBe(1);
    provider.dispose();
  });

  it("keeps the fresh attachment through a slow remainder and makes reuse wait for stream end", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const sourceText = Array.from(
      { length: 12 },
      (_value, index) => `const value${index} = ${index};`,
    ).join("\n");
    const source = mutableDocument(sourceText);
    vscodeState.documents.push(source.document);
    let releaseFirstEdit: (() => void) | undefined;
    const firstEditReleased = new Promise<void>((resolve) => {
      releaseFirstEdit = resolve;
    });
    let releaseRemainder: (() => void) | undefined;
    const remainderReleased = new Promise<void>((resolve) => {
      releaseRemainder = resolve;
    });
    const [firstChunk, remainderChunk] = splitUnifiedEditWindow(
      sourceText,
      {
        5: "const expandedValue5 = 500;",
        7: "const value7 = 700;",
      },
      6,
    );
    let requestToken: vscode.CancellationToken | undefined;
    let requestCount = 0;
    const model = languageModel(async (_messages, _options, token) => {
      requestCount += 1;
      requestToken = token;
      return chatResponse(
        (async function* (): AsyncIterable<string> {
          await firstEditReleased;
          yield firstChunk;
          await remainderReleased;
          yield remainderChunk;
        })(),
      );
    });
    const provider = providerFor(source.document, model, Date.now, {
      nextEdit: {
        requestDebounceMs: 0,
        diagnosticsStartDelayMs: 10_000,
      },
    });
    const request = input(source.document, 5, "slow-remainder");
    let firstSettled = false;
    const firstPending = provider
      .provide(request, cancellationToken(), false)
      .then((value) => {
        firstSettled = true;
        return value;
      });
    await vi.waitFor(() => expect(requestCount).toBe(1));
    let joinedSettled = false;
    const joined = provider
      .provide(
        input(source.document, 5, "slow-remainder-joined"),
        cancellationToken(),
        false,
      )
      .then((value) => {
        joinedSettled = true;
        return value;
      });
    await vi.advanceTimersByTimeAsync(0);
    expect(firstSettled).toBe(false);
    expect(joinedSettled).toBe(false);
    releaseFirstEdit?.();
    await vi.advanceTimersByTimeAsync(0);
    const first = await firstPending;
    if (!first?.edit) throw new Error("Expected the first slow-stream edit.");
    expect(joinedSettled).toBe(false);

    const cachedWhileStreaming = await provider.provide(
      input(source.document, 5, "slow-remainder-cache"),
      cancellationToken(),
      false,
    );
    expect(cachedWhileStreaming).toMatchObject({
      requestId: "slow-remainder-cache",
      sourceRequestId: "slow-remainder",
      fromCache: true,
      subsequent: false,
      edit: first.edit,
    });
    expect(joinedSettled).toBe(false);
    expect(requestCount).toBe(1);

    await vi.advanceTimersByTimeAsync(1_001);
    expect(requestToken?.isCancellationRequested).toBe(false);
    expect(joinedSettled).toBe(false);
    expect(provider.getState().inFlight).toBe(1);
    releaseRemainder?.();
    await vi.advanceTimersByTimeAsync(0);
    expect((await joined)?.edit).toEqual(first.edit);
    const joinedResult = await joined;
    expect(first).not.toBe(joinedResult);
    expect(cachedWhileStreaming).not.toBe(first);
    expect(first).toMatchObject({
      requestId: "slow-remainder",
      sourceRequestId: "slow-remainder",
    });
    expect(joinedResult).toMatchObject({
      requestId: "slow-remainder-joined",
      sourceRequestId: "slow-remainder-joined",
    });
    await vi.waitFor(() => expect(provider.getState().inFlight).toBe(0));

    const firstEdit = first.edit;
    const acceptedText = `${sourceText.slice(0, firstEdit.startOffset)}${
      firstEdit.newText
    }${sourceText.slice(firstEdit.endOffset)}`;
    const firstDelta =
      firstEdit.newText.length - (firstEdit.endOffset - firstEdit.startOffset);
    source.setText(acceptedText);
    provider.handleAccepted(first);
    const subsequent = await provider.provide(
      input(source.document, 7, "slow-remainder-subsequent"),
      cancellationToken(),
      false,
    );
    expect(subsequent).toMatchObject({
      fromCache: true,
      subsequent: true,
      edit: {
        startOffset:
          sourceText.indexOf("7;", sourceText.indexOf("value7")) +
          firstDelta +
          1,
        newText: "00",
      },
    });
    provider.dispose();
  });

  it("cancels the remaining stream after the reattachment grace expires", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const source = mutableDocument(
      Array.from(
        { length: 12 },
        (_value, index) => `const value${index} = ${index};`,
      ).join("\n"),
    );
    vscodeState.documents.push(source.document);
    let releaseRemainder: (() => void) | undefined;
    const remainderReleased = new Promise<void>((resolve) => {
      releaseRemainder = resolve;
    });
    const [firstChunk, remainderChunk] = splitUnifiedEditWindow(
      source.document.getText(),
      { 5: "const value5 = 500;" },
      6,
    );
    let requestToken: vscode.CancellationToken | undefined;
    const provider = providerFor(
      source.document,
      languageModel(async (_messages, _options, token) => {
        requestToken = token;
        return chatResponse(
          (async function* (): AsyncIterable<string> {
            yield firstChunk;
            await remainderReleased;
            yield remainderChunk;
          })(),
        );
      }),
      Date.now,
      {
        eagerness: "high",
        nextEdit: {
          requestDebounceMs: 0,
          diagnosticsStartDelayMs: 10_000,
        },
      },
    );
    const consumer = new vscodeApi.CancellationTokenSource();
    const firstPending = provider.provide(
      input(source.document, 5, "cancel-after-first"),
      consumer.token,
      false,
    );
    await vi.advanceTimersByTimeAsync(3_000);
    const first = await firstPending;
    expect(first?.edit).toBeDefined();
    consumer.cancel();
    expect(requestToken?.isCancellationRequested).toBe(false);
    await vi.advanceTimersByTimeAsync(999);
    expect(requestToken?.isCancellationRequested).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(requestToken?.isCancellationRequested).toBe(true);
    releaseRemainder?.();
    await vi.advanceTimersByTimeAsync(0);
    await vi.waitFor(() => expect(provider.getState().inFlight).toBe(0));
    consumer.dispose();
    provider.dispose();
  });

  it("cancels the remaining NES stream with its scheduler consumer", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const source = mutableDocument(
      Array.from(
        { length: 12 },
        (_value, index) => `const value${index} = ${index};`,
      ).join("\n"),
    );
    vscodeState.documents.push(source.document);
    let releaseRemainder: (() => void) | undefined;
    const remainderReleased = new Promise<void>((resolve) => {
      releaseRemainder = resolve;
    });
    const [firstChunk, remainderChunk] = splitUnifiedEditWindow(
      source.document.getText(),
      { 5: "const value5 = 500;" },
      6,
    );
    let requestToken: vscode.CancellationToken | undefined;
    const provider = providerFor(
      source.document,
      languageModel(async (_messages, _options, token) => {
        requestToken = token;
        return chatResponse(
          (async function* (): AsyncIterable<string> {
            yield firstChunk;
            await remainderReleased;
            yield remainderChunk;
          })(),
        );
      }),
      Date.now,
      {
        eagerness: "high",
        nextEdit: {
          requestDebounceMs: 0,
          diagnosticsStartDelayMs: 10_000,
        },
      },
    );
    const parent = trackedCancellationSource();
    const scheduledPending = scheduleCompletionProviders(
      [
        {
          provider: { id: "nes", algorithm: "copilot-replica" },
          run: async (token) => {
            const suggestion = await provider.provide(
              input(source.document, 5, "scheduler-stream"),
              token,
              false,
            );
            return suggestion?.edit
              ? {
                  providerId: "nes",
                  items: [{ insertText: suggestion.edit.newText }],
                }
              : undefined;
          },
        },
      ],
      { mode: "all", stopWhen: { type: "firstUsable" } },
      parent.token,
    );
    await vi.advanceTimersByTimeAsync(3_000);
    const scheduled = await scheduledPending;
    expect(scheduled).toHaveLength(1);
    expect(provider.getState().inFlight).toBe(1);
    expect(parent.listenerCount).toBe(1);

    parent.cancel();
    expect(parent.listenerCount).toBe(0);
    expect(requestToken?.isCancellationRequested).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(requestToken?.isCancellationRequested).toBe(true);

    releaseRemainder?.();
    await vi.advanceTimersByTimeAsync(0);
    await vi.waitFor(() => expect(provider.getState().inFlight).toBe(0));
    expect(parent.listenerCount).toBe(0);
    provider.dispose();
  });

  it("deducts context gathering from Invoke debounce time", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const source = Array.from(
      { length: 12 },
      (_value, index) => `const value${index} = ${index};`,
    ).join("\n");
    const mutable = mutableDocument(source);
    vscodeState.documents.push(mutable.document);
    let requestCount = 0;
    const contextRequests: CopilotWorkspaceContextRequest[] = [];
    const model = languageModel(async () => {
      requestCount += 1;
      return chatResponse(
        (async function* (): AsyncIterable<string> {
          yield "<INSERT>\n + invoke\n</INSERT>";
        })(),
      );
    });
    const provider = providerFor(mutable.document, model, Date.now, {
      gatherContextDelayMs: 60,
      onGatherContextRequest: (request) => contextRequests.push(request),
      nextEdit: {
        requestDebounceMs: 100,
      },
    });
    const result = provider.provide(
      input(mutable.document, 5, "invoke-context-time"),
      cancellationToken(),
      false,
    );
    await vi.advanceTimersByTimeAsync(99);
    expect(requestCount).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(requestCount).toBe(1);
    expect(contextRequests).toEqual([
      expect.objectContaining({
        timeoutEndMs: 1_100,
        includeLanguageContext: false,
      }),
    ]);
    expect((await result)?.edit).toBeDefined();
    provider.dispose();
  });

  it("applies the frozen 2000ms end-of-line extra debounce", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const source = Array.from(
      { length: 12 },
      (_value, index) => `const value${index} = ${index};`,
    ).join("\n");
    const mutable = mutableDocument(source);
    vscodeState.documents.push(mutable.document);
    let requestCount = 0;
    const contextRequests: CopilotWorkspaceContextRequest[] = [];
    const model = languageModel(async () => {
      requestCount += 1;
      return chatResponse(
        (async function* (): AsyncIterable<string> {
          yield "<INSERT>\n + eol\n</INSERT>";
        })(),
      );
    });
    const provider = providerFor(mutable.document, model, Date.now, {
      onGatherContextRequest: (request) => contextRequests.push(request),
      nextEdit: {
        requestDebounceMs: 100,
      },
    });
    const request = input(mutable.document, 5, "eol-delay");
    const lineText = mutable.document.lineAt(5).text;
    const result = provider.provide(
      { ...request, position: new vscodeApi.Position(5, lineText.length) },
      cancellationToken(),
      false,
    );
    await vi.advanceTimersByTimeAsync(2_099);
    expect(requestCount).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(requestCount).toBe(1);
    expect(contextRequests).toEqual([
      expect.objectContaining({ timeoutEndMs: 3_100 }),
    ]);
    expect((await result)?.edit).toBeDefined();
    provider.dispose();
  });

  it("delays the first raw EditWindow candidate before substring filtering", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const source = Array.from(
      { length: 12 },
      (_value, index) => `const value${index} = ${index};`,
    ).join("\n");
    const mutable = mutableDocument(source);
    vscodeState.documents.push(mutable.document);
    const output = Array.from({ length: 8 }, (_value, index) =>
      index === 2
        ? "<|current_file_content|>"
        : `const value${index + 3} = ${index + 3};`,
    ).join("\n");
    const model = languageModel(
      async () =>
        chatResponse(
          (async function* (): AsyncIterable<string> {
            yield output;
          })(),
        ),
      { supportsNextCursorLinePrediction: false },
    );
    const provider = providerFor(mutable.document, model, Date.now, {
      strategy: "xtab275",
      eagerness: "low",
      nextEdit: {
        requestDebounceMs: 100,
      },
    });
    let settled = false;
    const result = provider
      .provide(
        input(mutable.document, 5, "filtered-raw-delay"),
        cancellationToken(),
        false,
      )
      .then((value) => {
        settled = true;
        return value;
      });
    await vi.advanceTimersByTimeAsync(1_499);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await result).toBeUndefined();
    provider.dispose();
  });

  it("filters edit intent before artificial delay", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const source = Array.from(
      { length: 12 },
      (_value, index) => `const value${index} = ${index};`,
    ).join("\n");
    const mutable = mutableDocument(source);
    vscodeState.documents.push(mutable.document);
    const model = languageModel(
      async () =>
        chatResponse(
          (async function* (): AsyncIterable<string> {
            yield "<|edit_intent|>no_edit<|/edit_intent|>\n";
          })(),
        ),
      { supportsNextCursorLinePrediction: false },
    );
    const provider = providerFor(mutable.document, model, Date.now, {
      strategy: "xtab275EditIntent",
      nextEdit: {
        requestDebounceMs: 100,
      },
    });
    provider.handleRejected({
      branch: "nes",
      source: "llm",
      requestId: "prior-rejection",
      sourceRequestId: "prior-rejection",
      fromCache: false,
      rebased: false,
      subsequent: false,
      speculative: false,
      sourceIsSpeculative: false,
      createdAt: 900,
    });
    let settled = false;
    const result = provider
      .provide(
        input(mutable.document, 5, "intent-before-delay"),
        cancellationToken(),
        false,
      )
      .then((value) => {
        settled = true;
        return value;
      });
    await vi.advanceTimersByTimeAsync(99);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await result).toBeUndefined();
    expect(settled).toBe(true);
    provider.dispose();
  });

  it("hot-updates eagerness without losing interaction state", () => {
    const source = mutableDocument(
      Array.from(
        { length: 12 },
        (_value, index) => `const value${index} = ${index};`,
      ).join("\n"),
    );
    const provider = providerFor(
      source.document,
      languageModel(async () =>
        chatResponse((async function* (): AsyncIterable<string> {})()),
      ),
    );
    provider.handleAccepted({
      branch: "nes",
      source: "llm",
      requestId: "accepted-before-update",
      sourceRequestId: "accepted-before-update",
      fromCache: false,
      rebased: false,
      subsequent: false,
      speculative: false,
      sourceIsSpeculative: false,
      createdAt: 1,
    });
    provider.setEagerness("low");
    expect(provider.getState().userInteraction).toMatchObject({
      aggressivenessLevel: "low",
      wasLastActionAcceptance: true,
      aggressivenessActions: [expect.objectContaining({ kind: "accepted" })],
    });
    provider.dispose();
  });

  it("applies edit-intent filtering with the provider eagerness level", async () => {
    const source = Array.from(
      { length: 12 },
      (_value, index) => `const value${index} = ${index};`,
    ).join("\n");
    const output = [
      "<|edit_intent|>low<|/edit_intent|>",
      ...Array.from({ length: 8 }, (_value, index) =>
        index === 2
          ? "const value5 = 500;"
          : `const value${index + 3} = ${index + 3};`,
      ),
    ].join("\n");
    const makeModel = () =>
      languageModel(async () =>
        chatResponse(
          (async function* (): AsyncIterable<string> {
            yield output;
          })(),
        ),
      );

    const mediumDocument = mutableDocument(source);
    vscodeState.documents.push(mediumDocument.document);
    const medium = providerFor(mediumDocument.document, makeModel(), Date.now, {
      strategy: "xtab275EditIntent",
      eagerness: "medium",
    });
    expect(
      await medium.provide(
        input(mediumDocument.document, 5, "medium-intent"),
        cancellationToken(),
        false,
      ),
    ).toBeUndefined();
    expect(medium.getState().cacheSize).toBe(0);
    medium.dispose();

    const highDocument = mutableDocument(
      source,
      "file:///workspace/high-intent.ts",
    );
    vscodeState.documents.push(highDocument.document);
    const high = providerFor(highDocument.document, makeModel(), Date.now, {
      strategy: "xtab275EditIntent",
      eagerness: "high",
    });
    expect(
      (
        await high.provide(
          input(highDocument.document, 5, "high-intent"),
          cancellationToken(),
          false,
        )
      )?.edit?.newText,
    ).toBe("00");
    high.dispose();
  });

  it("uses the strict one-second rejection threshold only for LLM suggestions", async () => {
    const source = Array.from(
      { length: 12 },
      (_value, index) => `const value${index} = ${index};`,
    ).join("\n");
    const mutable = mutableDocument(source);
    vscodeState.documents.push(mutable.document);
    let now = 0;
    let requestCount = 0;
    const model = languageModel(async (_messages, options) => {
      requestCount += 1;
      const value =
        options.modelOptions?.max_tokens !== undefined
          ? "not a cursor prediction"
          : "<INSERT>\n + rejected\n</INSERT>";
      return chatResponse(
        (async function* (): AsyncIterable<string> {
          yield value;
        })(),
      );
    });
    const provider = providerFor(mutable.document, model, () => now);
    const first = await provider.provide(
      input(mutable.document),
      cancellationToken(),
      false,
    );
    expect(first?.edit).toBeDefined();
    if (!first) {
      throw new Error("Expected the first model suggestion.");
    }
    provider.handleShown(first, true);
    now = 1_000;
    provider.handleRejected(first);

    const second = await provider.provide(
      input(mutable.document, 5, "request-2"),
      cancellationToken(),
      false,
    );
    expect(second).toMatchObject({ fromCache: true });
    if (!second) {
      throw new Error("Expected the cache hit at the strict threshold.");
    }
    provider.handleShown(second, true);
    now = 2_001;
    provider.handleRejected(second);

    const third = await provider.provide(
      input(mutable.document, 5, "request-3"),
      cancellationToken(),
      false,
    );
    expect(third).toBeUndefined();
    expect(requestCount).toBe(1);
    expect(provider.getState().cacheSize).toBe(1);
    provider.dispose();
  });

  it("keeps origin siblings when a joined caller rejects the shown edit", async () => {
    const sourceText = Array.from(
      { length: 12 },
      (_value, index) => `const value${index} = ${index};`,
    ).join("\n");
    const source = mutableDocument(sourceText);
    vscodeState.documents.push(source.document);
    let now = 0;
    let releaseFirst: (() => void) | undefined;
    const firstReleased = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let releaseSecond: (() => void) | undefined;
    const secondReleased = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });
    const [firstChunk, secondChunk] = splitUnifiedEditWindow(
      sourceText,
      {
        5: "const value5 = 500;",
        7: "const value7 = 700;",
      },
      6,
    );
    let requestCount = 0;
    const model = languageModel(async () => {
      requestCount += 1;
      return chatResponse(
        (async function* (): AsyncIterable<string> {
          await firstReleased;
          yield firstChunk;
          await secondReleased;
          yield secondChunk;
        })(),
      );
    });
    const provider = providerFor(source.document, model, () => now);
    const firstPromise = provider.provide(
      input(source.document, 5, "joined-reject-origin"),
      cancellationToken(),
      false,
    );
    await vi.waitFor(() => expect(requestCount).toBe(1));
    const joinedPromise = provider.provide(
      input(source.document, 5, "joined-reject-caller"),
      cancellationToken(),
      false,
    );
    releaseFirst?.();
    const first = await firstPromise;
    if (!first?.edit) throw new Error("Expected the first streamed edit.");
    releaseSecond?.();
    const joined = await joinedPromise;
    expect(joined).toMatchObject({
      requestId: "joined-reject-caller",
      sourceRequestId: "joined-reject-caller",
      edit: { newText: "00" },
    });
    if (!joined) throw new Error("Expected the joined edit.");
    provider.handleShown(joined, true);
    now = 1_001;
    provider.handleRejected(joined);

    expect(
      await provider.provide(
        input(source.document, 5, "joined-rejected-exact"),
        cancellationToken(),
        false,
      ),
    ).toBeUndefined();
    const afterFirst = `${sourceText.slice(0, first.edit.startOffset)}${
      first.edit.newText
    }${sourceText.slice(first.edit.endOffset)}`;
    source.setText(afterFirst);
    expect(
      await provider.provide(
        input(source.document, 7, "joined-reject-sibling"),
        cancellationToken(),
        false,
      ),
    ).toMatchObject({
      fromCache: true,
      subsequent: true,
      sourceRequestId: "joined-reject-origin",
      edit: { newText: "00" },
    });
    expect(requestCount).toBe(1);
    provider.dispose();
  });

  it("keeps streaming E1 after the origin E0 is rejected", async () => {
    const sourceText = Array.from(
      { length: 12 },
      (_value, index) => `const value${index} = ${index};`,
    ).join("\n");
    const source = mutableDocument(sourceText);
    vscodeState.documents.push(source.document);
    let now = 0;
    let releaseSecond: (() => void) | undefined;
    const secondReleased = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });
    const [firstChunk, secondChunk] = splitUnifiedEditWindow(
      sourceText,
      {
        5: "const value5 = 500;",
        7: "const value7 = 700;",
      },
      6,
    );
    let requestCount = 0;
    const model = languageModel(async () => {
      requestCount += 1;
      return chatResponse(
        (async function* (): AsyncIterable<string> {
          yield firstChunk;
          await secondReleased;
          yield secondChunk;
        })(),
      );
    });
    const provider = providerFor(source.document, model, () => now);
    const first = await provider.provide(
      input(source.document, 5, "origin-reject-e0"),
      cancellationToken(),
      false,
    );
    if (!first?.edit) throw new Error("Expected E0.");
    provider.handleShown(first, true);
    now = 1_001;
    provider.handleRejected(first);
    expect(
      await provider.provide(
        input(source.document, 5, "origin-reject-exact"),
        cancellationToken(),
        false,
      ),
    ).toBeUndefined();
    releaseSecond?.();
    await vi.waitFor(() => expect(provider.getState().inFlight).toBe(0));
    expect(provider.getState().cacheSize).toBe(2);
    expect(
      await provider.provide(
        input(source.document, 5, "origin-reject-after-e1"),
        cancellationToken(),
        false,
      ),
    ).toBeUndefined();
    expect(requestCount).toBe(1);
    provider.dispose();
  });

  it("reuses an exact no-suggestion cache only inside its reduced window", async () => {
    const source = mutableDocument(
      Array.from(
        { length: 12 },
        (_value, index) => `const value${index} = ${index};`,
      ).join("\n"),
    );
    vscodeState.documents.push(source.document);
    let requestCount = 0;
    const model = languageModel(async (_messages, options) => {
      requestCount += 1;
      const value =
        options.modelOptions?.max_tokens !== undefined
          ? "not a cursor prediction"
          : "";
      return chatResponse(
        (async function* (): AsyncIterable<string> {
          if (value) yield value;
        })(),
      );
    });
    const provider = providerFor(source.document, model);
    expect(
      await provider.provide(
        input(source.document),
        cancellationToken(),
        false,
      ),
    ).toBeUndefined();
    expect(requestCount).toBe(2);
    expect(provider.getState().cacheSize).toBe(1);

    expect(
      await provider.provide(
        input(source.document, 5, "negative-exact"),
        cancellationToken(),
        false,
      ),
    ).toBeUndefined();
    expect(requestCount).toBe(2);

    expect(
      await provider.provide(
        input(source.document, 0, "negative-outside-window"),
        cancellationToken(),
        false,
      ),
    ).toBeUndefined();
    expect(requestCount).toBe(4);
    provider.dispose();
  });

  it("negative-caches a response whose ordinary edit was filtered", async () => {
    const source = mutableDocument(
      Array.from(
        { length: 12 },
        (_value, index) => `const value${index} = ${index};`,
      ).join("\n"),
    );
    vscodeState.documents.push(source.document);
    let requestCount = 0;
    const model = languageModel(async (_messages, options) => {
      requestCount += 1;
      const value =
        options.modelOptions?.max_tokens !== undefined
          ? "not a cursor prediction"
          : "<INSERT>\n<|current_file_content|>\n</INSERT>";
      return chatResponse(
        (async function* (): AsyncIterable<string> {
          yield value;
        })(),
      );
    });
    const provider = providerFor(source.document, model);
    for (const requestUuid of ["filtered-1", "filtered-2"]) {
      expect(
        await provider.provide(
          input(source.document, 5, requestUuid),
          cancellationToken(),
          false,
        ),
      ).toBeUndefined();
    }
    expect(requestCount).toBe(2);
    expect(provider.getState().cacheSize).toBe(1);
    provider.dispose();
  });

  it("does not revalidate a raw source result after the minimum delay", async () => {
    const source = Array.from(
      { length: 12 },
      (_value, index) => `const value${index} = ${index};`,
    ).join("\n");
    const mutable = mutableDocument(source);
    vscodeState.documents.push(mutable.document);
    const model = languageModel(async () =>
      chatResponse(
        (async function* (): AsyncIterable<string> {
          yield "<INSERT>\n + delayed\n</INSERT>";
        })(),
      ),
    );
    const provider = providerFor(mutable.document, model, Date.now, {
      nextEdit: { cacheDelayMs: 500 },
    });
    const result = provider.provide(
      input(mutable.document),
      cancellationToken(),
      true,
    );
    await vi.waitFor(() =>
      expect(provider.getState().cacheSize).toBeGreaterThan(0),
    );
    mutable.setText(`${source}\n// changed during delay`);
    fireDocumentChange(mutable.document);
    expect(await result).toMatchObject({
      fromCache: false,
      edit: { newText: "+ delayed " },
    });
    provider.dispose();
  });

  it("finishes minimum response delay before observing cancellation", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const source = mutableDocument(
      Array.from(
        { length: 12 },
        (_value, index) => `const value${index} = ${index};`,
      ).join("\n"),
    );
    vscodeState.documents.push(source.document);
    const provider = providerFor(
      source.document,
      languageModel(async () =>
        chatResponse(
          (async function* (): AsyncIterable<string> {
            yield "<INSERT>\n + delayed\n</INSERT>";
          })(),
        ),
      ),
      Date.now,
      {
        nextEdit: {
          requestDebounceMs: 0,
          cacheDelayMs: 500,
          rebasedCacheDelayMs: 500,
          subsequentCacheDelayMs: 500,
          speculativeCacheDelayMs: 500,
        },
      },
    );
    const request = input(source.document, 5, "minimum-cancel");
    expect(
      await provider.provide(request, cancellationToken(), false),
    ).toBeDefined();
    await vi.waitFor(() => expect(provider.getState().inFlight).toBe(0));
    vi.setSystemTime(2_000);
    const delayedRequest = input(source.document, 5, "minimum-cancel-delayed");
    const consumer = new vscodeApi.CancellationTokenSource();
    let settled = false;
    const delayed = provider
      .provide(delayedRequest, consumer.token, true)
      .then((value) => {
        settled = true;
        return value;
      });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    consumer.cancel();
    await vi.advanceTimersByTimeAsync(499);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await delayed).toBeUndefined();
    consumer.dispose();
    provider.dispose();
  });

  it("uses the base delay for an async joined rebase", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const originalText = Array.from(
      { length: 12 },
      (_value, index) => `const value${index} = ${index};`,
    ).join("\n");
    const source = mutableDocument(originalText);
    vscodeState.documents.push(source.document);
    let release: (() => void) | undefined;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let requestCount = 0;
    const model = languageModel(async () => {
      requestCount += 1;
      const requestText = source.document.getText();
      return chatResponse(
        (async function* (): AsyncIterable<string> {
          yield "<EDIT>\n";
          await released;
          const lines = requestText.split("\n").slice(3, 11);
          lines[2] = "const value5 = 500;";
          yield `${lines.join("\n")}\n</EDIT>`;
        })(),
      );
    });
    const provider = providerFor(source.document, model, Date.now, {
      nextEdit: {
        asyncCompletions: true,
        earlyDivergenceCancellation: "cursor",
        cacheDelayMs: 100,
        rebasedCacheDelayMs: 500,
      },
    });
    const first = provider.provide(
      input(source.document, 5, "joined-delay-origin"),
      cancellationToken(),
      false,
    );
    await vi.waitFor(() => expect(requestCount).toBe(1));
    const insertionOffset =
      originalText.indexOf("5;", originalText.indexOf("value5")) + 1;
    source.setText(
      `${originalText.slice(0, insertionOffset)}0${originalText.slice(
        insertionOffset,
      )}`,
    );
    fireDocumentChange(source.document, [
      {
        range: new vscodeApi.Range(
          new vscodeApi.Position(5, 16),
          new vscodeApi.Position(5, 16),
        ),
        rangeOffset: insertionOffset,
        rangeLength: 0,
        text: "0",
      },
    ]);
    let settled = false;
    const joined = provider
      .provide(
        input(source.document, 5, "joined-delay-consumer"),
        cancellationToken(),
        true,
      )
      .then((value) => {
        settled = true;
        return value;
      });
    release?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(99);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await joined).toMatchObject({
      fromCache: false,
      rebased: true,
      edit: { newText: "00" },
    });
    expect(await first).toBeUndefined();
    expect(requestCount).toBe(1);
    provider.dispose();
  });

  it("uses the rebased cache delay without a post-delay source guard", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const originalText = Array.from(
      { length: 12 },
      (_value, index) => `const value${index} = ${index};`,
    ).join("\n");
    const source = mutableDocument(originalText);
    vscodeState.documents.push(source.document);
    let release: (() => void) | undefined;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let requestCount = 0;
    const model = languageModel(async () => {
      requestCount += 1;
      const requestText = source.document.getText();
      return chatResponse(
        (async function* (): AsyncIterable<string> {
          yield "<EDIT>\n";
          await released;
          const lines = requestText.split("\n").slice(3, 11);
          lines[2] = "const value5 = 500;";
          yield `${lines.join("\n")}\n</EDIT>`;
        })(),
      );
    });
    const provider = providerFor(source.document, model, Date.now, {
      nextEdit: {
        cacheDelayMs: 100,
        rebasedCacheDelayMs: 500,
      },
    });
    const origin = provider.provide(
      input(source.document, 5, "rebased-delay-origin"),
      cancellationToken(),
      false,
    );
    await vi.waitFor(() => expect(requestCount).toBe(1));
    const insertionOffset =
      originalText.indexOf("5;", originalText.indexOf("value5")) + 1;
    const rebasedText = `${originalText.slice(
      0,
      insertionOffset,
    )}0${originalText.slice(insertionOffset)}`;
    source.setText(rebasedText);
    fireDocumentChange(source.document, [
      {
        range: new vscodeApi.Range(
          new vscodeApi.Position(5, 16),
          new vscodeApi.Position(5, 16),
        ),
        rangeOffset: insertionOffset,
        rangeLength: 0,
        text: "0",
      },
    ]);
    release?.();
    expect(await origin).toBeUndefined();
    await vi.waitFor(() => expect(provider.getState().inFlight).toBe(0));
    vi.setSystemTime(2_000);
    const timeoutSpy = vi.spyOn(globalThis, "setTimeout");
    let settled = false;
    const delayed = provider
      .provide(
        input(source.document, 5, "rebased-delay-cache"),
        cancellationToken(),
        true,
      )
      .then((value) => {
        settled = true;
        return value;
      });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    expect(timeoutSpy.mock.calls.map((call) => call[1])).toContain(500);
    source.setText(`${rebasedText}\n// changed during cache delay`);
    await vi.advanceTimersByTimeAsync(499);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(true);
    expect(await delayed).toMatchObject({
      fromCache: true,
      rebased: true,
      edit: { newText: "00" },
    });
    expect(requestCount).toBe(1);
    provider.dispose();
  });

  it("does not cancel a source request for an unrelated document mutation", async () => {
    const source = Array.from(
      { length: 12 },
      (_value, index) => `const value${index} = ${index};`,
    ).join("\n");
    const mutable = mutableDocument(source);
    const unrelated = mutableDocument(
      "export const unrelated = true;",
      "file:///workspace/unrelated.ts",
    );
    vscodeState.documents.push(mutable.document, unrelated.document);
    let release: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const model = languageModel(async () =>
      chatResponse(
        (async function* (): AsyncIterable<string> {
          yield "<INSERT>\n";
          await blocked;
          yield " + safe\n</INSERT>";
        })(),
      ),
    );
    const provider = providerFor(mutable.document, model);
    const result = provider.provide(
      input(mutable.document),
      cancellationToken(),
      false,
    );
    await Promise.resolve();
    unrelated.setText("export const unrelated = false;");
    fireDocumentChange(unrelated.document);
    release?.();
    expect((await result)?.edit?.newText).toContain("safe");
    provider.dispose();
  });

  it.each([
    { usesResponsesApi: false, expectedMaxTokens: 40 },
    { usesResponsesApi: true, expectedMaxTokens: 2_048 },
  ])(
    "uses a dedicated persistent cursor model with the $expectedMaxTokens token budget",
    async ({ usesResponsesApi, expectedMaxTokens }) => {
      const source = mutableDocument(
        Array.from(
          { length: 12 },
          (_value, index) => `const value${index} = ${index};`,
        ).join("\n"),
      );
      vscodeState.documents.push(source.document);
      let mainRequests = 0;
      let cursorRequests = 0;
      let cursorMaxTokens: unknown;
      const mainModel = languageModel(async () => {
        mainRequests += 1;
        return chatResponse((async function* (): AsyncIterable<string> {})());
      });
      const cursorModel = languageModel(
        async (_messages, options) => {
          cursorRequests += 1;
          cursorMaxTokens = options.modelOptions?.max_tokens;
          return chatResponse(
            (async function* (): AsyncIterable<string> {
              yield "5";
            })(),
          );
        },
        {
          name: "Cursor Predictor",
          id: "copilot-suggestions-himalia-001",
          usesResponsesApi,
        },
      );
      const provider = providerFor(source.document, mainModel, Date.now, {
        cursorModel,
      });

      expect(
        await provider.provide(
          input(source.document),
          cancellationToken(),
          false,
        ),
      ).toBeUndefined();
      expect(mainRequests).toBe(1);
      expect(cursorRequests).toBe(1);
      expect(cursorMaxTokens).toBe(expectedMaxTokens);
      expect(vscodeState.selectors).toEqual([
        { vendor: "test", id: "nes" },
        { vendor: "test", id: "copilot-suggestions-himalia-001" },
      ]);
      provider.dispose();
    },
  );

  it.each([
    { editIntent: "no_edit", eagerness: "high" },
    { editIntent: "low", eagerness: "medium" },
  ] as const)(
    "treats filtered $editIntent edit intent as terminal without cursor retry",
    async ({ editIntent, eagerness }) => {
      const source = mutableDocument(
        Array.from(
          { length: 12 },
          (_value, index) => `const value${index} = ${index};`,
        ).join("\n"),
      );
      vscodeState.documents.push(source.document);
      let mainRequests = 0;
      let cursorRequests = 0;
      const mainModel = languageModel(
        async () => {
          mainRequests += 1;
          return chatResponse(
            (async function* (): AsyncIterable<string> {
              yield `<|edit_intent|>${editIntent}<|/edit_intent|>\n`;
            })(),
          );
        },
        { supportsNextCursorLinePrediction: true },
      );
      const cursorModel = languageModel(
        async () => {
          cursorRequests += 1;
          return chatResponse(
            (async function* (): AsyncIterable<string> {
              yield "5";
            })(),
          );
        },
        { id: "cursor" },
      );
      const provider = providerFor(source.document, mainModel, Date.now, {
        strategy: "xtab275EditIntent",
        eagerness,
        cursorModel,
      });

      expect(
        await provider.provide(
          input(source.document, 5, `intent-${editIntent}`),
          cancellationToken(),
          false,
        ),
      ).toBeUndefined();
      expect(mainRequests).toBe(1);
      expect(cursorRequests).toBe(0);
      expect(provider.getState().cacheSize).toBe(0);
      expect(provider.getState().cursorPrediction).toBeUndefined();
      provider.dispose();
    },
  );

  it("retries when edit intent passes but an ordinary filter removes the candidate", async () => {
    const source = mutableDocument(
      Array.from(
        { length: 12 },
        (_value, index) => `const value${index} = ${index};`,
      ).join("\n"),
    );
    vscodeState.documents.push(source.document);
    const filteredWindow = Array.from({ length: 8 }, (_value, index) =>
      index === 2
        ? "<|current_file_content|>"
        : `const value${index + 3} = ${index + 3};`,
    ).join("\n");
    let mainRequests = 0;
    let cursorRequests = 0;
    const mainModel = languageModel(
      async () => {
        mainRequests += 1;
        return chatResponse(
          (async function* (): AsyncIterable<string> {
            yield mainRequests === 1
              ? `<|edit_intent|>high<|/edit_intent|>\n${filteredWindow}`
              : `<|edit_intent|>high<|/edit_intent|>\n${source.document
                  .getText()
                  .split("\n")
                  .slice(0, 6)
                  .join("\n")}`;
          })(),
        );
      },
      { supportsNextCursorLinePrediction: true },
    );
    const cursorModel = languageModel(
      async () => {
        cursorRequests += 1;
        return chatResponse(
          (async function* (): AsyncIterable<string> {
            yield "0";
          })(),
        );
      },
      { id: "cursor" },
    );
    const provider = providerFor(source.document, mainModel, Date.now, {
      strategy: "xtab275EditIntent",
      eagerness: "medium",
      cursorModel,
    });

    expect(
      await provider.provide(
        input(source.document, 5, "intent-passes-filtered"),
        cancellationToken(),
        false,
      ),
    ).toBeUndefined();
    expect(mainRequests).toBe(2);
    expect(cursorRequests).toBe(1);
    expect(provider.getState().cacheSize).toBe(1);
    provider.dispose();
  });

  it("treats unified NO_EDIT as malformed without retry or negative cache", async () => {
    const source = mutableDocument(
      Array.from(
        { length: 12 },
        (_value, index) => `const value${index} = ${index};`,
      ).join("\n"),
    );
    vscodeState.documents.push(source.document);
    let mainRequests = 0;
    let cursorRequests = 0;
    const mainModel = languageModel(
      async () => {
        mainRequests += 1;
        return chatResponse(
          (async function* (): AsyncIterable<string> {
            yield "<NO_EDIT>";
          })(),
        );
      },
      { supportsNextCursorLinePrediction: true },
    );
    const cursorModel = languageModel(
      async () => {
        cursorRequests += 1;
        return chatResponse(
          (async function* (): AsyncIterable<string> {
            yield "5";
          })(),
        );
      },
      { id: "cursor" },
    );
    const provider = providerFor(source.document, mainModel, Date.now, {
      cursorModel,
    });

    for (const requestId of ["malformed-no-edit-1", "malformed-no-edit-2"]) {
      expect(
        await provider.provide(
          input(source.document, 5, requestId),
          cancellationToken(),
          false,
        ),
      ).toBeUndefined();
      await vi.waitFor(() => expect(provider.getState().inFlight).toBe(0));
    }
    expect(mainRequests).toBe(2);
    expect(cursorRequests).toBe(0);
    expect(provider.getState().cacheSize).toBe(0);
    provider.dispose();
  });

  it("isolates ordinary cursor errors and reuses the resolved model", async () => {
    const source = mutableDocument(
      Array.from(
        { length: 12 },
        (_value, index) => `const value${index} = ${index};`,
      ).join("\n"),
    );
    vscodeState.documents.push(source.document);
    const mainModel = languageModel(async () =>
      chatResponse((async function* (): AsyncIterable<string> {})()),
    );
    let cursorRequests = 0;
    const runtimeErrors: Array<{
      source: string;
      message: string;
      error: unknown;
    }> = [];
    const cursorModel = languageModel(
      async () => {
        cursorRequests += 1;
        throw new Error("temporary cursor failure");
      },
      { id: "cursor" },
    );
    const provider = providerFor(source.document, mainModel, Date.now, {
      cursorModel,
      onRuntimeError: (sourceName, message, error) => {
        runtimeErrors.push({ source: sourceName, message, error });
      },
    });

    expect(
      await provider.provide(
        input(source.document),
        cancellationToken(),
        false,
      ),
    ).toBeUndefined();
    source.setText(`${source.document.getText()}\n// next request`);
    fireDocumentChange(source.document);
    expect(
      await provider.provide(
        input(source.document, 5, "request-2"),
        cancellationToken(),
        false,
      ),
    ).toBeUndefined();
    expect(cursorRequests).toBe(2);
    expect(
      vscodeState.selectors.filter((selector) => selector.id === "cursor"),
    ).toHaveLength(1);
    expect(provider.getState().cursorPrediction).toMatchObject({
      outcome: "request-failed",
    });
    expect(runtimeErrors).toHaveLength(2);
    expect(runtimeErrors[0]).toMatchObject({
      source: "cursor-prediction",
      message: "Cursor prediction request failed",
      error: expect.objectContaining({ message: "temporary cursor failure" }),
    });
    provider.dispose();
  });

  it("keeps a late cursor-model resolution local to its pre-catalog generation", async () => {
    const source = mutableDocument(
      Array.from(
        { length: 12 },
        (_value, index) => `const value${index} = ${index};`,
      ).join("\n"),
    );
    const secondSource = mutableDocument(
      Array.from(
        { length: 12 },
        (_value, index) => `const nextValue${index} = ${index};`,
      ).join("\n"),
      "file:///workspace/second.ts",
    );
    vscodeState.documents.push(source.document, secondSource.document);
    let mainRequests = 0;
    let retryReady = false;
    const mainModel = languageModel(async () => {
      mainRequests += 1;
      const emitRetry = retryReady;
      retryReady = false;
      return chatResponse(
        emitRetry
          ? (async function* (): AsyncIterable<string> {
              yield `<INSERT>\n + catalog retry ${mainRequests}\n</INSERT>`;
            })()
          : (async function* (): AsyncIterable<string> {})(),
      );
    });
    let oldCursorRequests = 0;
    const oldCursorModel = languageModel(
      async () => {
        oldCursorRequests += 1;
        retryReady = true;
        return chatResponse(
          (async function* (): AsyncIterable<string> {
            yield "0";
          })(),
        );
      },
      { id: "cursor" },
    );
    let newCursorRequests = 0;
    const newCursorModel = languageModel(
      async () => {
        newCursorRequests += 1;
        retryReady = true;
        return chatResponse(
          (async function* (): AsyncIterable<string> {
            yield "0";
          })(),
        );
      },
      { id: "cursor" },
    );
    let resolveFirstCursor:
      ((models: readonly vscode.LanguageModelChat[]) => void) | undefined;
    const firstCursorResolution = new Promise<
      readonly vscode.LanguageModelChat[]
    >((resolve) => {
      resolveFirstCursor = resolve;
    });
    let cursorSelections = 0;
    vscodeState.selectHandler = async (selector) => {
      if (selector.id === "nes") {
        return [mainModel];
      }
      if (selector.id !== "cursor") {
        return [];
      }
      cursorSelections += 1;
      return cursorSelections === 1
        ? await firstCursorResolution
        : [newCursorModel];
    };
    const provider = providerFor(source.document, mainModel, Date.now, {
      cursorModel: oldCursorModel,
      related: [secondSource.document],
    });
    const firstRequest = provider.provide(
      input(source.document, 5, "cursor-catalog-old-generation"),
      cancellationToken(),
      false,
    );
    await vi.waitFor(() => expect(cursorSelections).toBe(1));

    provider.handleDidChangeChatModels();
    resolveFirstCursor?.([oldCursorModel]);

    expect(await firstRequest).toMatchObject({
      edit: { uri: source.document.uri.toString() },
    });
    expect(oldCursorRequests).toBe(1);
    expect(newCursorRequests).toBe(0);
    await vi.waitFor(() => expect(provider.getState().inFlight).toBe(0));

    expect(
      await provider.provide(
        input(secondSource.document, 5, "cursor-catalog-new-generation"),
        cancellationToken(),
        false,
      ),
    ).toMatchObject({ edit: { uri: secondSource.document.uri.toString() } });
    expect(cursorSelections).toBe(2);
    expect(oldCursorRequests).toBe(1);
    expect(newCursorRequests).toBe(1);
    provider.dispose();
  });

  it("ignores a late cursor NotFound from a pre-catalog generation", async () => {
    const source = mutableDocument(
      Array.from(
        { length: 12 },
        (_value, index) => `const value${index} = ${index};`,
      ).join("\n"),
    );
    const secondSource = mutableDocument(
      Array.from(
        { length: 12 },
        (_value, index) => `const nextValue${index} = ${index};`,
      ).join("\n"),
      "file:///workspace/second.ts",
    );
    vscodeState.documents.push(source.document, secondSource.document);
    let retryReady = false;
    const mainModel = languageModel(async () => {
      const emitRetry = retryReady;
      retryReady = false;
      return chatResponse(
        emitRetry
          ? (async function* (): AsyncIterable<string> {
              yield "<INSERT>\n + new catalog retry\n</INSERT>";
            })()
          : (async function* (): AsyncIterable<string> {})(),
      );
    });
    let releaseOldCursor: (() => void) | undefined;
    const oldCursorReleased = new Promise<void>((resolve) => {
      releaseOldCursor = resolve;
    });
    let oldCursorRequests = 0;
    const oldCursorModel = languageModel(
      async () => {
        oldCursorRequests += 1;
        await oldCursorReleased;
        const error = new Error("old cursor model missing");
        Object.defineProperty(error, "code", { value: "NotFound" });
        throw error;
      },
      { id: "cursor" },
    );
    let newCursorRequests = 0;
    const newCursorModel = languageModel(
      async () => {
        newCursorRequests += 1;
        retryReady = true;
        return chatResponse(
          (async function* (): AsyncIterable<string> {
            yield "0";
          })(),
        );
      },
      { id: "cursor" },
    );
    let cursorSelections = 0;
    vscodeState.selectHandler = async (selector) => {
      if (selector.id === "nes") {
        return [mainModel];
      }
      if (selector.id !== "cursor") {
        return [];
      }
      cursorSelections += 1;
      return cursorSelections === 1 ? [oldCursorModel] : [newCursorModel];
    };
    const provider = providerFor(source.document, mainModel, Date.now, {
      cursorModel: oldCursorModel,
      related: [secondSource.document],
    });
    const firstRequest = provider.provide(
      input(source.document, 5, "cursor-catalog-late-not-found"),
      cancellationToken(),
      false,
    );
    await vi.waitFor(() => expect(oldCursorRequests).toBe(1));

    provider.handleDidChangeChatModels();
    releaseOldCursor?.();
    expect(await firstRequest).toBeUndefined();
    await vi.waitFor(() => expect(provider.getState().inFlight).toBe(0));

    expect(
      await provider.provide(
        input(secondSource.document, 5, "cursor-catalog-after-not-found"),
        cancellationToken(),
        false,
      ),
    ).toMatchObject({ edit: { uri: secondSource.document.uri.toString() } });
    expect(cursorSelections).toBe(2);
    expect(oldCursorRequests).toBe(1);
    expect(newCursorRequests).toBe(1);
    expect(provider.getState().cursorPrediction).toMatchObject({
      outcome: "retry-edit",
    });
    provider.dispose();
  });

  it("disables cursor prediction for the session after NotFound", async () => {
    const source = mutableDocument(
      Array.from(
        { length: 12 },
        (_value, index) => `const value${index} = ${index};`,
      ).join("\n"),
    );
    vscodeState.documents.push(source.document);
    const mainModel = languageModel(async () =>
      chatResponse((async function* (): AsyncIterable<string> {})()),
    );
    let cursorRequests = 0;
    const cursorModel = languageModel(
      async () => {
        cursorRequests += 1;
        const error = new Error("cursor model missing");
        Object.defineProperty(error, "code", { value: "NotFound" });
        throw error;
      },
      { id: "cursor" },
    );
    const provider = providerFor(source.document, mainModel, Date.now, {
      cursorModel,
    });

    expect(
      await provider.provide(
        input(source.document),
        cancellationToken(),
        false,
      ),
    ).toBeUndefined();
    source.setText(`${source.document.getText()}\n// next request`);
    fireDocumentChange(source.document);
    expect(
      await provider.provide(
        input(source.document, 5, "request-2"),
        cancellationToken(),
        false,
      ),
    ).toBeUndefined();
    expect(cursorRequests).toBe(1);
    expect(provider.getState().cursorPrediction).toEqual({
      outcome: "disabled",
      reason: "session-disabled",
    });
    provider.dispose();
  });

  it("uses an explicit cursor model when the main model opts out", async () => {
    const source = mutableDocument(
      Array.from(
        { length: 12 },
        (_value, index) => `const value${index} = ${index};`,
      ).join("\n"),
    );
    vscodeState.documents.push(source.document);
    const mainModel = languageModel(
      async () =>
        chatResponse((async function* (): AsyncIterable<string> {})()),
      { supportsNextCursorLinePrediction: false },
    );
    let cursorRequests = 0;
    const cursorModel = languageModel(
      async () => {
        cursorRequests += 1;
        return chatResponse((async function* (): AsyncIterable<string> {})());
      },
      { id: "cursor" },
    );
    const provider = providerFor(source.document, mainModel, Date.now, {
      cursorModel,
    });

    expect(
      await provider.provide(
        input(source.document),
        cancellationToken(),
        false,
      ),
    ).toBeUndefined();
    expect(cursorRequests).toBe(1);
    expect(vscodeState.selectors).toEqual([
      { vendor: "test", id: "nes" },
      { vendor: "test", id: "cursor" },
    ]);
    provider.dispose();
  });

  it("negative-caches original bytes after inconsistent edit and undo", async () => {
    const sourceText = Array.from(
      { length: 12 },
      (_value, index) => `const value${index} = ${index};`,
    ).join("\n");
    const source = mutableDocument(sourceText);
    vscodeState.documents.push(source.document);
    let releaseResponse: (() => void) | undefined;
    const responseReleased = new Promise<void>((resolve) => {
      releaseResponse = resolve;
    });
    let requestCount = 0;
    const model = languageModel(
      async () => {
        requestCount += 1;
        return chatResponse(
          (async function* (): AsyncIterable<string> {
            await responseReleased;
          })(),
        );
      },
      { supportsNextCursorLinePrediction: false },
    );
    const provider = providerFor(source.document, model, Date.now, {
      nextEdit: { asyncCompletions: true },
    });
    const first = provider.provide(
      input(source.document, 5, "disabled-cursor-inconsistent"),
      cancellationToken(),
      false,
    );
    await vi.waitFor(() => expect(requestCount).toBe(1));
    source.setText(`${sourceText}\n// actual bytes`);
    const insertionPosition = source.document.positionAt(sourceText.length);
    fireDocumentChange(source.document, [
      {
        range: new vscodeApi.Range(insertionPosition, insertionPosition),
        rangeOffset: sourceText.length,
        rangeLength: 0,
        text: "\n// different event bytes",
      },
    ]);
    source.setText(sourceText);
    releaseResponse?.();

    expect(await first).toBeUndefined();
    expect(provider.getState().cursorPrediction).toEqual({
      outcome: "disabled",
      reason: "cursor-model-capability",
    });
    expect(provider.getState().cacheSize).toBe(1);
    expect(
      await provider.provide(
        input(source.document, 5, "disabled-cursor-negative-hit"),
        cancellationToken(),
        false,
      ),
    ).toBeUndefined();
    expect(requestCount).toBe(1);
    provider.dispose();
  });

  it("does not request cursor prediction after the source changes", async () => {
    const source = mutableDocument(
      Array.from(
        { length: 12 },
        (_value, index) => `const value${index} = ${index};`,
      ).join("\n"),
    );
    vscodeState.documents.push(source.document);
    let releaseMain: (() => void) | undefined;
    const mainReleased = new Promise<void>((resolve) => {
      releaseMain = resolve;
    });
    let mainRequests = 0;
    const mainModel = languageModel(async () => {
      mainRequests += 1;
      return chatResponse(
        (async function* (): AsyncIterable<string> {
          if (mainRequests === 1) {
            yield "<INSERT>\n + prime\n</INSERT>";
            return;
          }
          await mainReleased;
        })(),
      );
    });
    let cursorRequests = 0;
    const cursorModel = languageModel(
      async () => {
        cursorRequests += 1;
        return chatResponse(
          (async function* (): AsyncIterable<string> {
            yield "5";
          })(),
        );
      },
      { id: "cursor" },
    );
    const provider = providerFor(source.document, mainModel, Date.now, {
      cursorModel,
      nextEdit: { asyncCompletions: true },
    });
    const prime = await provider.provide(
      input(source.document, 5, "source-change-prime"),
      cancellationToken(),
      false,
    );
    if (!prime) throw new Error("Expected the expansion prime suggestion.");
    await vi.waitFor(() => expect(provider.getState().inFlight).toBe(0));
    provider.handleAccepted(prime);
    provider.removeDocument(source.document.uri.toString());
    expect(provider.getState().expandNextFreshRequest).toBe(true);
    const cacheSizeBeforeRequest = provider.getState().cacheSize;
    const result = provider.provide(
      input(source.document, 0, "source-change-no-edit"),
      cancellationToken(),
      false,
    );
    await vi.waitFor(() => expect(mainRequests).toBe(2));
    const sourceBeforeChange = source.document.getText();
    source.setText(`${sourceBeforeChange}\n// changed while streaming`);
    const insertionPosition = source.document.positionAt(
      sourceBeforeChange.length,
    );
    fireDocumentChange(source.document, [
      {
        range: new vscodeApi.Range(insertionPosition, insertionPosition),
        rangeOffset: sourceBeforeChange.length,
        rangeLength: 0,
        text: "\n// changed while streaming",
      },
    ]);
    releaseMain?.();

    expect(await result).toBeUndefined();
    expect(cursorRequests).toBe(0);
    expect(provider.getState().cursorPrediction).toEqual({
      outcome: "document-changed",
      reason: "before-cursor-request",
    });
    expect(provider.getState().cacheSize).toBe(cacheSizeBeforeRequest);
    expect(provider.getState().expandNextFreshRequest).toBe(true);
    provider.dispose();
  });

  it("retries a same-file cursor prediction from the request snapshot after close", async () => {
    const source = mutableDocument(
      Array.from(
        { length: 12 },
        (_value, index) => `const value${index} = ${index};`,
      ).join("\n"),
    );
    vscodeState.documents.push(source.document);
    let releaseCursor: (() => void) | undefined;
    const cursorReleased = new Promise<void>((resolve) => {
      releaseCursor = resolve;
    });
    let requestCount = 0;
    const model = languageModel(async (_messages, options) => {
      requestCount += 1;
      if (options.modelOptions?.max_tokens !== undefined) {
        return chatResponse(
          (async function* (): AsyncIterable<string> {
            await cursorReleased;
            yield "0";
          })(),
        );
      }
      return chatResponse(
        requestCount === 1
          ? (async function* (): AsyncIterable<string> {})()
          : (async function* (): AsyncIterable<string> {
              yield "<INSERT>\n + retry after close\n</INSERT>";
            })(),
      );
    });
    const provider = providerFor(source.document, model);
    const result = provider.provide(
      input(source.document, 5, "same-file-close-retry"),
      cancellationToken(),
      false,
    );
    await vi.waitFor(() => expect(requestCount).toBe(2));
    vscodeState.documents = [];
    releaseCursor?.();

    expect(await result).toBeUndefined();
    expect(requestCount).toBe(3);
    expect(provider.getState().cursorPrediction).toMatchObject({
      outcome: "retry-empty",
      targetUri: source.document.uri.toString(),
      lineNumber: 0,
    });
    provider.dispose();
  });

  it("does not add a post-resolution typing gate to same-file cursor retry", async () => {
    const sourceText = Array.from(
      { length: 12 },
      (_value, index) => `const value${index} = ${index};`,
    ).join("\n");
    const source = mutableDocument(sourceText);
    vscodeState.documents.push(source.document);
    let requestCount = 0;
    const model = languageModel(async (_messages, options) => {
      requestCount += 1;
      if (options.modelOptions?.max_tokens !== undefined) {
        return chatResponse(
          (async function* (): AsyncIterable<string> {
            yield "0";
            vscodeState.documentsReadHook = () => {
              source.setText(`${sourceText}\n// typed in resolution gap`);
              const insertionPosition = source.document.positionAt(
                sourceText.length,
              );
              fireDocumentChange(source.document, [
                {
                  range: new vscodeApi.Range(
                    insertionPosition,
                    insertionPosition,
                  ),
                  rangeOffset: sourceText.length,
                  rangeLength: 0,
                  text: "\n// typed in resolution gap",
                },
              ]);
            };
          })(),
        );
      }
      return chatResponse(
        requestCount === 1
          ? (async function* (): AsyncIterable<string> {})()
          : (async function* (): AsyncIterable<string> {
              yield "<INSERT>\n + same-file retry\n</INSERT>";
            })(),
      );
    });
    const provider = providerFor(source.document, model, Date.now, {
      nextEdit: { earlyDivergenceCancellation: "off" },
    });

    expect(
      await provider.provide(
        input(source.document, 5, "same-file-resolution-gap"),
        cancellationToken(),
        false,
      ),
    ).toBeUndefined();
    expect(vscodeState.documentsReadHook).toBeUndefined();
    expect(requestCount).toBe(3);
    provider.dispose();
  });

  it("keeps frozen history when the source changes during cross-file target context", async () => {
    const sourceText = Array.from(
      { length: 12 },
      (_value, index) => `const source${index} = ${index};`,
    ).join("\n");
    const source = mutableDocument(sourceText);
    const target = mutableDocument(
      "export const crossTarget = 1;\n",
      "file:///workspace/other.ts",
    );
    vscodeState.documents.push(source.document, target.document);
    let historyMarker = "FROZEN_HISTORY_MARKER";
    let gatherCount = 0;
    let notifyTargetGather: (() => void) | undefined;
    const targetGatherStarted = new Promise<void>((resolve) => {
      notifyTargetGather = resolve;
    });
    const requests: Array<readonly TestModelMessage[]> = [];
    let requestCount = 0;
    const model = languageModel(async (messages, options) => {
      requests.push(messages);
      requestCount += 1;
      const value =
        options.modelOptions?.max_tokens !== undefined
          ? "other.ts:0"
          : requestCount === 3
            ? "<INSERT>\n + cross retry\n</INSERT>"
            : "";
      return chatResponse(
        (async function* (): AsyncIterable<string> {
          if (value) yield value;
        })(),
      );
    });
    const provider = providerFor(source.document, model, Date.now, {
      related: [target.document],
      gatherContextDelayMs: 25,
      onGatherContextRequest: () => {
        gatherCount += 1;
        if (gatherCount === 2) notifyTargetGather?.();
      },
      workspaceEditHistory: () => [
        {
          uri: source.document.uri.toString(),
          path: source.document.uri.fsPath,
          relativePath: "main.ts",
          languageId: "typescript",
          before: "old history",
          after: historyMarker,
          timestamp: 1,
          reason: "other",
          changes: [],
        },
      ],
      nextEdit: { earlyDivergenceCancellation: "off" },
    });
    const result = provider.provide(
      input(source.document, 5, "cross-context-source-change"),
      cancellationToken(),
      false,
    );
    await targetGatherStarted;
    historyMarker = "LATE_HISTORY_MARKER";
    source.setText(`${sourceText}\n// changed during target gather`);
    const insertionPosition = source.document.positionAt(sourceText.length);
    fireDocumentChange(source.document, [
      {
        range: new vscodeApi.Range(insertionPosition, insertionPosition),
        rangeOffset: sourceText.length,
        rangeLength: 0,
        text: "\n// changed during target gather",
      },
    ]);

    expect(await result).toMatchObject({
      edit: { uri: target.document.uri.toString() },
      cursorJump: { kind: "differentFile" },
    });
    expect(requests).toHaveLength(3);
    const retryPrompt = requests[2]?.map(messageText).join("\n") ?? "";
    expect(retryPrompt).toContain("FROZEN_HISTORY_MARKER");
    expect(retryPrompt).not.toContain("LATE_HISTORY_MARKER");
    expect(retryPrompt).not.toContain("const source0 = 0;");
    expect(retryPrompt).toContain("export const crossTarget = 1;");
    provider.dispose();
  });

  it("does not overwrite an empty cross-file retry with an outer negative", async () => {
    const source = mutableDocument(
      Array.from(
        { length: 12 },
        (_value, index) => `const source${index} = ${index};`,
      ).join("\n"),
    );
    const target = mutableDocument(
      "export const target = 1;\n",
      "file:///workspace/other.ts",
    );
    vscodeState.documents.push(source.document, target.document);
    let mainRequests = 0;
    let cursorRequests = 0;
    const model = languageModel(async (_messages, options) => {
      if (options.modelOptions?.max_tokens !== undefined) {
        cursorRequests += 1;
        return chatResponse(
          (async function* (): AsyncIterable<string> {
            yield "other.ts:0";
          })(),
        );
      }
      mainRequests += 1;
      return chatResponse(
        (async function* (): AsyncIterable<string> {
          if (mainRequests === 3) {
            yield "<INSERT>\n + fresh after retry\n</INSERT>";
          }
        })(),
      );
    });
    const provider = providerFor(source.document, model, Date.now, {
      related: [target.document],
    });

    expect(
      await provider.provide(
        input(source.document, 5, "empty-cross-retry"),
        cancellationToken(),
        false,
      ),
    ).toBeUndefined();
    expect(mainRequests).toBe(2);
    expect(cursorRequests).toBe(1);
    expect(provider.getState().cacheSize).toBe(1);

    expect(
      await provider.provide(
        input(source.document, 5, "after-empty-cross-retry"),
        cancellationToken(),
        false,
      ),
    ).toBeDefined();
    expect(mainRequests).toBe(3);
    expect(cursorRequests).toBe(1);
    provider.dispose();
  });

  it("negative-caches a relative cross-file prediction without a workspace root", async () => {
    const source = mutableDocument(
      Array.from(
        { length: 12 },
        (_value, index) => `const source${index} = ${index};`,
      ).join("\n"),
    );
    vscodeState.documents.push(source.document);
    let requestCount = 0;
    const model = languageModel(async (_messages, options) => {
      requestCount += 1;
      const value =
        options.modelOptions?.max_tokens !== undefined ? "missing.ts:0" : "";
      return chatResponse(
        (async function* (): AsyncIterable<string> {
          if (value) yield value;
        })(),
      );
    });
    const provider = providerFor(source.document, model, Date.now, {
      withoutWorkspaceRoot: true,
    });

    expect(
      await provider.provide(
        input(source.document, 5, "cross-without-root"),
        cancellationToken(),
        false,
      ),
    ).toBeUndefined();
    expect(provider.getState().cursorPrediction).toEqual({
      outcome: "target-unavailable",
      reason: "crossFile:noWorkspaceRoot",
      lineNumber: 0,
    });
    expect(provider.getState().cacheSize).toBe(1);
    expect(vscodeState.openCalls).toEqual([]);

    expect(
      await provider.provide(
        input(source.document, 5, "cross-without-root-negative"),
        cancellationToken(),
        false,
      ),
    ).toBeUndefined();
    expect(requestCount).toBe(2);
    provider.dispose();
  });

  it("keeps a cursor retry when its cross-file target mutates while streaming", async () => {
    const source = mutableDocument(
      Array.from(
        { length: 12 },
        (_value, index) => `const value${index} = ${index};`,
      ).join("\n"),
    );
    const target = mutableDocument(
      "export const target = 1;\n",
      "file:///workspace/other.ts",
    );
    vscodeState.documents.push(source.document, target.document);
    let retryStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      retryStarted = resolve;
    });
    let releaseRetry: (() => void) | undefined;
    const released = new Promise<void>((resolve) => {
      releaseRetry = resolve;
    });
    let retryToken: vscode.CancellationToken | undefined;
    let modelRequestCount = 0;
    const model = languageModel(async (_messages, options, requestToken) => {
      modelRequestCount += 1;
      if (options.modelOptions?.max_tokens !== undefined) {
        return chatResponse(
          (async function* (): AsyncIterable<string> {
            yield "other.ts:0";
          })(),
        );
      }
      if (modelRequestCount > 2) {
        retryToken = requestToken;
        retryStarted?.();
        return chatResponse(
          (async function* (): AsyncIterable<string> {
            yield "<INSERT>\n";
            await released;
            yield "changed\n</INSERT>";
          })(),
        );
      }
      return chatResponse((async function* (): AsyncIterable<string> {})());
    });
    const provider = providerFor(source.document, model, Date.now, {
      related: [target.document],
    });
    const result = provider.provide(
      input(source.document),
      cancellationToken(),
      false,
    );
    await started;
    target.setText("export const target = 2;\n");
    fireDocumentChange(target.document);
    releaseRetry?.();
    expect(await result).toMatchObject({
      edit: {
        uri: target.document.uri.toString(),
        newText: "changed",
      },
    });
    expect(retryToken?.isCancellationRequested).toBe(false);
    provider.dispose();
  });

  it("rebases a joined cross-file cursor retry through its target-owned cache entry", async () => {
    const source = mutableDocument(
      Array.from(
        { length: 40 },
        (_value, index) => `const source${index} = ${index};`,
      ).join("\n"),
      "file:///workspace/main.ts",
    );
    const target = mutableDocument(
      Array.from(
        { length: 40 },
        (_value, index) => `const target${index} = ${index};`,
      ).join("\n"),
      "file:///workspace/other.ts",
    );
    vscodeState.documents.push(source.document, target.document);
    let retryStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      retryStarted = resolve;
    });
    let releaseRetry: (() => void) | undefined;
    const retryReleased = new Promise<void>((resolve) => {
      releaseRetry = resolve;
    });
    let requestCount = 0;
    const model = languageModel(async (_messages, options) => {
      requestCount += 1;
      if (options.modelOptions?.max_tokens !== undefined) {
        return chatResponse(
          (async function* (): AsyncIterable<string> {
            yield "other.ts:5";
          })(),
        );
      }
      if (requestCount === 1) {
        return chatResponse((async function* (): AsyncIterable<string> {})());
      }
      retryStarted?.();
      return chatResponse(
        (async function* (): AsyncIterable<string> {
          await retryReleased;
          yield "<INSERT>\n + target retry\n</INSERT>";
        })(),
      );
    });
    const provider = providerFor(source.document, model, Date.now, {
      related: [target.document],
      nextEdit: { asyncCompletions: true },
    });
    const origin = provider.provide(
      input(source.document, 5, "cursor-retry-origin"),
      cancellationToken(),
      false,
    );
    await started;
    const targetJoin = provider.provide(
      input(target.document, 5, "cursor-retry-target-join"),
      cancellationToken(),
      false,
    );
    const sourceJoin = provider.provide(
      input(source.document, 5, "cursor-retry-source-join"),
      cancellationToken(),
      false,
    );
    await Promise.resolve();
    expect(requestCount).toBe(3);
    releaseRetry?.();

    const [originResult, targetResult, sourceResult] = await Promise.all([
      origin,
      targetJoin,
      sourceJoin,
    ]);
    expect(requestCount).toBe(3);
    expect(originResult?.edit?.uri).toBe(target.document.uri.toString());
    expect(targetResult).toMatchObject({
      requestId: "cursor-retry-target-join",
      sourceRequestId: "cursor-retry-target-join",
      edit: { uri: target.document.uri.toString() },
      cacheEntry: { documentUri: target.document.uri.toString() },
    });
    expect(sourceResult).toBeUndefined();
    provider.dispose();
  });

  it("joins a same-file cursor retry from its target and original windows", async () => {
    const source = mutableDocument(
      Array.from(
        { length: 40 },
        (_value, index) => `const source${index} = ${index};`,
      ).join("\n"),
    );
    vscodeState.documents.push(source.document);
    let retryStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      retryStarted = resolve;
    });
    let releaseRetry: (() => void) | undefined;
    const retryReleased = new Promise<void>((resolve) => {
      releaseRetry = resolve;
    });
    let requestCount = 0;
    const model = languageModel(async (_messages, options) => {
      requestCount += 1;
      if (options.modelOptions?.max_tokens !== undefined) {
        return chatResponse(
          (async function* (): AsyncIterable<string> {
            yield "25";
          })(),
        );
      }
      if (requestCount === 1) {
        return chatResponse((async function* (): AsyncIterable<string> {})());
      }
      retryStarted?.();
      return chatResponse(
        (async function* (): AsyncIterable<string> {
          await retryReleased;
          yield "<INSERT>\n + same-file retry\n</INSERT>";
        })(),
      );
    });
    const provider = providerFor(source.document, model, Date.now, {
      nextEdit: { asyncCompletions: true },
    });
    const origin = provider.provide(
      input(source.document, 5, "same-retry-origin"),
      cancellationToken(),
      false,
    );
    await started;
    const targetWindowJoin = provider.provide(
      input(source.document, 25, "same-retry-target-window"),
      cancellationToken(),
      false,
    );
    const originalWindowJoin = provider.provide(
      input(source.document, 5, "same-retry-original-window"),
      cancellationToken(),
      false,
    );
    await Promise.resolve();
    expect(requestCount).toBe(3);
    releaseRetry?.();

    const [originResult, targetResult, originalResult] = await Promise.all([
      origin,
      targetWindowJoin,
      originalWindowJoin,
    ]);
    expect(requestCount).toBe(3);
    expect(originResult?.edit?.uri).toBe(source.document.uri.toString());
    expect(targetResult).toMatchObject({
      requestId: "same-retry-target-window",
      sourceRequestId: "same-retry-target-window",
      cacheEntry: {
        documentUri: source.document.uri.toString(),
        requestId: "same-retry-origin",
        originalEditWindow: expect.any(Object),
      },
    });
    expect(originalResult).toMatchObject({
      requestId: "same-retry-original-window",
      sourceRequestId: "same-retry-original-window",
    });
    provider.dispose();
  });

  it("reuses the original DelaySession for cursor retry artificial delay", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const sourceLines = Array.from(
      { length: 12 },
      (_value, index) => `const value${index} = ${index};`,
    );
    const source = mutableDocument(sourceLines.join("\n"));
    const targetLines = Array.from(
      { length: 8 },
      (_value, index) => `const target${index} = ${index};`,
    );
    const target = mutableDocument(
      targetLines.join("\n"),
      "file:///workspace/other.ts",
    );
    vscodeState.documents.push(source.document, target.document);
    let requestCount = 0;
    const model = languageModel(async (_messages, options) => {
      requestCount += 1;
      const response =
        options.modelOptions?.max_tokens !== undefined
          ? "other.ts:0"
          : requestCount === 3
            ? ["const target0 = 100;", ...targetLines.slice(1, 6)].join("\n")
            : sourceLines.slice(3, 11).join("\n");
      return chatResponse(
        (async function* (): AsyncIterable<string> {
          if (response) yield response;
        })(),
      );
    });
    const provider = providerFor(source.document, model, Date.now, {
      related: [target.document],
      strategy: "xtab275",
      eagerness: "low",
      nextEdit: {
        requestDebounceMs: 100,
        diagnosticsStartDelayMs: 10_000,
        diagnosticsRaceDeadlineMs: 5_000,
      },
    });
    let settled = false;
    const result = provider
      .provide(
        input(source.document, 5, "retry-delay-session"),
        cancellationToken(),
        false,
      )
      .then((value) => {
        settled = true;
        return value;
      });
    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(0);
    for (let index = 0; index < 100; index += 1) {
      await Promise.resolve();
    }
    expect(requestCount).toBe(3);
    await vi.advanceTimersByTimeAsync(1_399);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect((await result)?.edit?.newText).toBe("10");
    provider.dispose();
  });

  it("keeps a raw cross-file cursor result through the minimum delay", async () => {
    const source = mutableDocument(
      Array.from(
        { length: 12 },
        (_value, index) => `const value${index} = ${index};`,
      ).join("\n"),
    );
    const target = mutableDocument(
      "export const target = 1;\n",
      "file:///workspace/other.ts",
    );
    vscodeState.documents.push(source.document, target.document);
    let modelRequestCount = 0;
    const model = languageModel(async (_messages, options) => {
      modelRequestCount += 1;
      const value =
        options.modelOptions?.max_tokens !== undefined
          ? "other.ts:0"
          : modelRequestCount > 2
            ? "<INSERT>\nchanged\n</INSERT>"
            : "";
      return chatResponse(
        (async function* (): AsyncIterable<string> {
          if (value) {
            yield value;
          }
        })(),
      );
    });
    const provider = providerFor(source.document, model, Date.now, {
      related: [target.document],
      nextEdit: { cacheDelayMs: 500 },
    });
    const result = provider.provide(
      input(source.document),
      cancellationToken(),
      true,
    );
    await vi.waitFor(() =>
      expect(provider.getState().cursorPrediction?.outcome).toBe("retry-edit"),
    );
    target.setText("export const target = 2;\n");
    fireDocumentChange(target.document);
    expect(await result).toMatchObject({
      fromCache: false,
      edit: {
        uri: target.document.uri.toString(),
        newText: "changed",
      },
    });
    expect(modelRequestCount).toBe(3);
    provider.dispose();
  });

  it("opens a closed cross-file cursor target and performs the retry", async () => {
    const source = mutableDocument(
      Array.from(
        { length: 12 },
        (_value, index) => `const value${index} = ${index};`,
      ).join("\n"),
      "vscode-remote://ssh-remote+source/workspace/main.ts",
    );
    const target = mutableDocument(
      "export const target = 1;\n",
      "vscode-remote://ssh-remote+source/workspace/other.ts",
    );
    vscodeState.documents.push(source.document);
    vscodeState.openableDocuments.set(
      target.document.uri.toString(),
      target.document,
    );
    let requestCount = 0;
    const model = languageModel(async (_messages, options) => {
      requestCount += 1;
      const value =
        options.modelOptions?.max_tokens !== undefined
          ? "other.ts:0"
          : requestCount === 3
            ? "<INSERT>\n + opened\n</INSERT>"
            : "";
      return chatResponse(
        (async function* (): AsyncIterable<string> {
          if (value) yield value;
        })(),
      );
    });
    const provider = providerFor(source.document, model);
    const result = await provider.provide(
      input(source.document),
      cancellationToken(),
      false,
    );
    expect(vscodeState.openCalls).toEqual([
      "vscode-remote://ssh-remote+source/workspace/other.ts",
    ]);
    expect(requestCount).toBe(3);
    expect(result).toMatchObject({
      edit: {
        uri: "vscode-remote://ssh-remote+source/workspace/other.ts",
      },
      cursorJump: {
        kind: "differentFile",
        targetUri: "vscode-remote://ssh-remote+source/workspace/other.ts",
        lineNumber: 0,
      },
    });
    const cached = await provider.provide(
      input(source.document, 5, "closed-target-cache"),
      cancellationToken(),
      false,
    );
    expect(cached).toMatchObject({
      fromCache: true,
      edit: {
        uri: "vscode-remote://ssh-remote+source/workspace/other.ts",
      },
    });
    expect(requestCount).toBe(3);
    provider.dispose();
  });

  it("matches an open remote cursor target by full URI authority", async () => {
    const source = mutableDocument(
      Array.from(
        { length: 12 },
        (_value, index) => `const value${index} = ${index};`,
      ).join("\n"),
      "vscode-remote://ssh-remote+source/workspace/main.ts",
    );
    const wrongAuthority = mutableDocument(
      "export const wrongAuthority = true;\n",
      "vscode-remote://ssh-remote+other/workspace/other.ts",
    );
    const sourceAuthority = mutableDocument(
      "export const sourceAuthority = true;\n",
      "vscode-remote://ssh-remote+source/workspace/other.ts",
    );
    vscodeState.documents.push(
      source.document,
      wrongAuthority.document,
      sourceAuthority.document,
    );
    let requestCount = 0;
    const model = languageModel(async (_messages, options) => {
      requestCount += 1;
      const value =
        options.modelOptions?.max_tokens !== undefined
          ? "other.ts:0"
          : requestCount === 3
            ? "<INSERT>\n + source authority\n</INSERT>"
            : "";
      return chatResponse(
        (async function* (): AsyncIterable<string> {
          if (value) yield value;
        })(),
      );
    });
    const provider = providerFor(source.document, model, Date.now, {
      related: [wrongAuthority.document, sourceAuthority.document],
    });

    const result = await provider.provide(
      input(source.document),
      cancellationToken(),
      false,
    );

    expect(vscodeState.openCalls).toEqual([
      "vscode-remote://ssh-remote+source/workspace/other.ts",
    ]);
    expect(requestCount).toBe(3);
    expect(result).toMatchObject({
      edit: {
        uri: "vscode-remote://ssh-remote+source/workspace/other.ts",
      },
      cursorJump: {
        targetUri: "vscode-remote://ssh-remote+source/workspace/other.ts",
      },
    });
    provider.dispose();
  });

  it("returns a pure cursor jump when a closed cross-file target cannot open", async () => {
    const source = mutableDocument(
      Array.from(
        { length: 12 },
        (_value, index) => `const value${index} = ${index};`,
      ).join("\n"),
      "vscode-remote://ssh-remote+source/workspace/main.ts",
    );
    vscodeState.documents.push(source.document);
    vscodeState.openFailures.add(
      "vscode-remote://ssh-remote+source/workspace/missing.ts",
    );
    let requestCount = 0;
    const model = languageModel(async (_messages, options) => {
      requestCount += 1;
      const value =
        options.modelOptions?.max_tokens !== undefined ? "missing.ts:7" : "";
      return chatResponse(
        (async function* (): AsyncIterable<string> {
          if (value) yield value;
        })(),
      );
    });
    const provider = providerFor(source.document, model);
    const result = await provider.provide(
      input(source.document),
      cancellationToken(),
      false,
    );
    expect(vscodeState.openCalls).toEqual([
      "vscode-remote://ssh-remote+source/workspace/missing.ts",
    ]);
    expect(requestCount).toBe(2);
    expect(result).toMatchObject({
      cursorJump: {
        kind: "differentFile",
        targetUri: "vscode-remote://ssh-remote+source/workspace/missing.ts",
        lineNumber: 7,
        fallbackOnly: true,
      },
    });
    expect(result?.edit).toBeUndefined();
    expect(provider.getState().cursorPrediction).toMatchObject({
      outcome: "target-unavailable",
      reason: "crossFile:openFailed",
    });
    expect(provider.getState().cacheSize).toBe(1);
    expect(
      await provider.provide(
        input(source.document, 5, "pure-jump-negative-cache"),
        cancellationToken(),
        false,
      ),
    ).toBeUndefined();
    expect(requestCount).toBe(2);
    expect(vscodeState.openCalls).toHaveLength(1);
    provider.dispose();
  });

  it("keeps a pure cursor jump when the source changes before target open fails", async () => {
    const sourceText = Array.from(
      { length: 12 },
      (_value, index) => `const value${index} = ${index};`,
    ).join("\n");
    const source = mutableDocument(sourceText);
    const missingUri = "file:///workspace/missing.ts";
    vscodeState.documents.push(source.document);
    let finishOpen: (() => void) | undefined;
    const openGate = new Promise<void>((resolve) => {
      finishOpen = resolve;
    });
    vscodeState.openHandlers.set(missingUri, async () => {
      await openGate;
      throw new Error("ENOENT");
    });
    let requestCount = 0;
    const model = languageModel(async (_messages, options) => {
      requestCount += 1;
      const value =
        options.modelOptions?.max_tokens !== undefined ? "missing.ts:7" : "";
      return chatResponse(
        (async function* (): AsyncIterable<string> {
          if (value) yield value;
        })(),
      );
    });
    const provider = providerFor(source.document, model);
    const result = provider.provide(
      input(source.document, 5, "typed-open-failure"),
      cancellationToken(),
      false,
    );
    await vi.waitFor(() => expect(vscodeState.openCalls).toEqual([missingUri]));
    source.setText(`${sourceText}\n// typed during open`);
    const insertionPosition = source.document.positionAt(sourceText.length);
    fireDocumentChange(source.document, [
      {
        range: new vscodeApi.Range(insertionPosition, insertionPosition),
        rangeOffset: sourceText.length,
        rangeLength: 0,
        text: "\n// typed during open",
      },
    ]);
    finishOpen?.();

    expect(await result).toMatchObject({
      cursorJump: {
        targetUri: missingUri,
        fallbackOnly: true,
      },
    });
    expect(provider.getState().cacheSize).toBe(1);
    source.setText(sourceText);
    expect(
      await provider.provide(
        input(source.document, 5, "typed-open-failure-negative"),
        cancellationToken(),
        false,
      ),
    ).toBeUndefined();
    expect(requestCount).toBe(2);
    expect(vscodeState.openCalls).toHaveLength(1);
    provider.dispose();
  });

  it("caches a failed-open cursor jump before the cancelled caller drops it", async () => {
    const source = mutableDocument(
      Array.from(
        { length: 12 },
        (_value, index) => `const value${index} = ${index};`,
      ).join("\n"),
    );
    const missingUri = "file:///workspace/missing.ts";
    vscodeState.documents.push(source.document);
    let finishOpen: (() => void) | undefined;
    const openGate = new Promise<void>((resolve) => {
      finishOpen = resolve;
    });
    vscodeState.openHandlers.set(missingUri, async () => {
      await openGate;
      throw new Error("ENOENT");
    });
    let requestCount = 0;
    const model = languageModel(async (_messages, options) => {
      requestCount += 1;
      const value =
        options.modelOptions?.max_tokens !== undefined ? "missing.ts:7" : "";
      return chatResponse(
        (async function* (): AsyncIterable<string> {
          if (value) yield value;
        })(),
      );
    });
    const provider = providerFor(source.document, model);
    const consumer = new vscodeApi.CancellationTokenSource();
    const result = provider.provide(
      input(source.document, 5, "cancelled-open-failure"),
      consumer.token,
      false,
    );
    await vi.waitFor(() => expect(vscodeState.openCalls).toEqual([missingUri]));
    consumer.cancel();
    finishOpen?.();

    expect(await result).toBeUndefined();
    expect(provider.getState().cacheSize).toBe(1);
    expect(
      await provider.provide(
        input(source.document, 5, "cancelled-open-failure-negative"),
        cancellationToken(),
        false,
      ),
    ).toBeUndefined();
    expect(requestCount).toBe(2);
    expect(vscodeState.openCalls).toHaveLength(1);
    consumer.dispose();
    provider.dispose();
  });

  it("abandons a closed-target retry when the source changes during open", async () => {
    const sourceText = Array.from(
      { length: 12 },
      (_value, index) => `const value${index} = ${index};`,
    ).join("\n");
    const source = mutableDocument(sourceText);
    const target = mutableDocument(
      "export const target = 1;\n",
      "file:///workspace/other.ts",
    );
    vscodeState.documents.push(source.document);
    let finishOpen: (() => void) | undefined;
    const openGate = new Promise<void>((resolve) => {
      finishOpen = resolve;
    });
    vscodeState.openHandlers.set(target.document.uri.toString(), async () => {
      await openGate;
      return target.document;
    });
    let requestCount = 0;
    const model = languageModel(async (_messages, options) => {
      requestCount += 1;
      const value =
        options.modelOptions?.max_tokens !== undefined ? "other.ts:0" : "";
      return chatResponse(
        (async function* (): AsyncIterable<string> {
          if (value) yield value;
        })(),
      );
    });
    const provider = providerFor(source.document, model);
    const result = provider.provide(
      input(source.document),
      cancellationToken(),
      false,
    );
    await vi.waitFor(() => expect(vscodeState.openCalls).toHaveLength(1));
    source.setText(`${sourceText}\n// changed`);
    fireDocumentChange(source.document, [
      {
        range: new vscodeApi.Range(
          new vscodeApi.Position(11, sourceText.split("\n")[11].length),
          new vscodeApi.Position(11, sourceText.split("\n")[11].length),
        ),
        rangeOffset: sourceText.length,
        rangeLength: 0,
        text: "\n// changed",
      },
    ]);
    finishOpen?.();
    expect(await result).toBeUndefined();
    expect(requestCount).toBe(2);
    provider.dispose();
  });

  it("gates ignored current documents before cache, diagnostics, and transport", async () => {
    const source = Array.from(
      { length: 12 },
      (_value, index) => `const value${index} = ${index};`,
    ).join("\n");
    const mutable = mutableDocument(source);
    vscodeState.documents.push(mutable.document);
    const ignoredUris = new Set<string>([mutable.document.uri.toString()]);
    let requestCount = 0;
    const model = languageModel(async () => {
      requestCount += 1;
      return chatResponse(
        (async function* (): AsyncIterable<string> {
          yield "<INSERT>\n + cached\n</INSERT>";
        })(),
      );
    });
    const provider = providerFor(mutable.document, model, Date.now, {
      ignoredUris,
    });
    const selection = {
      active: new vscodeApi.Position(5, 12),
      isEmpty: true,
    } as vscode.Selection;
    const textEditor: vscode.TextEditor = {
      document: mutable.document,
      selection,
      selections: [selection],
      visibleRanges: [],
      options: {},
      viewColumn: undefined,
      edit: async () => true,
      insertSnippet: async () => true,
      setDecorations: () => undefined,
      revealRange: () => undefined,
      show: () => undefined,
      hide: () => undefined,
    };
    for (const listener of vscodeState.selectionListeners) {
      listener({
        textEditor,
        selections: [selection],
        kind: undefined,
      });
    }
    await Promise.resolve();
    expect(vscodeState.diagnosticsReads).toBeGreaterThan(0);
    const backgroundDiagnosticsReads = vscodeState.diagnosticsReads;
    expect(
      await provider.provide(
        input(mutable.document),
        cancellationToken(),
        false,
      ),
    ).toBeUndefined();
    expect(requestCount).toBe(0);
    expect(vscodeState.diagnosticsReads).toBe(backgroundDiagnosticsReads);

    ignoredUris.delete(mutable.document.uri.toString());
    expect(
      await provider.provide(
        input(mutable.document, 5, "allowed"),
        cancellationToken(),
        false,
      ),
    ).toBeDefined();
    expect(requestCount).toBe(1);
    const diagnosticsReads = vscodeState.diagnosticsReads;

    ignoredUris.add(mutable.document.uri.toString());
    expect(
      await provider.provide(
        input(mutable.document, 5, "ignored-cache"),
        cancellationToken(),
        false,
      ),
    ).toBeUndefined();
    expect(requestCount).toBe(1);
    expect(vscodeState.diagnosticsReads).toBe(diagnosticsReads);
    provider.dispose();
  });

  it("excludes ignored recent context but still retries an ignored predicted target", async () => {
    const source = mutableDocument(
      Array.from(
        { length: 12 },
        (_value, index) => `const value${index} = ${index};`,
      ).join("\n"),
    );
    const ignoredTarget = mutableDocument(
      "export const secret = 1;\n",
      "file:///workspace/other.ts",
    );
    vscodeState.documents.push(source.document, ignoredTarget.document);
    const ignoredUris = new Set([ignoredTarget.document.uri.toString()]);
    const requests: Array<{
      readonly messages: readonly TestModelMessage[];
      readonly options: vscode.LanguageModelChatRequestOptions;
    }> = [];
    const model = languageModel(async (messages, options) => {
      requests.push({ messages, options });
      const value =
        options.modelOptions?.max_tokens !== undefined ? "other.ts:0" : "";
      return chatResponse(
        (async function* (): AsyncIterable<string> {
          if (value) {
            yield value;
          }
        })(),
      );
    });
    const provider = providerFor(source.document, model, Date.now, {
      related: [ignoredTarget.document],
      ignoredUris,
    });
    expect(
      await provider.provide(
        input(source.document),
        cancellationToken(),
        false,
      ),
    ).toBeUndefined();
    expect(requests[0]?.messages.map(messageText).join("\n")).not.toContain(
      "other.ts",
    );
    expect(requests).toHaveLength(3);
    expect(requests[2]?.messages.map(messageText).join("\n")).toContain(
      "export const secret = 1;",
    );
    expect(provider.getState().cursorPrediction).toMatchObject({
      outcome: "retry-empty",
      targetUri: ignoredTarget.document.uri.toString(),
    });
    provider.dispose();
  });

  it("defers speculation until the shown edit is the final streamed edit", async () => {
    const sourceText = Array.from(
      { length: 12 },
      (_value, index) => `const value${index} = ${index};`,
    ).join("\n");
    const source = mutableDocument(sourceText);
    vscodeState.documents.push(source.document);
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let requestCount = 0;
    const model = languageModel(async (_messages, _options, token) => {
      requestCount += 1;
      if (requestCount === 1) {
        return chatResponse(
          (async function* (): AsyncIterable<string> {
            yield "<INSERT>\n + first\n";
            await gate;
            yield "console.log(value5);\n</INSERT>";
          })(),
        );
      }
      return chatResponse(
        (async function* (): AsyncIterable<string> {
          await new Promise<void>((resolve) =>
            token.onCancellationRequested(resolve),
          );
        })(),
      );
    });
    const provider = providerFor(source.document, model, Date.now, {
      nextEdit: { speculativeRequests: "on" },
    });
    const suggestion = await provider.provide(
      input(source.document),
      cancellationToken(),
      false,
    );
    if (!suggestion) throw new Error("Expected a streamed suggestion.");
    provider.handleShown(suggestion, true);
    expect(provider.getState().speculative).toMatchObject({
      scheduled: true,
      pending: false,
    });
    release?.();
    await vi.waitFor(() => expect(provider.getState().inFlight).toBe(0));
    expect(requestCount).toBe(1);
    expect(provider.getState().hasSpeculativeRequest).toBe(false);
    provider.dispose();
  });

  it("fires a scheduled speculative request when the origin stream ends unchanged", async () => {
    const source = mutableDocument(
      Array.from(
        { length: 12 },
        (_value, index) => `const value${index} = ${index};`,
      ).join("\n"),
    );
    vscodeState.documents.push(source.document);
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let requestCount = 0;
    const model = languageModel(async (_messages, _options, token) => {
      requestCount += 1;
      if (requestCount === 1) {
        return chatResponse(
          (async function* (): AsyncIterable<string> {
            yield "<INSERT>\n + first\n";
            await gate;
            yield "</INSERT>";
          })(),
        );
      }
      return chatResponse(
        (async function* (): AsyncIterable<string> {
          await new Promise<void>((resolve) =>
            token.onCancellationRequested(resolve),
          );
        })(),
      );
    });
    const provider = providerFor(source.document, model, Date.now, {
      nextEdit: { speculativeRequests: "on" },
    });
    const suggestion = await provider.provide(
      input(source.document),
      cancellationToken(),
      false,
    );
    if (!suggestion) throw new Error("Expected a streamed suggestion.");
    provider.handleShown(suggestion, true);
    expect(provider.getState().speculative.scheduled).toBe(true);
    release?.();
    await vi.waitFor(() => expect(requestCount).toBe(2));
    expect(provider.getState().speculative).toMatchObject({
      scheduled: false,
      pending: true,
    });
    provider.dispose();
  });

  it("clears an origin's scheduled speculation when another document supersedes it", async () => {
    const sourceA = mutableDocument(
      Array.from(
        { length: 12 },
        (_value, index) => `const alpha${index} = ${index};`,
      ).join("\n"),
      "file:///workspace/a.ts",
    );
    const sourceB = mutableDocument(
      Array.from(
        { length: 12 },
        (_value, index) => `const beta${index} = ${index};`,
      ).join("\n"),
      "file:///workspace/b.ts",
    );
    vscodeState.documents.push(sourceA.document, sourceB.document);
    let releaseOrigin: (() => void) | undefined;
    const originReleased = new Promise<void>((resolve) => {
      releaseOrigin = resolve;
    });
    let requestCount = 0;
    const model = languageModel(async () => {
      requestCount += 1;
      if (requestCount === 1) {
        return chatResponse(
          (async function* (): AsyncIterable<string> {
            yield "<INSERT>\n + origin\n";
            await originReleased;
            yield "</INSERT>";
          })(),
        );
      }
      return chatResponse(
        (async function* (): AsyncIterable<string> {
          yield "<INSERT>\n + replacement\n</INSERT>";
        })(),
      );
    });
    const provider = providerFor(sourceA.document, model, Date.now, {
      related: [sourceB.document],
      nextEdit: {
        asyncCompletions: false,
        speculativeRequests: "on",
        requestDebounceMs: 0,
      },
    });
    const origin = await provider.provide(
      input(sourceA.document, 5, "origin-a"),
      cancellationToken(),
      false,
    );
    if (!origin?.edit) throw new Error("Expected the origin edit.");
    provider.handleShown(origin, true);
    expect(provider.getState().speculative.scheduled).toBe(true);

    const replacement = await provider.provide(
      input(sourceB.document, 5, "replacement-b"),
      cancellationToken(),
      false,
    );
    expect(replacement?.edit?.newText).toContain("replacement");
    expect(provider.getState().speculative.scheduled).toBe(false);
    releaseOrigin?.();
    await vi.waitFor(() => expect(provider.getState().inFlight).toBe(0));
    expect(requestCount).toBe(2);
    provider.dispose();
  });

  it("clears stale scheduled speculation after a non-async document cancellation", async () => {
    const sourceText = Array.from(
      { length: 12 },
      (_value, index) => `const value${index} = ${index};`,
    ).join("\n");
    const source = mutableDocument(sourceText);
    vscodeState.documents.push(source.document);
    let releaseOrigin: (() => void) | undefined;
    const originReleased = new Promise<void>((resolve) => {
      releaseOrigin = resolve;
    });
    let requestCount = 0;
    const provider = providerFor(
      source.document,
      languageModel(async () => {
        requestCount += 1;
        if (requestCount === 1) {
          return chatResponse(
            (async function* (): AsyncIterable<string> {
              yield "<INSERT>\n + origin\n";
              await originReleased;
              yield "</INSERT>";
            })(),
          );
        }
        return chatResponse(
          (async function* (): AsyncIterable<string> {
            yield "<INSERT>\n + replacement\n</INSERT>";
          })(),
        );
      }),
      Date.now,
      {
        nextEdit: {
          asyncCompletions: false,
          speculativeRequests: "on",
        },
      },
    );
    const origin = await provider.provide(
      input(source.document, 5, "non-async-origin"),
      cancellationToken(),
      false,
    );
    if (!origin?.edit) throw new Error("Expected the origin edit.");
    provider.handleShown(origin, true);
    expect(provider.getState().speculative.scheduled).toBe(true);

    const changeOffset = offsetAt(sourceText, new vscodeApi.Position(5, 12));
    const changedText = `${sourceText.slice(0, changeOffset)}X${sourceText.slice(changeOffset)}`;
    source.setText(changedText);
    fireDocumentChange(source.document, [
      {
        range: new vscodeApi.Range(
          new vscodeApi.Position(5, 12),
          new vscodeApi.Position(5, 12),
        ),
        rangeOffset: changeOffset,
        rangeLength: 0,
        text: "X",
      },
    ]);
    expect(provider.getState()).toMatchObject({
      inFlight: 1,
      speculative: { scheduled: true },
    });
    const replacementInput = input(source.document, 5, "non-async-replacement");
    const replacement = await provider.provide(
      {
        ...replacementInput,
        position: new vscodeApi.Position(5, 13),
      },
      cancellationToken(),
      false,
    );
    expect(replacement?.edit?.newText).toContain("replacement");
    expect(provider.getState().speculative.scheduled).toBe(false);
    releaseOrigin?.();
    await vi.waitFor(() => expect(provider.getState().inFlight).toBe(0));
    expect(requestCount).toBe(2);
    provider.dispose();
  });

  it("triggers an old shown edit immediately and preserves mismatched speculation when joining the current pending request", async () => {
    const sourceA = mutableDocument(
      Array.from(
        { length: 12 },
        (_value, index) => `const alpha${index} = ${index};`,
      ).join("\n"),
      "file:///workspace/a.ts",
    );
    const sourceB = mutableDocument(
      Array.from(
        { length: 12 },
        (_value, index) => `const beta${index} = ${index};`,
      ).join("\n"),
      "file:///workspace/b.ts",
    );
    vscodeState.documents.push(sourceA.document, sourceB.document);
    let releaseOrigin: (() => void) | undefined;
    const originReleased = new Promise<void>((resolve) => {
      releaseOrigin = resolve;
    });
    let releaseReplacement: (() => void) | undefined;
    const replacementReleased = new Promise<void>((resolve) => {
      releaseReplacement = resolve;
    });
    let requestCount = 0;
    const model = languageModel(async (_messages, _options, token) => {
      requestCount += 1;
      if (requestCount === 1) {
        return chatResponse(
          (async function* (): AsyncIterable<string> {
            yield "<INSERT>\n + origin\n";
            await originReleased;
            yield "</INSERT>";
          })(),
        );
      }
      if (requestCount === 2) {
        return chatResponse(
          (async function* (): AsyncIterable<string> {
            await replacementReleased;
            yield "<INSERT>\n + replacement\n</INSERT>";
          })(),
        );
      }
      return chatResponse(
        (async function* (): AsyncIterable<string> {
          await new Promise<void>((resolve) =>
            token.onCancellationRequested(resolve),
          );
        })(),
      );
    });
    const provider = providerFor(sourceA.document, model, Date.now, {
      related: [sourceB.document],
      nextEdit: {
        asyncCompletions: false,
        speculativeRequests: "on",
        requestDebounceMs: 0,
      },
    });
    const origin = await provider.provide(
      input(sourceA.document, 5, "origin-before-replacement"),
      cancellationToken(),
      false,
    );
    if (!origin?.edit) throw new Error("Expected the origin edit.");
    const replacementInput = input(sourceB.document, 5, "replacement-current");
    const replacement = provider.provide(
      replacementInput,
      cancellationToken(),
      false,
    );
    await vi.waitFor(() => expect(requestCount).toBe(2));

    provider.handleShown(origin, true);
    await vi.waitFor(() => expect(requestCount).toBe(3));
    expect(provider.getState().speculative).toMatchObject({
      scheduled: false,
      pending: true,
    });
    const joined = provider.provide(
      {
        ...replacementInput,
        context: {
          ...replacementInput.context,
          requestUuid: "replacement-joined",
        },
      },
      cancellationToken(),
      false,
    );
    await Promise.resolve();
    expect(provider.getState().speculative.pending).toBe(true);
    expect(requestCount).toBe(3);

    releaseReplacement?.();
    expect((await replacement)?.edit?.newText).toContain("replacement");
    expect((await joined)?.requestId).toBe("replacement-joined");
    releaseOrigin?.();
    provider.dispose();
  });

  it("reuses and consumes a matching pending speculative request", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const sourceText = Array.from(
      { length: 12 },
      (_value, index) => `const value${index} = ${index};`,
    ).join("\n");
    const source = mutableDocument(sourceText);
    vscodeState.documents.push(source.document);
    let releaseSpeculativeRemainder: (() => void) | undefined;
    const speculativeRemainderReleased = new Promise<void>((resolve) => {
      releaseSpeculativeRemainder = resolve;
    });
    let requestCount = 0;
    let speculativeToken: vscode.CancellationToken | undefined;
    const model = languageModel(async (_messages, _options, token) => {
      requestCount += 1;
      if (requestCount === 1) {
        return chatResponse(
          (async function* (): AsyncIterable<string> {
            yield "<INSERT>\n + first\n</INSERT>";
          })(),
        );
      }
      speculativeToken = token;
      return chatResponse(
        (async function* (): AsyncIterable<string> {
          yield "<INSERT>\n + next\n";
          await speculativeRemainderReleased;
          yield "</INSERT>";
        })(),
      );
    });
    const provider = providerFor(source.document, model, Date.now, {
      nextEdit: { speculativeRequests: "on" },
    });
    const first = await provider.provide(
      input(source.document),
      cancellationToken(),
      false,
    );
    if (!first?.edit) throw new Error("Expected the first edit.");
    provider.handleShown(first, true);
    await vi.waitFor(() =>
      expect(provider.getState().speculative.pending).toBe(true),
    );
    const postEditText = `${sourceText.slice(0, first.edit.startOffset)}${
      first.edit.newText
    }${sourceText.slice(first.edit.endOffset)}`;
    source.setText(postEditText);
    fireDocumentChange(source.document, [
      {
        range: new vscodeApi.Range(
          new vscodeApi.Position(5, 0),
          new vscodeApi.Position(5, 0),
        ),
        rangeOffset: first.edit.startOffset,
        rangeLength: first.edit.endOffset - first.edit.startOffset,
        text: first.edit.newText,
      },
    ]);
    const secondConsumer = new vscodeApi.CancellationTokenSource();
    const second = await provider.provide(
      input(source.document, 5, "request-2"),
      secondConsumer.token,
      false,
    );
    expect(second).toMatchObject({ speculative: true, fromCache: false });
    expect(requestCount).toBe(2);
    expect(provider.getState().speculative).toMatchObject({
      pending: false,
      consumed: 1,
    });
    secondConsumer.cancel();
    await vi.advanceTimersByTimeAsync(1_001);
    expect(speculativeToken?.isCancellationRequested).toBe(false);
    releaseSpeculativeRemainder?.();
    await vi.advanceTimersByTimeAsync(0);
    secondConsumer.dispose();
    provider.dispose();
  });

  it("gathers fresh shown-time context and records the shown edit in both timelines", async () => {
    const sourceText = Array.from(
      { length: 12 },
      (_value, index) => `const value${index} = ${index};`,
    ).join("\n");
    const source = mutableDocument(sourceText);
    const related = mutableDocument(
      "export const RELATED_CONTEXT_OLD = true;\n",
      "file:///workspace/related.ts",
    );
    vscodeState.documents.push(source.document, related.document);
    const requests: string[] = [];
    let requestCount = 0;
    const provider = providerFor(
      source.document,
      languageModel(async (messages) => {
        requestCount += 1;
        requests.push(messages.map(messageText).join("\n"));
        return chatResponse(
          requestCount === 1
            ? (async function* (): AsyncIterable<string> {
                yield unifiedEditWindow(sourceText, {
                  5: "const value5 = 500;",
                });
              })()
            : (async function* (): AsyncIterable<string> {})(),
        );
      }),
      Date.now,
      {
        related: [related.document],
        visibleRelated: true,
        workspaceEditHistory: () => [
          {
            uri: related.document.uri.toString(),
            path: "/workspace/related.ts",
            relativePath: "related.ts",
            languageId: "typescript",
            before: "",
            after: related.document.getText(),
            timestamp: 2_000,
            reason: "other",
            changes: [],
          },
        ],
        nextEdit: {
          speculativeRequests: "on",
        },
      },
    );
    const first = await provider.provide(
      input(source.document, 5, "fresh-shown-context"),
      cancellationToken(),
      false,
    );
    if (!first?.edit) throw new Error("Expected the shown source edit.");
    await vi.waitFor(() => expect(provider.getState().inFlight).toBe(0));
    related.setText("export const RELATED_CONTEXT_NEW = true;\n");
    fireDocumentChange(related.document);
    provider.handleShown(first, true);
    await vi.waitFor(() => expect(requestCount).toBe(2));

    expect(requests[1]).toContain("RELATED_CONTEXT_NEW");
    expect(requests[1]).not.toContain("RELATED_CONTEXT_OLD");
    expect(requests[1]).toContain("-const value5 = 5;");
    expect(requests[1]).toContain("+const value5 = 500;");
    provider.dispose();
  });

  it("consumes a matching speculative request after edit history becomes empty", async () => {
    const sourceText = Array.from(
      { length: 12 },
      (_value, index) => `const value${index} = ${index};`,
    ).join("\n");
    const source = mutableDocument(sourceText);
    vscodeState.documents.push(source.document);
    let hasEditHistory = true;
    let contextCalls = 0;
    let requestCount = 0;
    let releaseSpeculativeResponse: (() => void) | undefined;
    const speculativeResponseReleased = new Promise<void>((resolve) => {
      releaseSpeculativeResponse = resolve;
    });
    const sessionSpy = vi.spyOn(
      NesUserInteractionMonitor.prototype,
      "createDelaySession",
    );
    const provider = providerFor(
      source.document,
      languageModel(async () => {
        requestCount += 1;
        if (requestCount === 1) {
          return chatResponse(
            (async function* (): AsyncIterable<string> {
              yield "<INSERT>\n + first\n</INSERT>";
            })(),
          );
        }
        return chatResponse(
          (async function* (): AsyncIterable<string> {
            await speculativeResponseReleased;
            yield "<INSERT>\n + speculative\n</INSERT>";
          })(),
        );
      }),
      Date.now,
      {
        hasEditHistory: () => hasEditHistory,
        onGatherContextRequest: () => {
          contextCalls += 1;
        },
        nextEdit: { speculativeRequests: "on" },
      },
    );
    const first = await provider.provide(
      input(source.document, 5, "history-speculative-source"),
      cancellationToken(),
      false,
    );
    if (!first?.edit) throw new Error("Expected the source suggestion.");
    provider.handleShown(first, true);
    await vi.waitFor(() => {
      expect(requestCount).toBe(2);
      expect(provider.getState().speculative.pending).toBe(true);
    });
    const postEditText = `${sourceText.slice(0, first.edit.startOffset)}${first.edit.newText}${sourceText.slice(first.edit.endOffset)}`;
    source.setText(postEditText);
    fireDocumentChange(source.document, [
      {
        range: new vscodeApi.Range(
          source.document.positionAt(first.edit.startOffset),
          source.document.positionAt(first.edit.endOffset),
        ),
        rangeOffset: first.edit.startOffset,
        rangeLength: first.edit.endOffset - first.edit.startOffset,
        text: first.edit.newText,
      },
    ]);
    hasEditHistory = false;
    const sessionCalls = sessionSpy.mock.calls.length;
    const contextCallsBeforeConsume = contextCalls;
    const requestCallsBeforeConsume = requestCount;

    const consumedPromise = provider.provide(
      input(source.document, 5, "history-speculative-caller"),
      cancellationToken(),
      false,
    );
    await Promise.resolve();
    expect(provider.getState().speculative).toMatchObject({
      pending: false,
      consumed: 1,
    });
    expect(contextCalls).toBe(contextCallsBeforeConsume);
    expect(requestCount).toBe(requestCallsBeforeConsume);
    expect(sessionSpy).toHaveBeenCalledTimes(sessionCalls);
    releaseSpeculativeResponse?.();
    const consumed = await consumedPromise;
    expect(consumed).toMatchObject({
      requestId: "history-speculative-caller",
      sourceRequestId: "history-speculative-caller",
      speculative: true,
    });
    provider.dispose();
  });

  it("cancels a consumed speculative request immediately before transport", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const sourceText = Array.from(
      { length: 12 },
      (_value, index) => `const value${index} = ${index};`,
    ).join("\n");
    const source = mutableDocument(sourceText);
    vscodeState.documents.push(source.document);
    let requestCount = 0;
    const consumer = new vscodeApi.CancellationTokenSource();
    const model = languageModel(async () => {
      requestCount += 1;
      return chatResponse(
        (async function* (): AsyncIterable<string> {
          yield "<INSERT>\n + first\n</INSERT>";
        })(),
      );
    });
    const provider = providerFor(source.document, model, Date.now, {
      nextEdit: {
        speculativeRequests: "on",
        requestDebounceMs: 100,
        diagnosticsStartDelayMs: 10_000,
      },
    });
    const firstPending = provider.provide(
      input(source.document, 5, "spec-pre-transport-first"),
      cancellationToken(),
      false,
    );
    await vi.advanceTimersByTimeAsync(100);
    const first = await firstPending;
    if (!first?.edit) throw new Error("Expected the first edit.");
    await vi.waitFor(() => expect(provider.getState().inFlight).toBe(0));
    provider.handleShown(first, true);
    expect(provider.getState().speculative.pending).toBe(true);
    expect(requestCount).toBe(1);

    const postEditText = `${sourceText.slice(0, first.edit.startOffset)}${
      first.edit.newText
    }${sourceText.slice(first.edit.endOffset)}`;
    source.setText(postEditText);
    fireDocumentChange(source.document, [
      {
        range: new vscodeApi.Range(
          new vscodeApi.Position(5, 0),
          new vscodeApi.Position(5, 0),
        ),
        rangeOffset: first.edit.startOffset,
        rangeLength: first.edit.endOffset - first.edit.startOffset,
        text: first.edit.newText,
      },
    ]);
    const reused = provider.provide(
      input(source.document, 5, "spec-pre-transport-reuse"),
      consumer.token,
      false,
    );
    await vi.waitFor(() =>
      expect(provider.getState().speculative.consumed).toBe(1),
    );
    consumer.cancel();
    await vi.advanceTimersByTimeAsync(0);

    expect(await reused).toBeUndefined();
    expect(requestCount).toBe(1);
    expect(provider.getState().speculative).toMatchObject({
      pending: false,
      consumed: 1,
    });
    consumer.dispose();
    provider.dispose();
  });

  it("detaches a matching pending request before a cancelled consumer waits", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const sourceText = Array.from(
      { length: 12 },
      (_value, index) => `const value${index} = ${index};`,
    ).join("\n");
    const source = mutableDocument(sourceText);
    vscodeState.documents.push(source.document);
    let releaseSpeculative: (() => void) | undefined;
    const speculativeGate = new Promise<void>((resolve) => {
      releaseSpeculative = resolve;
    });
    let requestCount = 0;
    let speculativeToken: vscode.CancellationToken | undefined;
    const model = languageModel(async (_messages, _options, token) => {
      requestCount += 1;
      if (requestCount === 1) {
        return chatResponse(
          (async function* (): AsyncIterable<string> {
            yield "<INSERT>\n + first\n</INSERT>";
          })(),
        );
      }
      if (requestCount === 2) {
        speculativeToken = token;
        return chatResponse(
          (async function* (): AsyncIterable<string> {
            await Promise.race([
              speculativeGate,
              new Promise<void>((resolve) =>
                token.onCancellationRequested(resolve),
              ),
            ]);
            if (token.isCancellationRequested) return;
            yield "<INSERT>\n + speculative\n</INSERT>";
          })(),
        );
      }
      return chatResponse(
        (async function* (): AsyncIterable<string> {
          yield "<INSERT>\n + fresh\n</INSERT>";
        })(),
      );
    });
    const provider = providerFor(source.document, model, Date.now, {
      nextEdit: { speculativeRequests: "on" },
    });
    const first = await provider.provide(
      input(source.document),
      cancellationToken(),
      false,
    );
    if (!first?.edit) throw new Error("Expected the first edit.");
    provider.handleShown(first, true);
    await vi.waitFor(() => expect(requestCount).toBe(2));
    const postEditText = `${sourceText.slice(0, first.edit.startOffset)}${
      first.edit.newText
    }${sourceText.slice(first.edit.endOffset)}`;
    source.setText(postEditText);
    fireDocumentChange(source.document, [
      {
        range: new vscodeApi.Range(
          new vscodeApi.Position(5, 0),
          new vscodeApi.Position(5, 0),
        ),
        rangeOffset: first.edit.startOffset,
        rangeLength: first.edit.endOffset - first.edit.startOffset,
        text: first.edit.newText,
      },
    ]);

    const consumer = new vscodeApi.CancellationTokenSource();
    let joinedSettled = false;
    const joined = provider
      .provide(input(source.document, 5, "request-2"), consumer.token, false)
      .then((value) => {
        joinedSettled = true;
        return value;
      });
    await vi.waitFor(() =>
      expect(provider.getState().speculative).toMatchObject({
        pending: false,
        consumed: 1,
      }),
    );
    consumer.cancel();
    await vi.advanceTimersByTimeAsync(0);
    expect(joinedSettled).toBe(false);
    expect(speculativeToken?.isCancellationRequested).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(joinedSettled).toBe(true);
    expect(speculativeToken?.isCancellationRequested).toBe(true);
    expect(await joined).toBeUndefined();

    const fresh = await provider.provide(
      input(source.document, 5, "request-3"),
      cancellationToken(),
      false,
    );
    expect(requestCount).toBe(3);
    expect(fresh).toMatchObject({ speculative: false, fromCache: false });
    releaseSpeculative?.();
    consumer.dispose();
    provider.dispose();
  });

  it("does not reuse matching speculative text when the cursor is outside its request window", async () => {
    const sourceText = Array.from(
      { length: 12 },
      (_value, index) => `const value${index} = ${index};`,
    ).join("\n");
    const source = mutableDocument(sourceText);
    vscodeState.documents.push(source.document);
    let requestCount = 0;
    const model = languageModel(async (_messages, _options, token) => {
      requestCount += 1;
      if (requestCount === 1) {
        return chatResponse(
          (async function* (): AsyncIterable<string> {
            yield "<INSERT>\n + first\n</INSERT>";
          })(),
        );
      }
      if (requestCount === 2) {
        return chatResponse(
          (async function* (): AsyncIterable<string> {
            await new Promise<void>((resolve) =>
              token.onCancellationRequested(resolve),
            );
          })(),
        );
      }
      return chatResponse(
        (async function* (): AsyncIterable<string> {
          yield "<INSERT>\n + fresh\n</INSERT>";
        })(),
      );
    });
    const provider = providerFor(source.document, model, Date.now, {
      nextEdit: { speculativeRequests: "on" },
    });
    const first = await provider.provide(
      input(source.document),
      cancellationToken(),
      false,
    );
    if (!first?.edit) throw new Error("Expected the first edit.");
    provider.handleShown(first, true);
    await vi.waitFor(() =>
      expect(provider.getState().speculative.pending).toBe(true),
    );
    const postEditText = `${sourceText.slice(0, first.edit.startOffset)}${
      first.edit.newText
    }${sourceText.slice(first.edit.endOffset)}`;
    source.setText(postEditText);
    fireDocumentChange(source.document, [
      {
        range: new vscodeApi.Range(
          new vscodeApi.Position(5, 0),
          new vscodeApi.Position(5, 0),
        ),
        rangeOffset: first.edit.startOffset,
        rangeLength: first.edit.endOffset - first.edit.startOffset,
        text: first.edit.newText,
      },
    ]);

    const fresh = await provider.provide(
      input(source.document, 0, "request-2"),
      cancellationToken(),
      false,
    );
    expect(requestCount).toBe(3);
    expect(fresh).toMatchObject({ speculative: false, fromCache: false });
    expect(provider.getState().speculative).toMatchObject({
      pending: true,
      consumed: 0,
    });
    provider.dispose();
  });

  it("applies the configured expanded edit window to speculative prompts", async () => {
    const source = mutableDocument(
      Array.from(
        { length: 60 },
        (_value, index) => `const value${index} = ${index};`,
      ).join("\n"),
    );
    vscodeState.documents.push(source.document);
    const requestTexts: string[] = [];
    let requestCount = 0;
    const model = languageModel(async (messages, _options, token) => {
      requestCount += 1;
      requestTexts.push(messages.map(messageText).join("\n"));
      if (requestCount === 1) {
        return chatResponse(
          (async function* (): AsyncIterable<string> {
            yield "<INSERT>\n + first\n</INSERT>";
          })(),
        );
      }
      return chatResponse(
        (async function* (): AsyncIterable<string> {
          await new Promise<void>((resolve) =>
            token.onCancellationRequested(resolve),
          );
        })(),
      );
    });
    const provider = providerFor(source.document, model, Date.now, {
      nextEdit: {
        speculativeRequests: "on",
        speculativeRequestsAutoExpandEditWindowLines: "always",
        autoExpandEditWindowLines: 40,
      },
    });
    const first = await provider.provide(
      input(source.document),
      cancellationToken(),
      false,
    );
    if (!first) throw new Error("Expected the first suggestion.");
    provider.handleShown(first, true);
    await vi.waitFor(() => expect(requestCount).toBe(2));

    const speculativePrompt = requestTexts[1];
    const editWindow = speculativePrompt.match(
      /<\|code_to_edit\|>\n([\s\S]*?)\n<\|\/code_to_edit\|>/,
    )?.[1];
    expect(editWindow).toContain("const value40 = 40;");
    provider.dispose();
  });

  it("defers speculative trajectory cancellation until the next request", async () => {
    const sourceText = Array.from(
      { length: 12 },
      (_value, index) => `const value${index} = ${index};`,
    ).join("\n");
    const source = mutableDocument(sourceText);
    vscodeState.documents.push(source.document);
    let hasEditHistory = true;
    let requestCount = 0;
    const model = languageModel(async (_messages, _options, token) => {
      requestCount += 1;
      if (requestCount === 1) {
        return chatResponse(
          (async function* (): AsyncIterable<string> {
            yield "<INSERT>\n + first\n</INSERT>";
          })(),
        );
      }
      return chatResponse(
        (async function* (): AsyncIterable<string> {
          await new Promise<void>((resolve) =>
            token.onCancellationRequested(resolve),
          );
        })(),
      );
    });
    const provider = providerFor(source.document, model, Date.now, {
      nextEdit: { speculativeRequests: "on" },
      hasEditHistory: () => hasEditHistory,
    });
    const suggestion = await provider.provide(
      input(source.document),
      cancellationToken(),
      false,
    );
    if (!suggestion?.edit || suggestion.edit.newText.length < 2) {
      throw new Error("Expected an insertion with a trajectory.");
    }
    provider.handleShown(suggestion, true);
    await vi.waitFor(() =>
      expect(provider.getState().speculative.pending).toBe(true),
    );
    const typed = suggestion.edit.newText.slice(0, 1);
    let current = `${sourceText.slice(0, suggestion.edit.startOffset)}${typed}${sourceText.slice(suggestion.edit.endOffset)}`;
    source.setText(current);
    fireDocumentChange(source.document, [
      {
        range: new vscodeApi.Range(
          new vscodeApi.Position(5, 0),
          new vscodeApi.Position(5, 0),
        ),
        rangeOffset: suggestion.edit.startOffset,
        rangeLength: suggestion.edit.endOffset - suggestion.edit.startOffset,
        text: typed,
      },
    ]);
    expect(provider.getState().speculative.pending).toBe(true);
    const divergenceOffset = suggestion.edit.startOffset + typed.length;
    current = `${current.slice(0, divergenceOffset)}X${current.slice(divergenceOffset)}`;
    source.setText(current);
    fireDocumentChange(source.document, [
      {
        range: new vscodeApi.Range(
          new vscodeApi.Position(5, 0),
          new vscodeApi.Position(5, 0),
        ),
        rangeOffset: divergenceOffset,
        rangeLength: 0,
        text: "X",
      },
    ]);
    expect(provider.getState().speculative.pending).toBe(true);
    hasEditHistory = false;
    expect(
      await provider.provide(
        input(source.document, 0, "trajectory-diverged"),
        cancellationToken(),
        false,
      ),
    ).toBeUndefined();
    expect(provider.getState().speculative.pending).toBe(false);
    expect(provider.getState().speculative.lastCancelReason).toBe("superseded");
    provider.dispose();
  });

  it("can speculate again from a positive cached suggestion", async () => {
    const source = mutableDocument(
      Array.from(
        { length: 12 },
        (_value, index) => `const value${index} = ${index};`,
      ).join("\n"),
    );
    vscodeState.documents.push(source.document);
    let requestCount = 0;
    const model = languageModel(async (_messages, _options, token) => {
      requestCount += 1;
      if (requestCount === 1) {
        return chatResponse(
          (async function* (): AsyncIterable<string> {
            yield "<INSERT>\n + cached\n</INSERT>";
          })(),
        );
      }
      return chatResponse(
        (async function* (): AsyncIterable<string> {
          await new Promise<void>((resolve) =>
            token.onCancellationRequested(resolve),
          );
        })(),
      );
    });
    const provider = providerFor(source.document, model, Date.now, {
      nextEdit: { speculativeRequests: "on" },
    });
    const first = await provider.provide(
      input(source.document),
      cancellationToken(),
      false,
    );
    expect(first?.fromCache).toBe(false);
    await vi.waitFor(() => expect(provider.getState().inFlight).toBe(0));
    const cached = await provider.provide(
      input(source.document, 5, "request-2"),
      cancellationToken(),
      false,
    );
    expect(cached?.fromCache).toBe(true);
    if (!cached) throw new Error("Expected a cached suggestion.");
    provider.handleShown(cached, true);
    await vi.waitFor(() => expect(requestCount).toBe(2));
    expect(provider.getState().speculative.pending).toBe(true);
    provider.dispose();
  });

  it("assigns a fresh random request id to every speculative generation", async () => {
    const sourceText = Array.from(
      { length: 12 },
      (_value, index) => `const value${index} = ${index};`,
    ).join("\n");
    const source = mutableDocument(sourceText);
    vscodeState.documents.push(source.document);
    const completionIds: string[] = [];
    let requestCount = 0;
    const model = languageModel(async () => {
      requestCount += 1;
      const value =
        requestCount === 1
          ? "<INSERT>\n + first\n</INSERT>"
          : requestCount === 2
            ? "<INSERT>\n + second\n</INSERT>"
            : "";
      return chatResponse(
        (async function* (): AsyncIterable<string> {
          if (value) yield value;
        })(),
      );
    });
    const provider = providerFor(source.document, model, Date.now, {
      nextEdit: { speculativeRequests: "on" },
      onGatherContextRequest: (request) => {
        if (request.completionId) completionIds.push(request.completionId);
      },
    });
    const first = await provider.provide(
      input(source.document, 5, "speculative-id-origin"),
      cancellationToken(),
      false,
    );
    if (!first?.edit) throw new Error("Expected the first edit.");
    provider.handleShown(first, true);
    await vi.waitFor(() => expect(requestCount).toBe(2));

    const postFirstText = `${sourceText.slice(0, first.edit.startOffset)}${
      first.edit.newText
    }${sourceText.slice(first.edit.endOffset)}`;
    source.setText(postFirstText);
    fireDocumentChange(source.document, [
      {
        range: new vscodeApi.Range(
          new vscodeApi.Position(5, 0),
          new vscodeApi.Position(5, 0),
        ),
        rangeOffset: first.edit.startOffset,
        rangeLength: first.edit.endOffset - first.edit.startOffset,
        text: first.edit.newText,
      },
    ]);
    const second = await provider.provide(
      input(source.document, 5, "speculative-id-consumer"),
      cancellationToken(),
      false,
    );
    if (!second?.edit) throw new Error("Expected the speculative edit.");
    provider.handleShown(second, true);
    await vi.waitFor(() => expect(requestCount).toBe(3));

    const speculativeIds = completionIds.filter((id) => id.startsWith("sp-"));
    expect(speculativeIds).toHaveLength(2);
    expect(new Set(speculativeIds).size).toBe(2);
    expect(speculativeIds.every((id) => /^sp-[0-9a-f-]{36}$/.test(id))).toBe(
      true,
    );
    provider.dispose();
  });

  it.each([
    { cacheCompletesFirst: false, expectedExpanded: false },
    { cacheCompletesFirst: true, expectedExpanded: true },
  ])(
    "uses speculative source identity for smart expansion when cacheCompletesFirst=$cacheCompletesFirst",
    async ({ cacheCompletesFirst, expectedExpanded }) => {
      const sourceText = Array.from(
        { length: 60 },
        (_value, index) => `const value${index} = ${index};`,
      ).join("\n");
      const source = mutableDocument(sourceText);
      vscodeState.documents.push(source.document);
      let releaseSecond: (() => void) | undefined;
      const secondReleased = new Promise<void>((resolve) => {
        releaseSecond = resolve;
      });
      const requestTexts: string[] = [];
      let requestCount = 0;
      const model = languageModel(async (messages, _options, token) => {
        requestCount += 1;
        requestTexts.push(messages.map(messageText).join("\n"));
        if (requestCount === 1) {
          return chatResponse(
            (async function* (): AsyncIterable<string> {
              yield "<INSERT>\n + first\n</INSERT>";
            })(),
          );
        }
        if (requestCount === 2) {
          return chatResponse(
            (async function* (): AsyncIterable<string> {
              await secondReleased;
              yield "<INSERT>\n + second\n</INSERT>";
            })(),
          );
        }
        return chatResponse(
          (async function* (): AsyncIterable<string> {
            await new Promise<void>((resolve) =>
              token.onCancellationRequested(resolve),
            );
          })(),
        );
      });
      const provider = providerFor(source.document, model, Date.now, {
        nextEdit: {
          speculativeRequests: "on",
          speculativeRequestsAutoExpandEditWindowLines: "smart",
          autoExpandEditWindowLines: 40,
        },
      });
      const first = await provider.provide(
        input(source.document, 5, `smart-origin-${cacheCompletesFirst}`),
        cancellationToken(),
        false,
      );
      if (!first?.edit) throw new Error("Expected the first edit.");
      provider.handleShown(first, true);
      await vi.waitFor(() => expect(requestCount).toBe(2));
      const ordinaryFirstWindow = requestTexts[1]?.match(
        /<\|code_to_edit\|>\n([\s\S]*?)\n<\|\/code_to_edit\|>/,
      )?.[1];
      expect(ordinaryFirstWindow).not.toContain("const value40 = 40;");
      const postFirstText = `${sourceText.slice(0, first.edit.startOffset)}${
        first.edit.newText
      }${sourceText.slice(first.edit.endOffset)}`;
      source.setText(postFirstText);

      let second: NesBranchSuggestion | undefined;
      if (cacheCompletesFirst) {
        releaseSecond?.();
        await vi.waitFor(() => expect(provider.getState().cacheSize).toBe(2));
        second = await provider.provide(
          input(source.document, 5, "smart-cache-consumer"),
          cancellationToken(),
          false,
        );
        expect(second).toMatchObject({
          fromCache: true,
          sourceIsSpeculative: true,
        });
        expect(provider.getState().speculative).toMatchObject({
          pending: true,
          consumed: 0,
        });
      } else {
        const pendingSecond = provider.provide(
          input(source.document, 5, "smart-pending-consumer"),
          cancellationToken(),
          false,
        );
        await vi.waitFor(() =>
          expect(provider.getState().speculative.consumed).toBe(1),
        );
        releaseSecond?.();
        second = await pendingSecond;
        expect(second).toMatchObject({
          fromCache: false,
          sourceIsSpeculative: false,
        });
      }
      if (!second?.edit) throw new Error("Expected the second edit.");
      provider.handleShown(second, true);
      await vi.waitFor(() => expect(requestCount).toBe(3));

      const editWindow = requestTexts[2]?.match(
        /<\|code_to_edit\|>\n([\s\S]*?)\n<\|\/code_to_edit\|>/,
      )?.[1];
      expect(editWindow?.includes("const value40 = 40;")).toBe(
        expectedExpanded,
      );
      provider.dispose();
    },
  );

  it("smart-expands speculation from an ordinary subsequent cache edit", async () => {
    const sourceText = Array.from(
      { length: 60 },
      (_value, index) => `const value${index} = ${index};`,
    ).join("\n");
    const source = mutableDocument(sourceText);
    vscodeState.documents.push(source.document);
    const requestTexts: string[] = [];
    let requestCount = 0;
    const model = languageModel(async (messages, _options, token) => {
      requestCount += 1;
      requestTexts.push(messages.map(messageText).join("\n"));
      if (requestCount === 1) {
        return chatResponse(
          (async function* (): AsyncIterable<string> {
            yield unifiedEditWindow(sourceText, {
              5: "const value5 = 500;",
              7: "const value7 = 700;",
            });
          })(),
        );
      }
      return chatResponse(
        (async function* (): AsyncIterable<string> {
          await new Promise<void>((resolve) =>
            token.onCancellationRequested(resolve),
          );
        })(),
      );
    });
    const provider = providerFor(source.document, model, Date.now, {
      nextEdit: {
        speculativeRequests: "on",
        speculativeRequestsAutoExpandEditWindowLines: "smart",
        autoExpandEditWindowLines: 40,
      },
    });
    const first = await provider.provide(
      input(source.document, 5, "smart-subsequent-origin"),
      cancellationToken(),
      false,
    );
    if (!first?.edit) throw new Error("Expected the first edit.");
    await vi.waitFor(() => expect(provider.getState().inFlight).toBe(0));
    const postFirstText = `${sourceText.slice(0, first.edit.startOffset)}${
      first.edit.newText
    }${sourceText.slice(first.edit.endOffset)}`;
    source.setText(postFirstText);
    const subsequent = await provider.provide(
      input(source.document, 7, "smart-subsequent-cache"),
      cancellationToken(),
      false,
    );
    expect(subsequent).toMatchObject({
      fromCache: true,
      subsequent: true,
      sourceIsSpeculative: false,
    });
    if (!subsequent) throw new Error("Expected the subsequent cache edit.");
    provider.handleShown(subsequent, true);
    await vi.waitFor(() => expect(requestCount).toBe(2));

    const editWindow = requestTexts[1]?.match(
      /<\|code_to_edit\|>\n([\s\S]*?)\n<\|\/code_to_edit\|>/,
    )?.[1];
    expect(editWindow).toContain("const value40 = 40;");
    provider.dispose();
  });

  it("does not write a negative cache entry for an empty speculative response", async () => {
    const source = mutableDocument(
      Array.from(
        { length: 12 },
        (_value, index) => `const value${index} = ${index};`,
      ).join("\n"),
    );
    vscodeState.documents.push(source.document);
    let finishSpeculative: (() => void) | undefined;
    const speculativeFinished = new Promise<void>((resolve) => {
      finishSpeculative = resolve;
    });
    let requestCount = 0;
    const model = languageModel(async () => {
      requestCount += 1;
      if (requestCount === 1) {
        return chatResponse(
          (async function* (): AsyncIterable<string> {
            yield "<INSERT>\n + first\n</INSERT>";
          })(),
        );
      }
      return chatResponse(
        (async function* (): AsyncIterable<string> {
          finishSpeculative?.();
        })(),
      );
    });
    const provider = providerFor(source.document, model, Date.now, {
      nextEdit: { speculativeRequests: "on" },
    });
    const suggestion = await provider.provide(
      input(source.document),
      cancellationToken(),
      false,
    );
    if (!suggestion) throw new Error("Expected a suggestion.");
    provider.handleShown(suggestion, true);
    await speculativeFinished;
    expect(requestCount).toBe(2);
    expect(provider.getState().cacheSize).toBe(1);
    provider.dispose();
  });

  it("uses base debounce but skips end-of-line extra debounce for speculative requests", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const source = mutableDocument(
      Array.from(
        { length: 12 },
        (_value, index) => `const value${index} = ${index};`,
      ).join("\n"),
    );
    vscodeState.documents.push(source.document);
    let requestCount = 0;
    const model = languageModel(async () => {
      requestCount += 1;
      return chatResponse(
        requestCount === 1
          ? (async function* (): AsyncIterable<string> {
              yield "<INSERT>\n + first\n</INSERT>";
            })()
          : (async function* (): AsyncIterable<string> {})(),
      );
    });
    const provider = providerFor(source.document, model, Date.now, {
      nextEdit: {
        requestDebounceMs: 100,
        speculativeRequests: "on",
        diagnosticsStartDelayMs: 10_000,
        diagnosticsRaceDeadlineMs: 5_000,
      },
    });
    const request = input(source.document, 5, "speculative-delay");
    const position = new vscodeApi.Position(
      5,
      source.document.lineAt(5).text.length,
    );
    const firstPromise = provider.provide(
      { ...request, position },
      cancellationToken(),
      false,
    );
    await vi.advanceTimersByTimeAsync(2_100);
    const first = await firstPromise;
    if (!first) throw new Error("Expected the first suggestion.");
    expect(requestCount).toBe(1);
    provider.handleShown(first, true);
    await vi.advanceTimersByTimeAsync(99);
    expect(requestCount).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(requestCount).toBe(2);
    provider.dispose();
  });

  it("only cancels speculation for an ignored item that was shown without a superseder", async () => {
    const source = Array.from(
      { length: 12 },
      (_value, index) => `const value${index} = ${index};`,
    ).join("\n");
    const mutable = mutableDocument(source);
    vscodeState.documents.push(mutable.document);
    let requestCount = 0;
    const model = languageModel(async (_messages, _options, requestToken) => {
      requestCount += 1;
      if (requestCount === 1) {
        return chatResponse(
          (async function* (): AsyncIterable<string> {
            yield "<INSERT>\n + first\n</INSERT>";
          })(),
        );
      }
      return chatResponse(
        (async function* (): AsyncIterable<string> {
          await new Promise<void>((resolve) =>
            requestToken.onCancellationRequested(resolve),
          );
        })(),
      );
    });
    const provider = providerFor(mutable.document, model, Date.now, {
      nextEdit: { speculativeRequests: "on" },
    });
    const suggestion = await provider.provide(
      input(mutable.document),
      cancellationToken(),
      false,
    );
    if (!suggestion) {
      throw new Error("Expected a model suggestion.");
    }
    provider.handleShown(suggestion, true);
    await vi.waitFor(() =>
      expect(provider.getState().hasSpeculativeRequest).toBe(true),
    );
    const replacement = {
      ...suggestion,
      requestId: "replacement",
      sourceRequestId: "replacement",
    };
    provider.handleShown(replacement, true);
    const beforeIgnored = provider.getState().userInteraction;
    provider.handleIgnored(suggestion);
    expect(provider.getState().hasSpeculativeRequest).toBe(true);
    expect(provider.getState().userInteraction).toEqual(beforeIgnored);

    provider.handleIgnored(replacement);
    expect(provider.getState().userInteraction).toMatchObject({
      wasLastActionAcceptance: false,
      aggressivenessActions: [expect.objectContaining({ kind: "ignored" })],
    });
    await vi.waitFor(() =>
      expect(provider.getState().hasSpeculativeRequest).toBe(false),
    );
    provider.dispose();
  });
});

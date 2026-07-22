import type * as vscode from "vscode";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({
  documents: [] as vscode.TextDocument[],
  closedDocuments: new Map<string, vscode.TextDocument>(),
  visibleEditors: [] as vscode.TextEditor[],
  notebooks: [] as vscode.NotebookDocument[],
  files: new Map<string, string>(),
  findFilesResults: [] as vscode.Uri[],
  findFilesCalls: [] as Array<{ base: string; pattern: string }>,
  findFilesGate: undefined as Promise<void> | undefined,
  excludes: new Map<string, Record<string, boolean>>(),
  diagnostics: new Map<string, vscode.Diagnostic[]>(),
  openListeners: new Set<(document: vscode.TextDocument) => void>(),
  closeListeners: new Set<(document: vscode.TextDocument) => void>(),
  changeListeners: new Set<(event: vscode.TextDocumentChangeEvent) => void>(),
  configListeners: new Set<(event: vscode.ConfigurationChangeEvent) => void>(),
  activeListeners: new Set<(editor: vscode.TextEditor | undefined) => void>(),
  visibleEditorsListeners: new Set<
    (editors: readonly vscode.TextEditor[]) => void
  >(),
  visibleRangeListeners: new Set<
    (event: vscode.TextEditorVisibleRangesChangeEvent) => void
  >(),
  selectionListeners: new Set<
    (event: vscode.TextEditorSelectionChangeEvent) => void
  >(),
  ignoreCreateListeners: new Set<(uri: vscode.Uri) => void>(),
  ignoreChangeListeners: new Set<(uri: vscode.Uri) => void>(),
  ignoreDeleteListeners: new Set<(uri: vscode.Uri) => void>(),
  commandCalls: [] as string[],
  typescriptActivations: 0,
  tsserverResponse: undefined as unknown,
}));

vi.mock("vscode", () => {
  class Disposable {
    private active = true;
    constructor(private readonly callback: () => void = () => undefined) {}
    dispose(): void {
      if (!this.active) return;
      this.active = false;
      this.callback();
    }
  }

  class EventEmitter<T> {
    private readonly listeners = new Set<(event: T) => void>();
    readonly event = (listener: (event: T) => void) => {
      this.listeners.add(listener);
      return new Disposable(() => this.listeners.delete(listener));
    };
    fire(event: T): void {
      for (const listener of [...this.listeners]) listener(event);
    }
    dispose(): void {
      this.listeners.clear();
    }
  }

  class CancellationTokenSource {
    private readonly listeners = new Set<() => void>();
    private cancelled = false;
    readonly token: vscode.CancellationToken;

    constructor() {
      const owner = this;
      this.token = {
        get isCancellationRequested() {
          return owner.cancelled;
        },
        onCancellationRequested: (listener) => {
          const callback = () => listener(undefined);
          owner.listeners.add(callback);
          return new Disposable(() => owner.listeners.delete(callback));
        },
      };
    }

    cancel(): void {
      if (this.cancelled) return;
      this.cancelled = true;
      for (const listener of [...this.listeners]) listener();
      this.listeners.clear();
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

  class Diagnostic {
    source: string | undefined;
    code: string | number | undefined;
    constructor(
      readonly range: Range,
      readonly message: string,
      readonly severity = 0,
    ) {}
  }

  class Uri {
    static parse(value: string): Uri {
      return new Uri(value);
    }
    static file(path: string): Uri {
      return new Uri(`file://${path}`);
    }
    static joinPath(base: Uri, ...parts: string[]): Uri {
      return new Uri(
        `${base.toString().replace(/\/$/, "")}/${parts.join("/")}`,
      );
    }
    readonly scheme: string;
    readonly authority: string;
    readonly path: string;
    readonly fsPath: string;
    constructor(private readonly value: string) {
      const parsed = new URL(value);
      this.scheme = parsed.protocol.slice(0, -1);
      this.authority = parsed.host;
      this.path = decodeURIComponent(parsed.pathname);
      this.fsPath = this.path;
    }
    toString(): string {
      return this.value;
    }
  }

  class RelativePattern {
    constructor(
      readonly baseUri: Uri,
      readonly pattern: string,
    ) {}
  }

  const subscribe =
    <T>(listeners: Set<(event: T) => void>) =>
    (listener: (event: T) => void) => {
      listeners.add(listener);
      return new Disposable(() => listeners.delete(listener));
    };

  return {
    Disposable,
    EventEmitter,
    CancellationTokenSource,
    Position,
    Range,
    Diagnostic,
    Uri,
    RelativePattern,
    TextDocumentChangeReason: { Undo: 1, Redo: 2 },
    DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
    SymbolKind: { 0: "File", File: 0 },
    workspace: {
      get workspaceFolders() {
        return [{ uri: Uri.file("/workspace"), name: "workspace", index: 0 }];
      },
      get textDocuments() {
        return mock.documents;
      },
      get notebookDocuments() {
        return mock.notebooks;
      },
      onDidOpenTextDocument: subscribe(mock.openListeners),
      onDidCloseTextDocument: subscribe(mock.closeListeners),
      onDidChangeTextDocument: subscribe(mock.changeListeners),
      onDidChangeConfiguration: subscribe(mock.configListeners),
      getWorkspaceFolder: (uri: Uri) => {
        const workspacePath = uri.path.startsWith("/other-workspace")
          ? "/other-workspace"
          : uri.path.startsWith("/workspace")
            ? "/workspace"
            : undefined;
        if (!workspacePath) return undefined;
        const root =
          uri.scheme === "file"
            ? Uri.file(workspacePath)
            : Uri.parse(`${uri.scheme}://${uri.authority}${workspacePath}`);
        return {
          uri: root,
          name: workspacePath.slice(1),
          index: workspacePath === "/workspace" ? 0 : 1,
        };
      },
      getConfiguration: (section: string) => ({
        get: (_key: string, fallback: Record<string, boolean>) =>
          mock.excludes.get(section) ?? fallback,
      }),
      fs: {
        readFile: async (uri: Uri) => {
          const value =
            mock.files.get(uri.toString()) ?? mock.files.get(uri.fsPath);
          if (value === undefined) throw new Error("ENOENT");
          return new TextEncoder().encode(value);
        },
      },
      findFiles: async (pattern: RelativePattern) => {
        mock.findFilesCalls.push({
          base: pattern.baseUri.toString(),
          pattern: pattern.pattern,
        });
        await mock.findFilesGate;
        return mock.findFilesResults;
      },
      openTextDocument: async (uri: Uri) => {
        const document =
          mock.documents.find(
            (candidate) => candidate.uri.toString() === uri.toString(),
          ) ?? mock.closedDocuments.get(uri.toString());
        if (!document) throw new Error("ENOENT");
        return document;
      },
      createFileSystemWatcher: () => ({
        onDidCreate: subscribe(mock.ignoreCreateListeners),
        onDidChange: subscribe(mock.ignoreChangeListeners),
        onDidDelete: subscribe(mock.ignoreDeleteListeners),
        dispose: () => undefined,
      }),
    },
    window: {
      get visibleTextEditors() {
        return mock.visibleEditors;
      },
      onDidChangeActiveTextEditor: subscribe(mock.activeListeners),
      onDidChangeVisibleTextEditors: subscribe(mock.visibleEditorsListeners),
      onDidChangeTextEditorVisibleRanges: subscribe(mock.visibleRangeListeners),
      onDidChangeTextEditorSelection: subscribe(mock.selectionListeners),
    },
    languages: {
      getDiagnostics: (uri?: Uri) =>
        uri
          ? (mock.diagnostics.get(uri.toString()) ?? [])
          : [...mock.diagnostics].map(([value, diagnostics]) => [
              Uri.parse(value),
              diagnostics,
            ]),
      match: (
        selector: vscode.DocumentSelector,
        document: vscode.TextDocument,
      ) => {
        const selectors = Array.isArray(selector) ? selector : [selector];
        return selectors.some((candidate) => {
          if (typeof candidate === "string") {
            return candidate === "*" || candidate === document.languageId;
          }
          return (
            (candidate.language === undefined ||
              candidate.language === document.languageId) &&
            (candidate.scheme === undefined ||
              candidate.scheme === document.uri.scheme)
          );
        })
          ? 10
          : 0;
      },
    },
    commands: {
      executeCommand: async (command: string) => {
        mock.commandCalls.push(command);
        return command === "typescript.tsserverRequest"
          ? mock.tsserverResponse
          : [];
      },
    },
    extensions: {
      getExtension: (id: string) =>
        id === "vscode.typescript-language-features"
          ? {
              activate: async () => {
                mock.typescriptActivations += 1;
                return {};
              },
            }
          : undefined,
    },
  };
});

import * as vscodeApi from "vscode";
import {
  COPILOT_PROMPT_CONTEXT_TIMEOUT_MS,
  CopilotWorkspaceAdapter,
} from "../../src/completion/copilot/workspace";
import {
  COPILOT_BEHAVIOR_CONFIG,
  type CopilotBehaviorConfig,
} from "../../src/chat-lib/core/behavior-config";
import {
  CopilotContextProviderRegistry,
  type CopilotContextProvider,
  type CopilotContextProviderItem,
  type CopilotContextProviderRequest,
  type CopilotContextProviderResolver,
  type CopilotContextProviderTarget,
  type CopilotResolvedContextProviderItem,
} from "../../src/completion/copilot/context-provider";
import { coreContextFromWorkspace } from "../support/copilot-fim";
import {
  createDiagnosticsContextProvider,
  registerDefaultCopilotContextProviders,
} from "../../src/completion/copilot/default-context-providers";

interface MutableDocument {
  readonly document: vscode.TextDocument;
  replace(
    start: number,
    end: number,
    text: string,
  ): vscode.TextDocumentContentChangeEvent;
}

function mutableDocument(
  uriString: string,
  initialText: string,
  languageId = "typescript",
): MutableDocument {
  let text = initialText;
  let version = 1;
  const uri = vscodeApi.Uri.parse(uriString);
  const positionAt = (offset: number): vscode.Position => {
    const lines = text.slice(0, offset).split("\n");
    return new vscodeApi.Position(lines.length - 1, lines.at(-1)?.length ?? 0);
  };
  const offsetAt = (position: vscode.Position): number => {
    const lines = text.split("\n");
    return (
      lines
        .slice(0, position.line)
        .reduce((sum, line) => sum + line.length + 1, 0) + position.character
    );
  };
  const document = {
    uri,
    fileName: uri.fsPath,
    languageId,
    isClosed: false,
    get version() {
      return version;
    },
    getText: () => text,
    offsetAt,
    positionAt,
  } as vscode.TextDocument;
  return {
    document,
    replace(start, end, replacement) {
      const range = new vscodeApi.Range(positionAt(start), positionAt(end));
      text = `${text.slice(0, start)}${replacement}${text.slice(end)}`;
      version += 1;
      return {
        range,
        rangeOffset: start,
        rangeLength: end - start,
        text: replacement,
      };
    },
  };
}

function selection(
  start: vscode.Position,
  end: vscode.Position,
  active = end,
): vscode.Selection {
  return {
    start,
    end,
    anchor: start,
    active,
    isEmpty: start.line === end.line && start.character === end.character,
  } as vscode.Selection;
}

function editor(
  document: vscode.TextDocument,
  selected: vscode.Selection,
  visibleRanges: readonly vscode.Range[],
): vscode.TextEditor {
  return {
    document,
    selection: selected,
    selections: [selected],
    visibleRanges,
    options: { tabSize: 2, indentSize: 2, insertSpaces: true },
    viewColumn: undefined,
    edit: async () => false,
    insertSnippet: async () => false,
    setDecorations: () => undefined,
    revealRange: () => undefined,
    show: () => undefined,
    hide: () => undefined,
  };
}

function token(): vscode.CancellationToken {
  return {
    isCancellationRequested: false,
    onCancellationRequested: () => ({ dispose: () => undefined }),
  };
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolvePromise: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve(value): void {
      if (!resolvePromise) throw new Error("Deferred resolver is missing.");
      resolvePromise(value);
    },
  };
}

function diagnosticsBehavior(
  enabledLanguages: Readonly<Record<string, boolean>>,
): CopilotBehaviorConfig {
  return {
    ...COPILOT_BEHAVIOR_CONFIG,
    diagnosticsContextProvider: {
      enabled: true,
      enabledLanguages,
    },
  };
}

function requiredDiagnosticsProvider(
  behaviorConfig: CopilotBehaviorConfig,
  getDiagnostics?: (uri: vscode.Uri) => readonly vscode.Diagnostic[],
): CopilotContextProvider {
  const provider = createDiagnosticsContextProvider(
    behaviorConfig,
    getDiagnostics,
  );
  if (!provider) throw new Error("Diagnostics provider was not enabled.");
  return provider;
}

function diagnosticsRequest(
  document: vscode.TextDocument,
  position: vscode.Position,
): CopilotContextProviderRequest {
  return {
    completionId: "diagnostics-completion",
    opportunityId: "diagnostics-opportunity",
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
}

function diagnostic(
  startLine: number,
  startCharacter: number,
  endLine: number,
  endCharacter: number,
  message: string,
  severity: vscode.DiagnosticSeverity,
  source?: string,
  code?: string | number,
): vscode.Diagnostic {
  const value = new vscodeApi.Diagnostic(
    new vscodeApi.Range(
      new vscodeApi.Position(startLine, startCharacter),
      new vscodeApi.Position(endLine, endCharacter),
    ),
    message,
    severity,
  );
  value.source = source;
  value.code = code;
  return value;
}

function fire<T>(listeners: Set<(event: T) => void>, event: T): void {
  for (const listener of [...listeners]) listener(event);
}

function documentChangeEvent(
  document: vscode.TextDocument,
  contentChanges: readonly vscode.TextDocumentContentChangeEvent[],
  reason: vscode.TextDocumentChangeReason | undefined = undefined,
): vscode.TextDocumentChangeEvent {
  return { document, contentChanges, reason, detailedReason: undefined };
}

function resolvedItemValue(item: CopilotResolvedContextProviderItem): string {
  if ("value" in item.item) return item.item.value;
  throw new Error(`Context item ${item.item.id} does not contain text.`);
}

function listenerCount(): number {
  return [
    mock.openListeners,
    mock.closeListeners,
    mock.changeListeners,
    mock.configListeners,
    mock.activeListeners,
    mock.visibleEditorsListeners,
    mock.visibleRangeListeners,
    mock.selectionListeners,
    mock.ignoreCreateListeners,
    mock.ignoreChangeListeners,
    mock.ignoreDeleteListeners,
  ].reduce((sum, listeners) => sum + listeners.size, 0);
}

beforeEach(() => {
  mock.documents = [];
  mock.closedDocuments.clear();
  mock.visibleEditors = [];
  mock.notebooks = [];
  mock.files.clear();
  mock.findFilesResults = [];
  mock.findFilesCalls = [];
  mock.findFilesGate = undefined;
  mock.excludes.clear();
  mock.diagnostics.clear();
  mock.openListeners.clear();
  mock.closeListeners.clear();
  mock.changeListeners.clear();
  mock.configListeners.clear();
  mock.activeListeners.clear();
  mock.visibleEditorsListeners.clear();
  mock.visibleRangeListeners.clear();
  mock.selectionListeners.clear();
  mock.ignoreCreateListeners.clear();
  mock.ignoreChangeListeners.clear();
  mock.ignoreDeleteListeners.clear();
  mock.commandCalls = [];
  mock.typescriptActivations = 0;
  mock.tsserverResponse = undefined;
});

afterEach(() => {
  vi.useRealTimers();
});

describe("CopilotWorkspaceAdapter event state", () => {
  it("does not register or enable diagnostics language context in the fixed default treatment", () => {
    const registrations: Array<{
      readonly provider: CopilotContextProvider;
      readonly targets: readonly CopilotContextProviderTarget[];
    }> = [];
    const register = (
      provider: CopilotContextProvider,
      targets: readonly CopilotContextProviderTarget[],
    ): vscode.Disposable => {
      registrations.push({ provider, targets });
      return { dispose: () => undefined };
    };

    const defaults = registerDefaultCopilotContextProviders({ register });

    expect(createDiagnosticsContextProvider()).toBeUndefined();
    expect(registrations.map(({ provider }) => provider.id)).toEqual([
      "typescript-ai-context-provider",
      "scm-context-provider",
    ]);
    defaults.dispose();

    registrations.length = 0;
    const enabled = registerDefaultCopilotContextProviders({
      register,
      behaviorConfig: diagnosticsBehavior({ typescript: true }),
    });
    expect(registrations.at(-1)).toMatchObject({
      provider: {
        id: "diagnostics-context-provider",
        selector: "*",
      },
      targets: ["nes"],
    });
    enabled.dispose();
  });

  it("applies the diagnostics language gate before reading diagnostics", () => {
    const current = mutableDocument(
      "file:///workspace/main.ts",
      "const value = 1;\n",
    );
    const getDiagnostics = vi.fn((): readonly vscode.Diagnostic[] => []);
    const provider = requiredDiagnosticsProvider(
      diagnosticsBehavior({ python: true }),
      getDiagnostics,
    );
    const fallback = provider.resolver.resolveOnTimeout?.(
      diagnosticsRequest(current.document, new vscodeApi.Position(0, 0)),
    );

    expect(fallback).toEqual([]);
    expect(getDiagnostics).not.toHaveBeenCalled();
  });

  it("uses exact whole-range bounds, asymmetric distance, stable order, cap, and trait bytes", () => {
    const current = mutableDocument(
      "file:///workspace/main.ts",
      Array.from({ length: 12 }, (_value, index) => `line ${index}`).join("\n"),
    );
    const values = [
      diagnostic(
        4,
        0,
        4,
        2,
        "stable-left",
        vscodeApi.DiagnosticSeverity.Warning,
        "eslint",
        "W1",
      ),
      diagnostic(
        6,
        3,
        6,
        5,
        "stable-right",
        vscodeApi.DiagnosticSeverity.Information,
      ),
      diagnostic(
        5,
        1,
        5,
        4,
        "closest",
        vscodeApi.DiagnosticSeverity.Error,
        "ts",
        6133,
      ),
      diagnostic(
        2,
        0,
        2,
        1,
        "top-boundary",
        vscodeApi.DiagnosticSeverity.Warning,
      ),
      diagnostic(
        9,
        0,
        9,
        1,
        "bottom-boundary",
        vscodeApi.DiagnosticSeverity.Error,
      ),
      diagnostic(1, 0, 2, 1, "crosses-top", vscodeApi.DiagnosticSeverity.Error),
      diagnostic(
        9,
        0,
        10,
        1,
        "crosses-bottom",
        vscodeApi.DiagnosticSeverity.Error,
      ),
    ];
    const provider = requiredDiagnosticsProvider(
      diagnosticsBehavior({ typescript: true }),
      () => values,
    );
    const fallback = provider.resolver.resolveOnTimeout?.(
      diagnosticsRequest(current.document, new vscodeApi.Position(4, 2)),
    );

    expect(fallback).toEqual([
      {
        name: `Problems near the user's cursor`,
        value:
          "\n\t6:2 - error TS6133: closest" +
          "\n\t5:1 - warning ESLINTW1: stable-left" +
          "\n\t7:4 - warning: stable-right",
      },
    ]);
  });

  it("includes diagnostics ending exactly on both edit-window boundaries", () => {
    const current = mutableDocument(
      "file:///workspace/main.ts",
      Array.from({ length: 12 }, (_value, index) => `line ${index}`).join("\n"),
    );
    const provider = requiredDiagnosticsProvider(
      diagnosticsBehavior({ typescript: true }),
      () => [
        diagnostic(2, 0, 2, 1, "top", vscodeApi.DiagnosticSeverity.Warning),
        diagnostic(9, 0, 9, 1, "bottom", vscodeApi.DiagnosticSeverity.Error),
        diagnostic(1, 0, 2, 1, "above", vscodeApi.DiagnosticSeverity.Error),
        diagnostic(9, 0, 10, 1, "below", vscodeApi.DiagnosticSeverity.Error),
      ],
    );
    const fallback = provider.resolver.resolveOnTimeout?.(
      diagnosticsRequest(current.document, new vscodeApi.Position(4, 0)),
    );

    expect(fallback).toEqual([
      {
        name: `Problems near the user's cursor`,
        value: "\n\t3:1 - warning: top\n\t10:1 - error: bottom",
      },
    ]);
  });

  it("samples diagnostics fallback as soon as the NES primary set settles", async () => {
    const current = mutableDocument(
      "file:///workspace/main.ts",
      Array.from({ length: 8 }, (_value, index) => `line ${index}`).join("\n"),
    );
    const values = [
      diagnostic(4, 0, 4, 1, "stale", vscodeApi.DiagnosticSeverity.Warning),
    ];
    const getDiagnostics = vi.fn(() => values);
    const registry = new CopilotContextProviderRegistry({ timeoutMs: 150 });
    registry.register(
      requiredDiagnosticsProvider(
        diagnosticsBehavior({ typescript: true }),
        getDiagnostics,
      ),
      ["nes"],
    );
    const resolved = await registry.resolve(
      {
        target: "nes",
        document: current.document,
        offset: current.document.offsetAt(new vscodeApi.Position(4, 0)),
      },
      token(),
    );
    expect(resolved).toEqual([
      expect.objectContaining({
        providerId: "diagnostics-context-provider",
        resolution: "full",
        onTimeout: true,
        item: expect.objectContaining({
          name: `Problems near the user's cursor`,
          value: "\n\t5:1 - warning: stale",
        }),
      }),
    ]);
    expect(getDiagnostics).toHaveBeenCalledOnce();
    registry.dispose();
  });

  it("delays diagnostics fallback until the shared deadline when another NES provider is slow", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(500);
    const current = mutableDocument(
      "file:///workspace/main.ts",
      Array.from({ length: 8 }, (_value, index) => `line ${index}`).join("\n"),
    );
    let values = [
      diagnostic(4, 0, 4, 1, "stale", vscodeApi.DiagnosticSeverity.Warning),
    ];
    const getDiagnostics = vi.fn(() => values);
    let slowToken: vscode.CancellationToken | undefined;
    const registry = new CopilotContextProviderRegistry({
      enabledProviderIds: ["slow-nes-context"],
    });
    registry.register(
      requiredDiagnosticsProvider(
        diagnosticsBehavior({ typescript: true }),
        getDiagnostics,
      ),
      ["nes"],
    );
    registry.register(
      {
        id: "slow-nes-context",
        selector: "typescript",
        resolver: {
          resolve: (_request, cancellation) => {
            slowToken = cancellation;
            return new Promise<readonly CopilotContextProviderItem[]>(
              () => undefined,
            );
          },
        },
      },
      ["nes"],
    );
    const pending = registry.resolve(
      {
        target: "nes",
        document: current.document,
        offset: current.document.offsetAt(new vscodeApi.Position(4, 0)),
        timeoutEndMs: 600,
      },
      token(),
    );

    await vi.advanceTimersByTimeAsync(99);
    expect(getDiagnostics).not.toHaveBeenCalled();
    values = [
      diagnostic(
        5,
        2,
        5,
        4,
        "fresh",
        vscodeApi.DiagnosticSeverity.Error,
        "ts",
        1001,
      ),
    ];
    await vi.advanceTimersByTimeAsync(1);
    const resolved = await pending;

    expect(resolved).toHaveLength(1);
    expect(resolved[0]?.item).toMatchObject({
      name: `Problems near the user's cursor`,
      value: "\n\t6:3 - error TS1001: fresh",
    });
    expect(slowToken?.isCancellationRequested).toBe(false);
    registry.dispose();
  });

  it("does not run diagnostics timeout fallback after parent cancellation", async () => {
    const current = mutableDocument(
      "file:///workspace/main.ts",
      "const value = 1;\n",
    );
    const getDiagnostics = vi.fn((): readonly vscode.Diagnostic[] => [
      diagnostic(0, 0, 0, 1, "late", vscodeApi.DiagnosticSeverity.Error),
    ]);
    const registry = new CopilotContextProviderRegistry({ timeoutMs: 150 });
    registry.register(
      requiredDiagnosticsProvider(
        diagnosticsBehavior({ typescript: true }),
        getDiagnostics,
      ),
      ["nes"],
    );
    const source = new vscodeApi.CancellationTokenSource();
    const pending = registry.resolve(
      { target: "nes", document: current.document, offset: 0 },
      source.token,
    );

    source.cancel();

    await expect(pending).resolves.toEqual([]);
    expect(getDiagnostics).not.toHaveBeenCalled();
    source.dispose();
    registry.dispose();
  });

  it("omits relative paths for untitled, notebook, and out-of-workspace documents", () => {
    const untitled = mutableDocument(
      "untitled:/Untitled-1",
      "const untitled = true;\n",
    );
    const notebook = mutableDocument(
      "vscode-notebook-cell:/workspace/book.ipynb#cell-1",
      "const cell = true;\n",
    );
    const outside = mutableDocument(
      "file:///outside/external.ts",
      "const outside = true;\n",
    );
    mock.documents = [untitled.document, notebook.document, outside.document];
    const adapter = new CopilotWorkspaceAdapter(() => 100);

    expect(adapter.snapshot(untitled.document).relativePath).toBeUndefined();
    expect(adapter.snapshot(notebook.document).relativePath).toBeUndefined();
    expect(adapter.snapshot(outside.document).relativePath).toBeUndefined();
    adapter.dispose();
  });

  it("uses the production TypeScript registration path for completion and NES context", async () => {
    const current = mutableDocument(
      "file:///workspace/main.ts",
      "const active = shared;\n",
    );
    const provider = mutableDocument(
      "file:///workspace/provider.ts",
      "export const shared = 1;\n",
    );
    mock.documents = [current.document, provider.document];
    mock.tsserverResponse = {
      type: "response",
      body: {
        runnableResults: [
          {
            priority: 0.8,
            items: [
              { kind: "trait", name: "Target", value: "ES2024" },
              {
                kind: "snippet",
                fileName: "/workspace/provider.ts",
                value: "export const shared = 1;",
              },
            ],
          },
        ],
      },
    };
    const defaults = registerDefaultCopilotContextProviders();
    const adapter = new CopilotWorkspaceAdapter(() => 100);

    const completion = await adapter.gatherContext(
      current.document,
      token(),
      6,
      { target: "completions", completionId: "completion" },
    );
    const nes = await adapter.gatherContext(current.document, token(), 6, {
      target: "nes",
      completionId: "nes",
    });

    expect(mock.typescriptActivations).toBe(1);
    expect(mock.commandCalls).toEqual([
      "typescript.tsserverRequest",
      "typescript.tsserverRequest",
    ]);
    expect(completion.languageContext.items).toMatchObject([
      {
        kind: "trait",
        name: "Target",
        value: "ES2024",
        importance: 80,
      },
      {
        kind: "snippet",
        uri: "file:///workspace/provider.ts",
        path: "provider.ts",
        value: "export const shared = 1;",
        importance: 80,
      },
    ]);
    expect(nes.languageContext.items).toMatchObject([
      {
        kind: "trait",
        name: "Target",
        value: "ES2024",
        importance: 80,
      },
      {
        kind: "snippet",
        uri: "file:///workspace/provider.ts",
        path: "provider.ts",
        value: "export const shared = 1;",
        importance: 80,
      },
      {
        kind: "trait",
        name: "Target",
        value: "ES2024",
        importance: 80,
        onTimeout: true,
      },
      {
        kind: "snippet",
        uri: "file:///workspace/provider.ts",
        path: "provider.ts",
        value: "export const shared = 1;",
        importance: 80,
        onTimeout: true,
      },
    ]);
    expect(coreContextFromWorkspace(completion)).toMatchObject({
      traits: [{ name: "Target", value: "ES2024", importance: 80 }],
      codeSnippets: [
        {
          path: "provider.ts",
          value: "export const shared = 1;",
          importance: 80,
        },
      ],
    });
    adapter.dispose();
    defaults.dispose();
  });

  it("keeps language context empty instead of mapping ordinary document symbols to traits", async () => {
    const current = mutableDocument(
      "file:///workspace/main.ts",
      "function ordinarySymbol() {}\n",
    );
    mock.documents = [current.document];
    const adapter = new CopilotWorkspaceAdapter(() => 100);

    const context = await adapter.gatherContext(current.document, token());

    expect(context.languageContext).toEqual({
      items: [],
      diagnostics: [],
      symbols: [],
    });
    expect(coreContextFromWorkspace(context)).not.toHaveProperty("traits");
    expect(mock.commandCalls).toEqual([]);
    adapter.dispose();
  });

  it("routes registered completion context through selector, schema, and FIM mapping", async () => {
    const current = mutableDocument(
      "file:///workspace/main.ts",
      "const active = shared;\n",
    );
    const snippet = mutableDocument(
      "file:///workspace/provider.ts",
      "export const shared = 1;\n",
    );
    const generated = mutableDocument(
      "file:///workspace/generated.ts",
      "export const generated = true;\n",
    );
    const diagnosticDocument = mutableDocument(
      "file:///workspace/diagnostic.ts",
      "const diagnostic = true;\n",
    );
    mock.documents = [
      current.document,
      snippet.document,
      generated.document,
      diagnosticDocument.document,
    ];
    mock.visibleEditors = [
      editor(
        current.document,
        selection(new vscodeApi.Position(0, 1), new vscodeApi.Position(0, 1)),
        [],
      ),
    ];
    const registry = new CopilotContextProviderRegistry({
      enabledProviderIds: ["completion-context", "nes-only", "python-only"],
    });
    const requestSpy = vi.fn();
    const wrongTargetSpy = vi.fn();
    const wrongSelectorSpy = vi.fn();
    const diagnostic = new vscodeApi.Diagnostic(
      new vscodeApi.Range(
        new vscodeApi.Position(2, 3),
        new vscodeApi.Position(2, 9),
      ),
      "provider diagnostic",
      vscodeApi.DiagnosticSeverity.Warning,
    );
    diagnostic.source = "provider";
    registry.register(
      {
        id: "completion-context",
        selector: [{ language: "typescript", scheme: "file" }],
        resolver: {
          resolve: async (request) => {
            requestSpy(request);
            return [
              { name: "Framework", value: "Vitest", importance: 20 },
              { name: "Framework", value: "Vitest", importance: 20 },
              {
                uri: snippet.document.uri.toString(),
                value: "export const shared = 1;",
                additionalUris: ["file:///workspace/generated.ts"],
                importance: 30,
              },
              {
                uri: vscodeApi.Uri.parse("file:///workspace/diagnostic.ts"),
                values: [diagnostic],
                importance: 10,
              },
            ];
          },
        },
      },
      ["completions"],
    );
    registry.register(
      {
        id: "nes-only",
        selector: "typescript",
        resolver: { resolve: async () => (wrongTargetSpy(), []) },
      },
      ["nes"],
    );
    registry.register(
      {
        id: "python-only",
        selector: "python",
        resolver: { resolve: async () => (wrongSelectorSpy(), []) },
      },
      ["completions"],
    );
    const adapter = new CopilotWorkspaceAdapter(() => 100, registry);

    const context = await adapter.gatherContext(current.document, token(), 6, {
      target: "completions",
      completionId: "completion-id",
      opportunityId: "opportunity-id",
    });
    const fim = coreContextFromWorkspace(context);

    expect(requestSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        completionId: "completion-id",
        opportunityId: "opportunity-id",
        timeBudget: 150,
        documentContext: expect.objectContaining({
          offset: 6,
          languageId: "typescript",
        }),
      }),
    );
    expect(wrongTargetSpy).not.toHaveBeenCalled();
    expect(wrongSelectorSpy).not.toHaveBeenCalled();
    expect(context.languageContext.items).toMatchObject([
      {
        kind: "trait",
        name: "Framework",
        value: "Vitest",
        importance: 20,
      },
      {
        kind: "trait",
        name: "Framework",
        value: "Vitest",
        importance: 20,
      },
      {
        kind: "snippet",
        uri: "file:///workspace/provider.ts",
        path: "provider.ts",
        value: "export const shared = 1;",
        additionalUris: ["file:///workspace/generated.ts"],
        importance: 30,
      },
    ]);
    expect(context.promptDiagnostics).toEqual([
      expect.objectContaining({
        uri: "file:///workspace/diagnostic.ts",
        message: "provider diagnostic",
        startLine: 2,
        startCharacter: 3,
      }),
    ]);
    expect(fim.traits).toMatchObject([
      { name: "Framework", value: "Vitest", importance: 20 },
      { name: "Framework", value: "Vitest", importance: 20 },
    ]);
    expect(fim.codeSnippets).toMatchObject([
      {
        path: "provider.ts",
        value: "export const shared = 1;",
        importance: 30,
      },
    ]);
    expect(fim.diagnostics).toEqual([
      expect.objectContaining({
        path: "diagnostic.ts",
        message: "provider diagnostic",
        line: 2,
        character: 3,
      }),
    ]);
    adapter.dispose();
    registry.dispose();
  });

  it("drops provider snippets when the main or any additional URI is missing or ignored", async () => {
    const current = mutableDocument("file:///workspace/main.ts", "active\n");
    const valid = mutableDocument("file:///workspace/valid.ts", "valid\n");
    const second = mutableDocument("file:///workspace/second.ts", "second\n");
    const ignored = mutableDocument(
      "file:///workspace/ignored.ts",
      "ignored\n",
    );
    const closed = mutableDocument("file:///workspace/closed.ts", "closed\n");
    mock.documents = [
      current.document,
      valid.document,
      second.document,
      ignored.document,
    ];
    mock.closedDocuments.set(closed.document.uri.toString(), closed.document);
    const ignoreUri = vscodeApi.Uri.file("/workspace/.copilotignore");
    mock.findFilesResults = [ignoreUri];
    mock.files.set("/workspace/.copilotignore", "ignored.ts\n");
    const registry = new CopilotContextProviderRegistry({
      enabledProviderIds: ["snippets"],
    });
    registry.register(
      {
        id: "snippets",
        selector: "typescript",
        resolver: {
          resolve: async () => [
            {
              id: "valid-main",
              uri: valid.document.uri.toString(),
              value: "valid-main",
            },
            {
              id: "ignored-main",
              uri: ignored.document.uri.toString(),
              value: "ignored-main",
            },
            {
              id: "ignored-additional",
              uri: valid.document.uri.toString(),
              value: "ignored-additional",
              additionalUris: [ignored.document.uri.toString()],
            },
            {
              id: "missing-additional",
              uri: valid.document.uri.toString(),
              value: "missing-additional",
              additionalUris: ["file:///workspace/missing.ts"],
            },
            {
              id: "all-valid",
              uri: valid.document.uri.toString(),
              value: "all-valid",
              additionalUris: [second.document.uri.toString()],
            },
            {
              id: "closed-valid",
              uri: closed.document.uri.toString(),
              value: "closed-valid",
            },
          ],
        },
      },
      ["completions"],
    );
    const adapter = new CopilotWorkspaceAdapter(() => 100, registry);

    const context = await adapter.gatherContext(
      current.document,
      token(),
      undefined,
      { completionId: "snippet-exclusion" },
    );

    expect(
      context.languageContext.items.map((item) =>
        item.kind === "snippet" ? item.value : item.name,
      ),
    ).toEqual(["valid-main", "all-valid", "closed-valid"]);
    const fim = coreContextFromWorkspace(context);
    fim.contextProviderFeedback?.submit(
      (fim.codeSnippets ?? []).flatMap((snippet) =>
        snippet.contextProviderSource
          ? [
              {
                source: snippet.contextProviderSource,
                expectedTokens: 4,
                actualTokens: 4,
              },
            ]
          : [],
      ),
    );
    expect(
      registry.getUsageStatistics("snippet-exclusion", "snippets"),
    ).toMatchObject({
      resolution: "full",
      usage: "partial",
      usageDetails: [
        { id: "valid-main", usage: "full" },
        { id: "ignored-main", usage: "none_content_excluded" },
        { id: "ignored-additional", usage: "none_content_excluded" },
        { id: "missing-additional", usage: "none_content_excluded" },
        { id: "all-valid", usage: "full" },
        { id: "closed-valid", usage: "full" },
      ],
    });
    adapter.dispose();
    registry.dispose();
  });

  it("cancels context providers at 150ms and accepts only their timeout fallback", async () => {
    vi.useFakeTimers();
    const current = mutableDocument("file:///workspace/main.ts", "value\n");
    const registry = new CopilotContextProviderRegistry({
      enabledProviderIds: ["slow"],
    });
    let providerToken: vscode.CancellationToken | undefined;
    let providerRequestTimeBudget: number | undefined;
    registry.register(
      {
        id: "slow",
        selector: "typescript",
        resolver: {
          resolve: (request, cancellation) => {
            providerToken = cancellation;
            providerRequestTimeBudget = request.timeBudget;
            return new Promise<readonly CopilotContextProviderItem[]>(
              () => undefined,
            );
          },
          resolveOnTimeout: () => ({ name: "Cached", value: "fallback" }),
        },
      },
      ["completions"],
    );

    const pending = registry.resolve(
      {
        target: "completions",
        document: current.document,
        offset: 0,
      },
      token(),
    );
    await vi.advanceTimersByTimeAsync(150);

    await expect(pending).resolves.toEqual([
      expect.objectContaining({
        providerId: "slow",
        item: expect.objectContaining({ name: "Cached", value: "fallback" }),
        onTimeout: true,
      }),
    ]);
    expect(providerRequestTimeBudget).toBe(150);
    expect(providerToken?.isCancellationRequested).toBe(true);
    registry.dispose();
  });

  it("runs every NES fallback immediately after all primary providers settle", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const current = mutableDocument("file:///workspace/main.ts", "value\n");
    const requests: CopilotContextProviderRequest[] = [];
    let providerToken: vscode.CancellationToken | undefined;
    const fallback = vi.fn(() => ({
      id: "fallback",
      name: "Fallback",
      value: "settled",
    }));
    const registry = new CopilotContextProviderRegistry({
      enabledProviderIds: ["nes-settled"],
    });
    registry.register(
      {
        id: "nes-settled",
        selector: "typescript",
        resolver: {
          resolve: async (request, cancellation) => {
            requests.push(request);
            providerToken = cancellation;
            return [{ id: "primary", name: "Primary", value: "settled" }];
          },
          resolveOnTimeout: fallback,
        },
      },
      ["nes"],
    );

    const resolved = await registry.resolve(
      {
        target: "nes",
        document: current.document,
        offset: 0,
        timeoutEndMs: 1_100,
      },
      token(),
    );

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      source: "nes",
      timeBudget: 100,
      timeoutEnd: 1_100,
    });
    expect(providerToken?.isCancellationRequested).toBe(false);
    expect(fallback).toHaveBeenCalledOnce();
    expect(resolved.map(resolvedItemValue)).toEqual(["settled", "settled"]);
    expect(resolved.map((item) => item.onTimeout)).toEqual([false, true]);
    registry.dispose();
  });

  it("freezes NES results at the dynamic deadline without cancelling late providers", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(2_000);
    const current = mutableDocument("file:///workspace/main.ts", "value\n");
    const late = deferred<readonly CopilotContextProviderItem[]>();
    let lateSideEffect = false;
    let providerToken: vscode.CancellationToken | undefined;
    const fallback = vi.fn(() => ({
      id: "fallback",
      name: "Fallback",
      value: "deadline",
    }));
    const registry = new CopilotContextProviderRegistry({
      enabledProviderIds: ["nes-late"],
    });
    registry.register(
      {
        id: "nes-late",
        selector: "typescript",
        resolver: {
          resolve: (_request, cancellation) => {
            providerToken = cancellation;
            return late.promise.then((items) => {
              lateSideEffect = true;
              return items;
            });
          },
          resolveOnTimeout: fallback,
        },
      },
      ["nes"],
    );
    let settled = false;
    const pending = registry.resolve(
      {
        target: "nes",
        document: current.document,
        offset: 0,
        timeoutEndMs: 2_100,
      },
      token(),
    );
    void pending.then(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(99);
    expect(settled).toBe(false);
    expect(fallback).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    const resolved = await pending;

    expect(resolved.map(resolvedItemValue)).toEqual(["deadline"]);
    expect(providerToken?.isCancellationRequested).toBe(false);
    late.resolve([{ id: "late", name: "Late", value: "not-in-snapshot" }]);
    await Promise.resolve();
    await Promise.resolve();
    expect(lateSideEffect).toBe(true);
    expect(resolved.map(resolvedItemValue)).toEqual(["deadline"]);
    registry.dispose();
  });

  it("retains partial NES async items at deadline while the stream continues", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(3_000);
    const current = mutableDocument("file:///workspace/main.ts", "value\n");
    const release = deferred<void>();
    let streamFinished = false;
    const registry = new CopilotContextProviderRegistry({
      enabledProviderIds: ["nes-stream"],
    });
    registry.register(
      {
        id: "nes-stream",
        selector: "typescript",
        resolver: {
          resolve: async function* () {
            yield { id: "first", name: "First", value: "partial" };
            await release.promise;
            streamFinished = true;
            yield { id: "late", name: "Late", value: "after-deadline" };
          },
          resolveOnTimeout: () => ({
            id: "fallback",
            name: "Fallback",
            value: "fallback",
          }),
        },
      },
      ["nes"],
    );
    const pending = registry.resolve(
      {
        target: "nes",
        document: current.document,
        offset: 0,
        timeoutEndMs: 3_100,
      },
      token(),
    );
    await Promise.resolve();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(100);
    const resolved = await pending;

    expect(resolved.map(resolvedItemValue)).toEqual(["partial", "fallback"]);
    release.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(streamFinished).toBe(true);
    expect(resolved.map(resolvedItemValue)).toEqual(["partial", "fallback"]);
    registry.dispose();
  });

  it("does not run NES fallback after parent cancellation", async () => {
    const current = mutableDocument("file:///workspace/main.ts", "value\n");
    let providerToken: vscode.CancellationToken | undefined;
    const fallback = vi.fn(() => ({ name: "Fallback", value: "cancelled" }));
    const registry = new CopilotContextProviderRegistry({
      enabledProviderIds: ["nes-cancelled"],
    });
    registry.register(
      {
        id: "nes-cancelled",
        selector: "typescript",
        resolver: {
          resolve: (_request, cancellation) => {
            providerToken = cancellation;
            return new Promise<readonly CopilotContextProviderItem[]>(
              () => undefined,
            );
          },
          resolveOnTimeout: fallback,
        },
      },
      ["nes"],
    );
    const source = new vscodeApi.CancellationTokenSource();
    const pending = registry.resolve(
      {
        target: "nes",
        document: current.document,
        offset: 0,
        timeoutEndMs: Date.now() + 100,
      },
      source.token,
    );

    source.cancel();

    await expect(pending).resolves.toEqual([]);
    expect(providerToken?.isCancellationRequested).toBe(true);
    expect(fallback).not.toHaveBeenCalled();
    source.dispose();
    registry.dispose();
  });

  it("does not reuse completed NES results for the same completion id", async () => {
    const current = mutableDocument("file:///workspace/main.ts", "value\n");
    let fallbackInvocation = 0;
    const primary = vi.fn(async () => []);
    const registry = new CopilotContextProviderRegistry({
      enabledProviderIds: ["nes-fresh"],
    });
    registry.register(
      {
        id: "nes-fresh",
        selector: "typescript",
        resolver: {
          resolve: primary,
          resolveOnTimeout: () => ({
            id: `fallback-${++fallbackInvocation}`,
            name: "Fallback",
            value: String(fallbackInvocation),
          }),
        },
      },
      ["nes"],
    );
    const input = {
      target: "nes" as const,
      document: current.document,
      offset: 0,
      completionId: "same-completion",
      timeoutEndMs: Date.now() + 100,
    };

    const first = await registry.resolve(input, token());
    const second = await registry.resolve(input, token());

    expect(primary).toHaveBeenCalledTimes(2);
    expect(first.map(resolvedItemValue)).toEqual(["1"]);
    expect(second.map(resolvedItemValue)).toEqual(["2"]);
    registry.dispose();
  });

  it("returns no provider fallback when the outer request is cancelled", async () => {
    const current = mutableDocument("file:///workspace/main.ts", "value\n");
    const registry = new CopilotContextProviderRegistry({
      enabledProviderIds: ["cancelled"],
    });
    const fallback = vi.fn(() => ({ name: "Cached", value: "fallback" }));
    registry.register(
      {
        id: "cancelled",
        selector: "typescript",
        resolver: {
          resolve: () =>
            new Promise<readonly CopilotContextProviderItem[]>(() => undefined),
          resolveOnTimeout: fallback,
        },
      },
      ["completions"],
    );
    const source = new vscodeApi.CancellationTokenSource();
    const pending = registry.resolve(
      {
        target: "completions",
        document: current.document,
        offset: 0,
      },
      source.token,
    );

    source.cancel();

    await expect(pending).resolves.toEqual([]);
    expect(fallback).not.toHaveBeenCalled();
    source.dispose();
    registry.dispose();
  });

  it("activates fixed defaults and explicit IDs without activating registration alone", async () => {
    const current = mutableDocument("file:///workspace/main.ts", "value\n");
    const registeredOnly = vi.fn(async () => [
      { name: "Registered", value: "inactive" },
    ]);
    const explicit = vi.fn(async () => [{ name: "Explicit", value: "active" }]);
    const fixedDefault = vi.fn(async () => [
      { name: "Default", value: "active" },
    ]);
    const registry = new CopilotContextProviderRegistry({
      enabledProviderIds: ["explicit-provider"],
    });
    registry.register(
      {
        id: "registered-only",
        selector: "typescript",
        resolver: { resolve: registeredOnly },
      },
      ["completions"],
    );
    registry.register(
      {
        id: "explicit-provider",
        selector: "typescript",
        resolver: { resolve: explicit },
      },
      ["completions"],
    );
    registry.register(
      {
        id: "scm-context-provider",
        selector: "typescript",
        resolver: { resolve: fixedDefault },
      },
      ["completions"],
    );

    const resolved = await registry.resolve(
      {
        target: "completions",
        document: current.document,
        offset: 0,
        completionId: "activation",
      },
      token(),
    );

    expect(registeredOnly).not.toHaveBeenCalled();
    expect(explicit).toHaveBeenCalledOnce();
    expect(fixedDefault).toHaveBeenCalledOnce();
    expect(resolved.map((item) => item.providerId)).toEqual([
      "explicit-provider",
      "scm-context-provider",
    ]);
    registry.dispose();
  });

  it("starts matched providers in parallel and preserves duplicate items per provider", async () => {
    const current = mutableDocument("file:///workspace/main.ts", "value\n");
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const starts: string[] = [];
    const registry = new CopilotContextProviderRegistry({
      enabledProviderIds: ["first-provider", "second-provider"],
    });
    for (const id of ["first-provider", "second-provider"]) {
      registry.register(
        {
          id,
          selector: "typescript",
          resolver: {
            resolve: async () => {
              starts.push(id);
              await gate;
              return [
                { name: "Duplicate", value: "trait" },
                { uri: "file:///workspace/shared.ts", value: "snippet" },
              ];
            },
          },
        },
        ["completions"],
      );
    }

    const pending = registry.resolve(
      {
        target: "completions",
        document: current.document,
        offset: 0,
        completionId: "parallel",
      },
      token(),
    );
    await Promise.resolve();

    expect(starts).toEqual(["first-provider", "second-provider"]);
    release?.();
    const resolved = await pending;
    expect(resolved.map((item) => item.providerId)).toEqual([
      "first-provider",
      "first-provider",
      "second-provider",
      "second-provider",
    ]);
    expect(resolved.map((item) => item.item)).toMatchObject([
      { name: "Duplicate", value: "trait" },
      { uri: "file:///workspace/shared.ts", value: "snippet" },
      { name: "Duplicate", value: "trait" },
      { uri: "file:///workspace/shared.ts", value: "snippet" },
    ]);
    registry.dispose();
  });

  it("reuses non-empty completion results with a five-entry LRU", async () => {
    const current = mutableDocument("file:///workspace/main.ts", "value\n");
    let invocation = 0;
    const resolve = vi.fn(async () => [
      { name: "Invocation", value: String(++invocation) },
    ]);
    const registry = new CopilotContextProviderRegistry({
      enabledProviderIds: ["cached-provider"],
    });
    registry.register(
      {
        id: "cached-provider",
        selector: "typescript",
        resolver: { resolve },
      },
      ["completions"],
    );
    const resolveCompletion = (completionId: string) =>
      registry.resolve(
        {
          target: "completions",
          document: current.document,
          offset: 0,
          completionId,
        },
        token(),
      );

    const first = await resolveCompletion("a");
    expect(await resolveCompletion("a")).toEqual(first);
    for (const id of ["b", "c", "d", "e", "f"]) {
      await resolveCompletion(id);
    }
    const evicted = await resolveCompletion("a");

    expect(resolve).toHaveBeenCalledTimes(7);
    expect(evicted[0]?.item).toMatchObject({ name: "Invocation", value: "7" });
    registry.dispose();
  });

  it("feeds exact prompt usage into the next provider request and forwards request data and proposed edits", async () => {
    const current = mutableDocument("file:///workspace/main.ts", "value\n");
    const requests: CopilotContextProviderRequest[] = [];
    const registry = new CopilotContextProviderRegistry({
      enabledProviderIds: ["feedback-provider"],
    });
    registry.register(
      {
        id: "feedback-provider",
        selector: "typescript",
        resolver: {
          resolve: async (request) => {
            requests.push(request);
            const value = request.previousUsageStatistics
              ? `adapted:${request.previousUsageStatistics.usage}`
              : "initial";
            return [
              { id: "full-item", name: "Full", value },
              { id: "partial-item", name: "Partial", value: "partial" },
              { id: "none-item", name: "None", value: "none" },
              { id: "excluded-item", name: "Excluded", value: "excluded" },
              { id: "missing-item", name: "Missing", value: "missing" },
            ];
          },
        },
      },
      ["completions", "nes"],
    );
    const first = await registry.resolve(
      {
        target: "completions",
        document: current.document,
        offset: 0,
        completionId: "first-feedback",
      },
      token(),
    );
    const source = (id: string) => {
      const resolved = first.find((item) => item.item.id === id);
      if (!resolved) throw new Error(`Missing resolved context item ${id}.`);
      return resolved.source;
    };
    registry.markContentExcluded("first-feedback", source("excluded-item"));
    registry.submitPromptUsage("first-feedback", [
      {
        source: source("full-item"),
        expectedTokens: 8,
        actualTokens: 8,
      },
      {
        source: source("partial-item"),
        expectedTokens: 8,
        actualTokens: 4,
      },
      {
        source: source("none-item"),
        expectedTokens: 8,
        actualTokens: 0,
      },
    ]);

    expect(
      registry.getUsageStatistics("first-feedback", "feedback-provider"),
    ).toEqual({
      resolution: "full",
      usage: "partial",
      usageDetails: [
        {
          id: "full-item",
          type: "Trait",
          usage: "full",
          expectedTokens: 8,
          actualTokens: 8,
        },
        {
          id: "partial-item",
          type: "Trait",
          usage: "partial",
          expectedTokens: 8,
          actualTokens: 4,
        },
        {
          id: "none-item",
          type: "Trait",
          usage: "none",
          expectedTokens: 8,
          actualTokens: 0,
        },
        {
          id: "excluded-item",
          type: "Trait",
          usage: "none_content_excluded",
        },
        { id: "missing-item", type: "Trait", usage: "error" },
      ],
    });

    await registry.resolve(
      {
        target: "nes",
        document: current.document,
        offset: 0,
        completionId: "nes-feedback",
      },
      token(),
    );
    expect(requests[1]).toMatchObject({
      completionId: "nes-feedback",
      source: "nes",
    });
    expect(requests[1]).not.toHaveProperty("previousUsageStatistics");

    const proposedEdits = [
      {
        range: {
          start: { line: 0, character: 0 },
          end: { line: 0, character: 5 },
        },
        newText: "other",
        positionAfterEdit: { line: 0, character: 5 },
        source: "selectedCompletionInfo" as const,
      },
    ];
    const data = { completionItem: 42 };
    const secondInput = {
      target: "completions" as const,
      document: current.document,
      offset: 0,
      completionId: "second-feedback",
      proposedEdits,
      data,
    };
    const second = await registry.resolve(secondInput, token());

    expect(requests[2]).toMatchObject({
      completionId: "second-feedback",
      previousUsageStatistics: {
        resolution: "full",
        usage: "partial",
      },
      data,
      documentContext: { proposedEdits },
    });
    expect(second[0]?.item).toMatchObject({
      id: "full-item",
      value: "adapted:partial",
    });
    expect(await registry.resolve(secondInput, token())).toEqual(second);
    expect(requests).toHaveLength(3);
    registry.dispose();
  });

  it("keeps a 25-completion usage LRU and does not publish unsubmitted timeout feedback", async () => {
    vi.useFakeTimers();
    const current = mutableDocument("file:///workspace/main.ts", "value\n");
    const requests: CopilotContextProviderRequest[] = [];
    const registry = new CopilotContextProviderRegistry({
      enabledProviderIds: ["statistics-provider"],
    });
    registry.register(
      {
        id: "statistics-provider",
        selector: "typescript",
        resolver: {
          resolve: (request) => {
            requests.push(request);
            if (request.completionId === "timed-out") {
              return new Promise<readonly CopilotContextProviderItem[]>(
                () => undefined,
              );
            }
            return Promise.resolve([
              {
                id: `item-${request.completionId}`,
                name: "Completion",
                value: request.completionId,
              },
            ]);
          },
          resolveOnTimeout: (request) => ({
            id: `item-${request.completionId}`,
            name: "Timeout",
            value: request.completionId,
          }),
        },
      },
      ["completions"],
    );
    const resolveAndSubmit = async (completionId: string): Promise<void> => {
      const [item] = await registry.resolve(
        {
          target: "completions",
          document: current.document,
          offset: 0,
          completionId,
        },
        token(),
      );
      if (!item) throw new Error(`Missing context for ${completionId}.`);
      registry.submitPromptUsage(completionId, [
        { source: item.source, expectedTokens: 3, actualTokens: 3 },
      ]);
    };

    await resolveAndSubmit("completion-0");
    registry.submitPromptUsage("completion-0", []);
    const timedOut = registry.resolve(
      {
        target: "completions",
        document: current.document,
        offset: 0,
        completionId: "timed-out",
      },
      token(),
    );
    await vi.advanceTimersByTimeAsync(150);
    await timedOut;
    await resolveAndSubmit("completion-1");
    expect(requests.at(-1)?.previousUsageStatistics).toMatchObject({
      resolution: "full",
      usage: "full",
    });

    for (let index = 2; index <= 25; index++) {
      await resolveAndSubmit(`completion-${index}`);
    }
    expect(
      registry.getUsageStatistics("completion-0", "statistics-provider"),
    ).toBeUndefined();
    expect(
      registry.getUsageStatistics("completion-1", "statistics-provider"),
    ).toMatchObject({ usage: "full" });
    expect(
      registry.getUsageStatistics("completion-25", "statistics-provider"),
    ).toMatchObject({ usage: "full" });
    registry.dispose();
  });

  it("does not cache empty context results", async () => {
    const current = mutableDocument("file:///workspace/main.ts", "value\n");
    const resolve = vi.fn(async () => []);
    const registry = new CopilotContextProviderRegistry({
      enabledProviderIds: ["empty-provider"],
    });
    registry.register(
      {
        id: "empty-provider",
        selector: "typescript",
        resolver: { resolve },
      },
      ["completions"],
    );
    const input = {
      target: "completions" as const,
      document: current.document,
      offset: 0,
      completionId: "empty",
    };

    await registry.resolve(input, token());
    await registry.resolve(input, token());

    expect(resolve).toHaveBeenCalledTimes(2);
    registry.dispose();
  });

  it("rejects context registrations without a target", () => {
    const registry = new CopilotContextProviderRegistry({
      enabledProviderIds: ["targetless"],
    });

    expect(() =>
      registry.register(
        {
          id: "targetless",
          selector: "typescript",
          resolver: { resolve: async () => [] },
        },
        [],
      ),
    ).toThrow("has no targets");
    registry.dispose();
  });

  it("serializes complete prompt-context requests while providers remain parallel internally", async () => {
    const current = mutableDocument("file:///workspace/main.ts", "value\n");
    mock.documents = [current.document];
    const starts: string[] = [];
    const releases: Array<() => void> = [];
    const resolver: CopilotContextProviderResolver = {
      resolve: (input) => {
        starts.push(input.completionId ?? "missing");
        return new Promise((resolve) => {
          releases.push(() => resolve([]));
        });
      },
    };
    const adapter = new CopilotWorkspaceAdapter(() => 100, resolver);

    const first = adapter.gatherContext(current.document, token(), 0, {
      completionId: "first",
    });
    const second = adapter.gatherContext(current.document, token(), 0, {
      completionId: "second",
    });
    await vi.waitFor(() => expect(starts).toEqual(["first"]));

    releases.shift()?.();
    await first;
    await vi.waitFor(() => expect(starts).toEqual(["first", "second"]));
    releases.shift()?.();
    await second;

    adapter.dispose();
  });

  it("skips the NES registry when language context is disabled", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(4_000);
    const current = mutableDocument("untitled:/main.ts", "value\n");
    mock.documents = [current.document];
    const resolve = vi.fn(async () => []);
    const adapter = new CopilotWorkspaceAdapter(() => Date.now(), { resolve });

    const context = await adapter.gatherContext(current.document, token(), 0, {
      target: "nes",
      timeoutEndMs: 4_100,
      includeLanguageContext: false,
    });

    expect(resolve).not.toHaveBeenCalled();
    expect(context.ignored).toBe(false);
    expect(context.languageContext.items).toEqual([]);
    adapter.dispose();
  });

  it("returns NES base context at deadline without cancelling enrichment", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(5_000);
    const current = mutableDocument("untitled:/main.ts", "value\n");
    const recent = mutableDocument("untitled:/recent.ts", "recent\n");
    mock.documents = [current.document, recent.document];
    let providerToken: vscode.CancellationToken | undefined;
    const resolver: CopilotContextProviderResolver = {
      resolve: (_input, cancellation) => {
        providerToken = cancellation;
        return new Promise(() => undefined);
      },
    };
    const adapter = new CopilotWorkspaceAdapter(() => Date.now(), resolver);
    const change = current.replace(0, 5, "updated");
    fire(
      mock.changeListeners,
      documentChangeEvent(current.document, [change]),
    );
    const pending = adapter.gatherContext(current.document, token(), 0, {
      target: "nes",
      completionId: "nes-base-deadline",
      timeoutEndMs: 5_100,
      includeLanguageContext: true,
    });
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(100);
    const context = await pending;

    expect(context.ignored).toBe(false);
    expect(context.current.text).toBe("updated\n");
    expect(context.editHistory).toHaveLength(1);
    expect(context.editHistory[0]).toMatchObject({
      before: "value\n",
      after: "updated\n",
    });
    expect(context.recentDocuments.map((document) => document.uri)).toContain(
      recent.document.uri.toString(),
    );
    expect(context.languageContext.items).toEqual([]);
    expect(providerToken?.isCancellationRequested).toBe(false);
    adapter.dispose();
  });

  it("merges NES provider fallback at the shared workspace deadline", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(5_500);
    const current = mutableDocument("untitled:/main.ts", "value\n");
    mock.documents = [current.document];
    let providerToken: vscode.CancellationToken | undefined;
    const registry = new CopilotContextProviderRegistry({
      enabledProviderIds: ["workspace-deadline"],
    });
    registry.register(
      {
        id: "workspace-deadline",
        selector: "typescript",
        resolver: {
          resolve: (_request, cancellation) => {
            providerToken = cancellation;
            return new Promise<readonly CopilotContextProviderItem[]>(
              () => undefined,
            );
          },
          resolveOnTimeout: () => ({
            id: "workspace-fallback",
            name: "Workspace fallback",
            value: "at deadline",
          }),
        },
      },
      ["nes"],
    );
    const adapter = new CopilotWorkspaceAdapter(() => Date.now(), registry);
    const pending = adapter.gatherContext(current.document, token(), 0, {
      target: "nes",
      completionId: "workspace-deadline",
      timeoutEndMs: 5_600,
      includeLanguageContext: true,
    });

    await vi.advanceTimersByTimeAsync(100);
    const context = await pending;

    expect(context.ignored).toBe(false);
    expect(context.languageContext.items).toMatchObject([
      {
        kind: "trait",
        name: "Workspace fallback",
        value: "at deadline",
        onTimeout: true,
      },
    ]);
    expect(providerToken?.isCancellationRequested).toBe(false);
    adapter.dispose();
    registry.dispose();
  });

  it("charges serialized NES waiting to the same absolute deadline", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(6_000);
    const current = mutableDocument("untitled:/main.ts", "value\n");
    mock.documents = [current.document];
    const starts: string[] = [];
    const resolver: CopilotContextProviderResolver = {
      resolve: (input) => {
        starts.push(input.completionId ?? "missing");
        return new Promise(() => undefined);
      },
    };
    const adapter = new CopilotWorkspaceAdapter(() => Date.now(), resolver);
    void adapter.gatherContext(current.document, token(), 0, {
      target: "nes",
      completionId: "first-nes",
      timeoutEndMs: 7_000,
    });
    const second = adapter.gatherContext(current.document, token(), 0, {
      target: "nes",
      completionId: "second-nes",
      timeoutEndMs: 6_100,
    });
    await Promise.resolve();

    await vi.advanceTimersByTimeAsync(100);
    const context = await second;

    expect(starts).toEqual(["first-nes"]);
    expect(context.ignored).toBe(false);
    expect(context.current.text).toBe("value\n");
    adapter.dispose();
  });

  it("freezes the full NES base snapshot before waiting for a prior request", async () => {
    const current = mutableDocument(
      "file:///workspace/main.ts",
      'const phase = "base";\n',
    );
    const recent = mutableDocument(
      "file:///workspace/recent.ts",
      'export const related = "captured";\n',
    );
    mock.documents = [current.document, recent.document];
    const firstResolver =
      deferred<readonly CopilotResolvedContextProviderItem[]>();
    let resolverCalls = 0;
    const resolver: CopilotContextProviderResolver = {
      resolve: async () => {
        resolverCalls += 1;
        return resolverCalls === 1 ? await firstResolver.promise : [];
      },
    };
    const adapter = new CopilotWorkspaceAdapter(() => 100, resolver);
    const capturedChange = current.replace(15, 19, "captured");
    fire(
      mock.changeListeners,
      documentChangeEvent(current.document, [capturedChange]),
    );

    const first = adapter.gatherContext(current.document, token(), 0, {
      target: "nes",
      completionId: "freeze-first",
      timeoutEndMs: Date.now() + 10_000,
    });
    await vi.waitFor(() => expect(resolverCalls).toBe(1));
    const second = adapter.gatherContext(current.document, token(), 0, {
      target: "nes",
      completionId: "freeze-second",
      timeoutEndMs: Date.now() + 10_000,
    });

    const lateCurrentChange = current.replace(
      current.document.getText().indexOf("captured"),
      current.document.getText().indexOf("captured") + "captured".length,
      "late",
    );
    fire(
      mock.changeListeners,
      documentChangeEvent(current.document, [lateCurrentChange]),
    );
    const lateRecentChange = recent.replace(
      recent.document.getText().indexOf("captured"),
      recent.document.getText().indexOf("captured") + "captured".length,
      "late-related",
    );
    fire(
      mock.changeListeners,
      documentChangeEvent(recent.document, [lateRecentChange]),
    );
    firstResolver.resolve([]);
    await first;
    const context = await second;

    expect(resolverCalls).toBe(2);
    expect(context.current.text).toBe('const phase = "captured";\n');
    expect(context.recentDocuments).toMatchObject([
      {
        uri: recent.document.uri.toString(),
        text: 'export const related = "captured";\n',
      },
    ]);
    expect(context.editHistory).toHaveLength(1);
    expect(context.editHistory[0]).toMatchObject({
      before: 'const phase = "base";\n',
      after: 'const phase = "captured";\n',
    });
    adapter.dispose();
  });

  it("cancels and drops a prompt-context request at the 1200ms hard timeout", async () => {
    vi.useFakeTimers();
    const current = mutableDocument("file:///workspace/main.ts", "value\n");
    mock.documents = [current.document];
    let providerToken: vscode.CancellationToken | undefined;
    const resolver: CopilotContextProviderResolver = {
      resolve: (_input, cancellation) => {
        providerToken = cancellation;
        return new Promise(() => undefined);
      },
    };
    const adapter = new CopilotWorkspaceAdapter(() => 100, resolver);
    let settled = false;

    const pending = adapter
      .gatherContext(current.document, token(), 0, { completionId: "timeout" })
      .then((context) => {
        settled = true;
        return context;
      });
    await vi.advanceTimersByTimeAsync(COPILOT_PROMPT_CONTEXT_TIMEOUT_MS - 1);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    const context = await pending;
    expect(context.ignored).toBe(true);
    expect(context.languageContext.items).toEqual([]);
    expect(providerToken?.isCancellationRequested).toBe(true);
    adapter.dispose();
  });

  it("propagates parent cancellation to an active prompt-context request", async () => {
    const current = mutableDocument("file:///workspace/main.ts", "value\n");
    mock.documents = [current.document];
    let providerToken: vscode.CancellationToken | undefined;
    const resolver: CopilotContextProviderResolver = {
      resolve: (_input, cancellation) => {
        providerToken = cancellation;
        return new Promise(() => undefined);
      },
    };
    const adapter = new CopilotWorkspaceAdapter(() => 100, resolver);
    const source = new vscodeApi.CancellationTokenSource();
    const pending = adapter.gatherContext(current.document, source.token, 0, {
      completionId: "cancelled-prompt",
    });
    await vi.waitFor(() => expect(providerToken).toBeDefined());

    source.cancel();

    await expect(pending).resolves.toMatchObject({
      ignored: true,
      languageContext: { items: [] },
    });
    expect(providerToken?.isCancellationRequested).toBe(true);
    source.dispose();
    adapter.dispose();
  });

  it("tracks open/focus/selection/visible-range/notebook/close and releases listeners", () => {
    let now = 100;
    const source = mutableDocument(
      "file:///workspace/main.ts",
      "const value = 1;\n",
    );
    const cell = mutableDocument(
      "vscode-notebook-cell:/workspace/book.ipynb#cell-1",
      "value\n",
      "python",
    );
    const sourceEditor = editor(
      source.document,
      selection(new vscodeApi.Position(0, 6), new vscodeApi.Position(0, 11)),
      [
        new vscodeApi.Range(
          new vscodeApi.Position(0, 0),
          new vscodeApi.Position(0, 16),
        ),
      ],
    );
    mock.documents = [source.document];
    mock.visibleEditors = [sourceEditor];
    mock.notebooks = [
      {
        uri: vscodeApi.Uri.parse("file:///workspace/book.ipynb"),
        getCells: () => [{ document: cell.document }],
      } as vscode.NotebookDocument,
    ];
    const adapter = new CopilotWorkspaceAdapter(() => now);
    expect(adapter.getState()).toMatchObject({
      documentCount: 1,
      listenerCount: 12,
    });
    expect(adapter.snapshot(source.document)).toMatchObject({
      selection: { start: 6, end: 11, active: 11 },
      visibleRanges: [{ start: 0, end: 16 }],
    });

    fire(mock.openListeners, cell.document);
    expect(adapter.snapshot(cell.document)).toMatchObject({
      notebookUri: "file:///workspace/book.ipynb",
      workspaceRoot: "/workspace",
    });
    now = 200;
    const cellEditor = editor(
      cell.document,
      selection(new vscodeApi.Position(0, 2), new vscodeApi.Position(0, 2)),
      [
        new vscodeApi.Range(
          new vscodeApi.Position(0, 0),
          new vscodeApi.Position(0, 5),
        ),
      ],
    );
    fire(mock.activeListeners, cellEditor);
    fire(mock.visibleEditorsListeners, [sourceEditor, cellEditor]);
    fire(mock.visibleRangeListeners, {
      textEditor: cellEditor,
      visibleRanges: cellEditor.visibleRanges,
    } as vscode.TextEditorVisibleRangesChangeEvent);
    let selectionEvents = 0;
    adapter.onDidChangeSelection(() => {
      selectionEvents += 1;
    });
    fire(mock.selectionListeners, {
      textEditor: cellEditor,
      selections: cellEditor.selections,
      kind: undefined,
    } as vscode.TextEditorSelectionChangeEvent);
    expect(selectionEvents).toBe(1);
    expect(adapter.snapshot(cell.document)).toMatchObject({
      selection: { active: 2 },
      visibleRanges: [{ start: 0, end: 5 }],
      lastViewedAt: 200,
    });

    let closed: string | undefined;
    adapter.onDidCloseDocument((uri) => {
      closed = uri;
    });
    fire(mock.closeListeners, cell.document);
    expect(closed).toBe(cell.document.uri.toString());
    expect(adapter.getState().documentCount).toBe(1);
    expect(listenerCount()).toBe(11);
    adapter.dispose();
    expect(adapter.getState()).toMatchObject({
      documentCount: 0,
      historyCount: 0,
      listenerCount: 0,
      disposed: true,
    });
    expect(listenerCount()).toBe(0);
    fire(mock.openListeners, cell.document);
    expect(adapter.getState().documentCount).toBe(0);
  });

  it.each([
    { reason: vscodeApi.TextDocumentChangeReason.Undo, expected: "undo" },
    { reason: vscodeApi.TextDocumentChangeReason.Redo, expected: "redo" },
    { reason: undefined, expected: "other" },
  ] as const)(
    "records $expected text-change history",
    async ({ reason, expected }) => {
      let now = 10;
      const mutable = mutableDocument(
        "file:///workspace/main.ts",
        "value = 1;\n",
      );
      mock.documents = [mutable.document];
      const adapter = new CopilotWorkspaceAdapter(() => now);
      const change = mutable.replace(8, 9, "2");
      now = 20;
      let observed: string | undefined;
      adapter.onDidChangeDocument((event) => {
        observed = event.reason;
      });
      fire(
        mock.changeListeners,
        documentChangeEvent(mutable.document, [change], reason),
      );
      const context = await adapter.gatherContext(mutable.document, token());
      expect(observed).toBe(expected);
      expect(context.editHistory[0]).toMatchObject({
        before: "value = 1;\n",
        after: "value = 2;\n",
        reason: expected,
        changes: [{ rangeOffset: 8, rangeLength: 1, text: "2" }],
        timestamp: 20,
      });
      adapter.dispose();
    },
  );

  it("keeps full edit-history contents so the FIM reducer owns the 2MB guard", async () => {
    const prefix = "a".repeat(60_000);
    const suffix = "z".repeat(60_000);
    const mutable = mutableDocument(
      "file:///workspace/large.ts",
      `${prefix}BEFORE${suffix}`,
    );
    mock.documents = [mutable.document];
    const adapter = new CopilotWorkspaceAdapter(() => 100);
    const change = mutable.replace(prefix.length, prefix.length + 6, "AFTER");
    fire(
      mock.changeListeners,
      documentChangeEvent(mutable.document, [change]),
    );

    const context = await adapter.gatherContext(mutable.document, token());

    expect(context.editHistory[0].before).toBe(`${prefix}BEFORE${suffix}`);
    expect(context.editHistory[0].after).toBe(`${prefix}AFTER${suffix}`);
    expect(context.editHistory[0].before.length).toBeGreaterThan(100_000);
    adapter.dispose();
  });

  it("loads ignore rules before filtering recent documents and edit history", async () => {
    const current = mutableDocument("file:///workspace/main.ts", "main\n");
    const ignored = mutableDocument(
      "file:///workspace/ignored.ts",
      "ignored\n",
    );
    const kept = mutableDocument("file:///workspace/keep.ts", "kept\n");
    const secret = mutableDocument(
      "file:///workspace/secret/value.ts",
      "secret\n",
    );
    const excluded = mutableDocument(
      "file:///workspace/excluded.ts",
      "excluded\n",
    );
    mock.documents = [
      current.document,
      ignored.document,
      kept.document,
      secret.document,
      excluded.document,
    ];
    mock.files.set("/workspace/.copilotignore", "ignored.ts\n!keep.ts\n");
    mock.files.set("/workspace/.gitignore", "secret/**\n");
    mock.findFilesResults = [
      vscodeApi.Uri.file("/workspace/.gitignore"),
      vscodeApi.Uri.file("/workspace/.copilotignore"),
    ];
    mock.excludes.set("files", { "excluded.ts": true });
    const adapter = new CopilotWorkspaceAdapter(() => 100);
    const ignoredChange = ignored.replace(0, 7, "changed");
    fire(
      mock.changeListeners,
      documentChangeEvent(ignored.document, [ignoredChange]),
    );

    expect(
      await adapter.isDocumentIgnoredWithRules(ignored.document, token()),
    ).toBe(true);
    expect(
      await adapter.isDocumentIgnoredWithRules(kept.document, token()),
    ).toBe(false);
    expect(
      await adapter.isDocumentIgnoredWithRules(secret.document, token()),
    ).toBe(true);
    expect(
      await adapter.isDocumentIgnoredWithRules(excluded.document, token()),
    ).toBe(true);
    const context = await adapter.gatherContext(current.document, token(), 2);
    expect(
      context.recentDocuments.map((document) => document.relativePath),
    ).toEqual(["keep.ts"]);
    expect(context.editHistory).toEqual([]);
    adapter.dispose();
  });

  it("loads a closed history document workspace root within the NES deadline", async () => {
    const current = mutableDocument("file:///workspace/main.ts", "main\n");
    const ignoredHistory = mutableDocument(
      "file:///other-workspace/ignored.ts",
      "ignored\n",
    );
    mock.documents = [current.document];
    const adapter = new CopilotWorkspaceAdapter(() => 100);

    mock.documents.push(ignoredHistory.document);
    fire(mock.openListeners, ignoredHistory.document);
    await adapter.isDocumentIgnoredWithRules(ignoredHistory.document, token());
    const historyChange = ignoredHistory.replace(0, 7, "changed");
    fire(
      mock.changeListeners,
      documentChangeEvent(ignoredHistory.document, [historyChange]),
    );
    mock.documents = [current.document];
    mock.closedDocuments.set(
      ignoredHistory.document.uri.toString(),
      ignoredHistory.document,
    );
    fire(mock.closeListeners, ignoredHistory.document);

    const otherIgnore = vscodeApi.Uri.file("/other-workspace/.copilotignore");
    mock.findFilesResults = [otherIgnore];
    mock.files.set("/other-workspace/.copilotignore", "ignored.ts\n");
    mock.findFilesCalls = [];
    fire(mock.ignoreChangeListeners, otherIgnore);
    await Promise.resolve();
    expect(mock.findFilesCalls).not.toContainEqual({
      base: "file:///other-workspace",
      pattern: "**/{.gitignore,.copilotignore}",
    });

    const context = await adapter.gatherContext(current.document, token(), 2, {
      target: "nes",
      completionId: "multi-root-ignore",
      opportunityId: "multi-root-ignore",
      timeoutEndMs: Date.now() + 5_000,
      includeLanguageContext: false,
    });

    expect(mock.findFilesCalls).toContainEqual({
      base: "file:///other-workspace",
      pattern: "**/{.gitignore,.copilotignore}",
    });
    expect(context.editHistory).toEqual([]);
    adapter.dispose();
  });

  it("fails closed for an unknown history root until ignore loading settles", async () => {
    const current = mutableDocument("file:///workspace/main.ts", "main\n");
    const ignoredHistory = mutableDocument(
      "file:///other-workspace/ignored.ts",
      "ignored\n",
    );
    const keptHistory = mutableDocument(
      "file:///other-workspace/keep.ts",
      "kept\n",
    );
    mock.documents = [current.document];
    const adapter = new CopilotWorkspaceAdapter(() => 100);
    await adapter.isDocumentIgnoredWithRules(current.document, token());

    const otherIgnore = vscodeApi.Uri.file("/other-workspace/.copilotignore");
    mock.findFilesResults = [otherIgnore];
    mock.files.set("/other-workspace/.copilotignore", "ignored.ts\n");
    const loadGate = deferred<void>();
    mock.findFilesGate = loadGate.promise;
    mock.documents.push(ignoredHistory.document, keptHistory.document);
    fire(mock.openListeners, ignoredHistory.document);
    fire(mock.openListeners, keptHistory.document);
    const ignoredChange = ignoredHistory.replace(0, 7, "changed");
    fire(
      mock.changeListeners,
      documentChangeEvent(ignoredHistory.document, [ignoredChange]),
    );
    const keptChange = keptHistory.replace(0, 4, "updated");
    fire(
      mock.changeListeners,
      documentChangeEvent(keptHistory.document, [keptChange]),
    );
    mock.documents = [current.document];
    for (const historyDocument of [
      ignoredHistory.document,
      keptHistory.document,
    ]) {
      mock.closedDocuments.set(historyDocument.uri.toString(), historyDocument);
      fire(mock.closeListeners, historyDocument);
    }

    const timedOut = await adapter.gatherContext(current.document, token(), 2, {
      target: "nes",
      completionId: "unknown-root-timeout",
      opportunityId: "unknown-root-timeout",
      timeoutEndMs: Date.now() + 10,
      includeLanguageContext: false,
    });
    expect(timedOut.ignored).toBe(false);
    expect(timedOut.editHistory).toEqual([]);

    loadGate.resolve(undefined);
    await adapter.isDocumentIgnoredWithRules(ignoredHistory.document, token());
    const settled = await adapter.gatherContext(current.document, token(), 2, {
      target: "nes",
      completionId: "unknown-root-settled",
      opportunityId: "unknown-root-settled",
      timeoutEndMs: Date.now() + 5_000,
      includeLanguageContext: false,
    });
    expect(settled.editHistory.map((entry) => entry.relativePath)).toEqual([
      "keep.ts",
    ]);
    adapter.dispose();
  });

  it("applies nested ignore scopes, escaped markers, and parent-directory rules", async () => {
    const hash = mutableDocument("file:///workspace/%23hash.ts", "hash\n");
    const bang = mutableDocument("file:///workspace/!bang.ts", "bang\n");
    const nestedKeep = mutableDocument(
      "file:///workspace/nested/keep.ts",
      "keep\n",
    );
    const nestedDrop = mutableDocument(
      "file:///workspace/nested/drop.ts",
      "drop\n",
    );
    const blockedKeep = mutableDocument(
      "file:///workspace/blocked/keep.ts",
      "blocked\n",
    );
    mock.documents = [
      hash.document,
      bang.document,
      nestedKeep.document,
      nestedDrop.document,
      blockedKeep.document,
    ];
    mock.files.set(
      "/workspace/.gitignore",
      "\\#hash.ts\n\\!bang.ts\nnested/\n!nested/\nnested/*.ts\nblocked/\n!blocked/keep.ts\n",
    );
    mock.files.set("/workspace/nested/.gitignore", "!keep.ts\n");
    mock.files.set("/workspace/blocked/.gitignore", "!keep.ts\n");
    mock.findFilesResults = [
      vscodeApi.Uri.file("/workspace/blocked/.gitignore"),
      vscodeApi.Uri.file("/workspace/nested/.gitignore"),
      vscodeApi.Uri.file("/workspace/.gitignore"),
    ];

    const adapter = new CopilotWorkspaceAdapter(() => 100);
    expect(
      await adapter.isDocumentIgnoredWithRules(hash.document, token()),
    ).toBe(true);
    expect(
      await adapter.isDocumentIgnoredWithRules(bang.document, token()),
    ).toBe(true);
    expect(
      await adapter.isDocumentIgnoredWithRules(nestedKeep.document, token()),
    ).toBe(false);
    expect(
      await adapter.isDocumentIgnoredWithRules(nestedDrop.document, token()),
    ).toBe(true);
    expect(
      await adapter.isDocumentIgnoredWithRules(blockedKeep.document, token()),
    ).toBe(true);
    expect(mock.findFilesCalls).toEqual([
      {
        base: "file:///workspace",
        pattern: "**/{.gitignore,.copilotignore}",
      },
    ]);
    adapter.dispose();
  });

  it("invalidates cached ignore scopes when an ignore file changes", async () => {
    const oldIgnored = mutableDocument("file:///workspace/old.ts", "old\n");
    const newIgnored = mutableDocument("file:///workspace/new.ts", "new\n");
    mock.documents = [oldIgnored.document, newIgnored.document];
    const ignoreUri = vscodeApi.Uri.file("/workspace/.gitignore");
    mock.findFilesResults = [ignoreUri];
    mock.files.set("/workspace/.gitignore", "old.ts\n");

    const adapter = new CopilotWorkspaceAdapter(() => 100);
    expect(
      await adapter.isDocumentIgnoredWithRules(oldIgnored.document, token()),
    ).toBe(true);
    expect(
      await adapter.isDocumentIgnoredWithRules(newIgnored.document, token()),
    ).toBe(false);

    mock.files.set("/workspace/.gitignore", "new.ts\n");
    expect(
      await adapter.isDocumentIgnoredWithRules(oldIgnored.document, token()),
    ).toBe(true);
    fire(mock.ignoreChangeListeners, ignoreUri);
    expect(
      await adapter.isDocumentIgnoredWithRules(oldIgnored.document, token()),
    ).toBe(false);
    expect(
      await adapter.isDocumentIgnoredWithRules(newIgnored.document, token()),
    ).toBe(true);
    expect(mock.findFilesCalls).toHaveLength(2);
    adapter.dispose();
  });

  it("fails NES event eligibility closed while ignore rules load and reload", async () => {
    const ignored = mutableDocument(
      "file:///workspace/ignored.ts",
      "ignored\n",
    );
    const kept = mutableDocument("file:///workspace/kept.ts", "kept\n");
    mock.documents = [ignored.document, kept.document];
    const ignoreUri = vscodeApi.Uri.file("/workspace/.copilotignore");
    mock.findFilesResults = [ignoreUri];
    mock.files.set("/workspace/.copilotignore", "ignored.ts\n");
    let finishInitialLoad: (() => void) | undefined;
    mock.findFilesGate = new Promise<void>((resolve) => {
      finishInitialLoad = resolve;
    });

    const adapter = new CopilotWorkspaceAdapter(() => 100);
    expect(adapter.isEligibleForNesTrigger(ignored.document)).toBe(false);
    expect(adapter.isEligibleForNesTrigger(kept.document)).toBe(false);

    finishInitialLoad?.();
    await adapter.isDocumentIgnoredWithRules(ignored.document, token());
    expect(adapter.isEligibleForNesTrigger(ignored.document)).toBe(false);
    expect(adapter.isEligibleForNesTrigger(kept.document)).toBe(true);

    let finishReload: (() => void) | undefined;
    mock.findFilesGate = new Promise<void>((resolve) => {
      finishReload = resolve;
    });
    mock.files.set("/workspace/.copilotignore", "kept.ts\n");
    fire(mock.ignoreChangeListeners, ignoreUri);
    expect(adapter.isEligibleForNesTrigger(ignored.document)).toBe(false);
    expect(adapter.isEligibleForNesTrigger(kept.document)).toBe(false);

    finishReload?.();
    await adapter.isDocumentIgnoredWithRules(kept.document, token());
    expect(adapter.isEligibleForNesTrigger(ignored.document)).toBe(true);
    expect(adapter.isEligibleForNesTrigger(kept.document)).toBe(false);
    expect(mock.findFilesCalls).toHaveLength(2);
    adapter.dispose();
  });

  it("discovers and reads ignore files through remote workspace URIs", async () => {
    const current = mutableDocument(
      "vscode-remote://ssh-remote+host/workspace/main.ts",
      "main\n",
    );
    const ignored = mutableDocument(
      "vscode-remote://ssh-remote+host/workspace/generated.ts",
      "generated\n",
    );
    const ignoreUri = vscodeApi.Uri.parse(
      "vscode-remote://ssh-remote+host/workspace/.copilotignore",
    );
    mock.documents = [current.document, ignored.document];
    mock.findFilesResults = [ignoreUri];
    mock.files.set(ignoreUri.toString(), "generated.ts\n");

    const adapter = new CopilotWorkspaceAdapter(() => 100);
    expect(adapter.getState().documentCount).toBe(2);
    expect(
      await adapter.isDocumentIgnoredWithRules(ignored.document, token()),
    ).toBe(true);
    expect(adapter.snapshot(ignored.document)).toMatchObject({
      relativePath: "generated.ts",
      workspaceRootUri: "vscode-remote://ssh-remote+host/workspace",
    });
    expect(mock.findFilesCalls).toEqual([
      {
        base: "vscode-remote://ssh-remote+host/workspace",
        pattern: "**/{.gitignore,.copilotignore}",
      },
    ]);
    adapter.dispose();
  });
});

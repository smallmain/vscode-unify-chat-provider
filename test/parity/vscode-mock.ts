import type * as vscode from 'vscode';
import { vi } from 'vitest';

export interface MockCodeActionEdit {
  readonly uri: string;
  readonly start: { readonly line: number; readonly character: number };
  readonly end: { readonly line: number; readonly character: number };
  readonly newText: string;
}

export interface VscodeMockState {
  codeAction?: MockCodeActionEdit;
  codeActionTitle: string;
  diagnostics: Array<{
    readonly message: string;
    readonly code: string | number;
    readonly source?: string;
    readonly severity: number;
    readonly start: { readonly line: number; readonly character: number };
    readonly end: { readonly line: number; readonly character: number };
  }>;
  documents: Array<{
    uri: string;
    version: number;
    text: string;
    languageId: string;
    offsetAt(position: {
      readonly line: number;
      readonly character: number;
    }): number;
  }>;
  models: vscode.LanguageModelChat[];
  selectors: vscode.LanguageModelChatSelector[];
  readonly textDocumentChangeListeners: Set<
    (event: vscode.TextDocumentChangeEvent) => void
  >;
  readonly openDocumentListeners: Set<(document: vscode.TextDocument) => void>;
  readonly diagnosticChangeListeners: Set<
    (event: vscode.DiagnosticChangeEvent) => void
  >;
  readonly selectionChangeListeners: Set<
    (event: vscode.TextEditorSelectionChangeEvent) => void
  >;
  readonly activeEditorChangeListeners: Set<
    (editor: vscode.TextEditor | undefined) => void
  >;
  readonly visibleEditorChangeListeners: Set<
    (editors: readonly vscode.TextEditor[]) => void
  >;
  readonly visibleRangeChangeListeners: Set<
    (event: vscode.TextEditorVisibleRangesChangeEvent) => void
  >;
  readonly configurationChangeListeners: Set<
    (event: vscode.ConfigurationChangeEvent) => void
  >;
  readonly closeDocumentListeners: Set<(document: vscode.TextDocument) => void>;
}

export const vscodeMockState: VscodeMockState = {
  codeActionTitle: 'Parity quick fix',
  diagnostics: [],
  documents: [],
  models: [],
  selectors: [],
  textDocumentChangeListeners: new Set(),
  openDocumentListeners: new Set(),
  diagnosticChangeListeners: new Set(),
  selectionChangeListeners: new Set(),
  activeEditorChangeListeners: new Set(),
  visibleEditorChangeListeners: new Set(),
  visibleRangeChangeListeners: new Set(),
  configurationChangeListeners: new Set(),
  closeDocumentListeners: new Set(),
};

vi.mock('vscode', () => {
  class Disposable {
    constructor(private readonly callback: () => void = () => undefined) {}

    dispose(): void {
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
        get isCancellationRequested(): boolean {
          return owner.cancelled;
        },
        onCancellationRequested: (listener, thisArgs, disposables) => {
          const callback = (): void => {
            listener.call(thisArgs, undefined);
          };
          const disposable: vscode.Disposable = {
            dispose: () => owner.listeners.delete(callback),
          };
          if (owner.cancelled) {
            queueMicrotask(callback);
          } else {
            owner.listeners.add(callback);
          }
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

  class Position {
    constructor(
      readonly line: number,
      readonly character: number,
    ) {}
  }

  class Range {
    readonly start: Position;
    readonly end: Position;

    constructor(start: Position, end: Position) {
      this.start = start;
      this.end = end;
    }

    contains(position: Position): boolean {
      return (
        (position.line > this.start.line ||
          (position.line === this.start.line &&
            position.character >= this.start.character)) &&
        (position.line < this.end.line ||
          (position.line === this.end.line &&
            position.character <= this.end.character))
      );
    }

    get isEmpty(): boolean {
      return (
        this.start.line === this.end.line &&
        this.start.character === this.end.character
      );
    }
  }

  class Uri {
    static parse(value: string): Uri {
      return new Uri(value);
    }

    static joinPath(base: Uri, ...parts: string[]): Uri {
      return new Uri(
        new URL(parts.join('/'), `${base.toString()}/`).toString(),
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
      this.path = parsed.pathname;
      this.fsPath = parsed.pathname;
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
      return new Disposable(() => listeners.delete(listener));
    };

  return {
    Disposable,
    EventEmitter,
    CancellationTokenSource,
    Position,
    Range,
    Uri,
    RelativePattern,
    LanguageModelTextPart,
    LanguageModelChatMessage,
    LanguageModelChatMessageRole: { User: 1, Assistant: 2, System: 3 },
    TextDocumentChangeReason: {
      Undo: 1,
      Redo: 2,
    },
    DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
    CodeActionKind: {
      QuickFix: {
        value: 'quickfix',
        contains: (other: unknown) => other === 'quickfix',
      },
    },
    InlineCompletionTriggerKind: { Automatic: 0, Invoke: 1 },
    FileType: { Directory: 2 },
    languages: {
      match: (
        selector: vscode.DocumentSelector,
        document: vscode.TextDocument,
      ) => {
        const selectors = Array.isArray(selector) ? selector : [selector];
        return selectors.some((candidate) =>
          typeof candidate === 'string'
            ? candidate === '*' || candidate === document.languageId
            : (candidate.language === undefined ||
                candidate.language === document.languageId) &&
              (candidate.scheme === undefined ||
                candidate.scheme === document.uri.scheme),
        )
          ? 10
          : 0;
      },
      getDiagnostics: (uri?: Uri) => {
        const diagnostics = vscodeMockState.diagnostics.map((diagnostic) => ({
          message: diagnostic.message,
          code: diagnostic.code,
          source: diagnostic.source,
          severity: diagnostic.severity,
          range: new Range(
            new Position(diagnostic.start.line, diagnostic.start.character),
            new Position(diagnostic.end.line, diagnostic.end.character),
          ),
        }));
        if (uri) return diagnostics;
        const document = vscodeMockState.documents[0];
        return document ? [[new Uri(document.uri), diagnostics]] : [];
      },
      onDidChangeDiagnostics: subscribe(
        vscodeMockState.diagnosticChangeListeners,
      ),
    },
    commands: {
      executeCommand: async () => {
        const configured = vscodeMockState.codeAction;
        if (!configured) {
          return [];
        }
        const uri = new Uri(configured.uri);
        return [
          {
            title: vscodeMockState.codeActionTitle,
            isPreferred: true,
            kind: {
              contains: () => true,
            },
            edit: {
              entries: () => [
                [
                  uri,
                  [
                    {
                      range: new Range(
                        new Position(
                          configured.start.line,
                          configured.start.character,
                        ),
                        new Position(
                          configured.end.line,
                          configured.end.character,
                        ),
                      ),
                      newText: configured.newText,
                    },
                  ],
                ],
              ],
            },
          },
        ];
      },
    },
    lm: {
      selectChatModels: async (selector: vscode.LanguageModelChatSelector) => {
        vscodeMockState.selectors.push(selector);
        return vscodeMockState.models.filter(
          (model) =>
            (selector.vendor === undefined ||
              model.vendor === selector.vendor) &&
            (selector.id === undefined || model.id === selector.id),
        );
      },
    },
    window: {
      activeTextEditor: undefined,
      visibleTextEditors: [],
      onDidChangeActiveTextEditor: subscribe(
        vscodeMockState.activeEditorChangeListeners,
      ),
      onDidChangeTextEditorSelection: subscribe(
        vscodeMockState.selectionChangeListeners,
      ),
      onDidChangeVisibleTextEditors: subscribe(
        vscodeMockState.visibleEditorChangeListeners,
      ),
      onDidChangeTextEditorVisibleRanges: subscribe(
        vscodeMockState.visibleRangeChangeListeners,
      ),
    },
    workspace: {
      workspaceFolders: [],
      notebookDocuments: [],
      fs: { readDirectory: async () => [] },
      onDidOpenTextDocument: subscribe(vscodeMockState.openDocumentListeners),
      onDidChangeTextDocument: subscribe(
        vscodeMockState.textDocumentChangeListeners,
      ),
      onDidCloseTextDocument: subscribe(vscodeMockState.closeDocumentListeners),
      onDidChangeConfiguration: subscribe(
        vscodeMockState.configurationChangeListeners,
      ),
      getWorkspaceFolder: () => undefined,
      getConfiguration: () => ({
        get: <T>(_key: string, fallback: T): T => fallback,
      }),
      findFiles: async () => [],
      createFileSystemWatcher: () => ({
        onDidCreate: () => new Disposable(),
        onDidChange: () => new Disposable(),
        onDidDelete: () => new Disposable(),
        dispose: () => undefined,
      }),
      get textDocuments() {
        return vscodeMockState.documents.map((document) => ({
          uri: new Uri(document.uri),
          fileName: new Uri(document.uri).fsPath,
          isClosed: false,
          version: document.version,
          languageId: document.languageId,
          getText: (range?: Range) =>
            range
              ? document.text.slice(
                  document.offsetAt(range.start),
                  document.offsetAt(range.end),
                )
              : document.text,
          offsetAt: document.offsetAt,
          positionAt: (offset: number) => {
            const lines = document.text.slice(0, offset).split('\n');
            return new Position(
              lines.length - 1,
              lines[lines.length - 1].length,
            );
          },
        }));
      },
      openTextDocument: async (uri: Uri) =>
        vscodeMockState.documents
          .filter((document) => document.uri === uri.toString())
          .map((document) => ({
            uri,
            fileName: uri.fsPath,
            isClosed: false,
            version: document.version,
            languageId: document.languageId,
            getText: (range?: Range) =>
              range
                ? document.text.slice(
                    document.offsetAt(range.start),
                    document.offsetAt(range.end),
                  )
                : document.text,
            offsetAt: document.offsetAt,
            positionAt: (offset: number) => {
              const lines = document.text.slice(0, offset).split('\n');
              return new Position(
                lines.length - 1,
                lines[lines.length - 1].length,
              );
            },
          }))[0],
    },
  };
});

export function resetVscodeMock(): void {
  vscodeMockState.codeAction = undefined;
  vscodeMockState.codeActionTitle = 'Parity quick fix';
  vscodeMockState.diagnostics.length = 0;
  vscodeMockState.documents.length = 0;
  vscodeMockState.models.length = 0;
  vscodeMockState.selectors.length = 0;
  vscodeMockState.textDocumentChangeListeners.clear();
  vscodeMockState.openDocumentListeners.clear();
  vscodeMockState.diagnosticChangeListeners.clear();
  vscodeMockState.selectionChangeListeners.clear();
  vscodeMockState.activeEditorChangeListeners.clear();
  vscodeMockState.visibleEditorChangeListeners.clear();
  vscodeMockState.visibleRangeChangeListeners.clear();
  vscodeMockState.configurationChangeListeners.clear();
  vscodeMockState.closeDocumentListeners.clear();
}

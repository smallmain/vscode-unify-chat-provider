import type * as vscode from 'vscode';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({
  diagnostics: [] as vscode.Diagnostic[],
  actions: [] as vscode.CodeAction[],
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
  commandCalls: 0,
  executeCodeActions: undefined as
    | (() => Promise<vscode.CodeAction[]>)
    | undefined,
}));

vi.mock('vscode', () => {
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
      return (
        (position.line > this.start.line ||
          (position.line === this.start.line &&
            position.character >= this.start.character)) &&
        (position.line < this.end.line ||
          (position.line === this.end.line &&
            position.character <= this.end.character))
      );
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
      return new Uri(new URL(`${parts.join('/')}`, `${base.toString()}/`).toString());
    }

    constructor(private readonly value: string) {}

    toString(): string {
      return this.value;
    }
  }

  class CancellationTokenSource {
    private cancelled = false;
    private readonly listeners = new Set<() => void>();
    readonly token: vscode.CancellationToken;

    constructor() {
      const source = this;
      this.token = {
        get isCancellationRequested() {
          return source.cancelled;
        },
        onCancellationRequested: (listener) => {
          const callback = (): void => {
            listener(undefined);
          };
          source.listeners.add(callback);
          return {
            dispose: (): void => {
              source.listeners.delete(callback);
            },
          };
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
    }

    dispose(): void {
      this.listeners.clear();
    }
  }

  const subscribe = <T>(listeners: Set<(value: T) => void>) =>
    (listener: (value: T) => void) => {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    };

  return {
    Position,
    Range,
    Uri,
    CancellationTokenSource,
    DiagnosticSeverity: {
      Error: 0,
      Warning: 1,
      Information: 2,
      Hint: 3,
    },
    FileType: { Directory: 2 },
    CodeActionKind: {
      QuickFix: {
        value: 'quickfix',
        contains: () => true,
      },
    },
    languages: {
      getDiagnostics: () => mock.diagnostics,
      onDidChangeDiagnostics: subscribe(mock.diagnosticListeners),
    },
    commands: {
      executeCommand: async () => {
        mock.commandCalls += 1;
        return mock.executeCodeActions ? mock.executeCodeActions() : mock.actions;
      },
    },
    window: {
      get activeTextEditor() {
        return mock.activeEditor;
      },
      onDidChangeActiveTextEditor: subscribe(mock.activeEditorListeners),
      onDidChangeTextEditorSelection: subscribe(mock.selectionListeners),
    },
    workspace: {
      get textDocuments() {
        return mock.documents;
      },
      workspaceFolders: [],
      fs: { readDirectory: async () => [] },
      onDidOpenTextDocument: subscribe(mock.openListeners),
      onDidChangeTextDocument: subscribe(mock.changeListeners),
      onDidCloseTextDocument: subscribe(mock.closeListeners),
    },
  };
});

import * as vscodeApi from 'vscode';
import { DiagnosticsNextEditProvider } from '../../src/completion/copilot/diagnostics-provider';
import { COPILOT_BEHAVIOR_CONFIG } from '../../src/chat-lib/core/behavior-config';

interface MutableDocument {
  readonly document: vscode.TextDocument;
  replace(
    startOffset: number,
    endOffset: number,
    replacement: string,
  ): vscode.TextDocumentContentChangeEvent;
}

function token(cancelled = false): vscode.CancellationToken {
  const source = new vscodeApi.CancellationTokenSource();
  if (cancelled) {
    source.cancel();
  }
  return source.token;
}

function mutableDocument(
  initialText: string,
  languageId = 'typescript',
  uriValue = 'file:///workspace/main.ts',
): MutableDocument {
  let text = initialText;
  let version = 1;
  const uri = vscodeApi.Uri.parse(uriValue);
  const offsetAt = (position: vscode.Position): number => {
    const lines = text.split('\n');
    return (
      lines
        .slice(0, position.line)
        .reduce((total, line) => total + line.length + 1, 0) +
      position.character
    );
  };
  const positionAt = (offset: number): vscode.Position => {
    const before = text.slice(0, offset).split('\n');
    return new vscodeApi.Position(
      before.length - 1,
      before[before.length - 1].length,
    );
  };
  const document = {
    uri,
    languageId,
    get version() {
      return version;
    },
    isClosed: false,
    getText: (range?: vscode.Range) =>
      range
        ? text.slice(offsetAt(range.start), offsetAt(range.end))
        : text,
    offsetAt,
    positionAt,
  } as vscode.TextDocument;
  return {
    document,
    replace: (startOffset, endOffset, replacement) => {
      const range = new vscodeApi.Range(
        positionAt(startOffset),
        positionAt(endOffset),
      );
      text = `${text.slice(0, startOffset)}${replacement}${text.slice(endOffset)}`;
      version += 1;
      return {
        range,
        rangeOffset: startOffset,
        rangeLength: endOffset - startOffset,
        text: replacement,
      };
    },
  };
}

function edit(range: vscode.Range, newText: string): vscode.TextEdit {
  return { range, newText };
}

function action(
  title: string,
  document: vscode.TextDocument,
  edits: readonly vscode.TextEdit[],
  diagnostic: vscode.Diagnostic,
): vscode.CodeAction {
  return {
    title,
    isPreferred: true,
    diagnostics: [diagnostic],
    kind: vscodeApi.CodeActionKind.QuickFix,
    edit: {
      entries: () => [[document.uri, [...edits]]],
    },
  } as vscode.CodeAction;
}

function actionWithEntries(
  title: string,
  entries: readonly (readonly [vscode.Uri, readonly vscode.TextEdit[]])[],
  diagnostic: vscode.Diagnostic,
): vscode.CodeAction {
  return {
    title,
    isPreferred: true,
    diagnostics: [diagnostic],
    kind: vscodeApi.CodeActionKind.QuickFix,
    edit: {
      entries: () => entries.map(([uri, edits]) => [uri, [...edits]]),
    },
  } as vscode.CodeAction;
}

function fireChange(
  document: vscode.TextDocument,
  change: vscode.TextDocumentContentChangeEvent,
): void {
  const event: vscode.TextDocumentChangeEvent = {
    document,
    contentChanges: [change],
    reason: undefined,
    detailedReason: undefined,
  };
  for (const listener of [...mock.changeListeners]) {
    listener(event);
  }
}

function fireDiagnostics(document: vscode.TextDocument): void {
  const event = { uris: [document.uri] } as vscode.DiagnosticChangeEvent;
  for (const listener of [...mock.diagnosticListeners]) {
    listener(event);
  }
}

beforeEach(() => {
  mock.diagnostics = [];
  mock.actions = [];
  mock.documents = [];
  mock.activeEditor = undefined;
  mock.executeCodeActions = undefined;
  mock.commandCalls = 0;
  mock.openListeners.clear();
  mock.changeListeners.clear();
  mock.diagnosticListeners.clear();
  mock.selectionListeners.clear();
  mock.activeEditorListeners.clear();
  mock.closeListeners.clear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('DiagnosticsNextEditProvider', () => {
  it('precomputes after 20ms and serves the first request without a warmup call', async () => {
    vi.useFakeTimers();
    const mutable = mutableDocument('const value = missin;\n');
    const target = mutable.document;
    const position = new vscodeApi.Position(0, 14);
    mock.documents = [target];
    mock.activeEditor = {
      document: target,
      selection: { active: position },
    } as vscode.TextEditor;
    const provider = new DiagnosticsNextEditProvider(50);
    fireChange(target, mutable.replace(20, 20, 'g'));
    const range = new vscodeApi.Range(
      new vscodeApi.Position(0, 14),
      new vscodeApi.Position(0, 21),
    );
    const diagnostic = {
      range,
      message: "Cannot find name 'missing'",
      severity: vscodeApi.DiagnosticSeverity.Error,
      code: 2304,
    } as vscode.Diagnostic;
    mock.diagnostics = [diagnostic];
    mock.actions = [
      action(
        "Add import from './missing'",
        target,
        [
          edit(
            new vscodeApi.Range(
              new vscodeApi.Position(0, 0),
              new vscodeApi.Position(0, 0),
            ),
            "import { missing } from './missing';\n",
          ),
        ],
        diagnostic,
      ),
    ];
    fireDiagnostics(target);

    await vi.advanceTimersByTimeAsync(19);
    expect(mock.commandCalls).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(mock.commandCalls).toBe(1);

    let settled = false;
    const firstRequest = provider.provide(target, position, token()).then((value) => {
      settled = true;
      return value;
    });
    await vi.advanceTimersByTimeAsync(49);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    await expect(firstRequest).resolves.toMatchObject({
      source: 'diagnostics',
      kind: 'import',
    });
    expect(mock.commandCalls).toBe(1);
    provider.dispose();
  });

  it('requires a nearby recent edit and uses official import labels and rejection keys', async () => {
    const mutable = mutableDocument('const value = missin;\n');
    const target = mutable.document;
    mock.documents = [target];
    const provider = new DiagnosticsNextEditProvider(0);
    expect(
      await provider.provide(target, new vscodeApi.Position(0, 14), token()),
    ).toBeUndefined();

    fireChange(target, mutable.replace(20, 20, 'g'));
    const diagnosticRange = new vscodeApi.Range(
      new vscodeApi.Position(0, 14),
      new vscodeApi.Position(0, 21),
    );
    const diagnostic = {
      range: diagnosticRange,
      message: "Cannot find name 'missing'",
      severity: vscodeApi.DiagnosticSeverity.Error,
      code: 2304,
    } as vscode.Diagnostic;
    mock.diagnostics = [diagnostic];
    mock.actions = [
      action(
        "Add import from './missing'",
        target,
        [
          edit(
            new vscodeApi.Range(
              new vscodeApi.Position(0, 0),
              new vscodeApi.Position(0, 0),
            ),
            "import { missing } from './missing';\n",
          ),
        ],
        diagnostic,
      ),
    ];
    fireDiagnostics(target);
    const first = await provider.provide(
      target,
      new vscodeApi.Position(0, 14),
      token(),
    );
    expect(first).toMatchObject({
      kind: 'import',
      edit: {
        startOffset: 0,
        endOffset: 0,
        newText: "import { missing } from './missing';\n",
      },
      displayLocation: { label: 'import missing' },
      importName: 'missing',
    });
    if (!first) {
      throw new Error('Expected an import diagnostics suggestion.');
    }

    provider.handleRejected(first);
    expect(
      await provider.provide(target, new vscodeApi.Position(0, 14), token()),
    ).toBeUndefined();
    expect(provider.getState()).toMatchObject({
      rejectedCount: 1,
      lastOutcome: 'rejected',
      trackedDocuments: 1,
    });
    provider.dispose();
  });

  it('suppresses a recently accepted diagnostic for strictly less than one second', async () => {
    const mutable = mutableDocument('const value = missin;\n');
    const target = mutable.document;
    mock.documents = [target];
    let now = 100;
    const provider = new DiagnosticsNextEditProvider(0, () => now);
    fireChange(target, mutable.replace(20, 20, 'g'));
    const range = new vscodeApi.Range(
      new vscodeApi.Position(0, 14),
      new vscodeApi.Position(0, 21),
    );
    const diagnostic = {
      range,
      message: "Cannot find name 'missing'",
      severity: vscodeApi.DiagnosticSeverity.Error,
      code: 2304,
    } as vscode.Diagnostic;
    mock.diagnostics = [diagnostic];
    mock.actions = [
      action(
        "Add import from './missing'",
        target,
        [edit(new vscodeApi.Range(new vscodeApi.Position(0, 0), new vscodeApi.Position(0, 0)), "import { missing } from './missing';\n")],
        diagnostic,
      ),
    ];
    const suggestion = await provider.provide(
      target,
      new vscodeApi.Position(0, 14),
      token(),
    );
    if (!suggestion) {
      throw new Error('Expected an import diagnostics suggestion.');
    }
    provider.handleAccepted(suggestion);
    now += 999;
    expect(
      await provider.provide(target, new vscodeApi.Position(0, 14), token()),
    ).toBeUndefined();
    now += 1;
    expect(
      await provider.provide(target, new vscodeApi.Position(0, 14), token()),
    ).toBeDefined();
    provider.dispose();
  });

  it('classifies async actions precisely and filters actions that touch the user edit', async () => {
    const mutable = mutableDocument('function run() {\n  awai work();\n}\n');
    const target = mutable.document;
    mock.documents = [target];
    const provider = new DiagnosticsNextEditProvider(0);
    fireChange(target, mutable.replace(23, 23, 't'));
    const range = new vscodeApi.Range(
      new vscodeApi.Position(1, 2),
      new vscodeApi.Position(1, 7),
    );
    const diagnostic = {
      range,
      message: 'await is only valid in async functions',
      severity: vscodeApi.DiagnosticSeverity.Error,
      code: 1308,
    } as vscode.Diagnostic;
    mock.diagnostics = [diagnostic];
    mock.actions = [
      action(
        'Use an unrelated quick fix',
        target,
        [edit(new vscodeApi.Range(new vscodeApi.Position(0, 0), new vscodeApi.Position(0, 0)), 'async ')],
        diagnostic,
      ),
    ];
    expect(
      await provider.provide(target, new vscodeApi.Position(1, 2), token()),
    ).toBeUndefined();

    mock.actions = [
      action(
        'Add async modifier',
        target,
        [edit(new vscodeApi.Range(new vscodeApi.Position(0, 0), new vscodeApi.Position(0, 0)), 'async ')],
        diagnostic,
      ),
    ];
    fireDiagnostics(target);
    expect(
      await provider.provide(target, new vscodeApi.Position(1, 2), token()),
    ).toMatchObject({ kind: 'async' });

    mock.actions = [
      action(
        'Add async modifier',
        target,
        [edit(range, 'await')],
        diagnostic,
      ),
    ];
    fireDiagnostics(target);
    expect(
      await provider.provide(target, new vscodeApi.Position(1, 2), token()),
    ).toBeUndefined();
    provider.dispose();
  });

  it('invalidates in-flight code actions when the document mutates', async () => {
    const mutable = mutableDocument('const value = missin;\n');
    const target = mutable.document;
    mock.documents = [target];
    const provider = new DiagnosticsNextEditProvider(0);
    fireChange(target, mutable.replace(20, 20, 'g'));
    const range = new vscodeApi.Range(
      new vscodeApi.Position(0, 14),
      new vscodeApi.Position(0, 21),
    );
    const diagnostic = {
      range,
      message: "Cannot find name 'missing'",
      severity: vscodeApi.DiagnosticSeverity.Error,
      code: 2304,
    } as vscode.Diagnostic;
    mock.diagnostics = [diagnostic];
    let release: ((actions: vscode.CodeAction[]) => void) | undefined;
    mock.executeCodeActions = () =>
      new Promise<vscode.CodeAction[]>((resolve) => {
        release = resolve;
      });
    const result = provider.provide(
      target,
      new vscodeApi.Position(0, 14),
      token(),
    );
    await vi.waitFor(() =>
      expect(provider.getState().workInProgress).toBe(true),
    );
    fireChange(target, mutable.replace(target.getText().length, target.getText().length, '// changed'));
    release?.([
      action(
        "Add import from './missing'",
        target,
        [edit(new vscodeApi.Range(new vscodeApi.Position(0, 0), new vscodeApi.Position(0, 0)), "import { missing } from './missing';\n")],
        diagnostic,
      ),
    ]);
    expect(await result).toBeUndefined();
    provider.dispose();
  });

  it('honors cancellation and disposal', async () => {
    const mutable = mutableDocument('const value = missing;\n');
    mock.documents = [mutable.document];
    const provider = new DiagnosticsNextEditProvider(0);
    expect(
      await provider.provide(
        mutable.document,
        new vscodeApi.Position(0, 0),
        token(true),
      ),
    ).toBeUndefined();
    provider.dispose();
    expect(provider.getState().disposed).toBe(true);
    expect(
      await provider.provide(
        mutable.document,
        new vscodeApi.Position(0, 0),
        token(),
      ),
    ).toBeUndefined();
  });

  it('keeps Java diagnostics behind the fixed prerelease gate', async () => {
    expect(COPILOT_BEHAVIOR_CONFIG.nextEdit.javaImportDiagnostics).toBe(false);
    const mutable = mutableDocument('Widge value;\n', 'java');
    const target = mutable.document;
    mock.documents = [target];
    const provider = new DiagnosticsNextEditProvider(0);
    fireChange(target, mutable.replace(5, 5, 't'));
    const range = new vscodeApi.Range(
      new vscodeApi.Position(0, 0),
      new vscodeApi.Position(0, 6),
    );
    const diagnostic = {
      range,
      message: 'Widget cannot be resolved to a type',
      severity: vscodeApi.DiagnosticSeverity.Error,
      code: 16777218,
    } as vscode.Diagnostic;
    mock.diagnostics = [diagnostic];
    mock.actions = [
      action(
        "Import 'example.Widget'",
        target,
        [edit(new vscodeApi.Range(new vscodeApi.Position(0, 0), new vscodeApi.Position(0, 0)), 'import example.Widget;\n')],
        diagnostic,
      ),
    ];

    expect(
      await provider.provide(target, new vscodeApi.Position(0, 0), token()),
    ).toBeUndefined();
    provider.dispose();
  });

  it('ignores edits in another notebook cell under the fixed standard format', async () => {
    expect(
      COPILOT_BEHAVIOR_CONFIG.nextEdit.useAlternativeNotebookFormat,
    ).toBe(false);
    const mutable = mutableDocument(
      'const value = missin;\n',
      'typescript',
      'vscode-notebook-cell:///workspace/book.ipynb#cell-1',
    );
    const target = mutable.document;
    const other = mutableDocument(
      'export const missing = 1;\n',
      'typescript',
      'vscode-notebook-cell:///workspace/book.ipynb#cell-2',
    ).document;
    mock.documents = [target, other];
    const provider = new DiagnosticsNextEditProvider(0);
    fireChange(target, mutable.replace(20, 20, 'g'));
    const range = new vscodeApi.Range(
      new vscodeApi.Position(0, 14),
      new vscodeApi.Position(0, 21),
    );
    const diagnostic = {
      range,
      message: "Cannot find name 'missing'",
      severity: vscodeApi.DiagnosticSeverity.Error,
      code: 2304,
    } as vscode.Diagnostic;
    mock.diagnostics = [diagnostic];
    mock.actions = [
      actionWithEntries(
        "Add import from './missing'",
        [[other.uri, [edit(new vscodeApi.Range(new vscodeApi.Position(0, 0), new vscodeApi.Position(0, 0)), 'export const value = missing;\n')]]],
        diagnostic,
      ),
    ];

    expect(
      await provider.provide(target, new vscodeApi.Position(0, 14), token()),
    ).toBeUndefined();
    provider.dispose();
  });

  it('matches the fixed empty tsconfigPaths treatment for alias imports', async () => {
    const mutable = mutableDocument('const value = missin;\n');
    const target = mutable.document;
    mock.documents = [target];
    const provider = new DiagnosticsNextEditProvider(0);
    fireChange(target, mutable.replace(20, 20, 'g'));
    const range = new vscodeApi.Range(
      new vscodeApi.Position(0, 14),
      new vscodeApi.Position(0, 21),
    );
    const diagnostic = {
      range,
      message: "Cannot find name 'missing'",
      severity: vscodeApi.DiagnosticSeverity.Error,
      code: 2304,
    } as vscode.Diagnostic;
    mock.diagnostics = [diagnostic];
    const insertionRange = new vscodeApi.Range(
      new vscodeApi.Position(0, 0),
      new vscodeApi.Position(0, 0),
    );
    mock.actions = [
      action(
        "Add import from '@app/missing'",
        target,
        [edit(insertionRange, "import { missing } from '@app/missing';\n")],
        diagnostic,
      ),
      action(
        "Add import from './missing'",
        target,
        [edit(insertionRange, "import { missing } from './missing';\n")],
        diagnostic,
      ),
    ];

    await expect(
      provider.provide(target, new vscodeApi.Position(0, 14), token()),
    ).resolves.toMatchObject({
      edit: { newText: "import { missing } from './missing';\n" },
    });
    provider.dispose();
  });
});

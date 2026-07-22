import { afterEach, describe, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({
  documentChangeListeners: new Set<(event: unknown) => void>(),
  activeDocument: undefined as unknown,
  diagnostics: [] as unknown[],
}));

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
  class Selection extends Range {}
  class Uri {
    readonly scheme: string;
    readonly authority: string;
    readonly path: string;
    readonly fsPath: string;
    constructor(private readonly value: string) {
      const parsed = new URL(value);
      this.scheme = parsed.protocol.slice(0, -1);
      this.authority = parsed.host;
      this.path = parsed.pathname;
      this.fsPath = decodeURIComponent(parsed.pathname);
    }
    static parse(value: string): Uri {
      return new Uri(value);
    }
    toString(): string {
      return this.value;
    }
  }
  class InlineCompletionItem {
    isInlineEdit?: boolean;
    uri?: Uri;
    jumpToPosition?: Position;
    constructor(
      readonly insertText: string,
      readonly range: Range,
    ) {}
  }
  const workspaceUri = new Uri('file:///workspace');
  return {
    Disposable,
    EventEmitter,
    Position,
    Range,
    Selection,
    Uri,
    InlineCompletionItem,
    InlineCompletionTriggerKind: { Automatic: 0, Invoke: 1 },
    InlineCompletionEndOfLifeReasonKind: {
      Accepted: 0,
      Rejected: 1,
      Ignored: 2,
    },
    commands: { executeCommand: async () => undefined },
    languages: { getDiagnostics: () => mock.diagnostics },
    window: {
      get activeTextEditor() {
        return mock.activeDocument
          ? { document: mock.activeDocument }
          : undefined;
      },
      showTextDocument: async (document: unknown) => ({
        document,
        selection: undefined,
      }),
    },
    workspace: {
      textDocuments: [],
      getWorkspaceFolder: (uri: Uri) =>
        uri.toString().startsWith('file:///workspace/')
          ? { uri: workspaceUri }
          : undefined,
      asRelativePath: (uri: Uri) =>
        uri.toString().replace('file:///workspace/', ''),
      openTextDocument: async () => mock.activeDocument,
      onDidChangeTextDocument: (listener: (event: unknown) => void) => {
        mock.documentChangeListeners.add(listener);
        return new Disposable(() => mock.documentChangeListeners.delete(listener));
      },
    },
    l10n: { t: (message: string) => message },
  };
});

import * as vscode from 'vscode';
import {
  EditPredictionAlgorithm,
  editRuntimeTesting,
} from '../../src/completion/edit/runtime';
import {
  clearZedFeedbackForTests,
  trackZedPrediction,
} from '../../src/completion/zed/feedback';
import { ZedEditPredictionLifecycle } from '../../src/completion/zed/lifecycle';
import type {
  CompletionAlgorithmContext,
  CompletionAlgorithmInput,
  CompletionModel,
} from '../../src/completion/types';
import type {
  AlgorithmRequest,
  CopilotReplicaAlgorithmCursorPredictionRequest,
  CopilotReplicaAlgorithmFimRequest,
  CopilotReplicaAlgorithmNesRequest,
  InceptionAlgorithmRequest,
  MistralAlgorithmRequest,
  SimpleAlgorithmRequest,
  ZedAlgorithmRequest,
} from '../../src/completion/model/requests';
import type {
  AlgorithmResponse,
  CopilotReplicaAlgorithmCursorPredictionResponse,
  CopilotReplicaAlgorithmFimResponse,
  CopilotReplicaAlgorithmNesResponse,
  InceptionAlgorithmResponse,
  MistralAlgorithmResponse,
  SimpleAlgorithmResponse,
  ZedAlgorithmResponse,
} from '../../src/completion/model/responses';

function mutableDocument(initial: string) {
  let text = initial;
  let version = 1;
  const uri = vscode.Uri.parse('file:///workspace/main.ts');
  const positionAt = (offset: number): vscode.Position => {
    const bounded = Math.max(0, Math.min(text.length, offset));
    const prefix = text.slice(0, bounded);
    const line = prefix.split('\n').length - 1;
    const lastNewline = prefix.lastIndexOf('\n');
    return new vscode.Position(line, bounded - lastNewline - 1);
  };
  const document = {
    uri,
    languageId: 'typescript',
    get version() {
      return version;
    },
    get lineCount() {
      return text.split('\n').length;
    },
    getText: () => text,
    positionAt,
    offsetAt: (position: vscode.Position) => {
      const lines = text.split('\n');
      let offset = 0;
      for (let line = 0; line < position.line; line += 1) {
        offset += (lines[line]?.length ?? 0) + 1;
      }
      return Math.min(text.length, offset + position.character);
    },
    lineAt: (line: number) => {
      const lines = text.split('\n');
      const lineStart = lines
        .slice(0, line)
        .reduce((total, value) => total + value.length + 1, 0);
      const value = lines[line] ?? '';
      return {
        text: value,
        range: new vscode.Range(
          positionAt(lineStart),
          positionAt(lineStart + value.length),
        ),
      };
    },
  } as vscode.TextDocument;
  return {
    document,
    update(next: string): void {
      text = next;
      version += 1;
    },
  };
}

function token(): vscode.CancellationToken {
  return {
    isCancellationRequested: false,
    onCancellationRequested: () => ({ dispose: () => undefined }),
  };
}

class ZedOnlyCompletionModel implements CompletionModel {
  constructor(private readonly response: ZedAlgorithmResponse) {}

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
    _token: vscode.CancellationToken,
  ): Promise<AlgorithmResponse> {
    if (request.kind !== 'zed') {
      throw new Error(`Unexpected request kind: ${request.kind}`);
    }
    return this.response;
  }
}

afterEach(() => {
  vi.restoreAllMocks();
  clearZedFeedbackForTests();
  mock.documentChangeListeners.clear();
  mock.activeDocument = undefined;
  mock.diagnostics = [];
});

describe('EditPredictionAlgorithm feedback ownership', () => {
  it('collects only nearby diagnostics and keeps diagnostic row metadata', () => {
    const text = `${Array.from({ length: 50 }, (_, index) => `line ${index}`).join('\n')}\n`;
    const mutable = mutableDocument(text);
    const diagnostic = (
      line: number,
      severity: number,
      message: string,
    ) => ({
      severity,
      message,
      range: new vscode.Range(
        new vscode.Position(line, 0),
        new vscode.Position(line, 4),
      ),
    });
    mock.diagnostics = [
      diagnostic(24, 0, 'near error'),
      diagnostic(0, 1, 'far warning'),
    ];

    const values = editRuntimeTesting.diagnosticsFor(
      mutable.document,
      mutable.document.offsetAt(new vscode.Position(25, 0)),
      [],
    );
    expect(values).toHaveLength(1);
    expect(values[0]).toMatchObject({
      severity: 0,
      message: 'near error',
      diagnosticStartRow: 24,
      diagnosticEndRow: 24,
    });
    expect(values[0]?.snippetStartRow).toBeLessThan(24);
    expect(values[0]?.snippetEndRow).toBeGreaterThan(24);
  });

  it('installs lifecycle document tracking only when an adapter is provided', () => {
    const model = new ZedOnlyCompletionModel({ kind: 'zed', text: '' });
    const initialListeners = mock.documentChangeListeners.size;
    const context = (algorithm: 'zed' | 'inception'): CompletionAlgorithmContext => ({
      entry: { id: `${algorithm}-listeners`, algorithm },
      options: { model: { vendor: 'test', id: 'model' } },
      modelResolver: {
        resolveCompletionModel: async () => model,
      },
      reportConfigurationError: () => undefined,
    });

    const inception = new EditPredictionAlgorithm(
      'inception',
      context('inception'),
      { model: { vendor: 'test', id: 'model' } },
    );
    const sharedListenerCount =
      mock.documentChangeListeners.size - initialListeners;
    inception.dispose();
    expect(mock.documentChangeListeners.size).toBe(initialListeners);

    const zed = new EditPredictionAlgorithm(
      'zed',
      context('zed'),
      { model: { vendor: 'test', id: 'model' }, maxTokens: 64 },
      new ZedEditPredictionLifecycle(),
    );
    expect(mock.documentChangeListeners.size - initialListeners).toBe(
      sharedListenerCount + 1,
    );
    zed.dispose();
  });

  it('transfers a cached request terminal to the latest interpolated item', async () => {
    const mutable = mutableDocument('const x = ;');
    mock.activeDocument = mutable.document;
    const insertionOffset = mutable.document.getText().indexOf(';');
    const accept = vi.fn(async () => undefined);
    const reject = vi.fn(async () => undefined);
    const settled = vi.fn(async () => undefined);
    trackZedPrediction({
      requestId: 'request-1',
      startedAt: Date.now(),
      transport: { accept, reject, settled },
    });

    const model = new ZedOnlyCompletionModel({
        kind: 'zed',
        text: 'answer',
        edit: {
          requestId: 'request-1',
          targetUri: mutable.document.uri.toString(),
          startOffset: insertionOffset,
          endOffset: insertionOffset,
        },
      });
    const context: CompletionAlgorithmContext = {
      entry: { id: 'zed-test', algorithm: 'zed' },
      options: {
        model: { vendor: 'test', id: 'zeta-cloud' },
        maxTokens: 64,
      },
      modelResolver: {
        evaluateModelForRequest: async () => ({ eligible: true }),
        resolveCompletionModel: async () => model,
      },
      reportConfigurationError: () => undefined,
    };
    const algorithm = new EditPredictionAlgorithm('zed', context, {
      model: { vendor: 'test', id: 'zeta-cloud' },
      maxTokens: 64,
    }, new ZedEditPredictionLifecycle());
    const input = (): CompletionAlgorithmInput => ({
      document: mutable.document,
      position: mutable.document.positionAt(insertionOffset),
      context: {
        triggerKind: vscode.InlineCompletionTriggerKind.Automatic,
      } as vscode.InlineCompletionContext,
    });

    const first = await algorithm.provideInlineCompletions(input(), token());
    const firstItem = first?.items[0];
    expect(firstItem).toBeDefined();
    mutable.update('const x = ans;');
    const second = await algorithm.provideInlineCompletions(input(), token());
    const secondItem = second?.items[0];
    expect(secondItem).toBeDefined();
    expect(secondItem?.insertText).toBe('wer');

    if (!firstItem || !secondItem) throw new Error('Expected cached items.');
    algorithm.handleEndOfLifetime(firstItem, {
      kind: vscode.InlineCompletionEndOfLifeReasonKind.Rejected,
    });
    await Promise.resolve();
    expect(reject).not.toHaveBeenCalled();

    algorithm.handleEndOfLifetime(secondItem, {
      kind: vscode.InlineCompletionEndOfLifeReasonKind.Accepted,
    });
    await Promise.resolve();
    expect(accept).toHaveBeenCalledTimes(1);
    expect(accept).toHaveBeenCalledWith(
      expect.objectContaining({ request_id: 'request-1' }),
    );
    expect(reject).not.toHaveBeenCalled();
    algorithm.dispose();
  });

  it('retains granular v4 edits while adapting them to one VS Code inline edit', async () => {
    const source = 'first\nconst x = ;\nlast\n';
    const predicted = 'FIRST\nconst x = answer;\nLAST\n';
    const mutable = mutableDocument(source);
    mock.activeDocument = mutable.document;
    const insertion = source.indexOf(';');
    const last = source.indexOf('last');
    const model = new ZedOnlyCompletionModel({
      kind: 'zed',
      text: predicted,
      edit: {
        targetUri: mutable.document.uri.toString(),
        requestSnapshot: source,
        edits: [
          { startOffset: 0, endOffset: 5, text: 'FIRST' },
          { startOffset: insertion, endOffset: insertion, text: 'answer' },
          { startOffset: last, endOffset: last + 4, text: 'LAST' },
        ],
        jumpOffset: predicted.indexOf('answer') + 3,
      },
    });
    const algorithm = new EditPredictionAlgorithm(
      'zed',
      {
        entry: { id: 'zed-granular', algorithm: 'zed' },
        options: {
          model: { vendor: 'test', id: 'zeta-cloud' },
          maxTokens: 64,
        },
        modelResolver: {
          evaluateModelForRequest: async () => ({ eligible: true }),
          resolveCompletionModel: async () => model,
        },
        reportConfigurationError: () => undefined,
      },
      {
        model: { vendor: 'test', id: 'zeta-cloud' },
        maxTokens: 64,
      },
    );
    const result = await algorithm.provideInlineCompletions(
      {
        document: mutable.document,
        position: mutable.document.positionAt(insertion),
        context: {
          triggerKind: vscode.InlineCompletionTriggerKind.Automatic,
        } as vscode.InlineCompletionContext,
      },
      token(),
    );
    const item = result?.items[0];
    expect(item?.insertText).toBe('FIRST\nconst x = answer;\nLAST');
    expect(item?.jumpToPosition).toEqual(new vscode.Position(1, 13));
    algorithm.dispose();
  });

  it('keeps an empty response that represents a structured deletion', async () => {
    const source = 'remove me\nkeep me\n';
    const mutable = mutableDocument(source);
    mock.activeDocument = mutable.document;
    const model = new ZedOnlyCompletionModel({
      kind: 'zed',
      text: '',
      edit: {
        targetUri: mutable.document.uri.toString(),
        startOffset: 0,
        endOffset: 'remove me\n'.length,
      },
    });
    const algorithm = new EditPredictionAlgorithm(
      'zed',
      {
        entry: { id: 'zed-deletion', algorithm: 'zed' },
        options: {
          model: { vendor: 'test', id: 'zeta-cloud' },
          maxTokens: 64,
        },
        modelResolver: {
          evaluateModelForRequest: async () => ({ eligible: true }),
          resolveCompletionModel: async () => model,
        },
        reportConfigurationError: () => undefined,
      },
      {
        model: { vendor: 'test', id: 'zeta-cloud' },
        maxTokens: 64,
      },
    );
    const result = await algorithm.provideInlineCompletions(
      {
        document: mutable.document,
        position: new vscode.Position(0, 0),
        context: {
          triggerKind: vscode.InlineCompletionTriggerKind.Automatic,
        } as vscode.InlineCompletionContext,
      },
      token(),
    );
    expect(result?.items[0]?.insertText).toBe('');
    expect(result?.items[0]?.range).toEqual(
      new vscode.Range(new vscode.Position(0, 0), new vscode.Position(1, 0)),
    );
    algorithm.dispose();
  });

  it('lets an older cached item acceptance win the shared request terminal', async () => {
    const mutable = mutableDocument('const x = ;');
    mock.activeDocument = mutable.document;
    const insertionOffset = mutable.document.getText().indexOf(';');
    const accept = vi.fn(async () => undefined);
    const reject = vi.fn(async () => undefined);
    const settled = vi.fn(async () => undefined);
    trackZedPrediction({
      requestId: 'request-old-accepted',
      startedAt: Date.now(),
      transport: { accept, reject, settled },
    });
    const model = new ZedOnlyCompletionModel({
      kind: 'zed',
      text: 'answer',
      edit: {
        requestId: 'request-old-accepted',
        targetUri: mutable.document.uri.toString(),
        startOffset: insertionOffset,
        endOffset: insertionOffset,
      },
    });
    const algorithm = new EditPredictionAlgorithm(
      'zed',
      {
        entry: { id: 'zed-old-accepted', algorithm: 'zed' },
        options: {
          model: { vendor: 'test', id: 'zeta-cloud' },
          maxTokens: 64,
        },
        modelResolver: {
          evaluateModelForRequest: async () => ({ eligible: true }),
          resolveCompletionModel: async () => model,
        },
        reportConfigurationError: () => undefined,
      },
      {
        model: { vendor: 'test', id: 'zeta-cloud' },
        maxTokens: 64,
      },
      new ZedEditPredictionLifecycle(),
    );
    const input = (): CompletionAlgorithmInput => ({
      document: mutable.document,
      position: mutable.document.positionAt(insertionOffset),
      context: {
        triggerKind: vscode.InlineCompletionTriggerKind.Automatic,
      } as vscode.InlineCompletionContext,
    });

    const firstItem = (await algorithm.provideInlineCompletions(input(), token()))
      ?.items[0];
    mutable.update('const x = ans;');
    const secondItem = (await algorithm.provideInlineCompletions(input(), token()))
      ?.items[0];
    if (!firstItem || !secondItem) throw new Error('Expected cached items.');

    algorithm.handleEndOfLifetime(firstItem, {
      kind: vscode.InlineCompletionEndOfLifeReasonKind.Accepted,
    });
    await Promise.resolve();
    expect(accept).toHaveBeenCalledOnce();
    algorithm.handleEndOfLifetime(secondItem, {
      kind: vscode.InlineCompletionEndOfLifeReasonKind.Rejected,
    });
    await Promise.resolve();
    expect(accept).toHaveBeenCalledOnce();
    expect(reject).not.toHaveBeenCalled();
    algorithm.dispose();
  });
});

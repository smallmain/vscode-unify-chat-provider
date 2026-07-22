import * as vscode from 'vscode';
import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({
  InlineCompletionItem: class InlineCompletionItem {
    constructor(
      readonly insertText: unknown,
      readonly range: unknown,
    ) {}
  },
  Range: class Range {
    constructor(
      readonly start: unknown,
      readonly end: unknown,
    ) {}
  },
  Position: class Position {
    constructor(
      readonly line: number,
      readonly character: number,
    ) {}
  },
  Uri: class Uri {
    static parse(value: string): Uri {
      return new Uri(value);
    }

    readonly scheme = 'file';
    readonly authority = '';
    readonly path = '/test.ts';
    readonly query = '';
    readonly fragment = '';
    readonly fsPath = '/test.ts';

    constructor(private readonly value: string) {}

    with(): Uri {
      return this;
    }

    toString(): string {
      return this.value;
    }

    toJSON(): { scheme: string; path: string } {
      return { scheme: this.scheme, path: this.path };
    }
  },
  EndOfLine: { LF: 1, CRLF: 2 },
  InlineCompletionTriggerKind: { Automatic: 0, Invoke: 1 },
  l10n: { t: (message: string) => message },
}));

vi.mock('../../src/i18n', () => ({
  t: (message: string) => message,
}));

import {
  buildSimpleAlgorithmRequest,
  simpleAlgorithmDefinition,
} from '../../src/completion/simple/algorithm';
import { normalizeSimpleAlgorithmOptions } from '../../src/completion/simple/options';
import type {
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

class TestTextDocument implements vscode.TextDocument {
  readonly uri = vscode.Uri.parse('file:///test.ts');
  readonly fileName = '/test.ts';
  readonly isUntitled = false;
  readonly languageId = 'typescript';
  readonly encoding = 'utf8';
  readonly version = 1;
  readonly isDirty = false;
  readonly isClosed = false;
  readonly eol = vscode.EndOfLine.LF;
  readonly lineCount = 1;

  constructor(private readonly text: string) {}

  save(): Thenable<boolean> {
    return Promise.resolve(true);
  }

  lineAt(line: number): vscode.TextLine;
  lineAt(position: vscode.Position): vscode.TextLine;
  lineAt(lineOrPosition: number | vscode.Position): vscode.TextLine {
    const lineNumber =
      typeof lineOrPosition === 'number' ? lineOrPosition : lineOrPosition.line;
    const start = new vscode.Position(lineNumber, 0);
    const end = new vscode.Position(lineNumber, this.text.length);
    return {
      lineNumber,
      text: this.text,
      range: new vscode.Range(start, end),
      rangeIncludingLineBreak: new vscode.Range(start, end),
      firstNonWhitespaceCharacterIndex: this.text.search(/\S|$/),
      isEmptyOrWhitespace: this.text.trim().length === 0,
    };
  }

  offsetAt(position: vscode.Position): number {
    return Math.max(0, Math.min(this.text.length, position.character));
  }

  positionAt(offset: number): vscode.Position {
    return new vscode.Position(0, Math.max(0, Math.min(this.text.length, offset)));
  }

  getText(): string {
    return this.text;
  }

  getWordRangeAtPosition(): vscode.Range | undefined {
    return undefined;
  }

  validateRange(range: vscode.Range): vscode.Range {
    return range;
  }

  validatePosition(position: vscode.Position): vscode.Position {
    return position;
  }
}

class SimpleTestCompletionModel implements CompletionModel {
  readonly requests: SimpleAlgorithmRequest[] = [];

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
    if (request.kind !== 'simple') {
      throw new Error(`Unexpected completion request kind "${request.kind}".`);
    }
    this.requests.push(request);
    return { kind: 'simple', text: 'result', finishReason: 'stop' };
  }
}

function cancellationToken(): vscode.CancellationToken {
  return {
    isCancellationRequested: false,
    onCancellationRequested: (_listener, _thisArgs, disposables) => {
      const disposable = { dispose: () => undefined };
      disposables?.push(disposable);
      return disposable;
    },
  };
}

describe('Simple algorithm', () => {
  it('builds a path-free request at a bounded cursor offset', () => {
    expect(buildSimpleAlgorithmRequest('const answer = 42;', 15)).toEqual({
      kind: 'simple',
      prefix: 'const answer = ',
      suffix: '42;',
    });
    expect(buildSimpleAlgorithmRequest('value', 99)).toEqual({
      kind: 'simple',
      prefix: 'value',
      suffix: '',
    });
    expect(buildSimpleAlgorithmRequest('value', -1)).toEqual({
      kind: 'simple',
      prefix: '',
      suffix: 'value',
    });
  });

  it('normalizes only a complete model reference', () => {
    expect(
      normalizeSimpleAlgorithmOptions({
        model: { vendor: ' vendor ', id: ' model ' },
      }),
    ).toEqual({
      ok: true,
      value: { model: { vendor: 'vendor', id: 'model' } },
    });
    expect(normalizeSimpleAlgorithmOptions({ model: { vendor: 'vendor' } })).toEqual(
      {
        ok: false,
        error: 'Simple options require model.vendor and model.id.',
      },
    );
  });

  it('resolves the model, completes the tagged request, and builds the item', async () => {
    const model = new SimpleTestCompletionModel();
    const resolveCompletionModel = vi.fn(async () => model);
    const algorithm = simpleAlgorithmDefinition.create({
      entry: { id: 'simple-entry', algorithm: 'simple' },
      options: { model: { vendor: 'test', id: 'model' } },
      modelResolver: { resolveCompletionModel },
      reportConfigurationError: vi.fn(),
    });
    const position = new vscode.Position(0, 3);
    const input: CompletionAlgorithmInput = {
      document: new TestTextDocument('abcdef'),
      position,
      context: {
        triggerKind: vscode.InlineCompletionTriggerKind.Automatic,
        selectedCompletionInfo: undefined,
        requestUuid: 'simple-request',
        requestIssuedDateTime: 1,
        earliestShownDateTime: 1,
      },
    };

    const result = await algorithm.provideInlineCompletions(
      input,
      cancellationToken(),
    );

    expect(resolveCompletionModel).toHaveBeenCalledWith(
      { vendor: 'test', id: 'model' },
      expect.objectContaining({ isCancellationRequested: false }),
    );
    expect(model.requests).toEqual([
      { kind: 'simple', prefix: 'abc', suffix: 'def' },
    ]);
    expect(result).toMatchObject({
      providerId: 'simple-entry',
      items: [{ insertText: 'result' }],
      metadata: { finishReason: 'stop' },
    });
  });
});

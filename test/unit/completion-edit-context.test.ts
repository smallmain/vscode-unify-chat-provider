import { beforeEach, describe, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({
  executeCommand: vi.fn(),
  openTextDocument: vi.fn(),
  changeListener: undefined as
    | ((event: { document: unknown }) => void)
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
  }
  class Uri {
    readonly scheme: string;
    constructor(private readonly value: string) {
      this.scheme = value.slice(0, value.indexOf(':'));
    }
    static parse(value: string): Uri {
      return new Uri(value);
    }
    toString(): string {
      return this.value;
    }
  }
  const workspaceUri = new Uri('file:///workspace');
  return {
    Position,
    Range,
    Uri,
    commands: { executeCommand: mock.executeCommand },
    workspace: {
      getWorkspaceFolder: (uri: Uri) =>
        uri.toString().startsWith('file:///workspace/')
          ? { uri: workspaceUri }
          : undefined,
      openTextDocument: mock.openTextDocument,
      onDidChangeTextDocument: (listener: (event: { document: unknown }) => void) => {
        mock.changeListener = listener;
        return { dispose: () => (mock.changeListener = undefined) };
      },
      asRelativePath: (uri: Uri) =>
        uri.toString().replace('file:///workspace/', ''),
    },
  };
});

import * as vscode from 'vscode';
import { EditPredictionContextCache } from '../../src/completion/edit/context';

function textDocument(uri: vscode.Uri, text: string, version = 1) {
  const lineStarts = [0];
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 10) lineStarts.push(index + 1);
  }
  return {
    uri,
    version,
    getText: () => text,
    positionAt: (offset: number) => {
      const bounded = Math.max(0, Math.min(text.length, offset));
      let line = 0;
      while ((lineStarts[line + 1] ?? Number.POSITIVE_INFINITY) <= bounded) {
        line += 1;
      }
      return new vscode.Position(line, bounded - (lineStarts[line] ?? 0));
    },
    offsetAt: (position: vscode.Position) =>
      Math.min(text.length, (lineStarts[position.line] ?? 0) + position.character),
  } as vscode.TextDocument;
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe('EditPredictionContextCache', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mock.executeCommand.mockReset();
    mock.openTextDocument.mockReset();
  });

  it('refreshes syntax immediately and debounces cached identifier definitions', async () => {
    const source = textDocument(
      vscode.Uri.parse('file:///workspace/src/main.ts'),
      'helper',
    );
    const target = textDocument(
      vscode.Uri.parse('file:///workspace/src/helper.ts'),
      'export function helper() { return true; }\n',
    );
    mock.openTextDocument.mockResolvedValue(target);
    mock.executeCommand.mockImplementation((command: string) => {
      if (command === 'vscode.executeDocumentSymbolProvider') {
        return Promise.resolve([
          {
            range: new vscode.Range(
              new vscode.Position(0, 0),
              new vscode.Position(0, 6),
            ),
          },
        ]);
      }
      if (command === 'vscode.executeDefinitionProvider') {
        return Promise.resolve([
          {
            uri: target.uri,
            range: new vscode.Range(
              new vscode.Position(0, 16),
              new vscode.Position(0, 22),
            ),
          },
        ]);
      }
      return Promise.resolve([]);
    });

    const cache = new EditPredictionContextCache();
    cache.refresh(source, new vscode.Position(0, 3));
    expect(
      mock.executeCommand.mock.calls.map((call) => call[0]),
    ).toEqual(['vscode.executeDocumentSymbolProvider']);
    expect(cache.read(source).relatedFiles).toEqual([]);

    await flushPromises();
    expect(cache.read(source).fullSyntaxRanges).toEqual([
      { startOffset: 0, endOffset: 6 },
    ]);

    await vi.advanceTimersByTimeAsync(99);
    expect(
      mock.executeCommand.mock.calls.filter(
        (call) => call[0] === 'vscode.executeDefinitionProvider',
      ),
    ).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    await flushPromises();
    expect(cache.read(source).relatedFiles).toEqual([
      {
        uri: target.uri.toString(),
        path: 'src/helper.ts',
        content: target.getText(),
        range: { startOffset: 0, endOffset: target.getText().length },
      },
    ]);

    cache.refresh(source, new vscode.Position(0, 3));
    await vi.advanceTimersByTimeAsync(100);
    await flushPromises();
    expect(
      mock.executeCommand.mock.calls.filter(
        (call) => call[0] === 'vscode.executeDefinitionProvider',
      ),
    ).toHaveLength(1);

    const updatedTarget = textDocument(
      target.uri,
      'export function helper() { return false; }\n',
      2,
    );
    mock.openTextDocument.mockResolvedValue(updatedTarget);
    mock.changeListener?.({ document: updatedTarget });
    expect(cache.read(source).relatedFiles).toEqual([]);
    cache.refresh(source, new vscode.Position(0, 3));
    await vi.advanceTimersByTimeAsync(100);
    await flushPromises();
    expect(
      mock.executeCommand.mock.calls.filter(
        (call) => call[0] === 'vscode.executeDefinitionProvider',
      ),
    ).toHaveLength(2);
    expect(cache.read(source).relatedFiles[0]?.content).toContain('false');
    cache.dispose();
  });
});

import type * as VSCode from 'vscode';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({
  changeListeners: new Set<(event: { document: VSCode.TextDocument }) => void>(),
}));

vi.mock('vscode', () => {
  class Disposable {
    constructor(private readonly callback: () => void = () => undefined) {}
    dispose(): void {
      this.callback();
    }
  }
  class Uri {
    readonly path: string;
    constructor(private readonly value: string) {
      this.path = new URL(value).pathname;
    }
    static parse(value: string): Uri {
      return new Uri(value);
    }
    toString(): string {
      return this.value;
    }
  }
  const workspaceUri = Uri.parse('file:///workspace');
  return {
    Disposable,
    Uri,
    workspace: {
      textDocuments: [],
      getWorkspaceFolder: (uri: Uri) =>
        uri.toString().startsWith('file:///workspace/')
          ? { uri: workspaceUri }
          : undefined,
      asRelativePath: (uri: Uri) =>
        uri.toString().replace('file:///workspace/', ''),
      onDidChangeTextDocument: (
        listener: (event: { document: VSCode.TextDocument }) => void,
      ) => {
        mock.changeListeners.add(listener);
        return new Disposable(() => mock.changeListeners.delete(listener));
      },
    },
  };
});

import * as vscode from 'vscode';
import { WorkspaceEditHistory, editHistoryTesting } from '../../src/completion/edit/history';

function mutableDocument(initial: string): {
  readonly document: vscode.TextDocument;
  update(text: string): void;
} {
  let text = initial;
  const document = {
    uri: vscode.Uri.parse('file:///workspace/main.ts'),
    getText: () => text,
  } as vscode.TextDocument;
  return {
    document,
    update(value: string): void {
      text = value;
      for (const listener of mock.changeListeners) listener({ document });
    },
  };
}

afterEach(() => {
  mock.changeListeners.clear();
  vi.useRealTimers();
});

describe('WorkspaceEditHistory Zed parity', () => {
  it('coalesces a burst of keystrokes into one event and finalizes after a pause', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const mutable = mutableDocument('');
    const history = new WorkspaceEditHistory();
    const recorded = vi.fn();
    history.onDidRecord(recorded);
    history.seed(mutable.document);

    for (const value of ['a', 'ab', 'abc', 'abcd', 'abcde', 'abcdef']) {
      mutable.update(value);
      vi.advanceTimersByTime(100);
    }
    expect(history.read(mutable.document)).toHaveLength(1);
    expect(history.read(mutable.document)[0]).toMatchObject({
      oldText: '',
      newText: 'abcdef',
    });
    expect(recorded).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(
      editHistoryTesting.constants.LAST_CHANGE_GROUPING_TIME_MS,
    );
    expect(recorded).toHaveBeenCalledOnce();
    expect(history.read(mutable.document)).toHaveLength(1);

    mutable.update('abcdefg');
    expect(history.read(mutable.document)).toHaveLength(2);
    history.dispose();
  });

  it('does not coalesce edits more than eight lines apart', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const lines = Array.from({ length: 20 }, (_, index) => `line ${index}`);
    const mutable = mutableDocument(`${lines.join('\n')}\n`);
    const history = new WorkspaceEditHistory();
    history.seed(mutable.document);

    const first = [...lines];
    first[0] = 'changed 0';
    mutable.update(`${first.join('\n')}\n`);
    vi.advanceTimersByTime(100);
    const second = [...first];
    second[15] = 'changed 15';
    mutable.update(`${second.join('\n')}\n`);

    expect(history.read(mutable.document)).toHaveLength(2);
    history.dispose();
  });

  it('keeps unchanged lines as context inside grouped unified diffs', () => {
    const before = 'one\nkeep\nthree\n';
    const after = 'ONE\nkeep\nTHREE\n';
    const change = editHistoryTesting.minimalChange(before, after);
    if (!change) throw new Error('Expected a change.');
    const diff = editHistoryTesting.unifiedDiff(before, after, change);
    expect(diff).toContain(' keep');
    expect(diff).not.toContain('-keep');
    expect(diff).not.toContain('+keep');
  });

  it('merges an old mixed-source cluster after editing a distant location', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const lines = Array.from({ length: 15 }, (_, index) => `line ${index}`);
    const mutable = mutableDocument(`${lines.join('\n')}\n`);
    const history = new WorkspaceEditHistory();
    history.seed(mutable.document);

    const updateLine = (row: number, value: string, predicted: boolean): void => {
      lines[row] = value;
      if (predicted) history.markNextChangePredicted(mutable.document.uri);
      mutable.update(`${lines.join('\n')}\n`);
    };

    updateLine(0, 'LINE ZERO', false);
    updateLine(1, 'LINE ONE', false);
    updateLine(2, 'LINE TWO', true);
    updateLine(3, 'LINE THREE', true);
    updateLine(4, 'LINE FOUR', false);
    expect(history.read(mutable.document)).toHaveLength(3);

    updateLine(14, 'LINE FOURTEEN', false);
    const events = history.read(mutable.document);
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ predicted: false });
    expect(events[0]?.diff).toContain('+LINE ZERO');
    expect(events[0]?.diff).toContain('+LINE FOUR');
    expect(events[1]?.diff).toContain('+LINE FOURTEEN');
    history.dispose();
  });
});

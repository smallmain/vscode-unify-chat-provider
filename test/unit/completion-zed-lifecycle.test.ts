import * as vscode from 'vscode';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const feedback = vi.hoisted(() => ({
  accept: vi.fn(),
  attach: vi.fn((_requestId: string, _capture: unknown) => true),
  markEdited: vi.fn(),
  recordFuture: vi.fn(),
  recordNavigation: vi.fn(),
  reject: vi.fn(),
}));
const privacy = vi.hoisted(() => ({
  eligible: vi.fn(async () => true),
  privatePath: vi.fn(() => false),
}));
const wire = vi.hoisted(() => ({
  event: { event: 'BufferChange' },
  toEvent: vi.fn(() => wire.event),
}));

vi.mock('vscode', () => {
  class Uri {
    constructor(private readonly value: string) {}
    static parse(value: string): Uri {
      return new Uri(value);
    }
    toString(): string {
      return this.value;
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
  const workspaceUri = new Uri('file:///workspace');
  return {
    Uri,
    Position,
    Range,
    workspace: {
      getWorkspaceFolder: (uri: Uri) =>
        uri.toString().startsWith('file:///workspace/')
          ? { uri: workspaceUri }
          : undefined,
    },
  };
});

vi.mock('../../src/completion/zed/feedback', () => ({
  acceptZedPrediction: feedback.accept,
  attachZedPredictionCapture: feedback.attach,
  markZedPredictionCaptureEdited: feedback.markEdited,
  recordZedPredictionFutureEvent: feedback.recordFuture,
  recordZedPredictionNavigation: feedback.recordNavigation,
  rejectZedPrediction: feedback.reject,
}));

vi.mock('../../src/completion/zed/privacy', () => ({
  isZedFileEligibleForDataCollection: privacy.eligible,
  isZedPrivatePath: privacy.privatePath,
}));

vi.mock('../../src/completion/zed/wire', () => ({
  toZedBufferChangeEvent: wire.toEvent,
}));

import { ZedEditPredictionLifecycle } from '../../src/completion/zed/lifecycle';
import type { ZedPredictionCapture } from '../../src/completion/zed/feedback';
import type { EditHistoryEntry } from '../../src/completion/model/requests';

function mutableDocument(initial: string): {
  readonly document: vscode.TextDocument;
  update(value: string): void;
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
    },
  };
}

function historyEntry(): EditHistoryEntry {
  return {
    uri: 'file:///workspace/main.ts',
    path: 'main.ts',
    oldText: 'old',
    newText: 'new',
    oldRange: { startOffset: 0, endOffset: 3 },
    newRange: { startOffset: 0, endOffset: 3 },
    diff: '@@ -1 +1 @@\n-old\n+new\n',
    predicted: false,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  feedback.attach.mockReturnValue(true);
  privacy.eligible.mockResolvedValue(true);
  privacy.privatePath.mockReturnValue(false);
  wire.toEvent.mockReturnValue(wire.event);
});

describe('Zed edit-prediction lifecycle', () => {
  it('owns settled capture range tracking and edit notifications', () => {
    const mutable = mutableDocument('abcdef');
    const lifecycle = new ZedEditPredictionLifecycle();
    lifecycle.attachCapture('request', {
      document: mutable.document,
      workspaceUri: 'file:///workspace',
      startOffset: 2,
      endOffset: 4,
      editableRegionBeforePrediction: 'cd',
      predictedEditableRegion: 'xy',
    });
    const capture = feedback.attach.mock.calls[0]?.[1] as
      | ZedPredictionCapture
      | undefined;
    expect(capture?.readSettledEditableRegion()).toBe('cd');

    mutable.update('aXbcdef');
    lifecycle.handleDocumentChange({
      document: mutable.document,
      contentChanges: [
        {
          range: new vscode.Range(0, 0, 0, 0),
          rangeOffset: 1,
          rangeLength: 0,
          text: 'X',
        },
      ],
      reason: undefined,
      detailedReason: undefined,
    });
    expect(capture?.readSettledEditableRegion()).toBe('cd');
    expect(feedback.markEdited).not.toHaveBeenCalled();

    mutable.update('aXbYcdef');
    lifecycle.handleDocumentChange({
      document: mutable.document,
      contentChanges: [
        {
          range: new vscode.Range(0, 0, 0, 0),
          rangeOffset: 3,
          rangeLength: 0,
          text: 'Y',
        },
      ],
      reason: undefined,
      detailedReason: undefined,
    });
    expect(capture?.readSettledEditableRegion()).toBe('Ycd');
    expect(feedback.markEdited).toHaveBeenCalledWith('request');

    lifecycle.dispose();
    expect(capture?.readSettledEditableRegion()).toBeUndefined();
  });

  it('avoids privacy work without captures and routes matching future events', async () => {
    const lifecycle = new ZedEditPredictionLifecycle();
    const entry = historyEntry();
    await lifecycle.handleHistoryEntry(entry);
    expect(privacy.eligible).not.toHaveBeenCalled();

    const mutable = mutableDocument('abcdef');
    lifecycle.attachCapture('request', {
      document: mutable.document,
      workspaceUri: 'file:///workspace',
      startOffset: 0,
      endOffset: 1,
      editableRegionBeforePrediction: 'a',
      predictedEditableRegion: 'b',
    });
    await lifecycle.handleHistoryEntry(entry);

    expect(privacy.eligible).toHaveBeenCalledWith(
      'file:///workspace/main.ts',
      'main.ts',
    );
    expect(wire.toEvent).toHaveBeenCalledWith(entry, 'main.ts', true);
    expect(feedback.recordFuture).toHaveBeenCalledWith('request', wire.event);
  });

  it('keeps Zed navigation encoding and privacy inside the adapter', () => {
    privacy.privatePath.mockReturnValue(true);
    const lifecycle = new ZedEditPredictionLifecycle();
    lifecycle.recordNavigation('request', {
      path: '.env',
      predictedSnapshot: 'a🙂',
      navigationOffset: 3,
    });

    expect(feedback.recordNavigation).toHaveBeenCalledWith(
      'request',
      { path: '.env', cursor_position: 5 },
      false,
    );
  });
});

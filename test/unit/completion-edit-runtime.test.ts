import type * as vscode from 'vscode';
import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({
  Position: class Position {
    constructor(
      readonly line: number,
      readonly character: number,
    ) {}
  },
  Range: class Range {
    constructor(
      readonly start: unknown,
      readonly end: unknown,
    ) {}
  },
  EventEmitter: class EventEmitter {
    readonly event = (): { dispose(): void } => ({ dispose() {} });
    fire(): void {}
    dispose(): void {}
  },
  InlineCompletionItem: class InlineCompletionItem {},
  InlineCompletionTriggerKind: { Automatic: 0, Invoke: 1 },
  InlineCompletionEndOfLifeReasonKind: { Accepted: 0, Rejected: 1 },
  l10n: { t: (message: string) => message },
  workspace: {},
  languages: {},
}));

import {
  computeMinimalTextEdit,
  interpolateTextEdit,
  positionAtText,
  resolveEditPredictionTrigger,
} from '../../src/completion/edit/runtime';
import {
  applyTextEdits,
  interpolateTextEdits,
} from '../../src/completion/edit/text-edits';
import type { CompletionAlgorithmInput } from '../../src/completion/types';

function input(
  triggerKind: vscode.InlineCompletionTriggerKind,
  data?: unknown,
): CompletionAlgorithmInput {
  return {
    document: {} as vscode.TextDocument,
    position: {} as vscode.Position,
    context: {
      triggerKind,
      ...(data === undefined ? {} : { changeHint: { data } }),
    } as vscode.InlineCompletionContext,
  };
}

describe('edit prediction runtime pure behavior', () => {
  it('trims a prediction to its minimal replacement', () => {
    expect(
      computeMinimalTextEdit('const value = 1;', 'const value = 42;'),
    ).toEqual({ startOffset: 14, endOffset: 15, text: '42' });
    expect(computeMinimalTextEdit('same', 'same')).toBeUndefined();
  });

  it('interpolates only a typed prefix of a predicted insertion', () => {
    expect(
      interpolateTextEdit('const x = ;', 'const x = ans;', 'const x = answer;'),
    ).toEqual({
      kind: 'edit',
      edit: { startOffset: 13, endOffset: 13, text: 'wer' },
    });
    expect(
      interpolateTextEdit('const x = ;', 'const x = answer;', 'const x = answer;'),
    ).toEqual({ kind: 'interpolated-empty' });
    expect(
      interpolateTextEdit('const x = 1;', 'const y = 1;', 'const x = 2;'),
    ).toEqual({ kind: 'failed' });
  });

  it('interpolates a typed prefix without discarding other model edits', () => {
    const request = 'first\nconst x = ;\nlast\n';
    const insertion = request.indexOf(';');
    const last = request.indexOf('last');
    const modelEdits = [
      { startOffset: 0, endOffset: 5, text: 'FIRST' },
      { startOffset: insertion, endOffset: insertion, text: 'answer' },
      { startOffset: last, endOffset: last + 4, text: 'LAST' },
    ];
    const current = `${request.slice(0, insertion)}ans${request.slice(insertion)}`;
    const interpolated = interpolateTextEdits(request, current, modelEdits);
    expect(interpolated).toEqual({
      kind: 'edits',
      edits: [
        { startOffset: 0, endOffset: 5, text: 'FIRST' },
        { startOffset: insertion + 3, endOffset: insertion + 3, text: 'wer' },
        {
          startOffset: last + 3,
          endOffset: last + 7,
          text: 'LAST',
        },
      ],
    });
    if (interpolated.kind !== 'edits') throw new Error('Expected edits.');
    expect(applyTextEdits(current, interpolated.edits)).toBe(
      'FIRST\nconst x = answer;\nLAST\n',
    );
    expect(
      interpolateTextEdits(request, request.replace('first', 'other'), modelEdits),
    ).toEqual({ kind: 'failed' });
  });

  it('matches Zed interpolation across accepted replacement and deletion edits', () => {
    const request = 'Lorem ipsum dolor';
    const modelEdits = [
      { startOffset: 2, endOffset: 5, text: 'REM' },
      { startOffset: 9, endOffset: 11, text: '' },
    ];
    const expectEdits = (
      current: string,
      expected: readonly {
        readonly startOffset: number;
        readonly endOffset: number;
        readonly text: string;
      }[],
    ): void => {
      expect(interpolateTextEdits(request, current, modelEdits)).toEqual({
        kind: 'edits',
        edits: expected,
      });
    };

    expectEdits(request, modelEdits);
    expectEdits('Lo ipsum dolor', [
      { startOffset: 2, endOffset: 2, text: 'REM' },
      { startOffset: 6, endOffset: 8, text: '' },
    ]);
    expectEdits('LoR ipsum dolor', [
      { startOffset: 3, endOffset: 3, text: 'EM' },
      { startOffset: 7, endOffset: 9, text: '' },
    ]);
    expectEdits('LoRE ipsum dolor', [
      { startOffset: 4, endOffset: 4, text: 'M' },
      { startOffset: 8, endOffset: 10, text: '' },
    ]);
    expectEdits('LoREM ipsum dolor', [
      { startOffset: 9, endOffset: 11, text: '' },
    ]);
    expectEdits('LoRE ipsum dolor', [
      { startOffset: 4, endOffset: 4, text: 'M' },
      { startOffset: 8, endOffset: 10, text: '' },
    ]);
    expectEdits('LoRE ips dolor', [
      { startOffset: 4, endOffset: 4, text: 'M' },
    ]);
    expect(
      interpolateTextEdits(request, 'LoREps dolor', modelEdits),
    ).toEqual({ kind: 'failed' });
  });

  it('computes positions against the predicted snapshot', () => {
    expect(positionAtText('first\ninserted\nlast', 15)).toEqual({
      line: 2,
      character: 0,
    });
  });

  it('reads routed change reasons from changeHint.data.change.reason', () => {
    expect(
      resolveEditPredictionTrigger(
        input(0, { change: { reason: 'prediction-accepted' } }),
      ),
    ).toBe('prediction_accepted');
    expect(
      resolveEditPredictionTrigger(
        input(0, { change: { reason: 'settings-changed' } }),
      ),
    ).toBe('settings_changed');
    expect(resolveEditPredictionTrigger(input(0, { reason: 'provider-changed' }))).toBe(
      'buffer_edit',
    );
    expect(resolveEditPredictionTrigger(input(1))).toBe('explicit');
  });
});

import { describe, expect, it } from 'vitest';
import {
  NesStringEdit,
  NesStringReplacement,
} from '../../src/chat-lib/core/nes/string-edit';
import { tryRebaseNesEdits } from '../../src/chat-lib/core/nes/edit-rebase';
import type { NesTextEdit } from '../../src/chat-lib/core/nes/types';

const rebaseConfig = {
  absorbSubsequenceTyping: true,
  reverseAgreement: true,
  maxImperfectAgreementLength: 1,
} as const;

function insertion(offset: number, newText: string): NesTextEdit {
  return {
    uri: 'file:///main.ts',
    startOffset: offset,
    endOffset: offset,
    newText,
    kind: 'insert',
  };
}

function replacement(
  startOffset: number,
  endOffset: number,
  newText: string,
): NesTextEdit {
  return {
    uri: 'file:///main.ts',
    startOffset,
    endOffset,
    newText,
    kind: startOffset === endOffset ? 'insert' : 'replace',
  };
}

describe('NesStringEdit', () => {
  it('composes edits in post-edit coordinates', () => {
    const first = NesStringEdit.single(
      new NesStringReplacement({ start: 1, endOffset: 1 }, 'X'),
    );
    const second = NesStringEdit.single(
      new NesStringReplacement({ start: 1, endOffset: 2 }, 'Y'),
    );
    expect(first.compose(second).apply('abc')).toBe('aYbc');
  });

  it('rebases a disjoint edit through an earlier insertion', () => {
    const ours = NesStringEdit.single(
      new NesStringReplacement({ start: 2, endOffset: 3 }, 'C'),
    );
    const base = NesStringEdit.single(
      new NesStringReplacement({ start: 0, endOffset: 0 }, '//'),
    );
    expect(ours.tryRebase(base)?.apply('//abc')).toBe('//abC');
  });

  it('normalizes repeated text suffix-first like StringEdit', () => {
    const normalized = new NesStringReplacement(
      { start: 0, endOffset: 5 },
      'baabbb',
    ).removeCommonSuffixAndPrefix('baabb');
    expect(normalized).toMatchObject({
      range: { start: 3, endOffset: 3 },
      newText: 'b',
    });
  });
});

describe('official NES agreement rebase', () => {
  it('composes sequential model edits back into original coordinates', () => {
    expect(
      tryRebaseNesEdits(
        'one\ntwo\nthree',
        undefined,
        [replacement(0, 3, 'first'), replacement(6, 9, 'second')],
        NesStringEdit.empty,
        'one\ntwo\nthree',
        undefined,
        'strict',
        rebaseConfig,
      ),
    ).toEqual({
      kind: 'success',
      edits: [
        replacement(0, 3, 'first'),
        replacement(4, 7, 'second'),
      ],
    });
  });

  it('collapses a later overlapping model edit onto the original range', () => {
    expect(
      tryRebaseNesEdits(
        'abcdef',
        undefined,
        [replacement(1, 3, 'X'), replacement(1, 2, 'YZ')],
        NesStringEdit.empty,
        'abcdef',
        undefined,
        'strict',
        rebaseConfig,
      ),
    ).toEqual({
      kind: 'success',
      edits: [replacement(1, 3, 'YZ')],
    });
  });

  it('expands a coarse multiline model edit to the changed line only', () => {
    expect(
      tryRebaseNesEdits(
        'abc\ndef',
        undefined,
        [replacement(0, 7, 'abc\ndXf')],
        NesStringEdit.empty,
        'abc\ndef',
        undefined,
        'strict',
        rebaseConfig,
      ),
    ).toEqual({
      kind: 'success',
      edits: [replacement(4, 7, 'dXf')],
    });
  });

  it('preserves disjoint detailed changes from one coarse model edit', () => {
    const original = 'one\nmiddle\nthree';
    const userEdit = NesStringEdit.single(
      new NesStringReplacement({ start: 11, endOffset: 12 }, 'T'),
    );
    expect(
      tryRebaseNesEdits(
        original,
        undefined,
        [replacement(0, 16, 'ONE\nmiddle\nTHREE')],
        userEdit,
        userEdit.apply(original),
        undefined,
        'strict',
        rebaseConfig,
      ),
    ).toEqual({
      kind: 'success',
      edits: [replacement(0, 16, 'ONE\nmiddle\nTHREE')],
    });
  });

  it('keeps lenient user text between disjoint detailed changes', () => {
    const original = 'one\nmiddle\nthree';
    const userEdit = NesStringEdit.single(
      new NesStringReplacement({ start: 6, endOffset: 7 }, 'X'),
    );
    expect(
      tryRebaseNesEdits(
        original,
        undefined,
        [replacement(0, 16, 'ONE\nmiddle\nTHREE')],
        userEdit,
        userEdit.apply(original),
        undefined,
        'lenient',
        rebaseConfig,
      ),
    ).toEqual({
      kind: 'success',
      edits: [replacement(0, 16, 'ONE\nmiXdle\nTHREE')],
    });
  });

  it('uses the official subword diff for a coarse single-line edit', () => {
    const original = 'const value = 1;';
    expect(
      tryRebaseNesEdits(
        original,
        undefined,
        [replacement(0, 16, 'const value = 2;')],
        NesStringEdit.empty,
        original,
        undefined,
        'strict',
        rebaseConfig,
      ),
    ).toEqual({
      kind: 'success',
      edits: [replacement(14, 15, '2')],
    });
  });

  it('classifies an inconsistent sequential compose as an error', () => {
    expect(
      tryRebaseNesEdits(
        'bcbaXca',
        undefined,
        [replacement(4, 6, ')Zb'), replacement(6, 6, 'Y')],
        NesStringEdit.empty,
        'bcbaXca',
        undefined,
        'strict',
        rebaseConfig,
      ),
    ).toEqual({ kind: 'error' });
  });

  it('absorbs compatible type-through while retaining the official replacement range', () => {
    const original = 'function fi';
    const userEdit = NesStringEdit.single(
      new NesStringReplacement(
        { start: original.length, endOffset: original.length },
        'b',
      ),
    );
    const current = userEdit.apply(original);
    const result = tryRebaseNesEdits(
      original,
      { start: 0, endOffset: original.length },
      [insertion(original.length, 'bonacci')],
      userEdit,
      current,
      original.length + 1,
      'strict',
      rebaseConfig,
    );
    expect(result).toEqual({
      kind: 'success',
      edits: [
        expect.objectContaining({
          startOffset: original.length,
          endOffset: original.length + 1,
          newText: 'bonacci',
        }),
      ],
    });
  });

  it('rejects incompatible type-through', () => {
    const original = 'function fi';
    const userEdit = NesStringEdit.single(
      new NesStringReplacement(
        { start: original.length, endOffset: original.length },
        'x',
      ),
    );
    expect(
      tryRebaseNesEdits(
        original,
        undefined,
        [insertion(original.length, 'bonacci')],
        userEdit,
        userEdit.apply(original),
        undefined,
        'strict',
        rebaseConfig,
      ).kind,
    ).toBe('rebaseFailed');
  });

  it('absorbs an editor auto-close pair as a subsequence', () => {
    const original = 'call';
    const userEdit = NesStringEdit.single(
      new NesStringReplacement(
        { start: original.length, endOffset: original.length },
        '()',
      ),
    );
    const result = tryRebaseNesEdits(
      original,
      undefined,
      [insertion(original.length, '(value)')],
      userEdit,
      userEdit.apply(original),
      undefined,
      'strict',
      rebaseConfig,
    );
    expect(result).toEqual({
      kind: 'success',
      edits: [
        expect.objectContaining({
          startOffset: original.length,
          endOffset: original.length + 2,
          newText: '(value)',
        }),
      ],
    });
  });

  it('uses reverse agreement when the user typed beyond the model edit', () => {
    const original = 'foo';
    const userEdit = NesStringEdit.single(
      new NesStringReplacement({ start: 3, endOffset: 3 }, 'barbaz'),
    );
    expect(
      tryRebaseNesEdits(
        original,
        undefined,
        [insertion(3, 'bar')],
        userEdit,
        userEdit.apply(original),
        undefined,
        'strict',
        rebaseConfig,
      ),
    ).toEqual({ kind: 'success', edits: [] });
  });

  it('enforces the rebased selection window', () => {
    const original = 'const value = 1;';
    const userEdit = NesStringEdit.single(
      new NesStringReplacement({ start: 0, endOffset: 0 }, '// '),
    );
    expect(
      tryRebaseNesEdits(
        original,
        { start: 5, endOffset: 10 },
        [insertion(8, 'x')],
        userEdit,
        userEdit.apply(original),
        0,
        'strict',
        rebaseConfig,
      ),
    ).toEqual({ kind: 'outsideEditWindow' });
  });

  it('classifies malformed replacement ranges as rebase errors', () => {
    const malformed: NesTextEdit = {
      uri: 'file:///main.ts',
      startOffset: 4,
      endOffset: 2,
      newText: 'x',
      kind: 'replace',
    };
    expect(
      tryRebaseNesEdits(
        'value',
        undefined,
        [malformed],
        NesStringEdit.empty,
        'value',
        undefined,
        'strict',
        rebaseConfig,
      ),
    ).toEqual({ kind: 'error' });
  });
});

import { describe, expect, it } from 'vitest';
import {
  getCurrentLineAfterIntermediateEdit,
  isIntermediateModelLineCompatible,
  isModelLineCompatible,
} from '../../src/chat-lib/core/nes/stream-compatibility';
import {
  NesStringEdit,
  NesStringReplacement,
} from '../../src/chat-lib/core/nes/string-edit';

describe('NES intermediate stream compatibility', () => {
  it('accepts type-through and auto-close subsequences', () => {
    expect(
      isModelLineCompatible(
        'function fi',
        'function fib',
        'function fibonacci(n): number',
      ),
    ).toBe(true);
    expect(isModelLineCompatible('call', 'call()', 'call(value)')).toBe(true);
  });

  it('rejects edits outside the model range and incompatible typing', () => {
    expect(
      isModelLineCompatible(
        'function fi',
        'function fix',
        'function fibonacci(n): number',
      ),
    ).toBe(false);
    expect(isModelLineCompatible('a = 1', 'b = 1', 'a = 2')).toBe(false);
  });

  it('maps original line offsets through edits above the checked line', () => {
    const original = 'first\nfunction fi\nlast';
    const edit = new NesStringEdit([
      new NesStringReplacement({ start: 0, endOffset: 0 }, 'header\n'),
      new NesStringReplacement({ start: 17, endOffset: 17 }, 'b'),
    ]);
    expect(getCurrentLineAfterIntermediateEdit(original, 1, edit)).toBe(
      'function fib',
    );
  });

  it('maps a replacement that starts exactly at the checked line', () => {
    const edit = NesStringEdit.single(
      new NesStringReplacement({ start: 0, endOffset: 3 }, 'aabb'),
    );
    expect(getCurrentLineAfterIntermediateEdit('aab', 0, edit)).toBe('aabb');
  });

  it('rejects an original line start covered from an earlier line', () => {
    const original = 'first\nsecond';
    const edit = NesStringEdit.single(
      new NesStringReplacement({ start: 2, endOffset: 8 }, 'x'),
    );
    expect(
      getCurrentLineAfterIntermediateEdit(original, 1, edit),
    ).toBeUndefined();
  });

  it('preserves CRLF and isolated-CR line contents', () => {
    expect(
      getCurrentLineAfterIntermediateEdit(
        'first\r\nsecond',
        1,
        NesStringEdit.empty,
      ),
    ).toBe('second');
    expect(
      getCurrentLineAfterIntermediateEdit(
        'first\rsecond',
        1,
        NesStringEdit.empty,
      ),
    ).toBe('second');
  });

  it('checks only the configured cursor line', () => {
    const original = 'first\nfunction fi\nlast';
    const edit = NesStringEdit.single(
      new NesStringReplacement({ start: 17, endOffset: 17 }, 'b'),
    );
    const common = {
      mode: 'cursor' as const,
      cursorLineIndex: 1,
      editWindowStartLine: 0,
      editWindowLines: original.split('\n'),
      originalText: original,
      intermediateEdit: edit,
    };
    expect(
      isIntermediateModelLineCompatible({
        ...common,
        localLineIndex: 0,
        modelLine: 'unrelated',
      }),
    ).toBe(true);
    expect(
      isIntermediateModelLineCompatible({
        ...common,
        localLineIndex: 1,
        modelLine: 'function fibonacci',
      }),
    ).toBe(true);
    expect(
      isIntermediateModelLineCompatible({
        ...common,
        localLineIndex: 1,
        modelLine: 'function fix',
      }),
    ).toBe(false);
  });
});

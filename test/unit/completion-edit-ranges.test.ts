import { describe, expect, it } from 'vitest';
import {
  computeCursorExcerpt,
  computeEditableAndContextRanges,
} from '../../src/completion/edit/ranges';
import { utf8ByteOffsetToUtf16Offset } from '../../src/completion/edit/utf8';

describe('edit prediction UTF-8 ranges', () => {
  it('keeps CRLF outside logical row ends and reports a UTF-8 cursor offset', () => {
    const text = 'alpha α\r\nbeta 🙂\r\ngamma\r\n';
    const cursor = text.indexOf('🙂');
    const excerpt = computeCursorExcerpt(text, cursor);

    expect(excerpt.text).toBe(text);
    expect(excerpt.cursorByteOffset).toBe(
      Buffer.byteLength(text.slice(0, cursor)),
    );
    expect(excerpt.byteRange.end).toBe(Buffer.byteLength(text));
  });

  it('does not treat UTF-8 byte line starts as UTF-16 offsets', () => {
    const before = `${'α'.repeat(100)}\r\n`;
    const current = 'β\r\n';
    const after = 'γ'.repeat(100);
    const text = `${before}${current}${after}`;
    const cursorByte = Buffer.byteLength(before);
    const result = computeEditableAndContextRanges(
      text,
      cursorByte,
      [],
      1,
      0,
    );

    expect(result.editable).toEqual({
      start: cursorByte,
      end: cursorByte + Buffer.byteLength('β'),
    });
    expect(utf8ByteOffsetToUtf16Offset(text, result.editable.start)).toBe(
      before.length,
    );
    expect(utf8ByteOffsetToUtf16Offset(text, result.editable.end)).toBe(
      before.length + 1,
    );
  });
});

import { describe, expect, it } from 'vitest';
import {
  computeReducedNesWindow,
  cursorAfterNesEditWindow,
} from '../../src/chat-lib/core/nes/cache-window';

describe('NES cache windows', () => {
  it('matches the pinned reduced-window position arithmetic', () => {
    const text = Array.from({ length: 10 }, (_value, index) => `L${index}`).join(
      '\n',
    );
    expect(
      computeReducedNesWindow(
        text,
        { startOffset: 3, endOffset: 24 },
        15,
      ),
    ).toEqual({ startOffset: 6, endOffset: 18 });
  });

  it('moves after the window to the next line including a trailing empty line', () => {
    expect(cursorAfterNesEditWindow('one\ntwo\n', 7)).toBe(8);
    expect(cursorAfterNesEditWindow('one\ntwo', 7)).toBe(4);
  });
});

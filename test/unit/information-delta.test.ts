import { describe, expect, it } from 'vitest';
import {
  applyOffsetTextReplacements,
  getInformationDelta,
} from '../../src/chat-lib/core/information-delta';

describe('Copilot InformationDelta parity', () => {
  it('detects a semantic undo even when the candidate is not an exact revert', () => {
    const before = 'const descriptiveOriginalName = sourceValue;\n';
    const start = before.indexOf('descriptiveOriginalName');
    const end = start + 'descriptiveOriginalName'.length;
    const userEdit = {
      startOffset: start,
      endOffset: end,
      newText: 'meaningfulReplacementName',
    };
    const after = applyOffsetTextReplacements(before, [userEdit]);
    const candidate = {
      startOffset: after.indexOf('meaningfulReplacementName'),
      endOffset:
        after.indexOf('meaningfulReplacementName') +
        'meaningfulReplacementName'.length,
      newText: 'descriptiveOriginalNameWithSuffix',
    };

    expect(
      getInformationDelta(before, userEdit).isUndoneBy(
        getInformationDelta(after, candidate),
      ),
    ).toBe(true);
    expect(applyOffsetTextReplacements(after, [candidate])).not.toBe(before);
  });

  it('does not treat an unrelated edit as an undo', () => {
    const source = 'const descriptiveOriginalName = sourceValue;\n';
    const userEdit = {
      startOffset: source.indexOf('sourceValue'),
      endOffset: source.indexOf('sourceValue') + 'sourceValue'.length,
      newText: 'replacementValue',
    };
    const after = applyOffsetTextReplacements(source, [userEdit]);
    const unrelated = {
      startOffset: 0,
      endOffset: 0,
      newText: 'import { helper } from "./helper";\n',
    };

    expect(
      getInformationDelta(source, userEdit).isUndoneBy(
        getInformationDelta(after, unrelated),
      ),
    ).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';
import {
  fimNotebookLineInActiveCell,
  prepareFimNotebookContext,
} from '../../src/completion/copilot/fim-notebook-context';

describe('FIM notebook context', () => {
  it('prepends compatible cells, comments aliases, and maps the active cursor', () => {
    const activeText = 'const active = shared;';
    const result = prepareFimNotebookContext({
      activeCellIndex: 3,
      activeLanguageId: 'typescript',
      activeText,
      activeCursorOffset: activeText.indexOf('shared') + 3,
      cells: [
        {
          index: 0,
          languageId: 'typescript',
          text: 'const shared = 1;',
        },
        {
          index: 1,
          languageId: 'typescriptreact',
          text: 'const component = <div />;',
        },
        {
          index: 2,
          languageId: 'python',
          text: 'shared = 2',
        },
        {
          index: 3,
          languageId: 'typescript',
          text: activeText,
        },
        {
          index: 4,
          languageId: 'typescript',
          text: 'const after = true;',
        },
      ],
    });

    expect(result.prependedText).toBe(
      'const shared = 1;\n\n// const component = <div />;\n\n',
    );
    expect(result.text).toBe(`${result.prependedText}${activeText}`);
    expect(result.cursorOffset).toBe(
      result.activeCellOffset + activeText.indexOf('shared') + 3,
    );
    expect(result.activeCellLineOffset).toBe(4);
    expect(
      fimNotebookLineInActiveCell(4, result.activeCellLineOffset),
    ).toBe(0);
  });

  it('preserves the active document when no earlier cell is compatible', () => {
    expect(
      prepareFimNotebookContext({
        activeCellIndex: 1,
        activeLanguageId: 'typescript',
        activeText: 'const active = true;',
        activeCursorOffset: 6,
        cells: [
          { index: 0, languageId: 'python', text: 'active = True' },
          {
            index: 1,
            languageId: 'typescript',
            text: 'const active = true;',
          },
        ],
      }),
    ).toEqual({
      text: 'const active = true;',
      cursorOffset: 6,
      activeCellOffset: 0,
      activeCellLineOffset: 0,
      prependedText: '',
    });
  });
});

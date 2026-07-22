import { describe, expect, it } from 'vitest';
import { COPILOT_BEHAVIOR_CONFIG } from '../../src/chat-lib/core/behavior-config';
import {
  buildCursorPredictionPrompt,
  CURSOR_PREDICTION_CURRENT_FILE_MAX_TOKENS,
  CURSOR_PREDICTION_PROMPT_CONFIG,
  decideCursorPrediction,
  NEXT_CURSOR_PREDICTION_SYSTEM_MESSAGE,
  parseCursorPredictionResponse,
  stripCursorPredictionThinkBlocks,
  type CursorPredictionPrompt,
  type CursorPredictionPromptResult,
} from '../../src/chat-lib/core/nes/cursor-predictor';
import { buildOfficialNesPrompt } from '../../src/chat-lib/core/nes/prompt';
import type {
  NesDocumentContext,
  NesPromptContext,
} from '../../src/chat-lib/core/nes/types';

function document(
  relativePath: string,
  text: string,
  overrides: Partial<NesDocumentContext> = {},
): NesDocumentContext {
  return {
    uri: `file:///workspace/${relativePath}`,
    path: `/workspace/${relativePath}`,
    relativePath,
    languageId: 'typescript',
    version: 1,
    text,
    workspaceRoot: '/workspace',
    ...overrides,
  };
}

function offsetAtLine(text: string, line: number, character = 0): number {
  const lines = text.split('\n');
  return (
    lines.slice(0, line).reduce((total, value) => total + value.length + 1, 0) +
    character
  );
}

function contextFor(text: string, cursorLine: number): NesPromptContext {
  const current = document('src/main.ts', text);
  return {
    current,
    cursorOffset: offsetAtLine(text, cursorLine, 4),
    recentDocuments: [
      document('src/recent.ts', 'export const recentContext = true;', {
        lastViewedAt: 2,
        visibleRanges: [{ start: 0, end: 34 }],
      }),
    ],
    editHistory: [
      {
        uri: current.uri,
        path: current.relativePath ?? current.path,
        languageId: current.languageId,
        before: text.replace('value1', 'oldValue1'),
        after: text,
        timestamp: 1,
      },
    ],
    diagnostics: [
      {
        message: 'Controlled cursor diagnostic',
        severity: 'warning',
        startLine: cursorLine,
        endLine: cursorLine,
        source: 'ts',
      },
    ],
    languageContext: {
      symbols: [
        {
          name: 'cursorTarget',
          kind: 'Function',
          startLine: cursorLine,
          endLine: cursorLine + 1,
        },
      ],
    },
  };
}

function unwrapPrompt(result: CursorPredictionPromptResult): CursorPredictionPrompt {
  if (!result.ok) {
    throw new Error(`Cursor prompt failed: ${result.reason}`);
  }
  return result.prompt;
}

describe('cursor prediction prompt', () => {
  it('keeps the upstream system message byte-for-byte', () => {
    expect(NEXT_CURSOR_PREDICTION_SYSTEM_MESSAGE).toBe(
      "Your task is to predict the line number where the developer is most likely to make their next edit. If you jump in the current file, just output the line number. If you want to jump to another file, output the filepath (relative to workspace root), colon, then line number. If you don't think anywhere is a good next line jump target, just output the current line number of the cursor. Make sure to output no explanation, reasoning, extra spaces, etc.",
    );
    expect(COPILOT_BEHAVIOR_CONFIG.nextEdit.cursorPrediction).toEqual({
      mode: 'onlyWithEdit',
      currentFileMaxTokens: 3_000,
      maxResponseTokens: 40,
    });
    expect(CURSOR_PREDICTION_PROMPT_CONFIG).toEqual({
      currentFileIncludeTags: false,
      currentFileLineNumbers: 'withSpaceAfter',
      recentSnippetsLineNumbers: 'none',
      includePostScript: false,
      lintOptions: {
        tagName: 'linter',
        warnings: 'yesIfNoErrors',
        showCode: 'yesWithSurroundingLines',
        maxLints: 5,
        maxLineDistance: 1_000,
        nRecentFiles: 0,
      },
    });
    expect(COPILOT_BEHAVIOR_CONFIG.nextEdit.filterSubstrings).toEqual([
      '<|current_file_content|>',
      '<|/current_file_content|>',
      '<|' + 'diff_marker' + '|>',
    ]);
    expect(COPILOT_BEHAVIOR_CONFIG.nextEdit.undoInsertionFiltering).toBe('v1');
  });

  it('reuses current context, numbers current-file lines, and removes the edit postscript', () => {
    const lines = Array.from(
      { length: 40 },
      (_value, index) => `const value${index} = ${index};`,
    );
    const context = contextFor(lines.join('\n'), 20);
    const behaviorConfig = {
      ...COPILOT_BEHAVIOR_CONFIG,
      prompt: {
        ...COPILOT_BEHAVIOR_CONFIG.prompt,
        recentFilesIncludeViewed: true,
        languageContextEnabled: true,
      },
    };
    const currentPrompt = buildOfficialNesPrompt(
      context,
      'xtab275',
      behaviorConfig,
    );
    const cursorPrompt = unwrapPrompt(
      buildCursorPredictionPrompt(context, currentPrompt, {
        behaviorConfig,
      }),
    );

    expect(currentPrompt.editWindow).toMatchObject({
      startLine: 18,
      cursorLineOffset: 20,
      endLineExclusive: 26,
    });
    expect(cursorPrompt.messages).toHaveLength(2);
    expect(cursorPrompt.messages[0]).toEqual({
      role: 'system',
      content: NEXT_CURSOR_PREDICTION_SYSTEM_MESSAGE,
    });
    expect(cursorPrompt.messages[1].role).toBe('user');
    expect(cursorPrompt.currentFileContent).toContain('0| const value0 = 0;');
    expect(cursorPrompt.currentFileContent).toContain('20| const value20 = 20;');
    expect(cursorPrompt.messages[1].content).toContain('src/recent.ts');
    expect(cursorPrompt.messages[1].content).toContain(
      'Controlled cursor diagnostic',
    );
    expect(cursorPrompt.messages[1].content).toContain(
      '19|const value19 = 19;',
    );
    expect(cursorPrompt.messages[1].content).toContain(
      '<|code_to_edit|>\nconst value18 = 18;\nconst value19 = 19;\ncons<|cursor|>t value20 = 20;',
    );
    expect(cursorPrompt.messages[1].content).toContain('cursorTarget: Function');
    expect(cursorPrompt.messages[1].content).not.toContain(
      'The developer was working on a section of code within the tags',
    );
    expect(cursorPrompt.keptRange).toEqual({ start: 0, endExclusive: 40 });
    expect(cursorPrompt.currentFileTokens).toBeLessThanOrEqual(
      CURSOR_PREDICTION_CURRENT_FILE_MAX_TOKENS,
    );
  });

  it('clips a long numbered current file around the edit area to 3000 tokens', () => {
    const lines = Array.from(
      { length: 900 },
      (_value, index) =>
        `const longIdentifier${index} = "${'cursor-prediction-context-'.repeat(4)}";`,
    );
    const context = contextFor(lines.join('\n'), 450);
    const currentPrompt = buildOfficialNesPrompt(context, 'xtabUnifiedModel');
    const cursorPrompt = unwrapPrompt(
      buildCursorPredictionPrompt(context, currentPrompt),
    );

    expect(cursorPrompt.currentFileTokens).toBeLessThanOrEqual(3_000);
    expect(cursorPrompt.keptRange.start).toBeGreaterThan(0);
    expect(cursorPrompt.keptRange.endExclusive).toBeLessThan(lines.length);
    expect(cursorPrompt.keptRange.start).toBeLessThanOrEqual(450);
    expect(cursorPrompt.keptRange.endExclusive).toBeGreaterThan(450);
    expect(cursorPrompt.currentFileContent.split('\n')[0]).toBe(
      `${cursorPrompt.keptRange.start}| ${lines[cursorPrompt.keptRange.start]}`,
    );
  });

  it('reports outOfBudget when the preserved page alone exceeds the cap', () => {
    const text = `const huge = "${'very-long-token '.repeat(2_500)}";`;
    const context = contextFor(text, 0);
    const currentPrompt = buildOfficialNesPrompt(
      contextFor('const seed = 1;', 0),
      'copilotNesXtab',
    );
    expect(buildCursorPredictionPrompt(context, currentPrompt)).toEqual({
      ok: false,
      reason: 'outOfBudget',
    });
  });
});

describe('cursor prediction response parsing', () => {
  const keptRange = { start: 2, endExclusive: 8 };

  it('parses an exact zero-based same-file line only inside the kept range', () => {
    expect(parseCursorPredictionResponse('  5\n', keptRange)).toEqual({
      ok: true,
      prediction: { kind: 'sameFile', lineNumber: 5 },
    });
    expect(parseCursorPredictionResponse('8', keptRange)).toEqual({
      ok: false,
      reason: 'modelNotSeenLineNumber',
    });
    expect(parseCursorPredictionResponse('-1', keptRange)).toEqual({
      ok: false,
      reason: 'negativeLineNumber',
    });
    expect(parseCursorPredictionResponse('05', keptRange)).toEqual({
      ok: false,
      reason: 'gotNaN',
    });
  });

  it('parses filepath:line using the final colon and preserves upstream failures', () => {
    expect(
      parseCursorPredictionResponse('src/features/example.ts:12', keptRange),
    ).toEqual({
      ok: true,
      prediction: {
        kind: 'differentFile',
        filePath: 'src/features/example.ts',
        lineNumber: 12,
      },
    });
    expect(parseCursorPredictionResponse('src/example.ts:-1', keptRange)).toEqual(
      { ok: false, reason: 'crossFileInvalidLineNumber' },
    );
    expect(parseCursorPredictionResponse(' :4', keptRange)).toEqual({
      ok: false,
      reason: 'gotNaN',
    });
    expect(parseCursorPredictionResponse('not-a-location', keptRange)).toEqual({
      ok: false,
      reason: 'gotNaN',
    });
  });

  it('removes complete think blocks and drops unterminated leading reasoning', () => {
    expect(
      stripCursorPredictionThinkBlocks(
        '<think>first</think>\n<think>second</think>\n6',
      ),
    ).toBe('6');
    expect(
      parseCursorPredictionResponse('<think>reasoning</think>\n6', keptRange),
    ).toEqual({
      ok: true,
      prediction: { kind: 'sameFile', lineNumber: 6 },
    });
    expect(
      parseCursorPredictionResponse('<think>unfinished reasoning\n6', keptRange),
    ).toEqual({ ok: false, reason: 'gotNaN' });
  });
});

describe('cursor prediction decision', () => {
  const editWindow = { start: 4, endExclusive: 8 };

  it('distinguishes cross-file, bounds, edit-window, and jump decisions', () => {
    expect(
      decideCursorPrediction(
        { kind: 'differentFile', filePath: 'src/other.ts', lineNumber: 10 },
        20,
        editWindow,
      ),
    ).toEqual({
      kind: 'crossFile',
      prediction: {
        kind: 'differentFile',
        filePath: 'src/other.ts',
        lineNumber: 10,
      },
    });
    expect(
      decideCursorPrediction(
        { kind: 'sameFile', lineNumber: 20 },
        20,
        editWindow,
      ),
    ).toEqual({
      kind: 'outOfBounds',
      lineNumber: 20,
      reason: 'exceedsDocumentLines',
    });
    expect(
      decideCursorPrediction(
        { kind: 'sameFile', lineNumber: 6 },
        20,
        editWindow,
      ),
    ).toEqual({ kind: 'withinEditWindow', lineNumber: 6 });
    expect(
      decideCursorPrediction(
        { kind: 'sameFile', lineNumber: 12 },
        20,
        editWindow,
      ),
    ).toEqual({ kind: 'outsideEditWindow', lineNumber: 12 });
  });
});

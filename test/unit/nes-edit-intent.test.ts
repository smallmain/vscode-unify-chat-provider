import { describe, expect, it } from 'vitest';
import {
  parseNesEditIntent,
  shouldShowNesEditIntent,
} from '../../src/chat-lib/core/nes/edit-intent';
import { buildOfficialNesPrompt } from '../../src/chat-lib/core/nes/prompt';
import {
  chunksFromString,
  parseOfficialNesResponse,
} from '../support/nes-response';
import type {
  NesDocumentContext,
  NesPromptContext,
} from '../../src/chat-lib/core/nes/types';

function lines(values: readonly string[]): AsyncIterable<string> {
  return (async function* (): AsyncIterable<string> {
    for (const value of values) {
      yield value;
    }
  })();
}

async function collect(values: AsyncIterable<string>): Promise<string[]> {
  const result: string[] = [];
  for await (const value of values) {
    result.push(value);
  }
  return result;
}

function context(): NesPromptContext {
  const text = ['const zero = 0;', 'const one = 1;', 'console.log(one);'].join(
    '\n',
  );
  const current: NesDocumentContext = {
    uri: 'file:///workspace/src/main.ts',
    path: '/workspace/src/main.ts',
    relativePath: 'src/main.ts',
    languageId: 'typescript',
    version: 1,
    text,
    workspaceRoot: '/workspace',
  };
  return {
    current,
    cursorOffset: text.indexOf('one =') + 'one ='.length,
    recentDocuments: [],
    editHistory: [
      {
        uri: current.uri,
        path: current.path,
        languageId: current.languageId,
        before: text.replace('const one = 1;', 'const one = 0;'),
        after: text,
        timestamp: 1,
      },
    ],
    diagnostics: [],
    languageContext: { symbols: [] },
  };
}

describe('NES edit-intent parser', () => {
  it('removes a valid tag on the first line and preserves trailing content', async () => {
    const parsed = await parseNesEditIntent(
      lines(['prefix<|edit_intent|> Medium <|/edit_intent|> first', 'second']),
      'tags',
    );
    expect(parsed).toMatchObject({ editIntent: 'medium' });
    expect(await collect(parsed.remainingLines)).toEqual([' first', 'second']);
  });

  it('defaults malformed and unknown values to high without hiding code', async () => {
    const malformed = await parseNesEditIntent(
      lines(['<|edit_intent|>low', 'const value = 1;']),
      'tags',
    );
    expect(malformed).toMatchObject({
      editIntent: 'high',
      parseError: 'malformedTag:startWithoutEnd',
    });
    expect(await collect(malformed.remainingLines)).toEqual([
      '<|edit_intent|>low',
      'const value = 1;',
    ]);

    const unknown = await parseNesEditIntent(
      lines(['<|edit_intent|>maybe<|/edit_intent|>', 'code']),
      'tags',
    );
    expect(unknown).toMatchObject({
      editIntent: 'high',
      parseError: 'unknownIntentValue:maybe',
    });
    expect(await collect(unknown.remainingLines)).toEqual(['code']);
  });

  it('accepts only uppercase short names and retains invalid first lines', async () => {
    const valid = await parseNesEditIntent(lines(['L', 'code']), 'shortName');
    expect(valid.editIntent).toBe('low');
    expect(await collect(valid.remainingLines)).toEqual(['code']);

    const invalid = await parseNesEditIntent(lines(['l', 'code']), 'shortName');
    expect(invalid).toMatchObject({
      editIntent: 'high',
      parseError: 'unknownIntentValue:l',
    });
    expect(await collect(invalid.remainingLines)).toEqual(['l', 'code']);
  });

  it('applies the official intent by aggressiveness matrix', () => {
    expect(shouldShowNesEditIntent('no_edit', 'high')).toBe(false);
    expect(shouldShowNesEditIntent('high', 'low')).toBe(true);
    expect(shouldShowNesEditIntent('medium', 'low')).toBe(false);
    expect(shouldShowNesEditIntent('medium', 'medium')).toBe(true);
    expect(shouldShowNesEditIntent('low', 'medium')).toBe(false);
    expect(shouldShowNesEditIntent('low', 'high')).toBe(true);
  });
});

describe('NES aggressiveness prompt and response production path', () => {
  it('renders all official aggressiveness postscript variants', () => {
    const base = context();
    const tagOnly = buildOfficialNesPrompt(
      base,
      'xtabAggressiveness',
      undefined,
      {
        aggressivenessLevel: 'low',
      },
    );
    expect(tagOnly.messages.user).toContain('<|aggressive|>low<|/aggressive|>');
    expect(tagOnly.messages.user).not.toContain('Do not be lazy.');

    const allLevels = buildOfficialNesPrompt(
      base,
      'xtab275Aggressiveness',
      undefined,
      { aggressivenessLevel: 'medium' },
    );
    expect(allLevels.messages.user).toContain('Do not be lazy.');
    expect(allLevels.messages.user).toContain(
      '<|aggressive|>medium<|/aggressive|>',
    );

    const highLowMedium = buildOfficialNesPrompt(
      base,
      'xtab275AggressivenessHighLow',
      undefined,
      { aggressivenessLevel: 'medium' },
    );
    expect(highLowMedium.messages.user).not.toContain('<|aggressive|>');
    const highLowHigh = buildOfficialNesPrompt(
      base,
      'xtab275AggressivenessHighLow',
      undefined,
      { aggressivenessLevel: 'high' },
    );
    expect(highLowHigh.messages.user).toContain(
      '<|aggressive|>high<|/aggressive|>',
    );
  });

  it('filters tagged low/no_edit responses before producing edits', async () => {
    const promptContext = context();
    const mediumPrompt = buildOfficialNesPrompt(
      promptContext,
      'xtab275EditIntent',
      undefined,
      { aggressivenessLevel: 'medium' },
    );
    const changed = [...mediumPrompt.editWindow.lines];
    changed[1] = 'const one = 2;';
    const low = await parseOfficialNesResponse(
      chunksFromString(
        `<|edit_intent|>low<|/edit_intent|>\n${changed.join('\n')}`,
        [1, 2, 3, 5, 8],
      ),
      'xtab275EditIntent',
      mediumPrompt,
      promptContext.current,
      [],
    );
    expect(low).toMatchObject({
      edits: [],
      noChange: true,
      filteredOut: true,
      editIntent: 'low',
      format: 'editWindowWithEditIntent',
    });

    const noEdit = await parseOfficialNesResponse(
      chunksFromString(
        `<|edit_intent|>no_edit<|/edit_intent|>\n${changed.join('\n')}`,
      ),
      'xtab275EditIntent',
      mediumPrompt,
      promptContext.current,
      [],
    );
    expect(noEdit.filteredOut).toBe(true);
  });

  it('shows low intent at high eagerness and parses short intent responses', async () => {
    const promptContext = context();
    const highPrompt = buildOfficialNesPrompt(
      promptContext,
      'xtab275EditIntent',
      undefined,
      { aggressivenessLevel: 'high' },
    );
    const changed = [...highPrompt.editWindow.lines];
    changed[1] = 'const one = 2;';
    const low = await parseOfficialNesResponse(
      chunksFromString(
        `<|edit_intent|>low<|/edit_intent|>\n${changed.join('\n')}`,
      ),
      'xtab275EditIntent',
      highPrompt,
      promptContext.current,
      [],
    );
    expect(low.editIntent).toBe('low');
    expect(low.edits).toHaveLength(1);

    const shortPrompt = buildOfficialNesPrompt(
      promptContext,
      'xtab275EditIntentShort',
      undefined,
      { aggressivenessLevel: 'medium' },
    );
    const short = await parseOfficialNesResponse(
      chunksFromString(`M\n${changed.join('\n')}`, [1, 1, 4]),
      'xtab275EditIntentShort',
      shortPrompt,
      promptContext.current,
      [],
    );
    expect(short).toMatchObject({
      editIntent: 'medium',
      format: 'editWindowWithEditIntentShort',
    });
    expect(short.edits).toHaveLength(1);
  });
});

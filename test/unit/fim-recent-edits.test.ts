import { describe, expect, it } from 'vitest';
import {
  FIM_RECENT_EDITS_CONFIG,
  FimRecentEditsTracker,
} from '../../src/chat-lib/core/ghost-text/recent-edits';

describe('FIM recent edits tracker', () => {
  it('uses the fixed upstream limits and flushes only after the 500ms debounce', () => {
    expect(FIM_RECENT_EDITS_CONFIG).toEqual({
      maxFiles: 20,
      maxEdits: 8,
      diffContextLines: 3,
      editMergeLineDistance: 1,
      maxCharsPerEdit: 2_000,
      debounceTimeoutMs: 500,
      maxLinesPerEdit: 10,
    });
    const tracker = new FimRecentEditsTracker();
    const event = {
      uri: 'file:///workspace/src/edit.ts',
      path: 'src/edit.ts',
      before: 'const zero = 0;\nconst value = 1;\nconst tail = true;',
      after: 'const zero = 0;\nconst value = 2;\nconst tail = true;',
      timestamp: 1_000,
    };

    expect(tracker.ingest([event], 1_499)).toEqual([]);
    expect(tracker.getState()).toMatchObject({ pendingFiles: 1, edits: 0 });
    const flushed = tracker.ingest([event], 1_500);
    expect(flushed).toHaveLength(1);
    expect(flushed[0]).toMatchObject({
      path: 'src/edit.ts',
      startLine: 1,
      endLine: 1,
    });
    expect(flushed[0].summary).toContain('+const value = 2;');
    expect(flushed[0].summary).toContain(
      '-const value = 1; --- IGNORE ---',
    );
    expect(flushed[0].summary.indexOf('+const value = 2;')).toBeLessThan(
      flushed[0].summary.indexOf('-const value = 1;'),
    );
  });

  it('coalesces bursts, merges adjacent edits, and filters whitespace-only summaries', () => {
    const tracker = new FimRecentEditsTracker();
    const base = 'const a = 1;\nconst b = 2;\nconst c = 3;\nconst d = 4;';
    const first = 'const a = 10;\nconst b = 2;\nconst c = 3;\nconst d = 4;';
    const second = 'const a = 10;\nconst b = 20;\nconst c = 3;\nconst d = 4;';
    const events = [
      {
        uri: 'file:///workspace/src/burst.ts',
        path: 'src/burst.ts',
        before: base,
        after: first,
        timestamp: 100,
      },
      {
        uri: 'file:///workspace/src/burst.ts',
        path: 'src/burst.ts',
        before: first,
        after: second,
        timestamp: 400,
      },
    ];

    expect(tracker.ingest(events, 899)).toEqual([]);
    const summaries = tracker.ingest(events, 900);
    expect(summaries).toHaveLength(1);
    expect(summaries[0].summary).toContain('+const a = 10;');
    expect(summaries[0].summary).toContain('+const b = 20;');

    const whitespace = new FimRecentEditsTracker();
    const whitespaceEvent = {
      uri: 'file:///workspace/src/space.ts',
      path: 'src/space.ts',
      before: 'const value = 1;',
      after: '  const value = 1;  ',
      timestamp: 1,
    };
    expect(whitespace.ingest([whitespaceEvent], 501)).toEqual([]);
  });

  it('drops summaries over the ten-line limit and resets edits over 2000 chars', () => {
    const tooManyLines = new FimRecentEditsTracker();
    const lineEvent = {
      uri: 'file:///workspace/src/lines.ts',
      path: 'src/lines.ts',
      before: 'before',
      after: Array.from({ length: 11 }, (_, index) => `line ${index}`).join('\n'),
      timestamp: 1,
    };
    expect(tooManyLines.ingest([lineEvent], 501)).toEqual([]);
    expect(tooManyLines.getState().edits).toBe(1);

    const tooManyCharacters = new FimRecentEditsTracker();
    const characterEvent = {
      uri: 'file:///workspace/src/large.ts',
      path: 'src/large.ts',
      before: 'before',
      after: 'x'.repeat(2_001),
      timestamp: 1,
    };
    expect(tooManyCharacters.ingest([characterEvent], 501)).toEqual([]);
    expect(tooManyCharacters.getState().edits).toBe(0);
  });

  it('preserves prior state across a file over 2MB and resumes from the small-file baseline', () => {
    const tracker = new FimRecentEditsTracker();
    const base = [
      'const value = 1;',
      ...Array.from({ length: 6 }, (_, index) => `const stable${index} = true;`),
      'const tail = 1;',
    ].join('\n');
    const first = base.replace('value = 1', 'value = 2');
    const recovered = first.replace('tail = 1', 'tail = 2');
    const uri = 'file:///workspace/src/large-transition.ts';
    const path = 'src/large-transition.ts';

    const firstSummaries = tracker.ingest(
      [{ uri, path, before: base, after: first, timestamp: 100 }],
      600,
    );
    expect(firstSummaries).toHaveLength(1);
    expect(firstSummaries[0].summary).toContain('+const value = 2;');

    const oversized = 'x'.repeat(2 * 1024 * 1024 + 1);
    const preserved = tracker.ingest(
      [{ uri, path, before: first, after: oversized, timestamp: 700 }],
      1_200,
    );
    expect(preserved).toEqual(firstSummaries);
    expect(tracker.getState().edits).toBe(1);

    const resumed = tracker.ingest(
      [{ uri, path, before: oversized, after: recovered, timestamp: 1_300 }],
      1_800,
    );
    expect(resumed).toHaveLength(2);
    expect(resumed[1].summary).toContain('+const tail = 2;');
    expect(resumed[1].summary).toContain('-const tail = 1; --- IGNORE ---');
  });
});

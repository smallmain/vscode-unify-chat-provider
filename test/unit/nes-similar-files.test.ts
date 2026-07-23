import { describe, expect, it } from 'vitest';
import {
  DEFAULT_NES_SIMILAR_FILES_OPTIONS,
  selectNesNeighborSnippets,
} from '../../src/chat-lib/core/nes/similar-files';
import type { NesDocumentContext } from '../../src/chat-lib/core/nes/types';

function document(relativePath: string, text: string): NesDocumentContext {
  return {
    uri: `file:///workspace/${relativePath}`,
    path: `/workspace/${relativePath}`,
    relativePath,
    languageId: 'typescript',
    version: 1,
    text,
    workspaceRoot: '/workspace',
  };
}

describe('official NES similar-file selection', () => {
  it('uses case-sensitive 60-line sliding Jaccard windows and returns low-to-high scores', () => {
    const referenceLines = Array.from(
      { length: 60 },
      (_value, index) => `needle${index}`,
    );
    const current = document(
      'src/current.ts',
      ['outsideCursorWindow', ...referenceLines].join('\n'),
    );
    const exact = document(
      'src/exact.ts',
      [
        ...Array.from({ length: 5 }, (_value, index) => `noise${index}`),
        ...referenceLines,
      ].join('\n'),
    );
    const partial = document('src/partial.ts', 'needle0');
    const wrongCase = document('src/wrong-case.ts', 'NEEDLE0');

    const result = selectNesNeighborSnippets(
      current,
      current.text.length,
      [exact, partial, wrongCase],
    );

    expect(result.map((snippet) => snippet.path)).toEqual([
      'src/partial.ts',
      'src/exact.ts',
    ]);
    expect(result[0]).toMatchObject({ startLine: 0, score: 1 / 60 });
    expect(result[1]).toMatchObject({ startLine: 5, score: 1 });
    expect(result[1].snippet).toBe(referenceLines.join('\n'));
  });

  it('applies the official strict character, file, and top-snippet limits', () => {
    const current = document('src/current.ts', 'uniqueToken');
    const candidates = Array.from({ length: 25 }, (_value, index) =>
      document(`src/${index}.ts`, `uniqueToken candidate${index}`),
    );
    candidates[0] = document(
      'src/too-long.ts',
      `uniqueToken${'x'.repeat(DEFAULT_NES_SIMILAR_FILES_OPTIONS.maxCharPerFile)}`,
    );

    const result = selectNesNeighborSnippets(
      current,
      current.text.length,
      candidates,
    );

    expect(result).toHaveLength(DEFAULT_NES_SIMILAR_FILES_OPTIONS.maxTopSnippets);
    expect(result.some((snippet) => snippet.path === 'src/too-long.ts')).toBe(false);
    expect(result.every((snippet) => {
      const index = Number(snippet.path?.match(/src\/(\d+)\.ts/)?.[1]);
      return index <= DEFAULT_NES_SIMILAR_FILES_OPTIONS.maxNumberOfFiles;
    })).toBe(true);
  });
});

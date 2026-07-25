import { describe, expect, it } from 'vitest';
import {
  DEFAULT_COMPLETION_DISABLED_GLOBS,
  matchesCompletionDisabledGlob,
  mergeCompletionDisabledGlobs,
} from '../../src/completion/disabled-globs';

describe('completion disabled globs', () => {
  it('merges immutable defaults with trimmed, de-duplicated user patterns', () => {
    expect(
      mergeCompletionDisabledGlobs([
        ' **/*.generated.ts ',
        '**/*.generated.ts',
        '**/.env*',
      ]),
    ).toEqual([
      ...DEFAULT_COMPLETION_DISABLED_GLOBS,
      '**/*.generated.ts',
    ]);
  });

  it('matches dotfiles, credential extensions, custom patterns, and Windows paths', () => {
    const patterns = mergeCompletionDisabledGlobs(['private/**']);
    for (const path of [
      '.env',
      'apps/web/.env.local',
      'keys/deploy.pem',
      'keys\\deploy.key',
      'private/generated.ts',
    ]) {
      expect(matchesCompletionDisabledGlob(path, patterns)).toBe(true);
    }
    expect(matchesCompletionDisabledGlob('src/main.ts', patterns)).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_COMPLETION_STRATEGY,
  normalizeCompletionConfiguration,
} from '../../src/completion/configuration';
import { DEFAULT_COMPLETION_DISABLED_GLOBS } from '../../src/completion/disabled-globs';

describe('completion configuration', () => {
  it('normalizes providers, removes duplicate IDs, and preserves workspace values', () => {
    const result = normalizeCompletionConfiguration({
      enabled: false,
      providers: [
        { id: ' primary ', algorithm: 'simple', options: { model: 'x' } },
        { id: 'primary', algorithm: 'copilot-replica' },
        { id: '', algorithm: 'simple' },
      ],
      strategy: {
        mode: 'main-first',
        disableVSCodeBuiltinCompletion: false,
        disabledGlobs: [...DEFAULT_COMPLETION_DISABLED_GLOBS],
        mainProvider: ' primary ',
        mainFirstTimeoutMs: 25,
        parallelRequestOthers: true,
        stopWhen: { type: 'enoughResults', minItems: 2, graceMs: 5 },
      },
    });

    expect(result.configuration).toEqual({
      enabled: false,
      providers: [
        { id: 'primary', algorithm: 'simple', options: { model: 'x' } },
      ],
      strategy: {
        mode: 'main-first',
        disableVSCodeBuiltinCompletion: false,
        disabledGlobs: [...DEFAULT_COMPLETION_DISABLED_GLOBS],
        mainProvider: 'primary',
        mainFirstTimeoutMs: 25,
        parallelRequestOthers: true,
        stopWhen: { type: 'enoughResults', minItems: 2, graceMs: 5 },
      },
    });
    expect(result.issues).toHaveLength(2);
  });

  it('rejects unpublished legacy algorithm IDs without aliases', () => {
    const result = normalizeCompletionConfiguration({
      enabled: true,
      providers: [
        { id: 'legacy-simple', algorithm: 'fim' },
        { id: 'legacy-copilot', algorithm: 'copilot' },
      ],
      strategy: undefined,
    });

    expect(result.configuration.providers).toEqual([]);
    expect(result.issues).toHaveLength(2);
  });

  it('falls back to the default strategy for invalid values', () => {
    const result = normalizeCompletionConfiguration({
      enabled: undefined,
      providers: undefined,
      strategy: { mode: 'unknown', stopWhen: { type: 'deadline' } },
    });

    expect(result.configuration.enabled).toBe(true);
    expect(result.configuration.providers).toEqual([]);
    expect(result.configuration.strategy).toEqual(DEFAULT_COMPLETION_STRATEGY);
    expect(result.issues.length).toBeGreaterThan(0);
  });

  it('defaults a missing or invalid built-in completion switch to true', () => {
    const missing = normalizeCompletionConfiguration({
      enabled: true,
      providers: [],
      strategy: { mode: 'all', stopWhen: { type: 'allSettled' } },
    });
    const invalid = normalizeCompletionConfiguration({
      enabled: true,
      providers: [],
      strategy: {
        mode: 'all',
        disableVSCodeBuiltinCompletion: 'false',
        stopWhen: { type: 'allSettled' },
      },
    });

    expect(missing.configuration.strategy.disableVSCodeBuiltinCompletion).toBe(
      true,
    );
    expect(invalid.configuration.strategy.disableVSCodeBuiltinCompletion).toBe(
      true,
    );
  });

  it('merges user disabled globs with defaults and reports invalid values', () => {
    const valid = normalizeCompletionConfiguration({
      enabled: true,
      providers: [],
      strategy: {
        mode: 'all',
        disabledGlobs: [' **/*.generated.ts ', '**/.env*'],
        stopWhen: { type: 'allSettled' },
      },
    });
    expect(valid.configuration.strategy.disabledGlobs).toEqual([
      ...DEFAULT_COMPLETION_DISABLED_GLOBS,
      '**/*.generated.ts',
    ]);

    const invalid = normalizeCompletionConfiguration({
      enabled: true,
      providers: [],
      strategy: {
        mode: 'all',
        disabledGlobs: ['**/*.secret', 1],
        stopWhen: { type: 'allSettled' },
      },
    });
    expect(invalid.configuration.strategy.disabledGlobs).toEqual([
      ...DEFAULT_COMPLETION_DISABLED_GLOBS,
      '**/*.secret',
    ]);
    expect(invalid.issues).toContainEqual({ code: 'disabled-globs-invalid' });
  });
});

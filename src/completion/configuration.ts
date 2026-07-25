import type {
  CompletionAlgorithmId,
  CompletionAlgorithmEntry,
  CompletionConfiguration,
  CompletionStopCondition,
  CompletionStrategy,
} from './types';
import {
  DEFAULT_COMPLETION_DISABLED_GLOBS,
  mergeCompletionDisabledGlobs,
} from './disabled-globs';

export const DEFAULT_COMPLETION_STRATEGY: CompletionStrategy = {
  mode: 'all',
  disableVSCodeBuiltinCompletion: true,
  disabledGlobs: DEFAULT_COMPLETION_DISABLED_GLOBS,
  stopWhen: { type: 'firstUsable', graceMs: 0 },
};

export interface CompletionConfigurationResult {
  configuration: CompletionConfiguration;
  issues: CompletionConfigurationIssue[];
}

export type CompletionConfigurationIssue =
  | { readonly code: 'entry-not-object'; readonly index: number }
  | { readonly code: 'entry-missing-id'; readonly index: number }
  | { readonly code: 'entry-unknown-algorithm'; readonly id: string }
  | { readonly code: 'entry-invalid-options'; readonly id: string }
  | { readonly code: 'stop-when-invalid' }
  | { readonly code: 'deadline-invalid' }
  | { readonly code: 'enough-results-invalid' }
  | { readonly code: 'unknown-stop-condition'; readonly value: string }
  | { readonly code: 'strategy-not-object' }
  | { readonly code: 'unknown-strategy-mode'; readonly value: string }
  | { readonly code: 'disabled-globs-invalid' }
  | { readonly code: 'duplicate-entry-id'; readonly id: string }
  | { readonly code: 'providers-not-array' };

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isAlgorithmId(value: unknown): value is CompletionAlgorithmId {
  return (
    value === 'simple' ||
    value === 'copilot-replica' ||
    value === 'zed' ||
    value === 'inception' ||
    value === 'mistral'
  );
}

function readNonNegativeNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function readPositiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
    ? value
    : undefined;
}

function normalizeEntry(
  raw: unknown,
  index: number,
  issues: CompletionConfigurationIssue[],
): CompletionAlgorithmEntry | undefined {
  if (!isRecord(raw)) {
    issues.push({ code: 'entry-not-object', index });
    return undefined;
  }

  const id = typeof raw.id === 'string' ? raw.id.trim() : '';
  if (!id) {
    issues.push({ code: 'entry-missing-id', index });
    return undefined;
  }
  if (!isAlgorithmId(raw.algorithm)) {
    issues.push({ code: 'entry-unknown-algorithm', id });
    return undefined;
  }
  if (raw.options !== undefined && !isRecord(raw.options)) {
    issues.push({ code: 'entry-invalid-options', id });
    return undefined;
  }

  return {
    id,
    algorithm: raw.algorithm,
    ...(raw.options === undefined ? {} : { options: raw.options }),
  };
}

function normalizeStopCondition(
  raw: unknown,
  issues: CompletionConfigurationIssue[],
): CompletionStopCondition {
  if (!isRecord(raw) || typeof raw.type !== 'string') {
    issues.push({ code: 'stop-when-invalid' });
    return { type: 'firstUsable', graceMs: 0 };
  }

  switch (raw.type) {
    case 'firstUsable':
      return {
        type: 'firstUsable',
        graceMs: readNonNegativeNumber(raw.graceMs) ?? 0,
      };
    case 'deadline': {
      const timeoutMs = readNonNegativeNumber(raw.timeoutMs);
      if (timeoutMs === undefined) {
        issues.push({ code: 'deadline-invalid' });
        return { type: 'firstUsable', graceMs: 0 };
      }
      return { type: 'deadline', timeoutMs };
    }
    case 'enoughResults': {
      const minItems = readPositiveInteger(raw.minItems);
      if (minItems === undefined) {
        issues.push({ code: 'enough-results-invalid' });
        return { type: 'firstUsable', graceMs: 0 };
      }
      return {
        type: 'enoughResults',
        minItems,
        graceMs: readNonNegativeNumber(raw.graceMs) ?? 0,
      };
    }
    case 'allSettled':
      return { type: 'allSettled' };
    default:
      issues.push({ code: 'unknown-stop-condition', value: raw.type });
      return { type: 'firstUsable', graceMs: 0 };
  }
}

export function normalizeCompletionStrategy(
  raw: unknown,
  issues: CompletionConfigurationIssue[] = [],
): CompletionStrategy {
  if (!isRecord(raw)) {
    if (raw !== undefined) {
      issues.push({ code: 'strategy-not-object' });
    }
    return {
      mode: DEFAULT_COMPLETION_STRATEGY.mode,
      disableVSCodeBuiltinCompletion:
        DEFAULT_COMPLETION_STRATEGY.disableVSCodeBuiltinCompletion,
      disabledGlobs: [...DEFAULT_COMPLETION_DISABLED_GLOBS],
      stopWhen: { ...DEFAULT_COMPLETION_STRATEGY.stopWhen },
    };
  }

  const mode = raw.mode === 'main-first' ? 'main-first' : 'all';
  if (raw.mode !== undefined && raw.mode !== 'all' && raw.mode !== 'main-first') {
    issues.push({
      code: 'unknown-strategy-mode',
      value: String(raw.mode),
    });
  }

  const mainProvider =
    typeof raw.mainProvider === 'string' && raw.mainProvider.trim()
      ? raw.mainProvider.trim()
      : undefined;
  const mainFirstTimeoutMs = readNonNegativeNumber(raw.mainFirstTimeoutMs);
  const parallelRequestOthers =
    typeof raw.parallelRequestOthers === 'boolean'
      ? raw.parallelRequestOthers
      : undefined;
  const configuredDisabledGlobs: string[] = [];
  if (raw.disabledGlobs !== undefined) {
    if (Array.isArray(raw.disabledGlobs)) {
      for (const value of raw.disabledGlobs) {
        if (typeof value === 'string' && value.trim()) {
          configuredDisabledGlobs.push(value);
        } else {
          issues.push({ code: 'disabled-globs-invalid' });
          break;
        }
      }
    } else {
      issues.push({ code: 'disabled-globs-invalid' });
    }
  }

  return {
    mode,
    disableVSCodeBuiltinCompletion:
      typeof raw.disableVSCodeBuiltinCompletion === 'boolean'
        ? raw.disableVSCodeBuiltinCompletion
        : true,
    disabledGlobs: mergeCompletionDisabledGlobs(configuredDisabledGlobs),
    ...(mainProvider === undefined ? {} : { mainProvider }),
    ...(mainFirstTimeoutMs === undefined ? {} : { mainFirstTimeoutMs }),
    ...(parallelRequestOthers === undefined
      ? {}
      : { parallelRequestOthers }),
    stopWhen: normalizeStopCondition(raw.stopWhen, issues),
  };
}

export function normalizeCompletionConfiguration(raw: {
  enabled: unknown;
  providers: unknown;
  strategy: unknown;
}): CompletionConfigurationResult {
  const issues: CompletionConfigurationIssue[] = [];
  const providers: CompletionAlgorithmEntry[] = [];
  const ids = new Set<string>();

  if (Array.isArray(raw.providers)) {
    raw.providers.forEach((provider, index) => {
      const normalized = normalizeEntry(provider, index, issues);
      if (!normalized) {
        return;
      }
      if (ids.has(normalized.id)) {
        issues.push({ code: 'duplicate-entry-id', id: normalized.id });
        return;
      }
      ids.add(normalized.id);
      providers.push(normalized);
    });
  } else if (raw.providers !== undefined) {
    issues.push({ code: 'providers-not-array' });
  }

  return {
    configuration: {
      enabled: typeof raw.enabled === 'boolean' ? raw.enabled : true,
      providers,
      strategy: normalizeCompletionStrategy(raw.strategy, issues),
    },
    issues,
  };
}

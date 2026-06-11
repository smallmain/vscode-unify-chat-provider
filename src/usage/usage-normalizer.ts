import type { CopilotUsage } from '../types';
import type { NormalizedUsage } from './types';

function finiteNonNegative(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function buildUsage(options: {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  cachedInputTokens?: number;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
  uncachedInputTokens?: number;
}): NormalizedUsage | null {
  const promptTokens = options.promptTokens ?? 0;
  const completionTokens = options.completionTokens ?? 0;
  const totalTokens = options.totalTokens ?? promptTokens + completionTokens;

  if (promptTokens === 0 && completionTokens === 0 && totalTokens === 0) {
    return null;
  }

  const normalized: NormalizedUsage = {
    promptTokens,
    completionTokens,
    totalTokens,
  };

  if (options.cachedInputTokens !== undefined) {
    normalized.cachedInputTokens = options.cachedInputTokens;
  }
  if (options.cacheCreationInputTokens !== undefined) {
    normalized.cacheCreationInputTokens = options.cacheCreationInputTokens;
  }
  if (options.cacheReadInputTokens !== undefined) {
    normalized.cacheReadInputTokens = options.cacheReadInputTokens;
  }
  if (options.uncachedInputTokens !== undefined) {
    normalized.uncachedInputTokens = options.uncachedInputTokens;
  }

  return normalized;
}

export function normalizeUsage(usage: CopilotUsage): NormalizedUsage | null {
  try {
    const promptTokens = finiteNonNegative(usage.prompt_tokens) ?? 0;
    const completionTokens = finiteNonNegative(usage.completion_tokens) ?? 0;
    const totalTokens = finiteNonNegative(usage.total_tokens);
    const cachedInputTokens = finiteNonNegative(
      usage.prompt_tokens_details.cached_tokens,
    );

    return buildUsage({
      promptTokens,
      completionTokens,
      totalTokens,
      cachedInputTokens,
      uncachedInputTokens:
        cachedInputTokens === undefined
          ? undefined
          : Math.max(promptTokens - cachedInputTokens, 0),
    });
  } catch {
    return null;
  }
}

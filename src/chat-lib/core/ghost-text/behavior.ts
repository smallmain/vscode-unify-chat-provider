import {
  GHOST_TEXT_UPSTREAM_COMMIT,
  type GhostTextBehavior,
} from './types';

/**
 * Non-experimental defaults from VS Code 1.128.0's completions features and
 * prompt packages. Keeping this object versioned makes behavior drift visible.
 */
export const DEFAULT_GHOST_TEXT_BEHAVIOR: Readonly<GhostTextBehavior> = {
  upstreamCommit: GHOST_TEXT_UPSTREAM_COMMIT,
  maxPromptCompletionTokens: 8192,
  maxCompletionTokens: 500,
  suffixPercent: 15,
  suffixMatchThreshold: 10,
  minPromptCharacters: 10,
  numberOfSnippets: 4,
  maximumSimilarFiles: 20,
  maximumCharactersPerSimilarFile: 10_000,
  similarFileWindowLines: 60,
  cacheSize: 100,
  asyncCompletionTimeoutMs: 200,
  completionDelayMs: 200,
  cyclingCandidateCount: 3,
  blockMode: 'default',
  modelAlwaysTerminatesSingleline: false,
  singleLineUnlessAccepted: false,
  maxMultilineTokens: 200,
  multilineAfterAcceptLines: 1,
};

export function resolveGhostTextBehavior(
  overrides: Partial<Omit<GhostTextBehavior, 'upstreamCommit'>> | undefined,
): GhostTextBehavior {
  const behavior = { ...DEFAULT_GHOST_TEXT_BEHAVIOR, ...overrides };
  validatePercentage('suffixPercent', behavior.suffixPercent);
  validatePercentage('suffixMatchThreshold', behavior.suffixMatchThreshold);
  validatePositive('maxPromptCompletionTokens', behavior.maxPromptCompletionTokens);
  validatePositive('maxCompletionTokens', behavior.maxCompletionTokens);
  if (behavior.maxCompletionTokens >= behavior.maxPromptCompletionTokens) {
    throw new Error(
      'maxCompletionTokens must be smaller than maxPromptCompletionTokens.',
    );
  }
  validatePositive('cacheSize', behavior.cacheSize);
  validatePositive('cyclingCandidateCount', behavior.cyclingCandidateCount);
  validatePositive('maxMultilineTokens', behavior.maxMultilineTokens);
  validatePositive('multilineAfterAcceptLines', behavior.multilineAfterAcceptLines);
  validateNonNegative(
    'asyncCompletionTimeoutMs',
    behavior.asyncCompletionTimeoutMs,
  );
  validateNonNegative('completionDelayMs', behavior.completionDelayMs);
  if (
    ![
      'default',
      'parsing',
      'parsing-and-server',
      'more-multiline',
      'server',
    ].includes(behavior.blockMode)
  ) {
    throw new Error(`Unsupported GhostText block mode: ${behavior.blockMode}.`);
  }
  if (
    typeof behavior.modelAlwaysTerminatesSingleline !== 'boolean' ||
    typeof behavior.singleLineUnlessAccepted !== 'boolean'
  ) {
    throw new Error('GhostText single-line behavior flags must be boolean.');
  }
  return behavior;
}

function validatePercentage(name: string, value: number): void {
  if (!Number.isFinite(value) || value < 0 || value > 100) {
    throw new Error(`${name} must be between 0 and 100.`);
  }
}

function validatePositive(name: string, value: number): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
}

function validateNonNegative(name: string, value: number): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be non-negative.`);
  }
}

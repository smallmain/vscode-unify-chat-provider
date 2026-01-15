/**
 * Options for retry with exponential backoff
 */
export interface RetryOptions {
  /** Maximum number of retry attempts (default: 3) */
  maxAttempts?: number;
  /** Initial delay in milliseconds (default: 1000) */
  initialDelayMs?: number;
  /** Maximum delay in milliseconds (default: 10000) */
  maxDelayMs?: number;
  /** Timeout per attempt in milliseconds (default: 30000) */
  timeoutMs?: number;
  /** Backoff multiplier (default: 2) */
  backoffMultiplier?: number;
}

const DEFAULT_OPTIONS: Required<RetryOptions> = {
  maxAttempts: 3,
  initialDelayMs: 1000,
  maxDelayMs: 10000,
  timeoutMs: 30000,
  backoffMultiplier: 2,
};

/**
 * Sleep for a specified duration
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Calculate delay with exponential backoff
 */
function calculateDelay(
  attempt: number,
  initialDelayMs: number,
  maxDelayMs: number,
  backoffMultiplier: number,
): number {
  const delay = initialDelayMs * Math.pow(backoffMultiplier, attempt);
  return Math.min(delay, maxDelayMs);
}

/**
 * Execute a function with timeout
 */
export async function withTimeout<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
): Promise<T> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fn(controller.signal);
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Execute a function with retry and exponential backoff
 *
 * @param fn - The function to execute (receives AbortSignal for timeout support)
 * @param shouldRetry - Predicate to determine if an error is retryable
 * @param options - Retry options
 * @returns The result of the function
 * @throws The last error if all retries fail
 */
export async function withRetry<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  shouldRetry: (error: unknown) => boolean,
  options?: RetryOptions,
): Promise<T> {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  let lastError: unknown;

  for (let attempt = 0; attempt < opts.maxAttempts; attempt++) {
    try {
      return await withTimeout(fn, opts.timeoutMs);
    } catch (error) {
      lastError = error;

      // Don't retry if this is the last attempt or error is not retryable
      const isLastAttempt = attempt === opts.maxAttempts - 1;
      if (isLastAttempt || !shouldRetry(error)) {
        throw error;
      }

      // Calculate delay and wait before next attempt
      const delay = calculateDelay(
        attempt,
        opts.initialDelayMs,
        opts.maxDelayMs,
        opts.backoffMultiplier,
      );
      await sleep(delay);
    }
  }

  throw lastError;
}

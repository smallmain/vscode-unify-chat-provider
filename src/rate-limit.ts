/**
 * Token bucket rate limiter for RPM (requests per minute) throttling.
 *
 * Instead of reacting to 429 responses, this proactively gates outgoing
 * requests so the client never exceeds the configured rate and avoids
 * being locked out by the upstream API.
 *
 * Algorithm: token bucket
 * - Bucket capacity = ceil(rpm × 0.8), min 1 (conservative: limits burst)
 * - Tokens refill at a constant rate: rpm / 60_000 tokens per millisecond
 * - Each logical chat request consumes 1 token
 * - If no token is available, the caller waits until one is refilled
 * - Long-term average rate ≤ rpm (burst capacity doesn't increase throughput)
 *
 * When rpm is 0 the limiter is not created at all — no overhead, no limit.
 */
const MAX_SAFE_TIMEOUT_MS = 0x7fffffff;

/**
 * Build an abort-shaped error so the service layer can detect it via
 * `isAbortLikeError` and treat a cancelled wait as a normal cancellation.
 */
function createRateLimitAbortError(): Error {
  const error = new Error('Rate-limit token acquisition was aborted.');
  error.name = 'AbortError';
  return error;
}

/**
 * Resolve after `ms`, or reject with an AbortError if `signal` aborts first.
 * Used inside {@link RateLimiter.acquireOne} to wake up cancelled waiters so
 * they don't keep waiting for (and never consume) a token.
 */
function waitForTimeoutOrAbort(
  ms: number,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let timeoutId: ReturnType<typeof setTimeout> | undefined;

    const onAbort = (): void => {
      if (timeoutId !== undefined) {
        clearTimeout(timeoutId);
      }
      reject(createRateLimitAbortError());
    };

    signal?.addEventListener('abort', onAbort, { once: true });
    timeoutId = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
  });
}

function waitForPromiseOrAbort<T>(
  promise: Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (!signal) {
    return promise;
  }

  if (signal.aborted) {
    return Promise.reject(createRateLimitAbortError());
  }

  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      signal.removeEventListener('abort', onAbort);
      reject(createRateLimitAbortError());
    };

    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

export class RateLimiter {
  /** Maximum tokens the bucket can hold (= ceil(rpm * 0.8), min 1). */
  readonly maxTokens: number;

  /** Current token count. Starts at capacity (conservative). */
  private tokens: number;

  /** Tokens added per millisecond. */
  private readonly refillRate: number;

  /** Timestamp (ms) of the last refill. */
  private lastRefillMs: number;

  /** FIFO queue that makes refill, wait, and consumption atomic per caller. */
  private acquireQueue: Promise<void> = Promise.resolve();

  /**
   * @param rpm Logical chat requests per minute. Must be a finite value > 0.
   */
  constructor(rpm: number) {
    const refillRate = rpm / 60_000;
    if (
      !Number.isFinite(rpm) ||
      rpm <= 0 ||
      !Number.isFinite(refillRate) ||
      refillRate <= 0
    ) {
      throw new RangeError('RPM must be a finite number greater than zero.');
    }

    // Conservative burst: only allow 80% of RPM as instant burst.
    this.maxTokens = Math.max(1, Math.ceil(rpm * 0.8));
    this.tokens = this.maxTokens;
    this.refillRate = refillRate;
    this.lastRefillMs = Date.now();
  }

  /**
   * Acquire a token, waiting if necessary until one becomes available.
   *
   * Callers are processed FIFO so simultaneous waits cannot consume the same
   * refilled token or drive the bucket below zero.
   *
   * If `signal` is (or becomes) aborted while waiting, rejects with an
   * AbortError WITHOUT consuming a token, so cancelled chat requests don't pay
   * for a slot they'll never use.
   */
  acquire(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) {
      return Promise.reject(createRateLimitAbortError());
    }
    const queuedAcquisition = this.acquireQueue.then(() =>
      this.acquireOne(signal),
    );
    this.acquireQueue = queuedAcquisition.catch(() => {});
    return waitForPromiseOrAbort(queuedAcquisition, signal);
  }

  private async acquireOne(signal?: AbortSignal): Promise<void> {
    while (true) {
      // Abort before consuming so a cancelled request never takes a token.
      if (signal?.aborted) {
        throw createRateLimitAbortError();
      }

      this.refill();

      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }

      // We need exactly one token. Wait in bounded chunks so unusually low
      // positive RPM values cannot overflow the platform timeout limit.
      const deficit = 1 - this.tokens;
      const waitMs = Math.ceil(deficit / this.refillRate);
      const timeoutMs = Number.isFinite(waitMs)
        ? Math.min(waitMs, MAX_SAFE_TIMEOUT_MS)
        : MAX_SAFE_TIMEOUT_MS;
      await waitForTimeoutOrAbort(timeoutMs, signal);
    }
  }

  /**
   * Peek at the current token count without consuming any.
   *
   * Does NOT refill: `acquire()` already refills before consuming, so when
   * called right after a successful acquisition this returns the exact
   * post-consumption bucket state (used for the request log). Skipping an
   * extra time-based refill keeps the logged "post-acquire" snapshot accurate
   * instead of being slightly inflated by freshly earned tokens.
   */
  getAvailableTokens(): { available: number; capacity: number } {
    return { available: this.tokens, capacity: this.maxTokens };
  }

  /**
   * Add tokens earned since the last refill, capped at bucket capacity.
   */
  private refill(): void {
    const now = Date.now();
    const elapsed = now - this.lastRefillMs;

    if (elapsed <= 0) {
      return;
    }

    this.tokens = Math.min(
      this.maxTokens,
      this.tokens + elapsed * this.refillRate,
    );
    this.lastRefillMs = now;
  }
}

/**
 * Create a RateLimiter from the provider-level rate-limit configuration.
 *
 * Returns undefined when rpm is unset, non-finite, 0, or negative — meaning
 * no rate limiting is applied.
 */
export function createRateLimiter(
  config: RateLimitConfig | undefined,
): RateLimiter | undefined {
  const rpm = config?.rpm;
  if (typeof rpm !== 'number' || !Number.isFinite(rpm) || rpm <= 0) {
    return undefined;
  }
  return new RateLimiter(rpm);
}

/** Per-provider rate-limit configuration. */
export interface RateLimitConfig {
  /** Maximum logical chat requests per minute. 0 or unset = no limit. */
  rpm?: number;
}

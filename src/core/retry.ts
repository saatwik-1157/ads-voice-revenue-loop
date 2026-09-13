import { setTimeout as delay } from 'node:timers/promises';

/**
 * Retry with exponential backoff and jitter.
 *
 * Retrying a write is only safe because every write this system makes to Meta
 * or to the dialler carries an idempotency key - a retried create returns the
 * original object instead of making a second one. Do not use this helper for a
 * call that lacks one.
 *
 * A transient failure (429, 5xx, connection reset) is retried. A 4xx is a bug in
 * the request and is thrown immediately - retrying it just burns the rate limit
 * and delays the error reaching a human.
 */

export interface RetryOptions {
  /** Total attempts including the first. */
  attempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  onRetry?: (info: RetryInfo) => void;
  /** Injected in tests so retries do not actually sleep. */
  sleep?: (ms: number) => Promise<void>;
  /** Injected in tests to make jitter deterministic. */
  random?: () => number;
}

export interface RetryInfo {
  operation: string;
  attempt: number;
  attempts: number;
  delayMs: number;
  error: Error;
}

/** An error carrying enough information to decide whether a retry is sane. */
export interface TransientAware {
  retryable?: boolean;
  retryAfterMs?: number;
}

export const DEFAULT_RETRY: Required<Pick<RetryOptions, 'attempts' | 'baseDelayMs' | 'maxDelayMs'>> = {
  attempts: 4,
  baseDelayMs: 500,
  maxDelayMs: 20_000,
};

export function isRetryable(error: unknown): boolean {
  const candidate = error as TransientAware | undefined;
  if (candidate && typeof candidate.retryable === 'boolean') return candidate.retryable;
  // fetch() rejects with a TypeError for DNS/connection/reset failures, which
  // are exactly the ones worth trying again.
  return error instanceof TypeError;
}

/** Is this HTTP status worth another attempt? */
export function isRetryableStatus(status: number): boolean {
  return status === 0 || status === 408 || status === 429 || status >= 500;
}

/**
 * Parse a Retry-After header. The spec allows either a delay in seconds or an
 * HTTP date; both appear in the wild.
 */
export function parseRetryAfter(value: string | null, now: number = Date.now()): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const at = Date.parse(value);
  if (Number.isFinite(at)) return Math.max(0, at - now);
  return undefined;
}

/**
 * Full jitter: a delay uniformly drawn from [0, exponential). It beats fixed
 * backoff when several workers retry at once, because it spreads the herd
 * instead of synchronising it.
 */
export function backoffDelay(attempt: number, options: RetryOptions = {}): number {
  const base = options.baseDelayMs ?? DEFAULT_RETRY.baseDelayMs;
  const max = options.maxDelayMs ?? DEFAULT_RETRY.maxDelayMs;
  const random = options.random ?? Math.random;
  const exponential = Math.min(max, base * 2 ** (attempt - 1));
  return Math.round(exponential * random());
}

export async function withRetry<T>(operation: string, fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const attempts = options.attempts ?? DEFAULT_RETRY.attempts;
  const sleep = options.sleep ?? ((ms: number) => delay(ms));

  let lastError: Error = new Error(`${operation} never ran`);
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      lastError = err as Error;
      if (attempt === attempts || !isRetryable(err)) throw err;

      const hinted = (err as TransientAware).retryAfterMs;
      // A server that tells us when to come back knows better than our formula.
      const delayMs = Math.min(hinted ?? backoffDelay(attempt, options), options.maxDelayMs ?? DEFAULT_RETRY.maxDelayMs);
      options.onRetry?.({ operation, attempt, attempts, delayMs, error: lastError });
      await sleep(delayMs);
    }
  }
  throw lastError;
}

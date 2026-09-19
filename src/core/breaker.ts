import { log } from './log.ts';

/**
 * A circuit breaker for one external provider.
 *
 * The problem it solves: when Meta or the dialler is down, every cycle and
 * every lead keeps calling it. Each call waits out its own timeout and its own
 * retry ladder before failing, so an outage turns into a queue of slow
 * failures - the cycle takes minutes instead of seconds, leads pile up behind
 * calls that were never going to connect, and the provider gets hammered while
 * it is trying to recover.
 *
 * After enough consecutive failures the breaker opens and calls fail
 * immediately. After a cooldown it lets exactly one through to find out whether
 * the provider is back.
 *
 * Two decisions worth stating, because both are places this could do harm:
 *
 * **Only transient failures count.** A 4xx is a bug in our request, and it will
 * fail identically forever. Counting those would let one malformed call take
 * the whole provider offline for every other caller - turning our bug into an
 * outage. Errors carry `retryable` already; anything not marked transient
 * passes through without touching the breaker's state.
 *
 * **Open fails fast, it does not swallow.** The error it throws is itself
 * marked retryable and carries how long is left, so callers that defer rather
 * than discard - a lead waiting for a dialler - keep doing that.
 */

export type BreakerState = 'closed' | 'open' | 'half-open';

/** Thrown instead of calling the provider while the circuit is open. */
export class CircuitOpenError extends Error {
  readonly name = 'CircuitOpenError';
  /** Transient by definition: the provider may well be fine in a minute. */
  readonly retryable = true;
  readonly provider: string;
  readonly retryAfterMs: number;

  constructor(provider: string, retryAfterMs: number, lastError: string) {
    super(
      `${provider} is not being called: the circuit is open after repeated failures ` +
        `(${Math.ceil(retryAfterMs / 1000)}s left). Last failure: ${lastError}`,
    );
    this.provider = provider;
    this.retryAfterMs = retryAfterMs;
  }
}

export interface BreakerOptions {
  /** Consecutive transient failures before the circuit opens. */
  failureThreshold?: number;
  /** How long it stays open before letting one call through. */
  cooldownMs?: number;
  /** Injectable clock, so the cooldown can be tested without waiting. */
  now?: () => number;
}

export interface BreakerStatus {
  provider: string;
  state: BreakerState;
  consecutiveFailures: number;
  openedAt: number | null;
  lastError: string | null;
}

export class CircuitBreaker {
  readonly provider: string;
  readonly #threshold: number;
  readonly #cooldownMs: number;
  readonly #now: () => number;

  #failures = 0;
  #openedAt: number | null = null;
  #lastError: string | null = null;
  /** True while a half-open probe is in flight, so only one call probes. */
  #probing = false;

  constructor(provider: string, options: BreakerOptions = {}) {
    this.provider = provider;
    this.#threshold = options.failureThreshold ?? 5;
    this.#cooldownMs = options.cooldownMs ?? 30_000;
    this.#now = options.now ?? (() => Date.now());
  }

  state(): BreakerState {
    if (this.#openedAt === null) return 'closed';
    return this.#now() - this.#openedAt >= this.#cooldownMs ? 'half-open' : 'open';
  }

  status(): BreakerStatus {
    return {
      provider: this.provider,
      state: this.state(),
      consecutiveFailures: this.#failures,
      openedAt: this.#openedAt,
      lastError: this.#lastError,
    };
  }

  /** Force the circuit shut. For an operator who has fixed the provider. */
  reset(): void {
    this.#failures = 0;
    this.#openedAt = null;
    this.#lastError = null;
    this.#probing = false;
  }

  /**
   * Run an operation through the breaker.
   *
   * Wrap the whole operation including its retries, not each HTTP attempt: one
   * logical call that exhausts its retry ladder is one failure, not three. At
   * the attempt level a single flaky call would push the circuit most of the
   * way open on its own.
   */
  async run<T>(operation: string, fn: () => Promise<T>): Promise<T> {
    const state = this.state();

    if (state === 'open') {
      const left = this.#cooldownMs - (this.#now() - (this.#openedAt ?? 0));
      throw new CircuitOpenError(this.provider, Math.max(0, left), this.#lastError ?? 'unknown');
    }

    if (state === 'half-open') {
      // Exactly one probe. Without this, everything queued behind the outage
      // arrives at once the moment the cooldown expires and re-opens the
      // circuit together - the thundering herd the breaker exists to prevent.
      if (this.#probing) {
        throw new CircuitOpenError(this.provider, this.#cooldownMs, this.#lastError ?? 'unknown');
      }
      this.#probing = true;
    }

    try {
      const result = await fn();
      if (state === 'half-open') {
        log.info('breaker.closed', { provider: this.provider, operation });
      }
      this.reset();
      return result;
    } catch (err) {
      this.#probing = false;
      const transient = (err as { retryable?: boolean }).retryable === true;
      if (!transient) {
        // Our bug, not their outage. Left alone deliberately: counting these
        // would let one malformed request open the circuit for everybody.
        throw err;
      }

      this.#failures += 1;
      this.#lastError = (err as Error).message.slice(0, 200);

      if (state === 'half-open') {
        // The probe failed: still down, wait another cooldown.
        this.#openedAt = this.#now();
        log.warn('breaker.still_open', { provider: this.provider, operation, error: this.#lastError });
      } else if (this.#failures >= this.#threshold && this.#openedAt === null) {
        this.#openedAt = this.#now();
        log.error('breaker.opened', {
          provider: this.provider,
          operation,
          consecutiveFailures: this.#failures,
          cooldownMs: this.#cooldownMs,
          error: this.#lastError,
        });
      }
      throw err;
    }
  }
}

/**
 * The breakers in this process, one per provider.
 *
 * Module state, like the rate limiter, and per-process for the same reason:
 * a second instance has its own view of whether the provider is up. Documented
 * rather than hidden - with one instance, which is what SQLite allows anyway,
 * it is correct.
 */
const breakers = new Map<string, CircuitBreaker>();

export function breakerFor(provider: string, options?: BreakerOptions): CircuitBreaker {
  let existing = breakers.get(provider);
  if (!existing) {
    existing = new CircuitBreaker(provider, options);
    breakers.set(provider, existing);
  }
  return existing;
}

export function allBreakers(): BreakerStatus[] {
  return [...breakers.values()].map((b) => b.status());
}

/** Test helper: forget every breaker, so one test cannot affect the next. */
export function resetAllBreakers(): void {
  breakers.clear();
}

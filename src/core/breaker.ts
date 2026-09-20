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
  /** When the half-open probe started, or null if none is in flight. */
  #probeStartedAt: number | null = null;
  /**
   * Bumped whenever the circuit is deliberately reset.
   *
   * A call captures this on the way in and its outcome is ignored if it has
   * changed by the time the call returns. Without it, a slow call that started
   * while the circuit was closed re-closed a circuit that opened underneath it,
   * releasing the whole queued herd at a provider still down - and a probe
   * already in flight re-opened a circuit an operator had just cleared by hand.
   */
  #generation = 0;

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

  /**
   * Is a probe in flight, and still worth waiting for?
   *
   * A probe that never settles used to hold the circuit shut against everyone
   * indefinitely: neither provider passes a timeout to fetch, so a hung socket
   * kept the flag set until undici gave up minutes later. A probe older than
   * the cooldown is treated as lost and another is allowed.
   */
  #probeInFlight(): boolean {
    if (this.#probeStartedAt === null) return false;
    if (this.#now() - this.#probeStartedAt >= this.#cooldownMs) {
      this.#probeStartedAt = null;
      return false;
    }
    return true;
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
    this.#probeStartedAt = null;
    this.#generation += 1;
  }

  /**
   * Run an operation through the breaker.
   *
   * Wrap the whole operation including its retries, not each HTTP attempt: one
   * logical call that exhausts its retry ladder is one failure, not three. At
   * the attempt level a single flaky call would push the circuit most of the
   * way open on its own.
   */
  /** How long is left before the circuit would let a probe through. */
  #remainingMs(): number {
    if (this.#openedAt === null) return 0;
    return Math.max(0, this.#cooldownMs - (this.#now() - this.#openedAt));
  }

  async run<T>(operation: string, fn: () => Promise<T>): Promise<T> {
    const state = this.state();
    const generation = this.#generation;

    if (state === 'open') {
      throw new CircuitOpenError(this.provider, this.#remainingMs(), this.#lastError ?? 'unknown');
    }

    let probing = false;
    if (state === 'half-open') {
      // Exactly one probe. Without this, everything queued behind the outage
      // arrives at once the moment the cooldown expires and re-opens the
      // circuit together - the thundering herd the breaker exists to prevent.
      if (this.#probeInFlight()) {
        throw new CircuitOpenError(this.provider, this.#cooldownMs, this.#lastError ?? 'unknown');
      }
      this.#probeStartedAt = this.#now();
      probing = true;
    }

    try {
      const result = await fn();
      if (probing) this.#probeStartedAt = null;

      // Someone reset the circuit while this was in flight; their decision wins.
      if (generation !== this.#generation) return result;

      this.#failures = 0;
      this.#lastError = null;
      // Only the probe may close an open circuit. A call that started while the
      // circuit was closed says nothing about a circuit that opened underneath
      // it, and letting it clear the state released the queue at a provider
      // that was still down.
      if (probing || this.#openedAt === null) {
        if (this.#openedAt !== null) log.info('breaker.closed', { provider: this.provider, operation });
        this.#openedAt = null;
      }
      return result;
    } catch (err) {
      if (probing) this.#probeStartedAt = null;

      const transient = (err as { retryable?: boolean }).retryable === true;
      if (!transient) {
        // Our bug, not their outage. Left alone deliberately: counting these
        // would let one malformed request open the circuit for everybody.
        throw err;
      }
      if (generation !== this.#generation) throw err;

      this.#failures += 1;
      this.#lastError = (err as Error).message.slice(0, 200);

      if (probing) {
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

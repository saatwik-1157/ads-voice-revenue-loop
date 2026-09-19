/**
 * A token bucket per caller per route class.
 *
 * Nothing bounded request volume before this. An unauthenticated caller could
 * enumerate runs or force repeated HMAC verification as fast as the socket
 * allowed - and signature verification is deliberately constant-time, which
 * makes it a usefully expensive thing to force somebody else to do.
 *
 * In-memory, and that is a real limitation rather than an oversight: two
 * processes each keep their own buckets, so the effective limit is per process.
 * Correct for the single-process deployment this currently has, and the place
 * to change when there is more than one - which is why the state is behind a
 * class rather than a module-level map.
 */

export interface RateLimitRule {
  /** Tokens in a full bucket, which is also the largest burst allowed. */
  burst: number;
  /** Tokens added per second. */
  refillPerSecond: number;
}

export interface RateLimitDecision {
  allowed: boolean;
  /** Seconds until the next token, for Retry-After. */
  retryAfterSeconds: number;
  remaining: number;
}

interface Bucket {
  tokens: number;
  lastRefill: number;
}

export class RateLimiter {
  readonly #buckets = new Map<string, Bucket>();
  readonly #now: () => number;
  /** Stops an attacker growing the map without bound by varying the key. */
  readonly #maxKeys: number;

  constructor(options: { now?: () => number; maxKeys?: number } = {}) {
    this.#now = options.now ?? Date.now;
    this.#maxKeys = options.maxKeys ?? 10_000;
  }

  check(key: string, rule: RateLimitRule): RateLimitDecision {
    const at = this.#now();
    let bucket = this.#buckets.get(key);

    if (!bucket) {
      // Evicting the oldest is crude but bounded, and the alternative - letting
      // the map grow with every distinct key - is itself the denial of service.
      if (this.#buckets.size >= this.#maxKeys) {
        const oldest = this.#buckets.keys().next();
        if (!oldest.done) this.#buckets.delete(oldest.value);
      }
      bucket = { tokens: rule.burst, lastRefill: at };
      this.#buckets.set(key, bucket);
    }

    const elapsedSeconds = Math.max(0, (at - bucket.lastRefill) / 1000);
    bucket.tokens = Math.min(rule.burst, bucket.tokens + elapsedSeconds * rule.refillPerSecond);
    bucket.lastRefill = at;

    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return { allowed: true, retryAfterSeconds: 0, remaining: Math.floor(bucket.tokens) };
    }

    const needed = 1 - bucket.tokens;
    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil(needed / rule.refillPerSecond)),
      remaining: 0,
    };
  }

  /** Test hook: forget everything. */
  reset(): void {
    this.#buckets.clear();
  }
}

/**
 * Limits by what the route costs and who can reach it.
 *
 * Webhooks are the most generous because a provider legitimately bursts on
 * redelivery and being throttled would make it retry harder. Unauthenticated
 * requests are the tightest, because that is the only budget an attacker has.
 */
export const RATE_LIMITS: Record<string, RateLimitRule> = {
  webhook: { burst: 120, refillPerSecond: 10 },
  read: { burst: 60, refillPerSecond: 2 },
  write: { burst: 20, refillPerSecond: 0.5 },
  unauthenticated: { burst: 10, refillPerSecond: 0.2 },
};

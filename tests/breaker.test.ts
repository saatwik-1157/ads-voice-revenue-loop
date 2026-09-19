import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { CircuitBreaker, CircuitOpenError, breakerFor, allBreakers, resetAllBreakers } from '../src/core/breaker.ts';
import { MetaApiProvider } from '../src/meta/api.ts';

/**
 * The circuit breaker.
 *
 * Two of these tests matter more than the rest, because they cover the ways a
 * breaker does damage rather than prevents it: opening on our own bad requests,
 * and letting everything through at once the moment the cooldown expires.
 */

afterEach(() => {
  resetAllBreakers();
});

/** A clock the test moves by hand. */
function clock(start = 1_000_000): { now: () => number; advance: (ms: number) => void } {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

const transient = (message = 'provider unreachable'): Error =>
  Object.assign(new Error(message), { retryable: true });
const ourBug = (message = 'bad request'): Error => Object.assign(new Error(message), { retryable: false });

test('it opens after the threshold and then fails without calling the provider', async () => {
  const c = clock();
  const breaker = new CircuitBreaker('meta', { failureThreshold: 3, cooldownMs: 30_000, now: c.now });
  let calls = 0;
  const failing = (): Promise<never> => {
    calls += 1;
    return Promise.reject(transient());
  };

  for (let i = 0; i < 3; i += 1) {
    await assert.rejects(breaker.run('op', failing));
  }
  assert.equal(calls, 3);
  assert.equal(breaker.state(), 'open');

  // The point of the whole thing: the provider is not called again.
  await assert.rejects(breaker.run('op', failing), CircuitOpenError);
  assert.equal(calls, 3, 'an open circuit does not reach the provider');
});

test('our own bad requests never open it', async () => {
  // The failure mode that would turn one of our bugs into an outage for
  // everybody: a 4xx fails identically forever, so counting it would open the
  // circuit and take the provider away from every other caller.
  const c = clock();
  const breaker = new CircuitBreaker('meta', { failureThreshold: 3, cooldownMs: 30_000, now: c.now });

  for (let i = 0; i < 20; i += 1) {
    await assert.rejects(breaker.run('op', () => Promise.reject(ourBug())), /bad request/);
  }
  assert.equal(breaker.state(), 'closed', 'a 4xx says nothing about whether the provider is up');
  assert.equal(breaker.status().consecutiveFailures, 0);
});

test('a success resets the count, so scattered failures never add up', async () => {
  const c = clock();
  const breaker = new CircuitBreaker('meta', { failureThreshold: 3, cooldownMs: 30_000, now: c.now });

  await assert.rejects(breaker.run('op', () => Promise.reject(transient())));
  await assert.rejects(breaker.run('op', () => Promise.reject(transient())));
  assert.equal(breaker.status().consecutiveFailures, 2);

  await breaker.run('op', () => Promise.resolve('fine'));
  assert.equal(breaker.status().consecutiveFailures, 0, 'consecutive means consecutive');

  await assert.rejects(breaker.run('op', () => Promise.reject(transient())));
  assert.equal(breaker.state(), 'closed');
});

test('after the cooldown exactly one call probes, and success closes it', async () => {
  const c = clock();
  const breaker = new CircuitBreaker('voice', { failureThreshold: 2, cooldownMs: 30_000, now: c.now });
  for (let i = 0; i < 2; i += 1) await assert.rejects(breaker.run('op', () => Promise.reject(transient())));
  assert.equal(breaker.state(), 'open');

  c.advance(29_000);
  assert.equal(breaker.state(), 'open', 'still open before the cooldown is up');

  c.advance(2_000);
  assert.equal(breaker.state(), 'half-open');

  const result = await breaker.run('op', () => Promise.resolve('back'));
  assert.equal(result, 'back');
  assert.equal(breaker.state(), 'closed', 'a working probe closes it');
  assert.equal(breaker.status().consecutiveFailures, 0);
});

test('a failed probe re-opens it for another full cooldown', async () => {
  const c = clock();
  const breaker = new CircuitBreaker('voice', { failureThreshold: 2, cooldownMs: 30_000, now: c.now });
  for (let i = 0; i < 2; i += 1) await assert.rejects(breaker.run('op', () => Promise.reject(transient())));

  c.advance(31_000);
  assert.equal(breaker.state(), 'half-open');
  await assert.rejects(breaker.run('op', () => Promise.reject(transient('still down'))));

  assert.equal(breaker.state(), 'open', 'still down means wait again');
  c.advance(29_000);
  assert.equal(breaker.state(), 'open', 'and the wait starts over, not where it left off');
});

test('only one call probes a half-open circuit', async () => {
  // Without this, everything queued behind the outage arrives together the
  // moment the cooldown expires and re-opens the circuit as a group - the
  // thundering herd the breaker exists to prevent.
  const c = clock();
  const breaker = new CircuitBreaker('meta', { failureThreshold: 1, cooldownMs: 10_000, now: c.now });
  await assert.rejects(breaker.run('op', () => Promise.reject(transient())));
  c.advance(11_000);
  assert.equal(breaker.state(), 'half-open');

  let reached = 0;
  const releases: Array<() => void> = [];
  const slow = (): Promise<string> => {
    reached += 1;
    return new Promise<string>((resolve) => {
      releases.push(() => resolve('ok'));
    });
  };

  const probe = breaker.run('op', slow);
  // A second caller arriving while the probe is in flight is turned away.
  await assert.rejects(breaker.run('op', slow), CircuitOpenError);
  assert.equal(reached, 1, 'exactly one call reaches the provider');

  releases[0]?.();
  assert.equal(await probe, 'ok');
  assert.equal(breaker.state(), 'closed');
});

test('the open error is itself transient, so callers defer rather than discard', async () => {
  // A lead whose dispatch fails because the circuit is open is a fine lead. If
  // this error did not read as transient, the paths that defer would treat it
  // as a permanent refusal and the person would never be called.
  const c = clock();
  const breaker = new CircuitBreaker('voice', { failureThreshold: 1, cooldownMs: 30_000, now: c.now });
  await assert.rejects(breaker.run('op', () => Promise.reject(transient())));

  const err = await breaker.run('op', () => Promise.resolve('x')).catch((e: unknown) => e);
  assert.ok(err instanceof CircuitOpenError);
  assert.equal(err.retryable, true);
  assert.ok(err.retryAfterMs > 0, 'and says how long is left');
  assert.match(err.message, /voice/);
});

test('an operator can force it shut once the provider is fixed', async () => {
  const c = clock();
  const breaker = new CircuitBreaker('meta', { failureThreshold: 1, cooldownMs: 300_000, now: c.now });
  await assert.rejects(breaker.run('op', () => Promise.reject(transient())));
  assert.equal(breaker.state(), 'open');

  breaker.reset();
  assert.equal(breaker.state(), 'closed');
  assert.equal(await breaker.run('op', () => Promise.resolve('through')), 'through');
});

test('each provider has its own circuit', async () => {
  // A dialler outage must not stop the system reading insights from Meta.
  const meta = breakerFor('meta', { failureThreshold: 1, cooldownMs: 30_000 });
  const voice = breakerFor('omnidimension', { failureThreshold: 1, cooldownMs: 30_000 });

  await assert.rejects(voice.run('op', () => Promise.reject(transient())));
  assert.equal(voice.state(), 'open');
  assert.equal(meta.state(), 'closed', 'one provider being down says nothing about the other');

  assert.equal(await meta.run('op', () => Promise.resolve('fine')), 'fine');
  assert.equal(allBreakers().length, 2);
});

test('the Meta client stops calling a provider that is down', async () => {
  // The unit tests above exercise the breaker; this one exercises the wiring.
  // Without it the class could be perfect and connected to nothing.
  resetAllBreakers();
  let fetches = 0;
  const provider = new MetaApiProvider({
    accessToken: 'EAAtesttoken',
    adAccountId: 'act_123456789',
    apiVersion: 'v21.0',
    retry: { attempts: 2, sleep: () => Promise.resolve(), onRetry: () => {} },
    fetchImpl: () => {
      fetches += 1;
      return Promise.reject(new Error('ECONNREFUSED'));
    },
  });

  // Default threshold is 5 logical operations, each of which retries twice.
  for (let i = 0; i < 5; i += 1) {
    await assert.rejects(provider.accountSummary());
  }
  const afterOpening = fetches;
  assert.equal(afterOpening, 10, 'five operations, two attempts each');

  await assert.rejects(provider.accountSummary(), CircuitOpenError);
  assert.equal(fetches, afterOpening, 'once open, nothing reaches the network at all');

  const status = allBreakers().find((b) => b.provider === 'meta');
  assert.equal(status?.state, 'open');
  assert.equal(status?.consecutiveFailures, 5);
});

test('a bad request through the Meta client leaves the circuit shut', async () => {
  // A 400 is our bug. It must not take Meta away from every other caller.
  resetAllBreakers();
  const provider = new MetaApiProvider({
    accessToken: 'EAAtesttoken',
    adAccountId: 'act_123456789',
    apiVersion: 'v21.0',
    retry: { attempts: 1, sleep: () => Promise.resolve(), onRetry: () => {} },
    fetchImpl: () =>
      Promise.resolve(new Response('{"error":{"message":"bad field"}}', { status: 400 })),
  });

  for (let i = 0; i < 10; i += 1) {
    await assert.rejects(provider.accountSummary(), /400/);
  }
  assert.equal(allBreakers().find((b) => b.provider === 'meta')?.state ?? 'closed', 'closed');
});

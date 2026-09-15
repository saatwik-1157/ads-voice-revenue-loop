import { test } from 'node:test';
import assert from 'node:assert/strict';
import { backoffDelay, isRetryable, parseRetryAfter, withRetry } from '../src/core/retry.ts';
import { MetaApiProvider } from '../src/meta/api.ts';
import { MetaApiError } from '../src/meta/provider.ts';
import { OmniDimensionProvider } from '../src/voice/omnidimension.ts';
import type { Brief, Lead } from '../src/core/types.ts';

/** Collects the delays instead of sleeping, so the suite stays fast. */
function recorder() {
  const slept: number[] = [];
  return {
    slept,
    options: { sleep: async (ms: number) => void slept.push(ms), random: () => 1, baseDelayMs: 100 },
  };
}

test('a transient failure is retried and the eventual success is returned', async () => {
  const { slept, options } = recorder();
  let calls = 0;
  const result = await withRetry(
    'flaky',
    async () => {
      calls += 1;
      if (calls < 3) throw new MetaApiError(503, 'service unavailable');
      return 'ok';
    },
    options,
  );
  assert.equal(result, 'ok');
  assert.equal(calls, 3);
  assert.deepEqual(slept, [100, 200], 'delays double between attempts');
});

test('a 4xx is a bug in the request and is thrown immediately', async () => {
  const { slept, options } = recorder();
  let calls = 0;
  await assert.rejects(
    () =>
      withRetry(
        'bad-request',
        async () => {
          calls += 1;
          throw new MetaApiError(400, 'invalid parameter');
        },
        options,
      ),
    /400/,
  );
  assert.equal(calls, 1, 'a permanent error must not be retried');
  assert.deepEqual(slept, []);
});

test('retries give up after the attempt budget and rethrow the last error', async () => {
  const { slept, options } = recorder();
  let calls = 0;
  await assert.rejects(
    () =>
      withRetry(
        'always-down',
        async () => {
          calls += 1;
          throw new MetaApiError(500, `attempt ${calls}`);
        },
        { ...options, attempts: 3 },
      ),
    /attempt 3/,
  );
  assert.equal(calls, 3);
  assert.equal(slept.length, 2, 'n attempts means n-1 sleeps');
});

test('a connection failure with no response is retryable', async () => {
  assert.equal(isRetryable(new TypeError('fetch failed')), true);
  assert.equal(isRetryable(new MetaApiError(0, 'ECONNRESET')), true);
  assert.equal(isRetryable(new MetaApiError(429, 'slow down')), true);
  assert.equal(isRetryable(new MetaApiError(500, 'boom')), true);
  assert.equal(isRetryable(new MetaApiError(400, 'bad')), false);
  assert.equal(isRetryable(new MetaApiError(403, 'forbidden')), false);
});

test('Retry-After wins over our own backoff formula', async () => {
  const { slept, options } = recorder();
  let calls = 0;
  await withRetry(
    'rate-limited',
    async () => {
      calls += 1;
      if (calls === 1) throw new MetaApiError(429, 'slow down', { retryAfterMs: 4500 });
      return 'ok';
    },
    options,
  );
  assert.deepEqual(slept, [4500]);
});

test('parseRetryAfter handles both header forms', () => {
  assert.equal(parseRetryAfter('30'), 30_000);
  assert.equal(parseRetryAfter('0'), 0);
  const now = Date.parse('2026-01-01T00:00:00Z');
  assert.equal(parseRetryAfter('Thu, 01 Jan 2026 00:00:10 GMT', now), 10_000);
  assert.equal(parseRetryAfter(null), undefined);
  assert.equal(parseRetryAfter('not-a-date'), undefined);
});

test('backoff is capped so a long outage does not sleep forever', () => {
  const options = { baseDelayMs: 1000, maxDelayMs: 5000, random: () => 1 };
  assert.equal(backoffDelay(1, options), 1000);
  assert.equal(backoffDelay(2, options), 2000);
  assert.equal(backoffDelay(3, options), 4000);
  assert.equal(backoffDelay(4, options), 5000);
  assert.equal(backoffDelay(9, options), 5000);
});

test('jitter draws from below the exponential, never above it', () => {
  const options = { baseDelayMs: 1000, maxDelayMs: 60_000, random: () => 0.25 };
  assert.equal(backoffDelay(3, options), 1000, 'full jitter: 25% of the 4000ms window');
});

test('the Meta client retries a 500 and sends the idempotency key every time', async () => {
  const seen: Array<Record<string, string>> = [];
  let calls = 0;
  const fetchImpl = (async (_url: string | URL, init: RequestInit) => {
    calls += 1;
    seen.push(init.headers as Record<string, string>);
    if (calls < 3) return new Response('{"error":"internal"}', { status: 500 });
    return new Response('{"id":"cmp_1"}', { status: 200 });
  }) as unknown as typeof fetch;

  const meta = new MetaApiProvider({
    accessToken: 'token',
    adAccountId: 'act_1',
    apiVersion: 'v21.0',
    fetchImpl,
    retry: { sleep: async () => {}, onRetry: () => {} },
  });

  const result = await meta.createCampaign({
    name: 'test',
    objective: 'OUTCOME_LEADS',
    specialAdCategories: [],
    idempotencyKey: 'run_1:campaign',
  });

  assert.equal(result.campaignId, 'cmp_1');
  assert.equal(calls, 3);
  assert.equal(seen.length, 3);
  for (const headers of seen) {
    assert.equal(
      headers['X-Business-Idempotency-Key'],
      'run_1:campaign',
      'every retry must carry the key, or a retry could create a second campaign',
    );
  }
});

test('the Meta client does not retry a rejected request', async () => {
  let calls = 0;
  const fetchImpl = (async () => {
    calls += 1;
    return new Response('{"error":{"message":"Invalid parameter"}}', { status: 400 });
  }) as unknown as typeof fetch;

  const meta = new MetaApiProvider({
    accessToken: 'token',
    adAccountId: 'act_1',
    apiVersion: 'v21.0',
    fetchImpl,
    retry: { sleep: async () => {}, onRetry: () => {} },
  });

  await assert.rejects(
    () => meta.setStatus('cmp_1', 'ACTIVE'),
    (err: unknown) => err instanceof MetaApiError && err.status === 400 && !err.retryable,
  );
  assert.equal(calls, 1);
});

test('the voice client retries a dispatch and never dials twice without the key', async () => {
  const keys: string[] = [];
  let calls = 0;
  const fetchImpl = (async (_url: string | URL, init: RequestInit) => {
    calls += 1;
    keys.push((init.headers as Record<string, string>)['Idempotency-Key']!);
    if (calls === 1) throw new TypeError('fetch failed');
    if (calls === 2) return new Response('{"error":"busy"}', { status: 429 });
    return new Response('{"requestId":"call_1"}', { status: 200 });
  }) as unknown as typeof fetch;

  const voice = new OmniDimensionProvider({
    apiKey: 'key',
    agentId: 'agent',
    baseUrl: 'https://example.invalid/api/v1',
    fetchImpl,
    retry: { sleep: async () => {}, onRetry: () => {} },
  });

  const lead = { leadId: 'lead_1', name: 'Asha', phoneE164: '+919876543210' } as Lead;
  const brief = {
    offer: { outcome: 'x', deliverable: 'y' },
    callScript: {
      opener: 'hi',
      qualifyingQuestions: [],
      approvedAnswers: {},
      objectionHandling: {},
      conversionAsk: 'book',
      optOutLine: 'opt out',
    },
  } as unknown as Brief;

  const result = await voice.dispatchCall({
    lead,
    brief,
    metadata: {},
    webhookUrl: 'https://example.invalid/hook',
    idempotencyKey: 'call:lead_1',
  });

  assert.equal(result.callRef, 'call_1');
  assert.equal(calls, 3);
  assert.deepEqual(new Set(keys), new Set(['call:lead_1']), 'the same key on every attempt');
});

test('a 200 with no call id is a contract error, not something to retry', async () => {
  let calls = 0;
  const fetchImpl = (async () => {
    calls += 1;
    return new Response('{"status":"queued"}', { status: 200 });
  }) as unknown as typeof fetch;

  const voice = new OmniDimensionProvider({
    apiKey: 'key',
    agentId: 'agent',
    baseUrl: 'https://example.invalid/api/v1',
    fetchImpl,
    retry: { sleep: async () => {}, onRetry: () => {} },
  });

  await assert.rejects(
    () =>
      voice.dispatchCall({
        lead: { leadId: 'lead_1', name: 'Asha', phoneE164: '+919876543210' } as Lead,
        brief: {
          offer: {},
          callScript: { qualifyingQuestions: [], approvedAnswers: {}, objectionHandling: {} },
        } as unknown as Brief,
        metadata: {},
        webhookUrl: 'https://example.invalid/hook',
        idempotencyKey: 'call:lead_1',
      }),
    /carried no call id/,
  );
  assert.equal(calls, 1);
});

test('secrets never reach the error message of a failed call', async () => {
  const fetchImpl = (async () =>
    new Response('{"error":"bad token EAAabcdefghijklmnopqrst"}', { status: 400 })) as unknown as typeof fetch;

  const meta = new MetaApiProvider({
    accessToken: 'EAAsupersecrettoken1234567890',
    adAccountId: 'act_1',
    apiVersion: 'v21.0',
    fetchImpl,
    retry: { sleep: async () => {}, onRetry: () => {} },
  });

  await assert.rejects(
    () => meta.setStatus('cmp_1', 'ACTIVE'),
    (err: unknown) => {
      const message = (err as Error).message;
      assert.ok(!message.includes('EAAabcdefghijklmnopqrst'), 'token in the response body must be redacted');
      assert.ok(!message.includes('EAAsupersecrettoken1234567890'), 'our own token must never be echoed');
      return true;
    },
  );
});

test('insights turn Meta spend into minor units, and refuse what is not a number', async () => {
  const rows = (body: unknown) =>
    (async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch;
  const client = (fetchImpl: typeof fetch) =>
    new MetaApiProvider({ accessToken: 't', adAccountId: 'act_1', apiVersion: 'v21.0', fetchImpl, retry: { attempts: 1 } });

  const ok = await client(
    rows({ data: [{ spend: '12.34', impressions: '5000', clicks: '60', actions: [{ action_type: 'lead', value: '7' }] }] }),
  ).insights(['ad_1']);
  assert.deepEqual(ok[0], { adId: 'ad_1', spendMinor: 1234, impressions: 5000, clicks: 60, leads: 7 });

  // An ad with no delivery yet returns no row at all; that is a real zero.
  const empty = await client(rows({ data: [] })).insights(['ad_1']);
  assert.equal(empty[0]?.spendMinor, 0);

  // A missing field is zero. A malformed one is not: Number(undefined) is NaN,
  // and NaN is not zero - it is a value every comparison is false against, so
  // one bad insights row would have turned CPL, ROAS and the stop-loss into
  // NaN and made every threshold in the decision engine read as unmet.
  const partial = await client(rows({ data: [{ impressions: '10' }] })).insights(['ad_1']);
  assert.deepEqual(partial[0], { adId: 'ad_1', spendMinor: 0, impressions: 10, clicks: 0, leads: 0 });

  for (const bad of [{ spend: 'n/a' }, { spend: '-5' }, { impressions: 'lots' }]) {
    await assert.rejects(client(rows({ data: [bad] })).insights(['ad_1']), /refusing to treat that as a number/);
  }

  // Actions is not always an array in the wild; an unexpected shape must not
  // throw a TypeError out of a sync that is otherwise fine.
  const weird = await client(rows({ data: [{ spend: '1.00', actions: 'none' }] })).insights(['ad_1']);
  assert.equal(weird[0]?.leads, 0);
});

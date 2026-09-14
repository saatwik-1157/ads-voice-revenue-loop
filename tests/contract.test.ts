import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diagnose, extractCallRef, probeDispatchContract, buildProbeRequest } from '../src/voice/contract.ts';
import { generateBrief } from '../src/brief/generator.ts';
import { defaultGuardrails } from '../src/config/guardrails.ts';
import type { Env } from '../src/config/env.ts';
import type { Brief, Lead } from '../src/core/types.ts';

const ENV = {
  mode: 'live',
  publicBaseUrl: 'https://example.test',
  omni: {
    apiKey: 'key',
    agentId: 'agent',
    baseUrl: 'https://api.omnidim.test/api/v1',
    webhookSecret: 'secret',
    webhookToken: '',
  },
} as unknown as Env;

const LEAD = {
  leadId: 'probe_1',
  runId: 'contract_probe',
  name: 'Contract Probe',
  phoneE164: '+919876543210',
  campaignId: 'cmp_1',
  adsetId: 'ads_1',
  adId: 'ad_1',
  creativeId: 'cr_1',
} as unknown as Lead;

let brief: Brief;
async function theBrief(): Promise<Brief> {
  brief ??= (await generateBrief(defaultGuardrails)).brief;
  return brief;
}

function respond(status: number, body: unknown): typeof fetch {
  return (async () => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status }));
}

function finding(result: { findings: Array<{ check: string; status: string; detail: string; fix?: string }> }, check: string) {
  return result.findings.find((f) => f.check === check);
}

test('a dry run sends nothing and still reports what it can check', async () => {
  let called = false;
  const result = await probeDispatchContract(
    { env: ENV, fetchImpl: (async () => void (called = true)) as never },
    LEAD,
    await theBrief(),
  );

  assert.equal(called, false, 'a dry run must not touch the network');
  assert.equal(finding(result, 'credentials')?.status, 'pass');
  assert.equal(finding(result, 'endpoint')?.status, 'skipped');
  assert.equal(result.passed, true);
});

test('the dry run surfaces configuration that would break the loop later', async () => {
  const blind = { ...ENV, omni: { ...ENV.omni, webhookSecret: '', webhookToken: '' } };
  const result = await probeDispatchContract({ env: blind }, LEAD, await theBrief());

  const inbound = finding(result, 'inbound auth');
  assert.equal(inbound?.status, 'fail');
  assert.match(inbound.detail, /401/, 'says what will actually go wrong, not just that a var is unset');
  assert.equal(result.passed, false);
});

test('a token-only setup passes but is flagged as the weaker choice', async () => {
  const tokenOnly = { ...ENV, omni: { ...ENV.omni, webhookSecret: '', webhookToken: 'tok' } };
  const result = await probeDispatchContract({ env: tokenOnly }, LEAD, await theBrief());
  assert.equal(finding(result, 'inbound auth')?.status, 'warn');
  assert.equal(result.passed, true);
});

test('a localhost callback is a warning, because a provider cannot reach it', async () => {
  const local = { ...ENV, publicBaseUrl: 'http://localhost:8787' };
  const result = await probeDispatchContract({ env: local }, LEAD, await theBrief());
  assert.equal(finding(result, 'webhook url')?.status, 'warn');
});

test('the request carries the identifiers the outcome has to come back with', async () => {
  const request = buildProbeRequest(ENV, '+919876543210', LEAD, await theBrief());
  const context = request.body.call_context as Record<string, unknown>;

  assert.equal(context.lead_id, 'probe_1', 'without this every outcome is dropped');
  assert.equal(context.ad_id, 'ad_1', 'without this nothing can be attributed');
  assert.equal(request.headers['Idempotency-Key'], 'call:probe_1');
  assert.match(request.url, /\/calls\/dispatch$/);
  assert.ok(!JSON.stringify(request.headers).includes('key'), 'the dry run never prints the real key');
});

test('each failure mode names the thing to change', () => {
  const notFound = diagnose({ status: 404, text: 'no route' }, 'https://api.test/calls/dispatch');
  assert.equal(notFound[0]?.status, 'fail');
  assert.match(notFound[0].fix!, /OMNI_BASE_URL|dispatchCall/);

  const unauthorized = diagnose({ status: 401, text: 'bad key' }, 'https://api.test/x');
  assert.equal(unauthorized.find((f) => f.check === 'endpoint')?.status, 'pass', 'a 401 proves the path exists');
  assert.match(unauthorized.find((f) => f.check === 'auth')!.fix!, /OMNI_API_KEY|Authorization/);

  const rejected = diagnose({ status: 422, text: '{"error":"to_number is required"}' }, 'https://api.test/x');
  const shape = rejected.find((f) => f.check === 'request shape')!;
  assert.equal(shape.status, 'fail');
  assert.match(shape.detail, /to_number is required/, 'the provider message is what names the field');
  assert.match(shape.fix!, /body object literal/);

  const flaky = diagnose({ status: 503, text: 'upstream' }, 'https://api.test/x');
  assert.equal(flaky[0]?.status, 'warn', 'a 5xx is transient, not a contract mismatch');
});

test('a 200 with no recognisable call id is a contract mismatch, not a success', () => {
  const ok = diagnose({ status: 200, text: '{"requestId":"abc"}' }, 'https://api.test/x');
  assert.equal(ok.find((f) => f.check === 'response id')?.status, 'pass');

  const nameless = diagnose({ status: 200, text: '{"status":"queued"}' }, 'https://api.test/x');
  const id = nameless.find((f) => f.check === 'response id')!;
  assert.equal(id.status, 'fail');
  assert.match(id.fix!, /fallback chain/);
});

test('extractCallRef reads the shapes we accept, and gives up cleanly', () => {
  assert.equal(extractCallRef('{"requestId":"a"}'), 'a');
  assert.equal(extractCallRef('{"call_id":"b"}'), 'b');
  assert.equal(extractCallRef('{"id":"c"}'), 'c');
  assert.equal(extractCallRef('{"nope":1}'), null);
  assert.equal(extractCallRef('<html>504</html>'), null, 'an HTML error page must not throw');
});

test('a live probe reports the endpoint working', async () => {
  const result = await probeDispatchContract(
    { env: ENV, live: true, to: '+919876543210', fetchImpl: respond(200, { call_id: 'call_1' }) },
    LEAD,
    await theBrief(),
  );
  assert.equal(finding(result, 'request shape')?.status, 'pass');
  assert.equal(finding(result, 'response id')?.status, 'pass');
  assert.equal(result.passed, true);
});

test('the idempotency check is the one that decides whether retries are safe', async () => {
  let n = 0;
  const differentEachTime = (async () => {
    n += 1;
    return new Response(JSON.stringify({ call_id: `call_${n}` }), { status: 200 });
  }) as never;

  const unsafe = await probeDispatchContract(
    { env: ENV, live: true, to: '+919876543210', checkIdempotency: true, fetchImpl: differentEachTime },
    LEAD,
    await theBrief(),
  );
  const bad = finding(unsafe, 'idempotency')!;
  assert.equal(bad.status, 'fail');
  assert.match(bad.detail, /dials twice/);
  assert.match(bad.fix!, /attempts: 1/);

  const safe = await probeDispatchContract(
    { env: ENV, live: true, to: '+919876543210', checkIdempotency: true, fetchImpl: respond(200, { call_id: 'same' }) },
    LEAD,
    await theBrief(),
  );
  assert.equal(finding(safe, 'idempotency')?.status, 'pass');
});

test('an unreachable host fails on the endpoint rather than throwing at the caller', async () => {
  const result = await probeDispatchContract(
    {
      env: ENV,
      live: true,
      to: '+919876543210',
      fetchImpl: (async () => {
        throw new TypeError('getaddrinfo ENOTFOUND');
      }),
    },
    LEAD,
    await theBrief(),
  );
  const endpoint = finding(result, 'endpoint')!;
  assert.equal(endpoint.status, 'fail');
  assert.match(endpoint.detail, /ENOTFOUND/);
  assert.equal(result.passed, false);
});

test('an unusable --to number is caught before anything is dialled', async () => {
  const result = await probeDispatchContract({ env: ENV, to: 'not-a-number' }, LEAD, await theBrief());
  assert.equal(finding(result, 'to number')?.status, 'fail');
  assert.equal(result.passed, false);
});

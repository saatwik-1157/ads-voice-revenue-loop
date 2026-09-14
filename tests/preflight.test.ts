import { test } from 'node:test';
import assert from 'node:assert/strict';
import { preflight } from '../src/meta/preflight.ts';
import { publishCampaign } from '../src/meta/publisher.ts';
import { MockMetaProvider } from '../src/meta/mock.ts';
import { Store } from '../src/store/db.ts';
import { defaultGuardrails, GuardrailViolation } from '../src/config/guardrails.ts';
import { generateBrief } from '../src/brief/generator.ts';
import { approve, requestGate1 } from '../src/approvals/gates.ts';
import type { Env } from '../src/config/env.ts';

/**
 * The checks that run before a real ad account is touched.
 *
 * The currency one is the reason the command exists. Budgets are sent to Meta
 * as an integer of the *account's* minor units while every cap in the control
 * layer is written in the guardrails' currency, and nothing verified the two
 * agreed: guardrails in INR against a USD account send "100000" for a 1,000
 * rupee cap and buy a 1,000 dollar campaign - about 85x - with the stop-loss
 * and the CPL target denominated wrong at the same time. It only bites in live
 * mode, which is the one place none of the other tests go.
 */

const G = { ...defaultGuardrails, callWindow: { startHour: 0, endHour: 24, timeZone: 'UTC' } };

const ENV = {
  mode: 'live',
  meta: {
    accessToken: 'tok',
    adAccountId: 'act_123',
    pageId: 'page_1',
    apiVersion: 'v21.0',
  },
} as unknown as Env;

/** A Graph API that answers whatever the test wants it to. */
function graph(routes: Record<string, unknown>, status = 200): typeof fetch {
  return (async (input: string | URL) => {
    const url = new URL(String(input));
    const key = [...Object.keys(routes)].find((k) => url.pathname.includes(k));
    const body = key ? routes[key] : { error: { message: `no stub for ${url.pathname}` } };
    return new Response(JSON.stringify(body), { status: key ? status : 404 });
  }) as unknown as typeof fetch;
}

const GOOD_TOKEN = {
  data: { is_valid: true, expires_at: 0, type: 'SYSTEM_USER', scopes: ['ads_management', 'ads_read', 'leads_retrieval', 'pages_show_list'] },
};

function find(findings: Array<{ check: string; status: string; detail: string; fix?: string }>, check: string) {
  const hit = findings.find((f) => f.check === check);
  assert.ok(hit, `expected a "${check}" finding, got: ${findings.map((f) => f.check).join(', ')}`);
  return hit;
}

test('an account billing in another currency fails preflight, loudly', async () => {
  const result = await preflight({
    env: ENV,
    guardrails: { ...G, currency: 'INR' },
    fetchImpl: graph({
      debug_token: GOOD_TOKEN,
      act_123: { name: 'Acme', currency: 'USD', account_status: 1, timezone_name: 'America/New_York' },
      page_1: { name: 'Acme Page', id: 'page_1' },
    }),
  });

  const currency = find(result.findings, 'currency');
  assert.equal(currency.status, 'fail');
  assert.match(currency.detail, /USD/);
  assert.match(currency.detail, /INR/);
  assert.match(currency.fix ?? '', /guardrails\.json/, 'it says which line to change');
  assert.equal(result.passed, false);
});

test('matching currencies pass', async () => {
  const result = await preflight({
    env: ENV,
    guardrails: { ...G, currency: 'INR' },
    fetchImpl: graph({
      debug_token: GOOD_TOKEN,
      act_123: { name: 'Acme', currency: 'INR', account_status: 1, timezone_name: 'Asia/Kolkata' },
      page_1: { name: 'Acme Page', id: 'page_1' },
    }),
  });
  assert.equal(find(result.findings, 'currency').status, 'pass');
  assert.equal(result.passed, true, result.findings.filter((f) => f.status === 'fail').map((f) => f.detail).join('; '));
});

test('a missing scope is named, with what it was needed for', async () => {
  const result = await preflight({
    env: ENV,
    guardrails: G,
    fetchImpl: graph({
      debug_token: { data: { is_valid: true, expires_at: 0, scopes: ['ads_management', 'ads_read'] } },
      act_123: { name: 'Acme', currency: G.currency, account_status: 1 },
      page_1: { name: 'Acme Page', id: 'page_1' },
    }),
  });

  // leads_retrieval is the one whose absence is only discovered when the first
  // real lead arrives and its answers cannot be fetched.
  const scope = find(result.findings, 'scope leads_retrieval');
  assert.equal(scope.status, 'fail');
  assert.match(scope.detail, /answers/);
  assert.equal(find(result.findings, 'scope ads_management').status, 'pass');
  assert.equal(result.passed, false);
});

test('a token about to expire warns without blocking', async () => {
  const soon = Math.floor(Date.now() / 1000) + 5 * 86_400;
  const result = await preflight({
    env: ENV,
    guardrails: G,
    fetchImpl: graph({
      debug_token: { data: { ...GOOD_TOKEN.data, expires_at: soon } },
      act_123: { name: 'Acme', currency: G.currency, account_status: 1 },
      page_1: { name: 'Acme Page', id: 'page_1' },
    }),
  });
  const token = find(result.findings, 'access token');
  assert.equal(token.status, 'warn', 'a warning, because it works today');
  assert.match(token.fix ?? '', /scheduler|long-lived/i, 'and says why it matters for an unattended loop');
  assert.equal(result.passed, true, 'warnings do not block');
});

test('a disabled ad account fails', async () => {
  const result = await preflight({
    env: ENV,
    guardrails: G,
    fetchImpl: graph({
      debug_token: GOOD_TOKEN,
      act_123: { name: 'Acme', currency: G.currency, account_status: 2, disable_reason: 1 },
      page_1: { name: 'Acme Page', id: 'page_1' },
    }),
  });
  assert.equal(find(result.findings, 'account status').status, 'fail');
  assert.equal(result.passed, false);
});

test('a lead form with no phone question fails', async () => {
  const result = await preflight({
    env: ENV,
    guardrails: G,
    leadFormId: 'form_1',
    fetchImpl: graph({
      debug_token: GOOD_TOKEN,
      act_123: { name: 'Acme', currency: G.currency, account_status: 1 },
      page_1: { name: 'Acme Page', id: 'page_1' },
      form_1: { name: 'Quote form', status: 'ACTIVE', questions: [{ type: 'FULL_NAME' }, { type: 'EMAIL' }] },
    }),
  });
  const phone = find(result.findings, 'lead form phone field');
  assert.equal(phone.status, 'fail', 'a voice funnel with no phone number is not a funnel');
  assert.equal(result.passed, false);
});

test('missing credentials stop before any network call', async () => {
  let called = 0;
  const counting = (async () => {
    called += 1;
    return new Response('{}');
  }) as unknown as typeof fetch;

  const result = await preflight({
    env: { mode: 'live', meta: { accessToken: '', adAccountId: '', pageId: '' } } as unknown as Env,
    guardrails: G,
    fetchImpl: counting,
  });
  assert.equal(called, 0, 'nothing is sent when there is nothing to send it with');
  assert.equal(result.passed, false);
  assert.match(find(result.findings, 'credentials').detail, /META_ACCESS_TOKEN/);
});

test('publishing refuses outright when the account currency disagrees', async () => {
  // Preflight is the early warning; this is the stop. A mismatch discovered
  // here means a budget would have been sent in the wrong unit.
  const store = new Store(':memory:');
  const { brief } = await generateBrief(G);
  for (const c of brief.creatives) {
    c.assetRef = `hash_${c.creativeId}`;
    c.assetProvenance = 'manual';
  }
  const runId = store.createRun(brief.niche.name);
  store.saveBrief(runId, brief);
  approve(store, requestGate1(store, G, runId, brief, 50000).approvalId, 'tester');

  const usdAccount = new MockMetaProvider(5, null, 'USD');
  await assert.rejects(
    publishCampaign(store, usdAccount, { ...G, currency: 'INR' }, runId, brief, 'page_1', {
      dailyBudgetMinor: 50000,
      windowDays: 5,
      activate: true,
    }),
    (err: Error) => err instanceof GuardrailViolation && /currency_mismatch/.test(err.message),
  );
  store.close();
});

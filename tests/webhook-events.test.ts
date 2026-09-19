import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { Store } from '../src/store/db.ts';
import { defaultGuardrails } from '../src/config/guardrails.ts';
import { generateBrief } from '../src/brief/generator.ts';
import { createHttpServer } from '../src/server/http.ts';
import { intakeLead } from '../src/pipeline/intake.ts';
import type { Context } from '../src/orchestrator.ts';

/**
 * Every delivery is recorded, and a redelivery changes nothing.
 *
 * The guarantee under test is not "the second request returns 200" - it is that
 * the second request creates no second lead, no second call, and no second
 * revenue row. A replay that is acknowledged but also acted on is worse than
 * one that is rejected.
 */

const APP_SECRET = 'meta-app-secret';
const OMNI_TOKEN = 'omni-token';

let server: Server;
let store: Store;
let base: string;
let runId: string;

before(async () => {
  store = new Store(':memory:');
  const { brief } = await generateBrief(defaultGuardrails);
  runId = store.createRun(brief.niche.name);
  store.saveBrief(runId, brief);
  store.setRunState(runId, 'live');

  const ctx = {
    store,
    guardrails: { ...defaultGuardrails, callWindow: { startHour: 0, endHour: 24, timeZone: 'UTC' } },
    meta: { kind: 'mock' },
    voice: { kind: 'mock' },
    env: {
      mode: 'mock',
      port: 0,
      publicBaseUrl: 'http://localhost',
      meta: { appSecret: APP_SECRET, verifyToken: 'vt', pageId: 'page_1' },
      omni: { webhookToken: OMNI_TOKEN, webhookSecret: '' },
      previewDir: null,
    },
  } as unknown as Context;

  server = createHttpServer(ctx);
  server.listen(0);
  await once(server, 'listening');
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  server.close();
  await once(server, 'close');
  store.close();
});

async function postMeta(body: string): Promise<{ status: number; json: Record<string, unknown> }> {
  const signature = `sha256=${createHmac('sha256', APP_SECRET).update(body, 'utf8').digest('hex')}`;
  const res = await fetch(`${base}/webhooks/meta`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-hub-signature-256': signature },
    body,
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

async function postOmni(body: string): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${base}/webhooks/omnidimension`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${OMNI_TOKEN}` },
    body,
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

test('every delivery is recorded before it is acted on', async () => {
  const body = JSON.stringify({ object: 'page', entry: [] });
  const res = await postMeta(body);
  assert.equal(res.status, 200);

  const event = store.webhookEvent(res.json.eventId as string);
  assert.ok(event, 'the delivery has a row');
  assert.equal(event.provider, 'meta');
  assert.equal(event.signatureVerified, 1);
  assert.equal(event.status, 'ignored', 'nothing to act on, and it says so');
  assert.ok(event.processedAt, 'and it is closed out');
  assert.match(event.payloadHash, /^[0-9a-f]{64}$/, 'identified by hash, not by storing the body');
});

test('a rejected signature is recorded too', async () => {
  const before = store.listWebhookEvents({ status: 'failed' }).length;
  const res = await fetch(`${base}/webhooks/meta`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-hub-signature-256': 'sha256=deadbeef' },
    body: JSON.stringify({ object: 'page', entry: [] }),
  });
  assert.equal(res.status, 401);

  const failures = store.listWebhookEvents({ status: 'failed' });
  assert.equal(failures.length, before + 1, 'a forged or misconfigured delivery leaves a trace');
  assert.equal(failures[0]?.signatureVerified, 0);
  assert.match(failures[0]?.failureReason ?? '', /signature/);
});

test('a redelivered call outcome creates no second call and no second revenue row', async () => {
  const intake = intakeLead(store, defaultGuardrails, runId, {
    name: 'Asha R',
    phone: '9876543210',
    consent: true,
    consentSource: 'meta_instant_form',
    adId: 'ad_1',
  });
  if (intake.status !== 'accepted') throw new Error('setup failed');
  const leadId = intake.lead.leadId;

  const body = JSON.stringify({
    call_id: 'call_replay_1',
    lead_id: leadId,
    connected: true,
    qualified: true,
    sale_status: 'won',
    expected_value: 5000,
  });

  const first = await postOmni(body);
  assert.equal(first.status, 200);
  assert.equal(first.json.status, 'recorded');

  const second = await postOmni(body);
  assert.equal(second.json.status, 'duplicate', 'the second delivery is recognised');
  const third = await postOmni(body);
  assert.equal(third.json.status, 'duplicate');

  // The substance: nothing was done twice.
  assert.equal(store.callCountForLead(leadId), 1, 'one call row');
  const revenue = store.db
    .prepare('SELECT COUNT(*) AS n, COALESCE(SUM(amount_minor),0) AS total FROM revenue WHERE lead_id = ?')
    .get(leadId) as { n: number; total: number };
  assert.equal(revenue.n, 1, 'one revenue row');
  assert.equal(revenue.total, 500000, 'counted once');
  assert.equal(
    store.listAudit(runId, { kind: 'revenue.recorded' }).length,
    1,
    'and the audit trail says it happened once',
  );
});

test('two deliveries about different calls are both processed', async () => {
  // Dedupe must not collapse genuinely different events.
  const second = intakeLead(store, defaultGuardrails, runId, {
    name: 'Ravi K',
    phone: '9876500000',
    consent: true,
    consentSource: 'meta_instant_form',
    adId: 'ad_1',
  });
  if (second.status !== 'accepted') throw new Error('setup failed');

  const res = await postOmni(
    JSON.stringify({ call_id: 'call_distinct', lead_id: second.lead.leadId, connected: true }),
  );
  assert.equal(res.json.status, 'recorded', 'a different call id is a different event');
  assert.equal(store.callCountForLead(second.lead.leadId), 1);
});

test('the event log can be filtered, which is the point of keeping it', () => {
  const all = store.listWebhookEvents({ limit: 100 });
  assert.ok(all.length >= 4, 'deliveries accumulate');

  const failed = store.listWebhookEvents({ status: 'failed' });
  assert.ok(failed.every((e) => e.status === 'failed'));

  const omni = store.listWebhookEvents({ provider: 'omnidimension', limit: 100 });
  assert.ok(omni.length >= 2);
  assert.ok(omni.every((e) => e.provider === 'omnidimension'));

  // Feeds the health check and the safety loop, and the two counters are kept
  // apart on purpose. A refused forgery is this system working; counting it as
  // a failure let an unauthenticated caller engage the emergency stop.
  assert.ok(store.webhookRejectionsSince('2000-01-01T00:00:00.000Z') >= 1, 'the rejection was recorded');
  assert.equal(
    store.webhookFailuresSince('2000-01-01T00:00:00.000Z'),
    0,
    'a rejected signature is not a processing failure',
  );

  // And a delivery that verified and then broke does count.
  const broke = store.recordWebhookEvent({
    provider: 'omnidimension',
    providerEventId: 'call_that_broke',
    payloadHash: 'hash_that_broke',
    signatureVerified: true,
  });
  store.finishWebhookEvent(broke.eventId, 'failed', 'handler threw');
  assert.equal(store.webhookFailuresSince('2000-01-01T00:00:00.000Z'), 1);
  assert.equal(store.webhookFailuresSince('2999-01-01T00:00:00.000Z'), 0);
});

test('a second genuine sale adds to the first rather than replacing it', () => {
  // Revenue was keyed `rev_${leadId}` with INSERT OR REPLACE, so a lead could
  // hold one revenue row ever. Three sales of 900, 500 and 200 reported as 200,
  // while the audit trail recorded all three and nothing reconciled the two.
  const s = new Store(':memory:');
  const runId = s.createRun('revenue');
  const intake = intakeLead(s, defaultGuardrails, runId, {
    name: 'Asha R',
    phone: '9876543210',
    consent: true,
    consentSource: 'meta_instant_form',
    adId: 'ad_1',
  });
  if (intake.status !== 'accepted') throw new Error('setup failed');
  const leadId = intake.lead.leadId;

  s.recordRevenue(leadId, 90000, 'voice_agent', 'call:call_1');
  assert.equal(s.revenueMinor(runId), 90000);

  // The same call redelivered - one event, recorded once.
  s.recordRevenue(leadId, 90000, 'voice_agent', 'call:call_1');
  assert.equal(s.revenueMinor(runId), 90000, 'a redelivery is the same sale');

  // A second call to the same person that also converts.
  s.recordRevenue(leadId, 50000, 'voice_agent', 'call:call_2');
  assert.equal(s.revenueMinor(runId), 140000, 'a second sale adds');

  // And an upsell posted from outside.
  s.recordRevenue(leadId, 20000, 'crm', 'ext:invoice_77');
  assert.equal(s.revenueMinor(runId), 160000, 'three sales, all of them counted');

  s.close();
});

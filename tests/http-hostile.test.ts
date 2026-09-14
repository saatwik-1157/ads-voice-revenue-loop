import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { Store } from '../src/store/db.ts';
import { defaultGuardrails } from '../src/config/guardrails.ts';
import { createHttpServer } from '../src/server/http.ts';
import type { Context } from '../src/orchestrator.ts';

/**
 * What the server does with input nobody meant to send.
 *
 * The status code is the substance of these tests, not a detail. Meta and
 * OmniDimension retry on 5xx, so answering a permanently broken payload with
 * 500 signs this server up for that payload again, on their schedule, forever.
 * A request the sender got wrong has to come back 4xx and stay delivered.
 */

const APP_SECRET = 'meta-app-secret';
const ADMIN_TOKEN = 'admin-token';

let server: Server;
let store: Store;
let base: string;

before(async () => {
  store = new Store(':memory:');
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
      omni: { webhookSecret: 'omni' },
      previewDir: null,
    },
  } as unknown as Context;

  process.env.FL_ADMIN_TOKEN = ADMIN_TOKEN;
  server = createHttpServer(ctx);
  server.listen(0);
  await once(server, 'listening');
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  server.close();
  await once(server, 'close');
  store.close();
  delete process.env.FL_ADMIN_TOKEN;
});

/** Post a body exactly as given - a string stays a string, however broken. */
async function post(
  path: string,
  body: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: string }> {
  const res = await fetch(`${base}${path}`, { method: 'POST', headers, body });
  return { status: res.status, body: await res.text() };
}

function signed(body: string): Record<string, string> {
  return { 'x-hub-signature-256': `sha256=${createHmac('sha256', APP_SECRET).update(body, 'utf8').digest('hex')}` };
}

const admin = { 'x-fl-admin-token': ADMIN_TOKEN };

test('a body that is not JSON is the sender\'s problem, not a 500', async () => {
  const res = await post('/revenue', 'this is not json', admin);
  assert.equal(res.status, 400, 'a 500 here asks Meta to redeliver this forever');
  assert.match(res.body, /not valid JSON/);
});

test('JSON that is not an object is refused before anything reads a property off it', async () => {
  for (const body of ['null', '42', '[]', '"string"']) {
    const res = await post('/revenue', body, admin);
    assert.equal(res.status, 400, `${body} should be a bad request`);
    assert.match(res.body, /must be a JSON object/);
  }
});

test('an oversized body is answered, not dropped', async () => {
  // The connection used to be destroyed mid-request, so the sender could not
  // tell an oversized payload from this server falling over.
  const res = await post('/revenue', 'a'.repeat(1_200_000), admin);
  assert.equal(res.status, 413);
  assert.match(res.body, /exceeds/);
});

test('a token whose bytes and characters disagree is refused, not a crash', async () => {
  // "probé".length === "probe".length, but the UTF-8 buffers differ in length
  // and timingSafeEqual throws on that - which surfaced as 500, not 403.
  const res = await post('/revenue', '{}', { 'x-fl-admin-token': 'admin-tokeé' });
  assert.equal(res.status, 403);
});

test('revenue has to be a whole, non-negative number of minor units', async () => {
  const bad = [
    '{"leadId":"lead_1","amountMinor":-500000}',
    '{"leadId":"lead_1","amountMinor":"99999999"}',
    '{"leadId":"lead_1","amountMinor":1e308}',
    '{"leadId":"lead_1","amountMinor":12.5}',
    '{"leadId":"lead_1"}',
    '{"amountMinor":1000}',
    '{"leadId":"","amountMinor":1000}',
  ];
  for (const body of bad) {
    const res = await post('/revenue', body, admin);
    // Revenue is what KEEP/KILL/SCALE is decided from. A poisoned figure here
    // does not throw - it makes the engine scale a campaign that is losing.
    assert.equal(res.status, 400, `${body} must not reach the ledger`);
  }
});

test('a well-formed revenue post for an unknown lead is a 404, not a 400', async () => {
  const res = await post('/revenue', '{"leadId":"nope","amountMinor":1000}', admin);
  assert.equal(res.status, 404, 'the request was fine; the lead is what is missing');
});

test('an authentic Meta payload with a broken shape is accepted and ignored', async () => {
  // 200 is deliberate: the delivery succeeded and there was nothing to act on.
  // A non-2xx would put it back in Meta's retry queue to no purpose.
  for (const body of [
    '{"entry":42}',
    '{"entry":"nope"}',
    '{"entry":[null]}',
    '{"entry":[{"changes":"x"}]}',
    '{"entry":[{"changes":[{"field":"leadgen","value":null}]}]}',
    '{"entry":[{"changes":[{"field":"leadgen"}]}]}',
    '{}',
  ]) {
    const res = await post('/webhooks/meta', body, { ...signed(body), 'content-type': 'application/json' });
    assert.equal(res.status, 200, `${body} should not be a 500`);
    assert.match(res.body, /"received": 0/, `${body} should produce no leads`);
  }
});

test('the signature is checked before the body is parsed', async () => {
  // Order matters: an unsigned request should not be able to learn anything
  // about how this server parses, and garbage should not reach the parser.
  const res = await post('/webhooks/meta', 'not json at all', { 'x-hub-signature-256': 'sha256=deadbeef' });
  assert.equal(res.status, 401);
});

test('a refused request is written to the audit trail', async () => {
  await post('/revenue', 'nonsense', admin);
  const rejected = store.listAudit(null).filter((e) => e.kind === 'http.rejected');
  assert.ok(rejected.length > 0, 'refusals are findable afterwards');
});

test('the server is still healthy after all of that', async () => {
  const res = await fetch(`${base}/health`);
  assert.equal(res.status, 200);
  assert.equal(((await res.json()) as { ok: boolean }).ok, true);
});

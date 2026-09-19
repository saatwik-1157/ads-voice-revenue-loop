import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { Store } from '../src/store/db.ts';
import { defaultGuardrails } from '../src/config/guardrails.ts';
import { createHttpServer } from '../src/server/http.ts';
import { RateLimiter, RATE_LIMITS } from '../src/server/ratelimit.ts';
import { identify, permits } from '../src/server/access.ts';
import type { Context } from '../src/orchestrator.ts';
import type { IncomingMessage } from 'node:http';

/**
 * Who may reach what.
 *
 * GET /runs and GET /runs/:id used to be completely open - economics,
 * recommendations and pending approvals available to anyone who could reach the
 * port. The tests below are mostly about the routes that were open, not the
 * ones that were already closed.
 */

const ADMIN = 'admin-secret-token';
const VIEWER = 'viewer-secret-token';

let server: Server;
let store: Store;
let base: string;
let runId: string;

before(async () => {
  process.env.FL_ADMIN_TOKEN = ADMIN;
  process.env.FL_VIEWER_TOKEN = VIEWER;

  store = new Store(':memory:');
  runId = store.createRun('access test');

  const ctx = {
    store,
    guardrails: defaultGuardrails,
    meta: { kind: 'mock' },
    voice: { kind: 'mock' },
    env: {
      mode: 'mock',
      port: 0,
      publicBaseUrl: 'http://localhost',
      meta: { appSecret: 'sekrit', verifyToken: 'vt', pageId: 'page_1' },
      omni: { webhookSecret: 'omni', webhookToken: '' },
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
  delete process.env.FL_ADMIN_TOKEN;
  delete process.env.FL_VIEWER_TOKEN;
});

const get = (path: string, token?: string): Promise<Response> =>
  fetch(`${base}${path}`, { headers: token ? { 'x-fl-token': token } : {} });

test('the read routes are closed to anonymous callers', async () => {
  // This is the regression that matters: both of these answered 200 to anybody.
  assert.equal((await get('/runs')).status, 401);
  assert.equal((await get(`/runs/${runId}`)).status, 401);
});

test('a viewer token opens the read routes and nothing else', async () => {
  assert.equal((await get('/runs', VIEWER)).status, 200);

  const write = await fetch(`${base}/revenue`, {
    method: 'POST',
    headers: { 'x-fl-token': VIEWER, 'content-type': 'application/json' },
    body: JSON.stringify({ leadId: 'x', amountMinor: 100 }),
  });
  assert.equal(write.status, 401, 'reading the numbers is not permission to move money');
});

test('an admin token satisfies a viewer requirement', async () => {
  // Admin is a superset. Otherwise every admin would need two tokens.
  assert.equal((await get('/runs', ADMIN)).status, 200);
});

test('a wrong token is refused, and the refusal does not hint at the real one', async () => {
  const res = await get('/runs', 'not-the-token');
  assert.equal(res.status, 401);
  const body = await res.text();
  assert.ok(!body.includes(ADMIN) && !body.includes(VIEWER), 'the response leaks neither secret');
});

test('an unauthorised attempt is recorded', async () => {
  const before = store.listAudit(null, { kind: 'http.unauthorized' }).length;
  await get('/runs');
  assert.ok(
    store.listAudit(null, { kind: 'http.unauthorized' }).length > before,
    'somebody probing the read routes leaves a trace',
  );
});

test('liveness needs no credentials; readiness reports something real', async () => {
  // A load balancer has no token, so liveness must be open - but it says
  // nothing beyond "this process is up".
  const live = await get('/health');
  assert.equal(live.status, 200);
  assert.equal(((await live.json()) as { ok: boolean }).ok, true);

  const ready = await get('/health/ready');
  assert.equal(ready.status, 200);
  const body = (await ready.json()) as {
    ready: boolean;
    checks: Record<string, { ok: boolean }>;
    autopilot: { state: string };
  };
  assert.equal(body.ready, true);
  assert.equal(body.checks.database?.ok, true, 'the database is actually queried, not assumed');
  assert.equal(body.autopilot.state, 'active');
});

test('readiness fails when the system is not ready, which is the entire point', async () => {
  // The old /health returned a static ok and could not report a problem.
  for (let i = 0; i < 6; i += 1) {
    const e = store.recordWebhookEvent({
      provider: 'omnidimension',
      providerEventId: null,
      payloadHash: `h${i}`,
      signatureVerified: false,
    });
    store.finishWebhookEvent(e.eventId, 'failed', 'signature verification failed');
  }

  const res = await get('/health/ready');
  assert.equal(res.status, 503, 'a failing readiness probe returns 503, not 200');
  const body = (await res.json()) as { ready: boolean; checks: Record<string, { ok: boolean }> };
  assert.equal(body.ready, false);
  assert.equal(body.checks.webhooks?.ok, false);
});

test('identify prefers the stronger role when both tokens match', () => {
  // If someone sets both variables to the same value, being silently
  // downgraded to viewer would be a confusing way to lose access.
  process.env.FL_ADMIN_TOKEN = 'same';
  process.env.FL_VIEWER_TOKEN = 'same';
  const req = { headers: { 'x-fl-token': 'same' } } as unknown as IncomingMessage;
  assert.equal(identify(req)?.role, 'admin');

  process.env.FL_ADMIN_TOKEN = ADMIN;
  process.env.FL_VIEWER_TOKEN = VIEWER;
});

test('an unset token authenticates nobody', () => {
  const saved = process.env.FL_ADMIN_TOKEN;
  delete process.env.FL_ADMIN_TOKEN;
  delete process.env.FL_VIEWER_TOKEN;

  // An empty expected value must not match an empty supplied value, or an
  // unconfigured deployment would be wide open to a caller sending nothing.
  const req = { headers: { 'x-fl-token': '' } } as unknown as IncomingMessage;
  assert.equal(identify(req), null);
  assert.equal(permits(null, 'viewer'), false);

  process.env.FL_ADMIN_TOKEN = saved;
  process.env.FL_VIEWER_TOKEN = VIEWER;
});

test('the limiter refuses a burst and then refills', () => {
  let clock = 0;
  const limiter = new RateLimiter({ now: () => clock });
  const rule = { burst: 3, refillPerSecond: 1 };

  assert.equal(limiter.check('k', rule).allowed, true);
  assert.equal(limiter.check('k', rule).allowed, true);
  assert.equal(limiter.check('k', rule).allowed, true);

  const refused = limiter.check('k', rule);
  assert.equal(refused.allowed, false);
  assert.ok(refused.retryAfterSeconds >= 1, 'and says how long to wait');

  clock += 2000;
  assert.equal(limiter.check('k', rule).allowed, true, 'a token is back after a second');

  // Separate callers have separate budgets.
  assert.equal(limiter.check('other', rule).allowed, true);
});

test('the limiter does not grow without bound', () => {
  // Otherwise varying the key IS the denial of service.
  const limiter = new RateLimiter({ maxKeys: 5 });
  for (let i = 0; i < 50; i += 1) limiter.check(`key_${i}`, RATE_LIMITS.read!);
  assert.equal(limiter.check('key_49', RATE_LIMITS.read!).allowed, true, 'still serving after 50 distinct keys');
});

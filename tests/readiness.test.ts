import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store/db.ts';
import { defaultGuardrails } from '../src/config/guardrails.ts';
import { assessReadiness, formatReadiness } from '../src/readiness.ts';
import type { Context } from '../src/orchestrator.ts';

/**
 * Two gates, kept apart.
 *
 * "Can this run as a service" and "may this spend money and call strangers"
 * are different questions. The tests that matter here are the ones asserting
 * they cannot be confused: a deployable service is not a live one, and nothing
 * reports live-ready until the providers have actually been exercised.
 */

const SECRET = 'EAAverysecrettokenvalue123456';

function context(overrides: {
  mode?: 'mock' | 'live';
  publicBaseUrl?: string;
  meta?: Partial<Context['env']['meta']>;
  omni?: Partial<Context['env']['omni']>;
  store?: Store;
} = {}): { ctx: Context; store: Store } {
  const store = overrides.store ?? new Store(':memory:');
  const ctx = {
    store,
    guardrails: defaultGuardrails,
    meta: { kind: 'mock' },
    voice: { kind: 'mock' },
    env: {
      mode: overrides.mode ?? 'mock',
      port: 8787,
      publicBaseUrl: overrides.publicBaseUrl ?? 'http://localhost:8787',
      meta: {
        accessToken: '',
        adAccountId: 'act_000000000000',
        pageId: '',
        apiVersion: 'v21.0',
        appSecret: '',
        verifyToken: '',
        ...overrides.meta,
      },
      omni: { apiKey: '', agentId: '', baseUrl: '', webhookSecret: '', webhookToken: '', ...overrides.omni },
      anthropicKey: '',
      previewDir: null,
    },
  } as unknown as Context;
  return { ctx, store };
}

/** Everything filled in, both providers verified - the fully ready state. */
function readyContext(): { ctx: Context; store: Store } {
  const store = new Store(':memory:');
  store.audit(null, 'human', 'preflight.passed', { checks: 8 });
  store.audit(null, 'human', 'contract_test.passed', { checks: 4 });
  return context({
    store,
    mode: 'live',
    publicBaseUrl: 'https://autopilot.example.dpdns.org',
    meta: {
      accessToken: SECRET,
      adAccountId: 'act_123456789012',
      pageId: '900100',
      appSecret: 'app-secret-value',
    },
    omni: { apiKey: 'omni-key-value', agentId: 'agent_1', webhookSecret: 'omni-hmac-secret' },
  });
}

const openStores: Store[] = [];
afterEach(() => {
  while (openStores.length) openStores.pop()?.close();
});
const track = (s: Store): Store => {
  openStores.push(s);
  return s;
};

test('a fresh install is deployable but not live', () => {
  const { ctx, store } = context();
  track(store);
  const report = assessReadiness(ctx);

  // This is the normal starting state and it must not read as an error: the
  // service runs, it just is not allowed to spend anything.
  assert.equal(report.deployReady, true);
  assert.equal(report.liveReady, false);
});

test('every live blocker is named, with something to do about it', () => {
  const { ctx, store } = context();
  track(store);
  const report = assessReadiness(ctx);

  const blockers = report.checks.filter((c) => c.state === 'block').map((c) => c.name);
  assert.deepEqual(blockers.sort(), [
    'ad account verified',
    'credentials',
    'public URL',
    'voice platform verified',
    'webhook verification',
  ]);
  // A blocker without a fix is a dead end.
  for (const c of report.checks.filter((x) => x.state === 'block')) {
    assert.ok(c.fix, `${c.name} blocks but says nothing about what to do`);
  }
});

test('everything present and both providers verified reads as live-ready', () => {
  const { ctx, store } = readyContext();
  track(store);
  const report = assessReadiness(ctx);

  assert.equal(report.deployReady, true);
  assert.equal(report.liveReady, true);
  assert.equal(report.checks.filter((c) => c.state === 'block').length, 0);
});

test('credential values never reach the report', () => {
  // The report is printed, pasted into issues and screenshotted. It states
  // that a credential is present and never what it is.
  const { ctx, store } = readyContext();
  track(store);
  const rendered = formatReadiness(assessReadiness(ctx)) + JSON.stringify(assessReadiness(ctx));

  for (const value of [SECRET, 'app-secret-value', 'omni-key-value', 'omni-hmac-secret']) {
    assert.equal(rendered.includes(value), false, `${value} leaked into the readiness report`);
  }
  assert.equal(rendered.includes('all present'), true);
});

test('a localhost public URL blocks going live', () => {
  // The failure this catches is a campaign that publishes fine and then never
  // receives a single lead, because Meta cannot reach the webhook.
  const { ctx, store } = context({ publicBaseUrl: 'http://localhost:8787' });
  track(store);
  const check = assessReadiness(ctx).checks.find((c) => c.name === 'public URL');
  assert.equal(check?.state, 'block');

  const { ctx: https, store: s2 } = context({ publicBaseUrl: 'https://real.example.com' });
  track(s2);
  assert.equal(assessReadiness(https).checks.find((c) => c.name === 'public URL')?.state, 'pass');
});

test('provider verification comes from the record, not from configuration', () => {
  // Having credentials is not the same as having used them. This is the whole
  // reason preflight and contract-test now write an audit entry.
  const store = track(new Store(':memory:'));
  const { ctx } = context({
    store,
    mode: 'live',
    publicBaseUrl: 'https://real.example.com',
    meta: { accessToken: SECRET, adAccountId: 'act_1', pageId: 'p', appSecret: 'a' },
    omni: { apiKey: 'k', agentId: 'g', webhookSecret: 's' },
  });

  assert.equal(assessReadiness(ctx).liveReady, false, 'credentials alone must not read as verified');

  store.audit(null, 'human', 'preflight.passed', { checks: 8 });
  assert.equal(assessReadiness(ctx).liveReady, false, 'one provider verified is not both');

  store.audit(null, 'human', 'contract_test.passed', { checks: 4 });
  assert.equal(assessReadiness(ctx).liveReady, true);
});

test('a static webhook token is allowed but flagged as weaker', () => {
  const store = track(new Store(':memory:'));
  store.audit(null, 'human', 'preflight.passed', {});
  store.audit(null, 'human', 'contract_test.passed', {});
  const { ctx } = context({
    store,
    publicBaseUrl: 'https://real.example.com',
    meta: { accessToken: 't', adAccountId: 'act_1', pageId: 'p', appSecret: 'a' },
    omni: { apiKey: 'k', agentId: 'g', webhookToken: 'static-token' },
  });

  const check = assessReadiness(ctx).checks.find((c) => c.name === 'webhook verification');
  assert.equal(check?.state, 'warn');
  assert.match(check?.detail ?? '', /replayable/);
  // A warning must not block - it is a real, if weaker, configuration.
  assert.equal(assessReadiness(ctx).liveReady, true);
});

test('an engaged emergency stop blocks live but not deploy', () => {
  const { ctx, store } = readyContext();
  track(store);
  store.engageEmergencyStop({ trigger: 'manual', reason: 'looking into something', by: 'operator' });

  const report = assessReadiness(ctx);
  assert.equal(report.liveReady, false);
  // The service must still be deployable while stopped: it has to keep
  // accepting webhooks, or revenue and opt-outs are lost.
  assert.equal(report.deployReady, true);
});

test('the caps are always shown, so nobody has to go and look them up', () => {
  const { ctx, store } = context();
  track(store);
  const caps = assessReadiness(ctx).checks.find((c) => c.name === 'caps');
  assert.equal(caps?.state, 'pass');
  assert.match(caps?.detail ?? '', /test budget/);
  assert.match(caps?.detail ?? '', /stop-loss/);
});

test('the rendered report states both verdicts explicitly', () => {
  const { ctx, store } = context();
  track(store);
  const text = formatReadiness(assessReadiness(ctx));

  assert.match(text, /DEPLOY\s+ready/);
  assert.match(text, /LIVE\s+BLOCKED/);
  // Being deployable-but-not-live is normal, and the output should say so
  // rather than leaving someone to conclude something is broken.
  assert.match(text, /normal state before going live/);
});

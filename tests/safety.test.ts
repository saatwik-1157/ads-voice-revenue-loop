import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store/db.ts';
import { defaultGuardrails } from '../src/config/guardrails.ts';
import { generateBrief } from '../src/brief/generator.ts';
import { requestGate1, approve } from '../src/approvals/gates.ts';
import { publishCampaign } from '../src/meta/publisher.ts';
import { MockMetaProvider } from '../src/meta/mock.ts';
import { MockVoiceProvider } from '../src/voice/mock.ts';
import { intakeLead } from '../src/pipeline/intake.ts';
import { dispatchLead } from '../src/pipeline/dispatch.ts';
import { runCycle } from '../src/scheduler.ts';
import { inspectSafety, runSafetyCheck } from '../src/safety/monitor.ts';
import { now } from '../src/core/util.ts';
import { GuardrailViolation } from '../src/config/guardrails.ts';
import type { Context } from '../src/orchestrator.ts';
import type { Brief } from '../src/core/types.ts';

/**
 * The fast safety loop and the emergency stop.
 *
 * The stop-loss used to be evaluated once per evaluation cycle, so at a 24 hour
 * interval a run could pass its loss limit and keep spending for most of a day
 * before anything looked. These checks are meant to run every minute, and the
 * thing worth testing is that engaging the stop actually prevents action rather
 * than merely recording an intention to.
 */

const G = { ...defaultGuardrails, callWindow: { startHour: 0, endHour: 24, timeZone: 'UTC' } };

function stampAssets(brief: Brief): Brief {
  for (const c of brief.creatives) {
    c.assetRef = `hash_${c.creativeId}`;
    c.assetProvenance = 'manual';
  }
  return brief;
}

async function liveRun(): Promise<{ ctx: Context; runId: string; brief: Brief }> {
  const store = new Store(':memory:');
  const ctx = {
    store,
    guardrails: G,
    meta: new MockMetaProvider(7),
    voice: new MockVoiceProvider(7),
    env: { mode: 'mock', meta: { pageId: 'page_1' } },
  } as unknown as Context;

  const { brief } = await generateBrief(G);
  stampAssets(brief);
  const runId = store.createRun(brief.niche.name);
  store.saveBrief(runId, brief);
  approve(store, requestGate1(store, G, runId, brief, 50000).approvalId, 'tester');
  await publishCampaign(store, ctx.meta, G, runId, brief, 'page_1', {
    dailyBudgetMinor: 50000,
    windowDays: 5,
    activate: true,
  });
  return { ctx, runId, brief };
}

test('the stop is off by default and reports nothing wrong', async () => {
  const { ctx } = await liveRun();
  assert.equal(ctx.store.emergencyStop().engaged, false);
  assert.equal(inspectSafety(ctx).stops.length, 0);
  ctx.store.close();
});

test('a run past its stop-loss engages the stop, without waiting for a cycle', async () => {
  const { ctx, runId } = await liveRun();
  ctx.store.recordSpend({
    runId,
    adId: 'ad_1',
    spendMinor: G.stopLossMinor + 1000,
    impressions: 1000,
    clicks: 10,
    leads: 1,
    asOf: now(),
  });

  const report = runSafetyCheck(ctx);
  assert.equal(report.stops.length, 1);
  assert.equal(report.stops[0]?.check, 'stop-loss');

  const stop = ctx.store.emergencyStop();
  assert.equal(stop.engaged, true);
  assert.equal(stop.engagedBy, 'safety-loop');
  assert.match(stop.reason ?? '', /stop-loss/);
  assert.ok(
    ctx.store.listAudit(null, { kind: 'emergency_stop.engaged' }).length === 1,
    'engaging is audited where an operator will find it',
  );
  ctx.store.close();
});

test('repeated webhook failures engage the stop', async () => {
  // Revenue and opt-outs both arrive by webhook. Carrying on while those are
  // not landing means deciding on a funnel that looks worse than it is, and
  // dialling people who have asked not to be called.
  const { ctx } = await liveRun();
  for (let i = 0; i < 6; i += 1) {
    const e = ctx.store.recordWebhookEvent({
      provider: 'omnidimension',
      providerEventId: null,
      payloadHash: `hash_${i}`,
      signatureVerified: false,
    });
    ctx.store.finishWebhookEvent(e.eventId, 'failed', 'signature verification failed');
  }

  const report = runSafetyCheck(ctx);
  assert.ok(report.stops.some((f) => f.check === 'webhooks'));
  assert.equal(ctx.store.emergencyStop().engaged, true);
  ctx.store.close();
});

test('engaging keeps the first reason rather than overwriting it', async () => {
  const { ctx } = await liveRun();
  ctx.store.engageEmergencyStop({ trigger: 'manual', reason: 'the original reason', by: 'ada' });
  const second = ctx.store.engageEmergencyStop({ trigger: 'stop-loss', reason: 'something later', by: 'safety-loop' });

  assert.equal(second, false, 'the second engage is a no-op');
  const stop = ctx.store.emergencyStop();
  assert.equal(stop.reason, 'the original reason', 'the first reason is why the system stopped');
  assert.equal(stop.engagedBy, 'ada');
  ctx.store.close();
});

test('while engaged, nothing autonomous acts', async () => {
  const { ctx, runId, brief } = await liveRun();
  ctx.store.engageEmergencyStop({ trigger: 'manual', reason: 'testing', by: 'ada' });

  // The cycle declines.
  const cycle = await runCycle(ctx, runId, { sync: false });
  assert.equal(cycle.status, 'skipped');
  assert.match(cycle.reason ?? '', /emergency stop/);

  // No call is placed.
  const intake = intakeLead(ctx.store, G, runId, {
    name: 'Asha R',
    phone: '9876543210',
    consent: true,
    consentSource: 'meta_instant_form',
    adId: 'ad_1',
  });
  if (intake.status !== 'accepted') throw new Error('setup failed');
  const dispatch = await dispatchLead(ctx.store, ctx.voice, G, intake.lead, brief, 'http://x/hook');
  assert.equal(dispatch.status, 'deferred', 'the lead is fine; it waits rather than being suppressed');
  assert.match(dispatch.reason, /emergency stop/);

  // Nothing new publishes.
  const second = ctx.store.createRun('another');
  ctx.store.saveBrief(second, brief);
  approve(ctx.store, requestGate1(ctx.store, G, second, brief, 50000).approvalId, 'tester');
  await assert.rejects(
    publishCampaign(ctx.store, ctx.meta, G, second, brief, 'page_1', {
      dailyBudgetMinor: 50000,
      windowDays: 5,
    }),
    (err: Error) => err instanceof GuardrailViolation && /emergency_stop/.test(err.message),
  );
  ctx.store.close();
});

test('nothing is deleted, and releasing restores normal operation', async () => {
  const { ctx, runId } = await liveRun();
  const adsBefore = ctx.store.listAds(ctx.store.getCampaign(runId)!.campaignId).length;

  ctx.store.engageEmergencyStop({ trigger: 'manual', reason: 'testing', by: 'ada' });
  assert.equal(
    ctx.store.listAds(ctx.store.getCampaign(runId)!.campaignId).length,
    adsBefore,
    'the stop halts action; it does not destroy state',
  );
  assert.equal(ctx.store.getRun(runId)?.state, 'live', 'and the run is untouched');

  assert.equal(ctx.store.releaseEmergencyStop('ada'), true);
  assert.equal(ctx.store.emergencyStop().engaged, false);
  const cycle = await runCycle(ctx, runId, { sync: false });
  assert.notEqual(cycle.status, 'skipped', 'the loop resumes once a person releases it');
  ctx.store.close();
});

test('the stop survives a restart', () => {
  // An in-memory flag would forget, and a restarted scheduler would quietly
  // resume spending. It lives in the database for that reason.
  const store = new Store(':memory:');
  store.engageEmergencyStop({ trigger: 'manual', reason: 'persisted', by: 'ada' });
  const state = store.emergencyStop();
  assert.equal(state.engaged, true);
  assert.equal(state.reason, 'persisted');
  store.close();
});

test('a warning is not a stop', async () => {
  const { ctx, runId } = await liveRun();

  // Needs a configuration where the two thresholds are distinguishable. With
  // the shipped defaults the stop-loss (400000) sits below 80% of the test
  // budget (480000), so spend high enough to warn about the budget has already
  // passed the loss limit - the budget warning cannot fire on its own.
  ctx.guardrails = { ...G, stopLossMinor: G.maxTestBudgetMinor };

  // Past 80% of the test budget, but under both caps.
  ctx.store.recordSpend({
    runId,
    adId: 'ad_1',
    spendMinor: Math.round(G.maxTestBudgetMinor * 0.9),
    impressions: 100,
    clicks: 10,
    leads: 5,
    asOf: now(),
  });

  const report = runSafetyCheck(ctx);
  assert.ok(report.findings.some((f) => f.severity === 'warn'), 'it is worth saying');
  assert.equal(report.stops.length, 0, 'but not worth halting for');
  assert.equal(ctx.store.emergencyStop().engaged, false);
  ctx.store.close();
});

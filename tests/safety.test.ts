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
import { inspectSafety, runSafetyCheck, enforceSafety } from '../src/safety/monitor.ts';
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

/** A context with nothing in it but a store - enough for the read-only checks. */
function ctxWith(store: Store): Context {
  return {
    store,
    guardrails: G,
    meta: { kind: 'mock' },
    voice: { kind: 'mock' },
    env: { mode: 'mock', meta: { pageId: 'page_1' } },
  } as unknown as Context;
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
    // Verified deliveries whose handler then broke. This fixture used to pass
    // `signatureVerified: false` with reason 'signature verification failed',
    // which asserted that refusing forgeries engages the stop - encoding a
    // remote halt as the expected behaviour.
    const e = ctx.store.recordWebhookEvent({
      provider: 'omnidimension',
      providerEventId: `call_${i}`,
      payloadHash: `hash_${i}`,
      signatureVerified: true,
    });
    ctx.store.finishWebhookEvent(e.eventId, 'failed', 'handler threw while recording the outcome');
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

test('forged webhooks cannot halt the system', () => {
  // The remote halt: webhookFailuresSince counted rejected signatures, which
  // are written with status 'failed' like any other. Five unsigned POSTs in
  // fifteen minutes crossed the threshold and engaged the emergency stop -
  // with no credentials, from anyone who could reach the port.
  const store = new Store(':memory:');
  const ctx = ctxWith(store);

  for (let i = 0; i < 20; i += 1) {
    const rejected = store.recordWebhookEvent({
      provider: 'meta',
      providerEventId: null,
      payloadHash: `forged-${i}`,
      signatureVerified: false,
    });
    store.finishWebhookEvent(rejected.eventId, 'failed', 'signature verification failed');
  }

  const report = runSafetyCheck(ctx);
  assert.equal(report.engaged, false, 'unsigned deliveries must not engage the stop');
  assert.equal(store.emergencyStop().engaged, false);

  // Reported, though - a burst is either a wrong secret or somebody probing,
  // and an operator should see it.
  const warned = report.findings.find((f) => f.check === 'webhook signatures');
  assert.equal(warned?.severity, 'warn');

  store.close();
});

test('deliveries that verified and then failed to process still stop it', () => {
  // The other half: this check has to keep working, or losing revenue and
  // opt-outs stops being noticed.
  const store = new Store(':memory:');
  const ctx = ctxWith(store);

  for (let i = 0; i < 6; i += 1) {
    const accepted = store.recordWebhookEvent({
      provider: 'omnidimension',
      providerEventId: `call-${i}`,
      payloadHash: `hash-${i}`,
      signatureVerified: true,
    });
    store.finishWebhookEvent(accepted.eventId, 'failed', 'handler threw');
  }

  const report = runSafetyCheck(ctx);
  assert.equal(report.engaged, true);
  assert.equal(store.emergencyStop().trigger, 'webhooks');

  store.close();
});

test('a stop-loss trip pauses the campaign at Meta, not just this system', async () => {
  // The most expensive defect found in this project.
  //
  // The safety loop runs every minute, the evaluation cycle every 24 hours, so
  // the loop always tripped the stop-loss first. Engaging the stop then made
  // runCycle skip, and the KILL branch in `apply` that pauses the campaign at
  // the provider was never reached. The stop-loss fired, the system went quiet,
  // and the ad set kept spending to its own end date.
  const { ctx, runId } = await liveRun();
  const campaign = ctx.store.getCampaign(runId)!;

  const paused: string[] = [];
  const realSetStatus = ctx.meta.setStatus.bind(ctx.meta);
  ctx.meta.setStatus = async (objectId: string, status: 'ACTIVE' | 'PAUSED'): Promise<void> => {
    if (status === 'PAUSED') paused.push(objectId);
    await realSetStatus(objectId, status);
  };

  // Spend past the stop-loss with nothing to show for it.
  ctx.store.recordSpend({
    runId,
    adId: 'ad_1',
    spendMinor: G.stopLossMinor + 1000,
    impressions: 1000,
    clicks: 10,
    leads: 1,
    asOf: now(),
  });

  const report = await enforceSafety(ctx);

  assert.equal(report.engaged, true, 'the stop should engage');
  assert.ok(
    paused.includes(campaign.campaignId),
    'the campaign must be paused at the provider - stopping this system does not stop the spend',
  );
  assert.equal(ctx.store.getCampaign(runId)?.status, 'PAUSED');
  assert.equal(ctx.store.getRun(runId)?.state, 'paused');

  ctx.store.close();
});

test('the safety loop never resumes anything', async () => {
  // It may only ever reduce spend. A loop that could resume would be a way for
  // an automated system to restart spending without anyone looking at why it
  // stopped.
  const { ctx, runId } = await liveRun();

  const statuses: string[] = [];
  ctx.meta.setStatus = (objectId: string, status: 'ACTIVE' | 'PAUSED'): Promise<void> => {
    statuses.push(status);
    return Promise.resolve();
  };

  ctx.store.recordSpend({
    runId,
    adId: 'ad_1',
    spendMinor: G.stopLossMinor + 1000,
    impressions: 1000,
    clicks: 10,
    leads: 1,
    asOf: now(),
  });
  await enforceSafety(ctx);
  // And again, now that it is already engaged.
  await enforceSafety(ctx);

  assert.equal(statuses.includes('ACTIVE'), false, 'the safety loop must never send ACTIVE');
  assert.equal(statuses.filter((s) => s === 'PAUSED').length, 1, 'and must not re-pause every pass');

  ctx.store.close();
});

test('a stop-loss still pauses when the stop was already engaged for something else', async () => {
  // The hole in the first version of this fix: it keyed off the stop's own
  // trigger and returned early if the stop was already engaged. So a webhook
  // outage - or a manual pause - engaging first swallowed every later
  // stop-loss. The finding was detected on every pass and skipped over, while
  // the ad set kept spending.
  const { ctx, runId } = await liveRun();
  const campaign = ctx.store.getCampaign(runId)!;

  const paused: string[] = [];
  ctx.meta.setStatus = (objectId: string, status: 'ACTIVE' | 'PAUSED'): Promise<void> => {
    if (status === 'PAUSED') paused.push(objectId);
    return Promise.resolve();
  };

  // Engaged first for something that is not about money.
  ctx.store.engageEmergencyStop({ trigger: 'webhooks', reason: 'deliveries failing', by: 'safety-loop' });
  await enforceSafety(ctx);
  assert.deepEqual(paused, [], 'a webhook outage is not a reason to pause a campaign');

  // Now the money runs out.
  ctx.store.recordSpend({
    runId,
    adId: 'ad_1',
    spendMinor: G.stopLossMinor + 1000,
    impressions: 1000,
    clicks: 10,
    leads: 1,
    asOf: now(),
  });

  await enforceSafety(ctx);
  assert.deepEqual(paused, [campaign.campaignId], 'the stop-loss still has to stop the spend');
  ctx.store.close();
});

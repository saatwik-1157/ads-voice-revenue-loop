import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store/db.ts';
import { defaultGuardrails } from '../src/config/guardrails.ts';
import { planScale } from '../src/economics/decision.ts';
import { pauseKilledAds } from '../src/apply.ts';
import { MockMetaProvider } from '../src/meta/mock.ts';
import type { Context } from '../src/orchestrator.ts';
import type { Recommendation, Economics } from '../src/core/types.ts';

const G = { ...defaultGuardrails, holdoutBudgetShare: 0.2, maxBudgetStepFactor: 1.3 };

const EMPTY: Economics = {
  spendMinor: 0,
  leads: 0,
  unattributedLeads: 0,
  calledLeads: 0,
  leadsAwaitingCall: 0,
  connectedLeads: 0,
  qualifiedLeads: 0,
  appointments: 0,
  sales: 0,
  revenueMinor: 0,
  cplMinor: null,
  costPerConnectedMinor: null,
  costPerQualifiedMinor: null,
  cacMinor: null,
  roas: null,
  connectRate: null,
  qualifyRate: null,
};

test('a scale step reserves the holdout share for creatives still being tested', () => {
  const plan = planScale(G, 100000, 'SCALE', [
    { adId: 'winner', decision: 'SCALE' },
    { adId: 'testing_a', decision: 'KEEP' },
    { adId: 'testing_b', decision: 'ITERATE' },
    { adId: 'dead', decision: 'KILL' },
  ]);

  assert.equal(plan.proposedDailyMinor, 130000);
  assert.equal(plan.holdoutDailyMinor, 26000, '20% of the proposed budget');
  assert.equal(plan.provenDailyMinor, 104000);
  assert.equal(plan.provenDailyMinor + plan.holdoutDailyMinor, plan.proposedDailyMinor);
  assert.deepEqual(plan.holdoutAdIds, ['testing_a', 'testing_b']);
  assert.deepEqual(plan.warnings, []);
});

test('scaling with nothing left to test goes to a human instead of proceeding', () => {
  const plan = planScale(G, 100000, 'SCALE', [
    { adId: 'winner', decision: 'SCALE' },
    { adId: 'dead_a', decision: 'KILL' },
    { adId: 'dead_b', decision: 'KILL' },
  ]);

  assert.equal(plan.holdoutDailyMinor, 0);
  assert.deepEqual(plan.holdoutAdIds, []);
  assert.equal(plan.needsApproval, true, 'no holdout means no unattended scale');
  assert.match(plan.reason, /no holdout/i);
  assert.equal(plan.warnings.length, 1);
  assert.match(plan.warnings[0]!, /new variants/i);
});

test('a scale step still cannot cross the daily cap or skip gate #2', () => {
  const tight = { ...G, maxDailySpendMinor: 110000, budgetApprovalThresholdMinor: 105000 };
  const plan = planScale(tight, 100000, 'SCALE', [
    { adId: 'winner', decision: 'SCALE' },
    { adId: 'testing', decision: 'KEEP' },
  ]);

  assert.equal(plan.proposedDailyMinor, 110000, 'capped at maxDailySpendMinor, not 130000');
  assert.equal(plan.needsApproval, true, 'past the approval threshold');
  assert.match(plan.reason, /threshold/i);
});

test('anything other than SCALE proposes no change and reserves nothing', () => {
  for (const decision of ['KEEP', 'ITERATE', 'KILL'] as const) {
    const plan = planScale(G, 100000, decision, [{ adId: 'a', decision: 'KEEP' }]);
    assert.equal(plan.proposedDailyMinor, 100000);
    assert.equal(plan.holdoutDailyMinor, 0);
    assert.equal(plan.needsApproval, false);
  }
});

/** Minimal context - pauseKilledAds only touches the store and the meta provider. */
function ctxFor(store: Store): Context {
  return { store, meta: new MockMetaProvider(1) } as unknown as Context;
}

function recFor(perAd: Array<{ adId: string; decision: Recommendation['decision'] }>): Recommendation {
  return {
    decision: 'SCALE',
    signal: 'profitable_cohort',
    rationale: '',
    action: '',
    requiresHumanApproval: false,
    economics: EMPTY,
    perAd: perAd.map((ad) => ({ ...ad, rationale: '', economics: EMPTY })),
  };
}

test('apply pauses the condemned creatives', async () => {
  const store = new Store(':memory:');
  const runId = store.createRun('test');
  for (const adId of ['winner', 'dead_a', 'dead_b']) {
    store.saveAd({ adId, campaignId: 'c1', adsetId: 's1', creativeId: `cr_${adId}`, status: 'ACTIVE', createdAt: '' });
  }

  const rec = recFor([
    { adId: 'winner', decision: 'SCALE' },
    { adId: 'dead_a', decision: 'KILL' },
    { adId: 'dead_b', decision: 'KILL' },
  ]);
  const plan = planScale(G, 100000, 'SCALE', rec.perAd);

  assert.equal(await pauseKilledAds(ctxFor(store), runId, rec, plan), 2);
  const statuses = Object.fromEntries(store.listAds('c1').map((a) => [a.adId, a.status]));
  assert.deepEqual(statuses, { winner: 'ACTIVE', dead_a: 'PAUSED', dead_b: 'PAUSED' });
  store.close();
});

test('apply refuses to pause an ad the scale plan is holding open, and says so in the audit', async () => {
  const store = new Store(':memory:');
  const runId = store.createRun('test');
  for (const adId of ['winner', 'reserved']) {
    store.saveAd({ adId, campaignId: 'c1', adsetId: 's1', creativeId: `cr_${adId}`, status: 'ACTIVE', createdAt: '' });
  }

  // A future per-ad rule condemning the very ad being held as the test budget.
  const rec = recFor([
    { adId: 'winner', decision: 'SCALE' },
    { adId: 'reserved', decision: 'KILL' },
  ]);
  const plan = planScale(G, 100000, 'SCALE', [
    { adId: 'winner', decision: 'SCALE' },
    { adId: 'reserved', decision: 'KEEP' },
  ]);

  assert.equal(await pauseKilledAds(ctxFor(store), runId, rec, plan), 0);
  const statuses = Object.fromEntries(store.listAds('c1').map((a) => [a.adId, a.status]));
  assert.equal(statuses.reserved, 'ACTIVE', 'the holdout must survive the pause sweep');

  const refusal = store.auditTrail(runId).find((e) => e.kind === 'ad.pause_refused');
  assert.ok(refusal, 'the refusal has to be auditable');
  assert.match(refusal.detail, /reserved/);
  store.close();
});

test('pausing an ad is audited, not just the refusal to pause one', async () => {
  // The refusal was audited from the start; the action itself was not, so a
  // real change to the ad account left no trace.
  const store = new Store(':memory:');
  const runId = store.createRun('test');
  for (const adId of ['winner', 'dead']) {
    store.saveAd({ adId, campaignId: 'c1', adsetId: 's1', creativeId: `cr_${adId}`, status: 'ACTIVE', createdAt: '' });
  }
  const rec = recFor([
    { adId: 'winner', decision: 'SCALE' },
    { adId: 'dead', decision: 'KILL' },
  ]);
  await pauseKilledAds(ctxFor(store), runId, rec, planScale(G, 100000, 'SCALE', rec.perAd));

  const paused = store.listAudit(runId, { kind: 'ad.paused' });
  assert.equal(paused.length, 1);
  assert.match(paused[0]!.detail, /dead/, 'names which creative was stopped');
  store.close();
});

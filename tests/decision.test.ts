import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store/db.ts';
import { defaultGuardrails } from '../src/config/guardrails.ts';
import { generateBrief } from '../src/brief/generator.ts';
import { evaluate, planScale } from '../src/economics/decision.ts';
import { economicsForAd, economicsForRun } from '../src/economics/metrics.ts';
import { intakeLead } from '../src/pipeline/intake.ts';
import { handleCallWebhook } from '../src/pipeline/webhooks.ts';
import { publishCampaign } from '../src/meta/publisher.ts';
import { MockMetaProvider } from '../src/meta/mock.ts';
import { requestGate1, approve } from '../src/approvals/gates.ts';
import { now } from '../src/core/util.ts';
import type { Brief } from '../src/core/types.ts';

/** Publishing requires uploaded artwork; these tests are not about that step. */
function stampAssets(brief: Brief): Brief {
  for (const creative of brief.creatives) {
    creative.assetRef = `hash_${creative.creativeId}`;
    creative.assetProvenance = 'manual';
  }
  return brief;
}

const G = { ...defaultGuardrails, callWindow: { startHour: 0, endHour: 24, timeZone: 'UTC' } };

async function seed(): Promise<{ store: Store; runId: string; brief: Brief }> {
  const store = new Store(':memory:');
  const { brief } = await generateBrief(G);
  stampAssets(brief);
  const runId = store.createRun(brief.niche.name);
  store.saveBrief(runId, brief);
  return { store, runId, brief };
}

function addLead(store: Store, runId: string, index: number, outcome: Record<string, unknown>): void {
  const intake = intakeLead(store, G, runId, {
    name: `Lead ${index}`,
    phone: `9${String(700000000 + index * 31)}`,
    consent: true,
    consentSource: 'meta_instant_form',
    adId: 'ad_1',
    creativeId: 'cr_1',
  });
  if (intake.status !== 'accepted') throw new Error(`lead ${index} rejected`);
  if (Object.keys(outcome).length) {
    handleCallWebhook(store, { call_id: `call_${index}`, lead_id: intake.lead.leadId, ...outcome });
  }
}

test('spend with no leads is diagnosed as a plumbing fault, not a creative fault', async () => {
  const { store, runId, brief } = await seed();
  store.recordSpend({ runId, adId: 'ad_1', spendMinor: 150000, impressions: 9000, clicks: 40, leads: 0, asOf: now() });

  const rec = evaluate(store, G, runId, brief);
  assert.equal(rec.signal, 'no_leads');
  assert.equal(rec.decision, 'ITERATE');
  assert.match(rec.action, /tracking|delivery|approval/i);
  store.close();
});

test('a tiny sample is never enough to kill a cohort', async () => {
  const { store, runId, brief } = await seed();
  store.recordSpend({ runId, adId: 'ad_1', spendMinor: 5000, impressions: 500, clicks: 8, leads: 2, asOf: now() });
  addLead(store, runId, 1, { connected: false });
  addLead(store, runId, 2, { connected: false });

  const rec = evaluate(store, G, runId, brief);
  assert.equal(rec.signal, 'insufficient_data');
  assert.equal(rec.decision, 'KEEP');
  store.close();
});

test('leads that never connect point at the pipeline before the creative', async () => {
  const { store, runId, brief } = await seed();
  store.recordSpend({ runId, adId: 'ad_1', spendMinor: 120000, impressions: 9000, clicks: 90, leads: 20, asOf: now() });
  for (let i = 1; i <= 20; i += 1) addLead(store, runId, i, { connected: i <= 2 });

  const rec = evaluate(store, G, runId, brief);
  assert.equal(rec.signal, 'low_connect_rate');
  assert.match(rec.action, /phone capture|time-to-first-call|calling hours/i);
  store.close();
});

test('connected calls that do not qualify mean targeting or offer, not more spend', async () => {
  const { store, runId, brief } = await seed();
  store.recordSpend({ runId, adId: 'ad_1', spendMinor: 120000, impressions: 9000, clicks: 90, leads: 20, asOf: now() });
  for (let i = 1; i <= 20; i += 1) addLead(store, runId, i, { connected: true, qualified: false });

  const rec = evaluate(store, G, runId, brief);
  assert.equal(rec.signal, 'poor_qualification');
  assert.equal(rec.decision, 'ITERATE');
  store.close();
});

test('qualified leads that never close point at objections, pricing and the script', async () => {
  const { store, runId, brief } = await seed();
  store.recordSpend({ runId, adId: 'ad_1', spendMinor: 120000, impressions: 9000, clicks: 90, leads: 20, asOf: now() });
  for (let i = 1; i <= 20; i += 1) {
    addLead(store, runId, i, { connected: true, qualified: i <= 12, sale_status: 'lost', objection: 'Too expensive' });
  }

  const rec = evaluate(store, G, runId, brief);
  assert.equal(rec.signal, 'qualified_no_conversion');
  assert.match(rec.action, /objection|pricing|script/i);
  store.close();
});

test('a profitable cohort scales, and the step stays inside the cap', async () => {
  const { store, runId, brief } = await seed();
  store.recordSpend({ runId, adId: 'ad_1', spendMinor: 100000, impressions: 9000, clicks: 90, leads: 20, asOf: now() });
  for (let i = 1; i <= 20; i += 1) {
    const won = i <= 4;
    addLead(store, runId, i, {
      connected: i <= 14,
      qualified: i <= 10,
      appointment_booked: i <= 6,
      sale_status: won ? 'won' : 'lost',
      expected_value: won ? 5000 : 0,
    });
  }

  const rec = evaluate(store, G, runId, brief);
  assert.equal(rec.signal, 'profitable_cohort');
  assert.equal(rec.decision, 'SCALE');

  const plan = planScale(G, 100000, rec.decision, [
    { adId: 'ad_1', decision: 'SCALE' },
    { adId: 'ad_2', decision: 'KEEP' },
  ]);
  assert.ok(plan.proposedDailyMinor > 100000);
  assert.ok(plan.proposedDailyMinor <= G.maxDailySpendMinor, 'a scale step must never exceed the daily cap');
  store.close();
});

test('the stop-loss overrides every other signal and demands a human', async () => {
  const { store, runId, brief } = await seed();
  store.recordSpend({
    runId,
    adId: 'ad_1',
    spendMinor: G.stopLossMinor + 1000,
    impressions: 90000,
    clicks: 900,
    leads: 50,
    asOf: now(),
  });
  for (let i = 1; i <= 50; i += 1) addLead(store, runId, i, { connected: true, qualified: true, sale_status: 'lost' });

  const rec = evaluate(store, G, runId, brief);
  assert.equal(rec.signal, 'stop_loss');
  assert.equal(rec.decision, 'KILL');
  assert.equal(rec.requiresHumanApproval, true);
  store.close();
});

test('economics count every stage of the funnel separately', async () => {
  const { store, runId } = await seed();
  store.recordSpend({ runId, adId: 'ad_1', spendMinor: 100000, impressions: 9000, clicks: 90, leads: 10, asOf: now() });
  for (let i = 1; i <= 10; i += 1) {
    addLead(store, runId, i, {
      connected: i <= 6,
      qualified: i <= 4,
      appointment_booked: i <= 3,
      sale_status: i <= 2 ? 'won' : 'lost',
      expected_value: i <= 2 ? 5000 : 0,
    });
  }
  const e = economicsForRun(store, runId);
  assert.equal(e.leads, 10);
  assert.equal(e.connectedLeads, 6);
  assert.equal(e.qualifiedLeads, 4);
  assert.equal(e.appointments, 3);
  assert.equal(e.sales, 2);
  assert.equal(e.revenueMinor, 1000000);
  assert.equal(e.cplMinor, 10000);
  assert.equal(e.cacMinor, 50000);
  assert.equal(e.roas, 10);
  store.close();
});

test('publishing without gate #1 is refused, and publishing twice creates one campaign', async () => {
  const { store, runId, brief } = await seed();
  const meta = new MockMetaProvider(1);
  const options = { dailyBudgetMinor: 50000, windowDays: 3, activate: false };

  await assert.rejects(
    () => publishCampaign(store, meta, G, runId, brief, 'page_1', options),
    /gate_1/,
    'no approval means no campaign',
  );

  const gate = requestGate1(store, G, runId, brief, options.dailyBudgetMinor);
  approve(store, gate.approvalId, 'tester');

  const first = await publishCampaign(store, meta, G, runId, brief, 'page_1', options);
  const second = await publishCampaign(store, meta, G, runId, brief, 'page_1', options);
  assert.equal(first.campaign.campaignId, second.campaign.campaignId);
  assert.equal(store.listAds(first.campaign.campaignId).length, brief.creatives.length);
  store.close();
});

test('publishing over the cap is refused outright', async () => {
  const { store, runId, brief } = await seed();
  const meta = new MockMetaProvider(2);
  // Approved for the amount being published, so the daily cap is what this
  // test exercises. It used to approve 1000 and publish the cap plus one,
  // which would pass gate #1 today and meant the amount approved was never
  // the thing under test.
  const gate = requestGate1(store, G, runId, brief, G.maxDailySpendMinor + 1);
  approve(store, gate.approvalId, 'tester');

  await assert.rejects(
    () =>
      publishCampaign(store, meta, G, runId, brief, 'page_1', {
        dailyBudgetMinor: G.maxDailySpendMinor + 1,
        windowDays: 3,
      }),
    /daily_cap/,
  );
  store.close();
});

test('gate #1 binds the budget it approved, not merely that it was approved', async () => {
  // The approver reads "Budget: INR 10.00/day" and grants it. Nothing compared
  // that number to what was published, because it existed only inside the
  // summary text: approve INR 10/day, publish at INR 1,500/day, 150x, and no
  // check anywhere objected.
  const { store, runId, brief } = await seed();
  const meta = new MockMetaProvider(2);
  const approvedMinor = 1000;
  approve(store, requestGate1(store, G, runId, brief, approvedMinor).approvalId, 'tester');

  await assert.rejects(
    () =>
      publishCampaign(store, meta, G, runId, brief, 'page_1', {
        dailyBudgetMinor: approvedMinor * 150,
        windowDays: 3,
      }),
    /gate_1_budget/,
    'publishing above the approved amount needs a new approval',
  );

  // At or under what was approved is fine - the gate is a ceiling, not a quota.
  const published = await publishCampaign(store, meta, G, runId, brief, 'page_1', {
    dailyBudgetMinor: approvedMinor,
    windowDays: 3,
  });
  assert.ok(published.campaign.campaignId, 'at the approved amount it publishes');
  store.close();
});

test('a second call attempt does not turn one lead into two', async () => {
  // maxCallAttemptsPerLead defaults to 2, so more than one call row per lead is
  // normal. Counting joined rows meant the retry doubled the lead count, which
  // halved CPL and halved the connect rate at the same time: the campaign read
  // as twice as efficient as it was, and the funnel read as broken.
  const { store, runId } = await seed();
  store.recordSpend({ runId, adId: 'ad_1', spendMinor: 100000, impressions: 1000, clicks: 40, leads: 10, asOf: now() });

  const leadIds: string[] = [];
  for (let i = 0; i < 10; i += 1) {
    const intake = intakeLead(store, G, runId, {
      name: `Lead ${i}`,
      phone: `9${String(700000000 + i * 37)}`,
      consent: true,
      consentSource: 'meta_instant_form',
      adId: 'ad_1',
    });
    if (intake.status !== 'accepted') throw new Error('setup failed');
    leadIds.push(intake.lead.leadId);
  }

  for (const [i, leadId] of leadIds.entries()) {
    handleCallWebhook(store, { call_id: `first_${i}`, lead_id: leadId, connected: false });
  }
  const afterOne = economicsForRun(store, runId);
  assert.equal(afterOne.leads, 10);
  assert.equal(afterOne.cplMinor, 10000);

  for (const [i, leadId] of leadIds.entries()) {
    handleCallWebhook(store, { call_id: `second_${i}`, lead_id: leadId, connected: true, qualified: i < 5 });
  }
  const afterTwo = economicsForRun(store, runId);

  assert.equal(afterTwo.leads, 10, 'a lead called twice is still one lead');
  assert.equal(afterTwo.cplMinor, 10000, 'and CPL does not halve itself');
  assert.equal(afterTwo.connectedLeads, 10);
  assert.equal(afterTwo.connectRate, 1, 'everyone was reached on the second attempt');
  assert.equal(afterTwo.qualifyRate, 0.5, '5 of the 10 reached qualified');
  store.close();
});

test('leads nobody has dialled yet are not a pipeline fault', async () => {
  // A call deferred outside the window writes an audit row and no call row, so
  // a cycle at 02:00 saw leads with no connections and reported a pipeline
  // fault while the queue was simply waiting for 10:00.
  const { store, runId, brief } = await seed();
  store.recordSpend({ runId, adId: 'ad_1', spendMinor: 90000, impressions: 5000, clicks: 80, leads: 20, asOf: now() });
  for (let i = 0; i < 20; i += 1) addLead(store, runId, i, {});

  const rec = evaluate(store, G, runId, brief);
  assert.equal(rec.signal, 'calls_pending');
  assert.equal(rec.decision, 'KEEP', 'nothing is known yet, so nothing changes');
  assert.match(rec.action, /not a creative fault/i);
  assert.equal(rec.economics.leadsAwaitingCall, 20);
  assert.equal(rec.economics.calledLeads, 0);
  store.close();
});

test('once the leads are actually dialled, a real connect failure is still caught', async () => {
  const { store, runId, brief } = await seed();
  store.recordSpend({ runId, adId: 'ad_1', spendMinor: 90000, impressions: 5000, clicks: 80, leads: 20, asOf: now() });
  for (let i = 0; i < 20; i += 1) addLead(store, runId, i, { connected: false });

  const rec = evaluate(store, G, runId, brief);
  assert.equal(rec.signal, 'low_connect_rate');
  assert.equal(rec.decision, 'ITERATE');
  assert.equal(rec.economics.leadsAwaitingCall, 0, 'every lead has an outcome');
  store.close();
});

test('a healthy funnel is not derailed by a tail of undialled leads', async () => {
  // Most leads dialled and connecting, a few still queued: the queued ones must
  // not drag the diagnosis, because they are not evidence either way.
  const { store, runId, brief } = await seed();
  store.recordSpend({ runId, adId: 'ad_1', spendMinor: 90000, impressions: 5000, clicks: 80, leads: 20, asOf: now() });
  for (let i = 0; i < 16; i += 1) addLead(store, runId, i, { connected: true, qualified: i < 9 });
  for (let i = 16; i < 20; i += 1) addLead(store, runId, i, {});

  const rec = evaluate(store, G, runId, brief);
  assert.notEqual(rec.signal, 'calls_pending', 'the dialled majority is judgeable');
  assert.notEqual(rec.signal, 'low_connect_rate', '16 of 16 dialled leads connected');
  store.close();
});

/** A lead with no ad id: the round trip broke, or someone posted it by hand. */
function addUnattributedLead(store: Store, runId: string, index: number, outcome: Record<string, unknown>): void {
  const intake = intakeLead(store, G, runId, {
    name: `Untracked ${index}`,
    phone: `9${String(800000000 + index * 29)}`,
    consent: true,
    consentSource: 'meta_instant_form',
  });
  if (intake.status !== 'accepted') throw new Error(`lead ${index} rejected`);
  handleCallWebhook(store, { call_id: `untracked_${index}`, lead_id: intake.lead.leadId, ...outcome });
}

test('an ad is not killed because attribution broke', async () => {
  // Leads with no ad id count in the run total and are invisible to every
  // per-ad view, so an ad whose leads lost their ad id looked like an ad with
  // spend and no leads - and judgeAd kills those. That pauses a working
  // creative for a tracking fault, which is the confusion the run-level rules
  // are ordered specifically to avoid.
  const { store, runId, brief } = await seed();
  store.recordSpend({ runId, adId: 'ad_1', spendMinor: 120000, impressions: 9000, clicks: 90, leads: 20, asOf: now() });
  for (let i = 0; i < 4; i += 1) addLead(store, runId, i, { connected: true, qualified: true });
  for (let i = 0; i < 16; i += 1) addUnattributedLead(store, runId, i, { connected: true, qualified: true });

  const rec = evaluate(store, G, runId, brief);
  assert.equal(rec.economics.unattributedLeads, 16);
  assert.equal(rec.signal, 'attribution_gap');
  assert.equal(rec.decision, 'ITERATE', 'a broken round trip is a plumbing fault, not a creative verdict');
  assert.match(rec.action, /ad_id/);
  store.close();
});

test('with attribution intact, an ad with spend and no leads is still killed', async () => {
  // The caution above must not become a blanket excuse: when every lead that
  // arrived carried an ad id, an ad with none really did fail.
  const { store, runId, brief } = await seed();
  store.recordSpend({ runId, adId: 'ad_1', spendMinor: 120000, impressions: 9000, clicks: 90, leads: 20, asOf: now() });
  for (let i = 0; i < 20; i += 1) addLead(store, runId, i, { connected: true, qualified: i < 12 });

  const rec = evaluate(store, G, runId, brief);
  assert.equal(rec.economics.unattributedLeads, 0, 'every lead is traceable');
  assert.notEqual(rec.signal, 'attribution_gap');
  store.close();
});

test('per-ad leads add up to the run total, or the difference is named', async () => {
  // The invariant worth keeping: nothing disappears silently between the run
  // view and the per-ad view.
  const { store, runId } = await seed();
  store.recordSpend({ runId, adId: 'ad_1', spendMinor: 120000, impressions: 9000, clicks: 90, leads: 20, asOf: now() });
  for (let i = 0; i < 6; i += 1) addLead(store, runId, i, { connected: true });
  for (let i = 0; i < 3; i += 1) addUnattributedLead(store, runId, i, { connected: true });

  const run = economicsForRun(store, runId);
  const perAd = economicsForAd(store, runId, 'ad_1');
  assert.equal(run.leads, 9);
  assert.equal(perAd.leads, 6);
  assert.equal(run.leads - perAd.leads, run.unattributedLeads, 'the gap is exactly what carries no ad id');
  store.close();
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store/db.ts';
import { defaultGuardrails } from '../src/config/guardrails.ts';
import { generateBrief } from '../src/brief/generator.ts';
import { evaluate, proposeBudget } from '../src/economics/decision.ts';
import { economicsForRun } from '../src/economics/metrics.ts';
import { intakeLead } from '../src/pipeline/intake.ts';
import { handleCallWebhook } from '../src/pipeline/webhooks.ts';
import { publishCampaign } from '../src/meta/publisher.ts';
import { MockMetaProvider } from '../src/meta/mock.ts';
import { requestGate1, approve } from '../src/approvals/gates.ts';
import { now } from '../src/core/util.ts';
import type { Brief } from '../src/core/types.ts';

const G = { ...defaultGuardrails, callWindow: { startHour: 0, endHour: 24, timeZone: 'UTC' } };

async function seed(): Promise<{ store: Store; runId: string; brief: Brief }> {
  const store = new Store(':memory:');
  const { brief } = await generateBrief(G);
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

  const budget = proposeBudget(G, 100000, rec.decision);
  assert.ok(budget.proposedDailyMinor > 100000);
  assert.ok(budget.proposedDailyMinor <= G.maxDailySpendMinor, 'a scale step must never exceed the daily cap');
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
  assert.equal(e.connectedCalls, 6);
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
  const gate = requestGate1(store, G, runId, brief, 1000);
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

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store/db.ts';
import { defaultGuardrails } from '../src/config/guardrails.ts';
import { generateBrief } from '../src/brief/generator.ts';
import { approve, reject, requestGate1 } from '../src/approvals/gates.ts';
import { publishCampaign, syncInsights } from '../src/meta/publisher.ts';
import { ensureCreativeAssets } from '../src/creative/pipeline.ts';
import { RenderedAssetProvider } from '../src/creative/rendered.ts';
import { MockMetaProvider } from '../src/meta/mock.ts';
import { MockVoiceProvider } from '../src/voice/mock.ts';
import { intakeLead } from '../src/pipeline/intake.ts';
import { dispatchLead } from '../src/pipeline/dispatch.ts';
import { handleCallWebhook } from '../src/pipeline/webhooks.ts';
import { pauseKilledAds } from '../src/apply.ts';
import { planScale } from '../src/economics/decision.ts';
import type { Context } from '../src/orchestrator.ts';
import type { Recommendation, Economics } from '../src/core/types.ts';

/**
 * Audit coverage.
 *
 * Two gaps shipped before anyone noticed: a won sale recorded revenue without
 * an audit entry, and pausing an ad left no trace. Both were found by running
 * the audit command and getting an empty answer for something that had plainly
 * happened - not by reading the code.
 *
 * This walks one scenario through every consequential path and asserts each
 * leaves a record, so the next silent state change fails here instead.
 */

const G = { ...defaultGuardrails, callWindow: { startHour: 0, endHour: 24, timeZone: 'UTC' } };

const EMPTY: Economics = {
  spendMinor: 0,
  leads: 0,
  connectedCalls: 0,
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

test('every consequential action leaves an audit entry', async () => {
  const store = new Store(':memory:');
  const meta = new MockMetaProvider(99);
  const voice = new MockVoiceProvider(99);
  const ctx = { store, guardrails: G, meta, voice } as unknown as Context;

  const { brief } = await generateBrief(G);
  const runId = store.createRun(brief.niche.name);
  store.saveBrief(runId, brief);

  // Artwork, gate #1, publish.
  await ensureCreativeAssets(store, meta, new RenderedAssetProvider(), runId, brief);
  const gate = requestGate1(store, G, runId, brief, 50000);
  approve(store, gate.approvalId, 'tester');
  const published = await publishCampaign(store, meta, G, runId, brief, 'page_1', {
    dailyBudgetMinor: 50000,
    windowDays: 3,
    activate: true,
  });
  meta.tick();
  await syncInsights(store, meta, runId);

  // A lead that converts, so revenue moves.
  const winner = published.ads[0]!;
  const intake = intakeLead(store, G, runId, {
    name: 'Asha R',
    phone: '9876543210',
    consent: true,
    consentSource: 'meta_instant_form',
    adId: winner.adId,
    creativeId: winner.creativeId,
  });
  if (intake.status !== 'accepted') throw new Error('setup failed');
  const dispatch = await dispatchLead(store, voice, G, intake.lead, brief, 'http://x/hook');
  if (dispatch.status !== 'dispatched') throw new Error('setup failed');
  handleCallWebhook(store, {
    call_id: 'call_won',
    lead_id: intake.lead.leadId,
    connected: true,
    qualified: true,
    sale_status: 'won',
    expected_value: 5000,
  });

  // A lead that opts out, so a number is suppressed.
  const optOut = intakeLead(store, G, runId, {
    name: 'Ravi K',
    phone: '9876500000',
    consent: true,
    consentSource: 'meta_instant_form',
    adId: winner.adId,
  });
  if (optOut.status !== 'accepted') throw new Error('setup failed');
  handleCallWebhook(store, { call_id: 'call_out', lead_id: optOut.lead.leadId, connected: true, opt_out: true });

  // A creative the engine condemns, so an ad is paused.
  const rec: Recommendation = {
    decision: 'KEEP',
    signal: 'within_tolerance',
    rationale: '',
    action: '',
    requiresHumanApproval: false,
    economics: EMPTY,
    perAd: published.ads.map((ad, i) => ({
      adId: ad.adId,
      decision: i === 0 ? 'KILL' : 'KEEP',
      rationale: 'CPL over target',
      economics: EMPTY,
    })),
  };
  await pauseKilledAds(ctx, runId, rec, planScale(G, 50000, 'KEEP', rec.perAd));

  const kinds = new Set(store.auditTrail(runId).map((e) => e.kind));

  // Each of these is a thing that changed the world - money, a phone call, an
  // ad account, or a decision a person is accountable for.
  for (const required of [
    'creative.asset_ready',
    'gate1.requested',
    'campaign.created',
    'campaign.activated',
    'insights.synced',
    'lead.accepted',
    'call.dispatched',
    'call.outcome',
    'revenue.recorded',
    'lead.opted_out',
    'ad.paused',
  ]) {
    assert.ok(kinds.has(required), `${required} happened but was not audited`);
  }
  store.close();
});

test('a refusal is audited as loudly as an action', async () => {
  // The operator question is "why is nothing happening", so the reasons
  // nothing happened have to be in the log too.
  const store = new Store(':memory:');
  const { brief } = await generateBrief(G);
  const runId = store.createRun(brief.niche.name);
  store.saveBrief(runId, brief);

  intakeLead(store, G, runId, { name: '', phone: '9876543210', consent: true, consentSource: 'x' });

  const closed = { ...G, callWindow: { startHour: 3, endHour: 4, timeZone: 'UTC' } };
  const lead = intakeLead(store, G, runId, {
    name: 'Asha R',
    phone: '9876543211',
    consent: true,
    consentSource: 'meta_instant_form',
    adId: 'ad_1',
  });
  if (lead.status !== 'accepted') throw new Error('setup failed');
  await dispatchLead(
    store,
    new MockVoiceProvider(),
    closed,
    lead.lead,
    brief,
    'http://x/hook',
    {},
    new Date('2026-09-14T23:00:00Z'),
  );

  const kinds = new Set(store.auditTrail(runId).map((e) => e.kind));
  assert.ok(kinds.has('lead.rejected'), 'a refused lead is recorded');
  assert.ok(kinds.has('call.deferred'), 'a call the window blocked is recorded');
  store.close();
});

test('who approved the spend is recorded against the run they approved it for', async () => {
  // This was written with a null run id, and `WHERE run_id = ?` never matches
  // NULL - so the record of who authorised the money was unreadable by every
  // query in the codebase. It is the entire point of having a human gate.
  const store = new Store(':memory:');
  const { brief } = await generateBrief(G);
  const runId = store.createRun(brief.niche.name);
  store.saveBrief(runId, brief);

  const granted = requestGate1(store, G, runId, brief, 50000);
  approve(store, granted.approvalId, 'ada');
  const refused = requestGate1(store, G, runId, brief, 50000);
  reject(store, refused.approvalId, 'grace', 'claims are too strong');

  const events = store.listAudit(runId, { actor: 'human' });
  const names = events.map((e) => e.kind);
  assert.ok(names.includes('approval.granted'), 'an approval is findable on its run');
  assert.ok(names.includes('approval.rejected'), 'so is a refusal');

  const detail = JSON.parse(events.find((e) => e.kind === 'approval.granted')!.detail) as { approver: string };
  assert.equal(detail.approver, 'ada', 'and it says who');
  store.close();
});

test('events belonging to no run can still be read back', async () => {
  const store = new Store(':memory:');
  const { brief } = await generateBrief(G);
  const runId = store.createRun(brief.niche.name);
  store.audit(null, 'system', 'http.rejected', { status: 400 });
  store.audit(runId, 'system', 'cycle.completed', {});

  const system = store.listAudit(null);
  assert.equal(system.length, 1, 'null means "events belonging to no run", not "no filter"');
  assert.equal(system[0]?.kind, 'http.rejected');
  assert.deepEqual(
    store.auditSummary(null).map((r) => r.kind),
    ['http.rejected'],
    'and the summary scopes the same way',
  );
  store.close();
});

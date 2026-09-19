import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store/db.ts';
import { defaultGuardrails, type Guardrails } from '../src/config/guardrails.ts';
import { generateBrief } from '../src/brief/generator.ts';
import { requestGate1, approve } from '../src/approvals/gates.ts';
import { publishCampaign } from '../src/meta/publisher.ts';
import { MockMetaProvider } from '../src/meta/mock.ts';
import { MockVoiceProvider } from '../src/voice/mock.ts';
import { intakeLead } from '../src/pipeline/intake.ts';
import { dispatchLead } from '../src/pipeline/dispatch.ts';
import type { Brief } from '../src/core/types.ts';

/**
 * The call caps, counted when the phone rings.
 *
 * Both `maxCallsPerDay` and `maxCallAttemptsPerLead` were counted from the
 * `calls` table, which only the inbound result webhook writes. A call already
 * dialling counted as zero, so neither cap bound in the asynchronous case -
 * which is the only real one.
 */

const G = { ...defaultGuardrails, callWindow: { startHour: 0, endHour: 24, timeZone: 'UTC' } };

async function liveRun(g: Guardrails): Promise<{ store: Store; runId: string; brief: Brief }> {
  const store = new Store(':memory:');
  const meta = new MockMetaProvider(7);
  const { brief } = await generateBrief(g);
  for (const c of brief.creatives) {
    c.assetRef = `hash_${c.creativeId}`;
    c.assetProvenance = 'manual';
  }
  const runId = store.createRun(brief.niche.name);
  store.saveBrief(runId, brief);
  approve(store, requestGate1(store, g, runId, brief, 50000).approvalId, 'tester');
  await publishCampaign(store, meta, g, runId, brief, 'page_1', {
    dailyBudgetMinor: 50000,
    windowDays: 5,
    activate: true,
  });
  return { store, runId, brief };
}

test('the daily call ceiling counts calls placed, not results returned', async () => {
  // With maxCallsPerDay 25 the system dispatched 60 before anything noticed,
  // because callsToday() could not see a call that had not come back yet.
  const cap = 3;
  const g = { ...G, maxCallsPerDay: cap, maxCallAttemptsPerLead: 99 };
  const { store, brief, runId } = await liveRun(g);

  let dispatched = 0;
  let deferred = 0;
  for (let i = 0; i < cap + 4; i += 1) {
    const intake = intakeLead(store, g, runId, {
      name: `Person ${i}`,
      phone: `98765432${String(10 + i).padStart(2, '0')}`,
      consent: true,
      consentSource: 'meta_instant_form',
      adId: `ad_${i}`,
    });
    if (intake.status !== 'accepted') continue;
    const out = await dispatchLead(store, new MockVoiceProvider(3), g, intake.lead, brief, 'http://x/hook');
    if (out.status === 'dispatched') dispatched += 1;
    if (out.status === 'deferred') deferred += 1;
  }

  assert.equal(dispatched, cap, `the ceiling of ${cap} must bind without any result coming back`);
  assert.ok(deferred > 0, 'the rest are deferred, not silently dropped');
  store.close();
});

test('one person is not dialled twice while the first call is still in flight', async () => {
  // The intake dedupe key includes the ad id, so one person answering two ads
  // is two lead rows. The cap is about the phone ringing, so it has to bind
  // across them - and it did not, because neither call had returned yet.
  const g = { ...G, maxCallAttemptsPerLead: 1, maxCallsPerDay: 99 };
  const { store, brief, runId } = await liveRun(g);
  const phone = '9876543210';

  const first = intakeLead(store, g, runId, {
    name: 'Asha R',
    phone,
    consent: true,
    consentSource: 'meta_instant_form',
    adId: 'ad_1',
  });
  const second = intakeLead(store, g, runId, {
    name: 'Asha R',
    phone,
    consent: true,
    consentSource: 'meta_instant_form',
    adId: 'ad_2',
  });
  if (first.status !== 'accepted' || second.status !== 'accepted') throw new Error('setup failed');
  assert.notEqual(first.lead.leadId, second.lead.leadId, 'two ads, two lead rows - that is the setup');

  const a = await dispatchLead(store, new MockVoiceProvider(3), g, first.lead, brief, 'http://x/hook');
  const b = await dispatchLead(store, new MockVoiceProvider(3), g, second.lead, brief, 'http://x/hook');

  assert.equal(a.status, 'dispatched');
  assert.equal(b.status, 'suppressed', 'the same person must not ring twice, result or no result');
  assert.equal(store.callCountForPhone(runId, '+919876543210'), 1);
  store.close();
});

test('the backfill keeps call history that predates the attempts table', () => {
  // Without it, upgrading would hand everyone who had already been called a
  // fresh allowance.
  const store = new Store(':memory:');
  const runId = store.createRun('backfill');
  const intake = intakeLead(store, G, runId, {
    name: 'Asha R',
    phone: '9876543210',
    consent: true,
    consentSource: 'meta_instant_form',
    adId: 'ad_1',
  });
  if (intake.status !== 'accepted') throw new Error('setup failed');

  // A call that came back, with no attempt row - what a pre-migration database
  // looks like.
  store.saveCall({
    callId: 'call_old',
    leadId: intake.lead.leadId,
    connected: true,
    qualified: true,
    intentScore: 7,
    objection: null,
    appointmentBooked: false,
    saleStatus: 'lost',
    expectedValueMinor: 0,
    nextAction: 'nurture',
    summary: 'an old call',
    optOut: false,
    receivedAt: new Date().toISOString(),
  });
  store.db.exec('DELETE FROM call_attempts');
  assert.equal(store.callCountForPhone(runId, '+919876543210'), 0, 'no attempt rows yet');

  store.db.exec(`INSERT OR IGNORE INTO call_attempts (attempt_id, lead_id, run_id, phone_e164, dispatched_at)
                 SELECT 'bf_' || c.call_id, c.lead_id, l.run_id, l.phone_e164, c.received_at
                 FROM calls c JOIN leads l ON l.lead_id = c.lead_id`);
  assert.equal(store.callCountForPhone(runId, '+919876543210'), 1, 'the completed call is counted after backfill');
  store.close();
});

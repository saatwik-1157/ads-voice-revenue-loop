import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store/db.ts';
import { defaultGuardrails, type Guardrails } from '../src/config/guardrails.ts';
import { generateBrief } from '../src/brief/generator.ts';
import { requestGate1, approve } from '../src/approvals/gates.ts';
import { publishCampaign } from '../src/meta/publisher.ts';
import { MockMetaProvider } from '../src/meta/mock.ts';
import { MockVoiceProvider } from '../src/voice/mock.ts';
import { intakeLead } from '../src/pipeline/intake.ts';
import { dispatchLead } from '../src/pipeline/dispatch.ts';
import { CircuitOpenError } from '../src/core/breaker.ts';
import type { Brief, Lead } from '../src/core/types.ts';

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
  const again = intakeLead(store, g, runId, {
    name: 'Asha R',
    phone,
    consent: true,
    consentSource: 'meta_instant_form',
    adId: 'ad_2',
  });
  if (first.status !== 'accepted') throw new Error('setup failed');
  assert.equal(again.status, 'duplicate', 'intake collapses one person on one run to one lead');

  // Belt and braces: even with a second row for the same phone, the cap binds.
  const secondRow = { ...first.lead, leadId: 'lead_second_row', adId: 'ad_2' };

  const a = await dispatchLead(store, new MockVoiceProvider(3), g, first.lead, brief, 'http://x/hook');
  const b = await dispatchLead(store, new MockVoiceProvider(3), g, secondRow, brief, 'http://x/hook');

  assert.equal(a.status, 'dispatched');
  assert.equal(b.status, 'suppressed', 'the same person must not ring twice, result or no result');
  assert.equal(store.callCountForPhone(runId, '+919876543210'), 1);
  store.close();
});

test('the migration backfills call history from a database that predates the table', () => {
  // This used to run its own copy of the backfill INSERT and assert that its
  // own SQL worked - the production migration was never invoked, and the two
  // had already diverged: the real one joins `runs` so it cannot introduce an
  // orphan, the test's copy did not.
  //
  // Now it builds a v2-shaped database by hand and opens a Store, which is what
  // actually runs migration 3.
  const dir = mkdtempSync(join(tmpdir(), 'fl-backfill-'));
  const path = join(dir, 'autopilot.db');

  {
    const store = new Store(path);
    const runId = store.createRun('backfill');
    const intake = intakeLead(store, G, runId, {
      name: 'Asha R',
      phone: '9876543210',
      consent: true,
      consentSource: 'meta_instant_form',
      adId: 'ad_1',
    });
    if (intake.status !== 'accepted') throw new Error('setup failed');
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
    // Wind it back to what a pre-migration-3 database looks like.
    store.db.exec('DROP TABLE call_attempts');
    store.db.exec('DELETE FROM schema_migrations WHERE version = 3');
    store.close();
  }

  const reopened = new Store(path);
  const runId = reopened.listRuns()[0]!.runId;
  assert.equal(
    reopened.callCountForPhone(runId, '+919876543210'),
    1,
    'the completed call is counted after the migration runs',
  );
  assert.deepEqual(reopened.db.prepare('PRAGMA foreign_key_check').all(), [], 'and no orphan was introduced');
  reopened.close();
  rmSync(dir, { recursive: true, force: true });
});

test('the daily ceiling is measured on the clock the call is placed on', () => {
  // Two bugs met here. recordCallAttempt stamped the real wall clock while
  // dispatchLead had been handed a simulated one, and callsToday() compared
  // against the real clock too - so a run simulating a week in seconds saw
  // every call as today's and started refusing partway through.
  const store = new Store(':memory:');
  const runId = store.createRun('clock');
  const intake = intakeLead(store, G, runId, {
    name: 'Asha R',
    phone: '9876543210',
    consent: true,
    consentSource: 'meta_instant_form',
    adId: 'ad_1',
  });
  if (intake.status !== 'accepted') throw new Error('setup failed');
  const lead = intake.lead;

  // A rolling 24 hours, not a calendar day - which is the stricter reading and
  // the right one: a calendar cap allows 25 calls at 23:59 and 25 more two
  // minutes later.
  const monday = new Date('2026-03-02T10:00:00.000Z');
  const sameDayLater = new Date('2026-03-02T18:00:00.000Z');
  const wellAfter = new Date('2026-03-04T10:00:00.000Z');

  store.recordCallAttempt(lead, monday.toISOString());
  assert.equal(store.callsToday(monday), 1, 'counted on the clock it was placed on');
  assert.equal(store.callsToday(sameDayLater), 1, 'still inside the window eight hours later');
  assert.equal(store.callsToday(wellAfter), 0, 'and out of it two days on');

  store.recordCallAttempt(lead, wellAfter.toISOString());
  assert.equal(store.callsToday(wellAfter), 1, 'the later day gets its own allowance');

  // And the real-clock default does not see either of them.
  assert.equal(store.callsToday(), 0, 'a 2026-03 call is not in today rolling window');
  store.close();
});

test('a lead the dialler cannot take is deferred, and stays callable', async () => {
  // Two things the old assertions missed. The CircuitOpenError branch had no
  // coverage at all - without it the error becomes a 500 on the lead webhook,
  // asking Meta to redeliver a lead we already hold, and the person is never
  // called. And asserting only on the returned status would pass even if the
  // lead were marked suppressed and dropped out of the queue forever.
  const g = { ...G, maxCallsPerDay: 99, maxCallAttemptsPerLead: 2 };
  const { store, brief, runId } = await liveRun(g);
  const intake = intakeLead(store, g, runId, {
    name: 'Asha R',
    phone: '9876543210',
    consent: true,
    consentSource: 'meta_instant_form',
    adId: 'ad_1',
  });
  if (intake.status !== 'accepted') throw new Error('setup failed');

  const down = {
    kind: 'omnidimension' as const,
    dispatchCall: () => Promise.reject(new CircuitOpenError('omnidimension', 30_000, 'provider unreachable')),
  } as unknown as MockVoiceProvider;

  const out = await dispatchLead(store, down, g, intake.lead, brief, 'http://x/hook');
  assert.equal(out.status, 'deferred', 'not an error the webhook should 500 on');
  assert.ok(
    store.pendingLeads(runId).some((l) => l.leadId === intake.lead.leadId),
    'and still in the queue - a deferred lead has to be callable later',
  );
  store.close();
});

test('a lead deferred by the daily ceiling stays in the queue', async () => {
  // "the rest are deferred, not silently dropped" was asserted on the return
  // value alone, which would pass with the lead marked suppressed.
  const g = { ...G, maxCallsPerDay: 1, maxCallAttemptsPerLead: 9 };
  const { store, brief, runId } = await liveRun(g);

  const made: Lead[] = [];
  for (let i = 0; i < 2; i += 1) {
    const intake = intakeLead(store, g, runId, {
      name: `Person ${i}`,
      phone: `98765432${String(20 + i)}`,
      consent: true,
      consentSource: 'meta_instant_form',
      adId: `ad_${i}`,
    });
    if (intake.status !== 'accepted') throw new Error('setup failed');
    made.push(intake.lead);
  }

  const first = await dispatchLead(store, new MockVoiceProvider(3), g, made[0]!, brief, 'http://x/hook');
  const second = await dispatchLead(store, new MockVoiceProvider(3), g, made[1]!, brief, 'http://x/hook');
  assert.equal(first.status, 'dispatched');
  assert.equal(second.status, 'deferred');

  assert.ok(
    store.pendingLeads(runId).some((l) => l.leadId === made[1]!.leadId),
    'the deferred lead is still waiting, not written off',
  );
  store.close();
});

test('the ceiling is measured on the clock dispatchLead is given', async () => {
  // The existing clock test drove the store directly. This drives the caller,
  // which is where the two halves of the bug actually met: recordCallAttempt
  // stamped the real clock while dispatchLead had been handed a simulated one.
  const cap = 2;
  const g = { ...G, maxCallsPerDay: cap, maxCallAttemptsPerLead: 9 };
  const { store, brief, runId } = await liveRun(g);

  const leadAt = async (index: number, at: Date) => {
    const intake = intakeLead(store, g, runId, {
      name: `Person ${index}`,
      phone: `98765${String(10000 + index)}`,
      consent: true,
      consentSource: 'meta_instant_form',
      adId: `ad_${index}`,
    });
    if (intake.status !== 'accepted') throw new Error('setup failed');
    return dispatchLead(store, new MockVoiceProvider(3), g, intake.lead, brief, 'http://x/hook', {}, at);
  };

  const twoDaysAgo = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000);
  for (let i = 0; i < cap; i += 1) {
    assert.equal((await leadAt(i, twoDaysAgo)).status, 'dispatched', 'the simulated day has its own allowance');
  }
  assert.equal((await leadAt(99, twoDaysAgo)).status, 'deferred', 'and the ceiling binds within it');

  // A simulated day far enough away that the rolling window does not reach
  // back into the first batch - two days apart would still overlap at the
  // boundary, since the window is 24 hours wide.
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
  assert.equal((await leadAt(200, yesterday)).status, 'dispatched');
  store.close();
});

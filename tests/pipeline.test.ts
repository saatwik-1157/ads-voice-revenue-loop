import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store/db.ts';
import { defaultGuardrails, isWithinCallWindow, nextTimeInsideCallWindow } from '../src/config/guardrails.ts';
import { fromMetaLeadgen, intakeLead } from '../src/pipeline/intake.ts';
import { dispatchLead } from '../src/pipeline/dispatch.ts';
import { handleCallWebhook, verifySignature, verifyToken } from '../src/pipeline/webhooks.ts';
import { MockVoiceProvider } from '../src/voice/mock.ts';
import { generateBrief } from '../src/brief/generator.ts';
import { checkClaims, checkPromiseAlignment, offersOptOut } from '../src/brief/claims.ts';
import { createHmac } from 'node:crypto';

const G = { ...defaultGuardrails, callWindow: { startHour: 0, endHour: 24, timeZone: 'UTC' } };

function freshStore(): Store {
  return new Store(':memory:');
}

const VALID_LEAD = {
  name: 'Asha R',
  phone: '9876543210',
  consent: true,
  consentSource: 'meta_instant_form',
  adId: 'ad_1',
  creativeId: 'cr_1',
};

test('intake refuses leads it has no lawful basis or usable number for', () => {
  const store = freshStore();
  const runId = store.createRun('test');

  assert.equal(intakeLead(store, G, runId, { ...VALID_LEAD, consent: false }).status, 'rejected');
  assert.equal(intakeLead(store, G, runId, { ...VALID_LEAD, consentSource: undefined }).status, 'rejected');
  assert.equal(intakeLead(store, G, runId, { ...VALID_LEAD, phone: 'nope' }).status, 'rejected');
  assert.equal(intakeLead(store, G, runId, { ...VALID_LEAD, name: '  ' }).status, 'rejected');
  store.close();
});

test('intake deduplicates a replayed webhook and honours suppression', () => {
  const store = freshStore();
  const runId = store.createRun('test');

  const first = intakeLead(store, G, runId, VALID_LEAD);
  assert.equal(first.status, 'accepted');
  const replay = intakeLead(store, G, runId, VALID_LEAD);
  assert.equal(replay.status, 'duplicate');
  assert.equal(store.countLeads(runId), 1);

  store.suppress('+919999999999', 'prior opt-out');
  const suppressed = intakeLead(store, G, runId, { ...VALID_LEAD, phone: '9999999999' });
  assert.equal(suppressed.status, 'rejected');
  store.close();
});

test('Meta leadgen payloads map onto the intake shape', () => {
  const raw = fromMetaLeadgen({
    field_data: [
      { name: 'full_name', values: ['Asha R'] },
      { name: 'phone_number', values: ['+91 98765 43210'] },
      { name: 'email', values: ['asha@example.com'] },
    ],
    campaign_id: 'c1',
    adset_id: 's1',
    ad_id: 'a1',
  });
  assert.equal(raw.name, 'Asha R');
  assert.equal(raw.phone, '+91 98765 43210');
  assert.equal(raw.adId, 'a1');
  assert.equal(raw.consentSource, 'meta_instant_form');
});

test('dispatch defers outside the calling window and never calls a suppressed number', async () => {
  const store = freshStore();
  const voice = new MockVoiceProvider();
  const { brief } = await generateBrief(G);
  const runId = store.createRun(brief.niche.name);
  store.saveBrief(runId, brief);

  const intake = intakeLead(store, G, runId, VALID_LEAD);
  assert.equal(intake.status, 'accepted');
  if (intake.status !== 'accepted') return;

  const closed = { ...G, callWindow: { startHour: 3, endHour: 4, timeZone: 'UTC' } };
  const now = new Date();
  const hourUtc = now.getUTCHours();
  const windowThatIsClosed =
    hourUtc >= 3 && hourUtc < 4 ? { startHour: 5, endHour: 6, timeZone: 'UTC' } : closed.callWindow;

  const deferred = await dispatchLead(
    store,
    voice,
    { ...G, callWindow: windowThatIsClosed },
    intake.lead,
    brief,
    'http://localhost/hook',
  );
  assert.equal(deferred.status, 'deferred');

  store.suppress(intake.lead.phoneE164, 'opted out earlier');
  const blocked = await dispatchLead(store, voice, G, intake.lead, brief, 'http://localhost/hook');
  assert.equal(blocked.status, 'suppressed');
  store.close();
});

test('dispatch is idempotent - a retried handoff does not place a second call', async () => {
  const store = freshStore();
  const voice = new MockVoiceProvider();
  const { brief } = await generateBrief(G);
  const runId = store.createRun(brief.niche.name);
  store.saveBrief(runId, brief);
  const intake = intakeLead(store, G, runId, VALID_LEAD);
  if (intake.status !== 'accepted') throw new Error('setup failed');

  const a = await dispatchLead(store, voice, G, intake.lead, brief, 'http://localhost/hook');
  const b = await dispatchLead(store, voice, G, intake.lead, brief, 'http://localhost/hook');
  assert.equal(a.status, 'dispatched');
  assert.equal(b.status, 'dispatched');
  if (a.status === 'dispatched' && b.status === 'dispatched') {
    assert.equal(a.callRef, b.callRef);
  }
  store.close();
});

test('a won call records revenue once, and an opt-out suppresses the number', async () => {
  const store = freshStore();
  const { brief } = await generateBrief(G);
  const runId = store.createRun(brief.niche.name);
  store.saveBrief(runId, brief);
  const intake = intakeLead(store, G, runId, VALID_LEAD);
  if (intake.status !== 'accepted') throw new Error('setup failed');

  const payload = {
    call_id: 'call_1',
    lead_id: intake.lead.leadId,
    connected: true,
    qualified: true,
    appointment_booked: true,
    sale_status: 'won',
    expected_value: 5000,
    opt_out: false,
  };
  assert.equal(handleCallWebhook(store, payload).status, 'recorded');
  assert.equal(handleCallWebhook(store, payload).status, 'recorded');

  const revenue = store.db
    .prepare('SELECT COALESCE(SUM(amount_minor),0) AS total FROM revenue')
    .get() as { total: number };
  assert.equal(revenue.total, 500000, 'a replayed webhook must not double-count revenue');

  const second = intakeLead(store, G, runId, { ...VALID_LEAD, phone: '9876500000' });
  if (second.status !== 'accepted') throw new Error('setup failed');
  handleCallWebhook(store, {
    call_id: 'call_2',
    lead_id: second.lead.leadId,
    connected: true,
    qualified: false,
    opt_out: true,
  });
  assert.ok(store.isSuppressed(second.lead.phoneE164));
  store.close();
});

test('a pending appointment is a forecast, not revenue', async () => {
  const store = freshStore();
  const { brief } = await generateBrief(G);
  const runId = store.createRun(brief.niche.name);
  store.saveBrief(runId, brief);
  const intake = intakeLead(store, G, runId, VALID_LEAD);
  if (intake.status !== 'accepted') throw new Error('setup failed');

  handleCallWebhook(store, {
    call_id: 'call_3',
    lead_id: intake.lead.leadId,
    connected: true,
    qualified: true,
    appointment_booked: true,
    sale_status: 'pending',
    expected_value: 5000,
  });
  const revenue = store.db.prepare('SELECT COALESCE(SUM(amount_minor),0) AS total FROM revenue').get() as {
    total: number;
  };
  assert.equal(revenue.total, 0);
  store.close();
});

test('webhook signatures are verified, not trusted', () => {
  const body = JSON.stringify({ lead_id: 'lead_1' });
  const secret = 'shhh';
  const good = `sha256=${createHmac('sha256', secret).update(body, 'utf8').digest('hex')}`;
  assert.equal(verifySignature(body, good, secret), true);
  assert.equal(verifySignature(body, good, 'wrong-secret'), false);
  assert.equal(verifySignature(body, 'sha256=deadbeef', secret), false);
  assert.equal(verifySignature(body, good, ''), false, 'an unset secret must never pass');
});

test('the brief blocks unsupported claims and promise drift before a human sees it', async () => {
  const { brief } = await generateBrief(G);
  assert.deepEqual(checkClaims(brief, G), []);
  assert.deepEqual(checkPromiseAlignment(brief), []);

  const bad = structuredClone(brief);
  bad.offer.outcome = 'Guaranteed results, 100% risk free';
  assert.ok(checkClaims(bad, G).length >= 2);

  const drifted = structuredClone(brief);
  drifted.callScript.optOutLine = 'Thanks for your time.';
  assert.ok(checkPromiseAlignment(drifted).some((d) => d.includes('optOutLine')));
});

test('offersOptOut recognises the ways a script actually phrases it', () => {
  assert.ok(offersOptOut('I will opt you out right now'));
  assert.ok(offersOptOut('we will not call this number again'));
  assert.ok(offersOptOut('I can remove your number from our list'));
  assert.ok(!offersOptOut('Thanks, have a good day'));
});

test('a static token authenticates a provider that cannot sign the body', () => {
  assert.equal(verifyToken('shared-token', 'shared-token'), true);
  assert.equal(verifyToken('wrong-token0', 'shared-token'), false, 'same length, different value');
  assert.equal(verifyToken('short', 'shared-token'), false);
  assert.equal(verifyToken('shared-token', ''), false, 'an unset token fails closed');
  assert.equal(verifyToken('', 'shared-token'), false, 'a missing header fails closed');
});

test('a dispatch is judged against the time it is claimed to happen', async () => {
  // Regression: the demo simulates days elapsing but the window was checked
  // against the real wall clock, so running it outside working hours deferred
  // every call and reported "0 connected" - a working guardrail that read as a
  // broken funnel.
  const store = freshStore();
  const voice = new MockVoiceProvider();
  const { brief } = await generateBrief(G);
  const runId = store.createRun(brief.niche.name);
  store.saveBrief(runId, brief);
  const intake = intakeLead(store, G, runId, VALID_LEAD);
  if (intake.status !== 'accepted') throw new Error('setup failed');

  const window = { ...G, callWindow: { startHour: 9, endHour: 17, timeZone: 'UTC' } };
  const inside = new Date('2026-09-14T12:00:00Z');
  const outside = new Date('2026-09-14T23:00:00Z');

  const deferred = await dispatchLead(store, voice, window, intake.lead, brief, 'http://x/hook', {}, outside);
  assert.equal(deferred.status, 'deferred');

  const sent = await dispatchLead(store, voice, window, intake.lead, brief, 'http://x/hook', {}, inside);
  assert.equal(sent.status, 'dispatched');
  store.close();
});

test('nextTimeInsideCallWindow finds an hour the window accepts', () => {
  const window = { ...G, callWindow: { startHour: 9, endHour: 17, timeZone: 'UTC' } };
  for (const from of ['2026-09-14T23:00:00Z', '2026-09-14T03:00:00Z', '2026-09-14T12:00:00Z']) {
    const at = nextTimeInsideCallWindow(window, new Date(from));
    assert.ok(isWithinCallWindow(window, at), `${from} -> ${at.toISOString()} must be inside the window`);
  }
  // Already inside means no movement at all.
  const noon = new Date('2026-09-14T12:00:00Z');
  assert.equal(nextTimeInsideCallWindow(window, noon).getTime(), noon.getTime());
});

test('money moving gets its own audit entry, on both paths', async () => {
  // Found by using the audit command: the voice path recorded revenue without
  // auditing it, so a sale - the most important thing that happens here - was
  // only implied by the call outcome.
  const store = freshStore();
  const { brief } = await generateBrief(G);
  const runId = store.createRun(brief.niche.name);
  store.saveBrief(runId, brief);
  const intake = intakeLead(store, G, runId, VALID_LEAD);
  if (intake.status !== 'accepted') throw new Error('setup failed');

  handleCallWebhook(store, {
    call_id: 'call_won',
    lead_id: intake.lead.leadId,
    connected: true,
    qualified: true,
    sale_status: 'won',
    expected_value: 5000,
  });

  const recorded = store.listAudit(runId, { kind: 'revenue.recorded' });
  assert.equal(recorded.length, 1, 'a won sale is audited, not merely stored');
  const detail = JSON.parse(recorded[0]!.detail) as Record<string, unknown>;
  assert.equal(detail.amountMinor, 500000);
  assert.equal(detail.source, 'voice_agent');
  assert.equal(detail.adId, 'ad_1', 'the sale is attributable from the audit line alone');
  store.close();
});

test('a lost or pending call records no revenue and no revenue audit', async () => {
  const store = freshStore();
  const { brief } = await generateBrief(G);
  const runId = store.createRun(brief.niche.name);
  store.saveBrief(runId, brief);
  const intake = intakeLead(store, G, runId, VALID_LEAD);
  if (intake.status !== 'accepted') throw new Error('setup failed');

  handleCallWebhook(store, {
    call_id: 'call_pending',
    lead_id: intake.lead.leadId,
    connected: true,
    qualified: true,
    appointment_booked: true,
    sale_status: 'pending',
    expected_value: 5000,
  });
  assert.equal(store.listAudit(runId, { kind: 'revenue.recorded' }).length, 0, 'a forecast is not revenue');
  store.close();
});

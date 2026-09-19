import { OperationInFlightError, type Store } from '../store/db.ts';
import { CircuitOpenError } from '../core/breaker.ts';
import type { VoiceProvider } from '../voice/provider.ts';
import type { Brief, Lead } from '../core/types.ts';
import { isWithinCallWindow, type Guardrails } from '../config/guardrails.ts';
import { maskPhone } from '../core/util.ts';

export type DispatchResult =
  | { status: 'dispatched'; leadId: string; callRef: string }
  | { status: 'deferred'; leadId: string; reason: string }
  | { status: 'suppressed'; leadId: string; reason: string };

/**
 * Phase E, second half: lead handoff.
 *
 * Speed is the single biggest driver of connect rate, so this runs as soon as a
 * lead lands - but never outside the calling window, never to a suppressed
 * number, and never past the daily call ceiling.
 */
export async function dispatchLead(
  store: Store,
  voice: VoiceProvider,
  g: Guardrails,
  lead: Lead,
  brief: Brief,
  webhookUrl: string,
  extraMetadata: Record<string, string> = {},
  /**
   * When this call is considered to be happening. Defaults to now; the demo
   * passes a simulated time because it simulates days elapsing, and judging a
   * simulated call against the real wall clock is a category error.
   */
  at: Date = new Date(),
): Promise<DispatchResult> {
  const stop = store.emergencyStop();
  if (stop.engaged) {
    // Deferred, not suppressed: the lead is fine and should be called once
    // somebody has looked at why the system stopped.
    store.audit(lead.runId, 'system', 'call.deferred', {
      leadId: lead.leadId,
      reason: 'emergency stop engaged',
      trigger: stop.trigger,
    });
    return { status: 'deferred', leadId: lead.leadId, reason: `emergency stop engaged: ${stop.reason ?? ''}` };
  }

  if (store.isSuppressed(lead.phoneE164)) {
    store.setLeadCallStatus(lead.leadId, 'suppressed');
    store.audit(lead.runId, 'system', 'call.suppressed', { leadId: lead.leadId, reason: 'suppression list' });
    return { status: 'suppressed', leadId: lead.leadId, reason: 'number is on the suppression list' };
  }
  if (!lead.consent) {
    store.setLeadCallStatus(lead.leadId, 'suppressed');
    store.audit(lead.runId, 'system', 'call.suppressed', { leadId: lead.leadId, reason: 'no consent on record' });
    return { status: 'suppressed', leadId: lead.leadId, reason: 'no consent on record' };
  }
  if (!isWithinCallWindow(g, at)) {
    store.audit(lead.runId, 'system', 'call.deferred', {
      leadId: lead.leadId,
      window: `${g.callWindow.startHour}-${g.callWindow.endHour} ${g.callWindow.timeZone}`,
    });
    return {
      status: 'deferred',
      leadId: lead.leadId,
      reason: `outside calling window ${g.callWindow.startHour}:00-${g.callWindow.endHour}:00 ${g.callWindow.timeZone}`,
    };
  }
  // Counted against the same clock this dispatch is happening on. The demo
  // simulates days elapsing in seconds, so measuring its calls against the real
  // wall clock collapses a week into one day and the ceiling binds immediately.
  const callsToday = store.callsToday(at);
  if (callsToday >= g.maxCallsPerDay) {
    // Audited like every other refusal. This one was silent, which made it the
    // worst of them to hit: leads keep arriving and being accepted, no calls go
    // out, and `audit --kind call.deferred` - the command this README points at
    // for exactly that symptom - returned nothing at all.
    store.audit(lead.runId, 'system', 'call.deferred', {
      leadId: lead.leadId,
      reason: 'daily call ceiling',
      callsToday,
      cap: g.maxCallsPerDay,
    });
    return { status: 'deferred', leadId: lead.leadId, reason: `daily call ceiling ${g.maxCallsPerDay} reached` };
  }

  // This cap was declared in the guardrails, validated on load, and printed by
  // `guardrails` - and read by nothing that places a call. It is the rule that
  // stops one person being dialled over and over, so an unenforced version was
  // worse than none: the control layer said they were protected.
  // Counted per person, not per lead row. The dedupe key includes the ad id,
  // so one person answering two ads becomes two leads - and a per-row cap then
  // allows twice the calls it claims to. The rule is about the phone ringing.
  const attempts = store.callCountForPhone(lead.runId, lead.phoneE164);
  if (attempts >= g.maxCallAttemptsPerLead) {
    store.setLeadCallStatus(lead.leadId, 'completed');
    store.audit(lead.runId, 'system', 'call.attempts_exhausted', {
      leadId: lead.leadId,
      phone: maskPhone(lead.phoneE164),
      attempts,
      cap: g.maxCallAttemptsPerLead,
    });
    return {
      status: 'suppressed',
      leadId: lead.leadId,
      reason: `already called ${attempts} time(s); maxCallAttemptsPerLead is ${g.maxCallAttemptsPerLead}`,
    };
  }

  const metadata: Record<string, string> = {
    lead_id: lead.leadId,
    run_id: lead.runId,
    campaign_id: lead.campaignId ?? '',
    adset_id: lead.adsetId ?? '',
    ad_id: lead.adId ?? '',
    creative_id: lead.creativeId ?? '',
    ...extraMetadata,
  };

  let callRef: string;
  try {
    ({ callRef } = await store.onceAsync('voice.dispatch', [lead.leadId], () =>
      voice.dispatchCall({
        lead,
        brief,
        metadata,
        webhookUrl,
        idempotencyKey: `call:${lead.leadId}`,
      }),
    ));
  } catch (err) {
    // A redelivered webhook arriving while the first is still dialling. The
    // first attempt owns this call; standing down is the correct outcome, not
    // an error, and certainly not a second ring on someone's phone.
    if (err instanceof OperationInFlightError) {
      store.audit(lead.runId, 'system', 'call.already_dispatching', { leadId: lead.leadId });
      return { status: 'deferred', leadId: lead.leadId, reason: 'a call to this lead is already being placed' };
    }
    // The dialler is down and the circuit is open. The lead is fine and should
    // be called once the provider is back, so this defers rather than throwing
    // - a thrown error here becomes a 500 on the lead webhook, which asks Meta
    // to redeliver a lead we already hold.
    if (err instanceof CircuitOpenError) {
      const open: CircuitOpenError = err;
      store.audit(lead.runId, 'system', 'call.deferred', {
        leadId: lead.leadId,
        reason: 'voice provider circuit open',
        retryAfterMs: open.retryAfterMs,
      });
      return { status: 'deferred', leadId: lead.leadId, reason: open.message };
    }
    throw err;
  }

  // Recorded here, the moment the provider accepted it - not when the result
  // comes back. Both call caps count these rows, so a call already dialling
  // counts against them. Counting returned outcomes instead meant a cap of 25
  // dispatched 60, and a cap of one attempt per person dialled them three
  // times, because nothing in flight was visible to either check.
  store.recordCallAttempt(lead, at.toISOString());
  store.setLeadCallStatus(lead.leadId, 'dispatched');
  store.audit(lead.runId, 'voice', 'call.dispatched', {
    leadId: lead.leadId,
    callRef,
    phone: maskPhone(lead.phoneE164),
    adId: lead.adId,
  });
  return { status: 'dispatched', leadId: lead.leadId, callRef };
}

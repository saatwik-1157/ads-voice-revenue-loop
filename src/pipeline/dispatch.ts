import type { Store } from '../store/db.ts';
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
  if (store.isSuppressed(lead.phoneE164)) {
    store.setLeadCallStatus(lead.leadId, 'suppressed');
    store.audit(lead.runId, 'system', 'call.suppressed', { leadId: lead.leadId, reason: 'suppression list' });
    return { status: 'suppressed', leadId: lead.leadId, reason: 'number is on the suppression list' };
  }
  if (!lead.consent) {
    store.setLeadCallStatus(lead.leadId, 'suppressed');
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
  if (store.callsToday() >= g.maxCallsPerDay) {
    return { status: 'deferred', leadId: lead.leadId, reason: `daily call ceiling ${g.maxCallsPerDay} reached` };
  }

  // This cap was declared in the guardrails, validated on load, and printed by
  // `guardrails` - and read by nothing that places a call. It is the rule that
  // stops one person being dialled over and over, so an unenforced version was
  // worse than none: the control layer said they were protected.
  const attempts = store.callCountForLead(lead.leadId);
  if (attempts >= g.maxCallAttemptsPerLead) {
    store.setLeadCallStatus(lead.leadId, 'completed');
    store.audit(lead.runId, 'system', 'call.attempts_exhausted', {
      leadId: lead.leadId,
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

  const { callRef } = await store.onceAsync('voice.dispatch', [lead.leadId], () =>
    voice.dispatchCall({
      lead,
      brief,
      metadata,
      webhookUrl,
      idempotencyKey: `call:${lead.leadId}`,
    }),
  );

  store.setLeadCallStatus(lead.leadId, 'dispatched');
  store.audit(lead.runId, 'voice', 'call.dispatched', {
    leadId: lead.leadId,
    callRef,
    phone: maskPhone(lead.phoneE164),
    adId: lead.adId,
  });
  return { status: 'dispatched', leadId: lead.leadId, callRef };
}

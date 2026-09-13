import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Store } from '../store/db.ts';
import type { CallOutcome } from '../core/types.ts';
import { id, now } from '../core/util.ts';

/**
 * Phase F: structured call results come back here and are written against the
 * original lead - which still carries the campaign/adset/ad/creative ids, so the
 * outcome is attributable to the exact ad that paid for it.
 */

export interface RawCallResult {
  call_id?: string;
  lead_id?: string;
  connected?: boolean;
  qualified?: boolean;
  intent_score?: number;
  objection?: string | null;
  appointment_booked?: boolean;
  sale_status?: string;
  expected_value?: number;
  next_action?: string;
  summary?: string;
  opt_out?: boolean;
  metadata?: Record<string, string>;
}

export type WebhookResult =
  | { status: 'recorded'; outcome: CallOutcome }
  | { status: 'ignored'; reason: string };

export function handleCallWebhook(store: Store, raw: RawCallResult): WebhookResult {
  const leadId = raw.lead_id ?? raw.metadata?.lead_id;
  if (!leadId) return { status: 'ignored', reason: 'payload carried no lead_id' };

  const lead = store.getLead(leadId);
  if (!lead) return { status: 'ignored', reason: `unknown lead ${leadId}` };

  const outcome: CallOutcome = {
    callId: raw.call_id ?? id('call'),
    leadId,
    connected: raw.connected === true,
    qualified: raw.qualified === true,
    intentScore: clampScore(raw.intent_score),
    objection: raw.objection ?? null,
    appointmentBooked: raw.appointment_booked === true,
    saleStatus: normalizeSaleStatus(raw.sale_status),
    // Values arrive as major units from the voice provider.
    expectedValueMinor: Math.round(Number(raw.expected_value ?? 0) * 100),
    nextAction: raw.next_action ?? '',
    summary: raw.summary ?? '',
    optOut: raw.opt_out === true,
    receivedAt: now(),
  };

  // Idempotent by call id: a retried webhook must not double-count revenue.
  return store.once('voice.webhook', [outcome.callId], () => {
    store.saveCall(outcome);
    store.setLeadCallStatus(leadId, 'completed');

    if (outcome.optOut) {
      store.suppress(lead.phoneE164, 'lead opted out on call');
      store.audit(lead.runId, 'voice', 'lead.opted_out', { leadId });
    }
    // Only a won sale counts as revenue. An expected value on a pending
    // appointment is a forecast, and forecasts must not move ROAS.
    if (outcome.saleStatus === 'won' && outcome.expectedValueMinor > 0) {
      store.recordRevenue(leadId, outcome.expectedValueMinor, 'voice_agent');
    }
    store.audit(lead.runId, 'voice', 'call.outcome', {
      leadId,
      callId: outcome.callId,
      connected: outcome.connected,
      qualified: outcome.qualified,
      saleStatus: outcome.saleStatus,
      adId: lead.adId,
      creativeId: lead.creativeId,
    });
    return { status: 'recorded', outcome } satisfies WebhookResult;
  });
}

/** Record a conversion that arrives from the payment system rather than the call. */
export function recordExternalRevenue(store: Store, leadId: string, amountMinor: number, source: string): boolean {
  const lead = store.getLead(leadId);
  if (!lead) return false;
  store.recordRevenue(leadId, amountMinor, source);
  store.audit(lead.runId, 'system', 'revenue.recorded', { leadId, amountMinor, source });
  return true;
}

function clampScore(value: unknown): number {
  const n = Number(value ?? 0);
  if (!Number.isFinite(n)) return 0;
  return Math.min(100, Math.max(0, Math.round(n)));
}

function normalizeSaleStatus(value: string | undefined): CallOutcome['saleStatus'] {
  switch ((value ?? '').toLowerCase()) {
    case 'won':
    case 'closed':
    case 'sold':
      return 'won';
    case 'pending':
    case 'booked':
      return 'pending';
    case 'lost':
    case 'no':
      return 'lost';
    default:
      return 'none';
  }
}

/**
 * Verify an inbound webhook signature. Both Meta and OmniDimension sign with an
 * HMAC over the raw body; an unsigned or mismatched payload is dropped, because
 * anything that reaches these handlers can create calls and move money.
 */
export function verifySignature(rawBody: string, signature: string, secret: string, prefix = 'sha256='): boolean {
  if (!secret) return false;
  const provided = signature.startsWith(prefix) ? signature.slice(prefix.length) : signature;
  const expected = createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex');
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(provided, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

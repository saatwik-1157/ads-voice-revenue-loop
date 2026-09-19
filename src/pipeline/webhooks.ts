import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Store } from '../store/db.ts';
import type { CallOutcome } from '../core/types.ts';
import { fingerprint, now } from '../core/util.ts';

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

  // Major units from the voice provider, and the only field in this payload
  // that becomes money. Rejected rather than coerced: `1e999` becomes
  // Infinity, which is greater than every ROAS target there is, so a single
  // malformed payload was enough to make the engine SCALE on infinite return.
  // `"abc"` became NaN and died on a NOT NULL constraint, throwing a database
  // error at a provider that would then redeliver it forever.
  // A bad amount does not discard the call. It really happened, and whether it
  // connected and qualified is worth keeping; only the money is unusable, and
  // treating it as zero errs towards not scaling. The refusal is audited so
  // nobody has to infer a missing sale from a suspiciously low ROAS.
  const parsedValue = parseExpectedValue(raw.expected_value);
  const expectedValueMinor = parsedValue ?? 0;

  const outcome: CallOutcome = {
    callId: callIdFor(raw, leadId),
    leadId,
    connected: raw.connected === true,
    qualified: raw.qualified === true,
    intentScore: clampScore(raw.intent_score),
    objection: raw.objection ?? null,
    appointmentBooked: raw.appointment_booked === true,
    saleStatus: normalizeSaleStatus(raw.sale_status),
    expectedValueMinor,
    nextAction: raw.next_action ?? '',
    summary: raw.summary ?? '',
    optOut: raw.opt_out === true,
    receivedAt: now(),
  };

  // Idempotent by call id: a retried webhook must not double-count revenue.
  // One transaction: the call, the suppression, the revenue and the audit rows
  // are one fact about one phone conversation. Crashing between them left a
  // call with no revenue, or revenue nobody could explain - and no later read
  // could tell that apart from a call that genuinely earned nothing.
  return store.once('voice.webhook', [outcome.callId], () =>
    store.transaction(() => {
      store.saveCall(outcome);
      store.setLeadCallStatus(leadId, 'completed');

      if (parsedValue === null) {
        store.audit(lead.runId, 'voice', 'revenue.unusable_value', {
          leadId,
          callId: outcome.callId,
          received: JSON.stringify(raw.expected_value),
          note: 'call recorded with zero value; post the real amount to /revenue if there was a sale',
        });
      }

      if (outcome.optOut) {
        store.suppress(lead.phoneE164, 'lead opted out on call');
        store.audit(lead.runId, 'voice', 'lead.opted_out', { leadId });
      }
      // Only a won sale counts as revenue. An expected value on a pending
      // appointment is a forecast, and forecasts must not move ROAS.
      if (outcome.saleStatus === 'won' && outcome.expectedValueMinor > 0) {
        store.recordRevenue(leadId, outcome.expectedValueMinor, 'voice_agent');
        // Money moving is the single most important thing that happens here, so
        // it gets its own entry rather than being implied by the call outcome.
        store.audit(lead.runId, 'voice', 'revenue.recorded', {
          leadId,
          amountMinor: outcome.expectedValueMinor,
          source: 'voice_agent',
          adId: lead.adId,
          creativeId: lead.creativeId,
        });
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
    }),
  );
}

/** Record a conversion that arrives from the payment system rather than the call. */
export function recordExternalRevenue(store: Store, leadId: string, amountMinor: number, source: string): boolean {
  const lead = store.getLead(leadId);
  if (!lead) return false;
  store.recordRevenue(leadId, amountMinor, source);
  store.audit(lead.runId, 'system', 'revenue.recorded', { leadId, amountMinor, source });
  return true;
}

/**
 * The amount, in minor units, or null if it is not one.
 *
 * Absent is zero - plenty of calls end without a sale. Anything present has to
 * be a finite, non-negative number, because this is the figure every
 * KEEP/KILL/SCALE decision is ultimately made from.
 */
function parseExpectedValue(raw: unknown): number | null {
  if (raw === undefined || raw === null || raw === '') return 0;
  if (typeof raw !== 'number' && typeof raw !== 'string') return null;
  const major = Number(raw);
  if (!Number.isFinite(major) || major < 0) return null;
  const minorUnits = Math.round(major * 100);
  return Number.isSafeInteger(minorUnits) ? minorUnits : null;
}

/**
 * The key a redelivered webhook is deduplicated on.
 *
 * `call_id` when the provider sends one. When it does not, this used to fall
 * back to a fresh random id, which quietly turned the idempotency guarantee
 * directly above off: three deliveries of one payload wrote three call rows
 * and three revenue.recorded entries. Revenue itself survived only because it
 * is keyed per lead, and the funnel counts survived only because they count
 * distinct leads - the guarantee was being carried by two unrelated details.
 *
 * A fingerprint of the outcome restores it without rejecting a provider whose
 * field is named something else - which is a live possibility, since the
 * dispatch side of this contract is the least verified thing in the repo.
 */
function callIdFor(raw: RawCallResult, leadId: string): string {
  if (raw.call_id) return raw.call_id;
  return `call_${fingerprint([
    leadId,
    raw.connected ?? null,
    raw.qualified ?? null,
    raw.sale_status ?? null,
    raw.expected_value ?? null,
    raw.appointment_booked ?? null,
    raw.summary ?? null,
  ])}`;
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
 * Constant-time equality for a shared secret presented as a header.
 *
 * Weaker than an HMAC - it proves the sender knows a secret, not that the body
 * is untampered, and it is replayable by anyone who captures it. It exists
 * because a voice platform that can only attach a static header would otherwise
 * have no way to authenticate at all, and a documented weaker check beats an
 * open endpoint that places phone calls.
 */
export function verifyToken(provided: string, expected: string): boolean {
  if (!expected || !provided) return false;
  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
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

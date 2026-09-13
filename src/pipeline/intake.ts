import type { Store } from '../store/db.ts';
import type { Lead } from '../core/types.ts';
import type { Guardrails } from '../config/guardrails.ts';
import { fingerprint, id, maskPhone, now, PhoneError, toE164 } from '../core/util.ts';

export interface RawLead {
  name?: string;
  phone?: string;
  email?: string | null;
  consent?: boolean;
  consentSource?: string;
  campaignId?: string | null;
  adsetId?: string | null;
  adId?: string | null;
  creativeId?: string | null;
}

export type IntakeResult =
  | { status: 'accepted'; lead: Lead }
  | { status: 'duplicate'; leadId: string }
  | { status: 'rejected'; reason: string };

/**
 * Phase E, first half: lead capture.
 *
 * A lead is only admitted if we can normalize the number, we have a lawful basis
 * to call it, and it is not on the suppression list. Everything else is rejected
 * here rather than being quietly passed to the dialler.
 */
export function intakeLead(store: Store, g: Guardrails, runId: string, raw: RawLead): IntakeResult {
  const name = (raw.name ?? '').trim();
  if (!name) return reject(store, runId, 'missing name');

  let phoneE164: string;
  try {
    phoneE164 = toE164(raw.phone ?? '', g.defaultCountryCode);
  } catch (err) {
    const reason = err instanceof PhoneError ? err.message : String(err);
    return reject(store, runId, `unusable phone: ${reason}`);
  }

  if (g.requireExplicitConsent && raw.consent !== true) {
    return reject(store, runId, 'no explicit consent recorded for this lead');
  }
  if (!raw.consentSource) {
    return reject(store, runId, 'consentSource is required so the lawful basis is auditable');
  }
  if (store.isSuppressed(phoneE164)) {
    return reject(store, runId, `${maskPhone(phoneE164)} is on the suppression list`);
  }

  // Same person, same ad, same hour is the same lead however many times the
  // webhook fires.
  const dedupeKey = fingerprint([runId, phoneE164, raw.adId ?? null, new Date().toISOString().slice(0, 13)]);

  const lead: Lead = {
    leadId: id('lead'),
    runId,
    name,
    phoneE164,
    email: raw.email ?? null,
    consent: raw.consent === true,
    consentSource: raw.consentSource,
    campaignId: raw.campaignId ?? null,
    adsetId: raw.adsetId ?? null,
    adId: raw.adId ?? null,
    creativeId: raw.creativeId ?? null,
    createdAt: now(),
    callStatus: 'pending',
  };

  const { leadId, duplicate } = store.insertLead(lead, dedupeKey);
  if (duplicate) {
    store.audit(runId, 'meta', 'lead.duplicate', { leadId, phone: maskPhone(phoneE164) });
    return { status: 'duplicate', leadId };
  }
  store.audit(runId, 'meta', 'lead.accepted', {
    leadId,
    phone: maskPhone(phoneE164),
    adId: lead.adId,
    creativeId: lead.creativeId,
  });
  return { status: 'accepted', lead };
}

function reject(store: Store, runId: string, reason: string): IntakeResult {
  store.audit(runId, 'system', 'lead.rejected', { reason });
  return { status: 'rejected', reason };
}

/**
 * Parse a Meta leadgen webhook payload into the fields we need.
 * Meta delivers answers as a field_data array of {name, values}.
 */
export function fromMetaLeadgen(payload: {
  field_data?: Array<{ name: string; values: string[] }>;
  campaign_id?: string;
  adset_id?: string;
  ad_id?: string;
}): RawLead {
  const fields = new Map((payload.field_data ?? []).map((f) => [f.name.toLowerCase(), f.values[0] ?? '']));
  return {
    name: fields.get('full_name') ?? fields.get('name') ?? '',
    phone: fields.get('phone_number') ?? fields.get('phone') ?? '',
    email: fields.get('email') ?? null,
    // Submitting a Meta instant form that states the callback is the consent
    // event; we still record where it came from so it can be audited later.
    consent: true,
    consentSource: 'meta_instant_form',
    campaignId: payload.campaign_id ?? null,
    adsetId: payload.adset_id ?? null,
    adId: payload.ad_id ?? null,
  };
}

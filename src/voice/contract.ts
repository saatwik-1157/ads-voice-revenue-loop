import type { Brief, Lead } from '../core/types.ts';
import type { Env } from '../config/env.ts';
import { toE164 } from '../core/util.ts';

/**
 * A contract probe for the voice platform's dispatch API.
 *
 * The dispatch shape in omnidimension.ts was written from the playbook's
 * description, not from OmniDimension's docs, and it is the least-verified
 * thing in this repo. Reconciling it by reading is slow and easy to get subtly
 * wrong; this turns it into a run that names the mismatch and the line to
 * change.
 *
 * It is deliberately hard to fire by accident: the live mode needs an explicit
 * flag, an explicit number, and an explicit acknowledgement, because the
 * successful case is a real phone ringing.
 */

export type CheckStatus = 'pass' | 'fail' | 'warn' | 'skipped';

export interface Finding {
  check: string;
  status: CheckStatus;
  detail: string;
  /** Where to change things when this fails. */
  fix?: string;
}

export interface ProbeOptions {
  env: Env;
  /** Actually dispatch. Without this nothing leaves the machine. */
  live?: boolean;
  /** The number to ring. Yours, for the first run. */
  to?: string;
  /** Send the same dispatch twice to see whether the idempotency key holds. */
  checkIdempotency?: boolean;
  fetchImpl?: typeof fetch;
}

export interface ProbeResult {
  findings: Finding[];
  request: { url: string; headers: Record<string, string>; body: unknown };
  passed: boolean;
}

const WHERE = 'src/voice/omnidimension.ts -> dispatchCall';

/** The request we would send, built from a representative lead and brief. */
export function buildProbeRequest(env: Env, toNumber: string, lead: Lead, brief: Brief) {
  return {
    url: `${env.omni.baseUrl.replace(/\/$/, '')}/calls/dispatch`,
    headers: {
      Authorization: `Bearer ${env.omni.apiKey ? '<OMNI_API_KEY>' : '(unset)'}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': `call:${lead.leadId}`,
    },
    body: {
      agent_id: env.omni.agentId || '(unset)',
      to_number: toNumber,
      call_context: {
        customer_name: lead.name,
        offer_summary: brief.offer.outcome,
        deliverable: brief.offer.deliverable,
        opener: brief.callScript.opener,
        qualifying_questions: brief.callScript.qualifyingQuestions,
        approved_answers: brief.callScript.approvedAnswers,
        objection_handling: brief.callScript.objectionHandling,
        conversion_ask: brief.callScript.conversionAsk,
        opt_out_line: brief.callScript.optOutLine,
        lead_id: lead.leadId,
        run_id: lead.runId,
        campaign_id: lead.campaignId ?? '',
        adset_id: lead.adsetId ?? '',
        ad_id: lead.adId ?? '',
        creative_id: lead.creativeId ?? '',
      },
      webhook_url: `${env.publicBaseUrl.replace(/\/$/, '')}/webhooks/omnidimension`,
    },
  };
}

export async function probeDispatchContract(
  options: ProbeOptions,
  lead: Lead,
  brief: Brief,
): Promise<ProbeResult> {
  const { env } = options;
  const findings: Finding[] = [];
  const toNumber = options.to ? safeE164(options.to, env, findings) : '+10000000000';
  const request = buildProbeRequest(env, toNumber, lead, brief);

  // --- configuration, checkable without touching the network -------------
  const missing: string[] = [];
  if (!env.omni.apiKey) missing.push('OMNI_API_KEY');
  if (!env.omni.agentId) missing.push('OMNI_AGENT_ID');
  findings.push(
    missing.length
      ? { check: 'credentials', status: 'fail', detail: `not set: ${missing.join(', ')}`, fix: '.env' }
      : { check: 'credentials', status: 'pass', detail: 'OMNI_API_KEY and OMNI_AGENT_ID are set' },
  );

  findings.push(
    env.omni.webhookSecret || env.omni.webhookToken
      ? {
          check: 'inbound auth',
          status: env.omni.webhookSecret ? 'pass' : 'warn',
          detail: env.omni.webhookSecret
            ? 'OMNI_WEBHOOK_SECRET set - post-call webhooks verify by HMAC'
            : 'only OMNI_WEBHOOK_TOKEN set - weaker, replayable, says nothing about the body',
        }
      : {
          check: 'inbound auth',
          status: 'fail',
          detail: 'neither OMNI_WEBHOOK_SECRET nor OMNI_WEBHOOK_TOKEN set; every call outcome will 401',
          fix: '.env - see docs/omnidimension.md §5',
        },
  );

  findings.push(
    env.publicBaseUrl.startsWith('https://')
      ? { check: 'webhook url', status: 'pass', detail: `outcomes will be posted to ${request.body.webhook_url}` }
      : {
          check: 'webhook url',
          // A live probe places a real call whose outcome is posted back to
          // this URL. If the provider cannot reach it the probe proves nothing
          // - the call happens and the result is lost - so this fails rather
          // than warns. A dry run builds the request without sending it, where
          // the address not being reachable yet is fine.
          status: options.live ? 'fail' : 'warn',
          detail: `PUBLIC_BASE_URL is ${env.publicBaseUrl} - a provider cannot reach localhost`,
          fix: 'PUBLIC_BASE_URL in .env; docs/DEPLOY.md has a route that needs no account',
        },
  );

  if (!options.live) {
    for (const check of ['endpoint', 'request shape', 'response id', 'idempotency']) {
      findings.push({ check, status: 'skipped', detail: 'dry run - pass --live to actually dispatch' });
    }
    return { findings, request, passed: !findings.some((f) => f.status === 'fail') };
  }

  // --- the live half ------------------------------------------------------
  const doFetch = options.fetchImpl ?? fetch;
  const send = async (): Promise<{ status: number; text: string }> => {
    const res = await doFetch(request.url, {
      method: 'POST',
      headers: { ...request.headers, Authorization: `Bearer ${env.omni.apiKey}` },
      body: JSON.stringify(request.body),
    });
    return { status: res.status, text: await res.text() };
  };

  let first: { status: number; text: string };
  try {
    first = await send();
  } catch (err) {
    findings.push({
      check: 'endpoint',
      status: 'fail',
      detail: `could not reach ${request.url}: ${(err as Error).message}`,
      fix: `OMNI_BASE_URL in .env, or the path in ${WHERE}`,
    });
    return { findings, request, passed: false };
  }

  findings.push(...diagnose(first, request.url));
  if (findings.some((f) => f.check === 'response id' && f.status === 'pass') && options.checkIdempotency) {
    const second = await send();
    const a = extractCallRef(first.text);
    const b = extractCallRef(second.text);
    findings.push(
      a && b && a === b
        ? {
            check: 'idempotency',
            status: 'pass',
            detail: `a replayed dispatch returned the same call id (${a}) - retries are safe`,
          }
        : {
            check: 'idempotency',
            status: 'fail',
            detail: `replay returned ${b ?? 'no id'} against ${a ?? 'no id'} - the key is not honoured, so a retry dials twice`,
            fix: 'set retry: { attempts: 1 } where OmniDimensionProvider is constructed in src/orchestrator.ts',
          },
    );
  } else if (options.checkIdempotency) {
    findings.push({ check: 'idempotency', status: 'skipped', detail: 'the first dispatch did not succeed' });
  }

  return { findings, request, passed: !findings.some((f) => f.status === 'fail') };
}

/** Turn an HTTP response into findings that name the thing to change. */
export function diagnose(res: { status: number; text: string }, url: string): Finding[] {
  const body = res.text.slice(0, 300);

  if (res.status === 404) {
    return [
      {
        check: 'endpoint',
        status: 'fail',
        detail: `404 at ${url} - the path is wrong`,
        fix: `the template literal in ${WHERE}, or OMNI_BASE_URL`,
      },
    ];
  }
  if (res.status === 401 || res.status === 403) {
    return [
      { check: 'endpoint', status: 'pass', detail: 'the path exists - it answered' },
      {
        check: 'auth',
        status: 'fail',
        detail: `${res.status} - the key was rejected: ${body}`,
        fix: `OMNI_API_KEY, or the Authorization header style in ${WHERE}`,
      },
    ];
  }
  if (res.status === 422 || res.status === 400) {
    return [
      { check: 'endpoint', status: 'pass', detail: 'the path exists and the key was accepted' },
      {
        check: 'request shape',
        status: 'fail',
        detail: `${res.status} - the body was rejected. Read the message for the field it names: ${body}`,
        fix: `the body object literal in ${WHERE}`,
      },
    ];
  }
  if (res.status >= 500) {
    return [
      {
        check: 'endpoint',
        status: 'warn',
        detail: `${res.status} from the provider - transient, retry the probe: ${body}`,
      },
    ];
  }

  const findings: Finding[] = [
    { check: 'endpoint', status: 'pass', detail: 'the path exists and the key was accepted' },
    { check: 'request shape', status: 'pass', detail: `${res.status} - the body was accepted` },
  ];
  const callRef = extractCallRef(res.text);
  findings.push(
    callRef
      ? { check: 'response id', status: 'pass', detail: `call id read as "${callRef}"` }
      : {
          check: 'response id',
          status: 'fail',
          detail: `the response carried no requestId/call_id/id: ${body}`,
          fix: `the fallback chain at the end of ${WHERE}`,
        },
  );
  return findings;
}

export function extractCallRef(text: string): string | null {
  try {
    const parsed = JSON.parse(text) as { requestId?: string; call_id?: string; id?: string };
    return parsed.requestId ?? parsed.call_id ?? parsed.id ?? null;
  } catch {
    return null;
  }
}

function safeE164(raw: string, env: Env, findings: Finding[]): string {
  try {
    return toE164(raw, '91');
  } catch (err) {
    findings.push({
      check: 'to number',
      status: 'fail',
      detail: `${(err as Error).message} - give a full international number, e.g. +919876543210`,
    });
    void env;
    return raw;
  }
}

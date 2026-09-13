import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import type { Context } from '../orchestrator.ts';
import { voiceWebhookUrl } from '../orchestrator.ts';
import { fromMetaLeadgen, intakeLead } from '../pipeline/intake.ts';
import { dispatchLead } from '../pipeline/dispatch.ts';
import { handleCallWebhook, recordExternalRevenue, verifySignature, verifyToken } from '../pipeline/webhooks.ts';
import { economicsForRun } from '../economics/metrics.ts';
import { evaluate } from '../economics/decision.ts';
import { maskPhone } from '../core/util.ts';
import type { MockMetaProvider } from '../meta/mock.ts';
import type { MockVoiceProvider } from '../voice/mock.ts';

/**
 * The middleware layer: Meta leadgen in, voice dispatch out, call results back.
 *
 * Both webhook routes verify an HMAC signature before doing anything, because
 * an unauthenticated request here can place phone calls and record revenue.
 */
export function createHttpServer(ctx: Context) {
  return createServer((req, res) => {
    handle(ctx, req, res).catch((err: unknown) => {
      ctx.store.audit(null, 'system', 'http.error', { url: req.url, error: (err as Error).message });
      json(res, 500, { error: 'internal error' });
    });
  });
}

async function handle(ctx: Context, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const route = `${req.method} ${url.pathname}`;

  // Meta webhook subscription handshake.
  if (route === 'GET /webhooks/meta') {
    const mode = url.searchParams.get('hub.mode');
    const token = url.searchParams.get('hub.verify_token');
    const challenge = url.searchParams.get('hub.challenge') ?? '';
    if (mode === 'subscribe' && ctx.env.meta.verifyToken && token === ctx.env.meta.verifyToken) {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end(challenge);
      return;
    }
    json(res, 403, { error: 'verification failed' });
    return;
  }

  if (route === 'GET /health') {
    json(res, 200, { ok: true, mode: ctx.env.mode, meta: ctx.meta.kind, voice: ctx.voice.kind });
    return;
  }

  if (route === 'POST /webhooks/meta') {
    const body = await readBody(req);
    const signature = header(req, 'x-hub-signature-256');
    if (!verifySignature(body, signature, ctx.env.meta.appSecret)) {
      json(res, 401, { error: 'bad signature' });
      return;
    }
    const payload = JSON.parse(body) as MetaWebhookBody;
    const results: unknown[] = [];
    for (const entry of payload.entry ?? []) {
      for (const change of entry.changes ?? []) {
        if (change.field !== 'leadgen') continue;
        results.push(await acceptLead(ctx, change.value));
      }
    }
    json(res, 200, { received: results.length, results });
    return;
  }

  if (route === 'POST /webhooks/omnidimension') {
    const body = await readBody(req);
    // HMAC is preferred. The static token exists because a voice platform that
    // can only attach a fixed header would otherwise be unable to authenticate
    // at all, and this endpoint records revenue and suppresses numbers. With
    // neither configured it fails closed.
    const signature = header(req, 'x-omni-signature') || header(req, 'x-signature');
    const bearer = header(req, 'authorization').replace(/^Bearer\s+/i, '') || header(req, 'x-webhook-token');
    const authorized =
      verifySignature(body, signature, ctx.env.omni.webhookSecret) ||
      verifyToken(bearer, ctx.env.omni.webhookToken);
    if (!authorized) {
      json(res, 401, { error: 'bad signature or token' });
      return;
    }
    const result = handleCallWebhook(ctx.store, JSON.parse(body));
    json(res, result.status === 'recorded' ? 200 : 202, result);
    return;
  }

  // Local/manual lead submission - useful for testing the loop without Meta.
  // Gated on an admin token: this route places phone calls.
  if (route === 'POST /leads') {
    if (!authorized(ctx, req)) {
      json(res, 403, { error: 'set FL_ADMIN_TOKEN and send it as x-fl-admin-token' });
      return;
    }
    const body = await readBody(req);
    const payload = JSON.parse(body) as { runId?: string } & Record<string, unknown>;
    const runId = payload.runId ?? ctx.store.latestRun();
    if (!runId) {
      json(res, 400, { error: 'no run to attach this lead to' });
      return;
    }
    json(res, 200, await acceptLead(ctx, payload, runId));
    return;
  }

  if (route === 'POST /revenue') {
    if (!authorized(ctx, req)) {
      json(res, 403, { error: 'set FL_ADMIN_TOKEN and send it as x-fl-admin-token' });
      return;
    }
    const body = await readBody(req);
    const payload = JSON.parse(body) as { leadId: string; amountMinor: number; source?: string };
    const ok = recordExternalRevenue(ctx.store, payload.leadId, payload.amountMinor, payload.source ?? 'manual');
    json(res, ok ? 200 : 404, { ok });
    return;
  }

  if (route === 'GET /runs') {
    json(res, 200, { runs: ctx.store.listRuns() });
    return;
  }

  if (req.method === 'GET' && url.pathname.startsWith('/runs/')) {
    const runId = url.pathname.split('/')[2]!;
    const brief = ctx.store.getBrief(runId);
    if (!brief) {
      json(res, 404, { error: `unknown run ${runId}` });
      return;
    }
    json(res, 200, {
      run: ctx.store.getRun(runId),
      economics: economicsForRun(ctx.store, runId),
      recommendation: evaluate(ctx.store, ctx.guardrails, runId, brief),
      pendingApprovals: ctx.store.pendingApprovals(runId),
    });
    return;
  }

  json(res, 404, { error: `no route for ${route}` });
}

interface MetaWebhookBody {
  entry?: Array<{ changes?: Array<{ field: string; value: Record<string, unknown> }> }>;
}

/** Intake + immediate dispatch. Speed to first call is the whole ballgame. */
async function acceptLead(ctx: Context, value: Record<string, unknown>, explicitRunId?: string) {
  const runId = explicitRunId ?? (value.run_id as string | undefined) ?? ctx.store.latestRun();
  if (!runId) return { status: 'rejected', reason: 'no active run' };

  // Meta's leadgen webhook carries a leadgen_id and the ad identifiers, not the
  // answers - those are a second, authenticated call. That is also what keeps a
  // forged webhook from injecting a lead: the values come from Meta, not from
  // the request body. `field_data` inline is accepted too, because the Lead Ads
  // Testing Tool and manual posts send it that way.
  let source = value;
  if (!value.field_data && typeof value.leadgen_id === 'string') {
    try {
      const retrieved = await ctx.meta.fetchLead(value.leadgen_id);
      source = {
        field_data: retrieved.fieldData,
        ad_id: retrieved.adId ?? value.ad_id,
        adset_id: retrieved.adsetId ?? value.adgroup_id,
        campaign_id: retrieved.campaignId,
      } as Record<string, unknown>;
    } catch (err) {
      ctx.store.audit(runId, 'meta', 'lead.retrieval_failed', {
        leadgenId: value.leadgen_id,
        error: (err as Error).message,
      });
      return { status: 'rejected', reason: `could not retrieve lead ${value.leadgen_id}: ${(err as Error).message}` };
    }
  }

  const raw = source.field_data ? fromMetaLeadgen(source as never) : (source as never);
  const intake = intakeLead(ctx.store, ctx.guardrails, runId, raw);
  if (intake.status !== 'accepted') return intake;

  const brief = ctx.store.getBrief(runId);
  if (!brief) return { status: 'rejected', reason: `run ${runId} has no brief` };

  const dispatch = await dispatchLead(
    ctx.store,
    ctx.voice,
    ctx.guardrails,
    intake.lead,
    brief,
    voiceWebhookUrl(ctx.env),
    ctx.meta.kind === 'mock' && intake.lead.adId
      ? { creative_quality: (ctx.meta as MockMetaProvider).quality(intake.lead.adId).toFixed(3) }
      : {},
  );

  // In mock mode nobody is going to POST a real post-call webhook, so the
  // simulated agent posts its own result back through the same handler the real
  // provider would use. This branch does not exist in live mode.
  if (ctx.voice.kind === 'mock' && dispatch.status === 'dispatched') {
    const outcome = (ctx.voice as MockVoiceProvider).simulateOutcome(dispatch.callRef);
    handleCallWebhook(ctx.store, {
      call_id: outcome.callId,
      lead_id: outcome.leadId,
      connected: outcome.connected,
      qualified: outcome.qualified,
      intent_score: outcome.intentScore,
      objection: outcome.objection,
      appointment_booked: outcome.appointmentBooked,
      sale_status: outcome.saleStatus,
      expected_value: outcome.expectedValueMinor / 100,
      next_action: outcome.nextAction,
      summary: outcome.summary,
      opt_out: outcome.optOut,
    });
  }

  return {
    status: intake.status,
    leadId: intake.lead.leadId,
    phone: maskPhone(intake.lead.phoneE164),
    dispatch,
  };
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > 1_000_000) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/**
 * Admin routes are closed unless FL_ADMIN_TOKEN is set and matches. An unset
 * token fails closed: these routes can dial a stranger and move revenue.
 */
function authorized(ctx: Context, req: IncomingMessage): boolean {
  const expected = process.env.FL_ADMIN_TOKEN ?? '';
  if (!expected) return false;
  const provided = header(req, 'x-fl-admin-token');
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
}

function header(req: IncomingMessage, name: string): string {
  const value = req.headers[name];
  return Array.isArray(value) ? (value[0] ?? '') : (value ?? '');
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) });
  res.end(payload);
}

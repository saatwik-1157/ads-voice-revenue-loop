import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import type { Context } from '../orchestrator.ts';
import { voiceWebhookUrl } from '../orchestrator.ts';
import { fromMetaLeadgen, intakeLead } from '../pipeline/intake.ts';
import type { RawLead } from '../pipeline/intake.ts';
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

/**
 * A request this server refuses, as opposed to one it failed to handle.
 *
 * The distinction is not cosmetic. Meta and OmniDimension both retry on 5xx,
 * so answering a permanently malformed payload with 500 asks the sender to
 * redeliver something that can never succeed - forever, on their schedule.
 * Anything caused by the request gets a 4xx and stays delivered.
 */
export class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}

export function createHttpServer(ctx: Context) {
  return createServer((req, res) => {
    handle(ctx, req, res).catch((err: unknown) => {
      if (err instanceof HttpError) {
        ctx.store.audit(null, 'system', 'http.rejected', {
          url: req.url,
          status: err.status,
          error: err.message,
        });
        json(res, err.status, { error: err.message });
        return;
      }
      ctx.store.audit(null, 'system', 'http.error', { url: req.url, error: (err as Error).message });
      json(res, 500, { error: 'internal error' });
    });
  });
}

/**
 * Parse a request body, or refuse the request.
 *
 * Also rejects the JSON values that are legal but not objects - `null`, `42`,
 * `[]` - because every route here goes on to read properties off the result,
 * and `null.entry` is a 500 for what is really a bad request.
 */
function parseJson(body: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (err) {
    throw new HttpError(400, `body is not valid JSON: ${(err as Error).message}`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new HttpError(400, 'body must be a JSON object');
  }
  return parsed as Record<string, unknown>;
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
    const payload = parseJson(body) as MetaWebhookBody;
    const results: unknown[] = [];
    // `entry` typed as anything but an array used to reach for..of and throw a
    // TypeError, which came back as 500 - and 500 is what Meta retries on.
    for (const entry of Array.isArray(payload.entry) ? payload.entry : []) {
      const changes = Array.isArray(entry?.changes) ? entry.changes : [];
      for (const change of changes) {
        if (change?.field !== 'leadgen' || !change.value || typeof change.value !== 'object') continue;
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
    const result = handleCallWebhook(ctx.store, parseJson(body));
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
    const payload = parseJson(body) as { runId?: string } & Record<string, unknown>;
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
    const payload = parseJson(body) as { leadId?: unknown; amountMinor?: unknown; source?: unknown };

    // Revenue is the number every KEEP/KILL/SCALE decision is made from, so it
    // is the worst field in the system to take on trust. This used to write
    // whatever arrived: a string, a negative, 1e308. A poisoned figure here
    // does not throw - it makes the engine scale a losing campaign.
    const leadId = payload.leadId;
    if (typeof leadId !== 'string' || !leadId) throw new HttpError(400, 'leadId must be a non-empty string');
    const amountMinor = payload.amountMinor;
    if (typeof amountMinor !== 'number' || !Number.isSafeInteger(amountMinor) || amountMinor < 0) {
      throw new HttpError(400, `amountMinor must be a whole number of minor units, 0 or more, got ${JSON.stringify(amountMinor)}`);
    }
    const source = payload.source === undefined ? 'manual' : payload.source;
    if (typeof source !== 'string') throw new HttpError(400, 'source must be a string');

    const ok = recordExternalRevenue(ctx.store, leadId, amountMinor, source);
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

/** Meta's leadgen payloads are small; anything near this is not one of them. */
const MAX_BODY_BYTES = 1_000_000;

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
      };
    } catch (err) {
      ctx.store.audit(runId, 'meta', 'lead.retrieval_failed', {
        leadgenId: value.leadgen_id,
        error: (err as Error).message,
      });
      return { status: 'rejected', reason: `could not retrieve lead ${value.leadgen_id}: ${(err as Error).message}` };
    }
  }

  const raw = source.field_data ? fromMetaLeadgen(source) : (source as RawLead);
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

/**
 * Read a request body, up to a limit, and answer even when it exceeds one.
 *
 * Killing the socket the moment the limit is passed looks tidy and is not: the
 * sender is still uploading, so it never reads the response and sees only a
 * reset connection - indistinguishable from this server falling over. So we
 * stop buffering, keep draining what is already in flight so the reply can be
 * read, and only cut the connection off if the sender keeps going well past
 * the point of making a point.
 */
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let overLimit = false;

    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        if (!overLimit) {
          overLimit = true;
          chunks.length = 0;
          reject(new HttpError(413, `request body exceeds ${MAX_BODY_BYTES} bytes`));
        }
        // Past this much, the sender is not going to stop on its own.
        if (size > MAX_BODY_BYTES * 10) req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      if (!overLimit) resolve(Buffer.concat(chunks).toString('utf8'));
    });
    // A reset while we are already refusing the request is the expected
    // ending, not a second failure to report.
    req.on('error', (err) => {
      if (!overLimit) reject(err);
    });
  });
}

/**
 * Admin routes are closed unless FL_ADMIN_TOKEN is set and matches. An unset
 * token fails closed: these routes can dial a stranger and move revenue.
 */
function authorized(ctx: Context, req: IncomingMessage): boolean {
  const expected = Buffer.from(process.env.FL_ADMIN_TOKEN ?? '', 'utf8');
  if (expected.length === 0) return false;
  // Compare bytes, not UTF-16 units. `"probé".length` is 5 like `"probe"`, but
  // the buffers differ in length and timingSafeEqual throws on that - turning
  // a wrong token into a 500 instead of a refusal.
  const provided = Buffer.from(header(req, 'x-fl-admin-token'), 'utf8');
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(provided, expected);
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

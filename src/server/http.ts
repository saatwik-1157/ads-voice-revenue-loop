import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { identify, permits, refusalFor, type Role } from './access.ts';
import { RateLimiter, RATE_LIMITS } from './ratelimit.ts';
import { log } from '../core/log.ts';
import { id } from '../core/util.ts';
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

/**
 * The address to rate-limit an anonymous caller by.
 *
 * Only reads X-Forwarded-For when FL_TRUST_PROXY is set, and takes the
 * left-most entry, which is the originating client as every proxy in the chain
 * appends. With no proxy configured the header is ignored entirely, because
 * anything a client can set is not an identity.
 */
export function clientAddress(req: IncomingMessage): string | undefined {
  if (process.env.FL_TRUST_PROXY === 'true') {
    const forwarded = req.headers['x-forwarded-for'];
    const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(',')[0]?.trim();
    if (first) return first;
  }
  return req.socket.remoteAddress ?? undefined;
}

export function createHttpServer(ctx: Context) {
  // One limiter per server, so tests and separate instances do not share state.
  const limiter = new RateLimiter();
  return createServer((req, res) => {
    const started = process.hrtime.bigint();
    const requestId = id('req');
    // The id goes back on the response too, so a caller reporting a problem and
    // the line in the log can be joined without guessing from timestamps.
    res.setHeader('x-request-id', requestId);

    res.on('finish', () => {
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';
      log[level]('http.request', {
        requestId,
        method: req.method,
        // The path only. A query string is where an id or a token ends up
        // pasted by somebody debugging, and it is not worth the risk.
        path: new URL(req.url ?? '/', 'http://localhost').pathname,
        status: res.statusCode,
        durationMs: Math.round(ms * 10) / 10,
      });
    });

    handle(ctx, req, res, limiter).catch((err: unknown) => {
      if (err instanceof HttpError) {
        ctx.store.audit(null, 'system', 'http.rejected', {
          url: req.url,
          status: err.status,
          error: err.message,
        });
        log.warn('http.rejected', { requestId, status: err.status, error: err.message });
        json(res, err.status, { error: err.message });
        return;
      }
      ctx.store.audit(null, 'system', 'http.error', { url: req.url, error: (err as Error).message });
      // The stack goes to the log, never to the caller: it names internal paths.
      log.error('http.error', { requestId, error: err as Error });
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

async function handle(
  ctx: Context,
  req: IncomingMessage,
  res: ServerResponse,
  limiter: RateLimiter,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const route = `${req.method} ${url.pathname}`;

  const who = identify(req);
  // Behind the shipped Caddy the socket address is always the proxy's, so every
  // anonymous caller on the internet shared one bucket - and one flood could
  // starve the genuine Meta and OmniDimension deliveries that carry leads,
  // revenue and opt-outs.
  //
  // X-Forwarded-For is only trusted when FL_TRUST_PROXY says a proxy is in
  // front. Trusting it unconditionally would be worse than the bug: any caller
  // could then pick their own bucket, or someone else's, by setting a header.
  const caller = who ? `${who.role}` : (clientAddress(req) ?? 'unknown');

  /**
   * Refuse if this caller is asking too often. Keyed on identity when there is
   * one and on address when there is not, so one noisy anonymous client cannot
   * spend an authenticated operator's budget.
   */
  const limited = (kind: keyof typeof RATE_LIMITS): boolean => {
    const decision = limiter.check(`${kind}:${caller}`, RATE_LIMITS[kind]!);
    if (decision.allowed) return false;
    res.setHeader('Retry-After', String(decision.retryAfterSeconds));
    json(res, 429, { error: 'too many requests', retryAfterSeconds: decision.retryAfterSeconds });
    return true;
  };

  /** Everything that is not a webhook or a liveness probe needs a principal. */
  const requires = (role: Role): boolean => {
    if (permits(who, role)) return false;
    if (limited('unauthenticated')) return true;
    const refusal = refusalFor(role);
    ctx.store.audit(null, 'system', 'http.unauthorized', { url: req.url, role, caller });
    json(res, refusal.status, refusal.body);
    return true;
  };

  // Meta webhook subscription handshake.
  if (route === 'GET /webhooks/meta') {
    // This sat above every limiter call, so the one route Meta hits without a
    // signature had no rate limit at all.
    if (limited('webhook')) return;
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

  // Liveness: is this process running at all. Deliberately says nothing about
  // whether it is doing anything useful, and needs no credentials, because a
  // load balancer has none. It answers 200 as long as the event loop turns.
  if (route === 'GET /health' || route === 'GET /health/live') {
    json(res, 200, { ok: true, mode: ctx.env.mode });
    return;
  }

  // Readiness: should traffic be sent here. This one is allowed to fail, which
  // is the whole point - the previous /health returned a static ok and could
  // not report a problem, making it useless as a signal.
  if (route === 'GET /health/ready') {
    const checks: Record<string, { ok: boolean; detail?: string }> = {};

    // The database is the only hard dependency. A failed read here is fatal.
    try {
      ctx.store.db.prepare('SELECT 1').get();
      // A query succeeding is not enough. If the file was deleted out from
      // under this process - `reset` while `serve` is running - every read and
      // write still works against the held inode, and all of it is discarded
      // when the process exits. Reporting healthy through that is worse than
      // failing, because nothing else will notice either.
      checks.database = ctx.store.fileMissing()
        ? // No path in the body: /health/ready is open, and an absolute
          // filesystem path is free reconnaissance. The log line has it.
          { ok: false, detail: 'the database file no longer exists; restart this process' }
        : { ok: true };
    } catch (err) {
      checks.database = { ok: false, detail: (err as Error).message.slice(0, 200) };
    }

    // Recent webhook failures mean revenue and opt-outs may not be landing.
    const since = new Date(Date.now() - 15 * 60_000).toISOString();
    const failures = ctx.store.webhookFailuresSince(since);
    checks.webhooks = failures >= 5 ? { ok: false, detail: `${failures} failures in 15 minutes` } : { ok: true };

    // A stopped autopilot is not unhealthy - it is a deliberate state - but it
    // is the first thing anyone looking at this page needs to know.
    const stop = ctx.store.emergencyStop();

    const ready = Object.values(checks).every((c) => c.ok);
    json(res, ready ? 200 : 503, {
      ready,
      mode: ctx.env.mode,
      providers: { meta: ctx.meta.kind, voice: ctx.voice.kind },
      autopilot: stop.engaged ? { state: 'paused', trigger: stop.trigger, reason: stop.reason } : { state: 'active' },
      checks,
    });
    return;
  }

  if (route === 'POST /webhooks/meta') {
    if (limited('webhook')) return;
    const body = await readBody(req);
    const signature = header(req, 'x-hub-signature-256');
    if (!verifySignature(body, signature, ctx.env.meta.appSecret)) {
      // Recorded too: repeated signature failures are how a misconfigured
      // secret and a forged delivery both look from here.
      const rejected = ctx.store.recordWebhookEvent({
        provider: 'meta',
        providerEventId: null,
        payloadHash: hashBody(body),
        signatureVerified: false,
      });
      ctx.store.finishWebhookEvent(rejected.eventId, 'failed', 'signature verification failed');
      json(res, 401, { error: 'bad signature' });
      return;
    }
    const payload = parseJson(body) as MetaWebhookBody;

    // Recorded before it is acted on, so a handler that throws still leaves a
    // row saying what arrived. Meta does not put a delivery id in the body, so
    // the payload hash is the dedupe key.
    const delivery = ctx.store.recordWebhookEvent({
      provider: 'meta',
      providerEventId: null,
      payloadHash: hashBody(body),
      signatureVerified: true,
    });
    if (delivery.duplicate) {
      // Answer 200 so Meta stops redelivering; doing the work twice is what we
      // are avoiding, not acknowledging it.
      json(res, 200, { received: 0, duplicate: true, eventId: delivery.eventId });
      return;
    }

    try {
      const results: unknown[] = [];
      // `entry` typed as anything but an array used to reach for..of and throw
      // a TypeError, which came back as 500 - and 500 is what Meta retries on.
      for (const entry of Array.isArray(payload.entry) ? payload.entry : []) {
        const changes = Array.isArray(entry?.changes) ? entry.changes : [];
        for (const change of changes) {
          if (change?.field !== 'leadgen' || !change.value || typeof change.value !== 'object') continue;
          results.push(await acceptLead(ctx, change.value));
        }
      }
      ctx.store.finishWebhookEvent(delivery.eventId, results.length ? 'processed' : 'ignored');
      json(res, 200, { received: results.length, results, eventId: delivery.eventId });
    } catch (err) {
      ctx.store.finishWebhookEvent(delivery.eventId, 'failed', (err as Error).message.slice(0, 500));
      throw err;
    }
    return;
  }

  if (route === 'POST /webhooks/omnidimension') {
    if (limited('webhook')) return;
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
    const payload = parseJson(body);
    const delivery = ctx.store.recordWebhookEvent({
      provider: 'omnidimension',
      // The provider's own call id when it sends one - two deliveries about the
      // same call are the same event even if the bodies differ slightly.
      providerEventId: typeof payload.call_id === 'string' && payload.call_id ? payload.call_id : null,
      payloadHash: hashBody(body),
      signatureVerified: true,
    });
    if (delivery.duplicate) {
      json(res, 200, { status: 'duplicate', eventId: delivery.eventId });
      return;
    }

    try {
      const result = handleCallWebhook(ctx.store, payload);
      ctx.store.finishWebhookEvent(
        delivery.eventId,
        result.status === 'recorded' ? 'processed' : 'ignored',
        result.status === 'ignored' ? result.reason : undefined,
      );
      json(res, result.status === 'recorded' ? 200 : 202, { ...result, eventId: delivery.eventId });
    } catch (err) {
      ctx.store.finishWebhookEvent(delivery.eventId, 'failed', (err as Error).message.slice(0, 500));
      throw err;
    }
    return;
  }

  // Local/manual lead submission - useful for testing the loop without Meta.
  // Gated on an admin token: this route places phone calls.
  if (route === 'POST /leads') {
    if (requires('admin')) return;
    if (limited('write')) return;
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
    if (requires('admin')) return;
    if (limited('write')) return;
    const body = await readBody(req);
    const payload = parseJson(body) as {
      leadId?: unknown;
      amountMinor?: unknown;
      source?: unknown;
      eventId?: unknown;
    };

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

    // Identifies the sale, so a retry is the same sale and a second sale is a
    // second one. Optional, and absent means the body itself: posting an
    // identical body twice records once, while a different amount records
    // separately. Supply one explicitly if your system has an invoice id.
    const eventId = payload.eventId === undefined ? hashBody(body) : payload.eventId;
    if (typeof eventId !== 'string' || !eventId) throw new HttpError(400, 'eventId must be a non-empty string');

    const ok = recordExternalRevenue(ctx.store, leadId, amountMinor, source, eventId);
    json(res, ok ? 200 : 404, { ok });
    return;
  }

  if (route === 'GET /runs') {
    if (requires('viewer')) return;
    if (limited('read')) return;
    json(res, 200, { runs: ctx.store.listRuns() });
    return;
  }

  if (req.method === 'GET' && url.pathname.startsWith('/runs/')) {
    if (requires('viewer')) return;
    if (limited('read')) return;
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

/** Identifies a delivery without keeping a second copy of someone's phone number. */
function hashBody(body: string): string {
  return createHash('sha256').update(body, 'utf8').digest('hex');
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
  // Meta's own id for this lead, when the delivery carried one. It is the
  // identifier Meta dedupes on, and it survives a retry that changes or drops
  // anything else - which the previous key, built from the ad id and the
  // current hour, did not.
  if (typeof value.leadgen_id === 'string' && value.leadgen_id) raw.providerLeadId = value.leadgen_id;
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

function header(req: IncomingMessage, name: string): string {
  const value = req.headers[name];
  return Array.isArray(value) ? (value[0] ?? '') : (value ?? '');
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) });
  res.end(payload);
}

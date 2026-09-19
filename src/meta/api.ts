import type { AccountSummary, AdInsight, MetaProvider, RetrievedLead } from './provider.ts';
import { MetaApiError } from './provider.ts';
import type { CreativeVariant } from '../core/types.ts';
import { redact } from '../core/util.ts';
import { parseRetryAfter, withRetry, type RetryOptions } from '../core/retry.ts';
import { log } from '../core/log.ts';

/**
 * Meta Marketing API client - the authorized interface.
 *
 * Every write carries a client-side idempotency key so a retried request cannot
 * create a second campaign. The access token is only ever sent in the request
 * body/query to graph.facebook.com and is redacted from anything we log.
 */
export class MetaApiProvider implements MetaProvider {
  readonly kind = 'meta' as const;
  readonly #token: string;
  readonly #accountId: string;
  readonly #version: string;
  readonly #retry: RetryOptions;
  readonly #fetch: typeof fetch;

  constructor(opts: {
    accessToken: string;
    adAccountId: string;
    apiVersion: string;
    retry?: RetryOptions;
    fetchImpl?: typeof fetch;
  }) {
    if (!opts.accessToken) throw new Error('MetaApiProvider requires an access token');
    if (!/^act_\d+$/.test(opts.adAccountId)) {
      throw new Error(`META_AD_ACCOUNT_ID must look like "act_1234567890", got "${opts.adAccountId}"`);
    }
    this.#token = opts.accessToken;
    this.#accountId = opts.adAccountId;
    this.#version = opts.apiVersion;
    this.#fetch = opts.fetchImpl ?? fetch;
    this.#retry = {
      onRetry: (info) => {
        process.stderr.write(
          `[meta] ${info.operation} failed (${info.error.message.slice(0, 120)}); retry ${info.attempt}/${info.attempts - 1} in ${info.delayMs}ms\n`,
        );
      },
      ...opts.retry,
    };
  }

  /** One HTTP round trip, normalized into a MetaApiError that knows if it is transient. */
  async #send(url: string | URL, init: RequestInit): Promise<string> {
    // Latency is logged whatever happens. A provider that has become slow but
    // has not yet started failing is the state worth seeing early, and it is
    // invisible if only errors are recorded.
    const started = process.hrtime.bigint();
    const path = new URL(String(url)).pathname;
    const elapsed = (): number => Math.round(Number(process.hrtime.bigint() - started) / 1e5) / 10;

    let res: Response;
    try {
      res = await this.#fetch(url, init);
    } catch (err) {
      // DNS failure, connection reset, TLS error - no response at all.
      log.error('provider.request', {
        provider: 'meta',
        path,
        status: 0,
        durationMs: elapsed(),
        error: (err as Error).message,
      });
      throw new MetaApiError(0, (err as Error).message, { cause: err });
    }
    const text = await res.text();
    log[res.ok ? 'info' : 'warn']('provider.request', {
      provider: 'meta',
      path,
      status: res.status,
      durationMs: elapsed(),
    });
    if (!res.ok) {
      throw new MetaApiError(res.status, redact(text), {
        retryAfterMs: parseRetryAfter(res.headers.get('retry-after')),
      });
    }
    return text;
  }

  async #post(path: string, body: Record<string, unknown>, idempotencyKey?: string): Promise<Record<string, string>> {
    const url = `https://graph.facebook.com/${this.#version}/${path}`;
    const form = new URLSearchParams();
    for (const [key, value] of Object.entries(body)) {
      if (value === undefined || value === null) continue;
      form.set(key, typeof value === 'string' ? value : JSON.stringify(value));
    }
    const headers: Record<string, string> = {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Bearer ${this.#token}`,
    };
    // Meta honours this header on ad-object creation endpoints. It is what makes
    // the retry below safe: a replayed create returns the original object rather
    // than making a second campaign.
    if (idempotencyKey) headers['X-Business-Idempotency-Key'] = idempotencyKey;

    const text = await withRetry(
      `POST ${path}`,
      () => this.#send(url, { method: 'POST', headers, body: form }),
      this.#retry,
    );
    return JSON.parse(text) as Record<string, string>;
  }

  async #get(path: string, params: Record<string, string>): Promise<Record<string, unknown>> {
    const url = new URL(`https://graph.facebook.com/${this.#version}/${path}`);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    const text = await withRetry(
      `GET ${path}`,
      () => this.#send(url, { headers: { Authorization: `Bearer ${this.#token}` } }),
      this.#retry,
    );
    return JSON.parse(text) as Record<string, unknown>;
  }

  async createCampaign(input: {
    name: string;
    objective: string;
    specialAdCategories: string[];
    idempotencyKey: string;
  }): Promise<{ campaignId: string }> {
    const res = await this.#post(
      `${this.#accountId}/campaigns`,
      {
        name: input.name,
        objective: input.objective,
        // Always created paused. Going live is a separate, explicit step.
        status: 'PAUSED',
        special_ad_categories: input.specialAdCategories,
      },
      input.idempotencyKey,
    );
    return { campaignId: res.id! };
  }

  async createAdSet(input: {
    name: string;
    campaignId: string;
    dailyBudgetMinor: number;
    geos: string[];
    pageId: string;
    startTime: string;
    endTime: string;
    idempotencyKey: string;
  }): Promise<{ adsetId: string }> {
    const res = await this.#post(
      `${this.#accountId}/adsets`,
      {
        name: input.name,
        campaign_id: input.campaignId,
        daily_budget: String(input.dailyBudgetMinor),
        billing_event: 'IMPRESSIONS',
        optimization_goal: 'LEAD_GENERATION',
        destination_type: 'ON_AD',
        promoted_object: { page_id: input.pageId },
        targeting: { geo_locations: { countries: input.geos } },
        start_time: input.startTime,
        end_time: input.endTime,
        status: 'PAUSED',
      },
      input.idempotencyKey,
    );
    return { adsetId: res.id! };
  }

  async createAdCreative(input: {
    name: string;
    pageId: string;
    variant: CreativeVariant;
    leadFormId: string | null;
    idempotencyKey: string;
  }): Promise<{ creativeId: string }> {
    if (!input.variant.assetRef) {
      throw new Error(
        `creative ${input.variant.creativeId} has no assetRef; upload the image/video hash before publishing`,
      );
    }
    const linkData: Record<string, unknown> = {
      message: input.variant.primaryText,
      name: input.variant.headline,
      description: input.variant.description,
      image_hash: input.variant.assetRef,
      link: `https://facebook.com/${input.pageId}`,
      call_to_action: input.leadFormId
        ? { type: 'SIGN_UP', value: { lead_gen_form_id: input.leadFormId } }
        : { type: 'LEARN_MORE' },
    };
    const res = await this.#post(
      `${this.#accountId}/adcreatives`,
      {
        name: input.name,
        object_story_spec: { page_id: input.pageId, link_data: linkData },
      },
      input.idempotencyKey,
    );
    return { creativeId: res.id! };
  }

  async uploadImage(input: {
    bytes: Buffer;
    filename: string;
    contentType: string;
    idempotencyKey: string;
  }): Promise<{ imageHash: string }> {
    // adimages is multipart, not form-urlencoded, and the response keys the
    // result by the field name we send the bytes under.
    const form = new FormData();
    form.set(input.filename, new Blob([new Uint8Array(input.bytes)], { type: input.contentType }), input.filename);

    const text = await withRetry(
      'POST adimages',
      () =>
        this.#send(`https://graph.facebook.com/${this.#version}/${this.#accountId}/adimages`, {
          method: 'POST',
          // No Content-Type here on purpose: fetch sets the multipart boundary.
          headers: {
            Authorization: `Bearer ${this.#token}`,
            'X-Business-Idempotency-Key': input.idempotencyKey,
          },
          body: form,
        }),
      this.#retry,
    );

    const parsed = JSON.parse(text) as { images?: Record<string, { hash?: string }> };
    const entry = parsed.images?.[input.filename] ?? Object.values(parsed.images ?? {})[0];
    if (!entry?.hash) {
      throw new MetaApiError(422, `adimages response carried no hash: ${redact(text)}`);
    }
    return { imageHash: entry.hash };
  }

  async createAd(input: {
    name: string;
    adsetId: string;
    creativeId: string;
    idempotencyKey: string;
  }): Promise<{ adId: string }> {
    const res = await this.#post(
      `${this.#accountId}/ads`,
      {
        name: input.name,
        adset_id: input.adsetId,
        creative: { creative_id: input.creativeId },
        status: 'PAUSED',
      },
      input.idempotencyKey,
    );
    return { adId: res.id! };
  }

  async setStatus(objectId: string, status: 'ACTIVE' | 'PAUSED'): Promise<void> {
    await this.#post(objectId, { status });
  }

  async setDailyBudget(adsetId: string, dailyBudgetMinor: number): Promise<void> {
    await this.#post(adsetId, { daily_budget: String(dailyBudgetMinor) });
  }

  async fetchLead(leadgenId: string): Promise<RetrievedLead> {
    // Needs the leads_retrieval permission on a Page access token.
    const res = (await this.#get(leadgenId, {
      fields: 'id,created_time,field_data,ad_id,adset_id,campaign_id,form_id',
    }));

    return {
      leadgenId: typeof res.id === 'string' ? res.id : leadgenId,
      fieldData: (res.field_data as Array<{ name: string; values: string[] }> | undefined) ?? [],
      adId: (res.ad_id as string | undefined) ?? null,
      adsetId: (res.adset_id as string | undefined) ?? null,
      campaignId: (res.campaign_id as string | undefined) ?? null,
      formId: (res.form_id as string | undefined) ?? null,
      createdTime: (res.created_time as string | undefined) ?? null,
    };
  }

  async accountSummary(): Promise<AccountSummary> {
    const res = await this.#get(this.#accountId, {
      fields: 'name,currency,account_status,timezone_name,disable_reason',
    });
    const currency = typeof res.currency === 'string' ? res.currency : '';
    if (!currency) {
      // Without it there is no way to know what unit a budget is in, and
      // guessing is how a 1,000 rupee cap becomes a 1,000 dollar campaign.
      throw new MetaApiError(0, `ad account ${this.#accountId} reported no currency; budgets cannot be verified against it`);
    }
    return {
      accountId: this.#accountId,
      name: (res.name as string | undefined) ?? null,
      currency,
      status: typeof res.account_status === 'number' ? res.account_status : null,
      timezone: (res.timezone_name as string | undefined) ?? null,
      disableReason: typeof res.disable_reason === 'number' ? res.disable_reason : null,
    };
  }

  async insights(adIds: string[]): Promise<AdInsight[]> {
    const out: AdInsight[] = [];
    for (const adId of adIds) {
      const res = (await this.#get(`${adId}/insights`, {
        fields: 'spend,impressions,clicks,actions',
        date_preset: 'maximum',
      })) as { data?: Array<Record<string, unknown>> };
      const row = res.data?.[0];
      if (!row) {
        out.push({ adId, spendMinor: 0, impressions: 0, clicks: 0, leads: 0 });
        continue;
      }
      const rawActions = row.actions;
      const actions = Array.isArray(rawActions) ? (rawActions as Array<{ action_type?: string; value?: unknown }>) : [];
      const leadAction = actions.find(
        (a) => a?.action_type === 'lead' || a?.action_type === 'onsite_conversion.lead_grouped',
      );
      out.push({
        adId,
        // Meta reports spend as a decimal string in the account currency. The
        // account is verified to be a 1/100 currency before anything publishes.
        spendMinor: Math.round(count(row.spend, `spend for ${adId}`) * 100),
        impressions: count(row.impressions, `impressions for ${adId}`),
        clicks: count(row.clicks, `clicks for ${adId}`),
        leads: count(leadAction?.value, `lead actions for ${adId}`),
      });
    }
    return out;
  }
}

/**
 * A number from an API response, or a refusal.
 *
 * `Number(undefined)` is NaN, and NaN spent a happy life downstream: it is not
 * zero, every comparison against it is false, and Math.round keeps it. One
 * missing field in one insights row would have turned CPL, ROAS and the
 * stop-loss into NaN and made every threshold in the decision engine read as
 * unmet. An absent field is zero; a malformed one is an error.
 */
function count(value: unknown, what: string): number {
  if (value === undefined || value === null || value === '') return 0;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) {
    throw new MetaApiError(0, `Meta returned ${JSON.stringify(value)} for ${what}; refusing to treat that as a number`);
  }
  return n;
}

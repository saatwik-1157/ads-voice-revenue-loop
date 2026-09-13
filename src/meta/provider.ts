import type { CreativeVariant } from '../core/types.ts';
import { isRetryableStatus } from '../core/retry.ts';

/**
 * The only surface the orchestrator is allowed to touch Meta through.
 *
 * Two implementations exist: the official Marketing API client and a mock that
 * simulates delivery locally. There is deliberately no third option - this
 * system never drives Ads Manager through a browser, scrapes it, or mimics its
 * UI, and no code path here should ever make that possible.
 */
export interface MetaProvider {
  readonly kind: 'meta' | 'mock';

  createCampaign(input: {
    name: string;
    objective: string;
    specialAdCategories: string[];
    idempotencyKey: string;
  }): Promise<{ campaignId: string }>;

  createAdSet(input: {
    name: string;
    campaignId: string;
    dailyBudgetMinor: number;
    geos: string[];
    pageId: string;
    startTime: string;
    endTime: string;
    idempotencyKey: string;
  }): Promise<{ adsetId: string }>;

  createAdCreative(input: {
    name: string;
    pageId: string;
    variant: CreativeVariant;
    leadFormId: string | null;
    idempotencyKey: string;
  }): Promise<{ creativeId: string }>;

  /**
   * Upload an image and return the hash an ad creative refers to. Meta stores
   * the image against the ad account; the hash is what `createAdCreative` uses.
   */
  uploadImage(input: {
    bytes: Buffer;
    filename: string;
    contentType: string;
    idempotencyKey: string;
  }): Promise<{ imageHash: string }>;

  createAd(input: {
    name: string;
    adsetId: string;
    creativeId: string;
    idempotencyKey: string;
  }): Promise<{ adId: string }>;

  setStatus(objectId: string, status: 'ACTIVE' | 'PAUSED'): Promise<void>;

  setDailyBudget(adsetId: string, dailyBudgetMinor: number): Promise<void>;

  /** Cumulative insights per ad since the campaign started. */
  insights(adIds: string[]): Promise<AdInsight[]>;

  /**
   * Retrieve a lead by the id the leadgen webhook delivers.
   *
   * The webhook carries a `leadgen_id` and the ad identifiers - not the answers.
   * The field data is a second, authenticated call, which is also what stops a
   * forged webhook from injecting a lead: the values come from Meta, not from
   * the request body.
   */
  fetchLead(leadgenId: string): Promise<RetrievedLead>;
}

export interface RetrievedLead {
  leadgenId: string;
  fieldData: Array<{ name: string; values: string[] }>;
  adId: string | null;
  adsetId: string | null;
  campaignId: string | null;
  formId: string | null;
  createdTime: string | null;
}

export interface AdInsight {
  adId: string;
  spendMinor: number;
  impressions: number;
  clicks: number;
  leads: number;
}

export class MetaApiError extends Error {
  readonly status: number;
  readonly body: string;
  /** 429, 5xx and connection failures are worth another attempt; 4xx is not. */
  readonly retryable: boolean;
  readonly retryAfterMs: number | undefined;

  constructor(status: number, body: string, options: { retryAfterMs?: number; cause?: unknown } = {}) {
    super(status === 0 ? `Meta API unreachable: ${body.slice(0, 500)}` : `Meta API error ${status}: ${body.slice(0, 500)}`, {
      cause: options.cause,
    });
    this.name = 'MetaApiError';
    this.status = status;
    this.body = body;
    this.retryable = isRetryableStatus(status);
    this.retryAfterMs = options.retryAfterMs;
  }
}

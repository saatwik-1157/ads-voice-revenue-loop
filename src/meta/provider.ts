import type { CreativeVariant } from '../core/types.ts';

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
  constructor(status: number, body: string) {
    super(`Meta API error ${status}: ${body.slice(0, 500)}`);
    this.name = 'MetaApiError';
    this.status = status;
    this.body = body;
  }
}

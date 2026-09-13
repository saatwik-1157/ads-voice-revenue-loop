import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { AdInsight, MetaProvider } from './provider.ts';
import type { CreativeVariant } from '../core/types.ts';

interface MockState {
  seq: number;
  prng: number;
  ads: Record<string, { creativeId: string; status: 'ACTIVE' | 'PAUSED'; quality: number }>;
  adsets: Record<string, { dailyBudgetMinor: number; status: 'ACTIVE' | 'PAUSED'; adIds: string[] }>;
  acc: Record<string, { spendMinor: number; impressions: number; clicks: number; leads: number }>;
  images: Record<string, string>;
}

/**
 * Simulated ad delivery for FL_MODE=mock.
 *
 * It is not trying to model Meta's auction. It exists so the closed loop - the
 * part that actually matters - can be run, tested and demonstrated end to end
 * without spending money or touching a real ad account. Delivery is driven by a
 * seeded PRNG so a demo run is reproducible.
 */
export class MockMetaProvider implements MetaProvider {
  readonly kind = 'mock' as const;
  #state: MockState;
  #path: string | null;

  /**
   * `statePath` persists simulated delivery between processes, so a multi-step
   * CLI walkthrough (publish -> sync -> review) behaves like a real ad account
   * that keeps running while you are not looking at it.
   */
  constructor(seed = 42, statePath: string | null = null) {
    this.#path = statePath;
    this.#state = (statePath && existsSync(statePath)
      ? (JSON.parse(readFileSync(statePath, 'utf8')) as MockState)
      : { seq: 0, prng: seed >>> 0, ads: {}, adsets: {}, acc: {}, images: {} });
    this.#state.images ??= {};
  }

  #save(): void {
    if (!this.#path) return;
    mkdirSync(dirname(this.#path), { recursive: true });
    writeFileSync(this.#path, JSON.stringify(this.#state));
  }

  #rand(): number {
    const [value, next] = mulberry32Step(this.#state.prng);
    this.#state.prng = next;
    return value;
  }

  #id(prefix: string): string {
    this.#state.seq += 1;
    return `${prefix}${String(120000000000000 + this.#state.seq)}`;
  }

  async createCampaign(input: { name: string }): Promise<{ campaignId: string }> {
    const campaignId = this.#id('cmp_');
    this.#save();
    return { campaignId };
  }

  async createAdSet(input: { campaignId: string; dailyBudgetMinor: number }): Promise<{ adsetId: string }> {
    const adsetId = this.#id('ads_');
    this.#state.adsets[adsetId] = { dailyBudgetMinor: input.dailyBudgetMinor, status: 'PAUSED', adIds: [] };
    this.#save();
    return { adsetId };
  }

  async createAdCreative(input: { variant: CreativeVariant }): Promise<{ creativeId: string }> {
    const creativeId = this.#id('crt_');
    this.#save();
    return { creativeId };
  }

  async uploadImage(input: {
    bytes: Buffer;
    filename: string;
    contentType: string;
    idempotencyKey: string;
  }): Promise<{ imageHash: string }> {
    // Hash the bytes so identical artwork yields an identical hash, the way a
    // real ad account deduplicates uploads.
    const digest = createHash('sha256').update(input.bytes).digest('hex').slice(0, 32);
    this.#state.images[input.filename] = digest;
    this.#save();
    return { imageHash: digest };
  }

  async createAd(input: { adsetId: string; creativeId: string }): Promise<{ adId: string }> {
    const adId = this.#id('ad_');
    // Each ad gets a hidden "quality" - the thing the decision engine has to
    // discover from outcomes rather than be told.
    this.#state.ads[adId] = { creativeId: input.creativeId, status: 'PAUSED', quality: 0.4 + this.#rand() * 1.2 };
    this.#state.adsets[input.adsetId]?.adIds.push(adId);
    this.#save();
    return { adId };
  }

  async setStatus(objectId: string, status: 'ACTIVE' | 'PAUSED'): Promise<void> {
    const ad = this.#state.ads[objectId];
    if (ad) ad.status = status;
    const adset = this.#state.adsets[objectId];
    if (adset) {
      adset.status = status;
      // Pausing an ad set stops its ads; activating one releases them.
      for (const adId of adset.adIds) {
        const child = this.#state.ads[adId];
        if (child) child.status = status;
      }
    }
    this.#save();
  }

  async setDailyBudget(adsetId: string, dailyBudgetMinor: number): Promise<void> {
    const adset = this.#state.adsets[adsetId];
    if (adset) adset.dailyBudgetMinor = dailyBudgetMinor;
    this.#save();
  }

  /** Advance simulated delivery by one day for every active ad. */
  tick(): void {
    for (const adset of Object.values(this.#state.adsets)) {
      if (adset.status !== 'ACTIVE') continue;
      const active = adset.adIds.filter((adId) => this.#state.ads[adId]?.status === 'ACTIVE');
      if (active.length === 0) continue;
      const perAd = adset.dailyBudgetMinor / active.length;
      for (const adId of active) {
        const ad = this.#state.ads[adId]!;
        // Calibrated to plausible small-business lead-gen: ~INR 90 CPM,
        // 0.4-1.4% CTR, 6-24% form completion - so CPL lands in the same order
        // of magnitude as the target the brief sets, and a weak creative really
        // does lose money.
        const spendMajor = perAd / 100;
        const qn = normalizedQuality(ad.quality);
        const impressions = Math.round(spendMajor * (8 + this.#rand() * 6));
        const clicks = Math.round(impressions * (0.004 + 0.01 * qn * (0.6 + 0.8 * this.#rand())));
        const leads = Math.round(clicks * (0.06 + 0.18 * qn * (0.6 + 0.8 * this.#rand())));
        const acc = this.#state.acc[adId] ?? { spendMinor: 0, impressions: 0, clicks: 0, leads: 0 };
        acc.spendMinor += Math.round(perAd);
        acc.impressions += impressions;
        acc.clicks += clicks;
        acc.leads += leads;
        this.#state.acc[adId] = acc;
      }
    }
    this.#save();
  }

  async insights(adIds: string[]): Promise<AdInsight[]> {
    return adIds.map((adId) => {
      const acc = this.#state.acc[adId] ?? { spendMinor: 0, impressions: 0, clicks: 0, leads: 0 };
      return { adId, ...acc };
    });
  }

  /** How good each simulated ad secretly is - used to correlate call outcomes. */
  quality(adId: string): number {
    return this.#state.ads[adId]?.quality ?? 0;
  }
}

/** Map the hidden quality (0.4-1.6) onto 0-1 for use as a rate multiplier. */
export function normalizedQuality(quality: number): number {
  return Math.min(1, Math.max(0, (quality - 0.4) / 1.2));
}

/** One mulberry32 step, returned with the next state so it can be persisted. */
export function mulberry32Step(state: number): [value: number, next: number] {
  const a = (state + 0x6d2b79f5) >>> 0;
  let t = a;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return [((t ^ (t >>> 14)) >>> 0) / 4294967296, a];
}

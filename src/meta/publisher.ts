import type { Store } from '../store/db.ts';
import type { MetaProvider } from './provider.ts';
import type { AdRecord, Brief, CampaignRecord } from '../core/types.ts';
import {
  assertBudgetWithinCaps,
  assertGeoAllowed,
  assertNicheAllowed,
  assertObjectiveAllowed,
  GuardrailViolation,
  type Guardrails,
} from '../config/guardrails.ts';
import { now } from '../core/util.ts';
import { GATE_1 } from '../approvals/gates.ts';

export interface PublishOptions {
  dailyBudgetMinor: number;
  /** Test window length. A narrow window is the point - it bounds the loss. */
  windowDays: number;
  leadFormId?: string | null;
  /** Publish paused (default) or go live immediately once approved. */
  activate?: boolean;
}

export interface PublishResult {
  campaign: CampaignRecord;
  ads: AdRecord[];
  activated: boolean;
}

/**
 * Phase D of the playbook: Meta execution.
 *
 * Order matters here. Approval is checked before anything is built, caps are
 * checked before a budget is sent, and every object is created PAUSED and only
 * then activated - so a failure halfway through leaves an inert campaign rather
 * than a live one nobody approved.
 */
export async function publishCampaign(
  store: Store,
  provider: MetaProvider,
  g: Guardrails,
  runId: string,
  brief: Brief,
  pageId: string,
  options: PublishOptions,
): Promise<PublishResult> {
  if (!store.hasApproval(runId, GATE_1)) {
    throw new GuardrailViolation('gate_1', `run ${runId} has no approved gate #1; nothing may be published`);
  }

  const objective = g.allowedObjectives[0]!;
  assertObjectiveAllowed(g, objective);
  assertGeoAllowed(g, g.allowedGeos);
  assertNicheAllowed(g, brief.niche.name);
  assertBudgetWithinCaps(g, options.dailyBudgetMinor, store.totalSpendMinor(runId));

  if (!g.specialAdCategoriesAllowed) {
    // Special ad categories (credit, employment, housing, social issues) carry
    // their own targeting restrictions. We declare NONE, so the offer itself
    // must not belong to one. Ambiguous matches were already shown to a human
    // at gate #1; only hard blocks stop the publish here.
    assertNicheAllowed(g, brief.offer.icp, 'offer');
    assertNicheAllowed(g, brief.offer.outcome, 'offer');
  }

  const start = new Date();
  const end = new Date(start.getTime() + options.windowDays * 24 * 60 * 60 * 1000);

  const { campaignId } = await store.onceAsync('meta.createCampaign', [runId, brief.briefId], () =>
    provider.createCampaign({
      name: `[FL] ${brief.niche.name} - ${brief.briefId}`,
      objective,
      specialAdCategories: [],
      idempotencyKey: `${runId}:campaign`,
    }),
  );

  const { adsetId } = await store.onceAsync('meta.createAdSet', [runId, campaignId], () =>
    provider.createAdSet({
      name: `[FL] ${brief.niche.name} test`,
      campaignId,
      dailyBudgetMinor: options.dailyBudgetMinor,
      geos: g.allowedGeos,
      pageId,
      startTime: start.toISOString(),
      endTime: end.toISOString(),
      idempotencyKey: `${runId}:adset`,
    }),
  );

  const campaign: CampaignRecord = {
    campaignId,
    adsetId,
    runId,
    briefId: brief.briefId,
    objective,
    dailyBudgetMinor: options.dailyBudgetMinor,
    currency: g.currency,
    status: 'PAUSED',
    geo: g.allowedGeos,
    createdAt: now(),
    provider: provider.kind === 'meta' ? 'meta' : 'mock',
  };
  store.saveCampaign(campaign);
  store.audit(runId, 'agent', 'campaign.created', { campaignId, adsetId, dailyBudgetMinor: options.dailyBudgetMinor });

  const ads: AdRecord[] = [];
  for (const variant of brief.creatives) {
    const { creativeId } = await store.onceAsync('meta.createCreative', [runId, variant.creativeId], () =>
      provider.createAdCreative({
        name: `[FL] ${variant.angle} / ${variant.hook}`,
        pageId,
        variant,
        leadFormId: options.leadFormId ?? null,
        idempotencyKey: `${runId}:creative:${variant.creativeId}`,
      }),
    );

    const { adId } = await store.onceAsync('meta.createAd', [runId, variant.creativeId], () =>
      provider.createAd({
        name: `[FL] ${variant.angle} / ${variant.hook}`,
        adsetId,
        creativeId,
        idempotencyKey: `${runId}:ad:${variant.creativeId}`,
      }),
    );

    const ad: AdRecord = {
      adId,
      campaignId,
      adsetId,
      // Keep the brief's own creative id, not Meta's - it is how a call outcome
      // gets attributed back to the angle/hook that produced it.
      creativeId: variant.creativeId,
      status: 'PAUSED',
      createdAt: now(),
    };
    store.saveAd(ad);
    ads.push(ad);
  }

  let activated = false;
  if (options.activate) {
    await provider.setStatus(campaignId, 'ACTIVE');
    await provider.setStatus(adsetId, 'ACTIVE');
    for (const ad of ads) {
      await provider.setStatus(ad.adId, 'ACTIVE');
      store.setAdStatus(ad.adId, 'ACTIVE');
    }
    store.setCampaignStatus(campaignId, 'ACTIVE');
    campaign.status = 'ACTIVE';
    activated = true;
    store.setRunState(runId, 'live');
    store.audit(runId, 'agent', 'campaign.activated', { campaignId, ads: ads.length });
  } else {
    store.setRunState(runId, 'approved', 'published paused; activate explicitly');
  }

  return { campaign, ads, activated };
}

/** Pull cumulative insights and store a snapshot. Phase G reads these. */
export async function syncInsights(
  store: Store,
  provider: MetaProvider,
  runId: string,
): Promise<{ adIds: string[]; totalSpendMinor: number }> {
  const campaign = store.getCampaign(runId);
  if (!campaign) throw new Error(`run ${runId} has no campaign to sync`);
  const ads = store.listAds(campaign.campaignId);
  const insights = await provider.insights(ads.map((a) => a.adId));
  const asOf = now();
  for (const row of insights) {
    store.recordSpend({
      runId,
      adId: row.adId,
      spendMinor: row.spendMinor,
      impressions: row.impressions,
      clicks: row.clicks,
      leads: row.leads,
      asOf,
    });
  }
  const totalSpendMinor = insights.reduce((sum, r) => sum + r.spendMinor, 0);
  store.audit(runId, 'meta', 'insights.synced', { ads: insights.length, totalSpendMinor });
  return { adIds: ads.map((a) => a.adId), totalSpendMinor };
}

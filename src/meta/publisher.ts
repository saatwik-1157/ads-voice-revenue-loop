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
import { checkClaims, checkPromiseAlignment } from '../brief/claims.ts';
import { missingAssets } from '../creative/pipeline.ts';

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

  // Re-checked here, against the brief actually being sent, and not only at
  // gate #1. An approval is a decision about the brief as it stood then; this
  // is the last point before the copy is real. Both checks existed already and
  // neither stopped anything: a brief promising "guaranteed results" was
  // flagged at the gate, approved anyway, and published - while the gate's own
  // documentation said blocking issues could not be approved past.
  const claims = checkClaims(brief, g);
  if (claims.length) {
    const detail = claims.map((i) => `${i.field}: "${i.pattern}"`).join('; ');
    throw new GuardrailViolation(
      'banned_claim',
      `brief makes ${claims.length} claim(s) the control layer forbids - ${detail}. Regenerate the brief; this is not approvable.`,
    );
  }
  const drift = checkPromiseAlignment(brief);
  if (drift.length) {
    throw new GuardrailViolation(
      'promise_drift',
      `the voice script does not match what the ad promised - ${drift.join('; ')}`,
    );
  }

  // Budgets are sent to Meta as an integer of the *ad account's* minor units,
  // while every cap here is written in the guardrails' currency. Nothing used
  // to check they agreed, and the failure is silent and expensive: guardrails
  // in INR against a USD account send "100000" for a 1,000 rupee cap and get a
  // 1,000 dollar campaign - roughly 85x - with the stop-loss, the CPL target
  // and every other limit denominated wrong at the same time.
  const account = await provider.accountSummary();
  if (account.currency.toUpperCase() !== g.currency.toUpperCase()) {
    throw new GuardrailViolation(
      'currency_mismatch',
      `ad account ${account.accountId} bills in ${account.currency}, the control layer is written in ${g.currency}. ` +
        `Every budget would be sent as ${account.currency} minor units while being checked as ${g.currency}. ` +
        `Set "currency" in config/guardrails.json to ${account.currency} and restate the caps in it, or use an ad account that bills in ${g.currency}.`,
    );
  }
  if (account.status !== null && account.status !== 1) {
    throw new GuardrailViolation(
      'account_not_active',
      `ad account ${account.accountId} has account_status ${account.status} (1 is active)${account.disableReason ? `, disable_reason ${account.disableReason}` : ''}; it cannot run ads`,
    );
  }

  const objective = g.allowedObjectives[0]!;
  assertObjectiveAllowed(g, objective);
  assertGeoAllowed(g, g.allowedGeos);
  assertNicheAllowed(g, brief.niche.name);
  assertBudgetWithinCaps(g, options.dailyBudgetMinor, store.totalSpendMinor(runId), options.windowDays);

  if (!g.specialAdCategoriesAllowed) {
    // Special ad categories (credit, employment, housing, social issues) carry
    // their own targeting restrictions. We declare NONE, so the offer itself
    // must not belong to one. Ambiguous matches were already shown to a human
    // at gate #1; only hard blocks stop the publish here.
    assertNicheAllowed(g, brief.offer.icp, 'offer');
    assertNicheAllowed(g, brief.offer.outcome, 'offer');
  }

  // Artwork must exist before a single campaign object is created, so a run
  // cannot end up half-built around a creative that has no image.
  const missing = missingAssets(brief);
  if (missing.length) {
    throw new GuardrailViolation(
      'creative_assets',
      `${missing.length} creative(s) have no uploaded artwork: ${missing.join(', ')}. Run \`assets\` first.`,
    );
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
  store.transaction(() => {
    store.saveCampaign(campaign);
    store.audit(runId, 'agent', 'campaign.created', { campaignId, adsetId, dailyBudgetMinor: options.dailyBudgetMinor });
  });

  // The loop below cannot be one transaction: each iteration awaits two calls
  // to Meta, and holding a write transaction across network I/O would block
  // every other writer for as long as the provider takes. Each ad row is a
  // single atomic write instead, and `onceAsync` makes a resumed publish reuse
  // the ads it already created rather than duplicating them.

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
    // Every provider call first. A database transaction cannot be held open
    // across network I/O - SQLite would block other writers for the duration -
    // so the remote changes happen here and the local record of them is
    // committed as one unit below.
    await provider.setStatus(campaignId, 'ACTIVE');
    await provider.setStatus(adsetId, 'ACTIVE');
    for (const ad of ads) {
      await provider.setStatus(ad.adId, 'ACTIVE');
    }

    // One unit: ads active, campaign active, run live, audited. Previously a
    // throw partway left a campaign marked ACTIVE on a run still marked
    // approved - a state no later read could distinguish from a real one.
    store.transaction(() => {
      for (const ad of ads) store.setAdStatus(ad.adId, 'ACTIVE');
      store.setCampaignStatus(campaignId, 'ACTIVE');
      store.setRunState(runId, 'live');
      store.audit(runId, 'agent', 'campaign.activated', { campaignId, ads: ads.length });
    });
    campaign.status = 'ACTIVE';
    activated = true;
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

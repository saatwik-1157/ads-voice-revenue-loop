import type { Context } from '../orchestrator.ts';
import type { Brief, CreativeVariant } from '../core/types.ts';
import { checkClaims, checkPromiseAlignment } from '../brief/claims.ts';
import { ensureCreativeAssets } from './pipeline.ts';
import { fingerprint, now } from '../core/util.ts';
import { log } from '../core/log.ts';

/**
 * The ITERATE arm of the loop.
 *
 * KEEP holds, KILL pauses, SCALE raises the budget - and ITERATE did nothing at
 * all. The engine would conclude "connected calls that do not qualify mean the
 * offer or the targeting is wrong, write a different angle", pause nothing,
 * change nothing, and reach the identical conclusion on every cycle after that.
 * One of the four decisions the whole playbook is built around was a no-op.
 *
 * This writes the next untried angle, checks it, and puts it in the existing ad
 * set.
 *
 * **It costs nothing extra.** The new ad joins the ad set that is already
 * running, at the budget already approved. Iterating is a change of message,
 * not a change of spend, so it needs no gate: gate #1 approved this budget and
 * gate #2 is for material changes. A new claim *is* material, which is why the
 * copy is claim-checked before it goes anywhere, and refused if it introduces
 * one rather than quietly publishing it.
 */

export type IterationStatus = 'published' | 'nothing_untried' | 'no_room' | 'refused' | 'not_applicable';

export interface IterationOutcome {
  status: IterationStatus;
  reason: string;
  creativeId?: string;
  adId?: string;
  angle?: string;
  hook?: string;
}

/**
 * Angle and hook pairs the offline writer knows.
 *
 * The brief starts with as many of these as `maxCreativeVariants` allows, which
 * is usually two of six. The rest are what iteration has to work with. Kept
 * beside the writer's own list deliberately: a new angle invented here would
 * not have been through the same review as the ones in the brief.
 */
const CATALOGUE: Array<{ angle: string; hook: string }> = [
  { angle: 'Speed', hook: 'Still waiting on a callback?' },
  { angle: 'Cost certainty', hook: 'No surprise line items.' },
  { angle: 'Risk of delay', hook: 'What this costs you next week.' },
  { angle: 'Speed', hook: 'Booked today, quoted today.' },
  { angle: 'Cost certainty', hook: 'Fixed quote before anyone shows up.' },
  { angle: 'Risk of delay', hook: 'The cheap fix has an expiry date.' },
];

/** The next pair the brief has not used, preferring an angle it has not tried at all. */
export function nextUntried(brief: Brief): { angle: string; hook: string } | null {
  const usedPairs = new Set(brief.creatives.map((c) => `${c.angle}::${c.hook}`));
  const usedAngles = new Set(brief.creatives.map((c) => c.angle));

  // A new angle is a better test than a new hook on an angle already losing.
  const freshAngle = CATALOGUE.find((c) => !usedAngles.has(c.angle) && !usedPairs.has(`${c.angle}::${c.hook}`));
  if (freshAngle) return freshAngle;
  return CATALOGUE.find((c) => !usedPairs.has(`${c.angle}::${c.hook}`)) ?? null;
}

/** Build a variant in the same shape and voice as the brief's own. */
function draft(
  runId: string,
  brief: Brief,
  pick: { angle: string; hook: string },
  geos: string[],
): CreativeVariant {
  const model = brief.creatives[0];
  return {
    // Derived from what it is, not minted fresh. A random id per call made both
    // idempotency keys useless: a retried cycle never matched the stored key or
    // Meta's, so every failed attempt left another orphan creative in the ad
    // account and the work was redone from scratch.
    creativeId: `cr_${fingerprint([runId, pick.angle, pick.hook]).slice(0, 16)}`,
    angle: pick.angle,
    hook: pick.hook,
    primaryText: `${pick.hook} We handle ${brief.niche.name.toLowerCase()} for businesses in ${geos.join('/')}. Tell us what is happening and we will call you back with a fixed scope and a price - usually within 10 minutes during working hours.`,
    headline: model?.headline ?? 'Callback with a fixed quote',
    description: brief.offer.deliverable,
    format: model?.format ?? 'reel',
    assetRef: null,
    assetProvenance: null,
  };
}

export async function iterateCreative(ctx: Context, runId: string, brief: Brief): Promise<IterationOutcome> {
  const g = ctx.guardrails;

  const stop = ctx.store.emergencyStop();
  if (stop.engaged) {
    return { status: 'refused', reason: `emergency stop engaged (${stop.trigger ?? 'unknown'})` };
  }

  const campaign = ctx.store.getCampaign(runId);
  if (!campaign) return { status: 'not_applicable', reason: `run ${runId} has no campaign` };

  // Room is counted in *running* ads, not in ads that exist. The whole point of
  // iterating after a kill is that the kill freed a slot; counting paused ads
  // against the cap would mean a run could never replace anything.
  const ads = ctx.store.listAds(campaign.campaignId);
  const running = ads.filter((a) => a.status !== 'PAUSED').length;
  if (running >= g.maxCreativeVariants) {
    return {
      status: 'no_room',
      reason: `${running} creative(s) already running and maxCreativeVariants is ${g.maxCreativeVariants}; kill one before writing another`,
    };
  }

  const pick = nextUntried(brief);
  if (!pick) {
    // Worth saying plainly rather than looking like success: the offline writer
    // has run out of angles, and the next move is a person's.
    return {
      status: 'nothing_untried',
      reason: 'every angle and hook the writer knows has already been tried on this run',
    };
  }

  const variant = draft(runId, brief, pick, g.allowedGeos);
  const candidate: Brief = { ...brief, creatives: [...brief.creatives, variant] };

  // The same check the brief went through at gate #1. Iteration is allowed
  // without a human precisely because it cannot introduce a new claim, so this
  // is the line that makes that true rather than aspirational.
  const claimIssues = checkClaims(candidate, g);
  const drift = checkPromiseAlignment(candidate);
  if (claimIssues.length > 0 || drift.length > 0) {
    const detail = [...claimIssues.map((i) => `${i.field}: "${i.pattern}"`), ...drift];
    ctx.store.audit(runId, 'agent', 'creative.iteration_refused', { angle: pick.angle, hook: pick.hook, detail });
    return {
      status: 'refused',
      reason: `the new copy would introduce a claim that needs a person: ${detail.join('; ')}`,
    };
  }

  // Artwork, through the same pipeline and the same provenance labelling.
  //
  // The FULL brief with the new variant appended, never just the variant.
  // ensureCreativeAssets persists whatever brief it is handed, so passing
  // `{ creatives: [variant] }` wrote a brief containing only the unpublished
  // creative - erasing every existing one from the run. The next iteration then
  // saw those angles as untried and republished a creative the engine had just
  // killed, live, with real money behind it.
  const working: Brief = { ...brief, creatives: [...brief.creatives, variant] };
  await ensureCreativeAssets(ctx.store, ctx.meta, ctx.assets, runId, working, {
    // Previews are written for every other call site; without this nobody can
    // look at machine-rendered artwork that went live.
    previewDir: ctx.env.previewDir,
  });
  const ready = working.creatives[working.creatives.length - 1]!;
  if (!ready.assetRef) {
    return { status: 'refused', reason: `no artwork could be produced for ${variant.creativeId}` };
  }

  // Re-read, not only checked at the top. Artwork can take several
  // seconds and a stop engaged in that window would otherwise still see a new
  // ad go live.
  if (ctx.store.emergencyStop().engaged) {
    return { status: 'refused', reason: 'the emergency stop was engaged while the artwork was being produced' };
  }

  const { creativeId } = await ctx.store.onceAsync('meta.createCreative', [runId, variant.creativeId], () =>
    ctx.meta.createAdCreative({
      name: `[FL] ${variant.angle} / ${variant.hook}`,
      pageId: ctx.env.meta.pageId,
      variant: ready,
      leadFormId: null,
      idempotencyKey: `${runId}:creative:${variant.creativeId}`,
    }),
  );

  const { adId } = await ctx.store.onceAsync('meta.createAd', [runId, variant.creativeId], () =>
    ctx.meta.createAd({
      name: `[FL] ${variant.angle} / ${variant.hook}`,
      adsetId: campaign.adsetId,
      creativeId,
      idempotencyKey: `${runId}:ad:${variant.creativeId}`,
    }),
  );

  // Recorded PAUSED first, then activated, then updated. The other order left
  // an ad ACTIVE at Meta and unknown to the store if the process died between
  // the two - invisible to the decision engine, never paused by a KILL, and
  // uncounted by the variant cap, which reads this table.
  ctx.store.saveAd({
    adId,
    campaignId: campaign.campaignId,
    adsetId: campaign.adsetId,
    creativeId: variant.creativeId,
    status: 'PAUSED',
    createdAt: now(),
  });

  // Live only if the campaign it is joining is live. An iteration must not be
  // the thing that starts spending on a run somebody paused.
  const activate = campaign.status === 'ACTIVE';
  if (activate) await ctx.meta.setStatus(adId, 'ACTIVE');

  ctx.store.transaction(() => {
    if (activate) ctx.store.setAdStatus(adId, 'ACTIVE');
    // The brief carries the new variant, so the next iteration knows this angle
    // is spent and a call outcome can be attributed back to it.
    ctx.store.saveBrief(runId, { ...brief, creatives: [...brief.creatives, ready] });
    ctx.store.audit(runId, 'agent', 'creative.iterated', {
      creativeId: variant.creativeId,
      adId,
      angle: variant.angle,
      hook: variant.hook,
      provenance: ready.assetProvenance,
      activated: activate,
    });
  });

  log.info('creative.iterated', { runId, adId, angle: variant.angle, activated: activate });

  return {
    status: 'published',
    reason: `new creative "${variant.angle} / ${variant.hook}" is ${activate ? 'live' : 'paused'} in the existing ad set at no extra budget`,
    creativeId: variant.creativeId,
    adId,
    angle: variant.angle,
    hook: variant.hook,
  };
}

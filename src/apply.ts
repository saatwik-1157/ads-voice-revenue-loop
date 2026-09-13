import type { Context } from './orchestrator.ts';
import type { Recommendation } from './core/types.ts';
import type { ScalePlan } from './economics/decision.ts';

/**
 * Pause the creatives the engine condemned - except any the scale plan is
 * holding open as the test budget.
 *
 * Nothing in the current rules can produce that collision (the holdout is drawn
 * from KEEP/ITERATE ads, and only KILL ads are paused). The check is here so a
 * future per-ad rule cannot quietly consolidate the whole budget onto a single
 * winner, which is how an account ends up with one creative and no way to find
 * its replacement.
 */
export async function pauseKilledAds(
  ctx: Context,
  runId: string,
  rec: Recommendation,
  plan: ScalePlan,
): Promise<number> {
  const holdout = new Set(plan.holdoutAdIds);
  let paused = 0;
  for (const ad of rec.perAd) {
    if (ad.decision !== 'KILL') continue;
    if (holdout.has(ad.adId)) {
      ctx.store.audit(runId, 'agent', 'ad.pause_refused', { adId: ad.adId, reason: 'reserved as scale holdout' });
      continue;
    }
    await ctx.meta.setStatus(ad.adId, 'PAUSED');
    ctx.store.setAdStatus(ad.adId, 'PAUSED');
    paused += 1;
  }
  return paused;
}

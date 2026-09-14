import type { Context } from './orchestrator.ts';
import type { Brief, Recommendation } from './core/types.ts';
import { planScale, type ScalePlan } from './economics/decision.ts';
import { GATE_2, requestGate2 } from './approvals/gates.ts';
import { money } from './core/util.ts';

/**
 * Acting on a recommendation, inside what the agent may do alone.
 *
 * This is the single path both `apply` (a person at a terminal) and the
 * unattended scheduler take. Keeping one implementation is the point: a
 * scheduler that acted through slightly different rules than the CLI would be
 * a second, invisible policy.
 */

export interface ApplyOptions {
  /**
   * Clock for the budget-raise interval, injectable so the rule can be tested
   * without waiting a day.
   */
  now?: Date;
  /**
   * Skip minHoursBetweenBudgetRaises.
   *
   * This used to be implied by "a person is running it", on the reasoning that
   * someone at a terminal has already decided to act. That was wrong. The
   * operator decides to raise the budget once; they cannot see that the
   * scheduler raised it ninety seconds ago, and this floor exists precisely to
   * stop two individually-legal raises from compounding. Overriding it is now
   * something a person has to type, and it is audited when they do.
   */
  force?: boolean;
  /** Who forced it, for the audit trail. */
  forcedBy?: string;
}

export type ApplyOutcome =
  | { kind: 'halted'; reason: string; pausedAds: number }
  | { kind: 'budget_raised'; from: number; to: number; plan: ScalePlan; pausedAds: number }
  | { kind: 'approval_requested'; approvalId: string; plan: ScalePlan; pausedAds: number }
  | { kind: 'approval_pending'; approvalId: string; plan: ScalePlan; pausedAds: number }
  | { kind: 'budget_deferred'; reason: string; plan: ScalePlan; pausedAds: number }
  | { kind: 'no_change'; reason: string; plan: ScalePlan; pausedAds: number };

export async function applyRecommendation(
  ctx: Context,
  runId: string,
  brief: Brief,
  rec: Recommendation,
  options: ApplyOptions = {},
): Promise<ApplyOutcome> {
  const g = ctx.guardrails;
  const at = options.now ?? new Date();
  const campaign = ctx.store.getCampaign(runId);
  if (!campaign) throw new Error(`run ${runId} has no campaign`);

  // A stop-loss kill outranks everything: stop the spend, then stop.
  if (rec.decision === 'KILL' && rec.requiresHumanApproval) {
    await ctx.meta.setStatus(campaign.campaignId, 'PAUSED');
    ctx.store.setCampaignStatus(campaign.campaignId, 'PAUSED');
    ctx.store.setRunState(runId, 'paused', rec.rationale);
    ctx.store.audit(runId, 'agent', 'campaign.paused', { reason: rec.signal });
    return { kind: 'halted', reason: rec.rationale, pausedAds: 0 };
  }

  const plan = planScale(g, campaign.dailyBudgetMinor, rec.decision, rec.perAd);
  const pausedAds = await pauseKilledAds(ctx, runId, rec, plan);

  if (plan.proposedDailyMinor === campaign.dailyBudgetMinor) {
    return { kind: 'no_change', reason: plan.reason, plan, pausedAds };
  }

  if (plan.needsApproval) {
    // An unattended loop must not file the same request every cycle. One
    // pending gate #2 is a decision waiting on a person; a hundred is noise
    // that buries it.
    const existing = ctx.store.pendingApprovals(runId).find((a) => a.gate === GATE_2);
    if (existing) {
      return { kind: 'approval_pending', approvalId: existing.approvalId, plan, pausedAds };
    }
    const request = requestGate2(ctx.store, runId, `Raise daily budget to ${money(plan.proposedDailyMinor, g.currency)}`, {
      from: campaign.dailyBudgetMinor,
      to: plan.proposedDailyMinor,
      proven: plan.provenDailyMinor,
      holdout: plan.holdoutDailyMinor,
      holdoutAds: plan.holdoutAdIds,
      reason: plan.reason,
    });
    return { kind: 'approval_requested', approvalId: request.approvalId, plan, pausedAds };
  }

  const blocked = budgetRaiseTooSoon(ctx, runId, at);
  if (blocked) {
    if (!options.force) return { kind: 'budget_deferred', reason: blocked, plan, pausedAds };
    // Overriding a cap is itself an event worth being able to find later.
    ctx.store.audit(runId, 'human', 'budget.floor_overridden', {
      by: options.forcedBy ?? 'unknown',
      reason: blocked,
      to: plan.proposedDailyMinor,
    });
  }

  await ctx.meta.setDailyBudget(campaign.adsetId, plan.proposedDailyMinor);
  ctx.store.setCampaignBudget(campaign.campaignId, plan.proposedDailyMinor);
  ctx.store.audit(runId, 'agent', 'budget.raised', {
    from: campaign.dailyBudgetMinor,
    to: plan.proposedDailyMinor,
    provenDailyMinor: plan.provenDailyMinor,
    holdoutDailyMinor: plan.holdoutDailyMinor,
    holdoutAdIds: plan.holdoutAdIds,
  });
  return { kind: 'budget_raised', from: campaign.dailyBudgetMinor, to: plan.proposedDailyMinor, plan, pausedAds };
}

/**
 * maxBudgetStepFactor caps a single step, not a rate. Left alone, a 6-hourly
 * scheduler would compound 1.3x four times a day - 2.86x - while every
 * individual decision still looked compliant. This is the rate limit.
 */
export function budgetRaiseTooSoon(ctx: Context, runId: string, at: Date): string | null {
  const minHours = ctx.guardrails.minHoursBetweenBudgetRaises;
  if (minHours <= 0) return null;

  const last = ctx.store.lastEventAt(runId, 'budget.raised');
  if (!last) return null;

  const elapsedHours = (at.getTime() - Date.parse(last)) / 3_600_000;
  if (elapsedHours >= minHours) return null;
  return `last budget raise was ${elapsedHours.toFixed(1)}h ago; minHoursBetweenBudgetRaises is ${minHours}`;
}

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
    // Pausing an ad is a real change to the ad account. Auditing only the
    // refusal to pause left the action itself invisible.
    ctx.store.audit(runId, 'agent', 'ad.paused', { adId: ad.adId, rationale: ad.rationale });
    paused += 1;
  }
  return paused;
}

/** One-line description of what an apply actually did, for logs and the CLI. */
export function describeOutcome(outcome: ApplyOutcome, currency: string): string {
  switch (outcome.kind) {
    case 'halted':
      return `campaign PAUSED and handed back to a human: ${outcome.reason}`;
    case 'budget_raised':
      return (
        `budget raised to ${money(outcome.to, currency)}/day ` +
        `(${money(outcome.plan.provenDailyMinor, currency)} proven + ` +
        `${money(outcome.plan.holdoutDailyMinor, currency)} holdout across ${outcome.plan.holdoutAdIds.length} test creative(s))`
      );
    case 'approval_requested':
      return `GATE #2 requested ${outcome.approvalId}: ${outcome.plan.reason}`;
    case 'approval_pending':
      return `waiting on gate #2 approval ${outcome.approvalId}; no new request filed`;
    case 'budget_deferred':
      return `budget raise deferred: ${outcome.reason}`;
    case 'no_change':
      return `no budget change (${outcome.reason})`;
  }
}

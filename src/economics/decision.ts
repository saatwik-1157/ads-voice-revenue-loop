import type { Store } from '../store/db.ts';
import type { Brief, Decision, Economics, Recommendation } from '../core/types.ts';
import type { Guardrails } from '../config/guardrails.ts';
import { money, pct } from '../core/util.ts';
import { economicsForAd, economicsForRun } from './metrics.ts';
import { budgetChangeNeedsApproval } from '../approvals/gates.ts';

/**
 * The decision engine (playbook: "THE DECISION ENGINE" + phase G).
 *
 * The rules are ordered deliberately. Diagnosis comes before optimisation: if
 * there are no leads at all, or leads are not connecting, regenerating creative
 * is the wrong move and the engine says so instead of burning budget on new
 * variants. Only once the funnel is actually delivering does it start judging
 * creative on revenue.
 */
export function evaluate(store: Store, g: Guardrails, runId: string, brief: Brief): Recommendation {
  const economics = economicsForRun(store, runId);
  const campaign = store.getCampaign(runId);
  const ads = campaign ? store.listAds(campaign.campaignId) : [];
  const perAd = ads.map((ad) => {
    const e = economicsForAd(store, runId, ad.adId);
    return { adId: ad.adId, creativeId: ad.creativeId, economics: e };
  });

  // Per-ad judgement is only as good as the round trip that says which ad a
  // lead came from. When leads are arriving without one, an ad's real leads
  // are invisible to its own economics.
  const attributionIntact = economics.unattributedLeads === 0;

  const signal = diagnose(economics, g, brief);
  const perAdDecisions = perAd.map((entry) => ({
    adId: entry.adId,
    decision: judgeAd(entry.economics, g, brief, signal.decision, attributionIntact),
    rationale: attributionIntact
      ? adRationale(entry.economics, g, brief)
      : `${adRationale(entry.economics, g, brief)} - judged cautiously: ${economics.unattributedLeads} lead(s) on this run carry no ad id`,
    economics: entry.economics,
  }));

  return {
    decision: signal.decision,
    signal: signal.signal,
    rationale: signal.rationale,
    action: signal.action,
    requiresHumanApproval: signal.requiresHumanApproval,
    economics,
    perAd: perAdDecisions,
  };
}

interface Diagnosis {
  decision: Decision;
  signal: string;
  rationale: string;
  action: string;
  requiresHumanApproval: boolean;
}

function diagnose(e: Economics, g: Guardrails, brief: Brief): Diagnosis {
  const m = brief.successMetrics;

  // Stop-loss first. Nothing else matters once the run has lost more than the
  // control layer allows.
  if (e.spendMinor - e.revenueMinor >= g.stopLossMinor) {
    return {
      decision: 'KILL',
      signal: 'stop_loss',
      rationale: `net loss ${money(e.spendMinor - e.revenueMinor, g.currency)} reached the stop-loss ${money(g.stopLossMinor, g.currency)}`,
      action: 'Pause everything and hand back to a human before any further spend.',
      requiresHumanApproval: true,
    };
  }

  if (e.spendMinor === 0) {
    return {
      decision: 'ITERATE',
      signal: 'no_delivery',
      rationale: 'campaign has spent nothing yet',
      action: 'Check the campaign is active, the ads are approved, and the ad set has left review. Do not regenerate creative.',
      requiresHumanApproval: false,
    };
  }

  if (e.leads === 0) {
    return {
      decision: 'ITERATE',
      signal: 'no_leads',
      rationale: `${money(e.spendMinor, g.currency)} spent with zero leads`,
      action:
        'Verify delivery, ad approval status and lead-form/tracking wiring before touching creative. Endlessly regenerating creative hides a plumbing fault.',
      requiresHumanApproval: false,
    };
  }

  // Below this point there is not yet enough evidence to make a spend decision.
  if (e.leads < g.minLeadsBeforeDecision && e.spendMinor < g.minSpendBeforeKillMinor) {
    return {
      decision: 'KEEP',
      signal: 'insufficient_data',
      rationale: `${e.leads} leads / ${money(e.spendMinor, g.currency)} spent is below the decision threshold (${g.minLeadsBeforeDecision} leads or ${money(g.minSpendBeforeKillMinor, g.currency)})`,
      action: 'Keep running unchanged until the sample is large enough to judge.',
      requiresHumanApproval: false,
    };
  }

  // Leads arriving with no ad id are a plumbing fault of the same family as
  // no_leads, and a quieter one: the run total looks healthy while every
  // per-ad view is starved, so the creative test stops being a test without
  // anything appearing to be wrong. Checked after insufficient_data, so a run
  // too small to judge says that rather than blaming attribution.
  if (e.unattributedLeads * 2 >= e.leads) {
    return {
      decision: 'ITERATE',
      signal: 'attribution_gap',
      rationale: `${e.unattributedLeads} of ${e.leads} leads carry no ad id, so at least half of this run cannot be traced to a creative`,
      action:
        'Fix the round trip before judging creative: the instant form has to pass ad_id through, and a lead posted by hand has to carry one. Until then the per-ad numbers are a subset, not a split.',
      requiresHumanApproval: false,
    };
  }

  // A lead nobody has dialled is not evidence about dialling.
  //
  // A call deferred outside the calling window writes an audit row and no call
  // row, so a cycle running at 02:00 saw 20 leads and no connections and called
  // it a pipeline fault - "validate phone capture" - while the queue was simply
  // waiting for 10:00. The same false reading appeared mid-delivery, before the
  // first outcomes had come back.
  if (e.leadsAwaitingCall > 0 && (e.calledLeads < 5 || e.leadsAwaitingCall > e.calledLeads)) {
    return {
      decision: 'KEEP',
      signal: 'calls_pending',
      rationale: `${e.leadsAwaitingCall} of ${e.leads} leads have not been dialled yet; ${e.calledLeads} have an outcome`,
      action:
        'Nothing to judge yet, and nothing to change. If the queue is not draining the cause is the calling window, maxCallsPerDay, or a dispatcher that is not running - `audit --kind call.deferred` names it. Not a creative fault.',
      requiresHumanApproval: false,
    };
  }

  // Judged over the leads actually dialled, not over every lead. The run-wide
  // connectRate stays honest about leads paid for and never reached; it is just
  // the wrong denominator for asking whether dialling itself works.
  const dialledConnectRate = e.calledLeads > 0 ? e.connectedLeads / e.calledLeads : null;
  if (dialledConnectRate !== null && dialledConnectRate < m.targetConnectRate * 0.6) {
    return {
      decision: 'ITERATE',
      signal: 'low_connect_rate',
      rationale: `${pct(dialledConnectRate)} of the ${e.calledLeads} leads dialled connected, against a ${pct(m.targetConnectRate)} target`,
      action:
        'Validate phone capture and normalization, time-to-first-call, and calling hours before spending more. This is a pipeline fault, not a creative fault.',
      requiresHumanApproval: false,
    };
  }

  if (e.qualifyRate !== null && e.connectedLeads >= 5 && e.qualifyRate < m.targetQualifiedRate * 0.6) {
    return {
      decision: 'ITERATE',
      signal: 'poor_qualification',
      rationale: `only ${pct(e.qualifyRate)} of connected calls qualify against a ${pct(m.targetQualifiedRate)} target`,
      action:
        'Tighten targeting or change the offer so the ad attracts the buyer you can actually serve. Do not increase spend on an audience that does not qualify.',
      requiresHumanApproval: false,
    };
  }

  if (e.qualifiedLeads >= 5 && e.sales === 0) {
    const objection = 'inspect objections, pricing, trust signals and the voice-agent script';
    return {
      decision: 'ITERATE',
      signal: 'qualified_no_conversion',
      rationale: `${e.qualifiedLeads} qualified leads produced no sale`,
      action: `The funnel reaches the right people and loses them at the ask - ${objection}.`,
      requiresHumanApproval: false,
    };
  }

  if (e.roas !== null && e.roas >= m.targetRoas && e.sales > 0) {
    return {
      decision: 'SCALE',
      signal: 'profitable_cohort',
      rationale: `ROAS ${e.roas.toFixed(2)} against a ${m.targetRoas} target on ${e.sales} sale(s)`,
      action: `Raise budget gradually within the cap, keep ${Math.round(g.holdoutBudgetShare * 100)}% as a holdout for new variants, and re-evaluate before the next step.`,
      requiresHumanApproval: false,
    };
  }

  const cplOverTarget = e.cplMinor !== null && e.cplMinor > m.targetCplMinor * 1.5;
  if (cplOverTarget && e.spendMinor >= g.minSpendBeforeKillMinor) {
    return {
      decision: 'KILL',
      signal: 'unprofitable_cpl',
      rationale: `CPL ${money(e.cplMinor!, g.currency)} is more than 1.5x the target ${money(m.targetCplMinor, g.currency)} after ${money(e.spendMinor, g.currency)} of spend`,
      action: 'Pause this cohort. Keep the lead and call data; relaunch only with a changed offer or audience.',
      requiresHumanApproval: false,
    };
  }

  return {
    decision: 'KEEP',
    signal: 'within_tolerance',
    rationale: `CPL ${e.cplMinor === null ? 'n/a' : money(e.cplMinor, g.currency)}, connect ${pct(e.connectRate)}, qualify ${pct(e.qualifyRate)}, ROAS ${e.roas?.toFixed(2) ?? 'n/a'}`,
    action: 'Hold the current allocation and re-evaluate at the next cycle.',
    requiresHumanApproval: false,
  };
}

/**
 * Per-creative judgement. An ad is only killed on its own economics once it has
 * had a fair share of spend - otherwise the engine just kills whichever ad the
 * auction happened to starve.
 */
function judgeAd(e: Economics, g: Guardrails, brief: Brief, runDecision: Decision, attributionIntact: boolean): Decision {
  if (runDecision === 'KILL') return 'KILL';
  const minSpend = Math.round(g.minSpendBeforeKillMinor / Math.max(1, brief.creatives.length));
  if (e.spendMinor < minSpend) return 'KEEP';
  if (e.sales > 0 && e.roas !== null && e.roas >= brief.successMetrics.targetRoas) return 'SCALE';
  // "No leads" is only evidence against a creative when leads that did arrive
  // could be traced to one. With the round trip broken, an ad's leads land in
  // the run total and nowhere else, and killing on zero here pauses a working
  // creative for a tracking fault - the exact confusion the run-level rules
  // are ordered to avoid.
  if (e.leads === 0) return attributionIntact ? 'KILL' : 'KEEP';
  // The same reasoning one line up, and it was missing here. This CPL divides
  // the ad's FULL spend by only the leads that could be traced to it, so with
  // attribution partly lost it reads high for a creative that is doing fine:
  // 600 spend and 7 real leads, 4 of them untraceable, shows as a CPL of 200
  // against a true 86 and gets the creative paused for a tracking fault.
  if (attributionIntact && e.cplMinor !== null && e.cplMinor > brief.successMetrics.targetCplMinor * 2) return 'KILL';
  if (e.qualifiedLeads === 0 && e.connectedLeads >= 5) return 'ITERATE';
  return 'KEEP';
}

function adRationale(e: Economics, g: Guardrails, brief: Brief): string {
  return [
    `spend ${money(e.spendMinor, g.currency)}`,
    `leads ${e.leads}`,
    `CPL ${e.cplMinor === null ? 'n/a' : money(e.cplMinor, g.currency)} (target ${money(brief.successMetrics.targetCplMinor, g.currency)})`,
    `qualified ${e.qualifiedLeads}`,
    `sales ${e.sales}`,
    `ROAS ${e.roas?.toFixed(2) ?? 'n/a'}`,
  ].join(', ');
}

export interface ScalePlan {
  proposedDailyMinor: number;
  /** The share of the daily budget backing creatives that have proven out. */
  provenDailyMinor: number;
  /** Reserved for creatives still being tested. Zero means there is no holdout. */
  holdoutDailyMinor: number;
  /**
   * Ads that must stay ACTIVE to hold the test budget open. `apply` refuses to
   * pause these, which is what turns the holdout from a slogan into a rule.
   */
  holdoutAdIds: string[];
  needsApproval: boolean;
  reason: string;
  warnings: string[];
}

/**
 * Translate a SCALE recommendation into a concrete budget plan.
 *
 * Capped by the control layer, routed to gate #2 when it is a material increase,
 * and - the part that is actually enforced elsewhere - it reserves a holdout.
 *
 * A holdout only means something if there are unproven creatives left running to
 * receive it: every ad in one ad set shares the budget, so "reserve 20% for
 * testing" is the same statement as "do not pause everything except the winner".
 * When nothing is left to test, scaling would put the entire budget behind a
 * single creative with no way to find its replacement, so the plan goes to a
 * human instead of proceeding quietly.
 */
export function planScale(
  g: Guardrails,
  currentDailyMinor: number,
  decision: Decision,
  perAd: Array<{ adId: string; decision: Decision }> = [],
): ScalePlan {
  const noChange: ScalePlan = {
    proposedDailyMinor: currentDailyMinor,
    provenDailyMinor: currentDailyMinor,
    holdoutDailyMinor: 0,
    holdoutAdIds: [],
    needsApproval: false,
    reason: 'no increase proposed',
    warnings: [],
  };
  if (decision !== 'SCALE') return noChange;

  const stepped = Math.round(currentDailyMinor * g.maxBudgetStepFactor);
  const proposed = Math.min(stepped, g.maxDailySpendMinor);

  // The holdout is whatever is still being tested: anything not already proven
  // and not condemned.
  const holdoutAdIds = perAd.filter((ad) => ad.decision === 'KEEP' || ad.decision === 'ITERATE').map((ad) => ad.adId);
  const holdoutDailyMinor = holdoutAdIds.length > 0 ? Math.round(proposed * g.holdoutBudgetShare) : 0;

  const gate = budgetChangeNeedsApproval(g, currentDailyMinor, proposed);
  const warnings: string[] = [];
  let needsApproval = gate.needed;
  let reason = gate.reason;

  if (holdoutAdIds.length === 0) {
    needsApproval = true;
    reason =
      'no holdout available: every non-winning creative is spent or killed, so this step would put the whole budget behind one creative';
    warnings.push(
      `Generate new variants before scaling again - a cohort with no test budget cannot find its own replacement.`,
    );
  }

  return {
    proposedDailyMinor: proposed,
    provenDailyMinor: proposed - holdoutDailyMinor,
    holdoutDailyMinor,
    holdoutAdIds,
    needsApproval,
    reason,
    warnings,
  };
}

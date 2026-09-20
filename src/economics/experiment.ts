import type { Economics } from '../core/types.ts';

/**
 * Is the difference between these creatives real, or is it noise?
 *
 * Nothing asked that before. Creatives were judged against absolute targets -
 * CPL under this, ROAS over that - which is the right test for "is this working
 * at all". It is the wrong test for "which of these is better", and the system
 * acts on the second question every time it concentrates budget behind a
 * winner. On the sample sizes this runs at, that judgement is usually being
 * made on a handful of leads.
 *
 * Two creatives, 20 leads each, one sale against two. The second looks twice as
 * good and the difference is nothing at all: with numbers that small, that gap
 * arrives by chance most of the time. Scaling onto it puts the whole budget
 * behind a coin that happened to land heads twice.
 *
 * ## The test, and why this one
 *
 * Each variant gets a Wilson score interval for its conversion rate - a range
 * the true rate plausibly lies in, given how few observations there are. A
 * winner is declared only when the leader's interval does not overlap the
 * runner-up's.
 *
 * Wilson rather than the textbook normal interval because the normal one is
 * badly behaved exactly where this operates: at small n, and at rates near zero
 * where most of these sit. It gives intervals that run below zero and it is too
 * narrow when there are no conversions at all - which would manufacture
 * confidence precisely when there is least reason for any.
 *
 * Non-overlap rather than a two-sample test because it is **deliberately
 * conservative**: two intervals can fail to overlap only when a proper test
 * would also find a difference, but not the reverse. It will sometimes say
 * "cannot tell yet" about a difference that is real. That is the error worth
 * preferring - the cost is waiting for more data, and the cost the other way is
 * spending the whole budget on the wrong creative.
 *
 * None of this makes a small sample big. It reports honestly on what is there.
 */

/** 95%. Deliberately not configurable: a tunable confidence is a tunable excuse. */
const Z = 1.96;

export interface VariantResult {
  adId: string;
  creativeId: string;
  /** Leads that have been dialled and come back - the population it can judge. */
  trials: number;
  conversions: number;
  rate: number;
  /** The range the true rate plausibly lies in, given this many observations. */
  low: number;
  high: number;
}

export type ExperimentVerdict =
  | { kind: 'too_early'; reason: string }
  | { kind: 'inconclusive'; reason: string; leader: VariantResult; runnerUp: VariantResult }
  | { kind: 'winner'; reason: string; leader: VariantResult; runnerUp: VariantResult };

export interface ExperimentReport {
  variants: VariantResult[];
  verdict: ExperimentVerdict;
  /** What the run is comparing on. */
  metric: 'sales per lead' | 'qualified per lead';
}

export interface ExperimentOptions {
  /** Observations a variant needs before it is compared at all. */
  minTrialsPerVariant?: number;
}

/**
 * Wilson score interval.
 *
 * Verified against published values: 0 conversions in 10 trials gives
 * [0, 0.278], which the normal approximation renders as [0, 0] - a claim of
 * certainty from no evidence.
 */
export function wilson(conversions: number, trials: number): { low: number; high: number } {
  if (trials <= 0) return { low: 0, high: 1 };
  const p = conversions / trials;
  const z2 = Z * Z;
  const denominator = 1 + z2 / trials;
  const centre = (p + z2 / (2 * trials)) / denominator;
  const spread = (Z / denominator) * Math.sqrt((p * (1 - p)) / trials + z2 / (4 * trials * trials));
  return { low: Math.max(0, centre - spread), high: Math.min(1, centre + spread) };
}

/**
 * Compare the creatives on a run.
 *
 * Judged on outcomes that have actually come back, not on leads captured: a
 * lead still waiting for a call says nothing about the creative that produced
 * it, and counting it as a non-conversion would penalise whichever variant
 * happened to deliver most recently.
 */
export function analyseExperiment(
  perAd: Array<{ adId: string; creativeId: string; economics: Economics }>,
  options: ExperimentOptions = {},
): ExperimentReport {
  const minTrials = options.minTrialsPerVariant ?? 10;

  // Sales are what the system optimises for. Until any exist, qualified leads
  // are the best-correlated thing that moves at this sample size - and the
  // report says which is being used rather than quietly switching.
  const anySales = perAd.some((a) => a.economics.sales > 0);
  const metric = anySales ? ('sales per lead' as const) : ('qualified per lead' as const);

  const variants: VariantResult[] = perAd
    .map((a) => {
      const trials = a.economics.calledLeads;
      const conversions = anySales ? a.economics.sales : a.economics.qualifiedLeads;
      const { low, high } = wilson(conversions, trials);
      return {
        adId: a.adId,
        creativeId: a.creativeId,
        trials,
        conversions,
        rate: trials > 0 ? conversions / trials : 0,
        low,
        high,
      };
    })
    .sort((a, b) => b.rate - a.rate || b.trials - a.trials);

  const comparable = variants.filter((v) => v.trials >= minTrials);
  if (comparable.length < 2) {
    return {
      variants,
      metric,
      verdict: {
        kind: 'too_early',
        reason:
          `fewer than two creatives have ${minTrials} call outcomes back ` +
          `(${variants.map((v) => `${v.conversions}/${v.trials}`).join(', ')})`,
      },
    };
  }

  const leader = comparable[0]!;
  const runnerUp = comparable[1]!;

  // Against the WHOLE field, not just whichever sorted second. Comparing only
  // to comparable[1] let the tiebreaker pick the tightest interval among equal
  // rates - the easiest opponent - so a winner could be declared while a third
  // variant still overlapped the leader. "The ranges do not overlap" is a claim
  // about the set, and this is what makes it one.
  const highestOther = Math.max(...comparable.slice(1).map((v) => v.high));
  if (leader.low > highestOther) {
    return {
      variants,
      metric,
      verdict: {
        kind: 'winner',
        reason:
          `${pct(leader.rate)} (${leader.conversions}/${leader.trials}) against ` +
          `${pct(runnerUp.rate)} (${runnerUp.conversions}/${runnerUp.trials}); the ranges do not overlap`,
        leader,
        runnerUp,
      },
    };
  }

  return {
    variants,
    metric,
    verdict: {
      kind: 'inconclusive',
      reason:
        `${pct(leader.rate)} (${leader.conversions}/${leader.trials}) against ` +
        `${pct(runnerUp.rate)} (${runnerUp.conversions}/${runnerUp.trials}), but the ranges overlap ` +
        `[${pct(leader.low)}-${pct(leader.high)}] and [${pct(runnerUp.low)}-${pct(runnerUp.high)}] - ` +
        `this gap is what chance looks like at this sample size`,
      leader,
      runnerUp,
    },
  };
}

function pct(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`;
}

/** One line per variant, for `review` and the cycle log. */
export function formatExperiment(report: ExperimentReport): string {
  const lines = [`  comparing on ${report.metric}`];
  for (const v of report.variants) {
    lines.push(
      `    ${v.adId.padEnd(24)} ${String(v.conversions)}/${String(v.trials)} = ${pct(v.rate)}  ` +
        `plausible range ${pct(v.low)}-${pct(v.high)}`,
    );
  }
  lines.push(`    verdict: ${report.verdict.kind.replace('_', ' ')} - ${report.verdict.reason}`);
  return lines.join('\n');
}

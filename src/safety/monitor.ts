import type { Context } from '../orchestrator.ts';
import { money } from '../core/util.ts';
import { log } from '../core/log.ts';

/**
 * The fast safety loop.
 *
 * Separate from the evaluation cycle on purpose. The cycle asks "is this
 * campaign working" and that question is worth answering slowly and on plenty
 * of data. This asks "is something going wrong right now", which is worth
 * answering every minute and on almost none.
 *
 * Running both on one timer is what made the stop-loss weak: it was checked
 * once per evaluation interval, so at 24 hours a run could pass its loss limit
 * and keep spending for most of a day before anything noticed.
 *
 * Every check here is a read. The only thing this loop can change is the
 * emergency stop, and engaging that stops *this system* acting - it does not
 * pause anything at Meta, because spend there continues under the ad set's own
 * daily budget and end date regardless of what this process does.
 */

export type Severity = 'ok' | 'warn' | 'stop';

export interface SafetyFinding {
  check: string;
  severity: Severity;
  detail: string;
  evidence: Record<string, unknown>;
}

export interface SafetyReport {
  findings: SafetyFinding[];
  /** Findings that warrant halting autonomous mutation. */
  stops: SafetyFinding[];
  engaged: boolean;
}

export interface SafetyOptions {
  /** How far back to count webhook failures. Defaults to fifteen minutes. */
  windowMs?: number;
  /** Failures inside the window before this is treated as an outage. */
  webhookFailureThreshold?: number;
  now?: Date;
}

/**
 * Read the world and decide whether anything should stop it.
 *
 * Returns findings rather than acting, so the same checks can back a health
 * endpoint and a dry run without engaging anything.
 */
export function inspectSafety(ctx: Context, options: SafetyOptions = {}): SafetyReport {
  const at = options.now ?? new Date();
  const windowMs = options.windowMs ?? 15 * 60_000;
  const failureThreshold = options.webhookFailureThreshold ?? 5;
  const g = ctx.guardrails;
  const findings: SafetyFinding[] = [];

  // --- spend against the limits that bound the experiment -----------------
  for (const run of ctx.store.listRuns().filter((r) => r.state === 'live')) {
    const spent = ctx.store.totalSpendMinor(run.runId);
    const revenue = ctx.store.revenueMinor(run.runId);
    const netLoss = spent - revenue;

    if (netLoss >= g.stopLossMinor) {
      findings.push({
        check: 'stop-loss',
        severity: 'stop',
        detail: `run ${run.runId} has lost ${money(netLoss, g.currency)} against a stop-loss of ${money(g.stopLossMinor, g.currency)}`,
        evidence: { runId: run.runId, spentMinor: spent, revenueMinor: revenue, netLossMinor: netLoss },
      });
    }

    if (spent > g.maxTestBudgetMinor) {
      findings.push({
        check: 'test budget',
        severity: 'stop',
        detail: `run ${run.runId} has spent ${money(spent, g.currency)} against a test budget of ${money(g.maxTestBudgetMinor, g.currency)}`,
        evidence: { runId: run.runId, spentMinor: spent, capMinor: g.maxTestBudgetMinor },
      });
    } else if (spent > g.maxTestBudgetMinor * 0.8) {
      findings.push({
        check: 'test budget',
        severity: 'warn',
        detail: `run ${run.runId} has spent ${money(spent, g.currency)} of ${money(g.maxTestBudgetMinor, g.currency)}`,
        evidence: { runId: run.runId, spentMinor: spent, capMinor: g.maxTestBudgetMinor },
      });
    }
  }

  // --- inbound webhook health ---------------------------------------------
  const since = new Date(at.getTime() - windowMs).toISOString();
  // Rejections are reported and never stop anything. Letting an unauthenticated
  // caller engage the emergency stop by posting garbage is a remote halt, which
  // is exactly what counting them here used to allow.
  const rejections = ctx.store.webhookRejectionsSince(since);
  if (rejections >= failureThreshold) {
    findings.push({
      check: 'webhook signatures',
      severity: 'warn',
      detail: `${rejections} delivery(s) refused at the signature in the last ${Math.round(windowMs / 60_000)} minutes - a wrong secret, or somebody probing`,
      evidence: { rejections, since },
    });
  }

  const failures = ctx.store.webhookFailuresSince(since);
  if (failures >= failureThreshold) {
    // Revenue and opt-outs both arrive by webhook. Deciding anything while
    // those are not landing means deciding on a funnel that looks worse than
    // it is - and dialling people who have asked not to be called.
    findings.push({
      check: 'webhooks',
      severity: 'stop',
      detail: `${failures} verified webhook deliveries failed to process in the last ${Math.round(windowMs / 60_000)} minutes`,
      evidence: { failures, windowMinutes: Math.round(windowMs / 60_000), since },
    });
  } else if (failures > 0) {
    findings.push({
      check: 'webhooks',
      severity: 'warn',
      detail: `${failures} webhook delivery(s) failed recently`,
      evidence: { failures, since },
    });
  }

  // --- a cycle that keeps failing -----------------------------------------
  const recentCycles = ctx.store.recentCycles(10);
  const errored = recentCycles.filter((c) => c.status === 'error');
  if (recentCycles.length >= 3 && errored.length === recentCycles.length) {
    findings.push({
      check: 'evaluation cycle',
      severity: 'stop',
      detail: `the last ${recentCycles.length} evaluation cycles all failed`,
      evidence: { cycles: recentCycles.length, reasons: errored.slice(0, 3).map((c) => c.detail) },
    });
  }

  const stops = findings.filter((f) => f.severity === 'stop');
  return { findings, stops, engaged: ctx.store.emergencyStop().engaged };
}

/**
 * Inspect, and engage the emergency stop if anything warrants it.
 *
 * Engaging is one-way from here: releasing is a person's decision, because a
 * trigger that clears on its own would let the system resume spending without
 * anyone having looked at why it stopped.
 */
export function runSafetyCheck(ctx: Context, options: SafetyOptions = {}): SafetyReport {
  const report = inspectSafety(ctx, options);
  if (report.stops.length === 0 || report.engaged) return report;

  const first = report.stops[0]!;
  const engaged = ctx.store.engageEmergencyStop({
    trigger: first.check,
    reason: first.detail,
    detail: { findings: report.stops.map((f) => ({ check: f.check, detail: f.detail, evidence: f.evidence })) },
    by: 'safety-loop',
  });
  if (engaged) {
    log.error('emergency_stop.engaged', {
      trigger: first.check,
      reason: first.detail,
      findings: report.stops.length,
    });
    ctx.store.audit(null, 'system', 'emergency_stop.engaged', {
      trigger: first.check,
      reason: first.detail,
      findings: report.stops.length,
    });
  }
  return { ...report, engaged: true };
}

/** Human-readable, for the CLI and for whatever eventually renders a page. */
export function formatSafety(report: SafetyReport): string {
  const mark = { ok: 'OK  ', warn: 'WARN', stop: 'STOP' };
  const lines = report.findings.map((f) => `  ${mark[f.severity]} ${f.check.padEnd(18)} ${f.detail}`);
  if (lines.length === 0) lines.push('  OK   nothing to report');
  return lines.join('\n');
}

/** Triggers that mean money is being lost, not that something is misbehaving. */
const SPEND_TRIGGERS = new Set(['stop-loss', 'test budget']);

/**
 * Engage the stop, and for a spend trigger actually stop the spend.
 *
 * The emergency stop halts *this system*. On its own that was worse than
 * useless for a stop-loss: the safety loop runs every minute and the evaluation
 * cycle every twenty-four hours, so the loop always tripped first, `runCycle`
 * then skipped because the stop was engaged, and the KILL branch in `apply`
 * that pauses the campaign at Meta was never reached. The stop-loss fired, the
 * system went quiet, and the ad set kept spending to its own end date.
 *
 * So the loop pauses the campaign itself. This is the one outward action the
 * safety path takes, and it is only ever a pause - never a resume, never a
 * budget change.
 */
export async function enforceSafety(ctx: Context, options: SafetyOptions = {}): Promise<SafetyReport> {
  const before = ctx.store.emergencyStop().engaged;
  const report = runSafetyCheck(ctx, options);
  if (!report.engaged || before) return report;

  const trigger = ctx.store.emergencyStop().trigger ?? '';
  if (!SPEND_TRIGGERS.has(trigger)) return report;

  for (const run of ctx.store.listRuns().filter((r) => r.state === 'live')) {
    const campaign = ctx.store.getCampaign(run.runId);
    if (!campaign || campaign.status === 'PAUSED') continue;
    try {
      await ctx.meta.setStatus(campaign.campaignId, 'PAUSED');
      ctx.store.setCampaignStatus(campaign.campaignId, 'PAUSED');
      ctx.store.setRunState(run.runId, 'paused', `safety loop: ${trigger}`);
      ctx.store.audit(run.runId, 'system', 'campaign.paused', { reason: trigger, by: 'safety-loop' });
      log.warn('safety.campaign_paused', { runId: run.runId, campaignId: campaign.campaignId, trigger });
    } catch (err) {
      // Worth an audit row and a loud log, not a throw: the stop is engaged
      // either way, and a provider outage must not stop the loop running.
      ctx.store.audit(run.runId, 'system', 'campaign.pause_failed', {
        reason: trigger,
        error: (err as Error).message,
      });
      log.error('safety.pause_failed', { runId: run.runId, error: (err as Error).message });
    }
  }
  return report;
}

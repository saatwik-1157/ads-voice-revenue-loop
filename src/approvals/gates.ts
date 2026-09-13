import type { Store } from '../store/db.ts';
import type { Brief } from '../core/types.ts';
import type { Guardrails } from '../config/guardrails.ts';
import { money } from '../core/util.ts';
import { checkClaims, checkPromiseAlignment } from '../brief/claims.ts';

export const GATE_1 = 'gate1_publish';
export const GATE_2 = 'gate2_material_change';

export interface GateRequest {
  approvalId: string;
  gate: string;
  summary: string;
  /** Hard problems with the brief. The gate cannot be approved past these. */
  blocking: string[];
  /**
   * Ambiguous exclusion matches. These are a judgement call, not a defect - the
   * approver is being asked to confirm them, which is the whole reason the
   * classifier has a third outcome instead of guessing.
   */
  reviewFlags: string[];
}

/**
 * Human gate #1 - before first publish.
 *
 * Approve niche, claims, offer, creative and initial budget. Anything in
 * `blocking` is a hard problem with the brief itself: the gate can be opened
 * only after the brief is regenerated, not by approving past it.
 */
export function requestGate1(
  store: Store,
  g: Guardrails,
  runId: string,
  brief: Brief,
  dailyBudgetMinor: number,
  reviewFlags: string[] = [],
): GateRequest {
  const claimIssues = checkClaims(brief, g);
  const drift = checkPromiseAlignment(brief);
  const blocking = [
    ...claimIssues.map((i) => `unsupported claim in ${i.field}: "${i.pattern}"`),
    ...drift,
  ];

  const summary = [
    `Niche:   ${brief.niche.name} (score ${brief.niche.score})`,
    `ICP:     ${brief.offer.icp}`,
    `Offer:   ${brief.offer.outcome}`,
    `CTA:     ${brief.offer.cta}`,
    `Promise: ${brief.offer.deliverable}`,
    `Budget:  ${money(dailyBudgetMinor, g.currency)}/day, test cap ${money(g.maxTestBudgetMinor, g.currency)}`,
    `Geo:     ${g.allowedGeos.join(', ')}`,
    `Creative: ${brief.creatives.length} variants (${new Set(brief.creatives.map((c) => c.angle)).size} angles)`,
    `Target:  CPL <= ${money(brief.successMetrics.targetCplMinor, g.currency)}, ROAS >= ${brief.successMetrics.targetRoas}`,
  ].join('\n');

  const full = reviewFlags.length
    ? [
        summary,
        '',
        `CONFIRM: ${reviewFlags.length} ambiguous exclusion match(es) - approve only if none describes the offer:`,
        ...reviewFlags.map((f) => `  - ${f}`),
      ].join('\n')
    : summary;

  const approvalId = store.requestApproval(
    runId,
    GATE_1,
    'Publish first test campaign',
    JSON.stringify({ summary: full, blocking, reviewFlags }),
  );
  store.setRunState(runId, 'awaiting_gate1');
  store.audit(runId, 'agent', 'gate1.requested', { approvalId, blocking, reviewFlags });
  return { approvalId, gate: GATE_1, summary: full, blocking, reviewFlags };
}

/**
 * Human gate #2 - material change after launch.
 *
 * Required for budget increases past the threshold, new claims, new geography,
 * a new audience class, or a major offer change. The agent can iterate creative
 * and reallocate inside the existing cap without this.
 */
export function requestGate2(store: Store, runId: string, subject: string, detail: Record<string, unknown>): GateRequest {
  const approvalId = store.requestApproval(runId, GATE_2, subject, JSON.stringify(detail));
  store.audit(runId, 'agent', 'gate2.requested', { approvalId, subject, detail });
  return { approvalId, gate: GATE_2, summary: subject, blocking: [], reviewFlags: [] };
}

export function approve(store: Store, approvalId: string, approver: string): boolean {
  const ok = store.decideApproval(approvalId, 'approved', approver);
  if (ok) store.audit(null, 'human', 'approval.granted', { approvalId, approver });
  return ok;
}

export function reject(store: Store, approvalId: string, approver: string, reason: string): boolean {
  const ok = store.decideApproval(approvalId, 'rejected', approver);
  if (ok) store.audit(null, 'human', 'approval.rejected', { approvalId, approver, reason });
  return ok;
}

/**
 * Does this budget change need a human?
 *
 * Two independent triggers: stepping up faster than the allowed factor, or
 * crossing the absolute approval threshold. Proven profitability lets the agent
 * move inside the step factor - it never lets it past the threshold.
 */
export function budgetChangeNeedsApproval(
  g: Guardrails,
  currentDailyMinor: number,
  proposedDailyMinor: number,
): { needed: boolean; reason: string } {
  if (proposedDailyMinor <= currentDailyMinor) return { needed: false, reason: 'decrease or no change' };
  if (proposedDailyMinor > g.budgetApprovalThresholdMinor) {
    return {
      needed: true,
      reason: `proposed ${money(proposedDailyMinor, g.currency)} exceeds approval threshold ${money(g.budgetApprovalThresholdMinor, g.currency)}`,
    };
  }
  if (proposedDailyMinor > Math.round(currentDailyMinor * g.maxBudgetStepFactor)) {
    return {
      needed: true,
      reason: `step from ${money(currentDailyMinor, g.currency)} to ${money(proposedDailyMinor, g.currency)} exceeds max step factor ${g.maxBudgetStepFactor}x`,
    };
  }
  return { needed: false, reason: 'within approved step' };
}

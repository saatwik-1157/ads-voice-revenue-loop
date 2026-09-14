import type { Store } from '../store/db.ts';
import type { Brief } from '../core/types.ts';
import { GuardrailViolation, type Guardrails } from '../config/guardrails.ts';
import { money } from '../core/util.ts';
import { checkClaims, checkPromiseAlignment } from '../brief/claims.ts';
import { hasGeneratedArtwork } from '../creative/pipeline.ts';

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
    `Artwork: ${describeArtwork(brief)}`,
    `Target:  CPL <= ${money(brief.successMetrics.targetCplMinor, g.currency)}, ROAS >= ${brief.successMetrics.targetRoas}`,
  ].join('\n');

  // Approving spend without knowing the imagery was machine-generated is
  // exactly the kind of thing a gate exists to prevent.
  const flags = hasGeneratedArtwork(brief)
    ? [...reviewFlags, 'artwork is auto-generated, not cleared by a person - look at the previews before approving']
    : reviewFlags;

  const full = flags.length
    ? [
        summary,
        '',
        `CONFIRM before approving (${flags.length}):`,
        ...flags.map((f) => `  - ${f}`),
      ].join('\n')
    : summary;

  const approvalId = store.requestApproval(
    runId,
    GATE_1,
    'Publish first test campaign',
    JSON.stringify({ summary: full, blocking, reviewFlags: flags }),
  );
  store.setRunState(runId, 'awaiting_gate1');
  store.audit(runId, 'agent', 'gate1.requested', { approvalId, blocking, reviewFlags: flags });
  return { approvalId, gate: GATE_1, summary: full, blocking, reviewFlags: flags };
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

function describeArtwork(brief: Brief): string {
  const counts = new Map<string, number>();
  for (const creative of brief.creatives) {
    const key = creative.assetProvenance ?? 'not yet produced';
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts].map(([key, count]) => `${count} ${key}`).join(', ');
}

/**
 * Who decided, recorded against the run they decided about.
 *
 * These two rows are the entire point of having human gates, and they were
 * being written with a null run id - which `WHERE run_id = ?` can never match.
 * The record of who authorised the money existed and could not be read back.
 */
export function approve(store: Store, approvalId: string, approver: string): boolean {
  const approval = store.getApproval(approvalId);

  // "The gate can be opened only after the brief is regenerated, not by
  // approving past it" was the documented rule, and nothing implemented it.
  // A brief promising "guaranteed results" was flagged here, approved, and
  // published. Refusing at the gate is where the operator is standing; publish
  // re-checks the brief itself, because an approval ages and a brief can change.
  const blocking = blockingIssues(approval?.detail);
  if (blocking.length) {
    throw new GuardrailViolation(
      'blocking_brief',
      `approval ${approvalId} has ${blocking.length} blocking issue(s) and cannot be granted:\n  - ${blocking.join('\n  - ')}\nRegenerate the brief; this is not a judgement call.`,
    );
  }

  const ok = store.decideApproval(approvalId, 'approved', approver);
  if (ok) store.audit(approval?.runId ?? null, 'human', 'approval.granted', { approvalId, approver });
  return ok;
}

/** The blocking list recorded when the gate was opened, if it is still readable. */
function blockingIssues(detail: string | null | undefined): string[] {
  if (!detail) return [];
  try {
    const parsed = JSON.parse(detail) as { blocking?: unknown };
    return Array.isArray(parsed.blocking) ? parsed.blocking.filter((b): b is string => typeof b === 'string') : [];
  } catch {
    // Unreadable detail must not read as "no problems found".
    return ['approval detail could not be parsed, so its blocking issues cannot be confirmed'];
  }
}

export function reject(store: Store, approvalId: string, approver: string, reason: string): boolean {
  const runId = store.approvalRun(approvalId);
  const ok = store.decideApproval(approvalId, 'rejected', approver);
  if (ok) store.audit(runId, 'human', 'approval.rejected', { approvalId, approver, reason });
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

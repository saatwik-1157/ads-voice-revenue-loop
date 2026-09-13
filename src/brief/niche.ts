import type { NicheCandidate, ScoredNiche } from '../core/types.ts';
import { exclusionRules, type Guardrails } from '../config/guardrails.ts';
import { classifyFields, describeMatch } from '../config/exclusions.ts';

/**
 * Step 01 of the playbook: score niches, pick one.
 *
 * The weights encode what actually matters for a phone-closed offer bought from
 * a cold ad: someone has to want it now (urgency), it has to be worth calling
 * about (ticket size), and it has to be closeable in a single call without a
 * site visit or a committee.
 */
export const WEIGHTS = {
  urgency: 0.28,
  ticketSize: 0.22,
  phoneCloseable: 0.24,
  reachability: 0.14,
  offerSimplicity: 0.12,
} as const;

export function scoreNiche(candidate: NicheCandidate): ScoredNiche {
  const breakdown: Record<string, number> = {};
  let score = 0;
  for (const [axis, weight] of Object.entries(WEIGHTS)) {
    const raw = clamp1to5(candidate[axis as keyof typeof WEIGHTS]);
    const contribution = (raw / 5) * weight * 100;
    breakdown[axis] = Number(contribution.toFixed(2));
    score += contribution;
  }
  return { ...candidate, score: Number(score.toFixed(2)), breakdown };
}

export interface NichePick {
  chosen: ScoredNiche;
  ranked: ScoredNiche[];
  rejected: Array<{ name: string; reason: string }>;
  /**
   * Ambiguous matches on the chosen niche. Not a rejection - gate #1 shows
   * these to the person approving the campaign.
   */
  reviewFlags: string[];
}

/**
 * Rank candidates and return the best one the exclusion rules permit.
 *
 * A hard-blocked niche is dropped here, so an off-limits market never reaches a
 * human for approval. An ambiguous one is kept and flagged instead - dropping it
 * would quietly lose legitimate business, and the approval gate is the right
 * place for a judgement call.
 */
export function pickNiche(candidates: NicheCandidate[], g: Guardrails): NichePick {
  const rejected: Array<{ name: string; reason: string }> = [];
  const eligible: Array<{ candidate: NicheCandidate; flags: string[] }> = [];

  for (const c of candidates) {
    // The niche's name and offer describe what is being sold; the notes are the
    // agent's own commentary about it, so a term there is weaker evidence and
    // classifyFields caps it at review rather than blocking.
    const { verdict, matches } = classifyFields(
      [
        ['name', c.name],
        ['notes', c.notes],
      ],
      exclusionRules(g),
    );

    if (verdict === 'blocked') {
      const blocking = matches.filter((m) => m.severity === 'block');
      rejected.push({ name: c.name, reason: blocking.map(describeMatch).join('; ') });
      continue;
    }
    eligible.push({ candidate: c, flags: matches.map(describeMatch) });
  }

  if (eligible.length === 0) {
    throw new Error(
      `No eligible niche candidates. All ${candidates.length} were excluded by guardrails:\n` +
        rejected.map((r) => ` - ${r.name}: ${r.reason}`).join('\n'),
    );
  }

  const scored = eligible
    .map((entry) => ({ scored: scoreNiche(entry.candidate), flags: entry.flags }))
    .sort((a, b) => b.scored.score - a.scored.score);
  const winner = scored[0]!;

  return {
    chosen: winner.scored,
    ranked: scored.map((entry) => entry.scored),
    rejected,
    reviewFlags: winner.flags,
  };
}

function clamp1to5(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.min(5, Math.max(1, value));
}

/**
 * Starting candidate set for a local-services, phone-closed market boundary.
 * These are seeds for the agent to re-score, not a fixed menu - replace them
 * for your own market boundary.
 */
export const SEED_CANDIDATES: NicheCandidate[] = [
  {
    name: 'Commercial kitchen deep-clean for restaurants',
    urgency: 4,
    ticketSize: 4,
    phoneCloseable: 4,
    reachability: 4,
    offerSimplicity: 5,
    notes: 'Failed hygiene audits and pre-inspection panic create a now-problem with a fixed scope.',
  },
  {
    name: 'Emergency AC repair for small offices',
    urgency: 5,
    ticketSize: 3,
    phoneCloseable: 5,
    reachability: 4,
    offerSimplicity: 5,
    notes: 'Highest urgency, smallest ticket; connect speed is the whole game.',
  },
  {
    name: 'Dental clinic patient-reactivation campaigns',
    urgency: 2,
    ticketSize: 5,
    phoneCloseable: 3,
    reachability: 3,
    offerSimplicity: 3,
    notes: 'Good ticket, slow decision cycle, and clinical claims need care.',
  },
  {
    name: 'Solar panel cleaning and output audit for housing societies',
    urgency: 3,
    ticketSize: 4,
    phoneCloseable: 4,
    reachability: 3,
    offerSimplicity: 4,
    notes: 'Measurable outcome (kWh recovered) makes proof easy; committee buying slows the close.',
  },
  {
    name: 'GST filing cleanup for small traders',
    urgency: 4,
    ticketSize: 3,
    phoneCloseable: 4,
    reachability: 5,
    offerSimplicity: 4,
    notes: 'Deadline-driven urgency; avoid any outcome promises about penalties or refunds.',
  },
];

/**
 * Niche exclusions.
 *
 * A flat substring list gets this wrong in both directions. "Solar panel
 * cleaning for housing societies" is not a housing ad - "housing" there names
 * the customer, not the offer - and a bare `includes('loan')` also fires on
 * "Sloan". Meanwhile a genuine "home loan" offer needs to be stopped cold.
 *
 * So rules are structured, matched on word boundaries, and carry three
 * outcomes rather than two. `block` is a hard stop. `review` means the match is
 * real but ambiguous, and the decision belongs to the human at gate #1 - which
 * this system already has, so there is no reason to force a guess here.
 */

export type ExclusionSeverity = 'block' | 'review';

export interface ExclusionRule {
  id: string;
  /** Why this exists, shown to whoever has to act on the match. */
  reason: string;
  severity: ExclusionSeverity;
  /**
   * Matched on word boundaries, case-insensitively, with a tolerated plural.
   * Multi-word terms match as phrases with flexible whitespace.
   */
  terms: string[];
  /**
   * Phrases that make a term benign. These are masked out of the text before
   * the terms are matched, so "housing society" stops "housing" from firing
   * without stopping it anywhere else in the same sentence.
   */
  exemptions?: string[];
}

export interface ExclusionMatch {
  ruleId: string;
  term: string;
  reason: string;
  severity: ExclusionSeverity;
  /** Where the match was found. Commentary is weaker evidence than the name. */
  source: MatchSource;
}

export type MatchSource = 'name' | 'offer' | 'notes';
export type Verdict = 'allowed' | 'review' | 'blocked';

export interface Classification {
  verdict: Verdict;
  matches: ExclusionMatch[];
}

/**
 * Meta's special ad categories (credit, employment, housing, social issues) plus
 * the verticals this operator will not sell into.
 *
 * The split between `block` and `review` inside one category is deliberate: a
 * term that names a restricted *offer* blocks, a term that merely sits near one
 * gets a human.
 */
export const DEFAULT_EXCLUSION_RULES: ExclusionRule[] = [
  {
    id: 'credit_offer',
    reason: 'Meta special ad category: credit. Lending offers need the category declared and restricted targeting.',
    severity: 'block',
    terms: [
      'loan',
      'payday',
      'credit card',
      'credit repair',
      'credit score',
      'debt consolidation',
      'debt relief',
      'refinance',
      'mortgage',
      'line of credit',
      'buy now pay later',
    ],
  },
  {
    id: 'credit_adjacent',
    reason: 'Sits next to the credit category. Confirm the offer is not a lending product.',
    severity: 'review',
    terms: ['credit', 'lending', 'financing'],
    // A no-cost EMI or a financing *option* on a normal purchase is not a credit offer.
    exemptions: ['no cost emi', 'no-cost emi', 'emi option', 'tax credit', 'credit note'],
  },
  {
    id: 'housing_offer',
    reason: 'Meta special ad category: housing. Listings and tenancy offers need the category declared.',
    severity: 'block',
    terms: [
      'rental listing',
      'apartment listing',
      'property listing',
      'real estate listing',
      'property for sale',
      'flat for sale',
      'house for sale',
      'rent to own',
      'tenant screening',
      'home loan',
    ],
  },
  {
    id: 'housing_adjacent',
    reason: 'Mentions housing. Confirm this sells a service to residents rather than advertising housing itself.',
    severity: 'review',
    terms: ['housing', 'real estate', 'tenancy'],
    // A housing society (or RWA) is a customer segment - an apartment complex
    // buying a service - not a housing opportunity being advertised.
    exemptions: ['housing society', 'housing complex', 'housing board', 'housing association', 'housing colony'],
  },
  {
    id: 'employment_offer',
    reason: 'Meta special ad category: employment. Job ads need the category declared.',
    severity: 'block',
    terms: ['job opening', 'job vacancy', 'now hiring', 'hiring for', 'recruitment drive', 'apply for a job', 'job placement'],
  },
  {
    id: 'employment_adjacent',
    reason: 'Mentions employment. Confirm this is not advertising a job or a placement service.',
    severity: 'review',
    terms: ['employment', 'hiring', 'recruiting', 'vacancy'],
    // Recruiting *services sold to an employer* are a B2B offer, not a job ad.
    exemptions: ['hiring manager', 'recruiting software', 'recruiting agency software'],
  },
  {
    id: 'politics',
    reason: 'Meta special ad category: social issues, elections and politics. Requires authorization.',
    severity: 'block',
    terms: ['political', 'election', 'campaign rally', 'vote for', 'candidate for office', 'ballot'],
  },
  {
    id: 'regulated_financial',
    reason: 'Regulated financial product. Needs licensing and Meta authorization this operator does not have.',
    severity: 'block',
    terms: [
      'insurance',
      'crypto trading signal',
      'cryptocurrency investment',
      'forex signal',
      'assured return',
      'guaranteed return',
      'stock tip',
      'investment advice',
    ],
  },
  {
    id: 'gambling',
    reason: 'Gambling and real-money gaming are restricted and need per-market authorization.',
    severity: 'block',
    terms: ['gambling', 'casino', 'betting', 'lottery', 'rummy cash', 'poker cash'],
  },
  {
    id: 'medical_claims',
    reason: 'Medical outcome claims cannot be substantiated by this operator.',
    severity: 'block',
    terms: ['cure', 'medical treatment', 'miracle', 'clinical trial', 'prescription drug', 'covid'],
  },
  {
    id: 'health_adjacent',
    reason: 'Health or body-image adjacent. Meta restricts these and the claims need substantiating.',
    severity: 'review',
    terms: ['weight loss', 'fat loss', 'supplement', 'therapy', 'clinic', 'dental', 'cosmetic'],
  },
  {
    id: 'immigration',
    reason: 'Immigration outcomes cannot be promised and the vertical attracts fraud scrutiny.',
    severity: 'block',
    terms: ['visa approval', 'green card', 'immigration guarantee', 'pr application', 'work permit'],
  },
];

/**
 * Build a word-boundary matcher that tolerates a plural and flexible spacing.
 *
 * The y->ies case matters more than it looks: "housing society" has to match
 * "housing societies", or the exemption that makes this whole fix work never
 * fires.
 */
export function termPattern(term: string): RegExp {
  const words = term.trim().toLowerCase().split(/\s+/).filter(Boolean);
  // Every word gets the tolerance, not just the last one: the inflected word in
  // "flats for sale" is the first, and in "housing societies" it is the second.
  const pattern = words.map(pluralizeWord).join('\\s+');
  return new RegExp(`\\b${pattern}\\b`, 'i');
}

/** Function words are never inflected, so leave them alone. */
const UNINFLECTED = new Set(['for', 'of', 'to', 'in', 'on', 'at', 'a', 'an', 'the', 'and', 'or', 'with', 'by', 'from']);

function pluralizeWord(word: string): string {
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (UNINFLECTED.has(word)) return escaped;
  if (escaped.endsWith('y')) return `${escaped.slice(0, -1)}(?:y|ies)`;
  return `${escaped}(?:e?s)?`;
}

/** Replace exemption phrases with blanks so the terms inside them cannot fire. */
function maskExemptions(text: string, exemptions: string[] | undefined): string {
  if (!exemptions?.length) return text;
  let masked = text;
  for (const phrase of exemptions) {
    const pattern = new RegExp(termPattern(phrase).source, 'gi');
    masked = masked.replace(pattern, (found) => ' '.repeat(found.length));
  }
  return masked;
}

/**
 * Classify one piece of text against the rules.
 *
 * `source` matters: a restricted term in the agent's own commentary about a
 * niche ("avoid clinical claims here") is not the same as one in the niche's
 * name, so a notes-only match is capped at `review` rather than blocking.
 */
export function classifyText(text: string, rules: ExclusionRule[], source: MatchSource = 'name'): Classification {
  const matches: ExclusionMatch[] = [];
  const subject = (text ?? '').toLowerCase();

  for (const rule of rules) {
    const searchable = maskExemptions(subject, rule.exemptions);
    for (const term of rule.terms) {
      if (!termPattern(term).test(searchable)) continue;
      const severity: ExclusionSeverity = source === 'notes' ? 'review' : rule.severity;
      matches.push({ ruleId: rule.id, term, reason: rule.reason, severity, source });
    }
  }

  return { verdict: verdictFor(matches), matches };
}

export function verdictFor(matches: ExclusionMatch[]): Verdict {
  if (matches.some((m) => m.severity === 'block')) return 'blocked';
  if (matches.length > 0) return 'review';
  return 'allowed';
}

/** Classify several fields at once, keeping the strongest verdict. */
export function classifyFields(fields: Array<[MatchSource, string]>, rules: ExclusionRule[]): Classification {
  const matches = fields.flatMap(([source, text]) => classifyText(text, rules, source).matches);
  return { verdict: verdictFor(matches), matches };
}

export function describeMatch(match: ExclusionMatch): string {
  return `"${match.term}" in ${match.source} [${match.ruleId}] - ${match.reason}`;
}

/** Operator-supplied plain terms from config become hard blocks. */
export function rulesFromTerms(terms: string[]): ExclusionRule[] {
  return terms.length
    ? [
        {
          id: 'operator_excluded',
          reason: 'Listed in excludedNiches by the operator.',
          severity: 'block',
          terms,
        },
      ]
    : [];
}

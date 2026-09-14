import type { Guardrails } from '../config/guardrails.ts';
import type { Brief } from '../core/types.ts';

export interface ClaimIssue {
  field: string;
  text: string;
  pattern: string;
}

/**
 * The ad promise and the voice script must say the same thing, and neither may
 * make a claim the business cannot substantiate. This runs before gate #1 so a
 * human is never asked to approve copy that is already out of bounds.
 */
export function checkClaims(brief: Brief, g: Guardrails): ClaimIssue[] {
  const issues: ClaimIssue[] = [];
  for (const [field, text] of publicText(brief)) {
    const lower = text.toLowerCase();
    for (const pattern of g.bannedClaimPatterns) {
      if (lower.includes(pattern.toLowerCase())) {
        issues.push({ field, text, pattern });
      }
    }
  }
  return issues;
}

/**
 * Structural fields - ids, formats, timestamps. Everything else in a brief is
 * something a stranger can end up reading or hearing, so this list is the only
 * exemption from claim checking and is deliberately short.
 */
const STRUCTURAL = new Set([
  'briefId',
  'createdAt',
  'creativeId',
  'assetRef',
  'assetProvenance',
  'format',
  'source',
  'currency',
]);

/**
 * Every string in the brief that a member of the public could encounter.
 *
 * This used to be a hand-written list of nine fields plus the creatives, which
 * was fail-open: a field added to the brief went unchecked until someone
 * remembered to add it here. The whole brief object is handed to the voice
 * provider, so anything in it can be spoken - and `callScript.optOutLine` and
 * `callScript.qualifyingQuestions`, both read aloud, had been missed. A
 * qualifying question could carry any claim it liked. Walking the object means
 * a new field is checked by default and has to be declared structural to escape.
 */
function publicText(value: unknown, path = ''): Array<[string, string]> {
  if (typeof value === 'string') return value.trim() ? [[path || 'brief', value]] : [];
  if (Array.isArray(value)) return value.flatMap((item, i) => publicText(item, `${path}[${i}]`));
  if (value && typeof value === 'object') {
    return Object.entries(value).flatMap(([key, child]) =>
      STRUCTURAL.has(key) ? [] : publicText(child, path ? `${path}.${key}` : key),
    );
  }
  return [];
}

/**
 * The voice agent may only promise what the ad promised. Anything the script
 * offers that is absent from the offer's deliverable is a promise drift.
 */
export function checkPromiseAlignment(brief: Brief): string[] {
  const drift: string[] = [];
  const deliverable = brief.offer.deliverable.toLowerCase();
  const askTokens = tokenize(brief.callScript.conversionAsk);
  const ctaTokens = tokenize(brief.offer.cta);
  const overlap = askTokens.filter((t) => ctaTokens.includes(t) || deliverable.includes(t));
  if (overlap.length === 0) {
    drift.push(
      `callScript.conversionAsk ("${brief.callScript.conversionAsk}") shares no substance with the ad CTA ("${brief.offer.cta}")`,
    );
  }
  if (!offersOptOut(brief.callScript.optOutLine)) {
    drift.push(
      'callScript.optOutLine must offer a clear way to stop receiving calls (e.g. "opt you out", "we will not call again", "remove your number")',
    );
  }
  return drift;
}

/**
 * Does this line actually give the person a way out? Matches the ways a script
 * naturally phrases it, not one fixed string.
 */
export function offersOptOut(line: string): boolean {
  const text = (line ?? '').toLowerCase();
  return (
    /\bopt(?:ing|ed)?\s+(?:you\s+|me\s+|your\s+number\s+)?out\b/.test(text) ||
    /\b(?:do\s+not|don't|won't|will\s+not|never)\s+call\b/.test(text) ||
    /\bremove\s+(?:you|your\s+number|this\s+number)\b/.test(text) ||
    /\btake\s+(?:you|your\s+number)\s+off\b/.test(text) ||
    /\bunsubscribe\b/.test(text)
  );
}

const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'can', 'for', 'get', 'have', 'i', 'if', 'in', 'is', 'it', 'like', 'me',
  'of', 'on', 'or', 'our', 'the', 'to', 'we', 'would', 'you', 'your', 'want', 'this', 'that',
]);

function tokenize(text: string): string[] {
  return (text ?? '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 2 && !STOPWORDS.has(t));
}

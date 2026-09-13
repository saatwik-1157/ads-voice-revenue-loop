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
  const fields: Array<[string, string]> = [
    ['offer.problem', brief.offer.problem],
    ['offer.outcome', brief.offer.outcome],
    ['offer.mechanism', brief.offer.mechanism],
    ['offer.proof', brief.offer.proof],
    ['offer.cta', brief.offer.cta],
    ['offer.deliverable', brief.offer.deliverable],
    ['leadFormCopy', brief.leadFormCopy],
    ['callScript.opener', brief.callScript.opener],
    ['callScript.conversionAsk', brief.callScript.conversionAsk],
  ];

  for (const c of brief.creatives) {
    fields.push([`creative.${c.creativeId}.primaryText`, c.primaryText]);
    fields.push([`creative.${c.creativeId}.headline`, c.headline]);
    fields.push([`creative.${c.creativeId}.description`, c.description]);
    fields.push([`creative.${c.creativeId}.hook`, c.hook]);
  }
  for (const [key, value] of Object.entries(brief.callScript.approvedAnswers)) {
    fields.push([`callScript.approvedAnswers.${key}`, value]);
  }
  for (const [key, value] of Object.entries(brief.callScript.objectionHandling)) {
    fields.push([`callScript.objectionHandling.${key}`, value]);
  }

  for (const [field, text] of fields) {
    const lower = (text ?? '').toLowerCase();
    for (const pattern of g.bannedClaimPatterns) {
      if (lower.includes(pattern.toLowerCase())) {
        issues.push({ field, text, pattern });
      }
    }
  }
  return issues;
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

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  classifyText,
  DEFAULT_EXCLUSION_RULES,
  describeMatch,
  rulesFromTerms,
  type Classification,
  type ExclusionRule,
  type MatchSource,
} from './exclusions.ts';

/**
 * Phase A of the playbook: the control layer.
 *
 * Nothing in this system is allowed to spend money, publish an ad, or dial a
 * phone unless it passes these limits first. The agent can propose changes to
 * the guardrails; only a human editing this file can widen them.
 */
export interface Guardrails {
  allowedGeos: string[];
  defaultCountryCode: string;
  /** Extra plain terms the operator wants blocked outright, on top of the rules. */
  excludedNiches: string[];
  /** Structured exclusion rules. Defaults to DEFAULT_EXCLUSION_RULES. */
  exclusionRules?: ExclusionRule[];
  /** Meta "special ad categories" - must be handled deliberately, never by default. */
  specialAdCategoriesAllowed: boolean;
  allowedObjectives: string[];
  currency: string;
  maxDailySpendMinor: number;
  maxTestBudgetMinor: number;
  /** Cumulative loss at which the run halts itself and asks for a human. */
  stopLossMinor: number;
  /** Agent may raise budget by at most this factor per evaluation cycle. */
  maxBudgetStepFactor: number;
  /** Budget above this level always needs gate #2, regardless of profitability. */
  budgetApprovalThresholdMinor: number;
  minLeadsBeforeDecision: number;
  /** How often the unattended evaluation cycle runs. */
  evaluationIntervalHours: number;
  /**
   * Floor between two budget increases, regardless of how often the cycle runs.
   * maxBudgetStepFactor is per decision, so without this a 6-hourly scheduler
   * would compound it four times a day and quietly outrun the control layer.
   */
  minHoursBetweenBudgetRaises: number;
  minSpendBeforeKillMinor: number;
  callWindow: { startHour: number; endHour: number; timeZone: string };
  maxCallAttemptsPerLead: number;
  maxCallsPerDay: number;
  requireExplicitConsent: boolean;
  bannedClaimPatterns: string[];
  holdoutBudgetShare: number;
}

const DEFAULTS: Guardrails = {
  allowedGeos: ['IN'],
  defaultCountryCode: '91',
  excludedNiches: [],
  exclusionRules: DEFAULT_EXCLUSION_RULES,

  specialAdCategoriesAllowed: false,
  allowedObjectives: ['OUTCOME_LEADS'],
  currency: 'INR',
  maxDailySpendMinor: 150000, // INR 1,500/day
  maxTestBudgetMinor: 600000, // INR 6,000 total test
  stopLossMinor: 400000,
  maxBudgetStepFactor: 1.3,
  budgetApprovalThresholdMinor: 300000,
  minLeadsBeforeDecision: 15,
  evaluationIntervalHours: 24,
  minHoursBetweenBudgetRaises: 24,
  minSpendBeforeKillMinor: 100000,
  callWindow: { startHour: 9, endHour: 20, timeZone: 'Asia/Kolkata' },
  maxCallAttemptsPerLead: 2,
  maxCallsPerDay: 200,
  requireExplicitConsent: true,
  bannedClaimPatterns: [
    'guarantee',
    'guaranteed',
    '100%',
    'risk free',
    'risk-free',
    'no risk',
    'cure',
    'instant results',
    'get rich',
    'double your money',
    'assured returns',
  ],
  holdoutBudgetShare: 0.2,
};

export function loadGuardrails(path = 'config/guardrails.json'): Guardrails {
  const full = resolve(process.cwd(), path);
  if (!existsSync(full)) return DEFAULTS;
  const parsed = JSON.parse(readFileSync(full, 'utf8')) as Partial<Guardrails>;
  const merged: Guardrails = { ...DEFAULTS, ...parsed };
  validate(merged);
  return merged;
}

export function validate(g: Guardrails): void {
  const problems: string[] = [];
  if (g.maxDailySpendMinor <= 0) problems.push('maxDailySpendMinor must be > 0');
  if (g.maxTestBudgetMinor < g.maxDailySpendMinor) {
    problems.push('maxTestBudgetMinor must be >= maxDailySpendMinor');
  }
  if (g.stopLossMinor > g.maxTestBudgetMinor) {
    problems.push('stopLossMinor cannot exceed maxTestBudgetMinor');
  }
  if (g.allowedGeos.length === 0) problems.push('allowedGeos cannot be empty');
  if (g.maxBudgetStepFactor < 1 || g.maxBudgetStepFactor > 2) {
    problems.push('maxBudgetStepFactor must be between 1 and 2');
  }
  if (g.callWindow.startHour >= g.callWindow.endHour) {
    problems.push('callWindow.startHour must be before endHour');
  }
  if (g.evaluationIntervalHours <= 0) problems.push('evaluationIntervalHours must be > 0');
  if (g.minHoursBetweenBudgetRaises < 0) problems.push('minHoursBetweenBudgetRaises cannot be negative');
  if (problems.length) throw new Error(`Invalid guardrails:\n - ${problems.join('\n - ')}`);
}

export class GuardrailViolation extends Error {
  readonly rule: string;
  constructor(rule: string, message: string) {
    super(`[${rule}] ${message}`);
    this.name = 'GuardrailViolation';
    this.rule = rule;
  }
}

export function assertGeoAllowed(g: Guardrails, geos: string[]): void {
  const bad = geos.filter((x) => !g.allowedGeos.includes(x));
  if (bad.length) {
    throw new GuardrailViolation('geo', `geo(s) not approved: ${bad.join(', ')}`);
  }
}

/** The rules in force: the structured defaults plus anything the operator listed. */
export function exclusionRules(g: Guardrails): ExclusionRule[] {
  return [...(g.exclusionRules ?? DEFAULT_EXCLUSION_RULES), ...rulesFromTerms(g.excludedNiches)];
}

export function classifyNiche(g: Guardrails, text: string, source: MatchSource = 'name'): Classification {
  return classifyText(text, exclusionRules(g), source);
}

/**
 * Hard stop only. A `review` verdict deliberately does not throw: the match is
 * real but ambiguous, and gate #1 surfaces it to the person approving the
 * campaign. Blocking on ambiguity drops legitimate niches - "solar panel
 * cleaning for housing societies" is not a housing ad - and passing silently
 * would hide a genuine one.
 */
export function assertNicheAllowed(g: Guardrails, niche: string, source: MatchSource = 'name'): void {
  const { verdict, matches } = classifyNiche(g, niche, source);
  if (verdict !== 'blocked') return;
  const blocking = matches.filter((m) => m.severity === 'block');
  throw new GuardrailViolation('niche', `"${niche}" is excluded: ${blocking.map(describeMatch).join('; ')}`);
}

export function assertObjectiveAllowed(g: Guardrails, objective: string): void {
  if (!g.allowedObjectives.includes(objective)) {
    throw new GuardrailViolation('objective', `objective ${objective} is not in allowedObjectives`);
  }
}

export function assertBudgetWithinCaps(g: Guardrails, dailyBudgetMinor: number, spentSoFarMinor: number): void {
  // Every comparison against NaN is false, so an unchecked NaN passes each cap
  // below and reaches Meta as `daily_budget: "NaN"`. A negative budget passes
  // for the same reason. A cap that waves those through is not a cap.
  if (!Number.isFinite(dailyBudgetMinor) || dailyBudgetMinor <= 0) {
    throw new GuardrailViolation(
      'daily_budget',
      `daily budget must be a positive amount, got ${String(dailyBudgetMinor)} - check the --budget value`,
    );
  }
  if (!Number.isFinite(spentSoFarMinor) || spentSoFarMinor < 0) {
    throw new GuardrailViolation('spend_to_date', `spend to date is not a usable number: ${String(spentSoFarMinor)}`);
  }
  if (dailyBudgetMinor > g.maxDailySpendMinor) {
    throw new GuardrailViolation('daily_cap', `daily budget ${dailyBudgetMinor} exceeds cap ${g.maxDailySpendMinor}`);
  }
  if (spentSoFarMinor + dailyBudgetMinor > g.maxTestBudgetMinor) {
    throw new GuardrailViolation(
      'test_budget',
      `projected spend ${spentSoFarMinor + dailyBudgetMinor} exceeds test budget ${g.maxTestBudgetMinor}`,
    );
  }
}

export function isWithinCallWindow(g: Guardrails, at: Date = new Date()): boolean {
  const hour = Number(
    new Intl.DateTimeFormat('en-GB', {
      hour: '2-digit',
      hour12: false,
      timeZone: g.callWindow.timeZone,
    }).format(at),
  );
  return hour >= g.callWindow.startHour && hour < g.callWindow.endHour;
}

/**
 * The next moment inside the calling window, searched hour by hour from `from`.
 *
 * The demo needs this because it simulates days passing: a simulated call has
 * to be judged against a simulated time, or running the demo after dinner
 * silently skips the entire voice half of the loop and the run looks broken.
 */
export function nextTimeInsideCallWindow(g: Guardrails, from: Date = new Date()): Date {
  for (let hours = 0; hours < 24; hours += 1) {
    const candidate = new Date(from.getTime() + hours * 3_600_000);
    if (isWithinCallWindow(g, candidate)) return candidate;
  }
  return from;
}

export { DEFAULTS as defaultGuardrails };

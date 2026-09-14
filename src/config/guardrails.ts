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

export class GuardrailConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GuardrailConfigError';
  }
}

export function loadGuardrails(path = 'config/guardrails.json'): Guardrails {
  const full = resolve(process.cwd(), path);
  if (!existsSync(full)) return DEFAULTS;

  let parsed: Partial<Guardrails>;
  try {
    parsed = JSON.parse(readFileSync(full, 'utf8')) as Partial<Guardrails>;
  } catch (err) {
    // The control layer is hand-edited; a trailing comma should say so rather
    // than surface as a parser stack trace.
    throw new GuardrailConfigError(`${path} is not valid JSON: ${(err as Error).message}`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new GuardrailConfigError(`${path} must contain a JSON object`);
  }

  const merged: Guardrails = { ...DEFAULTS, ...parsed };
  try {
    validate(merged);
  } catch (err) {
    throw new GuardrailConfigError(`${path}: ${(err as Error).message}`);
  }
  return merged;
}

/**
 * Validate the control layer, types first.
 *
 * This file is hand-edited, so the realistic failure is a typo rather than a
 * bad decision - and a typo in a cap used to be silent and dangerous.
 * `"1,000"` parses to NaN, every comparison against NaN is false, and the cap
 * it was meant to impose simply stopped existing. Checking ranges without
 * checking types let that through.
 */
export function validate(g: Guardrails): void {
  const problems: string[] = [];

  const amount = (name: string, value: unknown, { min = 1 }: { min?: number } = {}): number | null => {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      // JSON.stringify(NaN) is "null", which hides the very mistake that makes
      // this check worth having - a cap typed as "1,000".
      const shown = typeof value === 'number' ? String(value) : JSON.stringify(value);
      problems.push(`${name} must be a finite number, got ${shown}`);
      return null;
    }
    if (value < min) problems.push(`${name} must be at least ${min}, got ${value}`);
    return value;
  };
  const text = (name: string, value: unknown): void => {
    if (typeof value !== 'string' || !value.trim()) problems.push(`${name} must be a non-empty string`);
  };
  const flag = (name: string, value: unknown): void => {
    if (typeof value !== 'boolean') problems.push(`${name} must be true or false, got ${JSON.stringify(value)}`);
  };
  const list = (name: string, value: unknown, { allowEmpty = true } = {}): void => {
    if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
      problems.push(`${name} must be an array of strings`);
      return;
    }
    if (!allowEmpty && value.length === 0) problems.push(`${name} cannot be empty`);
  };

  const daily = amount('maxDailySpendMinor', g.maxDailySpendMinor);
  const test = amount('maxTestBudgetMinor', g.maxTestBudgetMinor);
  const stopLoss = amount('stopLossMinor', g.stopLossMinor);
  amount('budgetApprovalThresholdMinor', g.budgetApprovalThresholdMinor);
  amount('minSpendBeforeKillMinor', g.minSpendBeforeKillMinor, { min: 0 });
  amount('minLeadsBeforeDecision', g.minLeadsBeforeDecision, { min: 0 });
  amount('maxCallAttemptsPerLead', g.maxCallAttemptsPerLead);
  amount('maxCallsPerDay', g.maxCallsPerDay);
  amount('evaluationIntervalHours', g.evaluationIntervalHours, { min: Number.MIN_VALUE });
  amount('minHoursBetweenBudgetRaises', g.minHoursBetweenBudgetRaises, { min: 0 });

  const step = amount('maxBudgetStepFactor', g.maxBudgetStepFactor, { min: 1 });
  if (step !== null && step > 2) problems.push(`maxBudgetStepFactor must be between 1 and 2, got ${step}`);

  const holdout = amount('holdoutBudgetShare', g.holdoutBudgetShare, { min: 0 });
  if (holdout !== null && holdout >= 1) problems.push(`holdoutBudgetShare must be below 1, got ${holdout}`);

  if (daily !== null && test !== null && test < daily) {
    problems.push('maxTestBudgetMinor must be >= maxDailySpendMinor');
  }
  if (stopLoss !== null && test !== null && stopLoss > test) {
    problems.push('stopLossMinor cannot exceed maxTestBudgetMinor');
  }

  list('allowedGeos', g.allowedGeos, { allowEmpty: false });
  list('allowedObjectives', g.allowedObjectives, { allowEmpty: false });
  list('excludedNiches', g.excludedNiches);
  list('bannedClaimPatterns', g.bannedClaimPatterns);
  text('currency', g.currency);
  flag('specialAdCategoriesAllowed', g.specialAdCategoriesAllowed);
  flag('requireExplicitConsent', g.requireExplicitConsent);

  // Deliberately not String(...): an unquoted 91 would satisfy that and then
  // fail inside toE164 on the first lead, long after the money has been spent.
  if (typeof g.defaultCountryCode !== 'string' || !/^\d{1,4}$/.test(g.defaultCountryCode)) {
    problems.push(`defaultCountryCode must be digits in a string, e.g. "91", got ${JSON.stringify(g.defaultCountryCode)}`);
  }

  problems.push(...validateCallWindow(g.callWindow));
  if (problems.length) throw new Error(`Invalid guardrails:\n - ${problems.join('\n - ')}`);
}

function validateCallWindow(window: Guardrails['callWindow']): string[] {
  if (!window || typeof window !== 'object') return ['callWindow must be an object'];
  const problems: string[] = [];

  for (const key of ['startHour', 'endHour'] as const) {
    const value = window[key];
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 24) {
      problems.push(`callWindow.${key} must be a whole hour between 0 and 24, got ${JSON.stringify(value)}`);
    }
  }
  if (problems.length === 0 && window.startHour >= window.endHour) {
    problems.push('callWindow.startHour must be before endHour');
  }

  // A mistyped zone would silently shift the hours people are called in, so it
  // is checked against the runtime's own list rather than assumed.
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: window.timeZone });
  } catch {
    problems.push(`callWindow.timeZone is not a known zone: ${JSON.stringify(window.timeZone)}`);
  }
  return problems;
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

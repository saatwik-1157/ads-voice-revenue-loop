import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertBudgetWithinCaps,
  defaultGuardrails,
  GuardrailConfigError,
  GuardrailViolation,
  loadGuardrails,
  validate,
  type Guardrails,
} from '../src/config/guardrails.ts';

/**
 * The control layer is the only thing standing between the agent and the
 * money, and it is a hand-edited JSON file. These tests are about typos rather
 * than policy: the dangerous failure is a cap that looks present and isn't.
 */

const dir = mkdtempSync(join(tmpdir(), 'fl-guardrails-'));
let seq = 0;

/** Write `body` verbatim - including deliberately broken JSON - and load it. */
function load(body: string): Guardrails {
  const path = join(dir, `g-${++seq}.json`);
  writeFileSync(path, body, 'utf8');
  return loadGuardrails(path);
}

/** The defaults with one field replaced by something hostile. */
function withField(key: string, value: unknown): Guardrails {
  return { ...defaultGuardrails, [key]: value };
}

function rejects(g: Guardrails, needle: string): void {
  assert.throws(
    () => { validate(g); },
    (err: Error) => err.message.includes(needle),
    `expected a complaint mentioning ${needle}`,
  );
}

test('the shipped defaults are valid', () => {
  validate(defaultGuardrails);
});

test('the repository config is valid', () => {
  validate(loadGuardrails('config/guardrails.json'));
});

test('a cap typed with a thousands separator is rejected, not silently disabled', () => {
  // "1,000" parses to NaN, and every comparison against NaN is false - so
  // before the type check this cap did not fail, it simply stopped existing.
  rejects(withField('maxDailySpendMinor', '1,000'), 'maxDailySpendMinor must be a finite number');
  rejects(withField('maxDailySpendMinor', Number.NaN), 'got NaN');
});

test('a cap that is zero, negative or infinite is rejected', () => {
  rejects(withField('maxDailySpendMinor', 0), 'must be at least 1');
  rejects(withField('stopLossMinor', -50000), 'must be at least 1');
  rejects(withField('maxTestBudgetMinor', Number.POSITIVE_INFINITY), 'must be a finite number');
});

test('a null cap is rejected rather than treated as zero', () => {
  rejects(withField('minLeadsBeforeDecision', null), 'minLeadsBeforeDecision must be a finite number');
});

test('a flag written as a string is rejected', () => {
  // "false" is truthy, so this one would have inverted the meaning.
  rejects(withField('specialAdCategoriesAllowed', 'false'), 'must be true or false');
  rejects(withField('requireExplicitConsent', 0), 'must be true or false');
});

test('a list that is not a list of strings is rejected', () => {
  rejects(withField('allowedGeos', 'IN'), 'must be an array of strings');
  rejects(withField('allowedGeos', []), 'cannot be empty');
  rejects(withField('bannedClaimPatterns', ['ok', 7]), 'must be an array of strings');
});

test('a mistyped timezone is caught instead of silently shifting call hours', () => {
  rejects(withField('callWindow', { startHour: 10, endHour: 19, timeZone: 'Asia/Calcuta' }), 'not a known zone');
  rejects(withField('callWindow', { startHour: 10, endHour: 19, timeZone: '' }), 'not a known zone');
});

test('call hours must be whole hours inside a day, in order', () => {
  const window = (startHour: unknown, endHour: unknown): Guardrails =>
    withField('callWindow', { startHour, endHour, timeZone: 'Asia/Kolkata' });
  rejects(window(9.5, 19), 'whole hour');
  rejects(window(10, 25), 'whole hour');
  rejects(window(-1, 19), 'whole hour');
  rejects(window(19, 10), 'startHour must be before endHour');
  rejects(window(10, 10), 'startHour must be before endHour');
  validate(window(0, 24));
});

test('the budget step and holdout share cannot be widened past their limits', () => {
  rejects(withField('maxBudgetStepFactor', 3), 'between 1 and 2');
  rejects(withField('maxBudgetStepFactor', 0.5), 'must be at least 1');
  rejects(withField('holdoutBudgetShare', 1), 'must be below 1');
  rejects(withField('holdoutBudgetShare', -0.1), 'must be at least 0');
});

test('an evaluation interval of zero is rejected - it would busy-loop the scheduler', () => {
  rejects(withField('evaluationIntervalHours', 0), 'evaluationIntervalHours');
});

test('a country code that is not digits is rejected', () => {
  rejects(withField('defaultCountryCode', '+91'), 'must be digits');
  rejects(withField('defaultCountryCode', 91), 'must be digits');
});

test('every problem in the file is reported at once', () => {
  const broken = {
    ...defaultGuardrails,
    maxDailySpendMinor: '1,000',
    allowedGeos: [],
    defaultCountryCode: '+91',
  } as unknown as Guardrails;
  try {
    validate(broken);
    assert.fail('expected the validator to refuse this');
  } catch (err) {
    const message = (err as Error).message;
    // One pass over the file beats fixing three typos across three runs.
    for (const needle of ['maxDailySpendMinor', 'allowedGeos', 'defaultCountryCode']) {
      assert.ok(message.includes(needle), `${needle} missing from:\n${message}`);
    }
  }
});

test('a file that is not valid JSON names itself instead of surfacing a parser stack', () => {
  assert.throws(
    () => load('{ "maxDailySpendMinor": 100000, }'),
    (err: Error) => err instanceof GuardrailConfigError && err.message.includes('not valid JSON'),
  );
});

test('a file that parses to something other than an object is rejected', () => {
  for (const body of ['[]', '"guardrails"', 'null', '42']) {
    assert.throws(
      () => load(body),
      (err: Error) => err instanceof GuardrailConfigError && err.message.includes('must contain a JSON object'),
      `${body} should not be accepted as a config`,
    );
  }
});

test('an invalid value in the file is reported as a config error, not a bare validation error', () => {
  assert.throws(
    () => load('{ "maxDailySpendMinor": "1,000" }'),
    (err: Error) => err instanceof GuardrailConfigError && err.message.includes('maxDailySpendMinor'),
  );
});

test('a missing file falls back to the built-in defaults', () => {
  assert.deepEqual(loadGuardrails(join(dir, 'does-not-exist.json')), defaultGuardrails);
});

test('a partial file overrides only what it names', () => {
  const g = load('{ "minLeadsBeforeDecision": 40 }');
  assert.equal(g.minLeadsBeforeDecision, 40);
  assert.equal(g.maxDailySpendMinor, defaultGuardrails.maxDailySpendMinor);
  assert.deepEqual(g.bannedClaimPatterns, defaultGuardrails.bannedClaimPatterns);
});

test('a budget that is not a positive finite number never reaches a provider', () => {
  for (const budget of [Number.NaN, 0, -1, Number.POSITIVE_INFINITY]) {
    assert.throws(
      () => { assertBudgetWithinCaps(defaultGuardrails, budget, 0); },
      GuardrailViolation,
      `a daily budget of ${String(budget)} must be refused`,
    );
  }
});

test('spend to date has to be a real number before it is compared to the stop-loss', () => {
  assert.throws(
    () => { assertBudgetWithinCaps(defaultGuardrails, 50000, Number.NaN); },
    GuardrailViolation,
  );
  assert.throws(
    () => { assertBudgetWithinCaps(defaultGuardrails, 50000, -1); },
    GuardrailViolation,
  );
});

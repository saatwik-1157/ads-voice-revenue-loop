import { test } from 'node:test';
import assert from 'node:assert/strict';
import { maskPhone, PhoneError, redact, toE164 } from '../src/core/util.ts';
import {
  assertBudgetWithinCaps,
  assertGeoAllowed,
  assertNicheAllowed,
  defaultGuardrails,
  GuardrailViolation,
  validate,
} from '../src/config/guardrails.ts';
import { budgetChangeNeedsApproval } from '../src/approvals/gates.ts';
import { isRealKey } from '../src/config/env.ts';

test('toE164 normalizes the shapes a lead form actually produces', () => {
  assert.equal(toE164('+91 98765 43210', '91'), '+919876543210');
  assert.equal(toE164('09876543210', '91'), '+919876543210');
  assert.equal(toE164('9876543210', '91'), '+919876543210');
  assert.equal(toE164('919876543210', '91'), '+919876543210');
  assert.equal(toE164('0091 9876543210', '91'), '+919876543210');
});

test('toE164 normalizes every shape of the same number identically', () => {
  // Suppression is recorded against the normalized form, so two spellings of
  // one number that normalize differently are two people as far as the
  // opt-out list is concerned.
  const spellings = ['9876543210', '+919876543210', '919876543210', '09876543210', '0091 98765 43210', '+91 98765-43210', '(98765) 43210'];
  for (const spelling of spellings) {
    assert.equal(toE164(spelling, '91'), '+919876543210', `${spelling} is the same person`);
  }
});

test('toE164 rejects rather than guesses', () => {
  assert.throws(() => toE164('', '91'), PhoneError);
  assert.throws(() => toE164('12345', '91'), PhoneError);
  assert.throws(() => toE164('+1', '91'), PhoneError);
});

test('a plus in front of a national number is refused, not believed', () => {
  // "+9876543210" used to normalize to +9876543210 - a different number,
  // possibly a real one belonging to someone else, and one that walks past a
  // suppression entry recorded as +919876543210.
  assert.throws(() => toE164('+9876543210', '91'), (err: Error) => /ambiguous/.test(err.message));
  assert.notEqual(toE164('9876543210', '91'), '+9876543210');
});

test('a phone field holding more than a phone number is refused', () => {
  // "9876543210 ext 22" used to become +91987654321022 by stripping the
  // letters and keeping every digit: a wrong number, dialled at a stranger.
  for (const raw of ['9876543210 ext 22', '9876543210x22', '98765ABCDE', '+', '9876543210 / 9876543211']) {
    assert.throws(() => toE164(raw, '91'), PhoneError, `${raw} must not be guessed at`);
  }
});

test('digits that are not a number are refused', () => {
  for (const raw of ['0000000000', '+000000000000', '9999999999', '1111111111']) {
    assert.throws(() => toE164(raw, '91'), PhoneError, `${raw} is not a phone number`);
  }
});

test('a national number of the wrong length is refused rather than padded with a country code', () => {
  for (const raw of ['1234567', '12345678', '123456789', '12345678901']) {
    assert.throws(() => toE164(raw, '91'), PhoneError, `${raw} is not 10 national digits`);
  }
});

test('maskPhone keeps only the last four digits', () => {
  const masked = maskPhone('+919876543210');
  assert.ok(masked.endsWith('3210'));
  assert.ok(!masked.includes('98765'));
});

test('redact strips tokens that must never reach a log', () => {
  const line = 'access_token=EAAabcdefghijklmnop and key sk-abcdefghijklmnop';
  const safe = redact(line);
  assert.ok(!safe.includes('EAAabcdefghijklmnop'));
  assert.ok(!safe.includes('sk-abcdefghijklmnop'));
});

test('guardrails reject an incoherent control layer', () => {
  assert.throws(() => validate({ ...defaultGuardrails, maxTestBudgetMinor: 1 }), /maxTestBudgetMinor/);
  assert.throws(() => validate({ ...defaultGuardrails, allowedGeos: [] }), /allowedGeos/);
  assert.throws(
    () => validate({ ...defaultGuardrails, callWindow: { startHour: 20, endHour: 9, timeZone: 'UTC' } }),
    /startHour/,
  );
});

test('geo, niche and budget caps are enforced, not advisory', () => {
  const g = defaultGuardrails;
  assert.throws(() => assertGeoAllowed(g, ['US']), GuardrailViolation);
  assert.throws(() => assertNicheAllowed(g, 'payday loans for drivers'), GuardrailViolation);
  assert.throws(() => assertBudgetWithinCaps(g, g.maxDailySpendMinor + 1, 0), /daily_cap/);
  assert.throws(() => assertBudgetWithinCaps(g, g.maxDailySpendMinor, g.maxTestBudgetMinor), /test_budget/);
  assert.doesNotThrow(() => assertBudgetWithinCaps(g, 1000, 0));
});

test('budget increases past the step factor or the threshold need a human', () => {
  const g = { ...defaultGuardrails, maxBudgetStepFactor: 1.3, budgetApprovalThresholdMinor: 300000 };
  assert.equal(budgetChangeNeedsApproval(g, 100000, 90000).needed, false);
  assert.equal(budgetChangeNeedsApproval(g, 100000, 130000).needed, false);
  assert.equal(budgetChangeNeedsApproval(g, 100000, 140000).needed, true);
  assert.equal(budgetChangeNeedsApproval(g, 280000, 310000).needed, true);
});

test('a placeholder key counts as no key at all', () => {
  // A placeholder is worse than an empty value: it is truthy, so it passes the
  // check, earns a 401, and falls back to the offline writer anyway.
  for (const fake of ['sk-ant-REPLACE-ME', 'sk-ant-YOUR-KEY', 'your_key_here', 'xxx', 'TODO', '  ', '']) {
    assert.equal(isRealKey(fake), false, `${JSON.stringify(fake)} is not a usable key`);
  }
  assert.equal(isRealKey('sk-ant-api03-abcdefghijklmnop'), true);
});

test('the budget cap rejects the values that slip past a naive comparison', () => {
  const g = defaultGuardrails;
  // Every comparison against NaN is false, so an unchecked NaN passes both
  // caps and reaches Meta as `daily_budget: "NaN"`. A negative budget passes
  // the same way. A cap that accepts these is not bounding anything.
  assert.throws(() => assertBudgetWithinCaps(g, Number.NaN, 0), /daily_budget/);
  assert.throws(() => assertBudgetWithinCaps(g, -5000, 0), /daily_budget/);
  assert.throws(() => assertBudgetWithinCaps(g, 0, 0), /daily_budget/, 'a campaign that cannot deliver is not a campaign');
  assert.throws(() => assertBudgetWithinCaps(g, Number.POSITIVE_INFINITY, 0), GuardrailViolation);
  assert.throws(() => assertBudgetWithinCaps(g, 1000, Number.NaN), /spend_to_date/);
  assert.throws(() => assertBudgetWithinCaps(g, 1000, -1), /spend_to_date/);

  assert.doesNotThrow(() => assertBudgetWithinCaps(g, 1000, 0), 'an ordinary budget still passes');
  assert.doesNotThrow(() => assertBudgetWithinCaps(g, g.maxDailySpendMinor, 0), 'exactly at the cap is allowed');
});

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

test('toE164 rejects rather than guesses', () => {
  assert.throws(() => toE164('', '91'), PhoneError);
  assert.throws(() => toE164('12345', '91'), PhoneError);
  assert.throws(() => toE164('+1', '91'), PhoneError);
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

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store/db.ts';
import { defaultGuardrails, GuardrailViolation } from '../src/config/guardrails.ts';
import { generateBrief } from '../src/brief/generator.ts';
import { checkClaims } from '../src/brief/claims.ts';
import { approve, reject, requestGate1 } from '../src/approvals/gates.ts';
import { publishCampaign } from '../src/meta/publisher.ts';
import { MockMetaProvider } from '../src/meta/mock.ts';
import type { Brief } from '../src/core/types.ts';

/**
 * The rules that exist for people who did not ask to be involved.
 *
 * Banned claims and promise alignment were both detected correctly and enforced
 * nowhere: gate #1 listed the problems, `approve` ignored them, and publish
 * checked only that an approval existed. A brief promising "guaranteed results"
 * went live - while the gate's own documentation said blocking issues could
 * not be approved past.
 */

const G = { ...defaultGuardrails, callWindow: { startHour: 0, endHour: 24, timeZone: 'UTC' } };

async function seed(mutate: (b: Brief) => void = () => {}): Promise<{ store: Store; runId: string; brief: Brief }> {
  const store = new Store(':memory:');
  const { brief } = await generateBrief(G);
  for (const c of brief.creatives) {
    c.assetRef = `hash_${c.creativeId}`;
    c.assetProvenance = 'manual';
  }
  mutate(brief);
  const runId = store.createRun(brief.niche.name);
  store.saveBrief(runId, brief);
  return { store, runId, brief };
}

test('a banned claim cannot be approved past at the gate', async () => {
  const { store, runId, brief } = await seed((b) => {
    b.creatives[0]!.headline = 'Guaranteed results in 30 days';
  });
  const gate = requestGate1(store, G, runId, brief, 50000);
  assert.ok(gate.blocking.length > 0, 'the gate sees the problem');

  assert.throws(
    () => approve(store, gate.approvalId, 'an-operator-in-a-hurry'),
    (err: Error) => err instanceof GuardrailViolation && /blocking/.test(err.message),
  );
  assert.equal(store.hasApproval(runId, gate.gate), false, 'and the approval did not land');
  store.close();
});

test('a brief edited after a clean approval is still caught at publish', async () => {
  // An approval is a decision about the brief as it stood then. Publish is the
  // last point before the copy is real, so it checks for itself.
  const { store, runId, brief } = await seed();
  const gate = requestGate1(store, G, runId, brief, 50000);
  assert.equal(gate.blocking.length, 0);
  approve(store, gate.approvalId, 'a-careful-operator');

  brief.creatives[0]!.headline = '100% risk free, guaranteed';
  store.saveBrief(runId, brief);

  await assert.rejects(
    publishCampaign(store, new MockMetaProvider(5), G, runId, brief, 'page_1', {
      dailyBudgetMinor: 50000,
      windowDays: 5,
      activate: true,
    }),
    (err: Error) => err instanceof GuardrailViolation && /banned_claim/.test(err.message),
  );
  store.close();
});

test('a script that offers no way out is refused at publish', async () => {
  const { store, runId, brief } = await seed();
  const gate = requestGate1(store, G, runId, brief, 50000);
  approve(store, gate.approvalId, 'tester');

  brief.callScript.optOutLine = 'Thanks for your time!';
  store.saveBrief(runId, brief);

  await assert.rejects(
    publishCampaign(store, new MockMetaProvider(5), G, runId, brief, 'page_1', {
      dailyBudgetMinor: 50000,
      windowDays: 5,
      activate: true,
    }),
    (err: Error) => err instanceof GuardrailViolation && /promise_drift/.test(err.message),
  );
  store.close();
});

test('rejecting a blocked approval is always allowed', async () => {
  // Refusing is never the dangerous direction, so the block must not trap an
  // approval in limbo where it can be neither granted nor cleared away.
  const { store, runId, brief } = await seed((b) => {
    b.offer.outcome = 'A guaranteed 3x return';
  });
  const gate = requestGate1(store, G, runId, brief, 50000);
  assert.equal(reject(store, gate.approvalId, 'tester', 'claims are too strong'), true);
  store.close();
});

test('a clean brief still passes the gate and publishes', async () => {
  // The whole point of the checks is that they refuse bad copy, not all copy.
  const { store, runId, brief } = await seed();
  const gate = requestGate1(store, G, runId, brief, 50000);
  assert.equal(gate.blocking.length, 0);
  assert.equal(approve(store, gate.approvalId, 'tester'), true);

  const published = await publishCampaign(store, new MockMetaProvider(5), G, runId, brief, 'page_1', {
    dailyBudgetMinor: 50000,
    windowDays: 5,
    activate: true,
  });
  assert.equal(published.ads.length, brief.creatives.length);
  store.close();
});

test('every string a stranger can hear is claim-checked, not a hand-picked list', async () => {
  // The checker walked nine named fields plus the creatives, which was
  // fail-open: the whole brief is handed to the voice provider, so anything in
  // it can be spoken. qualifyingQuestions and optOutLine are both read aloud
  // and neither was covered.
  const { brief, store } = await seed();
  assert.equal(checkClaims(brief, G).length, 0, 'the shipped brief is clean');

  const spoken: Array<[string, (b: Brief) => void]> = [
    ['qualifyingQuestions', (b) => { b.callScript.qualifyingQuestions[0] = 'Want the guaranteed 3x?'; }],
    ['optOutLine', (b) => { b.callScript.optOutLine = 'Say stop for a 100% opt out'; }],
    ['offer.icp', (b) => { b.offer.icp = 'People who want to get rich'; }],
    ['creative.angle', (b) => { b.creatives[0]!.angle = 'risk-free'; }],
    ['approvedAnswers', (b) => { b.callScript.approvedAnswers.price = 'We cure that'; }],
  ];
  for (const [label, mutate] of spoken) {
    const copy: Brief = structuredClone(brief);
    mutate(copy);
    assert.ok(checkClaims(copy, G).length > 0, `${label} reaches a person and must be checked`);
  }
  store.close();
});

test('structural fields are exempt, so an id never trips the checker', async () => {
  const { brief, store } = await seed();
  const copy: Brief = structuredClone(brief);
  copy.briefId = 'brief_100%_guarantee';
  copy.creatives[0]!.assetRef = 'hash_guaranteed_100%';
  assert.equal(checkClaims(copy, G).length, 0);
  store.close();
});

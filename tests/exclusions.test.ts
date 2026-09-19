import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyFields,
  classifyText,
  DEFAULT_EXCLUSION_RULES as RULES,
  termPattern,
} from '../src/config/exclusions.ts';
import { assertNicheAllowed, classifyNiche, defaultGuardrails, GuardrailViolation } from '../src/config/guardrails.ts';
import { pickNiche, SEED_CANDIDATES } from '../src/brief/niche.ts';
import { requestGate1 } from '../src/approvals/gates.ts';
import { generateBrief } from '../src/brief/generator.ts';
import { Store } from '../src/store/db.ts';

const G = defaultGuardrails;

test('a customer segment that merely mentions housing is not a housing ad', () => {
  const result = classifyText('Solar panel cleaning and output audit for housing societies', RULES);
  assert.equal(result.verdict, 'allowed', 'this was the false positive the flat list produced');
  assert.deepEqual(result.matches, []);
});

test('an actual housing offer is still blocked', () => {
  for (const text of [
    'Home loans for first-time buyers',
    'Rental listings in Pune',
    'Flats for sale near the airport',
    'Tenant screening for landlords',
  ]) {
    assert.equal(classifyText(text, RULES).verdict, 'blocked', `${text} must not get through`);
  }
});

test('housing that is neither clearly an offer nor clearly a segment goes to a human', () => {
  const result = classifyText('Affordable housing project marketing', RULES);
  assert.equal(result.verdict, 'review');
  assert.equal(result.matches[0]?.ruleId, 'housing_adjacent');
});

test('an exemption is local - it does not disarm the rule for the rest of the text', () => {
  const result = classifyText('Rental listings promoted to housing societies', RULES);
  assert.equal(result.verdict, 'blocked', 'the listing offer still fires even though the exemption matched');
  assert.ok(result.matches.some((m) => m.term === 'rental listing'));
});

test('terms match on word boundaries, not as substrings', () => {
  // The flat list matched 'loan' inside "Sloan" and 'credit' inside "accreditation".
  assert.equal(classifyText("Sloan's bakery equipment servicing", RULES).verdict, 'allowed');
  assert.equal(classifyText('NABH accreditation paperwork for hospitals', RULES).verdict, 'allowed');
  assert.equal(classifyText('Balloon decoration for events', RULES).verdict, 'allowed');
});

test('plurals are tolerated in both directions', () => {
  assert.ok(termPattern('loan').test('payday loans for drivers'));
  assert.ok(termPattern('housing society').test('for housing societies'), 'y -> ies');
  assert.ok(termPattern('job opening').test('job openings this week'));
  assert.ok(!termPattern('loan').test('sloane'));
});

test('a restricted term in commentary is weaker evidence than one in the name', () => {
  const commentary = classifyText('avoid medical treatment claims in this vertical', RULES, 'notes');
  assert.equal(commentary.verdict, 'review', 'commentary about a risk is not the same as selling it');

  const name = classifyText('Medical treatment for chronic pain', RULES, 'name');
  assert.equal(name.verdict, 'blocked');
});

test('classifyFields keeps the strongest verdict across fields', () => {
  const result = classifyFields(
    [
      ['name', 'Rooftop cleaning for housing societies'],
      ['notes', 'committee buying slows the close'],
    ],
    RULES,
  );
  assert.equal(result.verdict, 'allowed');

  const blocked = classifyFields(
    [
      ['name', 'Rooftop cleaning'],
      ['offer', 'Bundled with a home loan referral'],
    ],
    RULES,
  );
  assert.equal(blocked.verdict, 'blocked');
});

test('assertNicheAllowed throws on a block and stays quiet on a review', () => {
  assert.throws(() => assertNicheAllowed(G, 'payday loans for drivers'), GuardrailViolation);
  assert.throws(() => assertNicheAllowed(G, 'Casino night promotions'), /gambling/);
  assert.doesNotThrow(() => assertNicheAllowed(G, 'Affordable housing project marketing'));
  assert.doesNotThrow(() => assertNicheAllowed(G, 'Solar panel cleaning for housing societies'));
});

test('the violation message names the rule and the term that fired', () => {
  try {
    assertNicheAllowed(G, 'Home loan assistance');
    assert.fail('expected a violation');
  } catch (err) {
    const message = (err as Error).message;
    assert.match(message, /home loan/);
    assert.match(message, /credit|housing/);
    assert.match(message, /special ad category/i);
  }
});

test('operator-listed terms are hard blocks on top of the rules', () => {
  const strict = { ...G, excludedNiches: ['scaffolding'] };
  assert.equal(classifyNiche(strict, 'Scaffolding rental for builders').verdict, 'blocked');
  assert.equal(classifyNiche(G, 'Scaffolding rental for builders').verdict, 'allowed');
});

test('pickNiche keeps an ambiguous candidate and flags it instead of dropping it', () => {
  const { chosen, rejected, reviewFlags } = pickNiche(
    [
      {
        name: 'Solar panel cleaning for housing societies',
        urgency: 5,
        ticketSize: 5,
        phoneCloseable: 5,
        reachability: 5,
        offerSimplicity: 5,
        notes: 'Measurable outcome makes proof easy.',
      },
    ],
    G,
  );
  assert.match(chosen.name, /Solar panel/);
  assert.deepEqual(rejected, [], 'the old flat list rejected this one');
  assert.deepEqual(reviewFlags, []);
});

test('pickNiche still drops a genuinely excluded candidate', () => {
  const { chosen, rejected } = pickNiche(
    [
      {
        name: 'Payday loan lead generation',
        urgency: 5,
        ticketSize: 5,
        phoneCloseable: 5,
        reachability: 5,
        offerSimplicity: 5,
        notes: 'high intent',
      },
      {
        name: 'Emergency AC repair for small offices',
        urgency: 4,
        ticketSize: 3,
        phoneCloseable: 4,
        reachability: 4,
        offerSimplicity: 4,
        notes: 'connect speed is the whole game',
      },
    ],
    G,
  );
  assert.match(chosen.name, /AC repair/);
  assert.equal(rejected.length, 1);
  assert.match(rejected[0]!.reason, /payday|loan/i);
});

test('an ambiguous niche carries its flags through to gate #1', () => {
  const store = new Store(':memory:');
  const runId = store.createRun('test');
  const { chosen, reviewFlags } = pickNiche(
    [
      {
        name: 'Affordable housing project marketing',
        urgency: 3,
        ticketSize: 5,
        phoneCloseable: 3,
        reachability: 3,
        offerSimplicity: 3,
        notes: 'committee buying slows the close',
      },
    ],
    G,
  );
  assert.ok(reviewFlags.length > 0, 'bare "housing" is ambiguous and wants a human');

  const brief = {
    niche: chosen,
    offer: { icp: '', outcome: '', cta: '', deliverable: '' },
    creatives: [],
    callScript: { opener: '', conversionAsk: '', optOutLine: 'I will opt you out', approvedAnswers: {}, objectionHandling: {} },
    successMetrics: { targetCplMinor: 1, targetConnectRate: 0.5, targetQualifiedRate: 0.3, targetCacMinor: 1, targetRoas: 2 },
  } as never;

  const gate = requestGate1(store, G, runId, brief, 50000, reviewFlags);
  // Compared against the literal, not against the same array by reference -
  // this fixture has no creatives, so requestGate1 returns the caller's array
  // untouched and `deepEqual(gate.reviewFlags, reviewFlags)` compared it to
  // itself.
  assert.equal(gate.reviewFlags.length, 1);
  assert.match(gate.reviewFlags[0] ?? '', /housing_adjacent/);
  assert.match(gate.reviewFlags[0] ?? '', /sells a service to residents/);
  assert.match(gate.summary, /CONFIRM/);
  assert.match(gate.summary, /housing_adjacent/);
  store.close();
});

test('naming a clinic is not a health claim, so it does not need a human', () => {
  // A clinic is an ordinary local business to sell services to. The claim
  // checker catches an unsupportable health promise wherever it appears; the
  // niche name is the wrong place to look for one.
  for (const text of [
    'Dental clinic patient reactivation',
    'Physiotherapy clinic front-desk automation',
    'Veterinary clinic appointment reminders',
  ]) {
    assert.equal(classifyText(text, RULES).verdict, 'allowed', text);
  }
});

test('the health terms that remain still route to a human', () => {
  for (const text of ['Weight loss coaching programme', 'Cosmetic dentistry marketing', 'Supplement subscriptions']) {
    assert.equal(classifyText(text, RULES).verdict, 'review', text);
  }
});

test('the seed candidates all survive the rules, and the solar one is no longer rejected', async () => {
  const { rejectedNiches } = await generateBrief(G, { candidates: SEED_CANDIDATES });
  assert.deepEqual(
    rejectedNiches,
    [],
    'the flat list rejected "housing societies"; nothing in the seed set is actually restricted',
  );
});

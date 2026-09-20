import { test } from 'node:test';
import assert from 'node:assert/strict';
import { wilson, analyseExperiment, type ExperimentOptions } from '../src/economics/experiment.ts';
import type { Economics } from '../src/core/types.ts';

/**
 * Whether a difference between creatives is real.
 *
 * The error this exists to prevent costs money in a specific way: two
 * creatives, twenty leads each, one sale against two. The second looks twice as
 * good, the difference is nothing at all, and scaling onto it puts the whole
 * budget behind a coin that landed heads twice.
 */

function economics(over: Partial<Economics>): Economics {
  return {
    spendMinor: 100000,
    leads: 20,
    unattributedLeads: 0,
    calledLeads: 20,
    leadsAwaitingCall: 0,
    connectedLeads: 20,
    qualifiedLeads: 0,
    appointments: 0,
    sales: 0,
    revenueMinor: 0,
    cplMinor: 5000,
    costPerConnectedMinor: 5000,
    costPerQualifiedMinor: null,
    cacMinor: null,
    roas: 0,
    connectRate: 1,
    qualifyRate: 0,
    ...over,
  };
}

const variant = (adId: string, e: Partial<Economics>) => ({
  adId,
  creativeId: `cr_${adId}`,
  economics: economics(e),
});

const run = (ads: ReturnType<typeof variant>[], options?: ExperimentOptions) => analyseExperiment(ads, options);

test('wilson matches published values where the normal approximation fails', () => {
  // Zero conversions in ten trials. The textbook normal interval gives [0, 0] -
  // a claim of certainty from no evidence, which at these sample sizes is the
  // whole problem.
  const none = wilson(0, 10);
  assert.equal(Math.round(none.low * 1000) / 1000, 0);
  assert.equal(Math.round(none.high * 1000) / 1000, 0.278);

  const half = wilson(5, 10);
  assert.equal(Math.round(half.low * 1000) / 1000, 0.237);
  assert.equal(Math.round(half.high * 1000) / 1000, 0.763);

  // No observations at all says nothing, and must not say it narrowly.
  assert.deepEqual(wilson(0, 0), { low: 0, high: 1 });

  // Never outside [0, 1], whatever it is handed.
  for (const [c, n] of [[0, 1], [1, 1], [1, 2], [99, 100]] as Array<[number, number]>) {
    const w = wilson(c, n);
    assert.ok(w.low >= 0 && w.high <= 1, `${c}/${n} stayed inside [0,1]`);
    assert.ok(w.low <= w.high);
  }
});

test('a two-to-one difference on twenty leads each is not a winner', () => {
  // The exact case worth refusing. One sale against two reads as twice as good
  // and arrives by chance most of the time at this size.
  const report = run([
    variant('ad_a', { calledLeads: 20, sales: 2 }),
    variant('ad_b', { calledLeads: 20, sales: 1 }),
  ]);

  assert.equal(report.verdict.kind, 'inconclusive');
  assert.match(report.verdict.reason, /what chance looks like/);
  assert.equal(report.metric, 'sales per lead');
});

test('a difference big enough to be real is called', () => {
  // A bound that never fires is just a way of never deciding. 14 of 40 against
  // 1 of 40 is not a coin.
  const report = run([
    variant('ad_a', { calledLeads: 40, sales: 14 }),
    variant('ad_b', { calledLeads: 40, sales: 1 }),
  ]);

  assert.equal(report.verdict.kind, 'winner');
  if (report.verdict.kind !== 'winner') throw new Error('unreachable');
  assert.equal(report.verdict.leader.adId, 'ad_a');
  assert.equal(report.verdict.runnerUp.adId, 'ad_b');
});

test('too little data says so rather than picking the leader', () => {
  const report = run([
    variant('ad_a', { calledLeads: 3, sales: 2 }),
    variant('ad_b', { calledLeads: 2, sales: 0 }),
  ]);

  assert.equal(report.verdict.kind, 'too_early');
  assert.match(report.verdict.reason, /fewer than two creatives/);
});

test('it judges on outcomes that came back, not on leads captured', () => {
  // A lead still waiting for a call says nothing about the creative that
  // produced it. Counting it as a non-conversion would penalise whichever
  // variant happened to deliver most recently.
  const report = run([
    variant('ad_a', { leads: 500, calledLeads: 20, leadsAwaitingCall: 480, sales: 6 }),
    variant('ad_b', { leads: 20, calledLeads: 20, leadsAwaitingCall: 0, sales: 5 }),
  ]);

  const a = report.variants.find((v) => v.adId === 'ad_a');
  assert.equal(a?.trials, 20, 'trials are call outcomes, not captured leads');
  assert.equal(a?.rate, 6 / 20);
});

test('it falls back to qualified leads before any sale exists, and says so', () => {
  // Sales are what the system optimises for, but at zero sales they cannot
  // separate anything. The report names the metric rather than switching
  // quietly.
  const noSales = run([
    variant('ad_a', { calledLeads: 30, qualifiedLeads: 12 }),
    variant('ad_b', { calledLeads: 30, qualifiedLeads: 2 }),
  ]);
  assert.equal(noSales.metric, 'qualified per lead');
  assert.equal(noSales.verdict.kind, 'winner');

  const withSales = run([
    variant('ad_a', { calledLeads: 30, qualifiedLeads: 12, sales: 1 }),
    variant('ad_b', { calledLeads: 30, qualifiedLeads: 2 }),
  ]);
  assert.equal(withSales.metric, 'sales per lead');
});

test('zero against zero is never a winner', () => {
  // Two creatives that have both converted nothing are not distinguishable, and
  // an ordering by rate would otherwise hand the verdict to whichever sorted
  // first.
  const report = run([
    variant('ad_a', { calledLeads: 40, qualifiedLeads: 0 }),
    variant('ad_b', { calledLeads: 40, qualifiedLeads: 0 }),
  ]);
  assert.notEqual(report.verdict.kind, 'winner');
});

test('the leader is the best rate, not the most leads', () => {
  const report = run([
    variant('ad_busy', { calledLeads: 100, sales: 5 }),
    variant('ad_good', { calledLeads: 20, sales: 8 }),
  ]);
  assert.equal(report.variants[0]?.adId, 'ad_good');
});

test('a winner must beat the whole field, not just whichever sorted second', () => {
  // The sort tiebreaks equal rates by trial count, which picked the tightest
  // interval - the easiest opponent. A winner could be declared while a third
  // variant still overlapped the leader, and "the ranges do not overlap" is a
  // claim about the set.
  const report = run([
    variant('ad_b', { calledLeads: 10, sales: 3 }),
    variant('ad_c', { calledLeads: 35, sales: 0 }),
    variant('ad_a', { calledLeads: 10, sales: 0 }),
  ]);

  assert.equal(report.verdict.kind, 'inconclusive', '3/10 overlaps 0/10 and cannot be a winner');
});

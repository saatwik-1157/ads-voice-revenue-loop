import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store/db.ts';
import { defaultGuardrails } from '../src/config/guardrails.ts';
import { generateBrief } from '../src/brief/generator.ts';
import { requestGate1, approve, GATE_2 } from '../src/approvals/gates.ts';
import { publishCampaign } from '../src/meta/publisher.ts';
import { MockMetaProvider } from '../src/meta/mock.ts';
import { MockVoiceProvider } from '../src/voice/mock.ts';
import { intakeLead } from '../src/pipeline/intake.ts';
import { handleCallWebhook } from '../src/pipeline/webhooks.ts';
import { formatDuration, parseDuration, runAllCycles, runCycle, startScheduler } from '../src/scheduler.ts';
import { applyRecommendation, budgetRaiseTooSoon } from '../src/apply.ts';
import { evaluate } from '../src/economics/decision.ts';
import { runLockName, withRunLock } from '../src/store/lock.ts';
import { now } from '../src/core/util.ts';
import type { Context } from '../src/orchestrator.ts';
import type { Brief } from '../src/core/types.ts';

/** Publishing requires uploaded artwork; these tests are not about that step. */
function stampAssets(brief: Brief): Brief {
  for (const creative of brief.creatives) {
    creative.assetRef = `hash_${creative.creativeId}`;
    creative.assetProvenance = 'manual';
  }
  return brief;
}

const G = {
  ...defaultGuardrails,
  callWindow: { startHour: 0, endHour: 24, timeZone: 'UTC' },
  minHoursBetweenBudgetRaises: 24,
};

async function liveRun(overrides: Partial<typeof G> = {}): Promise<{ ctx: Context; runId: string }> {
  const guardrails = { ...G, ...overrides };
  const store = new Store(':memory:');
  const ctx = {
    store,
    guardrails,
    meta: new MockMetaProvider(11),
    voice: new MockVoiceProvider(5),
    env: { mode: 'mock', meta: { pageId: 'mock_page' } },
  } as unknown as Context;

  const { brief } = await generateBrief(guardrails);
  stampAssets(brief);
  const runId = store.createRun(brief.niche.name);
  store.saveBrief(runId, brief);
  approve(store, requestGate1(store, guardrails, runId, brief, 50000).approvalId, 'test');
  await publishCampaign(store, ctx.meta, guardrails, runId, brief, 'mock_page', {
    dailyBudgetMinor: 50000,
    windowDays: 5,
    activate: true,
  });
  return { ctx, runId };
}

/** Make the run unambiguously profitable so the engine reaches SCALE. */
function seedProfit(ctx: Context, runId: string): void {
  const campaign = ctx.store.getCampaign(runId)!;
  const winner = ctx.store.listAds(campaign.campaignId)[0]!;
  ctx.store.recordSpend({
    runId,
    adId: winner.adId,
    spendMinor: 60000,
    impressions: 5000,
    clicks: 60,
    leads: 20,
    asOf: now(),
  });
  for (let i = 1; i <= 20; i += 1) {
    const intake = intakeLead(ctx.store, ctx.guardrails, runId, {
      name: `Lead ${i}`,
      phone: `9${String(700000000 + i * 41)}`,
      consent: true,
      consentSource: 'meta_instant_form',
      adId: winner.adId,
      creativeId: winner.creativeId,
    });
    if (intake.status !== 'accepted') continue;
    const won = i <= 5;
    handleCallWebhook(ctx.store, {
      call_id: `call_${i}`,
      lead_id: intake.lead.leadId,
      connected: i <= 15,
      qualified: i <= 11,
      appointment_booked: i <= 7,
      sale_status: won ? 'won' : 'lost',
      expected_value: won ? 5000 : 0,
    });
  }
}

test('a cycle syncs, evaluates, acts, and records what it did', async () => {
  const { ctx, runId } = await liveRun();
  const result = await runCycle(ctx, runId);

  assert.equal(result.status, 'ok');
  assert.ok(result.decision, 'a completed cycle reports a decision');
  assert.match(result.summary, /KEEP|KILL|ITERATE|SCALE/);

  const cycles = ctx.store.listCycles(runId);
  assert.equal(cycles.length, 1);
  assert.equal(cycles[0]?.status, 'ok');
  assert.ok(cycles[0]?.finishedAt, 'the cycle row is closed out');
  assert.ok(ctx.store.totalSpendMinor(runId) > 0, 'insights were pulled');
  ctx.store.close();
});

test('a run a human paused is not resumed by a timer', async () => {
  const { ctx, runId } = await liveRun();
  ctx.store.setRunState(runId, 'paused', 'operator stopped it');

  const result = await runCycle(ctx, runId);
  assert.equal(result.status, 'skipped');
  assert.match(result.reason!, /human has to resume/);
  ctx.store.close();
});

test('two cycles cannot run on the same run at once', async () => {
  const { ctx, runId } = await liveRun();
  assert.equal(ctx.store.acquireLock(`cycle:${runId}`, 'someone_else', 60_000), true);

  const result = await runCycle(ctx, runId);
  assert.equal(result.status, 'skipped');
  assert.match(result.reason!, /already running/);
  ctx.store.close();
});

test('a dead cycle does not wedge the scheduler forever', async () => {
  const { ctx, runId } = await liveRun();
  const longAgo = new Date(Date.now() - 60 * 60_000);
  // A holder that died an hour ago with a 10-minute lease.
  assert.equal(ctx.store.acquireLock(`cycle:${runId}`, 'dead_process', 10 * 60_000, longAgo), true);

  const result = await runCycle(ctx, runId);
  assert.equal(result.status, 'ok', 'the expired lease is reclaimed');
  ctx.store.close();
});

test('a provider outage is recorded, not thrown at the loop', async () => {
  const { ctx, runId } = await liveRun();
  ctx.meta.insights = async () => {
    throw new Error('graph.facebook.com unreachable');
  };

  const result = await runCycle(ctx, runId);
  assert.equal(result.status, 'error');
  assert.match(result.reason!, /unreachable/);
  assert.equal(ctx.store.listCycles(runId)[0]?.status, 'error');

  const failure = ctx.store.auditTrail(runId).find((e) => e.kind === 'cycle.failed');
  assert.ok(failure, 'the failure is auditable');
  ctx.store.close();
});

test('the lock is released even when the cycle fails', async () => {
  const { ctx, runId } = await liveRun();
  ctx.meta.insights = async () => {
    throw new Error('boom');
  };
  await runCycle(ctx, runId);

  // If the lock leaked, this would come back false.
  assert.equal(ctx.store.acquireLock(`cycle:${runId}`, 'next_cycle', 1000), true);
  ctx.store.close();
});

test('an unattended loop cannot compound the budget step faster than the floor allows', async () => {
  const { ctx, runId } = await liveRun();
  seedProfit(ctx, runId);
  const before = ctx.store.getCampaign(runId)!.dailyBudgetMinor;

  const first = await runCycle(ctx, runId, { sync: false });
  assert.equal(first.outcome?.kind, 'budget_raised');
  const raised = ctx.store.getCampaign(runId)!.dailyBudgetMinor;
  assert.ok(raised > before);

  // Same day, second cycle: the step factor alone would allow another 1.3x.
  const second = await runCycle(ctx, runId, { sync: false });
  assert.equal(second.outcome?.kind, 'budget_deferred');
  assert.match((second.outcome as { reason: string }).reason, /minHoursBetweenBudgetRaises/);
  assert.equal(ctx.store.getCampaign(runId)!.dailyBudgetMinor, raised, 'budget did not move twice in a day');

  // A day later it may step again.
  const tomorrow = new Date(Date.now() + 25 * 3_600_000);
  const third = await runCycle(ctx, runId, { sync: false, now: tomorrow });
  assert.equal(third.outcome?.kind, 'budget_raised');
  assert.ok(ctx.store.getCampaign(runId)!.dailyBudgetMinor > raised);
  ctx.store.close();
});

test('budgetRaiseTooSoon measures from the last raise, and a zero floor disables it', async () => {
  const { ctx, runId } = await liveRun();
  assert.equal(budgetRaiseTooSoon(ctx, runId, new Date()), null, 'no raise yet, nothing to wait for');

  ctx.store.audit(runId, 'agent', 'budget.raised', { from: 1, to: 2 });
  assert.ok(budgetRaiseTooSoon(ctx, runId, new Date()));
  assert.equal(budgetRaiseTooSoon(ctx, runId, new Date(Date.now() + 25 * 3_600_000)), null);

  const relaxed = { ...ctx, guardrails: { ...ctx.guardrails, minHoursBetweenBudgetRaises: 0 } };
  assert.equal(budgetRaiseTooSoon(relaxed, runId, new Date()), null, 'a zero floor opts out');
  ctx.store.close();
});

test('an unattended loop files one gate #2 request, not one per cycle', async () => {
  // A tight threshold forces every scale step through gate #2.
  const { ctx, runId } = await liveRun({ budgetApprovalThresholdMinor: 1000 });
  seedProfit(ctx, runId);

  const first = await runCycle(ctx, runId, { sync: false });
  assert.equal(first.outcome?.kind, 'approval_requested');

  const second = await runCycle(ctx, runId, { sync: false });
  assert.equal(second.outcome?.kind, 'approval_pending', 'the second cycle waits rather than re-filing');

  const pending = ctx.store.pendingApprovals(runId).filter((a) => a.gate === GATE_2);
  assert.equal(pending.length, 1, 'exactly one decision is waiting on a person');
  ctx.store.close();
});

test('runAllCycles covers every live run and ignores the rest', async () => {
  const { ctx, runId } = await liveRun();
  const drafted = ctx.store.createRun('a run that never launched');

  const results = await runAllCycles(ctx);
  assert.equal(results.length, 1);
  assert.equal(results[0]?.runId, runId);
  assert.equal(ctx.store.listCycles(drafted).length, 0);
  ctx.store.close();
});

test('the loop ticks until stopped and then exits cleanly', async () => {
  const { ctx, runId } = await liveRun();
  let ticks = 0;
  const sleeps: number[] = [];

  const handle = startScheduler(ctx, {
    intervalMs: 60_000,
    runId,
    immediate: true,
    sleep: async (ms) => void sleeps.push(ms),
    onCycle: () => {
      ticks += 1;
      if (ticks >= 3) handle.stop();
    },
  });

  await handle.done;
  assert.equal(ticks, 3, 'stopped exactly when asked');
  assert.ok(sleeps.every((ms) => ms === 60_000));
  assert.equal(ctx.store.listCycles(runId).length, 3);
  ctx.store.close();
});

test('the loop waits out the first interval unless told to start immediately', async () => {
  const { ctx, runId } = await liveRun();
  const sleeps: number[] = [];
  const handle = startScheduler(ctx, {
    intervalMs: 5_000,
    runId,
    sleep: async (ms) => void sleeps.push(ms),
    onCycle: () => handle.stop(),
  });
  await handle.done;
  assert.ok(sleeps.length >= 1, 'slept before the first cycle');
  ctx.store.close();
});

test('a person running apply cannot stack a raise on top of the scheduler', async () => {
  const { ctx, runId } = await liveRun();
  seedProfit(ctx, runId);

  const cycle = await runCycle(ctx, runId, { sync: false });
  assert.equal(cycle.outcome?.kind, 'budget_raised');
  const afterCycle = ctx.store.getCampaign(runId)!.dailyBudgetMinor;

  // The CLI path, seconds later. This used to raise again - each step legal on
  // its own, 1.69x together, against a 1.3x cap and a 24h floor.
  const brief = ctx.store.getBrief(runId)!;
  const rec = evaluate(ctx.store, ctx.guardrails, runId, brief);
  const outcome = await applyRecommendation(ctx, runId, brief, rec, {});

  assert.equal(outcome.kind, 'budget_deferred');
  assert.equal(ctx.store.getCampaign(runId)!.dailyBudgetMinor, afterCycle, 'the budget did not move');
  assert.equal(ctx.store.listAudit(runId).filter((e) => e.kind === 'budget.raised').length, 1);
  ctx.store.close();
});

test('forcing past the floor works, and leaves a name behind', async () => {
  const { ctx, runId } = await liveRun();
  seedProfit(ctx, runId);
  await runCycle(ctx, runId, { sync: false });

  const brief = ctx.store.getBrief(runId)!;
  const rec = evaluate(ctx.store, ctx.guardrails, runId, brief);
  const outcome = await applyRecommendation(ctx, runId, brief, rec, { force: true, forcedBy: 'ada' });

  assert.equal(outcome.kind, 'budget_raised');
  // Overriding a cap is not the same as the cap not applying: it stays findable.
  const override = ctx.store.listAudit(runId).find((e) => e.kind === 'budget.floor_overridden');
  assert.ok(override, 'the override is audited');
  assert.equal((JSON.parse(override.detail) as { by: string }).by, 'ada');
  ctx.store.close();
});

test('an apply is turned away while a cycle is acting on the same run', async () => {
  const { ctx, runId } = await liveRun();

  // Stand in for a `serve` loop mid-cycle in another process.
  assert.ok(ctx.store.acquireLock(runLockName(runId), 'other_process', 60_000));

  const ran = await withRunLock(ctx.store, runId, () => Promise.resolve('acted'));
  assert.equal(ran, null, 'the second writer is refused rather than run');

  ctx.store.releaseLock(runLockName(runId), 'other_process');
  assert.equal(await withRunLock(ctx.store, runId, () => Promise.resolve('acted')), 'acted');
  ctx.store.close();
});

test('the run lock is released even when the work throws', async () => {
  const { ctx, runId } = await liveRun();
  await assert.rejects(
    withRunLock(ctx.store, runId, () => Promise.reject(new Error('provider down'))),
    /provider down/,
  );
  assert.equal(await withRunLock(ctx.store, runId, () => Promise.resolve('free')), 'free');
  ctx.store.close();
});

test('durations round-trip', () => {
  assert.equal(parseDuration('30s'), 30_000);
  assert.equal(parseDuration('15m'), 900_000);
  assert.equal(parseDuration('6h'), 21_600_000);
  assert.equal(parseDuration('1d'), 86_400_000);
  assert.equal(parseDuration('12'), 12 * 3_600_000, 'a bare number is hours');
  assert.equal(formatDuration(21_600_000), '6h');
  assert.equal(formatDuration(900_000), '15m');
  assert.equal(formatDuration(86_400_000), '1d');
  assert.throws(() => parseDuration('soon'), /duration/);
  assert.throws(() => parseDuration('0h'), /greater than zero/);
});

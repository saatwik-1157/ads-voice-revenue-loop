import { setTimeout as delay } from 'node:timers/promises';
import type { Context } from './orchestrator.ts';
import type { Decision } from './core/types.ts';
import { syncInsights } from './meta/publisher.ts';
import { evaluate } from './economics/decision.ts';
import { applyRecommendation, describeOutcome, type ApplyOutcome } from './apply.ts';
import { DEFAULT_LEASE_MS, PROCESS_HOLDER, runLockName } from './store/lock.ts';
import type { MockMetaProvider } from './meta/mock.ts';
import { log } from './core/log.ts';

/**
 * Phase G on a timer: sync -> evaluate -> act, unattended.
 *
 * The cycle is the unit of work and it is deliberately conservative. It can
 * pause bad creatives and step budget up inside the approved band; it cannot
 * widen a guardrail, resume a run a human paused, or file the same approval
 * twice. Anything material still stops at gate #2 and waits.
 */

export interface CycleOptions {
  /** Injectable clock, so the budget-raise interval can be tested. */
  now?: Date;
  /** How long a cycle may hold the run's lock before it is considered dead. */
  leaseMs?: number;
  /** Identifies the lock holder. Defaults to a per-process id. */
  holder?: string;
  /** Set false to evaluate and act without pulling fresh insights first. */
  sync?: boolean;
}

export type CycleStatus = 'ok' | 'skipped' | 'error';

export interface CycleResult {
  runId: string;
  status: CycleStatus;
  reason?: string;
  decision?: Decision;
  signal?: string;
  outcome?: ApplyOutcome;
  summary: string;
}

/**
 * Run one evaluation cycle for one run.
 *
 * Never throws for an operational problem - a provider outage, a missing brief,
 * a run someone paused - because the caller is usually a loop that has to keep
 * going. Those come back as `skipped` or `error` with a reason, and are written
 * to the cycles table either way.
 */
export async function runCycle(ctx: Context, runId: string, options: CycleOptions = {}): Promise<CycleResult> {
  const at = options.now ?? new Date();
  const holder = options.holder ?? PROCESS_HOLDER;
  const lease = options.leaseMs ?? DEFAULT_LEASE_MS;
  const lockName = runLockName(runId);

  const stop = ctx.store.emergencyStop();
  if (stop.engaged) {
    return skip(runId, `emergency stop engaged (${stop.trigger ?? 'unknown'}): ${stop.reason ?? ''}`);
  }

  // Two writers on one run would double-count a budget step and race on
  // pauses. `apply` takes the same lock, so a hand-run one and a scheduled
  // cycle queue behind each other instead of compounding.
  if (!ctx.store.acquireLock(lockName, holder, lease, at)) {
    return skip(runId, 'another cycle is already running for this run');
  }

  const cycleId = ctx.store.startCycle(runId, at.toISOString());
  try {
    const run = ctx.store.getRun(runId);
    if (!run) return finish(ctx, cycleId, skip(runId, `unknown run ${runId}`));

    // A run a human paused, or one that was killed, stays that way. Resuming
    // spend is a decision for a person, not for a timer.
    if (run.state === 'paused' || run.state === 'killed') {
      return finish(ctx, cycleId, skip(runId, `run is ${run.state}; a human has to resume it`));
    }
    if (run.state !== 'live') {
      return finish(ctx, cycleId, skip(runId, `run is ${run.state}, not live`));
    }

    const brief = ctx.store.getBrief(runId);
    if (!brief) return finish(ctx, cycleId, skip(runId, 'run has no brief'));
    if (!ctx.store.getCampaign(runId)) return finish(ctx, cycleId, skip(runId, 'run has no campaign'));

    if (options.sync !== false) {
      // In mock mode, advance the simulation so a cycle has new data to read.
      if (ctx.meta.kind === 'mock') (ctx.meta as MockMetaProvider).tick();
      await syncInsights(ctx.store, ctx.meta, runId);
    }

    const rec = evaluate(ctx.store, ctx.guardrails, runId, brief);
    const outcome = await applyRecommendation(ctx, runId, brief, rec, { now: at });

    const summary = `${rec.decision} (${rec.signal}) - ${describeOutcome(outcome, ctx.guardrails.currency)}`;
    // Every autonomous decision, with what it decided and what it did about it.
    log.info('autopilot.decision', {
      runId,
      cycleId,
      decision: rec.decision,
      signal: rec.signal,
      outcome: outcome.kind,
      spendMinor: rec.economics.spendMinor,
      revenueMinor: rec.economics.revenueMinor,
      leads: rec.economics.leads,
    });
    ctx.store.audit(runId, 'agent', 'cycle.completed', {
      cycleId,
      decision: rec.decision,
      signal: rec.signal,
      outcome: outcome.kind,
      pausedAds: 'pausedAds' in outcome ? outcome.pausedAds : 0,
    });

    return finish(ctx, cycleId, {
      runId,
      status: 'ok',
      decision: rec.decision,
      signal: rec.signal,
      outcome,
      summary,
    });
  } catch (err) {
    const message = (err as Error).message;
    log.error('autopilot.cycle_failed', { runId, cycleId, error: message });
    ctx.store.audit(runId, 'system', 'cycle.failed', { cycleId, error: message });
    return finish(ctx, cycleId, { runId, status: 'error', reason: message, summary: `cycle failed: ${message}` });
  } finally {
    ctx.store.releaseLock(lockName, holder);
  }
}

/** Run a cycle for every live run. */
export async function runAllCycles(ctx: Context, options: CycleOptions = {}): Promise<CycleResult[]> {
  const live = ctx.store.listRuns().filter((r) => r.state === 'live');
  const results: CycleResult[] = [];
  for (const run of live) {
    results.push(await runCycle(ctx, run.runId, options));
  }
  return results;
}

export interface SchedulerOptions {
  intervalMs: number;
  /** Limit to one run. Omit to cycle every live run each tick. */
  runId?: string;
  /** Run a cycle immediately rather than waiting out the first interval. */
  immediate?: boolean;
  onCycle?: (results: CycleResult[]) => void;
  /** Injectable sleep, so the loop can be tested without real time passing. */
  sleep?: (ms: number) => Promise<void>;
}

export interface SchedulerHandle {
  stop: () => void;
  /** Resolves once the loop has finished its current tick and exited. */
  done: Promise<void>;
}

/**
 * The loop. Ticks forever until stopped.
 *
 * It does not try to catch up on missed intervals: if the process was down for
 * a day, the right move is one cycle now, not twenty-four replayed at once
 * against stale data.
 */
export function startScheduler(ctx: Context, options: SchedulerOptions): SchedulerHandle {
  const sleep = options.sleep ?? ((ms: number) => delay(ms));
  let running = true;
  let wake: (() => void) | null = null;

  const stop = (): void => {
    running = false;
    wake?.();
  };

  const done = (async () => {
    if (!options.immediate) await interruptible(sleep, options.intervalMs);
    while (running) {
      const results = options.runId ? [await runCycle(ctx, options.runId)] : await runAllCycles(ctx);
      options.onCycle?.(results);
      if (!running) break;
      await interruptible(sleep, options.intervalMs);
    }
  })();

  /** Sleep that can be cut short by stop(), so shutdown is not delayed. */
  async function interruptible(sleepImpl: (ms: number) => Promise<void>, ms: number): Promise<void> {
    await Promise.race([
      sleepImpl(ms),
      new Promise<void>((resolve) => {
        wake = resolve;
      }),
    ]);
    wake = null;
  }

  return { stop, done };
}

const DURATION = /^(\d+(?:\.\d+)?)\s*(s|m|h|d)?$/i;

/** Parse "30s", "15m", "6h", "1d". A bare number is hours. */
export function parseDuration(input: string): number {
  const match = DURATION.exec(input.trim());
  if (!match) throw new Error(`cannot read "${input}" as a duration; use 30s, 15m, 6h or 1d`);
  const value = Number(match[1]);
  const unit = (match[2] ?? 'h').toLowerCase();
  const multiplier = unit === 's' ? 1_000 : unit === 'm' ? 60_000 : unit === 'h' ? 3_600_000 : 86_400_000;
  const ms = value * multiplier;
  if (ms <= 0) throw new Error('interval must be greater than zero');
  return ms;
}

export function formatDuration(ms: number): string {
  if (ms % 86_400_000 === 0) return `${ms / 86_400_000}d`;
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000}h`;
  if (ms % 60_000 === 0) return `${ms / 60_000}m`;
  return `${Math.round(ms / 1000)}s`;
}

function skip(runId: string, reason: string): CycleResult {
  return { runId, status: 'skipped', reason, summary: `skipped: ${reason}` };
}

function finish(ctx: Context, cycleId: string, result: CycleResult): CycleResult {
  ctx.store.finishCycle(cycleId, result.status, {
    decision: result.decision ?? null,
    signal: result.signal ?? null,
    detail: result.reason ?? result.summary,
  });
  return result;
}

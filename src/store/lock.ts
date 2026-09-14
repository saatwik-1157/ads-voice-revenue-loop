import type { Store } from './db.ts';
import { id } from '../core/util.ts';

/**
 * One run, one writer.
 *
 * The scheduler took this lock and the CLI did not, which is how a `serve`
 * loop and an operator typing `apply` could both raise the budget of the same
 * run seconds apart - each raise individually inside maxBudgetStepFactor, the
 * pair of them well outside it. Locking at the entry point only works if every
 * entry point remembers to do it, so the helper lives here and both use it.
 */

export const PROCESS_HOLDER = `pid_${process.pid}_${id('h')}`;

/** Ten minutes: long enough for a slow provider, short enough to forgive a crash. */
export const DEFAULT_LEASE_MS = 10 * 60_000;

export function runLockName(runId: string): string {
  return `cycle:${runId}`;
}

export class RunBusyError extends Error {
  readonly runId: string;
  constructor(runId: string) {
    super(`another operation is already running for run ${runId}`);
    this.name = 'RunBusyError';
    this.runId = runId;
  }
}

export interface LockOptions {
  holder?: string;
  leaseMs?: number;
  at?: Date;
}

/**
 * Run `fn` holding the run's lock, or return `null` if someone else holds it.
 *
 * Returning null rather than throwing is deliberate: the scheduler's caller is
 * a loop that has to keep going, and "someone else is on it" is a normal
 * outcome, not a failure. Callers that want a hard error can raise one.
 */
export async function withRunLock<T>(
  store: Store,
  runId: string,
  fn: () => Promise<T>,
  options: LockOptions = {},
): Promise<T | null> {
  const name = runLockName(runId);
  const holder = options.holder ?? PROCESS_HOLDER;
  const at = options.at ?? new Date();

  if (!store.acquireLock(name, holder, options.leaseMs ?? DEFAULT_LEASE_MS, at)) return null;
  try {
    return await fn();
  } finally {
    store.releaseLock(name, holder);
  }
}

import type { CycleResult } from '../scheduler.ts';

/** Terminal output and process-signal handling, shared by every command. */

export function write(text: string): void {
  process.stdout.write(`${text}\n`);
}

export function writeRaw(text: string): void {
  process.stdout.write(text);
}

/** Print to stderr and return the exit code, so callers can `return fail(...)`. */
export function fail(message: string): number {
  process.stderr.write(`${message}\n`);
  return 1;
}

export function indent(text: string, by = 4): string {
  return text
    .split('\n')
    .map((line) => `${' '.repeat(by)}${line}`)
    .join('\n');
}

export function safeParse(text: string): Record<string, unknown> | null {
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function reportCycles(results: CycleResult[]): void {
  for (const result of results) {
    const marker = result.status === 'ok' ? '' : `[${result.status}] `;
    write(`${new Date().toISOString()}  ${result.runId}  ${marker}${result.summary}`);
  }
  if (!results.length) write(`${new Date().toISOString()}  no live runs to evaluate`);
}

/**
 * Let Ctrl-C finish the cycle in flight and then exit.
 *
 * A second interrupt forces it, because an operator who has decided to stop
 * twice should not have to wait for a provider timeout.
 */
export function stopOnSignal(stop: () => void): void {
  let stopping = false;
  const handler = (): void => {
    if (stopping) process.exit(130);
    stopping = true;
    write('\nstopping after the current cycle; Ctrl-C again to force');
    stop();
  };
  process.on('SIGINT', handler);
  process.on('SIGTERM', handler);
}

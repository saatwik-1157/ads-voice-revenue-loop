import type { Command } from '../registry.ts';
import { flagIsSet } from '../args.ts';
import { fail, write } from '../io.ts';
import { maskPhone } from '../../core/util.ts';

/**
 * Reading the audit trail.
 *
 * Every guardrail refusal is recorded there and only there, so without this an
 * operator watching leads arrive and no calls go out has no way to tell a
 * broken funnel from a rule doing its job - short of opening the database.
 */
export const auditCommands: Command[] = [
  {
    name: 'audit',
    usage: '[runId] [--kind K] [--actor A] [--limit N] [--all] [--system]',
    summary: 'What the system did, and which rules fired',
    run: (ctx, args) => {
      // Events belonging to no run - requests the server refused before it knew
      // which run they concerned. Without a way to ask for them they were
      // written and then unreachable by any query in the codebase.
      const system = flagIsSet(args, 'system');
      const runId = system ? null : (args.positional[0] ?? ctx.store.latestRun() ?? null);
      if (!system && !runId) return Promise.resolve(fail('no run'));
      const label = runId ?? 'system (events with no run)';

      const filtered = Boolean(args.flags.kind ?? args.flags.actor);
      const limit = Number(args.flags.limit ?? (args.flags.all === 'true' ? 10_000 : 20));

      // The summary answers "what happened at all" at a glance; the stream
      // answers "and what exactly". Filtering skips straight to the stream.
      if (!filtered) {
        const summary = ctx.store.auditSummary(runId);
        if (!summary.length) {
          write(`no audit events for ${label}`);
          return Promise.resolve(0);
        }
        write(`${label}\n`);
        for (const row of summary) {
          write(`  ${String(row.count).padStart(5)}  ${row.kind.padEnd(24)} ${row.actor.padEnd(7)} last ${row.last}`);
        }
        write('');
      }

      const events = ctx.store.listAudit(runId, {
        kind: args.flags.kind,
        actor: args.flags.actor,
        limit,
      });
      if (!events.length) {
        write('no events match that filter');
        return Promise.resolve(0);
      }

      write(filtered ? `${events.length} event(s), newest first:` : `last ${events.length}, newest first:`);
      for (const event of events) {
        write(`  ${event.at}  ${event.actor.padEnd(7)} ${event.kind.padEnd(24)} ${summarise(event.detail)}`);
      }
      if (!filtered && !args.flags.all) {
        write('\n  --all for everything, --kind call for one family, --kind call.deferred for one kind');
      }
      return Promise.resolve(0);
    },
  },
];

/**
 * Audit details are JSON blobs. Flatten them to one readable line, and never
 * print a full phone number - the log is read far more often than it is
 * written, usually over someone's shoulder.
 */
function summarise(detail: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(detail);
  } catch {
    return detail;
  }
  if (parsed === null || typeof parsed !== 'object') return String(parsed);

  return Object.entries(parsed as Record<string, unknown>)
    .map(([key, value]) => {
      const text = typeof value === 'string' ? value : JSON.stringify(value);
      if (/phone/i.test(key) && typeof value === 'string') return `${key}=${maskPhone(value)}`;
      return `${key}=${text.length > 48 ? `${text.slice(0, 47)}…` : text}`;
    })
    .join(' ');
}

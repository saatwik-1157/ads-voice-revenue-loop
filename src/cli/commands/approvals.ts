import type { Command } from '../registry.ts';
import { fail, indent, safeParse, write } from '../io.ts';
import { approve, reject } from '../../approvals/gates.ts';

export const approvalCommands: Command[] = [
  {
    name: 'approvals',
    usage: '[runId]',
    summary: 'What is waiting on a human',
    run: (ctx, args) => {
      const runId = args.positional[0] ?? ctx.store.latestRun();
      if (!runId) {
        write('no runs yet');
        return Promise.resolve(1);
      }
      const pending = ctx.store.pendingApprovals(runId);
      if (!pending.length) {
        write(`no pending approvals for ${runId}`);
        return Promise.resolve(0);
      }
      for (const p of pending) {
        write(`${p.approvalId}  [${p.gate}]  ${p.subject}`);
        const detail = safeParse(p.detail);
        // The summary is JSON we wrote ourselves, but this reads it back off
        // disk - a hand-edited row should not print "[object Object]".
        if (typeof detail?.summary === 'string') write(indent(detail.summary));
      }
      return Promise.resolve(0);
    },
  },

  {
    name: 'approve',
    usage: '<approvalId> --by NAME',
    summary: 'Grant an approval',
    run: (ctx, args) => {
      const approvalId = args.positional[0];
      const by = args.flags.by;
      if (!approvalId || !by) return Promise.resolve(fail('usage: approve <approvalId> --by "name"'));

      const ok = approve(ctx.store, approvalId, by);
      write(ok ? `approved ${approvalId}` : `no pending approval ${approvalId}`);
      return Promise.resolve(ok ? 0 : 1);
    },
  },

  {
    name: 'reject',
    usage: '<approvalId> --by NAME --reason TEXT',
    summary: 'Refuse an approval',
    run: (ctx, args) => {
      const approvalId = args.positional[0];
      if (!approvalId || !args.flags.by) {
        return Promise.resolve(fail('usage: reject <approvalId> --by "name" --reason "why"'));
      }
      const ok = reject(ctx.store, approvalId, args.flags.by, args.flags.reason ?? '');
      write(ok ? `rejected ${approvalId}` : `no pending approval ${approvalId}`);
      return Promise.resolve(ok ? 0 : 1);
    },
  },
];

import type { Command } from '../registry.ts';
import { flagIsSet } from '../args.ts';
import { fail, write } from '../io.ts';
import { withRunLock } from '../../store/lock.ts';
import { evaluate } from '../../economics/decision.ts';
import { economicsForRun } from '../../economics/metrics.ts';
import { formatEconomics, formatRecommendation } from '../../report.ts';
import { applyRecommendation, describeOutcome } from '../../apply.ts';

export const reviewCommands: Command[] = [
  {
    name: 'economics',
    usage: '[runId]',
    summary: 'The funnel numbers on their own',
    run: (ctx, args) => {
      const runId = args.positional[0] ?? ctx.store.latestRun();
      if (!runId) return Promise.resolve(fail('no run'));
      write(formatEconomics(economicsForRun(ctx.store, runId), ctx.guardrails));
      return Promise.resolve(0);
    },
  },

  {
    name: 'review',
    usage: '[runId]',
    summary: 'Phase G: economics + KEEP/KILL/ITERATE/SCALE',
    run: (ctx, args) => {
      const runId = args.positional[0] ?? ctx.store.latestRun();
      if (!runId) return Promise.resolve(fail('no run to review'));
      const brief = ctx.store.getBrief(runId);
      if (!brief) return Promise.resolve(fail(`run ${runId} has no brief`));
      write(formatRecommendation(evaluate(ctx.store, ctx.guardrails, runId, brief), ctx.guardrails));
      return Promise.resolve(0);
    },
  },

  {
    name: 'apply',
    usage: '[runId] [--force --by <name>]',
    summary: 'Act on the last review, within the caps',
    run: async (ctx, args) => {
      const runId = args.positional[0] ?? ctx.store.latestRun();
      if (!runId) return fail('no run to act on');
      const brief = ctx.store.getBrief(runId);
      if (!brief) return fail(`run ${runId} has no brief`);
      if (!ctx.store.getCampaign(runId)) return fail(`run ${runId} has no campaign`);

      const force = flagIsSet(args, 'force');
      const forcedBy = args.flags.by;
      if (force && !forcedBy) {
        return fail('--force overrides a cap, so it needs --by "your name" for the audit trail.');
      }

      // The same lock the scheduler takes. Without it a `serve` loop and a
      // person typing `apply` could each raise the budget by an individually
      // legal step seconds apart, and together land well outside the cap.
      const outcome = await withRunLock(ctx.store, runId, async () => {
        const rec = evaluate(ctx.store, ctx.guardrails, runId, brief);
        write(`${formatRecommendation(rec, ctx.guardrails)}\n`);
        return applyRecommendation(ctx, runId, brief, rec, { force, forcedBy });
      });

      if (!outcome) {
        return fail(
          [
            `run ${runId} is busy - a scheduled cycle is acting on it right now.`,
            'Nothing was changed. Try again in a moment, or stop the scheduler first.',
          ].join('\n'),
        );
      }

      if ('pausedAds' in outcome && outcome.pausedAds) write(`paused ${outcome.pausedAds} creative(s)`);
      if ('plan' in outcome) {
        for (const warning of outcome.plan.warnings) write(`WARNING: ${warning}`);
      }
      write(describeOutcome(outcome, ctx.guardrails.currency));
      if (outcome.kind === 'approval_requested') {
        write(`approve with: node src/cli.ts approve ${outcome.approvalId} --by "your name"`);
      }
      if (outcome.kind === 'budget_deferred') {
        write('this is a cap, not a queue. override deliberately with:');
        write(`  node src/cli.ts apply ${runId} --force --by "your name"`);
      }
      return 0;
    },
  },
];

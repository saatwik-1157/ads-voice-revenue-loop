import type { Command } from '../registry.ts';
import { fail, write } from '../io.ts';
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
    usage: '[runId]',
    summary: 'Act on the last review, within the caps',
    run: async (ctx, args) => {
      const runId = args.positional[0] ?? ctx.store.latestRun();
      if (!runId) return fail('no run to act on');
      const brief = ctx.store.getBrief(runId);
      if (!brief) return fail(`run ${runId} has no brief`);
      if (!ctx.store.getCampaign(runId)) return fail(`run ${runId} has no campaign`);

      const rec = evaluate(ctx.store, ctx.guardrails, runId, brief);
      write(`${formatRecommendation(rec, ctx.guardrails)}\n`);

      // unattended:false - a person running this by hand has already decided to
      // act, so the inter-raise cooldown that paces the scheduler does not apply.
      const outcome = await applyRecommendation(ctx, runId, brief, rec, { unattended: false });
      if ('pausedAds' in outcome && outcome.pausedAds) write(`paused ${outcome.pausedAds} creative(s)`);
      if ('plan' in outcome) {
        for (const warning of outcome.plan.warnings) write(`WARNING: ${warning}`);
      }
      write(describeOutcome(outcome, ctx.guardrails.currency));
      if (outcome.kind === 'approval_requested') {
        write(`approve with: node src/cli.ts approve ${outcome.approvalId} --by "your name"`);
      }
      return 0;
    },
  },
];

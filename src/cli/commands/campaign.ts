import type { Command } from '../registry.ts';
import { flagIsSet, minorFromFlag } from '../args.ts';
import { fail, write } from '../io.ts';
import { ensureCreativeAssets, missingAssets } from '../../creative/pipeline.ts';
import { publishCampaign, syncInsights } from '../../meta/publisher.ts';
import { money } from '../../core/util.ts';
import type { MockMetaProvider } from '../../meta/mock.ts';

/** The default test budget: a third of the cap, so a run has three days in it. */
function defaultDailyBudget(ctx: { guardrails: { maxDailySpendMinor: number; maxTestBudgetMinor: number } }): number {
  // Floor: a share of a total must never round up past it.
  return Math.min(ctx.guardrails.maxDailySpendMinor, Math.floor(ctx.guardrails.maxTestBudgetMinor / 3));
}

export const campaignCommands: Command[] = [
  {
    name: 'assets',
    usage: '[runId] [--force]',
    summary: 'Produce and upload artwork for each creative',
    run: async (ctx, args) => {
      const runId = args.positional[0] ?? ctx.store.latestRun();
      if (!runId) return fail('no run');
      const brief = ctx.store.getBrief(runId);
      if (!brief) return fail(`run ${runId} has no brief`);

      write(`producing artwork with the ${ctx.assets.kind} provider`);
      const outcomes = await ensureCreativeAssets(ctx.store, ctx.meta, ctx.assets, runId, brief, {
        previewDir: ctx.env.previewDir,
        force: flagIsSet(args, 'force'),
      });
      for (const outcome of outcomes) {
        if (outcome.status === 'failed') {
          write(`  FAILED  ${outcome.creativeId}: ${outcome.error}`);
          continue;
        }
        const where = outcome.previewPath ? `  preview: ${outcome.previewPath}` : '';
        write(
          `  ${outcome.status.padEnd(8)} ${outcome.creativeId}  ${outcome.assetRef} (${outcome.provenance ?? 'unknown'})${where}`,
        );
      }
      return outcomes.some((o) => o.status === 'failed') ? 1 : 0;
    },
  },

  {
    name: 'publish',
    usage: '[runId] [--budget MAJOR] [--days N] [--lead-form ID] [--activate]',
    summary: 'Phase D: create the campaign structure',
    run: async (ctx, args) => {
      const runId = args.positional[0] ?? ctx.store.latestRun();
      if (!runId) return fail('no run to publish');
      const brief = ctx.store.getBrief(runId);
      if (!brief) return fail(`run ${runId} has no brief`);

      // A brief made before the creative engine existed has no artwork yet.
      if (missingAssets(brief).length) {
        write(`producing artwork with the ${ctx.assets.kind} provider`);
        const outcomes = await ensureCreativeAssets(ctx.store, ctx.meta, ctx.assets, runId, brief, {
          previewDir: ctx.env.previewDir,
        });
        for (const outcome of outcomes.filter((o) => o.status === 'failed')) {
          process.stderr.write(`  FAILED  ${outcome.creativeId}: ${outcome.error}\n`);
        }
      }

      const dailyBudgetMinor = minorFromFlag(args, 'budget') ?? defaultDailyBudget(ctx);
      const result = await publishCampaign(
        ctx.store,
        ctx.meta,
        ctx.guardrails,
        runId,
        brief,
        ctx.env.meta.pageId || 'mock_page',
        {
          dailyBudgetMinor,
          windowDays: Number(args.flags.days ?? 3),
          leadFormId: args.flags['lead-form'] ?? null,
          activate: flagIsSet(args, 'activate'),
        },
      );
      write(`campaign ${result.campaign.campaignId} (adset ${result.campaign.adsetId}) with ${result.ads.length} ads`);
      write(
        result.activated
          ? `ACTIVE at ${money(dailyBudgetMinor, ctx.guardrails.currency)}/day`
          : 'published PAUSED - activate with --activate once you have eyes on it',
      );
      return 0;
    },
  },

  {
    name: 'sync',
    usage: '[runId]',
    summary: 'Pull Meta insights into the local store',
    run: async (ctx, args) => {
      const runId = args.positional[0] ?? ctx.store.latestRun();
      if (!runId) return fail('no run to sync');
      // In mock mode advance simulated delivery first, so `sync` has something
      // new to report.
      if (ctx.meta.kind === 'mock') (ctx.meta as MockMetaProvider).tick();
      const result = await syncInsights(ctx.store, ctx.meta, runId);
      write(
        `synced ${result.adIds.length} ads, cumulative spend ${money(result.totalSpendMinor, ctx.guardrails.currency)}`,
      );
      return 0;
    },
  },
];

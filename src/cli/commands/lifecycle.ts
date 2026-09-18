import type { Command } from '../registry.ts';
import { minorFromFlag } from '../args.ts';
import { write, writeRaw } from '../io.ts';
import { generateBrief } from '../../brief/generator.ts';
import { hasAnthropicCredentials } from '../../config/env.ts';
import { requestGate1 } from '../../approvals/gates.ts';
import { ensureCreativeAssets } from '../../creative/pipeline.ts';
import { formatBrief } from '../../report.ts';

export const lifecycleCommands: Command[] = [
  {
    name: 'runs',
    usage: '',
    summary: 'List runs',
    run: (ctx) => {
      const runs = ctx.store.listRuns();
      if (!runs.length) {
        write('no runs yet - start with: node src/cli.ts brief');
        return Promise.resolve(0);
      }
      for (const run of runs) write(`${run.runId}  ${run.state.padEnd(14)} ${run.niche}`);
      return Promise.resolve(0);
    },
  },

  {
    name: 'brief',
    usage: '[--deal-value MAJOR]',
    summary: 'Phase B: brief + artwork, opens gate #1',
    run: async (ctx, args) => {
      const result = await generateBrief(ctx.guardrails, {
        anthropicKey: ctx.env.anthropicKey || undefined,
        useModel: hasAnthropicCredentials(ctx.env),
        dealValueMinor: minorFromFlag(args, 'deal-value'),
      });
      const runId = ctx.store.createRun(result.brief.niche.name);
      ctx.store.saveBrief(runId, result.brief);
      write(`run ${runId}\n`);
      write(`${formatBrief(result.brief, ctx.guardrails)}\n`);

      // Artwork is produced before the gate, not after it: gate #1 asks a
      // person to approve the creative, and they cannot do that without it.
      write(`producing artwork with the ${ctx.assets.kind} provider`);
      for (const outcome of await ensureCreativeAssets(ctx.store, ctx.meta, ctx.assets, runId, result.brief, {
        previewDir: ctx.env.previewDir,
      })) {
        write(
          outcome.status === 'failed'
            ? `  FAILED  ${outcome.creativeId}: ${outcome.error}`
            : `  ${outcome.creativeId}  ${outcome.previewPath ?? outcome.assetRef}`,
        );
      }
      writeRaw('\n');

      // Floor: a share of a total must never round up past it.
      const budget = Math.min(ctx.guardrails.maxDailySpendMinor, Math.floor(ctx.guardrails.maxTestBudgetMinor / 3));
      const gate = requestGate1(ctx.store, ctx.guardrails, runId, result.brief, budget, result.reviewFlags);
      write(`GATE #1 requested: ${gate.approvalId}\n${gate.summary}`);
      if (gate.blocking.length) {
        write('\nBLOCKING ISSUES (regenerate the brief; do not approve past these):');
        for (const issue of gate.blocking) write(`  - ${issue}`);
        return 1;
      }
      write(`\nApprove with: node src/cli.ts approve ${gate.approvalId} --by "your name"`);
      return 0;
    },
  },
];

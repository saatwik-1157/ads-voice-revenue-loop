import { createContext, voiceWebhookUrl, type Context } from './orchestrator.ts';
import { createHttpServer } from './server/http.ts';
import { generateBrief } from './brief/generator.ts';
import { approve, reject, requestGate1, requestGate2 } from './approvals/gates.ts';
import { publishCampaign, syncInsights } from './meta/publisher.ts';
import { evaluate, planScale } from './economics/decision.ts';
import { economicsForRun } from './economics/metrics.ts';
import { formatBrief, formatEconomics, formatRecommendation } from './report.ts';
import { runDemo } from './demo/e2e.ts';
import { money } from './core/util.ts';
import { pauseKilledAds } from './apply.ts';
import type { MockMetaProvider } from './meta/mock.ts';

const USAGE = `founder-labs-autopilot - autonomous Ads -> Voice -> Revenue loop

  node src/cli.ts <command> [options]

Commands
  demo [--days N]                 Run the whole loop end to end against mock providers
  brief [--deal-value MAJOR]      Phase B: write the brief, open human gate #1
  approvals [runId]               List pending approvals
  approve <approvalId> --by NAME  Grant an approval
  reject  <approvalId> --by NAME --reason TEXT
  publish <runId> [--budget MAJOR] [--days N] [--lead-form ID] [--activate]
  sync <runId>                    Pull Meta insights into the local store
  review <runId>                  Phase G: economics + KEEP/KILL/ITERATE/SCALE
  apply <runId>                   Act on the last review, within the caps
  runs                            List runs
  serve                           Start the webhook/middleware server
  guardrails                      Print the active control layer

Everything runs against mock providers unless FL_MODE=live and credentials are set.
`;

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  const flags = parseFlags(rest);
  const positional = rest.filter((a) => !a.startsWith('--') && !isFlagValue(rest, a));

  if (!command || command === 'help' || command === '--help') {
    process.stdout.write(USAGE);
    return 0;
  }

  const ctx = createContext();
  try {
    switch (command) {
      case 'demo':
        await runDemo(ctx, { days: Number(flags.days ?? 7) });
        return 0;

      case 'guardrails':
        process.stdout.write(`${JSON.stringify(ctx.guardrails, null, 2)}\n`);
        return 0;

      case 'runs': {
        const runs = ctx.store.listRuns();
        if (!runs.length) {
          process.stdout.write('no runs yet - start with: node src/cli.ts brief\n');
          return 0;
        }
        for (const run of runs) {
          process.stdout.write(`${run.runId}  ${run.state.padEnd(14)} ${run.niche}\n`);
        }
        return 0;
      }

      case 'brief': {
        const dealValueMinor = flags['deal-value'] ? Math.round(Number(flags['deal-value']) * 100) : undefined;
        const result = await generateBrief(ctx.guardrails, {
          anthropicKey: ctx.env.anthropicKey || undefined,
          dealValueMinor,
        });
        const runId = ctx.store.createRun(result.brief.niche.name);
        ctx.store.saveBrief(runId, result.brief);
        process.stdout.write(`run ${runId}\n\n`);
        process.stdout.write(`${formatBrief(result.brief, ctx.guardrails)}\n\n`);

        const budget = Math.min(ctx.guardrails.maxDailySpendMinor, Math.round(ctx.guardrails.maxTestBudgetMinor / 3));
        const gate = requestGate1(ctx.store, ctx.guardrails, runId, result.brief, budget);
        process.stdout.write(`GATE #1 requested: ${gate.approvalId}\n${gate.summary}\n`);
        if (gate.blocking.length) {
          process.stdout.write('\nBLOCKING ISSUES (regenerate the brief; do not approve past these):\n');
          for (const issue of gate.blocking) process.stdout.write(`  - ${issue}\n`);
          return 1;
        }
        process.stdout.write(`\nApprove with: node src/cli.ts approve ${gate.approvalId} --by "your name"\n`);
        return 0;
      }

      case 'approvals': {
        const runId = positional[0] ?? ctx.store.latestRun();
        if (!runId) {
          process.stdout.write('no runs yet\n');
          return 1;
        }
        const pending = ctx.store.pendingApprovals(runId);
        if (!pending.length) {
          process.stdout.write(`no pending approvals for ${runId}\n`);
          return 0;
        }
        for (const p of pending) {
          process.stdout.write(`${p.approvalId}  [${p.gate}]  ${p.subject}\n`);
          const detail = safeParse(p.detail);
          if (detail?.summary) process.stdout.write(`${indent(String(detail.summary))}\n`);
        }
        return 0;
      }

      case 'approve': {
        const approvalId = positional[0];
        const by = flags.by;
        if (!approvalId || !by) {
          process.stderr.write('usage: approve <approvalId> --by "name"\n');
          return 1;
        }
        const ok = approve(ctx.store, approvalId, by);
        process.stdout.write(ok ? `approved ${approvalId}\n` : `no pending approval ${approvalId}\n`);
        return ok ? 0 : 1;
      }

      case 'reject': {
        const approvalId = positional[0];
        if (!approvalId || !flags.by) {
          process.stderr.write('usage: reject <approvalId> --by "name" --reason "why"\n');
          return 1;
        }
        const ok = reject(ctx.store, approvalId, flags.by, flags.reason ?? '');
        process.stdout.write(ok ? `rejected ${approvalId}\n` : `no pending approval ${approvalId}\n`);
        return ok ? 0 : 1;
      }

      case 'publish': {
        const runId = positional[0] ?? ctx.store.latestRun();
        if (!runId) return fail('no run to publish');
        const brief = ctx.store.getBrief(runId);
        if (!brief) return fail(`run ${runId} has no brief`);
        const dailyBudgetMinor = flags.budget
          ? Math.round(Number(flags.budget) * 100)
          : Math.min(ctx.guardrails.maxDailySpendMinor, Math.round(ctx.guardrails.maxTestBudgetMinor / 3));
        const result = await publishCampaign(
          ctx.store,
          ctx.meta,
          ctx.guardrails,
          runId,
          brief,
          ctx.env.meta.pageId || 'mock_page',
          {
            dailyBudgetMinor,
            windowDays: Number(flags.days ?? 3),
            leadFormId: flags['lead-form'] ?? null,
            activate: flags.activate === 'true',
          },
        );
        process.stdout.write(
          `campaign ${result.campaign.campaignId} (adset ${result.campaign.adsetId}) with ${result.ads.length} ads\n`,
        );
        process.stdout.write(
          result.activated
            ? `ACTIVE at ${money(dailyBudgetMinor, ctx.guardrails.currency)}/day\n`
            : 'published PAUSED - activate with --activate once you have eyes on it\n',
        );
        return 0;
      }

      case 'sync': {
        const runId = positional[0] ?? ctx.store.latestRun();
        if (!runId) return fail('no run to sync');
        // In mock mode advance simulated delivery first, so `sync` has something
        // new to report.
        if (ctx.meta.kind === 'mock') (ctx.meta as MockMetaProvider).tick();
        const result = await syncInsights(ctx.store, ctx.meta, runId);
        process.stdout.write(
          `synced ${result.adIds.length} ads, cumulative spend ${money(result.totalSpendMinor, ctx.guardrails.currency)}\n`,
        );
        return 0;
      }

      case 'review': {
        const runId = positional[0] ?? ctx.store.latestRun();
        if (!runId) return fail('no run to review');
        const brief = ctx.store.getBrief(runId);
        if (!brief) return fail(`run ${runId} has no brief`);
        process.stdout.write(`${formatRecommendation(evaluate(ctx.store, ctx.guardrails, runId, brief), ctx.guardrails)}\n`);
        return 0;
      }

      case 'economics': {
        const runId = positional[0] ?? ctx.store.latestRun();
        if (!runId) return fail('no run');
        process.stdout.write(`${formatEconomics(economicsForRun(ctx.store, runId), ctx.guardrails)}\n`);
        return 0;
      }

      case 'apply': {
        const runId = positional[0] ?? ctx.store.latestRun();
        if (!runId) return fail('no run to act on');
        return await applyDecision(ctx, runId);
      }

      case 'serve': {
        const server = createHttpServer(ctx);
        server.listen(ctx.env.port, () => {
          process.stdout.write(`listening on http://localhost:${ctx.env.port}  (mode=${ctx.env.mode})\n`);
          process.stdout.write(`  Meta leadgen webhook  POST ${ctx.env.publicBaseUrl}/webhooks/meta\n`);
          process.stdout.write(`  Voice result webhook  POST ${voiceWebhookUrl(ctx.env)}\n`);
          if (!ctx.env.meta.appSecret || !ctx.env.omni.webhookSecret) {
            process.stdout.write('  WARNING: webhook secrets are unset, so every inbound payload will be rejected.\n');
          }
        });
        await new Promise(() => {});
        return 0;
      }

      default:
        process.stderr.write(`unknown command "${command}"\n\n${USAGE}`);
        return 1;
    }
  } finally {
    if (command !== 'serve') ctx.store.close();
  }
}

/** Act on the current recommendation, staying inside what the agent may do alone. */
async function applyDecision(ctx: Context, runId: string): Promise<number> {
  const brief = ctx.store.getBrief(runId);
  if (!brief) return fail(`run ${runId} has no brief`);
  const campaign = ctx.store.getCampaign(runId);
  if (!campaign) return fail(`run ${runId} has no campaign`);

  const rec = evaluate(ctx.store, ctx.guardrails, runId, brief);
  process.stdout.write(`${formatRecommendation(rec, ctx.guardrails)}\n\n`);

  if (rec.decision === 'KILL' && rec.requiresHumanApproval) {
    await ctx.meta.setStatus(campaign.campaignId, 'PAUSED');
    ctx.store.setCampaignStatus(campaign.campaignId, 'PAUSED');
    ctx.store.setRunState(runId, 'paused', rec.rationale);
    ctx.store.audit(runId, 'agent', 'campaign.paused', { reason: rec.signal });
    process.stdout.write('campaign PAUSED and handed back to a human.\n');
    return 0;
  }

  const plan = planScale(ctx.guardrails, campaign.dailyBudgetMinor, rec.decision, rec.perAd);
  const paused = await pauseKilledAds(ctx, runId, rec, plan);
  if (paused) process.stdout.write(`paused ${paused} creative(s)\n`);
  for (const warning of plan.warnings) process.stdout.write(`WARNING: ${warning}\n`);

  if (plan.proposedDailyMinor === campaign.dailyBudgetMinor) {
    process.stdout.write(`no budget change (${plan.reason})\n`);
    return 0;
  }

  if (plan.needsApproval) {
    const request = requestGate2(
      ctx.store,
      runId,
      `Raise daily budget to ${money(plan.proposedDailyMinor, ctx.guardrails.currency)}`,
      {
        from: campaign.dailyBudgetMinor,
        to: plan.proposedDailyMinor,
        proven: plan.provenDailyMinor,
        holdout: plan.holdoutDailyMinor,
        holdoutAds: plan.holdoutAdIds,
        reason: plan.reason,
      },
    );
    process.stdout.write(`GATE #2 requested ${request.approvalId}: ${plan.reason}\n`);
    process.stdout.write(`approve with: node src/cli.ts approve ${request.approvalId} --by "your name"\n`);
    return 0;
  }

  await ctx.meta.setDailyBudget(campaign.adsetId, plan.proposedDailyMinor);
  ctx.store.setCampaignBudget(campaign.campaignId, plan.proposedDailyMinor);
  ctx.store.audit(runId, 'agent', 'budget.raised', {
    from: campaign.dailyBudgetMinor,
    to: plan.proposedDailyMinor,
    provenDailyMinor: plan.provenDailyMinor,
    holdoutDailyMinor: plan.holdoutDailyMinor,
    holdoutAdIds: plan.holdoutAdIds,
  });
  process.stdout.write(
    `budget raised to ${money(plan.proposedDailyMinor, ctx.guardrails.currency)}/day ` +
      `(${money(plan.provenDailyMinor, ctx.guardrails.currency)} proven + ` +
      `${money(plan.holdoutDailyMinor, ctx.guardrails.currency)} holdout across ${plan.holdoutAdIds.length} test creative(s))\n`,
  );
  return 0;
}

function parseFlags(args: string[]): Record<string, string> {
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = args[i + 1];
    if (next === undefined || next.startsWith('--')) {
      flags[key] = 'true';
    } else {
      flags[key] = next;
      i += 1;
    }
  }
  return flags;
}

function isFlagValue(args: string[], value: string): boolean {
  const index = args.indexOf(value);
  return index > 0 && args[index - 1]!.startsWith('--');
}

function safeParse(text: string): Record<string, unknown> | null {
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function indent(text: string): string {
  return text
    .split('\n')
    .map((line) => `    ${line}`)
    .join('\n');
}

function fail(message: string): number {
  process.stderr.write(`${message}\n`);
  return 1;
}

const code = await main(process.argv.slice(2));
process.exit(code);

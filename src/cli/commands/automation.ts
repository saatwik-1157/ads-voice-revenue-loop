import type { Command } from '../registry.ts';
import { fail, reportCycles, stopOnSignal, write } from '../io.ts';
import { formatDuration, parseDuration, runAllCycles, runCycle, startScheduler } from '../../scheduler.ts';
import { createHttpServer } from '../../server/http.ts';
import { runSafetyCheck } from '../../safety/monitor.ts';
import { voiceWebhookUrl } from '../../orchestrator.ts';
import type { Context } from '../../orchestrator.ts';
import type { Args } from '../args.ts';

function intervalFrom(ctx: Context, args: Args): number {
  return args.flags.every ? parseDuration(args.flags.every) : ctx.guardrails.evaluationIntervalHours * 3_600_000;
}

export const automationCommands: Command[] = [
  {
    name: 'cycle',
    usage: '[runId]',
    summary: 'One unattended cycle: sync + review + apply',
    run: async (ctx, args) => {
      const runId = args.positional[0];
      const results = runId ? [await runCycle(ctx, runId)] : await runAllCycles(ctx);
      reportCycles(results);
      return results.some((r) => r.status === 'error') ? 1 : 0;
    },
  },

  {
    name: 'schedule',
    usage: '[runId] [--every 6h]',
    summary: 'Run the evaluation cycle on a loop until stopped',
    run: async (ctx, args) => {
      const intervalMs = intervalFrom(ctx, args);
      const runId = args.positional[0];
      write(
        `evaluating ${runId ?? 'every live run'} every ${formatDuration(intervalMs)} (mode=${ctx.env.mode}); Ctrl-C to stop`,
      );
      const handle = startScheduler(ctx, {
        intervalMs,
        runId,
        immediate: args.flags.immediate !== 'false',
        onCycle: reportCycles,
      });
      stopOnSignal(() => handle.stop());
      await handle.done;
      return 0;
    },
  },

  {
    name: 'cycles',
    usage: '[runId] [--limit N]',
    summary: 'What the loop has been doing',
    run: (ctx, args) => {
      const runId = args.positional[0] ?? ctx.store.latestRun();
      if (!runId) return Promise.resolve(fail('no run'));
      const rows = ctx.store.listCycles(runId, Number(args.flags.limit ?? 20));
      if (!rows.length) {
        write(`no cycles recorded for ${runId}`);
        return Promise.resolve(0);
      }
      for (const row of rows) {
        write(`${row.startedAt}  ${row.status.padEnd(8)} ${(row.decision ?? '-').padEnd(8)} ${row.signal ?? ''}`);
        if (row.detail && row.detail !== 'null') write(`    ${row.detail}`);
      }
      return Promise.resolve(0);
    },
  },

  {
    name: 'serve',
    usage: '[--schedule] [--every 6h]',
    summary: 'Webhook server, optionally with the cycle loop',
    // Blocks forever when not scheduling, so the store stays open.
    holdsProcess: true,
    run: async (ctx, args) => {
      const server = createHttpServer(ctx);
      const scheduling = args.flags.schedule === 'true' || Boolean(args.flags.every);

      server.listen(ctx.env.port, () => {
        write(`listening on http://localhost:${ctx.env.port}  (mode=${ctx.env.mode})`);
        write(`  Meta leadgen webhook  POST ${ctx.env.publicBaseUrl}/webhooks/meta`);
        write(`  Voice result webhook  POST ${voiceWebhookUrl(ctx.env)}`);
        // Named separately. One warning covering both routes claimed "every
        // inbound payload will be rejected" whenever either was unset, which is
        // false for the route that is configured - and sends an operator
        // hunting for a fault in credentials that are working correctly.
        if (!ctx.env.meta.appSecret) {
          write('  WARNING: META_APP_SECRET is unset - Meta leadgen payloads will all be rejected (401).');
        }
        if (!ctx.env.omni.webhookSecret && !ctx.env.omni.webhookToken) {
          write('  WARNING: no OMNI_WEBHOOK_SECRET or OMNI_WEBHOOK_TOKEN - post-call results will all');
          write('           be rejected (401). Prefer the secret; the token is the weaker fallback.');
        }
      });

      // The fast safety loop. Separate interval on purpose: "is this campaign
      // working" is worth answering slowly on plenty of data, and "is something
      // going wrong right now" is worth answering often on almost none. Running
      // both on one timer is what made the stop-loss weak - it was only checked
      // once per evaluation interval.
      const safetyMs = args.flags.safety ? parseDuration(args.flags.safety) : 60_000;
      let safetyTimer: NodeJS.Timeout | null = null;
      if (scheduling) {
        write(`  safety check every ${formatDuration(safetyMs)}`);
        safetyTimer = setInterval(() => {
          try {
            const report = runSafetyCheck(ctx);
            for (const f of report.stops) write(`  SAFETY STOP  ${f.check}: ${f.detail}`);
          } catch (err) {
            // A safety loop that throws must not take the server with it.
            write(`  safety check failed: ${(err as Error).message}`);
          }
        }, safetyMs);
        safetyTimer.unref();
      }

      if (scheduling) {
        const intervalMs = intervalFrom(ctx, args);
        write(`  evaluation cycle every ${formatDuration(intervalMs)}`);
        const handle = startScheduler(ctx, { intervalMs, onCycle: reportCycles });
        stopOnSignal(() => {
          if (safetyTimer) clearInterval(safetyTimer);
          handle.stop();
          server.close();
        });
        await handle.done;
        return 0;
      }

      await new Promise(() => {});
      return 0;
    },
  },
];

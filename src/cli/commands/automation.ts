import type { Command } from '../registry.ts';
import { fail, reportCycles, stopOnSignal, write } from '../io.ts';
import { formatDuration, parseDuration, runAllCycles, runCycle, startScheduler } from '../../scheduler.ts';
import { createHttpServer } from '../../server/http.ts';
import { enforceSafety } from '../../safety/monitor.ts';
import { noTokensConfigured } from '../../server/access.ts';
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
        if (noTokensConfigured()) {
          write('  WARNING: no FL_ADMIN_TOKEN or FL_VIEWER_TOKEN - every route except the webhooks');
          write('           and /health is closed. That is the safe default, not a working setup.');
        }
        write('  GET /health/live   liveness (open)');
        write('  GET /health/ready  readiness (open, 503 when not ready)');
      });

      // The fast safety loop. Separate interval on purpose: "is this campaign
      // working" is worth answering slowly on plenty of data, and "is something
      // going wrong right now" is worth answering often on almost none. Running
      // both on one timer is what made the stop-loss weak - it was only checked
      // once per evaluation interval.
      // A bare `--safety` arrives as the string 'true'. Parsing that threw after
      // the server was already listening, which surfaced as an internal-error
      // stack trace rather than a usage message.
      const safetyFlag = args.flags.safety;
      if (safetyFlag === 'true') {
        return fail('--safety needs a duration, e.g. --safety 30s');
      }
      const safetyMs = safetyFlag ? parseDuration(safetyFlag) : 60_000;
      let safetyTimer: NodeJS.Timeout | null = null;
      // Always, not only when scheduling. `serve` on its own still accepts
      // leads, places calls and records revenue - it just does not evaluate -
      // so running it without the stop-loss meant the one loop that can halt
      // spending was absent from the configuration the Dockerfile suggests for
      // driving cycles from outside.
      {
        write(`  safety check every ${formatDuration(safetyMs)}`);
        safetyTimer = setInterval(() => {
          // The loop can now pause a campaign at the provider, so it is async.
          // Nothing awaits this timer, so the rejection has to be caught here
          // or it becomes an unhandled rejection that takes the process down.
          void enforceSafety(ctx)
            .then((report) => {
              for (const f of report.stops) write(`  SAFETY STOP  ${f.check}: ${f.detail}`);
            })
            .catch((err: unknown) => {
              // A safety loop that throws must not take the server with it.
              write(`  safety check failed: ${(err as Error).message}`);
            });
        }, safetyMs);
        safetyTimer.unref();
      }

      if (scheduling) {
        const intervalMs = intervalFrom(ctx, args);
        write(`  evaluation cycle every ${formatDuration(intervalMs)}`);
        // `immediate` matters more here than it looks. Without it the first cycle
        // waits a whole evaluationIntervalHours - 24 by default - and
        // `restart: unless-stopped` means any crash or redeploy starts that wait
        // again. A container restarting daily would never evaluate anything,
        // and the only symptom is an empty cycles table.
        const handle = startScheduler(ctx, { intervalMs, onCycle: reportCycles, immediate: true });
        stopOnSignal(() => {
          if (safetyTimer) clearInterval(safetyTimer);
          handle.stop();
          server.close();
        });
        await handle.done;
        return 0;
      }

      // Webhooks only, no cycle loop. This still needs a signal handler: as
      // PID 1 in a container, a process with no SIGTERM listener does not get
      // the default disposition, so `docker stop` blocks for the whole grace
      // period and then SIGKILLs - on every redeploy.
      await new Promise<void>((resolve) => {
        stopOnSignal(() => {
          if (safetyTimer) clearInterval(safetyTimer);
          server.close();
          resolve();
        });
      });
      return 0;
    },
  },
];

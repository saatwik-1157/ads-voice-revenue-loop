import type { Command } from '../registry.ts';
import { flagIsSet } from '../args.ts';
import { fail, write } from '../io.ts';
import { runDemo } from '../../demo/e2e.ts';
import { probeDispatchContract } from '../../voice/contract.ts';
import { preflight } from '../../meta/preflight.ts';
import { inspectSafety, formatSafety } from '../../safety/monitor.ts';
import { assessReadiness, formatReadiness } from '../../readiness.ts';
import { generateBrief } from '../../brief/generator.ts';
import { id, now } from '../../core/util.ts';
import type { Lead } from '../../core/types.ts';

export const toolCommands: Command[] = [
  {
    name: 'readiness',
    usage: '',
    summary: 'Is this ready to deploy, and is it ready to spend money',
    run: (ctx) => {
      // Two gates, deliberately separate. Being able to run as a service and
      // being allowed to spend money are different questions, and answering
      // them together is how something goes live by accident.
      const report = assessReadiness(ctx);
      write(formatReadiness(report));
      // Exit 0 only when both gates are clear, so this is usable in a script
      // that should refuse to proceed.
      return Promise.resolve(report.liveReady ? 0 : 1);
    },
  },

  {
    name: 'demo',
    usage: '[--days N]',
    summary: 'The whole loop end to end against mock providers',
    run: async (ctx, args) => {
      await runDemo(ctx, { days: Number(args.flags.days ?? 7) });
      return 0;
    },
  },

  {
    name: 'guardrails',
    usage: '',
    summary: 'Print the active control layer',
    run: (ctx) => {
      write(JSON.stringify(ctx.guardrails, null, 2));
      return Promise.resolve(0);
    },
  },

  {
    name: 'contract-test',
    usage: '[--live --to N --yes] [--idempotency]',
    summary: "Probe the voice platform's dispatch API",
    run: async (ctx, args) => {
      const live = flagIsSet(args, 'live');
      if (live && (!args.flags.to || !flagIsSet(args, 'yes'))) {
        return fail(
          [
            'a live probe places a real phone call.',
            'Re-run with:  contract-test --live --to +919876543210 --yes',
            'Use your own number for the first one.',
          ].join('\n'),
        );
      }

      const { brief } = await generateBrief(ctx.guardrails);
      const probeLead: Lead = {
        leadId: id('probe'),
        runId: 'contract_probe',
        name: 'Contract Probe',
        phoneE164: args.flags.to ?? '+10000000000',
        email: null,
        consent: true,
        consentSource: 'contract_probe',
        campaignId: 'cmp_probe',
        adsetId: 'ads_probe',
        adId: 'ad_probe',
        creativeId: 'cr_probe',
        createdAt: now(),
        callStatus: 'pending',
      };

      const result = await probeDispatchContract(
        { env: ctx.env, live, to: args.flags.to, checkIdempotency: flagIsSet(args, 'idempotency') },
        probeLead,
        brief,
      );

      if (!live) {
        write(
          [
            'DRY RUN - nothing left this machine.',
            '',
            `POST ${result.request.url}`,
            JSON.stringify(result.request.headers, null, 2),
            JSON.stringify(result.request.body, null, 2),
            '',
            "Paste that into the provider's API console to compare shapes,",
            'or re-run with --live --to <your number> --yes to send it.',
            '',
          ].join('\n'),
        );
      }

      const mark = { pass: 'PASS', fail: 'FAIL', warn: 'WARN', skipped: 'skip' };
      for (const finding of result.findings) {
        write(`  ${mark[finding.status].padEnd(5)} ${finding.check.padEnd(14)} ${finding.detail}`);
        if (finding.fix) write(`        ${' '.repeat(14)} fix: ${finding.fix}`);
      }

      const failures = result.findings.filter((f) => f.status === 'fail').length;
      write(failures ? `\n${failures} check(s) failed - see docs/omnidimension.md` : '\nno failures');

      // Only a live probe counts. A dry run builds the request without sending
      // it, which says nothing about whether the provider accepts it.
      if (failures === 0 && live) {
        ctx.store.audit(null, 'human', 'contract_test.passed', {
          checks: result.findings.length,
          idempotency: flagIsSet(args, 'idempotency'),
        });
      }
      return failures ? 1 : 0;
    },
  },

  {
    name: 'preflight',
    usage: '[--lead-form ID]',
    summary: 'Read-only checks against the real ad account, before any spend',
    run: async (ctx, args) => {
      // Every call this makes is a GET. It creates nothing and spends nothing,
      // which is what makes it safe as the first thing you run with a new token.
      if (ctx.env.mode !== 'live') {
        write('FL_MODE is not live, so there are no real credentials to check here.');
        write('Set FL_MODE=live with your Meta credentials in .env, then run this before publishing.\n');
      }

      const result = await preflight({
        env: ctx.env,
        guardrails: ctx.guardrails,
        leadFormId: args.flags['lead-form'] ?? null,
      });

      const mark = { pass: 'PASS', fail: 'FAIL', warn: 'WARN', skipped: 'skip' };
      for (const finding of result.findings) {
        write(`  ${mark[finding.status].padEnd(5)} ${finding.check.padEnd(22)} ${finding.detail}`);
        if (finding.fix) write(`        ${' '.repeat(22)} fix: ${finding.fix}`);
      }

      const failures = result.findings.filter((f) => f.status === 'fail').length;
      write(
        failures
          ? `\n${failures} check(s) failed. Nothing was created and nothing was spent.`
          : '\nno failures. Nothing was created and nothing was spent.',
      );

      // Recorded so `readiness` can answer "has the ad account ever been
      // verified" as a fact rather than as something somebody remembers. Only
      // a live run counts: a mock pass proves nothing about the credentials.
      if (failures === 0 && ctx.env.mode === 'live') {
        ctx.store.audit(null, 'human', 'preflight.passed', {
          checks: result.findings.length,
          warnings: result.findings.filter((f) => f.status === 'warn').length,
        });
      }
      return failures ? 1 : 0;
    },
  },

  {
    name: 'safety',
    usage: '[--engage --reason TEXT --by NAME] [--release --by NAME]',
    summary: 'The fast safety checks, and the emergency stop',
    run: (ctx, args) => {
      const by = args.flags.by;

      if (flagIsSet(args, 'engage')) {
        if (!by) return Promise.resolve(fail('--engage needs --by "your name" for the audit trail.'));
        const engaged = ctx.store.engageEmergencyStop({
          trigger: 'manual',
          reason: args.flags.reason ?? 'engaged by hand',
          by,
        });
        ctx.store.audit(null, 'human', 'emergency_stop.engaged', { by, reason: args.flags.reason ?? null });
        write(engaged ? 'EMERGENCY STOP ENGAGED' : 'already engaged; the original reason is kept');
        write('No budget moves, no campaign publishes and no call is placed until this is released.');
        write('Spend already running at Meta continues under its own daily budget and end date.');
        return Promise.resolve(0);
      }

      if (flagIsSet(args, 'release')) {
        if (!by) return Promise.resolve(fail('--release needs --by "your name" for the audit trail.'));
        const released = ctx.store.releaseEmergencyStop(by);
        if (released) ctx.store.audit(null, 'human', 'emergency_stop.released', { by });
        write(released ? `released by ${by}` : 'the emergency stop was not engaged');
        return Promise.resolve(0);
      }

      const stop = ctx.store.emergencyStop();
      if (stop.engaged) {
        write('AUTOPILOT PAUSED');
        write(`  trigger   ${stop.trigger ?? 'unknown'}`);
        write(`  reason    ${stop.reason ?? 'none recorded'}`);
        write(`  since     ${stop.engagedAt ?? 'unknown'} (by ${stop.engagedBy ?? 'unknown'})`);
        write('  state     safe - nothing was deleted, and no autonomous action is being taken');
        write('\n  resume with: node src/cli.ts safety --release --by "your name"\n');
      } else {
        write('autopilot is ACTIVE\n');
      }

      const report = inspectSafety(ctx);
      write(formatSafety(report));
      if (report.stops.length && !stop.engaged) {
        write(`\n${report.stops.length} condition(s) would engage the stop on the next safety pass.`);
      }
      return Promise.resolve(report.stops.length && !stop.engaged ? 1 : 0);
    },
  },
];

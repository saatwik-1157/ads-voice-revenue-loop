import type { Command } from '../registry.ts';
import { flagIsSet } from '../args.ts';
import { fail, write } from '../io.ts';
import { runDemo } from '../../demo/e2e.ts';
import { probeDispatchContract } from '../../voice/contract.ts';
import { preflight } from '../../meta/preflight.ts';
import { generateBrief } from '../../brief/generator.ts';
import { id, now } from '../../core/util.ts';
import type { Lead } from '../../core/types.ts';

export const toolCommands: Command[] = [
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
      return failures ? 1 : 0;
    },
  },
];

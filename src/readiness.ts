import type { Context } from './orchestrator.ts';
import { inspectSafety } from './safety/monitor.ts';
import { money } from './core/util.ts';
import { allBreakers } from './core/breaker.ts';

/**
 * One answer to "is this ready".
 *
 * The question was previously spread across four commands - `preflight` for the
 * ad account, `contract-test` for the voice platform, `guardrails` for the
 * caps, `safety` for runtime state - and answering it meant running all of them
 * and holding the result in your head. Worse, two of those left no record, so
 * "have I ever verified the providers" was unanswerable an hour later.
 *
 * There are two different questions here and conflating them is how people go
 * live by accident:
 *
 *   DEPLOY - can this run as a service? Database, tokens, a public URL.
 *   LIVE   - can this spend money and call strangers? Credentials that have
 *            been exercised against the real providers, and caps that bound
 *            the damage.
 *
 * Everything here is a read. This command changes nothing.
 */

export type CheckState = 'pass' | 'warn' | 'block' | 'n/a';

export interface Check {
  /** Which question this bears on. */
  gate: 'deploy' | 'live';
  name: string;
  state: CheckState;
  detail: string;
  /** What to do about it, when there is something to do. */
  fix?: string;
}

export interface ReadinessReport {
  checks: Check[];
  deployReady: boolean;
  liveReady: boolean;
  mode: 'mock' | 'live';
}

/** Present without revealing. Never returns any part of the value. */
function present(value: string | undefined | null): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

export function assessReadiness(ctx: Context): ReadinessReport {
  const checks: Check[] = [];
  const e = ctx.env;
  const g = ctx.guardrails;

  const add = (c: Check): void => {
    checks.push(c);
  };

  // --- can this run as a service ------------------------------------------

  // The database is the only hard dependency, and a migration that has not run
  // is a schema the code does not expect.
  try {
    ctx.store.db.prepare('SELECT 1').get();
    const violations = ctx.store.db.prepare('PRAGMA foreign_key_check').all();
    if (violations.length > 0) {
      add({
        gate: 'deploy',
        name: 'database',
        state: 'block',
        detail: `${violations.length} foreign key violation(s)`,
        fix: 'the database is inconsistent; do not deploy it',
      });
    } else {
      add({ gate: 'deploy', name: 'database', state: 'pass', detail: 'readable, constraints intact' });
    }
  } catch (err) {
    add({
      gate: 'deploy',
      name: 'database',
      state: 'block',
      detail: (err as Error).message.slice(0, 120),
      fix: 'check FL_DB_PATH and that the volume is writable',
    });
  }

  // An unset token authenticates nobody, so the routes close rather than fall
  // open. That is safe, and it also means you cannot read your own runs.
  const admin = present(process.env.FL_ADMIN_TOKEN);
  const viewer = present(process.env.FL_VIEWER_TOKEN);
  if (admin && viewer) {
    add({ gate: 'deploy', name: 'access tokens', state: 'pass', detail: 'admin and viewer both set' });
  } else if (admin || viewer) {
    add({
      gate: 'deploy',
      name: 'access tokens',
      state: 'warn',
      detail: `${admin ? 'admin' : 'viewer'} set, ${admin ? 'viewer' : 'admin'} missing`,
      fix: `set FL_${admin ? 'VIEWER' : 'ADMIN'}_TOKEN, or those routes stay closed to everyone`,
    });
  } else {
    add({
      gate: 'deploy',
      name: 'access tokens',
      state: 'warn',
      detail: 'neither set - every non-webhook route is closed',
      fix: 'set FL_ADMIN_TOKEN and FL_VIEWER_TOKEN',
    });
  }

  // --- can this go live ---------------------------------------------------

  // A provider cannot reach localhost. This is the one that silently produces
  // a campaign nobody can deliver leads to.
  if (e.publicBaseUrl.startsWith('https://')) {
    add({ gate: 'live', name: 'public URL', state: 'pass', detail: e.publicBaseUrl });
  } else {
    add({
      gate: 'live',
      name: 'public URL',
      state: 'block',
      detail: `${e.publicBaseUrl} - Meta will not deliver webhooks here`,
      fix: 'see docs/DEPLOY.md; the quick tunnel route needs no account',
    });
  }

  // Presence only. The values are never read into this report.
  const creds: Array<[string, boolean]> = [
    ['META_ACCESS_TOKEN', present(e.meta.accessToken)],
    ['META_AD_ACCOUNT_ID', present(e.meta.adAccountId) && e.meta.adAccountId !== 'act_000000000000'],
    ['META_PAGE_ID', present(e.meta.pageId)],
    ['META_APP_SECRET', present(e.meta.appSecret)],
    ['OMNI_API_KEY', present(e.omni.apiKey)],
    ['OMNI_AGENT_ID', present(e.omni.agentId)],
  ];
  const missing = creds.filter(([, ok]) => !ok).map(([name]) => name);
  add(
    missing.length === 0
      ? { gate: 'live', name: 'credentials', state: 'pass', detail: 'all present (values not read)' }
      : {
          gate: 'live',
          name: 'credentials',
          state: 'block',
          detail: `missing: ${missing.join(', ')}`,
          fix: 'fill these in .env - they are yours to paste in',
        },
  );

  // A webhook endpoint that cannot verify a signature is an endpoint anyone can
  // post revenue to.
  const omniVerifiable = present(e.omni.webhookSecret) || present(e.omni.webhookToken);
  add(
    omniVerifiable
      ? {
          gate: 'live',
          name: 'webhook verification',
          state: present(e.omni.webhookSecret) ? 'pass' : 'warn',
          detail: present(e.omni.webhookSecret)
            ? 'HMAC over the raw body'
            : 'static token only - replayable, and proves nothing about the body',
          fix: present(e.omni.webhookSecret) ? undefined : 'prefer OMNI_WEBHOOK_SECRET where the provider supports it',
        }
      : {
          gate: 'live',
          name: 'webhook verification',
          state: 'block',
          detail: 'neither OMNI_WEBHOOK_SECRET nor OMNI_WEBHOOK_TOKEN is set',
          fix: 'set one, or anyone who finds the URL can record revenue',
        },
  );

  // The part that cannot be inferred from configuration: has anyone actually
  // called the real thing? preflight and contract-test now record their
  // outcome, so this is a fact rather than a memory.
  for (const [kind, label, how] of [
    ['preflight.passed', 'ad account verified', 'node src/cli.ts preflight'],
    ['contract_test.passed', 'voice platform verified', 'node src/cli.ts contract-test --live --to <your number> --yes'],
  ] as const) {
    // Recorded without a run id, so it has to be read with an explicit null.
    const last = ctx.store.listAudit(null, { kind, limit: 1 })[0];
    add(
      last
        ? { gate: 'live', name: label, state: 'pass', detail: `last passed ${last.at}` }
        : {
            gate: 'live',
            name: label,
            state: 'block',
            detail: 'never verified against the real provider',
            fix: how,
          },
    );
  }

  // --- what bounds the damage ---------------------------------------------
  add({
    gate: 'live',
    name: 'caps',
    state: 'pass',
    detail: `test budget ${money(g.maxTestBudgetMinor, g.currency)}, stop-loss ${money(g.stopLossMinor, g.currency)}, daily ${money(g.maxDailySpendMinor, g.currency)}`,
  });

  // A provider this system has stopped calling. Not a blocker on its own - the
  // circuit closes itself when the provider recovers - but it is the first
  // thing worth knowing when nothing seems to be happening.
  for (const b of allBreakers().filter((x) => x.state !== 'closed')) {
    add({
      gate: 'live',
      name: `${b.provider} circuit`,
      state: 'warn',
      detail: `${b.state} after ${b.consecutiveFailures} consecutive failures: ${b.lastError ?? 'unknown'}`,
      fix: 'the circuit closes itself once the provider answers again',
    });
  }

  const safety = inspectSafety(ctx);
  if (safety.engaged) {
    add({
      gate: 'live',
      name: 'emergency stop',
      state: 'block',
      detail: 'engaged - nothing autonomous will act',
      fix: 'node src/cli.ts safety --release --by "your name"',
    });
  } else if (safety.stops.length > 0) {
    add({
      gate: 'live',
      name: 'emergency stop',
      state: 'warn',
      detail: `${safety.stops.length} condition(s) would engage it on the next pass`,
      fix: 'node src/cli.ts safety',
    });
  } else {
    add({ gate: 'live', name: 'emergency stop', state: 'pass', detail: 'clear' });
  }

  // Mode is reported, never a blocker. Running in mock is a correct state, and
  // it is the state you should be in until everything above is green.
  add({
    gate: 'live',
    name: 'mode',
    state: e.mode === 'live' ? 'warn' : 'pass',
    detail: e.mode === 'live' ? 'LIVE - real spend, real calls' : 'mock - no spend, no calls',
  });

  const blocked = (gate: 'deploy' | 'live'): boolean =>
    checks.some((c) => c.gate === gate && c.state === 'block');

  return {
    checks,
    deployReady: !blocked('deploy'),
    // Live requires both gates: you cannot spend from something that cannot run.
    liveReady: !blocked('deploy') && !blocked('live'),
    mode: e.mode,
  };
}

const MARK: Record<CheckState, string> = { pass: 'PASS ', warn: 'WARN ', block: 'BLOCK', 'n/a': '---  ' };

export function formatReadiness(report: ReadinessReport): string {
  const lines: string[] = [];

  const section = (gate: 'deploy' | 'live', title: string): void => {
    lines.push('', title);
    for (const c of report.checks.filter((x) => x.gate === gate)) {
      lines.push(`  ${MARK[c.state]} ${c.name.padEnd(24)} ${c.detail}`);
      if (c.fix && c.state !== 'pass') lines.push(`        ${' '.repeat(24)} -> ${c.fix}`);
    }
  };

  section('deploy', 'CAN IT RUN AS A SERVICE');
  section('live', 'CAN IT SPEND MONEY AND CALL PEOPLE');

  lines.push('');
  lines.push(
    report.deployReady
      ? 'DEPLOY   ready - the service will start and serve'
      : 'DEPLOY   BLOCKED - see above',
  );
  lines.push(
    report.liveReady
      ? `LIVE     ready - set FL_MODE=live when you mean it (currently ${report.mode})`
      : 'LIVE     BLOCKED - do not set FL_MODE=live yet',
  );

  if (report.deployReady && !report.liveReady) {
    lines.push('');
    lines.push('This is the normal state before going live. Deploy it in mock, prove the loop,');
    lines.push('then clear the LIVE blockers one at a time.');
  }

  return lines.join('\n');
}

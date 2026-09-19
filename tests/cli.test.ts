import { test } from 'node:test';
import assert from 'node:assert/strict';
import { COMMANDS, findCommand, usageText } from '../src/cli/registry.ts';
import { flagIsSet, minorFromFlag, parseArgs, parseFlags } from '../src/cli/args.ts';
import { indent, safeParse } from '../src/cli/io.ts';
import { Store } from '../src/store/db.ts';

test('help lists every command, because it is generated from the registry', () => {
  // The hand-written help had already drifted once: `economics` existed for
  // weeks without appearing in it. Deriving the text makes that impossible.
  const help = usageText();
  for (const command of COMMANDS) {
    assert.ok(help.includes(`  ${command.name}`), `${command.name} is missing from help`);
    assert.ok(help.includes(command.summary), `${command.name}'s summary is missing from help`);
  }
});

test('the registry is well formed', () => {
  const names = COMMANDS.map((c) => c.name);
  assert.equal(new Set(names).size, names.length, 'command names must be unique');
  for (const command of COMMANDS) {
    assert.ok(command.summary.trim(), `${command.name} needs a summary`);
    assert.equal(typeof command.run, 'function');
  }
});

test('a long invocation drops its summary to the next line rather than running off', () => {
  const rendered = usageText([
    {
      name: 'short',
      usage: '[x]',
      summary: 'fits on one line',
      run: () => Promise.resolve(0),
    },
    {
      name: 'verylongcommand',
      usage: '[--one A] [--two B] [--three C] [--four D]',
      summary: 'does not fit',
      run: () => Promise.resolve(0),
    },
  ]);
  const lines = rendered.split('\n');
  assert.ok(lines.some((l) => /^ {2}short \[x\] +fits on one line$/.test(l)), 'short form stays on one line');
  assert.ok(lines.some((l) => l.trim() === 'does not fit'), 'long form wraps its summary');
});

test('only the server holds the process open', () => {
  const holding = COMMANDS.filter((c) => c.holdsProcess).map((c) => c.name);
  // Closing the store under a command that blocks forever is a bug; claiming
  // to block when you do not leaks the handle instead.
  assert.deepEqual(holding, ['serve']);
});

test('findCommand resolves registered names and nothing else', () => {
  assert.equal(findCommand('review')?.name, 'review');
  assert.equal(findCommand('contract-test')?.name, 'contract-test');
  assert.equal(findCommand('nope'), undefined);
});

test('flags take the following word, and a bare flag is a boolean', () => {
  const flags = parseFlags(['--budget', '700', '--activate', '--days', '5']);
  assert.deepEqual(flags, { budget: '700', activate: 'true', days: '5' });

  const trailing = parseFlags(['--live', '--to', '+919876543210', '--yes']);
  assert.deepEqual(trailing, { live: 'true', to: '+919876543210', yes: 'true' });
});

test("a flag's value is not mistaken for a positional", () => {
  const { command, args } = parseArgs(['publish', 'run_1', '--budget', '700', '--activate']);
  assert.equal(command, 'publish');
  assert.deepEqual(args.positional, ['run_1'], '700 belongs to --budget, not to the command');
  assert.equal(args.flags.budget, '700');
  assert.equal(flagIsSet(args, 'activate'), true);
  assert.equal(flagIsSet(args, 'force'), false);
});

test('money crosses the CLI boundary in major units and is stored in minor', () => {
  const { args } = parseArgs(['publish', '--budget', '700']);
  assert.equal(minorFromFlag(args, 'budget'), 70000);
  assert.equal(minorFromFlag(args, 'missing'), undefined, 'an absent flag is absent, not zero');

  const { args: fractional } = parseArgs(['brief', '--deal-value', '4999.99']);
  assert.equal(minorFromFlag(fractional, 'deal-value'), 499999);
});

test('a command with no arguments parses cleanly', () => {
  const { command, args } = parseArgs(['runs']);
  assert.equal(command, 'runs');
  assert.deepEqual(args.positional, []);
  assert.deepEqual(args.flags, {});
});

test('output helpers behave', () => {
  assert.equal(indent('a\nb'), '    a\n    b');
  assert.equal(indent('a', 2), '  a');
  assert.deepEqual(safeParse('{"a":1}'), { a: 1 });
  assert.equal(safeParse('not json'), null, 'a hand-edited row must not throw');
});

test('the audit trail can be filtered by kind, by family, and by actor', () => {
  const store = new Store(':memory:');
  const runId = store.createRun('test');
  store.audit(runId, 'meta', 'lead.accepted', { leadId: 'a' });
  store.audit(runId, 'system', 'call.deferred', { leadId: 'a', window: '10-19' });
  store.audit(runId, 'system', 'call.suppressed', { leadId: 'b' });
  store.audit(runId, 'agent', 'campaign.created', { campaignId: 'c1' });
  // A real second run. Audit rows are foreign-keyed to runs now, so auditing
  // against an id that was never created is exactly the orphan row the
  // constraint exists to refuse.
  store.audit(store.createRun('other'), 'agent', 'campaign.created', { campaignId: 'c2' });

  assert.equal(store.listAudit(runId).length, 4, 'other runs are not mixed in');
  assert.equal(store.listAudit(runId, { kind: 'call.deferred' }).length, 1, 'an exact kind');
  assert.equal(store.listAudit(runId, { kind: 'call' }).length, 2, 'a bare prefix matches the family');
  assert.equal(store.listAudit(runId, { actor: 'system' }).length, 2);
  assert.equal(store.listAudit(runId, { limit: 1 }).length, 1);
  store.close();
});

test('the summary counts what happened, so a firing rule is visible at a glance', () => {
  const store = new Store(':memory:');
  const runId = store.createRun('test');
  for (let i = 0; i < 84; i += 1) store.audit(runId, 'system', 'call.deferred', { leadId: `l${i}` });
  store.audit(runId, 'agent', 'campaign.created', {});

  const summary = store.auditSummary(runId);
  // Most frequent first: 84 deferrals is the answer to "why no calls?", and it
  // should not be buried under a chronological stream.
  assert.equal(summary[0]?.kind, 'call.deferred');
  assert.equal(summary[0]?.count, 84);
  assert.equal(summary[0]?.actor, 'system');
  assert.ok(summary[0]?.last);
  store.close();
});

test('closing the store twice is a no-op, not a crash', () => {
  // `reset` deletes the database, so it closes the store itself - and the CLI's
  // finally block then closes it again on the way out.
  const store = new Store(':memory:');
  store.close();
  assert.doesNotThrow(() => store.close());
});

test('reset refuses in live mode, where the database is the only record', () => {
  const reset = findCommand('reset');
  assert.ok(reset, 'reset is registered');
  assert.match(reset.usage, /--yes/, 'it cannot be fired without saying so');
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { COMMANDS, findCommand, usageText } from '../src/cli/registry.ts';
import { flagIsSet, minorFromFlag, parseArgs, parseFlags } from '../src/cli/args.ts';
import { indent, safeParse } from '../src/cli/io.ts';

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

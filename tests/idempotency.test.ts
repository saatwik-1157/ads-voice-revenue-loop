import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { OperationInFlightError, Store } from '../src/store/db.ts';
import { defaultGuardrails } from '../src/config/guardrails.ts';
import { generateBrief } from '../src/brief/generator.ts';
import { intakeLead } from '../src/pipeline/intake.ts';
import { dispatchLead } from '../src/pipeline/dispatch.ts';
import type { VoiceProvider } from '../src/voice/provider.ts';

/**
 * Doing a thing once, when two callers ask at the same time.
 *
 * The old implementation read the key, awaited the work, then wrote the key.
 * Two concurrent callers both saw no row, both did the work, and the loser hit
 * a UNIQUE constraint on insert - so a redelivered Meta webhook placed a
 * second call to the same person and reported it as a database error, which
 * reads like nothing happened. Sequential redelivery was always correct, which
 * is why the tests passed; a provider's retries are the concurrent case.
 */

const G = { ...defaultGuardrails, callWindow: { startHour: 0, endHour: 24, timeZone: 'UTC' } };

test('two concurrent callers run the operation once', async () => {
  const store = new Store(':memory:');
  let ran = 0;
  const work = async (): Promise<{ n: number }> => {
    ran += 1;
    await new Promise((r) => setTimeout(r, 30));
    return { n: ran };
  };

  const results = await Promise.allSettled([
    store.onceAsync('op', ['same'], work),
    store.onceAsync('op', ['same'], work),
  ]);

  assert.equal(ran, 1, 'the work happened once');
  const kinds = results.map((r) => r.status);
  assert.ok(kinds.includes('fulfilled'), 'one caller did it');
  const loser = results.find((r) => r.status === 'rejected');
  assert.ok(loser, 'and the other was told, rather than doing it again');
  assert.ok(loser.reason instanceof OperationInFlightError);
  store.close();
});

test('different keys are not blocked by each other', async () => {
  const store = new Store(':memory:');
  let ran = 0;
  const work = async (): Promise<number> => {
    ran += 1;
    await new Promise((r) => setTimeout(r, 10));
    return ran;
  };
  await Promise.all([store.onceAsync('op', ['a'], work), store.onceAsync('op', ['b'], work)]);
  assert.equal(ran, 2, 'two unrelated operations both run');
  store.close();
});

test('a completed operation returns its stored result, not a second run', async () => {
  const store = new Store(':memory:');
  let ran = 0;
  const work = async (): Promise<{ callRef: string }> => {
    ran += 1;
    return { callRef: `call_${ran}` };
  };
  const first = await store.onceAsync('voice.dispatch', ['lead_1'], work);
  const second = await store.onceAsync('voice.dispatch', ['lead_1'], work);
  assert.deepEqual(second, first);
  assert.equal(ran, 1);
  store.close();
});

test('a failed operation releases its key so a retry can run', async () => {
  // The provider carries its own idempotency key, so a request that did land is
  // deduplicated there. Holding the key after a failure would strand the lead.
  const store = new Store(':memory:');
  let attempts = 0;
  const flaky = async (): Promise<string> => {
    attempts += 1;
    if (attempts === 1) throw new Error('provider timed out');
    return 'ok';
  };

  await assert.rejects(store.onceAsync('op', ['k'], flaky), /timed out/);
  assert.equal(await store.onceAsync('op', ['k'], flaky), 'ok', 'the retry is allowed through');
  assert.equal(attempts, 2);
  store.close();
});

test('the synchronous form is idempotent too', () => {
  const store = new Store(':memory:');
  let ran = 0;
  const work = (): number => {
    ran += 1;
    return ran;
  };
  assert.equal(store.once('op', ['k'], work), 1);
  assert.equal(store.once('op', ['k'], work), 1);
  assert.equal(ran, 1);

  assert.throws(() => store.once('boom', ['k'], () => { throw new Error('nope'); }), /nope/);
  assert.equal(store.once('boom', ['k'], work), 2, 'a failure does not poison the key');
  store.close();
});

test('a redelivered webhook does not put a second call on the same phone', async () => {
  let dialled = 0;
  const slowVoice = {
    kind: 'mock',
    async dispatchCall() {
      dialled += 1;
      const n = dialled;
      await new Promise((r) => setTimeout(r, 30));
      return { callRef: `call_${n}` };
    },
  } as unknown as VoiceProvider;

  const store = new Store(':memory:');
  const { brief } = await generateBrief(G);
  const runId = store.createRun(brief.niche.name);
  store.saveBrief(runId, brief);
  const intake = intakeLead(store, G, runId, {
    name: 'Asha R',
    phone: '9876543210',
    consent: true,
    consentSource: 'meta_instant_form',
    adId: 'ad_1',
  });
  if (intake.status !== 'accepted') throw new Error('setup failed');

  const [a, b] = await Promise.all([
    dispatchLead(store, slowVoice, G, intake.lead, brief, 'http://x/hook'),
    dispatchLead(store, slowVoice, G, intake.lead, brief, 'http://x/hook'),
  ]);

  assert.equal(dialled, 1, 'the phone rang once');
  const statuses = [a.status, b.status].sort();
  assert.deepEqual(statuses, ['deferred', 'dispatched'], 'one placed it, one stood down cleanly');
  assert.equal(store.listAudit(runId, { kind: 'call.already_dispatching' }).length, 1, 'and standing down is recorded');
  store.close();
});

test('a database written before the status column still honours its completed work', async () => {
  // Without the migration the column is missing on every database except a new
  // one, and every operation already done would be done again on upgrade.
  const dir = mkdtempSync(join(tmpdir(), 'fl-idem-'));
  const path = join(dir, 'legacy.db');

  let store = new Store(path);
  let ran = 0;
  await store.onceAsync('voice.dispatch', ['lead_1'], async () => {
    ran += 1;
    return { callRef: 'call_first' };
  });
  store.close();
  assert.equal(ran, 1);

  // Rebuild the table as it looked before `status` existed - and drop the
  // migration ledger with it, because a database old enough to lack the column
  // is also old enough to predate the ledger. Leaving the ledger behind would
  // make the migration correctly skip, and would test a database that has
  // never existed.
  const raw = new DatabaseSync(path);
  raw.exec('CREATE TABLE old_idem (key TEXT PRIMARY KEY, operation TEXT NOT NULL, result TEXT NOT NULL, created_at TEXT NOT NULL)');
  raw.exec('INSERT INTO old_idem SELECT key, operation, result, created_at FROM idempotency');
  raw.exec('DROP TABLE idempotency');
  raw.exec('ALTER TABLE old_idem RENAME TO idempotency');
  raw.exec('DROP TABLE schema_migrations');
  raw.close();

  store = new Store(path);
  ran = 0;
  const got = await store.onceAsync('voice.dispatch', ['lead_1'], async () => {
    ran += 1;
    return { callRef: 'call_SECOND' };
  });
  assert.equal(ran, 0, 'the legacy row is honoured; nobody is dialled again on upgrade');
  assert.deepEqual(got, { callRef: 'call_first' });
  store.close();
});

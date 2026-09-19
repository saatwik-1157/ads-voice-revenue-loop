import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/store/db.ts';

/**
 * Schema migrations, against databases that already hold data.
 *
 * The risk being tested is not "does the DDL parse" - it is that a database
 * created before a constraint existed still opens, keeps its rows, and comes
 * out the other side actually constrained. A migration that silently skips is
 * indistinguishable from one that worked until the day it matters.
 */

const dir = mkdtempSync(join(tmpdir(), 'fl-migrate-'));
let seq = 0;
const freshPath = (): string => join(dir, `m-${++seq}.db`);

/** A database shaped like the first release: no constraints, no ledger. */
function legacyDatabase(path: string): void {
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE runs (run_id TEXT PRIMARY KEY, brief_id TEXT, state TEXT NOT NULL,
      niche TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, notes TEXT);
    CREATE TABLE leads (lead_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, name TEXT NOT NULL,
      phone_e164 TEXT NOT NULL, email TEXT, consent INTEGER NOT NULL, consent_source TEXT NOT NULL,
      campaign_id TEXT, adset_id TEXT, ad_id TEXT, creative_id TEXT, created_at TEXT NOT NULL,
      call_status TEXT NOT NULL, dedupe_key TEXT NOT NULL UNIQUE);
    CREATE TABLE calls (call_id TEXT PRIMARY KEY, lead_id TEXT NOT NULL, connected INTEGER NOT NULL,
      qualified INTEGER NOT NULL, intent_score INTEGER NOT NULL, objection TEXT,
      appointment_booked INTEGER NOT NULL, sale_status TEXT NOT NULL,
      expected_value_minor INTEGER NOT NULL, next_action TEXT, summary TEXT,
      opt_out INTEGER NOT NULL, received_at TEXT NOT NULL);
  `);
  db.prepare('INSERT INTO runs VALUES (?,?,?,?,?,?,?)')
    .run('run_legacy', null, 'live', 'roofing', '2026-01-01', '2026-01-01', null);
  db.prepare('INSERT INTO leads VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .run('lead_legacy', 'run_legacy', 'Asha R', '+919876543210', null, 1, 'meta_instant_form',
         null, null, 'ad_1', null, '2026-01-01', 'completed', 'dedupe_legacy');
  db.prepare('INSERT INTO calls VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .run('call_legacy', 'lead_legacy', 1, 1, 80, null, 0, 'won', 500000, null, null, 0, '2026-01-01');
  db.close();
}

test('a database with no constraints gains them without losing a row', () => {
  const path = freshPath();
  legacyDatabase(path);

  const store = new Store(path);

  // The rows are still there.
  assert.equal(store.getRun('run_legacy')?.state, 'live');
  assert.equal(store.getLead('lead_legacy')?.phoneE164, '+919876543210');
  assert.equal(store.callCountForLead('lead_legacy'), 1);

  // And the constraints now exist, which is the point.
  const leadFks = store.db.prepare('PRAGMA foreign_key_list(leads)').all() as Array<{ table: string }>;
  const callFks = store.db.prepare('PRAGMA foreign_key_list(calls)').all() as Array<{ table: string }>;
  assert.ok(leadFks.some((f) => f.table === 'runs'), 'leads reference their run');
  assert.ok(callFks.some((f) => f.table === 'leads'), 'calls reference their lead');
  assert.deepEqual(store.db.prepare('PRAGMA foreign_key_check').all(), [], 'and nothing violates them');
  store.close();
});

test('an orphan row cannot be written once the constraint is there', () => {
  const store = new Store(freshPath());
  const runId = store.createRun('test');

  assert.throws(
    () => {
      store.db
        .prepare('INSERT INTO calls (call_id, lead_id, connected, qualified, intent_score, objection, appointment_booked, sale_status, expected_value_minor, next_action, summary, opt_out, received_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
        .run('c1', 'lead_that_never_existed', 1, 1, 0, null, 0, 'none', 0, null, null, 0, '2026-01-01');
    },
    /FOREIGN KEY/,
    'a call against a lead that does not exist is refused',
  );

  assert.throws(
    () => { store.audit('run_that_never_existed', 'system', 'test', {}); },
    /FOREIGN KEY/,
    'and so is an audit row against a run that does not exist',
  );

  // The legitimate case still works.
  store.audit(runId, 'system', 'test', {});
  assert.equal(store.listAudit(runId).length, 1);
  store.close();
});

test('migrations run once and are recorded', () => {
  const path = freshPath();
  const first = new Store(path);
  const applied = first.db.prepare('SELECT version, name FROM schema_migrations ORDER BY version').all() as Array<{
    version: number;
    name: string;
  }>;
  first.close();

  assert.ok(applied.length >= 2, 'the ledger records what ran');
  // Against the literal order, not a sorted copy of itself. The rows arrive
  // ORDER BY version on an INTEGER PRIMARY KEY, so comparing them to their own
  // sort could never fail - applying the migrations in reverse left this green.
  assert.deepEqual(
    applied.map((m) => m.version),
    [1, 2, 3],
    'applied in ascending version order',
  );

  // Reopening must not re-run them.
  const second = new Store(path);
  const again = second.db.prepare('SELECT version FROM schema_migrations').all();
  assert.equal(again.length, applied.length, 'no duplicate application on reopen');
  second.close();
});

test('a legacy database carrying an orphan row is refused rather than half-migrated', () => {
  // The migration ends with PRAGMA foreign_key_check. Data that cannot satisfy
  // the new constraints must stop the upgrade loudly, not be silently accepted
  // into a schema that claims to guarantee something it does not.
  const path = freshPath();
  legacyDatabase(path);
  const db = new DatabaseSync(path);
  db.prepare('INSERT INTO calls VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .run('call_orphan', 'lead_that_never_existed', 1, 0, 0, null, 0, 'none', 0, null, null, 0, '2026-01-01');
  db.close();

  assert.throws(
    () => new Store(path),
    (err: Error) => /foreign key violation/.test(err.message),
    'the upgrade refuses and says why',
  );
});

test('a transaction leaves nothing behind when the work throws', () => {
  const store = new Store(freshPath());
  const runId = store.createRun('test');

  assert.throws(
    () =>
      store.transaction(() => {
        store.audit(runId, 'system', 'first', {});
        store.audit(runId, 'system', 'second', {});
        throw new Error('provider exploded halfway');
      }),
    /exploded/,
  );
  assert.equal(store.listAudit(runId).length, 0, 'neither write survived');

  // And the store is still usable afterwards - a failed transaction must not
  // leave the connection wedged mid-transaction.
  store.transaction(() => { store.audit(runId, 'system', 'after', {}); });
  assert.equal(store.listAudit(runId).length, 1);
  store.close();
});

test('a nested transaction joins the outer one rather than starting a second', () => {
  // SQLite has no nested transactions; a naive BEGIN inside a BEGIN throws.
  const store = new Store(freshPath());
  const runId = store.createRun('test');

  assert.throws(
    () =>
      store.transaction(() => {
        store.audit(runId, 'system', 'outer', {});
        store.transaction(() => { store.audit(runId, 'system', 'inner', {}); });
        throw new Error('rolled back');
      }),
    /rolled back/,
  );
  assert.equal(store.listAudit(runId).length, 0, 'the inner write rolls back with the outer');

  const committed = store.transaction(() => {
    store.audit(runId, 'system', 'outer', {});
    return store.transaction(() => {
      store.audit(runId, 'system', 'inner', {});
      return 'done';
    });
  });
  assert.equal(committed, 'done');
  assert.equal(store.listAudit(runId).length, 2, 'and commits together');
  store.close();
});

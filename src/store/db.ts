import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { id, now, fingerprint } from '../core/util.ts';
import type {
  AdRecord,
  AuditEvent,
  Brief,
  CallOutcome,
  CampaignRecord,
  Lead,
  RunState,
  SpendPoint,
  WebhookEventRow,
  EmergencyStopState,
} from '../core/types.ts';

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS runs (
  run_id TEXT PRIMARY KEY,
  brief_id TEXT,
  state TEXT NOT NULL,
  niche TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  notes TEXT
);

CREATE TABLE IF NOT EXISTS briefs (
  brief_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(run_id),
  created_at TEXT NOT NULL,
  payload TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS approvals (
  approval_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(run_id),
  gate TEXT NOT NULL,
  subject TEXT NOT NULL,
  status TEXT NOT NULL,
  approver TEXT,
  decided_at TEXT,
  requested_at TEXT NOT NULL,
  detail TEXT
);

CREATE TABLE IF NOT EXISTS campaigns (
  campaign_id TEXT PRIMARY KEY,
  adset_id TEXT NOT NULL,
  run_id TEXT NOT NULL REFERENCES runs(run_id),
  brief_id TEXT NOT NULL,
  objective TEXT NOT NULL,
  daily_budget_minor INTEGER NOT NULL,
  currency TEXT NOT NULL,
  status TEXT NOT NULL,
  geo TEXT NOT NULL,
  created_at TEXT NOT NULL,
  provider TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ads (
  ad_id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL REFERENCES campaigns(campaign_id),
  adset_id TEXT NOT NULL,
  creative_id TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS leads (
  lead_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(run_id),
  name TEXT NOT NULL,
  phone_e164 TEXT NOT NULL,
  email TEXT,
  consent INTEGER NOT NULL,
  consent_source TEXT NOT NULL,
  campaign_id TEXT,
  adset_id TEXT,
  ad_id TEXT,
  creative_id TEXT,
  created_at TEXT NOT NULL,
  call_status TEXT NOT NULL,
  dedupe_key TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS calls (
  call_id TEXT PRIMARY KEY,
  lead_id TEXT NOT NULL REFERENCES leads(lead_id),
  connected INTEGER NOT NULL,
  qualified INTEGER NOT NULL,
  intent_score INTEGER NOT NULL,
  objection TEXT,
  appointment_booked INTEGER NOT NULL,
  sale_status TEXT NOT NULL,
  expected_value_minor INTEGER NOT NULL,
  next_action TEXT,
  summary TEXT,
  opt_out INTEGER NOT NULL,
  received_at TEXT NOT NULL
);

-- A call the moment it is placed, not when its result comes back.
--
-- maxCallsPerDay and maxCallAttemptsPerLead were both counted from the calls
-- table, which only the inbound result webhook writes. A call already dialling
-- counted as zero, so with a cap of 25 the system dispatched 60, and a cap of
-- one attempt per person dialled the same number three times. The caps are
-- about the phone ringing, so they have to be counted when it rings.
CREATE TABLE IF NOT EXISTS call_attempts (
  attempt_id TEXT PRIMARY KEY,
  lead_id TEXT NOT NULL REFERENCES leads(lead_id),
  run_id TEXT NOT NULL REFERENCES runs(run_id),
  phone_e164 TEXT NOT NULL,
  dispatched_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS spend (
  spend_id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL REFERENCES runs(run_id),
  ad_id TEXT,
  spend_minor INTEGER NOT NULL,
  impressions INTEGER NOT NULL,
  clicks INTEGER NOT NULL,
  leads INTEGER NOT NULL,
  as_of TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS revenue (
  revenue_id TEXT PRIMARY KEY,
  lead_id TEXT NOT NULL REFERENCES leads(lead_id),
  amount_minor INTEGER NOT NULL,
  source TEXT NOT NULL,
  recorded_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS suppression (
  phone_e164 TEXT PRIMARY KEY,
  reason TEXT NOT NULL,
  added_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS idempotency (
  key TEXT PRIMARY KEY,
  operation TEXT NOT NULL,
  result TEXT NOT NULL,
  -- 'in_flight' while the operation is running, 'done' once its result is
  -- stored. The row is written before the work starts, so the key is what
  -- claims the right to do it.
  status TEXT NOT NULL DEFAULT 'done',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit (
  event_id TEXT PRIMARY KEY,
  run_id TEXT REFERENCES runs(run_id),
  at TEXT NOT NULL,
  actor TEXT NOT NULL,
  kind TEXT NOT NULL,
  detail TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS cycles (
  cycle_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(run_id),
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL,
  decision TEXT,
  signal TEXT,
  detail TEXT
);

-- Every inbound webhook, whether or not it was acted on.
--
-- Payloads used to be processed and discarded, so a delivery that failed could
-- not be inspected, explained or replayed - the only trace was whatever the
-- handler happened to audit. The raw body is deliberately NOT stored: it
-- carries a phone number and a name. The hash is enough to recognise the same
-- delivery arriving twice without keeping a second copy of someone's details.
CREATE TABLE IF NOT EXISTS webhook_events (
  event_id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  -- The provider's own id when it sends one; otherwise the payload hash, so
  -- dedupe still works for a provider that does not identify its deliveries.
  provider_event_id TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  signature_verified INTEGER NOT NULL,
  received_at TEXT NOT NULL,
  status TEXT NOT NULL,
  processed_at TEXT,
  failure_reason TEXT,
  UNIQUE (provider, provider_event_id)
);

-- One row, id 1. A file or an in-memory flag would not survive a restart and
-- would not be visible to a second process; a stop that forgets itself when the
-- scheduler is restarted is not a stop.
CREATE TABLE IF NOT EXISTS emergency_stop (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  engaged INTEGER NOT NULL,
  trigger TEXT,
  reason TEXT,
  detail TEXT,
  engaged_at TEXT,
  engaged_by TEXT,
  released_at TEXT,
  released_by TEXT
);

CREATE TABLE IF NOT EXISTS locks (
  name TEXT PRIMARY KEY,
  holder TEXT NOT NULL,
  acquired_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_cycles_run ON cycles(run_id);
CREATE INDEX IF NOT EXISTS idx_leads_run ON leads(run_id);
CREATE INDEX IF NOT EXISTS idx_calls_lead ON calls(lead_id);
CREATE INDEX IF NOT EXISTS idx_spend_run ON spend(run_id);
CREATE INDEX IF NOT EXISTS idx_audit_run ON audit(run_id);

-- Hit on every dispatch: suppression lookup and the per-person attempt cap
-- both filter leads by phone.
CREATE INDEX IF NOT EXISTS idx_leads_phone ON leads(phone_e164);
-- Every per-ad economics query filters here.
CREATE INDEX IF NOT EXISTS idx_leads_ad ON leads(ad_id);
CREATE INDEX IF NOT EXISTS idx_revenue_lead ON revenue(lead_id);
CREATE INDEX IF NOT EXISTS idx_approvals_run_status ON approvals(run_id, status);
CREATE INDEX IF NOT EXISTS idx_audit_kind ON audit(kind);
CREATE INDEX IF NOT EXISTS idx_ads_campaign ON ads(campaign_id);
CREATE INDEX IF NOT EXISTS idx_briefs_run ON briefs(run_id);
CREATE INDEX IF NOT EXISTS idx_call_attempts_phone ON call_attempts(run_id, phone_e164);
CREATE INDEX IF NOT EXISTS idx_call_attempts_at ON call_attempts(dispatched_at);
CREATE INDEX IF NOT EXISTS idx_webhook_status ON webhook_events(status, received_at);
`;

/** The DDL for one table, taken from SCHEMA so there is a single source of truth. */
function ddlFor(table: string): string {
  const match = new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\([\\s\\S]*?\\n\\);`).exec(SCHEMA);
  if (!match) throw new Error(`no CREATE TABLE found for ${table}`);
  return match[0];
}

/**
 * Rebuild a table so it picks up constraints that ALTER TABLE cannot add.
 *
 * SQLite has no "ADD CONSTRAINT", so the documented route is to build the new
 * shape alongside, copy the rows, and swap. Column list comes from the live
 * table, so a rebuild copies exactly what is there rather than assuming the
 * old and new shapes match.
 */
function rebuildWithConstraints(db: DatabaseSync, table: string): void {
  const existing = (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);
  if (existing.length === 0) return;

  const wanted = ddlFor(table);
  const newCols = new Set(
    (wanted.match(/\n {2}(\w+) /g) ?? []).map((m) => m.trim().split(/\s/)[0]!),
  );
  const carried = existing.filter((c) => newCols.has(c));
  const cols = carried.map((c) => `"${c}"`).join(', ');

  // ALTER TABLE RENAME rewrites foreign keys in *other* tables to follow the
  // new name. Every table this one rebuilds is a parent, so without this any
  // table already referencing it ends up pointing at `<table>_migrating`, which
  // is then dropped - leaving a reference to a table that does not exist. It
  // stayed invisible only because no table created before this migration
  // referenced a rebuilt one; adding call_attempts to the schema exposed it as
  // a foreign key violation naming `leads_migrating`.
  //
  // legacy_alter_table makes RENAME leave other tables alone, which is what a
  // rebuild wants: the new table has the same name, so their references are
  // already correct.
  db.exec('PRAGMA legacy_alter_table = ON');
  try {
    db.exec(`ALTER TABLE ${table} RENAME TO ${table}_migrating`);
    db.exec(wanted);
    db.exec(`INSERT INTO ${table} (${cols}) SELECT ${cols} FROM ${table}_migrating`);
    db.exec(`DROP TABLE ${table}_migrating`);
  } finally {
    db.exec('PRAGMA legacy_alter_table = OFF');
  }
}

interface Migration {
  version: number;
  name: string;
  up: (db: DatabaseSync) => void;
}

/**
 * Applied in order, once each. Never edit one that has shipped - add another.
 */
const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'idempotency.status',
    up: (db) => {
      const columns = db.prepare('PRAGMA table_info(idempotency)').all() as Array<{ name: string }>;
      if (!columns.some((c) => c.name === 'status')) {
        // Rows written before this existed are all completed operations.
        db.exec("ALTER TABLE idempotency ADD COLUMN status TEXT NOT NULL DEFAULT 'done'");
      }
    },
  },
  {
    version: 2,
    name: 'foreign keys on the parent-child tables',
    up: (db) => {
      // PRAGMA foreign_keys was ON from the first release and no table declared
      // a single REFERENCES clause, so the pragma implied an integrity that did
      // not exist. A database created before this has orphan rows waiting to
      // happen; foreign_key_check after the rebuild refuses to carry on if any
      // already exist.
      for (const table of ['briefs', 'approvals', 'campaigns', 'ads', 'leads', 'calls', 'spend', 'revenue', 'audit', 'cycles']) {
        const fks = db.prepare(`PRAGMA foreign_key_list(${table})`).all();
        if (fks.length === 0) rebuildWithConstraints(db, table);
      }
      // A rebuild drops the table's indexes with it.
      db.exec(SCHEMA);
    },
  },
  {
    version: 3,
    name: 'call_attempts',
    up: (db) => {
      db.exec(`CREATE TABLE IF NOT EXISTS call_attempts (
        attempt_id TEXT PRIMARY KEY,
        lead_id TEXT NOT NULL REFERENCES leads(lead_id),
        run_id TEXT NOT NULL REFERENCES runs(run_id),
        phone_e164 TEXT NOT NULL,
        dispatched_at TEXT NOT NULL
      )`);
      db.exec('CREATE INDEX IF NOT EXISTS idx_call_attempts_phone ON call_attempts(run_id, phone_e164)');
      db.exec('CREATE INDEX IF NOT EXISTS idx_call_attempts_at ON call_attempts(dispatched_at)');
      // Every call that already came back was placed at some point. Backfilling
      // from them keeps the caps honest on an existing database rather than
      // handing everyone a fresh allowance.
      db.exec(`INSERT OR IGNORE INTO call_attempts (attempt_id, lead_id, run_id, phone_e164, dispatched_at)
               SELECT 'bf_' || c.call_id, c.lead_id, l.run_id, l.phone_e164, c.received_at
               FROM calls c
               JOIN leads l ON l.lead_id = c.lead_id
               -- A backfill must not be the thing that introduces an orphan.
               JOIN runs r ON r.run_id = l.run_id`);
    },
  }
];

/**
 * The same logical operation is already running somewhere else.
 *
 * Not a failure: it is the idempotency guarantee doing its job. Whoever holds
 * the key will finish it, so the right response is to stand down rather than
 * do the work a second time.
 */
export class OperationInFlightError extends Error {
  readonly operation: string;
  constructor(operation: string, key: string) {
    super(`${operation} is already running for this key (${key}); not doing it twice`);
    this.name = 'OperationInFlightError';
    this.operation = operation;
  }
}

export class Store {
  readonly db: DatabaseSync;
  /** Where this store was opened from. ':memory:' for an in-memory one. */
  readonly path: string;

  constructor(path: string) {
    this.path = path;
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    // SQLite's default busy timeout is zero, so `serve` holding a write for a
    // few milliseconds was enough to make a CLI command in another process
    // fail outright with "database is locked". Waiting is the right answer:
    // the other writer is about to finish.
    this.db.exec('PRAGMA busy_timeout = 5000;');
    this.db.exec(SCHEMA);
    this.#migrate();
  }

  /**
   * Changes to tables that already exist in databases created before them.
   *
   * CREATE TABLE IF NOT EXISTS does nothing to a table that is already there,
   * so anything added later has to be applied explicitly or it is missing on
   * every database except a brand new one.
   *
   * Each migration is numbered, applied once, recorded in `schema_migrations`,
   * and wrapped in a transaction. Ordering is the array order. There is no down
   * path on purpose: rolling a schema backwards over live data is more
   * dangerous than rolling forwards to a fix.
   */
  #migrate(): void {
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         version INTEGER PRIMARY KEY,
         name TEXT NOT NULL,
         applied_at TEXT NOT NULL
       )`,
    );
    const applied = new Set(
      (this.db.prepare('SELECT version FROM schema_migrations').all() as Array<{ version: number }>).map(
        (r) => r.version,
      ),
    );

    for (const m of MIGRATIONS) {
      if (applied.has(m.version)) continue;
      // A migration that half-applies is worse than one that has not run, so
      // each is all-or-nothing. Foreign keys are suspended across a rebuild
      // because the table being replaced is briefly absent.
      this.db.exec('PRAGMA foreign_keys = OFF');
      this.db.exec('BEGIN');
      try {
        m.up(this.db);
        this.db
          .prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?,?,?)')
          .run(m.version, m.name, now());
        this.db.exec('COMMIT');
      } catch (err) {
        this.db.exec('ROLLBACK');
        throw new Error(`migration ${m.version} (${m.name}) failed and was rolled back: ${(err as Error).message}`, {
          cause: err,
        });
      } finally {
        this.db.exec('PRAGMA foreign_keys = ON');
      }

      // Refuse to carry on with data the new constraints reject.
      const violations = this.db.prepare('PRAGMA foreign_key_check').all();
      if (violations.length > 0) {
        throw new Error(
          `migration ${m.version} (${m.name}) left ${violations.length} foreign key violation(s); ` +
            `the data does not satisfy the new constraints`,
        );
      }
    }
  }

  /**
   * Idempotent: a command that closes the store itself is then closed again by
   * the CLI's finally block, and releasing a handle twice should be a no-op
   * rather than a crash on the way out.
   */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.db.close();
  }

  #closed = false;

  // --- audit -------------------------------------------------------------
  audit(runId: string | null, actor: AuditEvent['actor'], kind: string, detail: unknown): void {
    this.db
      .prepare('INSERT INTO audit (event_id, run_id, at, actor, kind, detail) VALUES (?,?,?,?,?,?)')
      .run(id('evt'), runId, now(), actor, kind, typeof detail === 'string' ? detail : JSON.stringify(detail));
  }

  /**
   * A filtered slice of the audit trail, newest first.
   *
   * Every guardrail refusal - a deferred call, a rejected lead, a pause the
   * holdout blocked - is recorded here and nowhere else, so this is how an
   * operator tells "nothing is happening" from "a rule is firing".
   */
  listAudit(runId: string | null, options: { kind?: string; actor?: string; limit?: number } = {}): AuditEvent[] {
    // `run_id = NULL` is never true in SQL, so events recorded without a run -
    // the HTTP layer's refusals, anything system-wide - used to be written and
    // then be unreadable by any query in the codebase. Pass null to read them.
    const where = [runId === null ? 'run_id IS NULL' : 'run_id = ?'];
    const params: Array<string | number> = runId === null ? [] : [runId];
    if (options.kind) {
      // A bare prefix like `call` matches call.deferred and call.outcome.
      where.push('(kind = ? OR kind LIKE ?)');
      params.push(options.kind, `${options.kind}.%`);
    }
    if (options.actor) {
      where.push('actor = ?');
      params.push(options.actor);
    }
    params.push(options.limit ?? 50);

    return this.db
      .prepare(
        `SELECT event_id as eventId, run_id as runId, at, actor, kind, detail
         FROM audit WHERE ${where.join(' AND ')} ORDER BY at DESC, rowid DESC LIMIT ?`,
      )
      .all(...params) as unknown as AuditEvent[];
  }

  /**
   * Is the file this store was opened from still on disk?
   *
   * On POSIX, deleting an open database leaves the process holding the inode:
   * reads keep working, writes keep succeeding, and every one of them goes to
   * a file with no directory entry. Nothing surfaces until the process exits
   * and the data goes with it. `reset` while `serve` is running does exactly
   * this, and without a check the server reports itself healthy the whole time.
   */
  fileMissing(): boolean {
    if (this.path === ':memory:') return false;
    return !existsSync(this.path);
  }

  /** How many of each kind of thing happened, most frequent first. */
  auditSummary(runId: string | null): Array<{ kind: string; actor: string; count: number; last: string }> {
    const scope = runId === null ? 'run_id IS NULL' : 'run_id = ?';
    return this.db
      .prepare(
        `SELECT kind, actor, COUNT(*) as count, MAX(at) as last
         FROM audit WHERE ${scope} GROUP BY kind, actor ORDER BY count DESC, kind`,
      )
      .all(...(runId === null ? [] : [runId])) as never;
  }

  auditTrail(runId: string): AuditEvent[] {
    return this.db
      .prepare(
        'SELECT event_id as eventId, run_id as runId, at, actor, kind, detail FROM audit WHERE run_id = ? ORDER BY at',
      )
      .all(runId) as unknown as AuditEvent[];
  }

  // --- idempotency -------------------------------------------------------
  /**
   * Run `fn` at most once for a given logical operation. A retried webhook or a
   * re-run CLI command returns the stored result instead of creating a second
   * campaign or placing a second call.
   */
  once<T>(operation: string, keyParts: unknown[], fn: () => T): T {
    const key = `${operation}:${fingerprint(keyParts)}`;
    const claim = this.#claim(key, operation);
    if (claim.state === 'done') return JSON.parse(claim.result) as T;
    if (claim.state === 'in_flight') throw new OperationInFlightError(operation, key);
    try {
      const result = fn();
      this.#settle(key, result);
      return result;
    } catch (err) {
      this.#release(key);
      throw err;
    }
  }

  /**
   * Async form of {@link once}, for provider calls that hit the network.
   *
   * The key is claimed *before* the work starts. It used to be written after:
   * read, await, write. Two concurrent callers with the same key both saw no
   * row, both ran the operation, and the loser then hit a UNIQUE constraint on
   * insert - so a redelivered Meta webhook placed a second call to the same
   * person and reported it as a database error, which reads like nothing
   * happened. Sequential redelivery was always fine, which is why every test
   * passed; Meta's retries are the concurrent case.
   */
  async onceAsync<T>(operation: string, keyParts: unknown[], fn: () => Promise<T>): Promise<T> {
    const key = `${operation}:${fingerprint(keyParts)}`;
    const claim = this.#claim(key, operation);
    if (claim.state === 'done') return JSON.parse(claim.result) as T;
    if (claim.state === 'in_flight') throw new OperationInFlightError(operation, key);
    try {
      const result = await fn();
      this.#settle(key, result);
      return result;
    } catch (err) {
      // The work failed, so the key should not stay claimed - a retry has to be
      // able to run. Safe because every provider call also carries its own
      // idempotency key, so the provider deduplicates a request that did land.
      this.#release(key);
      throw err;
    }
  }

  /**
   * Take the key, or report who has it.
   *
   * One statement, so two processes cannot both win: SQLite settles it, not the
   * order the reads happen to interleave in.
   */
  #claim(key: string, operation: string): { state: 'claimed' } | { state: 'done'; result: string } | { state: 'in_flight' } {
    const inserted = this.db
      .prepare(
        `INSERT INTO idempotency (key, operation, result, status, created_at)
         VALUES (?,?,'','in_flight',?) ON CONFLICT(key) DO NOTHING`,
      )
      .run(key, operation, now());
    if (Number(inserted.changes) === 1) return { state: 'claimed' };

    const existing = this.db.prepare('SELECT result, status FROM idempotency WHERE key = ?').get(key) as
      | { result: string; status: string }
      | undefined;
    if (existing?.status === 'done') return { state: 'done', result: existing.result };
    return { state: 'in_flight' };
  }

  #settle(key: string, result: unknown): void {
    this.db
      .prepare("UPDATE idempotency SET result = ?, status = 'done' WHERE key = ?")
      .run(JSON.stringify(result ?? null), key);
  }

  #release(key: string): void {
    this.db.prepare("DELETE FROM idempotency WHERE key = ? AND status = 'in_flight'").run(key);
  }

  // --- runs --------------------------------------------------------------
  createRun(niche: string): string {
    const runId = id('run');
    this.db
      .prepare(
        'INSERT INTO runs (run_id, brief_id, state, niche, created_at, updated_at, notes) VALUES (?,?,?,?,?,?,?)',
      )
      .run(runId, null, 'drafted', niche, now(), now(), '');
    return runId;
  }

  setRunState(runId: string, state: RunState, notes = ''): void {
    this.db
      .prepare('UPDATE runs SET state = ?, updated_at = ?, notes = ? WHERE run_id = ?')
      .run(state, now(), notes, runId);
  }

  getRun(runId: string): { runId: string; briefId: string | null; state: RunState; niche: string } | undefined {
    return this.db
      .prepare('SELECT run_id as runId, brief_id as briefId, state, niche FROM runs WHERE run_id = ?')
      .get(runId) as never;
  }

  listRuns(): Array<{ runId: string; state: RunState; niche: string; createdAt: string }> {
    return this.db
      .prepare('SELECT run_id as runId, state, niche, created_at as createdAt FROM runs ORDER BY created_at DESC')
      .all() as never;
  }

  latestRun(): string | undefined {
    const row = this.db.prepare('SELECT run_id as runId FROM runs ORDER BY created_at DESC LIMIT 1').get() as
      | { runId: string }
      | undefined;
    return row?.runId;
  }

  // --- briefs ------------------------------------------------------------
  saveBrief(runId: string, brief: Brief): void {
    this.db
      .prepare('INSERT OR REPLACE INTO briefs (brief_id, run_id, created_at, payload) VALUES (?,?,?,?)')
      .run(brief.briefId, runId, brief.createdAt, JSON.stringify(brief));
    this.db.prepare('UPDATE runs SET brief_id = ?, updated_at = ? WHERE run_id = ?').run(brief.briefId, now(), runId);
  }

  getBrief(runId: string): Brief | undefined {
    const row = this.db
      .prepare('SELECT payload FROM briefs WHERE run_id = ? ORDER BY created_at DESC LIMIT 1')
      .get(runId) as { payload: string } | undefined;
    return row ? (JSON.parse(row.payload) as Brief) : undefined;
  }

  // --- approvals ---------------------------------------------------------
  requestApproval(runId: string, gate: string, subject: string, detail: string): string {
    const approvalId = id('apr');
    this.db
      .prepare(
        'INSERT INTO approvals (approval_id, run_id, gate, subject, status, approver, decided_at, requested_at, detail) VALUES (?,?,?,?,?,?,?,?,?)',
      )
      .run(approvalId, runId, gate, subject, 'pending', null, null, now(), detail);
    return approvalId;
  }

  decideApproval(approvalId: string, status: 'approved' | 'rejected', approver: string): boolean {
    const res = this.db
      .prepare(
        "UPDATE approvals SET status = ?, approver = ?, decided_at = ? WHERE approval_id = ? AND status = 'pending'",
      )
      .run(status, approver, now(), approvalId);
    return Number(res.changes) > 0;
  }

  /** One approval by id, so a decision on it can be audited and checked. */
  getApproval(
    approvalId: string,
  ): { approvalId: string; runId: string; gate: string; subject: string; status: string; detail: string | null } | null {
    const row = this.db
      .prepare(
        `SELECT approval_id as approvalId, run_id as runId, gate, subject, status, detail
         FROM approvals WHERE approval_id = ?`,
      )
      .get(approvalId) as
      | { approvalId: string; runId: string; gate: string; subject: string; status: string; detail: string | null }
      | undefined;
    return row ?? null;
  }

  /** Which run an approval belongs to, so a decision on it is auditable there. */
  approvalRun(approvalId: string): string | null {
    return this.getApproval(approvalId)?.runId ?? null;
  }

  pendingApprovals(runId: string): Array<{ approvalId: string; gate: string; subject: string; detail: string }> {
    return this.db
      .prepare(
        "SELECT approval_id as approvalId, gate, subject, detail FROM approvals WHERE run_id = ? AND status = 'pending' ORDER BY requested_at",
      )
      .all(runId) as never;
  }

  hasApproval(runId: string, gate: string): boolean {
    const row = this.db
      .prepare("SELECT COUNT(*) as n FROM approvals WHERE run_id = ? AND gate = ? AND status = 'approved'")
      .get(runId, gate) as { n: number };
    return row.n > 0;
  }

  // --- campaigns / ads ---------------------------------------------------
  saveCampaign(c: CampaignRecord): void {
    this.db
      .prepare(
        'INSERT OR REPLACE INTO campaigns (campaign_id, adset_id, run_id, brief_id, objective, daily_budget_minor, currency, status, geo, created_at, provider) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      )
      .run(
        c.campaignId,
        c.adsetId,
        c.runId,
        c.briefId,
        c.objective,
        c.dailyBudgetMinor,
        c.currency,
        c.status,
        JSON.stringify(c.geo),
        c.createdAt,
        c.provider,
      );
  }

  getCampaign(runId: string): CampaignRecord | undefined {
    const row = this.db
      .prepare(
        'SELECT campaign_id as campaignId, adset_id as adsetId, run_id as runId, brief_id as briefId, objective, daily_budget_minor as dailyBudgetMinor, currency, status, geo, created_at as createdAt, provider FROM campaigns WHERE run_id = ? ORDER BY created_at DESC LIMIT 1',
      )
      .get(runId) as (Omit<CampaignRecord, 'geo'> & { geo: string }) | undefined;
    return row ? { ...row, geo: JSON.parse(row.geo) as string[] } : undefined;
  }

  setCampaignStatus(campaignId: string, status: 'ACTIVE' | 'PAUSED'): void {
    this.db.prepare('UPDATE campaigns SET status = ? WHERE campaign_id = ?').run(status, campaignId);
  }

  setCampaignBudget(campaignId: string, dailyBudgetMinor: number): void {
    this.db
      .prepare('UPDATE campaigns SET daily_budget_minor = ? WHERE campaign_id = ?')
      .run(dailyBudgetMinor, campaignId);
  }

  saveAd(a: AdRecord): void {
    this.db
      .prepare(
        'INSERT OR REPLACE INTO ads (ad_id, campaign_id, adset_id, creative_id, status, created_at) VALUES (?,?,?,?,?,?)',
      )
      .run(a.adId, a.campaignId, a.adsetId, a.creativeId, a.status, a.createdAt);
  }

  listAds(campaignId: string): AdRecord[] {
    return this.db
      .prepare(
        'SELECT ad_id as adId, campaign_id as campaignId, adset_id as adsetId, creative_id as creativeId, status, created_at as createdAt FROM ads WHERE campaign_id = ?',
      )
      .all(campaignId) as never;
  }

  setAdStatus(adId: string, status: 'ACTIVE' | 'PAUSED'): void {
    this.db.prepare('UPDATE ads SET status = ? WHERE ad_id = ?').run(status, adId);
  }

  // --- leads -------------------------------------------------------------
  /** Returns the existing lead id when the dedupe key was already seen. */
  insertLead(lead: Lead, dedupeKey: string): { leadId: string; duplicate: boolean } {
    const existing = this.db.prepare('SELECT lead_id as leadId FROM leads WHERE dedupe_key = ?').get(dedupeKey) as
      | { leadId: string }
      | undefined;
    if (existing) return { leadId: existing.leadId, duplicate: true };
    this.db
      .prepare(
        'INSERT INTO leads (lead_id, run_id, name, phone_e164, email, consent, consent_source, campaign_id, adset_id, ad_id, creative_id, created_at, call_status, dedupe_key) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      )
      .run(
        lead.leadId,
        lead.runId,
        lead.name,
        lead.phoneE164,
        lead.email,
        lead.consent ? 1 : 0,
        lead.consentSource,
        lead.campaignId,
        lead.adsetId,
        lead.adId,
        lead.creativeId,
        lead.createdAt,
        lead.callStatus,
        dedupeKey,
      );
    return { leadId: lead.leadId, duplicate: false };
  }

  getLead(leadId: string): Lead | undefined {
    const row = this.db
      .prepare(
        'SELECT lead_id as leadId, run_id as runId, name, phone_e164 as phoneE164, email, consent, consent_source as consentSource, campaign_id as campaignId, adset_id as adsetId, ad_id as adId, creative_id as creativeId, created_at as createdAt, call_status as callStatus FROM leads WHERE lead_id = ?',
      )
      .get(leadId) as (Omit<Lead, 'consent'> & { consent: number }) | undefined;
    return row ? { ...row, consent: row.consent === 1 } : undefined;
  }

  /**
   * Run several writes as one, or none of them.
   *
   * Publishing writes a campaign and then its ads; a call outcome writes the
   * call, then revenue, then audit rows. Crashing between those left partial
   * state that no later read could tell apart from the real thing - a campaign
   * with no ads reads as a campaign whose ads were all deleted.
   *
   * Synchronous on purpose. `node:sqlite` is a synchronous driver, and awaiting
   * inside a transaction would let another writer interleave between the
   * statements this is supposed to make atomic.
   */
  transaction<T>(fn: () => T): T {
    // Nested calls join the outer transaction rather than starting a second
    // one, which SQLite does not support.
    if (this.#inTransaction) return fn();
    this.#inTransaction = true;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    } finally {
      this.#inTransaction = false;
    }
  }

  #inTransaction = false;

  /** Revenue booked against a run, in minor units. */
  revenueMinor(runId: string): number {
    const row = this.db
      .prepare(
        `SELECT COALESCE(SUM(r.amount_minor), 0) AS total
         FROM revenue r JOIN leads l ON l.lead_id = r.lead_id
         WHERE l.run_id = ?`,
      )
      .get(runId) as { total: number };
    return row.total;
  }

  /** The most recent cycles across every run - what the loop has been doing. */
  recentCycles(limit = 10): Array<{ cycleId: string; runId: string; status: string; detail: string | null }> {
    return this.db
      .prepare(
        `SELECT cycle_id as cycleId, run_id as runId, status, detail
         FROM cycles ORDER BY started_at DESC, rowid DESC LIMIT ?`,
      )
      .all(limit) as never;
  }

  // --- emergency stop ----------------------------------------------------

  /**
   * Halt every autonomous mutation until a person releases it.
   *
   * Engaging is idempotent: a second trigger while already stopped does not
   * overwrite the first, because the first is the one that explains why the
   * system stopped. Nothing is deleted or paused remotely - spend at Meta
   * continues under its own daily budget and end date. This stops *this system*
   * from acting, which is the thing it can honestly promise.
   */
  engageEmergencyStop(input: { trigger: string; reason: string; detail?: unknown; by: string }): boolean {
    const current = this.emergencyStop();
    if (current.engaged) return false;
    this.db
      .prepare(
        `INSERT INTO emergency_stop (id, engaged, trigger, reason, detail, engaged_at, engaged_by, released_at, released_by)
         VALUES (1, 1, ?, ?, ?, ?, ?, NULL, NULL)
         ON CONFLICT(id) DO UPDATE SET
           engaged = 1, trigger = excluded.trigger, reason = excluded.reason, detail = excluded.detail,
           engaged_at = excluded.engaged_at, engaged_by = excluded.engaged_by,
           released_at = NULL, released_by = NULL`,
      )
      .run(input.trigger, input.reason, JSON.stringify(input.detail ?? null), now(), input.by);
    return true;
  }

  releaseEmergencyStop(by: string): boolean {
    const current = this.emergencyStop();
    if (!current.engaged) return false;
    this.db
      .prepare('UPDATE emergency_stop SET engaged = 0, released_at = ?, released_by = ? WHERE id = 1')
      .run(now(), by);
    return true;
  }

  emergencyStop(): EmergencyStopState {
    const row = this.db
      .prepare(
        `SELECT engaged, trigger, reason, detail, engaged_at as engagedAt, engaged_by as engagedBy,
                released_at as releasedAt, released_by as releasedBy
         FROM emergency_stop WHERE id = 1`,
      )
      .get() as
      | {
          engaged: number;
          trigger: string | null;
          reason: string | null;
          detail: string | null;
          engagedAt: string | null;
          engagedBy: string | null;
          releasedAt: string | null;
          releasedBy: string | null;
        }
      | undefined;

    if (!row || row.engaged !== 1) {
      return { engaged: false, trigger: null, reason: null, detail: null, engagedAt: null, engagedBy: null };
    }
    return {
      engaged: true,
      trigger: row.trigger,
      reason: row.reason,
      detail: row.detail,
      engagedAt: row.engagedAt,
      engagedBy: row.engagedBy,
    };
  }

  // --- webhook events ----------------------------------------------------

  /**
   * Record that a delivery arrived, or report that it already had.
   *
   * Written before the payload is acted on, so a handler that throws still
   * leaves a row saying what showed up and when. Duplicate detection is a
   * UNIQUE constraint rather than a read-then-write, so two deliveries racing
   * cannot both be treated as first.
   */
  recordWebhookEvent(input: {
    provider: string;
    providerEventId: string | null;
    payloadHash: string;
    signatureVerified: boolean;
  }): { eventId: string; duplicate: boolean } {
    const eventId = id('whk');
    // Only deliveries that passed verification share a dedupe space. A rejected
    // one gets a row of its own every time, for two reasons: repeated failures
    // are the signal worth counting, and otherwise replaying a known-good body
    // with a bad signature would collide with the genuine delivery's row and
    // flip its status to failed.
    const key = input.signatureVerified ? (input.providerEventId ?? input.payloadHash) : `rejected:${eventId}`;
    const inserted = this.db
      .prepare(
        `INSERT INTO webhook_events
           (event_id, provider, provider_event_id, payload_hash, signature_verified, received_at, status)
         VALUES (?,?,?,?,?,?, 'received')
         ON CONFLICT(provider, provider_event_id) DO NOTHING`,
      )
      .run(eventId, input.provider, key, input.payloadHash, input.signatureVerified ? 1 : 0, now());

    if (Number(inserted.changes) === 1) return { eventId, duplicate: false };

    const existing = this.db
      .prepare('SELECT event_id as eventId FROM webhook_events WHERE provider = ? AND provider_event_id = ?')
      .get(input.provider, key) as { eventId: string } | undefined;
    return { eventId: existing?.eventId ?? eventId, duplicate: true };
  }

  finishWebhookEvent(eventId: string, status: 'processed' | 'failed' | 'ignored', failureReason?: string): void {
    this.db
      .prepare('UPDATE webhook_events SET status = ?, processed_at = ?, failure_reason = ? WHERE event_id = ?')
      .run(status, now(), failureReason ?? null, eventId);
  }

  webhookEvent(eventId: string): WebhookEventRow | null {
    const row = this.db
      .prepare(
        `SELECT event_id as eventId, provider, provider_event_id as providerEventId, payload_hash as payloadHash,
                signature_verified as signatureVerified, received_at as receivedAt, status,
                processed_at as processedAt, failure_reason as failureReason
         FROM webhook_events WHERE event_id = ?`,
      )
      .get(eventId) as WebhookEventRow | undefined;
    return row ?? null;
  }

  listWebhookEvents(options: { status?: string; provider?: string; limit?: number } = {}): WebhookEventRow[] {
    const where: string[] = [];
    const params: Array<string | number> = [];
    if (options.status) {
      where.push('status = ?');
      params.push(options.status);
    }
    if (options.provider) {
      where.push('provider = ?');
      params.push(options.provider);
    }
    params.push(options.limit ?? 50);
    return this.db
      .prepare(
        `SELECT event_id as eventId, provider, provider_event_id as providerEventId, payload_hash as payloadHash,
                signature_verified as signatureVerified, received_at as receivedAt, status,
                processed_at as processedAt, failure_reason as failureReason
         FROM webhook_events ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
         ORDER BY received_at DESC, rowid DESC LIMIT ?`,
      )
      .all(...params) as unknown as WebhookEventRow[];
  }

  /** How many deliveries failed since a given time. Feeds the health check. */
  /**
   * Deliveries we accepted and then failed to process.
   *
   * `signature_verified = 1` is the whole point. A rejected forgery is also
   * written with status 'failed', and counting those here let anyone who could
   * reach the port halt the system: five unsigned POSTs in fifteen minutes
   * crossed the safety loop's threshold and engaged the emergency stop, with
   * no credentials at all. Refusing a forgery is this system working, not
   * failing. Only a delivery whose signature checked out and whose handler
   * then broke means revenue and opt-outs may not be landing.
   */
  webhookFailuresSince(sinceIso: string): number {
    const row = this.db
      .prepare(
        "SELECT COUNT(*) AS n FROM webhook_events WHERE status = 'failed' AND signature_verified = 1 AND received_at >= ?",
      )
      .get(sinceIso) as { n: number };
    return row.n;
  }

  /**
   * Deliveries refused at the signature.
   *
   * Worth surfacing and never worth stopping for: a burst means either a
   * misconfigured secret, which an operator should fix, or somebody probing,
   * which is not a reason to stop spending. Kept apart from the count above so
   * that distinction cannot be lost again.
   */
  webhookRejectionsSince(sinceIso: string): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS n FROM webhook_events WHERE signature_verified = 0 AND received_at >= ?')
      .get(sinceIso) as { n: number };
    return row.n;
  }

  /** How many call outcomes this lead row already has. */
  callCountForLead(leadId: string): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM calls WHERE lead_id = ?').get(leadId) as { n: number };
    return row.n;
  }

  /**
   * How many times this run has called this person, across every lead row.
   *
   * The attempt cap protects a person, not a row, and the dedupe key includes
   * the ad id - so one person answering two ads becomes two leads and used to
   * get the cap twice over. Scoped to the run: a genuinely new inquiry in a
   * later campaign is not the same as being dialled repeatedly about this one.
   */
  /** How many times this person has been dialled on this run. */
  callCountForPhone(runId: string, phoneE164: string): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS n FROM call_attempts WHERE run_id = ? AND phone_e164 = ?')
      .get(runId, phoneE164) as { n: number };
    return row.n;
  }

  /** Record that a call was placed. Counted by both call caps. */
  recordCallAttempt(lead: { leadId: string; runId: string; phoneE164: string }, at = now()): void {
    this.db
      .prepare(
        'INSERT INTO call_attempts (attempt_id, lead_id, run_id, phone_e164, dispatched_at) VALUES (?,?,?,?,?)',
      )
      .run(id('att'), lead.leadId, lead.runId, lead.phoneE164, at);
  }

  setLeadCallStatus(leadId: string, status: Lead['callStatus']): void {
    this.db.prepare('UPDATE leads SET call_status = ? WHERE lead_id = ?').run(status, leadId);
  }

  pendingLeads(runId: string): Lead[] {
    const rows = this.db
      .prepare(
        "SELECT lead_id as leadId, run_id as runId, name, phone_e164 as phoneE164, email, consent, consent_source as consentSource, campaign_id as campaignId, adset_id as adsetId, ad_id as adId, creative_id as creativeId, created_at as createdAt, call_status as callStatus FROM leads WHERE run_id = ? AND call_status = 'pending' ORDER BY created_at",
      )
      .all(runId) as Array<Omit<Lead, 'consent'> & { consent: number }>;
    return rows.map((r) => ({ ...r, consent: r.consent === 1 }));
  }

  countLeads(runId: string): number {
    return (this.db.prepare('SELECT COUNT(*) as n FROM leads WHERE run_id = ?').get(runId) as { n: number }).n;
  }

  callsToday(): number {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    return (
      this.db.prepare('SELECT COUNT(*) as n FROM call_attempts WHERE dispatched_at >= ?').get(since) as { n: number }
    ).n;
  }

  // --- suppression -------------------------------------------------------
  suppress(phoneE164: string, reason: string): void {
    this.db
      .prepare('INSERT OR REPLACE INTO suppression (phone_e164, reason, added_at) VALUES (?,?,?)')
      .run(phoneE164, reason, now());
  }

  isSuppressed(phoneE164: string): boolean {
    return this.db.prepare('SELECT 1 FROM suppression WHERE phone_e164 = ?').get(phoneE164) !== undefined;
  }

  // --- calls / revenue / spend ------------------------------------------
  saveCall(c: CallOutcome): void {
    this.db
      .prepare(
        'INSERT OR REPLACE INTO calls (call_id, lead_id, connected, qualified, intent_score, objection, appointment_booked, sale_status, expected_value_minor, next_action, summary, opt_out, received_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
      )
      .run(
        c.callId,
        c.leadId,
        c.connected ? 1 : 0,
        c.qualified ? 1 : 0,
        c.intentScore,
        c.objection,
        c.appointmentBooked ? 1 : 0,
        c.saleStatus,
        c.expectedValueMinor,
        c.nextAction,
        c.summary,
        c.optOut ? 1 : 0,
        c.receivedAt,
      );
  }

  callForLead(leadId: string): CallOutcome | undefined {
    const row = this.db
      .prepare(
        'SELECT call_id as callId, lead_id as leadId, connected, qualified, intent_score as intentScore, objection, appointment_booked as appointmentBooked, sale_status as saleStatus, expected_value_minor as expectedValueMinor, next_action as nextAction, summary, opt_out as optOut, received_at as receivedAt FROM calls WHERE lead_id = ? ORDER BY received_at DESC LIMIT 1',
      )
      .get(leadId) as
      | (Omit<CallOutcome, 'connected' | 'qualified' | 'appointmentBooked' | 'optOut'> & {
          connected: number;
          qualified: number;
          appointmentBooked: number;
          optOut: number;
        })
      | undefined;
    if (!row) return undefined;
    return {
      ...row,
      connected: row.connected === 1,
      qualified: row.qualified === 1,
      appointmentBooked: row.appointmentBooked === 1,
      optOut: row.optOut === 1,
    };
  }

  /**
   * Record revenue against a lead, once per event.
   *
   * `eventKey` identifies the thing that earned the money - a call, an external
   * posting - and is what makes a redelivery idempotent. It used to be the lead
   * id, with INSERT OR REPLACE, so a lead could only ever hold one revenue row:
   * a second genuine sale, or a later upsell, silently replaced the first.
   * Three sales of 900, 500 and 200 were reported as 200, while the audit trail
   * recorded all three and nothing reconciled the two.
   */
  recordRevenue(leadId: string, amountMinor: number, source: string, eventKey: string): void {
    this.db
      .prepare(
        'INSERT OR REPLACE INTO revenue (revenue_id, lead_id, amount_minor, source, recorded_at) VALUES (?,?,?,?,?)',
      )
      .run(`rev_${eventKey}`, leadId, amountMinor, source, now());
  }

  recordSpend(p: SpendPoint): void {
    this.db
      .prepare('INSERT INTO spend (run_id, ad_id, spend_minor, impressions, clicks, leads, as_of) VALUES (?,?,?,?,?,?,?)')
      .run(p.runId, p.adId, p.spendMinor, p.impressions, p.clicks, p.leads, p.asOf);
  }

  /** Latest spend snapshot per ad. Meta insights are cumulative, so take the max. */
  spendByAd(
    runId: string,
  ): Array<{ adId: string | null; spendMinor: number; impressions: number; clicks: number; leads: number }> {
    return this.db
      .prepare(
        `SELECT ad_id as adId,
                MAX(spend_minor) as spendMinor,
                MAX(impressions) as impressions,
                MAX(clicks) as clicks,
                MAX(leads) as leads
         FROM spend WHERE run_id = ? GROUP BY ad_id`,
      )
      .all(runId) as never;
  }

  totalSpendMinor(runId: string): number {
    return this.spendByAd(runId).reduce((sum, row) => sum + row.spendMinor, 0);
  }

  // --- evaluation cycles -------------------------------------------------
  startCycle(runId: string, at: string = now()): string {
    const cycleId = id('cyc');
    this.db
      .prepare('INSERT INTO cycles (cycle_id, run_id, started_at, status) VALUES (?,?,?,?)')
      .run(cycleId, runId, at, 'running');
    return cycleId;
  }

  finishCycle(
    cycleId: string,
    status: 'ok' | 'skipped' | 'error',
    outcome: { decision?: string | null; signal?: string | null; detail?: unknown } = {},
  ): void {
    this.db
      .prepare('UPDATE cycles SET finished_at = ?, status = ?, decision = ?, signal = ?, detail = ? WHERE cycle_id = ?')
      .run(
        now(),
        status,
        outcome.decision ?? null,
        outcome.signal ?? null,
        typeof outcome.detail === 'string' ? outcome.detail : JSON.stringify(outcome.detail ?? null),
        cycleId,
      );
  }

  listCycles(runId: string, limit = 20): Array<{
    cycleId: string;
    startedAt: string;
    finishedAt: string | null;
    status: string;
    decision: string | null;
    signal: string | null;
    detail: string | null;
  }> {
    return this.db
      .prepare(
        'SELECT cycle_id as cycleId, started_at as startedAt, finished_at as finishedAt, status, decision, signal, detail FROM cycles WHERE run_id = ? ORDER BY started_at DESC LIMIT ?',
      )
      .all(runId, limit) as never;
  }

  /** When this kind of event last happened on this run, if ever. */
  lastEventAt(runId: string, kind: string): string | null {
    const row = this.db
      .prepare('SELECT MAX(at) as at FROM audit WHERE run_id = ? AND kind = ?')
      .get(runId, kind) as { at: string | null } | undefined;
    return row?.at ?? null;
  }

  // --- locks -------------------------------------------------------------
  /**
   * Take a leased lock, or return false if someone else holds a live one.
   *
   * The lease matters more than the lock: a cycle that dies mid-run must not
   * wedge the scheduler forever, so the lock expires on its own. Wrapped in
   * BEGIN IMMEDIATE so two processes cannot both win the race.
   */
  acquireLock(name: string, holder: string, leaseMs: number, at: Date = new Date()): boolean {
    const nowIso = at.toISOString();
    const expires = new Date(at.getTime() + leaseMs).toISOString();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const existing = this.db.prepare('SELECT holder, expires_at as expiresAt FROM locks WHERE name = ?').get(name) as
        | { holder: string; expiresAt: string }
        | undefined;
      if (existing && existing.expiresAt > nowIso) {
        this.db.exec('ROLLBACK');
        return false;
      }
      this.db
        .prepare('INSERT OR REPLACE INTO locks (name, holder, acquired_at, expires_at) VALUES (?,?,?,?)')
        .run(name, holder, nowIso, expires);
      this.db.exec('COMMIT');
      return true;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  releaseLock(name: string, holder: string): void {
    this.db.prepare('DELETE FROM locks WHERE name = ? AND holder = ?').run(name, holder);
  }
}

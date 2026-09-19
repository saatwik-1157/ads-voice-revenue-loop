# Status after Tier 1

Tier 1 of the implementation order in [`PROJECT_AUDIT.md`](PROJECT_AUDIT.md) — the five items that
retire the most risk per unit of work. Phases 0 and 1 (audit and baseline) are complete;
Tiers 2–4 are not started.

Everything below was measured, not asserted. Commands and their output are at the end.

---

## What was implemented

| # | Item | Audit ref | State |
|---|---|---|---|
| 1.1 | Foreign keys, indexes, migration framework | D1, D2, D4 | done |
| 1.2 | Webhook event table and replay protection | D3, Phase 4 | done |
| 1.3 | Transaction boundaries | D7 | done |
| 1.4 | Fast safety loop | R1, Phase 11 | done |
| 1.5 | Global emergency stop | R4, Phase 12 | done |

### 1.1 — Integrity and migrations

`PRAGMA foreign_keys = ON` had been set since the first release while **no table declared a single
`REFERENCES` clause** — the grep count was zero. The pragma implied an integrity that did not exist.

- Ten foreign keys on the genuine parent-child relationships.
- **Deliberately unconstrained:** `leads.ad_id`, `leads.campaign_id`, `spend.ad_id`. These hold
  Meta's identifiers, and a lead arriving with no ad id is a normal case the system already handles
  (the `attribution_gap` signal). A constraint there would refuse real traffic.
- Seven indexes on columns that are actually filtered — notably `leads(phone_e164)`, hit on every
  dispatch by both the suppression check and the per-person attempt cap.
- A numbered migration framework, applied once each, transactional, recorded in
  `schema_migrations`. No down path: rolling a schema backwards over live data is worse than rolling
  forward to a fix. Every migration ends with `PRAGMA foreign_key_check`, so a database whose data
  cannot satisfy the new constraints **stops the upgrade loudly** rather than being accepted into a
  schema claiming a guarantee it does not hold.

Adding the constraints surfaced four test failures, **all of them real**: three fixtures saved ads
against a campaign id that was never created, one audited against a nonexistent run. Fixtures fixed,
constraints kept.

### 1.2 — Webhook events

Inbound payloads were processed and discarded; a failed delivery could not be inspected or replayed.

`webhook_events` records provider, the provider's event id, payload hash, whether the signature
verified, received and processed timestamps, status and failure reason. Written **before** the
payload is acted on, so a handler that throws still leaves a row. Flow on both routes: verify
signature → record → check duplicate → process → mark processed/ignored/failed.

- **The raw body is not stored.** It carries a name and a phone number; the hash is enough to
  recognise a repeat delivery without keeping a second copy of someone's details.
- Duplicate detection is a `UNIQUE` constraint with `ON CONFLICT DO NOTHING`, not read-then-write,
  so two deliveries racing cannot both be treated as first.
- A duplicate is answered `200` — the aim is to stop the provider redelivering, not to pretend the
  work was redone.

Writing the tests caught a flaw in my own first version: rejected deliveries shared a dedupe space
with verified ones, so replaying a known-good body with a **bad** signature collided with the genuine
delivery's row and flipped its status to failed. An attacker could have rewritten the record of a
legitimate event. Rejections now get their own row every time.

### 1.3 — Transactions

`store.transaction()` wraps a set of writes as one unit; nested calls join the outer transaction
rather than issuing a second `BEGIN`, which SQLite does not support. The call webhook commits as one
unit. Publishing commits the campaign and its audit row together, and the whole activation as a
second unit.

**Deliberately not transactional:** the loop that creates ads awaits two Meta calls per iteration. A
write transaction held across network I/O blocks every other writer for as long as the provider takes
— trading a rare partial write for a routine stall. Each ad row is a single atomic write instead, and
`onceAsync` already makes a resumed publish reuse ads it created.

### 1.4 / 1.5 — Fast safety loop and emergency stop

The stop-loss was evaluated inside `diagnose()`, which only runs during an evaluation cycle. At a
24-hour interval a run could pass its loss limit and keep spending for most of a day.

`src/safety/monitor.ts` checks spend against the stop-loss and test budget per live run, webhook
failures in a rolling window, and repeated cycle failures. Every check is a read. `inspectSafety()`
reports without acting; `runSafetyCheck()` engages the stop. `serve --schedule` runs it every minute
by default (`--safety 30s` to change).

The stop is a database row, not an in-memory flag — a stop a restart clears is not a stop. Engaging
is idempotent and **keeps the first reason**, because the first is the one that explains why the
system halted. Enforced at all four mutation points: `applyRecommendation`, `publishCampaign`,
`dispatchLead`, `runCycle`.

**What it does not do:** pause anything at Meta. Spend there continues under the ad set's own daily
budget and end date regardless of this process. The CLI says so rather than implying a guarantee the
system cannot make. Nothing is deleted — a test asserts the campaign, its ads and the run state are
all untouched.

---

## Files changed

| File | Change |
|---|---|
| `src/store/db.ts` | FKs, indexes, migration framework, `transaction()`, webhook event methods, emergency stop methods, `revenueMinor`, `recentCycles` |
| `src/core/types.ts` | `WebhookEventRow`, `EmergencyStopState` |
| `src/safety/monitor.ts` | **new** — the fast safety loop |
| `src/server/http.ts` | Webhook recording on both routes, body hashing |
| `src/pipeline/webhooks.ts` | Call outcome commits as one transaction |
| `src/pipeline/dispatch.ts` | Defers while the stop is engaged |
| `src/meta/publisher.ts` | Refuses while stopped; campaign and activation transactional |
| `src/apply.ts` | Refuses while stopped |
| `src/scheduler.ts` | Cycle skips while stopped |
| `src/cli/commands/tools.ts` | `safety` command |
| `src/cli/commands/automation.ts` | Fast loop in `serve`, cleanup on shutdown |
| `tests/migrations.test.ts` | **new** — 6 tests |
| `tests/webhook-events.test.ts` | **new** — 5 tests |
| `tests/safety.test.ts` | **new** — 8 tests |
| `tests/holdout.test.ts`, `tests/cli.test.ts`, `tests/idempotency.test.ts` | Fixtures corrected for the new constraints |
| `docs/PROJECT_AUDIT.md`, `docs/BASELINE.md` | **new** |

---

## Verification

```
npm run typecheck     clean
npm run lint          clean
npm test              243 passed, 0 failed  (was 224 at baseline)
node src/cli.ts demo  green, working tree clean afterwards
npm audit --omit=dev  0 vulnerabilities
```

End-to-end through the CLI, not only through tests:

```
node src/cli.ts safety --engage --reason "..." --by "operator"   →  EMERGENCY STOP ENGAGED
node src/cli.ts cycle                                            →  declines
node src/cli.ts safety                                           →  AUTOPILOT PAUSED, with reason and time
node src/cli.ts safety --release --by "operator"                 →  released, loop resumes
```

### Commands

```bash
npm ci                      # install
npm run typecheck           # tsc --noEmit
npm run lint                # eslint
npm test                    # 243 tests
npm run ci                  # all three
node src/cli.ts demo        # end-to-end against mocks
node src/cli.ts safety      # safety status + emergency stop state
```

Migrations run automatically when the store opens. There is no separate command and no down path.

---

## What is verified, and what is not

**Verified:** everything above, against mock providers and stubbed HTTP.

**Not verified — unchanged from the baseline, and not closable without credentials:**

| Integration | State |
|---|---|
| Meta Marketing API | Implemented, tested against stubs. Never called live. |
| OmniDimension voice | Implemented from the playbook's description, not vendor docs. The least-verified code here. |
| Anthropic brief drafting | Implemented, type-checked. Never called with a real key. |
| `preflight` | Its own logic is tested; its field names have never met the real Graph API. |

The live steps remain: `preflight`, `preflight --lead-form <id>`, `contract-test --live --to <your
number> --yes`, then a paused publish inspected in Ads Manager before activation.

---

## Known limitations introduced or still open

- **The 80% test-budget warning cannot fire under default configuration.** The shipped stop-loss
  (400000) sits below 80% of the test budget (480000), so spend high enough to warn has already
  passed the loss limit. Found by a test whose premise was wrong. Worth knowing when tuning those
  two numbers against each other.
- **The safety loop runs in the `serve` process.** If that process is down, nothing is checking. A
  separate worker is Tier 3 work.
- **`GET /runs` and `GET /runs/:id` still have no authentication** (audit S1). Unchanged by this
  tier, and the reason the audit puts authentication ahead of the dashboard.
- **No rate limiting** (S2), no structured logging (R6), no real health/readiness endpoint (R3), no
  circuit breaker (R2). All Tier 2.
- **Still SQLite only** (D5). The repository abstraction and PostgreSQL are Tier 3.

---

## Remaining work

Tier 2 (before any live traffic beyond a first test): HTTP authentication and authorisation, rate
limiting, structured logging and real health endpoints.

Tier 3: repository/data-access layer then PostgreSQL, provider hardening (circuit breaker, health
checks), revenue funnel expansion and richer attribution.

Tier 4: the HTTP API the dashboard would need, then the dashboard itself, experiments engine,
creative engine expansion, Docker, RBAC and multi-tenancy.

Reasoning for the ordering, including where it departs from the requested phase numbering, is in
[`PROJECT_AUDIT.md`](PROJECT_AUDIT.md) §13.

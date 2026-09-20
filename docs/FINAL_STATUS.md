# Status after Tier 2

Tiers 1 and 2 of the implementation order in [`PROJECT_AUDIT.md`](PROJECT_AUDIT.md). Phases 0 and 1
(audit and baseline) are complete; Tier 3 is not started. Of Tier 4, only the container image and the deployment path shipped - see
[`DEPLOY.md`](DEPLOY.md); the experiments engine shipped too ([`src/economics/experiment.ts`](../src/economics/experiment.ts));
the dashboard, the HTTP API behind it and multi-tenancy are not started.

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
| 2.1 | Authentication and roles on every route | S1, Phase 17 | done |
| 2.2 | Rate limiting | S2, Phase 18 | done |
| 2.3 | Liveness and readiness endpoints | R3, Phase 20 | done |
| 2.4 | Structured logging with redaction | R6, Phase 19 | done |

### 1.1 — Integrity and migrations

`PRAGMA foreign_keys = ON` had been set since the first release while **no table declared a single
`REFERENCES` clause** — the grep count was zero. The pragma implied an integrity that did not exist.

- Ten foreign keys on the genuine parent-child relationships. (Migration 3 later added two more
  with `call_attempts`; the counts here describe this change set, not the schema today.)
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

### 2.1 — Authentication and roles

`GET /runs` and `GET /runs/:id` answered 200 to anyone who could reach the port, returning economics,
recommendations and pending approvals. That was the highest-severity finding in the audit and the
reason authentication was ordered ahead of the dashboard.

`src/server/access.ts` gives two roles. `admin` writes (`POST /leads`, `POST /revenue`, approvals)
and reads; `viewer` only reads. Tokens come from `FL_ADMIN_TOKEN` / `FL_VIEWER_TOKEN` via
`x-fl-admin-token`, `x-fl-token` or `Authorization: Bearer`, compared with `timingSafeEqual` after a
byte-length check. **An unset token authenticates nobody** — the failure mode where a blank
environment variable matches a blank header would have opened every route at once. A wrong token
returns 401 with nothing about what would have been right, and the attempt is audited. `serve` warns
at startup, per route, when a token is missing.

### 2.2 — Rate limiting

Token buckets per route class: webhooks 120 burst / 10 per second, reads 60 / 2, writes 20 / 0.5,
unauthenticated 10 / 0.2. The bucket map is bounded at 10,000 keys and evicts oldest, so the limiter
cannot itself become the memory exhaustion it exists to prevent. In-memory and therefore per-process:
documented in the code, and not sufficient behind more than one instance.

### 2.3 — Health

`/health` and `/health/live` are open and answer whether the process is up. `/health/ready` actually
queries the database and counts recent webhook failures, and **returns 503** when either fails. The
previous endpoint returned 200 unconditionally, which meant a load balancer could not tell a healthy
process from a wedged one.

An engaged emergency stop does **not** make the process unready, and that is deliberate: a stopped
autopilot still has to accept webhooks, because revenue and opt-outs arrive that way and dropping
them is the failure the stop exists to prevent. The state is reported in the body instead.

### 2.4 — Structured logging

`src/core/log.ts`, on stderr, leaving human-readable command output on stdout. `FL_LOG_FORMAT=json`
for a pipeline, `FL_LOG_LEVEL` for verbosity. Logged: `http.request` (with a `requestId` echoed on
the `x-request-id` response header), `provider.request` with latency, `autopilot.decision`, and
`emergency_stop.engaged`.

Redaction is enforced on the way out, in one place, rather than trusted to every call site. A field
whose name looks like a secret is dropped entirely at any depth; phone numbers are masked to their
last four digits; every value passes through `redact()`, which catches a token pasted into a
free-text message where no field name would have flagged it; request logs record the path and never
the query string. That last defence is a deny-list and cannot enumerate every name somebody will
invent — it is the third of three, not the only one.

---

## Files changed

| File | Change |
|---|---|
| `src/store/db.ts` | FKs, indexes, migration framework, `transaction()`, webhook event methods, emergency stop methods, `revenueMinor`, `recentCycles` |
| `src/core/types.ts` | `WebhookEventRow`, `EmergencyStopState` |
| `src/safety/monitor.ts` | **new** — the fast safety loop; logs when the stop engages |
| `src/server/access.ts` | **new** — roles, token comparison, refusals |
| `src/server/ratelimit.ts` | **new** — bounded token-bucket limiter |
| `src/core/log.ts` | **new** — structured logging and output-side redaction |
| `src/server/http.ts` | Webhook recording on both routes, body hashing, auth and rate limiting on every route, liveness/readiness, request logging |
| `src/meta/api.ts` | Provider latency and failures logged |
| `src/pipeline/webhooks.ts` | Call outcome commits as one transaction |
| `src/pipeline/dispatch.ts` | Defers while the stop is engaged |
| `src/meta/publisher.ts` | Refuses while stopped; campaign and activation transactional |
| `src/apply.ts` | Refuses while stopped |
| `src/scheduler.ts` | Cycle skips while stopped; every decision logged |
| `src/cli/commands/tools.ts` | `safety` command |
| `src/cli/commands/automation.ts` | Fast loop in `serve`, cleanup on shutdown, per-route token warnings |
| `tests/migrations.test.ts` | **new** |
| `tests/webhook-events.test.ts` | **new** |
| `tests/safety.test.ts` | **new** |
| `tests/access.test.ts` | **new** |
| `tests/logging.test.ts` | **new** |
| `tests/holdout.test.ts`, `tests/cli.test.ts`, `tests/idempotency.test.ts`, `tests/http-hostile.test.ts` | Fixtures and expectations corrected for the new constraints |
| `.env.example` | `FL_VIEWER_TOKEN`, `FL_LOG_FORMAT`, `FL_LOG_LEVEL`; the old text still described open read routes |
| `docs/PROJECT_AUDIT.md`, `docs/BASELINE.md` | **new** |

---

## Verification

```
npm run typecheck     clean
npm run lint          clean
npm test              all passing, 1 skipped on Windows  (224 tests at the baseline; `npm test` is the
                      honest source for a count, and this line will not be kept up to date)
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

Tier 2 against a real `serve` process on port 8799, with `FL_LOG_FORMAT=json`:

```
GET  /health                                 →  200   (open)
GET  /health/ready                           →  200   ready:true, checks run against the database
GET  /runs            no token               →  401
GET  /runs            wrong token            →  401   "needs a viewer token", nothing more
GET  /runs            viewer token           →  200
POST /revenue         viewer token           →  401   viewer cannot write
GET  /runs            x15, unauthenticated   →  429 from the 10th, matching the 10-burst bucket
response header                              →  x-request-id: req_dcb7efac25b34d00
safety --engage, then GET /health/ready      →  200   autopilot.state "paused", with the reason
```

23 structured lines were written to stderr across that session. `grep` for either token value, and
for the wrong token that was sent, returns **0 matches** — the check that the redaction is doing
something, rather than the tests asserting it in isolation.

### Commands

```bash
npm ci                      # install
npm run typecheck           # tsc --noEmit
npm run lint                # eslint
npm test                    # the whole suite
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
  (100000) sits below 80% of the shipped test budget (80% of 150000 is 120000), so spend high enough
  to warn has already passed the loss limit. The same holds for the built-in defaults (400000
  against 480000). Found by a test whose premise was wrong. Worth knowing when tuning those
  two numbers against each other.
- **The safety loop runs in the `serve` process.** If that process is down, nothing is checking. A
  separate worker is Tier 3 work.
- **Rate limiting is per-process and in memory.** Correct for one instance, wrong behind a load
  balancer, where each process would enforce the limit separately. Shared state is Tier 3 work.
- **The logging deny-list cannot be complete.** It catches the field names in use today. A new field
  called something the pattern does not match would be logged, which is why `redact()` runs on every
  value as well and why nothing passes a raw request body to the logger.
- **Still SQLite only** (D5). The repository abstraction and PostgreSQL are Tier 3.
- **No dashboard and no HTTP API for one** (Tier 4). Everything is still CLI plus webhooks.

---

## Remaining work

Tier 3: repository/data-access layer then PostgreSQL, provider hardening (circuit breaker, health
checks, shared rate-limit state), revenue funnel expansion and richer attribution.

Tier 4: the HTTP API the dashboard would need, then the dashboard itself, experiments engine,
creative engine expansion, Docker, RBAC and multi-tenancy.

Reasoning for the ordering, including where it departs from the requested phase numbering, is in
[`PROJECT_AUDIT.md`](PROJECT_AUDIT.md) §13.

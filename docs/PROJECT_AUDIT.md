# Project audit

A read-only assessment of the repository as it stands at commit `45d2156`. Nothing was changed to
produce this document. Every claim below was checked against the code or by running it; where
something could not be checked, it says so rather than guessing.

---

## 1. Current architecture

A single Node process, no build step, no runtime framework. TypeScript executes directly on Node 24
via type stripping. One production dependency (`@anthropic-ai/sdk`), used only to draft the brief.

```
CLI (src/cli.ts)  ──┐
HTTP (src/server/)  ├──▶ Context ──▶ Store (SQLite)
Scheduler           ─┘      │
                            ├──▶ MetaProvider   { MetaApiProvider | MockMetaProvider }
                            ├──▶ VoiceProvider  { OmniDimensionProvider | MockVoiceProvider }
                            └──▶ CreativeAssetProvider { Library | Rendered }
```

`createContext()` in [`src/orchestrator.ts`](../src/orchestrator.ts) is the only place that decides
mock versus live. Everything downstream depends on the interface, not the implementation. Each
provider interface has exactly two implementations by design — there is deliberately nowhere to add
a browser driver or a scraper.

The domain loop is the playbook's eight phases:

```
brief ──▶ gate #1 ──▶ Meta campaign ──▶ lead ──▶ voice call ──▶ structured outcome
  ▲                                                                     │
  └──────── decision engine ◀── economics ◀── revenue ◀── attribution ◀──┘
```

| Module | Lines | Responsibility |
|---|---:|---|
| `meta/` | 1,193 | Marketing API client, mock delivery, publisher, preflight |
| `store/` | 861 | SQLite access, idempotency, leased locks |
| `creative/` | 796 | Asset library, PNG encoder, generated fallback, upload |
| `config/` | 777 | Guardrails (control layer), niche exclusions, env |
| `brief/` | 676 | Niche scoring, offer/creative/script, claim checking, Claude adapter |
| root | 629 | `cli.ts`, `orchestrator.ts`, `scheduler.ts`, `apply.ts`, `report.ts` |
| `voice/` | 491 | Provider interface, OmniDimension client, mock, contract probe |
| `core/` | 475 | Types, ids, phone normalisation, redaction, retry/backoff, money |
| `pipeline/` | 465 | Lead intake, dispatch, webhooks |
| `economics/` | 418 | Funnel metrics, decision engine |
| `server/` | 360 | Webhook middleware |
| `demo/` | 266 | The whole loop in one command |
| `approvals/` | 181 | Human gates #1 and #2 |
| `cli/` (including `cli/commands/`) | 882 | Command registry and arg parsing |

---

## 2. Existing features

- **Control layer** — hand-edited JSON validated by type before range, refusing malformed caps,
  unknown timezones, unsupported currencies and incoherent combinations. Every problem in the file
  is reported at once.
- **Brief generation** — deterministic offline writer, or Claude when a credential is present.
  Output is re-validated locally either way.
- **Claim checking** — walks the whole brief object and exempts only ids/formats/timestamps, so a
  new field is checked by default.
- **Human gates** — gate #1 before first publish, gate #2 for material budget change. Blocking
  issues cannot be approved past; publish re-checks the brief it is actually sending.
- **Meta execution** — campaign/ad set/creative/ad creation, status changes, budget updates,
  insights, lead retrieval. Every write carries an idempotency key.
- **Creative engine** — cleared asset library with provenance tracking, plus a zero-dependency
  generated fallback (hand-rolled PNG encoder over `node:zlib` and a 5×7 bitmap font).
- **Lead pipeline** — intake with consent and phone normalisation, suppression, calling window,
  daily ceiling, per-person attempt cap.
- **Decision engine** — ten ordered signals; diagnosis before optimisation.
- **Scheduler** — evaluation cycle on a timer with a leased lock per run.
- **Audit trail** — every consequential action and every refusal, queryable by kind and actor.
- **Preflight and contract-test** — read-only/self-directed probes of the two external APIs.

---

## 3. Working components (verified by running them)

| Component | Evidence |
|---|---|
| Typecheck | `tsc --noEmit` clean |
| Lint | `eslint .` clean, type-aware rules |
| Tests | 224 passing, 0 failing, ~10s |
| End-to-end demo | Runs green, leaves the working tree clean |
| CLI | `help`, `guardrails`, `runs` exit 0 |
| Dependency audit | `npm audit --omit=dev` → 0 vulnerabilities |
| Idempotency | Key claimed before work; concurrent callers verified in tests |
| Locking | Both writers (scheduler and `apply`) share `withRunLock` |

---

## 4. Mocked components

`MockMetaProvider` and `MockVoiceProvider` are the only implementations that have ever run a full
loop. They are honest about being simulations — the mock ad delivery is calibrated to plausible
small-business lead-gen so the decision engine can be exercised, not to forecast anything.

**The risk this creates is specific and has already bitten twice.** The mock gives every lead exactly
one call, which hid a defect where retries double-counted leads; and the tests cover redelivery but
not concurrency, which hid a defect where a redelivered webhook placed a second call to a real
person. Both passed the full suite. Any behaviour that only differs under real provider conditions
is, by construction, untested.

---

## 5. Unverified external integrations

**None of the three external integrations has ever been exercised against a live account.** This is
the single largest gap in the project and no amount of additional local work closes it.

| Integration | State | What is unverified |
|---|---|---|
| Meta Marketing API | Implemented, type-checked, tested against stubs | Field names, response shapes, error bodies, rate-limit behaviour, whether `X-Business-Idempotency-Key` is honoured on every endpoint used |
| OmniDimension voice | Implemented from the playbook's description, **not from vendor docs** | The entire dispatch contract: endpoint, payload shape, auth header, response field carrying the call id. This is the least-verified code in the repository. |
| Anthropic (brief drafting) | Implemented, type-checked against the SDK | Never called with a real key. Request shape is type-checked; the first live call should be treated as untested code. |
| `preflight` itself | Implemented, logic tested against a stubbed Graph API | Its own field names. It is the tool for checking everything else and has never met the real API. |

---

## 6. Security risks

| # | Risk | Severity | Detail |
|---|---|---|---|
| S1 | No authentication or authorisation on the HTTP layer | **High** | `POST /leads` and `POST /revenue` are gated only by a single shared `FL_ADMIN_TOKEN` compared with `timingSafeEqual`. `GET /runs` and `GET /runs/:id` are **completely open** — they expose economics, recommendations and pending approvals to anyone who can reach the port. There are no roles, no users, no sessions. |
| S2 | No rate limiting anywhere | **High** | Nothing bounds request volume on any route. An unauthenticated attacker can enumerate `GET /runs/:id` or force repeated signature verification at will. |
| S3 | No CORS policy | Medium | Not currently exploitable (no browser client exists), but becomes exploitable the moment a dashboard is added. |
| S4 | Webhook replay is only partly prevented | Medium | Signature verification is correct and constant-time. Duplicate *processing* is prevented by the idempotency table, but the **raw event is never persisted** — see D3. A replayed payload within the signature's validity is indistinguishable from a first delivery at the transport layer. |
| S5 | Admin token is a single shared secret | Medium | No rotation, no per-caller identity, no expiry. Compromise is total and silent. |
| S6 | Secrets handling is sound | — | Tokens are read from env, `redact()` strips them from error bodies and logs, and a test asserts secrets never reach the message of a failed call. `.env` is gitignored. **No issue found.** |
| S7 | No SQL injection surface found | — | Every query uses parameter binding. Table/column names are never interpolated from input. Checked all 40+ `prepare()` sites. |
| S8 | Dependency surface is minimal | — | One production dependency. `npm audit` clean. |

---

## 7. Reliability risks

| # | Risk | Severity | Detail |
|---|---|---|---|
| R1 | Stop-loss is evaluated per cycle, not continuously | **High** | It is checked inside `diagnose()`, which only runs during a cycle. Between cycles Meta keeps delivering and nothing here is watching. Worst case is the threshold plus one evaluation interval of spend. At 24h and ₹300/day a ₹1,000 stop-loss is discovered at about ₹1,300. This is exactly the problem the requested fast safety loop addresses. |
| R2 | No circuit breaker | Medium | Retry with backoff exists and is correct (4xx never retried, `Retry-After` honoured, full jitter). But a provider that is hard-down is retried on every cycle forever; there is no state that says "stop trying for a while". |
| R3 | No health or readiness endpoint | Medium | `GET /health` returns a static `{ok:true}` plus mode. It does not check the database, the providers, or webhook health, so it cannot fail — which makes it useless as a liveness signal. |
| R4 | No global emergency stop | Medium | A run can be paused individually. There is no single switch that halts all autonomous mutation across every run. |
| R5 | Single process, no worker separation | Medium | `serve --schedule` runs the HTTP server and the scheduler in one process. A slow cycle blocks nothing (it is async) but an unhandled crash takes both down together. |
| R6 | No structured logging | Medium | Output is human-readable text to stdout/stderr. There is no request id, no duration, no machine-parseable event stream, so production debugging would rely on reading prose. |
| R7 | Graceful shutdown is partial | Low | `Ctrl-C` finishes the cycle in flight and exits. Documented caveat: Node does not receive `SIGTERM` from an external kill on Windows, so a service manager stop mid-cycle relies on the lock lease rather than a clean handoff. |

---

## 8. Database risks

| # | Risk | Severity | Detail |
|---|---|---|---|
| D1 | **Zero foreign keys** | **High** | `PRAGMA foreign_keys = ON` is set, and then no table declares a single `REFERENCES` clause — verified by grep, count is 0. Nothing prevents a call row pointing at a lead that does not exist, or spend attributed to a deleted run. The pragma gives a false impression of integrity. |
| D2 | Only five indexes, none on hot filter columns | Medium | Indexes exist on `cycles(run_id)`, `leads(run_id)`, `calls(lead_id)`, `spend(run_id)`, `audit(run_id)`. Missing: `leads(phone_e164)` (used by suppression and the per-person attempt cap on every dispatch), `leads(ad_id)` (every per-ad economics query), `approvals(run_id, status)`, `audit(kind)`. |
| D3 | No webhook event table | **High** | Inbound payloads are processed and discarded. There is no record of what arrived, when, from whom, its hash, whether the signature verified, or why processing failed. A failed webhook cannot be replayed or even inspected. This is the gap Phase 4 of the request targets. |
| D4 | No migration framework | Medium | Schema is `CREATE TABLE IF NOT EXISTS` plus one hand-written guarded `ALTER TABLE` for the idempotency `status` column. There is no version table, no ordering, no down path. The next schema change has no safe pattern to follow. |
| D5 | SQLite only | Medium | `DatabaseSync` from `node:sqlite` is used directly throughout `store/db.ts`. There is no repository abstraction, so business logic and SQL are interleaved. Supporting PostgreSQL means either an abstraction layer or a parallel implementation. |
| D6 | Inconsistent timestamps, no soft delete | Low | Most tables carry a text ISO timestamp; none has `updated_at`; none supports soft deletion. `reset --yes` is a hard file delete, guarded against live mode. |
| D7 | Transaction boundaries are narrow | Medium | `BEGIN IMMEDIATE` is used correctly for lock acquisition. Multi-row operations elsewhere (publish writing campaign + ads, webhook writing call + revenue + audit) are **not** wrapped in a transaction, so a crash mid-sequence leaves partial state. |
| D8 | Busy timeout is set | — | `PRAGMA busy_timeout = 5000` and WAL are both on. **No issue.** |

---

## 9. Scaling risks

| # | Risk | Detail |
|---|---|---|
| X1 | No tenancy of any kind | Every table is global. No `organization_id`, no `user_id`. Adding multi-tenancy later means touching every table and every query. |
| X2 | `insights()` issues one HTTP request per ad | Six creatives is six calls per sync; this is linear in ad count and will hit rate limits before it hits anything else. Meta supports batch insights. |
| X3 | Economics are recomputed from raw rows on every call | No materialisation, no cache. Fine at current volume (hundreds of rows); a full-table scan per dashboard render at 10⁶ leads is not. |
| X4 | `callsToday()` is a global counter | Correct for one operator; wrong the moment two tenants share a process. |
| X5 | Mock ad state is a single JSON file | `data/mock-meta.json` is read and rewritten wholesale on every tick. Dev-only, but it caps demo scale. |

---

## 10. UX / dashboard gaps

**There is no frontend of any kind.** No HTML, no CSS, no client framework, no `.tsx` files, no
static assets beyond generated ad artwork. The entire operator surface is:

- a CLI with 21 commands and generated help
- five read-only JSON HTTP endpoints
- PNG previews written to `data/previews/<runId>/`

Every page in the requested dashboard (`/dashboard`, `/campaigns`, `/creatives`, `/leads`, `/calls`,
`/revenue`, `/experiments`, `/autopilot`, `/approvals`, `/audit`, `/settings`, `/health`) would be
new construction. The JSON endpoints to feed several of them do not exist either.

This is the single largest piece of net-new work in the request, and it is the one with no existing
foundation to build on.

---

## 11. Testing gaps

224 tests pass and the suite is genuinely good in the areas it covers — hostile input, guardrail
validation, idempotency under concurrency, audit coverage, claim checking, phone normalisation. The
gaps are structural rather than careless:

| Gap | Detail |
|---|---|
| No provider contract tests | Nothing asserts the Meta or voice request shapes against a recorded real response. `contract-test` probes live; there is no offline fixture. |
| No database integration tests against Postgres | There is no Postgres. |
| No failure-injection for provider outage at the loop level | Retry is tested in isolation; a full cycle against a hard-down provider is not. |
| No load or concurrency tests beyond idempotency | Two concurrent callers are tested. Fifty are not. |
| No migration tests | One migration exists and is tested; there is no framework to test. |
| E2E is the demo | Good — it has caught integration breaks unit tests passed. But it runs entirely on mocks. |
| No security tests | No tests for authz, rate limiting or replay windows, because none of those exist. |

---

## 12. Deployment gaps

Nothing exists. No `Dockerfile`, no `docker-compose.yml`, no `.env.production.example`, no process
manager config, no deployment section in the README beyond "expose the server at a public HTTPS
URL". CI runs lint, typecheck, tests and the demo on push — it does not build or publish an artefact,
because there is no build step and no artefact.

---

## 13. Recommended implementation order

Ordered by risk retired per unit of work, not by the numbering in the request. The reasoning for
each position is given because several items are deliberately *later* than requested.

### Tier 1 — do first (correctness and safety, small and high-value)

1. **Foreign keys and the missing indexes** (D1, D2). Cheap, mechanical, and closes a real integrity
   hole. Must come before any schema work built on top of it.
2. **Webhook event table** (D3, Phase 4). Persist provider, event id, received time, payload hash,
   signature result, processing status, failure reason. This is a prerequisite for replay,
   diagnosis, and for the observability and notification phases.
3. **Transaction boundaries** (D7). Wrap publish and webhook processing so a crash cannot leave half
   a campaign or a call without its revenue row.
4. **Fast safety loop** (R1, Phase 11). The stop-loss gap is the most dangerous live behaviour in the
   system and the fix is small: a short-interval loop that checks spend and provider health only.
5. **Global emergency stop** (R4, Phase 12). Depends on 4. Small once the fast loop exists.

### Tier 2 — before any live traffic beyond a first test

6. **HTTP authentication and authorisation** (S1). `GET /runs/:id` being open is not acceptable once
   this is reachable from anywhere. This must precede the dashboard, not follow it.
7. **Rate limiting** (S2).
8. **Structured logging and real health/readiness endpoints** (R3, R6, Phase 19). Required to operate
   anything unattended.
9. **Migration framework** (D4). Required before the Postgres work, not after.

### Tier 3 — substantial, sequenced

10. **Repository/data-access layer, then PostgreSQL** (D5, Phase 3). The abstraction must land first
    and pass the existing suite unchanged on SQLite before a second backend is introduced.
11. **Provider hardening** — circuit breaker, health check, request logging (R2, Phase 5). The retry
    and error layers already exist and are good; this extends them rather than replacing them.
12. **Revenue funnel expansion and richer attribution** (Phases 8, 9). Large, and it changes the
    schema — so it comes after migrations exist.

### Tier 4 — largest, most net-new

13. **HTTP API for the dashboard**. The dashboard cannot be built against five read-only endpoints.
14. **Dashboard** (Phases 16, 17, 18, 28). No existing foundation; needs a deliberate decision about
    the frontend stack, since the project currently has zero build tooling by design.
15. **Experiments engine** (Phase 13) and **creative engine expansion** (Phase 14).
16. **Docker and deployment** (Phase 24).
17. **RBAC** (Phase 22) and **multi-tenancy** (Phase 23). Deliberately last: both touch every table
    and every query, and doing them before the schema settles means doing them twice.

### A note on sequencing that conflicts with the request

The request asks for the dashboard (Phase 16) before observability (19), deployment (24) and RBAC
(22). Building an operator UI on top of an HTTP layer with **no authentication** and **no rate
limiting** would ship the security holes S1 and S2 into something people actually point a browser at.
The order above moves authentication ahead of the dashboard for that reason.

---

## Verification

Everything in sections 3 and 5 was produced by running the code at commit `45d2156`:

```
tsc --noEmit                 clean
eslint .                     clean
npm test                     224 passed, 0 failed
node src/cli.ts demo         green, working tree clean afterwards
npm audit --omit=dev         0 vulnerabilities
grep -c REFERENCES db.ts     0
```

Sections 6–12 are code review. Where a risk is theoretical rather than observed, it says so.

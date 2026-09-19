# Baseline

Measured at commit `45d2156` on 2026-09-19, before any changes were made for the production
hardening work. Every line below is the output of a command that was actually run. Nothing is
inferred and nothing is hidden.

## Environment

| | |
|---|---|
| Node | v24.18.0 |
| npm | 11.16.0 |
| Platform | Windows 11 (`win32`) |
| Required Node | `>=24.0.0` — TypeScript runs directly, `node:sqlite` needs no flag |

## Results

| Check | Command | Result |
|---|---|---|
| Install | `npm ci` | already installed, lockfile present |
| Typecheck | `npm run typecheck` | **PASS** — no errors |
| Lint | `npm run lint` | **PASS** — no errors, no warnings |
| Unit + integration tests | `npm test` | **224 passed, 0 failed**, 10.5s |
| End-to-end | `node src/cli.ts demo` (`FL_DB_PATH=:memory:`) | **PASS** |
| Working tree after E2E | `git status --porcelain` | clean — the run leaves no artefacts |
| Build | — | **N/A**: no build step by design. TypeScript executes directly via Node 24 type stripping. |
| Migrations | — | **N/A**: no migration framework. Schema is `CREATE TABLE IF NOT EXISTS` plus one guarded `ALTER TABLE`. See audit D4. |
| Dependency audit | `npm audit --omit=dev` | **0 vulnerabilities** |

### Test suite composition

17 files, 4,206 lines, 224 tests.

| File | Covers |
|---|---|
| `core.test.ts` | Phone normalisation, redaction, budget caps, currency exponents |
| `config.test.ts` | Guardrail validation — types before ranges, malformed config |
| `decision.test.ts` | The decision engine's ordered signals |
| `pipeline.test.ts` | Intake, dispatch, call webhook, attempt caps |
| `idempotency.test.ts` | Concurrent callers, claim-before-work, legacy rows |
| `http-hostile.test.ts` | Malformed bodies, oversized payloads, bad tokens |
| `compliance.test.ts` | Banned claims, gate enforcement, opt-out lines |
| `audit-coverage.test.ts` | Every consequential action and refusal is recorded |
| `preflight.test.ts` | Account checks against a stubbed Graph API |
| `creative.test.ts` | Asset library, provenance, image header validation |
| `scheduler.test.ts` | Cycles, locks, budget-raise floors |
| `exclusions.test.ts` | Niche exclusion rules and their three verdicts |
| `retry.test.ts` | Backoff, `Retry-After`, insights parsing |
| `holdout.test.ts` | Scale holdout enforcement |
| `leadgen.test.ts` | Meta leadgen webhook and lead retrieval |
| `contract.test.ts` | Voice dispatch contract probe |
| `cli.test.ts` | Command registry and argument parsing |

### CLI smoke tests

| Command | Exit | Note |
|---|---:|---|
| `help` | 0 | |
| `guardrails` | 0 | |
| `runs` | 0 | |
| `preflight` | 1 | **Correct.** Refuses with `not set: META_ACCESS_TOKEN, META_AD_ACCOUNT_ID, META_PAGE_ID`. Not a defect. |
| `contract-test` | 1 | **Correct.** Refuses with `not set: OMNI_API_KEY, OMNI_AGENT_ID`. Not a defect. |

Both non-zero exits are the credential guards doing their job. Verified by reading the output, not
assumed from the exit code.

## Failures found

**None caused by the repository.** Typecheck, lint, the full test suite and the end-to-end demo all
pass at this commit, and the demo leaves the working tree clean.

This is the starting point, not a claim of production readiness — see
[`PROJECT_AUDIT.md`](PROJECT_AUDIT.md) for what is missing. A green suite here means the code does
what its tests say; it does not mean the external integrations work, because none of them has been
run against a live account.

## External dependencies

| Dependency | Kind | Status |
|---|---|---|
| `@anthropic-ai/sdk` ^0.125.0 | Runtime, optional at execution | Only production dependency. Used to draft the brief; the loop runs without it via the deterministic writer. |
| Meta Marketing API | External service | Implemented. **Never called live.** |
| OmniDimension | External service | Implemented from the playbook description, not vendor docs. **Never called live.** |
| Anthropic API | External service | Implemented. **Never called live.** |
| `node:sqlite` | Node builtin | In use, no flag required on Node 24 |

## Credentials unavailable in this environment

None of the following is present, so nothing depending on them has been exercised:

| Variable | Gates |
|---|---|
| `META_ACCESS_TOKEN`, `META_AD_ACCOUNT_ID`, `META_PAGE_ID` | All Meta calls, `preflight` |
| `META_APP_SECRET`, `META_WEBHOOK_VERIFY_TOKEN` | Inbound leadgen webhooks |
| `OMNI_API_KEY`, `OMNI_AGENT_ID` | Voice dispatch, `contract-test` |
| `OMNI_WEBHOOK_SECRET` / `OMNI_WEBHOOK_TOKEN` | Inbound call results |
| `ANTHROPIC_API_KEY` | Claude brief drafting (falls back to the offline writer) |
| `FL_ADMIN_TOKEN` | `POST /leads`, `POST /revenue` |

Consequently the live verification steps below **have not been performed and cannot be performed from
here**:

1. `preflight` against a real ad account — token validity, scopes, account status, currency match
2. `preflight --lead-form <id>` — instant form has a phone question
3. `contract-test --live --to <own number> --yes` — one real call, settling the dispatch contract
4. A brief drafted by Claude with a real key
5. Publishing a real campaign paused, inspecting it, then activating

## Reproducing this baseline

```bash
npm ci
npm run typecheck
npm run lint
npm test
FL_DB_PATH=':memory:' node src/cli.ts demo
npm audit --omit=dev
```

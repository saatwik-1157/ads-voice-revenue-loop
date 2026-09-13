# Founder Labs Autopilot

An implementation of the *Autonomous AI Ads → Voice → Revenue* playbook: an AI orchestrator that
picks a niche, writes an offer and creative, publishes a guarded Meta test campaign, hands every
lead to an OmniDimension voice agent, reads structured call outcomes back, and decides
**KEEP / KILL / ITERATE / SCALE** from revenue rather than from clicks.

The whole loop runs today against **mock providers** — no ad spend, no phone calls — so you can see
the closed loop end to end before wiring real credentials:

```bash
node src/cli.ts demo
```

## What "closed loop" means here

```
 brief ──▶ gate #1 ──▶ Meta campaign ──▶ lead ──▶ voice call ──▶ structured outcome
   ▲                                                                      │
   └──────── decision engine ◀── economics ◀── revenue ◀── attribution ◀───┘
```

Every lead carries `campaign_id / adset_id / ad_id / creative_id` from the ad form, through the
voice agent's call metadata, and back on the post-call webhook. That round trip is the only reason
a sale can be attributed to the exact hook that paid for it.

## Status

| Playbook phase | Where it lives | State |
|---|---|---|
| A. Control layer | [`src/config/guardrails.ts`](src/config/guardrails.ts), [`config/guardrails.json`](config/guardrails.json) | complete |
| B. AI brief | [`src/brief/`](src/brief) | complete (Claude, with a deterministic offline writer) |
| C. Human gate #1 | [`src/approvals/gates.ts`](src/approvals/gates.ts) | complete |
| D. Meta execution | [`src/meta/`](src/meta) | API client complete; **untested against a live ad account** |
| E. Lead handoff | [`src/pipeline/intake.ts`](src/pipeline/intake.ts), [`dispatch.ts`](src/pipeline/dispatch.ts) | complete |
| F. Call result | [`src/pipeline/webhooks.ts`](src/pipeline/webhooks.ts) | complete; payload shape needs confirming against your OmniDimension agent |
| G. AI review | [`src/economics/`](src/economics) | complete |
| H. Human gate #2 | [`src/approvals/gates.ts`](src/approvals/gates.ts) | complete |
| (G on a timer) | [`src/scheduler.ts`](src/scheduler.ts) | complete — `cycle`, `schedule`, `serve --schedule` |
| Creative engine | [`src/creative/`](src/creative) | complete — asset library, generated fallback, upload to Meta |

One thing is deliberately **not** built, because it needs your Page: the Meta instant form itself.
Create it once and pass its id with `--lead-form`.

## Quick start

Requires **Node 22.6+** (24 recommended) — TypeScript runs directly, there is no build step.

```bash
npm install
node src/cli.ts demo          # the whole loop, mocked, ~2 seconds
npm test                      # 94 tests covering the guardrails, the loop, retries, scheduling and creative
```

### Commands

```bash
node src/cli.ts guardrails                          # print the active control layer
node src/cli.ts brief --deal-value 5000             # phase B, opens gate #1
node src/cli.ts approvals                           # what is waiting on a human
node src/cli.ts assets [runId] [--force]            # produce + upload artwork
node src/cli.ts approve <approvalId> --by "Nitesh"  # phase C
node src/cli.ts publish <runId> --budget 700 --days 5 --activate
node src/cli.ts sync <runId>                        # pull Meta insights
node src/cli.ts review <runId>                      # phase G: economics + decision
node src/cli.ts apply <runId>                       # act on it, inside the caps
node src/cli.ts cycle [runId]                       # one unattended cycle: sync + review + apply
node src/cli.ts schedule --every 6h                 # the cycle on a loop
node src/cli.ts cycles [runId]                      # what the loop has been doing
node src/cli.ts serve --schedule --every 6h         # webhook middleware + the loop
```

Money is passed to the CLI in major units (`--budget 700` = ₹700/day) and stored in minor units
everywhere internally, so there is no floating-point drift in the economics.

### Driving the loop by hand

`demo` runs everything in one process. To watch the same loop across real invocations — the shape a
production deployment actually has — use the server. Mock ad delivery persists in
`data/mock-meta.json` between processes, so the campaign keeps accumulating spend and leads while
you are not looking at it.

```bash
node src/cli.ts brief && node src/cli.ts approvals          # note the approval id
node src/cli.ts approve <approvalId> --by "Nitesh"
node src/cli.ts publish --budget 700 --days 5 --activate
node src/cli.ts sync                                        # advances one simulated day

FL_ADMIN_TOKEN=devtoken node src/cli.ts serve               # in another terminal
curl -X POST localhost:8787/leads -H 'x-fl-admin-token: devtoken' \
  -H 'content-type: application/json' \
  -d '{"name":"Asha R","phone":"9876543210","consent":true,
       "consentSource":"meta_instant_form","adId":"<adId from publish>"}'

curl localhost:8787/runs/<runId>                            # economics + live recommendation
```

`POST /leads` and `POST /revenue` place calls and move revenue, so they are closed unless
`FL_ADMIN_TOKEN` is set and sent as `x-fl-admin-token`. The two webhook routes are gated on HMAC
signatures instead.

## The control layer

Nothing spends, publishes or dials without clearing `config/guardrails.json` first. The agent can
propose changes to it; only a person editing the file can widen it.

```json
{
  "allowedGeos": ["IN"],
  "maxDailySpendMinor": 100000,
  "maxTestBudgetMinor": 500000,
  "stopLossMinor": 300000,
  "budgetApprovalThresholdMinor": 200000,
  "evaluationIntervalHours": 24,
  "minHoursBetweenBudgetRaises": 24,
  "callWindow": { "startHour": 10, "endHour": 19, "timeZone": "Asia/Kolkata" }
}
```

What that buys you, concretely:

- **The agent cannot publish at all** until gate #1 is approved — `publishCampaign` throws.
- **The agent cannot raise budget** past `maxBudgetStepFactor` (1.3×) or past
  `budgetApprovalThresholdMinor` without gate #2. Proven profitability moves it inside the step; it
  never moves it past the threshold.
- **The stop-loss outranks every other signal.** Once net loss reaches it, the only recommendation
  is KILL, and it is flagged as needing a human.
- **No calls outside the calling window**, none to a suppressed number, none past the daily ceiling.
- **Blocked niches are dropped before scoring**, so an off-limits market never reaches a human for
  approval. Special ad categories are declared `NONE` and blocked by default.

### Niche exclusions

A flat substring list gets this wrong in both directions: `includes('housing')` rejects "solar panel
cleaning for **housing societies**" — which sells a cleaning service to an apartment association, not
housing — while `includes('loan')` also fires on "Sloan". So the rules in
[`src/config/exclusions.ts`](src/config/exclusions.ts) are structured, matched on word boundaries,
and have **three** outcomes rather than two:

| Verdict | Meaning | What happens |
|---|---|---|
| `blocked` | the term names a restricted **offer** — "home loan", "rental listing", "casino" | candidate dropped before scoring; `publishCampaign` throws |
| `review` | the term is real but ambiguous — "housing", "credit", "dental" | candidate kept, flagged, and shown at gate #1 for a person to confirm |
| `allowed` | nothing fired, or an exemption covered it | proceeds normally |

The third outcome is the point. Some of these genuinely are judgement calls, and this system already
has a human gate — so it routes there instead of guessing. Supporting details:

- **Exemptions are local.** "housing society" stops `housing` from firing, but
  "rental listings promoted to housing societies" is still blocked — the exemption masks its own
  span, not the whole string.
- **Commentary is weaker evidence than the name.** A restricted term in the agent's own notes about
  a niche ("avoid medical treatment claims here") is capped at `review`; the same term in the niche
  name blocks.
- **Operator terms stay blunt.** Anything you list in `excludedNiches` is a hard block, matched on
  word boundaries.

## The decision engine

Diagnosis before optimisation. The rules are ordered so the system cannot paper over a plumbing
fault by generating more creative:

| Signal | What it means | What it does |
|---|---|---|
| `stop_loss` | net loss hit the cap | KILL, hand to a human |
| `no_delivery` / `no_leads` | spend but nothing arriving | ITERATE — check delivery, approval, tracking. **Explicitly not** "regenerate creative" |
| `insufficient_data` | below the decision threshold | KEEP — the sample cannot support a verdict |
| `low_connect_rate` | leads do not answer | ITERATE — phone capture, calling delay, time of day |
| `poor_qualification` | they answer but do not qualify | ITERATE — targeting or offer, not more spend |
| `qualified_no_conversion` | right people, lost at the ask | ITERATE — objections, pricing, trust, script |
| `profitable_cohort` | ROAS ≥ target on real sales | SCALE — gradual step, holdout enforced |
| `unprofitable_cpl` | CPL > 1.5× target after real spend | KILL the cohort |

Each creative is judged separately, but only after it has had a fair share of spend — otherwise the
engine just kills whichever ad the auction happened to starve.

### Scaling and the holdout

Every ad in one ad set shares a budget, so "reserve 20% for testing" and "do not pause everything
except the winner" are the same statement. `planScale` treats them that way:

- The step is `maxBudgetStepFactor` (1.3×), capped at `maxDailySpendMinor`, and split into a proven
  share and a holdout share — reported, audited, and shown on the CLI:
  `budget raised to INR 650.00/day (INR 520.00 proven + INR 130.00 holdout across 5 test creative(s))`
- The holdout is drawn from the creatives still being tested (`KEEP`/`ITERATE`). `apply` refuses to
  pause any of them and writes an `ad.pause_refused` audit event if something tries.
- **If there is nothing left to test, the scale step goes to gate #2 instead of proceeding.** A
  cohort with no test budget cannot find its own replacement, so that decision belongs to a person
  who can decide to add new variants.

## Where the artwork comes from

An ad creative needs a real `image_hash`, so `publish` refuses to run while any variant has none.
Two providers fill that in, behind one interface:

- **`assets/` — the approved asset library.** Drop cleared PNG or JPEG artwork in and it is used.
  This is what you actually run: a person made the artwork, owns or licensed it, and is happy for it
  to carry a budget. A filename naming an angle serves that angle (`speed-01.png` → the "Speed"
  variants); everything else comes from the pool in a stable order, so a variant keeps its image
  across republishes. Format, dimensions and size are read from the file header — not the extension —
  before anything is uploaded, because finding out from Meta after the fact is slow and confusing.
- **The generated fallback.** While the library is empty, a plain text-forward vertical card is
  rendered per variant (1080×1920, Reels safe areas respected, one palette per angle). Zero
  dependencies — Node has no rasterizer, so this is a small PNG encoder over built-in `zlib` plus an
  embedded 5×7 bitmap font. It exists for the same reason the offline brief writer does: so the loop
  runs and a real delivery test can go out before anyone opens a design tool.

**Claude does not generate images** — the Anthropic API is text-out — so there is no AI image
generation here. Adding one (any image API) means implementing `CreativeAssetProvider` and changing
nothing else.

Artwork is produced **before** gate #1, not after it, because the gate asks a person to approve the
creative and they cannot do that without seeing it. Previews are written to `data/previews/<runId>/`,
the gate summary reports what produced each image, and generated artwork adds an explicit line to
confirm:

```
Artwork: 6 rendered
CONFIRM before approving (1):
  - artwork is auto-generated, not cleared by a person - look at the previews before approving
```

Uploads are keyed on the image bytes, so a retried publish reuses the upload while genuinely new
artwork gets a new hash. One unusable file costs you that one ad, not the whole test.

## Running it unattended

`sync` -> `review` -> `apply` is the loop, and until something runs it on a timer the "autonomous"
part is aspirational. One **cycle** is the unit of work:

```bash
node src/cli.ts cycle                      # one cycle, every live run
node src/cli.ts schedule --every 6h        # the same thing on a loop
node src/cli.ts serve --schedule           # server and loop in one process
node src/cli.ts cycles                     # what it did, and when
```

`schedule` defaults to `evaluationIntervalHours`. For a one-shot under cron or Windows Task
Scheduler, use `cycle` — it is idempotent and safe to fire repeatedly.

What a cycle may do on its own: pull insights, evaluate, pause creatives the engine condemned, and
step budget up inside the approved band. What it may not do: widen a guardrail, resume a run a human
paused, or approve its own gate #2.

Four things make it safe to leave running:

- **Budget steps are rate-limited, not just size-limited.** `maxBudgetStepFactor` caps one decision.
  Left at that, a 6-hourly loop would compound 1.3× four times a day — **2.86×** — while every
  individual step still looked compliant. `minHoursBetweenBudgetRaises` is the floor that stops it,
  and it is enforced only for unattended runs; a person typing `apply` has already decided to act.
- **One pending gate #2, not one per cycle.** A decision waiting on a person is signal; a hundred
  copies of it is noise that buries the first one. If a request is already pending, the cycle reports
  that it is waiting and files nothing.
- **A leased lock per run.** Two overlapping cycles would double-count a budget step and race on
  pauses. The lease matters as much as the lock: a cycle killed mid-run releases it automatically
  rather than wedging the loop forever.
- **Failures are recorded, not thrown.** A provider outage ends that cycle with `error` in the
  `cycles` table and an audit event; the loop keeps its schedule. There is no catch-up burst either —
  if the process was down for a day, the right move is one cycle now, not twenty-four against stale
  data.

Ctrl-C finishes the cycle in flight and then exits. (On Windows, Node does not receive `SIGTERM` from
an external kill, so an unattended deployment there should stop the process via Ctrl-C or the service
manager rather than `taskkill` mid-cycle; the lock lease covers it either way.)

## Safety and platform rules

These are enforced in code, not just documented:

- **Authorized interfaces only.** Meta is reached through the Marketing API
  ([`src/meta/api.ts`](src/meta/api.ts)). There is no browser automation, no scraping, no UI
  mimicry, and `MetaProvider` has exactly two implementations so there is no place to add one.
- **Idempotency everywhere.** Campaign creation, ad creation, call dispatch and inbound webhooks all
  go through a keyed idempotency table, so a retry cannot duplicate a campaign, a call or a payment.
- **Transient failures are retried; permanent ones are not.** A 429, a 5xx or a dropped connection
  is retried with exponential backoff and full jitter, honouring `Retry-After` when the server sends
  one. A 4xx is a bug in the request and is thrown straight at you rather than burning the rate
  limit. Retrying a write is only safe because the idempotency key rides on every attempt - the
  tests assert exactly that.
- **Every webhook signature is verified** before anything happens — an unsigned payload can place
  phone calls and record revenue, so an unset secret fails closed.
- **Claims are checked before a human is asked to approve them.** A brief containing "guaranteed",
  "100%", "risk free" and friends is blocked at gate #1 rather than presented for sign-off, and the
  voice script is checked for promise drift against the ad's own CTA.
- **Consent, calling hours and opt-outs.** A lead with no recorded consent source is refused at
  intake. An opt-out on a call suppresses the number permanently and immediately.
- **Secrets never leave the server.** Tokens are read from env, redacted from logs, and never
  embedded in creative or sent to a browser.
- **Revenue means revenue.** An expected value on a *pending* appointment is a forecast and does not
  move ROAS. Only `sale_status: "won"` (or an external payment event via `POST /revenue`) counts.

## Going live

1. Fill in `.env` from `.env.example` and set `FL_MODE=live`. The process refuses to start with
   incomplete credentials rather than half-publishing a campaign.
2. Create the Meta instant form on your Page, and upload creative assets to get an `image_hash`.
   Publishing a creative without one is refused.
3. Set `META_APP_SECRET`, `META_WEBHOOK_VERIFY_TOKEN`, `OMNI_WEBHOOK_SECRET` and `FL_ADMIN_TOKEN`.
   Expose the server (`node src/cli.ts serve`) at a public HTTPS URL and point both webhooks at it:
   - `POST /webhooks/meta` — leadgen (verify subscription at `GET /webhooks/meta`)
   - `POST /webhooks/omnidimension` — post-call results
4. Publish **paused** first (`publish` without `--activate`), look at it in Ads Manager, then
   activate.

Confirm your OmniDimension agent's dispatch endpoint and post-call payload field names against
[`src/voice/omnidimension.ts`](src/voice/omnidimension.ts) and
[`src/pipeline/webhooks.ts`](src/pipeline/webhooks.ts) — the handler normalizes common variants, but
it is reading someone else's schema.

## Honest limitations

- **"Get the money back" is a target, not a guarantee.** This optimizes toward positive unit
  economics. It cannot make an offer profitable, and a system that spends money can lose it. The
  stop-loss bounds the loss; nothing bounds the outcome.
- **The mock providers are not a forecast.** They are calibrated to plausible small-business
  lead-gen (≈₹90 CPM, 0.4–1.4% CTR, 6–24% form completion, 0.2–6% lead→sale) so the loop and the
  decision engine can be exercised honestly. Your real numbers will differ.
- **The Meta client has been type-checked and exercised against the mock, not against a live ad
  account.** Expect to adjust field names on first contact.
- **Attribution is last-touch by ad id.** That is what the lead form gives you; it is not a
  multi-touch model.
- **The AI writes; it does not decide.** Claude drafts the brief and its output is re-validated
  locally. Every spend, publish and dial decision is made by the rules in this repo.

## Layout

```
src/
  config/      control layer (guardrails) + env
  core/        types, ids, phone normalization, redaction
  store/       SQLite: runs, briefs, approvals, campaigns, leads, calls, revenue, audit, idempotency
  brief/       niche scoring, offer + creative + script, claim checking, Claude adapter
  meta/        provider interface, Marketing API client, mock delivery, publisher
  voice/       provider interface, OmniDimension client, mock voice agent
  pipeline/    lead intake, dispatch, webhooks
  economics/   funnel metrics, decision engine
  approvals/   human gates #1 and #2
  creative/    asset library, generated fallback, PNG encoder, upload pipeline
  scheduler.ts the unattended evaluation cycle and its loop
  apply.ts     the one path both `apply` and the scheduler act through
  server/      webhook middleware
  demo/        the 48-hour MVP in one command
```

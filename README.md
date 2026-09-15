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
| B. AI brief | [`src/brief/`](src/brief) | complete; the offline writer is what has actually been exercised — see [Credentials](#credentials) |
| C. Human gate #1 | [`src/approvals/gates.ts`](src/approvals/gates.ts) | complete |
| D. Meta execution | [`src/meta/`](src/meta) | API client complete; **untested against a live ad account** - run `preflight` first |
| E. Lead handoff | [`src/pipeline/intake.ts`](src/pipeline/intake.ts), [`dispatch.ts`](src/pipeline/dispatch.ts) | complete |
| E2. Lead retrieval | [`src/server/http.ts`](src/server/http.ts), [`src/meta/api.ts`](src/meta/api.ts) | complete — the webhook carries a `leadgen_id`, the answers are fetched |
| F. Call result | [`src/pipeline/webhooks.ts`](src/pipeline/webhooks.ts) | complete — our contract; configure the agent to match ([guide](docs/omnidimension.md)) |
| G. AI review | [`src/economics/`](src/economics) | complete |
| H. Human gate #2 | [`src/approvals/gates.ts`](src/approvals/gates.ts) | complete |
| (G on a timer) | [`src/scheduler.ts`](src/scheduler.ts) | complete — `cycle`, `schedule`, `serve --schedule` |
| Creative engine | [`src/creative/`](src/creative) | complete — asset library, generated fallback, upload to Meta |

One thing is deliberately **not** built, because it lives on your Page: the Meta instant form itself.
Create it once and pass its id with `--lead-form` — step by step in
**[docs/meta-instant-form.md](docs/meta-instant-form.md)**.

## Quick start

Requires **Node 24+** — TypeScript runs directly, there is no build step.

Node 24 is the floor for two reasons, both load-bearing: `node:sqlite` is available without a flag,
and `.ts` files execute without one. Earlier versions need `--experimental-sqlite` and
`--experimental-strip-types`, which is a worse deal than upgrading. Verified on 24.18.

```bash
npm install
node src/cli.ts demo          # the whole loop, mocked, ~2.5 seconds
npm run lint                  # eslint, type-aware
npm test                      # 222 tests: guardrails, the loop, retries, scheduling, creative, hostile input
```

### Credentials

**Nothing here needs an API key.** With no credentials the loop runs end to end against the mock
providers, and the brief is written by a deterministic offline writer and labelled as such:

```
BRIEF brief_9ce6ab16db8d462e  (written by: deterministic)
```

Give it a credential and Claude drafts the brief instead. Three sources are honoured, because the
SDK resolves all three and gating on the API key alone silently downgrades anyone who authenticated
another way:

| Source | How |
|---|---|
| `ANTHROPIC_API_KEY` | a line in `.env`, or the environment |
| `ANTHROPIC_AUTH_TOKEN` | the environment |
| an `ant auth login` profile | `~/.config/anthropic` on disk |

`FL_BRIEF_MODEL` overrides the model (default `claude-sonnet-5`). A blank value falls back to the
default rather than sending an empty model, and an obvious placeholder (`sk-ant-REPLACE-ME` and
friends) counts as no key at all — otherwise it is truthy, earns a 401, and falls back to the offline
writer anyway with a confusing error in between.

### Commands

```bash
node src/cli.ts guardrails                          # print the active control layer
node src/cli.ts brief --deal-value 5000             # phase B: brief + artwork, opens gate #1
node src/cli.ts approvals                           # what is waiting on a human
node src/cli.ts assets [runId] [--force]            # produce + upload artwork
node src/cli.ts approve <approvalId> --by "Nitesh"  # phase C
node src/cli.ts publish <runId> --budget 700 --days 5 --activate
node src/cli.ts sync <runId>                        # pull Meta insights
node src/cli.ts economics <runId>                   # the funnel numbers on their own
node src/cli.ts review <runId>                      # phase G: economics + decision
node src/cli.ts audit [runId] [--kind call]         # what happened, and which rules fired
node src/cli.ts audit --system                      # events belonging to no run (refused requests)
node src/cli.ts reset --yes                         # throw away local state between demos
node src/cli.ts apply <runId>                       # act on it, inside the caps
node src/cli.ts apply <runId> --force --by "Nitesh" # ...and past the inter-raise floor, on the record
node src/cli.ts cycle [runId]                       # one unattended cycle: sync + review + apply
node src/cli.ts schedule --every 6h                 # the cycle on a loop
node src/cli.ts cycles [runId]                      # what the loop has been doing
node src/cli.ts serve --schedule --every 6h         # webhook middleware + the loop
node src/cli.ts contract-test                       # probe the voice API before trusting it
node src/cli.ts preflight [--lead-form ID]          # read-only checks on the real ad account
```

`npm run ci` runs lint, typecheck and tests together - the same three things CI runs on every push.

Money is passed to the CLI in major units (`--budget 700` = ₹700/day) and stored in minor units
everywhere internally, so there is no floating-point drift in the economics.

Those minor units are 1/100 of a major unit, everywhere. Meta takes budgets in the account currency's
own smallest unit, and that is not always 1/100 — the yen has no minor unit, the Kuwaiti dinar has
three decimals — so on a JPY account a budget this system means as ¥1,000.00 would be sent as
`100000` and buy a ¥100,000/day campaign. The control layer refuses a currency where the assumption
does not hold, and `preflight` reports it against the real account. A stated limitation beats a
silent factor of 100.

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
`FL_ADMIN_TOKEN` is set and sent as `x-fl-admin-token`. The webhook routes authenticate differently:
Meta is HMAC-only, and the voice route prefers HMAC but accepts a static token for platforms that
cannot sign a body. All of them fail closed when nothing is configured.

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
- **No calls outside the calling window**, none to a suppressed number, none past the daily ceiling,
  and no more than `maxCallAttemptsPerLead` to the same person **per run, counted by phone number**.
  That last one was declared here, validated on load and printed by `guardrails` for a while before
  anything that places a call read it — an unenforced version of a rule protecting a stranger's phone
  is worse than no rule, because the config says they are covered. Counting by phone rather than by
  lead row matters for the same reason: the dedupe key includes the ad id, so one person answering
  two ads becomes two lead rows and a per-row cap quietly allowed twice the calls it promised.
- **Blocked niches are dropped before scoring**, so an off-limits market never reaches a human for
  approval. Special ad categories are declared `NONE` and blocked by default.
- **A cap that is malformed is a cap that does not exist**, so the file is validated by type before
  it is validated by range. `"maxDailySpendMinor": "1,000"` parses to NaN, every comparison against
  NaN is false, and that limit silently stops applying — checking ranges alone let it through.
  `specialAdCategoriesAllowed: "false"` is a truthy string. A mistyped `timeZone` shifts the hours
  real people get called in, so it is checked against the runtime's own zone list. Every problem in
  the file is reported at once, nothing runs until it is fixed, and deleting the file falls back to
  the built-in defaults rather than to no limits.

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
| `attribution_gap` | half or more of the leads carry no ad id | ITERATE — fix the round trip; the per-ad numbers are a subset, not a split |
| `calls_pending` | leads arrived, most not dialled yet | KEEP — deferral is not a fault; check the window, the daily ceiling, or a stopped dispatcher |
| `low_connect_rate` | dialled leads do not answer | ITERATE — phone capture, calling delay, time of day |
| `poor_qualification` | they answer but do not qualify | ITERATE — targeting or offer, not more spend |
| `qualified_no_conversion` | right people, lost at the ask | ITERATE — objections, pricing, trust, script |
| `profitable_cohort` | ROAS ≥ target on real sales | SCALE — gradual step, holdout enforced |
| `unprofitable_cpl` | CPL > 1.5× target after real spend | KILL the cohort |

Each creative is judged separately, but only after it has had a fair share of spend — otherwise the
engine just kills whichever ad the auction happened to starve.

**Every stage counts leads, not call rows.** `maxCallAttemptsPerLead` is 2 by default, so a lead can
have more than one call, and joining leads to calls yields a row per attempt. Counting those rows
meant a second attempt doubled the lead count — halving CPL and halving the connect rate at the same
time, so a losing campaign read as twice as efficient as it was while a healthy funnel read as
broken. A lead reached on the second try was reached once.

**A lead nobody has dialled is not evidence about dialling.** A call deferred outside the calling
window writes an audit row and no call row, so a cycle at 02:00 saw leads with no connections and
reported a pipeline fault while the queue was simply waiting for 10:00. `low_connect_rate` is now
judged over the leads that actually have an outcome; the rest surface as `calls_pending`. The
reported connect rate still measures leads reached against every lead paid for — that number should
stay honest about leads you never got to.

**A creative is not judged on leads that lost their ad id.** Attribution is what makes the per-ad
split meaningful, and when it breaks it breaks quietly: a lead with no `ad_id` still counts in the
run total and is invisible to every per-ad number, so an ad whose leads lost their attribution looks
exactly like an ad with spend and no leads — which `judgeAd` kills. That pauses a working creative
for a tracking fault. Per-ad judging now abstains from that verdict while any lead is unattributed,
`economics` prints the count whenever it is non-zero, and half or more triggers `attribution_gap` at
the run level. The invariant to watch: per-ad leads plus unattributed leads equal the run total.

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
  to carry a budget. That act of putting the file there is the vouch, which is why it cannot be
  faked: `scripts/generate-placeholder-assets.ts` fills the directory for demonstration, and records
  what it wrote in `.generated.json` so those files keep reporting as machine-made and gate #1 keeps
  warning. A filename naming an angle serves that angle (`speed-01.png` → the "Speed"
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
  and it applies to people too. It used to be skipped whenever a person ran `apply`, on the reasoning
  that someone at a terminal has already decided to act — which put a scheduled cycle and a hand-run
  `apply` seconds apart at **1.69×**, both raises individually legal. The operator decides to raise
  once; they cannot see that the scheduler raised ninety seconds ago. Overriding the floor is
  `apply --force --by "your name"`, and the override is audited as `budget.floor_overridden`.
- **One pending gate #2, not one per cycle.** A decision waiting on a person is signal; a hundred
  copies of it is noise that buries the first one. If a request is already pending, the cycle reports
  that it is waiting and files nothing.
- **A leased lock per run, taken by both writers.** Two overlapping cycles would double-count a budget
  step and race on pauses — and so would a cycle overlapping a hand-run `apply`, which is how the
  1.69× above happened. Both go through `withRunLock`; whichever arrives second is turned away and
  told why, rather than acting. The lease matters as much as the lock: a cycle killed mid-run releases
  it automatically rather than wedging the loop forever.
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
- **Idempotency everywhere, and the key is claimed before the work starts.** Campaign creation, ad
  creation, call dispatch and inbound webhooks all go through a keyed idempotency table, so a retry
  cannot duplicate a campaign, a call or a payment. The claim ordering is the substance: the table
  used to be written *after* the operation, so two concurrent callers both saw no row, both did the
  work, and the loser hit a UNIQUE constraint — meaning a redelivered lead webhook placed a second
  call to the same person and reported it as a database error, which reads like nothing happened.
  Sequential redelivery was always correct, which is why the tests passed; a provider's retries are
  the concurrent case. The claim is now one `INSERT … ON CONFLICT DO NOTHING`, so SQLite decides the
  winner rather than the order two reads happen to interleave in, and the loser is told the work is
  already in flight instead of repeating it. A failed operation releases its key so a retry can run,
  which is safe because the provider call carries its own idempotency key too.
- **Transient failures are retried; permanent ones are not.** A 429, a 5xx or a dropped connection
  is retried with exponential backoff and full jitter, honouring `Retry-After` when the server sends
  one. A 4xx is a bug in the request and is thrown straight at you rather than burning the rate
  limit. Retrying a write is only safe because the idempotency key rides on every attempt - the
  tests assert exactly that.
- **Every webhook is authenticated** before anything happens — an unsigned payload can place phone
  calls and record revenue, so an unset secret fails closed. Meta is HMAC-only; the voice webhook
  prefers HMAC and accepts a static token for platforms that cannot sign a body, with the tradeoff
  documented rather than hidden.
- **Claims are checked before a human is asked to approve them, and the check is enforced.** A brief
  containing "guaranteed", "100%", "risk free" and friends is blocked at gate #1, `approve` refuses
  to grant it, and `publish` re-checks the brief it is actually about to send — because an approval
  is a decision about the brief as it stood then, and briefs can be edited afterwards. For a while
  the detection was perfect and the enforcement was absent: the gate listed the problems, `approve`
  ignored them, and copy promising "guaranteed results" went live under documentation saying that
  was impossible.
- **Everything a stranger can read or hear is claim-checked**, not a hand-picked list of fields. The
  whole brief object is handed to the voice provider, so anything in it can be spoken;
  `qualifyingQuestions` and `optOutLine` are both read aloud and neither used to be covered. The
  checker now walks the brief and exempts only ids, formats and timestamps, so a new field is
  checked by default rather than until someone remembers to add it.
- **Consent, calling hours and opt-outs.** A lead with no recorded consent source is refused at
  intake. An opt-out on a call suppresses the number permanently and immediately.
- **One person is one number.** Suppression is recorded against the normalized form, so a number that
  normalizes two different ways is two people as far as the opt-out list is concerned. `+9876543210`
  — a plus typed in front of a national number — used to be believed as an international number,
  producing a different number that may belong to somebody else and that walked straight past that
  person's opt-out. Ambiguous lengths, extensions (`9876543210 ext 22` became `+91987654321022`),
  repeated digits and anything else that is not exactly one phone number are refused rather than
  guessed at, which is what the function always claimed to do.
- **Every refusal is legible, not just recorded.** `audit` shows what happened and which rules fired,
  counted by kind - so "leads arriving, no calls going out" resolves to `84 call.deferred` in one
  command rather than a guess. Phone numbers are masked in the output.
- **Secrets never leave the server.** Tokens are read from env, redacted from logs, and never
  embedded in creative or sent to a browser.
- **Revenue means revenue.** An expected value on a *pending* appointment is a forecast and does not
  move ROAS. Only `sale_status: "won"` (or an external payment event via `POST /revenue`) counts, and
  the amount has to be a finite, non-negative number before it reaches the ledger — on both routes in.
  It is the figure every KEEP/KILL/SCALE decision is made from, so a poisoned one does not throw: JSON
  `1e999` parses to Infinity, which is greater than every ROAS target there is, so one malformed
  payload was enough to make the engine SCALE on infinite return. A bad amount is now zero and
  audited as `revenue.unusable_value` rather than discarding the call — the call really happened, and
  whether it connected and qualified is worth keeping.
- **A refusal is not a crash, and a crash is not a refusal.** A guardrail stopping a publish, a
  malformed config, an unusable image, a database another process is mid-write on — these are the
  system working, and they print what happened and what to do about it. Stack traces are reserved
  for genuine defects, where the machinery is exactly what you need to see. The same distinction
  runs through the HTTP layer: 4xx for anything the request got wrong, 5xx only for this server
  failing, because 5xx is what Meta and OmniDimension retry on.

## Going live

1. Fill in `.env` from `.env.example` and set `FL_MODE=live`. The process refuses to start with
   incomplete credentials rather than half-publishing a campaign.
2. **Run `node src/cli.ts preflight` before anything else.** Every call it makes is a GET — it creates
   nothing and spends nothing — and it answers the questions that are otherwise answered at the worst
   possible moment: is the token valid and when does it expire, does it hold `leads_retrieval`
   (without it, you find out when your first real lead arrives and its answers cannot be fetched), is
   the ad account active, does the instant form actually ask for a phone number, and **does the
   account bill in the same currency the control layer is written in**. That last one is the
   expensive one: budgets go to Meta as an integer of the *account's* minor units while every cap
   here is in the guardrails' currency, so an INR control layer against a USD account turns a
   ₹1,000/day cap into a $1,000/day campaign, with the stop-loss and CPL target denominated wrong at
   the same time. `publish` refuses on a mismatch; `preflight` tells you before you get that far and
   names the line to change. Add `--lead-form ID` to check the form too.
3. Create the Meta instant form on your Page and pass its id with `--lead-form` — the full walkthrough,
   including the `leads_retrieval` permission and Lead Access grant that leads silently depend on, is
   in [docs/meta-instant-form.md](docs/meta-instant-form.md). Artwork is handled for you — drop
   cleared files in `assets/` or let the generated fallback produce them; either way `brief` uploads
   them and publishing a creative without an `image_hash` is refused.
4. Set `META_APP_SECRET`, `META_WEBHOOK_VERIFY_TOKEN`, `FL_ADMIN_TOKEN`, and either
   `OMNI_WEBHOOK_SECRET` (HMAC, preferred) or `OMNI_WEBHOOK_TOKEN` (static header, weaker).
   Expose the server (`node src/cli.ts serve`) at a public HTTPS URL and point both webhooks at it:
   - `POST /webhooks/meta` — leadgen (verify subscription at `GET /webhooks/meta`)
   - `POST /webhooks/omnidimension` — post-call results
5. Publish **paused** first (`publish` without `--activate`), look at it in Ads Manager, then
   activate.

Confirm your OmniDimension agent's dispatch endpoint and post-call payload field names against
**[docs/omnidimension.md](docs/omnidimension.md)** — it covers both directions, and is explicit about
which half is our contract (the post-call webhook) and which half is a guess at someone else's API
(the dispatch call).

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
- **The voice dispatch shape is a guess at someone else's API.** `contract-test` exists to settle it
  against real credentials in one run rather than by reading — including whether the idempotency key
  is honoured, which is what the retry logic's safety rests on.
- **The model path is wired but unexercised.** Everything shown and tested here ran through the
  deterministic writer; `draftBrief` has never been run against a live API key. The request shape is
  type-checked against the SDK and the local re-validation applies either way, but treat the first
  real call as untested code.
- **Drafting runs on `claude-sonnet-5`** and `brief` is a billed call every time it runs. It is copy
  written against a tight spec that gets checked locally regardless, so it does not need the top of
  the range; `FL_BRIEF_MODEL` changes it.
- **The offline writer gives every variant the same headline and body.** Only the hook and the
  palette differ, so six generated creatives are a thin creative test on their own. Real artwork in
  `assets/`, or a model-written brief, is what makes the six worth testing against each other.

## Layout

```
src/
  config/      control layer (guardrails), niche exclusion rules, env
  core/        types, ids, phone normalization, redaction, retry/backoff
  store/       SQLite: runs, briefs, approvals, campaigns, leads, calls, revenue,
               spend, suppression, cycles, locks, audit, idempotency
               lock.ts: one writer per run, shared by the scheduler and `apply`
  brief/       niche scoring, offer + creative + script, claim checking, Claude adapter
  meta/        provider interface, Marketing API client, mock delivery, publisher
  voice/       provider interface, OmniDimension client, mock agent, contract probe
  pipeline/    lead intake, dispatch, webhooks
  economics/   funnel metrics, decision engine
  approvals/   human gates #1 and #2
  creative/    asset library, generated fallback, PNG encoder, upload pipeline
  cli/         one module per command group; help is generated from the registry
  scheduler.ts the unattended evaluation cycle and its loop
  apply.ts     the one path both `apply` and the scheduler act through
  server/      webhook middleware
  demo/        the 48-hour MVP in one command

docs/          setup guides for the two external accounts
tests/         222 tests, run by `npm test` and on every push
assets/        drop cleared artwork here (empty = generated fallback)
```

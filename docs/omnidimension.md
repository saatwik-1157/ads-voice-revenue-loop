# OmniDimension voice agent setup

Wiring the half of the loop that turns a lead into a conversation, and a conversation into a number
the decision engine can act on.

> **Read this first — the asymmetry matters.**
>
> The two directions of this integration have very different confidence levels:
>
> - **Outbound (we call them).** The endpoint and body in
>   [`src/voice/omnidimension.ts`](../src/voice/omnidimension.ts) were written from the playbook's
>   description, **not** verified against OmniDimension's API docs. Treat the request shape as a
>   first draft you will almost certainly adjust. [§4](#4-adapt-the-dispatch-call) tells you exactly
>   where.
> - **Inbound (they call us).** This is *our* contract — we define the fields and normalize common
>   variants. [§5](#5-the-post-call-webhook) is authoritative and you configure their agent to match.
>
> Where those differ, believe the inbound section and distrust the outbound one.

---

## 1. What the voice agent is for

It is not a robocaller reading a script at people. Its job is narrow:

1. **Reach the lead fast.** Connect rate collapses with delay, which is why dispatch happens the
   moment the lead lands rather than on a batch.
2. **Qualify honestly** against the brief's questions — need, timeline, budget, decision maker.
3. **Ask for the conversion** the ad already promised, and nothing beyond it.
4. **Come back with structured data**, not a transcript. The decision engine needs booleans and
   numbers to attribute revenue to a creative.

Everything it is allowed to say was approved by a human at gate #1. The agent is a reader, not an
author.

---

## 2. Create the agent

In the OmniDimension console, create an **outbound** agent. What matters:

- **Voice and language** should match the geography in `allowedGeos`. An accent the lead does not
  expect costs you the first ten seconds of every call.
- **Disclosure is mandatory.** The agent must say it is an AI assistant. The approved call script
  already does this in its answers (`"Who are you?"` → *"I am an AI assistant doing the first
  call, and a human handles the visit"*), several jurisdictions require it, and the instant form
  says the same thing. Do not configure a persona that contradicts it.
- **Let the call context drive the script.** Do not hard-code an offer into the agent. Each dispatch
  carries the approved script for that run, and a hard-coded offer would silently drift from what the
  ad promised — which is exactly the failure the claim checker exists to prevent.
- **Set a short max duration.** This is a qualification call, not a discovery session.

Note the **agent id** (`OMNI_AGENT_ID`) and an **API key** (`OMNI_API_KEY`).

---

## 3. What we send on dispatch

One POST per lead, at the moment it arrives:

```json
{
  "agent_id": "<OMNI_AGENT_ID>",
  "to_number": "+919876543210",
  "webhook_url": "https://your-host/webhooks/omnidimension",
  "call_context": {
    "customer_name": "Asha R",
    "offer_summary": "A booked slot with a specialist and a written scope",
    "deliverable": "One phone call today that ends with either a written fixed quote or an honest 'not a fit'.",
    "opener": "Hi, this is the callback you requested about ...",
    "qualifying_questions": ["What is happening right now, and since when?", "..."],
    "approved_answers": { "How much does it cost?": "..." },
    "objection_handling": { "Too expensive": "..." },
    "conversion_ask": "Shall I lock in the callback slot and send you the fixed quote in writing?",
    "opt_out_line": "If you would rather not hear from us again, say the word ...",

    "lead_id": "lead_3b381ee946c147f8",
    "run_id": "run_5c65e9d8a46f4971",
    "campaign_id": "...", "adset_id": "...", "ad_id": "...", "creative_id": "..."
  }
}
```

Sent with `Authorization: Bearer <OMNI_API_KEY>` and an **`Idempotency-Key`** of
`call:<lead_id>`.

Two things in there are load-bearing:

**The identifiers must survive the round trip.** `lead_id` especially — it is how the outcome finds
its way back to the ad that paid for it. If OmniDimension cannot echo arbitrary metadata onto the
post-call webhook, say so and configure the agent to include `lead_id` in the payload some other
way; without it every outcome is dropped as `payload carried no lead_id`.

**The idempotency key must be honoured.** The dispatch retries on a 429, a 5xx or a dropped
connection. That is only safe if a replayed dispatch is treated as *the same call* rather than a
second one to the same person. **Confirm this before going live.** If the platform ignores the
header, set `retry: { attempts: 1 }` where the provider is constructed in
[`src/orchestrator.ts`](../src/orchestrator.ts) and accept lost calls over duplicate ones — calling a
stranger twice in a minute is worse than not calling them.

---

## 4. Adapt the dispatch call

This is the part most likely to be wrong, so there is a command that finds out for you instead of
making you read two things side by side:

```bash
node src/cli.ts contract-test                 # dry run - nothing leaves the machine
```

It prints the exact request this repo would send — paste that into the provider's API console to
compare shapes — and checks the configuration that breaks the loop *later* rather than now: an unset
webhook secret means every call outcome 401s, and a `localhost` callback means none of them arrive at
all.

When you are ready to send one, with your own number:

```bash
node src/cli.ts contract-test --live --to +919876543210 --yes --idempotency
```

Three explicit signals, because success is a real phone ringing. Each check names the file to change
when it fails:

```
  PASS  endpoint       the path exists and the key was accepted
  FAIL  request shape  422 - the body was rejected: {"error":"to_number is required"}
        fix: the body object literal in src/voice/omnidimension.ts -> dispatchCall
```

`--idempotency` sends the same dispatch twice and compares the returned call ids. That is the check
worth running before any real traffic: [§3](#3-what-we-send-on-dispatch) explains why the retry logic
is only safe if the key is honoured, and this is how you find out rather than assume.

Everything the probe reports maps to one of these five places — all in one method, `dispatchCall` in
[`src/voice/omnidimension.ts`](../src/voice/omnidimension.ts):

| If their API differs in… | Change |
|---|---|
| the path | `` `${this.#baseUrl}/calls/dispatch` `` |
| the base URL | `OMNI_BASE_URL` in `.env` — no code change |
| auth style | the `Authorization` header in the same method |
| body field names | the `body` object literal |
| the response's id field | `parsed.requestId ?? parsed.call_id ?? parsed.id` |

Nothing else in the repo reaches the voice platform, so an API that looks nothing like this costs you
one method, not a refactor. A 200 that carries no call id is treated as a contract mismatch and
thrown rather than retried — you want to hear about that immediately.

---

## 5. The post-call webhook

**This is the contract that matters.** Configure the agent's post-call action to POST JSON to
`https://your-host/webhooks/omnidimension`:

| Field | Type | What it must mean |
|---|---|---|
| `lead_id` | string | **required** — from the call context; also read from `metadata.lead_id` |
| `call_id` | string | the provider's call id; used for idempotency |
| `connected` | boolean | a human actually answered — not ringing, not voicemail |
| `qualified` | boolean | met the brief's criteria |
| `intent_score` | 0–100 | clamped |
| `objection` | string \| null | the main objection heard |
| `appointment_booked` | boolean | a slot was agreed |
| `sale_status` | `won` \| `pending` \| `lost` \| `none` | `closed`/`sold` and `booked` are normalized |
| `expected_value` | number | **major units** (₹5000, not 500000) |
| `next_action` | string | free text |
| `summary` | string | one or two lines |
| `opt_out` | boolean | they asked not to be called again |

Three of these carry real consequences, so get them right:

- **`sale_status: "won"` is the only thing that moves revenue.** An `expected_value` on a `pending`
  appointment is a forecast and is deliberately ignored — forecasts must not move ROAS, or the
  decision engine will scale on optimism. Confirmed money arrives later via `POST /revenue`.
- **`opt_out: true` suppresses the number permanently and immediately.** Have the agent set it
  whenever the person expresses that, however they phrase it. Over-reporting it costs one lead;
  under-reporting it means calling someone who told you to stop.
- **`connected` must mean a human answered.** If voicemail counts as connected, the
  `low_connect_rate` signal stops working and the engine will diagnose a creative problem that is
  really a dialling problem.

### Authenticating it

This endpoint records revenue and suppresses phone numbers, so it fails closed. Two options:

1. **Preferred — HMAC.** Set `OMNI_WEBHOOK_SECRET` and have the platform send
   `X-Omni-Signature: sha256=<hex hmac of the raw body>`.
2. **Fallback — static token.** If the platform can only attach a fixed header, set
   `OMNI_WEBHOOK_TOKEN` and have it send `Authorization: Bearer <token>` or `X-Webhook-Token`.

The fallback is genuinely weaker — it proves the sender knows a secret, but says nothing about
whether the body was tampered with, and anyone who captures it can replay it. Use the HMAC if the
platform supports it at all. With neither configured, every post-call webhook is rejected with a 401
and the loop silently produces no outcomes.

---

## 6. Test before any real number is dialled

```bash
FL_MODE=live FL_ADMIN_TOKEN=devtoken node src/cli.ts serve
```

**Dispatch, with your own phone number:**

```bash
curl -X POST localhost:8787/leads -H 'x-fl-admin-token: devtoken' \
  -H 'content-type: application/json' \
  -d '{"name":"Your Name","phone":"<your number>","consent":true,
       "consentSource":"manual_test","adId":"<an adId from publish>"}'
```

You should get `"dispatch": { "status": "dispatched", "callRef": "..." }` and then a phone call.
A `deferred` means you are outside `callWindow`; `suppressed` means the number is on the list.

**The outcome, without waiting for a real call** — replay what the agent would send:

```bash
BODY='{"lead_id":"<leadId>","call_id":"t1","connected":true,"qualified":true,
       "appointment_booked":true,"sale_status":"won","expected_value":5000}'
SIG="sha256=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$OMNI_WEBHOOK_SECRET" -r | cut -d' ' -f1)"
curl -X POST localhost:8787/webhooks/omnidimension \
  -H "x-omni-signature: $SIG" -H 'content-type: application/json' -d "$BODY"
```

Then confirm the loop closed:

```bash
node src/cli.ts economics    # sales 1, revenue INR 5000.00
node src/cli.ts review       # the outcome attributed to that creative
```

That is the playbook's success condition: one lead travelling end to end, with the system able to
name the exact ad that produced the sale.

---

## Troubleshooting

| Symptom | Cause |
|---|---|
| `401 bad signature or token` | Neither `OMNI_WEBHOOK_SECRET` nor `OMNI_WEBHOOK_TOKEN` set, or the HMAC is over a re-serialized body rather than the raw bytes |
| `payload carried no lead_id` | The call context did not survive the round trip — see §3 |
| `unknown lead <id>` | The outcome arrived for a lead this instance has never seen (wrong database, or a test payload) |
| `dispatch response carried no call id` | Their response field is not `requestId`/`call_id`/`id` — see §4 |
| Calls placed twice | The idempotency key is not being honoured; drop `attempts` to 1 |
| Revenue stays zero despite sales | `sale_status` is `pending`, not `won` — by design |
| `deferred` on every dispatch | Outside `callWindow`, or `maxCallsPerDay` is reached |
| Everything connects, nothing qualifies | Usually real. `poor_qualification` means targeting or offer, not the agent |

---

## The honest caveat

No part of this has run against a live OmniDimension account. The post-call contract is ours and is
covered by tests; the dispatch shape is an educated guess at someone else's API and is the single
least-verified thing in this repo. Budget an hour to reconcile it with their docs, and make your
first call to your own phone.

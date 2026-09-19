# Meta instant form setup

The one piece this repo cannot build for you, because it lives on your Page. This is the wiring
between "a person taps your ad" and "the voice agent dials them ninety seconds later".

Budget about an hour, most of it waiting on app review if you do not already have a Business app
with the right permissions.

> **On the UI instructions below.** Meta moves menus around constantly, so treat every click path as
> a hint and the field names, permissions and payload shapes as the real contract. If a menu has
> moved, search the Business Suite for the noun ("Instant Forms", "Lead Access") rather than
> following the path literally. Everything in `code font` is stable and is what this repo actually
> depends on.

---

## 1. What you need before you start

| Thing | Why | Where |
|---|---|---|
| A Facebook **Page** | Instant forms belong to a Page, not to an ad account | — |
| A **Business app** in Meta for Developers | Issues the tokens | developers.facebook.com |
| An **ad account** with a payment method | Nothing publishes without one | Business Settings |
| A **public HTTPS URL** | Meta will not call a webhook over plain HTTP or localhost | ngrok / Cloudflare Tunnel / your host |

Permissions the app needs. The first three are the usual suspects; the fourth is the one people
forget, and it is the one that turns a webhook into an actual lead:

- `ads_management` — create campaigns, ad sets, ads, creatives
- `pages_show_list` — see the Page
- `pages_manage_ads` — run ads on behalf of the Page
- **`leads_retrieval`** — read the answers a person typed into the form

Use a **Page access token** (ideally long-lived or a System User token), not a plain user token. A
user token expires and takes your lead flow down with it at an inconvenient moment.

---

## 2. Create the form

In Meta Business Suite: **All tools → Instant Forms** (historically Page → Publishing Tools → Forms
Library) → **Create form**.

### Form type

Choose **More volume** unless you have a reason not to. "Higher intent" adds a review step that
suppresses volume — worth testing later, but it confounds a first test, and this system is already
measuring lead quality properly further down the funnel via the voice agent.

### Questions — exactly these

This repo reads three fields, and it matches them by the names Meta assigns to its **prebuilt**
questions. Use the prebuilt ones, not custom questions with similar labels:

| Add this prebuilt question | Meta's field name | Required? |
|---|---|---|
| Full name | `full_name` | **yes** — a lead with no name is rejected at intake |
| Phone number | `phone_number` | **yes** — no phone, no call, no funnel |
| Email | `email` | optional, stored if present |

The mapping lives in [`fromMetaLeadgen`](../src/pipeline/intake.ts) and tolerates `name` and `phone`
as fallbacks. It does **not** guess at anything else — a custom question called "Your mobile" will be
ignored and the lead rejected for having no phone number.

Keep the form to these three. Every extra field costs completion rate, and this funnel qualifies on
the call, which is the entire point of pairing ads with a voice agent.

### Intro and privacy — say you will call

This is not a formality. The voice agent phones people within minutes, and the system refuses to
dial a lead with no recorded consent source ([`intake.ts`](../src/pipeline/intake.ts)). The form is
that consent event, so the form has to actually say what will happen.

`brief` writes suitable copy for you — it is the `leadFormCopy` field on the brief, and it reads
roughly:

> Tell us what is happening with *[the niche]*. An assistant calls you back — usually within 10
> minutes during working hours — to confirm the scope and give you a fixed quote. You can opt out on
> the call at any time.

Paste that into the form's intro. Make sure the result states, in the person's own language:

- **who** is calling (your business by name)
- **that it is a phone call**, and roughly when
- **that an AI assistant** makes the first call — the approved call script already discloses this,
  and the form should not contradict it
- **how to opt out** — the script offers it on every call and honours it permanently

You must also link a real **privacy policy URL**. Meta requires it and will not let you publish
without one.

### Completion screen

Set the call to action to something that matches the promise — "We'll call you shortly" — rather
than a website visit. A lead who expects a call answers the phone.

Then **publish** the form. A published form cannot be edited, only duplicated, so read it once more
before you commit.

---

## 3. Get the form id

Open the form in the Forms Library and read the id from the URL, or ask the API:

```bash
curl -G "https://graph.facebook.com/v21.0/<PAGE_ID>/leadgen_forms" \
  -d "fields=id,name,status" \
  -d "access_token=<PAGE_ACCESS_TOKEN>"
```

That id is what you hand to `publish`:

```bash
node src/cli.ts publish --lead-form <FORM_ID> --budget 200 --days 5
```

It becomes the creative's call-to-action — `{ type: 'SIGN_UP', value: { lead_gen_form_id } }` in
[`meta/api.ts`](../src/meta/api.ts). Publish **without** `--activate` the first time and look at the
result in Ads Manager before anything spends.

---

## 4. Grant lead access

Leads are visible to the Page, and your app needs to be told it may read them. In **Business
Settings → Integrations → Lead Access**, grant your app (or System User) access to the Page's leads.

This is the most common silent failure: the webhook arrives, the fetch for the answers returns a
permissions error, and the lead is rejected with nothing obviously wrong at the Meta end. This repo
audits that case as `lead.retrieval_failed` so at least you can see it.

---

## 5. Subscribe the webhook

Expose the server at a public HTTPS URL:

```bash
FL_MODE=live FL_ADMIN_TOKEN=... node src/cli.ts serve
```

In your app's **Webhooks** product, subscribe the **Page** object to the **`leadgen`** field, with:

- **Callback URL** — `https://your-host/webhooks/meta`
- **Verify token** — whatever you set as `META_WEBHOOK_VERIFY_TOKEN`

Meta immediately issues a `GET` with `hub.mode=subscribe`, `hub.verify_token` and `hub.challenge`.
The server answers it only if the token matches, and echoes the challenge back
([`http.ts`](../src/server/http.ts)).

Then subscribe the Page itself to the app:

```bash
curl -X POST "https://graph.facebook.com/v21.0/<PAGE_ID>/subscribed_apps" \
  -d "subscribed_fields=leadgen" \
  -d "access_token=<PAGE_ACCESS_TOKEN>"
```

Set `META_APP_SECRET` too. Every inbound payload is verified against an `X-Hub-Signature-256` HMAC
and an unset secret **fails closed** — an unsigned request that reached this endpoint could place
phone calls, so it is rejected rather than trusted.

---

## 6. What Meta actually sends

Worth understanding, because it catches people out:

```json
{
  "object": "page",
  "entry": [{
    "id": "<page_id>",
    "changes": [{
      "field": "leadgen",
      "value": {
        "leadgen_id": "<lead_id>",
        "form_id": "<form_id>",
        "page_id": "<page_id>",
        "ad_id": "<ad_id>",
        "adgroup_id": "<adset_id>",
        "created_time": 1736500000
      }
    }]
  }]
}
```

**There are no answers in it.** No name, no phone. You get a `leadgen_id` and the ad identifiers, and
the field data is a second authenticated call:

```bash
curl -G "https://graph.facebook.com/v21.0/<LEADGEN_ID>" \
  -d "fields=id,created_time,field_data,ad_id,adset_id,campaign_id,form_id" \
  -d "access_token=<PAGE_ACCESS_TOKEN>"
```

The server does this for you. It is also a security property worth keeping: the lead's details come
from Meta over an authenticated call, so a forged webhook cannot inject a fabricated person into your
dialler even if it somehow passed signature checking.

Payloads that carry `field_data` inline are still accepted, because the Lead Ads Testing Tool sends
them that way.

---

## 7. Test it before you spend

Start with preflight. Every call it makes is a GET, so it creates nothing and spends nothing:

```bash
node src/cli.ts preflight --lead-form <formId>
```

It checks the things that are otherwise discovered at the worst moment — a token that expires next
week, a missing `leads_retrieval` scope (without it you find out when your first real lead arrives
and its answers cannot be fetched), a form with no phone question, and an ad account that bills in a
different currency from the one `config/guardrails.json` is written in. That last one matters more
than it sounds: budgets are sent as an integer of the account's minor units while every cap is
checked in the guardrails' currency, so an INR control layer against a USD account turns a ₹1,000/day
cap into a $1,000/day campaign. `publish` refuses on a mismatch — preflight tells you first, and names
the line to change.

Then use Meta's **Lead Ads Testing Tool** (developers.facebook.com/tools/lead-ads-testing). Pick your
Page and form, submit a test lead, and watch:

```
  accepted  lead_3b381ee946c147f8  +91******3210  dispatched
```

Test leads carry no real personal data and do not incur ad spend. Check, in order:

1. **The webhook arrived** — anything else means the subscription or the callback URL is wrong.
2. **The lead was accepted, not rejected.** A rejection names its reason: a missing phone means your
   form's question is not the prebuilt `phone_number`; `could not retrieve lead` means step 4.
3. **`ad_id` survived.** Attribution is the whole point — without it a sale cannot be traced to the
   creative that paid for it.
4. **In live mode, a real call is placed.** Use your own number for the first one.

Then delete the test leads from the form when you are done.

---

## Troubleshooting

| Symptom | Cause |
|---|---|
| Webhook verification fails | `META_WEBHOOK_VERIFY_TOKEN` does not match what you typed into the app |
| `401 bad signature` | `META_APP_SECRET` is wrong or unset — it fails closed on purpose |
| `could not retrieve lead <id>` | Lead Access not granted (step 4), or the token lacks `leads_retrieval` |
| `unusable phone` at intake | The form used a custom question instead of the prebuilt `phone_number`, or the number has no country code and `defaultCountryCode` does not fit it |
| `no explicit consent recorded` | The payload reached `POST /leads` by hand without `consentSource` — leadgen webhooks set it automatically |
| Leads arrive but no call | Outside `callWindow`, number on the suppression list, or past `maxCallsPerDay` — all audited |
| Nothing arrives at all | The ad is still `PAUSED`, still in review, or the Page is not subscribed to the app |

---

## The honest caveat

Every Meta interaction in this repo has been exercised against a mock, not a live ad account —
including the lead retrieval described above. The payload shapes and permissions here reflect Meta's
documented behaviour, and the webhook handling is covered by tests
([`tests/leadgen.test.ts`](../tests/leadgen.test.ts)), but expect to adjust a field name on first
contact. Publishing `PAUSED` and using the testing tool costs nothing and is how you find out
cheaply.

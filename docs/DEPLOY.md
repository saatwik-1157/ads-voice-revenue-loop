# Deploying behind a DigitalPlat FreeDomain hostname

## What FreeDomain gives you, and what it does not

[DigitalPlat FreeDomain](https://github.com/DigitalPlatDev/FreeDomain) registers a free domain —
`.dpdns.org`, `.us.kg`, `.qzz.io`, `.xx.kg`, `.qd.je` — and lets you point it wherever you like with
DNS records or custom nameservers.

It is a **registrar, not a host.** Their README says free hosting is something they "might introduce
in the future". So this gives you the one thing the system genuinely cannot work without — a public
hostname with a real certificate — and you still need a machine to run on.

That hostname is not cosmetic. Meta will not deliver leadgen webhooks to plain HTTP, OmniDimension
posts call outcomes to a URL you register with it, and `contract-test` already refuses a
`PUBLIC_BASE_URL` that is not `https://` because a provider cannot reach `localhost`. Until there is
a public HTTPS URL, the live loop cannot close: leads never arrive and revenue is never recorded.

## Three routes, pick one

| Route | Needs | Hostname | Good for |
|---|---|---|---|
| **[Quick tunnel](#the-quick-tunnel-no-account-no-domain-about-five-seconds)** | Nothing. No account, no domain, no server. | Random, changes on restart | Proving the loop over the real internet. `contract-test --live`, a first real webhook. |
| **[Named tunnel](#the-named-tunnel-your-own-hostname-stays-put)** | A free domain, a free Cloudflare account, a machine that stays on | Yours, stable | Running it without paying for a server |
| **[VPS](#1-register-the-domain-you-do-this-not-the-system)** | A free domain, a small VPS (~€4/mo) | Yours, stable | Where this belongs once real money is moving |

Start at the top and move down. The quick tunnel takes about five seconds and closes the biggest
unknown in the project — whether a provider can actually reach your webhook endpoint.

Everything below is the VPS route. The tunnel routes are [further down](#no-server-a-tunnel-instead)
and share the same image, `.env` and `verify.sh`.

### For the VPS route specifically

| | |
|---|---|
| A domain | Free, from FreeDomain. You register it — see below. |
| A server with a public IP | Any small VPS. Docker and Docker Compose installed. 1 GB RAM is plenty. |
| Ports 80 and 443 open | 443 serves traffic; **80 is required** for the certificate challenge. |
| A `.env` file | Yours, on the server. Never committed, never baked into the image. |

---

## 1. Register the domain: you do this, not the system

Go to the [FreeDomain dashboard](https://domain.digitalplat.org/), sign in, and register the name you
want. It involves creating an account and submitting a form under your identity, so it is yours to do
rather than something to automate.

Pick something unremarkable. The hostname ends up in Meta's webhook configuration and in your
OmniDimension agent settings, and a name that looks like a throwaway is a name a reviewer squints at.

## 2. Point it at your server

In the FreeDomain DNS panel, add an **A record** for the apex pointing at your server's public IPv4
address. If you prefer to manage DNS elsewhere, set custom nameservers to that provider instead and
create the A record there.

```
Type  Name  Value
A     @     203.0.113.10       # your server's IP
```

If you route through Cloudflare, set the record to **DNS-only (grey cloud) for the first
certificate**. Proxying intercepts the HTTP-01 challenge, and the usual symptom is Caddy retrying
forever while the site serves a Cloudflare error page. Turn proxying back on afterwards if you want
it.

Check it resolves before going further — a certificate request against a name that does not point at
you yet will fail and count against Let's Encrypt's rate limits:

```bash
dig +short yourname.dpdns.org
```

## 3. Provision, in one command

On the server:

```bash
git clone <your remote> founder-labs-autopilot
cd founder-labs-autopilot
sudo ./deploy/provision.sh yourname.dpdns.org
```

It installs Docker if it is missing, generates `.env` with random admin and viewer tokens at mode
600, opens 80 and 443 in `ufw` if that is what you use, warns you if the domain does not point at
this host, and brings the stack up. It is idempotent, and it **will not overwrite an existing
`.env`** — that file holds your tokens and clobbering it is how you lock yourself out.

Provider credentials are left blank on purpose. They are yours to paste in. The rest of this section
is what that script is doing, if you would rather do it by hand.

<details>
<summary>By hand</summary>

### Get the code and the secrets onto the server

```bash
git clone <your remote> founder-labs-autopilot
cd founder-labs-autopilot
cp .env.example .env
```

Fill in `.env`. The deployment-specific lines:

```bash
DOMAIN=yourname.dpdns.org      # compose reads this file for interpolation too
FL_MODE=mock                   # keep mock until you have deliberately gone live
FL_ADMIN_TOKEN=                # generate below - unset closes the write routes
FL_VIEWER_TOKEN=               # unset closes the read routes
```

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

`PUBLIC_BASE_URL` is set for you — compose derives `https://$DOMAIN` and overrides whatever the file
says, because inside the container that is the only correct value.

**Set both tokens before the first start.** An unset token authenticates nobody, so the routes stay
closed rather than falling open — but closed routes on a public host still mean the webhooks are the
only thing reachable, and you will not be able to read your own runs.

```bash
docker compose up -d --build
```

</details>

## 4. Watch the certificate get issued

```bash
docker compose logs -f caddy
```

Caddy requests and renews it on its own. There is no key to install and no cron job. This is the step
that fails most often, and almost always for one of two reasons: port 80 is closed, or a proxy
intercepted the challenge.

## 5. Check it from outside

**From your laptop, not from the server.** A green container proves the process started. It proves
nothing about DNS, the certificate, the firewall, or whether Meta can reach the webhook route.

```bash
FL_VIEWER_TOKEN=<from .env> ./deploy/verify.sh yourname.dpdns.org
```

It checks DNS, the certificate and its expiry, liveness and readiness, that `/runs`, `/runs/:id`,
`/leads` and `/revenue` all refuse anonymous callers, that a wrong token gets nothing, that both
webhook routes are **reachable and refusing unsigned deliveries** — reachable matters as much as
refusing, since Meta has to get through — and that plain HTTP redirects. Exit code 0 means all of it
passed.

To smoke-test the app on the server before DNS or the certificate are ready:

```bash
FL_VERIFY_BASE=http://127.0.0.1:8787 ./deploy/verify.sh yourname.dpdns.org
```

That skips DNS and TLS and says so loudly. It is not a substitute for the real check.

## 6. Point the providers at it

Only once the checks above pass:

```
Meta leadgen webhook    https://yourname.dpdns.org/webhooks/meta
Voice result webhook    https://yourname.dpdns.org/webhooks/omnidimension
```

Then the live sequence from the README's **Going live** section — `preflight`, `preflight
--lead-form`, `contract-test --live`, a paused publish inspected in Ads Manager — with `FL_MODE=live`
only at the end.

---

## No server: a tunnel instead

If you do not have a VPS and do not want to pay for one, Cloudflare Tunnel gives you the same public
HTTPS URL from a machine you already own — no public IP, no port forwarding, no certificate to
manage. There are two versions of this, and the difference is whether the hostname stays still.

### The quick tunnel: no account, no domain, about five seconds

```bash
docker compose up -d app                                    # or the container you already have
docker run --rm --network container:<app-container> \
  cloudflare/cloudflared:latest tunnel --url http://localhost:8787
```

It prints a `https://something-random.trycloudflare.com` URL. No signup, no token, no card, and a
real certificate — this project's own verification run against one came back with a Google Trust
Services certificate and every route behaving.

**What it is for:** proving the loop works over the real internet. `contract-test --live`, and a
first genuine post-call webhook from OmniDimension — which is the least-verified integration in the
project and the hardest thing to test any other way.

**What it is not for:** anything you leave running. Cloudflare's own startup banner says these
account-less tunnels have **no uptime guarantee**. The hostname is also ephemeral: restart
`cloudflared` and it changes, so every restart means re-registering the webhook URL with Meta. A lead
that arrives at the old hostname is a person who filled in your form and never got a call.

Take it down with `docker rm -f <tunnel-container>`. While it is up, your machine is serving the
public internet — only `/health` and the two signature-checked webhook routes are reachable without a
token, but it is real exposure, so be deliberate about it.

### The named tunnel: your own hostname, stays put

FreeDomain supports this directly: its "bring your own DNS" is exactly the custom-nameserver
delegation Cloudflare needs.

1. Create a free Cloudflare account and add your FreeDomain hostname as a zone.
2. Set the nameservers Cloudflare gives you as your domain's custom nameservers in the FreeDomain
   dashboard.
3. In **Zero Trust → Networks → Tunnels**, create a tunnel and copy its token.
4. Add a public hostname on that tunnel: your domain → `http://app:8787`.
5. Put the token in `.env` as `CLOUDFLARE_TUNNEL_TOKEN`, then:

```bash
docker compose -f docker-compose.yml -f docker-compose.tunnel.yml up -d
```

Caddy is switched off in that configuration — Cloudflare terminates TLS, and two things trying to own
the certificate is a bad time.

**When not to use this.** The loop has to be up to receive leads and dispatch calls. A desktop that
sleeps is a desktop that drops them, and a dropped lead is a person who filled in your form and never
got a call. Use the tunnel to get live and prove the loop; move to a VPS before real money is moving.

---

## Operating it

```bash
docker compose logs -f app                    # JSON, one object per line
docker compose exec app node src/cli.ts safety
docker compose exec app node src/cli.ts safety --engage --reason "..." --by "you"
docker compose exec app node src/cli.ts review <run-id>
docker compose pull && docker compose up -d --build   # update
```

**Back up the volume.** It holds every spend and revenue row the decision engine reasons over. Losing
it does not just lose history — it resets the economics the engine decides on.

```bash
docker run --rm -v founder-labs-autopilot_autopilot-data:/data -v "$PWD:/backup" \
  node:24-slim tar czf /backup/autopilot-$(date +%F).tar.gz -C /data .
```

## Notes on the setup

- **The app is not published to the host.** Only Caddy binds 80 and 443; the app is reachable only on
  the compose network. A wrong firewall rule cannot expose the admin routes over plain HTTP.
- **The container runs as `node`, uid 1000**, and can write `/app/data` and nothing else.
- **No secrets in the image.** `.dockerignore` excludes `.env`; secrets arrive as environment at run
  time. A token baked into a layer is in that layer forever.
- **`HEALTHCHECK` hits `/health/ready`**, so a container with an unwritable volume reports unhealthy
  rather than sitting there accepting traffic it cannot serve.
- **SQLite means one instance.** Two app containers against one volume will corrupt it. The
  repository abstraction and PostgreSQL are Tier 3 in
  [`PROJECT_AUDIT.md`](PROJECT_AUDIT.md); until then, scale up, not out.
- **Rate limiting is in-process**, so it is correct for exactly this one-instance topology and wrong
  behind a load balancer.

## What was tested, and what was not

**Tested** on this machine, with the output checked rather than the exit code assumed:

- `docker build` succeeds; the image runs.
- The container reports `(healthy)` — the `HEALTHCHECK` against `/health/ready` passes.
- It runs as `uid=1000(node)`, not root.
- `GET /runs` anonymous → 401, with a viewer token → 200, `POST /revenue` with a viewer token → 401.
- Structured JSON logs reach `docker logs`.
- `docker compose config` resolves, and refuses to start with a clear message when `DOMAIN` is unset.
- `deploy/verify.sh` against the running container: **11 passed, 0 failed**, exit 0. Its
  no-connection path was exercised too, and reports "nothing is answering on 443" rather than
  claiming a route is exposed.
- `deploy/provision.sh` parses (`bash -n`). Its Docker install, `ufw` and DNS branches have **not**
  been run — this machine is Windows and has no `ufw`.
- **The data volume survives the container.** The container was destroyed and a new one started on
  the same named volume; a run with 105 leads and INR 6,000.12 of spend came back intact. This was a
  claim in this document before it was a tested one.
- **The safety loop engages on its own in the container.** Left running with `--schedule`, the fast
  loop passed the test budget, wrote `emergency_stop.engaged` at `error` level, and a cycle run
  immediately afterwards returned `[skipped] emergency stop engaged`. Engaged `by safety-loop`, with
  no human involved. Readiness deliberately stayed 200 and the webhook routes stayed reachable.

**Tested over the public internet**, through a Cloudflare quick tunnel, with `verify.sh` run from a
container rather than from the host so the traffic genuinely left and came back:

- **13 passed, 0 failed.** DNS resolved, TLS presented a real certificate (Google Trust Services,
  valid to Nov 5 2026).
- **Both webhook routes reachable from outside and refusing unsigned deliveries.** This is the one
  that matters: Meta can get through, a forged POST cannot.
- Every read and write route — `/runs`, `/runs/:id`, `/leads`, `/revenue` — refused anonymous callers
  over the open internet. A viewer token read; it could not write.

**Still not tested:**

- **Certificate issuance by Caddy.** The certificate above came from Cloudflare, not from the Caddy
  path in `docker-compose.yml`. Let's Encrypt has still never seen a hostname from this repository,
  so step 4 remains the unproven step of the VPS route.
- **`provision.sh` end to end** on a real Debian or Ubuntu host.
- **A real webhook delivery from Meta or OmniDimension.** Reachability is now proven; the payload
  handling is not. Those integrations remain unverified against live providers, exactly as
  [`FINAL_STATUS.md`](FINAL_STATUS.md) says. A quick tunnel is the cheapest way to close this — it
  gives you a URL a provider can actually call without a domain or a server.

Do not treat a green local container as evidence that the deployment works. The first honest check is
step 5, run from somewhere other than the server.

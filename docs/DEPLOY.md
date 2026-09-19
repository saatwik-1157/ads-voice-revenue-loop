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

## What you need

| | |
|---|---|
| A domain | Free, from FreeDomain. You register it — see below. |
| A server with a public IP | Any small VPS. Docker and Docker Compose installed. 1 GB RAM is plenty. |
| Ports 80 and 443 open | 443 serves traffic; **80 is required** for the certificate challenge. |
| A `.env` file | Yours, on the server. Never committed, never baked into the image. |

---

## 1. Register the domain — you do this, not the system

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

## 3. Get the code and the secrets onto the server

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

## 4. Start it

```bash
docker compose up -d --build
docker compose logs -f caddy      # watch the certificate get issued
```

Caddy requests and renews the certificate on its own. There is no key to install and no cron job.

## 5. Check it from outside

From your laptop, not from the server:

```bash
curl -s https://yourname.dpdns.org/health
curl -s https://yourname.dpdns.org/health/ready | jq
curl -s -o /dev/null -w "%{http_code}\n" https://yourname.dpdns.org/runs                    # 401
curl -s -o /dev/null -w "%{http_code}\n" -H "x-fl-token: $FL_VIEWER_TOKEN" \
     https://yourname.dpdns.org/runs                                                        # 200
```

`/health/ready` returning `ready: true` means the database is readable inside the volume and webhook
deliveries are not failing. A 503 there is real — it queries rather than answering 200 on principle.

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

**Not tested, because it needs a registered domain and a public server:**

- Certificate issuance. The Caddy configuration is conventional, but no certificate has been issued
  from this repository and Let's Encrypt has never seen this hostname.
- Anything reaching the box from outside — DNS, ports 80 and 443, the proxy path end to end.
- A real webhook delivery from Meta or OmniDimension. Those integrations remain unverified against
  live providers, exactly as [`FINAL_STATUS.md`](FINAL_STATUS.md) says.

Do not treat a green local container as evidence that the deployment works. The first honest check is
step 5, run from somewhere other than the server.

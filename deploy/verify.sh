#!/usr/bin/env bash
#
# Check a deployment from outside it.
#
# Run this from your laptop, not from the server. A green container proves the
# process started; it proves nothing about DNS, the certificate, the firewall,
# or whether Meta can actually reach the webhook route. That is what this is
# for, and it is the difference between "it is running" and "it is deployed".
#
#   ./deploy/verify.sh yourname.dpdns.org
#
# Reads FL_VIEWER_TOKEN from the environment if you want the authenticated
# checks too:
#
#   FL_VIEWER_TOKEN=... ./deploy/verify.sh yourname.dpdns.org
#
set -uo pipefail

DOMAIN="${1:-}"
if [[ -z "$DOMAIN" ]]; then
  echo "usage: $0 <domain>    e.g. $0 yourname.dpdns.org" >&2
  exit 2
fi

# Normally https://<domain>. FL_VERIFY_BASE points the same checks somewhere
# else, which is how you test a box before DNS or the certificate is ready -
# e.g. FL_VERIFY_BASE=http://127.0.0.1:8787 on the server itself. It is loudly
# not a substitute for the real thing: it skips DNS and TLS entirely, which are
# the two steps that actually fail.
BASE="${FL_VERIFY_BASE:-https://${DOMAIN}}"
LOCAL=0
[[ "$BASE" != "https://${DOMAIN}" ]] && LOCAL=1

pass=0
fail=0
skip=0

ok()   { printf '  \033[32mPASS\033[0m  %s\n' "$1"; pass=$((pass + 1)); }
no()   { printf '  \033[31mFAIL\033[0m  %s\n' "$1"; fail=$((fail + 1)); }
meh()  { printf '  \033[33mSKIP\033[0m  %s\n' "$1"; skip=$((skip + 1)); }

# HTTP status for a request, or 000 if it never connected.
status() { curl -s -o /dev/null -w '%{http_code}' --max-time 15 "$@"; }

# Resolve a name to an address. `getent` is Linux-only and this is meant to be
# run from a laptop, which is as likely to be macOS or Git Bash on Windows.
resolve() {
  local name="$1" addr=''
  if command -v getent >/dev/null 2>&1; then
    addr="$(getent hosts "$name" 2>/dev/null | awk '{print $1}' | head -1)"
  fi
  if [[ -z "$addr" ]] && command -v dig >/dev/null 2>&1; then
    addr="$(dig +short "$name" A 2>/dev/null | grep -E '^[0-9.]+$' | head -1)"
  fi
  if [[ -z "$addr" ]] && command -v nslookup >/dev/null 2>&1; then
    addr="$(nslookup "$name" 2>/dev/null | awk '/^Address: /{print $2}' | tail -1)"
  fi
  printf '%s' "$addr"
}

printf '\nChecking %s\n\n' "$BASE"

if [[ "$LOCAL" == "1" ]]; then
  printf '  \033[33mNOTE\033[0m  FL_VERIFY_BASE is set, so DNS and TLS are NOT being checked.\n'
  printf '        This is a smoke test of the app, not of the deployment.\n\n'
fi

# --- DNS ------------------------------------------------------------------
if [[ "$LOCAL" == "1" ]]; then
  meh "DNS - skipped, checking ${BASE} directly"
  resolved="skipped"
else
resolved="$(resolve "$DOMAIN")"
if [[ -n "$resolved" ]]; then
  # Worth distrusting: some ISP resolvers answer NXDOMAIN with a search-page
  # address, so a name that does not exist still "resolves". If everything
  # below fails to connect, this line is the one that lied.
  ok "DNS resolves to ${resolved}"
else
  no "DNS does not resolve - nothing below can pass"
  printf '\nAdd an A record for %s and wait for it to propagate.\n\n' "$DOMAIN"
  exit 1
fi
fi

# --- TLS ------------------------------------------------------------------
# Certificate issuance is the step that fails most often, usually because port
# 80 is closed or a proxy intercepted the challenge.
if [[ "$LOCAL" == "1" ]]; then
  meh "TLS - skipped"
elif cert="$(echo | openssl s_client -servername "$DOMAIN" -connect "${DOMAIN}:443" 2>/dev/null \
             | openssl x509 -noout -issuer -enddate 2>/dev/null)" && [[ -n "$cert" ]]; then
  ok "TLS certificate present"
  printf '        %s\n' "$(echo "$cert" | tr '\n' ' ')"
else
  no "No TLS certificate - check 'docker compose logs caddy', and that port 80 is open"
fi

# --- liveness and readiness ----------------------------------------------
code="$(status "${BASE}/health")"
[[ "$code" == "200" ]] && ok "GET /health -> 200" || no "GET /health -> ${code} (expected 200)"

ready_body="$(curl -s --max-time 15 "${BASE}/health/ready")"
ready_code="$(status "${BASE}/health/ready")"
if [[ "$ready_code" == "200" ]]; then
  ok "GET /health/ready -> 200"
elif [[ "$ready_code" == "503" ]]; then
  no "GET /health/ready -> 503, the process is up but not ready:"
  printf '        %s\n' "$ready_body"
else
  no "GET /health/ready -> ${ready_code}"
fi

# --- the routes that must be closed --------------------------------------
# This is the regression worth guarding on a public host: these answered 200
# to anybody before the access work landed.
# Both of these answered 200 to anybody before the access work. /runs/:id is
# checked with an id that does not exist on purpose: authentication has to come
# before the lookup, or a 404 tells an anonymous caller which ids are real.
for route in /runs /runs/probe-does-not-exist; do
  code="$(status "${BASE}${route}")"
  if [[ "$code" == "401" ]]; then
    ok "GET ${route} anonymous -> 401"
  elif [[ "$code" == "404" ]]; then
    meh "GET ${route} -> 404 (route not present in this build)"
  elif [[ "$code" == "000" ]]; then
    # 000 is "never connected", which is a different problem from an open
    # route. Reporting it as exposed sends you looking in the wrong place.
    no "GET ${route} -> no connection (nothing is answering on 443)"
  else
    no "GET ${route} anonymous -> ${code} - EXPECTED 401, this route is exposed"
  fi
done

# The write routes, anonymous. A public host with these open is somebody else
# recording revenue into your decision engine.
for route in /leads /revenue; do
  code="$(status -X POST -H 'content-type: application/json' -d '{}' "${BASE}${route}")"
  if [[ "$code" == "401" ]]; then
    ok "POST ${route} anonymous -> 401"
  elif [[ "$code" == "000" ]]; then
    no "POST ${route} -> no connection"
  else
    no "POST ${route} anonymous -> ${code} - EXPECTED 401, this route is writable"
  fi
done

code="$(status -H 'x-fl-token: definitely-not-the-token' "${BASE}/runs")"
if [[ "$code" == "401" ]]; then
  ok "GET /runs with a wrong token -> 401"
elif [[ "$code" == "000" ]]; then
  meh "GET /runs with a wrong token - no connection, cannot tell"
else
  no "GET /runs with a wrong token -> ${code} (expected 401)"
fi

# --- the routes that must be open ----------------------------------------
# Meta and OmniDimension authenticate by signature, not by token, so these have
# to be reachable. An unsigned POST must be rejected, but it must be rejected
# by the app rather than never arriving.
code="$(status -X POST -H 'content-type: application/json' -d '{}' "${BASE}/webhooks/meta")"
if [[ "$code" == "401" || "$code" == "403" || "$code" == "400" ]]; then
  ok "POST /webhooks/meta unsigned -> ${code} (reachable, and refusing)"
elif [[ "$code" == "000" ]]; then
  no "POST /webhooks/meta never connected - Meta will not be able to deliver leads"
else
  no "POST /webhooks/meta unsigned -> ${code} - an unsigned delivery must not be accepted"
fi

code="$(status -X POST -H 'content-type: application/json' -d '{}' "${BASE}/webhooks/omnidimension")"
if [[ "$code" == "401" || "$code" == "403" || "$code" == "400" ]]; then
  ok "POST /webhooks/omnidimension unsigned -> ${code} (reachable, and refusing)"
else
  no "POST /webhooks/omnidimension unsigned -> ${code}"
fi

# --- authenticated read ---------------------------------------------------
if [[ -n "${FL_VIEWER_TOKEN:-}" ]]; then
  code="$(status -H "x-fl-token: ${FL_VIEWER_TOKEN}" "${BASE}/runs")"
  [[ "$code" == "200" ]] && ok "GET /runs with the viewer token -> 200" \
                         || no "GET /runs with the viewer token -> ${code} (expected 200)"

  code="$(status -X POST -H "x-fl-token: ${FL_VIEWER_TOKEN}" \
          -H 'content-type: application/json' -d '{}' "${BASE}/revenue")"
  [[ "$code" == "401" ]] && ok "POST /revenue with a viewer token -> 401 (viewer cannot write)" \
                         || no "POST /revenue with a viewer token -> ${code} (expected 401)"
else
  meh "FL_VIEWER_TOKEN not set - skipping the authenticated checks"
fi

# --- no plain HTTP --------------------------------------------------------
if [[ "$LOCAL" == "1" ]]; then
  meh "http:// redirect - skipped"
  code=''
else
  code="$(status "http://${DOMAIN}/runs")"
fi
if [[ "$LOCAL" == "1" ]]; then
  :
elif [[ "$code" == "301" || "$code" == "302" || "$code" == "308" ]]; then
  ok "http:// redirects to https (${code})"
elif [[ "$code" == "200" ]]; then
  no "http://${DOMAIN}/runs -> 200 - this is being served WITHOUT TLS"
else
  meh "http:// -> ${code}"
fi

printf '\n  %d passed, %d failed, %d skipped\n\n' "$pass" "$fail" "$skip"
[[ "$fail" -eq 0 ]] || exit 1

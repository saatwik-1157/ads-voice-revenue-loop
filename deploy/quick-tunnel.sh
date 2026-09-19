#!/usr/bin/env bash
#
# Put a running container behind a public HTTPS URL, with no account and no
# domain. For proving the loop over the real internet - `contract-test --live`,
# a first genuine webhook - not for anything you leave running.
#
#   ./deploy/quick-tunnel.sh [app-container] [port]
#
# Why not `--network container:<app>`: that shares the app's network namespace,
# so destroying or recreating the app tears the namespace out from under the
# tunnel. The tunnel keeps reporting healthy while its log fills with "network
# is unreachable" and Cloudflare serves error pages. A tunnel that looks up
# while dropping every lead is the worst shape this failure could take.
#
# A user-defined network instead: both containers are members, they find each
# other by name, and either can restart without disturbing the other.
#
set -euo pipefail

APP="${1:-fl-live}"
PORT="${2:-8787}"
NET="${FL_TUNNEL_NETWORK:-fl-net}"
TUNNEL="${FL_TUNNEL_NAME:-fl-tunnel}"

if ! docker inspect "$APP" >/dev/null 2>&1; then
  echo "no container named '$APP'. Pass the name: $0 <app-container> [port]" >&2
  exit 1
fi

# A user-defined network, unlike the default bridge, gives containers DNS by
# name. That is what lets the tunnel address the app as http://$APP:$PORT and
# keep working after either side restarts.
if ! docker network inspect "$NET" >/dev/null 2>&1; then
  docker network create "$NET" >/dev/null
  echo "created network $NET"
fi

# Exact name. `grep -qw` treats '-' as a boundary, so a container called
# fl-live-2 already on the network satisfied the test for fl-live, and the real
# one was never connected.
if ! docker network inspect "$NET" --format '{{range .Containers}}{{println .Name}}{{end}}' | grep -qxF "$APP"; then
  docker network connect "$NET" "$APP"
  echo "connected $APP to $NET"
fi

docker rm -f "$TUNNEL" >/dev/null 2>&1 || true
docker run -d --name "$TUNNEL" --network "$NET" cloudflare/cloudflared:latest \
  tunnel --no-autoupdate --url "http://${APP}:${PORT}" >/dev/null

# The URL, not the word. cloudflared logs "Requesting new quick Tunnel on
# trycloudflare.com..." several seconds before it prints the hostname, so
# waiting on the domain name alone returns an empty URL.
URL_RE='https://[a-z0-9]+(-[a-z0-9]+)+\.trycloudflare\.com'
echo -n "waiting for the hostname"
for _ in $(seq 1 60); do
  LOG="$(docker logs "$TUNNEL" 2>&1 || true)"
  URL="$(printf '%s' "$LOG" | grep -oE "$URL_RE" | head -1 || true)"
  [[ -n "$URL" ]] && break
  # A container that has already exited will never print a hostname; waiting the
  # full minute for it only delays the error. (The previous version of this
  # check was an `if ... then : fi` that did nothing at all.)
  if [[ "$(docker inspect -f '{{.State.Running}}' "$TUNNEL" 2>/dev/null)" != "true" ]]; then
    echo
    echo "the tunnel container exited. What it said:" >&2
    printf '%s
' "$LOG" | tail -10 >&2
    exit 1
  fi
  echo -n '.'
  sleep 1
done
echo

if [[ -z "${URL:-}" ]]; then
  echo "no hostname after 60s. What the tunnel says:" >&2
  docker logs "$TUNNEL" 2>&1 | tail -10 >&2
  exit 1
fi

cat <<EOF

  $URL

  This hostname is ephemeral: it changes every time the tunnel restarts, and
  any webhook URL registered with a provider then points at nothing.

  Tell the app its own address, or it will keep advertising localhost:

      docker rm -f $APP && docker run -d --name $APP \\
        -e PUBLIC_BASE_URL=$URL ... (your other flags)

  Check it from outside:

      FL_VIEWER_TOKEN=... ./deploy/verify.sh ${URL#https://}

  Take it down:

      docker rm -f $TUNNEL

EOF

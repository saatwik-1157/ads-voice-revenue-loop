#!/usr/bin/env bash
#
# Take a fresh Debian or Ubuntu host to a running deployment.
#
# Idempotent: safe to re-run. It will not overwrite an existing .env, because
# that file holds the tokens and secrets and clobbering it is how you lock
# yourself out of your own deployment.
#
#   sudo ./deploy/provision.sh yourname.dpdns.org
#
set -euo pipefail

DOMAIN="${1:-}"
if [[ -z "$DOMAIN" ]]; then
  echo "usage: $0 <domain>    e.g. $0 yourname.dpdns.org" >&2
  exit 2
fi

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR"

say() { printf '\n== %s\n' "$*"; }

# --- Docker ---------------------------------------------------------------
if command -v docker >/dev/null 2>&1; then
  say "Docker already installed: $(docker --version)"
else
  say "Installing Docker"
  # The convenience script is the vendor's own and pins to the official repo.
  curl -fsSL https://get.docker.com | sh
fi

if ! docker compose version >/dev/null 2>&1; then
  echo "docker compose plugin is missing. Install docker-compose-plugin and re-run." >&2
  exit 1
fi

# --- .env -----------------------------------------------------------------
if [[ -f .env ]]; then
  say ".env exists - leaving it alone"
  # DOMAIN still has to be right, because compose reads this file for
  # interpolation. Tell rather than rewrite.
  if ! grep -qxF "DOMAIN=${DOMAIN}" .env; then
    echo "   WARNING: .env does not contain DOMAIN=${DOMAIN}"
    echo "   Set it before continuing, or compose will request a certificate for the wrong name."
  fi
else
  say "Creating .env with generated tokens"
  gen() { openssl rand -hex 32; }
  cp .env.example .env
  # Only the values this script can safely decide. Provider credentials are
  # left blank on purpose - they are yours to paste in.
  sed -i "s|^DOMAIN=.*|DOMAIN=${DOMAIN}|" .env
  sed -i "s|^FL_ADMIN_TOKEN=.*|FL_ADMIN_TOKEN=$(gen)|" .env
  sed -i "s|^FL_VIEWER_TOKEN=.*|FL_VIEWER_TOKEN=$(gen)|" .env
  sed -i "s|^FL_MODE=.*|FL_MODE=mock|" .env
  chmod 600 .env
  # Under sudo this file would otherwise be root:root 0600, and every command
  # this script goes on to print - including `docker compose`, which treats
  # env_file as required - fails for the operator who ran it.
  if [[ -n "${SUDO_USER:-}" ]]; then
    chown "$SUDO_USER" .env
    echo "   .env owned by $SUDO_USER, mode 600"
  fi
  echo "   tokens generated, mode left at mock"
fi

# --- firewall -------------------------------------------------------------
# 80 is not optional: the certificate challenge runs over it. A deployment
# that opens only 443 fails at issuance and the symptom looks like a DNS
# problem, which is a bad afternoon.
if command -v ufw >/dev/null 2>&1 && ufw status | grep -q "Status: active"; then
  say "Opening 80 and 443 in ufw"
  ufw allow 80/tcp >/dev/null
  ufw allow 443/tcp >/dev/null
fi

# --- DNS sanity -----------------------------------------------------------
say "Checking that ${DOMAIN} points here"
resolved="$(getent hosts "$DOMAIN" | awk '{print $1}' | head -1 || true)"
public="$(curl -fsS --max-time 10 https://api.ipify.org || true)"
if [[ -z "$resolved" ]]; then
  echo "   ${DOMAIN} does not resolve yet."
  # No apostrophe inside the ${...:-default}: bash treats it as an opening
  # quote and the whole script fails to parse.
  echo "   Add an A record pointing at ${public:-the public IP of this host} and re-run."
  echo "   Continuing anyway - the certificate will fail until it resolves."
elif [[ -n "$public" && "$resolved" != "$public" ]]; then
  echo "   ${DOMAIN} resolves to ${resolved} but this host is ${public}."
  echo "   If that is a Cloudflare proxy address, set the record to DNS-only for"
  echo "   the first certificate: proxying intercepts the HTTP-01 challenge."
else
  echo "   ${DOMAIN} -> ${resolved}"
fi

# --- up -------------------------------------------------------------------
say "Building and starting"
docker compose up -d --build

say "Done"
cat <<EOF

  Watch the certificate get issued:
      docker compose logs -f caddy

  Then verify from somewhere other than this server:
      ./deploy/verify.sh ${DOMAIN}

  Your tokens are in .env (mode 600). Read them with:
      grep FL_.*_TOKEN .env

  Provider credentials in .env are still blank. Fill them in before
  preflight, and leave FL_MODE=mock until you have deliberately gone live.
EOF

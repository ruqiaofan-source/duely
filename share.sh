#!/usr/bin/env bash
# Put Settle on a public HTTPS URL you can paste into WhatsApp.
# Starts the server (if not already running) + a free Cloudflare quick tunnel.
# The URL changes each run and lasts only while this stays open — perfect for
# a live test session, not for permanent hosting (use render.yaml for that).
set -e
cd "$(dirname "$0")"

if ! curl -s -o /dev/null http://localhost:3000/api/config; then
  echo "Starting Settle server on :3000…"
  node server.js &
  sleep 2
fi

echo "Opening public tunnel — share the https://…trycloudflare.com URL it prints below."
exec ./.bin/cloudflared tunnel --url http://localhost:3000 --no-autoupdate

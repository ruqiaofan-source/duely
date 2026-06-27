# Deploying & sharing Settle

## Right now: share a live link in 1 command

A public URL is already running for this session:

> **https://trinity-playlist-admit-fully.trycloudflare.com**

Paste a bet or league link into WhatsApp and it unfurls with the card image, e.g.
`…trycloudflare.com/b/<betId>` or `…trycloudflare.com/l/LADS7`.

⚠️ This is a **Cloudflare quick tunnel** — it lasts only while your laptop is on
and the tunnel process is running, and the URL changes every time. Great for a
test session; not permanent.

To start a fresh public link yourself later:

```bash
cd ~/settle
./share.sh        # starts server + tunnel, prints a https://…trycloudflare.com URL
```

## For keeps: deploy to Render (free)

1. Push `~/settle` to a GitHub repo.
2. [render.com](https://render.com) → **New → Blueprint** → pick the repo.
   `render.yaml` configures everything (Node 22, `node server.js`).
3. You get a stable `https://settle-xxxx.onrender.com` URL.

Caveats on the free tier: the service **sleeps after ~15 min idle** (a few-second
cold start on the next visit), and the disk is **ephemeral** — `data.json` resets
on each deploy. Both are fine for testing. For real persistence, add a Render Disk
or move the JSON store to a database (Postgres/SQLite-on-disk).

Alternatives that use the same `Dockerfile`: **Railway**, **Fly.io**, **Koyeb** —
all give a persistent HTTPS URL and a free/cheap tier.

## Live football results (optional)

Without a key the app runs in demo mode (sample fixtures, manual results).
Add a free key from [football-data.org](https://football-data.org) to pull real
fixtures and auto-resolve finished matches:

```bash
FOOTBALL_DATA_TOKEN=yourkey node server.js
```

On Render, set `FOOTBALL_DATA_TOKEN` as an env var (uncomment it in `render.yaml`).

## ⚠️ Before a *public* launch (not a private test)

Sharing an unlisted link with mates to test the loop is fine. A real public launch
of a real-money bet-settling service likely needs a gambling-intermediary view
(UK Gambling Act 2005 s.13) and an EU DSA review first — see the strategy notes.

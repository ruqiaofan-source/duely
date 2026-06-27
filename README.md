# Settle ⚽ — settle it with a mate (v1 scorekeeper)

The "two friends who know each other" version. **No money is held and no
commission is taken** — Settle records the bet, gives you a link to send on
WhatsApp, resolves the result, and tells you who owes who. Friends sort the
payment between themselves.

This deliberately keeps v1 out of regulated-gambling territory so we can test
the only thing that matters first: *do friends actually reach for this to
settle an argument, and do they send the link?*

## The loop

1. **Create** — you pick the match, what you're backing, and the stake.
2. **Share** — one tap to WhatsApp, or copy the link.
3. **Accept** — your mate opens the link, sees the terms, takes the other side.
4. **Resolve** — at full time the result is reported (auto in live mode).
5. **Settle** — Settle shows "X owes Y €20"; tap *Mark as paid* when done.

## Run it

```bash
cd ~/settle
npm start          # or: node server.js
```

Open http://localhost:3000

To test the whole loop on one machine: create a bet (you're the proposer),
copy the link, open it in a **private/incognito window** (that browser has no
saved role, so it sees the "take the bet" screen), accept, then report a result.

## Demo vs live results

- **Demo mode (default):** ships with sample fixtures; results are reported
  manually by either friend.
- **Live mode:** get a free API key from https://football-data.org and run:

  ```bash
  FOOTBALL_DATA_TOKEN=your_key npm start
  ```

  Real fixtures load in the create screen, and finished matches auto-resolve.

## What's intentionally NOT here (yet)

- No payments / escrow / wallet — that's the regulated step, kept out of v1 on purpose.
- No accounts/login — a device remembers which bets are "yours" via localStorage.
- Single JSON file store (`data.json`) — fine for a prototype, swap for a real DB later.

## Files

| File | What it does |
|------|--------------|
| `server.js` | Zero-dependency Node HTTP server + JSON API + optional live results |
| `public/index.html` | Shell |
| `public/app.js` | The whole front-end state machine (create → share → accept → resolve → settle) |
| `public/styles.css` | Mobile-first styling |
| `data.json` | Auto-created bet store |

# AGENTS.md — rules for any AI agent working on this repo

This is **Clashly** (clashly.live): a free football scorekeeper for friend groups.
It has **real users**. Read this whole file before changing anything.

---

## 1. Hard rules — breaking these breaks the product

**Never rename these internal identifiers.** They look like leftovers from the old
name. They are not. Renaming any of them logs every existing user out permanently,
with no way back:

- `settle_me` — the localStorage key holding player identity
- `x-duely-secret` — the API auth header
- the repo name, and any internal `duely` variable, function or file name

**The user-visible brand is "Clashly", always.** No screen, string, meta tag, share
card, page title or email may show "duely" or "Settle". Internal names stay; visible
text is Clashly.

**Never touch the QA ghost filter** (`QA_GHOST` in server.js). It hides test accounts
from the public leaderboard. Removing it puts fake records in front of real users.

**Be careful with the sweeps** (`ftSweep`, `weeklySweep`, `slateSweep`). They run on a
timer and resolve real people's predictions against a live results API. A bug here
silently marks real users wrong. Do not change their timing or resolution logic
unless that is explicitly the task.

---

## 2. Legal rules — breaking these can get the site blocked

Clashly stays outside gambling regulation **only** because it holds no money, takes no
stake, gives no prize and takes no commission. That is the entire legal position.

**Never add, and refuse if asked:**

- any fee, rake, commission or paid entry
- any prize for winning — including vouchers, merch or credit
- any bookmaker link, logo, odds feed or affiliate code

**Banned words in anything a user can see** — UI copy, buttons, meta descriptions,
page titles, share cards, alt text, Polish translations:

> bet, betting, bets, odds, stake, acca, accumulator, tips, tipster, winnings,
> cash out, multiplier, wager, bankroll, jackpot
>
> Polish: zakłady, zakład, kursy, bukmacher

**Use instead:** call it, prediction, put it on the record, bragging rights,
head to head, rivalry, prove me wrong. Polish: typer, typowanie, rywalizacja.

**Every public page keeps its "no money, no prizes, 18+" line.** Do not remove it to
tidy up a layout.

Never show club crests, kit designs, league logos, player photos from press
agencies, or broadcast footage. Naming clubs and competitions in text is fine.
Player photos in `public/players/` are Wikimedia-licensed and credited on
`/credits.html` — if you add one, add its credit line too.

---

## 3. Always do these

- **Bump the cache-bust query strings** in `public/index.html` whenever you change
  `public/app.js`, `public/i18n.js`, `public/styles.css` or `public/sounds.js`.
  They look like `app.js?v=23`. Increment the number, or users keep running old code.
- **Run the checks before opening a PR:**
  ```bash
  node --check server.js && node --check cards.js && node --check public/app.js
  npm test          # boots its own isolated server, must stay 100% green
  ```
- **Translate new user-facing English into Polish** in `public/i18n.js` (phrase-for-
  phrase map). A missing entry silently falls back to English.
- **Keep the intro/preloader working with `prefers-reduced-motion: reduce`.** Note
  that `animation-duration` does not override `animation-delay` — zero both.

---

## 4. House style

- **Fonts:** Anton (display/headings) and Inter (body). No others.
- **Colours:** background `#0A0E13`, cards `#111823`, teal `#14E0C8` (making calls),
  purple `#7C3AED` (duels between people), gold `#FFC83D` (points and settling up).
- **Tone:** British terrace banter. Punchy, funny, a bit rude about your mates.
  Never corporate.
- **Mobile first.** Designed at 390px wide; check anything new at that width.
- **No build step, no frameworks.** Plain Node and vanilla browser JS, on purpose.
  Do not add React, TypeScript, a bundler, or a new npm dependency without asking
  the repo owner first.

---

## 5. How the code is laid out

| File | What it is |
|---|---|
| `server.js` | The whole backend: one Node `http` server, ~3700 lines, no framework. Also server-renders `/this-week`, `/arcade`, `/daily`, `/hilo`, `/penalty`, `/keepy`. |
| `public/app.js` | The app itself — a vanilla-JS single-page app, ~2100 lines. |
| `public/i18n.js` | English → Polish phrase map. |
| `public/index.html` | Page shell, intro animation, cache-bust version numbers. |
| `public/styles.css` | All styling. |
| `cards.js` | SVG templates for share cards and receipts. |
| `test/api-checks.mjs` | The test suite. Self-contained; run with `npm test`. |

Data lives in a JSON file locally (`data.json`), Postgres in production when
`DATABASE_URL` is set. Secrets are Render environment variables — never commit one.

### Where the content people usually want to change lives

- Terrace bot lines (the house voices): `FIXTURE_TAKES` and the seed `TAKES` list in `server.js`
- Transfer fees for the Higher or Lower game: `HILO_TRANSFERS` in `server.js`
- Players for The Daily: `DAILY_PLAYERS` in `server.js`
- Season-call suggestions: `SEASON_IDEAS` in `public/app.js`
- Polish wording: `public/i18n.js`

---

## 6. How to ship

**Never commit to `main`.** `main` auto-deploys to production on Render in about
three minutes, straight to real users.

Work on a branch and open a pull request. The repo owner reviews and merges. In the
PR description, say in plain English what changed and what you checked.

If a request would break any rule in sections 1 or 2, do not do it. Say which rule
and offer a version that does not break it.

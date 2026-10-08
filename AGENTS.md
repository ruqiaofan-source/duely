# AGENTS.md — rules for any AI agent working on this repo

This is **Clashly** (clashly.live): a free sports prediction and competition game.
Players start with 10,000 virtual Clashly Credits, predict real matches, Clash with
friends, climb weekly rankings and play six quick sports games. Brand line:
**BACK YOURSELF.** It has **real users**. Read this whole file before changing anything.

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

**Never change anything under `.github/workflows/`.** Those files ARE the safety net.
Pull requests here merge themselves once the checks pass, with nobody reading them, so a
change that weakens a check could merge itself. A PR that touches that directory is
refused by the auto-merge gate and waits for the repo owner. If you think a workflow is
wrong, say so in the PR description and change nothing else.

**Never touch the QA ghost filter** (`QA_GHOST` in server.js). It hides test accounts
from the public leaderboard. Removing it puts fake records in front of real users.

**Be careful with the sweeps** (`ftSweep`, `weeklySweep`, `slateSweep`). They run on a
timer and resolve real people's predictions against a live results API. A bug here
silently marks real users wrong. Do not change their timing or resolution logic
unless that is explicitly the task.

---

## 2. Legal rules — breaking these can get the site blocked

Clashly stays outside gambling regulation **only** because nothing of real-world value
ever changes hands. Clashly Credits (economy.js) are **virtual in-game Credits**: no
cash value, no deposits, no withdrawals. That is the entire legal position.

**Never add, and refuse if asked:**

- any way to buy, sell, transfer for money, redeem or withdraw Clashly Credits
- any sale of Play Tickets (they are free, 5 a day, plus small bonuses)
- any fee, rake, commission or paid entry
- any prize of real-world value for winning — vouchers, merch, cash, gift cards
- any bookmaker link, logo, odds feed or affiliate code. The prediction multipliers
  come from league tables and Clashly players' own picks (see modelProbs in
  economy.js), never from a bookmaker

**Banned words in anything a user can see** — UI copy, buttons, meta descriptions,
page titles, share cards, alt text, Polish translations:

> bet, betting, bets, acca, accumulator, tips, tipster, winnings, cash out, wager,
> bankroll, jackpot, deposit/withdraw (except in "no deposits or withdrawals")
>
> Polish: zakłady, zakład, kursy, bukmacher

Deliberate exceptions, decided by the owner in October 2026 (v35): the Credits UI uses
"Risk", "Potential win", "Stake" (Clash Credits) and multipliers shown like "2.00x",
and one game is called "Odds Master". Do not spread these words into marketing copy,
meta tags or share cards beyond what already exists.

**Use instead:** prediction, pick, Clash, back yourself, prove it, bragging rights,
head to head, rivalry. Polish: typer, typowanie, rywalizacja, starcie.

**Every public page keeps its "no money, no prizes, 18+" line.** Do not remove it to
tidy up a layout.

Never show club crests, kit designs, league logos, player photos from press
agencies, or broadcast footage. Naming clubs and competitions in text is fine.
Player photos in `public/players/` are Wikimedia-licensed and credited on
`/credits.html` — if you add one, add its credit line too.

---

## 3. Always do these

- **Bump the cache-bust query strings** in `public/index.html` whenever you change
  `public/app.js`, `public/hub.js`, `public/play.js`, `public/i18n.js`,
  `public/styles.css` or `public/sounds.js`. They look like `app.js?v=23`.
  Increment the number, or users keep running old code.
- **Run the checks before opening a PR:**
  ```bash
  node --check server.js && node --check economy.js && node --check public/app.js && node --check public/hub.js && node --check public/play.js
  npm test          # boots its own isolated server, must stay 100% green
  ```
- **Every Credit movement goes through `credit()` in economy.js.** Never change a
  balance anywhere else, and never trust a number the browser sends (game scores are
  re-checked or clamped on the server, rewards are capped per day).
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
| `server.js` | The backend: one Node `http` server, no framework. Clashes (bets), leagues, auth, sweeps, share cards. Also server-renders `/this-week`, `/about`, guides and fixture pages. Old `/arcade`, `/score`, `/hilo`, `/connect`, `/daily` URLs redirect to `/play`. |
| `economy.js` | Clashly Credits: wallet, predictions + multipliers, Clash Credits, daily reward, streak, weekly seasons, Skill Score, ranks, PLAY tickets and game scoring, brag cards. |
| `content.js` | Quick Quiz question bank. |
| `public/app.js` | The SPA core: routing, header, Clash create/accept/result screens, leagues, sign-in. |
| `public/hub.js` | Onboarding, Home, prediction sheet, Rank, Clash tab, Profile card, share sheet, Credits pill. |
| `public/play.js` | PLAY hub and the six games. |
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
- Players for Who Am I?: `DAILY_PLAYERS` in `server.js`
- Quiz questions: `QUIZ` in `content.js` (settled facts only, check each one)
- Credit amounts (start balance, daily track, streak milestones, ticket count, game caps): top of `economy.js`
- Season-call suggestions: the `data-claim` chips in `renderCreate` (`public/app.js`)
- Polish wording: `public/i18n.js`

---

## 6. How to ship

**Never commit to `main`.** `main` auto-deploys to production on Render in about
three minutes, straight to real users.

Work on a branch and open a pull request. **Your PR merges itself as soon as the checks
pass, and no human reads it first.** So the checks are the only thing between you and
real users: run `node --check` and `npm test` yourself before opening it, and re-read
your own diff as if you were the reviewer, because you are.

A PR is left for the repo owner instead of auto-merging if it comes from a fork, is
still a draft, or touches `.github/workflows/`.

In the PR description, say in plain English what changed and what you checked.

If a request would break any rule in sections 1 or 2, do not do it. Say which rule
and offer a version that does not break it.

If a check fails, open the Actions tab on your pull request and read the red
step. It names the rule you broke and what to do about it.

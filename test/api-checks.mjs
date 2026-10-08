// Duely API check suite — self-contained: boots an ISOLATED server (fresh temp dir,
// no .env → JSON-file store, demo fixtures, no Google) on :3199, runs the battery,
// tears down. Run with:  npm test
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 3199;
const B = `http://localhost:${PORT}`;

let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : fail++; console.log((c ? '  ✓ ' : '  ✗ FAIL: ') + m); };
async function j(p, o = {}, s) {
  const h = { 'Content-Type': 'application/json', ...(o.headers || {}) };
  if (s) h['x-duely-secret'] = s;
  const r = await fetch(B + p, { ...o, headers: h });
  let d = null; try { d = await r.json(); } catch {}
  return { status: r.status, data: d };
}
const mk = (name) => j('/api/players', { method: 'POST', body: JSON.stringify({ name }) }).then((r) => r.data);

// --- isolated boot ---------------------------------------------------------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'duely-test-'));
for (const f of ['server.js', 'cards.js', 'economy.js', 'content.js']) fs.copyFileSync(path.join(ROOT, f), path.join(tmp, f));
for (const l of ['node_modules', 'public', 'fonts', 'challenge.svg', 'result.svg']) fs.symlinkSync(path.join(ROOT, l), path.join(tmp, l));
const env = { ...process.env, PORT: String(PORT), ADMIN_KEY: 'test-admin' };
delete env.DATABASE_URL; delete env.FOOTBALL_DATA_TOKEN; delete env.GOOGLE_CLIENT_ID;
const srv = spawn(process.execPath, ['server.js'], { cwd: tmp, env, stdio: 'ignore' });
const cleanup = () => { try { srv.kill('SIGKILL'); } catch {} try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} };
process.on('exit', cleanup);

for (let i = 0; i < 80; i++) {
  try { const r = await fetch(B + '/healthz'); if (r.ok) break; } catch {}
  await new Promise((r) => setTimeout(r, 250));
}

// --- checks -----------------------------------------------------------------
try {
  let r = await j('/api/config');
  ok(r.status === 200 && r.data.brand === 'Clashly' && r.data.googleClientId === null, 'config: brand + googleClientId=null without env');

  const A = await mk('Ana'), Bp = await mk('Ben');
  ok(A.id && A.secret && Bp.id !== A.id, 'register mints distinct id+secret');
  ok(A.seq >= 1 && Bp.seq === A.seq + 1, 'founder seq increments with join order');

  r = await j('/api/players/me/summary');
  ok(r.status === 401, 'me/* without secret → 401');
  r = await j('/api/players/me/summary', {}, A.secret);
  ok(r.status === 200 && r.data.id === A.id, 'me/summary with secret → own record');
  r = await j('/api/players/Ana/summary');
  ok(r.status === 404, 'old name-keyed route → 404 (no enumeration)');

  r = await j('/api/bets', { method: 'POST', body: JSON.stringify({ home: 'X', away: 'Y', backedOutcome: 'HOME', stake: 20, currency: 'EUR', note: 'easy' }) });
  ok(r.status === 401, 'create bet without secret → 401');
  r = await j('/api/bets', { method: 'POST', body: JSON.stringify({ home: 'X', away: 'Y', backedOutcome: 'HOME', stake: 20, currency: 'EUR', note: 'easy' }) }, A.secret);
  ok(r.status === 201 && r.data.proposerId === A.id, 'create bet → proposerId stamped');
  const b1 = r.data.id;

  r = await j('/api/bets/' + b1 + '/accept', { method: 'POST' }, A.secret);
  ok(r.status === 409, 'self-accept → 409 (id compare)');
  r = await j('/api/bets/' + b1 + '/accept', { method: 'POST' }, Bp.secret);
  ok(r.status === 200 && r.data.opponentId === Bp.id, 'accept stamps opponentId');

  // the terrace: Pundit house-bot + real comments
  ok((r.data.comments || []).filter((c) => c.bot).length >= 2, 'Pundit (labeled bot) commented on create + accept');
  r = await j('/api/bets/' + b1 + '/comment', { method: 'POST', body: JSON.stringify({ text: 'get in!' }) });
  ok(r.status === 401, 'comment without secret → 401');
  r = await j('/api/bets/' + b1 + '/comment', { method: 'POST', body: JSON.stringify({ text: 'get in!' }) }, A.secret);
  ok(r.status === 200 && r.data.comments.some((c) => c.by === 'Ana' && c.text === 'get in!'), 'player comment lands on the terrace');
  r = await j('/api/bets/' + b1 + '/comment', { method: 'POST', body: JSON.stringify({ text: 'x'.repeat(300) }) }, A.secret);
  ok(r.status === 400, 'comment over 280 chars rejected');

  r = await j('/api/bets/' + b1 + '/resolve', { method: 'POST', body: JSON.stringify({ actualOutcome: 'HOME' }) }, Bp.secret);
  ok(r.status === 200 && r.data.pendingResult && r.data.pendingResult.byId === Bp.id, 'report → pendingResult');
  r = await j('/api/bets/' + b1 + '/confirm', { method: 'POST' }, Bp.secret);
  ok(r.status === 403, 'reporter cannot confirm own report');
  r = await j('/api/bets/' + b1 + '/confirm', { method: 'POST' }, A.secret);
  ok(r.status === 200 && r.data.status === 'resolved' && r.data.winner === 'proposer' && r.data.owes.toId === A.id, 'counterparty confirm → resolved, owes by id');

  r = await j('/api/players/me/summary', {}, A.secret);
  ok(r.data.w === 1 && r.data.l === 0, 'ledger: Ana 1-0');
  r = await j('/api/players/me/rivalry?with=' + Bp.id, {}, A.secret);
  ok(r.data.aWins === 1 && Array.isArray(r.data.recent) && r.data.recent.length === 1 && r.data.recent[0].aWon === true, 'rivalry: record + match-by-match recent');

  // both report the same → auto-resolve
  r = await j('/api/bets', { method: 'POST', body: JSON.stringify({ home: 'X', away: 'Y', backedOutcome: 'AWAY', stake: 5, currency: 'EUR' }) }, A.secret);
  const b2 = r.data.id;
  await j('/api/bets/' + b2 + '/accept', { method: 'POST' }, Bp.secret);
  await j('/api/bets/' + b2 + '/resolve', { method: 'POST', body: JSON.stringify({ actualOutcome: 'HOME' }) }, Bp.secret);
  r = await j('/api/bets/' + b2 + '/resolve', { method: 'POST', body: JSON.stringify({ actualOutcome: 'HOME' }) }, A.secret);
  ok(r.data.status === 'resolved' && r.data.winner === 'opponent', 'both report same → resolved without confirm');

  // dispute → void; voided bets never count
  r = await j('/api/bets', { method: 'POST', body: JSON.stringify({ home: 'X', away: 'Y', backedOutcome: 'HOME', stake: 5, currency: 'EUR' }) }, A.secret);
  const b3 = r.data.id;
  await j('/api/bets/' + b3 + '/accept', { method: 'POST' }, Bp.secret);
  await j('/api/bets/' + b3 + '/resolve', { method: 'POST', body: JSON.stringify({ actualOutcome: 'HOME' }) }, Bp.secret);
  r = await j('/api/bets/' + b3 + '/resolve', { method: 'POST', body: JSON.stringify({ actualOutcome: 'AWAY' }) }, A.secret);
  ok(r.data.disputed && r.data.disputed.claims.length === 2 && r.data.status === 'accepted', 'conflicting reports → disputed, no forced result');
  r = await j('/api/bets/' + b3 + '/void', { method: 'POST' }, A.secret);
  ok(r.status === 200 && r.data.status === 'void', 'participant voids disputed bet');
  r = await j('/api/bets/' + b3 + '/void', { method: 'POST' }, A.secret);
  ok(r.status === 409, 're-void → 409');
  r = await j('/api/players/me/summary', {}, A.secret);
  ok(r.data.w === 1 && r.data.l === 1, 'voided bets excluded from the ledger');

  // leagues: auth, membership by id, banter after >=2 games between a pair
  r = await j('/api/leagues', { method: 'POST', body: JSON.stringify({ name: 'T' }) });
  ok(r.status === 401, 'league create without secret → 401');
  r = await j('/api/leagues', { method: 'POST', body: JSON.stringify({ name: 'T' }) }, A.secret);
  const code = r.data.code;
  r = await j('/api/leagues/' + code + '/join', { method: 'POST' }, Bp.secret);
  ok(r.data.members.length === 2 && r.data.standings.length === 2, 'league join + standings');
  r = await j('/api/leagues/' + code);
  ok(r.data.banter && r.data.banter.games === 2, 'league banter: fiercest pair (void excluded)');

  // platform streak record (real, beatable) — give Ana back-to-back wins
  for (let i = 0; i < 2; i++) {
    const bb = (await j('/api/bets', { method: 'POST', body: JSON.stringify({ home: 'S', away: 'T', backedOutcome: 'HOME', stake: 1, currency: 'EUR' }) }, A.secret)).data;
    await j('/api/bets/' + bb.id + '/accept', { method: 'POST' }, Bp.secret);
    await j('/api/bets/' + bb.id + '/resolve', { method: 'POST', body: JSON.stringify({ actualOutcome: 'HOME' }) }, Bp.secret);
    await j('/api/bets/' + bb.id + '/resolve', { method: 'POST', body: JSON.stringify({ actualOutcome: 'HOME' }) }, A.secret);
  }
  r = await j('/api/players/me/summary', {}, A.secret);
  ok(r.data.platformRecord && r.data.platformRecord.name === 'Ana' && r.data.platformRecord.count >= 2, 'platform streak record surfaces (real wins only)');

  // high-scores board (windowed crowns, real data only)
  r = await j('/api/records?window=all');
  ok(r.status === 200 && r.data.streak && r.data.streak.name === 'Ana' && r.data.mostDuels && r.data.biggestBottle, 'high-scores board computes windowed crowns');

  // sharing contract: the OG head a scraper sees on /b/:id (WhatsApp/FB/iMessage/Twitter)
  const og = await (await fetch(B + '/b/' + b1)).text();
  const hasTag = (re) => re.test(og);
  ok(hasTag(/<meta property="og:title" content="[^"]+"/) && hasTag(/<meta property="og:image" content="[^"]*\/card\/[^"]+\.png/), 'OG: title + PNG image present on bet page');
  ok(hasTag(/<meta property="og:image:type" content="image\/png"/) && hasTag(/<meta property="og:image:secure_url"/) && hasTag(/<meta property="og:image:alt"/), 'OG: image type + secure_url + alt (Facebook/a11y)');
  ok(hasTag(/<meta property="og:image:width" content="1200"/) && hasTag(/<meta property="og:image:height" content="630"/), 'OG: 1200x630 declared (large preview)');
  ok(hasTag(/<meta name="twitter:card" content="summary_large_image"/), 'OG: twitter large-image card');
  ok(/duely\.live|localhost|127\.0\.0\.1|:3199/.test(og) || hasTag(/og:url/), 'OG: canonical url present');
  // challenge card must render PNG and stay under WhatsApp's 600KB unfurl cap
  const cardRes = await fetch(B + '/card/' + b1 + '.png');
  const cardBuf = await cardRes.arrayBuffer();
  ok(cardRes.ok && cardBuf.byteLength > 3000 && cardBuf.byteLength < 600000, `challenge card PNG under WhatsApp 600KB cap (${(cardBuf.byteLength / 1024 | 0)}KB)`);
  // og image url is cache-busted by state so re-shares don't unfurl a stale card
  ok(/og:image" content="[^"]*\?v=/.test(og), 'OG: image url cache-busted by bet state');

  // cards render to PNG; profanity masked on public surfaces only
  for (const [label, url] of [['challenge', `/card/${b3}.png`], ['result', `/card/${b1}.png`], ['story', `/storycard/${b1}.png`], ['league', `/lcard/${code}.png`]]) {
    const res = await fetch(B + url); const buf = await res.arrayBuffer();
    ok(res.ok && (res.headers.get('content-type') || '').includes('png') && buf.byteLength > 3000, `${label} card renders to PNG (${buf.byteLength}B)`);
  }
  r = await j('/api/bets', { method: 'POST', body: JSON.stringify({ home: 'P', away: 'Q', backedOutcome: 'HOME', stake: 1, currency: 'EUR', note: 'you are fucking done' }) }, A.secret);
  const svg = await (await fetch(B + '/card/' + r.data.id + '.svg')).text();
  ok(!/fucking/.test(svg) && /f\*+g/.test(svg), 'card masks profanity');
  const raw = await j('/api/bets/' + r.data.id);
  ok(/fucking/.test(raw.data.note), 'in-app note stays unmasked');
  ok(!JSON.stringify(raw.data).includes(A.secret), 'public bet JSON leaks no secret');

  // email auth: upgrade keeps identity; login adopts it; wrong password rejected
  r = await j('/api/auth/email', { method: 'POST', body: JSON.stringify({ email: 'a@x.com', password: 'secret123' }) }, A.secret);
  ok(r.status === 200 && r.data.id === A.id && r.data.secret === A.secret, 'email signup upgrades in place');
  r = await j('/api/auth/email', { method: 'POST', body: JSON.stringify({ email: 'a@x.com', password: 'secret123' }) });
  ok(r.status === 200 && r.data.id === A.id, 'email login adopts the account');
  r = await j('/api/auth/email', { method: 'POST', body: JSON.stringify({ email: 'a@x.com', password: 'wrong' }) });
  ok(r.status === 401, 'wrong password → 401');

  // SEO / GEO surfaces
  let sres = await fetch(B + '/robots.txt'); let stxt = await sres.text();
  ok(sres.ok && /Sitemap:/i.test(stxt) && /GPTBot|ClaudeBot|PerplexityBot/.test(stxt), 'robots.txt: sitemap + AI crawlers allowed');
  sres = await fetch(B + '/sitemap.xml'); stxt = await sres.text();
  ok(sres.ok && (sres.headers.get('content-type') || '').includes('xml') && /clashly\.live\/about/.test(stxt), 'sitemap.xml lists /about');
  sres = await fetch(B + '/about'); stxt = await sres.text();
  ok(sres.ok && /settle a bet with a friend|Settle football bets|Duely is a/i.test(stxt) && /no money/i.test(stxt), 'about page: crawlable prose + no-money framing');
  ok(/rel="canonical" href="https:\/\/clashly\.live\/about"/.test(stxt), 'about page has canonical');
  const home = await (await fetch(B + '/')).text();
  ok(/application\/ld\+json/.test(home) && /FAQPage/.test(home) && /WebApplication/.test(home), 'homepage has JSON-LD (WebApplication + FAQPage) for GEO');
  ok(/<section class="seo-hero">/.test(home) && /How it works/.test(home), 'homepage serves crawlable hero content (not just Loading…)');
  ok(/rel="canonical" href="https:\/\/clashly\.live\/"/.test(home), 'homepage has canonical');
  const ogh = await fetch(B + '/og-home.png'); const oghBuf = await ogh.arrayBuffer();
  ok(ogh.ok && (ogh.headers.get('content-type') || '').includes('png') && oghBuf.byteLength > 3000, 'home OG card renders to PNG');

  // static serving: gzip + cache tiers
  const gz = await fetch(B + '/app.js', { headers: { 'Accept-Encoding': 'gzip' } });
  ok(gz.headers.get('cache-control') === 'public, max-age=300', 'app.js cache-control 300s');
  const fav = await fetch(B + '/favicon.svg');
  ok(fav.ok && (fav.headers.get('cache-control') || '').includes('86400'), 'favicon cached 1 day');
  // ---- Clashly Credits (economy.js) ----------------------------------------
  const adm = (a, body) => j('/api/admin/' + a, { method: 'POST', body: JSON.stringify(body), headers: { 'x-admin-key': 'test-admin' } });
  const C = await mk('Cara'), D = await mk('Dev');
  r = await j('/api/wallet', {}, C.secret);
  ok(r.status === 200 && r.data.credits === 10000 && r.data.tickets.left === 5, 'credits: new player starts at 10,000 C with 5 Play Tickets');
  r = await j('/api/wallet');
  ok(r.status === 401, 'credits: wallet needs a secret');
  r = await j('/api/admin/result', { method: 'POST', body: '{}' });
  ok(r.status === 404, 'credits: admin hooks hidden without the key');
  r = await j('/api/predict/m_mci_liv', {}, C.secret);
  ok(r.status === 200 && [1.3, 2, 3.5, 5].includes(r.data.match.mult.HOME) && r.data.match.mult.DRAW >= r.data.match.mult.HOME, 'predict: tiered multipliers, draw priced as the longer shot');
  r = await j('/api/picks', { method: 'POST', body: JSON.stringify({ matchId: 'm_mci_liv', outcome: 'HOME', amount: 50 }) }, C.secret);
  ok(r.status === 400, 'picks: below the 100 C minimum is refused');
  r = await j('/api/picks', { method: 'POST', body: JSON.stringify({ matchId: 'm_mci_liv', outcome: 'HOME', amount: 99999 }) }, C.secret);
  ok(r.status === 400, 'picks: above the 5,000 C maximum is refused');
  r = await j('/api/picks', { method: 'POST', body: JSON.stringify({ matchId: 'm_mci_liv', outcome: 'HOME', amount: 1000 }) }, C.secret);
  ok(r.status === 201 && r.data.credits === 9000 && r.data.pick.status === 'open', 'picks: 1,000 C on the line comes off the balance');
  const cMult = r.data.pick.mult;
  r = await j('/api/picks', { method: 'POST', body: JSON.stringify({ matchId: 'm_mci_liv', outcome: 'AWAY', amount: 500 }) }, C.secret);
  ok(r.status === 409, 'picks: one pick per match, no hedging');
  await j('/api/picks', { method: 'POST', body: JSON.stringify({ matchId: 'm_mci_liv', outcome: 'AWAY', amount: 500 }) }, D.secret);
  r = await adm('result', { key: 'm_mci_liv', outcome: 'HOME' });
  ok(r.status === 200 && r.data.settled === 2, 'settle: both picks on the match settle');
  r = await j('/api/wallet', {}, C.secret);
  ok(r.data.credits === 9000 + Math.round(1000 * cMult), 'settle: a correct pick pays amount x multiplier');
  r = await j('/api/wallet', {}, D.secret);
  ok(r.data.credits === 9500, 'settle: a wrong pick keeps the Credits already on the line');
  r = await j('/api/home', {}, C.secret);
  ok(r.status === 200 && r.data.fresh.length === 1 && r.data.fresh[0].status === 'won' && r.data.founding.cap === 20000, 'home: fresh result waiting to be revealed + founding counter');
  await j('/api/picks/seen', { method: 'POST', body: JSON.stringify({ ids: [r.data.fresh[0].id] }) }, C.secret);
  r = await j('/api/home', {}, C.secret);
  ok(r.data.fresh.length === 0, 'home: a seen result is not shown twice');

  // daily reward + streak
  r = await j('/api/credits/daily', { method: 'POST' }, C.secret);
  ok(r.status === 200 && r.data.day === 1 && r.data.amount === 100, 'daily reward: day 1 pays 100 C');
  r = await j('/api/credits/daily', { method: 'POST' }, C.secret);
  ok(r.status === 409, 'daily reward: once a day');
  r = await j('/api/wallet', {}, C.secret);
  ok(r.data.streak.days === 1 && r.data.streak.today === true, 'streak: a prediction counts as today\'s activity');

  // Clash Credits: escrow, pool, refund
  const cBefore = (await j('/api/wallet', {}, C.secret)).data.credits, dBefore = (await j('/api/wallet', {}, D.secret)).data.credits;
  r = await j('/api/bets', { method: 'POST', body: JSON.stringify({ home: 'Inter', away: 'Milan', backedOutcome: 'HOME', line: 'pints', credits: 1000 }) }, C.secret);
  ok(r.status === 201 && r.data.credits === 1000, 'clash: created with 1,000 C on it');
  const cb = r.data.id;
  ok((await j('/api/wallet', {}, C.secret)).data.credits === cBefore - 1000, 'clash: proposer stake held');
  await j('/api/bets/' + cb + '/accept', { method: 'POST' }, D.secret);
  ok((await j('/api/wallet', {}, D.secret)).data.credits === dBefore - 1000, 'clash: acceptor stake held');
  await j('/api/bets/' + cb + '/resolve', { method: 'POST', body: JSON.stringify({ actualOutcome: 'AWAY' }) }, C.secret);
  await j('/api/bets/' + cb + '/confirm', { method: 'POST', body: JSON.stringify({ outcome: 'AWAY' }) }, D.secret);
  ok((await j('/api/wallet', {}, D.secret)).data.credits === dBefore + 1000, 'clash: winner takes the 2,000 C pool');
  r = await j('/api/bets', { method: 'POST', body: JSON.stringify({ home: 'Roma', away: 'Lazio', backedOutcome: 'HOME', credits: 500 }) }, C.secret);
  const vb = r.data.id; const cMid = (await j('/api/wallet', {}, C.secret)).data.credits;
  await j('/api/bets/' + vb + '/void', { method: 'POST' }, C.secret);
  ok((await j('/api/wallet', {}, C.secret)).data.credits === cMid + 500, 'clash: void refunds the stake');
  r = await j('/api/bets', { method: 'POST', body: JSON.stringify({ home: 'A', away: 'B', backedOutcome: 'HOME', credits: 999999 }) }, C.secret);
  ok(r.status === 400 || r.status === 409, 'clash: cannot stake more than allowed');

  // PLAY: tickets, server-scored quiz, clamps
  r = await j('/api/play/start', { method: 'POST', body: JSON.stringify({ game: 'quiz' }) }, D.secret);
  ok(r.status === 200 && r.data.tickets.left === 4 && r.data.q && r.data.q.opts.length === 4 && r.data.q.c === undefined, 'play: a run costs one ticket and never leaks the answer');
  let run = r.data.run, step;
  for (let i = 0; i < 10; i++) { step = await j('/api/play/step', { method: 'POST', body: JSON.stringify({ run, choice: 0 }) }, D.secret); }
  ok(step.data.done === true && typeof step.data.score === 'number', 'quiz: ten server-checked answers then done');
  r = await j('/api/play/finish', { method: 'POST', body: JSON.stringify({ run }) }, D.secret);
  ok(r.status === 200 && r.data.reward === step.data.score && r.data.credits === r.data.before + r.data.reward, 'quiz: reward = server score, credited');
  r = await j('/api/play/finish', { method: 'POST', body: JSON.stringify({ run }) }, D.secret);
  ok(r.status === 410 || r.status === 409, 'play: a run pays out once');
  r = await j('/api/play/start', { method: 'POST', body: JSON.stringify({ game: 'penalty' }) }, D.secret);
  run = r.data.run;
  r = await j('/api/play/finish', { method: 'POST', body: JSON.stringify({ run, shots: [250, 250, 250, 250, 250] }) }, D.secret);
  ok(r.status === 400, 'penalty: an instant perfect score is refused');
  r = await j('/api/play/start', { method: 'POST', body: JSON.stringify({ game: 'reaction' }) }, D.secret);
  run = r.data.run;
  r = await j('/api/play/finish', { method: 'POST', body: JSON.stringify({ run, ms: 20 }) }, D.secret);
  ok(r.status === 400, 'reaction: inhuman times are refused');
  for (let i = 0; i < 3; i++) await j('/api/play/start', { method: 'POST', body: JSON.stringify({ game: 'reaction' }) }, D.secret);
  r = await j('/api/play/start', { method: 'POST', body: JSON.stringify({ game: 'reaction' }) }, D.secret);
  ok(r.status === 409 && /tickets/i.test(r.data.error), 'play: no sixth run without a ticket');

  // odds master needs a league table; give it one
  const teams = { 65: { pos: 1, pg: 8, pts: 22, ppg: 2.75, gdpg: 1.5 }, 64: { pos: 12, pg: 8, pts: 9, ppg: 1.1, gdpg: -0.4 }, 57: { pos: 2, pg: 8, pts: 19, ppg: 2.4, gdpg: 1.2 }, 73: { pos: 18, pg: 8, pts: 5, ppg: 0.6, gdpg: -1.1 }, 61: { pos: 5, pg: 8, pts: 15, ppg: 1.9, gdpg: 0.5 }, 67: { pos: 15, pg: 8, pts: 7, ppg: 0.9, gdpg: -0.8 } };
  await adm('standings', { code: 'PL', teams });
  r = await j('/api/predict/m_ars_tot', {}, C.secret);
  ok(r.data.match.mult.HOME === 1.3 && r.data.match.mult.AWAY === 5, 'model: a strong home side at 1.30x, the bottom side away at 5.00x');
  r = await j('/api/play/start', { method: 'POST', body: JSON.stringify({ game: 'odds' }) }, C.secret);
  ok(r.status === 200 && r.data.total >= 3 && r.data.event.probs === undefined, 'odds master: events from the table, probabilities hidden until the pick');

  // ranks, card, seasons
  r = await j('/api/rank?scope=global', {}, C.secret);
  ok(r.status === 200 && r.data.me && r.data.rows[0].value >= r.data.rows[r.data.rows.length - 1].value && r.data.season.week >= 1, 'rank: global by Credits, you included');
  r = await j('/api/rank?scope=friends', {}, C.secret);
  ok(r.data.rows.some((x) => x.name === 'Dev'), 'rank: a Clash opponent is a friend');
  await adm('roll', {});
  r = await j('/api/rank?scope=weekly', {}, C.secret);
  ok(r.status === 200 && Array.isArray(r.data.history) && r.data.history.length === 1, 'season: a rollover stores the week in history');
  r = await j('/api/card', {}, C.secret);
  ok(r.status === 200 && r.data.skill > 0 && r.data.badges.some((b) => b.id === 'first' && b.on) && r.data.accuracy != null, 'card: skill, accuracy, badges');
  const br = await fetch(B + '/brag/' + C.id + '/rank.svg'); const brt = await br.text();
  ok(br.ok && /BACK YOURSELF/.test(brt) && /GLOBAL/.test(brt), 'share card: brag card renders from real data');
  const rd = await fetch(B + '/arcade', { redirect: 'manual' });
  ok(rd.status === 302 && rd.headers.get('location') === '/play', 'retired arcade redirects to PLAY');
  for (const tab of ['/rank', '/clash', '/play', '/play/quiz']) { const t = await fetch(B + tab); ok(t.ok && /id="app"/.test(await t.text()), 'SPA tab hard-loads: ' + tab); }
} catch (e) {
  fail++; console.error('  ✗ CRASH:', e.message);
}

console.log(`\n  ${pass} passed, ${fail} failed`);
cleanup();
process.exit(fail ? 1 : 0);

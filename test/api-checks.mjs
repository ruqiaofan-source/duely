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
for (const f of ['server.js', 'cards.js']) fs.copyFileSync(path.join(ROOT, f), path.join(tmp, f));
for (const l of ['node_modules', 'public', 'fonts', 'challenge.svg', 'result.svg']) fs.symlinkSync(path.join(ROOT, l), path.join(tmp, l));
const env = { ...process.env, PORT: String(PORT) };
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
  ok(r.status === 200 && r.data.brand === 'Duely' && r.data.googleClientId === null, 'config: brand + googleClientId=null without env');

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

  // static serving: gzip + cache tiers
  const gz = await fetch(B + '/app.js', { headers: { 'Accept-Encoding': 'gzip' } });
  ok(gz.headers.get('cache-control') === 'public, max-age=300', 'app.js cache-control 300s');
  const fav = await fetch(B + '/favicon.svg');
  ok(fav.ok && (fav.headers.get('cache-control') || '').includes('86400'), 'favicon cached 1 day');
} catch (e) {
  fail++; console.error('  ✗ CRASH:', e.message);
}

console.log(`\n  ${pass} passed, ${fail} failed`);
cleanup();
process.exit(fail ? 1 : 0);

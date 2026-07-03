'use strict';

/**
 * Duely — social P2P football bet scorekeeper (v1)
 *
 * Loop: create a bet -> share link -> mate takes the other side ->
 * resolve at full time -> who owes who -> the result writes to your
 * RIVALRY RECORD with that friend (the core retention engine) -> rematch.
 *
 * The server holds NO money and takes NO commission. It records the wager,
 * keeps the head-to-head ledger, and tells two friends who pays whom.
 *
 * Identity is server-authoritative: every player gets an opaque id (public,
 * stamped onto bets/leagues) and a secret bearer token (private, sent as the
 * `x-duely-secret` header). Private reads are gated by the secret — names are
 * display labels only, never the key, so nobody can read or claim a record by
 * guessing a name. Optional Google / email login attaches a verified identity
 * to an existing player id (see /api/auth/*).
 *
 * NOTE (legal): "no money held" is NOT a confirmed exemption from gambling
 * intermediary licensing (e.g. UK Gambling Act 2005 s.13). This is a
 * prototype to validate the loop — get counsel before any public launch.
 *
 * Optional live results: set FOOTBALL_DATA_TOKEN (free key, football-data.org).
 * Optional Google sign-in: set GOOGLE_CLIENT_ID (OAuth 2.0 Web client id).
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const cards = require('./cards');

// minimal .env loader (zero-dep) so secrets like FOOTBALL_DATA_TOKEN stay out of git
try {
  const envPath = path.join(__dirname, '.env');
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
} catch {}

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
const DATA_FILE = path.join(ROOT, 'data.json');
const FOOTBALL_TOKEN = process.env.FOOTBALL_DATA_TOKEN || '';
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const BRAND = 'Duely';

// ---------------------------------------------------------------------------
// Store — Postgres (durable, survives redeploys) with a JSON-file fallback
// ---------------------------------------------------------------------------
const DATABASE_URL = process.env.DATABASE_URL || '';
let pool = null;
if (DATABASE_URL) {
  const { Pool } = require('pg');
  pool = new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false }, max: 5 });
  pool.on('error', (e) => console.error('pg pool error:', e.message));
}

let db = { players: {}, bets: {}, leagues: {}, events: [], stats: {} };

// serialized write-through (latest state always wins, writes never overlap)
let _writing = false, _dirty = false;
async function pgSave() {
  if (_writing) { _dirty = true; return; }
  _writing = true;
  try { await pool.query('INSERT INTO app_state (id, data) VALUES (1, $1) ON CONFLICT (id) DO UPDATE SET data = $1', [JSON.stringify(db)]); }
  catch (e) { console.error('pg save failed:', e.message); }
  finally { _writing = false; if (_dirty) { _dirty = false; pgSave(); } }
}
function saveData() {
  if (pool) { pgSave(); return; }
  const tmp = `${DATA_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DATA_FILE);
}
async function initData() {
  if (pool) {
    await pool.query('CREATE TABLE IF NOT EXISTS app_state (id int PRIMARY KEY, data jsonb NOT NULL)');
    const r = await pool.query('SELECT data FROM app_state WHERE id = 1');
    if (r.rows[0] && r.rows[0].data) db = r.rows[0].data;
  } else {
    try { db = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch {}
  }
  if (!db.players) db.players = {};
  if (!db.bets) db.bets = {};
  if (!db.leagues) db.leagues = {};
  if (!db.events) db.events = [];
  if (!db.stats) db.stats = {};
  rebuildSecretIndex();
  seedHistory();
}

// lightweight loop-funnel instrumentation (created → opened → accepted → resolved → rematch)
function logEvent(type, meta = {}, persist = true) {
  db.stats[type] = (db.stats[type] || 0) + 1;
  db.events.push({ type, t: new Date().toISOString(), ...meta });
  if (db.events.length > 5000) db.events = db.events.slice(-5000);
  if (persist) saveData();
}

const newId = () => crypto.randomBytes(4).toString('hex');
const newSecret = () => crypto.randomBytes(24).toString('hex');
const newCode = () => {
  const A = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no ambiguous chars
  const b = crypto.randomBytes(5);
  let s = ''; for (let i = 0; i < 5; i++) s += A[b[i] % A.length];
  return s;
};
const norm = (s) => String(s || '').trim().toLowerCase();
const normEmail = (s) => String(s || '').trim().toLowerCase();
const OUTCOMES = ['HOME', 'DRAW', 'AWAY'];

// ---------------------------------------------------------------------------
// Identity — server-authoritative players (id public, secret private)
// ---------------------------------------------------------------------------
let _secretIndex = null; // secret -> id, lazily rebuilt
function rebuildSecretIndex() {
  _secretIndex = {};
  for (const p of Object.values(db.players)) if (p && p.secret) _secretIndex[p.secret] = p.id;
}
function playerBySecret(secret) {
  if (!secret) return null;
  if (!_secretIndex) rebuildSecretIndex();
  const id = _secretIndex[secret];
  return id ? db.players[id] : null;
}
function authPlayer(req) {
  const secret = req.headers['x-duely-secret'] || '';
  return playerBySecret(secret);
}
function createPlayer(name) {
  const id = newId();
  const p = { id, secret: newSecret(), name: String(name || '').slice(0, 40) || 'Player', createdAt: new Date().toISOString() };
  db.players[id] = p;
  if (_secretIndex) _secretIndex[p.secret] = id;
  return p;
}
const playerByEmail = (email) => Object.values(db.players).find((p) => p.email && normEmail(p.email) === normEmail(email)) || null;
const playerByGoogle = (sub) => Object.values(db.players).find((p) => p.googleSub === sub) || null;
const nameOf = (id) => (db.players[id] ? db.players[id].name : null);
// what the owner gets back (includes the secret); everyone else gets publicPlayer
const selfPlayer = (p) => ({ id: p.id, name: p.name, secret: p.secret, email: p.email || null, verified: Boolean(p.emailVerified), hasPassword: Boolean(p.passHash), google: Boolean(p.googleSub) });

function hashPw(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  const h = crypto.scryptSync(pw, salt, 64).toString('hex');
  return salt + ':' + h;
}
function checkPw(pw, stored) {
  try {
    const [salt, h] = String(stored).split(':');
    const hh = crypto.scryptSync(pw, salt, 64).toString('hex');
    return crypto.timingSafeEqual(Buffer.from(h, 'hex'), Buffer.from(hh, 'hex'));
  } catch { return false; }
}
async function verifyGoogleIdToken(idToken) {
  if (!idToken || !GOOGLE_CLIENT_ID) return null;
  const res = await fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(idToken));
  if (!res.ok) return null;
  const j = await res.json();
  if (j.aud !== GOOGLE_CLIENT_ID) return null;
  if (j.email_verified !== 'true' && j.email_verified !== true) return null;
  return { sub: j.sub, email: j.email, name: j.name || (j.email || '').split('@')[0] };
}

// ---------------------------------------------------------------------------
// Demo fixtures
// ---------------------------------------------------------------------------
function demoMatches() {
  const day = 86400000, now = Date.now();
  const d = (n) => new Date(now + n * day).toISOString();
  return [
    { id: 'm_esp_uru', home: 'Spain', away: 'Uruguay', competition: 'Friendly', utcDate: d(2) },
    { id: 'm_arg_bra', home: 'Argentina', away: 'Brazil', competition: 'WC Qualifier', utcDate: d(3) },
    { id: 'm_mci_liv', home: 'Man City', away: 'Liverpool', competition: 'Premier League', utcDate: d(4) },
    { id: 'm_rma_fcb', home: 'Real Madrid', away: 'Barcelona', competition: 'LaLiga', utcDate: d(5) },
    { id: 'm_ars_tot', home: 'Arsenal', away: 'Tottenham', competition: 'Premier League', utcDate: d(6) },
  ];
}

// ---------------------------------------------------------------------------
// Optional live results (football-data.org)
// ---------------------------------------------------------------------------
async function fetchLiveMatches() {
  const day = 86400000;
  const from = new Date().toISOString().slice(0, 10);
  const to = new Date(Date.now() + 10 * day).toISOString().slice(0, 10);
  const res = await fetch(`https://api.football-data.org/v4/matches?dateFrom=${from}&dateTo=${to}`, {
    headers: { 'X-Auth-Token': FOOTBALL_TOKEN },
  });
  if (!res.ok) throw new Error(`football-data ${res.status}`);
  const json = await res.json();
  return (json.matches || []).map((m) => ({
    id: 'm_' + m.id, externalId: String(m.id),
    home: m.homeTeam?.shortName || m.homeTeam?.name || 'Home', away: m.awayTeam?.shortName || m.awayTeam?.name || 'Away',
    competition: m.competition?.name || '', utcDate: m.utcDate,
  }));
}
async function fetchLiveResult(externalId) {
  const res = await fetch(`https://api.football-data.org/v4/matches/${externalId}`, {
    headers: { 'X-Auth-Token': FOOTBALL_TOKEN },
  });
  if (!res.ok) throw new Error(`football-data ${res.status}`);
  const json = await res.json();
  if (json.status !== 'FINISHED') return null;
  const w = json.score?.winner;
  return w === 'HOME_TEAM' ? 'HOME' : w === 'AWAY_TEAM' ? 'AWAY' : w === 'DRAW' ? 'DRAW' : null;
}
let _matchCache = { t: 0, data: null };
async function getMatches() {
  if (FOOTBALL_TOKEN) {
    if (_matchCache.data && Date.now() - _matchCache.t < 300000) return _matchCache.data; // 5-min cache to respect the 10/min upstream limit
    try {
      const live = await fetchLiveMatches();
      if (live.length) { _matchCache = { t: Date.now(), data: live }; return live; }
    } catch (e) { console.warn('live fetch failed, using demo:', e.message); }
  }
  return demoMatches();
}

// ---------------------------------------------------------------------------
// Bet logic
// ---------------------------------------------------------------------------
function outcomeLabel(bet, code) {
  if (code === 'HOME') return `${bet.home} win`;
  if (code === 'AWAY') return `${bet.away} win`;
  if (code === 'DRAW') return 'Draw';
  return code;
}
const sym = (c) => (c === 'EUR' ? '€' : c === 'GBP' ? '£' : c === 'USD' ? '$' : c + ' ');
const abbr = (s) => (String(s || '').replace(/[^A-Za-z]/g, '').toUpperCase().slice(0, 3) || '?');
function complementLabel(bet) {
  if (bet.backedOutcome === 'DRAW') return "it's not a draw";
  if (bet.backedOutcome === 'HOME') return `${bet.home} don't win`;
  return `${bet.away} don't win`;
}
function resolveBet(bet, actualOutcome) {
  const proposerWins = actualOutcome === bet.backedOutcome;
  const winnerPid = proposerWins ? bet.proposerId : bet.opponentId;
  const loserPid = proposerWins ? bet.opponentId : bet.proposerId;
  const winnerNm = proposerWins ? bet.proposerName : bet.opponentName;
  const loserNm = proposerWins ? bet.opponentName : bet.proposerName;
  bet.status = 'resolved';
  bet.actualOutcome = actualOutcome;
  bet.winner = proposerWins ? 'proposer' : 'opponent';
  // owes carries ids (the ledger key) plus denormalized names (for cards/OG)
  bet.owes = { fromId: loserPid, toId: winnerPid, from: loserNm, to: winnerNm, amount: bet.stake, currency: bet.currency };
  bet.resolvedAt = new Date().toISOString();
  return bet;
}

// ---------------------------------------------------------------------------
// Stats engine (records computed by player id; names are display only)
// ---------------------------------------------------------------------------
const decidedBets = () => Object.values(db.bets).filter((b) => b.status === 'resolved' || b.status === 'settled');
const involvesId = (b, id) => b.proposerId === id || b.opponentId === id;
const otherId = (b, id) => (b.proposerId === id ? b.opponentId : b.proposerId);
const nameForId = (b, id) => (b.proposerId === id ? b.proposerName : b.opponentName); // display name straight off the bet
const winnerId = (b) => (b.winner === 'proposer' ? b.proposerId : b.opponentId);
const winnerDisplayName = (b) => (b.winner === 'proposer' ? b.proposerName : b.opponentName);
const byRecent = (a, b) => new Date(b.resolvedAt || 0) - new Date(a.resolvedAt || 0);

// nets are tracked per currency (mates can stake in £ and € across bets — summing
// them naively is nonsense). netView collapses to a single displayable {net, currency}
// when exactly one currency is involved, else {net: null} and the client shows the record.
function addNet(nets, cur, delta) { const c = cur || 'EUR'; nets[c] = (nets[c] || 0) + delta; }
function netView(nets) {
  const keys = Object.keys(nets);
  if (keys.length === 0) return { net: 0, currency: 'EUR' };
  if (keys.length === 1) return { net: nets[keys[0]], currency: keys[0] };
  return { net: null, currency: null };
}

function playerSummary(id) {
  const name = nameOf(id);
  const mine = decidedBets().filter((b) => involvesId(b, id)).sort(byRecent);
  let w = 0, l = 0; const nets = {};
  for (const b of mine) {
    if (winnerId(b) === id) w++; else l++;
    if (b.owes) {
      if (b.owes.toId === id) addNet(nets, b.owes.currency, b.owes.amount);
      else if (b.owes.fromId === id) addNet(nets, b.owes.currency, -b.owes.amount);
    }
  }
  let streak = { type: null, count: 0 };
  for (const b of mine) {
    const t = winnerId(b) === id ? 'W' : 'L';
    if (streak.type === null) streak = { type: t, count: 1 };
    else if (streak.type === t) streak.count++;
    else break;
  }
  const byOpp = {};
  for (const b of mine) {
    const oid = otherId(b, id);
    // label from the live player record (freshest), bet-denormalized name as fallback
    if (!byOpp[oid]) byOpp[oid] = { opponentId: oid, opponent: nameOf(oid) || nameForId(b, oid), w: 0, l: 0, nets: {}, games: 0 };
    const r = byOpp[oid];
    r.games++;
    if (winnerId(b) === id) r.w++; else r.l++;
    if (b.owes) {
      if (b.owes.toId === id) addNet(r.nets, b.owes.currency, b.owes.amount);
      else if (b.owes.fromId === id) addNet(r.nets, b.owes.currency, -b.owes.amount);
    }
  }
  const rivalries = Object.values(byOpp)
    .map((r) => { const nv = netView(r.nets); return { opponentId: r.opponentId, opponent: r.opponent, w: r.w, l: r.l, games: r.games, net: nv.net, currency: nv.currency, isRival: r.games >= 3 }; })
    .sort((a, b) => b.games - a.games);
  const recent = mine.slice(0, 8).map((b) => ({
    id: b.id, home: b.home, away: b.away, opponent: nameForId(b, otherId(b, id)),
    won: winnerId(b) === id, amount: b.owes ? b.owes.amount : b.stake,
    currency: b.currency, status: b.status,
  }));
  const nv = netView(nets);
  return { id, name, w, l, net: nv.net, currency: nv.currency, streak, rivalries, recent };
}

function rivalry(idA, idB) {
  const both = decidedBets().filter((x) => involvesId(x, idA) && involvesId(x, idB)).sort(byRecent);
  let aWins = 0, bWins = 0; const aNets = {};
  // live player names first; fall back to the newest bet's denormalized labels
  const aName = nameOf(idA) || (both[0] ? nameForId(both[0], idA) : null);
  const bName = nameOf(idB) || (both[0] ? nameForId(both[0], idB) : null);
  for (const x of both) {
    if (winnerId(x) === idA) aWins++; else bWins++;
    if (x.owes) {
      if (x.owes.toId === idA) addNet(aNets, x.owes.currency, x.owes.amount);
      else if (x.owes.fromId === idA) addNet(aNets, x.owes.currency, -x.owes.amount);
    }
  }
  const nv = netView(aNets);
  return { aId: idA, bId: idB, a: aName, b: bName, aWins, bWins, aNet: nv.net, games: both.length, currency: nv.currency };
}

// Rivalry one-liner for a specific bet's two players (used on cards / OG meta).
function rivalryLine(bet) {
  const r = rivalry(bet.proposerId, bet.opponentId);
  const p = bet.proposerName, o = bet.opponentName;
  if (!r.games) return `First bet of the ${p}-${o} rivalry`;
  const hi = Math.max(r.aWins, r.bWins), lo = Math.min(r.aWins, r.bWins);
  if (r.aWins === r.bWins) return `${p} & ${o} all level ${hi}-${lo}`;
  const leader = r.aWins > r.bWins ? p : o;
  const chaser = r.aWins > r.bWins ? o : p;
  return `${leader} leads ${chaser} ${hi}-${lo}`;
}

// League table: aggregate decided bets *between members of the league* (by id).
function leagueStandings(league) {
  const ids = new Set(league.members.map((m) => m.id));
  const rel = decidedBets().filter((b) => ids.has(b.proposerId) && ids.has(b.opponentId));
  const tbl = {};
  for (const m of league.members) tbl[m.id] = { id: m.id, name: nameOf(m.id) || m.name, w: 0, l: 0, nets: {}, games: 0 };
  for (const b of rel) {
    const wk = winnerId(b), lk = otherId(b, wk);
    if (tbl[wk]) { tbl[wk].w++; tbl[wk].games++; }
    if (tbl[lk]) { tbl[lk].l++; tbl[lk].games++; }
    if (b.owes) {
      if (tbl[b.owes.toId]) addNet(tbl[b.owes.toId].nets, b.owes.currency, b.owes.amount);
      if (tbl[b.owes.fromId]) addNet(tbl[b.owes.fromId].nets, b.owes.currency, -b.owes.amount);
    }
  }
  const rows = Object.values(tbl)
    .map((r) => { const nv = netView(r.nets); return { id: r.id, name: r.name, w: r.w, l: r.l, games: r.games, net: nv.net, currency: nv.currency }; })
    .sort((a, b) => b.w - a.w || a.l - b.l || (b.net || 0) - (a.net || 0) || a.name.localeCompare(b.name));
  rows.forEach((r, i) => (r.rank = i + 1));
  return rows;
}

// shape a league for the API (denormalize member names off their player records)
function leagueView(league) {
  return {
    code: league.code, name: league.name,
    members: league.members.map((m) => ({ id: m.id, name: nameOf(m.id) || m.name })),
    standings: leagueStandings(league),
  };
}

function leagueSvgFor(league) {
  const rows = leagueStandings(league);
  const leader = rows.length && rows[0].games ? `led by ${rows[0].name}` : 'first to bet leads';
  return cards.leagueSvg({
    NAME: league.name, CODE: league.code,
    MEMBERS: `${league.members.length} ${league.members.length === 1 ? 'mate' : 'mates'}`,
    LEADER: leader,
  });
}

function fmtDate(iso) {
  if (!iso) return '';
  try { return new Date(iso).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }); }
  catch { return ''; }
}

// ---------------------------------------------------------------------------
// Share cards (SVG + PNG) and OG meta
// ---------------------------------------------------------------------------
// trim in Unicode code points, not UTF-16 units — a naive slice can split an emoji
// surrogate pair and render '�' on the shared card
const trimCp = (s, n) => { const cps = [...String(s)]; return cps.length > n ? cps.slice(0, n - 1).join('') + '…' : String(s); };
// scale the hero line down so long names/teams never clip the card edge
// (Anton ≈ 0.52em average advance width)
const heroSize = (text, base, maxPx) => Math.min(base, Math.max(48, Math.floor(maxPx / (0.52 * Math.max(1, [...String(text)].length)))));

function cardSvgForBet(bet) {
  const data = {
    PROPOSER: bet.proposerName, HOME: bet.home, AWAY: bet.away,
    HOME_ABBR: abbr(bet.home), AWAY_ABBR: abbr(bet.away),
    COMP: bet.competition || 'Match', DATE: fmtDate(bet.utcDate),
    STAKE: sym(bet.currency) + bet.stake,
    BACKED: outcomeLabel(bet, bet.backedOutcome),
    COMPLEMENT: complementLabel(bet),
    NOTE: bet.note ? trimCp(bet.note, 44) : '',
  };
  if (bet.status === 'void') {
    return cards.voidSvg({ HOME: bet.home, AWAY: bet.away });
  }
  if (bet.status === 'resolved' || bet.status === 'settled') {
    const winner = winnerDisplayName(bet);
    const loser = bet.winner === 'proposer' ? bet.opponentName : bet.proposerName;
    Object.assign(data, {
      RESULT: outcomeLabel(bet, bet.actualOutcome), WINNER: winner, LOSER: loser,
      WINNER_SIZE: heroSize(winner, 132, 1060),
      // a real note belongs to its author (the proposer); the synthetic
      // "told you so." fallback belongs to the winner
      NOTE_BY: (bet.note && bet.note.trim()) ? bet.proposerName : winner,
      OWES: `${bet.owes.from}  →  ${bet.owes.to}`, RIVALRY: rivalryLine(bet),
    });
    return cards.resultSvg(data);
  }
  // open + accepted share the challenge chassis; the badge/CTA reflect the state
  Object.assign(data, {
    BACKED_SIZE: heroSize(data.BACKED, 122, 1060),
    BADGE: bet.status === 'accepted' ? "BET'S ON" : 'OPEN BET',
    CTA_MAIN: bet.status === 'accepted' ? 'LOCKED IN' : 'TAKE THE OTHER SIDE',
    CTA_SUB: bet.status === 'accepted'
      ? `${bet.proposerName} v ${bet.opponentName} · ${sym(bet.currency)}${bet.stake} on it`
      : `you'd back ${complementLabel(bet)} · ${sym(bet.currency)}${bet.stake}`,
  });
  return cards.challengeSvg(data);
}

function storySvgForBet(bet) {
  const resolved = bet.status === 'resolved' || bet.status === 'settled';
  const accent = resolved ? '#FFC83D' : '#14E0C8';
  let badge, hero, sub, foot;
  if (resolved) {
    badge = 'FULL TIME'; hero = winnerDisplayName(bet);
    sub = 'called it — ' + outcomeLabel(bet, bet.actualOutcome);
    foot = rivalryLine(bet);
  } else {
    badge = 'OPEN BET'; hero = outcomeLabel(bet, bet.backedOutcome);
    sub = bet.proposerName + ' is backing'; foot = 'Take the other side →';
  }
  return cards.storySvg({ BADGE: badge, HERO: hero, HERO_SIZE: heroSize(hero, 120, 940), SUB: sub, ACCENT: accent, HOME: bet.home, AWAY: bet.away, STAKE: sym(bet.currency) + bet.stake, FOOT: foot, ID: bet.id });
}

function serveCard(req, res, url) {
  const m = url.pathname.match(/^\/card\/([a-f0-9]+)\.(svg|png)$/);
  if (!m) { res.writeHead(404); return res.end('Not found'); }
  const bet = db.bets[m[1]];
  if (!bet) { res.writeHead(404); return res.end('No such bet'); }
  const svg = cardSvgForBet(bet);
  const cc = (bet.status === 'resolved' || bet.status === 'settled') ? 'public, max-age=31536000, immutable' : 'public, max-age=60';
  if (m[2] === 'svg') {
    res.writeHead(200, { 'Content-Type': 'image/svg+xml; charset=utf-8', 'Cache-Control': cc });
    return res.end(svg);
  }
  const png = cards.renderPng(svg);
  if (png) {
    res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': cc });
    return res.end(png);
  }
  res.writeHead(302, { Location: `/card/${m[1]}.svg` }); res.end();
}

function serveStoryCard(req, res, url) {
  const m = url.pathname.match(/^\/storycard\/([a-f0-9]+)\.(svg|png)$/);
  if (!m) { res.writeHead(404); return res.end('Not found'); }
  const bet = db.bets[m[1]];
  if (!bet) { res.writeHead(404); return res.end('No such bet'); }
  const svg = storySvgForBet(bet);
  if (m[2] === 'svg') { res.writeHead(200, { 'Content-Type': 'image/svg+xml; charset=utf-8', 'Cache-Control': 'no-cache' }); return res.end(svg); }
  const png = cards.renderPng(svg);
  if (png) { res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-cache' }); return res.end(png); }
  res.writeHead(302, { Location: `/storycard/${m[1]}.svg` }); res.end();
}

const escHtml = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function ogTextForBet(bet) {
  if (bet.status === 'void') {
    return {
      title: `${bet.proposerName}'s bet was called off`,
      desc: `This one didn't count. Start your own on Duely.`,
    };
  }
  if (bet.status === 'resolved' || bet.status === 'settled') {
    const winner = winnerDisplayName(bet);
    return {
      title: `${winner} called it: ${outcomeLabel(bet, bet.actualOutcome)} ⚽`,
      desc: `${rivalryLine(bet)}. Settle it between yourselves. Back yourself on Duely.`,
    };
  }
  if (bet.status === 'accepted') {
    return {
      title: `${bet.proposerName} v ${bet.opponentName} — bet's on 🔒`,
      desc: `${bet.home} v ${bet.away}: ${outcomeLabel(bet, bet.backedOutcome)} for ${sym(bet.currency)}${bet.stake}. May the best mate win.`,
    };
  }
  return {
    title: `${bet.proposerName} bets ${outcomeLabel(bet, bet.backedOutcome)} · ${sym(bet.currency)}${bet.stake} 🤝`,
    desc: `${bet.note ? bet.note + ' — ' : ''}${bet.home} v ${bet.away}. Take the other side (${complementLabel(bet)}) on Duely.`,
  };
}

function serveShareHtml(req, res, id) {
  fs.readFile(path.join(PUBLIC, 'index.html'), 'utf8', (err, html) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    const bet = db.bets[id];
    if (bet) {
      logEvent('link_opened', { id, kind: 'bet' }, false);
      const proto = req.headers['x-forwarded-proto'] || 'http';
      const origin = `${proto}://${req.headers.host}`;
      const { title, desc } = ogTextForBet(bet);
      const img = `${origin}/card/${id}.png`;
      const pageUrl = `${origin}/b/${id}`;
      const meta = `
    <meta property="og:type" content="website" />
    <meta property="og:site_name" content="Duely" />
    <meta property="og:title" content="${escHtml(title)}" />
    <meta property="og:description" content="${escHtml(desc)}" />
    <meta property="og:image" content="${escHtml(img)}" />
    <meta property="og:image:width" content="1200" />
    <meta property="og:image:height" content="630" />
    <meta property="og:url" content="${escHtml(pageUrl)}" />
    <meta name="twitter:card" content="summary_large_image" />
    <meta name="twitter:title" content="${escHtml(title)}" />
    <meta name="twitter:description" content="${escHtml(desc)}" />
    <meta name="twitter:image" content="${escHtml(img)}" />
`;
      html = html.replace('</head>', meta + '  </head>');
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  });
}

// ---------------------------------------------------------------------------
// Seed some history so a fresh demo shows live rivalries
// ---------------------------------------------------------------------------
function seedHistory() {
  if (db.seeded) return;
  if (process.env.SEED_DEMO !== '1') return; // deployed app starts clean (no demo names)
  const players = {};
  const ply = (name) => {
    const k = norm(name);
    if (!players[k]) players[k] = createPlayer(name);
    return players[k];
  };
  const mk = (proposer, opponent, home, away, backed, actual, stake, daysAgo, comp) => {
    const id = newId();
    const P = ply(proposer), O = ply(opponent);
    const proposerWins = actual === backed;
    const ts = new Date(Date.now() - daysAgo * 86400000).toISOString();
    db.bets[id] = {
      id, status: 'settled', proposerId: P.id, opponentId: O.id, proposerName: P.name, opponentName: O.name,
      home, away, competition: comp || 'Premier League', utcDate: ts, externalId: null,
      backedOutcome: backed, stake, currency: 'EUR', note: '',
      createdAt: ts, acceptedAt: ts, actualOutcome: actual,
      winner: proposerWins ? 'proposer' : 'opponent',
      owes: {
        fromId: proposerWins ? O.id : P.id, toId: proposerWins ? P.id : O.id,
        from: proposerWins ? O.name : P.name, to: proposerWins ? P.name : O.name, amount: stake, currency: 'EUR',
      },
      resolvedAt: ts, settledAt: ts, seeded: true,
    };
  };
  // Demo rivalry (only with SEED_DEMO=1): Alex leads Jordan 3-2, recent form = 3-win streak.
  mk('Alex', 'Jordan', 'Man City', 'Arsenal', 'HOME', 'HOME', 20, 3);
  mk('Alex', 'Jordan', 'Real Madrid', 'Barcelona', 'HOME', 'HOME', 20, 6, 'LaLiga');
  mk('Jordan', 'Alex', 'Liverpool', 'Chelsea', 'HOME', 'AWAY', 20, 9);
  mk('Jordan', 'Alex', 'Arsenal', 'Tottenham', 'HOME', 'HOME', 20, 15);
  mk('Alex', 'Jordan', 'Brighton', 'Everton', 'HOME', 'DRAW', 20, 27);
  mk('Alex', 'Casey', 'Inter', 'Milan', 'HOME', 'HOME', 10, 21, 'Serie A');
  mk('Casey', 'Alex', 'PSG', 'Lyon', 'HOME', 'HOME', 10, 33, 'Ligue 1');
  db.leagues['SUN01'] = {
    code: 'SUN01', name: 'Sunday League', createdById: players[norm('Alex')].id,
    members: [players[norm('Alex')], players[norm('Jordan')], players[norm('Casey')]].map((p) => ({ id: p.id, name: p.name })),
    createdAt: new Date(Date.now() - 45 * 86400000).toISOString(),
  };
  db.seeded = true;
  saveData();
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------
function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}
function readBody(req) {
  return new Promise((resolve) => {
    let d = '';
    req.on('data', (c) => (d += c));
    req.on('end', () => { try { resolve(d ? JSON.parse(d) : {}); } catch { resolve({}); } });
  });
}
const STATIC_TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
function serveStatic(req, res) {
  let urlPath = req.url.split('?')[0];
  if (urlPath === '/') urlPath = '/index.html';
  const filePath = path.join(PUBLIC, path.normalize(urlPath));
  if (!filePath.startsWith(PUBLIC)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(filePath, (err, buf) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': STATIC_TYPES[path.extname(filePath)] || 'application/octet-stream' });
    res.end(buf);
  });
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------
async function handleApi(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean);
  const need401 = () => sendJson(res, 401, { error: 'Sign in on this device first.' });

  if (req.method === 'GET' && parts[1] === 'config')
    return sendJson(res, 200, { brand: BRAND, live: Boolean(FOOTBALL_TOKEN), googleClientId: GOOGLE_CLIENT_ID || null });

  if (req.method === 'GET' && parts[1] === 'matches') {
    const matches = await getMatches();
    return sendJson(res, 200, { matches, live: Boolean(FOOTBALL_TOKEN) });
  }

  // GET /api/stats — loop funnel for the activation metric (% of links that get accepted)
  if (req.method === 'GET' && parts[1] === 'stats') {
    const s = db.stats || {};
    const created = s.bet_created || 0, opened = s.link_opened || 0, accepted = s.bet_accepted || 0, resolved = s.bet_resolved || 0;
    const rematch = (db.events || []).filter((e) => e.type === 'bet_created' && e.rematch).length;
    const verified = Object.values(db.players).filter((p) => p.emailVerified || p.email).length;
    return sendJson(res, 200, {
      totals: { players: Object.keys(db.players).length, verified, bets: Object.keys(db.bets).length, leagues: Object.keys(db.leagues).length },
      funnel: {
        created, opened, accepted, resolved, rematch,
        acceptRate: created ? +(accepted / created).toFixed(2) : 0,
        resolveRate: accepted ? +(resolved / accepted).toFixed(2) : 0,
      },
      stats: s,
    });
  }

  // -------------------------------------------------------------------------
  // Identity
  // -------------------------------------------------------------------------

  // POST /api/players  {name}  — register this device (or rename if already authed)
  if (req.method === 'POST' && parts[1] === 'players' && parts.length === 2) {
    const b = await readBody(req);
    const existing = authPlayer(req);
    if (existing) {
      if (b.name) { existing.name = String(b.name).slice(0, 40) || existing.name; saveData(); }
      return sendJson(res, 200, selfPlayer(existing));
    }
    const p = createPlayer(b.name || 'Player');
    saveData();
    return sendJson(res, 201, selfPlayer(p));
  }

  // /api/players/me[...]  — everything here requires the secret and acts on the caller
  if (parts[1] === 'players' && parts[2] === 'me') {
    const me = authPlayer(req);
    if (!me) return need401();

    if (req.method === 'POST' && !parts[3]) { // rename (id + secret stay stable)
      const b = await readBody(req);
      if (b.name) { me.name = String(b.name).slice(0, 40) || me.name; saveData(); }
      return sendJson(res, 200, selfPlayer(me));
    }
    if (req.method === 'GET' && !parts[3]) return sendJson(res, 200, selfPlayer(me));
    if (req.method === 'GET' && parts[3] === 'summary') return sendJson(res, 200, playerSummary(me.id));
    if (req.method === 'GET' && parts[3] === 'leagues') {
      const mine = Object.values(db.leagues).filter((l) => l.members.some((m) => m.id === me.id));
      const leagues = mine.map((l) => {
        const s = leagueStandings(l);
        const row = s.find((r) => r.id === me.id);
        return { code: l.code, name: l.name, members: l.members.length, rank: row ? row.rank : null, total: s.length };
      });
      return sendJson(res, 200, { leagues });
    }
    if (req.method === 'GET' && parts[3] === 'bets') {
      const mine = Object.values(db.bets).filter((b) => involvesId(b, me.id));
      const map = (b) => ({
        id: b.id, home: b.home, away: b.away, status: b.status,
        opponent: b.opponentId ? nameForId(b, otherId(b, me.id)) : null,
        backed: outcomeLabel(b, b.backedOutcome), stake: b.stake, currency: b.currency,
        mine: b.proposerId === me.id,
        won: (b.status === 'resolved' || b.status === 'settled') ? winnerId(b) === me.id : null,
        pending: Boolean(b.pendingResult), createdAt: b.createdAt,
      });
      const active = mine.filter((b) => b.status === 'open' || b.status === 'accepted')
        .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0)).map(map);
      const history = mine.filter((b) => b.status === 'resolved' || b.status === 'settled').sort(byRecent).map(map);
      return sendJson(res, 200, { active, history });
    }
    // GET /api/players/me/rivalry?with=:opponentId — only your own head-to-heads
    if (req.method === 'GET' && parts[3] === 'rivalry') {
      const oppId = url.searchParams.get('with');
      if (!oppId) return sendJson(res, 400, { error: 'with required' });
      return sendJson(res, 200, rivalry(me.id, oppId));
    }
    return sendJson(res, 404, { error: 'Unknown endpoint' });
  }

  // -------------------------------------------------------------------------
  // Login — attach a verified identity to an existing (or new) player
  // -------------------------------------------------------------------------

  // Signing in to an EXISTING account from a device with an anonymous guest record must
  // merge that record in — not silently orphan the guest's bets/rivalries/leagues.
  function mergePlayer(from, into) {
    for (const b of Object.values(db.bets)) {
      if (!involvesId(b, from.id)) continue;
      if (otherId(b, from.id) === into.id) {
        // the guest bet against the very account they're claiming — a self-bet after
        // merge, so it can't stand; void it rather than corrupt the ledger
        if (b.status !== 'resolved' && b.status !== 'settled') { b.status = 'void'; b.voidedAt = new Date().toISOString(); delete b.pendingResult; delete b.disputed; }
        continue;
      }
      if (b.proposerId === from.id) b.proposerId = into.id;
      if (b.opponentId === from.id) b.opponentId = into.id;
      if (b.owes) { if (b.owes.fromId === from.id) b.owes.fromId = into.id; if (b.owes.toId === from.id) b.owes.toId = into.id; }
      if (b.pendingResult && b.pendingResult.byId === from.id) b.pendingResult.byId = into.id;
      if (b.disputed && b.disputed.claims) b.disputed.claims.forEach((c) => { if (c.byId === from.id) c.byId = into.id; });
      if (b.reactions) b.reactions.forEach((r) => { if (r.byId === from.id) r.byId = into.id; });
    }
    for (const l of Object.values(db.leagues)) {
      const idx = l.members.findIndex((m) => m.id === from.id);
      if (idx < 0) continue;
      if (l.members.some((m) => m.id === into.id)) l.members.splice(idx, 1); // already a member — drop the dupe
      else l.members[idx] = { id: into.id, name: into.name };
      if (l.createdById === from.id) l.createdById = into.id;
    }
    if (_secretIndex) delete _secretIndex[from.secret];
    delete db.players[from.id];
  }

  if (req.method === 'POST' && parts[1] === 'auth' && parts[2] === 'google') {
    if (!GOOGLE_CLIENT_ID) return sendJson(res, 503, { error: 'Google sign-in is not configured.' });
    const b = await readBody(req);
    let info; try { info = await verifyGoogleIdToken(b.idToken); } catch { info = null; }
    if (!info) return sendJson(res, 401, { error: 'Google sign-in failed.' });
    let p = playerByGoogle(info.sub) || playerByEmail(info.email);
    const current = authPlayer(req);
    if (p) {
      p.googleSub = info.sub; p.email = info.email; p.emailVerified = true;
      if (!p.name) p.name = info.name;
      if (current && current.id !== p.id && !current.email && !current.googleSub) mergePlayer(current, p);
    } else if (current && !current.email && !current.googleSub) {
      p = current; p.googleSub = info.sub; p.email = info.email; p.emailVerified = true; // upgrade anon, keep record
    } else {
      p = createPlayer(info.name); p.googleSub = info.sub; p.email = info.email; p.emailVerified = true;
    }
    saveData();
    return sendJson(res, 200, selfPlayer(p));
  }

  if (req.method === 'POST' && parts[1] === 'auth' && parts[2] === 'email') {
    const b = await readBody(req);
    const email = normEmail(b.email);
    const pw = String(b.password || '');
    if (!email || !email.includes('@') || !pw) return sendJson(res, 400, { error: 'Enter your email and password.' });
    let p = playerByEmail(email);
    if (p) {
      // existing account → log in (no length gate; a wrong guess is a wrong password, not a 400)
      if (!p.passHash) return sendJson(res, 409, { error: 'That email is linked to Google sign-in — use the Google button.' });
      if (!checkPw(pw, p.passHash)) return sendJson(res, 401, { error: 'Wrong password.' });
      const current = authPlayer(req);
      if (current && current.id !== p.id && !current.email && !current.googleSub) mergePlayer(current, p);
    } else {
      // new account → register (enforce a minimum password here)
      if (pw.length < 6) return sendJson(res, 400, { error: 'Pick a password with at least 6 characters.' });
      const current = authPlayer(req);
      if (current && !current.email && !current.googleSub) p = current; // upgrade anon, keep record
      else p = createPlayer(b.name || email.split('@')[0]);
      p.email = email; p.passHash = hashPw(pw); p.emailVerified = false;
    }
    saveData();
    return sendJson(res, 200, selfPlayer(p));
  }

  // -------------------------------------------------------------------------
  // Leagues
  // -------------------------------------------------------------------------

  // POST /api/leagues  (create)
  if (req.method === 'POST' && parts[1] === 'leagues' && parts.length === 2) {
    const me = authPlayer(req); if (!me) return need401();
    const b = await readBody(req);
    if (!b.name) return sendJson(res, 400, { error: 'name required' });
    let code; do { code = newCode(); } while (db.leagues[code]);
    const league = { code, name: String(b.name).slice(0, 50), createdById: me.id, members: [{ id: me.id, name: me.name }], createdAt: new Date().toISOString() };
    db.leagues[code] = league;
    logEvent('league_created', { code });
    return sendJson(res, 201, leagueView(league));
  }

  // /api/leagues/:code[/join]
  if (parts[1] === 'leagues' && parts[2]) {
    const code = parts[2].toUpperCase();
    const league = db.leagues[code];
    if (!league) return sendJson(res, 404, { error: 'League not found' });
    if (req.method === 'GET' && !parts[3]) {
      return sendJson(res, 200, leagueView(league));
    }
    if (req.method === 'POST' && parts[3] === 'join') {
      const me = authPlayer(req); if (!me) return need401();
      if (!league.members.some((m) => m.id === me.id)) league.members.push({ id: me.id, name: me.name });
      logEvent('league_joined', { code });
      return sendJson(res, 200, leagueView(league));
    }
  }

  // -------------------------------------------------------------------------
  // Bets
  // -------------------------------------------------------------------------

  // POST /api/bets
  if (req.method === 'POST' && parts[1] === 'bets' && parts.length === 2) {
    const me = authPlayer(req); if (!me) return need401();
    const b = await readBody(req);
    if (!b.home || !b.away || !OUTCOMES.includes(b.backedOutcome))
      return sendJson(res, 400, { error: 'Missing or invalid fields' });
    const id = newId();
    const bet = {
      id, status: 'open',
      proposerId: me.id, proposerName: me.name, opponentId: null, opponentName: null,
      home: String(b.home).slice(0, 40), away: String(b.away).slice(0, 40),
      competition: b.competition ? String(b.competition).slice(0, 60) : '',
      utcDate: b.utcDate || null, externalId: b.externalId || null,
      backedOutcome: b.backedOutcome, stake: Math.max(0, Number(b.stake) || 0),
      currency: (b.currency || 'EUR').slice(0, 4),
      note: b.note ? String(b.note).slice(0, 140) : '',
      createdAt: new Date().toISOString(),
    };
    db.bets[id] = bet;
    logEvent('bet_created', { id, rematch: Boolean(b.rematch) });
    return sendJson(res, 201, bet);
  }

  // /api/bets/:id[/action]
  if (parts[1] === 'bets' && parts[2]) {
    const bet = db.bets[parts[2]];
    if (!bet) return sendJson(res, 404, { error: 'Bet not found' });
    const action = parts[3];

    if (req.method === 'GET' && !action) {
      // public view (link possession is the capability) + lightweight social proof about the
      // proposer for cold visitors — aggregate counts only, no private record
      const ps = playerSummary(bet.proposerId);
      return sendJson(res, 200, { ...bet, proposerStats: { duels: ps.w + ps.l, streakType: ps.streak.type, streakCount: ps.streak.count } });
    }

    if (req.method === 'POST' && action === 'accept') {
      const me = authPlayer(req); if (!me) return need401();
      if (bet.status !== 'open') return sendJson(res, 409, { error: 'Bet already taken' });
      if (me.id === bet.proposerId) return sendJson(res, 409, { error: "That's your own bet — send the link to a mate to take the other side." });
      // no accepting after kickoff — otherwise a mate can wait for the result and only take winners
      if (bet.utcDate && Date.now() > new Date(bet.utcDate).getTime()) {
        return sendJson(res, 409, { error: 'Too late — this match has already kicked off. Start a fresh bet.' });
      }
      bet.opponentId = me.id;
      bet.opponentName = me.name;
      bet.status = 'accepted';
      bet.acceptedAt = new Date().toISOString();
      logEvent('bet_accepted', { id: bet.id });
      return sendJson(res, 200, bet);
    }

    if (req.method === 'POST' && action === 'resolve') {
      const me = authPlayer(req); if (!me) return need401();
      if (me.id !== bet.proposerId && me.id !== bet.opponentId) return sendJson(res, 403, { error: 'Only a player in this bet can report the result.' });
      if (bet.status === 'open') return sendJson(res, 409, { error: 'Nobody has taken this bet yet' });
      if (bet.status === 'void') return sendJson(res, 409, { error: 'This bet was voided — it no longer counts.' });
      if (bet.status !== 'accepted') return sendJson(res, 409, { error: 'Already resolved' });
      const b = await readBody(req);
      // trusted auto-resolution when a results API is configured — no confirmation needed
      if (FOOTBALL_TOKEN && bet.externalId) {
        try {
          const live = await fetchLiveResult(bet.externalId);
          if (live) { resolveBet(bet, live); delete bet.pendingResult; logEvent('bet_resolved', { id: bet.id, auto: true }); return sendJson(res, 200, bet); }
          if (!b.actualOutcome) return sendJson(res, 409, { error: 'Match not finished yet' });
        } catch (e) { console.warn('live result failed:', e.message); }
      }
      if (!OUTCOMES.includes(b.actualOutcome)) return sendJson(res, 400, { error: 'Provide the final result' });
      // manual: a participant reports, the OTHER player must confirm before it's final (anti-cheat)
      const prev = bet.pendingResult;
      if (prev && prev.byId !== me.id) {
        if (prev.outcome === b.actualOutcome) {
          // both players independently reported the same result → it's settled
          resolveBet(bet, b.actualOutcome); delete bet.pendingResult; delete bet.disputed;
          logEvent('bet_resolved', { id: bet.id });
          return sendJson(res, 200, bet);
        }
        // the two players disagree → flag a dispute (resolved via /void, not a forced result)
        bet.disputed = { claims: [{ outcome: prev.outcome, by: prev.by, byId: prev.byId }, { outcome: b.actualOutcome, by: me.name, byId: me.id }] };
        bet.pendingResult = { outcome: b.actualOutcome, byId: me.id, by: me.name };
        saveData();
        return sendJson(res, 200, bet);
      }
      bet.pendingResult = { outcome: b.actualOutcome, byId: me.id, by: me.name };
      delete bet.disputed;
      saveData();
      return sendJson(res, 200, bet);
    }

    if (req.method === 'POST' && action === 'confirm') {
      const me = authPlayer(req); if (!me) return need401();
      if (bet.status === 'void') return sendJson(res, 409, { error: 'This bet was voided — it no longer counts.' });
      if (bet.status !== 'accepted') return sendJson(res, 409, { error: 'Already resolved' });
      if (!bet.pendingResult || !OUTCOMES.includes(bet.pendingResult.outcome)) return sendJson(res, 409, { error: 'Nothing to confirm yet' });
      const counterpartyId = bet.pendingResult.byId === bet.proposerId ? bet.opponentId : bet.proposerId;
      if (me.id !== counterpartyId) return sendJson(res, 403, { error: 'Only the other player can confirm the result.' });
      // the confirmer must ratify the outcome they SAW — if the report changed underneath
      // them, force a re-render instead of silently resolving the swapped result
      const b = await readBody(req);
      if (b.outcome && b.outcome !== bet.pendingResult.outcome) {
        return sendJson(res, 409, { error: 'The report changed — check the new result before confirming.' });
      }
      resolveBet(bet, bet.pendingResult.outcome);
      delete bet.pendingResult;
      logEvent('bet_resolved', { id: bet.id });
      return sendJson(res, 200, bet);
    }

    if (req.method === 'POST' && action === 'settle') {
      const me = authPlayer(req); if (!me) return need401();
      if (me.id !== bet.proposerId && me.id !== bet.opponentId) return sendJson(res, 403, { error: 'Only a player in this bet can settle it.' });
      if (bet.status !== 'resolved') return sendJson(res, 409, { error: 'Not resolved yet' });
      bet.status = 'settled'; bet.settledAt = new Date().toISOString(); saveData();
      return sendJson(res, 200, bet);
    }

    // POST /api/bets/:id/void — a participant cancels an open bet or voids a disputed one
    // (voided bets never count toward the rivalry ledger). Can't void a settled result.
    if (req.method === 'POST' && action === 'void') {
      const me = authPlayer(req); if (!me) return need401();
      if (me.id !== bet.proposerId && me.id !== bet.opponentId) return sendJson(res, 403, { error: 'Only a player in this bet can void it.' });
      if (['resolved', 'settled', 'void'].includes(bet.status)) return sendJson(res, 409, { error: 'Nothing to void here.' });
      bet.status = 'void'; bet.voidedAt = new Date().toISOString(); bet.voidedBy = me.id;
      delete bet.pendingResult; delete bet.disputed;
      logEvent('bet_voided', { id: bet.id });
      saveData();
      return sendJson(res, 200, bet);
    }

    if (req.method === 'POST' && action === 'react') {
      const me = authPlayer(req); if (!me) return need401();
      const b = await readBody(req);
      const emoji = String(b.emoji || '').slice(0, 8);
      if (!emoji) return sendJson(res, 400, { error: 'emoji required' });
      if (!bet.reactions) bet.reactions = [];
      const idx = bet.reactions.findIndex((r) => r.byId === me.id && r.emoji === emoji);
      if (idx >= 0) bet.reactions.splice(idx, 1); else bet.reactions.push({ byId: me.id, by: me.name, emoji });
      logEvent('reaction', { id: bet.id }, false);
      saveData();
      return sendJson(res, 200, bet);
    }
  }

  return sendJson(res, 404, { error: 'Unknown endpoint' });
}

function serveLeagueCard(req, res, url) {
  const m = url.pathname.match(/^\/lcard\/([A-Z0-9]+)\.(svg|png)$/);
  if (!m) { res.writeHead(404); return res.end('Not found'); }
  const league = db.leagues[m[1]];
  if (!league) { res.writeHead(404); return res.end('No such league'); }
  const svg = leagueSvgFor(league);
  if (m[2] === 'svg') { res.writeHead(200, { 'Content-Type': 'image/svg+xml; charset=utf-8', 'Cache-Control': 'no-cache' }); return res.end(svg); }
  const png = cards.renderPng(svg);
  if (png) { res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-cache' }); return res.end(png); }
  res.writeHead(302, { Location: `/lcard/${m[1]}.svg` }); res.end();
}

function serveLeagueHtml(req, res, code) {
  fs.readFile(path.join(PUBLIC, 'index.html'), 'utf8', (err, html) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    const league = db.leagues[code];
    if (league) {
      logEvent('link_opened', { code, kind: 'league' }, false);
      const proto = req.headers['x-forwarded-proto'] || 'http';
      const origin = `${proto}://${req.headers.host}`;
      const title = `Join ${league.name} on Duely 🏆`;
      const desc = `${league.members.length} mate${league.members.length === 1 ? '' : 's'} settling football bets. Tap to join the league.`;
      const img = `${origin}/lcard/${code}.png`;
      const meta = `
    <meta property="og:type" content="website" />
    <meta property="og:site_name" content="Duely" />
    <meta property="og:title" content="${escHtml(title)}" />
    <meta property="og:description" content="${escHtml(desc)}" />
    <meta property="og:image" content="${escHtml(img)}" />
    <meta property="og:image:width" content="1200" />
    <meta property="og:image:height" content="630" />
    <meta property="og:url" content="${escHtml(origin + '/l/' + code)}" />
    <meta name="twitter:card" content="summary_large_image" />
    <meta name="twitter:title" content="${escHtml(title)}" />
    <meta name="twitter:description" content="${escHtml(desc)}" />
    <meta name="twitter:image" content="${escHtml(img)}" />
`;
      html = html.replace('</head>', meta + '  </head>');
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  });
}

// ---------------------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname === '/healthz') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('ok'); }
  if (url.pathname.startsWith('/api/')) {
    try { await handleApi(req, res, url); }
    catch (e) { console.error(e); sendJson(res, 500, { error: 'Server error' }); }
    return;
  }
  if (url.pathname.startsWith('/card/')) return serveCard(req, res, url);
  if (url.pathname.startsWith('/storycard/')) return serveStoryCard(req, res, url);
  if (url.pathname.startsWith('/lcard/')) return serveLeagueCard(req, res, url);
  // canonical share link (/b/:id) and legacy (/?b=:id) get OG meta injected
  const shareMatch = url.pathname.match(/^\/b\/([a-f0-9]+)$/);
  if (shareMatch) return serveShareHtml(req, res, shareMatch[1]);
  if (url.pathname === '/' && url.searchParams.get('b')) return serveShareHtml(req, res, url.searchParams.get('b'));
  const leagueMatch = url.pathname.match(/^\/l\/([a-zA-Z0-9]+)$/);
  if (leagueMatch) return serveLeagueHtml(req, res, leagueMatch[1].toUpperCase());
  serveStatic(req, res);
});

initData().then(() => {
  server.listen(PORT, () => {
    console.log(`\n  ${BRAND} running →  http://localhost:${PORT}`);
    console.log(`  Mode: ${FOOTBALL_TOKEN ? 'LIVE (football-data.org)' : 'DEMO (manual results)'}`);
    console.log(`  Login: ${GOOGLE_CLIENT_ID ? 'Google + email' : 'email only (set GOOGLE_CLIENT_ID for Google)'}`);
    console.log(`  Store: ${pool ? 'Postgres (durable)' : 'JSON file (' + DATA_FILE + ')'}\n`);
  });
}).catch((e) => { console.error('init failed:', e.message); process.exit(1); });

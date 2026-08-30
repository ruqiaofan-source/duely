'use strict';

/**
 * Clashly — social P2P football bet scorekeeper (v1)
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
const zlib = require('zlib');
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
const BRAND = 'Clashly';

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
let _decided = null; // memoized decided-bets list; invalidated on every save

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
  _decided = null;
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
  if (!db.terrace) db.terrace = [];
  // backfill founder seq for players created before it existed (join order)
  const ps = Object.values(db.players);
  let maxSeq = Math.max(0, ...ps.map((p) => p.seq || 0));
  ps.filter((p) => !p.seq).sort((a, b) => new Date(a.createdAt || 0) - new Date(b.createdAt || 0)).forEach((p) => { p.seq = ++maxSeq; });
  rebuildSecretIndex();
  seedHistory();
  demoHandoverReset();
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
// The only client events the server will record. Anything else is dropped.
// These are the steps the server genuinely cannot observe for itself — every
// one of them sits on a side of a known funnel leak.
const CLIENT_EVENTS = new Set([
  'onboard_view', 'onboard_done',      // landed → signed up
  'sheet_open', 'outcome_picked',      // signed up → started a call → picked a side
  'season_picked',                     // did anyone find season calls?
  'accept_view', 'accept_tap',         // saw a challenge → tapped take it (before the name ask)
  'settle_card_tap', 'brag_copy',      // the v14/v13 loops
  'table_send',                        // the v15 group-table share
  'weekly_view', 'weekly_call_tap', 'weekly_share',  // the v17 public weekly call
  'landing_call_tap', 'landing_door',                // the v22 turnstile landing
]);

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
  // seq = honest join order ("Founder #N") — never reused, never faked
  const seq = Math.max(0, ...Object.values(db.players).map((x) => x.seq || 0)) + 1;
  const p = { id, secret: newSecret(), name: String(name || '').slice(0, 40) || 'Player', seq, createdAt: new Date().toISOString() };
  db.players[id] = p;
  if (_secretIndex) _secretIndex[p.secret] = id;
  return p;
}
const playerByEmail = (email) => Object.values(db.players).find((p) => p.email && normEmail(p.email) === normEmail(email)) || null;
const playerByGoogle = (sub) => Object.values(db.players).find((p) => p.googleSub === sub) || null;
const nameOf = (id) => (db.players[id] ? db.players[id].name : null);
// what the owner gets back (includes the secret); everyone else gets publicPlayer
const selfPlayer = (p) => ({ id: p.id, name: p.name, secret: p.secret, seq: p.seq || null, email: p.email || null, verified: Boolean(p.emailVerified), hasPassword: Boolean(p.passHash), google: Boolean(p.googleSub) });

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
    headers: { 'X-Auth-Token': FOOTBALL_TOKEN }, signal: AbortSignal.timeout(5000),
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
    headers: { 'X-Auth-Token': FOOTBALL_TOKEN }, signal: AbortSignal.timeout(3000),
  });
  if (!res.ok) throw new Error(`football-data ${res.status}`);
  const json = await res.json();
  if (json.status !== 'FINISHED') return null;
  const w = json.score?.winner;
  return w === 'HOME_TEAM' ? 'HOME' : w === 'AWAY_TEAM' ? 'AWAY' : w === 'DRAW' ? 'DRAW' : null;
}
let _matchCache = { t: 0, data: null };
// tournament fixtures (World Cup / Euros knockouts) pin to the top of the picker —
// they're the highest-intent bets of the calendar; within each group, soonest first
const isTournament = (m) => /world cup|fifa|euro/i.test(m.competition || '');
const pinTournament = (list) => [...list].sort((a, b) => (isTournament(b) - isTournament(a)) || (new Date(a.utcDate || 0) - new Date(b.utcDate || 0)));
async function getMatches() {
  if (FOOTBALL_TOKEN) {
    if (_matchCache.data && Date.now() - _matchCache.t < 300000) return _matchCache.data; // 5-min cache to respect the 10/min upstream limit
    if (Date.now() - (_matchCache.failT || 0) < 60000) return _matchCache.data || demoMatches(); // failure negative-cache
    if (_matchCache.pending) return _matchCache.pending; // stampede guard: one upstream fetch at a time
    _matchCache.pending = (async () => {
      try {
        const live = await fetchLiveMatches();
        if (live.length) { _matchCache.t = Date.now(); _matchCache.data = pinTournament(live); return _matchCache.data; }
        _matchCache.failT = Date.now();
        return _matchCache.data || demoMatches(); // stale real fixtures beat demo ones
      } catch (e) {
        console.warn('live fetch failed:', e.message);
        _matchCache.failT = Date.now();
        return _matchCache.data || demoMatches();
      } finally { _matchCache.pending = null; }
    })();
    return _matchCache.pending;
  }
  return demoMatches();
}

// ---------------------------------------------------------------------------
// Bet logic
// ---------------------------------------------------------------------------
// A season-long call is a one-sided claim ("Arsenal finish above Spurs") with no
// away team and no fixture. Rather than invent a YES/NO axis and branch the ~65
// places that speak HOME/DRAW/AWAY, it rides the existing axis: HOME = the claim
// lands, AWAY = it doesn't, DRAW never offered. Every downstream surface —
// receipts, rivalry tables, the forfeit ledger — keeps working untouched.
const isSeason = (b) => Boolean(b) && b.kind === 'season';
const matchLabel = (b) => (isSeason(b) ? b.home : `${b.home} v ${b.away}`);
function outcomeLabel(bet, code) {
  if (isSeason(bet)) return code === 'HOME' ? 'Yes — it happens' : 'No chance';
  if (code === 'HOME') return `${bet.home} win`;
  if (code === 'AWAY') return `${bet.away} win`;
  if (code === 'DRAW') return 'Draw';
  return code;
}
const sym = (c) => (c === 'EUR' ? '€' : c === 'GBP' ? '£' : c === 'USD' ? '$' : c + ' ');
const abbr = (s) => (String(s || '').replace(/[^A-Za-z]/g, '').toUpperCase().slice(0, 3) || '?');
function complementLabel(bet) {
  if (isSeason(bet)) return bet.backedOutcome === 'HOME' ? "it doesn't happen" : 'it happens';
  if (bet.backedOutcome === 'DRAW') return "it's not a draw";
  if (bet.backedOutcome === 'HOME') return `${bet.home} don't win`;
  return `${bet.away} don't win`;
}
function notifyResolved(bet) {
  try {
    const label = matchLabel(bet);
    if (bet.owes) {
      sendPush(bet.owes.toId, { title: 'You WON 🏆', body: `${label} — ${bet.owes.from} owes you. Rub it in.`, url: '/b/' + bet.id });
      sendPush(bet.owes.fromId, { title: 'You lost 💀', body: `${label} — time to settle up with ${bet.owes.to}.`, url: '/b/' + bet.id });
    } else {
      sendPush(bet.proposerId, { title: 'Result is in', body: label, url: '/b/' + bet.id });
      if (bet.opponentId) sendPush(bet.opponentId, { title: 'Result is in', body: label, url: '/b/' + bet.id });
    }
  } catch {}
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
  // Arena incentive: beating a stranger from the open pool earns points (+3 win,
  // +1 for showing up) — fuel for the Arena crown on the dashboard.
  if (bet.arena) {
    const wp = db.players[winnerPid], lp = db.players[loserPid];
    if (wp) wp.arenaPts = (wp.arenaPts || 0) + 3;
    if (lp) lp.arenaPts = (lp.arenaPts || 0) + 1;
  }
  addPundit(bet, 'resolved');
  return bet;
}

// ---------------------------------------------------------------------------
// The Pundit — the house banter bot. ALWAYS labeled as a bot in the UI (bot:true);
// it gives every bet a voice from minute one without ever pretending to be a user.
// ---------------------------------------------------------------------------
const PUNDIT_POOLS = {
  created: [
    '{P} is backing {BACKED}. Big words. Someone take the other side before it goes to their head.',
    '{BACKED}, says {P}. The terrace awaits a challenger…',
    "Fresh duel on the board: {MATCHUP}. {P}'s called {BACKED} — who's got the minerals?",
    '{P} puts {STAKE} on {BACKED}. Talk is cheap until someone locks in.',
  ],
  accepted: [
    "It's ON. {P} says {BACKED}, {O} says no chance. {STAKE} on the line.",
    '{O} steps in. 90 minutes will sort this out. 🍿',
    'Handshakes done — {MATCHUP} just got personal.',
    'Locked: {P} vs {O}. The loser lives with it.',
  ],
  resolved: [
    'FT: {RESULT}. {WINNER} called it — {LOSER}, the terrace remembers. 📋',
    '{WINNER} takes it. {RIV}. Rematch, {LOSER}?',
    'Scenes. {WINNER} read it like a programme. {LOSER} owes the bragging rights.',
    'Full time: {RESULT}. {WINNER} eats first tonight. 🍽️',
  ],
};
function addPundit(bet, phase) {
  const pool = PUNDIT_POOLS[phase]; if (!pool) return;
  const winner = bet.winner === 'proposer' ? bet.proposerName : bet.opponentName;
  const loser = bet.winner === 'proposer' ? bet.opponentName : bet.proposerName;
  const ctx = {
    P: bet.proposerName, O: bet.opponentName || 'someone', HOME: bet.home, AWAY: bet.away, MATCHUP: matchLabel(bet),
    BACKED: outcomeLabel(bet, bet.backedOutcome), RESULT: bet.actualOutcome ? outcomeLabel(bet, bet.actualOutcome) : '',
    STAKE: stakeLabel(bet), WINNER: winner || '', LOSER: loser || '',
    RIV: (bet.proposerId && bet.opponentId) ? rivalryLine(bet) : '',
  };
  const pick = pool[(parseInt(bet.id.slice(0, 4), 16) + phase.length) % pool.length];
  if (!bet.comments) bet.comments = [];
  bet.comments.push({ byId: '__pundit', by: 'The Pundit', bot: true, text: pick.replace(/\{(\w+)\}/g, (_, k) => ctx[k] ?? ''), t: new Date().toISOString() });
}

// v10 — the Receipts Engine: on a rematch, the Pundit resurfaces the loser's
// old take verbatim. Screenshot culture, productized: the app is the receipt.
function lastSettledBetween(aId, bId, excludeId) {
  return Object.values(db.bets)
    .filter((b) => b.id !== excludeId && (b.status === 'resolved' || b.status === 'settled')
      && ((b.proposerId === aId && b.opponentId === bId) || (b.proposerId === bId && b.opponentId === aId)))
    .sort((x, y) => new Date(y.resolvedAt || y.createdAt) - new Date(x.resolvedAt || x.createdAt))[0] || null;
}
function addRematchReceipt(bet) {
  if (!bet.rematch || !bet.proposerId || !bet.opponentId) return;
  const prev = lastSettledBetween(bet.proposerId, bet.opponentId, bet.id);
  if (!prev || !prev.winner) return;
  const loser = prev.winner === 'proposer' ? prev.opponentName : prev.proposerName;
  const take = prev.winner === 'proposer' ? complementLabel(prev) : outcomeLabel(prev, prev.backedOutcome);
  const result = prev.actualOutcome ? outcomeLabel(prev, prev.actualOutcome) : '';
  if (!bet.comments) bet.comments = [];
  bet.comments.push({ byId: '__pundit', by: 'The Pundit', bot: true,
    text: `🔁 THE REMATCH. Last time ${loser} backed ${take}${result ? ` — FT: ${result}` : ''}. The terrace keeps receipts. 🧾`,
    t: new Date().toISOString() });
}

// ---------------------------------------------------------------------------
// Stats engine (records computed by player id; names are display only)
// ---------------------------------------------------------------------------
// QA ghosts: throwaway accounts used for live smoke tests. Their bets are real
// records but must never pollute public rankings, crowns, or results strips.
// QA accounts from live smoke tests must never reach a real user's leaderboard.
// The old pattern required trailing digits, so the 23-27 Aug audit accounts
// (AuditA_0823, LiveDeepB_f22a6, DeepC_1b4a49, ZzSweepQA) slipped through and sat
// on the public board with W-L records. Any future probe name MUST start with one
// of these stems — that is the contract, enforce it when writing tests.
const QA_GHOST = /^(ZqSmoke|ZvElev|XwProbe|XyElev|ZzTest|QaProbe|ZzSweep|XqSmoke|Audit[A-C]|LiveDeep[A-C]|Deep[A-C]|Smoke[A-C]|Probe[A-C])([_-]?[A-Za-z0-9]{0,12})?$/;
const isGhostBet = (b) => QA_GHOST.test(b.proposerName || '') || QA_GHOST.test(b.opponentName || '');
const decidedBets = () => (_decided ||= Object.values(db.bets).filter((b) => (b.status === 'resolved' || b.status === 'settled') && !isGhostBet(b)));
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

// v11 — gameweek arithmetic. Week index is days-since-a-known-Monday / 7
// (Jan 1 2024 was a Monday); monotonic, timezone-proof, no ISO-week edge cases.
const WEEK0 = Date.UTC(2024, 0, 1);
const weekIdx = (t) => Math.floor(((typeof t === 'number' ? t : new Date(t).getTime()) - WEEK0) / 604800000);
// consecutive gameweeks (ending this week or last) in which a pair had a live
// clash (accepted or beyond). THE rivalry-streak metric: miss a week, streak dies.
function pairWeekSet(idA, idB) {
  const weeks = new Set();
  for (const b of Object.values(db.bets)) {
    if (!['accepted', 'resolved', 'settled'].includes(b.status)) continue;
    if (!((b.proposerId === idA && b.opponentId === idB) || (b.proposerId === idB && b.opponentId === idA))) continue;
    weeks.add(weekIdx(b.acceptedAt || b.createdAt));
  }
  return weeks;
}
function pairWeekStreak(idA, idB) {
  const weeks = pairWeekSet(idA, idB);
  const cur = weekIdx(Date.now());
  let k = weeks.has(cur) ? cur : cur - 1, s = 0;
  while (weeks.has(k)) { s++; k--; }
  return s;
}

// the highest win streak ANY player has hit — a real, beatable platform record
function platformRecord() {
  const byPlayer = {};
  for (const b of decidedBets()) {
    for (const pid of [b.proposerId, b.opponentId]) {
      if (pid) (byPlayer[pid] = byPlayer[pid] || []).push(b);
    }
  }
  let best = null;
  for (const [pid, bets] of Object.entries(byPlayer)) {
    bets.sort((a, b) => new Date(a.resolvedAt || 0) - new Date(b.resolvedAt || 0));
    let run = 0, max = 0;
    for (const b of bets) { run = winnerId(b) === pid ? run + 1 : 0; if (run > max) max = run; }
    if (max >= 2 && (!best || max > best.count)) best = { name: nameOf(pid) || '?', count: max };
  }
  return best;
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
    .map((r) => { const nv = netView(r.nets); return { opponentId: r.opponentId, opponent: r.opponent, w: r.w, l: r.l, games: r.games, net: nv.net, currency: nv.currency, isRival: r.games >= 3, streakWeeks: pairWeekStreak(id, r.opponentId) }; })
    .sort((a, b) => b.games - a.games);
  // v11 — the Forfeit Ledger: resolved-but-unsettled forfeit lines are DEBTS on
  // the record. The app never enforces them; it just never forgets them.
  const forfeits = mine
    .filter((b) => b.status === 'resolved' && b.line && b.line.trim() && b.owes)
    .slice(0, 8)
    .map((b) => ({ betId: b.id, line: b.line, from: b.owes.from, to: b.owes.to, owedByMe: b.owes.fromId === id, since: b.resolvedAt }));
  const recent = mine.slice(0, 8).map((b) => ({
    id: b.id, home: b.home, away: b.away, kind: b.kind, opponent: nameForId(b, otherId(b, id)),
    won: winnerId(b) === id, amount: b.owes ? b.owes.amount : b.stake,
    currency: b.currency, status: b.status,
  }));
  const nv = netView(nets);
  const _p = db.players[id];
  return { id, name, w, l, net: nv.net, currency: nv.currency, streak, rivalries, recent, forfeits, arenaPts: (_p && _p.arenaPts) || 0, hasEmail: Boolean(_p && (_p.email || _p.emailVerified)) };
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
  // last few duels between the pair — the match-by-match history that makes the
  // rivalry a durable shared asset
  const recent = both.slice(0, 6).map((x) => ({
    id: x.id, home: x.home, away: x.away, kind: x.kind, resolvedAt: x.resolvedAt,
    aWon: winnerId(x) === idA, line: x.line || '', stake: x.stake, currency: x.currency,
  }));
  return { aId: idA, bId: idB, a: aName, b: bName, aWins, bWins, aNet: nv.net, games: both.length, currency: nv.currency, recent, streakWeeks: pairWeekStreak(idA, idB) };
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

// the league's fiercest rivalry — the most-played pair among members (banter strip)
function leagueBanter(league) {
  const ids = new Set(league.members.map((m) => m.id));
  const pairs = {};
  for (const b of decidedBets()) {
    if (!ids.has(b.proposerId) || !ids.has(b.opponentId)) continue;
    const k = [b.proposerId, b.opponentId].sort().join('|');
    if (!pairs[k]) pairs[k] = { a: b.proposerId, b: b.opponentId, games: 0 };
    pairs[k].games++;
  }
  const top = Object.values(pairs).sort((x, y) => y.games - x.games)[0];
  if (!top || top.games < 2) return null;
  return { a: nameOf(top.a) || '?', b: nameOf(top.b) || '?', games: top.games };
}

// shape a league for the API (denormalize member names off their player records)
function leagueView(league) {
  return {
    code: league.code, name: league.name,
    createdBy: nameOf(league.createdById) || null, // social proof on the join view
    members: league.members.map((m) => ({ id: m.id, name: nameOf(m.id) || m.name })),
    standings: leagueStandings(league),
    banter: leagueBanter(league),
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

// The weekly table image. The league page is a destination nobody visits; the
// group chat is where the season actually lives, so the table has to travel.
function tableSvgFor(league) {
  const rows = leagueStandings(league);
  const played = rows.filter((r) => r.games).length;
  const top = rows[0];
  const sub = !played ? 'No duels settled yet — someone start it'
    : rows.length > 1 && top.w === rows[1].w ? `${top.name} and ${rows[1].name} inseparable`
    : `${top.name} leads on ${top.w} ${top.w === 1 ? 'win' : 'wins'}`;
  return cards.tableSvg({
    NAME: league.name,
    WEEK: `MATCHWEEK ${weekIdx(Date.now()) - weekIdx(new Date(league.createdAt || Date.now()).getTime()) + 1}`,
    SUB: sub,
    ROWS: rows.map((r) => ({
      NAME: r.name,
      WL: `${r.w}-${r.l}`,
      NET: r.net ? (r.net > 0 ? '+' : '\u2212') + sym(r.currency || 'EUR') + Math.abs(r.net) : '—',
      POS: r.net > 0, NEG: r.net < 0,
    })),
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
// mask severe profanity in user text that becomes a PUBLIC shareable image (cards/OG).
// Deliberately conservative — banter like "you're getting schooled" must survive;
// only the words that make a card unshareable in a work chat get starred out.
const PROFANITY = /\b(fuck\w*|cunts?|niggers?|niggas?|faggots?|retards?|kankers?\w*)\b/gi;
const maskProfanity = (s) => String(s || '').replace(PROFANITY, (w) => w[0] + '*'.repeat(Math.max(1, w.length - 2)) + w[w.length - 1]);
// scale the hero line down so long names/teams never clip the card edge
// (Anton ≈ 0.52em average advance width)
const heroSize = (text, base, maxPx) => Math.min(base, Math.max(48, Math.floor(maxPx / (0.52 * Math.max(1, [...String(text)].length)))));
// what's on the line, as display text: the forfeit line if set, else the money stake,
// else pure bragging rights
const stakeLabel = (bet) => (bet.line && bet.line.trim()) ? trimCp(bet.line, 32) : (bet.stake > 0 ? sym(bet.currency) + bet.stake : 'bragging rights');

function cardSvgForBet(bet) {
  const data = {
    PROPOSER: bet.proposerName, HOME: bet.home, AWAY: bet.away,
    HOME_ABBR: abbr(bet.home), AWAY_ABBR: abbr(bet.away),
    COMP: bet.competition || 'Match', DATE: fmtDate(bet.utcDate),
    STAKE: stakeLabel(bet),
    BACKED: outcomeLabel(bet, bet.backedOutcome),
    COMPLEMENT: complementLabel(bet),
    NOTE: bet.note ? maskProfanity(trimCp(bet.note, 44)) : '',
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
      LOSER_TAKE: trimCp(bet.winner === 'proposer' ? complementLabel(bet) : outcomeLabel(bet, bet.backedOutcome), 26),
    });
    return cards.resultSvg(data);
  }
  // open + accepted share the challenge chassis; the badge/CTA reflect the state
  Object.assign(data, {
    BACKED_SIZE: heroSize(data.BACKED, 122, 1060),
    BADGE: bet.status === 'accepted' ? "BET'S ON" : 'OPEN BET',
    CTA_MAIN: bet.status === 'accepted' ? 'LOCKED IN' : 'TAKE THE OTHER SIDE',
    CTA_SUB: bet.status === 'accepted'
      ? `${bet.proposerName} v ${bet.opponentName} · ${stakeLabel(bet)} on it`
      : `you'd back ${complementLabel(bet)} · ${stakeLabel(bet)}`,
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
  return cards.storySvg({ BADGE: badge, HERO: hero, HERO_SIZE: heroSize(hero, 120, 940), SUB: sub, ACCENT: accent, HOME: bet.home, AWAY: bet.away, STAKE: stakeLabel(bet), FOOT: foot, ID: bet.id });
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
    // WhatsApp/Meta hard-cap the unfurl image at 600KB — over it, no preview shows.
    // Warn loudly if we ever approach it so a card redesign can't silently break shares.
    if (png.length > 500000) console.warn(`⚠️ card ${m[1]} PNG is ${(png.length / 1024 | 0)}KB — nearing WhatsApp's 600KB unfurl cap`);
    res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': cc });
    return res.end(png);
  }
  res.writeHead(302, { Location: `/card/${m[1]}.svg` }); res.end();
}

// v10 — the Receipt slip (settled bets only; the loser's take is the hero)
function receiptSvgForBet(bet) {
  const loser = bet.winner === 'proposer' ? bet.opponentName : bet.proposerName;
  const take = bet.winner === 'proposer' ? complementLabel(bet) : outcomeLabel(bet, bet.backedOutcome);
  return cards.receiptSvg({
    // a season claim is the whole line, so it gets the room a team name doesn't need
    HOME: trimCp(bet.home, isSeason(bet) ? 44 : 16), AWAY: trimCp(bet.away, 16),
    LOSER: trimCp(loser, 16), TAKE: trimCp(take, 24),
    RESULT: outcomeLabel(bet, bet.actualOutcome),
    RESULT_LABEL: isSeason(bet) ? 'HOW IT ENDED' : 'FULL TIME',
    STAKE: stakeLabel(bet), RIV: rivalryLine(bet),
    DATE: fmtDate(bet.resolvedAt || bet.createdAt), ID: bet.id,
  });
}
function serveReceipt(req, res, url) {
  const m = url.pathname.match(/^\/receipt\/([a-f0-9]+)\.(svg|png)$/);
  if (!m) { res.writeHead(404); return res.end('Not found'); }
  const bet = db.bets[m[1]];
  if (!bet || !(bet.status === 'resolved' || bet.status === 'settled')) { res.writeHead(404); return res.end('No receipt yet — the match has to finish first.'); }
  const svg = receiptSvgForBet(bet);
  const cc = 'public, max-age=31536000, immutable';
  if (m[2] === 'svg') { res.writeHead(200, { 'Content-Type': 'image/svg+xml; charset=utf-8', 'Cache-Control': cc }); return res.end(svg); }
  const png = cards.renderPng(svg);
  if (png) { res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': cc }); return res.end(png); }
  res.writeHead(302, { Location: `/receipt/${m[1]}.svg` }); res.end();
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

// One source of truth for unfurl tags — every scraper (WhatsApp, Facebook,
// Messenger, iMessage, Telegram, Discord, Slack, Twitter/X, LinkedIn) reads
// some subset of these, so we emit the full set. `img` is a PNG URL; alt is the
// human description of the card; `stamp` busts scraper caches when state changes.
function ogMeta({ title, desc, img, pageUrl, alt, stamp }) {
  const secure = img.replace(/^http:/, 'https:');
  const t = escHtml(title), d = escHtml(desc), a = escHtml(alt || title);
  return `
    <meta property="og:type" content="website" />
    <meta property="og:site_name" content="Clashly" />
    <meta property="og:title" content="${t}" />
    <meta property="og:description" content="${d}" />
    <meta property="og:image" content="${escHtml(img)}" />
    <meta property="og:image:secure_url" content="${escHtml(secure)}" />
    <meta property="og:image:type" content="image/png" />
    <meta property="og:image:width" content="1200" />
    <meta property="og:image:height" content="630" />
    <meta property="og:image:alt" content="${a}" />
    <meta property="og:url" content="${escHtml(pageUrl)}" />${stamp ? `\n    <meta property="og:updated_time" content="${escHtml(stamp)}" />` : ''}
    <meta name="twitter:card" content="summary_large_image" />
    <meta name="twitter:title" content="${t}" />
    <meta name="twitter:description" content="${d}" />
    <meta name="twitter:image" content="${escHtml(secure)}" />
    <meta name="twitter:image:alt" content="${a}" />
    <meta name="theme-color" content="#0A0E13" />
`;
}

function ogTextForBet(bet) {
  if (bet.status === 'void') {
    return {
      title: `${bet.proposerName}'s bet was called off`,
      desc: `This one didn't count. Start your own on Clashly.`,
    };
  }
  if (bet.status === 'resolved' || bet.status === 'settled') {
    const winner = winnerDisplayName(bet);
    return {
      title: `${winner} called it: ${outcomeLabel(bet, bet.actualOutcome)} ⚽`,
      desc: `${rivalryLine(bet)}. Settle it between yourselves. Back yourself on Clashly.`,
    };
  }
  if (bet.status === 'accepted') {
    // lead with the rivalry record when there is one — the strongest cold hook
    const rl = rivalryLine(bet);
    return {
      title: `${bet.proposerName} v ${bet.opponentName} — bet's on 🔒`,
      desc: `${rl}. ${matchLabel(bet)}: ${outcomeLabel(bet, bet.backedOutcome)} · ${stakeLabel(bet)} on the line. May the best mate win.`,
    };
  }
  return {
    // title carries the full hook: iMessage/Apple render ONLY og:title + og:image
    // (they drop og:description), so the matchup lives here, not just in desc.
    title: `${bet.proposerName} calls ${outcomeLabel(bet, bet.backedOutcome)} — ${matchLabel(bet)} 🤝`,
    desc: `${bet.note ? maskProfanity(bet.note) + ' — ' : ''}${stakeLabel(bet)} on the line. Take the other side (${complementLabel(bet)}) on Clashly.`,
  };
}

// A real, static, JS-free page — the highest-leverage GEO asset. AI answer engines
// (ChatGPT, Perplexity, Claude) read raw HTML, so this page states plainly what
// Clashly is, how to settle a bet, and that no money is held — the exact prose we
// want cited. Also a clean SEO landing for "settle a bet with a friend" queries.
// Homepage unfurl card (1200x630) — rendered once and cached. Branded floodlit
// look so a bare clashly.live link posted anywhere shows a proper preview.
let _homeOgPng = null;
const HOME_OG_SVG = `<svg viewBox="0 0 1200 630" xmlns="http://www.w3.org/2000/svg">
<defs>
<style>.anton{font-family:'Anton','Arial Narrow',Impact,sans-serif}.inter{font-family:'Inter',system-ui,sans-serif}</style>
<linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#0E141C"/><stop offset="1" stop-color="#0A0E13"/></linearGradient>
<radialGradient id="gl" cx="0.5" cy="0.0" r="0.9"><stop offset="0" stop-color="#14E0C8" stop-opacity="0.16"/><stop offset="1" stop-color="#14E0C8" stop-opacity="0"/></radialGradient>
<linearGradient id="duel" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#14E0C8"/><stop offset=".5" stop-color="#14E0C8"/><stop offset=".5" stop-color="#7C3AED"/><stop offset="1" stop-color="#7C3AED"/></linearGradient>
</defs>
<rect width="1200" height="630" fill="url(#bg)"/><rect width="1200" height="630" fill="url(#gl)"/>
<rect x="0" y="0" width="1200" height="8" fill="#14E0C8"/>
<g transform="translate(72,80) scale(0.62)"><rect width="100" height="100" rx="26" fill="#0E141C"/><path d="M49.4 19A31 31 0 0 0 49.4 81L49.4 68A18 18 0 0 1 49.4 32Z" fill="#14E0C8"/><path d="M50.6 19A31 31 0 0 1 74 30L64 39A18 18 0 0 0 50.6 32ZM74 70A31 31 0 0 1 50.6 81L50.6 68A18 18 0 0 0 64 61Z" fill="#7C3AED"/></g>
<text x="145" y="128" class="anton" font-size="46" fill="#F4F7FB" letter-spacing="1">CLASHLY</text>
<text x="147" y="156" class="inter" font-size="17" font-weight="700" fill="#14E0C8" letter-spacing="3">BACK YOURSELF.</text>
<text x="72" y="290" class="anton" font-size="82" fill="#F4F7FB">SETTLE THE BET.</text>
<text x="72" y="378" class="anton" font-size="82" fill="#14E0C8">ON THE RECORD.</text>
<text x="72" y="452" class="inter" font-size="27" font-weight="600" fill="#C7D0DB">Call the match · your mate takes the other side ·</text>
<text x="72" y="490" class="inter" font-size="27" font-weight="600" fill="#C7D0DB">the winner goes on the record.</text>
<rect x="72" y="536" width="360" height="60" rx="14" fill="#14E0C8"/>
<text x="252" y="575" class="inter" text-anchor="middle" font-size="23" font-weight="900" fill="#06140f">Start a duel  →</text>
<text x="470" y="574" class="inter" font-size="20" font-weight="700" fill="#7C8A9C">Free · no money held · 18+</text>
</svg>`;
function serveHomeOg(req, res) {
  if (!_homeOgPng) _homeOgPng = cards.renderPng(HOME_OG_SVG);
  if (_homeOgPng) { res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' }); return res.end(_homeOgPng); }
  res.writeHead(200, { 'Content-Type': 'image/svg+xml; charset=utf-8', 'Cache-Control': 'public, max-age=86400' }); res.end(HOME_OG_SVG);
}


// ---------------------------------------------------------------------------
// v13 — search + AI answer-engine surface. Before this the whole site was two
// indexed URLs (/ and /about), which is nothing to rank with. These pages are
// generated from the fixture list we already hold: one per upcoming match, in
// English and Polish, each one a landing page AND a loaded challenge starter
// (the CTA carries ?call=<id> so an arriving visitor is one tap from a duel).
// ---------------------------------------------------------------------------
const slugify = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const fixtureSlug = (m) => `${slugify(m.home)}-v-${slugify(m.away)}`;
const esc5 = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const PAGE_CSS = `:root{color-scheme:dark}body{margin:0;background:#0A0E13;color:#F4F7FB;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;line-height:1.65}.wrap{max-width:720px;margin:0 auto;padding:44px 20px 80px}h1{font-size:30px;line-height:1.15;letter-spacing:-.5px;margin:0 0 8px}h2{font-size:20px;margin:32px 0 8px}p,li{color:#C7D0DB;font-size:16px}a{color:#14E0C8}.lede{font-size:18px;color:#E8EDF4}.cta{display:inline-block;margin:22px 0;background:#14E0C8;color:#06140f;font-weight:800;text-decoration:none;padding:14px 22px;border-radius:12px}.tag{color:#14E0C8;font-weight:700;letter-spacing:2px;font-size:12px;text-transform:uppercase}.foot{margin-top:44px;padding-top:18px;border-top:1px solid #33414F;color:#7C8A9C;font-size:13px}.kick{color:#7C8A9C;font-size:14px;margin:0 0 18px}ul li{margin:6px 0}`;

function fixturePageHtml(m, lang) {
  const pl = lang === 'pl';
  const slug = fixtureSlug(m);
  const url = `https://clashly.live${pl ? '/pl' : ''}/call/${slug}`;
  const alt = `https://clashly.live${pl ? '' : '/pl'}/call/${slug}`;
  const when = m.utcDate ? new Date(m.utcDate).toUTCString().replace(' GMT', ' UTC') : '';
  const comp = m.competition || (pl ? 'Mecz' : 'Match');
  const title = pl
    ? `${m.home} - ${m.away}: obstaw z ziomkiem i zapisz wynik | Clashly`
    : `${m.home} v ${m.away}: call it, bet a mate, keep the receipts | Clashly`;
  const desc = pl
    ? `Kto ma racje w meczu ${m.home} - ${m.away}? Rzuc wyzwanie ziomkowi na Clashly: ty typujesz, on bierze druga strone, po meczu obaj potwierdzacie wynik. Bez stawek, bez nagrod, tylko honor.`
    : `Who is right about ${m.home} v ${m.away}? Challenge a mate on Clashly: you call it, they take the other side, and after full time you both confirm the result. No money held, just the record.`;
  const body = pl ? `
  <div class="tag">CLASHLY · ${esc5(comp)}</div>
  <h1>${esc5(m.home)} - ${esc5(m.away)}: kto ma racje?</h1>
  <p class="kick">${esc5(comp)}${when ? ' · ' + esc5(when) : ''}</p>
  <p class="lede">Kazdy ma zdanie na temat tego meczu, dopoki nie trzeba go zapisac. Wybierz strone, wyslij link ziomkowi, a po ostatnim gwizdku obaj potwierdzacie wynik. Zwyciezca ladduje w bilansie.</p>
  <a class="cta" href="/?call=${esc5(m.id)}">Typuj ${esc5(m.home)} - ${esc5(m.away)} →</a>
  <h2>Jak to dziala</h2>
  <ol><li><strong>Typujesz.</strong> Wybierasz wynik i to, co jest w grze: fant albo czysty honor.</li>
  <li><strong>Wysylasz link.</strong> Ziomek klika i bierze druga strone. Bez zakladania konta.</li>
  <li><strong>Rozliczacie.</strong> Po meczu obaj potwierdzacie wynik i bilans sie aktualizuje.</li></ol>
  <h2>Czy Clashly to bukmacher?</h2>
  <p>Nie. Clashly nie przyjmuje wplat, nie trzyma stawek i nie wyplaca nagrod. <strong>Brak stawek, brak nagrod</strong> — to licznik do pojedynkow miedzy znajomymi. 18+.</p>
  <h2>Inne mecze</h2>` : `
  <div class="tag">CLASHLY · ${esc5(comp)}</div>
  <h1>${esc5(m.home)} v ${esc5(m.away)}: who is right?</h1>
  <p class="kick">${esc5(comp)}${when ? ' · ' + esc5(when) : ''}</p>
  <p class="lede">Everyone has an opinion on this one until it is time to put it on the record. Call the outcome, send the link to whoever disagrees, and after full time you both confirm the result. The winner goes on the head-to-head record.</p>
  <a class="cta" href="/?call=${esc5(m.id)}">Call ${esc5(m.home)} v ${esc5(m.away)} →</a>
  <h2>How it works</h2>
  <ol><li><strong>Call it.</strong> Back an outcome and name what is on the line: a forfeit, or just bragging rights.</li>
  <li><strong>Send the link.</strong> Your mate taps it and takes the other side. No signup wall.</li>
  <li><strong>Settle it.</strong> After full time you both confirm the result and the rivalry table updates.</li></ol>
  <h2>Is Clashly a bookmaker?</h2>
  <p>No. Clashly holds no money, takes no stakes and pays no prizes. <strong>No stake, no prize</strong> — it is a scorekeeper for bets between friends. 18+.</p>
  <h2>Other matches</h2>`;
  const ld = {
    '@context': 'https://schema.org',
    '@graph': [
      { '@type': 'SportsEvent', name: `${m.home} v ${m.away}`, sport: 'Football',
        startDate: m.utcDate || undefined, url,
        homeTeam: { '@type': 'SportsTeam', name: m.home }, awayTeam: { '@type': 'SportsTeam', name: m.away } },
      { '@type': 'FAQPage', mainEntity: [
        { '@type': 'Question', name: pl ? `Jak obstawic ${m.home} - ${m.away} ze znajomym?` : `How do you bet on ${m.home} v ${m.away} with a friend?`,
          acceptedAnswer: { '@type': 'Answer', text: pl
            ? `Na Clashly typujesz wynik, wysylasz link ziomkowi, on bierze druga strone, a po meczu obaj potwierdzacie rezultat. Clashly nie trzyma pieniedzy.`
            : `On Clashly you call the outcome, send a challenge link to your friend, they take the other side, and after the match you both confirm the result. Clashly holds no money.` } },
      ] },
    ],
  };
  return `<!DOCTYPE html>
<html lang="${pl ? 'pl' : 'en'}"><head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${esc5(title)}</title>
<meta name="description" content="${esc5(desc)}" />
<link rel="canonical" href="${url}" />
<link rel="alternate" hreflang="${pl ? 'en' : 'pl'}" href="${alt}" />
<link rel="alternate" hreflang="x-default" href="https://clashly.live/call/${slug}" />
<link rel="icon" type="image/svg+xml" href="/favicon.svg" />
<meta property="og:type" content="article" />
<meta property="og:title" content="${esc5(title)}" />
<meta property="og:description" content="${esc5(desc)}" />
<meta property="og:url" content="${url}" />
<meta property="og:image" content="https://clashly.live/og-home.png" />
<meta name="twitter:card" content="summary_large_image" />
<script type="application/ld+json">${JSON.stringify(ld)}</script>
<style>${PAGE_CSS}</style>
</head><body><div class="wrap">${body}
  <ul id="others"></ul>
  <p><a href="/">${pl ? 'Wroc na Clashly' : 'Back to Clashly'} →</a> · <a href="/about">${pl ? 'Czym jest Clashly?' : 'What is Clashly?'}</a></p>
  <div class="foot">Clashly ${pl ? 'nie trzyma pieniedzy — rozliczacie sie miedzy soba. 18+.' : 'holds no money — you settle up between yourselves. For the bragging rights. 18+.'}<br />contact@clashly.live · <a href="https://x.com/clashlylive" rel="me noopener">@clashlylive</a></div>
</div>
<script>fetch('/api/matches').then(r=>r.json()).then(d=>{const s=(x)=>x.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'').replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'');const o=document.getElementById('others');(d.matches||[]).filter(x=>x.id!==${JSON.stringify(m.id)}).slice(0,6).forEach(x=>{const li=document.createElement('li');const a=document.createElement('a');a.href='${pl ? '/pl' : ''}/call/'+s(x.home)+'-v-'+s(x.away);a.textContent=x.home+' v '+x.away;li.appendChild(a);o.appendChild(li);});});</script>
</body></html>`;
}


// ---------------------------------------------------------------------------
// v13.1 — evergreen guide pages. The /call/:fixture pages expire with their
// kickoffs; these target the durable question queries ("how do you settle a
// bet with a friend", "what should the loser do") that stay searched all
// season. Static content, served with the same CSS as the fixture pages.
// ---------------------------------------------------------------------------
const GUIDES = {
  '/how-to-settle-a-bet-with-a-friend': {
    lang: 'en',
    title: 'How to settle a bet with a friend (and keep the friend) | Clashly',
    desc: 'The five rules for settling a bet with a friend: agree the terms before kickoff, write it down, confirm the result together, keep the stakes silly, and keep the receipts. Free, no money involved.',
    h1: 'How to settle a bet with a friend',
    body: `
  <p class="lede">Every friend group has one unsettled bet that still comes up years later. The argument is never about the football. It is about what was actually agreed. Here is how to do it properly.</p>
  <h2>1. Agree the terms before kickoff</h2>
  <p>The call, the other side, and what is on the line, all fixed before the match starts. "I bet you City win" is not a bet until someone takes the other side and both of you know what the loser owes. After kickoff, no changes.</p>
  <h2>2. Write it down where you both can see it</h2>
  <p>This is where every friendly bet dies. Nobody writes it down, and three weeks later one of you remembers a tenner and the other remembers "a pint, maybe". Put it in writing in a place neither of you can edit alone. A scorekeeper app like <a href="/">Clashly</a> exists for exactly this: you call it, your mate taps a link to take the other side, and the terms are frozen from that moment.</p>
  <h2>3. Both confirm the result</h2>
  <p>The fairest rule in betting between friends: neither side can settle the bet alone. After full time, one of you reports the result and the other confirms it. If you genuinely disagree, the bet is void and nobody wins. Sounds soft, but it is the rule that makes the record impossible to cheat, which is what makes the record worth having.</p>
  <h2>4. Keep the stakes silly</h2>
  <p>Money between friends gets awkward fast. Forfeits do not. Loser buys the pints, loser wears the winner's shirt, loser posts a public apology in the group chat. A forfeit gets funnier with time; a fiver gets forgotten. If you need ideas, there is a <a href="/forfeit-ideas-for-friendly-bets">full list of forfeit ideas here</a>.</p>
  <h2>5. Keep the receipts</h2>
  <p>The whole point of a bet with a mate is being able to bring it up later. A running head to head record, who called what, who bottled it, who has paid up and who still owes. That is the difference between an argument and a rivalry.</p>
  <h2>Frequently asked</h2>
  <h3>Is betting with a friend legal?</h3>
  <p>A private bet between friends with no bookmaker, no commission and nobody taking a cut is a personal arrangement in most places. Clashly holds no money at all, no stakes, no prizes, no payouts, so it is a scorekeeper, not gambling. It is for people 18 and over.</p>
  <h3>Does Clashly handle the money?</h3>
  <p>No, never. Whatever you put on the line is settled between the two of you. Clashly keeps the score and the receipts.</p>
  <h3>What if my mate denies the result?</h3>
  <p>Then the bet is voided and it goes down as nobody's win. In practice this almost never happens, because denying an obvious result in front of your own group chat costs more pride than the forfeit.</p>`,
    faq: [
      ['Is betting with a friend legal?', 'A private bet between friends with no bookmaker and nobody taking a cut is a personal arrangement in most places. Clashly holds no money at all, so it is a scorekeeper, not gambling. 18+.'],
      ['How do you keep a friendly bet fair?', 'Agree the terms before kickoff, record them where neither side can edit alone, and require both sides to confirm the result. If you disagree, the bet is void.'],
      ['What should the loser of a friendly bet do?', 'A forfeit beats money between friends: loser buys the pints, wears the winner’s shirt, or posts a public apology in the group chat.'],
    ],
  },
  '/forfeit-ideas-for-friendly-bets': {
    lang: 'en',
    title: 'Forfeit ideas for friendly bets: what the loser owes | Clashly',
    desc: 'Twenty forfeit ideas for bets with your mates, from loser buys the pints to wearing the rival shirt at the next watch-along. No money needed, just consequences.',
    h1: 'Forfeit ideas: what to put on the line',
    body: `
  <p class="lede">Money is the worst stake for a bet between mates. It gets awkward, it gets forgotten, and it is never funny. A good forfeit is the opposite: cheap, public, and impossible to live down. Steal from this list.</p>
  <h2>The classics</h2>
  <ul>
    <li>Loser buys the pints. The original and still the best.</li>
    <li>Loser buys the kebabs after the next five-a-side.</li>
    <li>Loser gets the breakfast in on matchday.</li>
    <li>Loser pays for the next month of the five-a-side pitch.</li>
  </ul>
  <h2>Public consequences</h2>
  <ul>
    <li>Loser wears the winner's shirt for a full day, photos required.</li>
    <li>Loser posts a public apology in the group chat, wording chosen by the winner.</li>
    <li>Winner picks the loser's profile picture for a week.</li>
    <li>Loser has to call the winner "gaffer" for a week, in person and in the chat.</li>
    <li>Loser's next status or story is written by the winner.</li>
  </ul>
  <h2>Effort forfeits</h2>
  <ul>
    <li>Loser carries the bags and cones at five-a-side for a month.</li>
    <li>Loser is the designated driver for the next away day.</li>
    <li>Loser does goal-of-the-month editing duty for the group.</li>
    <li>Loser brings the half-time oranges, actual oranges, sliced.</li>
  </ul>
  <h2>Football-specific pain</h2>
  <ul>
    <li>Loser wears the winner's club colours at the next watch-along.</li>
    <li>Loser has to publicly rate the winner's rival team 10/10 in the chat.</li>
    <li>Loser sings the winner's club anthem on voice note, sent to the group.</li>
    <li>Season-long version: loser wears the shirt at the derby. Reserve for big calls.</li>
  </ul>
  <h2>The rules that make forfeits work</h2>
  <p>Agree it before kickoff, keep it legal and keep it kind, set a deadline for paying up, and record it somewhere neither of you can edit alone. <a href="/">Clashly</a> tracks the forfeit on every bet and keeps an unpaid-forfeits ledger, so "I'll do it next week" has nowhere to hide. And if you are not sure how to run the bet itself, start with <a href="/how-to-settle-a-bet-with-a-friend">how to settle a bet with a friend</a>.</p>`,
    faq: [
      ['What is a good forfeit for a friendly bet?', 'The best forfeits are cheap, public and time-boxed: loser buys the pints, wears the winner’s shirt for a day, or posts an apology in the group chat with wording chosen by the winner.'],
      ['Should friends bet money on football?', 'Money between friends gets awkward and forgotten. Forfeits are funnier, cost nothing, and get better with retelling. If you do use money, keep it small and settle fast.'],
    ],
  },
  '/pl/jak-rozliczyc-zaklad-ze-znajomym': {
    lang: 'pl',
    title: 'Jak rozliczyć zakład ze znajomym (i nie stracić kumpla) | Clashly',
    desc: 'Pięć zasad zakładów między znajomymi: warunki przed meczem, zapis którego nikt sam nie zmieni, wspólne potwierdzenie wyniku i fant zamiast pieniędzy. Bez stawek, bez nagród.',
    h1: 'Jak rozliczyć zakład ze znajomym',
    body: `
  <p class="lede">W każdej paczce jest jeden nierozliczony zakład, o którym kłótnia trwa latami. Nigdy nie chodzi o mecz. Chodzi o to, co naprawdę było ustalone. Oto jak to zrobić porządnie.</p>
  <h2>1. Warunki przed pierwszym gwizdkiem</h2>
  <p>Typ, druga strona i to, co jest w grze, wszystko ustalone przed meczem. Po gwizdku żadnych zmian.</p>
  <h2>2. Zapisz to tam, gdzie obaj widzicie</h2>
  <p>Na tym umierają zakłady między kumplami: nikt nic nie zapisuje i po trzech tygodniach jeden pamięta dychę, a drugi "no może piwo". <a href="/">Clashly</a> istnieje dokładnie po to: typujesz, kumpel klika link i bierze drugą stronę, warunki zamrożone.</p>
  <h2>3. Wynik potwierdzacie obaj</h2>
  <p>Najuczciwsza zasada: nikt nie rozlicza zakładu sam. Jeden zgłasza wynik, drugi potwierdza. Spór oznacza unieważnienie i nikt nie wygrywa. To właśnie dlatego bilansu nie da się oszukać.</p>
  <h2>4. Fant zamiast pieniędzy</h2>
  <p>Pieniądze między znajomymi robią się niezręczne. Fanty nie. Przegrany stawia piwo, nosi koszulkę zwycięzcy, publicznie przeprasza na grupie, śpiewa hymn klubu rywala na głosówce. Fant z czasem robi się śmieszniejszy; dycha idzie w zapomnienie.</p>
  <h2>5. Trzymaj paragony</h2>
  <p>Cały sens zakładu z kumplem to móc go wypomnieć. Bilans głowa w głowę, kto co typował, kto zbottlował, kto spłacił fant a kto dalej wisi. To różnica między kłótnią a rywalizacją.</p>
  <h2>Częste pytania</h2>
  <h3>Czy to legalne?</h3>
  <p>Prywatny zakład między znajomymi bez bukmachera i bez prowizji to prywatna umowa. Clashly nie trzyma żadnych pieniędzy: <strong>brak stawek, brak nagród</strong>, to licznik wyników, nie hazard. 18+.</p>
  <h3>Czy Clashly obsługuje pieniądze?</h3>
  <p>Nie, nigdy. Cokolwiek jest w grze, rozliczacie między sobą. Clashly trzyma wynik i paragony.</p>`,
    faq: [
      ['Czy zakład ze znajomym jest legalny?', 'Prywatny zakład między znajomymi bez bukmachera i prowizji to prywatna umowa. Clashly nie trzyma pieniędzy, brak stawek i brak nagród, więc to licznik, nie hazard. 18+.'],
      ['Co powinien zrobić przegrany?', 'Fant zamiast pieniędzy: przegrany stawia piwo, nosi koszulkę zwycięzcy albo publicznie przeprasza na grupie.'],
    ],
  },
};


async function serveWeekCard(req, res) {
  const w = await getWeekly(weekIdx(Date.now()));
  if (!w) { res.writeHead(404); return res.end('Not found'); }
  const t = weeklyTally(w);
  const svg = cards.weekCardSvg({
    HOME: w.home, AWAY: w.away, H: t.HOME, D: t.DRAW, A: t.AWAY, TOTAL: t.total,
    META: [w.competition, w.result ? 'FULL TIME' : (w.utcDate ? new Date(w.utcDate).toUTCString().slice(0, 16) : '')]
      .filter(Boolean).join('  \u00b7  '),
  });
  if (/\.svg$/.test(req.url.split('?')[0])) {
    res.writeHead(200, { 'Content-Type': 'image/svg+xml; charset=utf-8', 'Cache-Control': 'no-cache' });
    return res.end(svg);
  }
  const png = cards.renderPng(svg);
  if (png) { res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=300' }); return res.end(png); }
  res.writeHead(302, { Location: '/weekcard.svg' }); res.end();
}


// /arcade — the skill games. Everything inline, no dependencies, mobile-first.
// ---------------------------------------------------------------------------
// The Arcade — hub + game pages (design: Clashly Screens v22)
// Each game is its own server-rendered page: shareable URL, no app shell, no
// account. The client only ever reports "which game, what score" — the server
// clamps everything (see arcadeAward).
// ---------------------------------------------------------------------------
const ARCADE_FONTS = `<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Anton&family=Inter:wght@400;600;700;800;900&display=swap" />`;
const ARCADE_CSS = `${PAGE_CSS}
.wk{max-width:430px;padding-top:26px}
.ghead{display:flex;align-items:center;margin:0 0 14px}
.gback{width:34px;font-size:24px;color:#7C8A9C;text-decoration:none;line-height:1}
.gtitle{flex:1;text-align:center}
.gtitle b{display:block;font-family:Anton,Impact,sans-serif;font-weight:400;font-size:19px;letter-spacing:1px}
.gtitle span{display:block;font:700 10px Inter,system-ui,sans-serif;letter-spacing:3px;color:#14E0C8;margin-top:2px}
.gcard{background:linear-gradient(180deg,#141C29,#0F1520);border:1px solid rgba(255,255,255,.07);border-radius:18px;padding:16px;margin:0 0 14px}
.gname{font-family:Anton,Impact,sans-serif;font-weight:400;font-size:22px;margin:0 0 2px;color:#F4F7FB}
.gsub{font-size:12.5px;color:#7C8A9C;margin:0 0 12px}
.stat{font-size:13px;color:#9AA7B8;font-weight:700;margin:10px 0 0}
.stat b{color:#14E0C8}
.gbtn{display:block;width:100%;padding:14px;border-radius:12px;border:0;background:linear-gradient(180deg,#2BEAD4,#12CDB7);color:#052220;font:800 15px Inter,system-ui,sans-serif;letter-spacing:.5px;cursor:pointer;margin-top:12px;box-shadow:0 6px 18px rgba(20,224,200,.28)}
.gbtn[disabled]{opacity:.45}
.gbtn.vio{background:linear-gradient(180deg,#8B4DF5,#6D2FD6);color:#F2ECFF;box-shadow:0 6px 18px rgba(124,58,237,.35)}
.pill-pts{display:inline-block;font:700 11px Inter,system-ui,sans-serif;letter-spacing:1px;color:#14E0C8;border:1px solid rgba(20,224,200,.4);border-radius:999px;padding:5px 14px}
.note{font-size:12.5px;color:#5E6B7C}`;
function arcadePage({ path, title, kicker, metaTitle, desc, body, script, extraCss = '' }) {
  const url = 'https://clashly.live' + path;
  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${metaTitle}</title>
<meta name="description" content="${desc}" />
<link rel="canonical" href="${url}" />
<link rel="icon" type="image/svg+xml" href="/favicon.svg?v=3" />
<meta property="og:type" content="website" />
<meta property="og:title" content="${metaTitle}" />
<meta property="og:description" content="${desc}" />
<meta property="og:url" content="${url}" />
<meta property="og:image" content="https://clashly.live/og-home.png" />
${ARCADE_FONTS}
<style>${ARCADE_CSS}${extraCss}</style>
</head><body><div class="wrap wk">
  <div class="ghead">
    <a class="gback" href="/arcade" aria-label="Back to the Arcade">‹</a>
    <div class="gtitle"><b>${title}</b><span>${kicker}</span></div>
    <div style="width:34px"></div>
  </div>
  ${body}
  <div class="foot">Clashly holds no money, takes no stake and gives no prize. For the bragging rights. 18+.<br />contact@clashly.live &middot; <a href="https://x.com/clashlylive" rel="me noopener">@clashlylive</a> &middot; <a href="/credits.html">photo credits</a></div>
</div>
<script>
(function(){
  var KEY='clashly_voter';
  var v=null; try{ v=localStorage.getItem(KEY); if(!v){ v='v'+Math.random().toString(36).slice(2)+Date.now().toString(36); localStorage.setItem(KEY,v);} }catch(e){ v='v'+Date.now().toString(36); }
  function submit(game, score, cb){
    fetch('/api/arcade/score',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({game:game,score:score,v:v})})
      .then(function(r){return r.json();}).then(function(d){ if(cb) cb(d); }).catch(function(){ if(cb) cb(null); });
  }
${script}
})();
</script>
</body></html>`;
}

async function serveArcade(req, res) {
  const board = weeklyBoard(3);
  const url = 'https://clashly.live/arcade';
  const rankCol = ['#A78BFA', '#14E0C8', 'rgba(233,238,243,.6)'];
  const tile = (href, emoji, name, sub, pts, col) => `
    <a href="${href}" style="display:flex;flex-direction:column;gap:5px;background:linear-gradient(180deg,#141C29,#0F1520);border:1px solid rgba(255,255,255,.08);border-radius:16px;padding:15px;text-decoration:none;color:#E9EEF3">
      <span style="font-size:25px">${emoji}</span>
      <span style="font-family:Anton,Impact,sans-serif;font-size:16px;letter-spacing:.6px">${name}</span>
      <span style="font-size:12px;color:rgba(233,238,243,.55)">${sub}</span>
      <span style="font:700 10px Inter,system-ui,sans-serif;letter-spacing:1px;color:${col};border:1px solid ${col}66;border-radius:999px;padding:3px 9px;align-self:flex-start;margin-top:3px">UP TO +${pts} PTS</span>
    </a>`;
  const html = `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>The Arcade — skill games for the board | Clashly</title>
<meta name="description" content="Football skill games, no account needed. Points go on the same public board as your match calls. Free, no money, no prizes." />
<link rel="canonical" href="${url}" />
<link rel="icon" type="image/svg+xml" href="/favicon.svg?v=3" />
<meta property="og:type" content="website" />
<meta property="og:title" content="The Clashly Arcade" />
<meta property="og:description" content="Penalty timing, keepy-uppy, transfer-fee streaks and the daily career puzzle. Points go on the board. Free, no money, no prizes." />
<meta property="og:url" content="${url}" />
<meta property="og:image" content="https://clashly.live/og-home.png" />
${ARCADE_FONTS}
<style>${ARCADE_CSS}</style>
</head><body><div class="wrap wk">
  <div style="display:flex;align-items:center;gap:11px;margin:0 0 16px">
    <svg style="width:40px;height:40px;flex:none;border-radius:11px" viewBox="0 0 100 100" aria-hidden="true"><rect width="100" height="100" rx="26" fill="#0E141C"/><path d="M49.4 19A31 31 0 0 0 49.4 81L49.4 68A18 18 0 0 1 49.4 32Z" fill="#14E0C8"/><path d="M50.6 19A31 31 0 0 1 74 30L64 39A18 18 0 0 0 50.6 32ZM74 70A31 31 0 0 1 50.6 81L50.6 68A18 18 0 0 0 64 61Z" fill="#7C3AED"/></svg>
    <div><div style="font-family:Anton,Impact,sans-serif;font-size:23px;letter-spacing:.5px;line-height:1">THE ARCADE</div><div class="tag" style="margin:2px 0 0">SKILL IN, POINTS OUT</div></div>
  </div>

  <div class="gcard">
    <div style="display:flex;align-items:baseline;justify-content:space-between">
      <div style="font:700 13px Inter,system-ui,sans-serif" id="capTxt">points bank today</div>
      <div style="font-family:Anton,Impact,sans-serif;font-size:14px;color:#FFC83D" id="capPts"></div>
    </div>
    <div style="height:8px;border-radius:999px;background:rgba(255,255,255,.08);margin-top:10px;overflow:hidden">
      <div id="capBar" style="width:0%;height:100%;border-radius:999px;background:linear-gradient(90deg,#D99A2B,#FFD883);transition:width .5s"></div>
    </div>
    ${board.length ? `<div style="display:flex;align-items:center;gap:13px;margin-top:14px;padding-top:12px;border-top:1px solid rgba(255,255,255,.07);flex-wrap:wrap">
      <span style="font:700 10px Inter,system-ui,sans-serif;letter-spacing:2px;color:rgba(233,238,243,.5)">BOARD</span>
      ${board.map((b, i) => `<span style="font:600 12px Inter,system-ui,sans-serif;color:${rankCol[i]}">${i + 1} ${esc5(b.name)} ${b.points}</span>`).join('')}
      <a href="/board" style="font:600 11px Inter,system-ui,sans-serif;color:#7C8A9C;margin-left:auto;text-decoration:none">all →</a>
    </div>` : ''}
  </div>

  <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
    ${tile('/penalty', '⚽', 'PENALTY SWEEP', 'beat the sweep', 15, '#14E0C8')}
    ${tile('/keepy', '🤹', 'KEEPY-UPPY', "don't let it drop", 15, '#A78BFA')}
    ${tile('/hilo', '📈', 'HIGHER OR LOWER', 'streak the transfer fees', 12, '#FFC83D')}
    ${tile('/daily', '🎯', 'THE DAILY', 'one career a day', 8, '#14E0C8')}
    <div style="grid-column:1 / -1;display:flex;align-items:center;gap:14px;background:linear-gradient(180deg,#141C29,#0F1520);border:1px dashed rgba(167,139,250,.4);border-radius:16px;padding:15px;opacity:.75">
      <span style="font-size:25px">⚔️</span>
      <div><div style="font-family:Anton,Impact,sans-serif;font-size:16px;letter-spacing:.6px">GRID DUEL</div>
      <div style="font-size:12px;color:rgba(233,238,243,.55)">argue it with a mate — in the workshop</div></div>
      <span style="margin-left:auto;font:700 10px Inter,system-ui,sans-serif;letter-spacing:1px;color:#A78BFA;border:1px solid rgba(167,139,250,.4);border-radius:999px;padding:3px 9px">SOON</span>
    </div>
  </div>

  <p class="note" style="margin:16px 0 0">Points land on the same board as your match calls — up to 30 a day, no account needed.</p>
  <a class="cta" href="/this-week" style="display:block;text-align:center;margin-top:14px">📣 Call the weekend's matches →</a>
  <div class="foot">Clashly holds no money, takes no stake and gives no prize. For the bragging rights. 18+.<br />contact@clashly.live &middot; <a href="https://x.com/clashlylive" rel="me noopener">@clashlylive</a> &middot; <a href="/credits.html">photo credits</a></div>
</div>
<script>
(function(){
  var KEY='clashly_voter';
  var v=null; try{ v=localStorage.getItem(KEY); if(!v){ v='v'+Math.random().toString(36).slice(2)+Date.now().toString(36); localStorage.setItem(KEY,v);} }catch(e){ v='v'+Date.now().toString(36); }
  fetch('/api/arcade?v='+encodeURIComponent(v)).then(function(r){return r.json();}).then(function(d){
    document.getElementById('capTxt').textContent = d.today>=d.cap ? 'daily cap reached — back tomorrow' : d.today+' of '+d.cap+' banked today';
    document.getElementById('capPts').textContent = d.allTime ? d.allTime+' PTS ALL TIME' : '';
    document.getElementById('capBar').style.width = Math.min(100, Math.round(d.today/d.cap*100))+'%';
  }).catch(function(){});
})();
</script>
</body></html>`;
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
  res.end(html);
}

async function servePenalty(req, res) {
  const body = `
  <div class="gcard">
    <h2 class="gname">Penalty Sweep ⚽</h2>
    <p class="gsub">The marker sweeps the goal. Tap SHOOT when it's inside the zone. Five kicks, the zone shrinks.</p>
    <div class="goal" id="goal"><div class="zone" id="zone"></div><div class="marker" id="marker"></div></div>
    <div class="kicks" id="kicks"></div>
    <button class="gbtn" id="shoot">SHOOT</button>
    <div class="stat" id="pstat"></div>
  </div>
  <p class="note" id="capline" style="text-align:center"></p>`;
  const extraCss = `
.goal{position:relative;height:64px;border-radius:12px;background:#0B0F14;border:1.5px solid #22303F;overflow:hidden;margin:4px 0 0}
.zone{position:absolute;top:0;bottom:0;background:rgba(20,224,200,.22);border-left:1.5px solid #14E0C8;border-right:1.5px solid #14E0C8}
.marker{position:absolute;top:6px;bottom:6px;width:5px;border-radius:3px;background:#FFC83D}
.kicks{display:flex;gap:6px;margin-top:10px}
.kick{width:26px;height:26px;border-radius:50%;border:1.5px solid #22303F;display:grid;place-items:center;font:800 12px Inter;color:#5E6B7C}
.kick.hit{border-color:#14E0C8;color:#14E0C8}
.kick.miss{border-color:#FF5A6E;color:#FF5A6E}`;
  const script = `
  var capline=document.getElementById('capline');
  function refreshCap(){ fetch('/api/arcade?v='+encodeURIComponent(v)).then(function(r){return r.json();}).then(function(d){
    capline.textContent = d.today>=d.cap ? 'daily cap reached — back tomorrow' : (d.cap-d.today)+' of '+d.cap+' still to bank today';
  }).catch(function(){}); }
  refreshCap();
  var goal=document.getElementById('goal'), zone=document.getElementById('zone'), marker=document.getElementById('marker');
  var shoot=document.getElementById('shoot'), kicksEl=document.getElementById('kicks'), pstat=document.getElementById('pstat');
  var KICKS=5, kick=0, total=0, pos=0, dir=1, speed=2.6, playing=true, zoneW=0.30, zoneX=0.35, raf;
  function layoutZone(){
    zoneX = 0.08 + Math.random()*(0.84-zoneW);
    zone.style.left=(zoneX*100)+'%'; zone.style.width=(zoneW*100)+'%';
  }
  function dots(){ kicksEl.innerHTML=''; for(var i=0;i<KICKS;i++){ var d=document.createElement('div'); d.className='kick'; d.textContent=i+1; kicksEl.appendChild(d);} }
  function step(){
    var w=goal.clientWidth-5;
    pos+=dir*speed; if(pos<=0||pos>=w){dir*=-1; pos=Math.max(0,Math.min(w,pos));}
    marker.style.transform='translateX('+pos+'px)';
    raf=requestAnimationFrame(step);
  }
  dots(); layoutZone(); step();
  shoot.addEventListener('click', function(){
    if(!playing) return;
    var w=goal.clientWidth-5, rel=pos/w;
    var inZone = rel>=zoneX && rel<=zoneX+zoneW;
    var centre = zoneX+zoneW/2, closeness = 1-Math.min(1, Math.abs(rel-centre)/(zoneW/2));
    var pts = inZone ? (closeness>0.6?3:2) : 0;
    total+=pts;
    var d=kicksEl.children[kick]; d.className='kick '+(pts?'hit':'miss'); d.textContent=pts||'✕';
    kick++;
    zoneW=Math.max(0.12, zoneW-0.045); speed+=0.55; layoutZone();
    if(kick>=KICKS){
      playing=false; cancelAnimationFrame(raf); shoot.disabled=true; shoot.textContent='FULL TIME';
      submit('penalty', total, function(d){
        pstat.innerHTML = d ? 'Scored '+total+' of 15. <b>+'+d.awarded+' points</b>'+(d.awarded<total?' (daily cap)':'')+' · '+d.allTime+' all time' : 'Could not save that one.';
        refreshCap();
      });
      setTimeout(function(){ kick=0; total=0; zoneW=0.30; speed=2.6; playing=true; shoot.disabled=false; shoot.textContent='SHOOT'; dots(); layoutZone(); step(); }, 2600);
    }
  });`;
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
  res.end(arcadePage({ path: '/penalty', title: 'PENALTY SWEEP', kicker: 'FIVE KICKS', metaTitle: 'Penalty Sweep — the Clashly Arcade', desc: 'Timing game: tap when the sweeping marker is in the zone. Five kicks, the zone shrinks. Points go on the public board. Free, no money, no prizes.', body, script, extraCss }));
}

async function serveKeepy(req, res) {
  const body = `
  <div class="gcard">
    <h2 class="gname">Keepy-Uppy 🤹</h2>
    <p class="gsub">Tap the ball to keep it up. It gets faster. One point a touch, drop it and the run's over.</p>
    <div class="pitch" id="pitch"><div id="ball">⚽</div></div>
    <button class="gbtn" id="kstart">START</button>
    <div class="stat" id="kstat"></div>
  </div>
  <p class="note" id="capline" style="text-align:center"></p>`;
  const extraCss = `
.pitch{position:relative;height:280px;border-radius:12px;background:linear-gradient(180deg,#0B0F14,#0d1a14);border:1.5px solid #22303F;overflow:hidden;margin:4px 0 0;touch-action:manipulation}
#ball{position:absolute;font-size:44px;line-height:1;user-select:none;cursor:pointer;left:50%;top:20px;will-change:transform}`;
  const script = `
  var capline=document.getElementById('capline');
  function refreshCap(){ fetch('/api/arcade?v='+encodeURIComponent(v)).then(function(r){return r.json();}).then(function(d){
    capline.textContent = d.today>=d.cap ? 'daily cap reached — back tomorrow' : (d.cap-d.today)+' of '+d.cap+' still to bank today';
  }).catch(function(){}); }
  refreshCap();
  var pitch=document.getElementById('pitch'), ball=document.getElementById('ball');
  var kstart=document.getElementById('kstart'), kstat=document.getElementById('kstat');
  var bx=0, by=0, vx=0, vy=0, touches=0, live=false, kraf;
  function kstep(){
    var W=pitch.clientWidth-44, H=pitch.clientHeight-44;
    vy+=0.45+touches*0.012;
    bx+=vx; by+=vy;
    if(bx<0){bx=0;vx=Math.abs(vx);} if(bx>W){bx=W;vx=-Math.abs(vx);}
    if(by<0){by=0;vy=Math.abs(vy)*0.6;}
    ball.style.transform='translate('+bx+'px,'+by+'px)';
    ball.style.left='0'; ball.style.top='0';
    if(by>=H){ live=false; cancelAnimationFrame(kraf);
      kstart.disabled=false; kstart.textContent='GO AGAIN';
      var sc=Math.min(15,touches);
      submit('keepy', sc, function(d){
        kstat.innerHTML = d ? touches+' touch'+(touches===1?'':'es')+'. <b>+'+d.awarded+' points</b>'+(d.awarded<sc?' (daily cap)':'')+' · '+d.allTime+' all time' : 'Could not save that one.';
        refreshCap();
      });
      return; }
    kraf=requestAnimationFrame(kstep);
  }
  function tapBall(e){
    if(!live) return;
    e.preventDefault();
    touches++;
    vy=-(7.5+Math.random()*2); vx=(Math.random()-0.5)*7;
    kstat.textContent=touches+' touches';
  }
  ball.addEventListener('pointerdown', tapBall);
  kstart.addEventListener('click', function(){
    var W=pitch.clientWidth-44;
    bx=W/2; by=10; vx=0; vy=0; touches=0; live=true;
    kstat.textContent='0 touches'; kstart.disabled=true; kstart.textContent='LIVE';
    cancelAnimationFrame(kraf); kraf=requestAnimationFrame(kstep);
  });`;
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
  res.end(arcadePage({ path: '/keepy', title: 'KEEPY-UPPY', kicker: "DON'T LET IT DROP", metaTitle: 'Keepy-Uppy — the Clashly Arcade', desc: 'Reflex game: tap the ball to keep it in the air, it gets faster every touch. Points go on the public board. Free, no money, no prizes.', body, script, extraCss }));
}

// Widely reported headline fees, €M, rounded. Display-only trivia — no odds,
// no wagers, the number is the quiz answer.
const HILO_TRANSFERS = [
  ['Neymar', 2017, 'Barcelona', 'PSG', 222],
  ['Kylian Mbappé', 2018, 'Monaco', 'PSG', 180],
  ['Philippe Coutinho', 2018, 'Liverpool', 'Barcelona', 135],
  ['Ousmane Dembélé', 2017, 'Dortmund', 'Barcelona', 105],
  ['João Félix', 2019, 'Benfica', 'Atlético Madrid', 126],
  ['Enzo Fernández', 2023, 'Benfica', 'Chelsea', 121],
  ['Jack Grealish', 2021, 'Aston Villa', 'Man City', 117],
  ['Cristiano Ronaldo', 2009, 'Man Utd', 'Real Madrid', 94],
  ['Gareth Bale', 2013, 'Tottenham', 'Real Madrid', 101],
  ['Paul Pogba', 2016, 'Juventus', 'Man Utd', 105],
  ['Romelu Lukaku', 2021, 'Inter', 'Chelsea', 113],
  ['Gonzalo Higuaín', 2016, 'Napoli', 'Juventus', 90],
  ['Eden Hazard', 2019, 'Chelsea', 'Real Madrid', 100],
  ['Antony', 2022, 'Ajax', 'Man Utd', 95],
  ['Harry Maguire', 2019, 'Leicester', 'Man Utd', 87],
  ['Virgil van Dijk', 2018, 'Southampton', 'Liverpool', 84],
  ['Kepa Arrizabalaga', 2018, 'Athletic Bilbao', 'Chelsea', 80],
  ['Zinedine Zidane', 2001, 'Juventus', 'Real Madrid', 77],
  ['Luís Figo', 2000, 'Barcelona', 'Real Madrid', 62],
  ['Kaká', 2009, 'Milan', 'Real Madrid', 67],
  ['Luis Suárez', 2014, 'Liverpool', 'Barcelona', 81],
  ['Zlatan Ibrahimović', 2009, 'Inter', 'Barcelona', 66],
  ['Andriy Shevchenko', 2006, 'Milan', 'Chelsea', 43],
  ['Fernando Torres', 2011, 'Liverpool', 'Chelsea', 58],
  ['Andy Carroll', 2011, 'Newcastle', 'Liverpool', 41],
  ['Dennis Bergkamp', 1995, 'Inter', 'Arsenal', 10],
  ['Thierry Henry', 1999, 'Juventus', 'Arsenal', 16],
  ['Nicolas Anelka', 1999, 'Arsenal', 'Real Madrid', 34],
  ['David Beckham', 2003, 'Man Utd', 'Real Madrid', 37],
  ['Wayne Rooney', 2004, 'Everton', 'Man Utd', 33],
  ['Rio Ferdinand', 2002, 'Leeds', 'Man Utd', 46],
  ['Juan Sebastián Verón', 2001, 'Lazio', 'Man Utd', 42],
  ['Hernán Crespo', 2000, 'Parma', 'Lazio', 56],
  ['Gianluigi Buffon', 2001, 'Parma', 'Juventus', 52],
  ['Erling Haaland', 2022, 'Dortmund', 'Man City', 60],
  ['Jude Bellingham', 2023, 'Dortmund', 'Real Madrid', 103],
  ['Declan Rice', 2023, 'West Ham', 'Arsenal', 116],
  ['Moisés Caicedo', 2023, 'Brighton', 'Chelsea', 116],
  ['Harry Kane', 2023, 'Tottenham', 'Bayern', 100],
  ['Alexander Isak', 2022, 'Real Sociedad', 'Newcastle', 70],
  ['Darwin Núñez', 2022, 'Benfica', 'Liverpool', 75],
  ['Florian Wirtz', 2025, 'Leverkusen', 'Liverpool', 125],
  ['Victor Osimhen', 2020, 'Lille', 'Napoli', 75],
  ['Antoine Griezmann', 2019, 'Atlético Madrid', 'Barcelona', 120],
  ['Kevin De Bruyne', 2015, 'Wolfsburg', 'Man City', 76],
  ['Raheem Sterling', 2015, 'Liverpool', 'Man City', 63],
  ['Ángel Di María', 2014, 'Real Madrid', 'Man Utd', 75],
  ['James Rodríguez', 2014, 'Monaco', 'Real Madrid', 75],
  ['Mykhailo Mudryk', 2023, 'Shakhtar', 'Chelsea', 70],
  ['Mohamed Salah', 2017, 'Roma', 'Liverpool', 42],
  ['Sadio Mané', 2016, 'Southampton', 'Liverpool', 41],
  ['Roberto Firmino', 2015, 'Hoffenheim', 'Liverpool', 41],
  ['Pierre-Emerick Aubameyang', 2018, 'Dortmund', 'Arsenal', 63],
  ['Álvaro Morata', 2017, 'Real Madrid', 'Chelsea', 66],
  ['Robert Lewandowski', 2022, 'Bayern', 'Barcelona', 45],
  ['Vinícius Júnior', 2018, 'Flamengo', 'Real Madrid', 45],
  ['Nicolas Pépé', 2019, 'Lille', 'Arsenal', 72],
  ['Tanguy Ndombele', 2019, 'Lyon', 'Tottenham', 60],
  ['Lucas Hernández', 2019, 'Atlético Madrid', 'Bayern', 80],
  ['Robinho', 2008, 'Real Madrid', 'Man City', 43],
  ['Dimitar Berbatov', 2008, 'Tottenham', 'Man Utd', 38],
  ['Ronaldinho', 2003, 'PSG', 'Barcelona', 30],
  ['Ronaldo', 1997, 'Barcelona', 'Inter', 28],
  ['Diego Maradona', 1984, 'Barcelona', 'Napoli', 7],
  ['Eric Cantona', 1992, 'Leeds', 'Man Utd', 1],
];

async function serveHilo(req, res) {
  const body = `
  <div class="gcard" id="cardA" style="text-align:center;padding:22px 18px">
    <img class="pimg" id="aImg" alt="" />
    <div class="sil" id="aSil" style="display:none"><div class="sc"></div><div class="ss"></div></div>
    <div style="font-family:Anton,Impact,sans-serif;font-size:24px;letter-spacing:.5px;margin-top:8px" id="aName"></div>
    <div style="font-size:12px;color:rgba(233,238,243,.55)" id="aMeta"></div>
    <div style="font-family:Anton,Impact,sans-serif;font-size:42px;color:#14E0C8;margin-top:6px;text-shadow:0 0 32px rgba(20,224,200,.3)" id="aFee"></div>
  </div>
  <div style="display:flex;align-items:center;justify-content:center;gap:10px;height:44px" id="streakRow">
    <span style="font-size:17px" id="fire">🔥</span>
    <span style="font-family:Anton,Impact,sans-serif;font-size:19px;letter-spacing:.5px" id="streakTxt">STREAK 0</span>
    <span style="font:600 11px Inter,system-ui,sans-serif;color:rgba(233,238,243,.5);border:1px solid rgba(255,255,255,.15);border-radius:999px;padding:3px 10px" id="bestTxt">best 0</span>
  </div>
  <div class="gcard" id="cardB" style="text-align:center;padding:22px 18px">
    <img class="pimg" id="bImg" style="width:64px;height:64px;margin-bottom:6px" alt="" />
    <div style="font-family:Anton,Impact,sans-serif;font-size:24px;letter-spacing:.5px" id="bName"></div>
    <div style="font-size:12px;color:rgba(233,238,243,.55)" id="bMeta"></div>
    <div id="bMystery" style="width:58px;height:58px;border-radius:50%;border:2px dashed rgba(255,255,255,.28);display:flex;align-items:center;justify-content:center;font-family:Anton,Impact,sans-serif;font-size:26px;color:rgba(233,238,243,.6);margin:10px auto 0">?</div>
    <div id="bReveal" style="display:none">
      <div style="font-family:Anton,Impact,sans-serif;font-size:46px;color:#FFC83D;margin-top:4px;text-shadow:0 0 32px rgba(255,200,61,.35)" id="bFee"></div>
      <div style="font-size:13px;font-weight:700" id="verdict"></div>
      <div class="pill-pts" id="banked" style="margin-top:8px;display:none"></div>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:14px" id="hlBtns">
      <button class="gbtn" id="btnH" style="margin-top:0">▲ HIGHER</button>
      <button class="gbtn vio" id="btnL" style="margin-top:0">▼ LOWER</button>
    </div>
    <button class="gbtn" id="again" style="display:none">GO AGAIN</button>
  </div>
  <p class="note" style="text-align:center">Was the fee higher or lower? One point a step, banked when the run ends — up to 12 a run, 30 a day.</p>`;
  const extraCss = `
.sil{display:flex;flex-direction:column;align-items:center}
.sc{width:50px;height:50px;border-radius:50%;background:rgba(255,255,255,.09)}
.ss{width:84px;height:28px;border-radius:16px 16px 0 0;background:rgba(255,255,255,.09);margin-top:-6px}
.pimg{width:84px;height:84px;border-radius:50%;object-fit:cover;border:2px solid rgba(255,255,255,.16);display:block;margin:0 auto;background:rgba(255,255,255,.06)}`;
  const script = `
  var DATA=${JSON.stringify(HILO_TRANSFERS)};
  var deck=[], A=null, B=null, streak=0, over=false;
  var best=0; try{ best=parseInt(localStorage.getItem('clashly_hilo_best')||'0',10)||0; }catch(e){}
  function shuffle(a){ for(var i=a.length-1;i>0;i--){ var j=Math.floor(Math.random()*(i+1)), t=a[i]; a[i]=a[j]; a[j]=t; } return a; }
  function fee(n){ return '€'+n+'M'; }
  function pslug(n){ return n.toLowerCase().normalize('NFD').replace(/[\\u0300-\\u036f]/g,'').replace(/[^a-z0-9]+/g,'-').replace(/-+/g,'-').replace(/^-|-\$/g,''); }
  function setImg(id, silId, name){
    var im=document.getElementById(id); if(!im) return;
    im.style.display='';
    im.onerror=function(){ im.style.display='none'; if(silId){ var s=document.getElementById(silId); if(s) s.style.display=''; } };
    if(silId){ var s0=document.getElementById(silId); if(s0) s0.style.display='none'; }
    im.src='/players/'+pslug(name)+'.jpg';
  }
  function draw(){ if(!deck.length) deck=shuffle(DATA.slice());
    var c=deck.pop();
    if(A && c[4]===A[4]){ deck.unshift(c); c=deck.pop() || c; }
    return c; }
  function paint(){
    setImg('aImg','aSil',A[0]); setImg('bImg',null,B[0]);
    document.getElementById('aName').textContent=A[0].toUpperCase();
    document.getElementById('aMeta').textContent=A[1]+' · '+A[2]+' → '+A[3];
    document.getElementById('aFee').textContent=fee(A[4]);
    document.getElementById('bName').textContent=B[0].toUpperCase();
    document.getElementById('bMeta').textContent=B[1]+' · '+B[2]+' → '+B[3];
    document.getElementById('streakTxt').textContent='STREAK '+streak;
    document.getElementById('bestTxt').textContent='best '+best;
    document.getElementById('bMystery').style.display='';
    document.getElementById('bReveal').style.display='none';
    document.getElementById('hlBtns').style.display='';
    document.getElementById('again').style.display='none';
    document.getElementById('cardB').style.borderColor='rgba(255,255,255,.07)';
    document.getElementById('fire').style.filter=''; document.getElementById('fire').style.opacity='';
    document.getElementById('streakTxt').style.color='';
  }
  function start(){ deck=shuffle(DATA.slice()); A=deck.pop(); B=draw(); streak=0; over=false; paint(); }
  function guess(higher){
    if(over) return;
    var correct = higher ? (B[4]>A[4]) : (B[4]<A[4]);
    document.getElementById('bMystery').style.display='none';
    document.getElementById('bReveal').style.display='';
    document.getElementById('bFee').textContent=fee(B[4]);
    document.getElementById('hlBtns').style.display='none';
    if(correct){
      streak++;
      if(streak>best){ best=streak; try{ localStorage.setItem('clashly_hilo_best',String(best)); }catch(e){} }
      document.getElementById('bFee').style.color='#14E0C8';
      document.getElementById('bFee').style.textShadow='0 0 32px rgba(20,224,200,.3)';
      document.getElementById('verdict').textContent='CALLED IT';
      document.getElementById('verdict').style.color='#14E0C8';
      document.getElementById('streakTxt').textContent='STREAK '+streak;
      document.getElementById('bestTxt').textContent='best '+best;
      setTimeout(function(){ A=B; B=draw(); paint(); }, 950);
    } else {
      over=true;
      var d=Math.abs(B[4]-A[4]);
      document.getElementById('bFee').style.color='#FFC83D';
      document.getElementById('bFee').style.textShadow='0 0 32px rgba(255,200,61,.35)';
      document.getElementById('cardB').style.borderColor='rgba(255,200,61,.4)';
      document.getElementById('verdict').textContent=(d<=5?'SO CLOSE — ':'')+'it was €'+d+'M '+(B[4]>A[4]?'more':'less');
      document.getElementById('verdict').style.color='#FFC83D';
      document.getElementById('fire').style.filter='grayscale(1)'; document.getElementById('fire').style.opacity='.6';
      document.getElementById('streakTxt').textContent='STREAK ENDS AT '+streak;
      document.getElementById('streakTxt').style.color='rgba(233,238,243,.6)';
      document.getElementById('again').style.display='';
      if(streak>0) submit('hilo', Math.min(12,streak), function(r){
        if(r && r.awarded){ var b=document.getElementById('banked'); b.textContent='+'+r.awarded+' PTS BANKED'; b.style.display='inline-block'; }
      });
    }
  }
  document.getElementById('btnH').addEventListener('click', function(){ guess(true); });
  document.getElementById('btnL').addEventListener('click', function(){ guess(false); });
  document.getElementById('again').addEventListener('click', start);
  start();`;
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
  res.end(arcadePage({ path: '/hilo', title: 'HIGHER OR LOWER', kicker: 'TRANSFER FEES', metaTitle: 'Higher or Lower: transfer fees — the Clashly Arcade', desc: 'Was the fee higher or lower? Streak the famous transfer fees. Points go on the public board. Free, no money, no prizes.', body, script, extraCss }));
}

// The Daily — one player a day, everyone gets the same one. Career steps as
// clues, a wrong guess unlocks the next step. Points once a day, ever.
const DAILY_PLAYERS = [
  { n: 'Zlatan Ibrahimović', alt: ['zlatan', 'ibrahimovic', 'ibra'], c: [[1999, 'Malmö'], [2001, 'Ajax'], [2004, 'Juventus'], [2006, 'Inter'], [2009, 'Barcelona'], [2010, 'Milan']] },
  { n: 'Cristiano Ronaldo', alt: ['ronaldo', 'cr7', 'cristiano'], c: [[2002, 'Sporting'], [2003, 'Man Utd'], [2009, 'Real Madrid'], [2018, 'Juventus'], [2021, 'Man Utd'], [2023, 'Al-Nassr']] },
  { n: 'Didier Drogba', alt: ['drogba'], c: [[2002, 'Guingamp'], [2003, 'Marseille'], [2004, 'Chelsea'], [2012, 'Shanghai Shenhua'], [2014, 'Chelsea'], [2015, 'Montreal']] },
  { n: 'Thierry Henry', alt: ['henry'], c: [[1994, 'Monaco'], [1999, 'Juventus'], [1999, 'Arsenal'], [2007, 'Barcelona'], [2010, 'NY Red Bulls']] },
  { n: 'Eric Cantona', alt: ['cantona'], c: [[1983, 'Auxerre'], [1988, 'Marseille'], [1991, 'Leeds'], [1992, 'Man Utd']] },
  { n: 'Ronaldinho', alt: ['ronaldinho'], c: [[1998, 'Grêmio'], [2001, 'PSG'], [2003, 'Barcelona'], [2008, 'Milan'], [2011, 'Flamengo']] },
  { n: 'Ronaldo', alt: ['ronaldo', 'r9', 'ronaldo nazario'], c: [[1993, 'Cruzeiro'], [1994, 'PSV'], [1996, 'Barcelona'], [1997, 'Inter'], [2002, 'Real Madrid'], [2007, 'Milan']] },
  { n: 'David Beckham', alt: ['beckham'], c: [[1992, 'Man Utd'], [2003, 'Real Madrid'], [2007, 'LA Galaxy'], [2013, 'PSG']] },
  { n: 'Andrea Pirlo', alt: ['pirlo'], c: [[1995, 'Brescia'], [1998, 'Inter'], [2001, 'Milan'], [2011, 'Juventus'], [2015, 'New York City']] },
  { n: 'Gianluigi Buffon', alt: ['buffon'], c: [[1995, 'Parma'], [2001, 'Juventus'], [2018, 'PSG'], [2019, 'Juventus'], [2021, 'Parma']] },
  { n: 'Robert Lewandowski', alt: ['lewandowski', 'lewy'], c: [[2008, 'Lech Poznań'], [2010, 'Dortmund'], [2014, 'Bayern'], [2022, 'Barcelona']] },
  { n: 'Wojciech Szczęsny', alt: ['szczesny'], c: [[2006, 'Arsenal'], [2015, 'Roma'], [2017, 'Juventus'], [2024, 'Barcelona']] },
  { n: 'Kaká', alt: ['kaka'], c: [[2001, 'São Paulo'], [2003, 'Milan'], [2009, 'Real Madrid'], [2014, 'Orlando City']] },
  { n: 'Luka Modrić', alt: ['modric'], c: [[2002, 'Dinamo Zagreb'], [2008, 'Tottenham'], [2012, 'Real Madrid']] },
  { n: 'Mohamed Salah', alt: ['salah'], c: [[2010, 'El Mokawloon'], [2012, 'Basel'], [2014, 'Chelsea'], [2016, 'Roma'], [2017, 'Liverpool']] },
  { n: 'Luis Suárez', alt: ['suarez'], c: [[2005, 'Nacional'], [2006, 'Groningen'], [2007, 'Ajax'], [2011, 'Liverpool'], [2014, 'Barcelona'], [2020, 'Atlético Madrid']] },
  { n: 'Robin van Persie', alt: ['van persie', 'rvp'], c: [[2001, 'Feyenoord'], [2004, 'Arsenal'], [2012, 'Man Utd'], [2015, 'Fenerbahçe']] },
  { n: 'Arjen Robben', alt: ['robben'], c: [[2000, 'Groningen'], [2002, 'PSV'], [2004, 'Chelsea'], [2007, 'Real Madrid'], [2009, 'Bayern']] },
  { n: 'Samuel Eto\'o', alt: ['etoo', 'eto o', 'eto'], c: [[1997, 'Real Madrid'], [2000, 'Mallorca'], [2004, 'Barcelona'], [2009, 'Inter'], [2011, 'Anzhi'], [2013, 'Chelsea']] },
  { n: 'Carlos Tevez', alt: ['tevez'], c: [[2001, 'Boca Juniors'], [2005, 'Corinthians'], [2006, 'West Ham'], [2007, 'Man Utd'], [2009, 'Man City'], [2013, 'Juventus']] },
  { n: 'Ángel Di María', alt: ['di maria'], c: [[2005, 'Rosario Central'], [2007, 'Benfica'], [2010, 'Real Madrid'], [2014, 'Man Utd'], [2015, 'PSG'], [2022, 'Juventus']] },
  { n: 'Radamel Falcao', alt: ['falcao'], c: [[2005, 'River Plate'], [2009, 'Porto'], [2011, 'Atlético Madrid'], [2013, 'Monaco']] },
  { n: 'Eden Hazard', alt: ['hazard'], c: [[2007, 'Lille'], [2012, 'Chelsea'], [2019, 'Real Madrid']] },
  { n: 'Antoine Griezmann', alt: ['griezmann'], c: [[2009, 'Real Sociedad'], [2014, 'Atlético Madrid'], [2019, 'Barcelona'], [2021, 'Atlético Madrid']] },
  { n: 'Philippe Coutinho', alt: ['coutinho'], c: [[2010, 'Inter'], [2013, 'Liverpool'], [2018, 'Barcelona'], [2022, 'Aston Villa']] },
  { n: 'Riyad Mahrez', alt: ['mahrez'], c: [[2010, 'Le Havre'], [2014, 'Leicester'], [2018, 'Man City'], [2023, 'Al-Ahli']] },
  { n: 'Jamie Vardy', alt: ['vardy'], c: [[2007, 'Stocksbridge Park Steels'], [2010, 'Halifax'], [2011, 'Fleetwood'], [2012, 'Leicester']] },
  { n: "N'Golo Kanté", alt: ['kante'], c: [[2012, 'Boulogne'], [2013, 'Caen'], [2015, 'Leicester'], [2016, 'Chelsea'], [2023, 'Al-Ittihad']] },
  { n: 'Virgil van Dijk', alt: ['van dijk', 'vvd'], c: [[2010, 'Groningen'], [2013, 'Celtic'], [2015, 'Southampton'], [2018, 'Liverpool']] },
  { n: 'Son Heung-min', alt: ['son', 'heung-min son', 'sonny'], c: [[2010, 'Hamburg'], [2013, 'Leverkusen'], [2015, 'Tottenham']] },
  { n: 'Kevin De Bruyne', alt: ['de bruyne', 'kdb'], c: [[2008, 'Genk'], [2012, 'Chelsea'], [2014, 'Wolfsburg'], [2015, 'Man City']] },
  { n: 'Piotr Zieliński', alt: ['zielinski'], c: [[2011, 'Udinese'], [2016, 'Napoli'], [2024, 'Inter']] },
  { n: 'Erling Haaland', alt: ['haaland'], c: [[2017, 'Molde'], [2019, 'RB Salzburg'], [2020, 'Dortmund'], [2022, 'Man City']] },
  { n: 'Kylian Mbappé', alt: ['mbappe'], c: [[2015, 'Monaco'], [2017, 'PSG'], [2024, 'Real Madrid']] },
  { n: 'Karim Benzema', alt: ['benzema'], c: [[2004, 'Lyon'], [2009, 'Real Madrid'], [2023, 'Al-Ittihad']] },
  { n: 'Alexis Sánchez', alt: ['sanchez', 'alexis'], c: [[2006, 'Udinese'], [2011, 'Barcelona'], [2014, 'Arsenal'], [2018, 'Man Utd'], [2019, 'Inter']] },
  { n: 'Wayne Rooney', alt: ['rooney'], c: [[2002, 'Everton'], [2004, 'Man Utd'], [2017, 'Everton'], [2018, 'DC United']] },
  { n: 'Andriy Shevchenko', alt: ['shevchenko', 'sheva'], c: [[1994, 'Dynamo Kyiv'], [1999, 'Milan'], [2006, 'Chelsea'], [2008, 'Milan'], [2009, 'Dynamo Kyiv']] },
];
const DAILY_EPOCH = Date.UTC(2026, 0, 1); // #1 = 1 Jan 2026
const dailyNumber = () => Math.floor((Date.now() - DAILY_EPOCH) / 86400000) + 1;
const dailyPick = () => DAILY_PLAYERS[(dailyNumber() * 17) % DAILY_PLAYERS.length];

async function serveDaily(req, res) {
  const N = dailyNumber();
  const P = dailyPick();
  const body = `
  <div class="gcard" id="dCard">
    <div style="display:flex;align-items:baseline;justify-content:space-between">
      <div style="font-family:Anton,Impact,sans-serif;font-size:26px;letter-spacing:.5px">THE DAILY</div>
      <div style="font-family:Anton,Impact,sans-serif;font-size:16px;color:rgba(233,238,243,.35)">#${N}</div>
    </div>
    <div style="font-size:12px;color:rgba(233,238,243,.5);margin-top:4px">one a day, everyone gets the same player</div>
    <div style="font:700 10px Inter,system-ui,sans-serif;letter-spacing:2.5px;color:#14E0C8;margin-top:20px">THE CAREER</div>
    <div style="display:flex;flex-direction:column;gap:8px;margin-top:10px" id="steps"></div>
    <div id="wrongs" style="margin-top:14px"></div>
    <div style="display:flex;gap:10px;margin-top:16px" id="guessRow">
      <input id="gIn" placeholder="Who is it?" autocomplete="off" style="flex:1;background:linear-gradient(180deg,#141C29,#0F1520);border:1px solid rgba(255,255,255,.13);border-radius:12px;padding:14px 16px;font:600 15px Inter,system-ui,sans-serif;color:#F4F7FB;outline:none;min-width:0" />
      <button class="gbtn" id="gGo" style="width:auto;margin-top:0;padding:14px 20px">GUESS</button>
    </div>
    <div style="display:flex;align-items:center;justify-content:center;gap:10px;margin-top:14px" id="dotsRow">
      <div style="display:flex;gap:5px" id="dots"></div>
      <div style="font-size:12px;color:rgba(233,238,243,.5)" id="gCount"></div>
    </div>
  </div>
  <div id="doneWrap" style="display:none;text-align:center">
    <div style="font:700 10px Inter,system-ui,sans-serif;letter-spacing:3px;color:#14E0C8;margin-top:18px" id="doneKick"></div>
    <img id="doneImg" style="display:none;width:96px;height:96px;border-radius:50%;object-fit:cover;border:2px solid rgba(20,224,200,.5);margin:14px auto 0;box-shadow:0 0 40px rgba(20,224,200,.25)" alt="" />
    <div style="font-family:Anton,Impact,sans-serif;font-size:40px;line-height:1.05;margin-top:12px;text-shadow:0 0 60px rgba(20,224,200,.35)" id="doneName"></div>
    <div style="font-size:13px;color:rgba(233,238,243,.55);margin-top:10px" id="donePath"></div>
    <div class="gcard" style="margin-top:24px;display:flex;flex-direction:column;align-items:center;gap:12px">
      <div style="font:700 10px Inter,system-ui,sans-serif;letter-spacing:2.5px;color:rgba(233,238,243,.5)" id="doneRes"></div>
      <div style="display:flex;gap:8px" id="doneSquares"></div>
      <div class="pill-pts" id="doneBanked" style="display:none"></div>
      <button id="copyRes" style="border:1px solid rgba(20,224,200,.5);color:#14E0C8;background:none;border-radius:12px;padding:12px 0;width:100%;font-family:Anton,Impact,sans-serif;font-size:16px;letter-spacing:1px;cursor:pointer">COPY RESULT</button>
      <div style="font-size:11px;color:rgba(233,238,243,.4)">just the squares, no link</div>
    </div>
    <div style="display:flex;align-items:center;justify-content:center;gap:8px;margin-top:22px" id="streakWrap">
      <span style="font-size:18px">🔥</span>
      <span style="font-family:Anton,Impact,sans-serif;font-size:20px;letter-spacing:.5px" id="dStreak"></span>
    </div>
    <div style="font-size:12px;color:rgba(233,238,243,.5);margin-top:18px">back tomorrow — one a day</div>
  </div>`;
  const script = `
  var N=${N};
  var ANSWER=${JSON.stringify(P.n)};
  var ALT=${JSON.stringify(P.alt)};
  var STEPS=${JSON.stringify(P.c)};
  var MAXG=6, SHOW0=Math.min(2,STEPS.length);
  var st=null; try{ st=JSON.parse(localStorage.getItem('clashly_daily')||'null'); }catch(e){}
  if(!st || st.n!==N) st={n:N, wrongs:[], done:false, won:false};
  function save(){ try{ localStorage.setItem('clashly_daily', JSON.stringify(st)); }catch(e){} }
  function norm(s){ return String(s||'').toLowerCase().normalize('NFD').replace(/[\\u0300-\\u036f]/g,'').replace(/[^a-z ]/g,' ').replace(/ +/g,' ').trim(); }
  var GOOD=[norm(ANSWER)].concat(ALT.map(norm), [norm(ANSWER).split(' ').slice(-1)[0]]);
  function isRight(g){ g=norm(g); return g.length>2 && GOOD.indexOf(g)>=0; }
  function shown(){ return Math.min(STEPS.length, SHOW0 + st.wrongs.length); }
  function paint(){
    var el=document.getElementById('steps'); el.innerHTML='';
    var k=shown();
    for(var i=0;i<k;i++){
      el.innerHTML += '<div style="display:flex;align-items:center;gap:12px;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.11);border-radius:12px;padding:12px 16px">'
        + '<span style="font-family:Anton,Impact,sans-serif;font-size:14px;color:#14E0C8">'+STEPS[i][0]+'</span>'
        + '<span style="font:600 15px Inter,system-ui,sans-serif">'+STEPS[i][1]+'</span></div>';
    }
    if(k<STEPS.length) el.innerHTML += '<div style="display:flex;align-items:center;gap:12px;border:2px dashed rgba(255,255,255,.18);border-radius:12px;padding:12px 16px">'
      + '<span style="font-family:Anton,Impact,sans-serif;font-size:14px;color:rgba(233,238,243,.4)">?</span>'
      + '<span style="font-size:12px;color:rgba(233,238,243,.4)">next step unlocks after a wrong guess</span></div>';
    var w=document.getElementById('wrongs');
    w.innerHTML = st.wrongs.map(function(g){ return '<div style="font-size:13px;color:rgba(233,238,243,.45);display:flex;align-items:center;gap:8px;margin-top:4px"><span style="color:#F27B6C">✗</span><span style="text-decoration:line-through">'+g.replace(/</g,'&lt;')+'</span></div>'; }).join('');
    var dots=document.getElementById('dots'); dots.innerHTML='';
    for(var j=0;j<MAXG;j++) dots.innerHTML += '<div style="width:8px;height:8px;border-radius:50%;background:'+(j<st.wrongs.length?'#F27B6C':(j===st.wrongs.length&&!st.done?'#14E0C8':'rgba(255,255,255,.15)'))+'"></div>';
    document.getElementById('gCount').textContent='guess '+Math.min(MAXG,st.wrongs.length+1)+' of '+MAXG;
  }
  function squares(won,used){
    var out=[]; for(var i=0;i<used-(won?1:0);i++) out.push(false); if(won) out.push(true); return out;
  }
  function finish(won, banked){
    st.done=true; st.won=won; save();
    document.getElementById('dCard').style.display='none';
    var dw=document.getElementById('doneWrap'); dw.style.display='block';
    document.getElementById('doneKick').textContent='THE DAILY #'+N+(won?' · GOT IT':' · NOT TODAY');
    // the photo only ever appears AFTER the round is over — during play it is the answer
    var di=document.getElementById('doneImg');
    di.onload=function(){ di.style.display='block'; };
    di.src='/players/'+ANSWER.toLowerCase().normalize('NFD').replace(/[\\u0300-\\u036f]/g,'').replace(/[^a-z0-9]+/g,'-').replace(/-+/g,'-').replace(/^-|-\$/g,'')+'.jpg';
    document.getElementById('doneName').textContent=ANSWER.toUpperCase();
    document.getElementById('donePath').textContent=STEPS.map(function(s){return s[1];}).join(' → ');
    var used=st.wrongs.length+(won?1:0);
    document.getElementById('doneRes').textContent='YOUR RESULT · '+(won?used:'X')+'/'+MAXG;
    var sq=squares(won, used||MAXG);
    if(!won){ sq=[]; for(var i=0;i<MAXG;i++) sq.push(false); }
    document.getElementById('doneSquares').innerHTML=sq.map(function(ok){ return '<div style="width:28px;height:28px;border-radius:7px;background:'+(ok?'#14E0C8':'rgba(255,255,255,.14)')+'"></div>'; }).join('');
    var stk={n:0,count:0}; try{ stk=JSON.parse(localStorage.getItem('clashly_daily_streak')||'{"n":0,"count":0}'); }catch(e){}
    if(won && !st.counted){ stk.count = (stk.n===N-1)?stk.count+1:1; stk.n=N; st.counted=true; save(); try{ localStorage.setItem('clashly_daily_streak',JSON.stringify(stk)); }catch(e){} }
    document.getElementById('streakWrap').style.display = (won&&stk.count>0)?'':'none';
    document.getElementById('dStreak').textContent = stk.count+(stk.count===1?' DAY':' DAYS');
    var txt='The Daily #'+N+' — '+(won?used:'X')+'/'+MAXG+'\\n'+sq.map(function(ok){return ok?'🟩':'⬛';}).join('');
    var cp=document.getElementById('copyRes');
    cp.onclick=function(){
      (navigator.clipboard&&navigator.clipboard.writeText?navigator.clipboard.writeText(txt):Promise.reject()).then(function(){ cp.textContent='COPIED'; setTimeout(function(){ cp.textContent='COPY RESULT'; },1600); }, function(){ prompt('Copy it:', txt); });
    };
  }
  function bank(pts){ submit('daily', pts, function(r){
    if(r && r.awarded){ var b=document.getElementById('doneBanked'); b.textContent='+'+r.awarded+' PTS BANKED'; b.style.display='inline-block'; }
  }); }
  function go(){
    if(st.done) return;
    var g=document.getElementById('gIn').value;
    if(!norm(g)) return;
    if(isRight(g)){
      var used=st.wrongs.length+1;
      var PTS=[8,6,5,4,3,2][used-1]||2;
      finish(true, null); bank(PTS);
    } else {
      st.wrongs.push(g.slice(0,40)); save();
      document.getElementById('gIn').value='';
      if(st.wrongs.length>=MAXG){ finish(false, null); }
      else paint();
    }
  }
  document.getElementById('gGo').addEventListener('click', go);
  document.getElementById('gIn').addEventListener('keydown', function(e){ if(e.key==='Enter') go(); });
  if(st.done) finish(st.won, null); else paint();`;
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
  res.end(arcadePage({ path: '/daily', title: 'THE DAILY', kicker: 'ONE CAREER A DAY', metaTitle: 'The Daily — guess the career | Clashly', desc: 'One footballer a day, career steps as clues, six guesses, everyone gets the same player. Copy your squares to the group chat. Free, no money, no prizes.', body, script }));
}

// /this-week — the public face of the weekly call. Server-rendered so it
// unfurls on X and WhatsApp and can be crawled; the buttons post straight to
// the API, so it works with no account and no app shell.
const shortTeam = (n) => {
  const w = String(n || '').split(' ');
  if (w.length > 1 && /^(Man|Manchester|Real|AC|AS|FC|RB|1\.|SC)$/i.test(w[0])) return w[1];
  return w[0];
};
async function serveThisWeek(req, res) {
  const wk = weekIdx(Date.now());
  const w = await getWeekly(wk);
  const sl = await getSlate(wk).catch(() => null);
  const url = 'https://clashly.live/this-week';
  if (!w) { res.writeHead(302, { Location: '/' }); return res.end(); }
  const t = weeklyTally(w);
  const pct = (n) => (t.total ? Math.round((n / t.total) * 100) : 0);
  const q = `Will ${w.home} beat ${w.away}?`;
  const title = `${w.home} v ${w.away} — call it | Clashly`;
  const desc = t.total
    ? `${t.total} ${t.total === 1 ? 'person has' : 'people have'} called ${w.home} v ${w.away}. ${pct(t.HOME)}% say ${w.home}. One tap, no account, and your record is public. Free, no money, no prizes.`
    : `Call ${w.home} v ${w.away} before kickoff. One tap, no account. Your call goes on the record and everyone sees who was right. Free, no money, no prizes.`;
  const locked = Boolean(w.utcDate && new Date(w.utcDate).getTime() < Date.now());
  const ld = { '@context': 'https://schema.org', '@graph': [
    { '@type': 'SportsEvent', name: `${w.home} v ${w.away}`, sport: 'Football',
      startDate: w.utcDate || undefined, url,
      homeTeam: { '@type': 'SportsTeam', name: w.home }, awayTeam: { '@type': 'SportsTeam', name: w.away } },
    { '@type': 'FAQPage', mainEntity: [
      { '@type': 'Question', name: q, acceptedAnswer: { '@type': 'Answer', text: t.total
        ? `${pct(t.HOME)}% of Clashly callers say ${w.home}, ${pct(t.DRAW)}% say a draw and ${pct(t.AWAY)}% say ${w.away}, from ${t.total} calls so far.`
        : `Nobody has called it yet. Make the first call on Clashly: one tap, no account, and the result goes on the record after full time.` } },
      { '@type': 'Question', name: 'Does Clashly take money?', acceptedAnswer: { '@type': 'Answer',
        text: 'No. Clashly holds no money, takes no stake and gives no prize. It is a scorekeeper for football calls between friends. 18+.' } },
    ] },
  ] };
  const board = weeklyBoard(8);
  const bar = (lbl, n, colour) => `
    <div class="row">
      <div class="lbl">${esc5(lbl)}</div>
      <div class="track"><div class="fill" style="width:${pct(n)}%;background:${colour}"></div></div>
      <div class="pc">${t.total ? pct(n) + '%' : '—'}</div>
    </div>`;
  const html = `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${esc5(title)}</title>
<meta name="description" content="${esc5(desc)}" />
<link rel="canonical" href="${url}" />
<link rel="icon" type="image/svg+xml" href="/favicon.svg?v=3" />
<meta property="og:type" content="website" />
<meta property="og:title" content="${esc5(q)}" />
<meta property="og:description" content="${esc5(desc)}" />
<meta property="og:url" content="${url}" />
<meta property="og:image" content="https://clashly.live/weekcard.png?w=${wk}" />
<meta name="twitter:card" content="summary_large_image" />
<script type="application/ld+json">${JSON.stringify(ld)}</script>
<style>${PAGE_CSS}
.wk{max-width:540px;padding-top:34px}
.brandrow{display:flex;align-items:center;gap:11px;margin:0 0 20px}
.mk{width:40px;height:40px;flex:none;border-radius:11px}
.bn{font-family:Anton,Impact,sans-serif;font-size:23px;letter-spacing:.5px;line-height:1}
.wk .cta{display:block;width:100%;box-sizing:border-box;text-align:center;margin:14px 0 0;padding:16px 18px;border-radius:16px;font-size:16px;border:0;cursor:pointer;font-family:inherit}
.wk h1.q{margin:0 0 6px}
.wk .cta.ghost2{background:transparent;color:#14E0C8;border:1.5px solid #22303F;font-weight:800}
.ft{background:rgba(255,200,61,.10);border:1.5px solid rgba(255,200,61,.5);border-radius:16px;padding:13px 15px;margin:0 0 14px;font-size:15px;color:#FFC83D}
.ft b{color:#FFC83D}
.ftsub{display:block;color:#9AA7B8;font-size:12.5px;font-weight:600;margin-top:3px}
.rule{border-left:2.2px solid #22303F;padding:2px 0 2px 12px;margin:16px 0 0;font-size:12.6px;line-height:1.55;color:#7C8A9C}
.rule b{color:#C7D0DB}
#you{margin-top:14px;padding:13px 15px;border-radius:16px;background:rgba(20,224,200,.08);border:1.5px solid rgba(20,224,200,.45);font-size:14.5px;color:#F4F7FB}
#you .big{font-family:Anton,Impact,sans-serif;font-size:27px;color:#14E0C8;display:block;line-height:1.1}
.slate .sm-row{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:11px 0;border-bottom:1px solid rgba(34,48,63,.55)}
.sm-fix{font-size:14px;color:#C7D0DB;min-width:0}
.sm-fix b{color:#F4F7FB}
.sm-meta{display:block;font-size:11px;color:#5E6B7C;margin-top:1px}
.sm-opts{display:flex;gap:6px;flex:none}
.sm-opt{padding:8px 9px;border-radius:11px;border:1.5px solid #22303F;background:#111823;color:#C7D0DB;font:700 11.5px Inter,system-ui,sans-serif;cursor:pointer;max-width:96px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sm-opt.on{border-color:#14E0C8;color:#14E0C8;background:rgba(20,224,200,.10)}
.sm-lock{font-size:11.5px;color:#5E6B7C;font-weight:700;flex:none}
.brd div span:first-child{display:flex;gap:9px;align-items:baseline}
.rk{color:#5E6B7C;font-size:12px;min-width:14px;display:inline-block}
.pts{color:#14E0C8}
.pl{color:#5E6B7C;font-size:12px;font-weight:600}
.q{font-family:Anton,Impact,sans-serif;font-size:clamp(30px,7vw,46px);line-height:1.03;margin:6px 0 4px}
.sub2{color:#9AA7B8;font-size:14px;margin:0 0 18px}
.opts{display:grid;gap:10px;margin:18px 0}
.opt{display:block;width:100%;padding:16px 18px;border-radius:16px;border:1.5px solid #22303F;background:#111823;color:#F4F7FB;font:800 17px Inter,system-ui,sans-serif;text-align:left;cursor:pointer}
.opt:hover{border-color:#14E0C8}
.opt.on{border-color:#14E0C8;background:rgba(20,224,200,.10)}
.row{display:grid;grid-template-columns:110px 1fr 44px;gap:10px;align-items:center;margin:8px 0;font-size:14px;font-weight:700}
.track{height:12px;border-radius:8px;background:#161E29;overflow:hidden}
.fill{height:100%;border-radius:8px;transition:width .5s ease}
.pc{text-align:right;color:#9AA7B8}
.brd{margin:22px 0 0;border-top:1px solid #22303F;padding-top:14px}
.brd div{display:flex;justify-content:space-between;padding:6px 0;font-size:14px;border-bottom:1px solid rgba(34,48,63,.5)}
.note{font-size:12.5px;color:#5E6B7C;margin-top:14px}
#share{margin-top:12px}
</style>
</head><body><div class="wrap wk">
  <div class="brandrow">
    <svg class="mk" viewBox="0 0 100 100" aria-hidden="true"><rect width="100" height="100" rx="26" fill="#0E141C"/><path d="M49.4 19A31 31 0 0 0 49.4 81L49.4 68A18 18 0 0 1 49.4 32Z" fill="#14E0C8"/><path d="M50.6 19A31 31 0 0 1 74 30L64 39A18 18 0 0 0 50.6 32ZM74 70A31 31 0 0 1 50.6 81L50.6 68A18 18 0 0 0 64 61Z" fill="#7C3AED"/></svg>
    <div><div class="bn">CLASHLY</div><div class="tag" style="margin:0">THE WEEKLY CALL</div></div>
  </div>
  <h1 class="q">${esc5(q)}</h1>
  <p class="sub2">${esc5(w.competition || 'Football')}${w.utcDate ? ' &middot; ' + new Date(w.utcDate).toUTCString().slice(0, 22) : ''}${locked ? ' &middot; calls closed' : ''}</p>

  ${w.result ? `<div class="ft">Full time &nbsp;·&nbsp; <b>${esc5(w.result === 'HOME' ? w.home + ' won' : w.result === 'AWAY' ? w.away + ' won' : 'Draw')}</b>${(() => { const c = weeklyCrowdPct(w); return c === null ? '' : `<span class="ftsub">${c}% of callers had it. Worth ${weeklyPointsFor(w, w.result)} points.</span>`; })()}</div>` : ''}

  <div class="opts" id="opts"${locked ? ' hidden' : ''}>
    <button class="opt" data-o="HOME">${esc5(w.home)} win</button>
    <button class="opt" data-o="DRAW">Draw</button>
    <button class="opt" data-o="AWAY">${esc5(w.away)} win</button>
  </div>

  <div id="split"${t.total ? '' : ' hidden'}>
    ${bar(w.home, t.HOME, '#14E0C8')}
    ${bar('Draw', t.DRAW, '#5E6B7C')}
    ${bar(w.away, t.AWAY, '#7C3AED')}
    <p class="note" id="cnt">${t.total} ${t.total === 1 ? 'call' : 'calls'} so far</p>
  </div>

  ${sl && sl.matches.length ? `<div class="slate">
    <p class="note" style="margin:22px 0 8px;text-transform:uppercase;letter-spacing:2px;font-weight:800">The rest of the weekend</p>
    ${sl.matches.map((m) => {
      const locked = m.result || (m.utcDate && new Date(m.utcDate).getTime() < Date.now());
      return `<div class="sm-row" data-mid="${esc5(m.id)}">
      <div class="sm-fix"><b>${esc5(m.home)}</b> v <b>${esc5(m.away)}</b>
        <span class="sm-meta">${esc5(m.competition || '')}${m.result ? ' &middot; FT: ' + esc5(m.result === 'HOME' ? m.home : m.result === 'AWAY' ? m.away : 'draw') : ''}</span></div>
      ${locked ? `<div class="sm-lock">${m.result ? 'settled' : 'kicked off'}</div>`
        : `<div class="sm-opts">
        <button class="sm-opt" data-mid="${esc5(m.id)}" data-o="HOME">${esc5(shortTeam(m.home))}</button>
        <button class="sm-opt" data-mid="${esc5(m.id)}" data-o="DRAW">draw</button>
        <button class="sm-opt" data-mid="${esc5(m.id)}" data-o="AWAY">${esc5(shortTeam(m.away))}</button>
      </div>`}
    </div>`; }).join('')}
    <p class="note" style="margin-top:6px">One tap each. Every right call banks points on the same board.</p>
  </div>` : ''}

  <div class="rule">
    <b>How it scores.</b> Get it right and you bank points. The fewer people who agreed
    with you, the more it is worth &mdash; up to five times. Get it wrong and you score
    nothing. Nothing to lose, no balance, no money anywhere.
  </div>
  <div id="you" hidden></div>
  <button class="cta" id="share" hidden>Copy it for the group 📋</button>
  <div id="nameWrap" hidden>
    <p class="note" style="margin-bottom:6px">Put your name on the board so everyone can see you called it.</p>
    <input id="nm" placeholder="Your name" maxlength="40" style="width:100%;padding:13px 14px;border-radius:14px;border:1.5px solid #22303F;background:#111823;color:#F4F7FB;font:600 16px Inter,sans-serif" />
    <button class="cta ghost2" id="saveNm" style="margin-top:8px">On the board →</button>
  </div>

  ${board.length ? `<div class="brd"><p class="note" style="margin:0 0 8px">The board</p>
    ${board.map((b, i) => `<div><span><b class="rk">${i + 1}</b> ${esc5(b.name)}</span><span><b class="pts">${b.points}</b> <span class="pl">pts &middot; ${b.right}/${b.played}</span></span></div>`).join('')}</div>` : ''}

  <a class="cta ghost2" href="/arcade" style="display:block;text-align:center;margin-top:14px">🕹️ The Arcade — skill games for the board →</a>
  <a class="cta" href="/" style="margin-top:12px;background:#7C3AED;color:#fff">Now settle one with a mate →</a>
  <p class="note" style="text-align:center">Same idea, but against someone who has to look you in the eye afterwards.</p>
  <div class="foot">Clashly holds no money, takes no stake and gives no prize. For the bragging rights. 18+.<br />contact@clashly.live &middot; <a href="https://x.com/clashlylive" rel="me noopener">@clashlylive</a> &middot; <a href="/credits.html">photo credits</a></div>
</div>
<script>
(function(){
  var KEY='clashly_voter';
  var v=null; try{ v=localStorage.getItem(KEY); if(!v){ v='v'+Math.random().toString(36).slice(2)+Date.now().toString(36); localStorage.setItem(KEY,v);} }catch(e){ v='v'+Date.now().toString(36); }
  var HOME=${JSON.stringify(w.home)}, AWAY=${JSON.stringify(w.away)}, RESULT=${JSON.stringify(w.result)};
  var mine=null;
  function pct(n,tot){ return tot?Math.round(n/tot*100):0; }
  function paint(t){
    var s=document.getElementById('split'); s.hidden=false;
    var rows=s.querySelectorAll('.row'), vals=[t.HOME,t.DRAW,t.AWAY];
    for(var i=0;i<rows.length;i++){
      rows[i].querySelector('.fill').style.width=pct(vals[i],t.total)+'%';
      rows[i].querySelector('.pc').textContent=pct(vals[i],t.total)+'%';
    }
    document.getElementById('cnt').textContent=t.total+(t.total===1?' call':' calls')+' so far';
  }
  function mark(o){
    mine=o;
    var bs=document.querySelectorAll('.opt');
    for(var i=0;i<bs.length;i++) bs[i].classList.toggle('on', bs[i].getAttribute('data-o')===o);
    document.getElementById('share').hidden=false;
    try{ if(!localStorage.getItem('clashly_named')) document.getElementById('nameWrap').hidden=false; }catch(e){}
  }
  function you(d){
    var el=document.getElementById('you'); if(!el) return;
    var rec=d.record||{}, bits=[];
    if(d.result && d.myCall){
      var won = d.myCall===d.result;
      bits.push('<span class="big">'+(won?('+'+d.points+' points'):'0 points')+'</span>'
        + (won ? ('You called it'+(d.crowd!=null?', and only '+d.crowd+'% agreed with you.':'.'))
               : 'Wrong one this week. Nothing lost, go again.'));
    } else if(d.myCall){
      bits.push('<span class="big">You are on the record</span>Come back after full time to see if you called it.');
    }
    if(rec.points) bits.push('<div style="margin-top:8px;color:#9AA7B8;font-size:12.6px">'
      + rec.points+' points all time · '+rec.right+'/'+rec.played+' right'
      + (rec.streak>1?' · '+rec.streak+' weeks running':'')+'</div>');
    if(bits.length){ el.innerHTML=bits.join(''); el.hidden=false; }
  }
  fetch('/api/weekly?v='+encodeURIComponent(v)).then(function(r){return r.json();}).then(function(d){
    if(d.tally) paint(d.tally);
    if(d.myCall) mark(d.myCall);
    you(d);
  }).catch(function(){});
  function markSlate(mid,o,crowd){
    var row=document.querySelector('.sm-row[data-mid="'+mid+'"]'); if(!row) return;
    var bs=row.querySelectorAll('.sm-opt');
    for(var i=0;i<bs.length;i++){
      var on = bs[i].getAttribute('data-o')===o;
      bs[i].classList.toggle('on', on);
      if(on && crowd && crowd.total){
        var pc=Math.round((crowd[o]||0)/crowd.total*100);
        bs[i].textContent = bs[i].textContent.replace(/ \d+%$/,'') + ' ' + pc + '%';
      }
    }
    var sh=document.getElementById('share'); if(sh) sh.hidden=false;
    try{ if(!localStorage.getItem('clashly_named')) document.getElementById('nameWrap').hidden=false; }catch(e){}
  }
  fetch('/api/slate?v='+encodeURIComponent(v)).then(function(r){return r.json();}).then(function(d){
    (d.matches||[]).forEach(function(m){ if(m.myCall) markSlate(m.id, m.myCall, m.tally); });
  }).catch(function(){});
  document.querySelectorAll('.sm-opt').forEach(function(b){
    b.addEventListener('click', function(){
      var mid=b.getAttribute('data-mid'), o=b.getAttribute('data-o');
      fetch('/api/slate/call',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({matchId:mid,outcome:o,v:v})})
        .then(function(r){return r.json();}).then(function(d){ if(d.match) markSlate(mid,o,d.match.tally); })
        .catch(function(){});
    });
  });
  document.getElementById('opts') && document.getElementById('opts').addEventListener('click', function(e){
    var b=e.target.closest('.opt'); if(!b) return;
    var o=b.getAttribute('data-o');
    fetch('/api/weekly/call',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({outcome:o,v:v})})
      .then(function(r){return r.json();}).then(function(d){ if(d.tally){ paint(d.tally); mark(o); d.myCall=o; you(d); } })
      .catch(function(){});
  });
  document.getElementById('share').addEventListener('click', function(){
    var lbl = mine==='HOME'?HOME+' win':mine==='AWAY'?AWAY+' win':'a draw';
    var txt = 'CLASHLY · '+HOME+' v '+AWAY+'\\nI called '+lbl+'.'+(RESULT?'':'\\nCall it before kickoff and we will see who was right.');
    if(navigator.clipboard){ navigator.clipboard.writeText(txt).then(function(){ var b=document.getElementById('share'); b.textContent='Copied — paste it in the chat'; }); }
  });
  var sv=document.getElementById('saveNm');
  sv && sv.addEventListener('click', function(){
    var n=document.getElementById('nm').value.trim(); if(n.length<2) return;
    fetch('/api/weekly/name',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({v:v,name:n})})
      .then(function(r){return r.json();}).then(function(){ try{localStorage.setItem('clashly_named','1');}catch(e){}
        document.getElementById('nameWrap').hidden=true; });
  });
})();
</script>
</body></html>`;
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
  res.end(html);
}

function guidePageHtml(path, g) {
  const url = 'https://clashly.live' + path;
  const ld = {
    '@context': 'https://schema.org',
    '@graph': [
      { '@type': 'Article', headline: g.h1, inLanguage: g.lang, url,
        author: { '@type': 'Organization', name: 'Clashly', url: 'https://clashly.live/' } },
      { '@type': 'FAQPage', mainEntity: g.faq.map(([q, a]) => ({ '@type': 'Question', name: q, acceptedAnswer: { '@type': 'Answer', text: a } })) },
    ],
  };
  const pl = g.lang === 'pl';
  return `<!DOCTYPE html>
<html lang="${g.lang}"><head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${esc5(g.title)}</title>
<meta name="description" content="${esc5(g.desc)}" />
<link rel="canonical" href="${url}" />
<link rel="icon" type="image/svg+xml" href="/favicon.svg" />
<meta property="og:type" content="article" />
<meta property="og:title" content="${esc5(g.title)}" />
<meta property="og:description" content="${esc5(g.desc)}" />
<meta property="og:url" content="${url}" />
<meta property="og:image" content="https://clashly.live/og-home.png" />
<meta name="twitter:card" content="summary_large_image" />
<script type="application/ld+json">${JSON.stringify(ld)}</script>
<style>${PAGE_CSS}</style>
</head><body><div class="wrap">
  <div class="tag">CLASHLY</div>
  <h1>${esc5(g.h1)}</h1>
  ${g.body}
  <a class="cta" href="/">${pl ? 'Rzuć wyzwanie ziomkowi →' : 'Challenge a mate →'}</a>
  <p><a href="/about">${pl ? 'Czym jest Clashly?' : 'What is Clashly?'}</a></p>
  <div class="foot">Clashly ${pl ? 'nie trzyma pieniędzy, rozliczacie się między sobą. 18+.' : 'holds no money, you settle up between yourselves. For the bragging rights. 18+.'}<br />contact@clashly.live · <a href="https://x.com/clashlylive" rel="me noopener">@clashlylive</a></div>
</div></body></html>`;
}

async function serveFixturePage(req, res, slug, lang) {
  let matches = [];
  try { matches = (await getMatches()) || []; } catch {}
  const m = matches.find((x) => fixtureSlug(x) === slug);
  if (!m) { res.writeHead(302, { Location: lang === 'pl' ? '/?lang=pl' : '/' }); return res.end(); }
  const html = fixturePageHtml(m, lang);
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=900' });
  res.end(html);
}

async function serveSitemap(req, res) {
  let matches = [];
  try { matches = (await getMatches()) || []; } catch {}
  const urls = [
    ['https://clashly.live/', 'daily', '1.0'],
    ['https://clashly.live/about', 'monthly', '0.8'],
    ['https://clashly.live/this-week', 'daily', '0.9'],
    ['https://clashly.live/arcade', 'weekly', '0.6'],
    ['https://clashly.live/daily', 'daily', '0.8'],
    ['https://clashly.live/hilo', 'weekly', '0.6'],
    ['https://clashly.live/penalty', 'weekly', '0.5'],
    ['https://clashly.live/keepy', 'weekly', '0.5'],
  ];
  Object.keys(GUIDES).forEach((p) => urls.push(['https://clashly.live' + p, 'monthly', '0.8']));
  matches.slice(0, 60).forEach((m) => {
    const sl = fixtureSlug(m);
    urls.push([`https://clashly.live/call/${sl}`, 'daily', '0.7']);
    urls.push([`https://clashly.live/pl/call/${sl}`, 'daily', '0.6']);
  });
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map(([u, cf, pr]) => `  <url>\n    <loc>${u}</loc>\n    <changefreq>${cf}</changefreq>\n    <priority>${pr}</priority>\n  </url>`).join('\n')}\n</urlset>\n`;
  res.writeHead(200, { 'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': 'public, max-age=3600' });
  res.end(xml);
}

// llms.txt — the plain-language brief an answer engine reads instead of guessing.
async function serveLlmsTxt(req, res) {
  let matches = [];
  try { matches = (await getMatches()) || []; } catch {}
  const txt = `# Clashly

> Clashly (clashly.live) is a free web app for settling football bets between friends. One person calls a match outcome, a friend takes the other side through a shared link, and after full time both confirm the result. The winner goes on a running head-to-head record.

## What Clashly is not
Clashly is not a bookmaker, sportsbook or prediction market. It holds no money, accepts no stakes, pays no prizes and takes no commission. There is no stake and no prize: it is a scorekeeper. Any forfeit or stake is settled privately between the friends themselves. It is for people aged 18 and over.

## How it works
1. Call it. Pick a match, back an outcome, and name what is on the line (a forfeit such as "loser buys the pints", or bragging rights).
2. Send the link. Your friend opens it and takes the other side. No account is required to accept.
3. Settle it. After the match both sides confirm the result. If they disagree the bet is voided, so the record cannot be faked.

## Key facts
- Free. Web based, works in a browser, no app store download.
- Languages: English and Polish.
- Features: head-to-head rivalry records, friends leagues, shareable result cards and betting-slip receipts, an open challenge Arena, weekly and all-time records.
- Contact: contact@clashly.live
- On X: https://x.com/clashlylive (@clashlylive)

## Pages
- https://clashly.live/ (app)
- https://clashly.live/about (what Clashly is and how it works)
- https://clashly.live/this-week (the weekly call: one fixture, one tap, no account, public record)
- https://clashly.live/arcade (football skill games; points join the public board; no money, no prizes)
- https://clashly.live/daily (The Daily: guess the footballer from their career, one a day, six guesses)
- https://clashly.live/hilo (Higher or Lower: streak the famous transfer fees)
${Object.entries(GUIDES).map(([p, g]) => `- https://clashly.live${p} (${g.h1})`).join('\n')}
${matches.slice(0, 20).map((m) => `- https://clashly.live/call/${fixtureSlug(m)} (${m.home} v ${m.away})`).join('\n')}
`;
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'public, max-age=3600' });
  res.end(txt);
}

function serveAbout(req, res) {
  const html = `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>What is Clashly? Settle football bets with friends — on the record</title>
<meta name="description" content="Clashly is a free app to settle football bets with friends. Call a match, your mate takes the other side, and the winner goes on the record. No money is held — just bragging rights. Here's how it works." />
<link rel="canonical" href="https://clashly.live/about" />
<link rel="icon" type="image/svg+xml" href="/favicon.svg" />
<meta property="og:type" content="article" />
<meta property="og:title" content="What is Clashly? Settle football bets with friends" />
<meta property="og:description" content="Call a match, your mate takes the other side, the winner goes on the record. Free, no money held, just bragging rights." />
<meta property="og:url" content="https://clashly.live/about" />
<meta property="og:image" content="https://clashly.live/og-home.png" />
<meta name="twitter:card" content="summary_large_image" />
<style>
  :root { color-scheme: dark; }
  body { margin:0; background:#0A0E13; color:#F4F7FB; font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; line-height:1.65; }
  .wrap { max-width:720px; margin:0 auto; padding:48px 20px 80px; }
  h1 { font-size:30px; line-height:1.15; letter-spacing:-.5px; margin:0 0 8px; }
  h2 { font-size:21px; margin:36px 0 10px; letter-spacing:-.3px; }
  h3 { font-size:16px; margin:22px 0 6px; color:#14E0C8; }
  p, li { color:#C7D0DB; font-size:16px; }
  a { color:#14E0C8; }
  .lede { font-size:18px; color:#E8EDF4; }
  .cta { display:inline-block; margin:26px 0; background:#14E0C8; color:#06140f; font-weight:800; text-decoration:none; padding:14px 22px; border-radius:12px; }
  ol li, ul li { margin:6px 0; }
  .foot { margin-top:48px; padding-top:20px; border-top:1px solid #33414F; color:#7C8A9C; font-size:13px; }
  .tag { color:#14E0C8; font-weight:700; letter-spacing:2px; font-size:12px; text-transform:uppercase; }
</style>
</head><body>
<div class="wrap">
  <div class="tag">CLASHLY · clashly.live</div>
  <h1>Settle football bets with your mates — on the record.</h1>
  <p class="lede">Clashly turns "I bet you Arsenal win" into a proper, tracked rivalry. Call the match, your friend takes the other side, and the winner goes on the record. Free, no money held, just bragging rights.</p>
  <a class="cta" href="/">Start a duel →</a>

  <h2>How to settle a bet with a friend</h2>
  <ol>
    <li><strong>Call it.</strong> Pick a football match and back an outcome — a team to win, a draw, or your own custom call — and name what's on the line (a forfeit, first round, or just bragging rights).</li>
    <li><strong>Send the link.</strong> Clashly gives you a challenge link with a share card. Drop it in the group chat; your mate taps it and takes the other side.</li>
    <li><strong>Settle it.</strong> After full time you both confirm the result. If you disagree, the bet is voided — nobody can cheat the record. The winner goes on the record and your head-to-head rivalry table updates.</li>
  </ol>

  <h2>Does Clashly handle money?</h2>
  <p>No. Clashly is a <strong>scorekeeper</strong>, not a bookmaker. It never processes payments, holds stakes, or takes a cut. Any stake is settled privately between friends. Clashly is for players aged 18 and over and is designed for friendly bets and bragging rights — not gambling.</p>

  <h2>What makes it stick</h2>
  <ul>
    <li><strong>Rivalries.</strong> Every settled bet feeds a running head-to-head record with each mate — the score you actually argue about.</li>
    <li><strong>Friends leagues.</strong> Turn a group chat into a season table where every duel between members counts.</li>
    <li><strong>Shareable cards.</strong> Each bet and result renders a card built to be posted on WhatsApp, Instagram Stories, and X.</li>
    <li><strong>High scores.</strong> Weekly and all-time crowns — longest win streak, most duels, best record — so there's always something to chase.</li>
  </ul>

  <h2>Who it's for</h2>
  <p>Football fans and friend groups who are always betting on matches but never keep track — five-a-side teams, fantasy-league mini-leagues, office rivalries, and family group chats. If your mates argue about who called it right, Clashly settles it.</p>

  <a class="cta" href="/">Back yourself — start a duel →</a>
  <div class="foot">Clashly keeps score and holds no money — you and your mates settle up between yourselves. For the bragging rights. 18+. · <a href="/">clashly.live</a> · <a href="mailto:contact@clashly.live">contact@clashly.live</a> · <a href="https://x.com/clashlylive" rel="me noopener">@clashlylive</a></div>
</div>
</body></html>`;
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=3600' });
  res.end(html);
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
      // cache-bust the image URL when the bet changes state, so a re-share after
      // accept/resolve unfurls the NEW card instead of a scraper's stale copy
      const v = encodeURIComponent(bet.status + (bet.resolvedAt || bet.acceptedAt || bet.createdAt || ''));
      const img = `${origin}/card/${id}.png?v=${v}`;
      const meta = ogMeta({ title, desc, img, pageUrl: `${origin}/b/${id}`, alt: `${matchLabel(bet)} — ${title}`, stamp: bet.resolvedAt || bet.acceptedAt || bet.createdAt });
      html = html.replace('</head>', meta + '  </head>');
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  });
}

// ---------------------------------------------------------------------------
// Seed some history so a fresh demo shows live rivalries
// ---------------------------------------------------------------------------
// One-time demo handover reset (Aug 2026): wipe QA/crowdtest accounts and bets,
// keep infrastructure meta (VAPID push keys, MOTW pick), and pre-warm the Terrace
// with rage-bait takes from HOUSE BOTS (always bot-labeled — Clashly never fakes
// users). Runs once; the demoReset1 flag makes redeploys safe.
function demoHandoverReset() {
  if (!db.meta) db.meta = {};
  if (db.meta.demoReset1) return;
  db.players = {}; db.bets = {}; db.terrace = []; db.events = []; db.leagues = {}; db.stats = {};
  rebuildSecretIndex();
  // [voice, text] — takes verified against the real 2025-26 season (Arsenal champions +
  // UCL final loss, Utd 3rd under Carrick, Spurs' near-relegation, Spain WC 2026,
  // Lewandowski to Chicago Fire, Poland's playoff loss, Lech back-to-back).
  const VOICES = {
    pundit: ['__v_pundit', 'The Pundit'], gaffer: ['__v_gaffer', 'The Gaffer'],
    var: ['__v_var', 'VAR Truther'], stats: ['__v_stats', 'xG Nerd'],
    lewy: ['__v_lewy', 'Lewy Stan'], old: ['__v_old', 'Old School'],
  };
  const TAKES = [
    ['old', 'Messi lost his last ever World Cup final. Ronaldo would’ve buried that chance. Debate over \u{1F410}'],
    ['pundit', 'Yamal is a world champion at 19. Messi wasn’t. It’s already his era \u{1F1EA}\u{1F1F8}'],
    ['gaffer', 'Haaland is a tap-in merchant. Take away City’s midfield and he’s Andy Carroll with a ponytail'],
    ['old', 'Pelé wouldn’t get in the current Brighton squad and you all know it'],
    ['pundit', 'Bellingham does more actual football than Mbappé. Fight me'],
    ['gaffer', 'Arsenal won the league then bottled the Champions League final. Once a bottler, always a bottler \u{1F37E}'],
    ['stats', '61 points to win the title?? Weakest Premier League winners ever. Asterisk season ⭐'],
    ['pundit', 'Carrick walked in and did in 5 months what ten Hag and Amorim couldn’t. Utd are BACK'],
    ['gaffer', 'Man Utd finished 3rd and still lost to Grimsby. Big club? Behave \u{1F62D}'],
    ['old', 'Liverpool went champions to 5th in one season. Slot was carried by Klopp’s squad all along'],
    ['pundit', 'Spurs won a European trophy then nearly got relegated the next year. Most Spursy arc in history'],
    ['stats', 'Bruno breaks the assist record and you lot still call him a penalty merchant. Jealousy is a disease'],
    ['old', 'The Hand of God was the most streetwise moment in football history. Cope harder, England \u{1F91A}'],
    ['old', 'Suárez’s handball vs Ghana was the most selfless thing a striker’s ever done. He took the red FOR the team'],
    ['gaffer', 'Lampard’s ghost goal doesn’t matter. Germany were battering England anyway — 4-1 flattered YOU'],
    ['var', 'Henry handballs Ireland out of a World Cup and gets a legends documentary. Football’s rigged for big names'],
    ['var', 'VAR ruined the Liverpool game on opening night and you still want to keep it?? Scrap it all \u{1F4FA}\u{1F5D1}️'],
    ['var', 'They literally publish tables of VAR errors now and you still trust Stockley Park \u{1F480}'],
    ['lewy', 'Lewandowski is top 3 strikers EVER and it’s not close. Ask Bayern. Ask the Bundesliga. Ask anyone \u{1F1F5}\u{1F1F1}'],
    ['lewy', 'Lewy in MLS at 38 while Poland watched the World Cup from the sofa. National embarrassment, not his fault'],
    ['lewy', 'Losing to SWEDEN to miss the World Cup. Again. This federation could ruin a two-car parade'],
    ['lewy', 'Lech back-to-back champions and Legia mid-table. Warsaw’s a museum, Poznań’s the capital now \u{1F682}'],
    ['gaffer', 'Górnik finishing 2nd above Legia is the funniest thing Ekstraklasa has ever produced'],
    ['lewy', 'Ekstraklasa is a better watch than Serie A. Yes I said it. No I’m not sober. Yes I’m right'],
    ['old', 'Modern football died the day they invented VAR and £9 pints. Non-league is the real game now ⚰️'],
    ['gaffer', 'Penalties aren’t a lottery. Your keeper’s just bad and your takers are cowards'],
    ['pundit', 'Any league your club wins easily is a farmers league. That’s the rule. Yes, including yours \u{1F69C}'],
    ['stats', 'xG is astrology for men who’ve never had a shot on target in their lives \u{1F4CA}'],
    ['old', 'One World Cup > ten Champions Leagues. Club football is just the warm-up and deep down you agree'],
  ];
  const now = Date.now();
  TAKES.forEach(([v, text], i) => {
    const [byId, by] = VOICES[v];
    // staggered over the last ~3 days so the feed reads lived-in, not bulk-loaded
    db.terrace.push({ id: newId(), byId, by, bot: true, text, t: new Date(now - (TAKES.length - i) * 9800000).toISOString() });
  });
  db.meta.demoReset1 = true;
  saveData();
  console.log(`\u{1F9F9} demo handover reset: data wiped, terrace seeded with ${TAKES.length} takes`);
}

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
const STATIC_TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8', '.xml': 'application/xml; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.webmanifest': 'application/manifest+json' };
// cache policy: the HTML shell must stay fresh (it's re-served with OG meta on share
// routes), but app.js/styles.css can be briefly cached and the favicon for a day.
const STATIC_CACHE = { '.css': 'public, max-age=300', '.js': 'public, max-age=300', '.svg': 'public, max-age=86400', '.ico': 'public, max-age=86400', '.jpg': 'public, max-age=604800', '.html': 'no-cache' };
function serveStatic(req, res) {
  let urlPath = req.url.split('?')[0];
  if (urlPath === '/') urlPath = '/index.html';
  const filePath = path.join(PUBLIC, path.normalize(urlPath));
  if (!filePath.startsWith(PUBLIC)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(filePath, (err, buf) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    const ext = path.extname(filePath);
    const type = STATIC_TYPES[ext] || 'application/octet-stream';
    const headers = { 'Content-Type': type, 'Cache-Control': STATIC_CACHE[ext] || 'no-cache' };
    // gzip text assets when the client accepts it (app.js ~77KB → ~20KB on the wire)
    const isText = /^(text\/|image\/svg|application\/(javascript|json))/.test(type);
    if (isText && /\bgzip\b/.test(req.headers['accept-encoding'] || '')) {
      headers['Content-Encoding'] = 'gzip';
      headers['Vary'] = 'Accept-Encoding';
      buf = zlib.gzipSync(buf);
    }
    res.writeHead(200, headers);
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
  // GET /api/arcade — today's cap state; POST /api/arcade/score — clamped award
  if (req.method === 'GET' && parts[1] === 'arcade' && parts.length === 2) {
    const me = authPlayer(req);
    const vid = me ? me.id : String(url.searchParams.get('v') || '');
    if (!vid) return sendJson(res, 400, { error: 'Missing voter' });
    return sendJson(res, 200, arcadeState(vid));
  }
  if (req.method === 'POST' && parts[1] === 'arcade' && parts[2] === 'score') {
    const b = await readBody(req);
    const me = authPlayer(req);
    const vid = me ? me.id : String(b.v || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40);
    if (!vid) return sendJson(res, 400, { error: 'Missing voter' });
    const out = arcadeAward(vid, String(b.game || ''), b.score);
    if (!out) return sendJson(res, 400, { error: 'Unknown game' });
    if (me) { if (!db.voterNames) db.voterNames = {}; db.voterNames[me.id] = me.name; }
    saveData();
    logEvent('arcade_score', { game: b.game, awarded: out.awarded }, false);
    return sendJson(res, 200, out);
  }

  // GET /api/slate — the rest of the weekend's big games, callable with no auth
  if (req.method === 'GET' && parts[1] === 'slate' && parts.length === 2) {
    const wk = weekIdx(Date.now());
    const sl = await getSlate(wk);
    const me = authPlayer(req);
    const vid = me ? me.id : String(url.searchParams.get('v') || '');
    return sendJson(res, 200, {
      week: wk,
      matches: sl ? sl.matches.map((m) => slateMatchView(m, vid)) : [],
    });
  }

  // POST /api/slate/call — one tap on one fixture. Same contract as the weekly.
  if (req.method === 'POST' && parts[1] === 'slate' && parts[2] === 'call') {
    const b = await readBody(req);
    const wk = weekIdx(Date.now());
    const sl = await getSlate(wk);
    if (!sl) return sendJson(res, 400, { error: 'No slate this week yet' });
    const m = (sl.matches || []).find((x) => x.id === String(b.matchId || ''));
    if (!m) return sendJson(res, 404, { error: 'Not on this week\'s slate' });
    if (!WEEKLY_OUTCOMES.includes(b.outcome)) return sendJson(res, 400, { error: 'Pick one' });
    if (m.utcDate && new Date(m.utcDate).getTime() < Date.now())
      return sendJson(res, 409, { error: 'Kicked off — calls are closed' });
    const me = authPlayer(req);
    const vid = me ? me.id : String(b.v || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40);
    if (!vid) return sendJson(res, 400, { error: 'Missing voter' });
    const isNew = !m.calls[vid];
    m.calls[vid] = b.outcome;
    if (me) { if (!db.voterNames) db.voterNames = {}; db.voterNames[me.id] = me.name; }
    saveData();
    if (isNew) logEvent('slate_call', { week: wk, match: m.id, outcome: b.outcome }, false);
    return sendJson(res, 200, { ok: true, match: slateMatchView(m, vid) });
  }

  // ---- THE WEEKLY CALL --------------------------------------------------
  // GET /api/weekly — the question, the split, your call, the board.
  // Deliberately readable with NO auth: a cold visitor from X must be able to
  // see and answer it before they are anybody.
  if (req.method === 'GET' && parts[1] === 'weekly' && parts.length === 2) {
    const wk = weekIdx(Date.now());
    const w = await getWeekly(wk);
    if (!w) return sendJson(res, 200, { week: wk, match: null });
    const me = authPlayer(req);
    const vid = me ? me.id : String(url.searchParams.get('v') || '');
    const last = db.weekly[wk - 1] && db.weekly[wk - 1].result ? db.weekly[wk - 1] : null;
    return sendJson(res, 200, {
      week: wk,
      match: { home: w.home, away: w.away, competition: w.competition, utcDate: w.utcDate },
      tally: weeklyTally(w),
      myCall: vid ? (w.calls[vid] || null) : null,
      named: Boolean(vid && (w.names[vid] || (me && me.name))),
      result: w.result || null,
      crowd: weeklyCrowdPct(w),
      points: vid ? weeklyPointsFor(w, w.calls[vid]) : 0,
      locked: Boolean(w.utcDate && new Date(w.utcDate).getTime() < Date.now()),
      record: vid ? weeklyRecord(vid) : null,
      last: last ? { home: last.home, away: last.away, result: last.result,
                     myCall: vid ? (last.calls[vid] || null) : null, tally: weeklyTally(last),
                     crowd: weeklyCrowdPct(last),
                     points: vid ? weeklyPointsFor(last, last.calls[vid]) : 0 } : null,
      board: weeklyBoard(),
    });
  }

  // POST /api/weekly/call — one tap, no account. The whole point of the feature
  // is that this works for someone who has never heard of Clashly.
  if (req.method === 'POST' && parts[1] === 'weekly' && parts[2] === 'call') {
    const b = await readBody(req);
    const wk = weekIdx(Date.now());
    const w = await getWeekly(wk);
    if (!w) return sendJson(res, 400, { error: 'No call this week yet' });
    if (!WEEKLY_OUTCOMES.includes(b.outcome)) return sendJson(res, 400, { error: 'Pick one' });
    if (w.utcDate && new Date(w.utcDate).getTime() < Date.now())
      return sendJson(res, 409, { error: 'Kicked off — calls are closed' });
    const me = authPlayer(req);
    const vid = me ? me.id : String(b.v || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40);
    if (!vid) return sendJson(res, 400, { error: 'Missing voter' });
    const isNew = !w.calls[vid];
    w.calls[vid] = b.outcome;
    if (me) w.names[vid] = me.name;
    else if (b.name) w.names[vid] = String(b.name).slice(0, 40);
    saveData();
    if (isNew) logEvent('weekly_call', { week: wk, outcome: b.outcome }, false);
    return sendJson(res, 200, { ok: true, tally: weeklyTally(w), myCall: b.outcome, record: weeklyRecord(vid) });
  }

  // POST /api/weekly/name — the upgrade prompt: an anonymous caller putting
  // their name on the board. Asked AFTER the call, never before it.
  if (req.method === 'POST' && parts[1] === 'weekly' && parts[2] === 'name') {
    const b = await readBody(req);
    const wk = weekIdx(Date.now());
    const w = db.weekly && db.weekly[wk];
    if (!w) return sendJson(res, 404, { error: 'No call this week' });
    const vid = String(b.v || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40);
    const name = String(b.name || '').trim().slice(0, 40);
    const sl = db.slate && db.slate[wk];
    const calledSlate = sl && (sl.matches || []).some((m) => m.calls && m.calls[vid]);
    if (!vid || (!w.calls[vid] && !calledSlate)) return sendJson(res, 400, { error: 'Call it first' });
    if (name.length < 2) return sendJson(res, 400, { error: 'Add a name' });
    w.names[vid] = name;
    if (!db.voterNames) db.voterNames = {};
    db.voterNames[vid] = name;              // the slate has no per-week names map
    saveData();
    logEvent('weekly_named', { week: wk }, false);
    return sendJson(res, 200, { ok: true, board: weeklyBoard() });
  }

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

  // The Terrace megaphone — public announcements. Rage bait welcome, slurs masked,
  // one post a minute per player, feed capped so it stays fresh.
  if (req.method === 'GET' && parts[1] === 'terrace' && parts.length === 2) {
    const rows = db.terrace.slice(-30).reverse().map((p) => {
      const ps = playerSummary(p.byId);
      return { ...p, record: `${ps.w}–${ps.l}`, streakType: ps.streak.type, streakCount: ps.streak.count, arenaPts: ps.arenaPts };
    });
    return sendJson(res, 200, { posts: rows });
  }
  if (req.method === 'POST' && parts[1] === 'terrace' && parts.length === 2) {
    const me = authPlayer(req); if (!me) return need401();
    const b = await readBody(req);
    const text = maskProfanity(String(b.text || '').trim().slice(0, 180));
    if (text.length < 2) return sendJson(res, 400, { error: 'Say something worth saying' });
    const last = [...db.terrace].reverse().find((p) => p.byId === me.id);
    if (last && Date.now() - new Date(last.t).getTime() < 60000)
      return sendJson(res, 429, { error: 'Easy — one megaphone a minute. Let it land.' });
    const post = { id: newId(), byId: me.id, by: me.name, text, t: new Date().toISOString() };
    db.terrace.push(post);
    if (db.terrace.length > 200) db.terrace = db.terrace.slice(-200);
    logEvent('terrace_post', { id: post.id });
    return sendJson(res, 201, post);
  }

  // GET /api/arena — the open-challenge pool: public bets anyone signed-in can take.
  // The competitive loop: strangers, points, and a crown worth defending.
  if (req.method === 'GET' && parts[1] === 'arena' && parts.length === 2) {
    const now = Date.now();
    const rows = Object.values(db.bets)
      .filter((b) => b.arena && b.status === 'open' && !isGhostBet(b) && (!b.utcDate || new Date(b.utcDate).getTime() > now))
      .sort((a, c) => new Date(c.createdAt) - new Date(a.createdAt))
      .slice(0, 30)
      .map((b) => {
        const ps = playerSummary(b.proposerId);
        return {
          id: b.id, home: b.home, away: b.away, kind: b.kind, competition: b.competition, utcDate: b.utcDate,
          backedOutcome: b.backedOutcome, stake: b.stake, currency: b.currency, line: b.line, note: b.note,
          proposerId: b.proposerId, proposerName: b.proposerName,
          proposerStats: { w: ps.w, l: ps.l, streakType: ps.streak.type, streakCount: ps.streak.count, arenaPts: ps.arenaPts },
          offers: (b.offers || []).filter((o) => o.status === 'pending').length,
        };
      });
    const recent = [...decidedBets()].sort(byRecent).slice(0, 8).map((b) => ({
      home: b.home, away: b.away, kind: b.kind,
      winner: b.owes ? b.owes.to : (b.winner === 'proposer' ? b.proposerName : b.opponentName),
      loser: b.owes ? b.owes.from : (b.winner === 'proposer' ? b.opponentName : b.proposerName),
      stakeLbl: b.line || (b.stake > 0 ? (b.currency || 'EUR') + ' ' + b.stake : 'bragging rights'),
      arena: Boolean(b.arena), t: b.resolvedAt,
    }));
    return sendJson(res, 200, { challenges: rows, recent });
  }

  // GET /api/records?window=week|all — the high-scores board: many small crowns,
  // time-windowed so the race resets and anyone can hold one THIS week.
  if (req.method === 'GET' && parts[1] === 'records') {
    const win = url.searchParams.get('window') === 'all' ? 'all' : 'week';
    const since = win === 'week' ? Date.now() - 7 * 86400000 : 0;
    const rel = decidedBets().filter((b) => new Date(b.resolvedAt || 0).getTime() >= since);
    const agg = {};
    for (const b of rel) for (const pid of [b.proposerId, b.opponentId]) {
      if (!pid) continue;
      const a = (agg[pid] = agg[pid] || { w: 0, l: 0 });
      if (winnerId(b) === pid) a.w++; else a.l++;
    }
    const rows = Object.entries(agg).map(([pid, a]) => ({ pid, name: nameOf(pid) || '?', w: a.w, l: a.l, duels: a.w + a.l }));
    const byP = {};
    for (const b of [...rel].sort((a, c) => new Date(a.resolvedAt || 0) - new Date(c.resolvedAt || 0)))
      for (const pid of [b.proposerId, b.opponentId]) {
        if (!pid) continue;
        const st = (byP[pid] = byP[pid] || { run: 0, max: 0 });
        if (winnerId(b) === pid) { st.run++; if (st.run > st.max) st.max = st.run; } else st.run = 0;
      }
    let streak = null;
    for (const [pid, st] of Object.entries(byP)) if (st.max >= 2 && (!streak || st.max > streak.count)) streak = { name: nameOf(pid) || '?', count: st.max };
    const pairs = {};
    for (const b of rel) { const k = [b.proposerId, b.opponentId].sort().join('|'); pairs[k] = (pairs[k] || 0) + 1; }
    const fp = Object.entries(pairs).sort((x, y) => y[1] - x[1])[0];
    const fiercest = fp && fp[1] >= 2 ? { a: nameOf(fp[0].split('|')[0]) || '?', b: nameOf(fp[0].split('|')[1]) || '?', games: fp[1] } : null;
    const sortTop = (key, min) => rows.filter((r) => r[key] > 0 && r.duels >= (min || 1)).sort((x, y) => y[key] - x[key])[0] || null;
    return sendJson(res, 200, {
      window: win, streak,
      mostDuels: sortTop('duels'),
      bestRecord: rows.filter((r) => r.duels >= 3).sort((x, y) => (y.w / y.duels) - (x.w / x.duels))[0] || null,
      biggestBottle: sortTop('l', 2),
      fiercest,
      table: [...rows].sort((x, y) => (y.w - x.w) || (x.l - y.l) || (y.duels - x.duels)).slice(0, 10).map((r) => ({ name: r.name, w: r.w, l: r.l, arenaPts: (db.players[r.pid] && db.players[r.pid].arenaPts) || 0 })),
      arenaKing: (() => { const agg = {}; for (const b of rel) if (b.arena) { const wid = winnerId(b); if (wid) agg[wid] = (agg[wid] || 0) + 1; } const top = Object.entries(agg).sort((x, y) => y[1] - x[1])[0]; return top ? { name: nameOf(top[0]) || '?', wins: top[1] } : null; })(),
    });
  }

  // -------------------------------------------------------------------------
  // Identity
  // -------------------------------------------------------------------------

  // POST /api/players  {name}  — register this device (or rename if already authed)
  // POST /api/track — the funnel steps that only the client can see. Strictly
  // whitelisted and count-only: no ids, no bodies, no free text, so it can never
  // become a way to write junk into the store. Mirrors what PostHog gets, so the
  // funnel is answerable from /api/stats alone.
  if (req.method === 'POST' && parts[1] === 'track' && parts.length === 2) {
    const b = await readBody(req).catch(() => ({}));
    const ev = String(b.e || '');
    if (!CLIENT_EVENTS.has(ev)) return sendJson(res, 400, { error: 'unknown event' });
    logEvent('c_' + ev, {}, false);        // c_ prefix: client-reported, never trusted as truth
    return sendJson(res, 204, {});
  }

  if (req.method === 'POST' && parts[1] === 'players' && parts.length === 2) {
    const b = await readBody(req);
    const existing = authPlayer(req);
    if (existing) {
      if (b.name) { existing.name = String(b.name).slice(0, 40) || existing.name; saveData(); }
      return sendJson(res, 200, selfPlayer(existing));
    }
    const p = createPlayer(b.name || 'Player');
    logEvent('player_created', {}, false);
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
    if (req.method === 'GET' && parts[3] === 'summary') return sendJson(res, 200, { ...playerSummary(me.id), platformRecord: platformRecord() });
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
        id: b.id, home: b.home, away: b.away, kind: b.kind, status: b.status,
        opponent: b.opponentId ? nameForId(b, otherId(b, me.id)) : null,
        backed: outcomeLabel(b, b.backedOutcome), stake: b.stake, currency: b.currency,
        mine: b.proposerId === me.id,
        won: (b.status === 'resolved' || b.status === 'settled') ? winnerId(b) === me.id : null,
        pending: Boolean(b.pendingResult), createdAt: b.createdAt,
        // it's YOUR move when the other player reported a result awaiting your confirm,
        // or the match has kicked off with nothing reported yet
        yourMove: b.status === 'accepted' && (
          (b.pendingResult && b.pendingResult.byId !== me.id) ||
          (!b.pendingResult && b.utcDate && Date.now() > new Date(b.utcDate).getTime()) ||
          // custom calls carry no kickoff time, so they would never surface at all.
          // A day after the handshake is the honest moment to ask "well? who won?"
          (!b.pendingResult && !b.utcDate && b.acceptedAt
            && Date.now() - new Date(b.acceptedAt).getTime() > 24 * 3600000)
        ),
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

  // Push subscription management
  if (req.method === 'GET' && parts[1] === 'push' && parts[2] === 'key') {
    return sendJson(res, 200, { key: (webpush && db.meta && db.meta.vapid) ? db.meta.vapid.publicKey : null });
  }
  if (req.method === 'POST' && parts[1] === 'push' && parts[2] === 'subscribe') {
    const me = authPlayer(req); if (!me) return need401();
    const b = await readBody(req);
    if (!b.subscription || !b.subscription.endpoint) return sendJson(res, 400, { error: 'subscription required' });
    db.push = db.push || {};
    const subs = (db.push[me.id] || []).filter((s) => s.endpoint !== b.subscription.endpoint);
    subs.push(b.subscription);
    db.push[me.id] = subs.slice(-5);
    saveData();
    return sendJson(res, 200, { ok: true });
  }

  // GET /api/activity — the live ticker: recent public happenings, no secrets
  if (req.method === 'GET' && parts[1] === 'activity' && parts.length === 2) {
    const items = [];
    for (const b of Object.values(db.bets)) {
      if (isGhostBet(b)) continue;   // the ticker is public too — no QA accounts here either
      if (b.arena && b.createdAt) items.push({ t: b.createdAt, text: `${b.proposerName} listed ${matchLabel(b)} in the Arena` });
      if (b.acceptedAt && b.opponentName) items.push({ t: b.acceptedAt, text: `${b.opponentName} took ${b.proposerName}'s bet` });
      if (b.resolvedAt && b.owes) items.push({ t: b.resolvedAt, text: `${b.owes.to} beat ${b.owes.from} (${matchLabel(b)})` });
    }
    for (const p of (db.terrace || []).slice(-10)) items.push({ t: p.t, text: `${p.by} sounded off on the Terrace` });
    items.sort((a, c) => new Date(c.t) - new Date(a.t));
    return sendJson(res, 200, { items: items.slice(0, 12) });
  }

  // GET /api/motw — Match of the Week: one Pundit-curated fixture per gameweek
  // that EVERYONE is prompted to call. Same match for all = the water-cooler moment.
  if (req.method === 'GET' && parts[1] === 'motw' && parts.length === 2) {
    const wk = weekIdx(Date.now());
    if (!db.meta) db.meta = {};
    let mo = db.meta.motw;
    const stale = !mo || mo.week !== wk || !mo.match || new Date(mo.match.utcDate || 0).getTime() < Date.now();
    if (stale) {
      const COMP_W2 = [[/world cup|fifa|\bwc\b/i, 100], [/champions league/i, 80], [/europa/i, 55], [/premier league/i, 50], [/la ?liga/i, 45], [/serie a/i, 42], [/bundesliga/i, 42], [/eredivisie/i, 40], [/ligue 1/i, 38]];
      const BIG2 = /man(chester)? (city|united)|liverpool|arsenal|chelsea|tottenham|newcastle|real madrid|barcelona|atl[ée]tico|bayern|dortmund|leverkusen|psg|paris|inter|ac milan|juventus|napoli|ajax|psv|feyenoord|benfica|porto|celtic|rangers|galatasaray|boca|river|flamengo/i;
      const now = Date.now();
      const matches = (await getMatches()) || [];
      const pick = matches
        .filter((x) => x.utcDate && new Date(x.utcDate).getTime() > now)
        .map((x) => {
          let sc = 0;
          for (const [re, w] of COMP_W2) if (re.test(x.competition || '')) { sc += w; break; }
          if (BIG2.test(x.home)) sc += 25;
          if (BIG2.test(x.away)) sc += 25;
          return { x, sc };
        })
        .sort((a, b) => (b.sc - a.sc) || (new Date(a.x.utcDate) - new Date(b.x.utcDate)))[0];
      if (!pick) return sendJson(res, 200, { week: wk, match: null });
      mo = { week: wk, match: pick.x };
      db.meta.motw = mo;
      saveData();
    }
    return sendJson(res, 200, mo);
  }

  // POST /api/bets
  if (req.method === 'POST' && parts[1] === 'bets' && parts.length === 2) {
    const me = authPlayer(req); if (!me) return need401();
    const b = await readBody(req);
    const season = b.kind === 'season';
    // a season call has no opponent team, and no draw to sit on
    if (!b.home || (!season && !b.away) || !OUTCOMES.includes(b.backedOutcome)
        || (season && b.backedOutcome === 'DRAW'))
      return sendJson(res, 400, { error: 'Missing or invalid fields' });
    const id = newId();
    const bet = {
      id, status: 'open',
      proposerId: me.id, proposerName: me.name, opponentId: null, opponentName: null,
      home: String(b.home).slice(0, season ? 80 : 40), away: season ? '' : String(b.away).slice(0, 40),
      kind: season ? 'season' : undefined,
      competition: b.competition ? String(b.competition).slice(0, 60) : '',
      utcDate: b.utcDate || null, externalId: b.externalId || null,
      backedOutcome: b.backedOutcome, stake: Math.max(0, Number(b.stake) || 0),
      currency: (b.currency || 'EUR').slice(0, 4),
      note: b.note ? String(b.note).slice(0, 140) : '',
      // hybrid stakes: an optional forfeit line ("loser buys the pints") alongside —
      // or instead of — a numeric stake. Forfeits are the ICP-native currency.
      line: b.line ? String(b.line).slice(0, 60) : '',
      arena: Boolean(b.arena) || undefined,
      rematch: Boolean(b.rematch) || undefined,
      createdAt: new Date().toISOString(),
    };
    db.bets[id] = bet;
    addPundit(bet, 'created');
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

    // Haggle: counter the terms instead of taking them (Vinted's "make an offer").
    // POST /api/bets/:id/offer               {stake?, currency?, line?, note?}
    // POST /api/bets/:id/offer/:oid/accept   (proposer only — locks the bet at the offer's terms)
    // POST /api/bets/:id/offer/:oid/decline  (proposer only)
    if (req.method === 'POST' && action === 'offer') {
      const me = authPlayer(req); if (!me) return need401();
      const oid = parts[4]; const sub = parts[5];
      if (oid) {
        if (me.id !== bet.proposerId) return sendJson(res, 403, { error: 'Only the bet owner can answer an offer.' });
        const off = (bet.offers || []).find((o) => o.id === oid);
        if (!off || off.status !== 'pending') return sendJson(res, 409, { error: 'That offer is gone.' });
        if (sub === 'decline') { off.status = 'declined'; saveData(); logEvent('offer_declined', { id: bet.id }); return sendJson(res, 200, bet); }
        if (sub === 'accept') {
          if (bet.status !== 'open') return sendJson(res, 409, { error: 'Bet already taken' });
          if (bet.utcDate && Date.now() > new Date(bet.utcDate).getTime()) { off.status = 'declined'; saveData(); return sendJson(res, 409, { error: 'Kicked off — this offer expired.' }); }
          // lock the bet at the COUNTER'S terms — the haggle won
          if (off.stake > 0) { bet.stake = off.stake; bet.currency = off.currency || bet.currency; bet.line = off.line || ''; }
          else if (off.line) { bet.line = off.line; bet.stake = 0; }
          bet.opponentId = off.byId; bet.opponentName = off.by;
          bet.status = 'accepted'; bet.acceptedAt = new Date().toISOString();
          bet.haggled = true;
          (bet.offers || []).forEach((o) => { if (o.status === 'pending') o.status = 'declined'; });
          off.status = 'accepted';
          addPundit(bet, 'accepted');
          addRematchReceipt(bet);
          logEvent('offer_accepted', { id: bet.id });
          saveData();
          sendPush(off.byId, { title: 'Deal — counter accepted 🤝', body: `${me.name} took your terms on ${matchLabel(bet)}.`, url: '/b/' + bet.id });
          return sendJson(res, 200, bet);
        }
        return sendJson(res, 400, { error: 'Unknown offer action' });
      }
      if (bet.status !== 'open') return sendJson(res, 409, { error: 'Bet already taken' });
      if (me.id === bet.proposerId) return sendJson(res, 409, { error: "It's your bet — you can't haggle with yourself." });
      if (bet.utcDate && Date.now() > new Date(bet.utcDate).getTime()) {
        return sendJson(res, 409, { error: 'Too late — this match has already kicked off.' });
      }
      const b = await readBody(req);
      const stake = Math.max(0, Number(b.stake) || 0);
      const line = b.line ? String(b.line).slice(0, 60) : '';
      if (!stake && !line) return sendJson(res, 400, { error: 'Counter with a stake or a forfeit — something has to be on the line.' });
      bet.offers = bet.offers || [];
      // one live offer per player — a new one replaces yours
      bet.offers = bet.offers.filter((o) => !(o.byId === me.id && o.status === 'pending'));
      if (bet.offers.filter((o) => o.status === 'pending').length >= 10) return sendJson(res, 409, { error: 'This bet has enough offers on the table.' });
      const off = {
        id: newId(), byId: me.id, by: me.name,
        stake, currency: (b.currency || bet.currency || 'EUR').slice(0, 4), line,
        note: b.note ? String(b.note).slice(0, 100) : '',
        t: new Date().toISOString(), status: 'pending',
      };
      bet.offers.push(off);
      logEvent('offer_made', { id: bet.id });
      saveData();
      sendPush(bet.proposerId, { title: 'Counter-offer on your listing 💬', body: `${me.name} wants different terms on ${matchLabel(bet)}.`, url: '/b/' + bet.id });
      return sendJson(res, 201, bet);
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
      addPundit(bet, 'accepted');
      addRematchReceipt(bet);
      logEvent('bet_accepted', { id: bet.id });
      sendPush(bet.proposerId, { title: 'Your bet is ON ⚔️', body: `${me.name} took the other side of ${matchLabel(bet)}.`, url: '/b/' + bet.id });
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
          if (live) { resolveBet(bet, live); notifyResolved(bet); delete bet.pendingResult; logEvent('bet_resolved', { id: bet.id, auto: true }); return sendJson(res, 200, bet); }
          if (!b.actualOutcome) return sendJson(res, 409, { error: 'Match not finished yet' });
        } catch (e) { console.warn('live result failed:', e.message); }
      }
      if (!OUTCOMES.includes(b.actualOutcome)) return sendJson(res, 400, { error: 'Provide the final result' });
      // manual: a participant reports, the OTHER player must confirm before it's final (anti-cheat)
      const prev = bet.pendingResult;
      if (prev && prev.byId !== me.id) {
        if (prev.outcome === b.actualOutcome) {
          // both players independently reported the same result → it's settled
          resolveBet(bet, b.actualOutcome); notifyResolved(bet); delete bet.pendingResult; delete bet.disputed;
          logEvent('bet_resolved', { id: bet.id });
          return sendJson(res, 200, bet);
        }
        // the two players disagree → flag a dispute (resolved via /void, not a forced result)
        bet.disputed = { claims: [{ outcome: prev.outcome, by: prev.by, byId: prev.byId }, { outcome: b.actualOutcome, by: me.name, byId: me.id }] };
        bet.pendingResult = { outcome: b.actualOutcome, byId: me.id, by: me.name, t: new Date().toISOString() };
        saveData();
        return sendJson(res, 200, bet);
      }
      bet.pendingResult = { outcome: b.actualOutcome, byId: me.id, by: me.name, t: new Date().toISOString() };
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
      notifyResolved(bet);
      delete bet.pendingResult;
      logEvent('bet_resolved', { id: bet.id });
      return sendJson(res, 200, bet);
    }

    if (req.method === 'POST' && action === 'settle') {
      const me = authPlayer(req); if (!me) return need401();
      if (me.id !== bet.proposerId && me.id !== bet.opponentId) return sendJson(res, 403, { error: 'Only a player in this bet can settle it.' });
      if (bet.status !== 'resolved') return sendJson(res, 409, { error: 'Not resolved yet' });
      bet.status = 'settled'; bet.settledAt = new Date().toISOString();
      bet.settledBy = me.id; bet.settledByName = me.name; // attribution — "You marked this sorted"
      saveData();
      return sendJson(res, 200, bet);
    }

    // POST /api/bets/:id/unsettle — undo an accidental "mark it sorted" (back to resolved)
    if (req.method === 'POST' && action === 'unsettle') {
      const me = authPlayer(req); if (!me) return need401();
      if (me.id !== bet.proposerId && me.id !== bet.opponentId) return sendJson(res, 403, { error: 'Only a player in this bet can change that.' });
      if (bet.status !== 'settled') return sendJson(res, 409, { error: 'Not marked sorted yet' });
      bet.status = 'resolved'; delete bet.settledAt; delete bet.settledBy; delete bet.settledByName;
      saveData();
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

    // POST /api/bets/:id/comment — the terrace: real players talking. Anyone signed-in
    // who holds the link can chip in (bets live in group chats; the audience is the mates).
    if (req.method === 'POST' && action === 'comment') {
      const me = authPlayer(req); if (!me) return need401();
      const b = await readBody(req);
      const text = String(b.text || '').trim();
      if (!text) return sendJson(res, 400, { error: 'Say something.' });
      if ([...text].length > 280) return sendJson(res, 400, { error: 'Keep it under 280.' });
      if (!bet.comments) bet.comments = [];
      if (bet.comments.length >= 200) return sendJson(res, 409, { error: 'The terrace is full for this one.' });
      bet.comments.push({ byId: me.id, by: me.name, text, t: new Date().toISOString() });
      logEvent('comment', { id: bet.id }, false);
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

function serveLeagueTable(req, res, url) {
  const m = url.pathname.match(/^\/ltable\/([A-Z0-9]+)\.(svg|png)$/);
  if (!m) { res.writeHead(404); return res.end('Not found'); }
  const league = db.leagues[m[1]];
  if (!league) { res.writeHead(404); return res.end('No such league'); }
  const svg = tableSvgFor(league);
  if (m[2] === 'svg') { res.writeHead(200, { 'Content-Type': 'image/svg+xml; charset=utf-8', 'Cache-Control': 'no-cache' }); return res.end(svg); }
  const png = cards.renderPng(svg);
  if (png) { res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-cache' }); return res.end(png); }
  res.writeHead(302, { Location: `/ltable/${m[1]}.svg` }); res.end();
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
      const title = `Join ${league.name} on Clashly 🏆`;
      const desc = `${league.members.length} mate${league.members.length === 1 ? '' : 's'} settling football bets. Tap to join the league.`;
      const img = `${origin}/lcard/${code}.png?v=${league.members.length}`;
      const meta = ogMeta({ title, desc, img, pageUrl: `${origin}/l/${code}`, alt: `${league.name} — friends football league on Clashly` });
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
  if (url.pathname === '/about') return serveAbout(req, res);
  if (url.pathname === '/llms.txt') return serveLlmsTxt(req, res);
  if (GUIDES[url.pathname]) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=3600' });
    return res.end(guidePageHtml(url.pathname, GUIDES[url.pathname]));
  }
  if (url.pathname === '/sitemap.xml') return serveSitemap(req, res);
  if (/^\/call\/[a-z0-9-]+$/.test(url.pathname)) return serveFixturePage(req, res, url.pathname.slice(6), 'en');
  if (/^\/pl\/call\/[a-z0-9-]+$/.test(url.pathname)) return serveFixturePage(req, res, url.pathname.slice(9), 'pl');
  if (url.pathname === '/this-week') return serveThisWeek(req, res);
  if (url.pathname === '/arcade') return serveArcade(req, res);
  if (url.pathname === '/penalty') return servePenalty(req, res);
  if (url.pathname === '/keepy') return serveKeepy(req, res);
  if (url.pathname === '/hilo') return serveHilo(req, res);
  if (url.pathname === '/daily') return serveDaily(req, res);
  if (url.pathname === '/weekcard.png' || url.pathname === '/weekcard.svg') return serveWeekCard(req, res);
  if (url.pathname.startsWith('/ltable/')) return serveLeagueTable(req, res, url);
  if (url.pathname === '/og-home.png') return serveHomeOg(req, res);
  if (url.pathname.startsWith('/card/')) return serveCard(req, res, url);
  if (url.pathname.startsWith('/storycard/')) return serveStoryCard(req, res, url);
  if (url.pathname.startsWith('/receipt/')) return serveReceipt(req, res, url);
  if (url.pathname.startsWith('/lcard/')) return serveLeagueCard(req, res, url);
  // canonical share link (/b/:id) and legacy (/?b=:id) get OG meta injected
  const shareMatch = url.pathname.match(/^\/b\/([a-f0-9]+)$/);
  if (shareMatch) return serveShareHtml(req, res, shareMatch[1]);
  if (url.pathname === '/' && url.searchParams.get('b')) return serveShareHtml(req, res, url.searchParams.get('b'));
  const leagueMatch = url.pathname.match(/^\/l\/([a-zA-Z0-9]+)$/);
  if (leagueMatch) return serveLeagueHtml(req, res, leagueMatch[1].toUpperCase());
  // SPA client routes — a hard load (reload, direct link) must get the app shell,
  // not a 404. The client router takes over from there.
  if (/^\/(arena|board|duels|leagues|profile)(\/|$)/.test(url.pathname)) {
    req.url = '/index.html';
    return serveStatic(req, res);
  }
  serveStatic(req, res);
});

// --- Arena seed bot: the house pundit keeps a few open listings live so the
// marketplace never looks closed. Bets use real fixtures (externalId) so they
// auto-resolve; humans who beat the bot still bank arena points.
const BOT_NAME = 'The Pundit';
const BOT_LINES = ['Bragging rights', 'Loser posts a public apology on the Terrace', "Loser wears the winner's colours for a day", 'Loser buys the pints', 'Bragging rights'];
const BOT_NOTES = ['printing bragging rights today', 'easy work. always has been', 'your lot bottle it every time', 'study the game, then come back', 'book the excuses now'];
function ensureBot() {
  let bot = Object.values(db.players).find((p) => p.bot && p.name === BOT_NAME);
  if (!bot) {
    const id = newId();
    bot = { id, name: BOT_NAME, bot: true, secret: newId() + newId() + newId(), createdAt: new Date().toISOString() };
    db.players[id] = bot;
  }
  return bot;
}
async function seedArena() {
  try {
    const now = Date.now();
    const openArena = Object.values(db.bets).filter((b) => b.arena && b.status === 'open' && (!b.utcDate || new Date(b.utcDate).getTime() > now));
    const TARGET = 3;
    if (openArena.length >= TARGET) return;
    const bot = ensureBot();
    const { matches } = { matches: await getMatches() };
    const taken = new Set(openArena.map((b) => b.externalId || (b.home + '|' + b.away)));
    const candidates = (matches || []).filter((mt) => mt.utcDate && new Date(mt.utcDate).getTime() > now + 3600000 && !taken.has(mt.id) && !taken.has(mt.home + '|' + mt.away));
    let made = 0;
    for (const mt of candidates) {
      if (openArena.length + made >= TARGET) break;
      const id = newId();
      const pick = Math.random() < 0.5 ? 'HOME' : 'AWAY';
      db.bets[id] = {
        id, status: 'open',
        proposerId: bot.id, proposerName: bot.name, opponentId: null, opponentName: null,
        home: mt.home, away: mt.away, competition: mt.competition || '', utcDate: mt.utcDate, externalId: mt.id || null,
        backedOutcome: pick, stake: 0, currency: 'EUR',
        note: BOT_NOTES[Math.floor(Math.random() * BOT_NOTES.length)],
        line: BOT_LINES[Math.floor(Math.random() * BOT_LINES.length)],
        arena: true, bot: true,
        createdAt: new Date().toISOString(),
      };
      made++;
    }
    if (made) { logEvent('arena_seeded', { made }); saveData(); console.log(`arena bot seeded ${made} listing(s)`); }
  } catch (e) { console.warn('arena seed failed:', e.message); }
}

// ---------------------------------------------------------------------------
// v13 — the LIVE terrace. The v12 seed was 29 fixed takes with frozen timestamps:
// fine on handover day, obviously fake a week later. This generates takes from
// what is actually happening — real upcoming fixtures, real open listings, the
// real leaderboard — so an app opened at 11pm on a Tuesday is never dead.
// Always bot:true and labelled in the UI. Clashly never fakes users.
// ---------------------------------------------------------------------------
const BOT_VOICES = {
  pundit: ['__v_pundit', 'The Pundit'], gaffer: ['__v_gaffer', 'The Gaffer'],
  var: ['__v_var', 'VAR Truther'], stats: ['__v_stats', 'xG Nerd'],
  lewy: ['__v_lewy', 'Lewy Stan'], old: ['__v_old', 'Old School'],
};
// {H} home, {A} away, {C} competition, {N} a player name, {X} a number
const FIXTURE_TAKES = [
  ['pundit', '{H} v {A} and half of you still have not called it. Scared money makes no memories'],
  ['gaffer', 'Anyone backing {A} at {H} needs a lie down in a dark room'],
  ['stats', '{H} v {A} is the only fixture worth arguing about this week and it is not close'],
  ['old', 'They will bore us to death in {H} v {A} and you will all still watch it'],
  ['var', '{H} v {A}. Two penalties, one wrong, and a fortnight of screenshots. Book it \u{1F4FA}'],
  ['gaffer', 'If {H} do not win this one the manager is gone by Christmas. Screenshot it'],
  ['pundit', 'Everyone has an opinion on {H} v {A} until it is time to put it on the record \u{1F440}'],
  ['lewy', '{C} is not even the best league in Europe and {H} v {A} proves it'],
  ['stats', 'The model says {H}. The model has also been wrong every week since April \u{1F4CA}'],
  ['old', 'In my day {H} v {A} was played in mud by men with real jobs'],
];
const ARENA_TAKES = [
  ['pundit', 'There is an open challenge on {H} v {A} sat in the Arena with no taker. Cowards, all of you'],
  ['gaffer', 'Someone has backed {O} and nobody will take the other side. Says everything about this place'],
  ['var', 'Open bet on {H} v {A} going begging. You lot talk a big game until it counts'],
];
const BOARD_TAKES = [
  ['pundit', '{N} is {X}-0 and running out of people brave enough to face them \u{1F451}'],
  ['gaffer', '{N} sat top of the board. Somebody take that record off them, it is embarrassing'],
  ['stats', '{N} is {X} from {X}. Either a genius or has only played their nan'],
  ['old', 'A leaderboard with {X} names on it. Football is dying, I have said it for years'],
];
const IDLE_TAKES = [
  ['gaffer', 'Quiet in here. Either everyone is right about everything or nobody has the bottle to prove it'],
  ['pundit', 'A terrace this silent usually means the loud ones lost last week \u{1F92B}'],
  ['old', 'Nobody has called a thing all day. In my day we argued in the rain for free'],
  ['var', 'No duels, no receipts, no evidence. Convenient for some of you'],
  ['stats', 'Zero calls today. Statistically, that is a lot of people who are not as sure as they sound'],
];

function terracePost(voice, text) {
  const v = BOT_VOICES[voice] || BOT_VOICES.pundit;
  const recent = db.terrace.slice(-40).map((p) => p.text);
  if (recent.includes(text)) return false; // never repeat a take that is still on screen
  db.terrace.push({ id: newId(), byId: v[0], by: v[1], bot: true, text, t: new Date().toISOString() });
  if (db.terrace.length > 200) db.terrace = db.terrace.slice(-200);
  return true;
}
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

async function terraceSweep() {
  try {
    db.meta = db.meta || {};
    const last = db.terrace.length ? new Date(db.terrace[db.terrace.length - 1].t).getTime() : 0;
    // never talk over the humans: if anyone posted in the last 4h, stay quiet
    if (Date.now() - last < 4 * 3600000) return;
    const pools = [];
    let matches = [];
    try { const mm = await getMatches(); matches = (mm || []).filter((m) => new Date(m.utcDate || 0).getTime() > Date.now()); } catch {}
    const fx = matches[0];
    if (fx) pools.push(() => { const [v, t] = pick(FIXTURE_TAKES); return [v, t.replace(/\{H\}/g, fx.home).replace(/\{A\}/g, fx.away).replace(/\{C\}/g, fx.competition || 'This league')]; });
    const openArena = Object.values(db.bets).filter((b) => b.arena && b.status === 'open');
    const ab = openArena[0];
    if (ab) pools.push(() => { const [v, t] = pick(ARENA_TAKES); return [v, t.replace(/\{H\}/g, ab.home).replace(/\{A\}/g, ab.away).replace(/\{O\}/g, outcomeLabel(ab, ab.backedOutcome))]; });
    const humans = Object.values(db.players).filter((p) => !p.bot && !String(p.id).startsWith('__v_'));
    const ranked = humans.map((p) => ({ n: p.name, s: playerSummary(p.id) }))
      .filter((r) => (r.s.w + r.s.l) > 0).sort((a, b) => b.s.w - a.s.w);
    if (ranked.length) pools.push(() => { const [v, t] = pick(BOARD_TAKES); return [v, t.replace(/\{N\}/g, ranked[0].n).replace(/\{X\}/g, String(ranked[0].s.w || ranked.length))]; });
    if (!pools.length) pools.push(() => pick(IDLE_TAKES));
    const [voice, text] = pick(pools)();
    if (terracePost(voice, text)) { logEvent('terrace_bot', { voice }); saveData(); console.log('terrace bot posted:', text.slice(0, 60)); }
  } catch (e) { console.warn('terrace sweep failed:', e.message); }
}

// ---------------------------------------------------------------------------
// v14 — the full-time sweep. The funnel data showed the product dying at
// resolution: accepted bets just sat there because settling needed someone to
// remember. Fixture bets now settle THEMSELVES from the results API (same
// trusted path the resolve endpoint already uses); custom bets get one push at
// full time; a reported result the other side ignores gets one confirm nudge
// after 24h. Every action here fires at most once per bet.
// ---------------------------------------------------------------------------
// Monday morning: the table goes back to the group. The league page is a place
// nobody thinks to visit; the chat is where the season is actually argued about,
// so once a week we hand every member the image and a reason to paste it.
// Once per league per week, and never for a table nobody has played in.
async function tableSweep() {
  try {
    const now = new Date();
    if (now.getUTCDay() !== 1 || now.getUTCHours() < 8) return; // Mondays, after 08:00 UTC
    const wk = weekIdx(Date.now());
    if (!db.meta.tableNudges) db.meta.tableNudges = {};
    let changed = false;
    for (const league of Object.values(db.leagues || {})) {
      if (!league || league.members.length < 2) continue;
      if (db.meta.tableNudges[league.code] === wk) continue;
      const rows = leagueStandings(league);
      const top = rows.find((r) => r.games);
      if (!top) continue;                       // an empty table is not news
      db.meta.tableNudges[league.code] = wk; changed = true;
      const body = rows.length > 1 && rows[1].w === top.w
        ? `${top.name} and ${rows[1].name} can't be split. Send the table to the group.`
        : `${top.name} leads on ${top.w} ${top.w === 1 ? 'win' : 'wins'}. Send the table to the group.`;
      for (const m of league.members) {
        sendPush(m.id, { title: `${league.name} — this week's table 🏆`, body, url: '/l/' + league.code });
      }
      logEvent('table_nudge', { code: league.code, members: league.members.length });
    }
    if (changed) saveData();
  } catch (e) { console.warn('table sweep failed:', e.message); }
}


// ---------------------------------------------------------------------------
// THE WEEKLY CALL — the public mechanic.
//
// A 1v1 challenge only has value against someone you know: beating a stranger
// wins you nothing and they will never pay the forfeit. That is why the Arena
// (open challenges to strangers) has zero real listings after two months. The
// public version of Clashly cannot be a duel, so it is this: ONE fixture a week,
// the same question for everyone, one tap, no account, no opponent.
//
// The reward is not beating a person, it is a permanent public record of what
// you called. Wordle-shaped: same question for everyone, one answer, a result
// that is shareable as text with no link in it.
// ---------------------------------------------------------------------------
const WEEKLY_OUTCOMES = ['HOME', 'DRAW', 'AWAY'];

function weeklyPick(matches) {
  // the biggest game with a kickoff still ahead — same weighting as MOTW, since
  // "the match everyone already has an opinion about" is exactly the ask here
  const COMP_W = [[/world cup|fifa|\bwc\b/i, 100], [/champions league/i, 80], [/europa/i, 55],
    [/premier league/i, 50], [/la ?liga/i, 45], [/serie a/i, 42], [/bundesliga/i, 42],
    [/eredivisie/i, 40], [/ligue 1/i, 38]];
  const BIG = /man(chester)? (city|united)|liverpool|arsenal|chelsea|tottenham|newcastle|real madrid|barcelona|atl[\u00e9e]tico|bayern|dortmund|leverkusen|psg|paris|inter|ac milan|juventus|napoli|ajax|psv|feyenoord|benfica|porto|celtic|rangers/i;
  const now = Date.now();
  return (matches || [])
    .filter((x) => x.utcDate && new Date(x.utcDate).getTime() > now + 3600000)
    .map((x) => {
      let sc = 0;
      for (const [re, w] of COMP_W) if (re.test(x.competition || '')) { sc += w; break; }
      if (BIG.test(x.home)) sc += 25;
      if (BIG.test(x.away)) sc += 25;
      return { x, sc };
    })
    .sort((a, b) => (b.sc - a.sc) || (new Date(a.x.utcDate) - new Date(b.x.utcDate)))[0]?.x || null;
}

async function getWeekly(wk) {
  if (!db.weekly) db.weekly = {};
  let w = db.weekly[wk];
  // re-pick only while nobody has called it yet; once a single person has voted
  // the question is frozen, or we would be moving the goalposts under them
  if (!w || (!Object.keys(w.calls || {}).length && w.utcDate && new Date(w.utcDate).getTime() < Date.now())) {
    const m = weeklyPick(await getMatches());
    if (!m) return w || null;
    w = { week: wk, matchId: m.id, home: m.home, away: m.away, competition: m.competition || '',
          utcDate: m.utcDate, externalId: m.externalId || null, calls: {}, names: {}, result: null };
    db.weekly[wk] = w; saveData();
  }
  return w;
}

const isGhostVoter = (w, vid) => QA_GHOST.test(vid)
  || QA_GHOST.test((w.names && w.names[vid]) || '')
  || QA_GHOST.test((db.players[vid] && db.players[vid].name) || '');
const weeklyTally = (w) => {
  const t = { HOME: 0, DRAW: 0, AWAY: 0, total: 0 };
  for (const [vid, o] of Object.entries(w.calls || {})) {
    if (isGhostVoter(w, vid)) continue;
    if (t[o] !== undefined) { t[o]++; t.total++; }
  }
  return t;
};

// how many weeks running this voter has called, and how many they got right
// Scoring. Flat scoring rewards picking the favourite, which is not a skill:
// the thing worth measuring is being right when the crowd was wrong. So a
// correct call is worth more the fewer people agreed with you.
//
//   points = 10 x (1 / share of callers who picked the winner), clamped 1x..5x
//
// Wrong call scores zero. There is deliberately NO bankroll and no way to go
// backwards: a starting balance you can lose just churns out the people who need
// keeping, which is why FPL and Superbru accumulate rather than stake. And there
// is deliberately no such thing as "odds" here — the multiplier comes from our
// own callers, never from a bookmaker feed, which is the line the guardrails
// research says never to cross.
const WEEKLY_BASE = 10;
function weeklyPointsFor(w, call) {
  if (!w || !w.result || call !== w.result) return 0;
  const t = weeklyTally(w);
  if (!t.total) return WEEKLY_BASE;
  const share = (t[w.result] || 0) / t.total;
  if (share <= 0) return WEEKLY_BASE;
  return Math.round(WEEKLY_BASE * Math.min(5, Math.max(1, 1 / share)));
}
const weeklyCrowdPct = (w) => {
  if (!w || !w.result) return null;
  const t = weeklyTally(w);
  return t.total ? Math.round(((t[w.result] || 0) / t.total) * 100) : null;
};


// ---------------------------------------------------------------------------
// THE SLATE — the "more games" ask, implemented as football knowledge instead
// of chance. Filip wanted casino-style mini-games (Plinko, multiplier lanes) to
// keep people on the site; those are social-casino shapes that TikTok
// suppresses, app stores rate 18+, and Poland's art. 29 register can block on
// sight. The rule of thumb: if a game still works with dice instead of
// football, we do not build it. So the extra playtime comes from MORE CALLS:
// the weekly's marquee fixture plus the rest of the weekend's big games, one
// tap each, same crowd-weighted scoring, one board. Sky Super 6's shape.
// ---------------------------------------------------------------------------
const SLATE_SIZE = 6;

async function getSlate(wk) {
  if (!db.slate) db.slate = {};
  let sl = db.slate[wk];
  if (!sl) {
    const weekly = await getWeekly(wk);
    const now = Date.now();
    const COMP_W = [[/world cup|fifa|\bwc\b/i, 100], [/champions league/i, 80], [/europa/i, 55],
      [/premier league/i, 50], [/la ?liga/i, 45], [/serie a/i, 42], [/bundesliga/i, 42],
      [/eredivisie/i, 40], [/ligue 1/i, 38]];
    const BIG = /man(chester)? (city|united)|liverpool|arsenal|chelsea|tottenham|newcastle|real madrid|barcelona|atl[\u00e9e]tico|bayern|dortmund|leverkusen|psg|paris|inter|ac milan|juventus|napoli|ajax|psv|feyenoord|benfica|porto|celtic|rangers/i;
    const picks = ((await getMatches()) || [])
      .filter((x) => x.utcDate && new Date(x.utcDate).getTime() > now + 3600000)
      .filter((x) => !weekly || x.id !== weekly.matchId)      // the marquee stays the marquee
      .map((x) => {
        let sc = 0;
        for (const [re, w] of COMP_W) if (re.test(x.competition || '')) { sc += w; break; }
        if (BIG.test(x.home)) sc += 25;
        if (BIG.test(x.away)) sc += 25;
        return { x, sc };
      })
      .sort((a, b) => (b.sc - a.sc) || (new Date(a.x.utcDate) - new Date(b.x.utcDate)))
      .slice(0, SLATE_SIZE)
      .map(({ x }) => ({ id: x.id, home: x.home, away: x.away, competition: x.competition || '',
        utcDate: x.utcDate, externalId: x.externalId || null, calls: {}, result: null }));
    if (!picks.length) return null;
    sl = { week: wk, matches: picks };
    db.slate[wk] = sl; saveData();
  }
  return sl;
}

const slateMatchView = (m, vid) => {
  const t = weeklyTally(m);   // same shape: calls map keyed by voter id
  return { id: m.id, home: m.home, away: m.away, competition: m.competition, utcDate: m.utcDate,
    tally: t, result: m.result || null, crowd: weeklyCrowdPct(m),
    myCall: vid ? (m.calls[vid] || null) : null,
    points: vid ? weeklyPointsFor(m, m.calls[vid]) : 0,
    locked: Boolean(m.utcDate && new Date(m.utcDate).getTime() < Date.now()) };
};

function slatePoints(voterId) {
  let points = 0, right = 0, played = 0;
  for (const sl of Object.values(db.slate || {}))
    for (const m of sl.matches || []) {
      const call = m.calls && m.calls[voterId];
      if (!call) continue;
      played++;
      if (m.result && m.result === call) right++;
      points += weeklyPointsFor(m, call);
    }
  return { points, right, played };
}

async function slateSweep() {
  try {
    if (!db.slate || !FOOTBALL_TOKEN) return;
    let changed = false, fetches = 0;
    for (const sl of Object.values(db.slate)) {
      for (const m of sl.matches || []) {
        if (m.result || !m.utcDate || !m.externalId || fetches >= 4) continue;
        if (Date.now() < new Date(m.utcDate).getTime() + FT_GRACE_MS) continue;
        fetches++;
        try {
          const live = await fetchLiveResult(m.externalId);
          if (live) { m.result = live; m.resolvedAt = new Date().toISOString(); changed = true;
            logEvent('slate_resolved', { week: sl.week, match: m.id, result: live }); }
        } catch (e) { console.warn('slate resolve failed:', e.message); }
      }
    }
    if (changed) saveData();
  } catch (e) { console.warn('slate sweep failed:', e.message); }
}


// ---------------------------------------------------------------------------
// THE ARCADE — skill games that feed the same board. The rule that gates what
// goes in here: chance in, points out is legal but casino-shaped and therefore
// radioactive (platform classifiers, Poland's look-alike register); SKILL in,
// points out is legal and clean — the shape of a Nike promo, not a slot. So:
// timing and reflex games with a football theme, no multipliers, no ladders,
// no wager-shaped choice anywhere.
//
// Points go into the prediction board (Qiao's call: the board needs filling
// far more than it needs purity right now). The grind is blunted by a DAILY
// CAP rather than a separate board, and the server clamps every submission —
// the client is never trusted with more than "which game, what score".
// ---------------------------------------------------------------------------
// hilo — streak game, one point a step, capped so a god-run can't drown the
// board. daily — Wordle-shaped, once:true means the server refuses a second
// award the same day however many times the client asks.
const ARCADE_GAMES = { penalty: { max: 15 }, keepy: { max: 15 }, hilo: { max: 12 }, daily: { max: 8, once: true } };
const ARCADE_DAILY_CAP = 30;
const dayKey = () => new Date().toISOString().slice(0, 10);

function arcadeState(vid) {
  const a = (db.arcade && db.arcade[vid]) || { points: 0, byDay: {} };
  return { today: a.byDay[dayKey()] || 0, cap: ARCADE_DAILY_CAP, allTime: a.points };
}
function arcadeAward(vid, game, rawScore) {
  const g = ARCADE_GAMES[game];
  if (!g) return null;
  if (!db.arcade) db.arcade = {};
  const a = (db.arcade[vid] ||= { points: 0, byDay: {} });
  const today = a.byDay[dayKey()] || 0;
  if (g.once && a.once && a.once[game] === dayKey())
    return { awarded: 0, today, cap: ARCADE_DAILY_CAP, allTime: a.points, repeat: true };
  const clamped = Math.max(0, Math.min(g.max, Math.floor(Number(rawScore) || 0)));
  const awarded = Math.max(0, Math.min(clamped, ARCADE_DAILY_CAP - today));
  a.byDay[dayKey()] = today + awarded;
  a.points += awarded;
  if (g.once) (a.once ||= {})[game] = dayKey();
  // byDay only ever needs today for the cap — stop it growing forever
  for (const k of Object.keys(a.byDay)) if (k !== dayKey()) delete a.byDay[k];
  return { awarded, today: a.byDay[dayKey()], cap: ARCADE_DAILY_CAP, allTime: a.points };
}
const arcadePoints = (vid) => (db.arcade && db.arcade[vid] && db.arcade[vid].points) || 0;

function weeklyRecord(voterId) {
  let right = 0, played = 0, streak = 0, points = 0;
  const weeks = Object.keys(db.weekly || {}).map(Number).sort((a, b) => b - a);
  for (const wk of weeks) {
    const w = db.weekly[wk]; const call = w.calls && w.calls[voterId];
    if (!call) { if (played) break; continue; }   // a gap ends the streak
    played++; streak++;
    if (w.result && w.result === call) right++;
    points += weeklyPointsFor(w, call);
  }
  const sp = slatePoints(voterId);
  return { played, right, streak, points: points + sp.points + arcadePoints(voterId),
           slate: { right: sp.right, played: sp.played }, arcade: arcadePoints(voterId) };
}

function weeklyBoard(limit = 10) {
  const agg = {};
  const nameFor = (vid, local) => local || (db.voterNames && db.voterNames[vid])
    || (db.players[vid] && db.players[vid].name) || null;
  const add = (vid, nm, won, pts) => {
    if (!nm || QA_GHOST.test(nm) || QA_GHOST.test(vid)) return;
    const a = (agg[vid] ||= { name: nm, right: 0, played: 0, points: 0 });
    a.name = nm; a.played++; if (won) a.right++; a.points += pts;
  };
  for (const w of Object.values(db.weekly || {})) {
    if (!w.result) continue;
    for (const [vid, call] of Object.entries(w.calls || {}))
      add(vid, nameFor(vid, w.names && w.names[vid]), call === w.result, weeklyPointsFor(w, call));
  }
  for (const sl of Object.values(db.slate || {})) {
    for (const m of sl.matches || []) {
      if (!m.result) continue;
      for (const [vid, call] of Object.entries(m.calls || {}))
        add(vid, nameFor(vid, null), call === m.result, weeklyPointsFor(m, call));
    }
  }
  // arcade points count toward the ranking but never toward right/played —
  // a reflex game must not inflate anyone's prediction hit rate
  for (const [vid, a] of Object.entries(db.arcade || {})) {
    if (!a.points) continue;
    const nm = nameFor(vid, null);
    if (!nm || QA_GHOST.test(nm) || QA_GHOST.test(vid)) continue;
    const row = (agg[vid] ||= { name: nm, right: 0, played: 0, points: 0 });
    row.name = nm; row.points += a.points;
  }
  // ranked on points, not hit rate: calling the unpopular one right should beat
  // going with the crowd every week
  return Object.values(agg)
    .sort((x, y) => y.points - x.points || y.right - x.right || x.name.localeCompare(y.name))
    .slice(0, limit);
}

// resolve finished weeklies from the same trusted results path the bets use
async function weeklySweep() {
  try {
    if (!db.weekly) return;
    let changed = false;
    for (const w of Object.values(db.weekly)) {
      if (w.result || !w.utcDate) continue;
      if (Date.now() < new Date(w.utcDate).getTime() + FT_GRACE_MS) continue;
      if (!FOOTBALL_TOKEN || !w.externalId) continue;
      try {
        const live = await fetchLiveResult(w.externalId);
        if (live) {
          w.result = live; w.resolvedAt = new Date().toISOString(); changed = true;
          logEvent('weekly_resolved', { week: w.week, result: live, callers: Object.keys(w.calls || {}).length });
          console.log('weekly resolved:', w.home, 'v', w.away, '->', live);
        }
      } catch (e) { console.warn('weekly resolve failed:', e.message); }
    }
    if (changed) saveData();
  } catch (e) { console.warn('weekly sweep failed:', e.message); }
}

const FT_GRACE_MS = 125 * 60000;      // kickoff + ~2h05 covers ET-free league football
async function ftSweep() {
  try {
    const now = Date.now();
    const due = Object.values(db.bets).filter((b) => b.status !== 'accepted' ? false
      : b.utcDate ? now > new Date(b.utcDate).getTime() + FT_GRACE_MS
      // dateless custom calls ("loser buys the pints") never hit a kickoff, so they
      // fall out of the sweep entirely. Chase them a day after the handshake instead.
      // a season call runs to May; chasing it a day after the handshake would be
      // nonsense. Without a deadline it simply waits.
      : !isSeason(b) && Boolean(b.acceptedAt) && now - new Date(b.acceptedAt).getTime() > 24 * 3600000);
    let fetches = 0, changed = false;
    for (const bet of due) {
      // fixture bets: settle automatically from the results API (trusted source,
      // mirrors the no-confirmation path in POST /bets/:id/resolve)
      if (FOOTBALL_TOKEN && bet.externalId && fetches < 5) {
        fetches++;
        try {
          const live = await fetchLiveResult(bet.externalId);
          if (live) {
            resolveBet(bet, live); delete bet.pendingResult;
            notifyResolved(bet);
            logEvent('bet_resolved', { id: bet.id, auto: true, sweep: true });
            console.log('ft sweep auto-resolved:', bet.home, 'v', bet.away, '->', live);
            changed = true; continue;
          }
        } catch (e) { console.warn('ft sweep result failed:', e.message); }
      }
      // custom bets (or result not published yet): one "who called it?" push
      if (!bet.pendingResult && !bet.ftNudged) {
        bet.ftNudged = true; changed = true;
        const label = matchLabel(bet);
        sendPush(bet.proposerId, { title: 'Full time 🏁', body: `${label} — who called it? Report the result.`, url: '/b/' + bet.id });
        if (bet.opponentId) sendPush(bet.opponentId, { title: 'Full time 🏁', body: `${label} — who called it? Report the result.`, url: '/b/' + bet.id });
        logEvent('ft_nudge', { id: bet.id });
      }
      // one side reported, the other has sat on it for a day: nudge the confirmer
      if (bet.pendingResult && bet.pendingResult.t && !bet.confirmNudged
          && now - new Date(bet.pendingResult.t).getTime() > 24 * 3600000) {
        bet.confirmNudged = true; changed = true;
        const waiterId = bet.pendingResult.byId === bet.proposerId ? bet.opponentId : bet.proposerId;
        if (waiterId) sendPush(waiterId, { title: 'Confirm the result ✓', body: `${bet.pendingResult.by} reported ${matchLabel(bet)}. One tap makes it official.`, url: '/b/' + bet.id });
        logEvent('confirm_nudge', { id: bet.id });
      }
    }
    if (changed) saveData();
  } catch (e) { console.warn('ft sweep failed:', e.message); }
}

// --- Web push: VAPID keys live in the db (zero-config deploys), subscriptions
// per player, best-effort delivery with pruning of dead endpoints.
let webpush = null;
try { webpush = require('web-push'); } catch { console.warn('web-push not installed; notifications disabled'); }
function initPush() {
  if (!webpush) return;
  db.meta = db.meta || {};
  if (!db.meta.vapid) { db.meta.vapid = webpush.generateVAPIDKeys(); saveData(); }
  webpush.setVapidDetails('mailto:contact@clashly.live', db.meta.vapid.publicKey, db.meta.vapid.privateKey);
}
function sendPush(playerId, payload) {
  if (!webpush || !db.meta || !db.meta.vapid) return;
  const subs = (db.push && db.push[playerId]) || [];
  if (!subs.length) return;
  const body = JSON.stringify(payload);
  subs.forEach((sub) => {
    webpush.sendNotification(sub, body).catch((err) => {
      if (err.statusCode === 404 || err.statusCode === 410) {
        db.push[playerId] = (db.push[playerId] || []).filter((s) => s.endpoint !== sub.endpoint);
        saveData();
      }
    });
  });
}

initData().then(() => {
  initPush();
  setTimeout(seedArena, 5000);
  setInterval(seedArena, 6 * 3600000);
  // live terrace: checks every 90 min, only speaks if the feed has been quiet 4h+
  setTimeout(terraceSweep, 30000);
  setInterval(terraceSweep, 90 * 60000);
  // v14 full-time sweep: fixture bets settle themselves, everyone else gets nudged
  setTimeout(ftSweep, 45000);
  setInterval(ftSweep, 30 * 60000);
  setTimeout(tableSweep, 60000);
  setInterval(tableSweep, 60 * 60000);
  setTimeout(weeklySweep, 50000);
  setInterval(weeklySweep, 20 * 60000);
  setTimeout(slateSweep, 70000);
  setInterval(slateSweep, 20 * 60000);
  // v11 — rivalry-streak rescue: Fri/Sat, if a pair with a 2+ week streak has no
  // clash yet this week, nudge BOTH sides once. Peer pressure beats app pressure.
  const streakNudgeSweep = () => {
    try {
      const dow = new Date().getUTCDay();
      if (dow !== 5 && dow !== 6) return;
      const wk = weekIdx(Date.now());
      if (!db.meta) db.meta = {};
      if (!db.meta.streakNudges) db.meta.streakNudges = {};
      const pairs = {};
      for (const b of Object.values(db.bets)) {
        if (!b.proposerId || !b.opponentId || !['accepted', 'resolved', 'settled'].includes(b.status)) continue;
        const key = [b.proposerId, b.opponentId].sort().join('|');
        (pairs[key] = pairs[key] || new Set()).add(weekIdx(b.acceptedAt || b.createdAt));
      }
      let touched = false;
      for (const [key, weeks] of Object.entries(pairs)) {
        if (weeks.has(wk)) continue;
        let s = 0, k = wk - 1;
        while (weeks.has(k)) { s++; k--; }
        if (s < 2) continue;
        if (db.meta.streakNudges[key] === wk) continue;
        db.meta.streakNudges[key] = wk; touched = true;
        const [aId, bId] = key.split('|');
        const an = nameOf(aId), bn = nameOf(bId);
        if (!an || !bn) continue;
        sendPush(aId, { title: `🔥 ${s}-week streak on the line`, body: `No clash with ${bn} yet this week — run one back before Sunday.`, url: '/' });
        sendPush(bId, { title: `🔥 ${s}-week streak on the line`, body: `No clash with ${an} yet this week — run one back before Sunday.`, url: '/' });
      }
      if (touched) saveData();
    } catch (e) { console.warn('streak nudge sweep failed:', e.message); }
  };
  setTimeout(streakNudgeSweep, 20000);
  setInterval(streakNudgeSweep, 12 * 3600000);
  server.listen(PORT, () => {
    console.log(`\n  ${BRAND} running →  http://localhost:${PORT}`);
    console.log(`  Mode: ${FOOTBALL_TOKEN ? 'LIVE (football-data.org)' : 'DEMO (manual results)'}`);
    console.log(`  Login: ${GOOGLE_CLIENT_ID ? 'Google + email' : 'email only (set GOOGLE_CLIENT_ID for Google)'}`);
    console.log(`  Store: ${pool ? 'Postgres (durable)' : 'JSON file (' + DATA_FILE + ')'}\n`);
  });
}).catch((e) => { console.error('init failed:', e.message); process.exit(1); });

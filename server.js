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
 * NOTE (legal): "no money held" is NOT a confirmed exemption from gambling
 * intermediary licensing (e.g. UK Gambling Act 2005 s.13). This is a
 * prototype to validate the loop — get counsel before any public launch.
 *
 * Zero npm dependencies. Node 18+.
 * Optional live results: set FOOTBALL_DATA_TOKEN (free key, football-data.org).
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
const BRAND = 'Duely';

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------
function loadData() {
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); }
  catch { return { bets: {}, seeded: false }; }
}
// atomic write: temp file + rename so a crash or concurrent read never sees a half-written file
function saveData(d) {
  const tmp = `${DATA_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(d, null, 2));
  fs.renameSync(tmp, DATA_FILE);
}
let db = loadData();
if (!db.bets) db.bets = {};
if (!db.leagues) db.leagues = {};
if (!db.events) db.events = [];
if (!db.stats) db.stats = {};

// lightweight loop-funnel instrumentation (created → opened → accepted → resolved → rematch)
function logEvent(type, meta = {}, persist = true) {
  db.stats[type] = (db.stats[type] || 0) + 1;
  db.events.push({ type, t: new Date().toISOString(), ...meta });
  if (db.events.length > 5000) db.events = db.events.slice(-5000);
  if (persist) saveData(db);
}

const newId = () => crypto.randomBytes(4).toString('hex');
const newCode = () => {
  const A = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no ambiguous chars
  const b = crypto.randomBytes(5);
  let s = ''; for (let i = 0; i < 5; i++) s += A[b[i] % A.length];
  return s;
};
const norm = (s) => String(s || '').trim().toLowerCase();
const OUTCOMES = ['HOME', 'DRAW', 'AWAY'];

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
    home: m.homeTeam?.name || 'Home', away: m.awayTeam?.name || 'Away',
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
    if (_matchCache.data && Date.now() - _matchCache.t < 60000) return _matchCache.data; // respect rate limits
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
  const winnerName = proposerWins ? bet.proposerName : bet.opponentName;
  const loserName = proposerWins ? bet.opponentName : bet.proposerName;
  bet.status = 'resolved';
  bet.actualOutcome = actualOutcome;
  bet.winner = proposerWins ? 'proposer' : 'opponent';
  bet.owes = { from: loserName, to: winnerName, amount: bet.stake, currency: bet.currency };
  bet.resolvedAt = new Date().toISOString();
  return bet;
}

// ---------------------------------------------------------------------------
// Stats engine (records computed by player name)
// ---------------------------------------------------------------------------
const decidedBets = () => Object.values(db.bets).filter((b) => b.status === 'resolved' || b.status === 'settled');
const winnerName = (b) => (b.winner === 'proposer' ? b.proposerName : b.opponentName);
const involves = (b, name) => norm(b.proposerName) === norm(name) || norm(b.opponentName) === norm(name);
const otherName = (b, name) => (norm(b.proposerName) === norm(name) ? b.opponentName : b.proposerName);
const byRecent = (a, b) => new Date(b.resolvedAt || 0) - new Date(a.resolvedAt || 0);

function playerSummary(name) {
  const mine = decidedBets().filter((b) => involves(b, name)).sort(byRecent);
  let w = 0, l = 0, net = 0;
  for (const b of mine) {
    if (norm(winnerName(b)) === norm(name)) w++; else l++;
    if (b.owes) {
      if (norm(b.owes.to) === norm(name)) net += b.owes.amount;
      else if (norm(b.owes.from) === norm(name)) net -= b.owes.amount;
    }
  }
  let streak = { type: null, count: 0 };
  for (const b of mine) {
    const t = norm(winnerName(b)) === norm(name) ? 'W' : 'L';
    if (streak.type === null) streak = { type: t, count: 1 };
    else if (streak.type === t) streak.count++;
    else break;
  }
  const byOpp = {};
  for (const b of mine) {
    const o = otherName(b, name), k = norm(o);
    if (!byOpp[k]) byOpp[k] = { opponent: o, w: 0, l: 0, net: 0, games: 0 };
    const r = byOpp[k];
    r.games++;
    if (norm(winnerName(b)) === norm(name)) r.w++; else r.l++;
    if (b.owes) {
      if (norm(b.owes.to) === norm(name)) r.net += b.owes.amount;
      else if (norm(b.owes.from) === norm(name)) r.net -= b.owes.amount;
    }
  }
  const rivalries = Object.values(byOpp)
    .map((r) => ({ ...r, isRival: r.games >= 3 }))
    .sort((a, b) => b.games - a.games);
  const recent = mine.slice(0, 8).map((b) => ({
    id: b.id, home: b.home, away: b.away, opponent: otherName(b, name),
    won: norm(winnerName(b)) === norm(name), amount: b.owes ? b.owes.amount : b.stake,
    currency: b.currency, status: b.status,
  }));
  return { name, w, l, net, currency: 'EUR', streak, rivalries, recent };
}

function rivalry(a, b) {
  const both = decidedBets().filter((x) => involves(x, a) && involves(x, b)).sort(byRecent);
  let aWins = 0, bWins = 0, aNet = 0;
  for (const x of both) {
    if (norm(winnerName(x)) === norm(a)) aWins++; else bWins++;
    if (x.owes) {
      if (norm(x.owes.to) === norm(a)) aNet += x.owes.amount;
      else if (norm(x.owes.from) === norm(a)) aNet -= x.owes.amount;
    }
  }
  return { a, b, aWins, bWins, aNet, games: both.length, currency: 'EUR' };
}

function rivalryLine(proposer, opponent) {
  const r = rivalry(proposer, opponent);
  if (!r.games) return `First bet of the ${proposer}-${opponent} rivalry`;
  const hi = Math.max(r.aWins, r.bWins), lo = Math.min(r.aWins, r.bWins);
  if (r.aWins === r.bWins) return `${proposer} & ${opponent} all level ${hi}-${lo}`;
  const leader = r.aWins > r.bWins ? proposer : opponent;
  const chaser = r.aWins > r.bWins ? opponent : proposer;
  return `${leader} leads ${chaser} ${hi}-${lo}`;
}

// League table: aggregate decided bets *between members of the league*.
function leagueStandings(league) {
  const set = new Set(league.members.map(norm));
  const rel = decidedBets().filter((b) => set.has(norm(b.proposerName)) && set.has(norm(b.opponentName)));
  const tbl = {};
  for (const nm of league.members) tbl[norm(nm)] = { name: nm, w: 0, l: 0, net: 0, games: 0 };
  for (const b of rel) {
    const wn = winnerName(b);
    const wk = norm(wn);
    const lk = wk === norm(b.proposerName) ? norm(b.opponentName) : norm(b.proposerName);
    if (tbl[wk]) { tbl[wk].w++; tbl[wk].games++; }
    if (tbl[lk]) { tbl[lk].l++; tbl[lk].games++; }
    if (b.owes) {
      if (tbl[norm(b.owes.to)]) tbl[norm(b.owes.to)].net += b.owes.amount;
      if (tbl[norm(b.owes.from)]) tbl[norm(b.owes.from)].net -= b.owes.amount;
    }
  }
  const rows = Object.values(tbl).sort((a, b) => b.w - a.w || b.net - a.net || a.l - b.l || a.name.localeCompare(b.name));
  rows.forEach((r, i) => (r.rank = i + 1));
  return rows;
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
function cardSvgForBet(bet) {
  const data = {
    PROPOSER: bet.proposerName, HOME: bet.home, AWAY: bet.away,
    HOME_ABBR: abbr(bet.home), AWAY_ABBR: abbr(bet.away),
    COMP: bet.competition || 'Match', DATE: fmtDate(bet.utcDate),
    STAKE: sym(bet.currency) + bet.stake,
    BACKED: outcomeLabel(bet, bet.backedOutcome),
    COMPLEMENT: complementLabel(bet),
    NOTE: bet.note || '',
  };
  if (bet.status === 'resolved' || bet.status === 'settled') {
    const winner = winnerName(bet);
    const loser = norm(winner) === norm(bet.proposerName) ? bet.opponentName : bet.proposerName;
    Object.assign(data, {
      RESULT: outcomeLabel(bet, bet.actualOutcome), WINNER: winner, LOSER: loser,
      OWES: `${bet.owes.from}  →  ${bet.owes.to}`, RIVALRY: rivalryLine(bet.proposerName, bet.opponentName),
    });
    return cards.resultSvg(data);
  }
  return cards.challengeSvg(data);
}

function storySvgForBet(bet) {
  const resolved = bet.status === 'resolved' || bet.status === 'settled';
  const accent = resolved ? '#FFC83D' : '#14E0C8';
  let badge, hero, sub, foot;
  if (resolved) {
    badge = 'FULL TIME'; hero = winnerName(bet);
    sub = 'called it — ' + outcomeLabel(bet, bet.actualOutcome);
    foot = rivalryLine(bet.proposerName, bet.opponentName);
  } else {
    badge = 'OPEN BET'; hero = outcomeLabel(bet, bet.backedOutcome);
    sub = bet.proposerName + ' is backing'; foot = 'Take the other side →';
  }
  return cards.storySvg({ BADGE: badge, HERO: hero, SUB: sub, ACCENT: accent, HOME: bet.home, AWAY: bet.away, STAKE: sym(bet.currency) + bet.stake, FOOT: foot });
}

function serveCard(req, res, url) {
  const m = url.pathname.match(/^\/card\/([a-f0-9]+)\.(svg|png)$/);
  if (!m) { res.writeHead(404); return res.end('Not found'); }
  const bet = db.bets[m[1]];
  if (!bet) { res.writeHead(404); return res.end('No such bet'); }
  const svg = cardSvgForBet(bet);
  if (m[2] === 'svg') {
    res.writeHead(200, { 'Content-Type': 'image/svg+xml; charset=utf-8', 'Cache-Control': 'no-cache' });
    return res.end(svg);
  }
  const png = cards.renderPng(svg);
  if (png) {
    res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-cache' });
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
  if (bet.status === 'resolved' || bet.status === 'settled') {
    const winner = winnerName(bet);
    return {
      title: `${winner} called it: ${outcomeLabel(bet, bet.actualOutcome)} ⚽`,
      desc: `${bet.owes.from} owes ${bet.owes.to} ${sym(bet.currency)}${bet.stake}. ${rivalryLine(bet.proposerName, bet.opponentName)}. Back yourself on Duely.`,
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
    desc: `${bet.note ? bet.note + ' — ' : ''}${bet.home} v ${bet.away}. Take the other side (${complementLabel(bet)}) on Duely. No money, no bookie.`,
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
  const mk = (proposer, opponent, home, away, backed, actual, stake, daysAgo, comp) => {
    const id = newId();
    const proposerWins = actual === backed;
    const ts = new Date(Date.now() - daysAgo * 86400000).toISOString();
    db.bets[id] = {
      id, status: 'settled', proposerName: proposer, opponentName: opponent,
      home, away, competition: comp || 'Premier League', utcDate: ts, externalId: null,
      backedOutcome: backed, stake, currency: 'EUR', note: '',
      createdAt: ts, acceptedAt: ts, actualOutcome: actual,
      winner: proposerWins ? 'proposer' : 'opponent',
      owes: { from: proposerWins ? opponent : proposer, to: proposerWins ? proposer : opponent, amount: stake, currency: 'EUR' },
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
    code: 'SUN01', name: 'Sunday League', createdBy: 'Alex',
    members: ['Alex', 'Jordan', 'Casey'], createdAt: new Date(Date.now() - 45 * 86400000).toISOString(),
  };
  db.seeded = true;
  saveData(db);
}
seedHistory();

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

  if (req.method === 'GET' && parts[1] === 'config')
    return sendJson(res, 200, { brand: BRAND, live: Boolean(FOOTBALL_TOKEN) });

  if (req.method === 'GET' && parts[1] === 'matches') {
    const matches = await getMatches();
    return sendJson(res, 200, { matches, live: Boolean(FOOTBALL_TOKEN) });
  }

  // GET /api/stats — loop funnel for the activation metric (% of links that get accepted)
  if (req.method === 'GET' && parts[1] === 'stats') {
    const s = db.stats || {};
    const created = s.bet_created || 0, opened = s.link_opened || 0, accepted = s.bet_accepted || 0, resolved = s.bet_resolved || 0;
    const rematch = (db.events || []).filter((e) => e.type === 'bet_created' && e.rematch).length;
    const names = new Set();
    Object.values(db.bets).forEach((b) => { if (b.proposerName) names.add(norm(b.proposerName)); if (b.opponentName) names.add(norm(b.opponentName)); });
    Object.values(db.leagues).forEach((l) => l.members.forEach((mm) => names.add(norm(mm))));
    return sendJson(res, 200, {
      totals: { players: names.size, bets: Object.keys(db.bets).length, leagues: Object.keys(db.leagues).length },
      funnel: {
        created, opened, accepted, resolved, rematch,
        acceptRate: created ? +(accepted / created).toFixed(2) : 0,
        resolveRate: accepted ? +(resolved / accepted).toFixed(2) : 0,
      },
      stats: s,
      recent: (db.events || []).slice(-40).reverse(),
    });
  }

  // GET /api/players/:name/summary
  if (req.method === 'GET' && parts[1] === 'players' && parts[2] && parts[3] === 'summary') {
    return sendJson(res, 200, playerSummary(decodeURIComponent(parts[2])));
  }

  // GET /api/players/:name/leagues
  if (req.method === 'GET' && parts[1] === 'players' && parts[2] && parts[3] === 'leagues') {
    const name = decodeURIComponent(parts[2]);
    const mine = Object.values(db.leagues).filter((l) => l.members.some((m) => norm(m) === norm(name)));
    const leagues = mine.map((l) => {
      const s = leagueStandings(l);
      const row = s.find((r) => norm(r.name) === norm(name));
      return { code: l.code, name: l.name, members: l.members.length, rank: row ? row.rank : null, total: s.length };
    });
    return sendJson(res, 200, { leagues });
  }

  // GET /api/players/:name/bets — for the Duels tab (active + history)
  if (req.method === 'GET' && parts[1] === 'players' && parts[2] && parts[3] === 'bets') {
    const name = decodeURIComponent(parts[2]);
    const mine = Object.values(db.bets).filter((b) => involves(b, name));
    const map = (b) => ({
      id: b.id, home: b.home, away: b.away, status: b.status,
      opponent: b.opponentName ? otherName(b, name) : null,
      backed: outcomeLabel(b, b.backedOutcome), stake: b.stake, currency: b.currency,
      mine: norm(b.proposerName) === norm(name),
      won: (b.status === 'resolved' || b.status === 'settled') ? norm(winnerName(b)) === norm(name) : null,
      pending: Boolean(b.pendingResult), createdAt: b.createdAt,
    });
    const active = mine.filter((b) => b.status === 'open' || b.status === 'accepted')
      .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0)).map(map);
    const history = mine.filter((b) => b.status === 'resolved' || b.status === 'settled').sort(byRecent).map(map);
    return sendJson(res, 200, { active, history });
  }

  // GET /api/rivalry?a=&b=
  if (req.method === 'GET' && parts[1] === 'rivalry') {
    const a = url.searchParams.get('a'), b = url.searchParams.get('b');
    if (!a || !b) return sendJson(res, 400, { error: 'a and b required' });
    return sendJson(res, 200, rivalry(a, b));
  }

  // POST /api/leagues  (create)
  if (req.method === 'POST' && parts[1] === 'leagues' && parts.length === 2) {
    const b = await readBody(req);
    if (!b.name || !b.creatorName) return sendJson(res, 400, { error: 'name and creatorName required' });
    let code; do { code = newCode(); } while (db.leagues[code]);
    const creator = String(b.creatorName).slice(0, 40);
    const league = { code, name: String(b.name).slice(0, 50), createdBy: creator, members: [creator], createdAt: new Date().toISOString() };
    db.leagues[code] = league;
    logEvent('league_created', { code });
    return sendJson(res, 201, { ...league, standings: leagueStandings(league) });
  }

  // /api/leagues/:code[/join]
  if (parts[1] === 'leagues' && parts[2]) {
    const code = parts[2].toUpperCase();
    const league = db.leagues[code];
    if (!league) return sendJson(res, 404, { error: 'League not found' });
    if (req.method === 'GET' && !parts[3]) {
      return sendJson(res, 200, { ...league, standings: leagueStandings(league) });
    }
    if (req.method === 'POST' && parts[3] === 'join') {
      const b = await readBody(req);
      if (!b.name) return sendJson(res, 400, { error: 'Name required' });
      const nm = String(b.name).slice(0, 40);
      if (!league.members.some((m) => norm(m) === norm(nm))) league.members.push(nm);
      logEvent('league_joined', { code });
      return sendJson(res, 200, { ...league, standings: leagueStandings(league) });
    }
  }

  // POST /api/bets
  if (req.method === 'POST' && parts[1] === 'bets' && parts.length === 2) {
    const b = await readBody(req);
    if (!b.proposerName || !b.home || !b.away || !OUTCOMES.includes(b.backedOutcome))
      return sendJson(res, 400, { error: 'Missing or invalid fields' });
    const id = newId();
    const bet = {
      id, status: 'open',
      proposerName: String(b.proposerName).slice(0, 40), opponentName: null,
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

    if (req.method === 'GET' && !action) return sendJson(res, 200, bet);

    if (req.method === 'POST' && action === 'accept') {
      const b = await readBody(req);
      if (bet.status !== 'open') return sendJson(res, 409, { error: 'Bet already taken' });
      if (!b.opponentName) return sendJson(res, 400, { error: 'Name required' });
      bet.opponentName = String(b.opponentName).slice(0, 40);
      bet.status = 'accepted';
      bet.acceptedAt = new Date().toISOString();
      logEvent('bet_accepted', { id: bet.id });
      return sendJson(res, 200, bet);
    }

    if (req.method === 'POST' && action === 'resolve') {
      if (bet.status === 'open') return sendJson(res, 409, { error: 'Nobody has taken this bet yet' });
      if (bet.status === 'resolved' || bet.status === 'settled') return sendJson(res, 409, { error: 'Already resolved' });
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
      // manual: record the claim; the OTHER player must confirm before it's final (anti-cheat)
      bet.pendingResult = { outcome: b.actualOutcome, by: b.reporterName ? String(b.reporterName).slice(0, 40) : null };
      saveData(db);
      return sendJson(res, 200, bet);
    }

    if (req.method === 'POST' && action === 'confirm') {
      if (bet.status === 'resolved' || bet.status === 'settled') return sendJson(res, 409, { error: 'Already resolved' });
      if (!bet.pendingResult || !OUTCOMES.includes(bet.pendingResult.outcome)) return sendJson(res, 409, { error: 'Nothing to confirm yet' });
      const b = await readBody(req);
      const who = b.confirmerName ? String(b.confirmerName).slice(0, 40) : '';
      if (bet.pendingResult.by && norm(who) === norm(bet.pendingResult.by)) {
        return sendJson(res, 403, { error: 'The other player has to confirm — not whoever reported it.' });
      }
      resolveBet(bet, bet.pendingResult.outcome);
      delete bet.pendingResult;
      logEvent('bet_resolved', { id: bet.id });
      return sendJson(res, 200, bet);
    }

    if (req.method === 'POST' && action === 'settle') {
      if (bet.status !== 'resolved') return sendJson(res, 409, { error: 'Not resolved yet' });
      bet.status = 'settled'; bet.settledAt = new Date().toISOString(); saveData(db);
      return sendJson(res, 200, bet);
    }

    if (req.method === 'POST' && action === 'react') {
      const b = await readBody(req);
      const emoji = String(b.emoji || '').slice(0, 8);
      const by = String(b.by || '').slice(0, 40);
      if (!emoji || !by) return sendJson(res, 400, { error: 'emoji and name required' });
      if (!bet.reactions) bet.reactions = [];
      const idx = bet.reactions.findIndex((r) => norm(r.by) === norm(by) && r.emoji === emoji);
      if (idx >= 0) bet.reactions.splice(idx, 1); else bet.reactions.push({ by, emoji });
      logEvent('reaction', { id: bet.id }, false);
      saveData(db);
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

server.listen(PORT, () => {
  console.log(`\n  ${BRAND} running →  http://localhost:${PORT}`);
  console.log(`  Mode: ${FOOTBALL_TOKEN ? 'LIVE (football-data.org)' : 'DEMO (sample fixtures, manual results)'}`);
  console.log(`  Data: ${DATA_FILE}\n`);
});

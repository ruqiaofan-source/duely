'use strict';

/**
 * Clashly Credits: the virtual in-game economy.
 *
 * Credits are virtual. They have no cash value, cannot be bought, sold,
 * deposited or withdrawn, and never convert into anything of real-world value.
 * That is what keeps Clashly a free-to-play game rather than gambling, so the
 * three red lines are permanent: never sell Credits or Play Tickets, never let
 * Credits buy anything outside the game, never award a prize of real value.
 *
 * Everything that moves Credits is server-authoritative and goes through
 * credit(). The client only ever asks; it never tells the server a balance.
 *
 * Long-term importance, by design: PREDICTIONS > CLASHES > MINI-GAMES.
 * Mini-games are capped per day (PLAY_DAILY_CAP) so they can never outrun
 * a good week of predictions.
 */

const { QUIZ } = require('./content');

module.exports = function createEconomy(ctx) {
  const {
    getDb, saveData, logEvent, newId, getMatches, authPlayer, sendJson, readBody,
    QA_GHOST, isGhostBet, FOOTBALL_TOKEN, fetchLiveResult, sendPush, cards,
    HILO_DECKS, DAILY_PLAYERS, HILO_PLAYERS,
  } = ctx;

  // ------------------------------------------------------------------------
  // Constants
  // ------------------------------------------------------------------------
  const START = 10000;
  const PICK_MIN = 100, PICK_MAX = 5000;
  const TIERS = [5.0, 3.5, 2.0, 1.3];
  const TIER_LABEL = { 1.3: 'Low risk', 2: 'Medium risk', 3.5: 'High risk', 5: 'Very high risk' };
  const PRIOR = { HOME: 0.45, DRAW: 0.27, AWAY: 0.28 };
  const CROWD_K = 12;                 // the crowd moves the price only after a dozen picks
  const DAILY_TRACK = [100, 150, 200, 250, 300, 400, 750];
  const STREAK_MILESTONES = { 3: 100, 5: 250, 7: 500, 14: 1000 };
  const TICKETS_PER_DAY = 5;
  const PLAY_DAILY_CAP = 2000;        // most Credits a player can take from mini-games in one day
  const FOUNDING_CAP = 20000;
  const RESULT_GRACE_MS = 125 * 60000;
  const VOID_AFTER_MS = 4 * 86400000; // postponed and never played: refund
  const DAY = 86400000;
  const MONDAY0 = Date.UTC(2026, 0, 5); // a Monday; seasons run Monday 00:00 UTC to Monday

  const GAMES = {
    penalty:  { name: 'Penalty Kings',   icon: '🥅', desc: 'Five penalties. Aim, shoot, beat the keeper.', max: 1250 },
    quiz:     { name: 'Quick Quiz',      icon: '🧠', desc: 'Ten questions against the clock.', max: 1500 },
    hilo:     { name: 'Higher or Lower', icon: '📈', desc: 'Fees, ages, heights, caps. Five calls.', max: 1000 },
    whoami:   { name: 'Who Am I?',       icon: '🕵️', desc: 'Career clues. Every clue costs you.', max: 500 },
    reaction: { name: 'Reaction Clash',  icon: '⚡', desc: 'Wait for it. Tap the second it says NOW.', max: 500, lowWins: true },
    odds:     { name: 'Odds Master',     icon: '🎯', desc: 'Read the table. Pick the most likely result.', max: 800 },
  };
  const GAME_IDS = Object.keys(GAMES);

  // ------------------------------------------------------------------------
  // Time helpers
  // ------------------------------------------------------------------------
  const dayKey = (t = Date.now()) => new Date(t).toISOString().slice(0, 10);
  const prevDay = (k) => dayKey(Date.parse(k + 'T00:00:00Z') - DAY);
  const weekKey = (t = Date.now()) => Math.floor((t - MONDAY0) / (7 * DAY));
  const weekStart = (k) => MONDAY0 + k * 7 * DAY;
  function isoWeekNo(t) {
    const d = new Date(t); d.setUTCHours(0, 0, 0, 0);
    d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
    const y0 = Date.UTC(d.getUTCFullYear(), 0, 1);
    return Math.ceil(((d - y0) / DAY + 1) / 7);
  }
  function seasonInfo(t = Date.now()) {
    const k = weekKey(t);
    const end = weekStart(k + 1);
    return { key: k, week: isoWeekNo(weekStart(k)), daysLeft: Math.max(1, Math.ceil((end - t) / DAY)), endsAt: new Date(end).toISOString() };
  }

  // ------------------------------------------------------------------------
  // Wallet
  // ------------------------------------------------------------------------
  const db = () => getDb();
  const eligible = (p) => p && !p.bot && !String(p.id || '').startsWith('__') && !QA_GHOST.test(String(p.name || ''));

  function wallet(p) {
    if (!p) return null;
    if (p.credits == null) {
      p.credits = START;
      p.eco = { log: [{ t: new Date().toISOString(), d: START, r: 'Welcome Credits', bal: START }], onboarded: false };
    }
    const e = p.eco || (p.eco = { log: [] });
    if (!e.log) e.log = [];
    if (!e.games) e.games = {};
    if (!e.streak) e.streak = { n: 0, last: null, best: 0, paid: [] };
    if (!e.daily) e.daily = { last: null, i: -1 };
    if (!e.tix) e.tix = { day: null, used: 0, bonus: 0 };
    if (!e.play) e.play = { day: null, earned: 0 };
    if (!e.hist) e.hist = [];
    const wk = weekKey();
    if (!e.wk || e.wk.k !== wk) { if (e.wk) e.prevWk = e.wk; e.wk = { k: wk, net: 0, wins: 0 }; } // keep last week until the season roll reads it
    return e;
  }

  // the ONLY place a balance changes
  function credit(p, delta, reason, ref) {
    const e = wallet(p);
    delta = Math.round(delta);
    if (delta < 0 && p.credits + delta < 0) throw Object.assign(new Error('Not enough Credits'), { status: 409 });
    p.credits += delta;
    e.wk.net += delta;
    if (delta > 0 && reason !== 'Welcome Credits') e.earned = (e.earned || 0) + delta;
    e.log.unshift({ t: new Date().toISOString(), d: delta, r: reason, ref: ref || undefined, bal: p.credits });
    if (e.log.length > 80) e.log.length = 80;
    return p.credits;
  }

  // ------------------------------------------------------------------------
  // Daily streak: one meaningful thing a day (a prediction, a Clash, the Daily Game)
  // ------------------------------------------------------------------------
  function currentStreak(e) {
    const s = e.streak; const today = dayKey();
    return (s.last === today || s.last === prevDay(today)) ? s.n : 0;
  }
  function markActivity(p, kind) {
    const e = wallet(p); const s = e.streak; const today = dayKey();
    if (s.last === today) return null;
    if (s.last === prevDay(today)) s.n += 1; else { s.n = 1; s.paid = []; }
    s.last = today;
    if (s.n > s.best) s.best = s.n;
    let bonus = STREAK_MILESTONES[s.n] || (s.n > 14 && s.n % 7 === 0 ? 500 : 0);
    let tickets = (s.n === 7 || s.n === 14) ? 1 : 0;
    if (bonus && !s.paid.includes(s.n)) {
      s.paid.push(s.n);
      credit(p, bonus, `${s.n} day streak`);
      if (tickets) e.tix.bonus += tickets;
      return { streak: s.n, bonus, tickets };
    }
    return { streak: s.n, bonus: 0, tickets: 0, kind };
  }

  // ------------------------------------------------------------------------
  // Daily reward: a 7-day track, miss a day and it starts again
  // ------------------------------------------------------------------------
  function dailyState(e) {
    const today = dayKey();
    const claimed = e.daily.last === today;
    const continuing = e.daily.last === prevDay(today);
    const nextI = claimed ? e.daily.i : continuing ? (e.daily.i + 1) % 7 : 0;
    return { available: !claimed, day: nextI + 1, amount: DAILY_TRACK[nextI], ticket: nextI === 6, track: DAILY_TRACK, claimedToday: claimed, todayDay: claimed ? e.daily.i + 1 : null };
  }
  function claimDaily(p) {
    const e = wallet(p); const st = dailyState(e);
    if (!st.available) throw Object.assign(new Error('Already claimed today. Back tomorrow.'), { status: 409 });
    e.daily.i = st.day - 1; e.daily.last = dayKey();
    credit(p, st.amount, `Daily reward, day ${st.day}`);
    if (st.ticket) e.tix.bonus += 1;
    return { day: st.day, amount: st.amount, ticket: st.ticket };
  }

  // ------------------------------------------------------------------------
  // Play Tickets
  // ------------------------------------------------------------------------
  function tickets(e) {
    const today = dayKey();
    if (e.tix.day !== today) { e.tix.day = today; e.tix.used = 0; }
    const free = Math.max(0, TICKETS_PER_DAY - e.tix.used);
    return { free, bonus: e.tix.bonus, left: free + e.tix.bonus, perDay: TICKETS_PER_DAY };
  }
  function useTicket(e) {
    const t = tickets(e);
    if (t.left <= 0) throw Object.assign(new Error("You've used today's Play Tickets. Come back tomorrow."), { status: 409 });
    if (t.free > 0) e.tix.used += 1; else e.tix.bonus -= 1;
  }
  function playToday(e) {
    const today = dayKey();
    if (e.play.day !== today) { e.play.day = today; e.play.earned = 0; }
    return { earned: e.play.earned, cap: PLAY_DAILY_CAP, left: Math.max(0, PLAY_DAILY_CAP - e.play.earned) };
  }

  // ------------------------------------------------------------------------
  // The prediction model: league standings, not bookmaker odds.
  // A team's strength is points per game plus a little goal difference per
  // game; home advantage is a fixed 0.3. The crowd blends in once enough
  // people have picked.
  // ------------------------------------------------------------------------
  function standingsFor(code) { return (db().meta && db().meta.standings && db().meta.standings[code]) || null; }
  function modelProbs(m) {
    if (m && m.compCode && m.homeId && m.awayId) {
      const st = standingsFor(m.compCode);
      const h = st && st.teams[m.homeId], a = st && st.teams[m.awayId];
      if (h && a && h.pg >= 2 && a.pg >= 2) {
        const sh = h.ppg + 0.15 * h.gdpg, sa = a.ppg + 0.15 * a.gdpg;
        const d = sh - sa + 0.3;
        const pd = Math.min(0.30, Math.max(0.12, 0.30 - 0.07 * Math.abs(d)));
        const ph = 1 / (1 + Math.exp(-1.6 * d));
        return { HOME: (1 - pd) * ph, DRAW: pd, AWAY: (1 - pd) * (1 - ph), source: 'table' };
      }
    }
    return { ...PRIOR, source: 'prior' };
  }
  function crowdFor(key) {
    const c = { HOME: 0, DRAW: 0, AWAY: 0, total: 0 };
    for (const k of Object.values(db().picks || {})) {
      if (k.key !== key) continue;
      const p = db().players[k.pid]; if (!eligible(p)) continue;
      c[k.o] += 1; c.total += 1;
    }
    return c;
  }
  const tierFor = (p) => { const fair = 0.95 / Math.max(0.02, p); for (const t of TIERS) if (t <= fair) return t; return TIERS[TIERS.length - 1]; };
  function priceMatch(m) {
    const key = m.externalId || m.id;
    const model = modelProbs(m);
    const crowd = crowdFor(key);
    const prob = {}, mult = {};
    for (const o of ['HOME', 'DRAW', 'AWAY']) {
      prob[o] = (model[o] * CROWD_K + crowd[o]) / (CROWD_K + crowd.total);
      mult[o] = tierFor(prob[o]);
    }
    const pct = {};
    if (crowd.total) { let acc = 0; ['HOME', 'DRAW'].forEach((o) => { pct[o] = Math.round(crowd[o] / crowd.total * 100); acc += pct[o]; }); pct.AWAY = 100 - acc; }
    return { key, mult, risk: Object.fromEntries(Object.entries(mult).map(([o, x]) => [o, TIER_LABEL[x]])), crowd: { ...pct, total: crowd.total }, model: model.source };
  }
  const matchView = (m, me) => {
    const pr = priceMatch(m);
    const mine = me ? Object.values(db().picks || {}).find((k) => k.pid === me.id && k.key === pr.key) : null;
    return {
      id: m.id, externalId: m.externalId || null, home: m.home, away: m.away, competition: m.competition || '', utcDate: m.utcDate,
      locked: Boolean(m.utcDate && Date.parse(m.utcDate) <= Date.now()),
      mult: pr.mult, risk: pr.risk, crowd: pr.crowd, myPick: mine ? pickView(mine) : null,
      result: (db().results && db().results[pr.key]) || null,
    };
  };

  // the big-game ranking (same taste as the old Match of the Week)
  const COMP_W = [[/world cup|fifa|\bwc\b/i, 100], [/champions league/i, 80], [/europa/i, 55], [/premier league/i, 50], [/primera|la ?liga/i, 45], [/serie a/i, 42], [/bundesliga/i, 42], [/eredivisie/i, 40], [/ligue 1/i, 38], [/championship/i, 20]];
  const BIG = /man(chester)? (city|united)|man utd|liverpool|arsenal|chelsea|tottenham|spurs|newcastle|real madrid|barcelona|barça|atl[ée]tico|bayern|dortmund|leverkusen|psg|paris|inter|ac milan|milan|juventus|napoli|ajax|psv|feyenoord|benfica|porto|sporting|celtic|rangers|galatasaray|flamengo|palmeiras/i;
  function bigScore(m) {
    let sc = 0;
    for (const [re, w] of COMP_W) if (re.test(m.competition || '')) { sc += w; break; }
    if (BIG.test(m.home)) sc += 25;
    if (BIG.test(m.away)) sc += 25;
    return sc;
  }
  async function upcoming() {
    const now = Date.now();
    return ((await getMatches()) || []).filter((m) => m.utcDate && Date.parse(m.utcDate) > now);
  }
  async function todaysClash() {
    const d = db(); if (!d.meta) d.meta = {};
    const today = dayKey();
    let tc = d.meta.todaysClash;
    if (tc && tc.day === today && tc.match) return tc.match;
    const list = await upcoming();
    const now = Date.now();
    const score = (m) => bigScore(m) + (Date.parse(m.utcDate) - now < 36 * 3600000 ? 30 : 0);
    const pick = list.filter((m) => Date.parse(m.utcDate) - now < 7 * DAY).sort((a, b) => (score(b) - score(a)) || (Date.parse(a.utcDate) - Date.parse(b.utcDate)))[0];
    if (!pick) return tc && tc.match ? tc.match : null;
    d.meta.todaysClash = { day: today, match: pick };
    saveData();
    return pick;
  }
  async function trending(excludeKey, n = 4) {
    const list = await upcoming();
    return list.filter((m) => (m.externalId || m.id) !== excludeKey && bigScore(m) >= 60)
      .sort((a, b) => (bigScore(b) - bigScore(a)) || (Date.parse(a.utcDate) - Date.parse(b.utcDate))).slice(0, n);
  }
  async function findMatch(mid) {
    const all = (await getMatches()) || [];
    let m = all.find((x) => x.id === mid || x.externalId === mid);
    if (!m) { const tc = db().meta && db().meta.todaysClash; if (tc && tc.match && (tc.match.id === mid || tc.match.externalId === mid)) m = tc.match; }
    return m || null;
  }

  // ------------------------------------------------------------------------
  // Predictions
  // ------------------------------------------------------------------------
  const pickView = (k) => ({ id: k.id, matchId: k.mid, home: k.home, away: k.away, competition: k.comp, utcDate: k.utc, outcome: k.o, amount: k.amt, mult: k.x, potential: Math.round(k.amt * k.x), status: k.st, payout: k.pay || 0, result: k.res || null, settledAt: k.set || null, seen: Boolean(k.seen), at: k.at });
  async function makePick(p, b) {
    const e = wallet(p);
    const m = await findMatch(String(b.matchId || ''));
    if (!m) throw Object.assign(new Error('That match is not on the board.'), { status: 404 });
    if (!['HOME', 'DRAW', 'AWAY'].includes(b.outcome)) throw Object.assign(new Error('Pick a result.'), { status: 400 });
    if (!m.utcDate || Date.parse(m.utcDate) <= Date.now()) throw Object.assign(new Error('Kicked off. Picks are locked.'), { status: 409 });
    const amt = Math.floor(Number(b.amount) || 0);
    if (amt < PICK_MIN) throw Object.assign(new Error(`The minimum is ${PICK_MIN} C.`), { status: 400 });
    if (amt > PICK_MAX) throw Object.assign(new Error(`The most you can put on one pick is ${PICK_MAX.toLocaleString('en-GB')} C.`), { status: 400 });
    if (amt > p.credits) throw Object.assign(new Error('Not enough Credits for that.'), { status: 409 });
    const d = db(); if (!d.picks) d.picks = {};
    const key = m.externalId || m.id;
    if (Object.values(d.picks).some((k) => k.pid === p.id && k.key === key)) throw Object.assign(new Error("You've already picked this one. It's locked."), { status: 409 });
    const pr = priceMatch(m);
    const id = newId();
    const k = { id, pid: p.id, key, mid: m.id, ext: m.externalId || null, home: m.home, away: m.away, comp: m.competition || '', utc: m.utcDate, o: b.outcome, amt, x: pr.mult[b.outcome], st: 'open', at: new Date().toISOString() };
    d.picks[id] = k;
    credit(p, -amt, `Prediction: ${m.home} v ${m.away}`, id);
    const streak = markActivity(p, 'pick');
    logEvent('pick_made', { id, mult: k.x }, false);
    saveData();
    return { pick: pickView(k), credits: p.credits, streak: streak && streak.bonus ? streak : null, match: matchView(m, p) };
  }
  function settleKey(key, outcome) {
    const d = db(); let n = 0;
    if (!d.results) d.results = {};
    d.results[key] = outcome;
    for (const k of Object.values(d.picks || {})) {
      if (k.key !== key || k.st !== 'open') continue;
      const p = d.players[k.pid]; if (!p) continue;
      wallet(p);
      k.res = outcome; k.set = new Date().toISOString();
      if (outcome === 'VOID') { k.st = 'void'; k.pay = k.amt; credit(p, k.amt, `Refund: ${k.home} v ${k.away} not played`, k.id); }
      else if (k.o === outcome) {
        k.st = 'won'; k.pay = Math.round(k.amt * k.x);
        credit(p, k.pay, `Correct: ${k.home} v ${k.away}`, k.id);
        p.eco.wk.wins += 1;
        try { sendPush(p.id, { title: `CORRECT ✅ +${k.pay.toLocaleString('en-GB')} C`, body: `${k.home} v ${k.away}. You called it.`, url: '/' }); } catch {}
      } else {
        k.st = 'lost'; k.pay = 0;
        try { sendPush(p.id, { title: 'Wrong one this time', body: `${k.home} v ${k.away}. -${k.amt.toLocaleString('en-GB')} C. Go again.`, url: '/' }); } catch {}
      }
      n++;
    }
    if (n) logEvent('picks_settled', { key, outcome, n }, false);
    return n;
  }
  async function picksSweep() {
    try {
      rollSeason();
      const d = db(); const now = Date.now();
      const due = {};
      for (const k of Object.values(d.picks || {})) {
        if (k.st !== 'open') continue;
        const ko = Date.parse(k.utc || 0);
        if (now < ko + RESULT_GRACE_MS) continue;
        if (d.results && d.results[k.key]) { settleKey(k.key, d.results[k.key]); continue; }
        due[k.key] = due[k.key] || { ext: k.ext, ko };
      }
      let fetches = 0, changed = false;
      for (const [key, v] of Object.entries(due)) {
        if (v.ext && FOOTBALL_TOKEN && fetches < 3) {
          fetches++;
          try { const r = await fetchLiveResult(v.ext); if (r) { settleKey(key, r); changed = true; continue; } } catch (e) { console.warn('picks sweep result failed:', e.message); }
        }
        if (now > v.ko + VOID_AFTER_MS) { settleKey(key, 'VOID'); changed = true; }
      }
      // Clash Credits on challenges nobody took before kickoff go back to the proposer
      for (const bet of Object.values(d.bets || {})) {
        if (bet.status !== 'open' || !(bet.credits > 0) || bet.creditsRefunded) continue;
        if (bet.utcDate && Date.parse(bet.utcDate) < now) { refundClash(bet, 'Clash not taken before kickoff'); changed = true; }
      }
      if (changed) saveData();
    } catch (e) { console.warn('picks sweep failed:', e.message); }
  }

  // ------------------------------------------------------------------------
  // Standings (for the model and for Odds Master). One competition per call,
  // spaced out, so we stay well inside football-data's 10 requests a minute.
  // ------------------------------------------------------------------------
  async function standingsSweep() {
    if (!FOOTBALL_TOKEN) return;
    try {
      const d = db(); if (!d.meta) d.meta = {};
      if (!d.meta.standings) d.meta.standings = {};
      const codes = [...new Set(((await getMatches()) || []).map((m) => m.compCode).filter(Boolean))];
      const stale = codes.map((c) => ({ c, t: (d.meta.standings[c] && d.meta.standings[c].t) || 0 }))
        .filter((x) => Date.now() - x.t > 12 * 3600000).sort((a, b) => a.t - b.t)[0];
      if (!stale) return;
      const res = await fetch(`https://api.football-data.org/v4/competitions/${stale.c}/standings`, { headers: { 'X-Auth-Token': FOOTBALL_TOKEN }, signal: AbortSignal.timeout(5000) });
      if (!res.ok) { d.meta.standings[stale.c] = { t: Date.now(), teams: (d.meta.standings[stale.c] || {}).teams || {} }; return; }
      const j = await res.json();
      const tbl = ((j.standings || []).find((s) => s.type === 'TOTAL') || (j.standings || [])[0] || {}).table || [];
      const teams = {};
      for (const r of tbl) {
        const pg = r.playedGames || 0; if (!r.team) continue;
        teams[r.team.id] = { name: r.team.shortName || r.team.name, pos: r.position, pg, pts: r.points, ppg: pg ? r.points / pg : 0, gdpg: pg ? (r.goalDifference || 0) / pg : 0 };
      }
      d.meta.standings[stale.c] = { t: Date.now(), teams };
      saveData();
    } catch (e) { console.warn('standings sweep failed:', e.message); }
  }

  // ------------------------------------------------------------------------
  // Clash Credits: both sides put the same amount in, the winner takes the pool
  // ------------------------------------------------------------------------
  function clashCreditsOnCreate(bet, p, amount) {
    const amt = Math.max(0, Math.floor(Number(amount) || 0));
    if (!amt) return;
    if (amt < 100) throw Object.assign(new Error('Clash Credits start at 100 C.'), { status: 400 });
    if (amt > 5000) throw Object.assign(new Error('The most you can put on a Clash is 5,000 C.'), { status: 400 });
    wallet(p);
    if (p.credits < amt) throw Object.assign(new Error('Not enough Credits for that stake.'), { status: 409 });
    credit(p, -amt, `Clash stake: ${bet.home}${bet.away ? ' v ' + bet.away : ''}`, bet.id);
    bet.credits = amt;
    bet.esc = { [p.id]: amt };
  }
  function clashCreditsOnAccept(bet, p) {
    if (!(bet.credits > 0)) return;
    wallet(p);
    if (p.credits < bet.credits) throw Object.assign(new Error(`You need ${bet.credits.toLocaleString('en-GB')} C to take this Clash.`), { status: 409 });
    credit(p, -bet.credits, `Clash stake: ${bet.home}${bet.away ? ' v ' + bet.away : ''}`, bet.id);
    bet.esc = { ...(bet.esc || {}), [p.id]: bet.credits };
  }
  function clashResolved(bet, winnerPid, loserPid) {
    const d = db();
    const w = d.players[winnerPid], l = d.players[loserPid];
    if (w && eligible(w)) { wallet(w); w.eco.wk.wins += 1; markActivity(w, 'clash'); }
    if (l && eligible(l)) { wallet(l); markActivity(l, 'clash'); }
    if (!(bet.credits > 0) || !bet.esc || bet.paidOut) return;
    const pool = Object.values(bet.esc).reduce((a, b) => a + b, 0);
    if (w) credit(w, pool, `Clash won: ${bet.home}${bet.away ? ' v ' + bet.away : ''}`, bet.id);
    bet.pool = pool; bet.paidOut = true;
  }
  function refundClash(bet, reason) {
    if (!bet.esc || bet.creditsRefunded || bet.paidOut) return;
    const d = db();
    for (const [pid, amt] of Object.entries(bet.esc)) { const p = d.players[pid]; if (p && amt > 0) credit(p, amt, reason || 'Clash called off: refund', bet.id); }
    bet.creditsRefunded = true;
  }

  // ------------------------------------------------------------------------
  // Skill, stats, ranks, seasons
  // ------------------------------------------------------------------------
  function decidedClashes(pid) {
    return Object.values(db().bets || {}).filter((b) => (b.status === 'resolved' || b.status === 'settled') && (b.proposerId === pid || b.opponentId === pid) && b.opponentId && !isGhostBet(b));
  }
  function statsFor(p) {
    const e = wallet(p);
    const picks = Object.values(db().picks || {}).filter((k) => k.pid === p.id);
    const done = picks.filter((k) => k.st === 'won' || k.st === 'lost');
    const won = done.filter((k) => k.st === 'won');
    const clashes = decidedClashes(p.id);
    const clashWins = clashes.filter((b) => (b.winner === 'proposer' ? b.proposerId : b.opponentId) === p.id);
    // results in time order for the current and best winning streak
    const seq = [
      ...done.map((k) => ({ t: Date.parse(k.set || k.at), w: k.st === 'won' })),
      ...clashes.map((b) => ({ t: Date.parse(b.resolvedAt || 0), w: (b.winner === 'proposer' ? b.proposerId : b.opponentId) === p.id })),
    ].sort((a, b) => a.t - b.t);
    let run = 0, best = 0; for (const r of seq) { if (r.w) { run++; if (run > best) best = run; } else run = 0; }
    const n = done.length + clashes.length, w = won.length + clashWins.length;
    const acc = (w + 1) / (n + 2);
    const diff = won.length ? won.reduce((a, k) => a + Math.log(k.x) / Math.log(5), 0) / won.length : 0;
    const conf = n / (n + 8);
    const gamePlays = Object.values(e.games).reduce((a, g) => a + (g.plays || 0), 0);
    const skill = Math.max(1, Math.min(999, Math.round(300 + conf * (500 * acc + 120 * diff) + Math.min(60, best * 6) + Math.min(20, gamePlays * 0.5))));
    return {
      skill, accuracy: n ? Math.round((w / n) * 100) : null, decided: n, correct: w,
      picks: picks.length, picksWon: won.length, clashes: clashes.length + Object.values(db().bets || {}).filter((b) => (b.status === 'accepted') && (b.proposerId === p.id || b.opponentId === p.id)).length,
      clashWins: clashWins.length, winStreak: run, bestWinStreak: best, gamePlays,
    };
  }
  function players() { return Object.values(db().players).filter((p) => eligible(p) && p.credits != null); }
  function globalRows() { return players().sort((a, b) => (b.credits - a.credits) || (Date.parse(a.createdAt || 0) - Date.parse(b.createdAt || 0))); }
  function weeklyRows() {
    const wk = weekKey();
    return players().map((p) => ({ p, wk: (p.eco && p.eco.wk && p.eco.wk.k === wk) ? p.eco.wk : { net: 0, wins: 0 } }))
      .filter((r) => r.wk.net !== 0 || r.wk.wins > 0)
      .sort((a, b) => (b.wk.net - a.wk.net) || (b.wk.wins - a.wk.wins));
  }
  function friendIds(p) {
    const ids = new Set([p.id]);
    for (const b of Object.values(db().bets || {})) {
      if (!b.opponentId) continue;
      if (b.proposerId === p.id) ids.add(b.opponentId); else if (b.opponentId === p.id) ids.add(b.proposerId);
    }
    for (const l of Object.values(db().leagues || {})) if (l.members.some((m) => m.id === p.id)) l.members.forEach((m) => ids.add(m.id));
    return ids;
  }
  function globalRank(p) { const rows = globalRows(); const i = rows.findIndex((x) => x.id === p.id); return { rank: i >= 0 ? i + 1 : null, of: rows.length }; }
  function weeklyRank(p) { const rows = weeklyRows(); const i = rows.findIndex((x) => x.p.id === p.id); return { rank: i >= 0 ? i + 1 : null, of: rows.length }; }
  function rollSeason() {
    const d = db(); if (!d.meta) d.meta = {};
    const now = weekKey();
    if (d.meta.seasonKey == null) { d.meta.seasonKey = now; return false; }
    if (d.meta.seasonKey === now) return false;
    const old = d.meta.seasonKey;
    const wkOf = (p) => (p.eco && p.eco.wk && p.eco.wk.k === old ? p.eco.wk : p.eco && p.eco.prevWk && p.eco.prevWk.k === old ? p.eco.prevWk : null);
    const rows = players().map((p) => ({ p, wk: wkOf(p) }))
      .filter((r) => r.wk && (r.wk.net !== 0 || r.wk.wins > 0)).sort((a, b) => (b.wk.net - a.wk.net) || (b.wk.wins - a.wk.wins));
    rows.forEach((r, i) => {
      const e = wallet(r.p);
      e.hist.unshift({ k: old, week: isoWeekNo(weekStart(old)), rank: i + 1, of: rows.length, net: r.wk.net, wins: r.wk.wins });
      if (e.hist.length > 26) e.hist.length = 26;
      if (!e.bestRank || i + 1 < e.bestRank) e.bestRank = i + 1;
      if (i === 0 && rows.length >= 3) e.champ = (e.champ || 0) + 1;
    });
    d.meta.seasonKey = now;
    if (!d.meta.seasons) d.meta.seasons = [];
    d.meta.seasons.unshift({ k: old, week: isoWeekNo(weekStart(old)), top: rows.slice(0, 3).map((r) => ({ name: r.p.name, net: r.wk.net })) });
    if (d.meta.seasons.length > 26) d.meta.seasons.length = 26;
    logEvent('season_rolled', { k: old, players: rows.length }, false);
    saveData();
    return true;
  }
  function badgesFor(p, st) {
    const e = wallet(p);
    return [
      { id: 'founding', name: 'FOUNDING MEMBER', desc: 'One of the first 20,000 players', on: (p.seq || 1e9) <= FOUNDING_CAP },
      { id: 'first', name: 'FIRST PICK', desc: 'Make your first prediction', on: st.picks > 0 },
      { id: 'streak5', name: '5 WIN STREAK', desc: 'Five correct in a row', on: st.bestWinStreak >= 5 },
      { id: '10k', name: '10K CLUB', desc: 'Earn 10,000 C in total', on: (e.earned || 0) >= 10000 },
      { id: 'clash', name: 'CLASH MASTER', desc: 'Win 10 Clashes', on: st.clashWins >= 10 },
      { id: 'champ', name: 'WEEKLY CHAMPION', desc: 'Finish a week at #1', on: (e.champ || 0) > 0 },
      { id: 'expert', name: 'FOOTBALL EXPERT', desc: '20 results called at 60%+', on: st.decided >= 20 && (st.accuracy || 0) >= 60 },
      { id: 'week', name: '7 DAY STREAK', desc: 'Show up seven days running', on: (e.streak.best || 0) >= 7 },
    ];
  }
  function foundingCount() { return Object.values(db().players).filter(eligible).length; }

  function walletView(p) {
    const e = wallet(p);
    return {
      credits: p.credits, onboarded: Boolean(e.onboarded),
      streak: { days: currentStreak(e), best: e.streak.best || 0, today: e.streak.last === dayKey(), milestones: STREAK_MILESTONES },
      daily: dailyState(e), tickets: tickets(e), play: playToday(e), season: seasonInfo(),
    };
  }

  // ------------------------------------------------------------------------
  // PLAY: runs are held in memory; a ticket is spent the moment a run starts
  // ------------------------------------------------------------------------
  const runs = new Map();
  const RUN_TTL = 30 * 60000;
  function gc() { const now = Date.now(); for (const [id, r] of runs) if (now - r.t0 > RUN_TTL) runs.delete(id); }
  const shuffle = (a) => { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
  const dailyGameId = (t = Date.now()) => GAME_IDS[Math.floor((t - Date.UTC(2026, 0, 1)) / DAY) % GAME_IDS.length];
  const pslug = (n) => String(n).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  const normName = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();

  function quizBonus(streak) { return streak === 3 ? 100 : streak === 5 ? 200 : streak === 8 ? 200 : 0; }

  async function oddsEvents(n = 5) {
    const list = (await upcoming()).map((m) => ({ m, p: modelProbs(m) })).filter((x) => x.p.source === 'table');
    const good = shuffle(list.filter((x) => {
      const v = [x.p.HOME, x.p.DRAW, x.p.AWAY].sort((a, b) => b - a);
      return v[0] >= 0.4 && v[0] - v[1] >= 0.06;
    })).sort((a, b) => bigScore(b.m) - bigScore(a.m));
    return good.slice(0, n).map((x) => {
      const pr = { HOME: Math.round(x.p.HOME * 100), DRAW: Math.round(x.p.DRAW * 100) }; pr.AWAY = 100 - pr.HOME - pr.DRAW;
      const best = Object.entries(pr).sort((a, b) => b[1] - a[1])[0][0];
      const st = standingsFor(x.m.compCode);
      const h = st && st.teams[x.m.homeId], a = st && st.teams[x.m.awayId];
      return { home: x.m.home, away: x.m.away, competition: x.m.competition, utcDate: x.m.utcDate, probs: pr, best,
        table: h && a ? { home: { pos: h.pos, pts: h.pts, pg: h.pg }, away: { pos: a.pos, pts: a.pts, pg: a.pg } } : null };
    });
  }

  function whoamiClues(P) {
    const c = P.c;
    const later = c.slice(3).map((x) => `${x[1]} (${x[0]})`).join(', ');
    return [
      `My senior career began in ${c[0][0]}, and ${c.length} clubs make up the story.`,
      `I started out at ${c[0][1]}.`,
      `Next stops: ${c.slice(1, 3).map((x) => `${x[1]} (${x[0]})`).join(' and ')}.`,
      later ? `Later on: ${later}.` : `My name starts with ${P.n[0]}.`,
    ];
  }

  async function startRun(p, game) {
    gc();
    if (!GAMES[game]) throw Object.assign(new Error('Unknown game'), { status: 404 });
    const e = wallet(p);
    let content = null, pub = {};
    if (game === 'quiz') {
      const qs = shuffle(QUIZ).slice(0, 10).map((q) => { const opts = shuffle(q.slice(1)); return { q: q[0], opts, c: opts.indexOf(q[1]) }; });
      content = { qs }; pub = { total: 10, q: { i: 0, text: qs[0].q, opts: qs[0].opts }, seconds: 10 };
    } else if (game === 'hilo') {
      const deckIds = Object.keys(HILO_DECKS);
      const deckId = deckIds[Math.floor(Math.random() * deckIds.length)];
      const D = HILO_DECKS[deckId];
      let rows = shuffle(D.rows());
      const seq = [rows[0]];
      for (const r of rows.slice(1)) { if (seq.length >= 6) break; if (r[2] !== seq[seq.length - 1][2]) seq.push(r); }
      const item = (r, show) => ({ name: r[0], meta: r[1], img: deckId === 'fees' ? null : '/players/' + pslug(r[0]) + '.jpg', value: show ? r[2] : null });
      content = { deckId, seq, item };
      pub = { deck: { id: deckId, title: D.kicker, q: D.q, up: D.up, down: D.down, kind: D.kind, greaterIsUp: D.greaterIsUp }, rounds: 5, a: item(seq[0], true), b: item(seq[1], false) };
    } else if (game === 'whoami') {
      const P = DAILY_PLAYERS[Math.floor(Math.random() * DAILY_PLAYERS.length)];
      const clues = whoamiClues(P);
      const names = [...new Set([...DAILY_PLAYERS.map((x) => x.n), ...HILO_PLAYERS.map((x) => x[0])])].sort();
      content = { P, clues, shown: 1, wrong: [] };
      pub = { clues: [clues[0]], rewards: [500, 350, 200, 100], names };
    } else if (game === 'odds') {
      const ev = await oddsEvents(5);
      if (ev.length < 3) throw Object.assign(new Error('Odds Master needs the league tables. Back shortly.'), { status: 503 });
      content = { ev }; pub = { total: ev.length, event: { i: 0, home: ev[0].home, away: ev[0].away, competition: ev[0].competition, utcDate: ev[0].utcDate } };
    } else if (game === 'reaction') {
      content = {}; pub = { waitMin: 1500, waitMax: 4000 };
    } else if (game === 'penalty') {
      content = {}; pub = { shots: 5, points: { goal: 100, corner: 150, top: 250 } };
    }
    useTicket(e);
    const id = newId() + newId();
    const run = { id, pid: p.id, game, t0: Date.now(), tq: Date.now(), content, i: 0, streak: 0, correct: 0, score: 0, bonuses: 0, done: false, log: [] };
    runs.set(id, run);
    e.games[game] = e.games[game] || { best: null, plays: 0 };
    e.games[game].plays += 1;
    if (game === dailyGameId()) markActivity(p, 'daily_game');
    saveData();
    logEvent('play_start', { game }, false);
    return { run: id, game, tickets: tickets(e), ...pub };
  }

  function getRun(p, id) {
    const r = runs.get(String(id || ''));
    if (!r || r.pid !== p.id) throw Object.assign(new Error('That game has expired. Start a new one.'), { status: 410 });
    if (r.done) throw Object.assign(new Error('That game is already over.'), { status: 409 });
    return r;
  }

  function stepRun(p, b) {
    const r = getRun(p, b.run);
    const C = r.content;
    if (r.game === 'quiz') {
      const q = C.qs[r.i];
      const late = Date.now() - r.tq > 13500;              // 10s on screen plus generous network slack
      const ok = !late && Number(b.choice) === q.c;
      let bonus = 0;
      if (ok) { r.correct++; r.streak++; r.score += 50; bonus = quizBonus(r.streak); r.bonuses += bonus; r.score += bonus; } else r.streak = 0;
      r.i++;
      const out = { correct: ok, late, answer: q.c, streak: r.streak, bonus, score: r.score, correctCount: r.correct };
      if (r.i >= C.qs.length) { if (r.correct === 10) { r.score += 500; r.bonuses += 500; out.perfect = 500; out.score = r.score; } out.done = true; }
      else { r.tq = Date.now(); out.next = { i: r.i, text: C.qs[r.i].q, opts: C.qs[r.i].opts }; }
      return out;
    }
    if (r.game === 'hilo') {
      const D = HILO_DECKS[C.deckId];
      const a = C.seq[r.i], nb = C.seq[r.i + 1];
      const up = b.guess === 'up';
      const greater = nb[2] > a[2];
      const truthUp = D.greaterIsUp ? greater : !greater;
      const ok = nb[2] === a[2] || up === truthUp;
      let bonus = 0;
      if (ok) { r.correct++; r.streak++; r.score += 100; bonus = r.streak === 3 ? 200 : r.streak === 5 ? 300 : 0; r.score += bonus; r.bonuses += bonus; }
      r.i++;
      const out = { correct: ok, value: nb[2], streak: r.streak, bonus, score: r.score };
      if (!ok || r.i >= 5) out.done = true;
      else out.next = C.item(C.seq[r.i + 1], false);
      return out;
    }
    if (r.game === 'whoami') {
      const rewards = [500, 350, 200, 100];
      if (b.action === 'clue') {
        if (C.shown >= 4) return { clues: C.clues.slice(0, 4), shown: 4, potential: rewards[3] };
        C.shown++;
        return { clues: C.clues.slice(0, C.shown), shown: C.shown, potential: rewards[C.shown - 1] };
      }
      const g = normName(b.guess);
      if (!g) throw Object.assign(new Error('Type a name'), { status: 400 });
      const P = C.P;
      const ok = g === normName(P.n) || (P.alt || []).some((x) => normName(x) === g);
      if (ok) { r.score = rewards[C.shown - 1]; r.correct = 1; return { correct: true, answer: P.n, img: '/players/' + pslug(P.n) + '.jpg', score: r.score, shown: C.shown, done: true }; }
      C.wrong.push(String(b.guess).slice(0, 40));
      if (C.shown >= 4) return { correct: false, answer: P.n, img: '/players/' + pslug(P.n) + '.jpg', score: 0, done: true, wrong: C.wrong };
      C.shown++;
      return { correct: false, clues: C.clues.slice(0, C.shown), shown: C.shown, potential: rewards[C.shown - 1], wrong: C.wrong };
    }
    if (r.game === 'odds') {
      const ev = C.ev[r.i];
      const ok = b.pick === ev.best;
      let bonus = 0;
      if (ok) { r.correct++; r.streak++; r.score += 100; if (r.streak === 5) { bonus = 300; r.score += 300; r.bonuses += 300; } } else r.streak = 0;
      r.i++;
      const out = { correct: ok, probs: ev.probs, best: ev.best, table: ev.table, streak: r.streak, bonus, score: r.score };
      if (r.i >= C.ev.length) out.done = true;
      else out.next = { i: r.i, home: C.ev[r.i].home, away: C.ev[r.i].away, competition: C.ev[r.i].competition, utcDate: C.ev[r.i].utcDate };
      return out;
    }
    throw Object.assign(new Error('This game has no steps'), { status: 400 });
  }

  const REACTION_TIERS = [[200, 500], [250, 400], [300, 300], [400, 150]];
  function finishRun(p, b) {
    const r = getRun(p, b.run);
    const e = wallet(p);
    let score = r.score, ms = null, detail = {};
    if (r.game === 'penalty') {
      const valid = [0, 100, 150, 250];
      const shots = Array.isArray(b.shots) ? b.shots.slice(0, 5).map((x) => (valid.includes(Number(x)) ? Number(x) : 0)) : [];
      if (shots.length !== 5) throw Object.assign(new Error('Take all five penalties.'), { status: 400 });
      if (Date.now() - r.t0 < 5000) throw Object.assign(new Error('Too quick. Take your time.'), { status: 400 });
      score = shots.reduce((a, x) => a + x, 0);
      detail = { goals: shots.filter((x) => x > 0).length, shots };
    } else if (r.game === 'reaction') {
      if (b.early) { score = 0; detail = { early: true }; }
      else {
        ms = Math.round(Number(b.ms));
        if (!(ms >= 100 && ms <= 3000)) throw Object.assign(new Error('That time does not look human.'), { status: 400 });
        if (Date.now() - r.t0 < 1500 + ms - 400) throw Object.assign(new Error('Too quick.'), { status: 400 });
        score = 50; for (const [lim, pts] of REACTION_TIERS) if (ms < lim) { score = pts; break; }
        detail = { ms };
      }
    } else if (r.game === 'quiz') {
      detail = { correct: r.correct, total: 10 };
    } else if (r.game === 'hilo') {
      detail = { correct: r.correct, total: 5 };
    } else if (r.game === 'whoami') {
      detail = { correct: Boolean(r.correct), clues: r.content.shown, answer: r.content.P.n };
    } else if (r.game === 'odds') {
      detail = { correct: r.correct, total: r.content.ev.length };
    }
    score = Math.max(0, Math.min(GAMES[r.game].max, Math.round(score)));
    r.done = true; runs.delete(r.id);
    const cap = playToday(e);
    const reward = Math.min(score, cap.left);
    const before = p.credits;
    if (reward > 0) { credit(p, reward, `${GAMES[r.game].name}`, r.id); e.play.earned += reward; }
    // personal best + boards
    const g = e.games[r.game];
    const metric = r.game === 'reaction' ? ms : score;
    let newBest = false;
    if (metric != null && !detail.early && (r.game === 'reaction' || metric > 0)) {
      if (g.best == null || (r.game === 'reaction' ? metric < g.best : metric > g.best)) { g.best = metric; newBest = true; }
    }
    g.last = { score, reward, ms, detail, t: new Date().toISOString() };
    const board = boardAdd(r.game, p, metric, score);
    saveData();
    logEvent('play_finish', { game: r.game, score, reward }, false);
    return { game: r.game, score, reward, capped: reward < score, before, credits: p.credits, ms, detail, best: g.best, newBest, board, tickets: tickets(e), play: playToday(e) };
  }

  function boardAdd(game, p, metric, score) {
    const d = db(); if (!d.gb) d.gb = {};
    const day = dayKey();
    for (const k of Object.keys(d.gb)) if (k < dayKey(Date.now() - 3 * DAY)) delete d.gb[k];
    if (!d.gb[day]) d.gb[day] = {};
    const low = GAMES[game].lowWins;
    if (metric == null || !eligible(p) || (!low && metric <= 0)) return boardView(game, p); // a zero is not a score worth a board spot
    const rows = d.gb[day][game] || (d.gb[day][game] = []);
    const cur = rows.find((x) => x.pid === p.id);
    const better = (a, b) => (low ? a < b : a > b);
    if (!cur) rows.push({ pid: p.id, name: p.name, m: metric, s: score });
    else if (better(metric, cur.m)) { cur.m = metric; cur.s = score; cur.name = p.name; }
    rows.sort((a, b) => (low ? a.m - b.m : b.m - a.m));
    if (rows.length > 50) rows.length = 50;
    if (!d.gbest) d.gbest = {};
    const gb = d.gbest[game];
    if (!gb || better(metric, gb.m)) d.gbest[game] = { pid: p.id, name: p.name, m: metric, day };
    return boardView(game, p);
  }
  function boardView(game, p) {
    const d = db(); const rows = ((d.gb || {})[dayKey()] || {})[game] || [];
    const i = p ? rows.findIndex((x) => x.pid === p.id) : -1;
    return { top: rows.slice(0, 10).map((x, j) => ({ rank: j + 1, name: x.name, m: x.m, me: p ? x.pid === p.id : false })), myRank: i >= 0 ? i + 1 : null, of: rows.length, globalBest: (d.gbest || {})[game] ? { name: d.gbest[game].name, m: d.gbest[game].m } : null };
  }
  function playView(p) {
    const e = wallet(p); const daily = dailyGameId();
    return {
      credits: p.credits, tickets: tickets(e), play: playToday(e), daily,
      games: GAME_IDS.map((id) => {
        const bv = boardView(id, p);
        return { id, ...GAMES[id], best: (e.games[id] || {}).best ?? null, plays: (e.games[id] || {}).plays || 0, last: (e.games[id] || {}).last || null, globalBest: bv.globalBest, top: bv.top.slice(0, 3), daily: id === daily };
      }),
    };
  }

  // ------------------------------------------------------------------------
  // Share cards ("BACK YOURSELF." brag cards), text composed from real data only
  // ------------------------------------------------------------------------
  const escx = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  function bragText(p, kind) {
    const e = wallet(p); const st = statsFor(p);
    if (kind === 'rank') { const g = globalRank(p); return { head: `I'M #${g.rank || '?'} GLOBAL.`, sub: `${p.credits.toLocaleString('en-GB')} C · SKILL ${st.skill}` }; }
    if (kind === 'streak') return { head: `${currentStreak(e)} DAY STREAK.`, sub: 'Showing up every day on Clashly.' };
    if (kind === 'beat') {
      const rows = globalRows(); const i = rows.findIndex((x) => x.id === p.id);
      const pct = rows.length > 1 && i >= 0 ? Math.round(((rows.length - 1 - i) / (rows.length - 1)) * 100) : 0;
      return { head: `I BEAT ${pct}% OF CLASHLY PLAYERS.`, sub: `${p.credits.toLocaleString('en-GB')} C · SKILL ${st.skill}` };
    }
    if (kind === 'clash') {
      const last = decidedClashes(p.id).filter((b) => (b.winner === 'proposer' ? b.proposerId : b.opponentId) === p.id).sort((a, b) => Date.parse(b.resolvedAt || 0) - Date.parse(a.resolvedAt || 0))[0];
      return last ? { head: 'I WON MY CLASH.', sub: `${last.home}${last.away ? ' v ' + last.away : ''} · beat ${last.winner === 'proposer' ? last.opponentName : last.proposerName}` } : { head: 'READY TO CLASH.', sub: 'Think you know better? Prove it.' };
    }
    if (kind === 'pick') {
      const k = Object.values(db().picks || {}).filter((x) => x.pid === p.id && x.st === 'won').sort((a, b) => Date.parse(b.set || 0) - Date.parse(a.set || 0))[0];
      return k ? { head: `CALLED IT. +${k.pay.toLocaleString('en-GB')} C`, sub: `${k.home} v ${k.away} · ${k.x.toFixed(2)}x` } : { head: 'BACK YOURSELF.', sub: 'Predict. Compete. Prove it.' };
    }
    if (kind.startsWith('game-')) {
      const id = kind.slice(5); const g = e.games[id]; const G = GAMES[id];
      if (!G || !g || !g.last) return { head: 'BACK YOURSELF.', sub: 'Play on Clashly.' };
      const L = g.last;
      const head = id === 'quiz' ? `I JUST HIT ${L.detail.correct}/10 ON CLASHLY QUIZ.`
        : id === 'reaction' ? (L.ms ? `${L.ms}MS. BEAT THAT.` : 'TOO EARLY. AGAIN.')
        : id === 'penalty' ? `${L.detail.goals}/5 PENALTIES SCORED.`
        : id === 'hilo' ? `${L.detail.correct}/5 ON HIGHER OR LOWER.`
        : id === 'whoami' ? (L.detail.correct ? `GOT IT IN ${L.detail.clues} CLUE${L.detail.clues === 1 ? '' : 'S'}.` : 'STUMPED.')
        : `${L.detail.correct}/${L.detail.total} ON ODDS MASTER.`;
      return { head, sub: `${G.name} · +${L.reward.toLocaleString('en-GB')} C` };
    }
    return { head: 'BACK YOURSELF.', sub: 'Think you know sports? Prove it.' };
  }
  function bragSvg(p, kind) {
    const t = bragText(p, kind);
    const size = t.head.length > 26 ? 64 : t.head.length > 18 ? 78 : 96;
    return `<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1080" viewBox="0 0 1080 1080">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#14E0C8"/><stop offset="1" stop-color="#7C3AED"/></linearGradient>
<radialGradient id="r" cx=".5" cy=".18" r=".8"><stop offset="0" stop-color="#14E0C8" stop-opacity=".22"/><stop offset="1" stop-color="#0A0E13" stop-opacity="0"/></radialGradient></defs>
<rect width="1080" height="1080" fill="#0A0E13"/><rect width="1080" height="1080" fill="url(#r)"/>
<rect x="60" y="60" width="960" height="960" rx="48" fill="none" stroke="url(#g)" stroke-width="6"/>
<g transform="translate(496,104) scale(.88)"><rect width="100" height="100" rx="26" fill="#0E141C"/><path d="M49.4 19A31 31 0 0 0 49.4 81L49.4 68A18 18 0 0 1 49.4 32Z" fill="#14E0C8"/><path d="M50.6 19A31 31 0 0 1 74 30L64 39A18 18 0 0 0 50.6 32ZM74 70A31 31 0 0 1 50.6 81L50.6 68A18 18 0 0 0 64 61Z" fill="#7C3AED"/></g>
<text x="540" y="262" text-anchor="middle" font-family="Anton" font-size="54" letter-spacing="8" fill="#F4F7FB">CLASHLY</text>
<text x="540" y="310" text-anchor="middle" font-family="Inter" font-weight="800" font-size="26" letter-spacing="6" fill="#14E0C8">${escx(p.name.toUpperCase())}</text>
<text x="540" y="560" text-anchor="middle" font-family="Anton" font-size="${size}" fill="#F4F7FB">${escx(t.head)}</text>
<text x="540" y="650" text-anchor="middle" font-family="Inter" font-weight="700" font-size="34" fill="#9AA7B8">${escx(t.sub)}</text>
<rect x="340" y="800" width="400" height="6" rx="3" fill="url(#g)"/>
<text x="540" y="890" text-anchor="middle" font-family="Anton" font-size="64" letter-spacing="3" fill="url(#g)">BACK YOURSELF.</text>
<text x="540" y="950" text-anchor="middle" font-family="Inter" font-weight="700" font-size="28" fill="#7C8A9C">clashly.live · virtual Credits, no cash value · 18+</text>
</svg>`;
  }
  function serveBrag(req, res, url) {
    const m = url.pathname.match(/^\/brag\/([a-f0-9]+)\/([a-z0-9-]+)\.(svg|png)$/);
    if (!m) { res.writeHead(404); return res.end('Not found'); }
    const p = db().players[m[1]];
    if (!p || !eligible(p)) { res.writeHead(404); return res.end('Not found'); }
    const svg = bragSvg(p, m[2]);
    if (m[3] === 'svg') { res.writeHead(200, { 'Content-Type': 'image/svg+xml; charset=utf-8', 'Cache-Control': 'no-cache' }); return res.end(svg); }
    const png = cards.renderPng(svg);
    if (png) { res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-cache' }); return res.end(png); }
    res.writeHead(302, { Location: `/brag/${m[1]}/${m[2]}.svg` }); res.end();
  }

  // ------------------------------------------------------------------------
  // HTTP
  // ------------------------------------------------------------------------
  const err = (res, e) => sendJson(res, e.status || 500, { error: e.message || 'Something went wrong' });
  const rowView = (p, me, value, extra) => ({ id: p.id, name: p.name, value, me: Boolean(me && me.id === p.id), founding: (p.seq || 1e9) <= FOUNDING_CAP, ...extra });

  async function handle(req, res, url, parts) {
    const seg = parts[1];
    try {
      // GET /api/founding: real count, never faked
      if (req.method === 'GET' && seg === 'founding') return sendJson(res, 200, { count: foundingCount(), cap: FOUNDING_CAP }), true;

      // admin hooks for tests and manual corrections; disabled unless ADMIN_KEY is set
      if (seg === 'admin') {
        const key = process.env.ADMIN_KEY;
        if (!key || req.headers['x-admin-key'] !== key) return sendJson(res, 404, { error: 'Unknown endpoint' }), true;
        const b = await readBody(req);
        if (parts[2] === 'result') { const n = settleKey(String(b.key), String(b.outcome)); saveData(); return sendJson(res, 200, { settled: n }), true; }
        if (parts[2] === 'standings') { const d = db(); if (!d.meta) d.meta = {}; if (!d.meta.standings) d.meta.standings = {}; d.meta.standings[b.code] = { t: Date.now(), teams: b.teams || {} }; saveData(); return sendJson(res, 200, { ok: true }), true; }
        if (parts[2] === 'roll') { // test hook: pretend this week just ended
          const d = db(); if (!d.meta) d.meta = {}; const k = weekKey();
          for (const p of players()) if (p.eco && p.eco.wk && p.eco.wk.k === k) p.eco.wk.k = k - 1;
          d.meta.seasonKey = k - 1; rollSeason(); return sendJson(res, 200, { ok: true }), true;
        }
        if (parts[2] === 'grant') { const p = d0player(b.id); if (!p) return sendJson(res, 404, { error: 'no player' }), true; credit(p, Number(b.amount) || 0, 'Admin adjustment'); saveData(); return sendJson(res, 200, { credits: p.credits }), true; }
        return sendJson(res, 404, { error: 'Unknown admin action' }), true;
      }

      const OURS = ['wallet', 'credits', 'home', 'predict', 'picks', 'rank', 'card', 'play'];
      if (!OURS.includes(seg)) return false;
      const me = authPlayer(req);
      if (!me) return sendJson(res, 401, { error: 'Sign in on this device first.' }), true;
      wallet(me);

      if (req.method === 'GET' && seg === 'wallet') { const changed = rollSeason(); if (changed) saveData(); return sendJson(res, 200, walletView(me)), true; }

      if (req.method === 'POST' && seg === 'credits' && parts[2] === 'onboard') {
        const b = await readBody(req);
        me.eco.onboarded = true;
        if (b.voter && db().arcade && db().arcade[b.voter] && !me.eco.legacyArcade) me.eco.legacyArcade = db().arcade[b.voter].points || 0;
        saveData(); logEvent('credits_onboard', {}, false);
        return sendJson(res, 200, walletView(me)), true;
      }
      if (req.method === 'POST' && seg === 'credits' && parts[2] === 'daily') {
        const out = claimDaily(me); saveData(); logEvent('daily_reward', { day: out.day }, false);
        return sendJson(res, 200, { ...out, wallet: walletView(me) }), true;
      }

      if (req.method === 'GET' && seg === 'home') {
        rollSeason();
        const tc = await todaysClash();
        const tcv = tc ? matchView(tc, me) : null;
        const tr = await trending(tcv ? (tc.externalId || tc.id) : null, 4);
        const st = statsFor(me);
        const wr = weeklyRows();
        const wme = wr.findIndex((r) => r.p.id === me.id);
        const g = globalRank(me);
        const fresh = Object.values(db().picks || {}).filter((k) => k.pid === me.id && (k.st === 'won' || k.st === 'lost' || k.st === 'void') && !k.seen)
          .sort((a, b) => Date.parse(b.set || 0) - Date.parse(a.set || 0)).slice(0, 5).map(pickView);
        const open = Object.values(db().picks || {}).filter((k) => k.pid === me.id && k.st === 'open').sort((a, b) => Date.parse(a.utc) - Date.parse(b.utc)).map(pickView);
        const pv = playView(me); const dg = pv.games.find((x) => x.id === pv.daily);
        return sendJson(res, 200, {
          wallet: walletView(me), todaysClash: tcv, trending: tr.map((m) => matchView(m, me)), open, fresh,
          dailyGame: { ...dg, tickets: pv.tickets },
          stats: { skill: st.skill, accuracy: st.accuracy, rank: g.rank, of: g.of, winStreak: st.winStreak, decided: st.decided },
          weekly: { season: seasonInfo(), top: wr.slice(0, 3).map((r, i) => rowView(r.p, me, r.wk.net, { rank: i + 1, wins: r.wk.wins })), me: { rank: wme >= 0 ? wme + 1 : null, net: me.eco.wk.net, wins: me.eco.wk.wins, of: wr.length } },
          founding: { count: foundingCount(), cap: FOUNDING_CAP, mine: (me.seq || 1e9) <= FOUNDING_CAP ? me.seq : null },
        }), true;
      }

      if (req.method === 'GET' && seg === 'predict' && parts[2]) {
        const m = await findMatch(decodeURIComponent(parts[2]));
        if (!m) return sendJson(res, 404, { error: 'That match is not on the board.' }), true;
        return sendJson(res, 200, { match: matchView(m, me), credits: me.credits, min: PICK_MIN, max: PICK_MAX }), true;
      }
      if (req.method === 'GET' && seg === 'predict') {
        const list = (await upcoming()).sort((a, b) => (bigScore(b) - bigScore(a)) || (Date.parse(a.utcDate) - Date.parse(b.utcDate))).slice(0, 40);
        return sendJson(res, 200, { matches: list.map((m) => matchView(m, me)) }), true;
      }
      if (req.method === 'POST' && seg === 'picks' && !parts[2]) {
        const b = await readBody(req);
        return sendJson(res, 201, await makePick(me, b)), true;
      }
      if (req.method === 'POST' && seg === 'picks' && parts[2] === 'seen') {
        const b = await readBody(req); const ids = new Set((b.ids || []).map(String));
        for (const k of Object.values(db().picks || {})) if (k.pid === me.id && ids.has(k.id)) k.seen = true;
        saveData();
        return sendJson(res, 200, { ok: true }), true;
      }
      if (req.method === 'GET' && seg === 'picks') {
        const mine = Object.values(db().picks || {}).filter((k) => k.pid === me.id).sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, 50).map(pickView);
        return sendJson(res, 200, { picks: mine }), true;
      }

      if (req.method === 'GET' && seg === 'rank') {
        rollSeason();
        const scope = ['global', 'weekly', 'friends'].includes(url.searchParams.get('scope')) ? url.searchParams.get('scope') : 'global';
        let rows;
        if (scope === 'weekly') rows = weeklyRows().map((r, i) => rowView(r.p, me, r.wk.net, { rank: i + 1, wins: r.wk.wins }));
        else if (scope === 'friends') { const ids = friendIds(me); rows = globalRows().filter((p) => ids.has(p.id)).map((p, i) => rowView(p, me, p.credits, { rank: i + 1 })); }
        else rows = globalRows().map((p, i) => rowView(p, me, p.credits, { rank: i + 1 }));
        const mine = rows.find((r) => r.me) || null;
        const e = me.eco; const wr = weeklyRank(me);
        return sendJson(res, 200, {
          scope, season: seasonInfo(), total: rows.length, rows: rows.slice(0, 100), me: mine,
          seasonStats: { currentRank: wr.rank, of: wr.of, bestRank: e.bestRank || null, weeklyWins: e.wk.wins, weeklyEarnings: e.wk.net },
          history: (e.hist || []).slice(0, 8), past: ((db().meta || {}).seasons || []).slice(0, 4),
        }), true;
      }

      if (req.method === 'GET' && seg === 'card') {
        const st = statsFor(me); const g = globalRank(me);
        const picks = Object.values(db().picks || {}).filter((k) => k.pid === me.id).sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, 30).map(pickView);
        const clashes = Object.values(db().bets || {}).filter((b) => (b.proposerId === me.id || b.opponentId === me.id) && b.status !== 'void')
          .sort((a, b) => Date.parse(b.resolvedAt || b.createdAt || 0) - Date.parse(a.resolvedAt || a.createdAt || 0)).slice(0, 30)
          .map((b) => ({ id: b.id, home: b.home, away: b.away, status: b.status, opponent: b.proposerId === me.id ? b.opponentName : b.proposerName, credits: b.credits || 0, won: (b.status === 'resolved' || b.status === 'settled') ? (b.winner === 'proposer' ? b.proposerId : b.opponentId) === me.id : null, t: b.resolvedAt || b.createdAt }));
        const games = GAME_IDS.map((id) => ({ id, name: GAMES[id].name, icon: GAMES[id].icon, best: (me.eco.games[id] || {}).best ?? null, plays: (me.eco.games[id] || {}).plays || 0, lowWins: Boolean(GAMES[id].lowWins) }));
        return sendJson(res, 200, {
          name: me.name, seq: me.seq || null, credits: me.credits, skill: st.skill, globalRank: g.rank, of: g.of, accuracy: st.accuracy, winStreak: st.winStreak,
          clashes: st.clashes, bestRank: me.eco.bestRank || null, stats: st, badges: badgesFor(me, st), streak: walletView(me).streak,
          picks, clashHistory: clashes, games, log: me.eco.log.slice(0, 20), legacyArcade: me.eco.legacyArcade || 0,
        }), true;
      }

      if (seg === 'play') {
        if (req.method === 'GET' && !parts[2]) return sendJson(res, 200, playView(me)), true;
        if (req.method === 'GET' && parts[2] === 'board' && GAMES[parts[3]]) return sendJson(res, 200, { game: parts[3], ...GAMES[parts[3]], ...boardView(parts[3], me), best: (me.eco.games[parts[3]] || {}).best ?? null }), true;
        const b = await readBody(req);
        if (req.method === 'POST' && parts[2] === 'start') return sendJson(res, 200, await startRun(me, String(b.game || ''))), true;
        if (req.method === 'POST' && parts[2] === 'step') return sendJson(res, 200, stepRun(me, b)), true;
        if (req.method === 'POST' && parts[2] === 'finish') return sendJson(res, 200, finishRun(me, b)), true;
      }
      return sendJson(res, 404, { error: 'Unknown endpoint' }), true;
    } catch (e) {
      if (!e.status) console.error(e);
      return err(res, e), true;
    }
  }
  const d0player = (id) => db().players[id];

  return {
    handle, serveBrag, picksSweep, standingsSweep, rollSeason,
    wallet, credit, markActivity, clashCreditsOnCreate, clashCreditsOnAccept, clashResolved, refundClash,
    _test: { tierFor, modelProbs, quizBonus, dailyGameId, seasonInfo },
  };
};

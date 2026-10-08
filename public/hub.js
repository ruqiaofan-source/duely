'use strict';
// ---------------------------------------------------------------------------
// Clashly hub: Credits, onboarding, Home, predictions, Rank, Clash, Profile.
// Loaded before app.js; every function here runs only after app.js has
// defined the shared helpers (api, me, $, esc, toast, openSheet, ...).
// Credits are virtual: no cash value, no deposits, no withdrawals.
// ---------------------------------------------------------------------------

let WALLET = null;
const fmt = (n) => Number(n || 0).toLocaleString('en-GB');
const signedC = (n) => (n >= 0 ? '+' : '−') + fmt(Math.abs(n)) + ' C';
const reduceMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const multTxt = (x) => Number(x).toFixed(2) + 'x';
const outLbl = (m, o) => (o === 'HOME' ? m.home : o === 'AWAY' ? m.away : 'Draw');

async function loadWallet() {
  if (!me.get()) { WALLET = null; return null; }
  try { WALLET = await api('/wallet'); } catch { WALLET = WALLET || null; }
  paintPill();
  return WALLET;
}

// ---- the Credits pill in the header ----
function pillHtml() {
  const w = WALLET; const m = me.get();
  if (!w || !m) return '';
  const st = w.streak && w.streak.days ? `<span class="hstreak" title="Daily streak">🔥<b>${w.streak.days}</b></span>` : '';
  return `${st}<button class="cpill" id="cpill" aria-label="Your Credits"><span class="cp-num" id="cpNum">${fmt(w.credits)}</span><span class="cp-c">C</span></button><button class="hav" id="hav" aria-label="Profile">${esc(initials(m.name))}</button>`;
}
function paintPill() {
  const box = document.getElementById('pillBox');
  if (!box) return;
  box.innerHTML = pillHtml();
  const cp = document.getElementById('cpill'); if (cp) cp.addEventListener('click', openCreditsSheet);
  const av = document.getElementById('hav'); if (av) av.addEventListener('click', () => go('/profile'));
}
function go(path) { if (location.pathname !== path) history.pushState({}, '', path); route(); }

// count the pill (and any mirror element) from the old balance to the new one
function animateCredits(to, delta, opts = {}) {
  const from = opts.from != null ? opts.from : (WALLET ? WALLET.credits : to - (delta || 0));
  if (WALLET) WALLET.credits = to;
  const els = [document.getElementById('cpNum'), ...document.querySelectorAll('[data-balmirror]')].filter(Boolean);
  if (!els.length) paintPill();
  const targets = els.length ? els : [document.getElementById('cpNum')].filter(Boolean);
  if (delta) floatDelta(delta);
  if (reduceMotion() || from === to) { targets.forEach((el) => { el.textContent = fmt(to); }); return; }
  const t0 = performance.now(), dur = Math.min(1400, 600 + Math.abs(to - from) / 8);
  const step = (t) => {
    const k = Math.min(1, (t - t0) / dur), e = 1 - Math.pow(1 - k, 3);
    const v = Math.round(from + (to - from) * e);
    targets.forEach((el) => { el.textContent = fmt(v); });
    if (k < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
  const cp = document.getElementById('cpill');
  if (cp) { cp.classList.remove('bump', 'dip'); void cp.offsetWidth; cp.classList.add(delta >= 0 ? 'bump' : 'dip'); }
}
function floatDelta(delta) {
  const cp = document.getElementById('cpill'); if (!cp) return;
  const r = cp.getBoundingClientRect();
  const f = document.createElement('div');
  f.className = 'cdelta ' + (delta >= 0 ? 'up' : 'down');
  f.textContent = signedC(delta);
  f.style.left = (r.left + r.width / 2) + 'px'; f.style.top = (r.bottom + 6) + 'px';
  document.body.appendChild(f);
  setTimeout(() => f.remove(), 1700);
  if (delta > 0) { sfx('ping'); haptic([10, 30, 12]); }
}

async function openCreditsSheet() {
  let card = null; try { card = await api('/card'); } catch {}
  const w = WALLET || {};
  const rows = card && card.log ? card.log.map((l) => `<div class="recent"><span>${esc(l.r)}<br><span class="sm" style="color:var(--muted-2)">${timeAgo(l.t)}</span></span><span class="res ${l.d >= 0 ? 'w' : ''}" style="${l.d < 0 ? 'color:var(--muted)' : ''}">${signedC(l.d)}</span></div>`).join('') : '';
  openSheet(`
    <div class="sheet-handle"></div>
    <div class="sheet-head"><h2>Your Credits</h2><button class="sheet-x" id="sheetClose" aria-label="Close">✕</button></div>
    <div class="sheet-body">
      <div class="bigbal"><span>${fmt(w.credits)}</span><span class="c">C</span></div>
      <p class="sub" style="text-align:center;margin:4px 0 14px"><span>Virtual in-game Credits. No cash value, no deposits, no withdrawals.</span></p>
      <label>Where they came from</label>
      ${rows || '<p class="sub">Nothing yet.</p>'}
    </div>`);
  $('#sheetClose').addEventListener('click', closeSheet);
}

// ---------------------------------------------------------------------------
// Onboarding: four screens, then Home
// ---------------------------------------------------------------------------
function renderCreditsOnboarding(opts = {}) {
  track('onboard_view');
  setTab(null);
  const existing = Boolean(me.get());
  let step = opts.step || 0;
  const flow = ['10,000 CREDITS', 'PREDICTION', 'RESULT', 'WIN / LOSE', 'RANKING'];
  const screens = [
    () => `
      <div class="ob-kick">⚔️ CLASHLY</div>
      <div class="ob-hero"><div>BACK</div><div class="grad">YOURSELF.</div></div>
      <p class="ob-lede">Think you know sports better than everyone else?</p>
      <p class="ob-tag">Predict. Compete. Prove it.</p>
      <button class="cta" data-ob="next">GET STARTED</button>
      ${existing ? '' : '<button class="muted-link" id="obSignin">I already have an account → sign in</button>'}`,
    () => `
      <div class="ob-kick">HOW CLASHLY WORKS</div>
      <ol class="ob-list">
        <li><span>You start with</span> <b>10,000</b> <span>free Clashly Credits.</span></li>
        <li><span>Use Credits to make sports predictions.</span></li>
        <li><span>Win Credits when your predictions are correct.</span></li>
        <li><span>Compete for a higher ranking.</span></li>
        <li><span>Challenge your friends.</span></li>
      </ol>
      <div class="ob-flow">${flow.map((f, i) => `<span class="ob-step" style="--i:${i}">${f}</span>`).join('<span class="ob-arrow">→</span>')}</div>
      <button class="cta" data-ob="next">NEXT</button>`,
    () => `
      <div class="ob-kick">CREDITS ARE THE GAME</div>
      <p class="ob-lede">Clashly Credits are virtual in-game Credits.</p>
      <p class="sub" style="margin:0 0 10px">You can:</p>
      <div class="ob-verbs">${['earn them', 'risk them', 'win them', 'lose them', 'use them in competitions', 'use them in selected mini-games'].map((v) => `<span>${v}</span>`).join('')}</div>
      <div class="ob-legal"><div><b>Credits have no cash value.</b></div><div>There are no deposits or withdrawals.</div></div>
      <button class="cta" data-ob="next">NEXT</button>`,
    () => `
      <div class="ob-kick">READY?</div>
      <p class="ob-lede" style="margin-bottom:6px">Your first:</p>
      <div class="ob-bal"><span id="obBal">10,000</span> <span class="c">CREDITS</span></div>
      <p class="ob-lede">are waiting.</p>
      ${existing ? '' : `
        <label for="name">What should mates call you?</label>
        <input id="name" placeholder="e.g. Alex" maxlength="40" autocomplete="nickname" />
        <div class="checkrow"><input type="checkbox" id="age" /><label for="age">I'm 18 or over.</label></div>`}
      <button class="cta" id="go" data-ob="enter">ENTER CLASHLY</button>`,
  ];
  const paint = () => {
    app.innerHTML = `<div class="ob card" data-step="${step}">
      <div class="ob-top">${step > 0 ? '<button class="ob-back" data-ob="back" aria-label="Back">←</button>' : '<span></span>'}
        <div class="ob-dots">${screens.map((_, i) => `<span class="${i === step ? 'on' : i < step ? 'done' : ''}"></span>`).join('')}</div><span></span></div>
      <div class="ob-body">${screens[step]()}</div>
      <p class="ob-foot"><span>Free to play. Virtual Credits only. 18+</span></p>
    </div>`;
    app.querySelectorAll('[data-ob="next"]').forEach((b) => b.addEventListener('click', () => { haptic(8); step++; paint(); }));
    const back = app.querySelector('[data-ob="back"]'); if (back) back.addEventListener('click', () => { step--; paint(); });
    const si = $('#obSignin'); if (si) si.addEventListener('click', () => openLoginSheet(() => route()));
    const enter = app.querySelector('[data-ob="enter"]');
    if (enter) enter.addEventListener('click', async () => {
      if (!existing) {
        const name = ($('#name').value || '').trim();
        if (!name) return toast('Pick a name');
        if (!$('#age').checked) return toast("Confirm you're 18+");
        enter.disabled = true; enter.textContent = 'Setting up…';
        try { await register(name); } catch (e) { enter.disabled = false; enter.textContent = 'ENTER CLASHLY'; return toast(e.message); }
      } else { enter.disabled = true; }
      try { WALLET = await api('/credits/onboard', { method: 'POST', body: JSON.stringify({ voter: voterId() }) }); } catch {}
      track('onboard_done');
      renderHeader();
      history.pushState({}, '', '/');
      setTab('home');
      await renderHub({ welcome: true });
    });
    const nm = $('#name'); if (nm) nm.focus();
  };
  paint();
}

// ---------------------------------------------------------------------------
// HOME
// ---------------------------------------------------------------------------
function crowdBars(m) {
  const c = m.crowd || {};
  if (!c.total) return `<p class="crowd-empty"><span>No picks yet. Be the first to call it.</span></p>`;
  return `<div class="crowd">${['HOME', 'DRAW', 'AWAY'].map((o, i) => `
    <div class="cr-row"><span class="cr-l">${esc(outLbl(m, o))}</span><span class="cr-bar"><i style="width:${c[o] || 0}%;background:${i === 0 ? 'var(--teal)' : i === 1 ? 'var(--muted)' : 'var(--purple-text)'}"></i></span><b>${c[o] || 0}%</b></div>`).join('')}
    <p class="crowd-n">${c.total} ${c.total === 1 ? 'pick' : 'picks'}</p></div>`;
}
function pickStatusHtml(k, m) {
  if (!k) return '';
  if (k.status === 'open') return `<div class="locked"><div class="lk-t">🔒 <span>YOUR PICK IS LOCKED.</span></div>
    <div class="lk-row"><span>${esc(outLbl(m || k, k.outcome))} · ${multTxt(k.mult)}</span><span><b>${fmt(k.amount)} C</b> → <b class="teal">${fmt(k.potential)} C</b></span></div></div>`;
  if (k.status === 'won') return `<div class="verdict win"><div class="v-t">CORRECT</div><div class="v-n">+${fmt(k.payout)} C</div></div>`;
  if (k.status === 'lost') return `<div class="verdict loss"><div class="v-t">WRONG</div><div class="v-n">−${fmt(k.amount)} C</div></div>`;
  return `<div class="verdict"><div class="v-t">VOID</div><div class="v-n">Refunded</div></div>`;
}
function optButtons(m, sel) {
  return `<div class="opts">${['HOME', 'DRAW', 'AWAY'].map((o) => `
    <button class="opt ${sel === o ? 'on' : ''}" data-o="${o}" ${m.locked ? 'disabled' : ''}><span class="o-l">${esc(outLbl(m, o).toUpperCase())}</span><span class="o-x">${multTxt(m.mult[o])}</span></button>`).join('')}</div>`;
}

async function renderHub(opts = {}) {
  const my = ++_gen; const live = () => my === _gen;
  let h;
  try { h = await api('/home'); }
  catch (e) {
    if (!live()) return;
    app.innerHTML = `<div class="card"><h2>Can't reach Clashly</h2><p class="sub">Connection blip. Your Credits are safe.</p><button class="cta" id="retry">Try again</button></div>`;
    $('#retry').addEventListener('click', () => renderHub(opts));
    return;
  }
  if (!live()) return;
  const prevBal = WALLET ? WALLET.credits : null;
  WALLET = h.wallet; paintPill();
  const w = h.wallet, tc = h.todaysClash, st = h.stats, wk = h.weekly, dg = h.dailyGame;
  const d = w.daily;
  const tm = tc && !tc.locked && !tc.myPick;

  app.innerHTML = `
    <section class="card hb">
      <div class="hb-top"><span class="kick">YOUR CREDITS</span>${w.streak.days ? `<span class="chip fire">🔥 <b>${w.streak.days}</b> <span>DAY STREAK</span></span>` : ''}</div>
      <div class="hb-num"><span data-balmirror>${fmt(opts.welcome ? 0 : w.credits)}</span><span class="c">C</span></div>
      <div class="hb-sub"><span>Rank</span> <b>#${st.rank || '–'}</b> · <span>Skill</span> <b>${st.skill}</b> · <span>Week</span> <b>${w.season.week}</b></div>
      ${d.available ? `<button class="daily" id="claimDaily"><span class="d-ic">🎁</span><span class="d-t"><b><span>DAILY REWARD</span> · ${d.day}/7</b><br>+${fmt(d.amount)} C${d.ticket ? ' + 1 🎟️' : ''}</span><span class="d-go">CLAIM</span></button>` : ''}
    </section>
    <div id="freshBox"></div>
    ${tc ? `<section class="card tc">
      <div class="tc-head"><span class="kick teal">TODAY'S CLASH</span><span class="tc-meta">${esc(tc.competition)}${tc.utcDate ? ' · ' + kickoffTxt(tc.utcDate) : ''}</span></div>
      <div class="tc-teams"><div class="tt">${esc(tc.home)}</div><div class="tvs">vs</div><div class="tt">${esc(tc.away)}</div></div>
      ${tc.myPick ? pickStatusHtml(tc.myPick, tc) : `<div class="tc-q">Who wins?</div>${optButtons(tc, null)}`}
      ${crowdBars(tc)}
      ${tm ? '<button class="cta" id="tcPick">MAKE YOUR PICK</button>' : tc.locked && !tc.myPick ? '<div class="banner">🔒 Kicked off. Picks are closed.</div>' : ''}
    </section>` : `<section class="card tc"><span class="kick teal">TODAY'S CLASH</span><p class="sub" style="margin:8px 0 0">No big game on the board right now. New fixtures land daily.</p></section>`}
    ${h.open && h.open.filter((k) => !tc || k.matchId !== tc.id).length ? `<section class="card"><div class="cardhead"><h2>Your live picks</h2><span class="pill accepted">${h.open.length}</span></div>
      ${h.open.filter((k) => !tc || k.matchId !== tc.id).slice(0, 4).map((k) => `<div class="recent"><span>${esc(k.home)} v ${esc(k.away)}<br><span class="sm" style="color:var(--muted-2)">${esc(outLbl(k, k.outcome))} · ${multTxt(k.mult)} · ${kickoffTxt(k.utcDate)}</span></span><span class="res">${fmt(k.amount)} → <span style="color:var(--teal)">${fmt(k.potential)}</span></span></div>`).join('')}</section>` : ''}
    ${h.trending.length ? `<section class="card">
      <div class="cardhead"><h2>Trending predictions</h2><button class="linkbtn" id="allMatches">All matches →</button></div>
      ${h.trending.map((m) => `<div class="trend" data-mid="${esc(m.id)}" role="button" tabindex="0">
        <div class="tr-l"><div class="nm">${esc(m.home)} <span class="v">v</span> ${esc(m.away)}</div><div class="sm">${esc(m.competition)} · ${kickoffTxt(m.utcDate)}${m.crowd.total ? ` · ${m.crowd.total} ${m.crowd.total === 1 ? 'pick' : 'picks'}` : ''}</div></div>
        ${m.myPick ? `<span class="tr-mine">✓ ${esc(outLbl(m, m.myPick.outcome))}</span>` : `<div class="tr-x">${['HOME', 'DRAW', 'AWAY'].map((o) => `<button data-mid="${esc(m.id)}" data-o="${o}">${o === 'HOME' ? '1' : o === 'DRAW' ? 'X' : '2'}<b>${multTxt(m.mult[o])}</b></button>`).join('')}</div>`}
      </div>`).join('')}
    </section>` : ''}
    ${dg && dg.id ? `<section class="card dgame" data-play="${dg.id}" role="button" tabindex="0">
      <div class="cardhead"><span class="kick gold">🔥 DAILY GAME</span><span class="chip">🎟️ ${dg.tickets.left}/${dg.tickets.perDay}</span></div>
      <div class="dg-name">${dg.icon} ${esc(dg.name.toUpperCase())}</div>
      <div class="dg-grid">
        <div><span class="k">BEST SCORE</span><b>${dg.globalBest ? (dg.lowWins ? dg.globalBest.m + 'ms' : fmt(dg.globalBest.m) + ' C') : '–'}</b></div>
        <div><span class="k">YOUR SCORE</span><b>${dg.best != null ? (dg.lowWins ? dg.best + 'ms' : fmt(dg.best) + ' C') : '–'}</b></div>
        <div><span class="k">TOP PLAYER</span><b>${dg.globalBest ? '@' + esc(dg.globalBest.name) : '–'}</b></div>
      </div>
      <button class="cta gold" data-play="${dg.id}">PLAY NOW</button>
    </section>` : ''}
    <section class="card">
      <div class="cardhead"><h2>Your stats</h2><button class="linkbtn" data-go="/profile">Profile →</button></div>
      <div class="stats four">
        <div class="stat"><div class="n teal">${st.skill}</div><div class="k">Skill</div></div>
        <div class="stat"><div class="n">#${st.rank || '–'}</div><div class="k">Rank</div></div>
        <div class="stat"><div class="n">${st.accuracy != null ? st.accuracy + '%' : '–'}</div><div class="k">Accuracy</div></div>
        <div class="stat"><div class="n gold">${st.winStreak}</div><div class="k">Win streak</div></div>
      </div>
    </section>
    <section class="card">
      <div class="cardhead"><h2>Weekly leaderboard</h2><span class="chip">WEEK ${wk.season.week} · ${wk.season.daysLeft} ${wk.season.daysLeft === 1 ? 'DAY' : 'DAYS'} LEFT</span></div>
      ${wk.top.length ? wk.top.map((r) => lbRow(r, true)).join('') : '<p class="sub" style="margin:8px 0 0">Nobody has moved this week yet. Make a pick and take #1.</p>'}
      ${wk.me.rank && wk.me.rank > 3 ? `<div class="lb-row me"><span class="lb-r">#${wk.me.rank}</span><span class="lb-n">YOU</span><span class="lb-v">${signedC(wk.me.net)}</span></div>` : ''}
      <button class="ghost" data-go="/rank">See the full ranking →</button>
    </section>
    <button class="cta commit big" id="challengeFriend">⚔️ CHALLENGE A FRIEND</button>
    <p class="sub" style="text-align:center;margin:8px 0 18px">Pick a match, set the Credits, send the link. Prove who knows more.</p>
    <section class="card founding">
      <div class="kick gold">FOUNDING MEMBERS</div>
      <div class="fm-n"><b>${fmt(h.founding.count)}</b> / ${fmt(h.founding.cap)}</div>
      <div class="fm-bar"><i style="width:${Math.max(1, Math.min(100, (h.founding.count / h.founding.cap) * 100))}%"></i></div>
      <p class="sub" style="margin:8px 0 0">${h.founding.mine ? `<span>You're Founding Member</span> <b style="color:var(--gold)">#${h.founding.mine}</b>. <span>The badge is yours for good.</span>` : '<span>JOIN THE FIRST 20,000 CLASHLY PLAYERS.</span>'}</p>
    </section>`;

  // wiring
  const cd = $('#claimDaily');
  if (cd) cd.addEventListener('click', async () => {
    cd.disabled = true;
    try {
      const r = await api('/credits/daily', { method: 'POST' });
      animateCredits(r.wallet.credits, r.amount);
      WALLET = r.wallet;
      cd.outerHTML = `<div class="daily done"><span class="d-ic">✅</span><span class="d-t"><b>${r.day}/7</b> <span>claimed</span> · +${fmt(r.amount)} C${r.ticket ? ' · +1 🎟️' : ''}</span></div>`;
      if (!reduceMotion()) confetti(0.6);
    } catch (e) { toast(e.message); cd.disabled = false; }
  });
  app.querySelectorAll('.tc .opt').forEach((b) => b.addEventListener('click', () => openPredictSheet(tc.id, b.dataset.o)));
  const tp = $('#tcPick'); if (tp) tp.addEventListener('click', () => openPredictSheet(tc.id));
  app.querySelectorAll('.trend').forEach((row) => row.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-o]');
    openPredictSheet(row.dataset.mid, b ? b.dataset.o : null);
  }));
  const am = $('#allMatches'); if (am) am.addEventListener('click', openAllMatches);
  app.querySelectorAll('[data-play]').forEach((el) => el.addEventListener('click', (e) => { e.stopPropagation(); go('/play/' + el.dataset.play); }));
  app.querySelectorAll('[data-go]').forEach((el) => el.addEventListener('click', () => go(el.dataset.go)));
  $('#challengeFriend').addEventListener('click', () => { PREFILL = null; renderCreate(); });

  // balance: welcome count-up, or the change since we last looked
  const mirror = app.querySelector('[data-balmirror]');
  if (opts.welcome) {
    setTimeout(() => { animateCredits(w.credits, w.credits, { from: 0 }); if (!reduceMotion()) confetti(1.4); }, 350);
  } else if (prevBal != null && prevBal !== w.credits && mirror) {
    mirror.textContent = fmt(prevBal);
    animateCredits(w.credits, w.credits - prevBal, { from: prevBal });
  }
  if (h.fresh.length) revealFresh(h.fresh);
}

function lbRow(r, compact) {
  return `<div class="lb-row ${r.me ? 'me' : ''}"><span class="lb-r">${r.rank === 1 ? '👑' : '#' + r.rank}</span><span class="lb-n">${esc(r.name)}${r.me ? ' <span class="tag-rival">you</span>' : ''}${r.founding && !compact ? ' <span class="fm-dot" title="Founding Member">◆</span>' : ''}</span><span class="lb-v">${r.wins != null ? signedC(r.value) : fmt(r.value) + ' C'}</span></div>`;
}

// results that landed since the player last looked: one card each, with the swing
function revealFresh(list) {
  const box = $('#freshBox'); if (!box) return;
  box.innerHTML = list.map((k) => `<section class="card fresh ${k.status}">
    <div class="fr-top"><span class="kick">${k.status === 'won' ? 'FULL TIME · YOU CALLED IT' : k.status === 'lost' ? 'FULL TIME' : 'CALLED OFF'}</span><span class="sm">${esc(k.home)} v ${esc(k.away)}</span></div>
    <div class="fr-big">${k.status === 'won' ? 'CORRECT' : k.status === 'lost' ? 'WRONG' : 'VOID'}</div>
    <div class="fr-n">${k.status === 'won' ? '+' + fmt(k.payout) + ' C' : k.status === 'lost' ? '−' + fmt(k.amount) + ' C' : '+' + fmt(k.amount) + ' C refunded'}</div>
    <div class="sm" style="color:var(--muted)">${esc(outLbl(k, k.outcome))} · ${multTxt(k.mult)}${k.status === 'lost' ? ' · <span>Go again. Nothing else to lose.</span>' : ''}</div>
    ${k.status === 'won' ? `<button class="ghost" data-brag="pick">Share it 📲</button>` : ''}
  </section>`).join('');
  const won = list.filter((k) => k.status === 'won');
  if (won.length) { setTimeout(() => { if (!reduceMotion()) confetti(1); sfx('cheer'); haptic([14, 50, 22]); }, 300); }
  box.querySelectorAll('[data-brag]').forEach((b) => b.addEventListener('click', () => shareBrag(b.dataset.brag, 'Called it on Clashly. BACK YOURSELF.')));
  api('/picks/seen', { method: 'POST', body: JSON.stringify({ ids: list.map((k) => k.id) }) }).catch(() => {});
}

async function openAllMatches() {
  let r; try { r = await api('/predict'); } catch (e) { return toast(e.message); }
  openSheet(`
    <div class="sheet-handle"></div>
    <div class="sheet-head"><h2>Make a prediction</h2><button class="sheet-x" id="sheetClose" aria-label="Close">✕</button></div>
    <div class="sheet-body">
      ${r.matches.length ? r.matches.map((m) => `<div class="trend" data-mid="${esc(m.id)}" role="button" tabindex="0">
        <div class="tr-l"><div class="nm">${esc(m.home)} <span class="v">v</span> ${esc(m.away)}</div><div class="sm">${esc(m.competition)} · ${kickoffTxt(m.utcDate)}</div></div>
        ${m.myPick ? `<span class="tr-mine">✓ ${esc(outLbl(m, m.myPick.outcome))}</span>` : `<div class="tr-x">${['HOME', 'DRAW', 'AWAY'].map((o) => `<button data-o="${o}">${o === 'HOME' ? '1' : o === 'DRAW' ? 'X' : '2'}<b>${multTxt(m.mult[o])}</b></button>`).join('')}</div>`}
      </div>`).join('') : '<p class="sub">No fixtures on the board right now.</p>'}
    </div>`);
  $('#sheetClose').addEventListener('click', closeSheet);
  document.querySelectorAll('#sheetPanel .trend').forEach((row) => row.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-o]');
    openPredictSheet(row.dataset.mid, b ? b.dataset.o : null);
  }));
}

// ---------------------------------------------------------------------------
// The prediction sheet
// ---------------------------------------------------------------------------
async function openPredictSheet(matchId, preset) {
  let r;
  try { r = await api('/predict/' + encodeURIComponent(matchId)); } catch (e) { return toast(e.message); }
  const m = r.match;
  if (m.myPick) { toast('Already picked. Locked in.'); return; }
  if (m.locked) { toast('Kicked off. Picks are closed.'); return; }
  const state = { o: preset || null, amt: Math.min(1000, Math.max(r.min, Math.floor((r.credits || 0) / 100) * 100)) };
  const CHIPS = [100, 500, 1000, 2500, 5000];
  openSheet(`
    <div class="sheet-handle"></div>
    <div class="sheet-head"><h2>${esc(m.home)} vs ${esc(m.away)}</h2><button class="sheet-x" id="sheetClose" aria-label="Close">✕</button></div>
    <div class="sheet-body" id="pkBody">
      <p class="sub" style="margin:0 0 10px">${esc(m.competition)} · ${kickoffTxt(m.utcDate)}</p>
      <div class="pk-bal"><span>Your Credits</span><b>${fmt(r.credits)} C</b></div>
      <label>Choose your prediction</label>
      <div class="opts big" id="pkOpts">${['HOME', 'DRAW', 'AWAY'].map((o) => `
        <button class="opt" data-o="${o}"><span class="o-l">${esc(outLbl(m, o).toUpperCase())}</span><span class="o-x">${multTxt(m.mult[o])}</span><span class="o-r">${esc(m.risk[o])}</span></button>`).join('')}</div>
      <label>Amount</label>
      <div class="amt-row"><button class="amt-step" data-step="-100" aria-label="Less">−</button><div class="amt-val"><span id="pkAmt">${fmt(state.amt)}</span> C</div><button class="amt-step" data-step="100" aria-label="More">+</button></div>
      <div class="chips">${CHIPS.map((c) => `<button class="react-chip" data-amt="${c}">${fmt(c)}</button>`).join('')}<button class="react-chip" data-amt="max">MAX</button></div>
      <div class="pk-sum">
        <div><span class="k">RISK</span><b id="pkRisk">${fmt(state.amt)} C</b></div>
        <div><span class="k">POTENTIAL WIN</span><b id="pkWin" class="teal">–</b></div>
      </div>
      <p class="sub" style="margin:10px 0 0;font-size:11.5px"><span>Virtual Credits only. No cash value. The multiplier comes from the league table and how Clashly players are calling it.</span></p>
    </div>
    <div class="sheet-foot"><button class="cta" id="pkGo" disabled>MAKE YOUR PICK</button></div>`);
  $('#sheetClose').addEventListener('click', closeSheet);
  const max = Math.min(r.max, r.credits);
  const sync = () => {
    state.amt = Math.max(r.min, Math.min(max, state.amt));
    $('#pkAmt').textContent = fmt(state.amt);
    $('#pkRisk').textContent = fmt(state.amt) + ' C';
    $('#pkWin').textContent = state.o ? '+' + fmt(Math.round(state.amt * m.mult[state.o])) + ' C' : '–';
    document.querySelectorAll('#pkOpts .opt').forEach((b) => b.classList.toggle('on', b.dataset.o === state.o));
    const go = $('#pkGo'); go.disabled = !state.o || r.credits < r.min;
    go.textContent = r.credits < r.min ? 'NOT ENOUGH CREDITS' : 'MAKE YOUR PICK';
  };
  document.querySelectorAll('#pkOpts .opt').forEach((b) => b.addEventListener('click', () => { state.o = b.dataset.o; haptic(8); sfx('tick'); sync(); }));
  document.querySelectorAll('#sheetPanel [data-step]').forEach((b) => b.addEventListener('click', () => { state.amt += Number(b.dataset.step); haptic(6); sync(); }));
  document.querySelectorAll('#sheetPanel [data-amt]').forEach((b) => b.addEventListener('click', () => { state.amt = b.dataset.amt === 'max' ? max : Number(b.dataset.amt); haptic(6); sync(); }));
  sync();
  $('#pkGo').addEventListener('click', async () => {
    const btn = $('#pkGo'); btn.disabled = true; btn.textContent = 'Locking in…';
    try {
      const out = await api('/picks', { method: 'POST', body: JSON.stringify({ matchId: m.id, outcome: state.o, amount: state.amt }) });
      track('pick_made', { mult: out.pick.mult });
      sfx('sig'); haptic([10, 40, 16]);
      animateCredits(out.credits, -out.pick.amount);
      $('#pkBody').innerHTML = `<div class="sealwrap"><div class="seal">🔒</div></div>
        <h2 style="text-align:center">YOUR PICK IS LOCKED.</h2>
        <div class="pk-sum" style="margin-top:14px"><div><span class="k">${esc(outLbl(m, out.pick.outcome).toUpperCase())}</span><b>${multTxt(out.pick.mult)}</b></div><div><span class="k">IF RIGHT</span><b class="teal">+${fmt(out.pick.potential)} C</b></div></div>
        ${out.streak ? `<div class="banner" style="margin-top:12px;border-style:solid;border-color:rgba(255,140,66,.5);color:var(--text)">🔥 ${out.streak.streak} <span>day streak</span> · +${fmt(out.streak.bonus)} C</div>` : ''}
        <p class="sub" style="text-align:center;margin:12px 0 0">Settles automatically at full time.</p>`;
      if (out.streak) setTimeout(() => animateCredits(out.credits + 0, out.streak.bonus, { from: out.credits - out.streak.bonus }), 900);
      const foot = document.querySelector('#sheetPanel .sheet-foot');
      foot.innerHTML = `<button class="cta" id="pkDone">Done</button><button class="ghost" id="pkDare">⚔️ Dare a mate to take the other side</button>`;
      $('#pkDone').addEventListener('click', () => { closeSheet(); if (location.pathname === '/') renderHub(); });
      $('#pkDare').addEventListener('click', () => { closeSheet(); PREFILL = { matchId: m.id, backed: out.pick.outcome }; renderCreate(); });
    } catch (e) { toast(e.message); btn.disabled = false; btn.textContent = 'MAKE YOUR PICK'; }
  });
}

// ---------------------------------------------------------------------------
// RANK
// ---------------------------------------------------------------------------
let RANK_SCOPE = 'global';
async function renderRank() {
  const my = ++_gen; const live = () => my === _gen;
  let r, lg;
  try { [r, lg] = await Promise.all([api('/rank?scope=' + RANK_SCOPE), api('/players/me/leagues').catch(() => ({ leagues: [] }))]); }
  catch (e) { if (!live()) return; app.innerHTML = `<div class="card"><h2>Can't load the ranking</h2><button class="cta" id="retry">Try again</button></div>`; $('#retry').addEventListener('click', renderRank); return; }
  if (!live()) return;
  const s = r.season, ss = r.seasonStats;
  const weekly = r.scope === 'weekly';
  const shown = r.rows.slice(0, 50);
  const meVisible = shown.some((x) => x.me);
  app.innerHTML = `
    <section class="card season">
      <div class="cardhead"><span class="kick teal">WEEK ${s.week}</span><span class="chip">${s.daysLeft} ${s.daysLeft === 1 ? 'DAY' : 'DAYS'} LEFT</span></div>
      <p class="sub" style="margin:4px 0 12px">Weekly rankings reset every Monday. Every week is a new season.</p>
      <div class="stats four">
        <div class="stat"><div class="n">${ss.currentRank ? '#' + ss.currentRank : '–'}</div><div class="k">Current rank</div></div>
        <div class="stat"><div class="n gold">${ss.bestRank ? '#' + ss.bestRank : '–'}</div><div class="k">Best rank</div></div>
        <div class="stat"><div class="n">${ss.weeklyWins}</div><div class="k">Weekly wins</div></div>
        <div class="stat"><div class="n ${ss.weeklyEarnings > 0 ? 'pos' : ss.weeklyEarnings < 0 ? 'neg' : ''}">${ss.weeklyEarnings ? signedC(ss.weeklyEarnings).replace(' C', '') : '0'}</div><div class="k">Weekly earnings</div></div>
      </div>
    </section>
    <div class="seg3" role="tablist">${['global', 'weekly', 'friends'].map((sc) => `<button role="tab" data-scope="${sc}" class="${r.scope === sc ? 'on' : ''}">${sc.toUpperCase()}</button>`).join('')}</div>
    <section class="card lb">
      ${shown.length ? shown.map((x) => lbRow(weekly ? x : { ...x, wins: null })).join('') : `<p class="sub" style="margin:4px 0">${weekly ? 'Nobody has moved this week yet. First pick takes the lead.' : r.scope === 'friends' ? 'Your friends appear here once you Clash with them or share a league.' : 'Nobody here yet.'}</p>`}
    </section>
    ${r.me && !meVisible ? `<div class="lb-row me sticky"><span class="lb-r">#${r.me.rank}</span><span class="lb-n">YOU</span><span class="lb-v">${fmt(r.me.value)} C</span></div>` : ''}
    ${r.me ? `<section class="card you-card"><div class="kick">YOU</div><div class="you-n">#${fmt(r.me.rank)}</div><div class="sm">${weekly ? (r.me.value >= 0 ? '+' : '') + fmt(r.me.value) + ' C this week' : fmt(r.me.value) + ' C'} · of ${fmt(r.total)}</div>
      <button class="ghost" id="shareRank">Share my rank 📲</button></section>` : ''}
    ${r.history.length ? `<section class="card"><h2>Past weeks</h2>${r.history.map((h) => `<div class="recent"><span>Week ${h.week}</span><span class="res">#${h.rank} of ${h.of} · ${h.net >= 0 ? '+' : ''}${fmt(h.net)} C</span></div>`).join('')}</section>` : ''}
    <section class="card">
      <div class="cardhead"><h2>My leagues</h2><button class="linkbtn" id="newLeague">+ New / join</button></div>
      ${lg.leagues.length ? lg.leagues.map((l) => `<div class="riv-row" data-league="${esc(l.code)}" role="button" tabindex="0" style="cursor:pointer"><div><div class="nm">${esc(l.name)}</div><div class="sm">${l.members} mates · ${l.rank ? "you're #" + l.rank + ' of ' + l.total : 'unranked'}</div></div><div class="rec">#${l.rank || '–'}</div></div>`).join('') : '<p class="sub" style="margin:8px 0 0">One table for your whole group chat.</p>'}
    </section>`;
  app.querySelectorAll('[data-scope]').forEach((b) => b.addEventListener('click', () => { RANK_SCOPE = b.dataset.scope; haptic(6); renderRank(); }));
  const sr = $('#shareRank'); if (sr) sr.addEventListener('click', () => shareBrag(r.scope === 'global' ? 'rank' : 'beat', `I'm #${r.me.rank} on Clashly. Think you know sports? Prove it.`));
  const nl = $('#newLeague'); if (nl) nl.addEventListener('click', () => renderLeagueHub());
  app.querySelectorAll('[data-league]').forEach((b) => b.addEventListener('click', () => { history.pushState({}, '', '/l/' + b.dataset.league); renderLeague(b.dataset.league); }));
}

// ---------------------------------------------------------------------------
// CLASH: challenge a friend, what's waiting on you, public Clashes, history
// ---------------------------------------------------------------------------
async function renderClash() {
  const my = ++_gen; const live = () => my === _gen;
  const m = me.get();
  const [bRes, aRes, tRes] = await Promise.allSettled([api('/players/me/bets'), api('/arena'), api('/terrace')]);
  if (!live()) return;
  const d = bRes.status === 'fulfilled' ? bRes.value : { active: [], history: [] };
  const arena = aRes.status === 'fulfilled' ? (aRes.value.challenges || []) : [];
  const terrace = tRes.status === 'fulfilled' ? (tRes.value.posts || []) : [];
  const yourMove = d.active.filter((b) => b.yourMove || b.offers > 0);
  const waiting = d.active.filter((b) => b.status === 'open' && !b.offers);
  const liveOnes = d.active.filter((b) => b.status === 'accepted' && !b.yourMove);
  const publicOpen = arena.filter((c) => !m || c.proposerId !== m.id);
  const stakeTxt = (b) => (b.credits ? fmt(b.credits) + ' C' : '') + (b.credits && (b.line || b.stake) ? ' · ' : '') + (b.line ? esc(b.line) : b.stake > 0 ? sym(b.currency) + b.stake : (!b.credits ? 'bragging rights' : ''));
  const row = (b, action) => `<div class="riv-row" data-bet="${esc(b.id)}" role="button" tabindex="0" style="cursor:pointer">
    <div><div class="nm">${esc(matchLabel(b))}</div><div class="sm">${b.opponent ? 'vs ' + esc(b.opponent) + ' · ' : ''}${stakeTxt(b)}</div></div>
    <span class="act">${action}</span></div>`;
  app.innerHTML = `
    <section class="card clash-hero">
      <div class="kick">⚔️ CLASH</div>
      <h2 class="ch-h">PROVE WHO KNOWS MORE.</h2>
      <p class="sub" style="margin:4px 0 0">Pick a match, back your call, put Credits on it. Your mate takes the other side. Winner takes the pool.</p>
      <button class="cta commit big" id="chFriend">⚔️ CHALLENGE A FRIEND</button>
      <button class="ghost" id="chPublic">🌍 Post a public Clash</button>
    </section>
    ${yourMove.length ? `<section class="card hot"><div class="cardhead"><h2>Your move</h2><span class="badge">${yourMove.length}</span></div>
      ${yourMove.map((b) => row(b, b.offers ? `💬 ${b.offers} offer${b.offers === 1 ? '' : 's'}` : b.pending ? 'Confirm ✓' : 'Report →')).join('')}</section>` : ''}
    ${liveOnes.length ? `<section class="card"><div class="cardhead"><h2>Live Clashes</h2></div>${liveOnes.map((b) => row(b, kickoffTxt(b.utcDate) || 'Live')).join('')}</section>` : ''}
    ${waiting.length ? `<section class="card"><div class="cardhead"><h2>Waiting for a taker</h2></div>${waiting.map((b) => row(b, 'Send link →')).join('')}</section>` : ''}
    <section class="card"><div class="cardhead"><h2>Public Clashes</h2><span class="pill open">${publicOpen.length}</span></div>
      <p class="sub" style="margin:2px 0 0">Open challenges from anyone on Clashly. Take one, win it.</p>
      ${publicOpen.length ? `<div class="market">${publicOpen.slice(0, 12).map(arenaItemCard).join('')}</div>` : '<p class="sub" style="margin:10px 0 0">No public Clashes right now. Post the first one.</p>'}
    </section>
    ${d.history.length ? `<section class="card"><div class="cardhead"><h2>History</h2><button class="linkbtn" id="shareClash">Share 📲</button></div>
      ${d.history.slice(0, 15).map((b) => `<div class="recent" data-bet="${esc(b.id)}" role="button" tabindex="0" style="cursor:pointer"><span>${esc(matchLabel(b))}${b.opponent ? ' · <span style="color:var(--muted)">' + esc(b.opponent) + '</span>' : ''}</span><span class="res ${b.won ? 'w' : 'l'}">${b.won ? 'W' : 'L'}${b.credits ? ' · ' + (b.won ? '+' + fmt(b.credits * 2) : '−' + fmt(b.credits)) + ' C' : ''}</span></div>`).join('')}</section>` : ''}
    <section class="card terrace">
      <div class="cardhead"><h2>The Terrace 📣</h2><span class="pill open" style="font-size:10.5px">public</span></div>
      <p class="sub" style="margin:2px 0 8px">Say it to all of Clashly. No opponent, no Credits, just a take on the record.</p>
      <div style="display:flex;gap:8px;align-items:center;margin-bottom:6px"><input id="terrIn" maxlength="180" placeholder="Announce it to all of Clashly…" style="flex:1" /><button class="linkbtn" id="terrGo" style="font-weight:800;flex:none">Announce →</button></div>
      ${terrace.slice(0, 6).map((t) => `<div class="recent" style="align-items:flex-start"><span style="min-width:0"><b style="color:var(--text)">${esc(t.by)}</b> <span style="color:var(--muted-2);font-size:11.5px">${t.bot ? 'house bot 🤖' : esc(t.record)} · ${timeAgo(t.t)}</span><br/>${esc(t.text)}</span></div>`).join('') || '<p class="sub" style="margin:6px 0 0">Silence on the terrace. Say something spicy.</p>'}
    </section>`;
  $('#chFriend').addEventListener('click', () => { PREFILL = null; renderCreate(); });
  $('#chPublic').addEventListener('click', () => { PREFILL = { arena: true }; renderCreate(); });
  app.querySelectorAll('[data-bet]').forEach((el) => el.addEventListener('click', () => { history.pushState({}, '', '/b/' + el.dataset.bet); renderBet(el.dataset.bet); }));
  app.querySelectorAll('[data-arena]').forEach((el) => el.addEventListener('click', () => { track('arena_tap', { bet: el.dataset.arena }); history.pushState({}, '', '/b/' + el.dataset.arena); renderBet(el.dataset.arena); }));
  const sc = $('#shareClash'); if (sc) sc.addEventListener('click', () => shareBrag('clash', 'I won my Clash on Clashly. Think you can beat me?'));
  const tGo = $('#terrGo'), tIn = $('#terrIn');
  const post = async () => { const v = tIn.value.trim(); if (v.length < 2) return toast('Say something worth saying'); tGo.disabled = true;
    try { await api('/terrace', { method: 'POST', body: JSON.stringify({ text: v }) }); track('terrace_post'); haptic(10); sfx('pop'); renderClash(); }
    catch (e) { toast(e.message); tGo.disabled = false; } };
  tGo.addEventListener('click', post);
  tIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); post(); } });
}

// tab-bar badge: Clashes waiting on you
function paintClashBadge(n) {
  const t = document.querySelector('.tab[data-tab="clash"]'); if (!t) return;
  let b = t.querySelector('.tbadge');
  if (!n) { if (b) b.remove(); return; }
  if (!b) { b = document.createElement('span'); b.className = 'tbadge'; t.appendChild(b); }
  b.textContent = n > 9 ? '9+' : String(n);
}
async function refreshClashBadge() {
  if (!me.get()) return paintClashBadge(0);
  try { const d = await api('/players/me/bets'); paintClashBadge(d.active.filter((b) => b.yourMove || b.offers > 0).length); } catch {}
}

// ---------------------------------------------------------------------------
// PROFILE: the player card
// ---------------------------------------------------------------------------
let PROFILE_TAB = 'picks';
async function renderProfileCard() {
  const my = ++_gen; const live = () => my === _gen;
  let m = me.get();
  if (m && m.seq == null) { try { const p = await api('/players/me'); me.save(p); m = p; } catch {} }
  let c;
  try { c = await api('/card'); } catch (e) { if (!live()) return; app.innerHTML = `<div class="card"><h2>Can't load your card</h2><button class="cta" id="retry">Try again</button></div>`; $('#retry').addEventListener('click', renderProfileCard); return; }
  if (!live()) return;
  const lang = (window.CLASHLY_I18N && window.CLASHLY_I18N.lang()) || 'en';
  const hideStreaks = prefs.get().hideStreaks;
  const tile = (k, v, cls) => `<div class="pc-t"><div class="pc-v ${cls || ''}">${v}</div><div class="pc-k">${k}</div></div>`;
  const hist = PROFILE_TAB === 'picks'
    ? (c.picks.length ? c.picks.map((k) => `<div class="recent"><span>${esc(k.home)} v ${esc(k.away)}<br><span class="sm" style="color:var(--muted-2)">${esc(outLbl(k, k.outcome))} · ${multTxt(k.mult)} · ${fmt(k.amount)} C</span></span><span class="res ${k.status === 'won' ? 'w' : k.status === 'lost' ? 'l' : ''}">${k.status === 'won' ? '+' + fmt(k.payout) : k.status === 'lost' ? '−' + fmt(k.amount) : k.status === 'void' ? 'void' : 'live'}</span></div>`).join('') : '<p class="sub">No predictions yet. Today\'s Clash is on Home.</p>')
    : PROFILE_TAB === 'clashes'
      ? (c.clashHistory.length ? c.clashHistory.map((b) => `<div class="recent" data-bet="${esc(b.id)}" role="button" tabindex="0" style="cursor:pointer"><span>${esc(b.home)}${b.away ? ' v ' + esc(b.away) : ''}<br><span class="sm" style="color:var(--muted-2)">${b.opponent ? 'vs ' + esc(b.opponent) : 'waiting for a taker'}${b.credits ? ' · ' + fmt(b.credits) + ' C' : ''}</span></span><span class="res ${b.won === true ? 'w' : b.won === false ? 'l' : ''}">${b.won === true ? 'W' : b.won === false ? 'L' : b.status}</span></div>`).join('') : '<p class="sub">No Clashes yet.</p>')
      : c.games.map((g) => `<div class="recent"><span>${g.icon} ${esc(g.name)}</span><span class="res">${g.best != null ? (g.lowWins ? g.best + 'ms' : fmt(g.best) + ' C') : '–'} <span class="sm" style="color:var(--muted-2)">· ${g.plays} ${g.plays === 1 ? 'play' : 'plays'}</span></span></div>`).join('');
  app.innerHTML = `
    <section class="pcard">
      <div class="pc-head"><div class="pc-av">${esc(initials(c.name))}</div><div><div class="pc-name">${esc(c.name.toUpperCase())}</div>
        ${c.seq && c.seq <= 20000 ? `<div class="pc-fm">◆ FOUNDING MEMBER #${c.seq}</div>` : ''}</div>
        <button class="linkbtn" id="rename" style="margin-left:auto">Edit</button></div>
      <div class="pc-bal"><span data-balmirror>${fmt(c.credits)}</span><span class="c">C</span></div>
      <div class="pc-grid">
        ${tile('SKILL', c.skill, 'teal')}
        ${tile('GLOBAL RANK', c.globalRank ? '#' + fmt(c.globalRank) : '–')}
        ${tile('ACCURACY', c.accuracy != null ? c.accuracy + '%' : '–')}
        ${tile('WIN STREAK', hideStreaks ? '–' : c.winStreak, 'gold')}
        ${tile('CLASHES', c.clashes)}
        ${tile('BEST RANK', c.bestRank ? '#' + c.bestRank : '–')}
      </div>
      <div class="pc-foot"><span>🔥 ${c.streak.days} <span>day streak</span></span><span class="brandline">BACK YOURSELF.</span></div>
    </section>
    <div class="row" style="margin:0 0 14px"><button class="ghost" id="shareCard" style="margin:0">Share my card 📲</button><button class="ghost" id="shareStreak" style="margin:0">Share streak 🔥</button></div>
    <section class="card"><div class="cardhead"><h2>Badges</h2><span class="sm" style="color:var(--muted)">${c.badges.filter((b) => b.on).length}/${c.badges.length}</span></div>
      <div class="badges">${c.badges.map((b) => `<div class="bdg ${b.on ? 'on' : ''}" title="${esc(b.desc)}"><div class="bdg-i">${b.on ? '★' : '☆'}</div><div class="bdg-n">${esc(b.name)}</div><div class="bdg-d">${esc(b.desc)}</div></div>`).join('')}</div>
    </section>
    <section class="card"><h2>History</h2>
      <div class="seg3 small">${[['picks', 'PREDICTIONS'], ['clashes', 'CLASHES'], ['games', 'MINI-GAMES']].map(([k, l]) => `<button data-ptab="${k}" class="${PROFILE_TAB === k ? 'on' : ''}">${l}</button>`).join('')}</div>
      <div style="margin-top:8px">${hist}</div>
    </section>
    ${m && m.email
      ? `<section class="card"><div class="cardhead"><h2>Account</h2><button class="linkbtn" id="signout">Sign out</button></div><p class="sub" style="margin:0">Signed in as <b style="color:var(--text)">${esc(m.email)}</b>${m.verified ? ' ✓' : ''}.</p></section>`
      : `<section class="card"><div class="cardhead"><h2>Account</h2></div><p class="sub" style="margin:0 0 10px">You're playing as a guest on this device. Save your Credits and record across devices.</p><button class="cta" id="signin">Sign in / create account</button></section>`}
    <section class="card"><div class="cardhead"><h2>Settings</h2></div>
      <div class="checkrow" style="margin-top:6px"><input type="checkbox" id="langPl" ${lang === 'pl' ? 'checked' : ''} /><label for="langPl">🇵🇱 Polski interfejs (Polish interface)</label></div>
      <div class="checkrow" style="margin-top:10px"><input type="checkbox" id="hideStreaks" ${hideStreaks ? 'checked' : ''} /><label for="hideStreaks">Hide streaks — no flame, no pressure</label></div>
      <div class="checkrow" style="margin-top:10px"><input type="checkbox" id="sndFx" ${(window.SFX && window.SFX.on()) ? 'checked' : ''} /><label for="sndFx">🔊 Sound effects</label></div>
      <div class="checkrow" style="margin-top:10px"><input type="checkbox" id="pushChk" ${typeof Notification !== 'undefined' && Notification.permission === 'granted' ? 'checked' : ''} /><label for="pushChk">🔔 Notifications (results, Clashes)</label></div>
    </section>
    <p class="sub" style="text-align:center;margin:6px 0 0;font-size:11.5px"><span>Clashly Credits are virtual and have no cash value. No deposits, no withdrawals. 18+</span></p>`;
  $('#rename').addEventListener('click', () => openRenameSheet(c.name));
  app.querySelectorAll('[data-ptab]').forEach((b) => b.addEventListener('click', () => { PROFILE_TAB = b.dataset.ptab; renderProfileCard(); }));
  app.querySelectorAll('[data-bet]').forEach((el) => el.addEventListener('click', () => { history.pushState({}, '', '/b/' + el.dataset.bet); renderBet(el.dataset.bet); }));
  $('#shareCard').addEventListener('click', () => shareBrag('beat', `Skill ${c.skill} on Clashly. Think you know sports better? Prove it.`));
  $('#shareStreak').addEventListener('click', () => shareBrag('streak', `${c.streak.days} day streak on Clashly. BACK YOURSELF.`));
  const lp = $('#langPl'); if (lp) lp.addEventListener('change', () => { if (window.CLASHLY_I18N) window.CLASHLY_I18N.toggle(); });
  const so = $('#signout'); if (so) so.addEventListener('click', () => { me.clear(); WALLET = null; localStorage.removeItem('settle_roles'); try { posthog.reset(); } catch {} renderHeader(); history.pushState({}, '', '/'); route(); });
  const si = $('#signin'); if (si) si.addEventListener('click', () => openLoginSheet(renderProfileCard));
  const hs = $('#hideStreaks'); if (hs) hs.addEventListener('change', () => { prefs.set('hideStreaks', hs.checked); renderProfileCard(); });
  const sx = $('#sndFx'); if (sx) sx.addEventListener('change', () => { if (window.SFX) window.SFX.toggle(); sfx('pop'); });
  const pc = $('#pushChk'); if (pc) pc.addEventListener('change', async () => { if (pc.checked) { const ok = await enablePush(); if (!ok) { pc.checked = false; toast('Blocked by the browser — allow notifications in site settings'); } else toast('Notifications on 🔔'); } else { toast('Turn off in your browser site settings'); pc.checked = true; } });
}

// ---------------------------------------------------------------------------
// Share: every major result gets a card. Image-first for Stories, link-first
// for chats (the link unfurls on WhatsApp, Messenger, Discord, X).
// ---------------------------------------------------------------------------
function shareBrag(kind, text) {
  const m = me.get(); if (!m) return;
  openShareSheet({ title: 'Share it', text, link: location.origin + '/', img: `/brag/${m.id}/${kind}.png` });
}
function openShareSheet({ title, text, link, img }) {
  track('share_open', {});
  const enc = encodeURIComponent;
  const mobile = /Android|iPhone|iPad/i.test(navigator.userAgent);
  openSheet(`
    <div class="sheet-handle"></div>
    <div class="sheet-head"><h2>${esc(title || 'Share')}</h2><button class="sheet-x" id="sheetClose" aria-label="Close">✕</button></div>
    <div class="sheet-body">
      ${img ? `<img class="brag-img" src="${esc(img)}" alt="Your Clashly card" />` : ''}
      <div class="share-grid">
        <button data-sh="wa"><span>🟢</span>WhatsApp</button>
        <button data-sh="ig"><span>📸</span>Instagram</button>
        <button data-sh="ms"><span>💬</span>Messenger</button>
        <button data-sh="dc"><span>🎮</span>Discord</button>
        <button data-sh="x"><span>✖️</span>X</button>
        <button data-sh="cp"><span>🔗</span>Copy link</button>
      </div>
      ${navigator.share ? '<button class="ghost" data-sh="more">More apps…</button>' : ''}
    </div>`);
  $('#sheetClose').addEventListener('click', closeSheet);
  const copy = async (msg) => { try { await navigator.clipboard.writeText(text + ' ' + link); sfx('clip'); toast(msg || 'Copied'); } catch { toast(link); } };
  document.querySelectorAll('#sheetPanel [data-sh]').forEach((b) => b.addEventListener('click', async () => {
    const k = b.dataset.sh; track('share', { kind: k });
    if (k === 'wa') window.open('https://wa.me/?text=' + enc(text + ' ' + link), '_blank', 'noopener');
    else if (k === 'x') window.open('https://twitter.com/intent/tweet?text=' + enc(text) + '&url=' + enc(link), '_blank', 'noopener');
    else if (k === 'ms') { if (mobile) location.href = 'fb-messenger://share/?link=' + enc(link); else copy('Copied. Paste it in Messenger'); }
    else if (k === 'dc') copy('Copied. Paste it in Discord');
    else if (k === 'cp') copy('Link copied');
    else if (k === 'ig') { if (img) shareImage(img, text, 'brag_story'); else copy('Copied'); }
    else if (k === 'more') { try { await navigator.share({ title: 'Clashly', text, url: link }); } catch {} }
  }));
}

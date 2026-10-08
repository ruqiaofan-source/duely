'use strict';
// ---------------------------------------------------------------------------
// PLAY: six short sports games. Each attempt costs one Play Ticket (5 a day).
// Scores are checked on the server; rewards are virtual Credits with a daily
// cap, so games add to a good week of predictions rather than replace it.
// ---------------------------------------------------------------------------

const GAME_ORDER = ['penalty', 'quiz', 'hilo', 'whoami', 'reaction', 'odds'];
const scoreTxt = (g, v) => (v == null ? '–' : g.lowWins ? v + 'ms' : fmt(v) + ' C');
const ticketsRow = (t) => `<span class="tix" aria-label="${t.left} Play Tickets left">${Array.from({ length: Math.max(t.perDay, t.left) }, (_, i) => `<i class="${i < t.left ? 'on' : ''}">🎟️</i>`).join('')}</span><b class="tix-n">${t.left}/${t.perDay}</b>`;

async function renderPlay() {
  const my = ++_gen; const live = () => my === _gen;
  let p;
  try { p = await api('/play'); } catch (e) { if (!live()) return; app.innerHTML = `<div class="card"><h2>Can't load PLAY</h2><button class="cta" id="retry">Try again</button></div>`; $('#retry').addEventListener('click', renderPlay); return; }
  if (!live()) return;
  const dg = p.games.find((g) => g.daily);
  const others = GAME_ORDER.map((id) => p.games.find((g) => g.id === id)).filter(Boolean);
  app.innerHTML = `
    <section class="card play-top">
      <div class="pt-row"><span class="kick">YOUR CREDITS</span><b><span data-balmirror>${fmt(p.credits)}</span> C</b></div>
      <div class="pt-row"><span class="kick">PLAY TICKETS</span>${ticketsRow(p.tickets)}</div>
      ${p.tickets.left === 0 ? `<div class="banner" style="margin-top:10px;border-style:solid"><b>YOU'VE USED TODAY'S PLAY TICKETS.</b><br><span>COME BACK TOMORROW.</span></div>` : ''}
      <div class="pt-cap"><span>Today from games:</span> <b>${fmt(p.play.earned)}</b> / ${fmt(p.play.cap)} C</div>
    </section>
    ${dg ? `<section class="card dgame" data-game="${dg.id}" role="button" tabindex="0">
      <div class="cardhead"><span class="kick gold">🔥 DAILY GAME</span><span class="chip">counts for your streak</span></div>
      <div class="dg-name">${dg.icon} ${esc(dg.name.toUpperCase())}</div>
      <p class="sub" style="margin:4px 0 10px">${esc(dg.desc)}</p>
      <div class="dg-grid"><div><span class="k">REWARD</span><b>Up to ${fmt(dg.max)} C</b></div><div><span class="k">YOUR BEST</span><b>${scoreTxt(dg, dg.best)}</b></div><div><span class="k">TOP TODAY</span><b>${dg.top[0] ? '@' + esc(dg.top[0].name) : '–'}</b></div></div>
      <button class="cta gold" data-game="${dg.id}">PLAY NOW</button>
    </section>` : ''}
    <h3 class="sect">SPORTS GAMES</h3>
    <div class="games">${others.map((g) => `
      <div class="gcard2" data-game="${g.id}" role="button" tabindex="0">
        <div class="g-ic">${g.icon}</div>
        <div class="g-main"><div class="g-t">${esc(g.name)}${g.daily ? ' <span class="chip gold">DAILY</span>' : ''}</div><div class="g-d">${esc(g.desc)}</div>
          <div class="g-m"><span>Up to <b>${fmt(g.max)} C</b></span><span>Best: <b>${scoreTxt(g, g.best)}</b></span></div></div>
        <button class="g-play" data-game="${g.id}">PLAY</button>
      </div>`).join('')}</div>
    <p class="sub" style="text-align:center;margin:14px 0 0;font-size:11.5px"><span>5 Play Tickets a day, never for sale. Up to 2,000 C a day from games. Predictions are where the big Credits are.</span></p>`;
  app.querySelectorAll('[data-game]').forEach((el) => el.addEventListener('click', (e) => { e.stopPropagation(); go('/play/' + el.dataset.game); }));
}

// ---- game intro: what it is, what it pays, who's top today ----
async function renderGameIntro(id) {
  const my = ++_gen; const live = () => my === _gen;
  let b, p;
  try { [b, p] = await Promise.all([api('/play/board/' + id), api('/play')]); }
  catch (e) { if (!live()) return; app.innerHTML = `<div class="card"><h2>Game not found</h2><button class="cta" id="back">Back to PLAY</button></div>`; $('#back').addEventListener('click', () => go('/play')); return; }
  if (!live()) return;
  const g = { ...b, lowWins: Boolean(b.lowWins) };
  app.innerHTML = `
    <div class="gbar"><button class="ob-back" id="gBack" aria-label="Back">←</button><span class="gb-t">${esc(g.name.toUpperCase())}</span>${ticketsRow(p.tickets)}</div>
    <section class="card gintro">
      <div class="gi-ic">${g.icon}</div>
      <h2 class="gi-t">${esc(g.name.toUpperCase())}</h2>
      <p class="sub" style="margin:4px 0 14px">${esc(g.desc)}</p>
      <div class="dg-grid">
        <div><span class="k">REWARD</span><b>Up to ${fmt(g.max)} C</b></div>
        <div><span class="k">YOUR BEST</span><b>${scoreTxt(g, g.best)}</b></div>
        <div><span class="k">GLOBAL BEST</span><b>${g.globalBest ? scoreTxt(g, g.globalBest.m) : '–'}</b></div>
      </div>
      ${rulesFor(id)}
      <button class="cta ${p.tickets.left ? '' : 'disabled'}" id="gPlay" ${p.tickets.left ? '' : 'disabled'}>${p.tickets.left ? 'PLAY · 🎟️ 1 TICKET' : "NO TICKETS LEFT TODAY"}</button>
      ${p.tickets.left ? '' : '<p class="sub" style="text-align:center;margin:8px 0 0"><span>COME BACK TOMORROW.</span></p>'}
    </section>
    <section class="card"><div class="cardhead"><h2>Top scores today</h2><span class="sm" style="color:var(--muted)">${g.of} ${g.of === 1 ? 'player' : 'players'}</span></div>
      ${g.top.length ? g.top.map((r) => `<div class="lb-row ${r.me ? 'me' : ''}"><span class="lb-r">${r.rank === 1 ? '👑' : '#' + r.rank}</span><span class="lb-n">${esc(r.name)}</span><span class="lb-v">${scoreTxt(g, r.m)}</span></div>`).join('') : '<p class="sub" style="margin:6px 0 0">Nobody has played today. Set the score to beat.</p>'}
    </section>`;
  $('#gBack').addEventListener('click', () => go('/play'));
  const pb = $('#gPlay'); if (pb && !pb.disabled) pb.addEventListener('click', () => startGame(id));
}
function rulesFor(id) {
  const R = {
    penalty: ['Tap once to lock your aim across the goal, tap again to lock the height.', 'Goal +100 C · difficult corner +150 C · perfect top corner +250 C.', 'Aim too wide or too high and it misses. The keeper reads you better every shot.'],
    quiz: ['Ten questions, ten seconds each.', 'Correct +50 C · 3 in a row +100 · 5 in a row +200 · 8 in a row +200 · 10/10 +500.'],
    hilo: ['Five calls. Is the next one higher or lower?', 'Correct +100 C · 3 in a row +200 bonus · 5 in a row +300 bonus. One wrong call ends it.'],
    whoami: ['Career clues, one at a time. Guess the player.', 'Guess on clue 1: +500 C · clue 2: +350 · clue 3: +200 · clue 4: +100.', 'A wrong guess costs you a clue.'],
    reaction: ['WAIT… for it. Tap the second the screen says NOW.', 'Under 200ms +500 C · 200–250 +400 · 250–300 +300 · 300–400 +150 · slower +50.', 'Tap early and it\'s gone.'],
    odds: ['Real fixtures, real league tables. Which result is most likely?', 'Correct +100 C · 5 in a row +300 bonus.', 'Most likely is not the same as guaranteed.'],
  };
  return `<ul class="rules">${(R[id] || []).map((x) => `<li>${x}</li>`).join('')}</ul>`;
}

// ---- start: spend the ticket, show it, then the game ----
async function startGame(id) {
  const btn = $('#gPlay'); if (btn) { btn.disabled = true; btn.textContent = 'Starting…'; }
  let s;
  try { s = await api('/play/start', { method: 'POST', body: JSON.stringify({ game: id }) }); }
  catch (e) { toast(e.message); if (btn) { btn.disabled = false; btn.textContent = 'PLAY · 🎟️ 1 TICKET'; } return; }
  if (WALLET) WALLET.tickets = s.tickets;
  track('play_start', { game: id });
  app.innerHTML = `<div class="ticket-used"><div class="tu-i">🎟️</div><div class="tu-t">1 PLAY TICKET USED</div><div class="tu-s">${s.tickets.left} <span>left today</span></div></div>`;
  sfx('swish'); haptic(10);
  setTimeout(() => {
    const G = { penalty: gamePenalty, quiz: gameQuiz, hilo: gameHilo, whoami: gameWhoAmI, reaction: gameReaction, odds: gameOdds }[id];
    G(s);
  }, reduceMotion() ? 350 : 850);
}
function gameShell(title, inner) {
  app.innerHTML = `<div class="gbar"><span class="gb-t">${esc(title)}</span><span class="gb-s" id="gScore">0 C</span></div><section class="card gplay">${inner}</section>`;
}
const setScore = (n) => { const el = $('#gScore'); if (el) el.textContent = fmt(n) + ' C'; };

async function finishGame(run, payload, headline) {
  let r;
  try { r = await api('/play/finish', { method: 'POST', body: JSON.stringify({ run, ...payload }) }); }
  catch (e) { toast(e.message); return go('/play'); }
  track('play_finish', { game: r.game, reward: r.reward });
  const G = { penalty: 'PENALTY KINGS', quiz: 'QUICK QUIZ', hilo: 'HIGHER OR LOWER', whoami: 'WHO AM I?', reaction: 'REACTION CLASH', odds: 'ODDS MASTER' }[r.game];
  const low = r.game === 'reaction';
  app.innerHTML = `
    <section class="card result">
      <div class="kick">${G}</div>
      <div class="rs-head">${headline(r)}</div>
      ${r.newBest ? '<div class="chip gold newbest">NEW PERSONAL BEST</div>' : ''}
      <div class="rs-lbl">REWARD</div>
      <div class="rs-rew ${r.reward ? '' : 'zero'}">+<span id="rsRew">0</span> C</div>
      ${r.capped ? `<p class="sub" style="margin:4px 0 0"><span>Daily games cap reached: 2,000 C a day from games.</span></p>` : ''}
      <div class="rs-bal"><span>${fmt(r.before)} C</span><span class="arr">→</span><b><span id="rsBal">${fmt(r.before)}</span> C</b></div>
      <div class="rs-board">${r.board.myRank ? `<span>You're</span> <b>#${r.board.myRank}</b> <span>today of</span> ${r.board.of}` : '<span>Leaderboard updates with your best.</span>'}</div>
      ${r.board.top.slice(0, 3).map((x) => `<div class="lb-row ${x.me ? 'me' : ''}"><span class="lb-r">${x.rank === 1 ? '👑' : '#' + x.rank}</span><span class="lb-n">${esc(x.name)}</span><span class="lb-v">${low ? x.m + 'ms' : fmt(x.m) + ' C'}</span></div>`).join('')}
      <div class="row" style="margin-top:14px">
        <button class="cta" id="again" style="margin:0" ${r.tickets.left ? '' : 'disabled'}>${r.tickets.left ? 'PLAY AGAIN · 🎟️ ' + r.tickets.left : 'NO TICKETS LEFT'}</button>
      </div>
      <button class="ghost" id="toHome">BACK TO HOME</button>
      <button class="muted-link" id="shareRes">Share my score 📲</button>
    </section>`;
  const rew = $('#rsRew'), bal = $('#rsBal');
  const t0 = performance.now(), dur = reduceMotion() ? 0 : 900;
  const tick = (t) => {
    const k = dur ? Math.min(1, (t - t0) / dur) : 1, e = 1 - Math.pow(1 - k, 3);
    rew.textContent = fmt(Math.round(r.reward * e)); bal.textContent = fmt(Math.round(r.before + r.reward * e));
    if (k < 1) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  if (r.reward > 0) { animateCredits(r.credits, r.reward, { from: r.before }); if (r.reward >= 500 && !reduceMotion()) setTimeout(() => confetti(r.reward / 400), 300); }
  else sfx('womp');
  if (WALLET) { WALLET.tickets = r.tickets; WALLET.play = r.play; }
  $('#again').addEventListener('click', () => { if (r.tickets.left) startGame(r.game); });
  $('#toHome').addEventListener('click', () => go('/'));
  $('#shareRes').addEventListener('click', () => shareBrag('game-' + r.game, `${G} on Clashly. Beat that.`));
}

// ---------------------------------------------------------------------------
// 1. PENALTY KINGS: two taps to aim, a keeper who learns
// ---------------------------------------------------------------------------
function gamePenalty(s) {
  gameShell('PENALTY KINGS', `
    <div class="pk-dots" id="pkDots">${'<span></span>'.repeat(5)}</div>
    <canvas id="pkCv" class="pk-cv" width="680" height="500" aria-label="Penalty: tap to aim"></canvas>
    <div class="pk-msg" id="pkMsg">TAP TO LOCK YOUR AIM</div>
    <button class="cta" id="pkTap">TAP</button>`);
  const cv = $('#pkCv'), ctx = cv.getContext('2d'), msg = $('#pkMsg');
  ctx.scale(2, 2);
  const W = 340, H = 250, GL = 40, GR = 300, GT = 40, GB = 200;
  const shots = []; let shot = 0, phase = 'x', ax = 20, ay = 18, dx = 1, dy = 1, lockX = 0, lockY = 0;
  let ball = null, keeper = { x: 170, tx: 170, dive: 0 }, raf = null, total = 0, busy = false;
  const speed = () => 2.6 * (1 + 0.17 * shot);
  const zone = (tx, ty) => {
    if (tx < GL + 4 || tx > GR - 4 || ty < GT + 4) return { pts: 0, what: tx < GL + 4 || tx > GR - 4 ? 'WIDE' : 'OVER' };
    const corner = tx < GL + 45 || tx > GR - 45;
    const top = corner && (tx < GL + 30 || tx > GR - 30) && ty < GT + 35;
    return { pts: top ? 250 : corner ? 150 : 100, top, corner };
  };
  const draw = () => {
    const g = ctx.createLinearGradient(0, 0, 0, H); g.addColorStop(0, '#0C1622'); g.addColorStop(1, '#0E2A22');
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = 'rgba(43,209,126,.10)'; for (let i = 0; i < 6; i++) ctx.fillRect(0, GB + i * 10, W, 5);
    // net
    ctx.strokeStyle = 'rgba(255,255,255,.08)'; ctx.lineWidth = 1;
    for (let x = GL; x <= GR; x += 13) { ctx.beginPath(); ctx.moveTo(x, GT); ctx.lineTo(x, GB); ctx.stroke(); }
    for (let y = GT; y <= GB; y += 13) { ctx.beginPath(); ctx.moveTo(GL, y); ctx.lineTo(GR, y); ctx.stroke(); }
    // corner hints
    ctx.fillStyle = 'rgba(255,200,61,.10)'; ctx.fillRect(GL, GT, 30, 35); ctx.fillRect(GR - 30, GT, 30, 35);
    ctx.fillStyle = 'rgba(20,224,200,.06)'; ctx.fillRect(GL, GT + 35, 45, GB - GT - 35); ctx.fillRect(GR - 45, GT + 35, 45, GB - GT - 35);
    // frame
    ctx.strokeStyle = '#F4F7FB'; ctx.lineWidth = 5; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(GL, GB); ctx.lineTo(GL, GT); ctx.lineTo(GR, GT); ctx.lineTo(GR, GB); ctx.stroke();
    // keeper (a plain silhouette)
    const kx = keeper.x, ky = 150, lean = keeper.dive;
    ctx.save(); ctx.translate(kx, ky); ctx.rotate(lean * 0.9);
    ctx.fillStyle = '#7C3AED'; ctx.beginPath(); if (ctx.roundRect) ctx.roundRect(-13, -32, 26, 58, 9); else ctx.rect(-13, -32, 26, 58); ctx.fill();
    ctx.fillStyle = '#C9D2DD'; ctx.beginPath(); ctx.arc(0, -42, 10, 0, 6.283); ctx.fill();
    ctx.fillStyle = '#14E0C8'; ctx.beginPath(); ctx.arc(-24, -30, 7, 0, 6.283); ctx.arc(24, -30, 7, 0, 6.283); ctx.fill();
    ctx.restore();
    // ball
    const b = ball || { x: 170, y: 232, r: 8 };
    ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(b.x, b.y, b.r, 0, 6.283); ctx.fill();
    ctx.fillStyle = '#0A0E13'; ctx.beginPath(); ctx.arc(b.x, b.y, b.r * 0.38, 0, 6.283); ctx.fill();
    // aim guides
    if (phase === 'x' || phase === 'y') {
      ctx.strokeStyle = '#FFC83D'; ctx.lineWidth = 2;
      const x = phase === 'x' ? ax : lockX;
      ctx.setLineDash([5, 5]); ctx.beginPath(); ctx.moveTo(x, 10); ctx.lineTo(x, GB); ctx.stroke(); ctx.setLineDash([]);
      if (phase === 'y') { ctx.beginPath(); ctx.moveTo(10, ay); ctx.lineTo(W - 10, ay); ctx.stroke(); ctx.fillStyle = '#FFC83D'; ctx.beginPath(); ctx.arc(lockX, ay, 6, 0, 6.283); ctx.fill(); }
    }
  };
  const loop = () => {
    if (phase === 'x') { ax += dx * speed(); if (ax > W - 14 || ax < 14) dx *= -1; }
    if (phase === 'y') { ay += dy * speed() * 0.8; if (ay > GB - 6 || ay < 12) dy *= -1; }
    draw(); raf = requestAnimationFrame(loop);
  };
  const dots = () => { $('#pkDots').innerHTML = Array.from({ length: 5 }, (_, i) => { const v = shots[i]; return `<span class="${v == null ? '' : v === 250 ? 'top' : v > 0 ? 'goal' : 'miss'}">${v == null ? i + 1 : v === 250 ? '★' : v > 0 ? '●' : '✕'}</span>`; }).join(''); };
  const shoot = () => {
    busy = true; phase = 'shot';
    const z = zone(lockX, lockY);
    // the keeper reads you better every shot; top corners are out of his reach
    const reads = Math.random() < 0.32 + 0.09 * shot;
    keeper.tx = reads ? Math.max(70, Math.min(270, lockX)) : [80, 170, 260][Math.floor(Math.random() * 3)];
    const reach = keeper.tx === 170 ? 40 : 48;
    const saved = z.pts > 0 && !z.top && Math.abs(lockX - keeper.tx) < reach;
    const pts = saved ? 0 : z.pts;
    const t0 = performance.now(), dur = reduceMotion() ? 1 : 520, sx = 170, sy = 232;
    const fly = (t) => {
      const k = Math.min(1, (t - t0) / dur), e = 1 - Math.pow(1 - k, 2);
      ball = { x: sx + (lockX - sx) * e, y: sy + (lockY - sy) * e, r: 8 - 3 * e };
      keeper.x = 170 + (keeper.tx - 170) * Math.min(1, k * 1.4); keeper.dive = (keeper.tx - 170) / 170 * Math.min(1, k * 1.4);
      draw();
      if (k < 1) requestAnimationFrame(fly);
      else {
        shots.push(pts); total += pts; setScore(total); dots();
        msg.textContent = pts === 250 ? 'TOP BINS! +250' : pts === 150 ? 'CORNER! +150' : pts === 100 ? 'GOAL! +100' : saved ? 'SAVED!' : z.what || 'MISSED';
        msg.className = 'pk-msg ' + (pts ? 'good' : 'bad');
        if (pts) { sfx(pts === 250 ? 'cheer' : 'ping'); haptic([10, 30, 10]); } else { sfx('womp'); haptic(30); }
        shot++;
        setTimeout(() => {
          if (shot >= 5) { cancelAnimationFrame(raf); return finishGame(s.run, { shots }, (r) => `YOU SCORED <b>${r.detail.goals}/5</b>`); }
          ball = null; keeper = { x: 170, tx: 170, dive: 0 }; phase = 'x'; ax = 20; ay = 18; busy = false;
          msg.textContent = 'TAP TO LOCK YOUR AIM'; msg.className = 'pk-msg'; $('#pkTap').textContent = 'TAP';
        }, 1100);
      }
    };
    requestAnimationFrame(fly);
  };
  const tap = (e) => {
    if (e) e.preventDefault();
    if (busy) return;
    if (phase === 'x') { lockX = ax; phase = 'y'; ay = 18; msg.textContent = 'NOW THE HEIGHT'; $('#pkTap').textContent = 'SHOOT'; haptic(8); sfx('tick'); }
    else if (phase === 'y') { lockY = ay; shoot(); }
  };
  $('#pkTap').addEventListener('click', tap);
  cv.addEventListener('pointerdown', tap);
  dots(); loop();
}

// ---------------------------------------------------------------------------
// 2. QUICK QUIZ
// ---------------------------------------------------------------------------
function gameQuiz(s) {
  gameShell('QUICK QUIZ', `<div class="qz-top"><span id="qzN">1/10</span><span id="qzStreak"></span><span id="qzT">10</span></div>
    <div class="qz-bar"><i id="qzBar"></i></div><div class="qz-q" id="qzQ"></div><div class="qz-opts" id="qzOpts"></div><div class="qz-fx" id="qzFx"></div>`);
  let q = s.q, timer = null, left = 10, locked = false;
  const show = () => {
    locked = false; left = s.seconds || 10;
    $('#qzN').textContent = (q.i + 1) + '/10'; $('#qzQ').textContent = q.text; $('#qzT').textContent = left;
    $('#qzOpts').innerHTML = q.opts.map((o, i) => `<button data-i="${i}">${esc(o)}</button>`).join('');
    const bar = $('#qzBar'); bar.style.transition = 'none'; bar.style.width = '100%'; void bar.offsetWidth;
    if (!reduceMotion()) { bar.style.transition = `width ${left}s linear`; bar.style.width = '0%'; }
    clearInterval(timer);
    timer = setInterval(() => { left--; $('#qzT').textContent = Math.max(0, left); if (reduceMotion()) bar.style.width = (left * 10) + '%'; if (left <= 0) answer(-1); }, 1000);
    document.querySelectorAll('#qzOpts button').forEach((b) => b.addEventListener('click', () => answer(Number(b.dataset.i))));
  };
  const answer = async (i) => {
    if (locked) return; locked = true; clearInterval(timer);
    let r;
    try { r = await api('/play/step', { method: 'POST', body: JSON.stringify({ run: s.run, choice: i }) }); } catch (e) { toast(e.message); return go('/play'); }
    const btns = document.querySelectorAll('#qzOpts button');
    btns.forEach((b, j) => { b.disabled = true; if (j === r.answer) b.classList.add('right'); else if (j === i) b.classList.add('wrong'); });
    setScore(r.score);
    $('#qzStreak').textContent = r.streak >= 2 ? '🔥 ' + r.streak : '';
    const fx = $('#qzFx');
    fx.textContent = r.bonus ? `${r.streak} IN A ROW +${r.bonus}` : r.correct ? '+50' : r.late ? "TIME'S UP" : '';
    fx.className = 'qz-fx ' + (r.correct ? 'good' : 'bad');
    if (r.correct) { sfx(r.bonus ? 'cheer' : 'ping'); haptic(10); } else { sfx('womp'); haptic(30); }
    setTimeout(() => {
      fx.textContent = '';
      if (r.done) return finishGame(s.run, {}, (x) => `<b>${x.detail.correct}/10</b> CORRECT`);
      q = r.next; show();
    }, 1100);
  };
  show();
}

// ---------------------------------------------------------------------------
// 3. HIGHER OR LOWER
// ---------------------------------------------------------------------------
function gameHilo(s) {
  const D = s.deck;
  const fmtV = (v) => (D.kind === 'fee' ? '€' + v + 'm' : D.kind === 'cm' ? v + ' cm' : D.kind === 'caps' ? v + ' caps' : D.kind === 'born' ? 'born ' + v : v);
  const card = (it, hidden, id) => `<div class="hl-card" id="${id}">
    ${it.img ? `<img src="${esc(it.img)}" alt="" onerror="this.remove()" />` : ''}
    <div class="hl-n">${esc(it.name)}</div>${it.meta ? `<div class="hl-m">${esc(it.meta)}</div>` : ''}
    <div class="hl-v ${hidden ? 'q' : ''}">${hidden ? '?' : fmtV(it.value)}</div></div>`;
  gameShell('HIGHER OR LOWER', `<div class="hl-deck">${esc(D.title)}</div><div class="hl-top"><span id="hlN">1/5</span><span id="hlStreak"></span></div>
    <div id="hlA"></div><div class="hl-q">${esc(D.q)}</div><div id="hlB"></div>
    <div class="row hl-btns"><button class="cta" data-g="up" style="margin:0">${esc(D.up)}</button><button class="cta ghost2" data-g="down" style="margin:0">${esc(D.down)}</button></div><div class="qz-fx" id="hlFx"></div>`);
  let a = s.a, b = s.b, n = 0, busy = false;
  const paint = () => { $('#hlA').innerHTML = card(a, false, 'hlCa'); $('#hlB').innerHTML = card(b, true, 'hlCb'); $('#hlN').textContent = (n + 1) + '/5'; };
  paint();
  document.querySelectorAll('.hl-btns [data-g]').forEach((btn) => btn.addEventListener('click', async () => {
    if (busy) return; busy = true;
    let r; try { r = await api('/play/step', { method: 'POST', body: JSON.stringify({ run: s.run, guess: btn.dataset.g }) }); } catch (e) { toast(e.message); return go('/play'); }
    const v = document.querySelector('#hlCb .hl-v'); v.classList.remove('q'); v.textContent = fmtV(r.value);
    $('#hlCb').classList.add(r.correct ? 'right' : 'wrong');
    setScore(r.score); $('#hlStreak').textContent = r.streak >= 2 ? '🔥 ' + r.streak : '';
    const fx = $('#hlFx'); fx.textContent = r.bonus ? `${r.streak} IN A ROW +${r.bonus}` : r.correct ? '+100' : 'WRONG CALL'; fx.className = 'qz-fx ' + (r.correct ? 'good' : 'bad');
    if (r.correct) { sfx('ping'); haptic(10); } else { sfx('womp'); haptic(30); }
    setTimeout(() => {
      fx.textContent = '';
      if (r.done) return finishGame(s.run, {}, (x) => `<b>${x.detail.correct}/5</b> CALLED RIGHT`);
      n++; a = { ...b, value: r.value }; b = r.next; paint(); busy = false;
    }, 1200);
  }));
}

// ---------------------------------------------------------------------------
// 4. WHO AM I?
// ---------------------------------------------------------------------------
function gameWhoAmI(s) {
  gameShell('WHO AM I?', `<div class="wa-pot">GUESS NOW: <b id="waPot">+500 C</b></div><div id="waClues" class="wa-clues"></div><div id="waWrong" class="wa-wrong"></div>
    <div class="row" style="margin-top:12px"><input id="waIn" list="waNames" placeholder="Who is it?" autocomplete="off" /><button class="cta" id="waGo" style="margin:0;flex:0 0 96px">GUESS</button></div>
    <datalist id="waNames">${s.names.map((n) => `<option value="${esc(n)}"></option>`).join('')}</datalist>
    <button class="ghost" id="waClue">Next clue (lower reward)</button>`);
  const rewards = s.rewards; let shown = 1, busy = false;
  const paint = (clues, wrong) => {
    $('#waClues').innerHTML = clues.map((c, i) => `<div class="wa-c"><span class="wa-n">CLUE #${i + 1}</span>${esc(c)}</div>`).join('');
    $('#waPot').textContent = '+' + fmt(rewards[shown - 1]) + ' C';
    if (wrong && wrong.length) $('#waWrong').innerHTML = wrong.map((w) => `<span>✕ ${esc(w)}</span>`).join('');
    $('#waClue').style.display = shown >= 4 ? 'none' : '';
  };
  paint(s.clues);
  const done = (r) => {
    $('#waClues').insertAdjacentHTML('beforeend', `<div class="wa-ans ${r.correct ? 'right' : 'wrong'}">${r.img ? `<img src="${esc(r.img)}" alt="" onerror="this.remove()" />` : ''}<div><span class="kick">${r.correct ? 'GOT IT' : 'IT WAS'}</span><div class="wa-an">${esc(r.answer)}</div></div></div>`);
    if (r.correct) { sfx('cheer'); haptic([10, 30, 12]); } else sfx('womp');
    setScore(r.score || 0);
    setTimeout(() => finishGame(s.run, {}, (x) => (x.detail.correct ? `GOT IT IN <b>${x.detail.clues}</b> ${x.detail.clues === 1 ? 'CLUE' : 'CLUES'}` : 'STUMPED')), 1500);
  };
  const guess = async () => {
    const g = ($('#waIn').value || '').trim(); if (!g || busy) return; busy = true;
    let r; try { r = await api('/play/step', { method: 'POST', body: JSON.stringify({ run: s.run, guess: g }) }); } catch (e) { busy = false; return toast(e.message); }
    $('#waIn').value = '';
    if (r.done) return done(r);
    shown = r.shown; paint(r.clues, r.wrong); sfx('womp'); haptic(20); toast('Not them. Another clue.'); busy = false;
  };
  $('#waGo').addEventListener('click', guess);
  $('#waIn').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); guess(); } });
  $('#waClue').addEventListener('click', async () => {
    if (busy) return; busy = true;
    try { const r = await api('/play/step', { method: 'POST', body: JSON.stringify({ run: s.run, action: 'clue' }) }); shown = r.shown; paint(r.clues); sfx('tick'); } catch (e) { toast(e.message); }
    busy = false;
  });
}

// ---------------------------------------------------------------------------
// 5. REACTION CLASH
// ---------------------------------------------------------------------------
function gameReaction(s) {
  gameShell('REACTION CLASH', `<button class="rx-pad wait" id="rxPad"><span id="rxT">WAIT…</span><small id="rxS">tap when it says NOW</small></button>`);
  const pad = $('#rxPad'), t = $('#rxT');
  let state = 'wait', t0 = 0, waits = 0;
  const delay = s.waitMin + Math.random() * (s.waitMax - s.waitMin);
  const pulse = setInterval(() => { if (state !== 'wait') return; waits++; t.textContent = 'WAIT' + '…'.repeat(1 + (waits % 3)); }, 650);
  const nowT = setTimeout(() => { state = 'now'; pad.className = 'rx-pad now'; t.textContent = 'NOW!'; $('#rxS').textContent = 'TAP!'; t0 = performance.now(); haptic(15); }, delay);
  pad.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    if (state === 'wait') {
      state = 'done'; clearTimeout(nowT); clearInterval(pulse);
      pad.className = 'rx-pad early'; t.textContent = 'TOO EARLY'; $('#rxS').textContent = 'jumped the gun'; sfx('womp'); haptic(40);
      setTimeout(() => finishGame(s.run, { early: true }, () => 'TOO EARLY'), 1000);
    } else if (state === 'now') {
      state = 'done'; clearInterval(pulse);
      const ms = Math.round(performance.now() - t0);
      pad.className = 'rx-pad hit'; t.textContent = ms + 'ms'; $('#rxS').textContent = ms < 200 ? 'ELITE' : ms < 250 ? 'SHARP' : ms < 300 ? 'QUICK' : ms < 400 ? 'DECENT' : 'SLEEPY';
      sfx('ping'); haptic(10);
      setTimeout(() => finishGame(s.run, { ms: Math.max(100, ms) }, (r) => (r.ms ? `<b>${r.ms}ms</b>` : 'TOO EARLY')), 1100);
    }
  });
}

// ---------------------------------------------------------------------------
// 6. ODDS MASTER: read the table, pick the most likely result
// ---------------------------------------------------------------------------
function gameOdds(s) {
  gameShell('ODDS MASTER', `<div class="hl-top"><span id="omN">1/${s.total}</span><span id="omStreak"></span></div>
    <div class="om-ev" id="omEv"></div><div class="qz-q" style="font-size:16px">WHICH OUTCOME IS MOST LIKELY?</div>
    <div class="opts big" id="omOpts"></div><div id="omReveal"></div><div class="qz-fx" id="omFx"></div>`);
  let ev = s.event, busy = false;
  const paint = () => {
    $('#omN').textContent = (ev.i + 1) + '/' + s.total;
    $('#omEv').innerHTML = `<div class="tc-teams"><div class="tt">${esc(ev.home)}</div><div class="tvs">vs</div><div class="tt">${esc(ev.away)}</div></div><div class="tc-meta" style="text-align:center">${esc(ev.competition)} · ${kickoffTxt(ev.utcDate)}</div>`;
    $('#omOpts').innerHTML = ['HOME', 'DRAW', 'AWAY'].map((o) => `<button class="opt" data-o="${o}"><span class="o-l">${esc(o === 'HOME' ? ev.home : o === 'AWAY' ? ev.away : 'Draw').toUpperCase()}</span></button>`).join('');
    $('#omReveal').innerHTML = '';
    document.querySelectorAll('#omOpts .opt').forEach((b) => b.addEventListener('click', () => pick(b.dataset.o)));
  };
  const pick = async (o) => {
    if (busy) return; busy = true;
    let r; try { r = await api('/play/step', { method: 'POST', body: JSON.stringify({ run: s.run, pick: o }) }); } catch (e) { toast(e.message); return go('/play'); }
    document.querySelectorAll('#omOpts .opt').forEach((b) => { b.disabled = true; if (b.dataset.o === r.best) b.classList.add('right'); else if (b.dataset.o === o) b.classList.add('wrong'); });
    const nm = (k) => (k === 'HOME' ? ev.home : k === 'AWAY' ? ev.away : 'Draw');
    $('#omReveal').innerHTML = `<div class="crowd">${['HOME', 'DRAW', 'AWAY'].map((k) => `<div class="cr-row"><span class="cr-l">${esc(nm(k))}</span><span class="cr-bar"><i style="width:${r.probs[k]}%;background:${k === r.best ? 'var(--teal)' : 'var(--muted)'}"></i></span><b>${r.probs[k]}%</b></div>`).join('')}</div>
      ${r.table ? `<p class="sub" style="margin:6px 0 0">${esc(ev.home)}: ${ord(r.table.home.pos)}, ${r.table.home.pts} pts · ${esc(ev.away)}: ${ord(r.table.away.pos)}, ${r.table.away.pts} pts</p>` : ''}
      <p class="sub" style="margin:6px 0 0"><span>Most likely is not guaranteed. A</span> ${r.probs[r.best]}% <span>favourite still fails</span> ${100 - r.probs[r.best]} <span>times in 100.</span></p>`;
    setScore(r.score); $('#omStreak').textContent = r.streak >= 2 ? '🔥 ' + r.streak : '';
    const fx = $('#omFx'); fx.textContent = r.bonus ? `5 IN A ROW +${r.bonus}` : r.correct ? '+100' : 'NOT THE FAVOURITE'; fx.className = 'qz-fx ' + (r.correct ? 'good' : 'bad');
    if (r.correct) sfx('ping'); else sfx('womp');
    setTimeout(() => {
      fx.textContent = '';
      if (r.done) return finishGame(s.run, {}, (x) => `<b>${x.detail.correct}/${x.detail.total}</b> READ RIGHT`);
      ev = r.next; busy = false; paint();
    }, 2600);
  };
  paint();
}
const ord = (n) => n + (n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] || 'th');

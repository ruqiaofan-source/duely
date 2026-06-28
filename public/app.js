'use strict';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const $ = (s, el = document) => el.querySelector(s);
const app = $('#app');
const api = async (path, opts = {}) => {
  const m = me.get();
  const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
  if (m && m.secret) headers['x-duely-secret'] = m.secret;
  const res = await fetch('/api' + path, { ...opts, headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Something went wrong');
  return data;
};
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const sym = (c) => (c === 'EUR' ? '€' : c === 'GBP' ? '£' : c === 'USD' ? '$' : c + ' ');
const money = (b) => `${sym(b.currency)}${b.stake}`;
const signed = (n, c) => `${n >= 0 ? '+' : '−'}${sym(c)}${Math.abs(n)}`;
const initials = (n) => String(n || '?').trim().slice(0, 2).toUpperCase();

function toast(msg) { const t = $('#toast'); t.textContent = msg; t.classList.add('show'); setTimeout(() => t.classList.remove('show'), 1900); }
// haptics — progressive enhancement (Android Chrome; iOS Safari no-ops). Respects reduced-motion.
function haptic(p) { try { if (navigator.vibrate && !matchMedia('(prefers-reduced-motion: reduce)').matches) navigator.vibrate(p); } catch {} }
function track(ev, props) { try { if (window.posthog) window.posthog.capture(ev, props || {}); } catch {} }

// ---- bottom sheet (accessible: labelled, focus-trapped, Escape-to-close) ----
let _sheetReturnFocus = null;
const _sheetFocusables = (panel) => [...panel.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')].filter((el) => !el.disabled && el.offsetParent !== null);
function _sheetKey(e) {
  const scrim = document.getElementById('sheetScrim');
  if (!scrim || !scrim.classList.contains('open')) return;
  if (e.key === 'Escape') { e.preventDefault(); closeSheet(); return; }
  if (e.key !== 'Tab') return;
  const f = _sheetFocusables(document.getElementById('sheetPanel'));
  if (!f.length) return;
  const first = f[0], last = f[f.length - 1];
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
}
function openSheet(html) {
  const scrim = document.getElementById('sheetScrim');
  const panel = document.getElementById('sheetPanel');
  panel.innerHTML = html;
  panel.tabIndex = -1;
  const h = panel.querySelector('h2');
  if (h) { if (!h.id) h.id = 'sheetTitle'; panel.setAttribute('aria-labelledby', h.id); }
  _sheetReturnFocus = document.activeElement;
  scrim.classList.add('open'); scrim.setAttribute('aria-hidden', 'false');
  document.body.style.overflow = 'hidden';
  const f = _sheetFocusables(panel);
  (f[0] || panel).focus();
  document.addEventListener('keydown', _sheetKey, true);
}
function closeSheet() {
  const scrim = document.getElementById('sheetScrim');
  scrim.classList.remove('open'); scrim.setAttribute('aria-hidden', 'true');
  document.body.style.overflow = '';
  document.removeEventListener('keydown', _sheetKey, true);
  if (_sheetReturnFocus && _sheetReturnFocus.focus) { try { _sheetReturnFocus.focus(); } catch {} }
  _sheetReturnFocus = null;
  setTimeout(() => { const p = document.getElementById('sheetPanel'); if (p && !scrim.classList.contains('open')) p.innerHTML = ''; }, 300);
}

// ---- tab bar ----
function setTab(name) {
  const bar = document.getElementById('tabbar'); if (!bar) return;
  document.body.classList.toggle('has-tabbar', Boolean(me.get()) && Boolean(name));
  bar.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
}

function statusLabel(b) {
  if (b.status === 'open') return 'open';
  if (b.status === 'accepted') return b.pending ? 'confirm' : 'live';
  return (b.won ? '+' : '−') + sym(b.currency) + b.stake;
}

// ---- emoji reactions ----
function reactionsHtml(bet) {
  const rs = bet.reactions || [];
  const counts = {}; rs.forEach((r) => { counts[r.emoji] = (counts[r.emoji] || 0) + 1; });
  const m = me.get();
  const mine = new Set(rs.filter((r) => m && r.byId === m.id).map((r) => r.emoji));
  const chips = Object.entries(counts).map(([e, c]) => `<button class="react-chip ${mine.has(e) ? 'mine' : ''}" data-react="${e}">${e}<span class="ct">${c}</span></button>`).join('');
  return `<div class="reacts">${chips}<button class="react-chip react-add" id="reactAdd">＋ react</button></div><div class="react-pop" id="reactPop" style="display:none"></div>`;
}
function wireReactions(id) {
  const palette = ['🔥', '😂', '😱', '🧊', '💀', '🐐', '😭', '👏'];
  const add = $('#reactAdd'), pop = $('#reactPop');
  if (add) add.addEventListener('click', () => {
    if (!pop.innerHTML) {
      pop.innerHTML = palette.map((e) => `<button data-pick="${e}">${e}</button>`).join('');
      pop.querySelectorAll('[data-pick]').forEach((b) => b.addEventListener('click', () => doReact(id, b.dataset.pick)));
    }
    pop.style.display = pop.style.display === 'none' ? 'flex' : 'none';
  });
  document.querySelectorAll('[data-react]').forEach((b) => b.addEventListener('click', () => doReact(id, b.dataset.react)));
}
async function doReact(id, emoji) {
  const m = me.get(); if (!m) return toast('Add your name first');
  haptic(10);
  try { await api('/bets/' + id + '/react', { method: 'POST', body: JSON.stringify({ emoji }) }); renderBet(id); }
  catch (e) { toast(e.message); }
}

// identity (server-authoritative: id is public, secret is the bearer token)
const me = {
  get() { try { return JSON.parse(localStorage.getItem('settle_me') || 'null'); } catch { return null; } },
  save(p) { if (p && p.id && p.secret) localStorage.setItem('settle_me', JSON.stringify(p)); },
  clear() { localStorage.removeItem('settle_me'); },
};
// mint a player on first use, or rename (id + secret stay stable across renames)
async function register(name) { const p = await api('/players', { method: 'POST', body: JSON.stringify({ name }) }); me.save(p); return p; }
async function rename(name) { const p = await api('/players/me', { method: 'POST', body: JSON.stringify({ name }) }); me.save(p); return p; }

// Google Identity Services loader (only used when a client id is configured)
let _gsiPromise = null;
function loadGoogle() {
  if (window.google && google.accounts && google.accounts.id) return Promise.resolve();
  if (_gsiPromise) return _gsiPromise;
  _gsiPromise = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client'; s.async = true; s.defer = true;
    s.onload = () => resolve(); s.onerror = () => reject(new Error('Google script failed to load'));
    document.head.appendChild(s);
  });
  return _gsiPromise;
}
// sign-in sheet: Google (if configured) + email/password. Upgrades the current
// anonymous player when possible, so the rivalry record on this device carries over.
function openLoginSheet(onDone) {
  const hasGoogle = Boolean(CONFIG.googleClientId);
  openSheet(`
    <div class="sheet-handle"></div>
    <div class="sheet-head"><h2>Sign in 🔐</h2><button class="sheet-x" id="sheetClose">✕</button></div>
    <div class="sheet-body">
      <p class="sub" style="margin:2px 0 12px">Save your record and pick it up on any device. Your history on this device carries over. 18+ only.</p>
      ${hasGoogle ? `<div id="gBtn" style="display:flex;justify-content:center;margin-bottom:4px"></div><div style="text-align:center;color:var(--muted);font-size:12px;margin:10px 0">or with email</div>` : ''}
      <label>Email</label>
      <input id="loginEmail" type="email" inputmode="email" placeholder="you@example.com" autocomplete="email" />
      <label>Password</label>
      <input id="loginPw" type="password" placeholder="6+ characters" autocomplete="current-password" />
      <p class="sub" id="loginErr" style="color:var(--red);min-height:16px;margin:6px 0 0"></p>
    </div>
    <div class="sheet-foot"><button class="cta commit" id="loginBtn">Continue with email →</button></div>
  `);
  $('#sheetClose').addEventListener('click', closeSheet);
  const err = $('#loginErr');
  const finish = (p) => {
    me.save(p); renderHeader(); closeSheet(); toast('Signed in');
    try { if (window.posthog) posthog.identify(p.id, { name: p.name, email: p.email || undefined }); } catch {}
    (onDone || (() => route()))();
  };
  $('#loginBtn').addEventListener('click', async () => {
    const email = $('#loginEmail').value.trim(), password = $('#loginPw').value;
    if (!email || !password) { err.textContent = 'Enter your email and password.'; return; }
    const btn = $('#loginBtn'); btn.disabled = true;
    try { finish(await api('/auth/email', { method: 'POST', body: JSON.stringify({ email, password, name: (me.get() || {}).name }) })); }
    catch (e) { err.textContent = e.message; btn.disabled = false; }
  });
  if (hasGoogle) {
    loadGoogle().then(() => {
      google.accounts.id.initialize({
        client_id: CONFIG.googleClientId,
        callback: async (resp) => {
          try { finish(await api('/auth/google', { method: 'POST', body: JSON.stringify({ idToken: resp.credential }) })); }
          catch (e) { err.textContent = e.message; }
        },
      });
      const el = document.getElementById('gBtn');
      if (el) google.accounts.id.renderButton(el, { theme: 'filled_black', size: 'large', shape: 'pill', text: 'continue_with', width: 240 });
    }).catch(() => { const el = document.getElementById('gBtn'); if (el) el.innerHTML = '<p class="sub" style="text-align:center">Google sign-in unavailable right now.</p>'; });
  }
}
const roleStore = {
  get: (id) => { try { return JSON.parse(localStorage.getItem('settle_roles') || '{}')[id]; } catch { return null; } },
  set: (id, role) => { let m = {}; try { m = JSON.parse(localStorage.getItem('settle_roles') || '{}'); } catch {} m[id] = role; localStorage.setItem('settle_roles', JSON.stringify(m)); },
};

const outcomeLabel = (b, code) => code === 'HOME' ? `${b.home} win` : code === 'AWAY' ? `${b.away} win` : code === 'DRAW' ? 'Draw' : code;
const complementLabel = (b) => b.backedOutcome === 'DRAW' ? "it's not a draw" : b.backedOutcome === 'HOME' ? `${b.home} don't win` : `${b.away} don't win`;

let CONFIG = { brand: 'Duely', live: false };
let PREFILL = null; // for rematch

// ---------------------------------------------------------------------------
// Confetti (tiny, zero-dep) + count-up
// ---------------------------------------------------------------------------
function confetti(intensity = 1) {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return; // respect reduced-motion
  let c = $('#confetti');
  if (!c) { c = document.createElement('canvas'); c.id = 'confetti'; document.body.appendChild(c); }
  const ctx = c.getContext('2d');
  c.width = innerWidth; c.height = innerHeight;
  const colors = ['#14E0C8', '#FFC83D', '#2BD17E', '#FF8C42', '#7C3AED', '#5B6CFF'];
  const N = Math.round(80 + Math.min(140, intensity * 55)); // scale celebration to the stake
  const P = Array.from({ length: N }, () => ({
    x: innerWidth / 2 + (Math.random() - 0.5) * 80, y: innerHeight * 0.32,
    vx: (Math.random() - 0.5) * 11, vy: Math.random() * -13 - 4,
    s: Math.random() * 6 + 4, c: colors[(Math.random() * colors.length) | 0],
    r: Math.random() * Math.PI, vr: (Math.random() - 0.5) * 0.3,
  }));
  let t = 0;
  (function frame() {
    t++; ctx.clearRect(0, 0, c.width, c.height);
    P.forEach((p) => {
      p.vy += 0.32; p.x += p.vx; p.y += p.vy; p.r += p.vr; p.vx *= 0.99;
      ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.r); ctx.fillStyle = p.c;
      ctx.fillRect(-p.s / 2, -p.s / 2, p.s, p.s * 0.6); ctx.restore();
    });
    if (t < 150) requestAnimationFrame(frame); else ctx.clearRect(0, 0, c.width, c.height);
  })();
}
// odometer-style rolling digits (the Robinhood "premium tell")
function countUp(el, to, prefix = '') {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) { el.textContent = prefix + to; return; }
  el.innerHTML = '';
  const pre = document.createElement('span'); pre.textContent = prefix;
  const wrap = document.createElement('span'); wrap.className = 'odo';
  el.appendChild(pre); el.appendChild(wrap);
  const cols = String(Math.round(to)).split('').map((d) => {
    const col = document.createElement('span'); col.className = 'col';
    const strip = document.createElement('span'); strip.className = 'strip';
    for (let i = 0; i <= 9; i++) { const s = document.createElement('span'); s.textContent = i; strip.appendChild(s); }
    col.appendChild(strip); wrap.appendChild(col);
    return { strip, target: Number(d) };
  });
  requestAnimationFrame(() => cols.forEach((c, i) => {
    c.strip.style.transition = `transform .95s cubic-bezier(.18,1.4,.4,1) ${i * 0.07}s`;
    c.strip.style.transform = `translateY(-${c.target}em)`;
  }));
}

// ---------------------------------------------------------------------------
// Header (identity chip)
// ---------------------------------------------------------------------------
function renderHeader() {
  const h = $('#headExtra');
  const m = me.get();
  if (!h) return;
  h.innerHTML = m ? `<div class="idchip" id="idchip"><span class="av">${initials(m.name)}</span>${esc(m.name)}</div>` : '';
  const chip = $('#idchip');
  if (chip) chip.addEventListener('click', () => { history.pushState({}, '', '/'); route(); });
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------
function getBetId() {
  const p = location.pathname.match(/^\/b\/([a-z0-9]+)/i);
  if (p) return p[1];
  return new URLSearchParams(location.search).get('b');
}
function getLeagueCode() {
  const p = location.pathname.match(/^\/l\/([a-z0-9]+)/i);
  return p ? p[1].toUpperCase() : null;
}

async function nativeShare(link, text) {
  if (navigator.share) {
    try { await navigator.share({ title: 'Duely', text, url: link }); return true; } catch { return false; }
  }
  window.open('https://wa.me/?text=' + encodeURIComponent(text + ' ' + link), '_blank');
  return true;
}

async function route() {
  const id = getBetId();
  const code = getLeagueCode();
  app.innerHTML = '<div class="spin">Loading…</div>';
  try { CONFIG = await api('/config'); } catch {}
  // migrate any pre-accounts identity ({name, token}) to a server-issued player
  let _me = me.get();
  if (_me && (!_me.id || !_me.secret)) { try { _me = await register(_me.name || 'Player'); } catch { me.clear(); _me = null; } }
  renderHeader();
  if (_me && window.posthog) { try { posthog.identify(_me.id, { name: _me.name, email: _me.email || undefined }); } catch {} }
  if (id) { setTab(null); return renderBet(id); }
  if (code) { setTab('league'); if (!me.get()) return renderOnboarding(() => renderLeague(code)); return renderLeague(code); }
  if (!me.get()) { setTab(null); return renderOnboarding(); }
  const path = location.pathname;
  if (path.startsWith('/duels')) { setTab('duels'); return renderDuels(); }
  if (path.startsWith('/leagues')) { setTab('league'); return renderLeagueHub(); }
  if (path.startsWith('/profile')) { setTab('profile'); return renderProfile(); }
  setTab('home'); return renderHome();
}

// ---------------------------------------------------------------------------
// Onboarding
// ---------------------------------------------------------------------------
function renderOnboarding(next) {
  app.innerHTML = `
    <div class="card">
      <h2>Back yourself 🤝</h2>
      <p class="sub">Duely turns a football argument into a bet you settle with a mate — and a rivalry you'll want to win. We just keep score.</p>
      <label>What should mates call you?</label>
      <input id="name" placeholder="e.g. Alex" maxlength="40" />
      <div class="checkrow">
        <input type="checkbox" id="age" />
        <label for="age">I'm 18 or over, and I'm here for the bragging rights.</label>
      </div>
      <button class="cta" id="go">Let's go →</button>
      <button class="muted-link" id="signin">I already have an account → sign in</button>
    </div>
    <div class="banner">Quick start needs just a name. Sign in (Google or email) to save your record across devices.</div>`;
  $('#go').addEventListener('click', async () => {
    const name = $('#name').value.trim();
    if (!name) return toast('Pick a name');
    if (!$('#age').checked) return toast("Confirm you're 18+");
    const btn = $('#go'); btn.disabled = true; btn.textContent = 'Setting up…';
    try { await register(name); renderHeader(); (next || renderHome)(); }
    catch (e) { toast(e.message); btn.disabled = false; btn.textContent = "Let's go →"; }
  });
  $('#signin').addEventListener('click', () => openLoginSheet(next || renderHome));
}

// ---------------------------------------------------------------------------
// Home dashboard — the rivalry hub
// ---------------------------------------------------------------------------
async function renderHome() {
  const m = me.get();
  let s;
  try { s = await api('/players/me/summary'); }
  catch { s = { w: 0, l: 0, net: 0, currency: 'EUR', streak: { type: null, count: 0 }, rivalries: [], recent: [] }; }
  let lg = { leagues: [] };
  try { lg = await api('/players/me/leagues'); } catch {}

  const netClass = s.net > 0 ? 'pos' : s.net < 0 ? 'neg' : '';
  const streakTxt = s.streak.count ? `${s.streak.count}${s.streak.type}` : '—';
  const onFire = s.streak.type === 'W' && s.streak.count >= 2;
  const isNew = s.w === 0 && s.l === 0 && s.rivalries.length === 0 && lg.leagues.length === 0;

  const rivalriesHtml = s.rivalries.length
    ? s.rivalries.map((r) => {
        const lead = r.w > r.l ? 'lead' : r.w < r.l ? 'trail' : 'level';
        const verb = r.w > r.l ? 'You lead' : r.w < r.l ? 'You trail' : 'Level with';
        return `
          <div class="riv-row" data-opp="${esc(r.opponent)}">
            <div>
              <div class="nm">${esc(r.opponent)} ${r.isRival ? '<span class="tag-rival">Rival</span>' : ''}</div>
              <div class="sm">${verb} · net ${signed(r.net, s.currency)}</div>
            </div>
            <div style="text-align:right">
              <div class="rec ${lead}">${r.w}–${r.l}</div>
              <button class="muted-link" style="margin:2px 0 0;font-size:12px" data-rematch="${esc(r.opponent)}">Rematch →</button>
            </div>
          </div>`;
      }).join('')
    : `<p class="sub" style="margin:8px 0 0">No rivalries yet. Challenge a mate and start one. 👀</p>`;

  const recentHtml = s.recent.length
    ? s.recent.map((r) => `
        <div class="recent">
          <span>${esc(r.home)} v ${esc(r.away)} · <span style="color:var(--muted)">${esc(r.opponent)}</span></span>
          <span class="res ${r.won ? 'w' : 'l'}">${r.won ? '+' : '−'}${sym(r.currency)}${r.amount}</span>
        </div>`).join('')
    : '';

  app.innerHTML = `
    ${isNew ? `<div class="card" style="border-color:rgba(20,224,200,.4)"><h2>New here? 👋</h2><p class="sub" style="margin:0">Pick this weekend's match, back your call, and fire the link to a mate — they tap, take the other side, done. No signup — Duely keeps score and builds your rivalry.</p></div>` : ''}
    <div class="card">
      <div class="cardhead"><h2>Your season</h2><span class="flame ${onFire ? 'on' : ''}">${onFire ? '🔥 ' + s.streak.count + ' in a row' : ''}</span></div>
      <div class="stats">
        <div class="stat"><div class="n">${s.w}–${s.l}</div><div class="k">Record</div></div>
        <div class="stat"><div class="n ${netClass}">${signed(s.net, s.currency)}</div><div class="k">Net</div></div>
        <div class="stat"><div class="n gold">${streakTxt}</div><div class="k">Streak</div></div>
      </div>
      <button class="cta commit" id="challenge">⚔️ Challenge a mate</button>
    </div>

    <div class="card">
      <h2>Rivalries</h2>
      ${rivalriesHtml}
    </div>

    <div class="card">
      <div class="cardhead"><h2>Leagues</h2><button class="linkbtn" id="newLeague">+ New / join</button></div>
      ${lg.leagues.length
        ? lg.leagues.map((l) => `
          <div class="riv-row" data-league="${esc(l.code)}" role="button" tabindex="0" style="cursor:pointer">
            <div><div class="nm">${esc(l.name)}</div><div class="sm">${l.members} mates · ${l.rank ? 'you\'re #' + l.rank + ' of ' + l.total : 'unranked'}</div></div>
            <div class="rec ${l.rank === 1 ? 'lead' : ''}">#${l.rank || '–'}</div>
          </div>`).join('')
        : `<p class="sub" style="margin:8px 0 0">No leagues yet — turn your group chat into a season-long table. 🏆</p>`}
    </div>

    ${recentHtml ? `<div class="card"><h2>Recent</h2>${recentHtml}</div>` : ''}

    <div class="banner">You're net <b style="color:var(--text)">${signed(s.net, s.currency)}</b> this season — settle up with your mates and run it back.</div>`;

  $('#challenge').addEventListener('click', () => { PREFILL = null; renderCreate(); });
  app.querySelectorAll('[data-rematch]').forEach((b) =>
    b.addEventListener('click', () => { PREFILL = { opponent: b.dataset.rematch }; renderCreate(); }));
  $('#newLeague').addEventListener('click', () => renderLeagueHub());
  app.querySelectorAll('[data-league]').forEach((b) =>
    b.addEventListener('click', () => { history.pushState({}, '', '/l/' + b.dataset.league); renderLeague(b.dataset.league); }));
}

// ---------------------------------------------------------------------------
// Duels tab — all your bets
// ---------------------------------------------------------------------------
async function renderDuels() {
  const m = me.get();
  let d = { active: [], history: [] };
  try { d = await api('/players/me/bets'); } catch {}
  const row = (b) => `
    <div class="recent" data-bet="${b.id}" role="button" tabindex="0" style="cursor:pointer">
      <span>${esc(b.home)} v ${esc(b.away)}${b.opponent ? ' · <span style="color:var(--muted)">' + esc(b.opponent) + '</span>' : ''}</span>
      <span class="res ${b.won === true ? 'w' : b.won === false ? 'l' : ''}">${statusLabel(b)}</span>
    </div>`;
  app.innerHTML = `
    <div class="card">
      <div class="cardhead"><h2>Active duels ⚔️</h2><button class="linkbtn" id="newBet">+ New</button></div>
      ${d.active.length ? d.active.map(row).join('') : '<p class="sub" style="margin:8px 0 0">No live duels. Challenge a mate.</p>'}
    </div>
    ${d.history.length ? `<div class="card"><h2>Settled</h2>${d.history.map(row).join('')}</div>` : ''}`;
  $('#newBet').addEventListener('click', () => { PREFILL = null; renderCreate(); });
  app.querySelectorAll('[data-bet]').forEach((el) => el.addEventListener('click', () => { history.pushState({}, '', '/b/' + el.dataset.bet); renderBet(el.dataset.bet); }));
}

// ---------------------------------------------------------------------------
// Profile tab — record, rivalries, identity
// ---------------------------------------------------------------------------
async function renderProfile() {
  const m = me.get();
  let s;
  try { s = await api('/players/me/summary'); }
  catch { s = { w: 0, l: 0, net: 0, currency: 'EUR', streak: { type: null, count: 0 }, rivalries: [] }; }
  const netClass = s.net > 0 ? 'pos' : s.net < 0 ? 'neg' : '';
  const streakTxt = s.streak.count ? `${s.streak.count}${s.streak.type}` : '—';
  const acct = m.email
    ? `<div class="card"><div class="cardhead"><h2>Account</h2><button class="linkbtn" id="signout">Sign out</button></div><p class="sub" style="margin:0">Signed in as <b style="color:var(--text)">${esc(m.email)}</b>${m.verified ? ' ✓' : ''}. Your record syncs to this account.</p></div>`
    : `<div class="card"><div class="cardhead"><h2>Account</h2></div><p class="sub" style="margin:0 0 10px">You're playing as a guest on this device. Save your record so it survives across devices.</p><button class="cta" id="signin">Sign in / create account</button></div>`;
  app.innerHTML = `
    <div class="card">
      <div class="cardhead"><h2>${esc(m.name)}</h2><button class="linkbtn" id="rename">Edit name</button></div>
      <div class="stats">
        <div class="stat"><div class="n">${s.w}–${s.l}</div><div class="k">Record</div></div>
        <div class="stat"><div class="n ${netClass}">${signed(s.net, s.currency)}</div><div class="k">Net</div></div>
        <div class="stat"><div class="n gold">${streakTxt}</div><div class="k">Streak</div></div>
      </div>
    </div>
    ${acct}
    <div class="card"><h2>Rivalries</h2>${s.rivalries.length
      ? s.rivalries.map((r) => `<div class="riv-row" data-rematch="${esc(r.opponent)}" style="cursor:pointer"><div><div class="nm">${esc(r.opponent)} ${r.isRival ? '<span class="tag-rival">Rival</span>' : ''}</div><div class="sm">net ${signed(r.net, s.currency)}</div></div><div class="rec ${r.w > r.l ? 'lead' : r.w < r.l ? 'trail' : ''}">${r.w}–${r.l}</div></div>`).join('')
      : '<p class="sub" style="margin:8px 0 0">No rivalries yet — challenge a mate.</p>'}</div>
    <div class="banner">You're net <b style="color:var(--text)">${signed(s.net, s.currency)}</b> — settle up with your mates and run it back.</div>`;
  $('#rename').addEventListener('click', () => openRenameSheet(m.name));
  const so = $('#signout'); if (so) so.addEventListener('click', () => { me.clear(); try { posthog.reset(); } catch {} renderHeader(); history.pushState({}, '', '/'); route(); });
  const si = $('#signin'); if (si) si.addEventListener('click', () => openLoginSheet(renderProfile));
  app.querySelectorAll('[data-rematch]').forEach((b) => b.addEventListener('click', () => { PREFILL = { opponent: b.dataset.rematch }; renderCreate(); }));
}

// ---------------------------------------------------------------------------
// Leagues — the scale layer
// ---------------------------------------------------------------------------
function renderLeagueHub() {
  const m = me.get();
  app.innerHTML = `
    <div class="card">
      <h2>Leagues 🏆</h2>
      <p class="sub">Turn your group chat into a season-long table. Every bet between members feeds one leaderboard.</p>
      <label>Create a league</label>
      <input id="lname" placeholder="e.g. Sunday League" maxlength="50" />
      <button class="cta" id="createLeague">Create league →</button>
      <div style="height:8px"></div>
      <label>…or join with a code</label>
      <input id="lcode" placeholder="e.g. K7M2Q" maxlength="8" style="text-transform:uppercase" />
      <button class="ghost" id="joinByCode">Join league</button>
      <button class="muted-link" id="homeLink">Back to my season</button>
    </div>`;
  $('#createLeague').addEventListener('click', async () => {
    const name = $('#lname').value.trim();
    if (!name) return toast('Name your league');
    try {
      const l = await api('/leagues', { method: 'POST', body: JSON.stringify({ name }) });
      history.pushState({}, '', '/l/' + l.code); renderLeague(l.code);
    } catch (e) { toast(e.message); }
  });
  $('#joinByCode').addEventListener('click', async () => {
    const code = $('#lcode').value.trim().toUpperCase();
    if (!code) return toast('Enter a code');
    try {
      await api('/leagues/' + code + '/join', { method: 'POST' });
      history.pushState({}, '', '/l/' + code); renderLeague(code);
    } catch (e) { toast(e.message); }
  });
  $('#homeLink').addEventListener('click', () => { history.pushState({}, '', '/'); route(); });
}

async function renderLeague(code) {
  app.innerHTML = '<div class="spin">Loading…</div>';
  const m = me.get();
  let lg;
  try { lg = await api('/leagues/' + code); }
  catch { app.innerHTML = `<div class="card"><h2>League not found</h2><p class="sub">This invite looks broken or expired.</p><button class="cta" onclick="location.href='/'">Go to Duely</button></div>`; return; }

  const isMember = m && lg.members.some((x) => x.id === m.id);
  const link = location.origin + '/l/' + code;

  if (!isMember) {
    app.innerHTML = `
      <div class="card">
        <div class="cardhead"><h2>Join ${esc(lg.name)} 🏆</h2></div>
        <p class="sub">${lg.members.length} mate${lg.members.length === 1 ? '' : 's'} settling football bets in one league. Climb the table.</p>
        <img class="cardimg" src="/lcard/${code}.svg" alt="League invite" />
        <button class="cta" id="joinBtn">Join the league 🤝</button>
        <button class="muted-link" onclick="location.href='/'">Not now</button>
      </div>`;
    $('#joinBtn').addEventListener('click', async () => {
      if (!m) return renderOnboarding(() => renderLeague(code));
      try { await api('/leagues/' + code + '/join', { method: 'POST' }); renderLeague(code); }
      catch (e) { toast(e.message); }
    });
    return;
  }

  const rows = lg.standings || [];
  const tbl = rows.map((r) => `
    <div class="lg-row ${m && r.id === m.id ? 'me' : ''}">
      <div class="lg-rank">${r.rank}</div>
      <div class="lg-name">${esc(r.name)}${r.rank === 1 && r.games ? ' 👑' : ''}</div>
      <div class="lg-rec">${r.w}-${r.l}</div>
      <div class="lg-net ${r.net > 0 ? 'pos' : r.net < 0 ? 'neg' : ''}">${signed(r.net, 'EUR')}</div>
    </div>`).join('');
  const waText = `Join our Duely league "${lg.name}" 🏆 — settle football bets, climb the table.`;

  app.innerHTML = `
    <div class="card">
      <div class="cardhead"><h2>${esc(lg.name)} 🏆</h2><span class="pill resolved">${lg.members.length} mates</span></div>
      <div class="lg-head"><div class="lg-rank">#</div><div class="lg-name">Player</div><div class="lg-rec">W-L</div><div class="lg-net">Net</div></div>
      ${tbl}
      <button class="cta commit" id="challenge">⚔️ Challenge a mate</button>
      <button class="cta wa" id="invite">Invite mates on WhatsApp</button>
      <button class="ghost" id="copyInvite">Copy invite link</button>
      <button class="muted-link" id="homeLink">Back to my season</button>
    </div>
    <div class="banner">League table counts bets between members only. Win to climb. 🪜</div>`;
  $('#challenge').addEventListener('click', () => { PREFILL = null; renderCreate(); });
  $('#invite').addEventListener('click', () => window.open('https://wa.me/?text=' + encodeURIComponent(waText + ' ' + link), '_blank'));
  $('#copyInvite').addEventListener('click', async () => { try { await navigator.clipboard.writeText(link); toast('Invite copied'); } catch { toast(link); } });
  $('#homeLink').addEventListener('click', () => { history.pushState({}, '', '/'); route(); });
}

// ---------------------------------------------------------------------------
// Create a bet
// ---------------------------------------------------------------------------
async function renderCreate() {
  const m = me.get();
  let matches = [], live = false;
  try { const r = await api('/matches'); matches = r.matches; live = r.live; } catch {}
  const copy = PREFILL?.copy;
  const state = { backedOutcome: copy?.backedOutcome || 'HOME' };
  const rematchOf = PREFILL?.opponent;

  openSheet(`
    <div class="sheet-handle"></div>
    <div class="sheet-head"><h2>${rematchOf ? 'Rematch ' + esc(rematchOf) + ' ⚔️' : copy ? 'Run it back 🔁' : 'Start a duel 🤝'}</h2><button class="sheet-x" id="sheetClose">✕</button></div>
    <div class="sheet-body">
      <p class="sub" style="margin:2px 0 12px">${rematchOf ? 'Winner takes the bragging rights and the lead.' : 'Set the terms, send the link — you settle up between yourselves.'}</p>
      <label>The match</label>
      <select id="matchSel"></select>
      <div id="customWrap" style="display:none"><div class="row"><div><label>Home team</label><input id="home" placeholder="Spain" maxlength="40" /></div><div><label>Away team</label><input id="away" placeholder="Uruguay" maxlength="40" /></div></div></div>
      <label>What are you backing?</label>
      <div class="seg" id="seg"></div>
      <div class="row"><div><label>Stake</label><input id="stake" type="number" inputmode="decimal" min="0" step="1" value="${copy?.stake || 20}" /></div><div><label>Currency</label><select id="currency"><option>EUR</option><option>GBP</option><option>USD</option></select></div></div>
      <label>Trash talk (optional)</label>
      <input id="note" placeholder="No chance they keep it close 😏" maxlength="140" value="${copy?.note ? esc(copy.note) : ''}" />
      <div class="banner" style="margin-top:14px;text-align:left"><span id="previewLine">…</span></div>
      <div class="banner" style="margin-top:8px">${live ? '🟢 Live fixtures' : '🟡 Demo fixtures'}</div>
    </div>
    <div class="sheet-foot"><button class="cta commit" id="createBtn">Lock it in & get link →</button></div>
  `);

  const sel = $('#matchSel');
  sel.innerHTML = matches.map((mm) => `<option value="${mm.id}">${esc(mm.home)} vs ${esc(mm.away)}${mm.competition ? ' · ' + esc(mm.competition) : ''}</option>`).join('') + '<option value="custom">+ Custom match…</option>';

  const updatePreview = () => {
    const mm = matches.find((x) => x.id === sel.value);
    const home = mm ? mm.home : ($('#home')?.value || 'Home');
    const away = mm ? mm.away : ($('#away')?.value || 'Away');
    const backedLbl = state.backedOutcome === 'HOME' ? home + ' win' : state.backedOutcome === 'AWAY' ? away + ' win' : 'Draw';
    const compl = state.backedOutcome === 'DRAW' ? 'not a draw' : state.backedOutcome === 'HOME' ? home + " don't win" : away + " don't win";
    const el = $('#previewLine');
    if (el) el.innerHTML = `You back <b style="color:var(--text)">${esc(backedLbl)}</b> for <b style="color:var(--green)">${sym($('#currency').value)}${esc($('#stake').value || '0')}</b> — they take <b style="color:var(--text)">${esc(compl)}</b>`;
  };
  const renderSeg = () => {
    const mm = matches.find((x) => x.id === sel.value);
    const home = mm ? mm.home : ($('#home')?.value || 'Home');
    const away = mm ? mm.away : ($('#away')?.value || 'Away');
    $('#seg').innerHTML = [['HOME', `${home} win`], ['DRAW', 'Draw'], ['AWAY', `${away} win`]]
      .map(([code, lbl]) => `<button data-o="${code}" class="${state.backedOutcome === code ? 'active' : ''}">${esc(lbl)}</button>`).join('');
    $('#seg').querySelectorAll('button').forEach((btn) => btn.addEventListener('click', () => { state.backedOutcome = btn.dataset.o; haptic(8); renderSeg(); }));
    updatePreview();
  };
  const onMatchChange = () => { $('#customWrap').style.display = sel.value === 'custom' ? 'block' : 'none'; renderSeg(); };
  sel.addEventListener('change', onMatchChange);
  $('#home').addEventListener('input', renderSeg);
  $('#away').addEventListener('input', renderSeg);
  ['input', 'change'].forEach((ev) => { $('#stake').addEventListener(ev, updatePreview); $('#currency').addEventListener(ev, updatePreview); });
  $('#sheetClose').addEventListener('click', closeSheet);

  if (copy) { sel.value = 'custom'; $('#home').value = copy.home || ''; $('#away').value = copy.away || ''; if (copy.currency) $('#currency').value = copy.currency; }
  onMatchChange();

  $('#createBtn').addEventListener('click', async () => {
    const mm = matches.find((x) => x.id === sel.value);
    const home = mm ? mm.home : $('#home').value.trim();
    const away = mm ? mm.away : $('#away').value.trim();
    if (!home || !away) return toast('Add both teams');
    const stake = Number($('#stake').value);
    if (!(stake > 0)) return toast('Add a stake');
    const btn = $('#createBtn'); btn.disabled = true; btn.textContent = 'Locking in…'; haptic(22);
    try {
      const bet = await api('/bets', { method: 'POST', body: JSON.stringify({
        home, away, competition: mm ? mm.competition : (copy?.competition || ''),
        utcDate: mm ? mm.utcDate : null, externalId: mm ? mm.externalId || null : null,
        backedOutcome: state.backedOutcome, stake, currency: $('#currency').value, note: $('#note').value.trim(), rematch: Boolean(rematchOf || copy),
      }) });
      roleStore.set(bet.id, 'proposer'); PREFILL = null;
      track('bet_created', { stake });
      closeSheet();
      history.pushState({}, '', '/b/' + bet.id); renderBet(bet.id);
    } catch (e) { toast(e.message); btn.disabled = false; btn.textContent = 'Lock it in & get link →'; }
  });
}

// brief "locked in" seal animation between commit and next screen
function sealThen(next) {
  app.innerHTML = `<div class="card"><div class="sealwrap"><div class="seal">🔒</div><h2 style="text-align:center">Locked in</h2></div></div>`;
  setTimeout(next, 720);
}

// ---------------------------------------------------------------------------
// A specific bet
// ---------------------------------------------------------------------------
async function renderBet(id, opts = {}) {
  app.innerHTML = '<div class="spin">Loading…</div>';
  let bet;
  try { bet = await api('/bets/' + id); }
  catch { app.innerHTML = `<div class="card"><h2>Bet not found</h2><p class="sub">This link looks broken or expired.</p><button class="cta" onclick="location.href='/'">Go to Duely</button></div>`; return; }

  const role = roleStore.get(id);
  const m = me.get();
  const link = location.origin + '/b/' + id;
  const matchCard = `
    <div class="match">
      <div class="teams">${esc(bet.home)} <span class="vs">VS</span> ${esc(bet.away)}</div>
      <div class="meta">${bet.competition ? esc(bet.competition) + ' · ' : ''}${bet.utcDate ? new Date(bet.utcDate).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' }) : ''}</div>
    </div>`;
  const pill = `<span class="pill ${bet.status}">${bet.status}</span>`;

  // helper: rivalry banner between me and the other player (if history exists)
  async function rivalryBanner(otherPid, otherName) {
    if (!m || !otherPid || otherPid === m.id) return '';
    try {
      const r = await api('/players/me/rivalry?with=' + encodeURIComponent(otherPid));
      if (!r.games) return '';
      const lead = r.aWins > r.bWins ? 'lead' : r.aWins < r.bWins ? 'trail' : 'level';
      const verb = r.aWins > r.bWins ? 'You lead' : r.aWins < r.bWins ? 'You trail' : 'All level';
      return `<div class="rivalry"><div><div class="vsline">${verb} ${esc(otherName)}</div><div class="sm" style="color:var(--muted);font-size:12px">net ${signed(r.aNet, r.currency)} this season</div></div><div class="score ${lead}">${r.aWins}–${r.bWins}</div></div>`;
    } catch { return ''; }
  }

  // ---- OPEN ----
  if (bet.status === 'open') {
    // the proposer sees the SHARE view — by identity, not just device-local role,
    // so opening your own link on any device never dead-ends into the accept screen.
    if (role === 'proposer' || (m && bet.proposerId === m.id)) {
      app.innerHTML = `
        <div class="card">
          <div class="cardhead"><h2>Send it to your mate 📲</h2>${pill}</div>
          <p class="sub">You're backing <b>${esc(outcomeLabel(bet, bet.backedOutcome))}</b> for <b>${money(bet)}</b>. They take the other side (${esc(complementLabel(bet))}).</p>
          <img class="cardimg" src="/card/${id}.svg" alt="Your bet card" loading="eager" />
          <button class="cta wa" id="waBtn">Share on WhatsApp</button>
          <button class="ghost" id="shareBtn">Share card / copy link</button>
          <a class="muted-link" href="/card/${id}.png" target="_blank" rel="noopener">Save card image</a>
          <button class="muted-link" id="cancelBet">Cancel this bet</button>
          <button class="muted-link" id="homeLink">Back to my season</button>
        </div>
        <div class="banner">Waiting for your mate to take the bet…</div>`;
      const waText = `${m ? m.name : 'I'} bet you ${money(bet)} that ${outcomeLabel(bet, bet.backedOutcome)}. ${bet.note ? '“' + bet.note + '” ' : ''}Tap to take the other side 👇`;
      $('#waBtn').addEventListener('click', () => { track('share', { kind: 'whatsapp' }); window.open('https://wa.me/?text=' + encodeURIComponent(waText + ' ' + link), '_blank'); });
      $('#shareBtn').addEventListener('click', () => shareWithCard('/card/' + id + '.png', waText, link, 'challenge'));
      $('#cancelBet').addEventListener('click', (e) => {
        const b = e.target;
        if (b.dataset.armed) return doVoid(id);
        b.dataset.armed = '1'; b.textContent = 'Tap again to cancel this bet';
      });
      $('#homeLink').addEventListener('click', () => { history.pushState({}, '', '/'); route(); });
      return;
    }
    // opponent / fresh visitor
    track('accept_view', { id });
    const rb = await rivalryBanner(bet.proposerId, bet.proposerName);
    app.innerHTML = `
      <div class="card">
        <div class="cardhead"><h2>${esc(bet.proposerName)} wants to bet you 👀</h2>${pill}</div>
        <p class="sub"><b>${esc(bet.proposerName)}</b> is backing <b>${esc(outcomeLabel(bet, bet.backedOutcome))}</b> for <b>${money(bet)}</b>.</p>
        ${rb}
        ${matchCard}
        ${bet.note ? `<div class="note">“${esc(bet.note)}”</div>` : ''}
        <div class="side"><div><div class="who">You'd be backing</div><div class="pick">${esc(complementLabel(bet))}</div></div><div class="stake">${money(bet)}</div></div>
        <label>Your name</label>
        <input id="opponentName" placeholder="e.g. Jordan" maxlength="40" value="${m ? esc(m.name) : ''}" />
        <button class="cta commit" id="acceptBtn">Take the bet 🤝</button>
        <button class="muted-link" onclick="location.href='/'">Nah — not this one</button>
      </div>`;
    $('#acceptBtn').addEventListener('click', async () => {
      const opponentName = $('#opponentName').value.trim();
      if (!opponentName) return toast('Add your name');
      const btn = $('#acceptBtn'); btn.disabled = true; $('.card').classList.add('locking'); haptic(22);
      try {
        let mm = me.get();
        if (!mm) mm = await register(opponentName);
        else if (norm(mm.name) !== norm(opponentName)) mm = await rename(opponentName);
        await api('/bets/' + id + '/accept', { method: 'POST' });
        track('bet_accepted');
        renderHeader();
        roleStore.set(id, 'opponent');
        sealThen(() => renderBet(id));
      } catch (e) { toast(e.message); btn.disabled = false; $('.card').classList.remove('locking'); }
    });
    return;
  }

  // ---- ACCEPTED ----
  if (bet.status === 'accepted') {
    const rb = await rivalryBanner(otherSideId(bet, m), otherSide(bet, m));
    app.innerHTML = `
      <div class="card">
        <div class="cardhead"><h2>Bet's on 🔒</h2>${pill}</div>
        ${matchCard}
        ${rb}
        ${bet.note ? `<div class="note">“${esc(bet.note)}”</div>` : ''}
        <div class="side"><div><div class="who">${esc(bet.proposerName)}</div><div class="pick">${esc(outcomeLabel(bet, bet.backedOutcome))}</div></div><div class="stake">${money(bet)}</div></div>
        <div class="side"><div><div class="who">${esc(bet.opponentName)}</div><div class="pick">${esc(complementLabel(bet))}</div></div><div class="stake">${money(bet)}</div></div>
        <div id="resolveZone"></div>
        ${reactionsHtml(bet)}
      </div>`;
    const zone = $('#resolveZone');
    const pend = bet.pendingResult;
    const other = otherSide(bet, m);
    const kickoffFuture = bet.utcDate && new Date(bet.utcDate).getTime() > Date.now();
    const showReportSeg = () => {
      zone.innerHTML = `
        <label>Report the final result</label>
        <div class="seg" id="resSeg">
          <button data-o="HOME">${esc(bet.home)} won</button>
          <button data-o="DRAW">Draw</button>
          <button data-o="AWAY">${esc(bet.away)} won</button>
        </div>
        <div class="banner">Your mate confirms it before it's final — keeps it honest 🤝</div>`;
      $('#resSeg').querySelectorAll('button').forEach((b) => b.addEventListener('click', () => doResolve(id, b.dataset.o)));
    };
    if (bet.disputed) {
      const claims = bet.disputed.claims || [];
      zone.innerHTML = `
        <div class="banner" style="margin-bottom:10px">⚖️ You two don't agree on the result.</div>
        ${claims.map((c) => `<div class="side"><div><div class="who">${esc(c.by)}</div><div class="pick">says ${esc(outcomeLabel(bet, c.outcome))}</div></div></div>`).join('')}
        <button class="cta" id="redoBtn" style="margin-top:12px">Report it again</button>
        <button class="ghost" id="voidBtn">Void this bet — no result counts</button>`;
      $('#redoBtn').addEventListener('click', showReportSeg);
      $('#voidBtn').addEventListener('click', (e) => {
        const b = e.target; if (b.dataset.armed) return doVoid(id);
        b.dataset.armed = '1'; b.textContent = 'Tap again to void it';
      });
    } else if (pend && m && pend.byId === m.id) {
      zone.innerHTML = `
        <div class="banner" style="margin-bottom:10px">You reported <b style="color:var(--text)">${esc(outcomeLabel(bet, pend.outcome))}</b>. Waiting for ${esc(other)} to confirm…</div>
        <button class="ghost" id="changeBtn">Change my report</button>`;
      $('#changeBtn').addEventListener('click', showReportSeg);
    } else if (pend && m) {
      zone.innerHTML = `
        <div class="banner" style="margin-bottom:10px">${esc(pend.by || 'Your mate')} says it finished: <b style="color:var(--text)">${esc(outcomeLabel(bet, pend.outcome))}</b></div>
        <button class="cta gold" id="confirmBtn">Confirm result ✓</button>
        <button class="ghost" id="disputeBtn">That's not right →</button>`;
      $('#confirmBtn').addEventListener('click', () => doConfirm(id));
      $('#disputeBtn').addEventListener('click', showReportSeg);
    } else if (kickoffFuture) {
      zone.innerHTML = `<div class="banner">🔒 Locked in — kicks off ${esc(new Date(bet.utcDate).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }))}. Come back after full time to settle.</div>`;
    } else if (CONFIG.live && bet.externalId) {
      zone.innerHTML = `<button class="cta" id="autoBtn">Check final result</button><div class="banner">Auto-resolves from the live feed once the match is finished.</div><button class="muted-link" id="manualBtn">Match over but the feed's not updating? Report it manually</button>`;
      $('#autoBtn').addEventListener('click', () => doResolve(id, null));
      $('#manualBtn').addEventListener('click', showReportSeg);
    } else {
      showReportSeg();
    }
    wireReactions(id);
    return;
  }

  // ---- RESOLVED / SETTLED ----
  if (bet.status === 'resolved' || bet.status === 'settled') {
    const winnerNm = bet.winner === 'proposer' ? bet.proposerName : bet.opponentName;
    const winPick = bet.winner === 'proposer' ? outcomeLabel(bet, bet.backedOutcome) : complementLabel(bet);
    const other = otherSide(bet, m);
    const iWon = m && (bet.winner === 'proposer' ? bet.proposerId : bet.opponentId) === m.id;
    const rb = await rivalryBanner(otherSideId(bet, m), other);

    app.innerHTML = `
      <div class="card">
        <div class="cardhead"><h2>Full time 🏁</h2>${pill}</div>
        ${matchCard}
        <div class="banner reveal" style="margin-bottom:12px">Result: <b style="color:var(--text)">${esc(outcomeLabel(bet, bet.actualOutcome))}</b></div>
        <div class="owes reveal delay1">
          <div class="lbl">${bet.status === 'settled' ? 'Sorted' : 'Sort it'} 👇</div>
          <div class="big">${esc(bet.owes.from)} → ${esc(bet.owes.to)}</div>
          <div class="amt" id="amt">${sym(bet.currency)}0</div>
        </div>
        <div class="side win reveal delay2"><div><div class="who">🏆 ${esc(winnerNm)}</div><div class="pick">called it: ${esc(winPick)}</div></div></div>
        ${rb ? `<div class="reveal delay3">${rb}</div>` : ''}
        <div class="reveal delay3">
          ${reactionsHtml(bet)}
          <img class="cardimg" src="/card/${id}.svg" alt="Result card" loading="lazy" />
          ${iWon
            ? `<button class="cta wa" id="shareResult">Brag about it 🏆</button>`
            : (other ? `<button class="cta commit" id="rematchLoss">Demand a rematch ⚔️</button>` : '')}
          <div class="row" style="margin-top:10px">
            <button class="ghost" id="storyBtn">Story image 📲</button>
            <button class="ghost" id="copyBet">Run it back 🔁</button>
          </div>
          ${bet.status === 'resolved' ? `<button class="cta gold" id="settleBtn" style="margin-top:10px">Mark it sorted ✓</button>` : `<div class="banner" style="margin-top:14px">✓ Sorted${bet.settledAt ? ' · ' + new Date(bet.settledAt).toLocaleDateString() : ''}</div>`}
          ${other && iWon ? `<button class="cta commit" id="rematchBtn" style="margin-top:10px">Rematch ${esc(other)} ⚔️</button>` : ''}
          <button class="muted-link" id="homeLink">Back to my season</button>
        </div>
      </div>`;
    const shareText = `I called it — ${outcomeLabel(bet, bet.actualOutcome)}. ${other ? other + ' owes me the bragging rights 👑 ' : ''}Who's next?`;
    const sr = $('#shareResult'); if (sr) sr.addEventListener('click', () => shareWithCard('/card/' + id + '.png', shareText, link, 'result'));
    const rl = $('#rematchLoss'); if (rl) rl.addEventListener('click', () => rematchConfirm(other, bet));
    const sb = $('#storyBtn'); if (sb) sb.addEventListener('click', () => shareStory(id));
    const cb = $('#copyBet'); if (cb) cb.addEventListener('click', () => { PREFILL = { copy: { home: bet.home, away: bet.away, competition: bet.competition, backedOutcome: bet.backedOutcome, stake: bet.stake, currency: bet.currency, note: bet.note } }; renderCreate(); });
    wireReactions(id);

    // animate the payout count-up, confetti only if *I* won
    setTimeout(() => { const el = $('#amt'); if (el) countUp(el, bet.owes.amount, sym(bet.currency)); }, 420);
    if (iWon) { setTimeout(() => confetti(Math.max(1, Math.min(3, bet.stake / 20))), 520); haptic([14, 50, 22]); }

    if (bet.status === 'resolved') $('#settleBtn').addEventListener('click', async () => {
      try { await api('/bets/' + id + '/settle', { method: 'POST' }); toast('Nice — sorted'); renderBet(id); } catch (e) { toast(e.message); }
    });
    const rbtn = $('#rematchBtn'); if (rbtn) rbtn.addEventListener('click', () => rematchConfirm(other, bet));
    $('#homeLink').addEventListener('click', () => { history.pushState({}, '', '/'); route(); });
    return;
  }

  // ---- VOID (cancelled or disputed-and-voided) ----
  if (bet.status === 'void') {
    app.innerHTML = `
      <div class="card">
        <div class="cardhead"><h2>Bet called off</h2><span class="pill settled">void</span></div>
        <p class="sub">This bet was voided — it doesn't count toward anyone's record.</p>
        <button class="cta" id="homeLink">Back to my season</button>
      </div>`;
    $('#homeLink').addEventListener('click', () => { history.pushState({}, '', '/'); route(); });
    return;
  }
}

// the other player relative to "me" (falls back to opponent)
function otherSide(bet, m) {
  if (!m) return bet.opponentName || bet.proposerName;
  return bet.proposerId === m.id ? bet.opponentName : bet.proposerName;
}
function otherSideId(bet, m) {
  if (!m) return bet.opponentId || bet.proposerId;
  return bet.proposerId === m.id ? bet.opponentId : bet.proposerId;
}
function norm(s) { return String(s || '').trim().toLowerCase(); }

// ---------------------------------------------------------------------------
// Rematch — deliberate friction (responsible design): restate stake + net,
// never one-tap, never auto-fired after a loss.
// ---------------------------------------------------------------------------
async function rematchConfirm(other, lastBet) {
  const m = me.get();
  const oppId = otherSideId(lastBet, m);
  let netLine = '';
  try {
    const r = await api('/players/me/rivalry?with=' + encodeURIComponent(oppId));
    netLine = `You're <b>${signed(r.aNet, r.currency)}</b> vs ${esc(other)} this season · record <b>${r.aWins}–${r.bWins}</b>.`;
  } catch {}
  app.innerHTML = `
    <div class="card">
      <h2>Rematch ${esc(other)}?</h2>
      <p class="sub">Quick gut-check before you go again.</p>
      <div class="side"><div><div class="who">Last bet</div><div class="pick">${esc(lastBet.home)} v ${esc(lastBet.away)}</div></div><div class="stake">${money(lastBet)}</div></div>
      <div class="resp" style="margin-top:14px;text-align:center;display:block">${netLine || 'New rivalry — make it count.'}</div>
      <div class="banner" style="margin-top:12px">Winner takes the bragging rights. Set your own stake on the next screen.</div>
      <button class="cta commit" id="goRematch">Set up the rematch →</button>
      <button class="muted-link" id="notNow">Not now</button>
    </div>`;
  $('#goRematch').addEventListener('click', () => { PREFILL = { opponent: other }; renderCreate(); });
  $('#notNow').addEventListener('click', () => { history.pushState({}, '', '/'); route(); });
}

async function doResolve(id, actualOutcome) {
  try { await api('/bets/' + id + '/resolve', { method: 'POST', body: JSON.stringify({ actualOutcome }) }); renderBet(id); }
  catch (e) { toast(e.message); }
}
async function doConfirm(id) {
  try { await api('/bets/' + id + '/confirm', { method: 'POST' }); track('bet_resolved'); renderBet(id); }
  catch (e) { toast(e.message); }
}
async function doVoid(id) {
  try { await api('/bets/' + id + '/void', { method: 'POST' }); toast('Bet voided'); history.pushState({}, '', '/'); route(); }
  catch (e) { toast(e.message); }
}

// share a rendered card image (native file share where supported), else the link
async function shareWithCard(cardUrl, text, link, kind) {
  track('share', { kind });
  try {
    if (navigator.canShare) {
      const r = await fetch(cardUrl); const blob = await r.blob();
      const file = new File([blob], 'duely.png', { type: 'image/png' });
      if (navigator.canShare({ files: [file] })) { await navigator.share({ files: [file], text, url: link }); return; }
    }
  } catch {}
  if (navigator.share) { try { await navigator.share({ title: 'Duely', text, url: link }); return; } catch {} }
  try { await navigator.clipboard.writeText(link); toast('Link copied'); } catch { toast(link); }
}
async function shareStory(id) {
  track('share', { kind: 'story' });
  const url = '/storycard/' + id + '.png';
  try {
    if (navigator.canShare) {
      const r = await fetch(url); const blob = await r.blob();
      const file = new File([blob], 'duely-story.png', { type: 'image/png' });
      if (navigator.canShare({ files: [file] })) { await navigator.share({ files: [file], text: 'Settled on Duely ⚽' }); return; }
    }
  } catch {}
  window.open(url, '_blank');
}

// rename via the bottom sheet (replaces the inaccessible prompt())
function openRenameSheet(current) {
  openSheet(`
    <div class="sheet-handle"></div>
    <div class="sheet-head"><h2>Edit name</h2><button class="sheet-x" id="sheetClose" aria-label="Close">✕</button></div>
    <div class="sheet-body">
      <label for="renameInput">What should mates call you?</label>
      <input id="renameInput" maxlength="40" value="${esc(current)}" autocomplete="off" />
    </div>
    <div class="sheet-foot"><button class="cta" id="renameSave">Save name →</button></div>`);
  $('#sheetClose').addEventListener('click', closeSheet);
  const inp = $('#renameInput'); try { inp.focus(); inp.select(); } catch {}
  $('#renameSave').addEventListener('click', async () => {
    const n = inp.value.trim(); if (!n) return toast('Pick a name');
    try { await rename(n); renderHeader(); closeSheet(); renderProfile(); } catch (e) { toast(e.message); }
  });
}

document.getElementById('tabbar')?.addEventListener('click', (e) => {
  const t = e.target.closest('.tab'); if (!t) return;
  haptic(8);
  const tab = t.dataset.tab;
  history.pushState({}, '', tab === 'home' ? '/' : tab === 'league' ? '/leagues' : '/' + tab);
  route();
});
document.getElementById('sheetScrim')?.addEventListener('click', (e) => { if (e.target.id === 'sheetScrim') closeSheet(); });

// Enter/Space activate keyboard-focused rows (role=button divs)
app.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  const t = e.target.closest('[role="button"][data-bet],[role="button"][data-league]');
  if (t) { e.preventDefault(); t.click(); }
});

window.addEventListener('popstate', route);
route();

// floodlights intro + ambient spotlight that tracks the pointer
(function floodlit() {
  const intro = document.getElementById('intro');
  if (intro) {
    if (document.documentElement.classList.contains('no-intro')) {
      intro.classList.add('gone');
    } else {
      const kill = () => intro.classList.add('gone');
      intro.addEventListener('click', kill);
      setTimeout(kill, 1850);
    }
  }
  const spot = document.querySelector('.amb-spot');
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (spot && !reduce) {
    let lastPointer = -9999;
    window.addEventListener('pointermove', (e) => {
      lastPointer = performance.now();
      spot.style.setProperty('--mx', (e.clientX / innerWidth * 100).toFixed(1) + '%');
      spot.style.setProperty('--my', (e.clientY / innerHeight * 100).toFixed(1) + '%');
    }, { passive: true });
    // on phones (no pointer) and when the cursor is idle, the floodlight drifts on its own
    const drift = (t) => {
      if (performance.now() - lastPointer > 1400) {
        const s = t / 1000;
        const mx = 50 + Math.sin(s * 0.16) * 32 + Math.sin(s * 0.07) * 8;
        const my = 24 + Math.cos(s * 0.12) * 18;
        spot.style.setProperty('--mx', mx.toFixed(1) + '%');
        spot.style.setProperty('--my', my.toFixed(1) + '%');
      }
      requestAnimationFrame(drift);
    };
    requestAnimationFrame(drift);
  }
})();

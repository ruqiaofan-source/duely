'use strict';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const $ = (s, el = document) => el.querySelector(s);
const app = $('#app');
const sfx = (n) => { try { if (window.SFX) window.SFX.play(n); } catch {} };
const api = async (path, opts = {}) => {
  const m = me.get();
  const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
  if (m && m.secret) headers['x-duely-secret'] = m.secret;
  const res = await fetch('/api' + path, { ...opts, headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    // a 401 while we HOLD a secret means the identity is dead server-side (store reset) —
    // clear it so the user can re-onboard instead of being stuck "signed in" with every
    // write failing. Auth endpoints excluded: their 401s are credential failures, not
    // session death, and must not nuke a valid guest identity.
    if (res.status === 401 && m && m.secret && !path.startsWith('/auth/')) { me.clear(); try { renderHeader(); } catch {} setTimeout(() => { try { route(); } catch {} }, 0); }
    const err = new Error(data.error || 'Something went wrong');
    err.status = res.status;
    throw err;
  }
  return data;
};
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const sym = (c) => (c === 'EUR' ? '€' : c === 'GBP' ? '£' : c === 'USD' ? '$' : c + ' ');
// what's on the line: forfeit text if set, else the money stake, else bragging rights
const money = (b) => (b.line && b.line.trim()) ? b.line : (b.stake > 0 ? `${sym(b.currency)}${b.stake}` : 'bragging rights');
const signed = (n, c) => `${n >= 0 ? '+' : '−'}${sym(c)}${Math.abs(n)}`;
// net is null when stakes span multiple currencies (summing £ and € is nonsense)
const netTxt = (n, c) => (n == null ? '—' : signed(n, c || 'EUR'));
const initials = (n) => String(n || '?').trim().slice(0, 2).toUpperCase();

function toast(msg) { const t = $('#toast'); t.textContent = msg; t.classList.add('show'); setTimeout(() => t.classList.remove('show'), 1900); }
// haptics — progressive enhancement (Android Chrome; iOS Safari no-ops). Respects reduced-motion.
function haptic(p) { try { if (navigator.vibrate && !matchMedia('(prefers-reduced-motion: reduce)').matches) navigator.vibrate(p); } catch {} }
function track(ev, props) { try { if (window.posthog) window.posthog.capture(ev, props || {}); } catch {} }

// ---- bottom sheet (accessible: labelled, focus-trapped, Escape-to-close) ----
let _sheetReturnFocus = null;
let _sheetURL = null;
const _sheetFocusables = (panel) => [...panel.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')].filter((el) => !el.disabled && el.offsetParent !== null);
function _sheetKey(e) {
  const scrim = document.getElementById('sheetScrim');
  if (!scrim || !scrim.classList.contains('open')) return;
  if (e.key === 'Escape') { e.preventDefault(); closeSheet(); return; }
  if (e.key !== 'Tab') return;
  const panel = document.getElementById('sheetPanel');
  const f = _sheetFocusables(panel);
  if (!f.length) return;
  const first = f[0], last = f[f.length - 1];
  // if focus escaped the sheet (e.g. the focused element was re-rendered away),
  // clamp it back inside instead of letting Tab wander the background page
  if (!panel.contains(document.activeElement)) { e.preventDefault(); (e.shiftKey ? last : first).focus(); return; }
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
}
function openSheet(html) {
  sfx('swish');
  const scrim = document.getElementById('sheetScrim');
  const panel = document.getElementById('sheetPanel');
  panel.innerHTML = html;
  panel.tabIndex = -1;
  const h = panel.querySelector('h2');
  if (h) { if (!h.id) h.id = 'sheetTitle'; panel.setAttribute('aria-labelledby', h.id); }
  _sheetReturnFocus = document.activeElement;
  _sheetURL = location.href;
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
  if (b.status === 'void') return 'void';
  if (!(b.stake > 0)) return b.won ? 'W' : 'L'; // forfeit bets settle in bragging rights
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
  // optimistic: toggle my reaction locally and repaint just the strip (no full-screen
  // spinner wipe, no scroll jump). Reconcile against the server's authoritative bet.
  const bet = _betCache[id];
  const container = document.querySelector('.reacts')?.parentElement;
  if (bet && container) {
    bet.reactions = bet.reactions || [];
    const i = bet.reactions.findIndex((r) => r.byId === m.id && r.emoji === emoji);
    if (i >= 0) bet.reactions.splice(i, 1); else bet.reactions.push({ byId: m.id, by: m.name, emoji });
    repaintReacts(id, bet);
  }
  try {
    const fresh = await api('/bets/' + id + '/react', { method: 'POST', body: JSON.stringify({ emoji }) });
    _betCache[id] = fresh;
    if (container) repaintReacts(id, fresh);
  } catch (e) {
    toast(e.message);
    if (bet && container) { // revert
      const i = bet.reactions.findIndex((r) => r.byId === m.id && r.emoji === emoji);
      if (i >= 0) bet.reactions.splice(i, 1); else bet.reactions.push({ byId: m.id, by: m.name, emoji });
      repaintReacts(id, bet);
    }
  }
}
function repaintReacts(id, bet) {
  const old = document.querySelector('.reacts'); if (!old) return;
  const pop = document.getElementById('reactPop');
  const wrap = document.createElement('div'); wrap.innerHTML = reactionsHtml(bet);
  old.replaceWith(wrap.firstElementChild);
  if (pop) pop.replaceWith(wrap.lastElementChild);
  wireReactions(id);
}

// press-and-hold commit — micro-friction as ceremony (the deliberate inverse of
// one-click betting: we ADD a beat of intent at the money moment)
function armHold(btn, onCommit, holdMs = 650) {
  if (!btn) return;
  let t = null, done = false;
  btn.style.position = 'relative'; btn.style.overflow = 'hidden';
  const fill = document.createElement('span');
  fill.style.cssText = 'position:absolute;inset:0;background:rgba(255,255,255,.25);transform:scaleX(0);transform-origin:left;pointer-events:none;transition:transform ' + holdMs + 'ms linear;border-radius:inherit';
  btn.appendChild(fill);
  const start = (e) => { if (done || btn.disabled) return; e.preventDefault(); haptic(8); requestAnimationFrame(() => { fill.style.transform = 'scaleX(1)'; }); t = setTimeout(() => { done = true; haptic([15, 30, 15]); onCommit(); }, holdMs); };
  const cancel = () => { try { if (window.SFX) window.SFX.play('riserStop'); } catch {} if (done || t === null) return; clearTimeout(t); t = null; fill.style.transition = 'transform 180ms ease-out'; fill.style.transform = 'scaleX(0)'; setTimeout(() => { fill.style.transition = 'transform ' + holdMs + 'ms linear'; }, 200); toast('Hold to lock it in'); };
  btn.addEventListener('pointerdown', (e) => { t = null; sfx('riserStart'); start(e); });
  ['pointerup', 'pointerleave', 'pointercancel'].forEach((ev) => btn.addEventListener(ev, cancel));
  btn.addEventListener('keydown', (e) => { if ((e.key === 'Enter' || e.key === ' ') && !done) { e.preventDefault(); done = true; onCommit(); } });
}

// ---- the terrace: comments on a bet (real players + the clearly-labeled Pundit) ----
function commentsHtml(bet) {
  const cs = (bet.comments || []).slice(-6);
  const mm = me.get();
  const rows = cs.map((c) => `
    <div style="padding:8px 2px;border-bottom:1px solid var(--line)">
      <span style="font-weight:800;font-size:12.5px;color:${c.bot ? 'var(--purple-text)' : 'var(--teal)'}">${esc(c.by)}${c.bot ? ' <span class="tag-rival">house bot 🤖</span>' : ''}</span>
      <div style="font-size:14px;margin-top:2px;line-height:1.45">${esc(c.text)}</div>
    </div>`).join('');
  return `<div id="terrace" style="margin-top:14px">
    <label style="margin-top:0">The terrace 🗣️</label>
    ${rows || '<p class="sub" style="margin:4px 0 8px">No noise yet — get it started.</p>'}
    ${mm ? `<div class="linkbox"><input id="cmtIn" maxlength="280" placeholder="Talk your talk…" aria-label="Add a comment" /><button id="cmtSend">Send</button></div>` : ''}
  </div>`;
}
function wireComments(id) {
  const send = $('#cmtSend'); if (!send) return;
  const go = async () => {
    const inp = $('#cmtIn'); const text = (inp.value || '').trim(); if (!text) return;
    send.disabled = true;
    try {
      const b = await api('/bets/' + id + '/comment', { method: 'POST', body: JSON.stringify({ text }) });
      track('comment', { id });
      const t = $('#terrace'); if (t) { t.outerHTML = commentsHtml(b); wireComments(id); const ni = $('#cmtIn'); if (ni) ni.focus(); }
    } catch (e) { toast(e.message); send.disabled = false; }
  };
  send.addEventListener('click', go);
  $('#cmtIn').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); go(); } });
}

// identity (server-authoritative: id is public, secret is the bearer token)
const me = {
  get() { try { return JSON.parse(localStorage.getItem('settle_me') || 'null'); } catch { return null; } },
  save(p) { try { if (p && p.id && p.secret) localStorage.setItem('settle_me', JSON.stringify(p)); } catch {} },
  clear() { try { localStorage.removeItem('settle_me'); } catch {} },
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
      <label for="loginEmail">Email</label>
      <input id="loginEmail" type="email" inputmode="email" placeholder="you@example.com" autocomplete="email" />
      <label for="loginPw">Password</label>
      <input id="loginPw" type="password" placeholder="6+ characters" autocomplete="current-password" />
      <p class="sub" id="loginErr" style="color:#FF9AA6;min-height:16px;margin:6px 0 0"></p>
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
  set: (id, role) => { let m = {}; try { m = JSON.parse(localStorage.getItem('settle_roles') || '{}'); } catch {} m[id] = role; try { localStorage.setItem('settle_roles', JSON.stringify(m)); } catch {} },
};
// local preferences (e.g. hide streaks — a humane opt-out for users who find them stressful)
const prefs = {
  get() { try { return JSON.parse(localStorage.getItem('settle_prefs') || '{}'); } catch { return {}; } },
  set(k, v) { const p = prefs.get(); p[k] = v; try { localStorage.setItem('settle_prefs', JSON.stringify(p)); } catch {} },
};

// A season-long call is a one-sided claim ("Arsenal finish above Spurs"): no away
// team, no fixture, no draw. It rides the existing HOME/AWAY axis — HOME = the
// claim lands, AWAY = it doesn't — so rivalry tables, receipts and the ledger all
// keep working with no branching of their own.
const isSeason = (b) => Boolean(b) && b.kind === 'season';
const matchLabel = (b) => (isSeason(b) ? b.home : `${b.home} v ${b.away}`);
const outcomeLabel = (b, code) => isSeason(b) ? (code === 'HOME' ? 'Yes — it happens' : 'No chance')
  : code === 'HOME' ? `${b.home} win` : code === 'AWAY' ? `${b.away} win` : code === 'DRAW' ? 'Draw' : code;
const complementLabel = (b) => isSeason(b) ? (b.backedOutcome === 'HOME' ? "it doesn't happen" : 'it happens')
  : b.backedOutcome === 'DRAW' ? "it's not a draw" : b.backedOutcome === 'HOME' ? `${b.home} don't win` : `${b.away} don't win`;

let CONFIG = { brand: 'Clashly', live: false };
let PREFILL = null; // for rematch
let RECWIN = 'week'; // high-scores window: week | all
const _betCache = {}; // last-fetched bet per id (optimistic reactions reconcile against it)
let _gen = 0; // render generation — a newer render invalidates a slower older one

// rank fixtures for the Home "Big games" spotlight: tournament > big competition,
// big-club bonus, near-kickoff bonus. Threshold keeps filler fixtures out.
const COMP_W = [[/world cup|fifa|\bwc\b/i, 100], [/champions league/i, 80], [/europa/i, 55], [/premier league/i, 50], [/la ?liga/i, 45], [/serie a/i, 42], [/bundesliga/i, 42], [/eredivisie/i, 40], [/ligue 1/i, 38]];
const BIG_CLUBS = /man(chester)? (city|united)|liverpool|arsenal|chelsea|tottenham|newcastle|real madrid|barcelona|atl[ée]tico|bayern|dortmund|leverkusen|psg|paris|inter|ac milan|juventus|napoli|ajax|psv|feyenoord|benfica|porto|celtic|rangers|galatasaray|boca|river|flamengo/i;
function pickBigGames(matches, n = 3) {
  const now = Date.now(), soon = 3 * 86400000;
  return (matches || [])
    .map((mm) => {
      let sc = 0;
      for (const [re, w] of COMP_W) if (re.test(mm.competition || '')) { sc += w; break; }
      if (BIG_CLUBS.test(mm.home)) sc += 25;
      if (BIG_CLUBS.test(mm.away)) sc += 25;
      const t = new Date(mm.utcDate || 0).getTime();
      if (t > now && t - now < soon) sc += 10;
      return { ...mm, _score: sc };
    })
    .filter((mm) => mm._score >= 60)
    .sort((a, b) => (b._score - a._score) || (new Date(a.utcDate || 0) - new Date(b.utcDate || 0)))
    .slice(0, n);
}
const timeAgo = (iso) => { const s = Math.max(1, (Date.now() - new Date(iso).getTime()) / 1000); if (s < 60) return 'now'; if (s < 3600) return Math.floor(s / 60) + 'm'; if (s < 86400) return Math.floor(s / 3600) + 'h'; return Math.floor(s / 86400) + 'd'; };
const kickoffTxt = (iso) => { try { return new Date(iso).toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' }); } catch { return ''; } };

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
  // static text for reduced-motion AND non-integer amounts (the odometer rounds —
  // a €12.50 payout must not animate to "€13")
  if (matchMedia('(prefers-reduced-motion: reduce)').matches || !Number.isInteger(to)) { el.textContent = prefix + to; return; }
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
  const lang = (window.CLASHLY_I18N && window.CLASHLY_I18N.lang()) || 'en';
  const segS = (on) => on ? 'padding:5px 10px;background:var(--teal);color:#06140f' : 'padding:5px 10px;color:var(--muted)';
  const langBtn = `<div id="langBtn" role="button" tabindex="0" title="Language / Język" style="display:flex;border:1.5px solid var(--line);border-radius:999px;overflow:hidden;cursor:pointer;font-size:12px;font-weight:800;flex:none"><span style="${segS(lang !== 'pl')}">🇬🇧 EN</span><span style="${segS(lang === 'pl')}">🇵🇱 PL</span></div>`;
  h.innerHTML = (m ? `<div class="idchip" id="idchip"><span class="av">${initials(m.name)}</span>${esc(m.name)}</div>` : '') + langBtn;
  const lb = $('#langBtn');
  if (lb && window.CLASHLY_I18N) lb.addEventListener('click', () => window.CLASHLY_I18N.toggle());
  const chip = $('#idchip');
  if (chip) chip.addEventListener('click', () => { if (location.pathname !== '/') history.pushState({}, '', '/'); route(); });
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

// LINK-FIRST share — for invites/challenges/results where the tappable link is
// the whole point. The link auto-unfurls into the rich card on WhatsApp,
// Messenger, iMessage, Telegram, Discord, Slack, Twitter/X and Facebook, AND
// stays tappable so the mate can accept. We deliberately DON'T attach the image
// file here: on WhatsApp/Messenger a file-share can drop the URL, killing the loop.
async function shareLink(link, text) {
  if (navigator.share) {
    try { await navigator.share({ title: 'Clashly', text, url: link }); return true; }
    catch (e) { if (e && e.name === 'AbortError') return true; } // user cancelled — not a failure
  }
  // desktop / no Web Share: WhatsApp web deep-link (unfurls the card there too)
  try { window.open('https://wa.me/?text=' + encodeURIComponent(text + ' ' + link), '_blank', 'noopener'); return true; }
  catch { try { await navigator.clipboard.writeText(link); toast('Link copied — paste it to your mate'); } catch { toast(link); } return true; }
}
const nativeShare = shareLink; // back-comaptible alias

async function route() {
  const id = getBetId();
  const code = getLeagueCode();
  app.innerHTML = '<div class="spin">Loading…</div>';
  // config off the critical path: only the bet view needs it before first render
  // (auto-resolve UI reads CONFIG.live); everything else reads it lazily later
  const cfgP = api('/config').then((c) => (CONFIG = c)).catch(() => {});
  // migrate any pre-accounts identity ({name, token}) to a server-issued player
  let _me = me.get();
  if (_me && (!_me.id || !_me.secret)) { try { _me = await register(_me.name || 'Player'); } catch { me.clear(); _me = null; } }
  renderHeader();
  if (_me && window.posthog) { try { posthog.identify(_me.id, { name: _me.name, email: _me.email || undefined }); } catch {} }
  if (id) { setTab(null); await cfgP; return renderBet(id); }
  if (code) { setTab('league'); if (!me.get()) return renderOnboarding(() => renderLeague(code)); return renderLeague(code); }
  if (!me.get()) { setTab(null); return renderOnboarding(); }
  // arriving from a /call/:fixture landing page — open the create sheet on that match
  const callId = new URLSearchParams(location.search).get('call');
  if (callId) {
    history.replaceState({}, '', location.pathname);
    setTab('home'); PREFILL = { matchId: callId };
    await renderHome(); track('call_page_land', { match: callId });
    return renderCreate();
  }
  const path = location.pathname;
  if (path.startsWith('/arena')) { setTab('home'); return renderArena(); }
  if (path.startsWith('/board')) { setTab('board'); return renderBoard(); }
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
      <h2>Think you know ball? Prove it. ⚽</h2>
      <p class="sub">Call the match, your mate takes the other side, and the winner goes on the record. Clashly keeps the score — the rivalry does the rest.</p>
      <label for="name">What should mates call you?</label>
      <input id="name" placeholder="e.g. Alex" maxlength="40" />
      <div class="checkrow">
        <input type="checkbox" id="age" />
        <label for="age">I'm 18 or over, and I'm here for the bragging rights.</label>
      </div>
      <button class="cta" id="go">Let's go →</button>
      <button class="muted-link" id="signin">I already have an account → sign in</button>
    </div>
    <div class="banner" style="border-style:solid;border-color:rgba(255,200,61,.35);color:var(--text)">🔰 Early days — join now and you're a <b style="color:var(--gold)">Founder</b>: your number's stamped on your profile and your perks carry over when Pro launches.</div>
    <div class="banner">Quick start needs just a name. Sign in (Google or email) to save your record across devices.</div>`;
  $('#go').addEventListener('click', async () => {
    const name = $('#name').value.trim();
    if (!name) return toast('Pick a name');
    if (!$('#age').checked) return toast("Confirm you're 18+");
    const btn = $('#go'); btn.disabled = true; btn.textContent = 'Setting up…';
    // go through the router (not the render fn directly) so setTab runs and the
    // tab bar actually appears now that an identity exists
    try { await register(name); renderHeader(); route(); }
    catch (e) { toast(e.message); btn.disabled = false; btn.textContent = "Let's go →"; }
  });
  $('#signin').addEventListener('click', () => openLoginSheet());
}


// Vinted-style item card for an open Arena challenge — the bet as a listing
function arenaItemCard(c) {
  const backedLbl = c.backedOutcome === 'HOME' ? c.home + ' win' : c.backedOutcome === 'AWAY' ? c.away + ' win' : 'Draw';
  const stakeLbl = c.line || (c.stake > 0 ? sym(c.currency) + c.stake : 'bragging rights');
  const st = c.proposerStats || {};
  const cred = (st.w || st.l) ? `${st.w}\u2013${st.l}` : 'new';
  const fire = st.streakType === 'W' && st.streakCount >= 2 ? ' \ud83d\udd25' + st.streakCount : '';
  return `<div class="item-card" data-arena="${esc(c.id)}" role="button" tabindex="0">
    <span class="pricetag">${esc(stakeLbl)}</span>${c.offers ? `<span class="offbadge">💬 ${c.offers}</span>` : ''}
    <div class="teams">${esc(c.home)} <span style="color:var(--purple)">v</span> ${esc(c.away)}</div>
    <div class="pick">backs <b>${esc(backedLbl)}</b>${c.utcDate ? ' \u00b7 ' + kickoffTxt(c.utcDate) : ''}</div>
    <div class="seller"><span class="av2">${initials(c.proposerName)}</span><span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(c.proposerName)} \u00b7 ${cred}${fire}</span></div>
  </div>`;
}

// ---------------------------------------------------------------------------
// Home dashboard — the rivalry hub
// ---------------------------------------------------------------------------
async function renderHome() {
  const my = ++_gen; const live = () => my === _gen;
  const m = me.get();
  const actP = api('/activity').catch(() => null);
  const myBetsP = m ? api('/players/me/bets').catch(() => null) : Promise.resolve(null);
  const motwP = api('/motw').catch(() => null);
  const matchP = api('/matches').catch(() => null); // in parallel with the ledger fetches
  const recP = api('/records?window=' + RECWIN).catch(() => null);
  const arenaP = api('/arena').catch(() => null);
  const terrP = api('/terrace').catch(() => null);
  const [sRes, lgRes] = await Promise.allSettled([api('/players/me/summary'), api('/players/me/leagues')]);
  const s = sRes.status === 'fulfilled' ? sRes.value : { w: 0, l: 0, net: 0, currency: 'EUR', streak: { type: null, count: 0 }, rivalries: [], recent: [] };
  const lg = lgRes.status === 'fulfilled' ? lgRes.value : { leagues: [] };
  let big = [];
  try { const mr = await matchP; if (mr) big = pickBigGames(mr.matches); } catch {}
  let rec = null;
  try { rec = await recP; } catch {}
  let arena = [];
  try { const ar = await arenaP; if (ar && ar.challenges) arena = ar.challenges; } catch {}
  let terrace = [];
  try { const tr = await terrP; if (tr && tr.posts) terrace = tr.posts; } catch {}
  let activity = [];
  try { const av = await actP; if (av && av.items) activity = av.items; } catch {}
  let motw = null;
  try { const mw = await motwP; if (mw && mw.match && new Date(mw.match.utcDate || 0).getTime() > Date.now()) motw = mw.match; } catch {}
  // v14 — bets waiting on ME to settle or confirm: the single most valuable tap
  // on the whole site, so it renders above everything else on home.
  let toSettle = [];
  try { const mb = await myBetsP; if (mb && mb.active) toSettle = mb.active.filter((b) => b.status === 'accepted' && b.yourMove); } catch {}
  if (!live()) return; // superseded by a newer navigation
  const recRow = (ico, label, val) => val ? `<div class="recent"><span>${ico} ${label}</span><span class="res" style="color:var(--gold)">${val}</span></div>` : '';
  const recHtml = rec ? [
    prefs.get().hideStreaks ? '' : recRow('🔥', 'Hot streak', rec.streak && `${esc(rec.streak.name)} · ${rec.streak.count}W`),
    recRow('⚔️', 'Most duels', rec.mostDuels && `${esc(rec.mostDuels.name)} · ${rec.mostDuels.duels}`),
    recRow('🎯', 'Best record', rec.bestRecord && `${esc(rec.bestRecord.name)} · ${rec.bestRecord.w}-${rec.bestRecord.l}`),
    recRow('😅', 'Biggest bottle', rec.biggestBottle && `${esc(rec.biggestBottle.name)} · ${rec.biggestBottle.l} Ls`),
    recRow('🥊', 'Fiercest rivalry', rec.fiercest && `${esc(rec.fiercest.a)} v ${esc(rec.fiercest.b)} · ${rec.fiercest.games}`),
    recRow('👑', 'Arena crown', rec.arenaKing && `${esc(rec.arenaKing.name)} · ${rec.arenaKing.wins} arena W${rec.arenaKing.wins === 1 ? '' : 's'}`),
  ].join('') : '';

  const netClass = s.net > 0 ? 'pos' : s.net < 0 ? 'neg' : '';
  const hideStreaks = prefs.get().hideStreaks;
  const streakTxt = (!hideStreaks && s.streak.count) ? `${s.streak.count}${s.streak.type}` : '—';
  const onFire = !hideStreaks && s.streak.type === 'W' && s.streak.count >= 2;
  const isNew = s.w === 0 && s.l === 0 && s.rivalries.length === 0 && lg.leagues.length === 0;
  // the single most-contested rivalry — an unsettled score is an open loop you return to settle
  const hot = s.rivalries
    .filter((r) => Math.abs(r.w - r.l) <= 1 && (r.w + r.l) >= 2)
    .sort((a, b) => (Math.abs(a.w - a.l) - Math.abs(b.w - b.l)) || ((b.w + b.l) - (a.w + a.l)))[0];
  const hotLine = hot ? (hot.w === hot.l ? `Level with ${esc(hot.opponent)} — nobody's ahead` : hot.w > hot.l ? `You lead ${esc(hot.opponent)} by one` : `${esc(hot.opponent)} leads you by one`) : '';

  const rivalriesHtml = s.rivalries.length
    ? s.rivalries.map((r) => {
        const lead = r.w > r.l ? 'lead' : r.w < r.l ? 'trail' : 'level';
        const verb = r.w > r.l ? 'You lead' : r.w < r.l ? 'You trail' : 'Level with';
        return `
          <div class="riv-row" data-rivid="${esc(r.opponentId)}" data-rivname="${esc(r.opponent)}" role="button" tabindex="0" style="cursor:pointer">
            <div>
              <div class="nm">${esc(r.opponent)} ${r.isRival ? '<span class="tag-rival">Rival</span>' : ''}${r.streakWeeks >= 2 ? ` <span class="wkchip">🔥${r.streakWeeks}wk</span>` : ''}</div>
              <div class="sm">${verb} · ${r.w + r.l} duel${r.w + r.l === 1 ? '' : 's'}</div>
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
          <span>${esc(matchLabel(r))} · <span style="color:var(--muted)">${esc(r.opponent)}</span></span>
          <span class="res ${r.won ? 'w' : 'l'}">${r.won ? '+' : '−'}${sym(r.currency)}${r.amount}</span>
        </div>`).join('')
    : '';

  app.innerHTML = `
    ${toSettle.length ? `<div class="card" style="border-color:rgba(255,200,61,.55);background:linear-gradient(180deg,rgba(255,200,61,.06),transparent)">
      <div class="cardhead"><h2>Full time 🏁 Settle up</h2></div>
      ${toSettle.slice(0, 3).map((b) => `
        <div class="riv-row" data-settle="${esc(b.id)}" role="button" tabindex="0" style="cursor:pointer">
          <div><div class="nm">${esc(b.home)} <span style="color:var(--purple);font-family:Anton,sans-serif">v</span> ${esc(b.away)}</div>
          <div class="sm">${b.pending ? 'Your mate reported the result — confirm it' : 'Match finished — report the result'}${b.opponent ? ' · vs ' + esc(b.opponent) : ''}</div></div>
          <button class="linkbtn" data-settle="${esc(b.id)}" style="font-weight:800;color:var(--gold)">${b.pending ? 'Confirm ✓' : 'Report →'}</button>
        </div>`).join('')}
      <p class="sub" style="margin:8px 0 0">Unsettled duels never reach the record. Thirty seconds, on it goes.</p>
    </div>` : ''}
    ${!isNew && terrace.length ? (() => { const hp = terrace[0]; return `<div class="card" style="border-color:rgba(255,200,61,.5);background:linear-gradient(180deg,rgba(255,200,61,.07),transparent)">
      <div class="sm" style="color:var(--gold);font-weight:800;letter-spacing:1px;font-size:11px">📣 LATEST FROM THE TERRACE</div>
      <div style="font-family:Anton,sans-serif;font-size:24px;line-height:1.25;margin:8px 0 6px">“${esc(hp.text)}”</div>
      <div class="sm" style="color:var(--muted)">— ${esc(hp.by)}${hp.bot ? ' <span class="tag-rival">house bot 🤖</span>' : ` (${esc(hp.record)}${hp.streakType === 'W' && hp.streakCount >= 2 ? ' · 🔥' + hp.streakCount : ''})`} · ${timeAgo(hp.t)}</div>
      <div style="display:flex;gap:10px;margin-top:12px">
        <button class="cta" data-correct="${esc(hp.by)}" style="flex:1">🗣️ That's nonsense →</button>
        <button class="cta commit" data-punish="${esc(hp.by)}" style="flex:1">⚔️ Make them back it</button>
      </div>
    </div>`; })() : ''}
    ${!isNew && activity.length > 1 ? `<div class="ticker"><div class="ticker-track">${(activity.concat(activity)).map((a) => `<span class="tk">⚡ ${esc(a.text)}</span>`).join('')}</div></div>` : ''}
    ${(() => { const mineOff = m ? arena.filter((c) => c.proposerId === m.id && c.offers > 0) : [];
      return mineOff.length ? `<div class="card" style="border-color:rgba(124,58,237,.55)">
      <div class="cardhead"><h2>💬 Counter-offers waiting</h2></div>
      ${mineOff.map((c) => `<div class="riv-row" data-golisting="${esc(c.id)}" role="button" tabindex="0" style="cursor:pointer"><div><div class="nm">${esc(c.home)} <span style="color:var(--purple);font-family:Anton,sans-serif">v</span> ${esc(c.away)}</div><div class="sm">${c.offers} offer${c.offers === 1 ? '' : 's'} on your listing — someone wants different terms</div></div><button class="linkbtn" data-golisting="${esc(c.id)}" style="font-weight:800">Review →</button></div>`).join('')}
    </div>` : ''; })()}
    ${m && (s.w + s.l + (s.rivalries || []).length) > 0 && typeof Notification !== 'undefined' && Notification.permission === 'default' && !localStorage.getItem('clashly_push_dismissed') ? `<div class="banner" style="border-style:solid;border-color:rgba(124,58,237,.4);text-align:left;display:flex;justify-content:space-between;align-items:center;gap:10px"><span>🔔 Know the second your bet resolves or someone counters.</span><button class="linkbtn" id="pushOn" style="flex:none;font-weight:800">Turn on</button><button class="linkbtn" id="pushNo" style="flex:none;color:var(--muted)">✕</button></div>` : ''}
    ${m && (s.w + s.l) > 0 && !s.hasEmail ? `<div class="banner" style="border-style:solid;border-color:rgba(20,224,200,.4);text-align:left;display:flex;justify-content:space-between;align-items:center;gap:10px"><span>🛡️ Protect your ${s.w}–${s.l} record — link your email so it survives any device.</span><button class="linkbtn" id="linkAcct" style="flex:none;font-weight:800">Link it →</button></div>` : ''}
    ${isNew ? `<div class="card" style="border-color:rgba(20,224,200,.4)">
      <h2>Duel #1 👋</h2>
      <p class="sub" style="margin:2px 0 10px">Pick a match, back yourself, send the link. Your mate takes the other side and the record starts.</p>
      <div style="display:flex;flex-direction:column;gap:9px;margin-top:6px">
        <div style="display:flex;align-items:center;gap:10px;font-weight:800;color:var(--teal)"><span style="display:grid;place-items:center;width:24px;height:24px;border-radius:50%;background:var(--teal);color:#06140f;font-size:13px;font-weight:900">✓</span> Joined Clashly</div>
        <div style="display:flex;align-items:center;gap:10px;color:var(--muted);font-weight:700"><span style="display:grid;place-items:center;width:24px;height:24px;border-radius:50%;border:1.5px solid var(--line);font-size:12px">2</span> Back a call &amp; set the stakes</div>
        <div style="display:flex;align-items:center;gap:10px;color:var(--muted);font-weight:700"><span style="display:grid;place-items:center;width:24px;height:24px;border-radius:50%;border:1.5px solid var(--line);font-size:12px">3</span> Fire the link — a mate takes the other side</div>
      </div>
      <button class="cta commit" id="firstBet" style="margin-top:16px">⚔️ Challenge a mate →</button>
      ${arena.filter((c) => !m || c.proposerId !== m.id).length ? `<button class="ghost" id="firstTake" style="width:100%;margin-top:8px">🛒 Or take a live bet from the Arena</button>` : ''}
    </div>` : ''}
    ${hot ? `<div class="card hero-duel">
      <div class="cardhead"><h2>Unfinished business ⚔️</h2></div>
      <div class="rivalry" style="margin-top:2px"><div><div class="vsline">${hotLine}</div><div class="sm" style="color:var(--muted);font-size:12px">${hot.w + hot.l} duels in — settle the score</div></div><div class="score ${hot.w > hot.l ? 'lead' : hot.w < hot.l ? 'trail' : 'level'}">${hot.w}–${hot.l}</div></div>
      <button class="cta commit" data-rematch="${esc(hot.opponent)}" style="margin-top:12px">Settle it with ${esc(hot.opponent)} →</button>
      ${!lg.leagues.length ? `<button class="muted-link" id="escalateLeague">Start a league with ${esc(hot.opponent)} + the group →</button>` : ''}
    </div>` : ''}
    ${isNew ? '' : `<div class="card">
      <div class="cardhead"><h2>Your season</h2><span class="flame ${onFire ? 'on' : ''}">${onFire ? '🔥 ' + s.streak.count + ' in a row' : ''}</span></div>
      <div class="stats">
        <div class="stat"><div class="n">${s.w}–${s.l}</div><div class="k">Record</div></div>
        <div class="stat"><div class="n ${netClass}">${netTxt(s.net, s.currency)}</div><div class="k">Net</div></div>
        <div class="stat"><div class="n gold">${streakTxt}</div><div class="k">Streak</div></div>
      </div>
      ${!hideStreaks && s.platformRecord ? `<div class="banner" style="margin:10px 0 0;border-style:solid;border-color:rgba(255,200,61,.3)">🏆 Clashly record: <b style="color:var(--gold)">${esc(s.platformRecord.name)}'s ${s.platformRecord.count}-win streak</b>${s.streak.type === 'W' && s.streak.count >= s.platformRecord.count ? " — that's you. Defend it." : ' — beat it.'}</div>` : ''}
      <button class="cta commit" id="challenge">⚔️ Challenge a mate</button>
    </div>`}

    <div class="card">
      <div class="cardhead"><h2>The Terrace 📣</h2><span class="sm" style="color:var(--muted);font-size:12px">say it to everyone</span></div>
      <div class="reacts" id="terrChips" style="margin:6px 0 6px">
        <button type="button" class="react-chip" data-terr="Nobody in this app knows ball. Prove me wrong 😤">😤 rage bait</button>
        <button type="button" class="react-chip" data-terr="Free Arena points on my open challenge — if you dare 🌍">🌍 call-out</button>
        <button type="button" class="react-chip" data-terr="My record speaks for itself. Who's next? 👑">👑 flex</button>
      </div>
      <div style="display:flex;gap:8px;align-items:center;margin-bottom:8px">
        <input id="terrIn" maxlength="180" placeholder="Announce it to all of Clashly…" style="flex:1" />
        <button class="linkbtn" id="terrGo" style="font-weight:800;flex:none">Post</button>
      </div>
      <div style="max-height:320px;overflow-y:auto">
      ${terrace.length ? terrace.slice(0, isNew ? 3 : 25).map((p) => `
        <div class="recent" data-correct="${esc(p.by)}" role="button" tabindex="0" style="align-items:flex-start;cursor:pointer">
          <span style="min-width:0"><b style="color:var(--text)">${esc(p.by)}</b> <span style="color:var(--muted-2);font-size:11.5px">${p.bot ? 'house bot 🤖' : esc(p.record) + (p.streakType === 'W' && p.streakCount >= 2 ? ' · 🔥' + p.streakCount : '')} · ${timeAgo(p.t)}</span><br/>${esc(p.text)}</span>
        </div>`).join('') : '<p class="sub" style="margin:8px 0 0">Silence on the terrace. Someone say something spicy. 🌶️</p>'}
      </div>
    </div>


    ${!isNew && big.length ? `<div class="card">
      <div class="cardhead"><h2>Big games coming up 🔥</h2></div>
      ${big.map((g) => `
        <div class="riv-row" data-callit="${esc(g.id)}" role="button" tabindex="0" style="cursor:pointer">
          <div>
            <div class="nm">${esc(g.home)} <span style="color:var(--purple);font-family:Anton,sans-serif">v</span> ${esc(g.away)}</div>
            <div class="sm">${esc(g.competition || 'Match')} · ${kickoffTxt(g.utcDate)}</div>
          </div>
          <button class="linkbtn" data-callit="${esc(g.id)}" style="font-weight:800">Call it →</button>
        </div>`).join('')}
    </div>` : ''}



    <div class="card" style="border-color:rgba(124,58,237,.45)">
      <div class="cardhead"><h2>The Arena ⚡</h2><button class="linkbtn" id="arenaAll">See all →</button></div>
      <p class="sub" style="margin:2px 0 0">Open bets from all of Clashly, listed like a marketplace. Take one, win it, bank <b style="color:var(--gold)">+3 points</b>.${s.arenaPts ? ` You have <b style=\"color:var(--gold)\">\u26a1 ${s.arenaPts}</b>.` : ''}</p>
      ${(() => { const open = arena.filter((c) => !m || c.proposerId !== m.id); const mine = arena.length - open.length;
        return (open.length ? `<div class="market">${open.slice(0, isNew ? 2 : 4).map(arenaItemCard).join('')}</div>` : '<p class="sub" style="margin:8px 0 0">No open challenges right now — throw the first glove. 🥊</p>')
          + (mine > 0 ? `<p class="sub" style="margin:8px 0 0">Your open challenge is live in the Arena — waiting for a taker. 👀</p>` : ''); })()}
      ${isNew ? '' : `<button class="cta" id="arenaPost" style="margin-top:12px">🌍 Post an open challenge</button>`}
    </div>

    ${isNew ? '' : `<div class="card">
      <h2>Rivalries</h2>
      ${rivalriesHtml}
    </div>`}


    ${motw ? `<div class="card motw"><div class="cardhead"><h2>🏟️ Match of the Week</h2></div><div class="nm" style="font-family:Anton,sans-serif;font-size:19px;letter-spacing:.3px;margin:4px 0 2px">${esc(motw.home)} <span style="color:var(--purple-text)">v</span> ${esc(motw.away)}</div><div class="sm" style="color:var(--muted);font-size:12.5px">${esc(motw.competition || '')}${motw.utcDate ? ' · ' + kickoffTxt(motw.utcDate) : ''} · everyone's calling this one</div><button class="cta" id="motwCall" style="margin-top:12px">Make your call →</button></div>` : ''}

    ${s.forfeits && s.forfeits.length ? `<div class="card"><div class="cardhead"><h2>Unpaid forfeits 🧾</h2></div>${s.forfeits.map((f) => `
      <div class="riv-row" data-bet="${esc(f.betId)}" role="button" tabindex="0" style="cursor:pointer">
        <div><div class="nm">${f.owedByMe ? 'You owe ' + esc(f.to) : esc(f.from) + ' owes you'}</div><div class="sm">“${esc(f.line)}”${f.since ? ' · since ' + new Date(f.since).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : ''}</div></div>
        ${f.owedByMe ? `<span class="sm" style="color:var(--muted)">Make it right →</span>` : `<button class="linkbtn" data-collect="${esc(f.betId)}" data-cfrom="${esc(f.from)}" data-cline="${esc(f.line)}" style="font-weight:800;color:var(--gold)">Collect →</button>`}
      </div>`).join('')}<p class="sub" style="margin:10px 0 0">Clashly never forgets a forfeit. Settle it and mark the duel sorted.</p></div>` : ''}

    ${s.recent && s.recent.length >= 2 ? `<div class="card"><div class="cardhead"><h2>My form 📋</h2></div><div class="gw-strip">${s.recent.slice(0, 7).map((r) => r.won ? '🟩' : '🟥').reverse().join('')}</div><button class="ghost" id="gwCopy">Copy for the group chat 📋</button></div>` : ''}

    ${recentHtml ? `<div class="card"><h2>Recent</h2>${recentHtml}</div>` : ''}

    ${isNew ? '' : `<div class="banner">${s.net == null ? "You're " + s.w + '–' + s.l + ' this season' : "You're net <b style=\"color:var(--text)\">" + netTxt(s.net, s.currency) + '</b> this season'} — settle up with your mates and run it back.</div>`}`;

  app.querySelectorAll('[data-settle]').forEach((el) => el.addEventListener('click', (e) => { e.stopPropagation(); track('settle_card_tap'); history.pushState({}, '', '/b/' + el.dataset.settle); renderBet(el.dataset.settle); }));
  const chBtn = $('#challenge'); if (chBtn) chBtn.addEventListener('click', () => { PREFILL = null; renderCreate(); });
  const mc = $('#motwCall'); if (mc) mc.addEventListener('click', () => { track('motw_tap'); PREFILL = { matchId: motw.id }; renderCreate(); });
  app.querySelectorAll('[data-collect]').forEach((b) => b.addEventListener('click', (e) => {
    e.stopPropagation(); track('forfeit_collect');
    const link = location.origin + '/b/' + b.dataset.collect;
    shareLink(link, `Oi ${b.dataset.cfrom} — still outstanding: “${b.dataset.cline}” 🧾 The receipt says it all 👇`);
  }));
  app.querySelectorAll('[data-bet]').forEach((el) => el.addEventListener('click', () => { history.pushState({}, '', '/b/' + el.dataset.bet); renderBet(el.dataset.bet); }));
  const gw = $('#gwCopy'); if (gw) gw.addEventListener('click', async () => {
    const strip = s.recent.slice(0, 7).map((r) => r.won ? '🟩' : '🟥').reverse().join('');
    const txt = `My form on Clashly: ${strip} (${s.w}W–${s.l}L). Fancy your chances? clashly.live`;
    try { await navigator.clipboard.writeText(txt); sfx('clip'); toast('Copied — paste it in the chat'); track('gw_copy'); }
    catch { toast(txt); }
  });
  const fb = $('#firstBet'); if (fb) fb.addEventListener('click', () => { PREFILL = null; renderCreate(); });
  const ft = $('#firstTake'); if (ft) ft.addEventListener('click', () => { track('first_take_tap'); history.pushState({}, '', '/arena'); route(); });
  const la = $('#linkAcct'); if (la) la.addEventListener('click', () => { track('link_nudge_tap'); history.pushState({}, '', '/profile'); route(); });
  const po = $('#pushOn'); if (po) po.addEventListener('click', async () => { track('push_optin_tap'); const ok = await enablePush(); toast(ok ? 'Notifications on 🔔' : 'Could not enable notifications'); renderHome(); });
  const pn = $('#pushNo'); if (pn) pn.addEventListener('click', () => { try { localStorage.setItem('clashly_push_dismissed', '1'); } catch {} renderHome(); });
  app.querySelectorAll('[data-golisting]').forEach((el) =>
    el.addEventListener('click', (e) => { e.stopPropagation(); history.pushState({}, '', '/b/' + el.dataset.golisting); renderBet(el.dataset.golisting); }));
  app.querySelectorAll('[data-arena]').forEach((el) =>
    el.addEventListener('click', (e) => { e.stopPropagation(); track('arena_tap', { bet: el.dataset.arena }); history.pushState({}, '', '/b/' + el.dataset.arena); renderBet(el.dataset.arena); }));
  const ap = $('#arenaPost'); if (ap) ap.addEventListener('click', () => { PREFILL = { arena: true }; renderCreate(); });
  const aa = $('#arenaAll'); if (aa) aa.addEventListener('click', () => { history.pushState({}, '', '/arena'); route(); });
  app.querySelectorAll('[data-correct]').forEach((b) => b.addEventListener('click', (e) => { e.stopPropagation(); const ti = $('#terrIn'); if (ti) { ti.value = '@' + b.dataset.correct + ' '; ti.focus(); ti.scrollIntoView({ behavior: 'smooth', block: 'center' }); haptic(8); } }));
  app.querySelectorAll('[data-punish]').forEach((b) => b.addEventListener('click', (e) => { e.stopPropagation(); PREFILL = { opponent: b.dataset.punish }; renderCreate(); }));
  const tGo = $('#terrGo'), tIn = $('#terrIn');
  if (tGo && tIn) {
    const post = async () => { const v = tIn.value.trim(); if (v.length < 2) return toast('Say something worth saying'); tGo.disabled = true;
      try { await api('/terrace', { method: 'POST', body: JSON.stringify({ text: v }) }); track('terrace_post'); haptic(10); sfx('pop'); renderHome(); }
      catch (e) { toast(e.message); tGo.disabled = false; } };
    tGo.addEventListener('click', post);
    tIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); post(); } });
    app.querySelectorAll('[data-terr]').forEach((c) => c.addEventListener('click', () => { tIn.value = c.dataset.terr; haptic(6); tIn.focus(); }));
  }
  app.querySelectorAll('[data-callit]').forEach((el) =>
    el.addEventListener('click', (e) => { e.stopPropagation(); track('big_game_tap', { match: el.dataset.callit }); PREFILL = { matchId: el.dataset.callit }; renderCreate(); }));
  app.querySelectorAll('[data-rivid]').forEach((row) =>
    row.addEventListener('click', (e) => { if (e.target.closest('[data-rematch]')) return; openRivalrySheet(row.dataset.rivid, row.dataset.rivname); }));
  app.querySelectorAll('[data-rematch]').forEach((b) =>
    b.addEventListener('click', () => { PREFILL = { opponent: b.dataset.rematch }; renderCreate(); }));
  const nl0 = $('#newLeague'); if (nl0) nl0.addEventListener('click', () => renderLeagueHub());
  const sl = $('#startLeague'); if (sl) sl.addEventListener('click', () => renderLeagueHub());
  const rw = $('#recWin'); if (rw) rw.addEventListener('click', () => { RECWIN = RECWIN === 'week' ? 'all' : 'week'; renderHome(); });
  const el2 = $('#escalateLeague'); if (el2) el2.addEventListener('click', () => renderLeagueHub(`The ${hot.opponent} derby`));
  app.querySelectorAll('[data-league]').forEach((b) =>
    b.addEventListener('click', () => { history.pushState({}, '', '/l/' + b.dataset.league); renderLeague(b.dataset.league); }));
}


// ---------------------------------------------------------------------------
// Arena — the full marketplace of open bets (browse like listings)
// ---------------------------------------------------------------------------
async function renderArena() {
  const my = ++_gen; const live = () => my === _gen;
  const m = me.get();
  const [arRes, sRes] = await Promise.allSettled([api('/arena'), api('/players/me/summary')]);
  if (!live()) return;
  const ar = arRes.status === 'fulfilled' ? arRes.value : null;
  const s = sRes.status === 'fulfilled' ? sRes.value : { arenaPts: 0 };
  const list = (ar && ar.challenges) || [];
  const recent = (ar && ar.recent) || [];
  const open = list.filter((c) => !m || c.proposerId !== m.id);
  const mine = list.filter((c) => m && c.proposerId === m.id);
  app.innerHTML = `
    <div class="card" style="border-color:rgba(124,58,237,.45)">
      <div class="cardhead"><h2>The Arena ⚡</h2>${s.arenaPts ? `<span class="flame on">⚡ ${s.arenaPts} pts</span>` : ''}</div>
      <p class="sub" style="margin:2px 0 0">Every card is a live bet waiting for an opponent. Take one, win it, bank <b style="color:var(--gold)">+3 Arena points</b> and climb the Ranking. 👑</p>
      ${open.length ? `<div class="market">${open.map(arenaItemCard).join('')}</div>` : '<p class="sub" style="margin:10px 0 0">No open challenges right now — throw the first glove. 🥊</p>'}
      ${mine.length ? `<p class="sub" style="margin:10px 0 0">📌 Yours, live in the Arena:</p><div class="market">${mine.map(arenaItemCard).join('')}</div>` : ''}
      <button class="cta commit" id="arenaPost" style="margin-top:14px">🌍 Post an open challenge</button>
      <button class="muted-link" id="homeLink">← Back to home</button>
    </div>
    ${recent.length ? `<div class="card"><div class="cardhead"><h2>Latest results 🏁</h2></div>${recent.map((r) => `
      <div class="recent"><span><b style="color:var(--text)">${esc(r.winner)}</b> beat ${esc(r.loser)}${r.arena ? ' ⚡' : ''} · <span style="color:var(--muted)">${esc(matchLabel(r))}</span></span><span class="res" style="color:var(--muted)">${esc(r.stakeLbl)}</span></div>`).join('')}</div>` : ''}`;
  app.querySelectorAll('[data-arena]').forEach((el) =>
    el.addEventListener('click', () => { track('arena_tap', { bet: el.dataset.arena }); history.pushState({}, '', '/b/' + el.dataset.arena); renderBet(el.dataset.arena); }));
  const ap = $('#arenaPost'); if (ap) ap.addEventListener('click', () => { PREFILL = { arena: true }; renderCreate(); });
  const hl = $('#homeLink'); if (hl) hl.addEventListener('click', () => { history.pushState({}, '', '/'); route(); });
}

// ---------------------------------------------------------------------------
// Leaderboard — rankings, weekly crowns, leagues
// ---------------------------------------------------------------------------
async function renderBoard() {
  const my = ++_gen; const live = () => my === _gen;
  const m = me.get();
  const [recRes, lgRes, sRes] = await Promise.allSettled([api('/records?window=' + RECWIN), api('/players/me/leagues'), api('/players/me/summary')]);
  if (!live()) return;
  const rec = recRes.status === 'fulfilled' ? recRes.value : null;
  const lg = lgRes.status === 'fulfilled' ? lgRes.value : { leagues: [] };
  const s = sRes.status === 'fulfilled' ? sRes.value : { arenaPts: 0 };
  const recRow = (ico, label, val) => val ? `<div class="recent"><span>${ico} ${label}</span><span class="res" style="color:var(--gold)">${val}</span></div>` : '';
  const crowns = rec ? [
    recRow('🔥', 'Hot streak', rec.streak && `${esc(rec.streak.name)} · ${rec.streak.count}W`),
    recRow('⚔️', 'Most duels', rec.mostDuels && `${esc(rec.mostDuels.name)} · ${rec.mostDuels.duels}`),
    recRow('🎯', 'Best record', rec.bestRecord && `${esc(rec.bestRecord.name)} · ${rec.bestRecord.w}-${rec.bestRecord.l}`),
    recRow('😅', 'Biggest bottle', rec.biggestBottle && `${esc(rec.biggestBottle.name)} · ${rec.biggestBottle.l} Ls`),
    recRow('👑', 'Arena crown', rec.arenaKing && `${esc(rec.arenaKing.name)} · ${rec.arenaKing.wins} arena W${rec.arenaKing.wins === 1 ? '' : 's'}`),
  ].join('') : '';
  const table = (rec && rec.table) || [];
  app.innerHTML = `
    <div class="card">
      <div class="cardhead"><h2>Player rankings 🏆</h2><button class="linkbtn" id="recWin">${RECWIN === 'week' ? 'This week ▾' : 'All time ▾'}</button></div>
      ${table.length ? table.map((r, i) => `
        <div class="recent"><span>${i === 0 ? '👑' : '#' + (i + 1)} <b style="color:var(--text)">${esc(r.name)}</b>${m && r.name === m.name ? ' <span class="tag-rival">you</span>' : ''}</span><span class="res" style="color:var(--gold)">${r.w}–${r.l}${r.arenaPts ? ' · ⚡' + r.arenaPts : ''}</span></div>`).join('')
        : `<p class="sub" style="margin:8px 0 0">No decided duels ${RECWIN === 'week' ? 'this week' : 'yet'} — the throne is empty. 👑</p>`}
      ${s.arenaPts ? `<div class="banner" style="margin-top:10px">⚡ Your Arena points: <b style="color:var(--gold)">${s.arenaPts}</b></div>` : ''}
    </div>
    <div class="card"><div class="cardhead"><h2>Weekly crowns</h2></div>${crowns || '<p class="sub" style="margin:8px 0 0">Play some duels and the crowns appear here.</p>'}</div>
    <div class="card">
      <div class="cardhead"><h2>My leagues</h2><button class="linkbtn" id="newLeague">+ New / join</button></div>
      ${lg.leagues.length ? lg.leagues.map((l) => `
        <div class="riv-row" data-league="${esc(l.code)}" role="button" tabindex="0" style="cursor:pointer">
          <div><div class="nm">${esc(l.name)}</div><div class="sm">${l.members} mates · ${l.rank ? "you're #" + l.rank + ' of ' + l.total : 'unranked'}</div></div>
          <div class="rec ${l.rank === 1 ? 'lead' : ''}">#${l.rank || '–'}</div>
        </div>`).join('') : `<p class="sub" style="margin:8px 0 0">One table for your whole group chat — every duel between members counts. 🏆</p><button class="cta" id="startLeague" style="margin-top:12px">Start a group league →</button>`}
    </div>`;
  const rw = $('#recWin'); if (rw) rw.addEventListener('click', () => { RECWIN = RECWIN === 'week' ? 'all' : 'week'; renderBoard(); });
  const nl = $('#newLeague'); if (nl) nl.addEventListener('click', () => renderLeagueHub());
  const sl = $('#startLeague'); if (sl) sl.addEventListener('click', () => renderLeagueHub());
  app.querySelectorAll('[data-league]').forEach((b) => b.addEventListener('click', () => { history.pushState({}, '', '/l/' + b.dataset.league); renderLeague(b.dataset.league); }));
}


// ---------------------------------------------------------------------------
// Duels tab — all your bets
// ---------------------------------------------------------------------------
async function renderDuels() {
  const my = ++_gen; const live = () => my === _gen;
  const m = me.get();
  let d = { active: [], history: [] };
  try { d = await api('/players/me/bets'); } catch {}
  const row = (b) => `
    <div class="recent" data-bet="${b.id}" role="button" tabindex="0" style="cursor:pointer">
      <span>${b.yourMove ? '<span class="pill accepted" style="margin-right:6px">your move</span>' : ''}${esc(matchLabel(b))}${b.opponent ? ' · <span style="color:var(--muted)">' + esc(b.opponent) + '</span>' : ''}</span>
      <span class="res ${b.won === true ? 'w' : b.won === false ? 'l' : ''}">${statusLabel(b)}</span>
    </div>`;
  // whatever needs YOUR action surfaces first — the open loop you came back to close
  const active = [...d.active].sort((a, b) => (b.yourMove === true) - (a.yourMove === true));
  app.innerHTML = `
    <div class="card">
      <div class="cardhead"><h2>Active duels ⚔️</h2><button class="linkbtn" id="newBet">+ New</button></div>
      ${active.length ? active.map(row).join('') : `<p class="sub" style="margin:8px 0 12px">No live duels.</p><button class="cta commit" id="emptyNewBet">⚔️ Challenge a mate</button>`}
    </div>
    ${d.history.length ? `<div class="card"><h2>Settled</h2>${d.history.map(row).join('')}</div>` : ''}`;
  $('#newBet').addEventListener('click', () => { PREFILL = null; renderCreate(); });
  const enb = $('#emptyNewBet'); if (enb) enb.addEventListener('click', () => { PREFILL = null; renderCreate(); });
  app.querySelectorAll('[data-bet]').forEach((el) => el.addEventListener('click', () => { history.pushState({}, '', '/b/' + el.dataset.bet); renderBet(el.dataset.bet); }));
}

// ---------------------------------------------------------------------------
// Profile tab — record, rivalries, identity
// ---------------------------------------------------------------------------
async function renderProfile() {
  const my = ++_gen; const live = () => my === _gen;
  let m = me.get();
  // players saved before founder numbers existed → refresh once to pick up seq
  if (m && m.seq == null) { try { const p = await api('/players/me'); me.save(p); m = p; } catch {} }
  let s;
  try { s = await api('/players/me/summary'); }
  catch { s = { w: 0, l: 0, net: 0, currency: 'EUR', streak: { type: null, count: 0 }, rivalries: [] }; }
  const netClass = s.net > 0 ? 'pos' : s.net < 0 ? 'neg' : '';
  const hideStreaks = prefs.get().hideStreaks;
  const streakTxt = (!hideStreaks && s.streak.count) ? `${s.streak.count}${s.streak.type}` : '—';
  const lang = (window.CLASHLY_I18N && window.CLASHLY_I18N.lang()) || 'en';
  const acct = m.email
    ? `<div class="card"><div class="cardhead"><h2>Account</h2><button class="linkbtn" id="signout">Sign out</button></div><p class="sub" style="margin:0">Signed in as <b style="color:var(--text)">${esc(m.email)}</b>${m.verified ? ' ✓' : ''}. Your record syncs to this account.</p></div>`
    : `<div class="card"><div class="cardhead"><h2>Account</h2></div><p class="sub" style="margin:0 0 10px">You're playing as a guest on this device. Save your record so it survives across devices.</p><button class="cta" id="signin">Sign in / create account</button></div>`;
  app.innerHTML = `
    <div class="card">
      <div class="cardhead"><h2>${esc(m.name)} ${m.seq ? `<span class="tag-rival" style="background:rgba(255,200,61,.18);color:var(--gold)">🔰 FOUNDER #${m.seq}</span>` : ''}</h2><button class="linkbtn" id="rename">Edit name</button></div>
      <div class="stats">
        <div class="stat"><div class="n">${s.w}–${s.l}</div><div class="k">Record</div></div>
        <div class="stat"><div class="n ${netClass}">${netTxt(s.net, s.currency)}</div><div class="k">Net</div></div>
        <div class="stat"><div class="n gold">${streakTxt}</div><div class="k">Streak</div></div>
      </div>
    </div>
    ${acct}
    <div class="card"><div class="cardhead"><h2>Settle up 💸</h2><button class="linkbtn" id="allDuels">⚔️ All my duels →</button></div>
      ${(s.rivalries || []).filter((r) => r.net).length ? (s.rivalries || []).filter((r) => r.net).map((r) => `<div class="recent" data-settlego="1" role="button" tabindex="0" style="cursor:pointer"><span>${esc(r.opponent)} <span style="color:var(--muted-2);font-size:11px">tap to settle →</span></span><span class="res ${r.net > 0 ? 'w' : 'l'}">${r.net > 0 ? 'owes you ' : 'you owe '}${sym(r.currency)}${Math.abs(r.net)}</span></div>`).join('') : '<p class="sub" style="margin:8px 0 0">All square — nobody owes anything. 🤝</p>'}
      <p class="sub" style="margin:10px 0 0;font-size:12px">Clashly holds no money — settle between yourselves (cash, BLIK, Revolut…) and mark the duel sorted.</p>
    </div>
    <div class="card"><div class="cardhead"><h2>Settings</h2></div><div class="checkrow" style="margin-top:6px"><input type="checkbox" id="langPl" ${lang === 'pl' ? 'checked' : ''} /><label for="langPl">🇵🇱 Polski interfejs (Polish interface)</label></div><div class="checkrow" style="margin-top:10px"><input type="checkbox" id="hideStreaks" ${hideStreaks ? 'checked' : ''} /><label for="hideStreaks">Hide streaks — no flame, no pressure</label></div><div class="checkrow" style="margin-top:10px"><input type="checkbox" id="sndFx" ${(window.SFX && window.SFX.on()) ? 'checked' : ''} /><label for="sndFx">🔊 Sound effects</label></div><div class="checkrow" style="margin-top:10px"><input type="checkbox" id="pushChk" ${typeof Notification !== 'undefined' && Notification.permission === 'granted' ? 'checked' : ''} /><label for="pushChk">🔔 Notifications (results, counter-offers)</label></div></div>
    <div class="card"><h2>Rivalries</h2>${s.rivalries.length
      ? s.rivalries.map((r) => `<div class="riv-row" data-rivid="${esc(r.opponentId)}" data-rivname="${esc(r.opponent)}" role="button" tabindex="0" style="cursor:pointer"><div><div class="nm">${esc(r.opponent)} ${r.isRival ? '<span class="tag-rival">Rival</span>' : ''}</div><div class="sm">${r.w + r.l} duel${r.w + r.l === 1 ? '' : 's'}</div></div><div class="rec ${r.w > r.l ? 'lead' : r.w < r.l ? 'trail' : ''}">${r.w}–${r.l}</div></div>`).join('')
      : '<p class="sub" style="margin:8px 0 0">No rivalries yet — challenge a mate.</p>'}</div>
    <div class="banner">${s.net == null ? "You're " + s.w + '–' + s.l : "You're net <b style=\"color:var(--text)\">" + netTxt(s.net, s.currency) + '</b>'} — settle up with your mates and run it back.</div>`;
  $('#rename').addEventListener('click', () => openRenameSheet(m.name));
  const ad = $('#allDuels'); if (ad) ad.addEventListener('click', () => { history.pushState({}, '', '/duels'); route(); });
  app.querySelectorAll('[data-settlego]').forEach((el) => el.addEventListener('click', () => { history.pushState({}, '', '/duels'); route(); }));
  const lp = $('#langPl'); if (lp) lp.addEventListener('change', () => { if (window.CLASHLY_I18N) window.CLASHLY_I18N.toggle(); });
  const so = $('#signout'); if (so) so.addEventListener('click', () => { me.clear(); localStorage.removeItem('settle_roles'); try { posthog.reset(); } catch {} renderHeader(); history.pushState({}, '', '/'); route(); });
  const si = $('#signin'); if (si) si.addEventListener('click', () => openLoginSheet(renderProfile));
  const hs = $('#hideStreaks'); if (hs) hs.addEventListener('change', () => { prefs.set('hideStreaks', hs.checked); renderProfile(); });
  const sx = $('#sndFx'); if (sx) sx.addEventListener('change', () => { if (window.SFX) window.SFX.toggle(); sfx('pop'); });
  const pc = $('#pushChk'); if (pc) pc.addEventListener('change', async () => { if (pc.checked) { const ok = await enablePush(); if (!ok) { pc.checked = false; toast('Blocked by the browser — allow notifications in site settings'); } else toast('Notifications on 🔔'); } else { toast('Turn off in your browser site settings'); pc.checked = true; } });
  app.querySelectorAll('[data-rivid]').forEach((row) =>
    row.addEventListener('click', () => openRivalrySheet(row.dataset.rivid, row.dataset.rivname)));
}

// ---------------------------------------------------------------------------
// Leagues — the scale layer
// ---------------------------------------------------------------------------
function renderLeagueHub(prefillName) {
  const m = me.get();
  app.innerHTML = `
    <div class="card">
      <h2>Leagues 🏆</h2>
      <p class="sub">Turn your group chat into a season-long table. Every bet between members feeds one leaderboard.</p>
      <label for="lname">Create a league</label>
      <input id="lname" placeholder="e.g. Sunday League" maxlength="50" value="${prefillName ? esc(prefillName) : ''}" />
      <button class="cta" id="createLeague">Create league →</button>
      <div style="height:8px"></div>
      <label for="lcode">…or join with a code</label>
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

async function renderLeague(code, full) {
  const my = ++_gen; const live = () => my === _gen;
  app.innerHTML = '<div class="spin">Loading…</div>';
  const m = me.get();
  let lg;
  try { lg = await api('/leagues/' + code); }
  catch (e) {
    if (e.status === 404) { app.innerHTML = `<div class="card"><h2>League not found</h2><p class="sub">This invite looks broken or expired.</p><button class="cta" onclick="location.href='/'">Go to Clashly</button></div>`; return; }
    app.innerHTML = `<div class="card"><h2>Can't reach Clashly</h2><p class="sub">Looks like a connection blip — the league's still there.</p><button class="cta" id="retryLg">Try again</button></div>`;
    $('#retryLg').addEventListener('click', () => renderLeague(code, full));
    return;
  }

  const isMember = m && lg.members.some((x) => x.id === m.id);
  const link = location.origin + '/l/' + code;

  if (!isMember) {
    // social proof before the join wall: who invited you + the live top of the table
    const preview = (lg.standings || []).slice(0, 3).map((r) => `
      <div class="lg-row"><div class="lg-rank">${r.rank}</div><div class="lg-name">${esc(r.name)}${r.rank === 1 && r.games ? ' 👑' : ''}</div><div class="lg-rec">${r.w}-${r.l}</div><div class="lg-net"></div></div>`).join('');
    app.innerHTML = `
      <div class="card">
        <div class="cardhead"><h2>Join ${esc(lg.name)} 🏆</h2></div>
        <p class="sub">${lg.createdBy ? `Started by <b style="color:var(--text)">${esc(lg.createdBy)}</b> · ` : ''}${lg.members.length} mate${lg.members.length === 1 ? '' : 's'} settling football calls in one league. Climb the table.</p>
        ${preview ? `<div class="lg-head"><div class="lg-rank">#</div><div class="lg-name">Player</div><div class="lg-rec">W-L</div><div class="lg-net"></div></div>${preview}` : `<img class="cardimg" src="/lcard/${code}.svg" alt="League invite" />`}
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
  const myIdx = rows.findIndex((r) => m && r.id === m.id);
  // relative "your neighbourhood" view (you ±2) — an absolute table demotivates everyone
  // outside the top few; a peer band that shows movement keeps the whole league engaged.
  const canSlice = myIdx >= 0 && rows.length > 6;
  let viewRows = rows;
  if (canSlice && !full) {
    const start = Math.max(0, Math.min(myIdx - 2, rows.length - 5));
    viewRows = rows.slice(start, start + 5);
  }
  let gapLine = '';
  if (myIdx > 0) {
    const above = rows[myIdx - 1];
    const wd = above.w - rows[myIdx].w;
    gapLine = wd <= 0 ? `Level with ${esc(above.name)} for #${above.rank} — edge ahead` : `${wd} win${wd === 1 ? '' : 's'} behind ${esc(above.name)} for #${above.rank}`;
  } else if (myIdx === 0 && rows[0].games) {
    gapLine = `Top of the table 👑 — defend it`;
  }
  const tbl = viewRows.map((r) => `
    <div class="lg-row ${m && r.id === m.id ? 'me' : ''}">
      <div class="lg-rank">${r.rank}</div>
      <div class="lg-name">${esc(r.name)}${r.rank === 1 && r.games ? ' 👑' : ''}</div>
      <div class="lg-rec">${r.w}-${r.l}</div>
      <div class="lg-net ${r.net > 0 ? 'pos' : r.net < 0 ? 'neg' : ''}">${netTxt(r.net, r.currency)}</div>
    </div>`).join('');
  const waText = `Join our Clashly league "${lg.name}" 🏆 — settle football bets, climb the table.`;

  const solo = lg.members.length === 1;
  app.innerHTML = `
    <div class="card">
      <div class="cardhead"><h2>${esc(lg.name)} 🏆</h2><span class="pill resolved">${lg.members.length} mate${lg.members.length === 1 ? '' : 's'}</span></div>
      ${solo ? `<div class="banner" style="margin:2px 0 10px;border-style:solid;border-color:rgba(255,200,61,.4);text-align:left">👑 A table of one wins nothing. Send the link and the season starts when the first mate joins.</div>
      <button class="cta wa" id="inviteTop">Send it to the group 📲</button>` : ''}
      ${gapLine ? `<div class="banner" style="margin:2px 0 10px;border-style:solid;border-color:rgba(20,224,200,.3);color:var(--text)">${gapLine}</div>` : ''}
      ${lg.banter ? `<div class="banner" style="margin:0 0 10px">⚔️ Fiercest rivalry: <b style="color:var(--text)">${esc(lg.banter.a)} v ${esc(lg.banter.b)}</b> · ${lg.banter.games} duels</div>` : ''}
      <div class="lg-head"><div class="lg-rank">#</div><div class="lg-name">Player</div><div class="lg-rec">W-L</div><div class="lg-net">Net</div></div>
      ${tbl}
      ${canSlice ? `<button class="muted-link" id="toggleTable">${full ? 'Show just my spot' : 'Show full table →'}</button>` : ''}
      <button class="cta commit" id="challenge">⚔️ Challenge a mate</button>
      ${solo ? '' : '<button class="cta gold" id="sendTable">📲 Send the table to the group</button>'}
      ${solo ? '' : '<button class="cta wa" id="invite">Invite mates on WhatsApp</button>'}
      <button class="ghost" id="copyInvite">Copy invite link</button>
      <button class="muted-link" id="homeLink">Back to my season</button>
    </div>
    <div class="banner">League table counts bets between members only. Win to climb. 🪜</div>`;
  $('#challenge').addEventListener('click', () => { PREFILL = null; renderCreate(); });
  const st0 = $('#sendTable');
  if (st0) st0.addEventListener('click', () => {
    const top = (lg.standings || []).find((r) => r.games);
    shareImage('/ltable/' + code + '.png',
      top ? `${lg.name} as it stands — ${top.name} on top. Get involved: ${link}` : `${lg.name} on Clashly — ${link}`,
      'table');
  });
  const iv = $('#invite'); if (iv) iv.addEventListener('click', () => { track('league_invite_tap'); window.open('https://wa.me/?text=' + encodeURIComponent(waText + ' ' + link), '_blank'); });
  const it = $('#inviteTop'); if (it) it.addEventListener('click', () => { track('league_invite_tap', { solo: true }); shareLink(link, waText); });
  $('#copyInvite').addEventListener('click', async () => { try { await navigator.clipboard.writeText(link); sfx('clip'); toast('Invite copied'); } catch { toast(link); } });
  const tt = $('#toggleTable'); if (tt) tt.addEventListener('click', () => renderLeague(code, !full));
  $('#homeLink').addEventListener('click', () => { history.pushState({}, '', '/'); route(); });
}

// ---------------------------------------------------------------------------
// Create a bet
// ---------------------------------------------------------------------------
async function renderCreate() {
  const m = me.get();
  // the sheet opens INSTANTLY; fixtures stream in (the primary tap must never feel dead)
  let matches = [], live = false;
  const matchesP = api('/matches').catch(() => null);
  const copy = PREFILL?.copy;
  const terms = copy || PREFILL?.terms; // last duel's line/stake carry into a rematch
  const state = { backedOutcome: copy?.backedOutcome || 'HOME' };
  const rematchOf = PREFILL?.opponent;

  openSheet(`
    <div class="sheet-handle"></div>
    <div class="sheet-head"><h2>${rematchOf ? 'Rematch ' + esc(rematchOf) + ' ⚔️' : copy ? 'Run it back 🔁' : 'Start a duel 🤝'}</h2><button class="sheet-x" id="sheetClose">✕</button></div>
    <div class="sheet-body">
      <p class="sub" style="margin:2px 0 12px">${rematchOf ? 'Winner takes the bragging rights and the lead.' : 'Set the terms, send the link — you settle up between yourselves.'}</p>
      <label for="matchSel">The match</label>
      <select id="matchSel"></select>
      <div id="customWrap" style="display:none"><div class="row"><div><label>Home team</label><input id="home" placeholder="Spain" maxlength="40" /></div><div><label>Away team</label><input id="away" placeholder="Uruguay" maxlength="40" /></div></div></div>
      <div id="seasonWrap" style="display:none">
        <label for="claim">The call</label>
        <input id="claim" maxlength="80" placeholder="Arsenal finish above Spurs" />
        <div class="reacts" style="margin-top:8px">
          <button type="button" class="react-chip" data-claim="Arsenal finish above Spurs">finish above</button>
          <button type="button" class="react-chip" data-claim="Man United sack their manager before Christmas">sacked by Xmas</button>
          <button type="button" class="react-chip" data-claim="Haaland is the top scorer">top scorer</button>
          <button type="button" class="react-chip" data-claim="We get relegated">relegation</button>
        </div>
        <label for="deadline" style="margin-top:10px">Settle by (optional)</label>
        <input id="deadline" type="date" />
      </div>
      <label>What are you backing?</label>
      <div class="seg" id="seg"></div>
      <label for="lineInput">What's on the line?</label>
      <input id="lineInput" maxlength="60" placeholder="e.g. loser buys the pints" value="${terms?.line ? esc(terms.line) : (terms?.stake ? esc(sym(terms.currency || 'EUR') + terms.stake) : '')}" />
      <div class="reacts" style="margin-top:8px">
        <button type="button" class="react-chip" data-line="Loser buys the pints 🍺">🍺 pints</button>
        <button type="button" class="react-chip" data-line="Loser wears the winner's shirt 👕">👕 the shirt</button>
        <button type="button" class="react-chip" data-line="Winner picks the forfeit 😈">😈 forfeit</button>
        <button type="button" class="react-chip" data-line="€10">€10</button>
      </div>
      <label for="note">Trash talk (optional)</label>
      <div class="reacts" id="banterChips" style="margin:0 0 8px"></div>
      <input id="note" placeholder="No chance they keep it close 😏" maxlength="140" value="${copy?.note ? esc(copy.note) : ''}" />
      <div class="checkrow" style="margin-top:14px">
        <input type="checkbox" id="arenaChk" />
        <label for="arenaChk">🌍 <b>Open challenge</b> — list it in the Arena so <b>anyone</b> on Clashly can take the other side. Beat a stranger, bank <b style="color:var(--gold)">+3 Arena points</b>.</label>
      </div>
      <div class="banner" style="margin-top:14px;text-align:left"><span id="previewLine">…</span></div>
      <div class="banner" id="fixSrc" style="margin-top:8px">⏳ Loading fixtures…</div>
    </div>
    <div class="sheet-foot"><button class="cta commit" id="createBtn">Lock it in & get link →</button><div style="text-align:center;font-size:11.5px;color:var(--muted-2);margin-top:8px">Hold to lock — no backing out after.</div></div>
  `);

  // banter chips — tap-to-talk suggestions (rotates daily; tap fills the note)
  const BANTER = ["no chance they keep it close", "you know nothing about ball", "printing bragging rights today", "your lot bottle it every time", "easy work. always has been", "I'll even give you a head start", "book the excuses now", "study the game, then come back"];
  const bc = $('#banterChips');
  if (bc) {
    const d0 = new Date().getDate() % BANTER.length;
    bc.innerHTML = [0, 1, 2].map((i) => BANTER[(d0 + i) % BANTER.length]).map((c) => `<button type="button" class="react-chip" data-chip="${esc(c)}">${esc(c)}</button>`).join('');
    bc.querySelectorAll('[data-chip]').forEach((b) => b.addEventListener('click', () => { const n = $('#note'); if (n) { n.value = b.dataset.chip; haptic(6); } }));
  }

  const sel = $('#matchSel');
  const CUSTOM_OPT = '<option value="custom">+ Custom match…</option><option value="season">🗓️ Season-long call…</option>';
  sel.innerHTML = '<option value="" disabled selected>⏳ Loading fixtures…</option>' + CUSTOM_OPT;

  // "€10" / "10 gbp" / "£5" reads as a money stake; anything else is a forfeit line
  const parseLine = (raw) => {
    const t = String(raw || '').trim();
    const mny = t.match(/^([€£$]?)\s*(\d+(?:[.,]\d{1,2})?)\s*(eur|gbp|usd|euro?s?|quid|pounds?|dollars?)?$/i);
    if (mny) {
      const symCur = { '€': 'EUR', '£': 'GBP', '$': 'USD' }[mny[1]] || null;
      const wordCur = mny[3] ? ({ e: 'EUR', q: 'GBP', p: 'GBP', g: 'GBP', u: 'USD', d: 'USD' }[mny[3][0].toLowerCase()] || 'EUR') : null;
      return { stake: Number(mny[2].replace(',', '.')), currency: symCur || wordCur || 'EUR', line: '' };
    }
    return { stake: 0, currency: 'EUR', line: t };
  };
  const updatePreview = () => {
    const mm = matches.find((x) => x.id === sel.value);
    const home = mm ? mm.home : ($('#home')?.value || 'Home');
    const away = mm ? mm.away : ($('#away')?.value || 'Away');
    const seasonMode = sel.value === 'season';
    const claim = seasonMode ? (($('#claim')?.value || '').trim() || 'your call') : '';
    const backedLbl = seasonMode ? `${claim} — ${state.backedOutcome === 'HOME' ? 'yes' : 'no chance'}`
      : state.backedOutcome === 'HOME' ? home + ' win' : state.backedOutcome === 'AWAY' ? away + ' win' : 'Draw';
    const compl = seasonMode ? (state.backedOutcome === 'HOME' ? "it doesn't happen" : 'it happens')
      : state.backedOutcome === 'DRAW' ? 'not a draw' : state.backedOutcome === 'HOME' ? home + " don't win" : away + " don't win";
    const p = parseLine($('#lineInput')?.value);
    const lineLbl = p.line || (p.stake > 0 ? sym(p.currency) + p.stake : 'bragging rights');
    const el = $('#previewLine');
    // both outcomes, honestly — real books only ever show the upside; showing the
    // downside too is DSA-safe AND funnier (the forfeit is half the banter)
    if (el) el.innerHTML =
      `<span style="display:flex;gap:8px;align-items:center;margin-bottom:4px"><span style="width:8px;height:8px;border-radius:50%;background:var(--gold);flex:none"></span> You back <b style="color:var(--text)">${esc(backedLbl)}</b></span>`
      + `<span style="display:flex;gap:8px;align-items:center"><span style="width:8px;height:8px;border-radius:50%;background:var(--purple);flex:none"></span> They take <b style="color:var(--text)">${esc(compl)}</b> · <b style="color:var(--green)">${esc(lineLbl)}</b> on it</span>`;
  };
  const renderSeg = () => {
    const mm = matches.find((x) => x.id === sel.value);
    const home = mm ? mm.home : ($('#home')?.value || 'Home');
    const away = mm ? mm.away : ($('#away')?.value || 'Away');
    const seg = $('#seg');
    // keyboard: the rebuild destroys the focused button — restore focus only when it
    // was inside the seg group (never hijack focus from the team inputs while typing)
    const hadFocus = seg.contains(document.activeElement) ? document.activeElement.dataset.o : null;
    const sides = sel.value === 'season'
      ? [['HOME', 'It happens ✅'], ['AWAY', "No chance ❌"]]
      : [['HOME', `${home} win`], ['DRAW', 'Draw'], ['AWAY', `${away} win`]];
    // a draw carried over from a match pick would be un-selectable here
    if (sel.value === 'season' && state.backedOutcome === 'DRAW') state.backedOutcome = 'HOME';
    seg.innerHTML = sides
      .map(([code, lbl]) => `<button data-o="${code}" class="${state.backedOutcome === code ? 'active' : ''}">${esc(lbl)}</button>`).join('');
    seg.querySelectorAll('button').forEach((btn) => btn.addEventListener('click', () => { state.backedOutcome = btn.dataset.o; haptic(8); renderSeg(); }));
    if (hadFocus) seg.querySelector(`[data-o="${hadFocus}"]`)?.focus();
    updatePreview();
  };
  const onMatchChange = () => {
    const season = sel.value === 'season';
    $('#customWrap').style.display = sel.value === 'custom' ? 'block' : 'none';
    $('#seasonWrap').style.display = season ? 'block' : 'none';
    // a season call has no kickoff to wait for, so it can't be an Arena listing
    // a stranger stumbles onto months later — keep it between mates
    const ar = $('#arenaChk')?.closest('.checkrow');
    if (ar) ar.style.display = season ? 'none' : '';
    renderSeg();
  };
  sel.addEventListener('change', onMatchChange);
  $('#home').addEventListener('input', renderSeg);
  $('#away').addEventListener('input', renderSeg);
  const cl = $('#claim'); if (cl) cl.addEventListener('input', updatePreview);
  document.querySelectorAll('#sheetPanel [data-claim]').forEach((chip) =>
    chip.addEventListener('click', () => { const c = $('#claim'); if (c) { c.value = chip.dataset.claim; haptic(8); updatePreview(); } }));
  $('#lineInput').addEventListener('input', updatePreview);
  document.querySelectorAll('#sheetPanel [data-line]').forEach((chip) =>
    chip.addEventListener('click', () => { $('#lineInput').value = chip.dataset.line; haptic(8); updatePreview(); }));
  $('#sheetClose').addEventListener('click', closeSheet);
  const syncArenaUi = () => { const ac = $('#arenaChk'), cb = $('#createBtn'); if (ac && cb && !cb.disabled) cb.textContent = ac.checked ? '🌍 Lock it in & post to the Arena →' : 'Lock it in & get link →'; };
  const acEl = $('#arenaChk'); if (acEl) acEl.addEventListener('change', () => { haptic(8); syncArenaUi(); });
  if (PREFILL?.arena) { const ac = $('#arenaChk'); if (ac) ac.checked = true; syncArenaUi(); }

  if (copy) { sel.value = 'custom'; $('#home').value = copy.home || ''; $('#away').value = copy.away || ''; }
  onMatchChange();
  matchesP.then((r) => {
    if (!document.getElementById('matchSel')) return; // sheet closed meanwhile
    if (r) { matches = r.matches; live = r.live; }
    const keep = sel.value === 'custom' ? 'custom' : null;
    sel.innerHTML = matches.map((mm) => `<option value="${mm.id}">${esc(mm.home)} vs ${esc(mm.away)}${mm.competition ? ' · ' + esc(mm.competition) : ''}</option>`).join('') + CUSTOM_OPT;
    if (keep) sel.value = keep;
    else if (PREFILL?.matchId && matches.some((x) => x.id === PREFILL.matchId)) sel.value = PREFILL.matchId;
    const src = $('#fixSrc'); if (src) src.textContent = live ? '🟢 Live fixtures' : '🟡 Demo fixtures';
    // one-tap from the Home "Big games" card → land with that fixture pre-picked
    onMatchChange();
  });

  const doCreate = async () => {
    const season = sel.value === 'season';
    const mm = matches.find((x) => x.id === sel.value);
    const home = season ? ($('#claim')?.value || '').trim() : (mm ? mm.home : $('#home').value.trim());
    const away = season ? '' : (mm ? mm.away : $('#away').value.trim());
    if (season && !home) return toast('What are you calling?');
    if (!season && (!home || !away)) return toast('Add both teams');
    const p = parseLine($('#lineInput').value);
    if (!p.line && !(p.stake > 0)) return toast("Put something on the line — a forfeit or a number");
    const btn = $('#createBtn'); btn.disabled = true; btn.textContent = 'Locking in…'; haptic(22);
    try {
      const bet = await api('/bets', { method: 'POST', body: JSON.stringify({
        home, away, kind: season ? 'season' : undefined,
        competition: season ? '' : (mm ? mm.competition : (copy?.competition || '')),
        utcDate: season ? ($('#deadline')?.value ? new Date($('#deadline').value + 'T21:00:00Z').toISOString() : null) : (mm ? mm.utcDate : null),
        externalId: season ? null : (mm ? mm.externalId || null : null),
        backedOutcome: state.backedOutcome, stake: p.stake, currency: p.currency, line: p.line, note: $('#note').value.trim(), arena: Boolean($('#arenaChk')?.checked), rematch: Boolean(rematchOf || copy),
      }) });
      roleStore.set(bet.id, 'proposer'); PREFILL = null;
      try { sessionStorage.setItem('duely_stamp', bet.id); } catch {}
      track('bet_created', { stake: p.stake, forfeit: Boolean(p.line) });
      closeSheet();
      history.pushState({}, '', '/b/' + bet.id); renderBet(bet.id);
    } catch (e) { toast(e.message); btn.disabled = false; syncArenaUi(); if (!$('#arenaChk')?.checked) btn.textContent = 'Lock it in & get link →'; }
  };
  armHold($('#createBtn'), doCreate);
}

// brief "locked in" seal animation between commit and next screen
function sealThen(next, sub) {
  sfx('sig');
  app.innerHTML = `<div class="card"><div class="sealwrap"><div class="seal">🔒</div><h2 style="text-align:center">Locked in</h2>${sub ? `<p class="sub" style="text-align:center;margin:8px 0 0">${sub}</p>` : ''}</div></div>`;
  if (sub) { try { confetti(1); haptic([10, 40, 16]); } catch {} }
  setTimeout(next, sub ? 1100 : 720);
}

// ---------------------------------------------------------------------------
// A specific bet
// ---------------------------------------------------------------------------
async function renderBet(id, opts = {}) {
  const my = ++_gen; const live = () => my === _gen;
  app.innerHTML = '<div class="spin">Loading…</div>';
  let bet;
  try { bet = await api('/bets/' + id); }
  catch (e) {
    if (!live()) return; // a newer navigation superseded this render
    if (e.status === 404) { app.innerHTML = `<div class="card"><h2>Bet not found</h2><p class="sub">This link looks broken or expired.</p><button class="cta" onclick="location.href='/'">Go to Clashly</button></div>`; return; }
    app.innerHTML = `<div class="card"><h2>Can't reach Clashly</h2><p class="sub">Looks like a connection blip — the bet's still there.</p><button class="cta" id="retryBet">Try again</button></div>`;
    $('#retryBet').addEventListener('click', () => renderBet(id));
    return;
  }
  if (!live()) return; // stale render — a newer view already won
  _betCache[id] = bet;

  const role = roleStore.get(id);
  const m = me.get();
  const link = location.origin + '/b/' + id;
  const matchCard = `
    <div class="match">
      <div class="teams">${isSeason(bet) ? esc(bet.home) : `${esc(bet.home)} <span class="vs">VS</span> ${esc(bet.away)}`}</div>
      <div class="meta">${isSeason(bet) ? '🗓️ Season-long call' + (bet.competition ? ' · ' + esc(bet.competition) : '') : (bet.competition ? esc(bet.competition) + ' · ' : '')}${bet.utcDate ? (isSeason(bet) ? ' · settle by ' + new Date(bet.utcDate).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : new Date(bet.utcDate).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })) : ''}</div>
    </div>`;
  const pill = `<span class="pill ${bet.status}">${bet.status}</span>`;

  // helper: rivalry banner between me and the other player (if history exists).
  // Stashes the data so later code (share taunts) reuses it — never a second fetch.
  let rivData = null;
  async function rivalryBanner(otherPid, otherName) {
    if (!m || !otherPid || otherPid === m.id) return '';
    try {
      const r = await api('/players/me/rivalry?with=' + encodeURIComponent(otherPid));
      rivData = r;
      if (!r.games) return '';
      const lead = r.aWins > r.bWins ? 'lead' : r.aWins < r.bWins ? 'trail' : 'level';
      const verb = r.aWins > r.bWins ? 'You lead' : r.aWins < r.bWins ? 'You trail' : 'All level';
      return `<div class="rivalry"><div><div class="vsline">${verb} ${esc(otherName)}${r.streakWeeks >= 2 ? ` <span class="wkchip">🔥${r.streakWeeks}wk</span>` : ''}</div><div class="sm" style="color:var(--muted);font-size:12px">net ${netTxt(r.aNet, r.currency)} this season</div></div><div class="score ${lead}">${r.aWins}–${r.bWins}</div></div>`;
    } catch { return ''; }
  }

  // ---- OPEN ----
  if (bet.status === 'open') {
    // the proposer sees the SHARE view — identity is authoritative when signed in;
    // the device-local role is only a hint for the signed-out case (a stale role from
    // a previous user on a shared device must never trump the current identity).
    if ((m && bet.proposerId === m.id) || (!m && role === 'proposer')) {
      track('proposer_open', { id });
      app.innerHTML = `
        <div class="card">
          <div class="cardhead"><h2>Send it to your mate 📲</h2>${pill}</div>
          <p class="sub">You're backing <b>${esc(outcomeLabel(bet, bet.backedOutcome))}</b> for <b>${money(bet)}</b>. They take the other side (${esc(complementLabel(bet))}).</p>
          <div style="position:relative">
            <img class="cardimg" src="/card/${id}.svg" alt="Your bet card" loading="eager" />
            ${(() => { try { if (sessionStorage.getItem('duely_stamp') === id) { sessionStorage.removeItem('duely_stamp'); return '<div class="stamp-slam">ON THE RECORD</div>'; } } catch {} return ''; })()}
          </div>
          <button class="cta wa" id="waBtn">SEND THE CHALLENGE 📲</button>
          <div class="row" style="margin-top:10px">
            <button class="ghost" id="shareBtn">More apps</button>
            <button class="ghost" id="storyBtn">Story / IG 📸</button>
          </div>
          <button class="muted-link" id="copyLink">Copy link</button>
          ${commentsHtml(bet)}
          <button class="muted-link" id="cancelBet">Cancel this bet</button>
          <button class="muted-link" id="homeLink">Back to my season</button>
        </div>
        <div class="banner">Waiting for your mate to take the bet…</div>`;
      const pendingOffers = (bet.offers || []).filter((o) => o.status === 'pending');
      if (pendingOffers.length) {
        const offHtml = pendingOffers.map((o) => `
          <div class="offer">
            <div>
              <div class="o-who"><b>${esc(o.by)}</b> counters:</div>
              <div class="o-terms">${esc(o.line || '')}${o.line && o.stake > 0 ? ' + ' : ''}${o.stake > 0 ? sym(o.currency) + o.stake : ''}</div>
              ${o.note ? `<div class="o-note">“${esc(o.note)}”</div>` : ''}
            </div>
            <div class="o-btns">
              <button class="mini yes" data-acc="${o.id}">✓</button>
              <button class="mini no" data-dec="${o.id}">✕</button>
            </div>
          </div>`).join('');
        $('#waBtn').insertAdjacentHTML('beforebegin', `
          <div style="margin:0 0 12px;padding:12px 14px;border:1px solid rgba(20,224,200,.35);border-radius:16px;background:rgba(20,224,200,.05)">
            <p class="sub" style="margin:0 0 4px"><b style="color:var(--teal)">💬 Counter-offers</b> — they want different terms:</p>
            ${offHtml}
          </div>`);
        document.querySelectorAll('[data-acc]').forEach((b) => b.addEventListener('click', async () => {
          b.disabled = true;
          try { await api('/bets/' + id + '/offer/' + b.dataset.acc + '/accept', { method: 'POST' }); track('offer_accepted'); sfx('deal'); toast('Deal 🤝 — locked at their terms'); renderBet(id); }
          catch (e) { toast(e.message); b.disabled = false; }
        }));
        document.querySelectorAll('[data-dec]').forEach((b) => b.addEventListener('click', async () => {
          b.disabled = true;
          try { await api('/bets/' + id + '/offer/' + b.dataset.dec + '/decline', { method: 'POST' }); toast('Offer declined'); renderBet(id); }
          catch (e) { toast(e.message); b.disabled = false; }
        }));
      }
      const waText = `${m ? m.name + ' reckons' : 'I reckon'} ${outcomeLabel(bet, bet.backedOutcome)} — ${bet.note ? '“' + bet.note + '” ' : ''}you taking the other side? 👇`;
      // primary: WhatsApp deep-link (unfurls the card AND keeps the link tappable)
      if (bet.arena) { const wa = $('#waBtn'); if (wa) wa.insertAdjacentHTML('beforebegin', '<div class="banner" style="border-style:solid;border-color:rgba(124,58,237,.45);text-align:left;margin-bottom:10px">🌍 <b>Live in the Arena</b> — anyone on Clashly can take the other side right now. Firing the link at a mate still works too.</div>'); }
      $('#waBtn').addEventListener('click', () => { track('share', { kind: 'whatsapp' }); shareLink(link, waText); });
      $('#shareBtn').addEventListener('click', () => shareLink(link, waText)); // native sheet, link-first
      $('#storyBtn').addEventListener('click', () => shareImage('/storycard/' + id + '.png', waText, 'challenge_story'));
      $('#copyLink').addEventListener('click', async () => { try { await navigator.clipboard.writeText(link); sfx('clip'); toast('Link copied'); } catch { toast(link); } });
      $('#cancelBet').addEventListener('click', (e) => {
        const b = e.target;
        if (b.dataset.armed) return doVoid(id);
        b.dataset.armed = '1'; b.textContent = 'Tap again to cancel this bet';
      });
      wireComments(id);
      $('#homeLink').addEventListener('click', () => { history.pushState({}, '', '/'); route(); });
      return;
    }
    // opponent / fresh visitor
    track('accept_view', { id });
    const rb = await rivalryBanner(bet.proposerId, bet.proposerName);
    // cold visitor with no shared history → truthful social proof about the proposer
    const ps = bet.proposerStats || {};
    const proof = rb ? '' : (
      ps.streakType === 'W' && ps.streakCount >= 2
        ? `<div class="banner" style="margin:0 0 4px">🔥 ${esc(bet.proposerName)} is on a ${ps.streakCount}-win streak — fancy stopping it?</div>`
        : ps.duels >= 1
          ? `<div class="banner" style="margin:0 0 4px">${esc(bet.proposerName)} has settled ${ps.duels} duel${ps.duels === 1 ? '' : 's'} on Clashly.</div>`
          : `<div class="banner" style="margin:0 0 4px">Duel #1 between you and ${esc(bet.proposerName)} — the record starts here.</div>`
    );
    // v14 — honest urgency: how long until this call locks
    const ko = bet.utcDate ? new Date(bet.utcDate).getTime() - Date.now() : 0;
    // the label sits in its own text node so the i18n observer can swap it —
    // interpolated sentences fall back to English, split ones don't
    const koTxt = isSeason(bet)
      // a season call has no kickoff to count down to — a deadline, if any
      ? (bet.utcDate ? `🗓️ <span>Settle by</span> ${new Date(bet.utcDate).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' })}` : '')
      : ko > 0
      ? (ko > 86400000 ? `⏱ <span>Kickoff in</span> ${Math.floor(ko / 86400000)}d ${Math.floor((ko % 86400000) / 3600000)}h`
        : ko > 3600000 ? `⏱ <span>Kickoff in</span> ${Math.floor(ko / 3600000)}h ${Math.floor((ko % 3600000) / 60000)}m`
        : `⏱ <span>Kicks off in</span> ${Math.max(1, Math.floor(ko / 60000))} <span>minutes</span>`)
      : '';
    track('invitee_open', { id });
    app.innerHTML = `
      <div class="card">
        <div class="cardhead"><h2>${esc(bet.proposerName)} wants to bet you 👀</h2>${pill}</div>
        ${koTxt ? `<div class="banner" style="margin:0 0 6px;border-style:solid;border-color:rgba(255,200,61,.35);color:var(--gold);font-weight:800">${koTxt}</div>` : ''}
        <p class="sub"><b>${esc(bet.proposerName)}</b> is backing <b>${esc(outcomeLabel(bet, bet.backedOutcome))}</b>. You take the other side.</p>
        ${rb}${proof}
        ${matchCard}
        ${bet.note ? `<div class="note">“${esc(bet.note)}”</div>` : ''}
        <div class="tape">
          <div><div class="t-av">${initials(bet.proposerName)}</div><div class="t-nm teal">${esc(bet.proposerName)}</div><div class="t-pick">${esc(outcomeLabel(bet, bet.backedOutcome))}</div></div>
          <div><div class="vs-big">VS</div><div class="t-stake">${esc(bet.line ? bet.line : (bet.stake > 0 ? sym(bet.currency) + bet.stake : 'bragging rights'))}</div></div>
          <div><div class="t-av pu">${m ? initials(m.name) : 'YOU'}</div><div class="t-nm purple">${m ? esc(m.name) : 'You'}</div><div class="t-pick">${esc(complementLabel(bet))}</div></div>
        </div>
        ${m ? '' : `
        <div id="nameWrap" style="display:none">
          <label for="opponentName">Sign the fight card — this goes on the record</label>
          <input id="opponentName" placeholder="Your name" maxlength="40" autocapitalize="words" />
        </div>`}
        <button class="cta commit" id="acceptBtn">Take the bet 🤝</button>
        <div style="text-align:center;font-size:11.5px;color:var(--muted-2);margin-top:6px">Free. No money. No sign-up. You're just going on the record.</div>
        <div style="text-align:center;font-size:11px;color:var(--muted-2);margin-top:3px">By accepting you confirm you're 18 or over.</div>
        <button class="ghost" id="haggleBtn" style="width:100%;margin-top:8px">💬 Haggle — counter the terms</button>
        <div id="haggleWrap" style="display:none;margin-top:10px">
          <label>Your counter — what should be on the line?</label>
          <input id="hagLine" placeholder="e.g. loser wears the rival shirt" maxlength="60" />
          <input id="hagStake" type="number" min="0" inputmode="numeric" placeholder="…or money (optional)" style="margin-top:8px" />
          <input id="hagNote" placeholder="Add a jab (optional)" maxlength="100" style="margin-top:8px" />
          ${m ? '' : '<div id="hagNameWrap"><label for="hagName">Sign the fight card</label><input id="hagName" placeholder="Your name" maxlength="40" autocapitalize="words" /></div>'}
          <button class="cta" id="hagSend" style="margin-top:10px">Send counter-offer →</button>
        </div>
        <button class="muted-link" onclick="location.href='/'">Nah — not this one</button>
        ${commentsHtml(bet)}
      </div>`;
    $('#acceptBtn').addEventListener('click', async () => {
      // tap-first: the commitment tap comes BEFORE the name ask — a cold visitor's
      // first tap reveals the name field, the second locks it in
      const mm0 = me.get();
      const nameWrap = $('#nameWrap');
      if (!mm0 && nameWrap && nameWrap.style.display === 'none') {
        track('accept_tap', { id });
        nameWrap.style.display = 'block';
        $('#acceptBtn').textContent = 'Lock it in 🤝';
        try { $('#opponentName').focus(); } catch {}
        return;
      }
      const opponentName = mm0 ? mm0.name : ($('#opponentName')?.value || '').trim();
      if (!opponentName) return toast('Add your name');
      const btn = $('#acceptBtn'); btn.disabled = true; $('.card').classList.add('locking'); haptic(22);
      try {
        let mm = me.get();
        try {
          if (!mm) mm = await register(opponentName);
          await api('/bets/' + id + '/accept', { method: 'POST' });
        } catch (e) {
          // dead local identity (server store reset) → api() already cleared it; mint a
          // fresh player with the typed name and retry once instead of dead-ending
          if (e.status !== 401) throw e;
          mm = await register(opponentName);
          await api('/bets/' + id + '/accept', { method: 'POST' });
        }
        track('bet_accepted');
        sfx('whistle');
        renderHeader();
        roleStore.set(id, 'opponent');
        let sub = `The ${esc(bet.proposerName)} rivalry is live`;
        try { const r = await api('/players/me/rivalry?with=' + encodeURIComponent(bet.proposerId)); if (r.games >= 1) sub = `You're ${r.aWins}–${r.bWins} with ${esc(bet.proposerName)} — live now`; } catch {}
        sealThen(() => renderBet(id), sub);
      } catch (e) {
        toast(e.message);
        if (e.status === 409) return renderBet(id); // taken underneath us → show real state
        btn.disabled = false; $('.card').classList.remove('locking');
      }
    });
    (() => {
      const hb = $('#haggleBtn'); if (!hb) return;
      const mm0 = me.get();
      const myPending = mm0 && (bet.offers || []).find((o) => o.byId === mm0.id && o.status === 'pending');
      if (myPending) {
        hb.style.display = 'none';
        $('#haggleWrap').style.display = 'none';
        hb.insertAdjacentHTML('afterend', `<div class="banner" style="margin-top:8px">💬 Your counter is in — ${esc(myPending.line || sym(myPending.currency) + myPending.stake)}. Waiting on ${esc(bet.proposerName)}.</div>`);
        return;
      }
      hb.addEventListener('click', () => {
        const w = $('#haggleWrap');
        w.style.display = w.style.display === 'none' ? 'block' : 'none';
        if (w.style.display === 'block') { try { $('#hagLine').focus(); } catch {} }
      });
      $('#hagSend').addEventListener('click', async () => {
        const line = ($('#hagLine')?.value || '').trim();
        const stake = Math.max(0, Number($('#hagStake')?.value) || 0);
        const note = ($('#hagNote')?.value || '').trim();
        if (!line && !stake) return toast('Counter with a forfeit or a stake');
        let mm = me.get();
        if (!mm) {
          const nm = ($('#hagName')?.value || '').trim();
          if (!nm) return toast('Add your name');
          try { mm = await register(nm); } catch (e) { return toast(e.message); }
          renderHeader();
        }
        const b = $('#hagSend'); b.disabled = true; haptic(16);
        try {
          await api('/bets/' + id + '/offer', { method: 'POST', body: JSON.stringify({ line, stake, currency: bet.currency, note }) });
          track('offer_made');
          sfx('ping');
          toast('Counter-offer sent 💬');
          renderBet(id);
        } catch (e) { toast(e.message); b.disabled = false; }
      });
    })();
    wireComments(id);
    return;
  }

  // ---- ACCEPTED ----
  if (bet.status === 'accepted') {
    const rb = await rivalryBanner(otherSideId(bet, m), otherSide(bet, m));
    app.innerHTML = `
      <div class="card">
        <div class="cardhead"><h2>Bet's on 🔒</h2>${pill}</div>
        ${bet.haggled ? `<div class="banner" style="margin:0 0 8px">💬 Terms were haggled — ${esc(bet.opponentName)} countered and ${esc(bet.proposerName)} took the deal.</div>` : ''}
        ${matchCard}
        <div class="stamprow"><span class="stamp stamp-on stamp-in">ON.</span></div>
        ${rb}
        ${bet.note ? `<div class="note">“${esc(bet.note)}”</div>` : ''}
        <div class="side"><div><div class="who">${esc(bet.proposerName)}</div><div class="pick">${esc(outcomeLabel(bet, bet.backedOutcome))}</div></div><div class="stake">${money(bet)}</div></div>
        <div class="side"><div><div class="who">${esc(bet.opponentName)}</div><div class="pick">${esc(complementLabel(bet))}</div></div><div class="stake">${money(bet)}</div></div>
        <div id="resolveZone"></div>
        ${reactionsHtml(bet)}
        ${commentsHtml(bet)}
      </div>`;
    const zone = $('#resolveZone');
    const pend = bet.pendingResult;
    const other = otherSide(bet, m);
    const kickoffFuture = bet.utcDate && new Date(bet.utcDate).getTime() > Date.now();
    const isParticipant = m && (bet.proposerId === m.id || bet.opponentId === m.id);
    // spectators (a third mate opening the link) get a passive status, never
    // report/confirm controls that would just 403
    if (!isParticipant) {
      zone.innerHTML = pend
        ? `<div class="banner">${esc(pend.by || 'One player')} says it finished: <b style="color:var(--text)">${esc(outcomeLabel(bet, pend.outcome))}</b> — waiting on the other to confirm.</div>`
        : `<div class="banner">⏳ Waiting on ${esc(bet.proposerName)} and ${esc(bet.opponentName)} to settle this one.</div>`;
      wireReactions(id);
      wireComments(id);
      return;
    }
    const showReportSeg = () => {
      zone.innerHTML = `
        <label>${isSeason(bet) ? 'How did it end up?' : 'Report the final result'}</label>
        <div class="seg" id="resSeg">
          ${isSeason(bet)
            ? `<button data-o="HOME">It happened ✅</button><button data-o="AWAY">It didn't ❌</button>`
            : `<button data-o="HOME">${esc(bet.home)} won</button>
          <button data-o="DRAW">Draw</button>
          <button data-o="AWAY">${esc(bet.away)} won</button>`}
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
      $('#confirmBtn').addEventListener('click', () => doConfirm(id, pend.outcome));
      $('#disputeBtn').addEventListener('click', showReportSeg);
    } else if (kickoffFuture) {
      zone.innerHTML = isSeason(bet)
        ? `<div class="banner">🔒 On the record — settle it by ${esc(new Date(bet.utcDate).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' }))}. No rush, it isn't going anywhere.</div>`
        : `<div class="banner">🔒 Locked in — kicks off ${esc(new Date(bet.utcDate).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }))}. Come back after full time to settle.</div>`;
    } else if (CONFIG.live && bet.externalId) {
      zone.innerHTML = `<button class="cta" id="autoBtn">Check final result</button><div class="banner" id="autoState">Auto-resolves from the live feed once the match is finished.</div><button class="muted-link" id="manualBtn">Match over but the feed's not updating? Report it manually</button>`;
      $('#autoBtn').addEventListener('click', async () => {
        const btn = $('#autoBtn'); btn.disabled = true; btn.textContent = 'Checking…';
        try { await api('/bets/' + id + '/resolve', { method: 'POST', body: JSON.stringify({}) }); renderBet(id); }
        catch (e) {
          // not finished yet → a persistent inline state, not a vanishing toast
          const st = $('#autoState'); if (st) st.innerHTML = `⏱️ Not full time yet — we'll settle it from the feed after the whistle. Check back later.`;
          btn.disabled = false; btn.textContent = 'Check final result';
        }
      });
      $('#manualBtn').addEventListener('click', showReportSeg);
    } else {
      showReportSeg();
    }
    wireReactions(id);
    wireComments(id);
    return;
  }

  // ---- RESOLVED / SETTLED ----
  if (bet.status === 'resolved' || bet.status === 'settled') {
    const winnerNm = bet.winner === 'proposer' ? bet.proposerName : bet.opponentName;
    const winPick = bet.winner === 'proposer' ? outcomeLabel(bet, bet.backedOutcome) : complementLabel(bet);
    const other = otherSide(bet, m);
    const iWon = m && (bet.winner === 'proposer' ? bet.proposerId : bet.opponentId) === m.id;
    const rb = await rivalryBanner(otherSideId(bet, m), other);
    const iPlay = m && (bet.proposerId === m.id || bet.opponentId === m.id);
    const stampTxt = iWon ? 'CALLED IT.' : iPlay ? 'BOTTLED.' : 'SETTLED.';
    const stampCls = iWon ? 'stamp-win' : iPlay ? 'stamp-loss' : 'stamp-neutral';

    app.innerHTML = `
      <div class="card">
        <div class="cardhead"><h2>${isSeason(bet) ? 'Settled 🗓️' : 'Full time 🏁'}</h2>${pill}</div>
        ${matchCard}
        <div class="stamprow"><span class="stamp ${stampCls} stamp-in">${stampTxt}</span></div>
        <div class="banner reveal" style="margin-bottom:12px">Result: <b style="color:var(--text)">${esc(outcomeLabel(bet, bet.actualOutcome))}</b></div>
        <div class="owes reveal delay1">
          <div class="lbl">${bet.status === 'settled' ? 'Sorted' : 'Sort it'} 👇</div>
          <div class="big">${esc(bet.owes.from)} → ${esc(bet.owes.to)}</div>
          ${bet.stake > 0
            ? `<div class="amt" id="amt">${sym(bet.currency)}0</div>`
            : `<div class="amt" style="font-size:22px">${esc(money(bet))}</div>`}
        </div>
        <div class="side win reveal delay2"><div><div class="who">🏆 ${esc(winnerNm)}</div><div class="pick">called it: ${esc(winPick)}</div></div></div>
        ${rb ? `<div class="reveal delay3">${rb}</div>` : ''}
        <div class="reveal delay3">
          ${reactionsHtml(bet)}
          ${commentsHtml(bet)}
          <img class="cardimg" src="/card/${id}.svg" alt="Result card" loading="lazy" />
          ${iWon
            ? `<button class="cta wa" id="shareResult">Brag about it 🏆</button>`
            : (other ? `<button class="cta commit" id="rematchLoss">Demand a rematch ⚔️</button>` : '')}
          ${iPlay ? `<button class="ghost" id="bragCopy" style="width:100%;margin-top:10px">📋 Copy the scoreline</button>
          <div style="text-align:center;font-size:11.5px;color:var(--muted-2);margin-top:6px">No link, just the record. Paste it in the group chat.</div>` : ''}
          <div class="row" style="margin-top:10px">
            <button class="ghost" id="storyBtn">Story image 📲</button>
            <button class="ghost" id="receiptBtn">Receipt 🧾</button>
            <button class="ghost" id="copyBet">Run it back 🔁</button>
          </div>
          ${bet.status === 'resolved' ? `<button class="cta gold" id="settleBtn" style="margin-top:10px">Mark it sorted ✓</button>` : `<div class="banner" style="margin-top:14px">✓ Sorted${bet.settledByName ? ' by ' + esc(bet.settledByName) : ''}${bet.settledAt ? ' · ' + new Date(bet.settledAt).toLocaleDateString() : ''} · <button class="linkbtn" id="unsettleBtn" style="font-size:12px">undo</button></div>`}
          ${other && iWon ? `<button class="cta commit" id="rematchBtn" style="margin-top:10px">Rematch ${esc(other)} ⚔️</button>` : ''}
          ${iWon ? `<button class="muted-link" id="proLink" style="color:var(--gold);margin-top:10px">⭐ Make this rivalry official — Group Pro</button>` : ''}
          <button class="muted-link" id="homeLink">Back to my season</button>
        </div>
      </div>`;
    // score-led taunt when the record exists — reuses the banner's fetch (no await:
    // an await here would leave the screen painted but dead until it resolved)
    let shareText = `Called it — ${outcomeLabel(bet, bet.actualOutcome)}. ${other ? 'Your move, ' + other + ' 👀 ' : ''}Settle the score on Clashly 👇`;
    if (iWon && other && rivData && rivData.games > 1) {
      const strip = (rivData.recent || []).slice().reverse().map((x) => (x.aWon ? '🟩' : '🟥')).join('');
      shareText = `That's ${rivData.aWins}–${rivData.bWins} to me, ${other} 😏${strip ? `\nUs, on the record: ${strip}` : ''}\nRematch? 👇`;
    }
    const sr = $('#shareResult'); if (sr) sr.addEventListener('click', () => shareWithCard('/card/' + id + '.png', shareText, link, 'result'));
    // the link-free brag — the Wordle grid lesson: a scoreline that reads as bragging,
    // not as an advert, travels further than a link ever does. No URL on purpose.
    const bc = $('#bragCopy');
    if (bc) bc.addEventListener('click', async () => {
      const meNm = (m && m.name) || (iWon ? winnerNm : other) || 'Me';
      const oppNm = other || (iWon ? bet.owes.from : winnerNm) || 'Them';
      let head, strip;
      if (rivData && rivData.games >= 1) {
        head = `${meNm} ${rivData.aWins}-${rivData.bWins} ${oppNm}`;
        strip = (rivData.recent || []).slice(0, 6).reverse().map((x) => (x.aWon ? '🟩' : '🟥')).join('');
      } else {
        head = `${meNm} ${iWon ? 1 : 0}-${iWon ? 0 : 1} ${oppNm}`;
        strip = iWon ? '🟩' : '🟥';
      }
      const owed = bet.line ? `${bet.owes.from} owes: ${bet.line}` : '';
      const txt = ['CLASHLY · ' + head, strip, owed].filter(Boolean).join('\n');
      try { await navigator.clipboard.writeText(txt); sfx('clip'); toast('Copied — paste it in the chat'); track('brag_copy', { id }); }
      catch { toast(txt); }
    });
    const rl = $('#rematchLoss'); if (rl) rl.addEventListener('click', () => rematchConfirm(other, bet));
    const sb = $('#storyBtn'); if (sb) sb.addEventListener('click', () => shareStory(id));
    const rcb = $('#receiptBtn'); if (rcb) rcb.addEventListener('click', () => shareImage('/receipt/' + id + '.png', 'Receipts 🧾 — the terrace remembers. clashly.live/b/' + id, 'receipt'));
    const cb = $('#copyBet'); if (cb) cb.addEventListener('click', () => { PREFILL = { copy: { home: bet.home, away: bet.away, competition: bet.competition, backedOutcome: bet.backedOutcome, stake: bet.stake, currency: bet.currency, line: bet.line, note: bet.note } }; renderCreate(); });
    wireReactions(id);
    wireComments(id);

    // animate the payout count-up, confetti only if *I* won
    setTimeout(() => { const el = $('#amt'); if (el) countUp(el, bet.owes.amount, sym(bet.currency)); }, 420);
    if (iPlay) setTimeout(() => sfx('deal'), 160); // the stamp thump
    if (iWon) { setTimeout(() => confetti(Math.max(1, Math.min(3, (bet.stake || 20) / 20))), 520); haptic([14, 50, 22]); sfx('cheer'); }
    else if (m && (bet.proposerId === m.id || bet.opponentId === m.id)) { sfx('womp'); }

    if (bet.status === 'resolved') $('#settleBtn').addEventListener('click', async () => {
      try { await api('/bets/' + id + '/settle', { method: 'POST' }); toast('Nice — sorted'); renderBet(id); } catch (e) { toast(e.message); }
    });
    const ub = $('#unsettleBtn'); if (ub) ub.addEventListener('click', async () => {
      try { await api('/bets/' + id + '/unsettle', { method: 'POST' }); renderBet(id); } catch (e) { toast(e.message); }
    });
    const rbtn = $('#rematchBtn'); if (rbtn) rbtn.addEventListener('click', () => rematchConfirm(other, bet));
    const pl = $('#proLink'); if (pl) pl.addEventListener('click', () => openProSheet('result'));
    $('#homeLink').addEventListener('click', () => { history.pushState({}, '', '/'); route(); });
    return;
  }

  // ---- VOID (cancelled or disputed-and-voided) ----
  if (bet.status === 'void') {
    app.innerHTML = `
      <div class="card">
        <div class="cardhead"><h2>Bet called off</h2><span class="pill settled">void</span></div>
        <div class="stamprow"><span class="stamp stamp-void stamp-in">VOID.</span></div>
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
  const iWon = m && (lastBet.winner === 'proposer' ? lastBet.proposerId : lastBet.opponentId) === m.id;
  const lost = iWon === false;
  track('rematch_view', { after_loss: lost }); // monitor (never optimize against) loss-triggered rematches
  let recLine = `New rivalry vs ${esc(other)} — make it count.`;
  try {
    const r = await api('/players/me/rivalry?with=' + encodeURIComponent(oppId));
    if (r.games) recLine = `Head to head vs ${esc(other)}: <b>${r.aWins}–${r.bWins}</b>${r.aWins === r.bWins ? ' — all square' : r.aWins > r.bWins ? " — you're ahead" : ''}.`;
  } catch {}
  app.innerHTML = `
    <div class="card">
      <h2>${lost ? `Run it back on ${esc(other)}?` : `Rematch ${esc(other)}?`}</h2>
      <p class="sub">${lost ? 'No rush — only when you fancy it.' : 'Quick gut-check before you go again.'}</p>
      <div class="side"><div><div class="who">Last duel</div><div class="pick">${esc(matchLabel(lastBet))}</div></div></div>
      <div class="resp" style="margin-top:14px;text-align:center;display:block">${recLine}</div>
      <div class="banner" style="margin-top:12px">Winner takes the bragging rights. Set your own stake on the next screen.</div>
      <button class="cta${lost ? '' : ' commit'}" id="goRematch">Set up the rematch${lost ? '' : ' →'}</button>
      <button class="muted-link" id="notNow">${lost ? 'Maybe later' : 'Not now'}</button>
    </div>`;
  // carry the last duel's terms into the rematch (same forfeit/stake, new fixture)
  $('#goRematch').addEventListener('click', () => { PREFILL = { opponent: other, terms: { line: lastBet.line, stake: lastBet.stake, currency: lastBet.currency } }; renderCreate(); });
  $('#notNow').addEventListener('click', () => { history.pushState({}, '', '/'); route(); });
}

async function doResolve(id, actualOutcome) {
  try { await api('/bets/' + id + '/resolve', { method: 'POST', body: JSON.stringify({ actualOutcome }) }); renderBet(id); }
  catch (e) { toast(e.message); if (e.status === 409) renderBet(id); } // stale screen (e.g. voided underneath) → self-heal
}
async function doConfirm(id, outcome) {
  // send the outcome the confirmer SAW — the server 409s if the report changed underneath
  try { await api('/bets/' + id + '/confirm', { method: 'POST', body: JSON.stringify({ outcome }) }); track('bet_resolved'); renderBet(id); }
  catch (e) { toast(e.message); if (e.status === 409) renderBet(id); } // re-render so the changed report actually surfaces
}
async function doVoid(id) {
  try { await api('/bets/' + id + '/void', { method: 'POST' }); toast('Bet voided'); history.pushState({}, '', '/'); route(); }
  catch (e) { toast(e.message); }
}

// share a rendered card image (native file share where supported), else the link
// LINK-first for cards too: the challenge/result link unfurls the card image
// automatically on every messaging app while staying tappable. This replaces the
// old file-first path that could strip the URL on WhatsApp/Messenger.
async function shareWithCard(cardUrl, text, link, kind) {
  track('share', { kind });
  return shareLink(link, text);
}
// IMAGE-first — for Instagram Stories / Snap / WhatsApp Status, which do NOT
// unfurl links at all: the only way onto those surfaces is the image itself.
// The card has clashly.live/b/<id> printed on it, so viewers can still find the bet.
async function shareImage(imgUrl, text, kind) {
  track('share', { kind: kind || 'image' });
  try {
    if (navigator.canShare) {
      const r = await fetch(imgUrl); const blob = await r.blob();
      const file = new File([blob], 'clashly.png', { type: blob.type || 'image/png' });
      if (navigator.canShare({ files: [file] })) {
        try { await navigator.share({ files: [file], text }); return; }
        catch (e) { if (e && e.name === 'AbortError') return; }
      }
    }
  } catch {}
  // no file-share support (most desktops) → open the image so they can save/post it
  try { window.open(imgUrl, '_blank', 'noopener'); } catch { toast('Could not open the image'); }
}
async function shareStory(id) { return shareImage('/storycard/' + id + '.png', 'Settled on Clashly ⚽', 'story'); }

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

// Rivalry detail — the match-by-match history that makes the head-to-head a durable
// shared asset. Opened from any rivalry row; the resolving CTA is always the rematch.
async function openRivalrySheet(oppId, oppName) {
  let r;
  try { r = await api('/players/me/rivalry?with=' + encodeURIComponent(oppId)); }
  catch (e) { return toast(e.message); }
  const lead = r.aWins > r.bWins ? 'lead' : r.aWins < r.bWins ? 'trail' : 'level';
  const verb = r.aWins > r.bWins ? 'You lead' : r.aWins < r.bWins ? 'You trail' : 'All level with';
  const rows = (r.recent || []).map((x) => `
    <div class="recent" data-bet="${x.id}" role="button" tabindex="0" style="cursor:pointer">
      <span>${esc(matchLabel(x))}</span>
      <span class="res ${x.aWon ? 'w' : 'l'}">${x.aWon ? 'W' : 'L'}${x.stake > 0 ? ' · ' + sym(x.currency) + x.stake : ''}</span>
    </div>`).join('');
  openSheet(`
    <div class="sheet-handle"></div>
    <div class="sheet-head"><h2>${verb} ${esc(oppName)}</h2><button class="sheet-x" id="sheetClose" aria-label="Close">✕</button></div>
    <div class="sheet-body">
      <div class="rivalry" style="margin-top:2px"><div><div class="vsline">${esc(oppName)} rivalry</div><div class="sm" style="color:var(--muted);font-size:12px">${r.games} duel${r.games === 1 ? '' : 's'} · net ${netTxt(r.aNet, r.currency)}</div></div><div class="score ${lead}">${r.aWins}–${r.bWins}</div></div>
      ${rows ? `<label>Last duels</label>${rows}` : ''}
    </div>
    <div class="sheet-foot"><button class="cta commit" id="rivRematch">Rematch ${esc(oppName)} ⚔️</button></div>`);
  $('#sheetClose').addEventListener('click', closeSheet);
  $('#rivRematch').addEventListener('click', () => { PREFILL = { opponent: oppName }; renderCreate(); });
  document.querySelectorAll('#sheetPanel [data-bet]').forEach((el) => el.addEventListener('click', () => { closeSheet(); history.pushState({}, '', '/b/' + el.dataset.bet); renderBet(el.dataset.bet); }));
}

// Group Pro — surfaced only at the post-win peak, never in the create/accept flow.
// No checkout yet (needs a payment processor); this captures demand honestly.
function openProSheet(ctx) {
  openSheet(`
    <div class="sheet-handle"></div>
    <div class="sheet-head"><h2>Group Pro ⭐</h2><button class="sheet-x" id="sheetClose" aria-label="Close">✕</button></div>
    <div class="sheet-body">
      <p class="sub" style="margin:2px 0 12px">Make the rivalry official — one mate unlocks it for the whole group.</p>
      <div class="side"><div><div class="who">Season stats &amp; deep history</div><div class="pick">every duel, every streak, all-time records</div></div></div>
      <div class="side"><div><div class="who">Kits</div><div class="pick">skins for your rivalry &amp; share cards</div></div></div>
      <div class="side"><div><div class="who">Season Pass — one payer, whole group</div><div class="pick">€14.99 for the season unlocks it for everyone in the league</div></div></div>
      <p class="sub" style="margin:14px 0 0">Not live yet — tap below and you'll be first to know when it opens.</p>
    </div>
    <div class="sheet-foot"><button class="cta gold" id="proNotify">Notify me when it's ready</button></div>`);
  $('#sheetClose').addEventListener('click', closeSheet);
  $('#proNotify').addEventListener('click', () => { track('pro_interest', { ctx: ctx || 'unknown' }); closeSheet(); toast("Nice — you're on the list 🙌"); });
}

document.getElementById('tabbar')?.addEventListener('click', (e) => {
  sfx('tab');
  const t = e.target.closest('.tab'); if (!t) return;
  haptic(8);
  const tab = t.dataset.tab;
  if (tab === 'challenge') { PREFILL = null; renderCreate(); return; }
  const target = tab === 'home' ? '/' : tab === 'league' ? '/leagues' : '/' + tab;
  if (location.pathname !== target) history.pushState({}, '', target);
  route();
});
document.getElementById('sheetScrim')?.addEventListener('click', (e) => { if (e.target.id === 'sheetScrim') closeSheet(); });

// Enter/Space activate keyboard-focused rows (role=button divs)
app.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  const t = e.target.closest('[role="button"][data-bet],[role="button"][data-league],[role="button"][data-rivid],[role="button"][data-callit]');
  if (t) { e.preventDefault(); t.click(); }
});

window.addEventListener('popstate', () => {
  const scrim = document.getElementById('sheetScrim');
  if (scrim && scrim.classList.contains('open')) { closeSheet(); if (_sheetURL) history.pushState({}, '', _sheetURL); return; }
  route();
});
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
      setTimeout(kill, 2350);
    }
  }
  const spot = document.querySelector('.amb-spot');
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  // the cursor spotlight is a fine-pointer effect — phones skip the whole system
  // (no 60fps rAF loop burning battery for an effect touch can't see)
  if (spot && !reduce && matchMedia('(pointer: fine)').matches) {
    let lastPointer = -9999, rafId = null;
    window.addEventListener('pointermove', (e) => {
      lastPointer = performance.now();
      spot.style.transform = 'translate3d(' + (e.clientX - 340) + 'px,' + (e.clientY - 340) + 'px,0)';
    }, { passive: true });
    // when the cursor is idle, the floodlight drifts on its own — paused on hidden tabs.
    // writes only transform (compositor-only, no layout/paint) on a fixed-size blob.
    const drift = (t) => {
      if (performance.now() - lastPointer > 1400) {
        const s = t / 1000;
        const mx = (50 + Math.sin(s * 0.16) * 32 + Math.sin(s * 0.07) * 8) / 100 * innerWidth;
        const my = (24 + Math.cos(s * 0.12) * 18) / 100 * innerHeight;
        spot.style.transform = 'translate3d(' + (mx - 340) + 'px,' + (my - 340) + 'px,0)';
      }
      rafId = requestAnimationFrame(drift);
    };
    rafId = requestAnimationFrame(drift);
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) { if (rafId) cancelAnimationFrame(rafId); rafId = null; }
      else if (!rafId) rafId = requestAnimationFrame(drift);
    });
  }
})();


// ---- Web push opt-in ----
async function enablePush() {
  try {
    if (!('serviceWorker' in navigator) || typeof Notification === 'undefined') return false;
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') return false;
    const reg = await navigator.serviceWorker.ready;
    const { key } = await api('/push/key');
    if (!key) return false;
    const b64 = key.replace(/-/g, '+').replace(/_/g, '/');
    const raw = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
    const appKey = new Uint8Array([...raw].map((c) => c.charCodeAt(0)));
    const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: appKey });
    await api('/push/subscribe', { method: 'POST', body: JSON.stringify({ subscription: sub.toJSON() }) });
    return true;
  } catch { return false; }
}

// ---- PWA install: capture the prompt, surface it once things are sticky ----
let _deferredInstall = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  _deferredInstall = e;
  try {
    if (localStorage.getItem('clashly_pwa_dismissed')) return;
    const bar = document.createElement('div');
    bar.id = 'pwaBar';
    bar.style.cssText = 'position:fixed;left:12px;right:12px;bottom:76px;z-index:60;background:linear-gradient(135deg,#0E141C,#101a24);border:1px solid rgba(20,224,200,.45);border-radius:14px;padding:12px 14px;display:flex;align-items:center;gap:10px;box-shadow:0 8px 30px rgba(0,0,0,.45)';
    bar.innerHTML = '<span style="font-size:13.5px;font-weight:700">📲 Add Clashly to your home screen — it works like an app.</span><button id="pwaGo" class="linkbtn" style="flex:none;font-weight:800">Install</button><button id="pwaNo" class="linkbtn" style="flex:none;color:var(--muted)">✕</button>';
    document.body.appendChild(bar);
    bar.querySelector('#pwaGo').addEventListener('click', async () => {
      bar.remove();
      if (_deferredInstall) { track('pwa_install_prompt'); _deferredInstall.prompt(); _deferredInstall = null; }
    });
    bar.querySelector('#pwaNo').addEventListener('click', () => { bar.remove(); try { localStorage.setItem('clashly_pwa_dismissed', '1'); } catch {} });
  } catch {}
});
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => { navigator.serviceWorker.register('/sw.js').catch(() => {}); });
}

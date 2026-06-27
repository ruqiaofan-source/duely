'use strict';

/**
 * Share-card renderer.
 *
 * Produces the per-bet share image in two flavours:
 *   - challenge card (open/accepted bet — the "I dare you" card)
 *   - result card    (resolved/settled — the "I told you so" brag card)
 *
 * The SVG templates live in ./challenge.svg and ./result.svg (a
 * "Broadcast Scoreboard" design — TV-fixture chassis + a giant gloat hero +
 * a promoted Head-to-Head panel). They carry {{TOKENS}} that we fill per bet.
 *
 * SVG is the source of truth (zero-dep, crisp in-app + on SVG-capable
 * unfurlers). For WhatsApp — which won't render SVG previews — we rasterize
 * to PNG with @resvg/resvg-js if it's installed, loading the brand fonts from
 * ./fonts. If resvg isn't present the PNG route falls back to the SVG.
 */

const fs = require('fs');
const path = require('path');
let Resvg;
try { Resvg = require('@resvg/resvg-js').Resvg; } catch { Resvg = null; }
const FONTS = path.join(__dirname, 'fonts');

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fill = (tpl, data) => tpl.replace(/\{\{(\w+)\}\}/g, (_, k) => esc(data[k] ?? ''));

function loadTemplate(name, fallback) {
  try { return fs.readFileSync(path.join(__dirname, name), 'utf8'); }
  catch { return fallback; }
}
const FALLBACK = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 630"><rect width="1200" height="630" fill="#0B0F14"/><text x="64" y="320" font-family="Impact,sans-serif" font-size="80" fill="#14E0C8">DUELY</text></svg>`;
const CHALLENGE_TPL = loadTemplate('challenge.svg', FALLBACK);
const RESULT_TPL = loadTemplate('result.svg', FALLBACK);

const LEAGUE_TPL = `<svg viewBox="0 0 1200 630" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Duely league invite">
<defs>
<style>@import url('https://fonts.googleapis.com/css2?family=Anton&amp;family=Inter:wght@400;600;700;800;900&amp;display=swap');
.anton{font-family:'Anton','Oswald','Arial Narrow',Impact,sans-serif;}
.inter{font-family:'Inter',system-ui,-apple-system,'Segoe UI',sans-serif;}</style>
<linearGradient id="lBg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#0E141C"/><stop offset="1" stop-color="#0B0F14"/></linearGradient>
<linearGradient id="lTeal" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#14E0C8"/><stop offset="1" stop-color="#0FB7A4"/></linearGradient>
<radialGradient id="lGlow" cx="0.5" cy="0.2" r="0.8"><stop offset="0" stop-color="#14E0C8" stop-opacity="0.14"/><stop offset="1" stop-color="#14E0C8" stop-opacity="0"/></radialGradient>
</defs>
<rect width="1200" height="630" fill="#0B0F14"/>
<rect width="1200" height="630" fill="url(#lBg)"/>
<rect width="1200" height="630" fill="url(#lGlow)"/>
<rect x="0" y="0" width="1200" height="8" fill="#14E0C8"/>
<g opacity="0.05" stroke="#9AA7B8" stroke-width="2" fill="none"><line x1="600" y1="120" x2="600" y2="470"/><circle cx="600" cy="295" r="78"/></g>
<g class="inter">
<rect x="56" y="48" width="46" height="46" rx="13" fill="url(#lTeal)"/>
<circle cx="79" cy="71" r="13" fill="none" stroke="#0B0F14" stroke-width="2.4"/>
<path d="M79 60 L83 68 L79 72 L75 68 Z" fill="#0B0F14"/><path d="M66 71 L75 68 L79 72 L74 81 Z" fill="#0B0F14"/><path d="M92 71 L83 68 L79 72 L84 81 Z" fill="#0B0F14"/>
<text x="116" y="74" class="anton" font-size="34" fill="#F5F7FA" letter-spacing="1">DUELY</text>
<text x="118" y="92" class="inter" font-size="12.5" font-weight="700" fill="#14E0C8" letter-spacing="2">BACK YOURSELF.</text>
</g>
<text x="600" y="232" class="inter" text-anchor="middle" font-size="18" font-weight="800" fill="#14E0C8" letter-spacing="4">FRIENDS LEAGUE</text>
<text x="600" y="332" class="anton" text-anchor="middle" font-size="92" fill="#F5F7FA">{{NAME}}</text>
<text x="600" y="392" class="inter" text-anchor="middle" font-size="22" font-weight="700" fill="#9AA7B8">{{MEMBERS}} &#183; {{LEADER}}</text>
<rect x="300" y="470" width="600" height="64" rx="16" fill="url(#lTeal)"/>
<text x="600" y="510" class="inter" text-anchor="middle" font-size="24" font-weight="900" fill="#06231F">Join the league &#8594;</text>
<text x="600" y="582" class="inter" text-anchor="middle" font-size="18" font-weight="700" fill="#9AA7B8">join code <tspan class="anton" font-size="22" fill="#14E0C8" letter-spacing="2">{{CODE}}</tspan></text>
</svg>`;

function challengeSvg(data) {
  // Per design notes: never leave the trash-talk panel hollow.
  const d = { ...data, NOTE: (data.NOTE && data.NOTE.trim()) ? data.NOTE : 'easy money.' };
  return fill(CHALLENGE_TPL, d);
}
function resultSvg(data) { return fill(RESULT_TPL, data); }
function leagueSvg(data) { return fill(LEAGUE_TPL, data); }

function renderPng(svg) {
  if (!Resvg) return null;
  try {
    const r = new Resvg(svg, {
      background: '#0B0F14',
      fitTo: { mode: 'width', value: 1200 },
      font: { fontDirs: [FONTS], loadSystemFonts: true, defaultFontFamily: 'Inter' },
    });
    return r.render().asPng();
  } catch (e) { console.warn('card png render failed:', e.message); return null; }
}

module.exports = { challengeSvg, resultSvg, leagueSvg, renderPng, hasRasterizer: Boolean(Resvg) };

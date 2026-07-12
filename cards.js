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
<style>.anton{font-family:'Anton','Oswald','Arial Narrow',Impact,sans-serif;}
.inter{font-family:'Inter',system-ui,-apple-system,'Segoe UI',sans-serif;}</style>
<linearGradient id="lBg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#0E141C"/><stop offset="1" stop-color="#0B0F14"/></linearGradient>
<linearGradient id="lTeal" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#14E0C8"/><stop offset="1" stop-color="#0FB7A4"/></linearGradient>
<radialGradient id="lGlow" cx="0.5" cy="0.2" r="0.8"><stop offset="0" stop-color="#14E0C8" stop-opacity="0.14"/><stop offset="1" stop-color="#14E0C8" stop-opacity="0"/></radialGradient>
<linearGradient id="lDuel" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#14E0C8"/><stop offset=".5" stop-color="#14E0C8"/><stop offset=".5" stop-color="#7C3AED"/><stop offset="1" stop-color="#7C3AED"/></linearGradient>
</defs>
<rect width="1200" height="630" fill="#0B0F14"/>
<rect width="1200" height="630" fill="url(#lBg)"/>
<rect width="1200" height="630" fill="url(#lGlow)"/>
<rect x="0" y="0" width="1200" height="8" fill="#14E0C8"/>
<g opacity="0.05" stroke="#9AA7B8" stroke-width="2" fill="none"><line x1="600" y1="120" x2="600" y2="470"/><circle cx="600" cy="295" r="78"/></g>
<g class="inter">
<g transform="translate(56,48) scale(0.46)"><rect width="100" height="100" rx="26" fill="#0E141C"/><path d="M26 20 H56 C73 20 80 33 80 50 C80 67 73 80 56 80 H26 Z M39 33 H55 C64 33 68 41 68 50 C68 59 64 67 55 67 H39 Z" fill-rule="evenodd" fill="url(#lDuel)"/><rect x="51" y="20" width="3" height="60" fill="#0A0E13"/></g>
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

// 1080x1920 story / reel variant (Instagram/WhatsApp status)
const STORY_TPL = `<svg viewBox="0 0 1080 1920" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Duely story card">
<defs>
<style>.anton{font-family:'Anton','Oswald','Arial Narrow',Impact,sans-serif;}.inter{font-family:'Inter',system-ui,sans-serif;}</style>
<linearGradient id="sBg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#0E141C"/><stop offset="1" stop-color="#0A0E13"/></linearGradient>
<radialGradient id="sGlow" cx="50%" cy="20%" r="70%"><stop offset="0" stop-color="{{ACCENT}}" stop-opacity="0.18"/><stop offset="1" stop-color="{{ACCENT}}" stop-opacity="0"/></radialGradient>
<linearGradient id="sDuel" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#14E0C8"/><stop offset=".5" stop-color="#14E0C8"/><stop offset=".5" stop-color="#7C3AED"/><stop offset="1" stop-color="#7C3AED"/></linearGradient>
</defs>
<rect width="1080" height="1920" fill="#0A0E13"/>
<rect width="1080" height="1920" fill="url(#sBg)"/>
<rect width="1080" height="1920" fill="url(#sGlow)"/>
<rect x="0" y="0" width="1080" height="10" fill="{{ACCENT}}"/>
<g class="inter">
<g transform="translate(72,100) scale(0.78)"><rect width="100" height="100" rx="26" fill="#0E141C"/><path d="M26 20 H56 C73 20 80 33 80 50 C80 67 73 80 56 80 H26 Z M39 33 H55 C64 33 68 41 68 50 C68 59 64 67 55 67 H39 Z" fill-rule="evenodd" fill="url(#sDuel)"/><rect x="51" y="20" width="3" height="60" fill="#0A0E13"/></g>
<text x="172" y="144" class="anton" font-size="56" fill="#F5F7FA" letter-spacing="1">DUELY</text>
<text x="174" y="176" class="inter" font-size="20" font-weight="700" fill="#14E0C8" letter-spacing="3">BACK YOURSELF.</text>
</g>
<rect x="72" y="320" width="360" height="60" rx="30" fill="#161C26" stroke="{{ACCENT}}" stroke-width="2"/>
<text x="252" y="360" class="inter" text-anchor="middle" font-size="26" font-weight="800" fill="{{ACCENT}}" letter-spacing="3">{{BADGE}}</text>
<text x="72" y="580" class="inter" font-size="36" font-weight="700" fill="#93A1B3">{{SUB}}</text>
<text x="72" y="720" class="anton" font-size="{{HERO_SIZE}}" fill="{{ACCENT}}">{{HERO}}</text>
<rect x="72" y="840" width="936" height="104" rx="24" fill="#161C26" stroke="#2A3340" stroke-width="2"/>
<text x="540" y="906" class="inter" text-anchor="middle" font-size="42" font-weight="800" fill="#F5F7FA">{{HOME}}  v  {{AWAY}}</text>
<text x="72" y="1110" class="inter" font-size="28" font-weight="800" fill="#93A1B3" letter-spacing="2">THE STAKE</text>
<text x="72" y="1250" class="anton" font-size="140" fill="#2BD17E">{{STAKE}}</text>
<text x="72" y="1320" class="inter" font-size="30" font-weight="700" fill="#93A1B3">winner takes the bragging rights</text>
<rect x="72" y="1690" width="936" height="124" rx="30" fill="{{ACCENT}}"/>
<text x="540" y="1768" class="inter" text-anchor="middle" font-size="42" font-weight="900" fill="#06140f">{{FOOT}}</text>
<text x="540" y="1862" class="inter" text-anchor="middle" font-size="28" font-weight="800" fill="#93A1B3" letter-spacing="2">duely.live/b/{{ID}}</text>
</svg>`;

function challengeSvg(data) {
  // Per design notes: never leave the trash-talk panel hollow. BADGE/CTA tokens
  // default to the open-bet state when the caller doesn't provide them.
  const d = {
    BADGE: 'OPEN BET', CTA_MAIN: 'TAKE THE OTHER SIDE', CTA_SUB: '', BACKED_SIZE: 122,
    ...data, NOTE: (data.NOTE && data.NOTE.trim()) ? data.NOTE : 'called it.',
  };
  return fill(CHALLENGE_TPL, d);
}

// neutral "called off" card for voided bets — a cancelled bet must not keep
// unfurling as an open challenge
const VOID_TPL = `<svg viewBox="0 0 1200 630" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Duely bet called off">
<defs>
<style>.anton{font-family:'Anton','Oswald','Arial Narrow',Impact,sans-serif;}.inter{font-family:'Inter',system-ui,sans-serif;}</style>
<linearGradient id="vBg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#10161F"/><stop offset="1" stop-color="#0A0E13"/></linearGradient>
<linearGradient id="vDuel" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#14E0C8"/><stop offset=".5" stop-color="#14E0C8"/><stop offset=".5" stop-color="#7C3AED"/><stop offset="1" stop-color="#7C3AED"/></linearGradient>
</defs>
<rect width="1200" height="630" fill="#0A0E13"/><rect width="1200" height="630" fill="url(#vBg)"/>
<rect x="0" y="0" width="1200" height="6" fill="#33414F"/>
<g transform="translate(64,48)">
<g transform="scale(0.46)"><rect width="100" height="100" rx="26" fill="#0E141C"/><path d="M26 20 H56 C73 20 80 33 80 50 C80 67 73 80 56 80 H26 Z M39 33 H55 C64 33 68 41 68 50 C68 59 64 67 55 67 H39 Z" fill-rule="evenodd" fill="url(#vDuel)"/><rect x="51" y="20" width="3" height="60" fill="#0A0E13"/></g>
<text x="60" y="28" class="anton" font-size="30" fill="#F4F7FB" letter-spacing="1">DUELY</text>
<text x="62" y="46" class="inter" font-size="12" font-weight="700" fill="#14E0C8" letter-spacing="2.5">BACK YOURSELF.</text>
</g>
<text x="60" y="330" class="anton" font-size="96" fill="#93A1B3">CALLED OFF</text>
<text x="66" y="386" class="inter" font-size="26" font-weight="700" fill="#5E6B7C">{{HOME}} v {{AWAY}} &#183; this one didn't count</text>
<text x="66" y="560" class="inter" font-size="20" font-weight="800" fill="#14E0C8">Start your own on duely.live &#8594;</text>
</svg>`;
function voidSvg(data) { return fill(VOID_TPL, data); }
function resultSvg(data) {
  const d = { ...data, NOTE: (data.NOTE && data.NOTE.trim()) ? data.NOTE : 'told you so.' };
  return fill(RESULT_TPL, d);
}
function leagueSvg(data) { return fill(LEAGUE_TPL, data); }
function storySvg(data) { return fill(STORY_TPL, data); }

function renderPng(svg) {
  if (!Resvg) return null;
  try {
    const r = new Resvg(svg, {
      background: '#0B0F14',
      fitTo: { mode: 'width', value: 1200 },
      font: { fontDirs: [FONTS], loadSystemFonts: false, defaultFontFamily: 'Inter' },
    });
    return r.render().asPng();
  } catch (e) { console.warn('card png render failed:', e.message); return null; }
}

module.exports = { challengeSvg, resultSvg, leagueSvg, storySvg, voidSvg, renderPng, hasRasterizer: Boolean(Resvg) };

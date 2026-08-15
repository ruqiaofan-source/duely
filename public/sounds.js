'use strict';
// Clashly SFX v2 — LinkedIn-grade micro-sounds, synthesized, zero files.
// The signature moment: a riser while you hold-to-lock that completes into the
// Clashly chime when the bet is placed.
(function () {
  let ctx = null, riserNodes = null;
  const on = () => { try { return localStorage.getItem('clashly_sound') !== 'off'; } catch { return true; } };
  const ac = () => { if (!ctx) { try { ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch {} } if (ctx && ctx.state === 'suspended') ctx.resume().catch(() => {}); return ctx; };

  function tone(freq, dur, type, peak, slideTo, delay) {
    const c = ac(); if (!c) return;
    const t0 = c.currentTime + (delay || 0);
    const o = c.createOscillator(), g = c.createGain();
    o.type = type || 'sine'; o.frequency.setValueAtTime(freq, t0);
    if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t0 + dur);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(peak || 0.1, t0 + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g); g.connect(c.destination);
    o.start(t0); o.stop(t0 + dur + 0.05);
  }
  function noise(dur, peak, lpFrom, lpTo) {
    const c = ac(); if (!c) return;
    const n = Math.floor(c.sampleRate * dur), buf = c.createBuffer(1, n, c.sampleRate), d = buf.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / n);
    const src = c.createBufferSource(); src.buffer = buf;
    const f = c.createBiquadFilter(); f.type = 'lowpass';
    f.frequency.setValueAtTime(lpFrom || 1200, c.currentTime);
    if (lpTo) f.frequency.exponentialRampToValueAtTime(lpTo, c.currentTime + dur);
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, c.currentTime);
    g.gain.exponentialRampToValueAtTime(peak || 0.15, c.currentTime + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + dur);
    src.connect(f); f.connect(g); g.connect(c.destination); src.start();
  }

  const FX = {
    // THE signature: bet placed. Warm marimba-ish triad roll + soft sub thump.
    sig() { if (!on()) return; noise(0.06, 0.07, 400); tone(90, 0.16, 'sine', 0.22, 60); tone(523.25, 0.28, 'triangle', 0.12, null, 0); tone(659.25, 0.30, 'triangle', 0.12, null, 0.07); tone(783.99, 0.42, 'triangle', 0.13, null, 0.14); },
    // riser during hold-to-lock (starts low, climbs; stopped on release)
    riserStart() {
      if (!on()) return; FX.riserStop();
      const c = ac(); if (!c) return;
      const o = c.createOscillator(), g = c.createGain();
      o.type = 'sine'; o.frequency.setValueAtTime(220, c.currentTime);
      o.frequency.exponentialRampToValueAtTime(880, c.currentTime + 0.66);
      g.gain.setValueAtTime(0.0001, c.currentTime);
      g.gain.exponentialRampToValueAtTime(0.06, c.currentTime + 0.05);
      o.connect(g); g.connect(c.destination); o.start();
      riserNodes = { o, g, c };
    },
    riserStop(fail) {
      if (!riserNodes) return;
      const { o, g, c } = riserNodes; riserNodes = null;
      try {
        g.gain.cancelScheduledValues(c.currentTime);
        g.gain.setValueAtTime(g.gain.value || 0.05, c.currentTime);
        g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + 0.1);
        if (fail) o.frequency.exponentialRampToValueAtTime(140, c.currentTime + 0.1);
        o.stop(c.currentTime + 0.15);
      } catch {}
    },
    tick()    { if (on()) tone(1500, 0.035, 'sine', 0.05); },
    tab()     { if (on()) { tone(700, 0.045, 'sine', 0.06, 900); } },
    swish()   { if (on()) noise(0.18, 0.06, 600, 3000); },
    clip()    { if (!on()) return; tone(1100, 0.05, 'sine', 0.09); tone(1600, 0.08, 'sine', 0.07, null, 0.05); },
    whistle() { if (!on()) return; tone(2200, 0.09, 'square', 0.05); tone(2200, 0.16, 'square', 0.05, null, 0.12); },
    deal()    { if (!on()) return; tone(120, 0.1, 'sine', 0.18, 80); tone(523.25, 0.18, 'triangle', 0.1, null, 0.08); tone(1046.5, 0.26, 'triangle', 0.09, null, 0.16); },
    cheer()   { if (!on()) return; noise(1.1, 0.2, 900, 3800); tone(523, 0.5, 'triangle', 0.05, 784); tone(659, 0.4, 'triangle', 0.05, 1047, 0.18); },
    womp()    { if (on()) tone(220, 0.5, 'sawtooth', 0.08, 90); },
    pop()     { if (on()) tone(600, 0.07, 'sine', 0.1, 1200); },
    ping()    { if (!on()) return; tone(880, 0.1, 'sine', 0.08); tone(1174.7, 0.16, 'sine', 0.08, null, 0.09); },
    lock()    { FX.sig(); },
  };
  window.SFX = { play(name) { try { if (FX[name]) FX[name](); } catch {} }, on, toggle() { try { localStorage.setItem('clashly_sound', on() ? 'off' : 'on'); } catch {} } };
})();

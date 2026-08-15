'use strict';
// Clashly SFX — synthesized stadium sounds, zero audio files. WebAudio fires only
// after a user gesture (browser rule) and respects the sound toggle.
(function () {
  let ctx = null;
  const on = () => { try { return localStorage.getItem('clashly_sound') !== 'off'; } catch { return true; } };
  const ac = () => { if (!ctx) { try { ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch {} } if (ctx && ctx.state === 'suspended') ctx.resume().catch(() => {}); return ctx; };

  const env = (g, t, a, peak, d) => { g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(peak, t + a); g.gain.exponentialRampToValueAtTime(0.0001, t + d); };

  function tone(freq, dur, type, peak, slideTo) {
    const c = ac(); if (!c) return;
    const o = c.createOscillator(), g = c.createGain();
    o.type = type || 'sine'; o.frequency.setValueAtTime(freq, c.currentTime);
    if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, c.currentTime + dur);
    env(g, c.currentTime, 0.008, peak || 0.12, dur);
    o.connect(g); g.connect(c.destination);
    o.start(); o.stop(c.currentTime + dur + 0.05);
  }
  function noise(dur, peak, lpFrom, lpTo) {
    const c = ac(); if (!c) return;
    const n = Math.floor(c.sampleRate * dur), buf = c.createBuffer(1, n, c.sampleRate), d = buf.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / n);
    const src = c.createBufferSource(); src.buffer = buf;
    const f = c.createBiquadFilter(); f.type = 'lowpass';
    f.frequency.setValueAtTime(lpFrom || 1200, c.currentTime);
    if (lpTo) f.frequency.exponentialRampToValueAtTime(lpTo, c.currentTime + dur);
    const g = c.createGain(); env(g, c.currentTime, 0.01, peak || 0.2, dur);
    src.connect(f); f.connect(g); g.connect(c.destination); src.start();
  }

  const FX = {
    tick()    { if (on()) tone(1800, 0.03, 'square', 0.03); },
    lock()    { if (on()) { tone(150, 0.12, 'sine', 0.25, 90); noise(0.08, 0.08, 500); } },
    whistle() { if (!on()) return; tone(2200, 0.09, 'square', 0.06); setTimeout(() => tone(2200, 0.16, 'square', 0.06), 120); },
    cheer()   { if (!on()) return; noise(1.1, 0.22, 900, 3800); tone(523, 0.5, 'triangle', 0.05, 784); setTimeout(() => tone(659, 0.4, 'triangle', 0.05, 1047), 180); },
    womp()    { if (on()) tone(220, 0.5, 'sawtooth', 0.09, 90); },
    pop()     { if (on()) tone(600, 0.07, 'sine', 0.12, 1200); },
    ping()    { if (!on()) return; tone(880, 0.1, 'sine', 0.09); setTimeout(() => tone(1175, 0.16, 'sine', 0.09), 90); },
  };
  window.SFX = { play(name) { try { if (FX[name]) FX[name](); } catch {} }, on, toggle() { try { localStorage.setItem('clashly_sound', on() ? 'off' : 'on'); } catch {} } };
})();

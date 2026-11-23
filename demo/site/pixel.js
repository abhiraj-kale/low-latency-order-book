/* Tiny pixel toolkit: a hand-drawn 3x5 bitmap font, sprite blitting, pixel
   particles, and square-wave sound. Everything draws whole pixels on
   low-resolution canvases that CSS scales up with image-rendering: pixelated. */
const PX = (() => {
  "use strict";

  // Sweetie 16 palette.
  const P = {
    ink: "#1a1c2c", plum: "#5d275d", red: "#b13e53", orange: "#ef7d57", gold: "#ffcd75",
    lime: "#a7f070", green: "#38b764", teal: "#257179", navy: "#29366f", blue: "#3b5dc9",
    sky: "#41a6f6", cyan: "#73eff7", white: "#f4f4f4", silver: "#94b0c2", slate: "#566c86", shadow: "#333c57",
  };

  // 3x5 glyphs, rows top to bottom, '1' = pixel on.
  const RAW = {
    "0": "111101101101111", "1": "010110010010111", "2": "111001111100111", "3": "111001111001111",
    "4": "101101111001001", "5": "111100111001111", "6": "111100111101111", "7": "111001001001001",
    "8": "111101111101111", "9": "111101111001111",
    A: "010101111101101", B: "110101110101110", C: "011100100100011", D: "110101101101110",
    E: "111100110100111", F: "111100110100100", G: "011100101101011", H: "101101111101101",
    I: "111010010010111", J: "001001001101010", K: "101101110101101", L: "100100100100111",
    M: "101111111101101", N: "110101101101101", O: "010101101101010", P: "110101110100100",
    Q: "010101101110011", R: "110101110101101", S: "011100010001110", T: "111010010010010",
    U: "101101101101111", V: "101101101101010", W: "101101111111101", X: "101101010101101",
    Y: "101101010010010", Z: "111001010100111",
    ".": "000000000000010", ",": "000000000010100", ":": "000010000010000", "-": "000000111000000",
    "+": "000010111010000", "/": "001001010100100", "@": "010101111100011", "#": "101111101111101",
    "%": "101001010100101", ">": "100010001010100", "<": "001010100010001", "(": "010100100100010",
    ")": "010001001001010", "!": "010010010000010", "?": "110001010000010", "=": "000111000111000",
    "$": "011110010011110", "*": "000101010101000", "'": "010010000000000", "_": "000000000000111",
    "^": "010101000000000", " ": "000000000000000",
  };
  const GLYPH = {};
  for (const k in RAW) GLYPH[k] = Array.from(RAW[k], (c) => c === "1");

  function text(ctx, str, x, y, color, s = 1, align = "left") {
    str = String(str).toUpperCase();
    const w = textWidth(str, s);
    let cx = Math.round(align === "right" ? x - w : align === "center" ? x - w / 2 : x);
    y = Math.round(y);
    ctx.fillStyle = color;
    for (const ch of str) {
      const g = GLYPH[ch] || GLYPH["?"];
      for (let i = 0; i < 15; i++) if (g[i]) ctx.fillRect(cx + (i % 3) * s, y + ((i / 3) | 0) * s, s, s);
      cx += 4 * s;
    }
    return w;
  }
  const textWidth = (str, s = 1) => (String(str).length * 4 - 1) * s;

  // rows: array of strings; each char is a key into pal, '.' is transparent.
  function sprite(ctx, rows, x, y, pal, s = 1, flip = false) {
    x = Math.round(x); y = Math.round(y);
    for (let r = 0; r < rows.length; r++) {
      const row = rows[r];
      for (let c = 0; c < row.length; c++) {
        const ch = row[flip ? row.length - 1 - c : c];
        if (ch === "." || !pal[ch]) continue;
        ctx.fillStyle = pal[ch];
        ctx.fillRect(x + c * s, y + r * s, s, s);
      }
    }
  }

  // Fixed-resolution canvas: internal size w x h, scaled up by CSS.
  function fit(canvas, w, h) {
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    const ctx = canvas.getContext("2d");
    ctx.imageSmoothingEnabled = false;
    return ctx;
  }

  // Pixel particles with gravity and palette fade.
  function particles() {
    const list = [];
    return {
      list,
      burst(x, y, n, colors, speed = 1, gravity = 0.04) {
        for (let i = 0; i < n; i++) {
          const a = Math.random() * Math.PI * 2, v = (0.4 + Math.random()) * speed;
          list.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 0.3 * speed, life: 1, colors, g: gravity });
        }
      },
      step(ctx) {
        for (let i = list.length - 1; i >= 0; i--) {
          const p = list[i];
          p.x += p.vx; p.y += p.vy; p.vy += p.g; p.vx *= 0.98;
          p.life -= 0.025;
          if (p.life <= 0) { list.splice(i, 1); continue; }
          const ci = Math.min(p.colors.length - 1, Math.floor((1 - p.life) * p.colors.length));
          ctx.fillStyle = p.colors[ci];
          ctx.fillRect(Math.round(p.x), Math.round(p.y), 1, 1);
        }
      },
    };
  }

  // Square-wave sound, off until the visitor turns it on.
  const audio = {
    on: false, ctx: null, last: 0,
    ensure() { if (!this.ctx) this.ctx = new (window.AudioContext || window.webkitAudioContext)(); return this.ctx; },
    beep(freq, dur = 0.06, vol = 0.04, type = "square", when = 0) {
      if (!this.on) return;
      const ac = this.ensure(), t = ac.currentTime + when;
      const o = ac.createOscillator(), g = ac.createGain();
      o.type = type; o.frequency.setValueAtTime(freq, t);
      g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g).connect(ac.destination); o.start(t); o.stop(t + dur + 0.02);
    },
    arp(notes, step = 0.06, vol = 0.04) { notes.forEach((f, i) => this.beep(f, step * 1.4, vol, "square", i * step)); },
    tick() { const now = performance.now(); if (now - this.last > 70) { this.last = now; this.beep(1800 + Math.random() * 400, 0.015, 0.012); } },
  };

  return { P, text, textWidth, sprite, fit, particles, audio };
})();

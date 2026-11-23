/* LOB ARCADE. The order book is the C++ engine compiled to WebAssembly
   (lob.js + lob.wasm). This file makes order flow, reads trades, depth, and
   per-level queues out of WASM memory, and draws everything in whole pixels. */
(() => {
  "use strict";
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const { P } = PX;
  const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const fmtPx = (t) => (t / 100).toFixed(2);
  const fmtInt = (n) => Math.round(n).toLocaleString("en-US");
  const onVisible = (el, fn, threshold = 0.02) =>
    new IntersectionObserver((es) => es.forEach((e) => fn(e.isIntersecting)), { threshold }).observe(el);

  // ---------------------------------------------------------------- reveal + sound
  const revealObs = new IntersectionObserver((es) => es.forEach((e) => {
    if (e.isIntersecting) { e.target.classList.add("in"); revealObs.unobserve(e.target); }
  }), { threshold: 0.12 });
  $$(".wipe").forEach((el) => revealObs.observe(el));

  const soundBtn = $("#sound");
  soundBtn.addEventListener("click", () => {
    PX.audio.on = !PX.audio.on;
    soundBtn.setAttribute("aria-pressed", PX.audio.on);
    soundBtn.textContent = PX.audio.on ? "SOUND ON" : "SOUND OFF";
    if (PX.audio.on) { PX.audio.ensure().resume(); PX.audio.arp([523, 659, 784, 1047], 0.07); }
  });

  // ---------------------------------------------------------------- engine + order flow
  const PX_MIN = 0, PX_MAX = 40000, START = 10000, USER_BASE = 2000000000;
  let M = null;
  const sim = {
    fair: START, drift: 0, nextId: 1, live: [], ops: 0, trades: 0, last: null, prevLast: null,
    rate: 220, paused: false, due: 0, nsPerOp: null, winOps: 0, winMs: 0, tradeWindow: [],
  };
  const user = { side: 0, nextId: USER_BASE, orders: new Map() };
  const tapeQueue = [];
  const tradedMakers = new Map(); // maker id -> qty traded since the last screen snapshot
  let fireworkBudget = 0;
  let screenVisible = false;

  const CH = 1024;
  const gKind = new Uint8Array(CH), gSide = new Uint8Array(CH), gId = new Uint32Array(CH), gPx = new Int32Array(CH), gQty = new Uint32Array(CH);
  const gauss = () => { let u = 0; while (!u) u = Math.random(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * Math.random()); };
  const geometric = (p) => Math.floor(Math.log(1 - Math.random()) / Math.log(1 - p));
  function stepFair(dt) {
    sim.drift = sim.drift * Math.exp(-dt / 6) + gauss() * 0.9 * Math.sqrt(dt);
    sim.fair += sim.drift * dt * 6 + gauss() * 3.5 * Math.sqrt(dt);
    if (Math.random() < dt * 0.03) sim.fair += (Math.random() < 0.5 ? -1 : 1) * (4 + Math.random() * 6);
    sim.fair = Math.max(PX_MIN + 500, Math.min(PX_MAX - 500, sim.fair));
  }
  function genChunk(k, resting) {
    const pc = Math.max(0.08, Math.min(0.8, 0.2 + 0.45 * (resting / 700)));
    const f = Math.round(sim.fair);
    for (let i = 0; i < k; i++) {
      if (sim.live.length && Math.random() < pc) {
        const j = (Math.random() * sim.live.length) | 0;
        gKind[i] = 1; gId[i] = sim.live[j];
        sim.live[j] = sim.live[sim.live.length - 1]; sim.live.pop();
        continue;
      }
      const side = Math.random() < 0.5 ? 0 : 1, dir = side === 0 ? -1 : 1;
      let px, qty;
      if (Math.random() < 0.12) { px = f - dir * ((Math.random() * 4) | 0); qty = 10 * (1 + ((Math.random() * Math.random() * 50) | 0)); }
      else { px = f + dir * (1 + geometric(0.24)); qty = 10 * (1 + ((Math.random() * Math.random() * 36) | 0)); }
      gKind[i] = 0; gSide[i] = side; gPx[i] = Math.max(PX_MIN, Math.min(PX_MAX, px)); gQty[i] = qty;
      gId[i] = sim.nextId++;
      sim.live.push(gId[i]);
    }
  }
  function runOps(n) {
    while (n > 0) {
      const k = Math.min(n, CH);
      genChunk(k, M._lob_order_count());
      const t0 = performance.now();
      for (let i = 0; i < k; i++) {
        if (gKind[i]) M._lob_cancel(gId[i]);
        else M._lob_add(gId[i], gSide[i], gPx[i], gQty[i]);
      }
      sim.winMs += performance.now() - t0;
      sim.winOps += k;
      sim.ops += k;
      processTrades();
      n -= k;
    }
    if (sim.winOps >= 40000 && sim.winMs > 1) {
      const v = (sim.winMs * 1e6) / sim.winOps;
      sim.nsPerOp = sim.nsPerOp == null ? v : sim.nsPerOp * 0.6 + v * 0.4;
      sim.winOps = 0; sim.winMs = 0;
    }
  }
  function processTrades(takerId = -1) {
    const n = M._lob_trade_count();
    const out = { filled: 0, notional: 0, makers: 0 };
    if (!n) return out;
    const U = M.HEAPU32, I = M.HEAP32, base = M._lob_trades() >> 2;
    for (let i = 0; i < n; i++) {
      const o = base + i * 6;
      const maker = U[o], taker = U[o + 1], px = I[o + 2], q = U[o + 3], ts = U[o + 4];
      sim.trades++; sim.prevLast = sim.last; sim.last = px;
      tradedMakers.set(maker, (tradedMakers.get(maker) || 0) + q);
      if (taker === takerId) { out.filled += q; out.notional += q * px; out.makers++; }
      if (maker >= USER_BASE) userMakerFill(maker, px, q);
      if (i >= n - 10) tapeQueue.push({ maker, taker, px, q, buy: ts === 0 });
      if (fireworkBudget >= 1) { fireworkBudget--; city.firework(ts === 0); }
    }
    sim.tradeWindow.push([performance.now(), n]);
    if (tapeQueue.length > 10) tapeQueue.splice(0, tapeQueue.length - 10);
    if (sim.rate <= 220 && screenVisible) PX.audio.tick();
    M._lob_clear_trades();
    return out;
  }
  function userMakerFill(id, px, q) {
    const o = user.orders.get(id);
    if (!o) return;
    o.rem -= q;
    const done = o.rem <= 0;
    if (done) user.orders.delete(id);
    say([[`SOMEONE HIT YOUR ${o.side === 0 ? "BID" : "OFFER"}! `, ""], [`${fmtInt(q)} @ ${fmtPx(px)}`, "y"], [done ? " FULLY FILLED." : " PARTIAL FILL.", ""]]);
    PX.audio.arp([784, 988, 1175], 0.05, 0.05);
  }

  // ---------------------------------------------------------------- hero: the order book as a city
  const city = (() => {
    const cv = $("#city");
    let W = 320, H = 200, sky = null, stars = [], visible = true, frame = 0;
    const TW = 8, GAP = 2;
    let towers = [[], []]; // [bids, asks], index 0 nearest the avenue
    let bestBid = -1, bestAsk = -1;
    const rockets = [], parts = PX.particles();
    const hash = (n) => { n = (n ^ 61) ^ (n >>> 16); n = n + (n << 3); n = n ^ (n >>> 4); n = Math.imul(n, 0x27d4eb2d); return (n ^ (n >>> 15)) >>> 0; };

    function resize() {
      W = Math.max(160, Math.min(360, Math.round(cv.clientWidth / 4)));
      H = Math.max(120, Math.round((W * cv.clientHeight) / Math.max(1, cv.clientWidth)));
      // Sky, moon, and a far skyline are static: draw them once.
      sky = document.createElement("canvas");
      sky.width = W; sky.height = H;
      const s = sky.getContext("2d");
      const band = (y0, y1, c) => { s.fillStyle = c; s.fillRect(0, y0, W, y1 - y0); };
      const dither = (y0, y1, c) => { s.fillStyle = c; for (let y = y0; y < y1; y++) for (let x = (y & 1); x < W; x += 2) s.fillRect(x, y, 1, 1); };
      const g = H - 10;
      band(0, H, P.ink);
      dither(Math.round(H * 0.5), Math.round(H * 0.62), P.navy);
      band(Math.round(H * 0.62), g, P.navy);
      dither(Math.round(H * 0.78), g, P.plum);
      const mx = Math.round(W * 0.86), my = Math.round(H * 0.14), r = Math.max(6, Math.round(W / 36));
      for (let y = -r; y <= r; y++) for (let x = -r; x <= r; x++) if (x * x + y * y <= r * r) { s.fillStyle = P.white; s.fillRect(mx + x, my + y, 1, 1); }
      s.fillStyle = P.silver; s.fillRect(mx - 2, my - 1, 2, 2); s.fillRect(mx + 2, my + 2, 1, 1); s.fillRect(mx + 1, my - 3, 1, 1);
      let x = 0, k = 7;
      while (x < W) {
        const w = 6 + (hash(k) % 10), h = Math.round(H * 0.12 + (hash(k * 3) % Math.round(H * 0.16)));
        s.fillStyle = P.shadow; s.fillRect(x, g - h, w, h);
        s.fillStyle = P.navy;
        for (let wy = g - h + 3; wy < g - 2; wy += 4) for (let wx = x + 2; wx < x + w - 1; wx += 3) if (hash(wx * 31 + wy) % 5 === 0) s.fillRect(wx, wy, 1, 1);
        x += w + 1; k++;
      }
      stars = Array.from({ length: Math.round((W * H) / 700) }, (_, i) => [hash(i * 7) % W, hash(i * 13) % Math.round(H * 0.55), hash(i * 17) % 200, hash(i) % 3]);
      const n = Math.floor((W / 2 - 10) / (TW + GAP));
      const mk = () => Array.from({ length: n }, () => ({ h: 0, th: 0, q: 0, c: 0, p: 0 }));
      towers = [mk(), mk()];
    }

    function update() {
      if (!M) return;
      const read = (side) => {
        const n = M._lob_depth(side, 64), base = M._lob_depth_ptr(side) >> 2, I = M.HEAP32, m = new Map();
        for (let i = 0; i < n; i++) m.set(I[base + i * 3], [I[base + i * 3 + 1], I[base + i * 3 + 2]]);
        return [m, n ? I[base] : -1];
      };
      const [bm, bb] = read(0), [am, ba] = read(1);
      bestBid = bb; bestAsk = ba;
      const H2 = H * 0.4;
      let maxQ = 1;
      const fill = (side, m, best, dir) => towers[side].forEach((t, i) => {
        const p = best < 0 ? -1 : best + dir * i, v = m.get(p);
        t.p = p; t.q = v ? v[0] : 0; t.c = v ? v[1] : 0;
        maxQ = Math.max(maxQ, t.q);
      });
      fill(0, bm, bb, -1);
      fill(1, am, ba, 1);
      for (const side of towers) for (const t of side) t.th = t.q ? Math.round(10 + (H2 - 10) * Math.sqrt(t.q / maxQ)) : 0;
    }

    function firework(buy) {
      if (!visible || rockets.length > 6) return;
      rockets.push({ x: W / 2 + (Math.random() * 6 - 3), y: H - 12, vy: -1.4 - Math.random() * 0.6, apex: H * (0.22 + Math.random() * 0.3), buy });
    }

    function draw() {
      frame++;
      const ctx = PX.fit(cv, W, H);
      ctx.drawImage(sky, 0, 0);
      for (const [x, y, ph, b] of stars) if ((frame + ph) % 160 < 140) { ctx.fillStyle = b === 0 ? P.white : b === 1 ? P.silver : P.slate; ctx.fillRect(x, y, 1, 1); }
      const g = H - 10, cx = Math.round(W / 2);
      const drawTower = (t, i, side) => {
        t.h += Math.sign(t.th - t.h) * Math.max(1, Math.round(Math.abs(t.th - t.h) * 0.15));
        if (Math.abs(t.th - t.h) < 1) t.h = t.th;
        if (t.h <= 0) return;
        const x = side === 0 ? cx - 10 - (i + 1) * (TW + GAP) + GAP : cx + 10 + i * (TW + GAP);
        const top = g - t.h;
        ctx.fillStyle = side === 0 ? P.teal : P.plum; ctx.fillRect(x, top, TW, t.h);
        ctx.fillStyle = side === 0 ? P.green : P.red; ctx.fillRect(x, top, TW, 1); ctx.fillRect(side === 0 ? x : x + TW - 1, top, 1, t.h);
        // one window per resting order, in a fixed shuffled order per price
        const slots = [];
        for (let wy = top + 3; wy < g - 2; wy += 2) for (let wx = x + 2; wx < x + TW - 2; wx += 2) slots.push([wx, wy]);
        const lit = Math.min(slots.length, t.c), seed = hash(t.p + side * 99991);
        for (let k = 0; k < slots.length; k++) {
          const s = slots[(k * 7 + seed) % slots.length];
          ctx.fillStyle = k < lit && (frame + seed + k * 37) % 400 >= 3 ? P.gold : P.ink;
          ctx.fillRect(s[0], s[1], 1, 1);
        }
        if (user.orders.size && (frame >> 4) & 1) for (const o of user.orders.values()) if (o.side === side && o.px === t.p) { ctx.fillStyle = P.cyan; ctx.fillRect(x + 3, top - 3, 2, 2); }
      };
      towers[0].forEach((t, i) => drawTower(t, i, 0));
      towers[1].forEach((t, i) => drawTower(t, i, 1));
      ctx.fillStyle = P.slate; ctx.fillRect(0, g, W, 2);
      ctx.fillStyle = P.shadow; ctx.fillRect(0, g + 2, W, H - g - 2);
      ctx.fillStyle = P.gold; for (let y = g + 3; y < H; y += 3) ctx.fillRect(cx, y, 1, 1);
      for (const lx of [cx - 7, cx + 6]) { ctx.fillStyle = P.slate; ctx.fillRect(lx, g - 12, 1, 12); ctx.fillStyle = P.gold; ctx.fillRect(lx - (lx < cx ? 0 : 1), g - 13, 2, 1); }
      if (bestBid >= 0 && bestAsk >= 0) {
        const t = fmtPx(bestAsk - bestBid), w = PX.textWidth(t) + 4, sy = g - 30;
        ctx.fillStyle = P.slate; ctx.fillRect(cx, sy + 7, 1, 17);
        ctx.fillStyle = P.green; ctx.fillRect(cx - (w >> 1), sy, w, 7);
        PX.text(ctx, t, cx, sy + 1, P.white, 1, "center");
        PX.text(ctx, fmtPx(bestBid), cx - 11, g + 4, P.lime, 1, "right");
        PX.text(ctx, fmtPx(bestAsk), cx + 11, g + 4, P.orange, 1, "left");
      }
      for (let i = rockets.length - 1; i >= 0; i--) {
        const r = rockets[i];
        r.y += r.vy;
        ctx.fillStyle = P.gold; ctx.fillRect(Math.round(r.x), Math.round(r.y), 1, 2);
        if (r.y <= r.apex) {
          parts.burst(r.x, r.y, 22, r.buy ? [P.white, P.lime, P.green, P.teal] : [P.white, P.gold, P.orange, P.red], 0.9, 0.02);
          rockets.splice(i, 1);
        }
      }
      parts.step(ctx);
    }

    addEventListener("resize", resize);
    resize();
    onVisible($(".hero"), (v) => (visible = v));
    return { update, draw, firework, get visible() { return visible; } };
  })();

  // ---------------------------------------------------------------- the game screen: ladder with real queues
  const SW = 256, SH = 198, ROWS = 11, RH = 8, HEAD = 12, MIDY = HEAD + ROWS * RH, QX0 = 62, QX1 = 252;
  const screenCv = $("#screen");
  onVisible($(".cabinet"), (v) => (screenVisible = v));
  const vis = new Map(); // order id -> animated block
  const floaters = [];
  const sparks = PX.particles();
  let levels = [[], []], scale = 0.3, sframe = 0;

  function snapshot() {
    const read = (side) => {
      const n = M._lob_ladder(side, ROWS), U = M.HEAPU32, out = [];
      let w = M._lob_ladder_ptr(side) >> 2;
      for (let i = 0; i < n; i++) {
        const lv = { price: U[w], total: U[w + 1], count: U[w + 2], orders: [] };
        const k = U[w + 3]; w += 4;
        for (let j = 0; j < k; j++) { lv.orders.push([U[w], U[w + 1]]); w += 2; }
        out.push(lv);
      }
      return out;
    };
    levels = [read(0), read(1)];
    // Fit the busiest visible queue into the screen.
    let target = 1.2;
    for (const side of levels) for (const lv of side) {
      let q = 0;
      for (const [, qty] of lv.orders) q += qty;
      if (q) target = Math.min(target, (QX1 - QX0 - lv.orders.length) / q);
    }
    scale = scale * 0.7 + Math.max(0.02, target) * 0.3;
    const seen = new Set();
    levels.forEach((side, s) => side.forEach((lv, i) => {
      const y = s === 1 ? MIDY - RH * (i + 1) : MIDY + RH * (i + 1);
      let x = QX0;
      for (const [id, qty] of lv.orders) {
        const w = Math.max(1, Math.round(qty * scale));
        if (x + w > QX1) break;
        let v = vis.get(id);
        if (!v) { v = { x: QX1 + 2, y, w: 0, side: s, dying: 0, flash: 0 }; vis.set(id, v); }
        if (v.qty && qty < v.qty) { v.flash = 6; sparks.burst(v.x, y + 3, 4, [P.white, P.gold], 0.5); floatText("-" + (v.qty - qty), v.x, y, P.gold); }
        v.qty = qty; v.tx = x; v.ty = y; v.tw = w; v.side = s; v.mine = id >= USER_BASE; v.dying = 0;
        seen.add(id);
        x += w + 1;
      }
    }));
    for (const [id, v] of vis) {
      if (seen.has(id) || v.dying) continue;
      const traded = tradedMakers.get(id);
      if (traded) {
        v.dying = 1; v.filled = true;
        sparks.burst(v.x + v.w / 2, v.y + 3, 10, [P.white, P.gold, P.orange], 0.9);
        floatText("+" + traded, v.x, v.y, v.side === 0 ? P.lime : P.orange);
      } else if (v.x < QX1 - 2) {
        v.dying = 1; v.filled = false; // cancelled
      } else vis.delete(id);
    }
    tradedMakers.clear();
  }
  function floatText(t, x, y, c) { if (floaters.length < 14) floaters.push({ t, x: Math.min(QX1 - 16, x), y, c, life: 36 }); }
  function queueOverflows(lv) {
    let x = QX0;
    for (const [, q] of lv.orders) { x += Math.max(1, Math.round(q * scale)) + 1; if (x > QX1 + 1) return true; }
    return false;
  }

  function drawScreen() {
    sframe++;
    const ctx = PX.fit(screenCv, SW, SH);
    ctx.fillStyle = "#0f1020"; ctx.fillRect(0, 0, SW, SH);
    for (let r = 0; r < ROWS * 2 + 1; r++) if (r & 1) { ctx.fillStyle = "#13152a"; ctx.fillRect(0, HEAD + r * RH, SW, RH); }
    PX.text(ctx, "PRICE", 3, 3, P.slate);
    PX.text(ctx, "SIZE", 56, 3, P.slate, 1, "right");
    PX.text(ctx, "QUEUE: FRONT FILLS FIRST", QX0, 3, P.slate);
    ctx.fillStyle = P.navy; ctx.fillRect(0, MIDY, SW, RH);
    levels.forEach((side, s) => side.forEach((lv, i) => {
      const y = s === 1 ? MIDY - RH * (i + 1) : MIDY + RH * (i + 1);
      PX.text(ctx, fmtPx(lv.price), 3, y + 2, s === 1 ? P.orange : P.lime);
      PX.text(ctx, String(lv.total), 56, y + 2, P.silver, 1, "right");
      ctx.fillStyle = P.white; ctx.fillRect(58, y + 2, 1, 5); ctx.fillRect(59, y + 3, 1, 3); ctx.fillRect(60, y + 4, 1, 1);
      if (lv.count > lv.orders.length || queueOverflows(lv)) { ctx.fillStyle = P.slate; ctx.fillRect(QX1 + 1, y + 4, 1, 1); ctx.fillRect(QX1 + 3, y + 4, 1, 1); }
    }));
    const bb = levels[0][0], ba = levels[1][0];
    if (bb && ba) {
      PX.text(ctx, "MID " + ((bb.price + ba.price) / 200).toFixed(3), 3, MIDY + 2, P.gold);
      PX.text(ctx, "SPREAD " + fmtPx(ba.price - bb.price), QX1, MIDY + 2, P.white, 1, "right");
    }
    for (const [id, v] of vis) {
      v.x += (v.tx - v.x) * 0.25; v.y += (v.ty - v.y) * 0.3; v.w += (v.tw - v.w) * 0.35;
      if (v.dying) {
        v.dying++;
        if (v.filled) v.tw = 0; else v.ty += 0.4;
        if (v.dying > 16 || v.w < 0.5) { vis.delete(id); continue; }
      }
      const x = Math.round(v.x), y = Math.round(v.y) + 1, w = Math.max(1, Math.round(v.w));
      let body, top;
      if (v.dying && v.filled) { body = v.dying < 5 ? P.white : P.gold; top = P.white; }
      else if (v.dying) { body = P.shadow; top = P.slate; }
      else if (v.mine) { const on = (sframe >> 3) & 1; body = on ? P.gold : P.orange; top = P.white; }
      else if (v.flash > 0) { v.flash--; body = P.white; top = P.white; }
      else if (v.side === 1) { body = P.red; top = P.orange; }
      else { body = P.green; top = P.lime; }
      ctx.fillStyle = body; ctx.fillRect(x, y, w, 6);
      ctx.fillStyle = top; ctx.fillRect(x, y, w, 1);
    }
    for (let i = floaters.length - 1; i >= 0; i--) {
      const f = floaters[i];
      f.life--; f.y -= 0.35;
      if (f.life <= 0) { floaters.splice(i, 1); continue; }
      if (f.life > 6 || f.life & 1) PX.text(ctx, f.t, f.x, f.y, f.c);
    }
    sparks.step(ctx);
    if (sim.paused) {
      ctx.fillStyle = "rgba(15,16,32,0.6)"; ctx.fillRect(0, 0, SW, SH);
      if ((sframe >> 5) & 1) PX.text(ctx, "PAUSED", SW / 2, SH / 2 - 6, P.gold, 2, "center");
    }
  }

  // ---------------------------------------------------------------- HUD, tape, dialog
  const HU = { ops: $("#h-ops"), trades: $("#h-trades"), resting: $("#h-resting"), last: $("#h-last"), spread: $("#h-spread"), ns: $("#h-ns") };
  const topScore = $("#top-score"), tapeEl = $("#tape"), tapeRate = $("#tape-rate");
  let lastTape = 0;
  function paintHud(now) {
    HU.ops.textContent = String(sim.ops).padStart(9, "0");
    topScore.textContent = String(sim.ops % 1e8).padStart(8, "0");
    HU.trades.textContent = fmtInt(sim.trades);
    HU.resting.textContent = fmtInt(M._lob_order_count());
    if (sim.last != null) {
      HU.last.textContent = fmtPx(sim.last);
      HU.last.className = sim.prevLast == null || sim.last === sim.prevLast ? "" : sim.last > sim.prevLast ? "up" : "down";
    }
    const b = M._lob_best_bid(), a = M._lob_best_ask();
    if (b >= 0 && a >= 0) HU.spread.textContent = fmtPx(a - b);
    if (sim.nsPerOp != null) HU.ns.textContent = sim.nsPerOp.toFixed(0) + " NS";
    while (sim.tradeWindow.length && sim.tradeWindow[0][0] < now - 1000) sim.tradeWindow.shift();
    tapeRate.textContent = fmtInt(sim.tradeWindow.reduce((s, x) => s + x[1], 0)) + "/S";
    if (tapeQueue.length && now - lastTape > 180) {
      lastTape = now;
      for (const t of tapeQueue.splice(0).slice(-3)) {
        const li = document.createElement("li");
        const mine = t.maker >= USER_BASE || t.taker >= USER_BASE;
        li.className = (t.buy ? "b" : "s") + (mine ? " mine" : "");
        const id = (x) => (x >= USER_BASE ? "YOU" : "#" + x);
        li.innerHTML = `<span>${fmtPx(t.px)}</span><span>${t.q}</span><span class="ids">${id(t.maker)}&gt;${id(t.taker)}</span>`;
        tapeEl.insertBefore(li, tapeEl.firstChild);
      }
      while (tapeEl.children.length > 24) tapeEl.lastChild.remove();
    }
  }

  // RPG dialog box: segments of [text, colorKey] typed out one character at a time.
  const dialogEl = $("#dialog");
  let sayToken = 0;
  const COLORS = { g: P.lime, r: P.orange, y: P.gold, c: P.cyan, "": P.white };
  async function say(segs) {
    const tok = ++sayToken;
    dialogEl.innerHTML = "";
    let n = 0;
    for (const [t, c] of segs) {
      const span = document.createElement("span");
      span.style.color = COLORS[c] || P.white;
      dialogEl.appendChild(span);
      if (reduceMotion) { span.textContent = t; continue; }
      for (const ch of t) {
        if (tok !== sayToken) return;
        span.textContent += ch;
        if (ch !== " " && (n++ & 1) === 0) PX.audio.beep(420 + Math.random() * 60, 0.02, 0.02);
        await sleep(14);
      }
    }
  }

  // ---------------------------------------------------------------- controls
  const statusEl = $("#status");
  $$("#difficulty .pbtn").forEach((b) => b.addEventListener("click", () => {
    $$("#difficulty .pbtn").forEach((x) => x.classList.toggle("on", x === b));
    sim.rate = +b.dataset.rate;
    say([["DIFFICULTY: ", ""], [b.textContent, sim.rate >= 1e6 ? "r" : "y"], [` · ${fmtInt(sim.rate)} ORDERS PER SECOND INTO THE ENGINE.`, ""]]);
    PX.audio.beep(sim.rate >= 1e6 ? 220 : 660, 0.08, 0.05);
  }));
  $("#pause").addEventListener("click", (e) => {
    sim.paused = !sim.paused;
    e.currentTarget.classList.toggle("on", sim.paused);
    e.currentTarget.textContent = sim.paused ? "RESUME" : "PAUSE";
    statusEl.textContent = sim.paused ? "PAUSED" : "LIVE";
    statusEl.classList.toggle("paused", sim.paused);
  });
  const tPrice = $("#t-price"), tQty = $("#t-qty");
  $$(".ticket .side .pbtn").forEach((b) => b.addEventListener("click", () => {
    user.side = +b.dataset.side;
    $$(".ticket .side .pbtn").forEach((x) => x.classList.toggle("on", x === b));
    PX.audio.beep(user.side === 0 ? 523 : 392, 0.05);
  }));
  $$("[data-step]").forEach((b) => b.addEventListener("click", () => {
    const d = +b.dataset.d;
    if (b.dataset.step === "price") tPrice.value = Math.max(0.01, parseFloat(tPrice.value || "0") + d * 0.01).toFixed(2);
    else tQty.value = Math.max(10, Math.min(100000, (parseInt(tQty.value, 10) || 0) + d * 50));
    PX.audio.beep(880, 0.02, 0.03);
  }));
  $("#t-join").addEventListener("click", () => { if (!M) return; const p = user.side === 0 ? M._lob_best_bid() : M._lob_best_ask(); if (p >= 0) tPrice.value = fmtPx(p); });
  $("#t-cross").addEventListener("click", () => { if (!M) return; const p = user.side === 0 ? M._lob_best_ask() + 3 : M._lob_best_bid() - 3; if (p > 0) tPrice.value = fmtPx(p); });
  $("#t-cancel").addEventListener("click", () => {
    if (!M) return;
    let c = 0;
    for (const id of user.orders.keys()) c += M._lob_cancel(id);
    user.orders.clear();
    say(c ? [[`CANCELLED ${c} ORDER${c > 1 ? "S" : ""}. `, "y"], ["EACH ONE UNLINKED FROM ITS QUEUE IN O(1).", ""]] : [["YOU HAVE NO ORDERS RESTING.", ""]]);
  });
  $("#ticket").addEventListener("submit", (e) => {
    e.preventDefault();
    if (!M) return;
    const px = Math.round(parseFloat(tPrice.value) * 100), qty = parseInt(tQty.value, 10);
    if (!Number.isFinite(px) || !Number.isFinite(qty) || qty <= 0) { say([["THAT ORDER MAKES NO SENSE. TRY A PRICE AND A QUANTITY.", "r"]]); return; }
    const id = user.nextId++;
    const res = M._lob_add(id, user.side, px, qty);
    const fill = processTrades(id);
    const side = user.side === 0 ? "BUY" : "SELL";
    if (res === 2) { say([["REJECTED! ", "r"], [`PRICE MUST BE BETWEEN ${fmtPx(PX_MIN)} AND ${fmtPx(PX_MAX)}.`, ""]]); PX.audio.beep(110, 0.2, 0.05); return; }
    if (res === 1) {
      say([["FILLED! ", "g"], [`${side} ${fmtInt(fill.filled)} @ AVG ${(fill.notional / fill.filled / 100).toFixed(3)}`, "y"], [` AGAINST ${fill.makers} RESTING ORDER${fill.makers > 1 ? "S" : ""}, OLDEST FIRST.`, ""]]);
      PX.audio.arp([523, 659, 784, 1047], 0.05, 0.05);
    } else {
      user.orders.set(id, { px, side: user.side, rem: qty - fill.filled });
      say(fill.filled
        ? [[`FILLED ${fmtInt(fill.filled)}, `, "g"], [`RESTING ${fmtInt(qty - fill.filled)} @ ${fmtPx(px)}.`, "y"], [" LOOK FOR YOUR BLINKING BLOCK.", ""]]
        : [[`${side} ${fmtInt(qty)} @ ${fmtPx(px)} JOINS THE BACK OF THE QUEUE.`, "y"], [" BLINKING BLOCK = YOU. EVERYONE AHEAD FILLS FIRST.", ""]]);
      PX.audio.beep(330, 0.08, 0.05);
    }
    if (screenVisible) snapshot();
  });

  // ---------------------------------------------------------------- stage 2: the race
  const race = (() => {
    const cv = $("#race"), RW = 256, RHh = 110, X0 = 20, FIN = 238, X1 = FIN - 22;
    const CAR = ["..1111......", ".111111.....", "11122111111.", "111111111111", ".33....33..."];
    const lanes = [{ y: 40, name: "LOB", pal: { 1: P.lime, 2: P.cyan, 3: P.white }, x: X0 }, { y: 74, name: "MAP", pal: { 1: P.silver, 2: P.cyan, 3: P.white }, x: X0 }];
    let state = "idle", t0 = 0, countdown = "", result = null, n = 250000, f = 0, visible = false;
    const puff = PX.particles(), boom = PX.particles();
    const btn = $("#race-go"), out = $("#race-result");
    onVisible(cv, (v) => (visible = v));
    $$("#race-n .pbtn").forEach((b) => b.addEventListener("click", () => { n = +b.dataset.n; $$("#race-n .pbtn").forEach((x) => x.classList.toggle("on", x === b)); }));
    btn.addEventListener("click", start);
    async function start() {
      if (!M || state === "count" || state === "run") return;
      state = "count"; btn.disabled = true; result = null; lanes.forEach((l) => (l.x = X0));
      for (const c of ["3", "2", "1"]) {
        countdown = c; PX.audio.beep(440, 0.12, 0.05);
        await sleep(40);
        if (c === "3") {
          const wasPaused = sim.paused; sim.paused = true;
          const p = M._lob_bench(n, 7) >> 3, F = M.HEAPF64;
          result = { fast: F[p], ref: F[p + 1], ft: F[p + 2], rt: F[p + 3], fr: F[p + 4], rr: F[p + 5] };
          sim.paused = wasPaused;
        }
        await sleep(560);
      }
      countdown = "GO!"; PX.audio.beep(880, 0.25, 0.06);
      state = "run"; t0 = performance.now();
      setTimeout(() => (countdown = ""), 500);
    }
    function draw(now) {
      if (!visible) return;
      f++;
      const ctx = PX.fit(cv, RW, RHh);
      ctx.fillStyle = "#0f1020"; ctx.fillRect(0, 0, RW, RHh);
      for (let x = 2; x < RW; x += 3) {
        ctx.fillStyle = [P.slate, P.shadow, P.navy, P.plum][(x * 7 + (f >> 3) * (state === "done" ? 1 : 0)) % 4];
        ctx.fillRect(x, 6 + ((x * 13) % 3), 1, 1); ctx.fillRect(x + 1, 12 + ((x * 5) % 3), 1, 1);
      }
      for (const l of lanes) {
        ctx.fillStyle = P.shadow; ctx.fillRect(0, l.y - 7, RW, 20);
        ctx.fillStyle = P.slate; const off = state === "run" ? (f * 2) % 8 : 0;
        for (let x = -off; x < RW; x += 8) ctx.fillRect(x, l.y + 12, 4, 1);
        PX.text(ctx, l.name, 3, l.y - 6, P.white);
      }
      ctx.fillStyle = P.white; ctx.fillRect(X0 + 24, 32, 1, 62);
      for (let y = 32; y < 94; y += 2) for (let c = 0; c < 2; c++) { ctx.fillStyle = ((y >> 1) + c) & 1 ? P.white : P.ink; ctx.fillRect(FIN + c * 2, y, 2, 2); }
      if (state === "run" && result) {
        const slow = 3200, tf = slow * (result.fast / result.ref), dt = now - t0;
        lanes[0].x = X0 + (X1 - X0) * Math.min(1, dt / tf);
        lanes[1].x = X0 + (X1 - X0) * Math.min(1, dt / slow);
        lanes.forEach((l) => { if (l.x < X1 && f % 2 === 0) puff.burst(l.x, l.y + 6, 1, [P.silver, P.slate, P.shadow], 0.35, -0.01); });
        if (dt >= tf && !result.firstDone) { result.firstDone = true; boom.burst(FIN, lanes[0].y + 4, 30, [P.white, P.gold, P.lime], 1); PX.audio.arp([784, 988, 1175, 1568], 0.07, 0.05); }
        if (dt >= slow) finish();
      }
      lanes.forEach((l, i) => PX.sprite(ctx, CAR, l.x, l.y - 1 + (state === "run" && ((f >> 2) + i) & 1 ? 1 : 0), l.pal, 2));
      puff.step(ctx); boom.step(ctx);
      if (countdown) PX.text(ctx, countdown, RW / 2, 50, countdown === "GO!" ? P.lime : P.gold, 4, "center");
      if (state === "idle" && (f >> 5) & 1) PX.text(ctx, "READY?", RW / 2, 54, P.gold, 2, "center");
      if (state === "done" && result) PX.text(ctx, `LOB WINS BY ${(result.ref / result.fast).toFixed(1)}X`, RW / 2, 100, P.gold, 1, "center");
    }
    function finish() {
      state = "done"; btn.disabled = false; btn.textContent = "RACE AGAIN";
      const fm = n / result.fast / 1000, rm = n / result.ref / 1000;
      const agree = result.ft === result.rt && result.fr === result.rr;
      out.innerHTML = `<b>LOB ${fm.toFixed(1)}M ops/s</b> vs MAP ${rm.toFixed(1)}M ops/s over ${fmtInt(n)} orders: <span class="g">${(fm / rm).toFixed(1)}x faster</span> in this tab. ` +
        (agree ? `Both books agree: ${fmtInt(result.ft)} shares traded, ${fmtInt(result.fr)} orders resting.` : "Books disagree.");
    }
    return { draw, ready() { btn.disabled = false; btn.textContent = "START RACE"; } };
  })();

  // ---------------------------------------------------------------- stage 3: manual animations
  function manual(id, setup) {
    const cv = $(id), W = 128, Hh = 56;
    let visible = false, f = 0;
    const st = setup();
    onVisible(cv, (v) => (visible = v));
    function loop() {
      if (visible) { f++; const ctx = PX.fit(cv, W, Hh); ctx.fillStyle = "#0f1020"; ctx.fillRect(0, 0, W, Hh); st.draw(ctx, f); }
      requestAnimationFrame(loop);
    }
    if (st.run) (async () => { for (;;) { if (visible) await st.run(); else await sleep(300); } })();
    requestAnimationFrame(loop);
  }

  // Bitset radar: the best level empties, scan words for the next set bit.
  manual("#m-bits", () => {
    let on = [], best = -1, gone = -1, scan = -1, found = -1;
    const sp = PX.particles();
    const rnd = () => { on = Array.from({ length: 64 }, (_, i) => i > 2 && Math.random() < 0.1); on[1 + ((Math.random() * 4) | 0)] = true; };
    rnd();
    return {
      async run() {
        if (on.filter(Boolean).length < 3) rnd();
        best = on.indexOf(true); found = -1; gone = -1; await sleep(900);
        on[best] = false; gone = best; await sleep(600);
        for (let w = best >> 4; w < 4; w++) {
          scan = w; await sleep(520);
          const s = w === best >> 4 ? (best & 15) + 1 : 0;
          for (let b = s; b < 16; b++) if (on[w * 16 + b]) { found = w * 16 + b; break; }
          if (found >= 0) break;
        }
        scan = -1;
        if (found < 0) { rnd(); return; }
        best = found; gone = -1;
        sp.burst(12 + (found & 15) * 7 + 3, 5 + (found >> 4) * 12 + 3, 10, [P.white, P.gold, P.orange], 0.6, 0.01);
        await sleep(1200);
        for (let i = 0; i < 2; i++) on[4 + ((Math.random() * 60) | 0)] = true;
      },
      draw(ctx, f) {
        for (let w = 0; w < 4; w++) {
          const y = 5 + w * 12;
          PX.text(ctx, "W" + w, 1, y + 1, scan === w ? P.sky : P.slate);
          if (scan === w) { ctx.fillStyle = P.sky; ctx.fillRect(10, y - 2, 114, 1); ctx.fillRect(10, y + 7, 114, 1); if ((f >> 3) & 1) PX.text(ctx, "<", 124, y + 1, P.sky); }
          for (let b = 0; b < 16; b++) {
            const i = w * 16 + b, x = 12 + b * 7;
            ctx.fillStyle = i === best && found >= 0 ? ((f >> 3) & 1 ? P.gold : P.white) : i === best && gone < 0 ? P.gold : i === gone ? P.plum : on[i] ? P.red : P.shadow;
            ctx.fillRect(x, y, 6, 6);
          }
        }
        sp.step(ctx);
      },
    };
  });

  // FIFO train: couple on at the back, unhook from the middle, leave from the front.
  manual("#m-fifo", () => {
    const cars = [];
    let next = 41, label = "", lc = P.white;
    const sp = PX.particles();
    const layout = () => cars.forEach((c, i) => (c.tx = 22 + i * 17));
    for (let i = 0; i < 4; i++) cars.push({ id: next++, x: 22 + i * 17, tx: 0, y: 30, ty: 30, c: i & 1 ? P.green : P.teal });
    layout();
    return {
      async run() {
        cars.push({ id: next++, x: 140, tx: 0, y: 30, ty: 30, c: cars.length & 1 ? P.green : P.teal });
        layout(); label = "ADD: COUPLE AT THE BACK"; lc = P.lime; await sleep(1500);
        const mi = 1 + ((Math.random() * (cars.length - 2)) | 0), v = cars[mi];
        v.c = P.red; label = "CANCEL: UNHOOK, O(1)"; lc = P.orange; await sleep(500);
        v.ty = 10; await sleep(450); cars.splice(mi, 1); layout(); await sleep(1100);
        const h = cars[0]; h.c = P.gold; h.tx = -20; label = "FILL: FRONT LEAVES FIRST"; lc = P.gold;
        sp.burst(16, 34, 8, [P.white, P.gold], 0.5);
        await sleep(700); cars.shift(); layout(); await sleep(1100);
        if (cars.length < 3) { cars.push({ id: next++, x: 140, tx: 0, y: 30, ty: 30, c: P.green }); layout(); }
      },
      draw(ctx, f) {
        ctx.fillStyle = P.slate; ctx.fillRect(0, 41, 128, 1); ctx.fillRect(0, 44, 128, 1);
        for (let x = 0; x < 128; x += 4) { ctx.fillStyle = P.shadow; ctx.fillRect(x, 42, 2, 2); }
        ctx.fillStyle = P.shadow; ctx.fillRect(0, 22, 16, 22); ctx.fillStyle = P.ink; ctx.fillRect(3, 26, 10, 18);
        for (const c of cars) {
          c.x += (c.tx - c.x) * 0.12; c.y += (c.ty - c.y) * 0.2;
          const x = Math.round(c.x), y = Math.round(c.y);
          if (x < 2) continue;
          ctx.fillStyle = c.c; ctx.fillRect(x, y, 15, 9);
          ctx.fillStyle = P.ink; ctx.fillRect(x + 2, y + 9, 3, 2); ctx.fillRect(x + 10, y + 9, 3, 2);
          PX.text(ctx, String(c.id), x + 2, y + 2, P.ink);
        }
        ctx.fillStyle = P.slate; ctx.fillRect(0, 22, 3, 22);
        sp.step(ctx);
        PX.text(ctx, label, 64, 4, lc, 1, "center");
      },
    };
  });

  // Item pool: LIFO free list, the slot freed last is handed out next.
  manual("#m-pool", () => {
    const used = Array.from({ length: 24 }, () => Math.random() < 0.55), free = [];
    used.forEach((u, i) => { if (!u) free.push(i); });
    let fly = null, warm = -1, label = "", lc = P.white;
    const slotXY = (i) => [4 + (i % 8) * 12, 8 + ((i / 8) | 0) * 13];
    const stackXY = (k) => [110, 44 - k * 6];
    return {
      async run() {
        const doFree = free.length < 3 || (Math.random() < 0.5 && free.length < 10);
        if (doFree) {
          const ids = used.map((u, i) => (u ? i : -1)).filter((i) => i >= 0);
          const i = ids[(Math.random() * ids.length) | 0];
          used[i] = false; label = "CANCEL: PUSH " + i; lc = P.orange;
          fly = { from: slotXY(i), to: stackXY(Math.min(5, free.length)), t: 0 };
          await sleep(650); free.push(i); fly = null; await sleep(900);
          const j = free.pop(); label = "ADD: POP " + j + ", STILL WARM"; lc = P.gold;
          fly = { from: stackXY(Math.min(5, free.length)), to: slotXY(j), t: 0 };
          await sleep(650); used[j] = true; fly = null; warm = j; await sleep(1100); warm = -1;
        } else {
          const j = free.pop(); label = "ADD: POP " + j; lc = P.lime;
          fly = { from: stackXY(Math.min(5, free.length)), to: slotXY(j), t: 0 };
          await sleep(650); used[j] = true; fly = null; warm = j; await sleep(1000); warm = -1;
        }
      },
      draw(ctx, f) {
        used.forEach((u, i) => {
          const [x, y] = slotXY(i);
          ctx.fillStyle = P.shadow; ctx.fillRect(x, y, 10, 10);
          if (u) { ctx.fillStyle = i === warm && (f >> 3) & 1 ? P.gold : P.green; ctx.fillRect(x + 2, y + 2, 6, 6); ctx.fillStyle = i === warm ? P.white : P.lime; ctx.fillRect(x + 2, y + 2, 6, 1); }
        });
        PX.text(ctx, "FREE", 108, 1, P.slate);
        free.slice(-6).forEach((v, k) => { const [x, y] = stackXY(k); ctx.fillStyle = P.gold; ctx.fillRect(x, y, 12, 4); ctx.fillStyle = P.orange; ctx.fillRect(x, y + 3, 12, 1); });
        if (fly) {
          fly.t = Math.min(1, fly.t + 0.06);
          const x = fly.from[0] + (fly.to[0] - fly.from[0]) * fly.t, y = fly.from[1] + (fly.to[1] - fly.from[1]) * fly.t - Math.sin(fly.t * Math.PI) * 8;
          ctx.fillStyle = P.white; ctx.fillRect(Math.round(x), Math.round(y), 8, 4);
        }
        PX.text(ctx, label, 2, 49, lc);
      },
    };
  });

  // SPSC loop: the producer drops orders into ring slots, the consumer picks them up.
  manual("#m-ring", () => {
    const N = 16;
    let head = 4, tail = 0, hA = 4, tA = 0, acc = 0, mode = 0, mt = 0, taken = 0;
    const pos = (k) => { const a = -Math.PI / 2 + (k / N) * Math.PI * 2; return [64 + Math.cos(a) * 46, 26 + Math.sin(a) * 18]; };
    return {
      draw(ctx) {
        if (++mt > 220) { mt = 0; mode = (mode + 1) % 3; }
        if (++acc > 9) {
          acc = 0;
          const pp = [0.85, 0.5, 0.25][mode], cp = [0.35, 0.5, 0.9][mode];
          if (head - tail < N && Math.random() < pp) head++;
          if (head > tail && Math.random() < cp) { tail++; taken++; }
        }
        hA += (head - hA) * 0.15; tA += (tail - tA) * 0.15;
        for (let k = 0; k < N; k++) {
          const [x, y] = pos(k + 0.5);
          let full = false;
          for (let s = tail; s < head; s++) if (s % N === k) full = true;
          ctx.fillStyle = full ? P.gold : P.shadow; ctx.fillRect(Math.round(x) - 2, Math.round(y) - 2, 5, 5);
          if (full) { ctx.fillStyle = P.orange; ctx.fillRect(Math.round(x) - 2, Math.round(y) + 2, 5, 1); }
        }
        const car = (k, c) => { const [x, y] = pos(k); ctx.fillStyle = c; ctx.fillRect(Math.round(x) - 3, Math.round(y) - 3, 6, 6); ctx.fillStyle = P.ink; ctx.fillRect(Math.round(x) - 1, Math.round(y) - 1, 2, 2); };
        car(hA + 0.5, P.lime); car(tA + 0.5, P.sky);
        PX.text(ctx, "SPSC", 64, 19, P.white, 1, "center");
        PX.text(ctx, `${head - tail}/${N}`, 64, 27, P.gold, 1, "center");
        PX.text(ctx, "PRODUCER", 2, 50, P.lime);
        PX.text(ctx, "CONSUMER", 126, 50, P.sky, 1, "right");
        PX.text(ctx, String(taken), 64, 50, P.slate, 1, "center");
      },
    };
  });

  // ---------------------------------------------------------------- main loop
  let lastT = performance.now(), lastSnap = 0, lastHud = 0, lastCity = 0;
  function frame(now) {
    const dt = Math.min(0.1, (now - lastT) / 1000);
    lastT = now;
    fireworkBudget = Math.min(3, fireworkBudget + dt * 2.2);
    if (M && !sim.paused) {
      stepFair(dt);
      sim.due += sim.rate * dt;
      const n = Math.floor(sim.due);
      sim.due -= n;
      if (n) runOps(n);
    }
    if (M) {
      if (city.visible) { if (now - lastCity > 140) { city.update(); lastCity = now; } city.draw(); }
      if (screenVisible) { if (now - lastSnap > 70) { snapshot(); lastSnap = now; } drawScreen(); }
      if (now - lastHud > 120) { paintHud(now); lastHud = now; }
    } else if (city.visible) city.draw();
    race.draw(now);
    requestAnimationFrame(frame);
  }

  function boot(mod) {
    M = mod;
    M._lob_init(PX_MIN, PX_MAX, 1 << 16);
    for (let i = 0; i < 4; i++) { genChunk(CH, M._lob_order_count()); for (let j = 0; j < CH; j++) gKind[j] ? M._lob_cancel(gId[j]) : M._lob_add(gId[j], gSide[j], gPx[j], gQty[j]); M._lob_clear_trades(); }
    const p = M._lob_bench(100000, 3) >> 3;
    sim.nsPerOp = (M.HEAPF64[p] * 1e6) / 100000;
    statusEl.textContent = "LIVE";
    race.ready();
    city.update();
    say([["PLAYER 1 READY. ", "y"], ["GREEN BLOCKS ARE BIDS, RED ARE ASKS, EACH ONE A REAL ORDER IN THE C++ ENGINE. PICK A SIDE AND PRESS FIRE.", ""]]);
  }
  requestAnimationFrame(frame);
  if (typeof createLob === "function") createLob().then(boot).catch((e) => { console.error(e); statusEl.textContent = "ENGINE FAILED"; });
  else statusEl.textContent = "ENGINE FAILED";
})();

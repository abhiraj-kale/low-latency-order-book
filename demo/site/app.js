/* Live demo for lob::OrderBook. The book itself is the C++ engine compiled to
   WebAssembly (lob.js + lob.wasm); this file only generates order flow, reads
   trades and depth out of WASM memory, and draws. */
(() => {
  "use strict";

  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const fmtPx = (t) => (t / 100).toFixed(2);
  const fmtInt = (n) => Math.round(n).toLocaleString("en-US");
  const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
  const COLORS = { bid: css("--bid"), ask: css("--ask"), accent: css("--accent"), amber: css("--amber"), line: css("--line"), dim: css("--dim"), muted: css("--muted") };

  // ------------------------------------------------------------------ page chrome
  const nav = $(".nav");
  addEventListener("scroll", () => nav.classList.toggle("scrolled", scrollY > 30), { passive: true });

  function countUp(el) {
    const target = parseFloat(el.dataset.count);
    const dec = parseInt(el.dataset.decimals || "0", 10);
    const suf = el.dataset.suffix || "";
    const t0 = performance.now();
    const dur = reduceMotion ? 1 : 1600;
    const tick = (now) => {
      const p = Math.min(1, (now - t0) / dur);
      const e = 1 - Math.pow(1 - p, 4);
      el.textContent = (target * e).toFixed(dec) + suf;
      if (p < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  const revealObs = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        e.target.classList.add("in");
        $$("[data-count]", e.target).forEach(countUp);
        if (e.target.matches("[data-count]")) countUp(e.target);
        $$(".fill[data-w]", e.target).forEach((f) => {
          const max = parseFloat(f.dataset.max || "46.5");
          f.style.width = Math.min(100, (parseFloat(f.dataset.w) / max) * 100) + "%";
        });
        revealObs.unobserve(e.target);
      }
    },
    { threshold: 0.18 }
  );
  $$(".reveal").forEach((el) => revealObs.observe(el));

  $$(".card").forEach((c) =>
    c.addEventListener("pointermove", (e) => {
      const r = c.getBoundingClientRect();
      c.style.setProperty("--mx", e.clientX - r.left + "px");
      c.style.setProperty("--my", e.clientY - r.top + "px");
    })
  );

  const toastEl = $("#toast");
  let toastTimer = 0;
  function toast(html) {
    toastEl.innerHTML = html;
    toastEl.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove("show"), 2600);
  }

  // Runs fn(visible) whenever an element enters or leaves the viewport.
  function onVisible(el, fn) {
    new IntersectionObserver((es) => es.forEach((e) => fn(e.isIntersecting)), { threshold: 0.05 }).observe(el);
  }

  // ------------------------------------------------------------------ hero canvas
  const hero = (() => {
    const cv = $("#hero-canvas");
    const ctx = cv.getContext("2d");
    let w = 0, h = 0, dpr = 1, visible = true;
    const parts = [];
    const sparks = [];
    function resize() {
      dpr = Math.min(2, devicePixelRatio || 1);
      w = cv.clientWidth; h = cv.clientHeight;
      cv.width = w * dpr; cv.height = h * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    function spawn(p, fresh) {
      p.side = Math.random() < 0.5 ? 0 : 1;
      p.y0 = Math.random() * h;
      p.z = 0.3 + Math.random() * 0.7;
      p.v = (40 + Math.random() * 120) * p.z;
      p.len = 14 + 40 * p.z;
      p.x = fresh ? Math.random() * (w / 2) : 0; // distance travelled from the edge
    }
    function init() {
      resize();
      parts.length = 0;
      const n = Math.round(Math.min(160, (w * h) / 9000));
      for (let i = 0; i < n; i++) { const p = {}; spawn(p, true); parts.push(p); }
    }
    function burst(isBuy) {
      if (!visible || sparks.length > 220) return;
      const y = h / 2 + (Math.random() - 0.5) * h * 0.42;
      for (let i = 0; i < 7; i++) {
        const a = Math.random() * Math.PI * 2;
        const s = 40 + Math.random() * 160;
        sparks.push({ x: w / 2, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: 1, buy: isBuy });
      }
    }
    let last = performance.now();
    function frame(now) {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      if (visible) {
        ctx.clearRect(0, 0, w, h);
        // faint grid
        ctx.strokeStyle = "rgba(122,162,255,0.045)";
        ctx.lineWidth = 1;
        for (let x = (w / 2) % 48; x < w; x += 48) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke(); }
        for (let y = (h / 2) % 48; y < h; y += 48) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke(); }
        // matching line
        const g = ctx.createLinearGradient(0, 0, 0, h);
        g.addColorStop(0, "rgba(122,162,255,0)");
        g.addColorStop(0.5, "rgba(122,162,255,0.55)");
        g.addColorStop(1, "rgba(122,162,255,0)");
        ctx.fillStyle = g;
        ctx.fillRect(w / 2 - 1, 0, 2, h);
        // order streams converging on the book
        const half = w / 2;
        for (const p of parts) {
          p.x += p.v * dt;
          const t = p.x / half;
          if (t >= 1) { spawn(p, false); continue; }
          const y = h / 2 + (p.y0 - h / 2) * (1 - 0.72 * t * t);
          const dir = p.side === 0 ? 1 : -1;
          const x = p.side === 0 ? p.x : w - p.x;
          const fade = Math.min(1, t * 4) * (1 - Math.pow(t, 6));
          ctx.strokeStyle = p.side === 0 ? `rgba(49,224,161,${0.5 * p.z * fade})` : `rgba(255,93,122,${0.5 * p.z * fade})`;
          ctx.lineWidth = 1.6 * p.z;
          ctx.beginPath();
          ctx.moveTo(x - dir * p.len, y);
          ctx.lineTo(x, y);
          ctx.stroke();
        }
        // trade sparks
        for (let i = sparks.length - 1; i >= 0; i--) {
          const s = sparks[i];
          s.life -= dt * 1.4;
          if (s.life <= 0) { sparks.splice(i, 1); continue; }
          s.x += s.vx * dt; s.y += s.vy * dt;
          s.vx *= 0.96; s.vy *= 0.96;
          ctx.fillStyle = `rgba(255,193,99,${s.life})`;
          ctx.beginPath();
          ctx.arc(s.x, s.y, 1.8 * s.life + 0.4, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      requestAnimationFrame(frame);
    }
    addEventListener("resize", init);
    init();
    if (!reduceMotion) requestAnimationFrame(frame);
    onVisible($(".hero"), (v) => (visible = v));
    return { burst };
  })();

  // ------------------------------------------------------------------ engine
  const PX_MIN = 0, PX_MAX = 40000, START = 10000, USER_BASE = 2000000000;
  let M = null;
  const E = {
    add: (id, side, px, qty) => M._lob_add(id, side, px, qty),
    cancel: (id) => M._lob_cancel(id),
    bid: () => M._lob_best_bid(),
    ask: () => M._lob_best_ask(),
    count: () => M._lob_order_count(),
  };

  const sim = {
    fair: START, drift: 0, nextId: 1, live: [], ops: 0, trades: 0,
    last: null, prevLast: null, rate: 316, paused: false, due: 0,
    nsPerOp: null, winOps: 0, winMs: 0, tradeWindow: [],
  };
  const user = { side: 0, nextId: USER_BASE, orders: new Map() };
  const pendingTape = [];
  const hitLevels = new Set();

  // Order flow: Gaussian fair-value walk in time, passive orders a few ticks
  // away from it, ~12% aggressive orders that cross, and cancels that keep
  // the resting book near a target size.
  const CH = 1024;
  const gKind = new Uint8Array(CH), gSide = new Uint8Array(CH), gId = new Uint32Array(CH), gPx = new Int32Array(CH), gQty = new Uint32Array(CH);
  function gauss() { let u = 0; while (!u) u = Math.random(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * Math.random()); }
  function geometric(p) { return Math.floor(Math.log(1 - Math.random()) / Math.log(1 - p)); }
  function stepFair(dt) {
    sim.drift = sim.drift * Math.exp(-dt / 6) + gauss() * 0.9 * Math.sqrt(dt);
    sim.fair += sim.drift * dt * 8 + gauss() * 5 * Math.sqrt(dt);
    if (Math.random() < dt * 0.04) sim.fair += (Math.random() < 0.5 ? -1 : 1) * (6 + Math.random() * 10);
    sim.fair = Math.max(PX_MIN + 500, Math.min(PX_MAX - 500, sim.fair));
  }
  function genChunk(k, resting) {
    const pc = Math.max(0.08, Math.min(0.8, 0.2 + 0.45 * (resting / 900)));
    const f = Math.round(sim.fair);
    for (let i = 0; i < k; i++) {
      if (sim.live.length && Math.random() < pc) {
        const j = (Math.random() * sim.live.length) | 0;
        gKind[i] = 1;
        gId[i] = sim.live[j];
        sim.live[j] = sim.live[sim.live.length - 1];
        sim.live.pop();
        continue;
      }
      const side = Math.random() < 0.5 ? 0 : 1;
      const dir = side === 0 ? -1 : 1; // passive direction
      let px, qty;
      if (Math.random() < 0.12) {
        px = f - dir * ((Math.random() * 4) | 0);
        qty = 10 * (1 + ((Math.random() * Math.random() * 60) | 0));
      } else {
        px = f + dir * (1 + geometric(0.22));
        qty = 10 * (1 + ((Math.random() * Math.random() * 40) | 0));
      }
      gKind[i] = 0; gSide[i] = side; gPx[i] = Math.max(PX_MIN, Math.min(PX_MAX, px)); gQty[i] = qty;
      gId[i] = sim.nextId++;
      sim.live.push(gId[i]);
    }
  }
  function runOps(n) {
    while (n > 0) {
      const k = Math.min(n, CH);
      genChunk(k, E.count());
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

  let sparkBudget = 0;
  function processTrades() {
    const n = M._lob_trade_count();
    if (!n) return;
    const U = M.HEAPU32, I = M.HEAP32, base = M._lob_trades() >> 2;
    const now = performance.now();
    for (let i = 0; i < n; i++) {
      const o = base + i * 6;
      const maker = U[o], taker = U[o + 1], px = I[o + 2], q = U[o + 3], ts = U[o + 4];
      sim.trades++;
      sim.prevLast = sim.last;
      sim.last = px;
      hitLevels.add(px);
      if (maker >= USER_BASE) userMakerFill(maker, px, q);
      if (i >= n - 14) pendingTape.push({ maker, taker, px, q, buy: ts === 0 });
      if (sparkBudget > 0) { sparkBudget--; hero.burst(ts === 0); }
    }
    sim.tradeWindow.push([now, n]);
    if (pendingTape.length > 14) pendingTape.splice(0, pendingTape.length - 14);
    M._lob_clear_trades();
  }

  function userMakerFill(id, px, q) {
    const o = user.orders.get(id);
    if (!o) return;
    o.rem -= q;
    const done = o.rem <= 0;
    if (done) user.orders.delete(id);
    toast(`<span class="ok">Your ${o.side === 0 ? "buy" : "sell"}</span> ${done ? "filled" : "partly filled"}: ${fmtInt(q)} @ ${fmtPx(px)}`);
  }

  // ------------------------------------------------------------------ ladder + tape
  const LEVELS = 11;
  function buildRows(container) {
    const rows = [];
    for (let i = 0; i < LEVELS; i++) {
      const r = document.createElement("div");
      r.className = "lrow empty";
      r.innerHTML = '<div class="bar"></div><span class="px">--</span><span class="sz">--</span><span class="cnt">--</span>';
      container.appendChild(r);
      rows.push({ el: r, bar: r.firstChild, px: r.children[1], sz: r.children[2], cnt: r.children[3], p: -1, q: -1 });
    }
    return rows;
  }
  const askRows = buildRows($("#asks")).reverse(); // askRows[0] is the bottom row, closest to the spread
  const bidRows = buildRows($("#bids"));
  function restart(el, cls) { el.classList.remove("flash-up", "flash-down", "hit"); void el.offsetWidth; el.classList.add(cls); }

  function readDepth(side, max) {
    const n = M._lob_depth(side, max);
    const base = M._lob_depth_ptr(side) >> 2, I = M.HEAP32;
    const out = new Array(n);
    for (let i = 0; i < n; i++) out[i] = [I[base + i * 3], I[base + i * 3 + 1], I[base + i * 3 + 2]];
    return out;
  }
  function userPrices(side) {
    const s = new Set();
    for (const o of user.orders.values()) if (o.side === side) s.add(o.px);
    return s;
  }
  function paintSide(rows, levels, maxQ, mine) {
    for (let i = 0; i < LEVELS; i++) {
      const r = rows[i];
      const lv = levels[i];
      if (!lv) {
        if (r.p !== -1) { r.el.className = "lrow empty"; r.px.textContent = r.sz.textContent = r.cnt.textContent = "--"; r.bar.style.width = "0"; r.p = r.q = -1; }
        continue;
      }
      const [p, q, c] = lv;
      if (r.p === -1) r.el.classList.remove("empty");
      if (p !== r.p) { r.px.textContent = fmtPx(p); }
      if (p === r.p && q !== r.q) restart(r.el, q > r.q ? "flash-up" : "flash-down");
      if (hitLevels.has(p)) restart(r.el, "hit");
      r.sz.textContent = fmtInt(q);
      r.cnt.textContent = c;
      r.bar.style.width = Math.max(2, (q / maxQ) * 100) + "%";
      r.el.classList.toggle("mine", mine.has(p));
      r.p = p; r.q = q;
    }
  }

  const tapeEl = $("#tape");
  function idLabel(id) { return id >= USER_BASE ? "you" : "#" + id; }
  let lastTape = 0;
  function paintTape() {
    const now = performance.now();
    if (!pendingTape.length || now - lastTape < 160) return;
    lastTape = now;
    const items = pendingTape.splice(0, pendingTape.length).slice(-3);
    for (const t of items) {
      const li = document.createElement("li");
      li.className = (t.buy ? "b" : "s") + (t.maker >= USER_BASE || t.taker >= USER_BASE ? " mine" : "");
      li.innerHTML = `<span class="tp">${fmtPx(t.px)}</span><span>${fmtInt(t.q)}</span><span class="ids">${idLabel(t.maker)} / ${idLabel(t.taker)}</span>`;
      tapeEl.insertBefore(li, tapeEl.firstChild);
    }
    while (tapeEl.children.length > 40) tapeEl.lastChild.remove();
  }

  const k = { last: $("#k-last"), spread: $("#k-spread"), resting: $("#k-resting"), trades: $("#k-trades"), ops: $("#k-ops"), ns: $("#k-nsop") };
  const midEl = $("#mid"), spreadLbl = $("#spread-lbl"), tapeRate = $("#tape-rate");
  let lastMid = null;

  function render() {
    const bids = readDepth(0, 64);
    const asks = readDepth(1, 64);
    let maxQ = 1;
    for (let i = 0; i < LEVELS; i++) {
      if (bids[i]) maxQ = Math.max(maxQ, bids[i][1]);
      if (asks[i]) maxQ = Math.max(maxQ, asks[i][1]);
    }
    paintSide(askRows, asks, maxQ, userPrices(1));
    paintSide(bidRows, bids, maxQ, userPrices(0));
    hitLevels.clear();
    paintTape();

    const bb = bids.length ? bids[0][0] : -1, ba = asks.length ? asks[0][0] : -1;
    if (bb >= 0 && ba >= 0) {
      const mid = (bb + ba) / 2;
      midEl.textContent = (mid / 100).toFixed(3).replace(/0$/, "");
      if (lastMid != null && mid !== lastMid) midEl.className = mid > lastMid ? "up" : "down";
      lastMid = mid;
      spreadLbl.textContent = "spread " + fmtPx(ba - bb);
      k.spread.textContent = fmtPx(ba - bb);
    }
    if (sim.last != null) {
      k.last.textContent = fmtPx(sim.last);
      k.last.className = sim.prevLast == null || sim.last === sim.prevLast ? "" : sim.last > sim.prevLast ? "up" : "down";
    }
    k.resting.textContent = fmtInt(E.count());
    k.trades.textContent = fmtInt(sim.trades);
    k.ops.textContent = fmtInt(sim.ops);
    if (sim.nsPerOp != null) k.ns.textContent = sim.nsPerOp.toFixed(0) + " ns";
    const now = performance.now();
    while (sim.tradeWindow.length && sim.tradeWindow[0][0] < now - 1000) sim.tradeWindow.shift();
    tapeRate.textContent = fmtInt(sim.tradeWindow.reduce((a, b) => a + b[1], 0)) + " / s";
    drawChart(bids, asks);
  }

  // ------------------------------------------------------------------ chart
  const chart = $("#chart");
  const cctx = chart.getContext("2d");
  let chartMode = "price";
  const series = []; // {bid, ask, last}
  let lastSample = 0;
  function sample(now) {
    if (now - lastSample < 200) return;
    lastSample = now;
    const b = E.bid(), a = E.ask();
    if (b < 0 || a < 0) return;
    series.push({ b, a, l: sim.last != null ? sim.last : (a + b) / 2 });
    if (series.length > 300) series.shift();
  }
  $$(".tab").forEach((t) =>
    t.addEventListener("click", () => {
      $$(".tab").forEach((x) => x.classList.toggle("active", x === t));
      chartMode = t.dataset.chart;
    })
  );
  function sizeCanvas(cv, ctx) {
    const dpr = Math.min(2, devicePixelRatio || 1);
    const w = cv.clientWidth, h = cv.clientHeight;
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return [w, h];
  }
  function drawChart(bids, asks) {
    const [w, h] = sizeCanvas(chart, cctx);
    cctx.clearRect(0, 0, w, h);
    cctx.font = "11px JetBrains Mono, monospace";
    const padR = 54, padT = 10, padB = 16;
    const pw = w - padR, ph = h - padT - padB;
    if (chartMode === "price") {
      if (series.length < 2) return;
      let lo = Infinity, hi = -Infinity;
      for (const s of series) { lo = Math.min(lo, s.b, s.l); hi = Math.max(hi, s.a, s.l); }
      const pad = Math.max(3, (hi - lo) * 0.15);
      lo -= pad; hi += pad;
      const X = (i) => (i / 299) * pw + (300 - series.length) / 299 * pw;
      const Y = (v) => padT + (1 - (v - lo) / (hi - lo)) * ph;
      // grid
      cctx.strokeStyle = "rgba(139,151,171,0.10)";
      cctx.fillStyle = COLORS.dim;
      cctx.lineWidth = 1;
      for (let g = 0; g <= 4; g++) {
        const v = lo + ((hi - lo) * g) / 4, y = Y(v);
        cctx.beginPath(); cctx.moveTo(0, y); cctx.lineTo(pw, y); cctx.stroke();
        cctx.fillText(fmtPx(v), pw + 8, y + 4);
      }
      // bid/ask band
      cctx.beginPath();
      series.forEach((s, i) => (i ? cctx.lineTo(X(i), Y(s.a)) : cctx.moveTo(X(i), Y(s.a))));
      for (let i = series.length - 1; i >= 0; i--) cctx.lineTo(X(i), Y(series[i].b));
      cctx.closePath();
      cctx.fillStyle = "rgba(122,162,255,0.07)";
      cctx.fill();
      const line = (key, color, width) => {
        cctx.beginPath();
        series.forEach((s, i) => (i ? cctx.lineTo(X(i), Y(s[key])) : cctx.moveTo(X(i), Y(s[key]))));
        cctx.strokeStyle = color; cctx.lineWidth = width; cctx.stroke();
      };
      line("a", "rgba(255,93,122,0.45)", 1);
      line("b", "rgba(49,224,161,0.45)", 1);
      // last price with area
      const grad = cctx.createLinearGradient(0, padT, 0, h);
      grad.addColorStop(0, "rgba(122,162,255,0.28)");
      grad.addColorStop(1, "rgba(122,162,255,0)");
      cctx.beginPath();
      series.forEach((s, i) => (i ? cctx.lineTo(X(i), Y(s.l)) : cctx.moveTo(X(i), Y(s.l))));
      cctx.lineTo(X(series.length - 1), h - padB);
      cctx.lineTo(X(0), h - padB);
      cctx.closePath();
      cctx.fillStyle = grad;
      cctx.fill();
      line("l", COLORS.accent, 2);
      const end = series[series.length - 1];
      const ex = X(series.length - 1), ey = Y(end.l);
      const pulse = (performance.now() % 1400) / 1400;
      cctx.beginPath(); cctx.arc(ex, ey, 3 + pulse * 9, 0, Math.PI * 2);
      cctx.fillStyle = `rgba(122,162,255,${0.35 * (1 - pulse)})`; cctx.fill();
      cctx.beginPath(); cctx.arc(ex, ey, 3.5, 0, Math.PI * 2);
      cctx.fillStyle = "#fff"; cctx.fill();
      cctx.fillStyle = COLORS.accent;
      cctx.fillRect(pw + 2, ey - 9, padR - 2, 18);
      cctx.fillStyle = "#07090e";
      cctx.fillText(fmtPx(end.l), pw + 8, ey + 4);
    } else {
      if (!bids.length || !asks.length) return;
      const span = 40;
      const mid = (bids[0][0] + asks[0][0]) / 2;
      const lo = mid - span, hi = mid + span;
      const cum = (lv, limitFn) => { const pts = []; let c = 0; for (const [p, q] of lv) { if (!limitFn(p)) break; c += q; pts.push([p, c]); } return pts; };
      const bp = cum(bids, (p) => p >= lo), ap = cum(asks, (p) => p <= hi);
      const maxC = Math.max(1, bp.length ? bp[bp.length - 1][1] : 0, ap.length ? ap[ap.length - 1][1] : 0);
      const X = (p) => ((p - lo) / (hi - lo)) * pw;
      const Y = (c) => padT + (1 - c / (maxC * 1.08)) * ph;
      const area = (pts, color, fill, leftward) => {
        if (!pts.length) return;
        cctx.beginPath();
        cctx.moveTo(X(pts[0][0]), Y(0));
        let prevY = Y(0);
        for (const [p, c] of pts) { cctx.lineTo(X(p), prevY); cctx.lineTo(X(p), Y(c)); prevY = Y(c); }
        cctx.lineTo(leftward ? 0 : pw, prevY);
        cctx.lineTo(leftward ? 0 : pw, Y(0));
        cctx.closePath();
        cctx.fillStyle = fill; cctx.fill();
        cctx.strokeStyle = color; cctx.lineWidth = 1.6; cctx.stroke();
      };
      area(bp, COLORS.bid, "rgba(49,224,161,0.16)", true);
      area(ap, COLORS.ask, "rgba(255,93,122,0.16)", false);
      cctx.strokeStyle = "rgba(122,162,255,0.6)";
      cctx.setLineDash([3, 4]);
      cctx.beginPath(); cctx.moveTo(X(mid), padT); cctx.lineTo(X(mid), h - padB); cctx.stroke();
      cctx.setLineDash([]);
      cctx.fillStyle = COLORS.dim;
      cctx.fillText(fmtPx(lo), 2, h - 3);
      cctx.fillText(fmtPx(hi), pw - 44, h - 3);
      cctx.fillText(fmtInt(maxC), pw + 8, Y(maxC) + 4);
      cctx.fillText("0", pw + 8, Y(0));
    }
  }

  // ------------------------------------------------------------------ controls
  const rateIn = $("#rate"), rateOut = $("#rate-out");
  const sliderToRate = (v) => Math.round(Math.pow(10, 1 + (5 * v) / 100));
  function setSlider(v) {
    rateIn.value = v;
    sim.rate = sliderToRate(v);
    rateIn.style.setProperty("--p", v + "%");
    rateOut.textContent = (sim.rate >= 1e6 ? "1M" : fmtInt(sim.rate)) + " / s";
    $$(".chip[data-rate]").forEach((c) => c.classList.toggle("active", +c.dataset.rate === +v));
  }
  rateIn.addEventListener("input", () => setSlider(+rateIn.value));
  $$(".chip[data-rate]").forEach((c) => c.addEventListener("click", () => setSlider(+c.dataset.rate)));
  const pauseBtn = $("#pause");
  pauseBtn.addEventListener("click", () => {
    sim.paused = !sim.paused;
    pauseBtn.textContent = sim.paused ? "Resume" : "Pause";
    pauseBtn.classList.toggle("active", sim.paused);
    $("#status-dot").classList.toggle("off", sim.paused);
    $("#status-text").textContent = sim.paused ? "paused" : "live";
  });
  setSlider(30);

  // ------------------------------------------------------------------ order ticket
  const tPrice = $("#t-price"), tQty = $("#t-qty"), tMsg = $("#t-msg"), tSend = $("#t-send");
  $$(".seg-btn").forEach((b) =>
    b.addEventListener("click", () => {
      user.side = +b.dataset.side;
      $$(".seg-btn").forEach((x) => x.classList.toggle("active", x === b));
      tSend.className = "btn send " + (user.side === 0 ? "buy" : "sell");
      tSend.textContent = user.side === 0 ? "Send buy order" : "Send sell order";
    })
  );
  $("#t-touch").addEventListener("click", () => {
    const p = user.side === 0 ? E.bid() : E.ask();
    if (p >= 0) tPrice.value = fmtPx(p);
  });
  $("#t-cross").addEventListener("click", () => {
    const p = user.side === 0 ? E.ask() + 3 : E.bid() - 3;
    if (p >= 3) tPrice.value = fmtPx(p);
  });
  $("#ticket").addEventListener("submit", (e) => {
    e.preventDefault();
    if (!M) return;
    const px = Math.round(parseFloat(tPrice.value) * 100);
    const qty = parseInt(tQty.value, 10);
    if (!Number.isFinite(px) || !Number.isFinite(qty) || qty <= 0 || qty > 1e6) {
      tMsg.innerHTML = '<span class="bad">Enter a price and a quantity from 1 to 1,000,000.</span>';
      return;
    }
    const id = user.nextId++;
    const res = E.add(id, user.side, px, qty);
    // Fills where we were the taker are in the trade buffer right now.
    const n = M._lob_trade_count(), U = M.HEAPU32, I = M.HEAP32, base = M._lob_trades() >> 2;
    let filled = 0, notional = 0, makers = 0;
    for (let i = 0; i < n; i++) {
      const o = base + i * 6;
      if (U[o + 1] === id) { filled += U[o + 3]; notional += U[o + 3] * I[o + 2]; makers++; }
    }
    processTrades();
    const side = user.side === 0 ? "buy" : "sell";
    if (res === 2) {
      tMsg.innerHTML = `<span class="bad">Rejected.</span> Price must be between ${fmtPx(PX_MIN)} and ${fmtPx(PX_MAX)}.`;
    } else if (res === 1) {
      tMsg.innerHTML = `<span class="ok">Filled</span> ${fmtInt(filled)} @ avg ${(notional / filled / 100).toFixed(3)} against ${makers} maker${makers > 1 ? "s" : ""}.`;
    } else {
      user.orders.set(id, { px, side: user.side, rem: qty - filled });
      tMsg.innerHTML = filled
        ? `<span class="ok">Filled ${fmtInt(filled)}</span>, rested ${fmtInt(qty - filled)} @ ${fmtPx(px)}.`
        : `<span class="ok">Rested</span> ${side} ${fmtInt(qty)} @ ${fmtPx(px)}. Look for the amber dot.`;
    }
    render();
  });
  $("#t-cancel").addEventListener("click", () => {
    let c = 0;
    for (const id of user.orders.keys()) c += E.cancel(id);
    user.orders.clear();
    tMsg.innerHTML = c ? `<span class="ok">Cancelled ${c} order${c > 1 ? "s" : ""}.</span>` : "No resting orders of yours.";
    render();
  });

  // ------------------------------------------------------------------ browser benchmark
  const runBtn = $("#run-bench");
  let benchN = 250000;
  $$(".run-select .chip").forEach((c) =>
    c.addEventListener("click", () => {
      benchN = +c.dataset.n;
      $$(".run-select .chip").forEach((x) => x.classList.toggle("active", x === c));
    })
  );
  runBtn.addEventListener("click", async () => {
    if (!M) return;
    runBtn.disabled = true;
    runBtn.classList.add("running");
    runBtn.textContent = `Running ${fmtInt(benchN)} ops...`;
    $("#wb-fast").style.width = "0"; $("#wb-ref").style.width = "0";
    await sleep(80);
    const wasPaused = sim.paused;
    sim.paused = true;
    const p = M._lob_bench(benchN, 7) >> 3;
    const F = M.HEAPF64;
    const fastMs = F[p], refMs = F[p + 1], fastTr = F[p + 2], refTr = F[p + 3], fastRest = F[p + 4], refRest = F[p + 5];
    sim.paused = wasPaused;
    const fm = benchN / fastMs / 1000, rm = benchN / refMs / 1000;
    const max = Math.max(fm, rm);
    requestAnimationFrame(() => {
      $("#wb-fast").style.width = (fm / max) * 100 + "%";
      $("#wb-ref").style.width = (rm / max) * 100 + "%";
    });
    $("#wv-fast").textContent = fm.toFixed(1);
    $("#wv-ref").textContent = rm.toFixed(1);
    const agree = fastTr === refTr && fastRest === refRest;
    $("#verdict").innerHTML =
      `<b>${(fm / rm).toFixed(1)}x faster</b> in this tab: ${fastMs.toFixed(1)} ms vs ${refMs.toFixed(1)} ms for ${fmtInt(benchN)} ops. ` +
      (agree
        ? `<span class="ok">Both books agree:</span> ${fmtInt(fastTr)} shares traded, ${fmtInt(fastRest)} orders resting.`
        : `<span class="bad">Books disagree.</span>`);
    runBtn.classList.remove("running");
    runBtn.disabled = false;
    runBtn.textContent = "Run again";
  });

  // ------------------------------------------------------------------ main loop
  let lastT = performance.now(), lastRender = 0;
  function frame(now) {
    const dt = Math.min(0.1, (now - lastT) / 1000);
    lastT = now;
    sparkBudget = Math.min(4, sparkBudget + dt * 18);
    if (!sim.paused) {
      stepFair(dt);
      sim.due += sim.rate * dt;
      const n = Math.floor(sim.due);
      sim.due -= n;
      if (n) runOps(n);
    }
    sample(now);
    if (now - lastRender > 60) { render(); lastRender = now; }
    requestAnimationFrame(frame);
  }

  function boot(mod) {
    M = mod;
    M._lob_init(PX_MIN, PX_MAX, 1 << 16);
    // Seed a book around the start price, then estimate per-op cost.
    for (let i = 0; i < 6; i++) { genChunk(CH, E.count()); for (let j = 0; j < CH; j++) gKind[j] ? E.cancel(gId[j]) : E.add(gId[j], gSide[j], gPx[j], gQty[j]); processTrades(); }
    sim.trades = 0; pendingTape.length = 0;
    const p = M._lob_bench(100000, 3) >> 3;
    sim.nsPerOp = (M.HEAPF64[p] * 1e6) / 100000;
    $("#status-text").textContent = "live";
    runBtn.disabled = false;
    runBtn.textContent = "Run benchmark";
    requestAnimationFrame(frame);
  }

  if (typeof createLob === "function") {
    createLob().then(boot).catch((err) => {
      console.error(err);
      $("#status-text").textContent = "engine failed to load";
      $("#status-dot").classList.add("off");
    });
  } else {
    $("#status-text").textContent = "engine failed to load";
    $("#status-dot").classList.add("off");
  }

  // ------------------------------------------------------------------ "inside" visualizations
  function looped(el, body) {
    let visible = false, running = false;
    onVisible(el, (v) => {
      visible = v;
      if (v && !running) { running = true; (async () => { while (visible) await body(); running = false; })(); }
    });
  }

  // Occupancy bitset: best level empties, scan words for the next set bit.
  (() => {
    const root = $("#viz-bitset");
    root.innerHTML = '<div class="bits"></div><div class="viz-note"></div>';
    const bitsEl = $(".bits", root), note = $(".viz-note", root);
    const W = 4, B = 16, cells = [], words = [];
    for (let w = 0; w < W; w++) {
      const row = document.createElement("div");
      row.className = "word";
      row.innerHTML = `<span class="word-lbl">word ${w}</span><div class="word-cells"></div>`;
      const wc = row.lastChild;
      for (let b = 0; b < B; b++) { const c = document.createElement("div"); c.className = "cell"; wc.appendChild(c); cells.push(c); }
      words.push(wc);
      bitsEl.appendChild(row);
    }
    let on = [];
    const randomize = () => {
      on = Array.from({ length: W * B }, (_, i) => i > 2 && Math.random() < 0.11);
      on[1 + ((Math.random() * 5) | 0)] = true;
    };
    const paint = (best) => cells.forEach((c, i) => (c.className = "cell" + (i === best ? " best" : on[i] ? " on" : "")));
    randomize();
    paint(-1);
    looped(root, async () => {
      if (on.filter(Boolean).length < 3) { randomize(); paint(-1); await sleep(500); }
      let best = on.indexOf(true);
      paint(best);
      note.innerHTML = `best ask = level <b>${best}</b>`;
      await sleep(1000);
      on[best] = false;
      cells[best].className = "cell gone";
      note.innerHTML = `level ${best} empties, find the next one`;
      await sleep(800);
      let w = Math.floor(best / B), reads = 0, found = -1;
      while (w < W) {
        words.forEach((x, i) => x.classList.toggle("scan", i === w));
        reads++;
        const startBit = w === Math.floor(best / B) ? (best % B) + 1 : 0;
        for (let b = startBit; b < B; b++) if (on[w * B + b]) { found = w * B + b; break; }
        note.innerHTML = found >= 0 ? `word ${w}: countr_zero gives bit <b>${found % B}</b>` : `word ${w}: all zero, next word`;
        await sleep(650);
        if (found >= 0) break;
        w++;
      }
      words.forEach((x) => x.classList.remove("scan"));
      if (found < 0) { randomize(); paint(-1); return; }
      paint(found);
      note.innerHTML = `new best ask = level <b>${found}</b> after ${reads} word read${reads > 1 ? "s" : ""}`;
      await sleep(1300);
      // a couple of new orders arrive at random levels
      for (let i = 0; i < 2; i++) { const j = 4 + ((Math.random() * (W * B - 4)) | 0); on[j] = true; }
      paint(-1);
      await sleep(300);
    });
  })();

  // Intrusive FIFO: append at tail, cancel from the middle, fill from the head.
  (() => {
    const root = $("#viz-fifo");
    root.innerHTML = '<div class="fifo"></div><div class="viz-note"></div><div class="fifo-tag head">head</div><div class="fifo-tag tail">tail</div>';
    const box = $(".fifo", root), note = $(".viz-note", root), headTag = $(".fifo-tag.head", root), tailTag = $(".fifo-tag.tail", root);
    let nodes = [], links = [], nextId = 41;
    const NW = 54, GAP = 24;
    const make = () => {
      const el = document.createElement("div");
      el.className = "fnode enter";
      const q = 10 * (1 + ((Math.random() * 20) | 0));
      el.innerHTML = `<b>#${nextId++}</b><span>${q}</span>`;
      box.appendChild(el);
      return el;
    };
    function layout() {
      const W = root.clientWidth, n = nodes.length;
      const total = n * NW + (n - 1) * GAP, x0 = (W - total) / 2;
      nodes.forEach((el, i) => (el.style.left = x0 + i * (NW + GAP) + "px"));
      while (links.length < n - 1) { const l = document.createElement("div"); l.className = "flink"; box.appendChild(l); links.push(l); }
      while (links.length > n - 1) links.pop().remove();
      links.forEach((l, i) => { l.style.left = x0 + i * (NW + GAP) + NW + 3 + "px"; l.style.width = GAP - 6 + "px"; });
      headTag.style.left = x0 + NW / 2 + "px";
      tailTag.style.left = x0 + (n - 1) * (NW + GAP) + NW / 2 + "px";
    }
    for (let i = 0; i < 4; i++) { const el = make(); el.classList.remove("enter"); nodes.push(el); }
    requestAnimationFrame(layout);
    addEventListener("resize", layout);
    looped(root, async () => {
      // append
      const el = make();
      nodes.push(el);
      layout();
      el.style.left = parseFloat(el.style.left) + 40 + "px";
      await sleep(30);
      el.classList.remove("enter");
      layout();
      note.innerHTML = "new order links in at the <b>tail</b>, O(1)";
      await sleep(1500);
      // cancel from the middle
      const mi = 1 + ((Math.random() * (nodes.length - 2)) | 0);
      const victim = nodes[mi];
      note.innerHTML = `cancel ${victim.firstChild.textContent}: unlink from the middle, O(1)`;
      victim.classList.add("cancel");
      await sleep(550);
      nodes.splice(mi, 1);
      victim.remove();
      layout();
      await sleep(1300);
      // fill from the head
      const h = nodes[0];
      note.innerHTML = `aggressive order fills the <b>head</b> first (oldest)`;
      h.classList.add("fill");
      await sleep(550);
      nodes.shift();
      h.remove();
      layout();
      await sleep(1300);
      if (nodes.length < 3) { const e2 = make(); nodes.push(e2); layout(); await sleep(30); e2.classList.remove("enter"); }
    });
  })();

  // Object pool with a LIFO free list.
  (() => {
    const root = $("#viz-pool");
    root.innerHTML = '<div class="pool"><div class="slots"></div><div class="stack"><div class="stack-title">free list</div><ul></ul></div></div><div class="viz-note"></div>';
    const slotsEl = $(".slots", root), ul = $(".stack ul", root), note = $(".viz-note", root);
    const N = 32, slots = [], used = new Array(N).fill(false);
    for (let i = 0; i < N; i++) { const s = document.createElement("div"); s.className = "slot"; s.textContent = i; slotsEl.appendChild(s); slots.push(s); }
    let free = [];
    for (let i = 0; i < N; i++) { if (Math.random() < 0.6) { used[i] = true; slots[i].classList.add("used"); } else free.push(i); }
    free.sort(() => Math.random() - 0.5);
    const paintStack = (pushed) => {
      ul.innerHTML = "";
      free.slice(-5).reverse().forEach((v, i) => {
        const li = document.createElement("li");
        li.textContent = "slot " + v;
        if (i === 0) li.className = "top" + (pushed ? " pushed" : "");
        ul.appendChild(li);
      });
      if (!free.length) ul.innerHTML = '<li class="empty">empty: reject</li>';
    };
    paintStack(false);
    let lastFreed = -1;
    looped(root, async () => {
      const usedIdx = used.map((u, i) => (u ? i : -1)).filter((i) => i >= 0);
      const doFree = lastFreed < 0 && (free.length < 3 || (usedIdx.length > 8 && Math.random() < 0.55));
      if (doFree) {
        const i = usedIdx[(Math.random() * usedIdx.length) | 0];
        slots[i].className = "slot freeing";
        note.innerHTML = `cancel releases slot ${i}, pushed on top of the free list`;
        await sleep(500);
        used[i] = false;
        slots[i].className = "slot";
        free.push(i);
        lastFreed = i;
        paintStack(true);
        await sleep(1200);
      } else {
        const i = free.pop();
        used[i] = true;
        slots[i].className = "slot used warm";
        note.innerHTML = i === lastFreed ? `new order pops slot <b>${i}</b>: the one just freed, still in cache` : `new order pops slot <b>${i}</b> off the free list, no malloc`;
        lastFreed = -1;
        paintStack(false);
        await sleep(1300);
        slots[i].className = "slot used";
      }
    });
  })();

  // SPSC ring: producer advances head, consumer advances tail.
  (() => {
    const root = $("#viz-ring");
    root.innerHTML = '<canvas></canvas>';
    const cv = $("canvas", root), ctx = cv.getContext("2d");
    cv.style.width = "100%"; cv.style.height = "100%";
    const N = 16;
    let head = 5, tail = 0, hA = head, tA = tail, msgs = 0, mode = 0, modeT = 0, acc = 0, visible = false;
    onVisible(root, (v) => (visible = v));
    let last = performance.now();
    function frame(now) {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      if (visible) {
        modeT += dt;
        if (modeT > 3.2) { modeT = 0; mode = (mode + 1) % 3; }
        acc += dt;
        if (acc > 0.16) {
          acc = 0;
          const pp = mode === 0 ? 0.85 : mode === 1 ? 0.5 : 0.25;
          const cp = mode === 0 ? 0.35 : mode === 1 ? 0.5 : 0.85;
          if (head - tail < N && Math.random() < pp) head++;
          if (head > tail && Math.random() < cp) { tail++; msgs++; }
        }
        hA += (head - hA) * Math.min(1, dt * 10);
        tA += (tail - tA) * Math.min(1, dt * 10);
        const dpr = Math.min(2, devicePixelRatio || 1), w = cv.clientWidth, h = cv.clientHeight;
        if (cv.width !== Math.round(w * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, w, h);
        const cx = w / 2, cy = h / 2, r = Math.min(h * 0.36, w * 0.22);
        const ang = (i) => -Math.PI / 2 + (i / N) * Math.PI * 2;
        for (let i = 0; i < N; i++) {
          const filled = (() => { for (let k = tail; k < head; k++) if (k % N === i) return true; return false; })();
          ctx.beginPath();
          ctx.arc(cx, cy, r, ang(i) + 0.05, ang(i + 1) - 0.05);
          ctx.lineWidth = 14;
          ctx.strokeStyle = filled ? COLORS.accent : "rgba(139,151,171,0.16)";
          ctx.shadowColor = filled ? "rgba(122,162,255,0.7)" : "transparent";
          ctx.shadowBlur = filled ? 12 : 0;
          ctx.stroke();
        }
        ctx.shadowBlur = 0;
        const marker = (pos, color, label, outer) => {
          const a = ang(pos);
          const rr = r + (outer ? 22 : -22);
          const x = cx + Math.cos(a) * rr, y = cy + Math.sin(a) * rr;
          ctx.beginPath(); ctx.arc(x, y, 5, 0, Math.PI * 2); ctx.fillStyle = color; ctx.fill();
        };
        const legend = (y, color, label) => {
          ctx.beginPath(); ctx.arc(18, y - 4, 4, 0, Math.PI * 2); ctx.fillStyle = color; ctx.fill();
          ctx.font = "11px JetBrains Mono, monospace"; ctx.textAlign = "left"; ctx.fillText(label, 28, y);
        };
        legend(20, COLORS.bid, "head: producer writes");
        legend(38, COLORS.amber, "tail: consumer reads");
        marker(hA, COLORS.bid, "head (producer)", true);
        marker(tA, COLORS.amber, "tail (consumer)", true);
        ctx.textAlign = "center";
        ctx.fillStyle = "#e8edf6";
        ctx.font = "600 15px Inter, sans-serif";
        ctx.fillText("SPSC", cx, cy - 4);
        ctx.fillStyle = COLORS.dim;
        ctx.font = "11px JetBrains Mono, monospace";
        ctx.fillText(`${head - tail}/${N} full`, cx, cy + 13);
        ctx.textAlign = "left";
        ctx.fillText(`dequeued ${msgs}`, 12, h - 12);
        ctx.textAlign = "right";
        ctx.fillText(mode === 0 ? "burst: ring fills" : mode === 1 ? "steady" : "consumer catches up", w - 12, h - 12);
      }
      requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  })();
})();

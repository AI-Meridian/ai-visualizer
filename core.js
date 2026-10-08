/*
 * ai-visualizer: give your AI agent a face.
 * Copyright (C) 2026 Jared Rhodenizer
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published
 * by the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program. If not, see <https://www.gnu.org/licenses/>.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/* ============================================================
   ai-visualizer core — the shared plumbing every face rides on.

   A face is one self-contained page in faces/<name>/index.html.
   It includes this script, calls AV.init(opts), then reads these
   fields every animation frame after calling AV.tick(dtMs):

     AV.state      "idle" | "listening" | "thinking" | "speaking"
     AV.level      0..1 raw voice loudness (speaking only)
     AV.env        0..1 smoothed speech envelope (attack/release eased,
                   adaptively normalized — use this for motion)
     AV.samples    Float32Array(64), 0..1 normalized waveform ring
     AV.alert      bool, optional attention signal
     AV.tasks      [{id, label}, ...] — every tool call currently
                   executing while the brain is quietly working; can
                   hold more than one entry when several tools run in
                   parallel. Drives the floating, draggable task-list
                   panel core.js injects into every face (left side,
                   one row per active entry, same HUD language as the
                   rest of the chrome)
     AV.micLevel   0..1 your microphone (only if init({mic:true}))
     AV.name       display name from config ("JARVIS" by default)
     AV.label      the dotted chip label ("J.A.R.V.I.S.")
     AV.badge      optional handle from config ("" by default)

   Modes:
     live   served by server.py — rides the real signal bus
     demo   ?demo=1, or the page opened as a plain file — a scripted
            voice-turn loop (idle, listening, thinking, speaking) with
            synthesized audio, so every face performs with no voice
            line installed
     shot   ?shot=<state>&t=ms — pins one state and runs the frame
            loop deterministically, then sets document.title to
            "ready" (screenshot/verification harness)

   The thinking sound: assets/thinking.wav plays while the state is
   "thinking", exactly like a voice line would play it. If the bus
   says the voice line is already playing its own (.voice_loading_pid),
   this player stays quiet — you never hear it twice. The speaker
   button (bottom left) toggles it; browsers may require one click on
   the page before audio is allowed.
   ============================================================ */
"use strict";

const AV = (() => {
  const Q = new URLSearchParams(location.search);
  const SHOT = Q.get("shot");
  const SHOT_T = parseInt(Q.get("t") || "4000", 10);
  const DEMO = Q.get("demo") === "1" || location.protocol === "file:" || !!SHOT;

  // where core.js lives -> where assets/ lives (works over http and file://)
  const ROOT = new URL(".", document.currentScript.src);

  const A = {
    state: "idle", level: 0, env: 0, alert: false, micLevel: 0,
    samples: new Float32Array(64), tasks: [],
    name: "JARVIS", label: "J.A.R.V.I.S.", badge: "",
    demo: DEMO, shot: SHOT, faces: [],
    _sndOn: true, _mic: false, _readyCbs: [], _ready: false,
  };

  function dotted(name) {
    const up = String(name).toUpperCase();
    if (/^[A-Z0-9]{2,10}$/.test(up)) return up.split("").join(".") + ".";
    return up;
  }

  /* -------------------------------- config -------------------------------- */
  function applyConfig(cfg) {
    if (cfg.name) { A.name = String(cfg.name); A.label = dotted(A.name); }
    A.badge = String(cfg.badge || "");
    if (cfg.thinking_sound === false) A._sndWant = false;
    A.faces = cfg.faces || [];
    A._ready = true;
    A._readyCbs.forEach(cb => cb(A));
    A._readyCbs = [];
  }

  A.ready = cb => { A._ready ? cb(A) : A._readyCbs.push(cb); };

  /* ------------------------------ bus polling ------------------------------ */
  let raw = { state: "idle", level: 0, samples: null, alert: false,
              loading: false, tasks: [] };
  if (!DEMO) {
    setInterval(async () => {
      try {
        const r = await fetch("/state", { cache: "no-store" });
        raw = await r.json();
      } catch (e) { /* server gone: hold last state */ }
    }, 120);
  }

  /* ------------------------------ demo driver ------------------------------ */
  // A scripted voice turn: the face performs everything with no voice line.
  const SCRIPT = [["idle", 6000], ["listening", 3500], ["thinking", 4200],
                  ["speaking", 8500]];
  let demoT = 0, demoClock = 0;
  const PIN = SHOT || Q.get("state");   // ?state=speaking pins the demo
  function demoUpdate(dt) {
    demoClock += dt;
    let st = PIN || "idle";
    if (!PIN) {
      demoT = (demoT + dt) % SCRIPT.reduce((a, s) => a + s[1], 0);
      let t = demoT;
      for (const [name, len] of SCRIPT) {
        if (t < len) { st = name; break; }
        t -= len;
      }
    }
    const tt = demoClock / 1000;
    const speaking = st === "speaking";
    const cadence = speaking
      ? Math.max(0, Math.sin(tt * 2.1) * 0.6 + Math.sin(tt * 0.9) * 0.5)
      : 0;
    const samples = new Array(64);
    for (let i = 0; i < 64; i++) {
      // drifting per-sample color so the synthetic voice has a moving
      // spectrum, not a steady tone — spectrum-driven faces dance
      const m = 0.3 + 0.7 * Math.abs(Math.sin(i * 0.23 + tt * 1.7))
        * Math.abs(Math.sin(tt * 2.9 + i * 0.05));
      samples[i] = speaking
        ? (Math.sin(i * 0.55 + tt * 9) * 0.6 + Math.sin(i * 1.7 - tt * 13)
           * 0.4) * 9000 * (0.15 + 0.85 * cadence) * m
        : 0;
    }
    raw = { state: st, level: speaking ? Math.min(1, cadence) : 0,
            samples, alert: false, loading: false,
            // Two entries while "thinking" so the demo honestly shows
            // the panel's real job (several concurrent tasks), not
            // just a single-item list that looks the same as the old
            // one-at-a-time chip ever did.
            tasks: st === "thinking"
              ? [{ id: "demo-1", label: "Searching the web" },
                 { id: "demo-2", label: "Reading a file" }]
              : [] };
    if (st === "listening")
      A.micLevel = 0.25 + 0.55 * Math.abs(Math.sin(tt * 2.7))
        * Math.abs(Math.sin(tt * 0.61));
  }

  /* ----------------------- envelope + samples easing ----------------------- */
  let peak = 0.05, sPeak = 200;
  function tick(dt) {
    if (DEMO) demoUpdate(dt);
    A.state = raw.state || "idle";
    A.alert = !!raw.alert;
    A.tasks = raw.tasks || [];
    taskListUpdate();
    // Empty unless the voice line was told to publish usage. A face that
    // wants to draw it reads AV.rateLimits; every other face ignores it.
    A.rateLimits = raw.rate_limits || {};
    A.level = raw.level || 0;

    // adaptive envelope: normalize against a decaying peak, then ease
    // (attack 50ms, release 350ms) — motion code rides AV.env
    const dts = dt / 1000;
    peak = Math.max(A.level, 0.05, peak - 0.5 * peak * dts);
    const target = Math.min(1, A.level / peak);
    const tau = target > A.env ? 50 : 350;
    A.env += (target - A.env) * Math.min(1, dt / tau);

    // waveform ring: rectify, normalize against its own decaying peak,
    // blend toward the newest frame so the ring flows instead of flickers
    const s = raw.samples;
    A.rawSamples = s && s.length ? s : null;   // signed, int16-scale floats
    if (s && s.length) {
      let mx = 0;
      for (let i = 0; i < s.length; i++) mx = Math.max(mx, Math.abs(s[i]));
      sPeak = Math.max(mx, 200, sPeak * 0.98);
      const n = s.length;
      for (let i = 0; i < 64; i++) {
        const v = Math.abs(s[Math.min(n - 1, Math.round(i * (n - 1) / 63))])
          / sPeak;
        A.samples[i] = A.samples[i] * 0.45 + Math.min(1, v) * 0.55;
      }
    } else {
      for (let i = 0; i < 64; i++) A.samples[i] *= Math.max(0, 1 - dts * 6);
    }
    if (A.state !== "speaking" && !DEMO)
      for (let i = 0; i < 64; i++) A.samples[i] *= Math.max(0, 1 - dts * 6);

    if (A._mic && A._micAnalyser) micRead();
    soundUpdate();
  }

  /* --------------------------------- mic ---------------------------------- */
  let micPeak = 0.02;
  function micRead() {
    const an = A._micAnalyser;
    const buf = A._micBuf;
    an.getFloatTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
    const rms = Math.sqrt(sum / buf.length);
    micPeak = Math.max(rms, 0.02, micPeak * 0.999);
    A.micLevel = Math.min(1, rms / micPeak);
  }
  async function micStart() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const ctx = new AudioContext();
      const src = ctx.createMediaStreamSource(stream);
      const an = ctx.createAnalyser();
      an.fftSize = 512;
      src.connect(an);
      A._micAnalyser = an;
      A._micBuf = new Float32Array(an.fftSize);
      const kick = () => ctx.state === "suspended" && ctx.resume();
      addEventListener("click", kick); addEventListener("keydown", kick);
    } catch (e) { /* no mic permission: level stays 0, faces degrade */ }
  }

  /* ----------------------------- thinking sound ---------------------------- */
  let audio = null, sndBtn = null, playing = false;
  A._sndWant = true;
  function soundInit() {
    if (SHOT) return;
    try { A._sndOn = localStorage.getItem("av_sound") !== "0"; }
    catch (e) { A._sndOn = true; }
    audio = new Audio(new URL("assets/thinking.wav", ROOT).href);
    audio.volume = 0.35;
    sndBtn = document.createElement("div");
    // hidden until the mouse moves, so it never collides with a face's
    // chrome and never shows on camera or in an OBS source
    sndBtn.style.cssText =
      "position:fixed;left:64px;bottom:14px;z-index:50;cursor:pointer;" +
      "font:12px 'SF Mono',Menlo,Consolas,monospace;letter-spacing:.2em;" +
      "color:#5a6a72;opacity:0;transition:opacity .4s;user-select:none;" +
      "pointer-events:none";
    sndBtn.title = "thinking sound on/off";
    let hideT = null;
    addEventListener("mousemove", () => {
      sndBtn.style.opacity = ".65";
      sndBtn.style.pointerEvents = "auto";
      clearTimeout(hideT);
      hideT = setTimeout(() => {
        sndBtn.style.opacity = "0";
        sndBtn.style.pointerEvents = "none";
      }, 3000);
    });
    sndBtn.onclick = () => {
      A._sndOn = !A._sndOn;
      try { localStorage.setItem("av_sound", A._sndOn ? "1" : "0"); }
      catch (e) {}
      if (!A._sndOn) stopSound();
      paintBtn();
    };
    paintBtn();
    document.body.appendChild(sndBtn);
  }
  function paintBtn() {
    if (sndBtn) sndBtn.textContent = A._sndOn ? "SND ON" : "SND OFF";
  }
  function stopSound() {
    if (audio && playing) { audio.pause(); audio.currentTime = 0; }
    playing = false;
  }
  function soundUpdate() {
    if (!audio || !A._sndWant) return;
    const want = A._sndOn && A.state === "thinking" && !raw.loading;
    if (want && !playing) {
      playing = true;
      audio.currentTime = 0;
      audio.play().catch(() => { playing = false; });
    } else if (!want && playing) {
      stopSound();
    }
  }

  /* ------------------------- active-task list panel -------------------------
     A small floating, draggable panel listing every tool call currently
     running — not just the most recent one. Same dark/blue HUD language as
     a face's own waveform pill, so it reads as part of the same system
     rather than a bolted-on widget. Lives in core.js (not a per-face
     canvas) so every face gets it for free and dragging is just native
     DOM, no per-face render-loop plumbing.

     Rows are diffed by id (AV.tasks[i].id, the SDK's own tool_use_id):
     a row is created once when its id first appears and removed once its
     id disappears, so several concurrent tasks each get their own live
     row instead of one shared slot overwriting itself — that overwrite
     was the actual bug behind the old single-chip version only ever
     reading as "on" sometimes. -------------------------------------- */
  let panelEl = null, rowsEl = null, headCountEl = null;
  let panelShown = false;
  const rowEls = new Map();   // task id -> row element
  let dragging = false, dragDX = 0, dragDY = 0;

  function panelPos() {
    try {
      const saved = JSON.parse(localStorage.getItem("av_tasklist_pos") || "null");
      if (saved && typeof saved.top === "number" && typeof saved.left === "number")
        return saved;
    } catch (e) {}
    return { top: 90, left: 24 };   // left side, clear of most faces' chrome
  }
  function panelSavePos(top, left) {
    try { localStorage.setItem("av_tasklist_pos", JSON.stringify({ top, left })); }
    catch (e) {}
  }

  function taskListInit() {
    if (SHOT) return;
    const style = document.createElement("style");
    style.textContent = `
      @keyframes av-task-dot { 0%,100%{opacity:.4} 50%{opacity:1} }
      @keyframes av-task-ellipsis { 0%,100%{opacity:.25} 50%{opacity:1} }
      @keyframes av-task-row-in {
        from{opacity:0;transform:translateX(-6px)} to{opacity:1;transform:translateX(0)} }
      #av-task-panel{position:fixed;z-index:60;min-width:190px;max-width:300px;
        background:rgba(8,12,22,.78);border:1px solid rgba(120,160,210,.32);
        border-radius:10px;padding:10px 14px 11px;
        box-shadow:0 0 22px rgba(90,190,255,.14),0 4px 18px rgba(0,0,0,.35);
        font:12px "SF Mono",Menlo,Consolas,monospace;color:rgba(230,238,250,.92);
        cursor:grab;user-select:none;opacity:0;pointer-events:none;
        transform:translateY(-4px);transition:opacity .25s,transform .25s;}
      #av-task-panel.on{opacity:1;pointer-events:auto;transform:translateY(0)}
      #av-task-panel.dragging{cursor:grabbing;transition:none}
      #av-task-panel .av-task-head{display:flex;align-items:center;gap:7px;
        letter-spacing:.2em;font-size:10px;color:rgba(150,200,240,.85)}
      #av-task-panel .av-task-dot{width:6px;height:6px;border-radius:50%;flex:none;
        background:rgba(110,200,255,.95);animation:av-task-dot 1.1s ease-in-out infinite}
      #av-task-panel .av-task-rows{margin-top:7px;display:flex;
        flex-direction:column;gap:5px}
      #av-task-panel .av-task-row{display:flex;align-items:baseline;gap:7px;
        animation:av-task-row-in .22s ease-out}
      #av-task-panel .av-task-row-label{font-size:12px;color:rgba(230,238,250,.92);
        white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:250px}
      #av-task-panel .av-task-row-dots{display:inline-flex;gap:2px;flex:none}
      #av-task-panel .av-task-row-dots i{width:3px;height:3px;border-radius:50%;
        display:block;background:rgba(120,200,255,.85);
        animation:av-task-ellipsis 1s ease-in-out infinite}
    `;
    document.head.appendChild(style);

    panelEl = document.createElement("div");
    panelEl.id = "av-task-panel";
    const head = document.createElement("div");
    head.className = "av-task-head";
    head.innerHTML = `<span class="av-task-dot"></span><span>WORKING</span>` +
      `<span class="av-task-head-count"></span>`;
    headCountEl = head.querySelector(".av-task-head-count");
    rowsEl = document.createElement("div");
    rowsEl.className = "av-task-rows";
    panelEl.appendChild(head);
    panelEl.appendChild(rowsEl);
    document.body.appendChild(panelEl);

    const p = panelPos();
    panelEl.style.top = p.top + "px";
    panelEl.style.left = p.left + "px";

    panelEl.addEventListener("pointerdown", e => {
      dragging = true;
      panelEl.classList.add("dragging");
      panelEl.setPointerCapture(e.pointerId);
      const r = panelEl.getBoundingClientRect();
      dragDX = e.clientX - r.left;
      dragDY = e.clientY - r.top;
    });
    panelEl.addEventListener("pointermove", e => {
      if (!dragging) return;
      const left = Math.min(innerWidth - 40, Math.max(0, e.clientX - dragDX));
      const top = Math.min(innerHeight - 30, Math.max(0, e.clientY - dragDY));
      panelEl.style.left = left + "px";
      panelEl.style.top = top + "px";
    });
    const stopDrag = () => {
      if (!dragging) return;
      dragging = false;
      panelEl.classList.remove("dragging");
      const r = panelEl.getBoundingClientRect();
      panelSavePos(r.top, r.left);
    };
    panelEl.addEventListener("pointerup", stopDrag);
    panelEl.addEventListener("pointercancel", stopDrag);
  }

  function taskListMakeRow(label) {
    const row = document.createElement("div");
    row.className = "av-task-row";
    const dots = document.createElement("span");
    dots.className = "av-task-row-dots";
    for (let i = 0; i < 3; i++) {
      const d = document.createElement("i");
      d.style.animationDelay = (i * 0.15).toFixed(2) + "s";
      dots.appendChild(d);
    }
    const lab = document.createElement("span");
    lab.className = "av-task-row-label";
    lab.textContent = label;
    row.appendChild(dots);
    row.appendChild(lab);
    return row;
  }

  function taskListUpdate() {
    if (!panelEl) return;
    const tasks = A.tasks || [];
    const liveIds = new Set(tasks.map(t => t.id));

    // remove rows for ids no longer active
    for (const [id, row] of rowEls) {
      if (!liveIds.has(id)) {
        row.remove();
        rowEls.delete(id);
      }
    }
    // add rows for newly-seen ids, in the order the bus reports them
    for (const t of tasks) {
      if (!rowEls.has(t.id)) {
        const row = taskListMakeRow(t.label);
        rowsEl.appendChild(row);
        rowEls.set(t.id, row);
      }
    }

    const shown = tasks.length > 0;
    if (shown !== panelShown) {
      panelShown = shown;
      panelEl.classList.toggle("on", shown);
    }
    headCountEl.textContent = tasks.length > 1 ? ` · ${tasks.length}` : "";
  }

  /* ------------------------------ shot harness ----------------------------- */
  // Runs the face's frame() deterministically (a synchronous burst of t ms).
  // A headless browser resizes the window and finishes loading images AFTER
  // the first burst, so the burst re-runs on resize and on two late timers
  // (the last one flags "ready"), then keeps painting at frame pace so the
  // late capture always sees a fresh composite.
  A.shotRun = (frame) => {
    const burst = () => { for (let t = 0; t < SHOT_T; t += 16.6) frame(16.6); };
    burst();
    addEventListener("resize", burst);
    setTimeout(burst, 450);
    setTimeout(burst, 900);
    setTimeout(() => { burst(); document.title = "ready"; }, 3000);
    // fat 100ms steps: assets that finish loading after the last burst
    // still reach their steady state within a few paints
    const loop = () => { frame(100); requestAnimationFrame(loop); };
    requestAnimationFrame(loop);
  };

  /* ---------------------------------- init --------------------------------- */
  A.init = (opts = {}) => {
    A._mic = !!opts.mic;
    if (A._mic && !DEMO) micStart();
    if (opts.sound !== false) soundInit(); else A._sndWant = false;
    taskListInit();
    if (DEMO) {
      applyConfig({ name: Q.get("name") || "JARVIS" });
    } else {
      fetch("/config", { cache: "no-store" })
        .then(r => r.json()).then(applyConfig)
        .catch(() => applyConfig({}));
    }
    return A;
  };

  A.tick = tick;

  /* ----------------------------- render helpers ---------------------------- */
  const U = {};
  U.dim = (c, f) => {
    f = Math.max(0, Math.min(1, f));
    return `rgb(${c[0] * f | 0},${c[1] * f | 0},${c[2] * f | 0})`;
  };
  U.rgba = (c, a) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;

  // How long until a usage window resets, in the shortest honest unit.
  U.relTime = (ep) => {
    const d = ep - Date.now() / 1000;
    if (!(d > 0)) return "";
    if (d < 3600) return Math.round(d / 60) + "m";
    if (d < 86400) return Math.round(d / 3600) + "h";
    return Math.round(d / 86400) + "d";
  };

  // The plan-usage windows, formatted ONCE for every face that draws them.
  // Lives here rather than in each face because four copies of one format
  // drift apart silently, and the first symptom is two faces disagreeing
  // about the same number.
  //
  // Returns [] when the voice line publishes no usage, so a face can call
  // it unconditionally and simply draw nothing when there is nothing to say.
  // A window that is KNOWN but has no percentage yet still returns a row:
  // hiding it entirely was the original bug, and a row that says "no number
  // yet" is information where a missing row is just confusing.
  U.usageRows = () => {
    const rl = A.rateLimits || {};
    const out = [];
    for (const [label, w] of [["5H", rl.five_hour], ["7D", rl.seven_day]]) {
      if (!w) continue;
      const known = w.utilization != null;
      const pct = known ? Math.round(w.utilization * 100) : null;
      const rel = w.resets_at ? U.relTime(w.resets_at) : "";
      out.push({
        label, pct, known,
        hot: known && pct >= 80,
        text: (known ? pct + "%" : "\u2014") + (rel ? "  " + rel : "")
      });
    }
    return out;
  };
  U.mix = (c1, c2, t) => [c1[0] + (c2[0] - c1[0]) * t | 0,
                          c1[1] + (c2[1] - c1[1]) * t | 0,
                          c1[2] + (c2[2] - c1[2]) * t | 0];
  // soft additive glow sprite (canvas), cached by the caller
  U.makeGlow = (rgb, size) => {
    const c = document.createElement("canvas");
    c.width = c.height = size;
    const g = c.getContext("2d");
    const grd = g.createRadialGradient(size / 2, size / 2, 0,
                                       size / 2, size / 2, size / 2);
    grd.addColorStop(0, `rgba(${rgb[0]},${rgb[1]},${rgb[2]},1)`);
    grd.addColorStop(.25, `rgba(${rgb[0]},${rgb[1]},${rgb[2]},.55)`);
    grd.addColorStop(1, "rgba(0,0,0,0)");
    g.fillStyle = grd;
    g.fillRect(0, 0, size, size);
    return c;
  };
  // the one-field bloom rule: draw everything luminous into one field
  // canvas, bloom the WHOLE field (two downscale taps), composite
  // additively — bloom applied per-element reads as pencil lines
  U.bloomBlit = (dst, field, w, h) => {
    if (!field._b4 || field._b4.width !== w >> 2) {
      field._b4 = document.createElement("canvas");
      field._b4.width = Math.max(1, w >> 2);
      field._b4.height = Math.max(1, h >> 2);
      field._b8 = document.createElement("canvas");
      field._b8.width = Math.max(1, w >> 3);
      field._b8.height = Math.max(1, h >> 3);
    }
    const g4 = field._b4.getContext("2d"), g8 = field._b8.getContext("2d");
    g4.clearRect(0, 0, field._b4.width, field._b4.height);
    g4.drawImage(field, 0, 0, field._b4.width, field._b4.height);
    g8.clearRect(0, 0, field._b8.width, field._b8.height);
    g8.drawImage(field, 0, 0, field._b8.width, field._b8.height);
    const prev = dst.globalCompositeOperation;
    dst.globalCompositeOperation = "lighter";
    dst.drawImage(field, 0, 0);
    dst.drawImage(field._b4, 0, 0, w, h);
    dst.drawImage(field._b8, 0, 0, w, h);
    dst.globalCompositeOperation = prev;
  };
  // text that resolves out of glyph noise, left to right
  U.Descrambler = class {
    constructor(text, perChar = 50, hold = null) {
      this.text = text; this.per = perChar; this.hold = hold;
      this.t = 0; this.done = false;
      this.chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789#$%&";
    }
    render(dt) {
      this.t += dt;
      const n = this.t / this.per | 0;
      let out = "";
      for (let i = 0; i < this.text.length; i++) {
        const ch = this.text[i];
        out += (i < n || ch === " ") ? ch
          : this.chars[Math.random() * this.chars.length | 0];
      }
      if (this.hold != null && this.t > this.per * this.text.length + this.hold)
        this.done = true;
      return out;
    }
  };
  A.util = U;

  return A;
})();

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
     AV.tasks      [{id, ts, label}, ...] — every tool call currently
                   executing while the brain is quietly working; can
                   hold more than one entry when several tools run in
                   parallel. Drives the floating, draggable status bar
                   core.js injects into every face: a compact pill
                   that's ALWAYS on screen (idle, listening, thinking,
                   speaking — not just while a tool call is running),
                   expandable to show the current task plus every other
                   one running in the background, each timed off its
                   own real start (ts), never a fabricated percentage.
     AV.lastCompleted  {id, label, completed_ts} | null — the most
                   recently FINISHED task. Drives a persistent green
                   "last done" chip above the status bar, always on
                   screen once anything has completed this run,
                   replaced (never cleared) by the next completion.
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
  let demoT = 0, demoClock = 0, demoPrevState = "idle", demoLastDone = null;
  const PIN = SHOT || Q.get("state");   // ?state=speaking pins the demo
  function demoUpdate(dt) {
    demoClock += dt;
    let st = PIN || "idle";
    let elapsedMs = demoClock;   // pinned (?state=) never leaves this state
    if (!PIN) {
      demoT = (demoT + dt) % SCRIPT.reduce((a, s) => a + s[1], 0);
      let t = demoT;
      for (const [name, len] of SCRIPT) {
        if (t < len) { st = name; elapsedMs = t; break; }
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
              ? [{ id: "demo-1", label: "Searching the web",
                   ts: Date.now() / 1000 - elapsedMs / 1000 },
                 { id: "demo-2", label: "Reading a file",
                   ts: Date.now() / 1000 - elapsedMs / 2000 }]
              : [],
            last_completed: demoLastDone };
    // Fabricate one completion each time the scripted loop leaves
    // "thinking", so the demo honestly shows the persistent chip too —
    // same id/label pattern as the fake in-progress tasks above, never
    // pretending to be a real result.
    if (demoPrevState === "thinking" && st !== "thinking") {
      demoLastDone = { id: "demo-done-" + Math.floor(tt),
                        label: "Read a file", completed_ts: tt };
    }
    demoPrevState = st;
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
    A.lastCompleted = raw.last_completed || null;
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

  /* ---------------------------- status bar panel -----------------------------
     A floating, draggable status bar — ALWAYS on screen, in every state
     (idle, listening, thinking, speaking), not just while a tool call is
     running. Visual language: compact dark pill (dot, state label, mini
     waveform, current line, background-count badge, chevron), expanding
     into a current-task row plus every other concurrent tool call as a
     background-tasks list. Styled from Seb's own two reference mocks
     (2026-10-08: "Hugo AI taskbar" / "App building with PDF tasks").
     Lives in core.js (not a per-face canvas) so every face gets it for
     free and dragging is just native DOM, no per-face render-loop plumbing.

     Background rows are diffed by id (AV.tasks[i].id, the SDK's own
     tool_use_id): a row is created once when its id first appears and
     removed once its id disappears, so several concurrent tasks each get
     their own live row instead of one shared slot overwriting itself —
     that overwrite was the actual bug behind the old single-chip version
     only ever reading as "on" sometimes.

     Nothing here is fabricated: the only timer shown (current-task
     elapsed) comes from the task's own real start time (ts), and it's
     simply absent when there's no task to time, never a fake number. */
  let panelEl = null, barEl = null, dotEl = null, labelEl = null,
      currentEl = null, badgeEl = null, chevronEl = null, waveEl = null,
      expandedEl = null, curSectionEl = null, bgSectionEl = null,
      bgRowsEl = null, bgBadgeEl = null, curProgEl = null,
      lastDoneEl = null, lastDoneLabelEl = null;
  let expanded = false;
  const rowEls = new Map();   // task id -> {wrap, progEl} background row
  const WAVE_BARS = 5;
  let dragging = false, dragDX = 0, dragDY = 0, dragMoved = false;

  function panelPos() {
    try {
      const saved = JSON.parse(localStorage.getItem("av_tasklist_pos") || "null");
      if (saved && typeof saved.top === "number" && typeof saved.left === "number")
        return saved;
    } catch (e) {}
    return { top: 20, left: 24 };   // top-left, clear of most faces' chrome
  }
  function panelSavePos(top, left) {
    try { localStorage.setItem("av_tasklist_pos", JSON.stringify({ top, left })); }
    catch (e) {}
  }
  function expandedPref() {
    try { return localStorage.getItem("av_tasklist_expanded") === "1"; }
    catch (e) { return false; }
  }
  function expandedSave(on) {
    try { localStorage.setItem("av_tasklist_expanded", on ? "1" : "0"); }
    catch (e) {}
  }

  function fmtElapsed(s) {
    s = Math.max(0, Math.round(s));
    const m = Math.floor(s / 60), r = s % 60;
    return String(m).padStart(2, "0") + ":" + String(r).padStart(2, "0");
  }

  // Below this, a job is "quick" — an elapsed-time spinner is enough,
  // a progress bar would just be visual noise on a two-second Read.
  const JOB_ETA_FLOOR_S = 20;

  function taskProgressBuild() {
    const wrap = document.createElement("div");
    wrap.className = "av-task-progress-wrap";
    wrap.style.display = "none";
    const track = document.createElement("div");
    track.className = "av-task-progress-track";
    const fill = document.createElement("div");
    fill.className = "av-task-progress-fill";
    track.appendChild(fill);
    const text = document.createElement("span");
    text.className = "av-task-progress-text";
    wrap.append(track, text);
    return { wrap, fill, text };
  }

  // A real eta renders a live bar + "elapsed / ~eta" readout; no eta
  // (or a too-short one) hides the whole element rather than showing a
  // bar that's either always-empty or always-full.
  function taskProgressSet(prog, ts, eta) {
    if (!prog || !eta || eta < JOB_ETA_FLOOR_S || !ts) {
      if (prog) prog.wrap.style.display = "none";
      return;
    }
    const elapsed = Math.max(0, Date.now() / 1000 - ts);
    const pct = Math.max(2, Math.min(100, (elapsed / eta) * 100));
    prog.wrap.style.display = "";
    prog.fill.style.width = pct.toFixed(1) + "%";
    prog.text.textContent = fmtElapsed(elapsed) + " / ~" + fmtElapsed(eta);
  }

  function taskListInit() {
    if (SHOT) return;
    const style = document.createElement("style");
    style.textContent = `
      @keyframes av-task-dot { 0%,100%{opacity:.45} 50%{opacity:1} }
      @keyframes av-task-spin { to{transform:rotate(360deg)} }
      @keyframes av-task-wave-idle { 0%,100%{transform:scaleY(.3)} 50%{transform:scaleY(1)} }
      @keyframes av-task-row-in {
        from{opacity:0;transform:translateY(-4px)} to{opacity:1;transform:translateY(0)} }
      #av-task-panel{position:fixed;z-index:60;min-width:260px;max-width:420px;
        font:12px "SF Mono",Menlo,Consolas,monospace;color:rgba(230,238,250,.92);
        user-select:none;}
      #av-task-bar{display:flex;align-items:center;gap:10px;
        background:rgba(8,12,22,.82);border:1px solid rgba(120,160,210,.32);
        border-radius:999px;padding:9px 14px;cursor:grab;
        box-shadow:0 0 22px rgba(90,190,255,.14),0 4px 18px rgba(0,0,0,.35);}
      #av-task-panel.dragging #av-task-bar{cursor:grabbing}
      #av-task-dot{width:7px;height:7px;border-radius:50%;flex:none;
        background:rgba(130,140,155,.65);animation:av-task-dot 1.6s ease-in-out infinite}
      #av-task-dot.st-listening{background:rgba(110,230,160,.95)}
      #av-task-dot.st-working,#av-task-dot.st-thinking{background:rgba(110,200,255,.95);
        animation-duration:1s}
      #av-task-dot.st-speaking{background:rgba(180,150,255,.95);animation-duration:.6s}
      #av-task-label{letter-spacing:.18em;font-size:10px;font-weight:600;
        color:rgba(150,200,240,.85);white-space:nowrap;flex:none}
      #av-task-wave{display:inline-flex;align-items:center;gap:2px;height:14px;flex:none}
      #av-task-wave i{width:2px;border-radius:1px;display:block;
        background:rgba(120,200,255,.85);height:40%;
        animation:av-task-wave-idle 1.4s ease-in-out infinite}
      #av-task-divider{width:1px;align-self:stretch;background:rgba(120,160,210,.25);flex:none}
      #av-task-current{font-size:12px;color:rgba(210,222,240,.85);flex:1 1 auto;
        white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}
      #av-task-badge{font-size:9px;letter-spacing:.14em;color:rgba(150,200,240,.85);
        border:1px solid rgba(120,160,210,.35);border-radius:999px;
        padding:3px 9px;flex:none;white-space:nowrap}
      #av-task-badge:empty{display:none}
      #av-task-chevron{flex:none;width:18px;height:18px;border:none;background:none;
        color:rgba(150,200,240,.85);cursor:pointer;font-size:11px;
        display:flex;align-items:center;justify-content:center;
        transition:transform .2s;}
      #av-task-panel.expanded #av-task-chevron{transform:rotate(180deg)}
      #av-task-expanded{margin-top:6px;background:rgba(8,12,22,.82);
        border:1px solid rgba(120,160,210,.32);border-radius:14px;
        padding:12px 14px 10px;box-shadow:0 0 22px rgba(90,190,255,.14),0 4px 18px rgba(0,0,0,.35);
        display:none;}
      #av-task-panel.expanded #av-task-expanded{display:block}
      .av-task-section-label{letter-spacing:.16em;font-size:9px;
        color:rgba(140,160,185,.75);display:flex;align-items:center;
        justify-content:space-between;margin-bottom:8px}
      .av-task-mini-badge{font-size:9px;letter-spacing:.1em;color:rgba(150,200,240,.85);
        border:1px solid rgba(120,160,210,.35);border-radius:999px;padding:2px 8px}
      #av-task-cur-row{display:flex;align-items:center;gap:9px}
      .av-task-spin{width:14px;height:14px;border-radius:50%;flex:none;
        border:2px solid rgba(110,200,255,.22);border-top-color:rgba(110,200,255,.95);
        animation:av-task-spin .9s linear infinite}
      .av-task-row-label{font-size:12px;color:rgba(230,238,250,.92);flex:1 1 auto;
        white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}
      #av-task-cur-time{font-size:11px;color:rgba(150,200,240,.75);flex:none}
      #av-task-cur-plain{font-size:12px;color:rgba(190,205,225,.75)}
      #av-task-bg-section{margin-top:11px;padding-top:10px;
        border-top:1px solid rgba(120,160,210,.2)}
      #av-task-bg-rows{display:flex;flex-direction:column;gap:9px}
      .av-task-bg-row{display:flex;align-items:center;gap:9px}
      .av-task-bg-row-wrap{animation:av-task-row-in .2s ease-out}
      .av-task-bg-row-status{font-size:10px;color:rgba(140,160,185,.65);flex:none}
      .av-task-progress-wrap{margin-top:5px}
      .av-task-progress-track{height:3px;border-radius:2px;
        background:rgba(255,255,255,.08);overflow:hidden}
      .av-task-progress-fill{height:100%;border-radius:2px;
        background:linear-gradient(90deg,rgba(110,200,255,.9),rgba(150,120,255,.9));
        transition:width .5s linear}
      .av-task-progress-text{font-size:9px;letter-spacing:.02em;
        color:rgba(150,200,240,.65);display:block;margin-top:3px}
      #av-task-lastdone{display:none;align-items:center;gap:8px;
        background:rgba(8,12,22,.82);border:1px solid rgba(110,230,160,.35);
        border-radius:999px;padding:7px 14px;margin-bottom:8px;max-width:420px;
        box-shadow:0 0 16px rgba(110,230,160,.12),0 4px 14px rgba(0,0,0,.35);}
      #av-task-lastdone.av-task-row-in{animation:av-task-row-in .25s ease-out}
      #av-task-lastdone-check{flex:none;width:14px;height:14px;border-radius:50%;
        background:rgba(110,230,160,.18);color:rgba(110,230,160,.95);
        font-size:9px;font-weight:700;display:flex;align-items:center;
        justify-content:center;line-height:1}
      #av-task-lastdone-label{font-size:11px;color:rgba(210,222,240,.88);
        white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}
    `;
    document.head.appendChild(style);

    panelEl = document.createElement("div");
    panelEl.id = "av-task-panel";

    barEl = document.createElement("div");
    barEl.id = "av-task-bar";
    dotEl = document.createElement("span"); dotEl.id = "av-task-dot";
    labelEl = document.createElement("span"); labelEl.id = "av-task-label";
    waveEl = document.createElement("span"); waveEl.id = "av-task-wave";
    for (let i = 0; i < WAVE_BARS; i++) {
      const bar = document.createElement("i");
      bar.style.animationDelay = (i * 0.11).toFixed(2) + "s";
      waveEl.appendChild(bar);
    }
    const divider = document.createElement("span"); divider.id = "av-task-divider";
    currentEl = document.createElement("span"); currentEl.id = "av-task-current";
    badgeEl = document.createElement("span"); badgeEl.id = "av-task-badge";
    chevronEl = document.createElement("button"); chevronEl.id = "av-task-chevron";
    chevronEl.type = "button";
    chevronEl.textContent = "⌄";
    barEl.append(dotEl, labelEl, waveEl, divider, currentEl, badgeEl, chevronEl);

    expandedEl = document.createElement("div");
    expandedEl.id = "av-task-expanded";
    curSectionEl = document.createElement("div");
    curSectionEl.innerHTML = `<div class="av-task-section-label">CURRENT TASK</div>`;
    const curRow = document.createElement("div");
    curRow.id = "av-task-cur-row";
    curSectionEl.appendChild(curRow);
    curProgEl = taskProgressBuild();
    curSectionEl.appendChild(curProgEl.wrap);
    bgSectionEl = document.createElement("div");
    bgSectionEl.id = "av-task-bg-section";
    bgSectionEl.innerHTML =
      `<div class="av-task-section-label"><span>BACKGROUND TASKS</span>` +
      `<span class="av-task-mini-badge" id="av-task-bg-badge"></span></div>`;
    bgRowsEl = document.createElement("div");
    bgRowsEl.id = "av-task-bg-rows";
    bgSectionEl.appendChild(bgRowsEl);
    bgBadgeEl = bgSectionEl.querySelector("#av-task-bg-badge");
    expandedEl.append(curSectionEl, bgSectionEl);

    lastDoneEl = document.createElement("div");
    lastDoneEl.id = "av-task-lastdone";
    const lastDoneCheck = document.createElement("span");
    lastDoneCheck.id = "av-task-lastdone-check";
    lastDoneCheck.textContent = "✓";
    lastDoneLabelEl = document.createElement("span");
    lastDoneLabelEl.id = "av-task-lastdone-label";
    lastDoneEl.append(lastDoneCheck, lastDoneLabelEl);

    panelEl.append(lastDoneEl, barEl, expandedEl);
    document.body.appendChild(panelEl);

    if (expandedPref() || Q.get("expanded") === "1") {
      expanded = true; panelEl.classList.add("expanded");
    }

    const p = panelPos();
    panelEl.style.top = p.top + "px";
    panelEl.style.left = p.left + "px";

    chevronEl.addEventListener("pointerdown", e => e.stopPropagation());
    chevronEl.addEventListener("click", () => {
      expanded = !expanded;
      panelEl.classList.toggle("expanded", expanded);
      expandedSave(expanded);
    });

    barEl.addEventListener("pointerdown", e => {
      dragging = true;
      dragMoved = false;
      panelEl.classList.add("dragging");
      barEl.setPointerCapture(e.pointerId);
      const r = panelEl.getBoundingClientRect();
      dragDX = e.clientX - r.left;
      dragDY = e.clientY - r.top;
    });
    barEl.addEventListener("pointermove", e => {
      if (!dragging) return;
      dragMoved = true;
      const left = Math.min(innerWidth - 40, Math.max(0, e.clientX - dragDX));
      const top = Math.min(innerHeight - 30, Math.max(0, e.clientY - dragDY));
      panelEl.style.left = left + "px";
      panelEl.style.top = top + "px";
    });
    const stopDrag = () => {
      if (!dragging) return;
      dragging = false;
      panelEl.classList.remove("dragging");
      if (dragMoved) {
        const r = panelEl.getBoundingClientRect();
        panelSavePos(r.top, r.left);
      }
    };
    barEl.addEventListener("pointerup", stopDrag);
    barEl.addEventListener("pointercancel", stopDrag);
  }

  function taskListMakeBgRow(label) {
    const wrap = document.createElement("div");
    wrap.className = "av-task-bg-row-wrap";
    const row = document.createElement("div");
    row.className = "av-task-bg-row";
    const spin = document.createElement("span");
    spin.className = "av-task-spin";
    const lab = document.createElement("span");
    lab.className = "av-task-row-label";
    lab.textContent = label;
    const status = document.createElement("span");
    status.className = "av-task-bg-row-status";
    status.textContent = "Running";
    row.append(spin, lab, status);
    const progEl = taskProgressBuild();
    wrap.append(row, progEl.wrap);
    return { wrap, progEl };
  }

  function stateWord() {
    const st = A.state;
    if (st === "thinking") return A.tasks.length ? "WORKING" : "THINKING";
    if (st === "listening") return "LISTENING";
    if (st === "speaking") return "SPEAKING";
    return "IDLE";
  }
  function currentLine() {
    if (A.tasks.length) return A.tasks[0].label;
    switch (A.state) {
      case "listening": return "Listening...";
      case "thinking": return "Thinking...";
      case "speaking": return "Replying...";
      default: return "Standing by";
    }
  }

  function taskListUpdate() {
    if (!panelEl) return;
    const tasks = A.tasks || [];
    const word = stateWord();

    // Persistent "last done" chip — always visible once anything has
    // finished this run, replaced (never cleared) by the next
    // completion. One real result at a time, not an accreting log; a
    // genuine key change (not just the same completion polled again)
    // is what triggers the pop-in so it doesn't re-animate every 120ms.
    const lc = A.lastCompleted;
    if (lc && lc.label) {
      const key = lc.id + "|" + lc.completed_ts;
      if (lastDoneEl.dataset.key !== key) {
        lastDoneEl.dataset.key = key;
        lastDoneLabelEl.textContent = lc.label;
        lastDoneEl.classList.remove("av-task-row-in");
        void lastDoneEl.offsetWidth;   // restart the animation
        lastDoneEl.classList.add("av-task-row-in");
      }
      lastDoneEl.style.display = "flex";
    } else {
      lastDoneEl.style.display = "none";
    }

    dotEl.className = "st-" + word.toLowerCase();
    labelEl.textContent = (A.name || "HUGO").toUpperCase() + " " + word;
    currentEl.textContent = currentLine();
    badgeEl.textContent = tasks.length > 1 ? `${tasks.length - 1} BACKGROUND` : "";

    // mini waveform: real levels while speaking/listening, a gentle idle
    // breathe otherwise — never a fake "working" animation dressed as data
    const bars = waveEl.children;
    if (A.state === "speaking" && A.samples) {
      for (let i = 0; i < bars.length; i++) {
        const v = A.samples[Math.floor(i * A.samples.length / bars.length)] || 0;
        bars[i].style.animation = "none";
        bars[i].style.transform = `scaleY(${Math.max(.15, Math.min(1, v))})`;
      }
    } else if (A.state === "listening") {
      for (let i = 0; i < bars.length; i++) {
        bars[i].style.animation = "none";
        bars[i].style.transform = `scaleY(${Math.max(.15, Math.min(1, A.micLevel || 0))})`;
      }
    } else {
      for (let i = 0; i < bars.length; i++) bars[i].style.animation = "";
    }

    // current-task section: a real task with its real elapsed time, or a
    // plain state line when nothing is actually running
    curSectionEl.querySelector(".av-task-section-label").textContent =
      tasks.length ? "CURRENT TASK" : "STATUS";
    const curRow = panelEl.querySelector("#av-task-cur-row");
    curRow.innerHTML = "";
    if (tasks.length) {
      const spin = document.createElement("span");
      spin.className = "av-task-spin";
      const lab = document.createElement("span");
      lab.className = "av-task-row-label";
      lab.textContent = tasks[0].label;
      const time = document.createElement("span");
      time.id = "av-task-cur-time";
      time.textContent = fmtElapsed(Date.now() / 1000 - (tasks[0].ts || Date.now() / 1000));
      curRow.append(spin, lab, time);
      taskProgressSet(curProgEl, tasks[0].ts, tasks[0].eta);
    } else {
      const plain = document.createElement("span");
      plain.id = "av-task-cur-plain";
      plain.textContent = currentLine();
      curRow.appendChild(plain);
      taskProgressSet(curProgEl, null, null);
    }

    // background rows: everything beyond the current task, diffed by id
    // exactly like the old single-list panel did
    const bg = tasks.slice(1);
    const liveIds = new Set(bg.map(t => t.id));
    for (const [id, entry] of rowEls) {
      if (!liveIds.has(id)) { entry.wrap.remove(); rowEls.delete(id); }
    }
    for (const t of bg) {
      let entry = rowEls.get(t.id);
      if (!entry) {
        entry = taskListMakeBgRow(t.label);
        bgRowsEl.appendChild(entry.wrap);
        rowEls.set(t.id, entry);
      }
      taskProgressSet(entry.progEl, t.ts, t.eta);
    }
    bgSectionEl.style.display = bg.length ? "" : "none";
    bgBadgeEl.textContent = bg.length ? `${bg.length} RUNNING` : "";
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

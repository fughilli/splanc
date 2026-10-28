"""The simulator's web page (sim.py serves it at /). One file, no dependencies."""

PAGE = r"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Bridge Display Sim</title>
<style>
:root {
  --bg: #15171a; --panel: #1f2226; --line: #33383e; --text: #e4e6e9; --muted: #8b939c;
  --accent: #5aaaff; --pcb: #0f4a2c; --pcb-edge: #0a3520; --key: #2a2d31; --key-top: #3a3e44;
  --down: #5aaaff; --bad: #ff7a6b; --good: #69d391;
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text);
  font: 14px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
header { padding: 12px 16px; border-bottom: 1px solid var(--line); display: flex;
  gap: 16px; align-items: baseline; flex-wrap: wrap; }
header h1 { font-size: 16px; margin: 0; font-weight: 600; }
header .stats { color: var(--muted); font: 12px ui-monospace, Menlo, monospace; }
main { display: grid; grid-template-columns: minmax(0, 1fr) minmax(320px, 440px); gap: 16px; padding: 16px; }
@media (max-width: 1100px) { main { grid-template-columns: minmax(0, 1fr); } }
section { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 12px; }
section h2 { font-size: 12px; text-transform: uppercase; letter-spacing: .06em; color: var(--muted);
  margin: 0 0 8px; font-weight: 600; }
/* the HAT */
.hat { background: var(--pcb); border: 3px solid var(--pcb-edge); border-radius: 14px; padding: 18px;
  display: flex; align-items: center; gap: 22px; width: max-content; max-width: 100%;
  user-select: none; -webkit-user-select: none; touch-action: none; }
.bezel { background: #050607; border-radius: 6px; padding: 10px 10px 16px; box-shadow: inset 0 0 0 2px #222; }
canvas#oled { display: block; image-rendering: pixelated; background: #000; max-width: 70vw; }
.joy { display: grid; grid-template-columns: repeat(3, 40px); grid-template-rows: repeat(3, 40px); gap: 3px; }
.keys { display: flex; flex-direction: column; gap: 10px; }
button.k { background: var(--key); color: var(--text); border: 1px solid #000; border-radius: 6px;
  box-shadow: inset 0 -3px 0 #111, inset 0 1px 0 var(--key-top); font: 600 12px ui-monospace, Menlo, monospace;
  cursor: pointer; padding: 0; min-width: 40px; min-height: 40px; }
.keys button.k { width: 64px; height: 40px; }
button.k.down { background: var(--down); color: #000; box-shadow: inset 0 2px 0 #2a6fb8; }
.joy .c { border-radius: 50%; }
.legend { color: var(--muted); font-size: 12px; margin-top: 8px; }
kbd { background: #2b2f34; border: 1px solid var(--line); border-radius: 3px; padding: 0 4px;
  font: 11px ui-monospace, Menlo, monospace; }
.row { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; margin: 6px 0; }
.row > label { color: var(--muted); min-width: 92px; }
button.b, select { background: #2b2f34; color: var(--text); border: 1px solid var(--line); border-radius: 5px;
  padding: 4px 10px; font: inherit; cursor: pointer; }
button.b:hover { border-color: var(--accent); }
button.b.on { background: var(--accent); color: #000; border-color: var(--accent); }
img#hdmi { width: 100%; max-width: 640px; aspect-ratio: 16 / 9; display: block; background: #000;
  border: 6px solid #0b0c0d; border-radius: 4px; }
.cols { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 16px; }
@media (max-width: 700px) { .cols { grid-template-columns: minmax(0, 1fr); } }
.stack { display: flex; flex-direction: column; gap: 16px; min-width: 0; }
table { border-collapse: collapse; width: 100%; font-size: 13px; }
td { padding: 3px 4px; border-top: 1px solid var(--line); }
td.n { width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 0; }
.dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 6px; }
.mono { font: 12px ui-monospace, Menlo, monospace; color: var(--muted); white-space: pre-wrap;
  overflow-wrap: anywhere; }
.err { color: var(--bad); min-height: 1.4em; }
</style>
</head>
<body>
<header>
  <h1>Splanc bridge display sim</h1>
  <span class="stats" id="stats">connecting…</span>
</header>
<main>
  <div class="stack">
    <section>
      <h2>Waveshare 1.3" OLED HAT</h2>
      <div class="hat">
        <div class="joy">
          <span></span><button class="k" data-key="up">▲</button><span></span>
          <button class="k" data-key="left">◀</button>
          <button class="k c" data-key="press">●</button>
          <button class="k" data-key="right">▶</button>
          <span></span><button class="k" data-key="down">▼</button><span></span>
        </div>
        <div class="bezel"><canvas id="oled" width="640" height="320"></canvas></div>
        <div class="keys">
          <button class="k" data-key="key1">KEY1</button>
          <button class="k" data-key="key2">KEY2</button>
          <button class="k" data-key="key3">KEY3</button>
        </div>
      </div>
      <div class="legend">
        Keys: <kbd>←</kbd><kbd>→</kbd><kbd>↑</kbd><kbd>↓</kbd> joystick, <kbd>Enter</kbd>/<kbd>Space</kbd> press,
        <kbd>1</kbd><kbd>2</kbd><kbd>3</kbd> KEY1–3 (hold works: KEY3 5 s = revoke). <kbd>R</kbd> restart,
        <kbd>F</kbd> next font set.
      </div>
      <div class="row" style="margin-top:10px">
        <label>Display</label>
        <button class="b" id="restart">Restart service (boot logo)</button>
        <select id="speed" title="clock rate handed to the service">
          <option value="1">1× speed</option><option value="0.5">0.5×</option>
          <option value="0.25">0.25× slow-mo</option><option value="0.1">0.1×</option>
          <option value="2">2×</option>
        </select>
        <button class="b" id="grid">Pixel grid</button>
        <select id="tint"><option value="blue">Blue panel</option><option value="white">White panel</option></select>
        <select id="scale">
          <option value="4">4×</option><option value="5" selected>5×</option><option value="6">6×</option>
        </select>
      </div>
      <div class="row">
        <label>OLED fonts</label>
        <select id="fontset" title="F cycles"></select>
        <button class="b" id="allsets">All sets</button>
        <span class="mono" id="fontmeta"></span>
      </div>
      <img id="sheet" alt="the current screen in every font set" hidden
        style="width:100%;max-width:800px;display:block;margin-top:8px;image-rendering:pixelated">
      <div class="err" id="err"></div>
    </section>
    <section>
      <h2>HDMI</h2>
      <img id="hdmi" alt="HDMI output">
    </section>
  </div>
  <div class="stack">
    <section id="bridge">
      <h2>Bridge <span id="bkind"></span></h2>
      <div id="bfake" hidden>
        <div class="row"><label>Phase</label>
          <button class="b" data-a="phase" data-v="starting">starting</button>
          <button class="b" data-a="phase" data-v="running">running</button>
          <button class="b" data-a="phase" data-v="error">error</button></div>
        <div class="row"><label>Relay</label>
          <button class="b" data-a="relay" data-v="true">connected</button>
          <button class="b" data-a="relay" data-v="false">disconnected</button></div>
        <div class="row"><label>Pairing code</label>
          <button class="b" data-a="code" data-v="300">new (5 min)</button>
          <button class="b" data-a="code" data-v="20">expiring (20 s)</button>
          <button class="b" data-a="code" data-v="0">none</button>
          <span class="mono" id="code"></span></div>
        <div class="row"><label>Paired</label>
          <button class="b" data-a="paired" data-v="true">yes</button>
          <button class="b" data-a="paired" data-v="false">no</button>
          <label style="min-width:0">sessions</label>
          <button class="b" data-a="clients" data-v="-1">−</button><span id="clients">0</span>
          <button class="b" data-a="clients" data-v="+1">+</button></div>
        <div class="row"><label>Commands</label>
          <button class="b" data-a="fail" data-v="">succeed</button>
          <button class="b" data-a="fail" data-v="relay timed out">fail</button>
          <select id="delay"><option value="0">instant</option><option value="0.3" selected>0.3 s</option>
            <option value="2">2 s</option></select></div>
        <div class="row"><label>Fixtures</label>
          <button class="b" data-a="add">add</button>
          <button class="b" data-a="fixtures" data-v="sample">3 samples</button>
          <button class="b" data-a="fixtures" data-v="many">12</button>
          <button class="b" data-a="fixtures" data-v="none">none</button></div>
        <table id="players"></table>
        <div class="row"><label>Paired clients</label>
          <button class="b" data-a="client_add">add</button>
          <button class="b" data-a="client_list" data-v="sample">3 samples</button>
          <button class="b" data-a="client_list" data-v="many">12</button>
          <button class="b" data-a="client_list" data-v="none">none</button>
          <button class="b" data-a="client_list" data-v="outdated" id="outdated">relay outdated</button></div>
        <table id="pclients"></table>
      </div>
      <div id="breal" hidden>
        <div class="row"><label>Relay</label>
          <button class="b" data-a="relay" data-v="true">start local relay</button>
          <button class="b" data-a="relay" data-v="false">stop it</button>
          <span class="mono" id="relayurl"></span></div>
        <div class="mono" id="blog"></div>
      </div>
    </section>
    <section>
      <h2>Service view</h2>
      <div class="mono" id="view"></div>
    </section>
  </div>
</main>
<script>
"use strict";
const $ = (id) => document.getElementById(id);
const canvas = $("oled"), ctx = canvas.getContext("2d");
let bits = new Uint8Array(1024), contrast = 0xcf, hidden = false, hdmiSeq = -1, info = null;
let grid = false, tint = "blue", scale = 5;
const TINTS = { blue: [90, 170, 255], white: [235, 240, 255] };

function post(path, body) {
  return fetch(path, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify(body || {}) }).then((r) => r.json()).then((j) => {
      $("err").textContent = j.ok ? "" : (j.error || "error");
      return j;
    }).catch((e) => { $("err").textContent = String(e); });
}

function draw() {
  const w = 128 * scale, h = 64 * scale;
  if (canvas.width !== w) { canvas.width = w; canvas.height = h; }
  ctx.fillStyle = "#000"; ctx.fillRect(0, 0, w, h);
  if (hidden) return;
  const [r, g, b] = TINTS[tint];
  const k = contrast >= 0x80 ? 1 : 0.35;  // CONTRAST_DIM on a real panel: clearly dimmer
  ctx.fillStyle = `rgb(${r * k | 0},${g * k | 0},${b * k | 0})`;
  const gap = grid && scale >= 4 ? 1 : 0;
  for (let y = 0; y < 64; y++) for (let x = 0; x < 128; x++) {
    if (bits[y * 16 + (x >> 3)] & (0x80 >> (x & 7)))
      ctx.fillRect(x * scale, y * scale, scale - gap, scale - gap);
  }
  if (grid && scale >= 4) {
    ctx.fillStyle = "rgba(255,255,255,0.05)";
    for (let x = 0; x < 128; x++) ctx.fillRect(x * scale + scale - 1, 0, 1, h);
    for (let y = 0; y < 64; y++) ctx.fillRect(0, y * scale + scale - 1, w, 1);
  }
}

function connect() {
  const es = new EventSource("/events");
  es.addEventListener("frame", (e) => {
    const m = JSON.parse(e.data);
    const s = atob(m.bits); for (let i = 0; i < s.length; i++) bits[i] = s.charCodeAt(i);
    contrast = m.contrast; hidden = m.hidden;
    if (m.hdmi !== hdmiSeq) { hdmiSeq = m.hdmi; $("hdmi").src = "/hdmi.png?n=" + m.hdmi; }
    draw();
  });
  es.addEventListener("info", (e) => { info = JSON.parse(e.data); showInfo(); });
  es.onerror = () => { $("stats").textContent = "disconnected — retrying…"; };
}

let fontsShown = "", sheetOn = false, sheetKey = "";
function showFonts(f) {
  const sel = $("fontset");
  const names = f.sets.map((x) => x.name).join(",");
  if (names !== fontsShown) {
    fontsShown = names;
    sel.innerHTML = f.sets.map((x) =>
      `<option value="${esc(x.name)}">${esc(x.name)}${x.name === f.default ? " (default)" : ""}</option>`).join("");
  }
  if (document.activeElement !== sel) sel.value = f.active;
  const cur = f.sets.find((x) => x.name === f.active) || {};
  $("fontmeta").textContent = `${cur.label} · ${cur.summary} · ${cur.license}`;
}
function refreshSheet(force) {
  if (!sheetOn || !info) return;
  const v = info.view || {};
  const key = [info.fonts.active, v.page, v.key, v.sel, v.overlay, info.bridge.state,
    Math.floor(Date.now() / 5000)].join("|");
  if (force || key !== sheetKey) { sheetKey = key; $("sheet").src = "/fontsets.png?t=" + Date.now(); }
}
function setFonts(name) {
  post("/fonts", { name }).then((j) => { if (j && j.state) { info = j.state; showInfo(); refreshSheet(true); } });
}

function showInfo() {
  const v = info.view || {};
  $("stats").textContent = `${info.fps ? info.fps.toFixed(0) + " fps" : "idle"} · ` +
    `frame interval ${info.frame_interval_ms} ms · ` +
    `${info.speed}× clock · page ${v.page || "?"}${v.overlay ? " + " + v.overlay : ""}` +
    `${v.animating ? " · animating" : ""}${v.dimmed ? " · dimmed" : ""}${v.asleep ? " · asleep" : ""}`;
  $("view").textContent = Object.entries(v).map(([k, x]) => `${k}: ${x}`).join("\n");
  showFonts(info.fonts);
  refreshSheet(false);
  const b = info.bridge;
  $("bkind").textContent = `(${b.kind}: ${b.state || "?"})`;
  $("bfake").hidden = b.kind !== "fake"; $("breal").hidden = b.kind !== "real";
  if (b.kind === "fake") {
    mark("phase", b.phase); mark("relay", String(b.relay_up)); mark("paired", String(b.paired));
    mark("fail", b.fail || "");
    $("clients").textContent = b.clients;
    $("code").textContent = b.code ? `${b.code} (${b.code_remaining} s)` : "";
    const rows = b.players.map((p) =>
      `<tr><td class="n"><span class="dot" style="background:var(${p.ok ? "--good" : "--bad"})"></span>` +
      `${esc(p.name)}</td>` +
      `<td><button class="b" data-a="toggle" data-v="${esc(p.key)}">` +
      `${p.ok ? "take offline" : "bring online"}</button></td>` +
      `<td><button class="b" data-a="remove" data-v="${esc(p.key)}">remove</button></td></tr>`).join("");
    if ($("players").dataset.rows !== rows) { $("players").innerHTML = rows; $("players").dataset.rows = rows; }
    $("outdated").classList.toggle("on", !!b.relay_outdated);
    const crows = (b.paired_clients || []).map((c) =>
      `<tr><td class="n"><span class="dot" style="background:var(${c.live ? "--good" : "--muted"})"></span>` +
      `${esc(c.label)} <span class="mono">${esc(c.kind)} · ${esc(c.id.slice(0, 8))}</span></td>` +
      `<td><button class="b" data-a="client_live" data-v="${esc(c.id)}">` +
      `${c.live ? "go idle" : "use now"}</button></td>` +
      `<td><button class="b" data-a="client_remove" data-v="${esc(c.id)}">` +
      `revoke (elsewhere)</button></td></tr>`).join("");
    if ($("pclients").dataset.rows !== crows) { $("pclients").innerHTML = crows; $("pclients").dataset.rows = crows; }
  } else {
    mark("relay", String(b.relay_up));
    $("relayurl").textContent = b.relay + (b.bridge_running ? "" : " · bridge exited");
    $("blog").textContent = (b.log || []).join("\n");
  }
}
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
function mark(a, v) {
  document.querySelectorAll(`#bridge [data-a="${a}"]`).forEach((el) => el.classList.toggle("on", el.dataset.v === v));
}

// Bridge knobs.
$("bridge").addEventListener("click", (e) => {
  const el = e.target.closest("[data-a]"); if (!el || el.tagName === "SELECT") return;
  let a = el.dataset.a, v = el.dataset.v;
  if (a === "relay" || a === "paired") v = v === "true";
  if (a === "clients") v = Math.max(0, (info ? info.bridge.clients : 0) + Number(v));
  post("/bridge", { action: a, arg: v }).then((j) => { if (j && j.state) { info = j.state; showInfo(); } });
});
$("delay").addEventListener("change", (e) => post("/bridge", { action: "delay", arg: Number(e.target.value) }));

// HAT keys: pointer + keyboard, press and release separately (holds are real holds).
// One request at a time, in order: a release must never overtake its press.
const down = new Set();
let keyChain = Promise.resolve();
const sendKey = (k, action) => { keyChain = keyChain.then(() => post("/key", { key: k, action })); };
function keyDown(k) {
  if (down.has(k)) return; down.add(k);
  document.querySelector(`[data-key="${k}"]`).classList.add("down");
  sendKey(k, "press");
}
function keyUp(k) {
  if (!down.has(k)) return; down.delete(k);
  document.querySelector(`[data-key="${k}"]`).classList.remove("down");
  sendKey(k, "release");
}
document.querySelectorAll("button.k").forEach((el) => {
  const k = el.dataset.key;
  el.addEventListener("pointerdown", (e) => { e.preventDefault(); el.setPointerCapture(e.pointerId); keyDown(k); });
  el.addEventListener("pointerup", () => keyUp(k));
  el.addEventListener("pointercancel", () => keyUp(k));
  el.addEventListener("contextmenu", (e) => e.preventDefault());
});
const KEYMAP = { ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right",
  Enter: "press", " ": "press", "1": "key1", "2": "key2", "3": "key3" };
addEventListener("keydown", (e) => {
  if (e.target.tagName === "SELECT" || e.metaKey || e.ctrlKey) return;
  if (KEYMAP[e.key]) { e.preventDefault(); if (!e.repeat) keyDown(KEYMAP[e.key]); }
  else if ((e.key === "r" || e.key === "R") && !e.repeat) post("/restart");
  else if ((e.key === "f" || e.key === "F") && !e.repeat && info) {
    const sets = info.fonts.sets.map((x) => x.name);
    const i = sets.indexOf(info.fonts.active);
    setFonts(sets[(i + (e.shiftKey ? sets.length - 1 : 1)) % sets.length]);
  }
});
addEventListener("keyup", (e) => { if (KEYMAP[e.key]) { e.preventDefault(); keyUp(KEYMAP[e.key]); } });
addEventListener("blur", () => { [...down].forEach(keyUp); keyChain = keyChain.then(() => post("/release_all")); });

// Display controls.
$("restart").onclick = () => post("/restart");
$("fontset").onchange = (e) => { setFonts(e.target.value); e.target.blur(); };
$("allsets").onclick = (e) => {
  sheetOn = !sheetOn; e.target.classList.toggle("on", sheetOn); $("sheet").hidden = !sheetOn; refreshSheet(true);
};
$("speed").onchange = (e) => post("/speed", { speed: Number(e.target.value) });
$("grid").onclick = (e) => { grid = !grid; e.target.classList.toggle("on", grid); draw(); };
$("tint").onchange = (e) => { tint = e.target.value; draw(); };
$("scale").onchange = (e) => { scale = Number(e.target.value); draw(); };
draw();
connect();
</script>
</body>
</html>
"""

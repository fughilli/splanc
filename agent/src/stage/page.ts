/**
 * The stage page (one self-contained HTML document, no network fetches): laid out
 * for a 16:9 TV. Phone (a captured window: QuickTime's iPhone mirror) | the code
 * being written | the conversation and every tool call, with a live twin of each
 * fixture along the bottom.
 *
 * Keys: hold Space to talk; a presenter clicker's Page Down / Page Up (or B)
 * toggles listening; Enter types a prompt instead; Esc stops the agent.
 *
 * Kept free of backticks and dollar-brace so it can live in String.raw.
 */

export const STAGE_PAGE = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Splanc Stage</title>
<style>
:root {
  --bg: #08080c;
  --panel: #111118;
  --panel-2: #181822;
  --line: #262632;
  --text: #ededf0;
  --dim: #8e8e9a;
  --faint: #55555f;
  --accent: #7c95ff;
  --ok: #3ddc84;
  --warn: #f0b93e;
  --err: #ff5c64;
  --kw: #c792ea;
  --ty: #7fd4ff;
  --num: #f7a26b;
  --fn: #9ef0b4;
  --com: #6b6b7a;
  --gap: 1.1vw;
  --r: 14px;
  color-scheme: dark;
}
* { box-sizing: border-box; }
html, body { margin: 0; height: 100%; background: var(--bg); color: var(--text); overflow: hidden;
  font: 400 1.05vw/1.4 -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Roboto, sans-serif; }
.app { height: 100vh; display: grid; gap: var(--gap); padding: var(--gap);
  grid-template-rows: auto 1fr auto; grid-template-columns: auto minmax(0, 1.25fr) minmax(0, 1fr);
  grid-template-areas: "top top top" "phone code talk" "phone twin twin"; }
.app.nophone { grid-template-columns: 0 minmax(0, 1.25fr) minmax(0, 1fr); }
header { grid-area: top; display: flex; align-items: center; gap: 1.2vw; padding: 0 .3vw; }
.mark { font-weight: 700; font-size: 1.5vw; letter-spacing: -.02em; }
.mark span { color: var(--accent); }
.status { display: flex; align-items: center; gap: .6vw; padding: .45vw 1vw; border-radius: 999px;
  background: var(--panel-2); border: 1px solid var(--line); font-size: 1.05vw; color: var(--dim); transition: all .25s; }
.status i { width: .7vw; height: .7vw; border-radius: 50%; background: var(--faint); }
.status.listening { color: #fff; border-color: var(--err); background: #2a1114; }
.status.listening i { background: var(--err); animation: pulse 1s infinite; }
.status.thinking i, .status.working i { background: var(--accent); animation: pulse 1.2s infinite; }
.status.thinking, .status.working { color: var(--text); }
@keyframes pulse { 50% { opacity: .25; } }
.hint { margin-left: auto; color: var(--faint); font-size: .9vw; }
.hint kbd { font: inherit; color: var(--dim); border: 1px solid var(--line); border-radius: 5px; padding: 0 .35vw; }
.btn { background: var(--panel-2); color: var(--dim); border: 1px solid var(--line); border-radius: 8px;
  padding: .35vw .8vw; font: inherit; font-size: .9vw; cursor: pointer; }
.btn:hover { color: var(--text); }
.panel { background: var(--panel); border: 1px solid var(--line); border-radius: var(--r); min-height: 0; min-width: 0;
  display: flex; flex-direction: column; overflow: hidden; }
.ph { display: flex; align-items: center; gap: .8vw; padding: .8vw 1.1vw; border-bottom: 1px solid var(--line);
  color: var(--dim); font-size: .95vw; text-transform: uppercase; letter-spacing: .08em; }
.ph b { color: var(--text); text-transform: none; letter-spacing: 0; font-weight: 600; font-size: 1.1vw; }
.badge { margin-left: auto; text-transform: none; letter-spacing: 0; padding: .15vw .6vw; border-radius: 6px;
  background: var(--panel-2); color: var(--dim); font-size: .9vw; }
.badge.ok { color: var(--ok); } .badge.err { color: var(--err); } .badge.busy { color: var(--accent); }

/* phone */
.phone { grid-area: phone; width: 22vw; display: flex; align-items: center; justify-content: center; }
.nophone .phone { display: none; }
.phone video { max-height: 100%; max-width: 100%; border-radius: 2.2vw; border: .5vw solid #1d1d24;
  box-shadow: 0 0 0 1px var(--line), 0 1.5vw 4vw #000a; background: #000; }

/* code */
.code { grid-area: code; }
pre { margin: 0; flex: 1; overflow: hidden; padding: 1vw 1.2vw; counter-reset: ln;
  font: 400 1.02vw/1.5 ui-monospace, "SF Mono", Menlo, "Fira Code", monospace; color: #d6d6de; }
pre .l { display: block; white-space: pre-wrap; padding-left: 3.2vw; text-indent: -3.2vw; }
pre .l::before { counter-increment: ln; content: counter(ln); display: inline-block; width: 2.4vw; margin-right: .8vw;
  text-align: right; color: var(--faint); text-indent: 0; }
pre .l.bad { background: #ff5c6422; box-shadow: inset .25vw 0 var(--err); }
pre .l.warnl { background: #f0b93e18; box-shadow: inset .25vw 0 var(--warn); }
.kw { color: var(--kw); } .ty { color: var(--ty); } .nu { color: var(--num); } .fn { color: var(--fn); } .co { color: var(--com); font-style: italic; }
.caret { display: inline-block; width: .55vw; height: 1.1vw; background: var(--accent); vertical-align: -.15vw; animation: pulse .8s infinite; }
.diag { padding: .6vw 1.2vw; border-top: 1px solid var(--line); font: 400 .95vw/1.4 ui-monospace, Menlo, monospace; color: var(--err); max-height: 22%; overflow: hidden; }
.diag.warn { color: var(--warn); }
.diag:empty { display: none; }
.empty { margin: auto; color: var(--faint); font-size: 1.3vw; text-align: center; padding: 2vw; }

/* talk */
.talk { grid-area: talk; }
.conv { padding: 1.2vw 1.4vw .4vw; display: flex; flex-direction: column; gap: 1vw; }
.said { font-size: 1.6vw; line-height: 1.3; font-weight: 600; color: #fff; }
.said.interim { color: var(--dim); }
.said:before { content: "\201C"; color: var(--accent); margin-right: .2vw; }
.said:after { content: "\201D"; color: var(--accent); margin-left: .1vw; }
.said:empty { display: none; }
.reply { font-size: 1.45vw; line-height: 1.38; color: #dcdce4; }
.reply:empty { display: none; }
.think { font-size: .95vw; color: var(--faint); font-style: italic; max-height: 3.2em; overflow: hidden; }
.think:empty { display: none; }
.steps { flex: 1; overflow: hidden; display: flex; flex-direction: column; justify-content: flex-end; gap: .45vw; padding: .6vw 1.1vw 1vw; }
.step { display: grid; grid-template-columns: 1.4vw 1fr auto; gap: .2vw .7vw; align-items: center; padding: .5vw .8vw;
  border-radius: 10px; background: var(--panel-2); border: 1px solid var(--line); animation: in .3s ease; }
@keyframes in { from { opacity: 0; transform: translateY(.6vw); } }
.step .ic { width: 1vw; height: 1vw; border-radius: 50%; border: .18vw solid var(--accent); border-top-color: transparent; animation: spin .8s linear infinite; }
.step.ok .ic { border: none; background: var(--ok); animation: none; -webkit-mask: none; }
.step.err .ic { border: none; background: var(--err); animation: none; }
@keyframes spin { to { transform: rotate(1turn); } }
.step .nm { font-weight: 600; font-size: 1.05vw; }
.step .nm small { color: var(--dim); font-weight: 400; margin-left: .5vw; }
.step .ms { color: var(--faint); font-size: .9vw; font-variant-numeric: tabular-nums; }
.step .sub { grid-column: 2 / 4; color: var(--dim); font-size: .9vw; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.step.err .sub { color: var(--err); white-space: normal; max-height: 2.8em; }
.step .pics { grid-column: 2 / 4; display: flex; gap: .4vw; }
.step .pics img { height: 4.2vw; border-radius: 6px; background: #000; }
.step.note { grid-template-columns: 1fr; color: var(--dim); font-size: .95vw; }

/* twin */
.twin { grid-area: twin; height: 36vh; }
.fixtures { flex: 1; display: flex; gap: var(--gap); padding: .8vw 1.1vw 1vw; min-height: 0; }
.fx { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: .4vw; }
.fx .nm { font-size: .95vw; color: var(--dim); display: flex; gap: .6vw; }
.fx .nm b { color: var(--text); font-weight: 600; }
.fx canvas { flex: 1; min-height: 0; width: 100%; border-radius: 10px; background: #050507; }

/* deploy flash */
.flash { position: fixed; left: 50%; top: 46%; transform: translate(-50%, -50%) scale(.9); opacity: 0; pointer-events: none;
  padding: 1.4vw 2.6vw; border-radius: 18px; background: #0f2a1bf0; border: 2px solid var(--ok); color: #fff;
  font-size: 2.4vw; font-weight: 700; transition: all .35s ease; box-shadow: 0 2vw 6vw #000c; }
.flash.on { opacity: 1; transform: translate(-50%, -50%) scale(1); }
.typebox { position: fixed; left: 50%; bottom: 31vh; transform: translateX(-50%); width: 50vw; display: none; }
.typebox.on { display: block; }
.typebox input { width: 100%; font: inherit; font-size: 1.5vw; padding: .9vw 1.2vw; border-radius: 12px;
  border: 2px solid var(--accent); background: var(--panel-2); color: var(--text); outline: none; }
</style>
</head>
<body>
<div class="app nophone" id="app">
  <header>
    <div class="mark">splanc<span>.</span>live</div>
    <div class="status" id="status"><i></i><span id="statusText">Connecting…</span></div>
    <div class="hint" id="hint">Hold <kbd>Space</kbd> to talk · <kbd>Enter</kbd> to type · <kbd>Esc</kbd> stop</div>
    <button class="btn" id="phoneBtn" title="Show a window (e.g. QuickTime's iPhone mirror) in the phone slot">Phone</button>
    <button class="btn" id="mapsBtn" title="Re-read the fixtures' maps (after mapping in the app)">Maps</button>
    <button class="btn" id="resetBtn" title="Start a new conversation">New</button>
  </header>
  <div class="phone"><video id="phone" autoplay muted playsinline></video></div>
  <section class="panel code">
    <div class="ph">Effect <b id="effName">—</b><span class="badge" id="compile">waiting</span></div>
    <pre id="code"><div class="empty">Ask for a look.<br>The code appears here as it is written.</div></pre>
    <div class="diag" id="diag"></div>
  </section>
  <section class="panel talk">
    <div class="ph">Conversation</div>
    <div class="conv">
      <div class="said" id="said"></div>
      <div class="think" id="think"></div>
      <div class="reply" id="reply"></div>
    </div>
    <div class="steps" id="steps"></div>
  </section>
  <section class="panel twin">
    <div class="ph">Live preview <span class="badge">device VM on each fixture's real map</span></div>
    <div class="fixtures" id="fixtures"><div class="empty" id="noFx">Looking for fixtures…</div></div>
  </section>
</div>
<div class="flash" id="flash"></div>
<div class="typebox" id="typebox"><input id="typed" placeholder="Type a prompt and press Enter" autocomplete="off"></div>
<script>
(function () {
  "use strict";
  var KEY = new URLSearchParams(location.search).get("k") || "";
  var Q = KEY ? "?k=" + encodeURIComponent(KEY) : "";
  var $ = function (id) { return document.getElementById(id); };
  var LABEL = {
    list_players: "Find fixtures", refresh_players: "Look for fixtures", identify_player: "Blink fixtures",
    export_map: "Read map", plot_fixture: "Plot fixture", set_brightness: "Brightness",
    list_uniforms: "Read knobs", set_uniforms: "Turn knobs", ramp_uniforms: "Glide knobs",
    list_keypoints: "Saved looks", recall_keypoint: "Recall look", blend_keypoints: "Blend looks", get_keypoint: "Read look",
    read_sensors: "Read sensor", compile_effect: "Compile", estimate_effect: "Estimate cost", preview_effect: "Preview",
    deploy_effect: "Deploy", set_effect: "Switch effect", rollback_effect: "Undo", crossfade_to: "Crossfade",
    list_decks: "Decks", list_textures: "Textures", search_effects: "Search library", get_effect: "Open library effect"
  };
  function post(path, body) {
    return fetch(path + Q, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}) });
  }

  // ---- status ---------------------------------------------------------------
  var idleText = "Ready";
  function status(kind, text) {
    $("status").className = "status " + (kind || "");
    $("statusText").textContent = text;
  }

  // ---- code panel -----------------------------------------------------------
  var KW = /^(uniform|state|buffer|texture|const|if|else|for|while|return|in|true|false|struct|break|continue)$/;
  var TY = /^(void|float|fixed|int|uint|bool|vec2|vec3|vec4|ivec2|ivec3|mat2|mat3|mat4|Led)$/;
  function esc(s) { return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
  function hl(line) {
    var out = "", m, re = /(\/\/.*$)|(\b\d+(?:\.\d*)?(?:e[-+]?\d+)?\b|\.\d+\b)|([A-Za-z_]\w*)(\s*\()?|([^A-Za-z_\d\/]+|\/)/g;
    while ((m = re.exec(line)) !== null) {
      if (m[1]) out += '<span class="co">' + esc(m[1]) + "</span>";
      else if (m[2]) out += '<span class="nu">' + m[2] + "</span>";
      else if (m[3]) {
        var w = m[3];
        if (KW.test(w)) out += '<span class="kw">' + w + "</span>";
        else if (TY.test(w)) out += '<span class="ty">' + w + "</span>";
        else if (m[4]) out += '<span class="fn">' + w + "</span>";
        else out += w;
        if (m[4]) out += esc(m[4]);
      } else out += esc(m[5]);
      if (m[0] === "") re.lastIndex++;
    }
    return out;
  }
  var code = { id: null, target: "", shown: 0, done: false, bad: {}, warn: {} };
  function renderCode() {
    var text = code.target.slice(0, code.shown);
    if (code.done && code.shown >= code.target.length) text = text.replace(/\s+$/, "");
    var lines = text.split("\n");
    var html = lines.map(function (l, i) {
      var cls = code.bad[i + 1] ? " bad" : code.warn[i + 1] ? " warnl" : "";
      return '<span class="l' + cls + '">' + (hl(l) || " ") + (i === lines.length - 1 && !code.done ? '<span class="caret"></span>' : "") + "</span>";
    }).join("");
    var pre = $("code");
    pre.innerHTML = html;
    // Follow the cursor while writing; show the top once done.
    var caret = pre.querySelector(".caret");
    if (caret) { var over = caret.offsetTop - pre.clientHeight * 0.75; pre.scrollTop = over > 0 ? over : 0; }
  }
  setInterval(function () {
    if (code.shown >= code.target.length) return;
    var behind = code.target.length - code.shown;
    code.shown += Math.max(3, Math.ceil(behind / 12));
    if (code.shown > code.target.length) code.shown = code.target.length;
    renderCode();
  }, 30);
  function effectName(src) {
    var m = /^\s*\/\/\s*(.+)$/m.exec(src);
    return m ? m[1].slice(0, 60) : "untitled";
  }

  // ---- conversation + steps -------------------------------------------------
  var steps = {};
  function addStep(id, cls, nameHtml) {
    var el = document.createElement("div");
    el.className = "step " + cls;
    el.innerHTML = '<div class="ic"></div><div class="nm">' + nameHtml + '</div><div class="ms"></div><div class="sub"></div>';
    $("steps").appendChild(el);
    while ($("steps").children.length > 9) $("steps").removeChild($("steps").firstChild);
    if (id) steps[id] = el;
    return el;
  }
  function note(text, cls) {
    var el = document.createElement("div");
    el.className = "step note " + (cls || "");
    el.textContent = text;
    $("steps").appendChild(el);
    while ($("steps").children.length > 9) $("steps").removeChild($("steps").firstChild);
  }
  function summarize(name, args) {
    var parts = [];
    if (args.effect_id) parts.push(args.effect_id);
    if (args.library_id) parts.push("library " + args.library_id);
    if (args.query) parts.push('"' + args.query + '"');
    if (args.seconds !== undefined) parts.push(args.seconds + " s");
    if (args.values) parts.push(Object.keys(args.values).map(function (k) { return k + " " + JSON.stringify(args.values[k]); }).join(", "));
    if (args.targets) parts.push(Object.keys(args.targets).map(function (k) { return k + " → " + JSON.stringify(args.targets[k]); }).join(", "));
    if (args.brightness !== undefined) parts.push(Math.round(args.brightness * 100) + "%");
    if (args.players) parts.push("on " + [].concat(args.players).join(", "));
    return parts.join(" · ");
  }
  // The compile result for the code panel: diagnostics (errors) / warnings, by line.
  function findCompile(j) {
    if (!j || typeof j !== "object") return null;
    if ("diagnostics" in j && "ok" in j) return j;
    for (var k in j) { var r = findCompile(j[k]); if (r) return r; }
    return null;
  }
  function onCompiled(text, okCall) {
    var j = null;
    try { j = JSON.parse(text); } catch (e) { /* plain error text */ }
    var c = findCompile(j);
    code.bad = {}; code.warn = {};
    var diag = $("diag");
    diag.className = "diag"; diag.textContent = "";
    if (!c) {
      $("compile").className = "badge " + (okCall ? "ok" : "err");
      $("compile").textContent = okCall ? "compiled" : "failed";
      if (!okCall) diag.textContent = text.slice(0, 300);
      renderCode();
      return;
    }
    if (!c.ok) {
      (c.diagnostics || []).forEach(function (d) { code.bad[d.line] = 1; });
      diag.textContent = (c.diagnostics || []).slice(0, 3).map(function (d) { return d.line + ":" + d.col + "  " + d.msg; }).join("\n");
      $("compile").className = "badge err";
      $("compile").textContent = "compile error";
    } else {
      var w = c.warnings || [];
      w.forEach(function (d) { code.warn[d.line] = 1; });
      if (w.length) { diag.className = "diag warn"; diag.textContent = w.slice(0, 2).map(function (d) { return d.line + ":" + d.col + "  " + d.msg; }).join("\n"); }
      var knobs = (c.uniforms || []).length;
      $("compile").className = "badge ok";
      $("compile").textContent = "compiled · " + c.bytecode_bytes + " B · " + knobs + " knob" + (knobs === 1 ? "" : "s");
    }
    renderCode();
  }
  var flashTimer = 0;
  function flash(text) {
    var f = $("flash");
    f.textContent = text;
    f.classList.add("on");
    clearTimeout(flashTimer);
    flashTimer = setTimeout(function () { f.classList.remove("on"); }, 1800);
  }
  var replyFresh = false;

  // ---- twin -----------------------------------------------------------------
  var fixtures = {};
  function layout(ev) {
    $("noFx") && $("noFx").remove();
    var f = fixtures[ev.player];
    if (!f) {
      var el = document.createElement("div");
      el.className = "fx";
      el.innerHTML = '<div class="nm"><b></b><span></span></div><canvas></canvas>';
      $("fixtures").appendChild(el);
      f = fixtures[ev.player] = { el: el, canvas: el.querySelector("canvas"), rgb: null };
    }
    f.xy = ev.xy; f.aspect = ev.aspect; f.live = !!ev.effect;
    f.el.querySelector("b").textContent = ev.name;
    f.el.querySelector("span").textContent = ev.effect ? "· " + ev.effect : "· map";
    f.rgb = null;
    draw(f);
  }
  function draw(f) {
    var c = f.canvas, dpr = window.devicePixelRatio || 1;
    var W = c.clientWidth * dpr, H = c.clientHeight * dpr;
    if (c.width !== W || c.height !== H) { c.width = W; c.height = H; }
    var g = c.getContext("2d");
    g.globalCompositeOperation = "source-over";
    g.fillStyle = "#050507"; g.fillRect(0, 0, W, H);
    if (!f.xy) return;
    var n = f.xy.length / 2, pad = 14 * dpr;
    var bw = W - 2 * pad, bh = H - 2 * pad, w = bw, h = bw / f.aspect;
    if (h > bh) { h = bh; w = bh * f.aspect; }
    var ox = (W - w) / 2, oy = (H - h) / 2;
    var spacing = Math.sqrt((w * h) / Math.max(1, n));
    var rad = Math.max(1.5 * dpr, Math.min(9 * dpr, spacing * 0.42));
    // Halos add up ("lighter"): dense maps get fainter ones, or they wash to white.
    var halo = Math.min(0.28, 0.28 * Math.pow(spacing / (rad * 4.2), 2)).toFixed(3);
    g.globalCompositeOperation = "lighter";
    for (var i = 0; i < n; i++) {
      var x = ox + f.xy[2 * i] * w, y = oy + f.xy[2 * i + 1] * h;
      var r, gg, b;
      if (f.rgb) { r = f.rgb[3 * i]; gg = f.rgb[3 * i + 1]; b = f.rgb[3 * i + 2]; } else { r = gg = b = 34; }
      if (r + gg + b < 6) continue;
      g.fillStyle = "rgba(" + r + "," + gg + "," + b + "," + halo + ")";
      g.beginPath(); g.arc(x, y, rad * 2.1, 0, 6.2832); g.fill();
      g.fillStyle = "rgb(" + r + "," + gg + "," + b + ")";
      g.beginPath(); g.arc(x, y, rad, 0, 6.2832); g.fill();
    }
  }
  function frame(ev) {
    var f = fixtures[ev.player];
    if (!f) return;
    var bin = atob(ev.rgb), a = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i);
    f.rgb = a;
    if (!f.queued) { f.queued = true; requestAnimationFrame(function () { f.queued = false; draw(f); }); }
  }
  window.addEventListener("resize", function () { for (var k in fixtures) draw(fixtures[k]); });

  // ---- events ---------------------------------------------------------------
  function handle(ev) {
    switch (ev.type) {
      case "reset":
        $("said").textContent = ""; $("reply").textContent = ""; $("think").textContent = ""; $("steps").innerHTML = "";
        code = { id: null, target: "", shown: 0, done: false, bad: {}, warn: {} };
        $("code").innerHTML = '<div class="empty">Ask for a look.<br>The code appears here as it is written.</div>';
        $("effName").textContent = "—"; $("compile").className = "badge"; $("compile").textContent = "waiting"; $("diag").textContent = "";
        status("", idleText);
        break;
      case "prompt":
        $("said").className = "said"; $("said").textContent = ev.text;
        $("reply").textContent = ""; $("think").textContent = ""; replyFresh = true;
        status("thinking", "Thinking…");
        break;
      case "thinking_start": status("thinking", "Thinking…"); $("think").textContent = ""; break;
      case "thinking": $("think").textContent = ($("think").textContent + ev.text).slice(-220); break;
      case "say_start":
        if (!replyFresh && $("reply").textContent) $("reply").textContent += " ";
        replyFresh = false; $("think").textContent = "";
        break;
      case "say": $("reply").textContent += ev.text; break;
      case "tool_writing":
        status("working", /compile_effect|deploy_effect|crossfade_to|preview_effect|estimate_effect/.test(ev.name) ? "Writing code…" : "Getting ready: " + (LABEL[ev.name] || ev.name).toLowerCase() + "…");
        break;
      case "code":
        if (code.id !== ev.id) {
          var same = ev.source.indexOf(code.target.slice(0, 40)) === 0 && code.target.length > 0;
          code.id = ev.id; code.bad = {}; code.warn = {};
          if (!same) code.shown = 0;
          $("compile").className = "badge busy"; $("compile").textContent = "writing"; $("diag").textContent = "";
        }
        code.target = ev.source; code.done = !!ev.done;
        if (code.shown > code.target.length) code.shown = code.target.length;
        $("effName").textContent = effectName(ev.source);
        renderCode();
        break;
      case "tool_call": {
        var el = addStep(ev.id, "", (LABEL[ev.name] || ev.name) + "<small>" + esc(ev.name) + "</small>");
        el.dataset.summary = summarize(ev.name, ev.args || {});
        el.querySelector(".sub").textContent = el.dataset.summary;
        status("working", (LABEL[ev.name] || ev.name) + "…");
        if (ev.name === "compile_effect") { $("compile").className = "badge busy"; $("compile").textContent = "compiling"; }
        break;
      }
      case "tool_progress": { var s = steps[ev.id]; if (s) s.querySelector(".sub").textContent = ev.text; break; }
      case "tool_result": {
        var st = steps[ev.id];
        if (st) {
          st.className = "step " + (ev.ok ? "ok" : "err");
          st.querySelector(".ms").textContent = ev.ms < 1000 ? ev.ms + " ms" : (ev.ms / 1000).toFixed(1) + " s";
          st.querySelector(".sub").textContent = ev.ok ? st.dataset.summary || "" : ev.text.slice(0, 220);
          if (ev.images && ev.images.length) {
            var pics = document.createElement("div"); pics.className = "pics";
            ev.images.slice(0, 4).forEach(function (im) { var i = new Image(); i.src = "data:" + im.mimeType + ";base64," + im.data; pics.appendChild(i); });
            st.appendChild(pics);
          }
        }
        if (ev.name === "compile_effect" || ((ev.name === "deploy_effect" || ev.name === "crossfade_to") && !ev.ok)) onCompiled(ev.text, ev.ok);
        if (ev.ok && (ev.name === "deploy_effect" || ev.name === "crossfade_to")) {
          flash((ev.name === "crossfade_to" ? "Crossfading ✦ " : "Deployed ✓ ") + $("effName").textContent);
          if ($("compile").textContent === "writing" || $("compile").textContent === "waiting") { $("compile").className = "badge ok"; $("compile").textContent = "on the lights"; }
        }
        if (ev.ok && ev.name === "rollback_effect") flash("Undone ↺");
        status("thinking", "Thinking…");
        break;
      }
      case "turn_end": status("", idleText); $("think").textContent = ""; break;
      case "stopped": status("", idleText); note("Stopped."); break;
      case "error": status("", idleText); note(ev.text, "err"); break;
      case "note": note(ev.text); break;
      case "twin_layout": layout(ev); break;
      case "twin_note": note(ev.player + ": " + ev.text); break;
    }
  }
  function connect() {
    var es = new EventSource("/events" + Q);
    es.addEventListener("open", function () { status("", idleText); });
    es.addEventListener("stage", function (m) { handle(JSON.parse(m.data)); });
    es.addEventListener("frame", function (m) { frame(JSON.parse(m.data)); });
    es.addEventListener("error", function () { status("", "Reconnecting…"); });
  }
  connect();

  // ---- voice ----------------------------------------------------------------
  var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  var rec = null, listening = false, finalText = "", sendOnEnd = false;
  if (!SR) { $("hint").innerHTML = "No speech recognition in this browser (use Chrome or Safari) · <kbd>Enter</kbd> to type"; }
  function startListening() {
    if (!SR || listening) return;
    finalText = ""; sendOnEnd = true;
    rec = new SR();
    rec.lang = navigator.language || "en-US";
    rec.continuous = true;
    rec.interimResults = true;
    rec.onresult = function (e) {
      var interim = "";
      finalText = "";
      for (var i = 0; i < e.results.length; i++) {
        if (e.results[i].isFinal) finalText += e.results[i][0].transcript;
        else interim += e.results[i][0].transcript;
      }
      $("said").className = "said interim";
      $("said").textContent = (finalText + " " + interim).trim();
    };
    rec.onerror = function (e) { if (e.error !== "aborted" && e.error !== "no-speech") note("Microphone: " + e.error, "err"); };
    rec.onend = function () {
      listening = false;
      var t = ($("said").textContent || "").trim();
      if (sendOnEnd && t) { post("/api/prompt", { text: t }); }
      else if (!t) status("", idleText);
    };
    try { rec.start(); listening = true; status("listening", "Listening…"); $("said").textContent = ""; $("reply").textContent = ""; }
    catch (err) { note("Microphone: " + err.message, "err"); }
  }
  function stopListening(send) {
    if (!rec || !listening) return;
    sendOnEnd = send;
    rec.stop();
  }
  var typing = false;
  function openType() { typing = true; $("typebox").classList.add("on"); $("typed").value = ""; $("typed").focus(); }
  function closeType() { typing = false; $("typebox").classList.remove("on"); $("typed").blur(); }
  $("typed").addEventListener("keydown", function (e) {
    if (e.key === "Enter") { var t = $("typed").value.trim(); closeType(); if (t) post("/api/prompt", { text: t }); e.preventDefault(); }
    else if (e.key === "Escape") { closeType(); e.preventDefault(); }
    e.stopPropagation();
  });
  var TOGGLE = { PageDown: 1, PageUp: 1, b: 1, B: 1, ".": 1 };
  document.addEventListener("keydown", function (e) {
    if (typing) return;
    if (e.code === "Space") { e.preventDefault(); if (!e.repeat) startListening(); }
    else if (TOGGLE[e.key]) { e.preventDefault(); if (e.repeat) return; if (listening) stopListening(true); else startListening(); }
    else if (e.key === "Enter") { e.preventDefault(); openType(); }
    else if (e.key === "Escape") { if (listening) stopListening(false); post("/api/stop"); }
  });
  document.addEventListener("keyup", function (e) { if (!typing && e.code === "Space") { e.preventDefault(); stopListening(true); } });

  // ---- buttons --------------------------------------------------------------
  $("resetBtn").onclick = function () { post("/api/reset"); this.blur(); };
  $("mapsBtn").onclick = function () { post("/api/maps"); note("Re-reading maps…"); this.blur(); };
  $("phoneBtn").onclick = function () {
    this.blur();
    var v = $("phone");
    if (v.srcObject) { v.srcObject.getTracks().forEach(function (t) { t.stop(); }); v.srcObject = null; $("app").classList.add("nophone"); return; }
    navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 30 }, audio: false }).then(function (s) {
      v.srcObject = s; $("app").classList.remove("nophone");
      s.getVideoTracks()[0].addEventListener("ended", function () { v.srcObject = null; $("app").classList.add("nophone"); });
    }).catch(function (err) { note("Phone: " + err.message, "err"); });
  };
  idleText = SR ? "Ready — hold Space to talk" : "Ready — press Enter to type";
})();
</script>
</body>
</html>
`;

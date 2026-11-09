/**
 * The stage page (one self-contained HTML document; the brand fonts come from
 * /brand/ on the same server): laid out for a 16:9 TV in the splanc.io style kit
 * (purple, yellow, black panels, thick outlines, offset shadows, Bangers).
 * Phone (a captured window: QuickTime's iPhone mirror) | the code being written
 * or explained | the conversation and every tool call, with a live twin of the
 * one or two fixtures in the spotlight along the bottom.
 *
 * The agent's replies are spoken (Web Speech synthesis; V toggles the voice).
 * An explain_code walkthrough plays step by step: each step's highlight is drawn
 * as its sentence starts, paced by the voice, or by reading time when it is off.
 *
 * Keys: hold Space to talk; a presenter clicker's Page Down / Page Up (or B)
 * toggles listening; Enter types a prompt instead; V voice on/off; Esc stops the
 * agent (and the voice).
 *
 * Kept free of backticks and dollar-brace so it can live in String.raw.
 */

import { LOGO_SVG } from "./brand";

const PAGE = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Splanc Stage</title>
<script src="https://cdn.jsdelivr.net/npm/qrcode-generator@1.4.4/qrcode.js" integrity="sha384-8FWZA6BGMXhsfO+BLtrJK0We6gg5o1JyO8xQm6peWDEUs17ACA5ziE/NIAkl9z2k" crossorigin="anonymous"></script>
<script type="importmap">{"imports":{"kokoro":"https://cdn.jsdelivr.net/npm/kokoro-js@1.2.1/dist/kokoro.web.js"},"integrity":{"https://cdn.jsdelivr.net/npm/kokoro-js@1.2.1/dist/kokoro.web.js":"sha384-suR1TeKe6Fe8fT0n/uTWoohnPJrp1zu3z0bj4VH2anmmq739wlmFSnMFJyMYszAC"}}</script>
<style>
@font-face { font-family: "Bangers"; src: url("/brand/bangers.woff2") format("woff2"); font-display: block; }
@font-face { font-family: "Inter"; src: url("/brand/inter-400.woff2") format("woff2"); font-weight: 400; font-display: swap; }
@font-face { font-family: "Inter"; src: url("/brand/inter-600.woff2") format("woff2"); font-weight: 600 800; font-display: swap; }
:root {
  --purple: #6a16a8;
  --purple-deep: #4a0e78;
  --yellow: #ffe600;
  --yellow-hot: #f2a12e;
  --black: #000;
  --ink: #111;
  --ink-2: #1a1a1a;
  --white: #fff;
  --gray: #777;
  --dim: #a3a3ad;
  --err: #ff4d5e;
  --pink: #ff5fa2;
  --cyan: #3fd8ff;
  --green: #5dfc8d;
  --display: "Bangers", "Anton", Impact, sans-serif;
  --body: "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  --mono: ui-monospace, "SF Mono", Menlo, "Fira Code", monospace;
  --gap: 1.3vw;
  --line: .2vw solid var(--black);
  --shadow: .42vw .42vw 0 var(--black);
  --shadow-sm: .22vw .22vw 0 var(--black);
  --snap: cubic-bezier(.2, .85, .25, 1);
  color-scheme: dark;
}
* { box-sizing: border-box; }
html, body { margin: 0; height: 100%; overflow: hidden; background: var(--purple); color: var(--white);
  font: 400 1.05vw/1.4 var(--body); -webkit-font-smoothing: antialiased; }
body::before { content: ""; position: fixed; inset: 0; pointer-events: none;
  background-image: radial-gradient(circle, rgba(0, 0, 0, .38) 1.1px, transparent 1.3px); background-size: 7px 7px;
  -webkit-mask-image: linear-gradient(115deg, #000 0%, transparent 38%, transparent 62%, #000 100%);
  mask-image: linear-gradient(115deg, #000 0%, transparent 38%, transparent 62%, #000 100%); }
.app { position: relative; height: 100vh; display: grid; gap: var(--gap); padding: var(--gap) calc(var(--gap) + .42vw) calc(var(--gap) + .42vw) var(--gap);
  grid-template-rows: auto 1fr auto; grid-template-columns: auto minmax(0, 1.25fr) minmax(0, 1fr);
  grid-template-areas: "top top top" "phone code talk" "phone twin twin"; }
.app.nophone { grid-template-columns: 0 minmax(0, 1.25fr) minmax(0, 1fr); column-gap: 0; }
.app.nophone .code { margin-right: var(--gap); }

/* header */
header { grid-area: top; display: flex; align-items: center; gap: 1.1vw; padding: .5vw 1vw; background: var(--ink);
  border: var(--line); border-radius: .8vw; box-shadow: var(--shadow); }
.mark { display: flex; align-items: center; gap: .8vw; }
.mark .logo { width: 2.8vw; height: 2.8vw; border: var(--line); border-radius: .65vw; overflow: hidden; display: block; }
.mark .logo svg { width: 100%; height: 100%; display: block; }
.mark .word { font: 400 2.3vw/1 var(--display); letter-spacing: .05em; text-transform: uppercase; }
.mark .live { font: 400 1.25vw/1 var(--display); letter-spacing: .06em; color: var(--black); background: var(--yellow);
  border: var(--line); padding: .2vw .55vw .1vw; transform: rotate(-6deg); box-shadow: var(--shadow-sm); margin-left: .2vw; }
.status { display: flex; align-items: center; gap: .6vw; padding: .4vw 1vw .3vw; border-radius: .5vw; background: var(--ink-2);
  border: var(--line); color: var(--dim); font: 400 1.3vw/1 var(--display); letter-spacing: .07em; text-transform: uppercase;
  transition: transform .15s var(--snap); }
.status i { width: .75vw; height: .75vw; border-radius: 50%; background: var(--gray); margin-top: -.15vw; }
.status.listening { color: var(--black); background: var(--yellow); transform: rotate(-2deg) scale(1.06); box-shadow: var(--shadow-sm); }
.status.listening i { background: var(--err); animation: pulse .9s infinite; }
.status.thinking, .status.working, .status.speaking { color: var(--white); }
.status.thinking i, .status.working i { background: var(--yellow); animation: pulse 1.1s infinite; }
.status.speaking i { background: var(--yellow); animation: talk .5s infinite alternate; border-radius: .2vw; }
@keyframes pulse { 50% { opacity: .2; } }
@keyframes talk { from { transform: scaleY(.45); } to { transform: scaleY(1.3); } }
.hint { margin-left: auto; color: var(--dim); font-size: .85vw; }
.hint kbd { font: 600 .8vw var(--body); color: var(--white); background: var(--ink-2); border: .12vw solid #333; border-bottom-width: .22vw;
  border-radius: .3vw; padding: 0 .35vw; }
.btn { background: var(--black); color: var(--white); border: .15vw solid #333; border-radius: .5vw; padding: .35vw .9vw .25vw;
  font: 400 1.15vw/1.1 var(--display); letter-spacing: .06em; text-transform: uppercase; cursor: pointer;
  transition: transform .12s var(--snap), box-shadow .12s var(--snap); }
.btn:hover { transform: translate(-.1vw, -.1vw) rotate(-1deg); }
.btn.on { background: var(--yellow); color: var(--black); border-color: var(--black); box-shadow: var(--shadow-sm); }

/* panels */
.panel { background: var(--ink); border: var(--line); border-radius: .8vw; box-shadow: var(--shadow); min-height: 0; min-width: 0;
  display: flex; flex-direction: column; overflow: hidden; }
.ph { display: flex; align-items: baseline; gap: .8vw; padding: .65vw 1.1vw .45vw; border-bottom: .15vw solid var(--black);
  background: var(--black); font: 400 1.45vw/1.1 var(--display); letter-spacing: .07em; text-transform: uppercase; color: var(--yellow); }
.ph b { color: var(--white); font: 600 1.1vw var(--body); text-transform: none; letter-spacing: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.badge { margin-left: auto; align-self: center; padding: .2vw .6vw .1vw; border-radius: .35vw; border: .15vw solid #333; color: var(--dim);
  font: 400 1.05vw/1.1 var(--display); letter-spacing: .06em; white-space: nowrap; }
.badge.ok { color: var(--black); background: var(--yellow); border-color: var(--black); }
.badge.err { color: var(--white); background: var(--err); border-color: var(--black); }
.badge.busy { color: var(--yellow); border-color: var(--yellow); }

/* phone */
.phone { grid-area: phone; width: 22vw; display: flex; align-items: center; justify-content: center; }
.nophone .phone { display: none; }
.phone video { max-height: 100%; max-width: 100%; border-radius: 2.2vw; border: .55vw solid var(--black); box-shadow: var(--shadow); background: #000; }

/* code */
.code { grid-area: code; }
pre { position: relative; margin: 0; flex: 1; overflow: hidden; padding: 1vw 1.2vw 30vh; counter-reset: ln;
  font: 400 1.02vw/1.55 var(--mono); color: #e8e8ee; }
pre .l { display: block; white-space: pre-wrap; padding-left: 3.4vw; text-indent: -3.4vw; transition: background .25s, box-shadow .25s; }
pre .l::before { counter-increment: ln; content: counter(ln); display: inline-block; width: 2.4vw; margin-right: 1vw;
  text-align: right; color: #55555e; text-indent: 0; }
pre .l.bad { background: #ff4d5e26; box-shadow: inset .3vw 0 var(--err); }
pre .l.warnl { background: #f2a12e1c; box-shadow: inset .3vw 0 var(--yellow-hot); }
.kw { color: var(--yellow); } .ty { color: #c8a6ff; } .nu { color: var(--yellow-hot); } .fn { color: #7fe7ff; } .co { color: #7a7a86; font-style: italic; }
.caret { display: inline-block; width: .55vw; height: 1.15vw; background: var(--yellow); vertical-align: -.15vw; animation: pulse .8s infinite; }
/* marks: c-* sets the colour, mk-* the shape */
.c-yellow { --mk: var(--yellow); --mkbg: #ffe6002b; } .c-pink { --mk: var(--pink); --mkbg: #ff5fa22e; }
.c-cyan { --mk: var(--cyan); --mkbg: #3fd8ff2b; } .c-green { --mk: var(--green); --mkbg: #5dfc8d26; }
pre .l.mk-band { background: var(--mkbg); box-shadow: inset .32vw 0 var(--mk); }
pre .l.mk-box { box-shadow: inset .2vw 0 var(--mk), inset -.2vw 0 var(--mk); background: #ffffff08; }
pre .l.mk-box.top { box-shadow: inset .2vw 0 var(--mk), inset -.2vw 0 var(--mk), inset 0 .2vw var(--mk); }
pre .l.mk-box.bot { box-shadow: inset .2vw 0 var(--mk), inset -.2vw 0 var(--mk), inset 0 -.2vw var(--mk); }
pre .l.mk-box.top.bot { box-shadow: inset 0 0 0 .2vw var(--mk); }
pre mark { color: inherit; background: var(--mkbg); border-radius: .2vw; text-decoration: underline wavy var(--mk);
  text-decoration-thickness: .14vw; text-underline-offset: .32vw; animation: ink .35s var(--snap); }
@keyframes ink { from { background: transparent; text-decoration-color: transparent; } }
.callout { display: block; width: max-content; max-width: 88%; margin: .5vw 0 .7vw 3.2vw; padding: .35vw .8vw .2vw; position: relative;
  font: 400 1.35vw/1.15 var(--display); letter-spacing: .05em; text-transform: uppercase; white-space: normal; text-indent: 0;
  color: var(--black); background: var(--mk); border: var(--line); border-radius: .3vw; box-shadow: var(--shadow-sm);
  transform: rotate(-1.2deg); animation: pop .35s var(--snap); }
.callout::before { content: ""; position: absolute; left: 1.2vw; top: -.85vw; border: .45vw solid transparent;
  border-bottom: .55vw solid var(--black); }
.callout::after { content: ""; position: absolute; left: 1.32vw; top: -.5vw; border: .33vw solid transparent;
  border-bottom: .4vw solid var(--mk); }
@keyframes pop { from { transform: scale(.4) rotate(-8deg); opacity: 0; } 70% { transform: scale(1.06) rotate(-.5deg); } }
.diag { padding: .6vw 1.2vw; border-top: .15vw solid var(--black); font: 400 .95vw/1.4 var(--mono); color: var(--err); max-height: 22%; overflow: hidden; background: #160809; }
.diag.warn { color: var(--yellow-hot); background: #161008; }
.diag:empty { display: none; }
.empty { margin: auto; padding: 2vw; text-align: center; color: var(--dim); font-size: 1.1vw; }
.empty b { display: block; color: var(--yellow); font: 400 2.6vw/1.1 var(--display); letter-spacing: .05em; transform: rotate(-2deg); margin-bottom: .6vw; }

/* talk */
.talk { grid-area: talk; }
.conv { padding: 1.3vw 1.4vw .4vw; display: flex; flex-direction: column; gap: 1vw; min-height: 0; flex: 0 1 auto; overflow: hidden; }
.said { position: relative; align-self: flex-start; max-width: 100%; padding: .7vw 1.1vw; margin-bottom: .8vw; background: var(--white); color: var(--black);
  border: var(--line); border-radius: 1.2vw; box-shadow: var(--shadow-sm); font: 700 1.5vw/1.28 var(--body); }
.said::before, .said::after { content: ""; position: absolute; border-style: solid; border-color: transparent; }
.said::before { left: 1.7vw; bottom: -1.35vw; border-width: 1.35vw 1.1vw 0 0; border-top-color: var(--black); }
.said::after { left: 1.98vw; bottom: -.82vw; border-width: .85vw .68vw 0 0; border-top-color: var(--white); }
.said.interim { color: #6a6a74; }
.said:empty { display: none; }
.reply { position: relative; font-size: 1.45vw; line-height: 1.4; color: var(--white); max-height: 46vh; overflow: hidden; }
.reply .next { color: #6d6d78; }
.reply:empty { display: none; }
.think { font-size: .95vw; color: var(--gray); font-style: italic; max-height: 3.2em; overflow: hidden; }
.think:empty { display: none; }
.steps { flex: 1; min-height: 0; overflow: hidden; display: flex; flex-direction: column; justify-content: flex-end; gap: .45vw; padding: .6vw 1.1vw 1vw; }
.step { display: grid; grid-template-columns: 1.4vw 1fr auto; gap: .2vw .7vw; align-items: center; padding: .45vw .8vw;
  border-radius: .5vw; background: var(--ink-2); border: .15vw solid var(--black); animation: in .25s var(--snap); }
@keyframes in { from { opacity: 0; transform: translateY(.6vw) rotate(.6deg); } }
.step .ic { width: 1.05vw; height: 1.05vw; border-radius: 50%; border: .2vw solid var(--yellow); border-top-color: transparent; animation: spin .7s linear infinite; }
.step.ok .ic { border: none; background: var(--yellow); animation: none; position: relative; }
.step.ok .ic::after { content: ""; position: absolute; left: .34vw; top: .18vw; width: .25vw; height: .48vw; border: solid var(--black); border-width: 0 .14vw .14vw 0; transform: rotate(45deg); }
.step.err .ic { border: none; background: var(--err); animation: none; }
@keyframes spin { to { transform: rotate(1turn); } }
.step .nm { font: 400 1.25vw/1.1 var(--display); letter-spacing: .05em; text-transform: uppercase; }
.step .nm small { color: var(--gray); font: 400 .8vw var(--mono); text-transform: none; letter-spacing: 0; margin-left: .5vw; }
.step .ms { color: var(--gray); font-size: .9vw; font-variant-numeric: tabular-nums; }
.step .sub { grid-column: 2 / 4; color: var(--dim); font-size: .9vw; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.step.err .sub { color: var(--err); white-space: normal; max-height: 2.8em; }
.step .pics { grid-column: 2 / 4; display: flex; gap: .4vw; }
.step .pics img { height: 4.2vw; border-radius: .3vw; border: .12vw solid var(--black); background: #000; }
.step.note { grid-template-columns: 1fr; color: var(--dim); font-size: .95vw; }
.step.note.err { color: var(--err); }

/* twin */
.twin { grid-area: twin; height: 34vh; }
.fixtures { flex: 1; display: flex; gap: var(--gap); padding: .8vw 1.1vw 1vw; min-height: 0; }
.fx { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: .4vw; animation: in .3s var(--snap); }
.fx .nm { display: flex; align-items: baseline; gap: .6vw; font-size: .95vw; color: var(--dim); }
.fx .nm b { color: var(--white); font: 400 1.35vw/1 var(--display); letter-spacing: .06em; text-transform: uppercase; }
.fx canvas { flex: 1; min-height: 0; width: 100%; border-radius: .5vw; background: #000; border: .15vw solid var(--black); }

/* deploy burst */
.flash { position: fixed; left: 50%; top: 45%; width: 30vw; height: 19vw; transform: translate(-50%, -50%) scale(.3) rotate(-14deg);
  opacity: 0; pointer-events: none; transition: transform .28s var(--snap), opacity .2s; filter: drop-shadow(.5vw .5vw 0 #000); }
.flash.on { opacity: 1; transform: translate(-50%, -50%) scale(1) rotate(-5deg); }
.flash .burst { position: absolute; inset: 0; background: var(--black); }
.flash .burst.in { inset: .55vw; background: var(--yellow); }
.flash .txt { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; color: var(--black); text-align: center; }
.flash .big { font: 400 4.2vw/1 var(--display); letter-spacing: .04em; }
.flash .small { font: 700 1.05vw/1.2 var(--body); max-width: 16vw; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.phone iframe { width: 100%; height: 100%; border: .55vw solid var(--black); border-radius: 2.2vw; box-shadow: var(--shadow); background: #000; }
.phone [hidden] { display: none; }
/* F: the phone fills the stage below the header (the status and voice stay in view). */
.app.phonebig .phone { position: fixed; top: 10.5vh; bottom: 2.5vh; left: 2vw; right: 2vw; width: auto; z-index: 15;
  background: rgba(20, 0, 40, .88); border-radius: 1.2vw; padding: 1vh 1vw; }
.app.phonebig .phone video { max-height: 100%; max-width: 100%; }
.pair { position: fixed; inset: 0; background: rgba(20, 0, 40, .72); display: flex; align-items: center; justify-content: center; z-index: 20; }
.pair[hidden] { display: none; }
.pair .card { background: var(--white); color: var(--black); border: var(--line); border-radius: 1.2vw; box-shadow: var(--shadow); padding: 1.6vw 2vw; display: flex; gap: 2vw; align-items: center; max-width: 60vw; }
.pair h2 { font: 400 2.6vw/1 var(--display); letter-spacing: .04em; margin: 0 0 .8vw; }
.pair p { font: 500 1.05vw/1.4 var(--body); margin: 0 0 .6vw; }
.pair .qr svg { width: 16vw; height: 16vw; display: block; }
.pair .url { font: 600 .9vw var(--body); word-break: break-all; color: #888; }
.pair .url span { display: block; cursor: pointer; }
.pair .url span.sel { color: var(--purple); }
.pair .row { display: flex; gap: .6vw; flex-wrap: wrap; margin-top: 1vw; }
.pair .btn { font-size: 1vw; }
.typebox { position: fixed; left: 50%; bottom: 31vh; transform: translateX(-50%); width: 50vw; display: none; }
.typebox.on { display: block; }
.typebox input { width: 100%; font: 600 1.5vw var(--body); padding: .9vw 1.2vw; border-radius: .8vw;
  border: var(--line); background: var(--white); color: var(--black); outline: none; box-shadow: var(--shadow); }
</style>
</head>
<body>
<div class="app nophone" id="app">
  <header>
    <div class="mark"><span class="logo">@@LOGO@@</span><span class="word">Splanc</span><span class="live">Live!</span></div>
    <div class="status" id="status"><i></i><span id="statusText">Connecting…</span></div>
    <div class="hint" id="hint">Hold <kbd>Space</kbd> to talk · <kbd>Enter</kbd> type · <kbd>V</kbd> voice · <kbd>F</kbd> phone · <kbd>G</kbd> grid · <kbd>Esc</kbd> stop</div>
    <button class="btn" id="voiceBtn" title="Speak replies aloud (V)">Voice</button>
    <button class="btn" id="phoneBtn" title="Put the phone's screen (ScreenStream) or a window in the phone slot">Phone</button>
    <button class="btn" id="mapsBtn" title="Re-read the fixtures' maps (after mapping in the app)">Maps</button>
    <button class="btn" id="resetBtn" title="Start a new conversation">New</button>
  </header>
  <div class="phone"><video id="phone" autoplay muted playsinline hidden></video><iframe id="phoneFrame" title="Phone" allow="fullscreen; autoplay" hidden></iframe></div>
  <section class="panel code">
    <div class="ph">Effect <b id="effName"></b><span class="badge" id="compile">waiting</span></div>
    <pre id="code"></pre>
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
    <div class="ph">Live preview <b id="fxCount"></b><span class="badge">device VM · real map</span></div>
    <div class="fixtures" id="fixtures"><div class="empty" id="noFx">Looking for fixtures…</div></div>
  </section>
</div>
<div class="flash" id="flash"><div class="burst"></div><div class="burst in"></div><div class="txt"><div class="big" id="flashBig"></div><div class="small" id="flashSmall"></div></div></div>
<div class="pair" id="pair" hidden><div class="card">
  <div class="qr" id="pairQr"></div>
  <div>
    <h2>Put your phone on screen</h2>
    <p>Start ScreenStream on the phone, then scan this code with the phone's camera and tap <b>Show on the TV</b>.</p>
    <p class="url" id="pairUrl"></p>
    <p id="pairState"></p>
    <div class="row">
      <button class="btn" id="pairTrust" hidden>Trust the phone's certificate</button>
      <button class="btn" id="pairCapture">Capture a window instead</button>
      <button class="btn" id="pairHide" hidden>Hide the phone</button>
      <button class="btn" id="pairClose">Close</button>
    </div>
  </div>
</div></div>
<div class="typebox" id="typebox"><input id="typed" placeholder="Type a prompt and press Enter" autocomplete="off"></div>
<script src="/stage/view.js"></script>
<script>
(function () {
  "use strict";
  var PARAMS = new URLSearchParams(location.search);
  var KEY = PARAMS.get("k") || "";
  var Q = KEY ? "?k=" + encodeURIComponent(KEY) : "";
  var $ = function (id) { return document.getElementById(id); };
  var LABEL = {
    list_players: "Find fixtures", refresh_players: "Look for fixtures", identify_player: "Blink fixtures",
    export_map: "Read map", plot_fixture: "Plot fixture", set_brightness: "Brightness",
    list_uniforms: "Read knobs", set_uniforms: "Turn knobs", ramp_uniforms: "Glide knobs",
    list_keypoints: "Saved looks", recall_keypoint: "Recall look", blend_keypoints: "Blend looks", get_keypoint: "Read look",
    read_sensors: "Read sensor", compile_effect: "Compile", estimate_effect: "Estimate cost", preview_effect: "Preview",
    deploy_effect: "Deploy", set_effect: "Switch effect", rollback_effect: "Undo", crossfade_to: "Crossfade",
    list_decks: "Decks", list_textures: "Textures", search_effects: "Search library", get_effect: "Open library effect",
    show_code: "Open code", explain_code: "Explain", show_fixtures: "Show fixtures"
  };
  var EMPTY_CODE = '<div class="empty"><b>Ask for a look!</b>The code appears here as it is written.</div>';
  function post(path, body) {
    return fetch(path + Q, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}) });
  }
  function store(k, v) { try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch (e) { /* private window */ } return null; }

  // ---- status ---------------------------------------------------------------
  var idleText = "Ready";
  var statusKind = "";
  function status(kind, text) {
    statusKind = kind || "";
    $("status").className = "status " + statusKind;
    $("statusText").textContent = text;
  }
  var turnActive = false;
  function idle() {
    if (player.busy || player.q.length) status("speaking", "Speaking…");
    else if (turnActive) status("thinking", "Thinking…");
    else status("", idleText);
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
  function freshCode() { return { id: null, target: "", shown: 0, done: false, bad: {}, warn: {}, marks: [] }; }
  var code = freshCode();
  function lineHtml(l, n) {
    var u = null;
    code.marks.forEach(function (m) { if (m.span && m.from === n && (m.style === "underline" || m.style === "band" || m.style === "box")) u = m; });
    if (!u || u.span[0] >= l.length) return hl(l) || " ";
    var a = u.span[0], b = Math.min(l.length, u.span[1]);
    return hl(l.slice(0, a)) + '<mark class="c-' + u.color + '">' + hl(l.slice(a, b)) + "</mark>" + hl(l.slice(b));
  }
  function renderCode(scrollToMarks) {
    var pre = $("code");
    if (!code.target) { pre.innerHTML = EMPTY_CODE; return; }
    var text = code.target.slice(0, code.shown);
    if (code.done && code.shown >= code.target.length) text = text.replace(/\s+$/, "");
    var lines = text.split("\n");
    var html = lines.map(function (l, i) {
      var n = i + 1, cls = code.bad[n] ? " bad" : code.warn[n] ? " warnl" : "", after = "";
      code.marks.forEach(function (m) {
        if (n < m.from || n > m.to) return;
        if (m.style === "band" && !(m.span && m.from === m.to)) cls += " mk-band c-" + m.color;
        else if (m.style === "box") cls += " mk-box c-" + m.color + (n === m.from ? " top" : "") + (n === m.to ? " bot" : "");
        if (n === m.to && m.note) after += '<span class="callout c-' + m.color + '">' + esc(m.note) + "</span>";
      });
      return '<span class="l' + cls + '" data-n="' + n + '">' + lineHtml(l, n) + (i === lines.length - 1 && !code.done ? '<span class="caret"></span>' : "") + "</span>" + after;
    }).join("");
    pre.innerHTML = html;
    // Follow the cursor while writing; bring marks into view when explaining.
    var caret = pre.querySelector(".caret");
    if (caret) { var over = caret.offsetTop - pre.clientHeight * 0.75; pre.scrollTop = over > 0 ? over : 0; return; }
    if (scrollToMarks && code.marks.length) {
      var m = code.marks[code.marks.length - 1];
      var first = pre.querySelector('[data-n="' + m.from + '"]'), last = pre.querySelector('[data-n="' + m.to + '"]');
      if (!first || !last) return;
      var bottom = last.offsetTop + last.offsetHeight + (m.note ? last.offsetHeight * 2.4 : 0);
      var mid = (first.offsetTop + bottom) / 2;
      var top = Math.max(0, Math.min(first.offsetTop - pre.clientHeight * 0.12, mid - pre.clientHeight * 0.42));
      pre.scrollTo({ top: top, behavior: "smooth" });
    }
  }
  setInterval(function () {
    if (code.shown >= code.target.length) return;
    var behind = code.target.length - code.shown;
    code.shown += Math.max(3, Math.ceil(behind / 12));
    if (code.shown > code.target.length) code.shown = code.target.length;
    renderCode(false);
  }, 30);
  function effectName(src) {
    var m = /^\s*\/\/\s*(.+)$/m.exec(src);
    return m ? m[1].slice(0, 60) : "untitled";
  }
  function applyMark(ev) {
    if (!ev.keep) code.marks = [];
    if (ev.mark) code.marks.push(ev.mark);
    renderCode(true);
  }

  // ---- reply + voice --------------------------------------------------------
  // The reply is one text; the part already spoken (or read) is bright.
  var reply = { text: "", pos: 0, queued: 0 };
  function renderReply() {
    var el = $("reply");
    if (!reply.text) { el.innerHTML = ""; return; }
    var p = Math.min(reply.pos, reply.text.length);
    el.innerHTML = esc(reply.text.slice(0, p)) + '<i id="at"></i><span class="next">' + esc(reply.text.slice(p)) + "</span>";
    var at = $("at"), over = at.offsetTop - el.clientHeight * 0.6;
    el.scrollTop = over > 0 ? over : 0;
  }
  function addReply(t, sep) {
    if (sep && reply.text && !/\s$/.test(reply.text)) reply.text += " ";
    reply.text += t;
  }
  var synth = window.speechSynthesis;
  var voiceOn = false;
  function setVoice(on) {
    voiceOn = canSpeak && on;
    store("stage.voice", voiceOn ? "on" : "off");
    $("voiceBtn").classList.toggle("on", voiceOn);
    $("voiceBtn").textContent = voiceOn ? "Voice on" : "Voice off";
    if (!voiceOn) stopAudio();
  }

  // The neural voice: Kokoro in the browser (?tts=system for the system voice;
  // ?voice=af_bella etc. picks a Kokoro voice). Until it has loaded, or if it
  // can't, the system voice speaks.
  var KOKORO_VOICE = /^[ab][fm]_[a-z]+$/;
  var tts = window.stageTts = {
    wantKokoro: PARAMS.get("tts") !== "system" && !!(window.AudioContext || window.webkitAudioContext),
    lib: null, loading: false, failed: false, model: null, ctx: null, src: null, chain: Promise.resolve(),
    voice: KOKORO_VOICE.test((PARAMS.get("voice") || "").toLowerCase()) ? PARAMS.get("voice").toLowerCase() : "af_heart",
    speed: parseFloat(PARAMS.get("rate") || "1") || 1,
    // Only the tab that speaks loads the model (one copy in memory).
    load: function () {
      var Kokoro = tts.lib;
      if (!Kokoro || tts.loading || tts.failed || !ownsVoice()) return;
      tts.loading = true;
      var id = "onnx-community/Kokoro-82M-v1.0-ONNX", gpu = false;
      note("Loading the voice…");
      // WebGPU when there is a real adapter (Chrome on a Mac), else WASM on the CPU.
      var adapter = navigator.gpu ? navigator.gpu.requestAdapter().catch(function () { return null; }) : Promise.resolve(null);
      adapter.then(function (a) {
        gpu = !!a;
        return Kokoro.from_pretrained(id, gpu ? { dtype: "fp32", device: "webgpu" } : { dtype: "q8", device: "wasm" });
      }).then(function (m) {
        tts.model = m;
        note("Voice ready: " + tts.voice + (gpu ? "" : " (no WebGPU: slower)") + ".");
      }, tts.fail);
    },
    fail: function (e) { tts.failed = true; note("Using the system voice (the neural voice didn't load: " + ((e && e.message) || e) + ").", "err"); },
    // Synthesize in order (one model at a time); resolves to an AudioBuffer.
    make: function (text) {
      var p = tts.chain.then(function () { return tts.model.generate(text, { voice: tts.voice, speed: tts.speed }); }).then(function (a) {
        var b = audioCtx().createBuffer(1, a.audio.length, a.sampling_rate);
        b.copyToChannel(a.audio, 0);
        return b;
      });
      tts.chain = p.catch(function () {});
      return p;
    }
  };
  var canSpeak = !!synth || tts.wantKokoro;
  voiceOn = canSpeak && store("stage.voice") !== "off";
  function audioCtx() { if (!tts.ctx) tts.ctx = new (window.AudioContext || window.webkitAudioContext)(); return tts.ctx; }
  function stopAudio() {
    if (synth) synth.cancel();
    if (tts.src) { try { tts.src.stop(); } catch (e) { /* not started */ } tts.src = null; }
  }

  // One voice per browser: with the stage open in two tabs (the one it opened
  // plus one on the TV), only the tab used last speaks; the others stay quiet.
  var TAB = Math.random().toString(36).slice(2);
  function voiceOwner() { try { return JSON.parse(localStorage.getItem("stage.voiceOwner") || "null"); } catch (e) { return null; } }
  function claimVoice() { try { localStorage.setItem("stage.voiceOwner", JSON.stringify({ id: TAB, t: Date.now() })); } catch (e) { /* private window */ } }
  function ownsVoice() { var o = voiceOwner(); return !o || o.id === TAB || Date.now() - o.t > 6000; }
  if (ownsVoice()) claimVoice();
  setInterval(function () { if (ownsVoice()) { claimVoice(); tts.load(); } }, 2000);
  ["keydown", "pointerdown"].forEach(function (k) {
    document.addEventListener(k, function () {
      claimVoice();
      if (tts.wantKokoro) { var c = audioCtx(); if (c.state === "suspended") c.resume(); tts.load(); }
    }, true);
  });
  var BAD_VOICE = /Albert|Bad News|Bahh|Bells|Boing|Bubbles|Cellos|Good News|Jester|Organ|Superstar|Trinoids|Whisper|Wobble|Zarvox|Fred|Junior|Ralph|Kathy|Grandma|Grandpa|Eddy|Flo|Reed|Rocko|Sandy|Shelley/;
  function pickVoice() {
    var vs = synth ? synth.getVoices() : [];
    if (!vs.length) return null;
    var want = (PARAMS.get("voice") || "").toLowerCase();
    if (want) { for (var i = 0; i < vs.length; i++) if (vs[i].name.toLowerCase().indexOf(want) >= 0) return vs[i]; }
    var lang = (navigator.language || "en-US").slice(0, 2);
    var best = null, bestScore = -99;
    vs.forEach(function (v) {
      var s = (v.lang || "").slice(0, 2) === lang ? 10 : 0;
      if ((v.lang || "") === navigator.language) s += 2;
      if (/premium|enhanced|neural|natural/i.test(v.name)) s += 5;
      if (/^(Samantha|Daniel|Karen|Moira|Ava|Zoe|Evan|Allison|Tom|Serena|Google US English|Google UK English)/.test(v.name)) s += 3;
      if (v.localService) s += 1;
      if (BAD_VOICE.test(v.name)) s -= 30;
      if (s > bestScore) { bestScore = s; best = v; }
    });
    return best;
  }
  var RATE = parseFloat(PARAMS.get("rate") || "1.05") || 1.05;
  // The playback queue: spoken chunks of the reply and walkthrough steps, in order.
  var player = { q: [], busy: false, timer: 0, done: null };
  var live = false;
  function enqueue(item) {
    // Start synthesizing now, so the clip is ready when its turn comes.
    if (voiceOn && live && tts.model && ownsVoice()) {
      var w = reply.text.slice(item.start, item.end).trim();
      if (w) item.audio = tts.make(w);
    }
    player.q.push(item); pump();
  }
  function pump() {
    if (player.busy) return;
    var it = player.q.shift();
    if (!it) { if (statusKind === "speaking") idle(); return; }
    player.busy = true;
    if (it.act) it.act();
    var chunk = reply.text.slice(it.start, it.end), lead = chunk.length - chunk.replace(/^\s+/, "").length, words = chunk.trim();
    var finished = false;
    var done = player.done = function () {
      if (finished) return; finished = true;
      clearTimeout(player.timer);
      reply.pos = Math.max(reply.pos, it.end); renderReply();
      player.busy = false; player.done = null;
      pump();
    };
    if (voiceOn && words && live && ownsVoice() && tts.model) {
      if (statusKind === "") status("speaking", "Speaking…");
      var made = it.audio || tts.make(words);
      player.timer = setTimeout(done, 30000 + words.length * 200); // synthesis stalled
      made.then(function (buf) {
        if (finished) return;
        clearTimeout(player.timer);
        var c = audioCtx(), s = c.createBufferSource();
        s.buffer = buf; s.connect(c.destination);
        tts.src = s;
        s.onended = function () { if (tts.src === s) tts.src = null; done(); };
        var t0 = c.currentTime;
        // Light the words up across the clip (Kokoro gives no word timings).
        (function glow() {
          if (finished) return;
          var f = Math.min(1, (c.currentTime - t0) / buf.duration);
          reply.pos = Math.max(reply.pos, it.start + lead + Math.round(words.length * f)); renderReply();
          if (f < 1) requestAnimationFrame(glow);
        })();
        s.start();
        player.timer = setTimeout(done, buf.duration * 1000 + 3000); // a suspended audio context never ends
      }, function () { if (!finished) done(); });
    } else if (voiceOn && words && live && ownsVoice() && synth) {
      if (statusKind === "") status("speaking", "Speaking…");
      var u = new SpeechSynthesisUtterance(words);
      var v = pickVoice(); if (v) { u.voice = v; u.lang = v.lang; }
      u.rate = RATE;
      u.onend = done; u.onerror = done;
      u.onboundary = function (e) {
        if (typeof e.charIndex !== "number") return;
        reply.pos = Math.max(reply.pos, it.start + lead + e.charIndex + (e.charLength || 0)); renderReply();
      };
      player.timer = setTimeout(done, 3000 + words.length * 120); // some engines drop onend
      synth.resume();
      synth.speak(u);
    } else if (it.pace && words && live) {
      reply.pos = Math.max(reply.pos, it.end); renderReply();
      player.timer = setTimeout(done, Math.min(9000, 700 + words.length * 62));
    } else done();
  }
  // Jump to the end: every pending highlight drawn, all the text bright.
  function flushPlayback() {
    stopAudio();
    var q = player.q; player.q = [];
    if (player.done) player.done();
    q.forEach(function (it) { if (it.act) it.act(); });
    player.q = []; player.busy = false;
    reply.pos = reply.queued = reply.text.length; renderReply();
  }
  // Queue the reply text written since last time: whole sentences while the
  // voice is on (so it speaks naturally), everything when it is off.
  function queueText(all) {
    var rest = reply.text.slice(reply.queued);
    if (!rest) return;
    var cut = rest.length;
    if (voiceOn && !all) {
      var m, re = /[.!?…:;](?=\s)|\n/g, last = -1;
      while ((m = re.exec(rest)) !== null) last = m.index + 1;
      if (last < 0) return;
      cut = last;
    }
    var it = { start: reply.queued, end: reply.queued + cut };
    reply.queued += cut;
    enqueue(it);
  }

  // ---- conversation + steps -------------------------------------------------
  var steps = {};
  function trimSteps() { while ($("steps").children.length > 8) $("steps").removeChild($("steps").firstChild); }
  function addStep(id, cls, nameHtml) {
    var el = document.createElement("div");
    el.className = "step " + cls;
    el.innerHTML = '<div class="ic"></div><div class="nm">' + nameHtml + '</div><div class="ms"></div><div class="sub"></div>';
    $("steps").appendChild(el); trimSteps();
    if (id) steps[id] = el;
    return el;
  }
  function note(text, cls) {
    var el = document.createElement("div");
    el.className = "step note " + (cls || "");
    el.textContent = text;
    $("steps").appendChild(el); trimSteps();
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
  function badge(cls, text) { $("compile").className = "badge " + cls; $("compile").textContent = text; }
  function onCompiled(text, okCall) {
    var j = null;
    try { j = JSON.parse(text); } catch (e) { /* plain error text */ }
    var c = findCompile(j);
    code.bad = {}; code.warn = {};
    var diag = $("diag");
    diag.className = "diag"; diag.textContent = "";
    if (!c) {
      badge(okCall ? "ok" : "err", okCall ? "compiled" : "failed");
      if (!okCall) diag.textContent = text.slice(0, 300);
      renderCode(false);
      return;
    }
    if (!c.ok) {
      (c.diagnostics || []).forEach(function (d) { code.bad[d.line] = 1; });
      diag.textContent = (c.diagnostics || []).slice(0, 3).map(function (d) { return d.line + ":" + d.col + "  " + d.msg; }).join("\n");
      badge("err", "compile error");
    } else {
      var w = c.warnings || [];
      w.forEach(function (d) { code.warn[d.line] = 1; });
      if (w.length) { diag.className = "diag warn"; diag.textContent = w.slice(0, 2).map(function (d) { return d.line + ":" + d.col + "  " + d.msg; }).join("\n"); }
      var knobs = (c.uniforms || []).length;
      badge("ok", "compiled · " + c.bytecode_bytes + " B · " + knobs + " knob" + (knobs === 1 ? "" : "s"));
    }
    renderCode(false);
  }
  // The deploy burst: a jagged comic star.
  (function () {
    var pts = [], n = 22;
    for (var i = 0; i < n * 2; i++) {
      var a = (i / (n * 2)) * Math.PI * 2, r = i % 2 ? 36 + (i * 7 % 5) : 50;
      pts.push((50 + Math.cos(a) * r).toFixed(1) + "% " + (50 + Math.sin(a) * r).toFixed(1) + "%");
    }
    var poly = "polygon(" + pts.join(",") + ")";
    Array.prototype.forEach.call(document.querySelectorAll(".burst"), function (b) { b.style.clipPath = poly; b.style.webkitClipPath = poly; });
  })();
  var flashTimer = 0;
  function flash(big, small) {
    if (!live) return;
    $("flashBig").textContent = big; $("flashSmall").textContent = small || "";
    $("flash").classList.add("on");
    clearTimeout(flashTimer);
    flashTimer = setTimeout(function () { $("flash").classList.remove("on"); }, 1700);
  }
  var replyFresh = false;

  // ---- twin -----------------------------------------------------------------
  // Layouts for every fixture seen; the strip shows the spotlight (newest first).
  var shapes = {}, focus = [], fixtures = {};
  function renderStrip() {
    var known = Object.keys(shapes).length;
    $("fxCount").textContent = known > focus.length ? focus.length + " of " + known + " fixtures" : "";
    if (!focus.length) return;
    if ($("noFx")) $("noFx").remove();
    var box = $("fixtures");
    Object.keys(fixtures).forEach(function (id) {
      if (focus.indexOf(id) >= 0) return;
      if (fixtures[id].view) fixtures[id].view.stop();
      fixtures[id].el.remove(); delete fixtures[id];
    });
    focus.forEach(function (id) {
      var s = shapes[id]; if (!s) return;
      var f = fixtures[id];
      if (!f) {
        var el = document.createElement("div");
        el.className = "fx";
        el.innerHTML = '<div class="nm"><b></b><span></span></div><canvas></canvas>';
        f = fixtures[id] = { el: el, canvas: el.querySelector("canvas"), rgb: null };
      }
      box.appendChild(f.el); // in spotlight order
      if (f.shape !== s) { f.shape = s; f.rgb = null; attachView(f); }
      f.el.querySelector("b").textContent = s.name;
      f.el.querySelector("span").textContent = s.effect ? s.effect : "map only";
      draw(f);
    });
  }
  function draw(f) {
    if (f.view) return;
    var c = f.canvas, dpr = window.devicePixelRatio || 1, s = f.shape;
    var W = c.clientWidth * dpr, H = c.clientHeight * dpr;
    if (!W || !H) return;
    if (c.width !== W || c.height !== H) { c.width = W; c.height = H; }
    var g = c.getContext("2d");
    g.globalCompositeOperation = "source-over";
    g.fillStyle = "#000"; g.fillRect(0, 0, W, H);
    if (!s || !s.xy) return;
    var n = s.xy.length / 2, pad = 14 * dpr;
    var bw = W - 2 * pad, bh = H - 2 * pad, w = bw, h = bw / s.aspect;
    if (h > bh) { h = bh; w = bh * s.aspect; }
    var ox = (W - w) / 2, oy = (H - h) / 2;
    var spacing = Math.sqrt((w * h) / Math.max(1, n));
    var rad = Math.max(1.5 * dpr, Math.min(9 * dpr, spacing * 0.42));
    // Halos add up ("lighter"): dense maps get fainter ones, or they wash to white.
    var halo = Math.min(0.28, 0.28 * Math.pow(spacing / (rad * 4.2), 2)).toFixed(3);
    g.globalCompositeOperation = "lighter";
    for (var i = 0; i < n; i++) {
      var x = ox + s.xy[2 * i] * w, y = oy + s.xy[2 * i + 1] * h;
      var r, gg, b;
      if (f.rgb) { r = f.rgb[3 * i]; gg = f.rgb[3 * i + 1]; b = f.rgb[3 * i + 2]; } else { r = gg = b = 38; }
      if (r + gg + b < 6) continue;
      g.fillStyle = "rgba(" + r + "," + gg + "," + b + "," + halo + ")";
      g.beginPath(); g.arc(x, y, rad * 2.1, 0, 6.2832); g.fill();
      g.fillStyle = "rgb(" + r + "," + gg + "," + b + ")";
      g.beginPath(); g.arc(x, y, rad, 0, 6.2832); g.fill();
    }
  }
  // The app's 3D map view (window.SplancMapView, /stage/view.js): orbits slowly;
  // drag to orbit, wheel to zoom, and after a pause it goes back to orbiting.
  // G toggles its ground grid + axis gizmo. Without it, the flat drawing above.
  var showGrid = store("stage.grid") !== "off";
  function mapOf(s) {
    var leds = [], n = s.xyz.length / 3;
    for (var i = 0; i < n; i++) leds.push({ id: i, xyz: [s.xyz[3 * i], s.xyz[3 * i + 1], s.xyz[3 * i + 2]], confidence: 1, nViews: 2 });
    return { leds: leds, ledCount: n };
  }
  function attachView(f) {
    var V = window.SplancMapView, s = f.shape;
    if (!V || !s || !s.xyz) return;
    var map = mapOf(s);
    if (f.view && f.viewN === map.leds.length) f.view.update(map);
    else {
      if (f.view) f.view.stop();
      f.view = new V(f.canvas, map);
      f.view.showStats = false;
      f.view.showGrid = f.view.showTriad = showGrid;
      f.view.resumeAfterMs = 6000;
      f.view.start();
    }
    f.viewN = map.leds.length;
    f.view.setLedColors(new Uint8Array(map.leds.length * 3)); // unlit: the map's shape in grey
  }
  function setGrid(on) {
    showGrid = on; store("stage.grid", on ? "on" : "off");
    for (var k in fixtures) if (fixtures[k].view) fixtures[k].view.showGrid = fixtures[k].view.showTriad = on;
  }
  function frame(ev) {
    var f = fixtures[ev.player];
    if (!f) return;
    var bin = atob(ev.rgb), a = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i);
    f.rgb = a;
    if (f.view) { f.view.setLedColors(a); return; } // it draws every animation frame
    if (!f.queued) { f.queued = true; requestAnimationFrame(function () { f.queued = false; draw(f); }); }
  }
  window.addEventListener("resize", function () { for (var k in fixtures) draw(fixtures[k]); });

  // ---- events ---------------------------------------------------------------
  function newReply() {
    flushPlayback();
    reply = { text: "", pos: 0, queued: 0 };
    renderReply();
  }
  function handle(ev) {
    switch (ev.type) {
      case "reset":
        newReply(); turnActive = false;
        $("said").textContent = ""; $("think").textContent = ""; $("steps").innerHTML = "";
        code = freshCode(); renderCode(false);
        $("effName").textContent = ""; badge("", "waiting"); $("diag").textContent = "";
        status("", idleText);
        break;
      case "prompt":
        newReply();
        $("said").className = "said"; $("said").textContent = ev.text;
        $("think").textContent = ""; replyFresh = true; turnActive = true;
        status("thinking", "Thinking…");
        break;
      case "thinking_start": status("thinking", "Thinking…"); $("think").textContent = ""; break;
      case "thinking": $("think").textContent = ($("think").textContent + ev.text).slice(-220); break;
      case "say_start":
        queueText(true);
        if (!replyFresh) addReply("", true);
        replyFresh = false; $("think").textContent = "";
        break;
      case "say":
        addReply(ev.text, false);
        if (live) queueText(false); else { reply.pos = reply.queued = reply.text.length; renderReply(); }
        if (live && voiceOn && statusKind === "thinking") status("speaking", "Speaking…");
        break;
      case "tool_writing":
        queueText(true);
        if (ev.name === "explain_code") status("speaking", "Explaining…");
        else if (ev.name === "show_code" || ev.name === "show_fixtures") status("working", LABEL[ev.name] + "…");
        else status("working", /compile_effect|deploy_effect|crossfade_to|preview_effect|estimate_effect/.test(ev.name) ? "Writing code…" : "Getting ready: " + (LABEL[ev.name] || ev.name).toLowerCase() + "…");
        break;
      case "explain_step": {
        queueText(true);
        var start = reply.text.length;
        if (ev.say) addReply(ev.say, true);
        var it = { start: start, end: reply.text.length, pace: true, act: function () { applyMark(ev); } };
        reply.queued = it.end;
        renderReply(); // what is still to come shows dim
        if (live) enqueue(it); else { applyMark(ev); reply.pos = reply.text.length; renderReply(); }
        break;
      }
      case "explain_end": break;
      case "code":
        if (code.id !== ev.id) {
          var same = code.target.length > 0 && ev.source.indexOf(code.target.slice(0, 40)) === 0;
          code.id = ev.id; code.bad = {}; code.warn = {}; code.marks = [];
          if (!same) { code.shown = 0; $("code").scrollTop = 0; }
          badge("busy", ev.instant ? "opened" : "writing"); $("diag").textContent = "";
        }
        code.target = ev.source; code.done = !!ev.done;
        if (ev.instant) code.shown = code.target.length;
        if (code.shown > code.target.length) code.shown = code.target.length;
        $("effName").textContent = ev.label || effectName(ev.source);
        if (ev.instant) badge("ok", "on screen");
        renderCode(false);
        break;
      case "tool_call": {
        var el = addStep(ev.id, "", (LABEL[ev.name] || ev.name) + "<small>" + esc(ev.name) + "</small>");
        el.dataset.summary = summarize(ev.name, ev.args || {});
        el.querySelector(".sub").textContent = el.dataset.summary;
        status("working", (LABEL[ev.name] || ev.name) + "…");
        if (ev.name === "compile_effect") badge("busy", "compiling");
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
          flash(ev.name === "crossfade_to" ? "Crossfade!" : "Splanc!", $("effName").textContent);
          var bt = $("compile").textContent;
          if (bt === "writing" || bt === "waiting") badge("ok", "on the lights");
        }
        if (ev.ok && ev.name === "rollback_effect") flash("Undo!", "back to the last look");
        status("thinking", "Thinking…");
        break;
      }
      case "turn_end": turnActive = false; queueText(true); $("think").textContent = ""; idle(); break;
      case "stopped": turnActive = false; flushPlayback(); status("", idleText); note("Stopped."); break;
      case "error": turnActive = false; queueText(true); idle(); note(ev.text, "err"); break;
      case "note": note(ev.text); break;
      case "phone":
        if (ev.url && ev.url !== phoneUrl && live) { closePair(); note("Phone on screen. Clicked into it? Click the stage again before pressing Space."); }
        showPhone(ev);
        break;
      case "phone_cert": phoneCert = ev.fingerprint; renderPair(); break;
      case "twin_layout": shapes[ev.player] = ev; renderStrip(); break;
      case "twin_focus": focus = ev.players || []; renderStrip(); break;
      case "twin_note": note(ev.player + ": " + ev.text); break;
    }
  }
  function connect() {
    var es = new EventSource("/events" + Q);
    es.addEventListener("open", function () { live = false; status("", idleText); });
    es.addEventListener("live", function () { live = true; });
    es.addEventListener("stage", function (m) { handle(JSON.parse(m.data)); });
    es.addEventListener("frame", function (m) { frame(JSON.parse(m.data)); });
    es.addEventListener("error", function () { live = false; status("", "Reconnecting…"); });
  }
  renderCode(false);
  connect();

  // ---- listening ------------------------------------------------------------
  var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  var rec = null, listening = false, sendOnEnd = false;
  if (!SR) { $("hint").innerHTML = "No speech recognition in this browser (use Chrome or Safari) · <kbd>Enter</kbd> to type"; }
  function startListening() {
    if (!SR || listening) return;
    flushPlayback(); // barge in: the voice stops, the explanation jumps to its end
    var finalText = "";
    sendOnEnd = true;
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
    try { rec.start(); listening = true; status("listening", "Listening…"); $("said").textContent = ""; }
    catch (err) { note("Microphone: " + err.message, "err"); }
  }
  function stopListening(send) {
    if (!rec || !listening) return;
    sendOnEnd = send;
    rec.stop();
  }
  var typing = false;
  function openType() { flushPlayback(); typing = true; $("typebox").classList.add("on"); $("typed").value = ""; $("typed").focus(); }
  function closeType() { typing = false; $("typebox").classList.remove("on"); $("typed").blur(); }
  $("typed").addEventListener("keydown", function (e) {
    if (e.key === "Enter") { var t = $("typed").value.trim(); closeType(); if (t) post("/api/prompt", { text: t }); e.preventDefault(); }
    else if (e.key === "Escape") { closeType(); e.preventDefault(); }
    e.stopPropagation();
  });
  var TOGGLE = { PageDown: 1, PageUp: 1, b: 1, B: 1, ".": 1 };
  document.addEventListener("keydown", function (e) {
    if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.code === "Space") { e.preventDefault(); if (!e.repeat) startListening(); }
    else if (TOGGLE[e.key]) { e.preventDefault(); if (e.repeat) return; if (listening) stopListening(true); else startListening(); }
    else if (e.key === "Enter") { e.preventDefault(); openType(); }
    else if (e.key === "v" || e.key === "V") { if (!e.repeat) setVoice(!voiceOn); }
    else if (e.key === "g" || e.key === "G") { if (!e.repeat) setGrid(!showGrid); }
    else if (e.key === "f" || e.key === "F") { if (!e.repeat && phoneShown()) $("app").classList.toggle("phonebig"); }
    else if (e.key === "Escape" && !$("pair").hidden) closePair();
    else if (e.key === "Escape" && $("app").classList.contains("phonebig")) $("app").classList.remove("phonebig");
    else if (e.key === "Escape") { if (listening) stopListening(false); flushPlayback(); idle(); post("/api/stop"); }
  });
  document.addEventListener("keyup", function (e) { if (!typing && e.code === "Space") { e.preventDefault(); stopListening(true); } });

  // ---- buttons --------------------------------------------------------------
  $("voiceBtn").onclick = function () { setVoice(!voiceOn); this.blur(); };
  $("resetBtn").onclick = function () { post("/api/reset"); this.blur(); };
  $("mapsBtn").onclick = function () { post("/api/maps"); note("Re-reading maps…"); this.blur(); };
  // ---- the phone slot --------------------------------------------------------
  // The phone's ScreenStream page in an iframe (its address comes from pairing:
  // the phone scans the QR code and sends it), or a captured window.
  var phoneUrl = null, phoneSrc = null, phoneCert = null;
  function phoneShown() { return !$("phoneFrame").hidden || !$("phone").hidden; }
  function stopCapture() {
    var v = $("phone");
    if (v.srcObject) v.srcObject.getTracks().forEach(function (t) { t.stop(); });
    v.srcObject = null; v.hidden = true;
  }
  function layoutPhone() {
    $("app").classList.toggle("nophone", !phoneShown());
    if (!phoneShown()) $("app").classList.remove("phonebig");
    $("phoneBtn").classList.toggle("on", phoneShown());
  }
  // Through the stage's phone proxy when it has one (no certificate prompt: the
  // stage checks the phone's certificate itself), else the phone's page directly.
  function showPhone(ev) {
    phoneUrl = (ev && ev.url) || null;
    phoneSrc = !phoneUrl ? null : ev.proxyPort ? location.protocol + "//" + location.hostname + ":" + ev.proxyPort + "/?splanc=" + (ev.n || 0) : phoneUrl;
    if (!phoneUrl) phoneCert = null;
    var f = $("phoneFrame");
    if (phoneSrc) {
      stopCapture();
      if (f.getAttribute("src") !== phoneSrc) f.setAttribute("src", phoneSrc);
      f.hidden = false;
    } else { f.hidden = true; f.removeAttribute("src"); }
    layoutPhone();
    renderPair();
  }
  function renderPair() {
    var direct = phoneUrl && phoneSrc === phoneUrl && phoneUrl.indexOf("https:") === 0;
    $("pairTrust").hidden = !direct;
    $("pairHide").hidden = !phoneShown();
    $("pairState").textContent = !phoneUrl ? "" : direct
      ? "Showing " + phoneUrl + ". Blank? Trust its certificate once, then close the tab it opens."
      : "Showing " + phoneUrl + (phoneCert ? ". Certificate SHA-256 " + phoneCert.slice(0, 23) + "… (ScreenStream shows the same)." : ".");
  }
  function openPair() {
    $("pair").hidden = false; renderPair();
    fetch("/api/pair" + Q, { headers: { "x-stage-key": KEY } }).then(function (r) { return r.json(); }).then(function (p) {
      var url = (p.urls || [])[0];
      if (!url) { $("pairUrl").textContent = p.error || "Pairing isn't available (no network address)."; return; }
      // The likeliest address is first; the others are a click away (VPNs, two networks).
      var draw = function (u) {
        if (window.qrcode) { var qr = window.qrcode(0, "M"); qr.addData(u); qr.make(); $("pairQr").innerHTML = qr.createSvgTag(6, 2); }
        Array.prototype.forEach.call($("pairUrl").children, function (c) { c.classList.toggle("sel", c.textContent === u); });
      };
      if (p.fingerprint) { phoneCert = p.fingerprint; renderPair(); }
      $("pairUrl").innerHTML = "";
      p.urls.forEach(function (u) {
        var a = document.createElement("span"); a.textContent = u; a.onclick = function () { draw(u); };
        $("pairUrl").appendChild(a);
      });
      draw(url);
    }).catch(function (e) { $("pairUrl").textContent = "Pairing: " + e.message; });
  }
  function closePair() { $("pair").hidden = true; }
  $("phoneBtn").onclick = function () {
    this.blur();
    if (phoneShown()) { hidePhone(); return; }
    openPair();
  };
  function hidePhone() {
    stopCapture();
    if (phoneUrl) post("/api/phone", { url: null }); // every screen hides it
    showPhone(null);
  }
  $("pairClose").onclick = closePair;
  $("pairHide").onclick = function () { hidePhone(); closePair(); };
  $("pairTrust").onclick = function () { if (phoneUrl) window.open(phoneUrl, "_blank", "noopener"); };
  $("pairCapture").onclick = function () {
    closePair();
    navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 30 }, audio: false }).then(function (s) {
      if (phoneUrl) post("/api/phone", { url: null });
      showPhone(null);
      var v = $("phone");
      v.srcObject = s; v.hidden = false; layoutPhone();
      s.getVideoTracks()[0].addEventListener("ended", function () { stopCapture(); layoutPhone(); });
    }).catch(function (err) { note("Phone: " + err.message, "err"); });
  };
  if (!canSpeak) { $("voiceBtn").disabled = true; }
  setVoice(voiceOn);
  if (synth) { synth.getVoices(); synth.addEventListener && synth.addEventListener("voiceschanged", function () { synth.getVoices(); }); }
  idleText = SR ? "Ready — hold Space to talk" : "Ready — press Enter to type";
})();
</script>
<script type="module">
  // The neural voice (Kokoro, open weights, runs here in the browser). The library is
  // pinned by version and hash (the import map above); the model comes from Hugging Face
  // on first use and is cached by the browser.
  if (window.stageTts && window.stageTts.wantKokoro) {
    import("kokoro").then(function (m) { window.stageTts.lib = m.KokoroTTS; window.stageTts.load(); }, function (e) { window.stageTts.fail(e); });
  }
</script>
</body>
</html>
`;

export const STAGE_PAGE = PAGE.replace("@@LOGO@@", LOGO_SVG);

/** The page a phone gets from the pairing QR code: it sends the phone's
 * ScreenStream address to the stage. `@@IP@@` is the phone's address as the
 * stage saw it; the form posts back to the same (token) path. */
export const PHONE_PAGE = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Splanc Stage: show this phone</title>
<style>
body { margin: 0; font: 16px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #6a16a8; color: #fff; }
main { max-width: 30rem; margin: 0 auto; padding: 1.5rem 1rem; }
h1 { font-size: 1.6rem; margin: 0 0 .5rem; }
label { display: block; font-weight: 600; margin: 1rem 0 .3rem; }
input { box-sizing: border-box; width: 100%; font: inherit; padding: .7rem; border-radius: .6rem; border: 3px solid #000; }
button { display: block; width: 100%; margin-top: .8rem; padding: .85rem; font-family: inherit; font-weight: 700; font-size: 1.05rem; border: 3px solid #000; border-radius: .7rem; box-shadow: 4px 4px 0 #000; }
.go { background: #ffe600; color: #000; }
.quiet { background: #fff; color: #000; }
.small { font-size: .9rem; opacity: .9; }
.small a { color: #ffe600; }
#msg { margin-top: 1rem; font-weight: 600; min-height: 1.5em; }
</style>
</head>
<body><main>
<h1>Show this phone on the TV</h1>
<p>Start ScreenStream on this phone, then tap <b>Show on the TV</b>.</p>
<label for="u">ScreenStream address</label>
<input id="u" inputmode="url" autocomplete="off" value="https://@@IP@@:8081/">
<p class="small">The ScreenStream fork serves its page over HTTPS on port 8081. Stock ScreenStream: <a href="#" id="stock">http://@@IP@@:8080/</a></p>
<button class="go" id="go">Show on the TV</button>
<button class="quiet" id="hide">Hide it from the TV</button>
<div id="msg"></div>
</main>
<script>
(function () {
  var u = document.getElementById("u"), msg = document.getElementById("msg");
  document.getElementById("stock").onclick = function (e) { e.preventDefault(); u.value = this.textContent; };
  function send(url) {
    msg.textContent = "Sending…";
    fetch(location.pathname, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url: url }) })
      .then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || r.status); }); })
      .then(function () { msg.textContent = url ? "On the TV now. Keep ScreenStream running." : "Hidden."; },
            function (e) { msg.textContent = "Couldn't reach the stage: " + e.message; });
  }
  document.getElementById("go").onclick = function () { send(u.value.trim()); };
  document.getElementById("hide").onclick = function () { send(null); };
})();
</script>
</body>
</html>
`;

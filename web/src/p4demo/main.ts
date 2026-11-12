/**
 * The P4 tracker demo page (p4demo.html, served as /p4-demo): runs the desktop
 * lighthouse demo's `--p4` live mode from a phone.
 *
 *  - The lamp (a PixieLamp2: an ESP32-P4 player with its own wired Vive tracker) is
 *    reached through the app's own player connection (appState + the device sheet,
 *    cert trust included). OSC goes to it inside that session (ClientMessage.osc) and
 *    its /lh/pose comes back (ServerMessage.osc).
 *  - The stylus (a second Vive tracker on a Watchman dongle) and lhd's base stations
 *    come from an LhTracking (./lh): the mock with ?mock=1, else the WebHID one.
 *  - The page deploys its effects through the app's compile/upload path, forwards the
 *    stations as /lh/station once a second, and streams the stylus-driven shape.
 *
 * Browser-only entry (kept out of the unit-test compile with the other page entries).
 */

import "../ui/kit/fonts.css";
import "../ui/kit/tokens.css";
import "../ui/app/app.css";
import "./p4demo.css";

import type { LedMapperClient } from "../net/client";
import { appState } from "../ui/app/state";
import { openDeviceSheet } from "../ui/screens/deviceSheet";
import { Button, Slider, StatusPill, Switch, installIconSprite, toast, type PillState } from "../ui/kit";
import { saveFile } from "../ui/saveFile";
import { createTracking } from "./lh";
import type { LhPose, LhStatus, Vec3 } from "./lh/types";
import { decode } from "./osc";
import { OscStreamer } from "./streamer";
import { lampProblem, MockLamp, parseFixturePose, parseLhPose, realLamp, type LampLink, type LampPose } from "./lamp";
import {
  effectFor,
  followStylus,
  hexToRgb,
  initialState,
  rgbToHex,
  stationMessages,
  syncStreamer,
  SPOT_COUNT,
  type DemoState,
  type EffectKey,
  type Mode,
} from "./demo";
import { deployEffect } from "./deploy";
import { poseFromPQ, tipWorld, type Pose } from "./frames";
import { pivotProblem, pivotRobust, PIVOT_MIN_SAMPLES, type PivotResult } from "./pivot";
import { defaultKv, parseStylusTip, StylusTipStore } from "./stylusTip";
import { View3D } from "./view3d";

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;
const params = new URLSearchParams(location.search);
const MOCK = params.get("mock") === "1";
const STYLUS_STALE_MS = 500;
const LAMP_POSE_STALE_MS = 1000;
const STATE_KEY = "splanc.p4demo.state";
const PREFS_KEY = "splanc.p4demo.prefs";

// ------------------------------------------------------------------ state

// Subscriptions below can fire before the UI further down exists (onStatus calls back
// at once): render() waits for this.
let uiReady = false;
const kv = defaultKv();
const tips = new StylusTipStore(kv);
const S: DemoState = loadState();
const prefs = loadPrefs();
const { tracking, mock } = createTracking({ mock: MOCK });
const mockLamp = MOCK ? new MockLamp() : null;

let lamp: LampLink | null = null;
let lampOscUnsub: (() => void) | null = null;
let lampPose: LampPose | null = null;
let fixturePose: { pose: Pose; s: number; at: number } | null = null;
let trackStatus: LhStatus = { state: "disconnected" };
let stylusSerial: string | null = null;
const serialsSeen = new Set<string>();
let stylus: { pose: Pose; ok: boolean; at: number } | null = null;
let stationsSent = 0;
let deployed: { link: LampLink; key: EffectKey } | null = null;
let deploying: EffectKey | null = null;
let deployError: string | null = null;
let pivot: { poses: Pose[]; live: PivotResult | null; why: string | null } | null = null;
let poseCount = 0;
let poseRate = 0;
let oscCount = 0;
let oscRate = 0;

interface Prefs {
  stations: boolean;
  autoDeploy: boolean;
}

function loadPrefs(): Prefs {
  const d: Prefs = { stations: true, autoDeploy: true };
  try {
    return { ...d, ...(JSON.parse(kv?.getItem(PREFS_KEY) ?? "{}") as Partial<Prefs>) };
  } catch {
    return d;
  }
}
function savePrefs(): void {
  try {
    kv?.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    /* ignore */
  }
}

/** The knobs and spots persist; the mode does not (the page always starts LIVE). */
function loadState(): DemoState {
  const s = initialState();
  try {
    const d = JSON.parse(kv?.getItem(STATE_KEY) ?? "{}") as Partial<DemoState>;
    for (const k of ["width", "halo", "radius", "spotRadius", "spotRange"] as const)
      if (typeof d[k] === "number" && Number.isFinite(d[k])) s[k] = d[k];
    if (Array.isArray(d.glow) && d.glow.length === 3) s.glow = d.glow as Vec3;
    if (Array.isArray(d.spots) && d.spots.length === SPOT_COUNT) s.spots = d.spots;
  } catch {
    /* defaults */
  }
  return s;
}
let saveTimer = 0;
function saveState(): void {
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    try {
      const { width, halo, radius, glow, spots, spotRadius, spotRange } = S;
      kv?.setItem(STATE_KEY, JSON.stringify({ width, halo, radius, glow, spots, spotRadius, spotRange }));
    } catch {
      /* ignore */
    }
  }, 400);
}

// ------------------------------------------------------------------ OSC out

/** Only a lamp the page can drive gets OSC (an "osc"-less firmware would drop the
 * unknown message arm anyway; this keeps the socket quiet). */
function sendOsc(packet: Uint8Array): boolean {
  if (lampProblem(lamp) !== null) return false;
  const ok = lamp!.sendOsc(packet);
  if (ok) oscCount++;
  return ok;
}

const streamer = new OscStreamer((p) => void sendOsc(p)).start();

function pushState(): void {
  syncStreamer(streamer, S);
}

// Stations: lhd's base stations to the P4 once a second, each as its own datagram
// (README --no-p4-stations turns this off: the P4 then keeps calibrating its own).
setInterval(() => {
  if (!prefs.stations) return;
  for (const m of stationMessages(tracking.stations())) if (sendOsc(m)) stationsSent++;
}, 1000);

setInterval(() => {
  poseRate = poseCount;
  oscRate = oscCount;
  poseCount = oscCount = 0;
  render();
}, 1000);

// ------------------------------------------------------------------ the lamp

let linkClient: LedMapperClient | null = null;
/** The app's connected player when there is one (it wins over the simulated lamp),
 * else the simulated lamp under ?mock=1. */
function currentLink(): LampLink | null {
  const c = appState.client;
  if (c?.isConnected) {
    if (c === linkClient && lamp?.kind === "real") return lamp;
    linkClient = c;
    return realLamp(c);
  }
  linkClient = null;
  return mockLamp;
}

function onLampChanged(): void {
  const next = currentLink();
  if (next !== lamp) {
    lampOscUnsub?.();
    lamp = next;
    lampPose = null;
    fixturePose = null;
    lampOscUnsub = lamp ? lamp.onOsc(onLampOsc) : null;
    if (deployed && deployed.link !== lamp) deployed = null;
    deployError = null;
    streamer.resend();
  }
  maybeDeploy();
  render();
}

function onLampOsc(packet: Uint8Array): void {
  let msgs;
  try {
    msgs = decode(packet);
  } catch {
    return;
  }
  const now = performance.now();
  for (const m of msgs) {
    const p = parseLhPose(m, now);
    if (p) lampPose = p;
    const f = parseFixturePose(m);
    if (f) fixturePose = { ...f, at: now };
  }
}

/** Put the mode's effect on the lamp: automatically the first time a usable lamp shows
 * up (prefs.autoDeploy), and whenever the mode needs the other effect. */
function maybeDeploy(force = false): void {
  if (lampProblem(lamp) !== null || deploying) return;
  const want = effectFor(S.mode);
  if (!force && deployed?.link === lamp && deployed.key === want) return;
  if (!force && !prefs.autoDeploy && deployed?.link !== lamp) return;
  if (!force && deployError) return;
  void runDeploy(want);
}

async function runDeploy(key: EffectKey): Promise<void> {
  const link = lamp!;
  deploying = key;
  deployError = null;
  render();
  try {
    await deployEffect(link, key);
    deployed = { link, key };
    toast(key === "hot_spots" ? "Hot spots effect on the lamp" : "Tracker demo effect on the lamp");
    streamer.resend(); // the new effect starts from its defaults
  } catch (e) {
    deployError = e instanceof Error ? e.message : String(e);
    toast(`Deploy failed: ${deployError}`, { error: true });
  } finally {
    deploying = null;
    render();
    // The mode may have changed while this one uploaded.
    if (!deployError && lamp === link) maybeDeploy();
  }
}

appState.subscribe(onLampChanged);
appState.restoreActive(params.get("url"));

// ------------------------------------------------------------------ the stylus

function tipFor(serial: string | null): Vec3 | null {
  return serial ? (tips.get(serial)?.c_S ?? null) : null;
}

tracking.onStatus((s) => {
  trackStatus = s;
  render();
});
tracking.onStations(() => render());
tracking.onPose((p: LhPose) => {
  serialsSeen.add(p.serial);
  if (stylusSerial === null) stylusSerial = p.serial;
  if (p.serial !== stylusSerial) return;
  poseCount++;
  const pose = poseFromPQ(p.pos, p.quat);
  stylus = { pose, ok: p.ok, at: performance.now() };
  if (!p.ok) return;
  if (pivot && pivot.poses.length < 5000) pivot.poses.push(pose);
  if ((S.mode === "plane" || S.mode === "sphere") && followStylus(S, pose, tipFor(stylusSerial))) pushState();
});

async function toggleTracking(): Promise<void> {
  try {
    if (trackStatus.state === "disconnected") await tracking.connect();
    else await tracking.disconnect();
  } catch (e) {
    toast(e instanceof Error ? e.message : String(e), { error: true });
  }
}

// Pivot: rock the stylus round its tip held in a dimple; solved live (4 Hz).
function startPivot(): void {
  if (!stylusSerial) {
    toast("No stylus pose yet: connect the stylus first", { error: true });
    return;
  }
  pivot = { poses: [], live: null, why: null };
  mock?.setScenario("pivot");
  buildPanel();
  render();
}
setInterval(() => {
  if (!pivot || pivot.poses.length < 20) return;
  // Decimate for the live view; the final solve uses every sample.
  const step = Math.max(1, Math.floor(pivot.poses.length / 1500));
  const sub = pivot.poses.filter((_, i) => i % step === 0);
  pivot.live = pivotRobust(sub);
  pivot.why = pivot.live ? pivotProblem(pivot.live, sub.length) : "degenerate: rock the stylus";
  render();
}, 250);
function finishPivot(): void {
  if (!pivot || !stylusSerial) return;
  const res = pivotRobust(pivot.poses);
  const why = res ? pivotProblem(res, pivot.poses.length) : "no rotation: rock the stylus round its tip";
  if (!res || why) {
    toast(`Tip not saved: ${why}`, { error: true });
    pivot = { poses: [], live: null, why };
    render();
    return;
  }
  tips.put({
    stylus: stylusSerial,
    c_S: res.c,
    pivot: {
      rms_mm: res.rms * 1e3,
      spread_deg: res.spreadDeg,
      n: pivot.poses.length,
      kept: res.inliers.filter(Boolean).length,
      q_W: res.q,
    },
    saved: new Date().toISOString().slice(0, 19),
  });
  toast(`Tip saved: ${(Math.hypot(...res.c) * 100).toFixed(1)} cm from the tracker, RMS ${(res.rms * 1e3).toFixed(1)} mm`);
  pivot = null;
  mock?.setScenario("wander");
  buildPanel();
  render();
}
function cancelPivot(): void {
  pivot = null;
  mock?.setScenario("wander");
  buildPanel();
  render();
}

function pickFile(accept: string, then: (text: string, name: string) => void): void {
  const inp = document.createElement("input");
  inp.type = "file";
  inp.accept = accept;
  inp.onchange = async () => {
    const f = inp.files?.[0];
    if (f) then(await f.text(), f.name);
  };
  inp.click();
}

function importTip(): void {
  pickFile(".json,application/json", (text) => {
    try {
      const fromName = stylusSerial ?? undefined;
      const t = parseStylusTip(text, fromName);
      tips.put(t);
      toast(
        t.stylus === stylusSerial || !stylusSerial
          ? `Tip for ${t.stylus} imported`
          : `Tip for ${t.stylus} imported (the stylus in use is ${stylusSerial})`,
      );
      render();
    } catch (e) {
      toast(`Not a stylus tip file: ${e instanceof Error ? e.message : String(e)}`, { error: true });
    }
  });
}

// ------------------------------------------------------------------ modes

function setMode(m: Mode): void {
  if (S.mode === m) return;
  S.mode = m;
  if (stylus && (m === "plane" || m === "sphere")) followStylus(S, stylus.pose, tipFor(stylusSerial));
  pushState();
  maybeDeploy();
  buildPanel();
  render();
}

function currentTip(): Vec3 | null {
  if (!stylus || performance.now() - stylus.at > STYLUS_STALE_MS) return null;
  return tipWorld(stylus.pose, tipFor(stylusSerial) ?? [0, 0, 0]);
}

function placeSpot(i: number): void {
  const tip = currentTip();
  if (!tip) {
    toast("No live stylus: can't place a spot", { error: true });
    return;
  }
  if (!tipFor(stylusSerial)) toast("The stylus tip isn't calibrated: the spot goes at the tracker itself");
  S.spots[i]!.pos = [...tip];
  pushState();
  saveState();
  buildPanel();
  render();
}

function placeNextSpot(): void {
  const free = S.spots.findIndex((s) => !s.pos);
  placeSpot(free >= 0 ? free : 0);
}

// ------------------------------------------------------------------ UI

installIconSprite();
const view = new View3D($<HTMLCanvasElement>("view"));
const lampPill = StatusPill(() => openDeviceSheet());
const stylusPill = StatusPill(() => void toggleTracking());
$("pills").append(lampPill.el, stylusPill.el);

const MODES: { mode: Mode; label: string; sub: string }[] = [
  { mode: "plane", label: "Plane", sub: "live" },
  { mode: "sphere", label: "Sphere", sub: "live" },
  { mode: "outline", label: "Outline", sub: "idle" },
  { mode: "spots", label: "Spots", sub: "game" },
];
const modeButtons = MODES.map(({ mode, label, sub }) => {
  const b = document.createElement("button");
  b.type = "button";
  b.innerHTML = `${label}<small>${sub}</small>`;
  b.addEventListener("click", () => setMode(mode));
  $("modes").append(b);
  return { mode, b };
});

function card(title: string, ...children: (Node | string)[]): HTMLElement {
  const c = document.createElement("section");
  c.className = "p4-card";
  if (title) {
    const h = document.createElement("h2");
    h.textContent = title;
    c.append(h);
  }
  c.append(...children);
  return c;
}
function details(title: string, open: boolean, ...children: (Node | string)[]): HTMLDetailsElement {
  const d = document.createElement("details");
  d.className = "p4-card";
  d.open = open;
  const s = document.createElement("summary");
  s.textContent = title;
  d.append(s, ...children);
  return d;
}
function row(...children: (Node | string)[]): HTMLElement {
  const r = document.createElement("div");
  r.className = "p4-row";
  r.append(...children);
  return r;
}
function text(t: string, cls = "p4-dim"): HTMLElement {
  const s = document.createElement("div");
  s.className = cls;
  s.textContent = t;
  return s;
}
function live(id: string, cls = "p4-dim"): HTMLElement {
  const s = document.createElement("div");
  s.className = cls;
  s.id = id;
  return s;
}
function colorInput(value: Vec3, onInput: (c: Vec3) => void): HTMLInputElement {
  const c = document.createElement("input");
  c.type = "color";
  c.className = "p4-color";
  c.value = rgbToHex(value);
  c.addEventListener("input", () => onInput(hexToRgb(c.value)));
  return c;
}
const mm = (v: number): string => `${(v * 1000).toFixed(0)} mm`;
const cm = (v: number): string => `${(v * 100).toFixed(0)} cm`;

function shapeControls(): HTMLElement[] {
  const follow = Switch({
    on: S.follow,
    label: "Follow the stylus",
    onChange: (on) => {
      S.follow = on;
      if (on && stylus) followStylus(S, stylus.pose, tipFor(stylusSerial));
      pushState();
      render();
    },
  });
  const out: HTMLElement[] = [
    card(
      S.mode === "plane" ? "Plane at the stylus tip" : "Sphere round the stylus tip",
      text(S.mode === "plane" ? "Perpendicular to the stylus, through its tip." : "Centred on the stylus tip."),
      row(text("Follow the stylus (off: hold it where it is)", "grow"), follow.el),
      live("shape-readout", "p4-mono"),
      Slider({
        label: "Width",
        min: 0.002,
        max: 0.1,
        step: 0.001,
        value: S.width,
        format: mm,
        onInput: (v) => {
          S.width = v;
          pushState();
          saveState();
        },
      }).el,
      Slider({
        label: "Halo",
        min: 0,
        max: 0.2,
        step: 0.002,
        value: S.halo,
        format: mm,
        onInput: (v) => {
          S.halo = v;
          pushState();
          saveState();
        },
      }).el,
      row(
        text("Glow", "grow"),
        colorInput(S.glow, (c) => {
          S.glow = c;
          pushState();
          saveState();
          render();
        }),
      ),
    ),
  ];
  if (S.mode === "sphere") {
    out[0]!.append(
      Slider({
        label: "Radius",
        min: 0.01,
        max: 0.5,
        step: 0.005,
        value: S.radius,
        format: cm,
        onInput: (v) => {
          S.radius = v;
          S.sphere.r = v;
          pushState();
          saveState();
          render();
        },
      }).el,
    );
  }
  return out;
}

function spotControls(): HTMLElement[] {
  const rows = S.spots.map((sp, i) => {
    const r = document.createElement("div");
    r.className = "p4-spot";
    const label = text(`${i + 1}`);
    const col = colorInput(sp.color, (c) => {
      sp.color = c;
      pushState();
      saveState();
      render();
    });
    const where = text(sp.pos ? sp.pos.map((v) => v.toFixed(2)).join(", ") : "not placed", "p4-mono");
    const btns = document.createElement("div");
    btns.className = "p4-row";
    btns.append(
      Button({ label: sp.pos ? "Move" : "Place", variant: "quiet", onClick: () => placeSpot(i) }),
      Button({
        label: "Clear",
        variant: "quiet",
        disabled: !sp.pos,
        onClick: () => {
          sp.pos = null;
          pushState();
          saveState();
          buildPanel();
          render();
        },
      }),
    );
    r.append(label, col, where, btns);
    return r;
  });
  const next = Button({ label: "Place a spot at the stylus tip", block: true, onClick: placeNextSpot });
  next.classList.add("p4-big");
  return [
    card(
      "Hot spots",
      text("Up to four spots in the room. The lamp glows in a spot's colour as it gets near, and blinks inside one."),
      next,
      ...rows,
      Slider({
        label: "Hit radius",
        min: 0.01,
        max: 0.3,
        step: 0.005,
        value: S.spotRadius,
        format: cm,
        onInput: (v) => {
          S.spotRadius = v;
          pushState();
          saveState();
          render();
        },
      }).el,
      Slider({
        label: "Range",
        min: 0.05,
        max: 2,
        step: 0.05,
        value: S.spotRange,
        format: cm,
        onInput: (v) => {
          S.spotRange = v;
          pushState();
          saveState();
        },
      }).el,
    ),
  ];
}

function setupControls(): HTMLElement[] {
  const stations = Switch({
    on: prefs.stations,
    label: "Send base stations to the lamp",
    onChange: (on) => {
      prefs.stations = on;
      savePrefs();
      render();
    },
  });
  const auto = Switch({
    on: prefs.autoDeploy,
    label: "Deploy the effect on connect",
    onChange: (on) => {
      prefs.autoDeploy = on;
      savePrefs();
    },
  });
  const lampCard = details(
    "Lamp",
    false,
    live("lamp-info"),
    row(Button({ label: "Devices…", variant: "quiet", onClick: () => openDeviceSheet() }), Button({ label: "Deploy effect", onClick: () => maybeDeploy(true) })),
    row(text("Deploy the effect when a lamp connects", "grow"), auto.el),
    row(text("Send lhd's base stations (/lh/station, 1 Hz)", "grow"), stations.el),
    text(
      "Off: the lamp keeps calibrating its own stations (lhd's calibration is from another room, say). " +
        "Once a P4 has adopted lhd's stations, its own calibration stays off until it restarts.",
    ),
  );
  const stylusCard = details(
    "Stylus",
    !tipFor(stylusSerial) && stylusSerial !== null,
    live("stylus-info"),
    row(
      Button({ label: "Connect / disconnect", variant: "quiet", onClick: () => void toggleTracking() }),
      Button({ label: "Calibrate tip", onClick: startPivot }),
    ),
    live("pivot-info"),
    row(
      Button({ label: "Import stylus-*.json", variant: "quiet", onClick: importTip }),
      Button({
        label: "Export tip",
        variant: "quiet",
        onClick: () => {
          const j = stylusSerial ? tips.exportJson(stylusSerial) : null;
          if (j) void saveFile(j, `stylus-${stylusSerial}.json`, "application/json");
          else toast("No tip saved for this stylus yet", { error: true });
        },
      }),
    ),
    text(
      "Tip calibration: rest the stylus tip in a small dimple and rock it round (±20° or more, all directions) " +
        "until the bar says OK, then Done. Saved per stylus in this browser.",
    ),
  );
  const trackCard = details(
    "Tracking (lhd)",
    false,
    live("track-info"),
    row(
      Button({ label: "Recalibrate", variant: "quiet", onClick: () => tracking.recalibrate() }),
      Button({
        label: "Export",
        variant: "quiet",
        onClick: () => void saveFile(tracking.exportCalibration(), "lhd-calibration.json", "application/json"),
      }),
      Button({
        label: "Import",
        variant: "quiet",
        onClick: () =>
          pickFile(".json,application/json", (t) => {
            try {
              tracking.importCalibration(t);
              toast("Tracking calibration imported");
            } catch (e) {
              toast(`Import failed: ${e instanceof Error ? e.message : String(e)}`, { error: true });
            }
          }),
      }),
    ),
    text("After moving the base stations: Recalibrate, then set the stylus down still in a few places both stations see."),
  );
  // TODO(lh-mount): LED-touch fixture calibration (probe LEDs with the stylus tip, fit
  // the P4 tracker <- map mount, send it as /lh/mount ,f x16) is a later PR; the
  // desktop demo's probe.fit / app.py p4_send_mount is what to port.
  const fixtureCard = details(
    "Fixture calibration",
    false,
    text(
      "Coming later: touch LEDs with the stylus tip to fit where the lamp's map sits on its tracker " +
        "(/lh/mount). Until then the lamp uses the mount it has saved (set with the desktop demo).",
    ),
    live("fixture-info"),
  );
  return [lampCard, stylusCard, trackCard, fixtureCard];
}

function buildPanel(): void {
  const panel = $("panel");
  // Keep which setup sections are open across rebuilds.
  const open = new Map([...panel.querySelectorAll("details")].map((d) => [d.querySelector("summary")?.textContent ?? "", d.open]));
  panel.innerHTML = "";
  const pivotCard = pivot ? [pivotPanel()] : [];
  const modeCards = S.mode === "spots" ? spotControls() : S.mode === "outline" ? [card("Outline", text("The lamp shows a faint outline (the idle look). Pick Plane or Sphere to go live."))] : shapeControls();
  panel.append(...pivotCard, ...modeCards, ...setupControls());
  for (const d of panel.querySelectorAll("details")) {
    const k = d.querySelector("summary")?.textContent ?? "";
    if (open.has(k)) d.open = open.get(k)!;
  }
}

function pivotPanel(): HTMLElement {
  const done = Button({ label: "Done", onClick: finishPivot });
  done.classList.add("p4-big");
  return card(
    "Calibrating the stylus tip",
    text("Tip in a dimple, rock the stylus round it in every direction."),
    live("pivot-live", "p4-mono"),
    row(done, Button({ label: "Restart", variant: "quiet", onClick: startPivot }), Button({ label: "Cancel", variant: "quiet", onClick: cancelPivot })),
  );
}

function setText(id: string, t: string): void {
  const el = document.getElementById(id);
  if (el && el.textContent !== t) el.textContent = t;
}

function lampPillState(): [PillState, string] {
  if (lamp?.kind === "real" || appState.client) {
    const st = appState.status;
    const name = lamp?.name() || appState.client?.welcome?.deviceName || "lamp";
    if (st.state === "connected") return lampProblem(lamp) ? ["error", `${name}: no OSC`] : ["connected", name];
    return [st.state, st.text];
  }
  if (lamp?.kind === "mock") return ["connected", "simulated lamp"];
  return ["offline", "lamp: tap to connect"];
}

function stylusPillState(): [PillState, string] {
  const fresh = stylus && performance.now() - stylus.at < STYLUS_STALE_MS;
  switch (trackStatus.state) {
    case "tracking":
      return fresh && stylus!.ok ? ["connected", "stylus"] : ["connecting", "stylus: no pose"];
    case "connecting":
    case "calibrating":
      return ["connecting", `stylus: ${trackStatus.state}`];
    case "no-tracker":
      return ["error", "stylus: none"];
    case "lost":
      return ["error", "stylus lost"];
    default:
      return ["offline", "stylus: tap to connect"];
  }
}

function banner(): { kind: "warn" | "err"; lines: string[]; action?: HTMLElement } | null {
  const problem = lampProblem(lamp);
  if (problem && (appState.client?.isConnected || !MOCK)) {
    if (appState.status.certUrl) return { kind: "warn", lines: ["The lamp's certificate needs trusting first.", problem], action: Button({ label: "Open devices", onClick: () => openDeviceSheet() }) };
    return { kind: appState.client?.isConnected ? "err" : "warn", lines: [problem] };
  }
  if (deployError) return { kind: "err", lines: [`The effect didn't deploy: ${deployError}`], action: Button({ label: "Try again", onClick: () => maybeDeploy(true) }) };
  if (trackStatus.state === "disconnected" && trackStatus.detail) return { kind: "warn", lines: [trackStatus.detail] };
  if (stylusSerial && !tipFor(stylusSerial) && !pivot)
    return {
      kind: "warn",
      lines: [`Stylus ${stylusSerial} has no tip calibration yet: the shape follows the tracker itself.`],
      action: Button({ label: "Calibrate tip", onClick: startPivot }),
    };
  return null;
}

let lastBanner = "";
function render(): void {
  if (!uiReady) return;
  // Pills.
  const [ls, lt] = lampPillState();
  lampPill.set(ls, lt);
  const [ss, st] = stylusPillState();
  stylusPill.set(ss, st);
  for (const { mode, b } of modeButtons) b.setAttribute("aria-pressed", String(S.mode === mode));

  // Banner (rebuilt only when it changes, so its button stays clickable).
  const bn = banner();
  const key = bn ? bn.kind + bn.lines.join("|") : "";
  if (key !== lastBanner) {
    lastBanner = key;
    const el = $("banner");
    el.hidden = !bn;
    el.innerHTML = "";
    if (bn) {
      el.dataset["kind"] = bn.kind;
      for (const l of bn.lines) el.append(Object.assign(document.createElement("p"), { textContent: l }));
      if (bn.action) el.append(bn.action);
    }
  }

  const now = performance.now();
  const stylusFresh = !!stylus && now - stylus.at < STYLUS_STALE_MS;
  const lampFresh = !!lampPose && now - lampPose.at < LAMP_POSE_STALE_MS;
  const tipS = tipFor(stylusSerial);

  // Live readouts.
  if (S.mode === "plane") setText("shape-readout", `n ${S.plane.n.map((v) => v.toFixed(2)).join(" ")}  d ${S.plane.d.toFixed(3)} m${S.follow ? "" : "  (held)"}`);
  if (S.mode === "sphere") setText("shape-readout", `c ${S.sphere.c.map((v) => v.toFixed(2)).join(" ")}  r ${cm(S.radius)}${S.follow ? "" : "  (held)"}`);
  setText(
    "lamp-info",
    lamp
      ? `${lamp.name() || "lamp"} · ${lamp.kind === "mock" ? "simulated" : "connected"} · OSC ${lamp.features().includes("osc") ? "yes" : "NO (reflash)"}\n` +
          `effect: ${deploying ? `deploying ${deploying}…` : deployed?.link === lamp ? deployed.key : "not deployed from this page yet"} · ` +
          `stations sent ${stationsSent}${prefs.stations ? "" : " (off)"}\n` +
          `pose: ${lampPose ? `${lampPose.ok ? "tracking" : "NOT tracking"}, ${((now - lampPose.at) / 1000).toFixed(1)} s ago` : "none yet (it answers once it has had OSC)"}`
      : "No lamp. Tap Devices… to connect your PixieLamp.",
  );
  const lampInfo = document.getElementById("lamp-info");
  if (lampInfo) lampInfo.style.whiteSpace = "pre-line";
  setText(
    "stylus-info",
    `${stylusSerial ?? "no stylus yet"}${serialsSeen.size > 1 ? ` (also seen: ${[...serialsSeen].filter((s) => s !== stylusSerial).join(", ")})` : ""} · ` +
      (tipS ? `tip ${tipS.map((v) => (v * 1000).toFixed(1)).join(", ")} mm` : "tip NOT calibrated"),
  );
  setText("track-info", `${trackStatus.state}${trackStatus.detail ? `: ${trackStatus.detail}` : ""} · ${tracking.stations().length} station(s)`);
  setText("fixture-info", fixturePose ? `The lamp reports a mount (map scale ${fixturePose.s.toFixed(3)}).` : "The lamp hasn't reported a mount (/lh/fixture_pose).");
  if (pivot) {
    const L = pivot.live;
    setText(
      "pivot-live",
      `${pivot.poses.length} samples (need ${PIVOT_MIN_SAMPLES})` +
        (L ? `\nrocked ±${L.spreadDeg.toFixed(0)}°, RMS ${(L.rms * 1e3).toFixed(1)} mm, tip ${(Math.hypot(...L.c) * 100).toFixed(1)} cm` : "") +
        `\n${pivot.why ? `not yet: ${pivot.why}` : pivot.poses.length >= 20 ? "OK: press Done" : ""}`,
    );
    const el = document.getElementById("pivot-live");
    if (el) el.style.whiteSpace = "pre-line";
  }

  // HUD.
  setText(
    "hud",
    [
      `stylus ${stylusFresh ? `${poseRate} Hz` : "—"}${tipS ? "" : " (no tip cal)"}`,
      `lamp   ${lampFresh ? (lampPose!.ok ? "tracking" : "not tracking") : "—"}`,
      `osc    ${oscRate}/s`,
      MOCK ? "MOCK" : "",
    ]
      .filter(Boolean)
      .join("\n"),
  );

  // 3D.
  view.update({
    stations: tracking.stations(),
    stylus: stylus?.pose ?? null,
    stylusOk: stylusFresh && !!stylus?.ok,
    tip: stylus ? tipWorld(stylus.pose, tipS ?? [0, 0, 0]) : null,
    hasTipCal: !!tipS,
    lamp: lampPose ? { pose: lampPose.pose, ok: lampPose.ok, fresh: lampFresh } : null,
    mode: S.mode,
    plane: S.plane,
    sphere: { c: S.sphere.c, r: S.radius },
    glow: S.glow,
    spots: S.spots,
    spotRadius: S.spotRadius,
    pivotPoint: pivot?.live && !pivot.why ? pivot.live.q : null,
  });
}

// Redraw at ~20 Hz for the moving parts (poses arrive faster than that).
setInterval(render, 50);

// ?mode=sphere|outline|spots opens in that mode (a deep link); the default is the plane, live.
const startMode = params.get("mode");
if (startMode === "sphere" || startMode === "outline" || startMode === "spots") S.mode = startMode;
uiReady = true;
buildPanel();
pushState();
onLampChanged();
if (MOCK) void tracking.connect();
render();

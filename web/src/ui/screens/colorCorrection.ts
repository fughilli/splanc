/**
 * Color correction (FUG-75). A per-device surface for the LED strip's gamma /
 * white-balance curves: pick a built-in profile, tune per-channel gamma and
 * white balance by value or by dragging the transfer curve on a plot, and see a
 * forward + reverse palette-transfer simulator so the effect on real colors is
 * visible before (and while) it's on the strip.
 *
 * The curve math mirrors the firmware (src/color/correction.ts == the web mirror
 * of firmware/player_app/color_correction.h), so the plot and the simulator
 * match what the device does. Pushing is debounced and fire-and-forget: the
 * device rebuilds its flash LUTs and applies them to the running effect live, so
 * you can dial curves in against a playing show — the debounce keeps a drag from
 * hammering the device's flash.
 */

import { Card, Slider, Button, Chip, toast } from "../kit";
import type { Router, Screen } from "../app/router";
import { appState } from "../app/state";
import { deviceStore } from "../../store/deviceStore";
import {
  PRESETS,
  DEFAULT_PROFILE,
  buildLut,
  inverseLut,
  transfer,
  balanceFactors,
  gammaForPoint,
  matchPreset,
  cloneProfile,
  GAMMA_MIN,
  GAMMA_MAX,
  type GammaProfile,
} from "../../color/correction";
import { installColorCorrectionStyles } from "./colorCorrection.css";
import { compileScript } from "../../fx/preview";
import { UniformPanel } from "../../effects/editor/uniform-panel";
import { COLOR_TEST_ID, COLOR_TEST_SOURCE } from "../../color/colorTestEffect";

const CHANNELS = ["R", "G", "B"] as const;
const CH_COLOR = ["#ff5d5d", "#57d16a", "#5d8bff"];
const PUSH_DEBOUNCE_MS = 200;

/** Per-device persistence of the last-used profile (there's no device read-back
 * for color correction, so the UI remembers what was last dialed in). */
function storeKey(deviceId: string): string {
  return `cc:profile:${deviceId}`;
}
function loadProfile(deviceId: string | null): GammaProfile {
  if (deviceId) {
    try {
      const raw = localStorage.getItem(storeKey(deviceId));
      if (raw) {
        const p = JSON.parse(raw) as GammaProfile;
        if (Array.isArray(p.gamma) && Array.isArray(p.luminance)) return cloneProfile(p);
      }
    } catch {
      /* fall through to default */
    }
  }
  return cloneProfile(DEFAULT_PROFILE);
}
function saveProfile(deviceId: string | null, p: GammaProfile): void {
  if (!deviceId) return;
  try {
    localStorage.setItem(storeKey(deviceId), JSON.stringify(p));
  } catch {
    /* storage full / disabled — non-fatal */
  }
}

export function ColorCorrectionScreen(_router: Router): Screen {
  installColorCorrectionStyles();

  const deviceId = deviceStore.activeId();
  let profile = loadProfile(deviceId);
  let live = true;

  const el = document.createElement("div");
  el.className = "screen screen--cc";

  const head = document.createElement("h1");
  head.className = "screen-headline";
  head.textContent = "Color correction";
  const sub = document.createElement("p");
  sub.className = "screen-sub";
  const dev = deviceId ? deviceStore.get(deviceId) : null;
  sub.textContent = dev
    ? `Gamma & white balance for ${dev.label}. Saved on this device.`
    : "Gamma & white balance for the LED strip. Connect a device to push live.";
  el.append(head, sub);

  // -- persistent canvases (built once; redrawn on change) -----------------
  const plot = document.createElement("canvas");
  plot.className = "cc-plot";
  const sim = new PaletteSim();

  // Persistent "color test" uniform panel: loading the effect fills it, and each
  // control pushes setUniforms live (the same seam the effect editor uses).
  const testHost = document.createElement("div");
  let testLoaded = false;
  const testPanel = new UniformPanel(testHost, (slot, value) => {
    const c = appState.client;
    if (c?.isConnected) void c.setUniforms([{ slot, value }]).catch(() => undefined);
  });

  async function loadColorTest(btn: HTMLButtonElement): Promise<void> {
    const c = appState.client;
    if (!c?.isConnected) {
      toast("Connect a device first", { error: true });
      return;
    }
    btn.disabled = true;
    try {
      const compiled = await compileScript(COLOR_TEST_SOURCE);
      if (!compiled.ok) {
        toast("Color test failed to compile", { error: true });
        return;
      }
      await c.submitEffect(COLOR_TEST_ID, compiled.bytecode, true);
      testPanel.setManifest(compiled.uniforms);
      testLoaded = true;
      const vals = testPanel.values();
      if (vals.length) await c.setUniforms(vals);
      rebuildControls();
      toast("Color test loaded — tune the gradient below");
    } catch {
      toast("Couldn't load the color test", { error: true });
    } finally {
      btn.disabled = false;
    }
  }

  // Debounced, fire-and-forget push so a drag doesn't thrash the device flash.
  let pushTimer = 0;
  function pushNow(): void {
    const c = appState.client;
    if (!c?.isConnected) return;
    void c
      .setColorCorrection({ gamma: profile.gamma, luminance: profile.luminance })
      .catch(() => undefined);
  }
  function schedulePush(): void {
    if (!live) return;
    window.clearTimeout(pushTimer);
    pushTimer = window.setTimeout(pushNow, PUSH_DEBOUNCE_MS);
  }

  // Called whenever the profile changes: repaint the plot + simulator, persist,
  // and (if live) push. `structural` also rebuilds the value controls so their
  // positions reflect a change that came from elsewhere (preset, plot drag).
  function onProfileChanged(structural: boolean): void {
    drawPlot(plot, profile);
    sim.draw(profile);
    saveProfile(deviceId, profile);
    if (structural) rebuildControls();
    schedulePush();
  }

  // -- controls (rebuilt on structural changes) ----------------------------
  const controls = document.createElement("div");

  function rebuildControls(): void {
    controls.replaceChildren(
      presetGroup(),
      curveGroup(),
      whiteBalanceGroup(),
      colorTestGroup(),
      pushGroup(),
    );
  }

  function colorTestGroup(): HTMLElement {
    const g = group("Color test");
    const hint = document.createElement("div");
    hint.className = "cc-hint";
    hint.textContent =
      "Load a two-tone gradient onto the strip to check color reproduction under " +
      "the current curves. Set the endpoint colors, the span length (e.g. 10 vs " +
      "100 LEDs), and where it starts — to probe voltage droop along the run.";
    g.append(hint);
    const btn = Button({
      label: testLoaded ? "Reload color test" : "Load color test",
      block: true,
      onClick: () => void loadColorTest(btn),
    });
    g.append(btn, testHost);
    if (!testLoaded) {
      const note = document.createElement("div");
      note.className = "cc-hint";
      note.textContent = "The gradient controls appear here once loaded.";
      g.append(note);
    }
    return g;
  }

  function presetGroup(): HTMLElement {
    const g = group("Profile");
    const sel = document.createElement("select");
    sel.className = "cc-select";
    const active = matchPreset(profile);
    for (const preset of PRESETS) {
      const opt = document.createElement("option");
      opt.value = preset.id;
      opt.textContent = preset.label;
      if (preset.id === active) opt.selected = true;
      sel.appendChild(opt);
    }
    if (active === null) {
      const opt = document.createElement("option");
      opt.value = "__custom";
      opt.textContent = "Custom";
      opt.selected = true;
      sel.appendChild(opt);
    }
    sel.addEventListener("change", () => {
      const preset = PRESETS.find((p) => p.id === sel.value);
      if (!preset) return;
      profile = cloneProfile(preset.profile);
      onProfileChanged(true);
    });
    g.append(row("Preset", "Start from a built-in curve, then tune below.", sel));
    return g;
  }

  function curveGroup(): HTMLElement {
    const g = group("Gamma");
    g.append(plot);
    const hint = document.createElement("div");
    hint.className = "cc-hint";
    hint.textContent =
      "Drag a curve to reshape that channel's gamma, or use the sliders. Higher " +
      "gamma darkens the midtones (fixes washed-out output); 1.0 is linear.";
    g.append(hint);
    for (let c = 0; c < 3; c++) {
      g.append(
        fullRow(
          Slider({
            label: `${CHANNELS[c]} gamma`,
            min: GAMMA_MIN,
            max: GAMMA_MAX,
            step: 0.05,
            value: profile.gamma[c]!,
            format: (v) => v.toFixed(2),
            onInput: (v) => {
              profile.gamma[c] = v;
              // Non-structural: don't rebuild the slider the user is dragging.
              onProfileChanged(false);
            },
          }).el,
        ),
      );
    }
    return g;
  }

  function whiteBalanceGroup(): HTMLElement {
    const g = group("White balance");
    const hint = document.createElement("div");
    hint.className = "cc-hint";
    hint.textContent =
      "Attenuate each channel toward the dimmest so full white renders neutral. " +
      "The brightest channel sits at 100%.";
    g.append(hint);
    const gains = balanceFactors(profile); // dimmest channel == 1.0
    for (let c = 0; c < 3; c++) {
      g.append(
        fullRow(
          Slider({
            label: `${CHANNELS[c]} level`,
            min: 0.1,
            max: 1,
            step: 0.01,
            value: gains[c]!,
            format: (v) => `${Math.round(v * 100)}%`,
            onInput: (v) => {
              // Only ratios matter to the device; store luminance = 1/gain and
              // let balanceFactors renormalize (brightest -> 100%) on rebuild.
              profile.luminance[c] = 1 / Math.max(0.01, v);
              onProfileChanged(false);
            },
            onChange: () => rebuildControls(),
          }).el,
        ),
      );
    }
    return g;
  }

  function pushGroup(): HTMLElement {
    const g = group("Device");
    const c = appState.client;
    const connected = c?.isConnected ?? false;
    const liveChip = Chip({
      label: live ? "Live update: on" : "Live update: off",
      on: live,
      icon: "sparkles",
      onClick: () => {
        live = !live;
        rebuildControls();
        if (live) pushNow();
      },
    });
    const pushBtn = Button({
      label: connected ? "Push to device" : "Connect a device to push",
      block: true,
      onClick: () => {
        if (!appState.client?.isConnected) {
          toast("No device connected", { error: true });
          return;
        }
        pushNow();
        toast("Curves pushed");
      },
    });
    const ctl = document.createElement("div");
    ctl.className = "cc-push";
    ctl.append(liveChip, pushBtn);
    g.append(ctl);
    if (!connected) {
      const note = document.createElement("div");
      note.className = "cc-hint";
      note.textContent =
        "You can still preview curves offline; they'll be saved and pushed on connect.";
      g.append(note);
    }
    return g;
  }

  // -- plot drag: reshape the nearest channel's gamma ----------------------
  attachPlotDrag(plot, () => profile, (c, x, y) => {
    const balance = balanceFactors(profile)[c]!;
    profile.gamma[c] = gammaForPoint(x, y, balance);
    onProfileChanged(false);
  }, () => rebuildControls());

  el.append(controls, sim.el);
  rebuildControls();
  drawPlot(plot, profile);
  sim.draw(profile);

  return {
    el,
    onUnmount: () => window.clearTimeout(pushTimer),
  };
}

// ---------------------------------------------------------------------------
// Plot: the three per-channel transfer curves, draggable to set gamma.
// ---------------------------------------------------------------------------

/** Set a canvas up for crisp drawing at the device pixel ratio; returns a 2D
 * context already scaled so drawing uses CSS pixels. Returns null if the canvas
 * has no layout box yet (offscreen) — callers redraw on the next paint. */
function fitCanvas(canvas: HTMLCanvasElement, wCss: number, hCss: number): CanvasRenderingContext2D | null {
  const dpr = Math.min(3, Math.max(1, window.devicePixelRatio || 1));
  canvas.width = Math.round(wCss * dpr);
  canvas.height = Math.round(hCss * dpr);
  canvas.style.aspectRatio = `${wCss} / ${hCss}`;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return ctx;
}

const PLOT_W = 320;
const PLOT_H = 220;

function drawPlot(canvas: HTMLCanvasElement, p: GammaProfile): void {
  const ctx = fitCanvas(canvas, PLOT_W, PLOT_H);
  if (!ctx) return;
  const pad = 10;
  const w = PLOT_W - pad * 2;
  const h = PLOT_H - pad * 2;
  const px = (x: number): number => pad + x * w; // x in [0,1]
  const py = (y: number): number => pad + (1 - y) * h; // y in [0,1]

  ctx.clearRect(0, 0, PLOT_W, PLOT_H);
  // background + grid
  ctx.fillStyle = "rgba(255,255,255,0.03)";
  ctx.fillRect(pad, pad, w, h);
  ctx.strokeStyle = "rgba(255,255,255,0.10)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let i = 1; i < 4; i++) {
    ctx.moveTo(px(i / 4), py(0));
    ctx.lineTo(px(i / 4), py(1));
    ctx.moveTo(px(0), py(i / 4));
    ctx.lineTo(px(1), py(i / 4));
  }
  ctx.stroke();
  // identity diagonal (reference: no correction)
  ctx.strokeStyle = "rgba(255,255,255,0.25)";
  ctx.setLineDash([4, 4]);
  ctx.beginPath();
  ctx.moveTo(px(0), py(0));
  ctx.lineTo(px(1), py(1));
  ctx.stroke();
  ctx.setLineDash([]);

  // per-channel transfer curves
  for (let c = 0; c < 3; c++) {
    ctx.strokeStyle = CH_COLOR[c]!;
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let i = 0; i <= 64; i++) {
      const x = i / 64;
      const y = transfer(p, c, x);
      if (i === 0) ctx.moveTo(px(x), py(y));
      else ctx.lineTo(px(x), py(y));
    }
    ctx.stroke();
    // draggable handle at x = 0.5
    const hx = 0.5;
    const hy = transfer(p, c, hx);
    ctx.fillStyle = CH_COLOR[c]!;
    ctx.beginPath();
    ctx.arc(px(hx), py(hy), 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "rgba(0,0,0,0.5)";
    ctx.lineWidth = 1;
    ctx.stroke();
  }
}

/** Wire pointer drag on the plot: picks the channel whose curve is nearest the
 * grab point, then feeds normalized (x,y) as the drag moves. */
function attachPlotDrag(
  canvas: HTMLCanvasElement,
  getProfile: () => GammaProfile,
  onDrag: (channel: number, x: number, y: number) => void,
  onEnd: () => void,
): void {
  const pad = 10;
  const w = PLOT_W - pad * 2;
  const h = PLOT_H - pad * 2;
  let channel = -1;

  const toNorm = (ev: PointerEvent): { x: number; y: number } => {
    const r = canvas.getBoundingClientRect();
    const cx = ((ev.clientX - r.left) / r.width) * PLOT_W;
    const cy = ((ev.clientY - r.top) / r.height) * PLOT_H;
    return {
      x: Math.min(1, Math.max(0, (cx - pad) / w)),
      y: Math.min(1, Math.max(0, 1 - (cy - pad) / h)),
    };
  };

  canvas.addEventListener("pointerdown", (ev) => {
    const { x, y } = toNorm(ev);
    // Pick the channel whose transfer curve passes closest to the grab point.
    const p = getProfile();
    let best = 0;
    let bestD = Infinity;
    for (let c = 0; c < 3; c++) {
      const d = Math.abs(transfer(p, c, x) - y);
      if (d < bestD) {
        bestD = d;
        best = c;
      }
    }
    channel = best;
    canvas.setPointerCapture(ev.pointerId);
    onDrag(channel, x, y);
    ev.preventDefault();
  });
  canvas.addEventListener("pointermove", (ev) => {
    if (channel < 0) return;
    const { x, y } = toNorm(ev);
    onDrag(channel, x, y);
  });
  const end = (ev: PointerEvent): void => {
    if (channel < 0) return;
    channel = -1;
    try {
      canvas.releasePointerCapture(ev.pointerId);
    } catch {
      /* pointer already released */
    }
    onEnd();
  };
  canvas.addEventListener("pointerup", end);
  canvas.addEventListener("pointercancel", end);
}

// ---------------------------------------------------------------------------
// Palette transfer simulator: a linear ramp and a hue sweep, each shown as the
// input, the forward-corrected (on-device) output, and the reverse transfer.
// ---------------------------------------------------------------------------

const SIM_W = 256;
const SIM_H = 26;

class PaletteSim {
  el: HTMLElement;
  private rampIn = document.createElement("canvas");
  private rampFwd = document.createElement("canvas");
  private rampRev = document.createElement("canvas");
  private hueIn = document.createElement("canvas");
  private hueFwd = document.createElement("canvas");

  constructor() {
    this.el = group("Palette transfer simulator");
    const hint = document.createElement("div");
    hint.className = "cc-hint";
    hint.textContent =
      "How the curves remap colors. Forward is what the strip shows for a given " +
      "input; reverse is the correction undone (the input needed for a linear result).";
    this.el.append(
      hint,
      simRow("Grayscale — input", this.rampIn),
      simRow("Grayscale — on device (forward)", this.rampFwd),
      simRow("Grayscale — reverse", this.rampRev),
      simRow("Hue sweep — input", this.hueIn),
      simRow("Hue sweep — on device (forward)", this.hueFwd),
    );
  }

  draw(p: GammaProfile): void {
    const lut = buildLut(p);
    const [fR, fG, fB] = lut;
    const iR = inverseLut(fR);
    const iG = inverseLut(fG);
    const iB = inverseLut(fB);
    const rgb = (r: number, g: number, b: number): [number, number, number] => [r, g, b];

    // grayscale ramp: input value v on all channels
    this.paint(this.rampIn, (v) => rgb(v, v, v));
    this.paint(this.rampFwd, (v) => rgb(fR[v]!, fG[v]!, fB[v]!));
    this.paint(this.rampRev, (v) => rgb(iR[v]!, iG[v]!, iB[v]!));

    // hue sweep: full-saturation hue across the bar, then corrected
    this.paint(this.hueIn, (v) => hueRgb(v / 255));
    this.paint(this.hueFwd, (v) => {
      const [r, g, b] = hueRgb(v / 255);
      return rgb(fR[r]!, fG[g]!, fB[b]!);
    });
  }

  private paint(canvas: HTMLCanvasElement, at: (v: number) => [number, number, number]): void {
    const ctx = fitCanvas(canvas, SIM_W, SIM_H);
    if (!ctx) return;
    const img = ctx.createImageData(SIM_W, 1);
    for (let x = 0; x < SIM_W; x++) {
      const [r, g, b] = at(x);
      img.data[x * 4] = r;
      img.data[x * 4 + 1] = g;
      img.data[x * 4 + 2] = b;
      img.data[x * 4 + 3] = 255;
    }
    // stretch the 1px row down the bar
    const tmp = document.createElement("canvas");
    tmp.width = SIM_W;
    tmp.height = 1;
    tmp.getContext("2d")?.putImageData(img, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(tmp, 0, 0, SIM_W, 1, 0, 0, SIM_W, SIM_H);
  }
}

function simRow(label: string, canvas: HTMLCanvasElement): HTMLElement {
  canvas.className = "cc-sim-bar";
  const r = document.createElement("div");
  r.className = "cc-sim-row";
  const cap = document.createElement("div");
  cap.className = "cc-sim-cap";
  cap.textContent = label;
  r.append(cap, canvas);
  return r;
}

/** Full-saturation, full-value hue at h in [0,1) -> [r,g,b] 0..255. */
function hueRgb(h: number): [number, number, number] {
  const s = 1;
  const v = 1;
  const i = Math.floor(h * 6);
  const f = h * 6 - i;
  const p = v * (1 - s);
  const q = v * (1 - f * s);
  const t = v * (1 - (1 - f) * s);
  let r = 0;
  let g = 0;
  let b = 0;
  switch (i % 6) {
    case 0:
      [r, g, b] = [v, t, p];
      break;
    case 1:
      [r, g, b] = [q, v, p];
      break;
    case 2:
      [r, g, b] = [p, v, t];
      break;
    case 3:
      [r, g, b] = [p, q, v];
      break;
    case 4:
      [r, g, b] = [t, p, v];
      break;
    default:
      [r, g, b] = [v, p, q];
      break;
  }
  return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
}

// ---------------------------------------------------------------------------
// small local builders (mirrors the settings screen's group/row helpers)
// ---------------------------------------------------------------------------

function group(legend: string): HTMLElement {
  const card = Card();
  card.classList.add("cc-group");
  const l = document.createElement("div");
  l.className = "cc-legend";
  l.textContent = legend;
  card.appendChild(l);
  return card;
}

function row(name: string, hint: string, control: HTMLElement): HTMLElement {
  const r = document.createElement("div");
  r.className = "cc-row";
  const label = document.createElement("div");
  label.className = "cc-row-label";
  const n = document.createElement("div");
  n.className = "cc-row-name";
  n.textContent = name;
  const h = document.createElement("div");
  h.className = "cc-row-hint";
  h.textContent = hint;
  label.append(n, h);
  const ctl = document.createElement("div");
  ctl.className = "cc-row-ctl";
  ctl.appendChild(control);
  r.append(label, ctl);
  return r;
}

function fullRow(control: HTMLElement): HTMLElement {
  const r = document.createElement("div");
  r.className = "cc-row cc-full";
  r.appendChild(control);
  return r;
}

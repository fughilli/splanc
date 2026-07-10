/**
 * Virtual LED wall — hardware-free test fixture for the live solver.
 *
 * Renders a flat (planar) array of virtual LEDs fullscreen on a laptop/monitor
 * and blinks them with the EXACT Gray-code frame plan the real M1 driver
 * emits, synchronized to the server's pattern clock:
 *
 *   1. connect to the same WebSocket control plane as the phone (§7),
 *   2. SNTP clock sync (§7.3) — the wall learns the server-clock offset,
 *   3. poll `get_pattern` — when the phone starts a capture, the server
 *      stamps `patternClockEpoch`; the wall adopts it (and the ledCount)
 *      and starts blinking. The wall FOLLOWS the clock; it owns nothing.
 *
 * The phone is then pointed at the screen exactly as it would be at a real
 * fixture. Since the wall is planar and grid-regular, the reconstruction can
 * be sanity-checked with the §1 shape-consistency criteria (coplanarity,
 * collinearity, uniform spacing) without measuring anything.
 *
 * Query params: ?cols=N (default ~square), &gap=px, &margin=px, &dot=frac,
 * &only=id (single-LED study mode: only that LED renders, the rest stay
 * dark — layout/ids unchanged), &url=ws://... (defaults to this page's
 * origin). The blink code itself is the hue carrier: every dot stays LIT at
 * constant brightness and the code is in COLOR (ALL_ON white, ALL_OFF
 * green, data frames from the negotiated symbol palette — see code/gray.ts).
 */

import type { CodeParams } from "@ledmapper/protocol";
import { colorForFrame, cssColor } from "../code/gray";
import { frameIndexAt } from "../code/timing";
import { defaultWsUrl, LedMapperClient } from "../net/client";

const qs = new URLSearchParams(location.search);
const OPT = {
  cols: intParam("cols", 0), // 0 = auto (near-square, wide)
  gapPx: intParam("gap", 0), // 0 = auto
  marginPx: intParam("margin", 48),
  dotFrac: floatParam("dot", 0.35), // LED diameter as a fraction of cell pitch
  only: intParam("only", -1), // >= 0: single-LED study mode
  wsUrl: qs.get("url") ?? defaultWsUrl(),
};

// The palette lives with the coding logic (code/gray.ts), shared with the
// phone decoder's expectations and golden-pinned to the Python driver.

function intParam(name: string, dflt: number): number {
  const v = qs.get(name);
  const n = v === null ? NaN : parseInt(v, 10);
  return Number.isFinite(n) ? n : dflt;
}
function floatParam(name: string, dflt: number): number {
  const v = qs.get(name);
  const n = v === null ? NaN : parseFloat(v);
  return Number.isFinite(n) ? n : dflt;
}

const canvas = document.getElementById("wall") as HTMLCanvasElement;
const ctx = canvas.getContext("2d")!;
const statusEl = document.getElementById("status")!;
const hintEl = document.getElementById("hint")!;

interface Layout {
  cols: number;
  rows: number;
  pitch: number;
  dotR: number;
  x0: number;
  y0: number;
}

interface WallState {
  connected: boolean;
  synced: boolean;
  offsetMs: number;
  rttMs: number;
  active: boolean;
  epochMs: number | null;
  params: CodeParams | null;
  lastFrameIndex: number;
}

const state: WallState = {
  connected: false,
  synced: false,
  offsetMs: 0,
  rttMs: Infinity,
  active: false,
  epochMs: null,
  params: null,
  lastFrameIndex: -1,
};

// -- layout -----------------------------------------------------------------

function layoutFor(ledCount: number): Layout {
  const w = canvas.width;
  const h = canvas.height;
  const availW = w - 2 * OPT.marginPx;
  const availH = h - 2 * OPT.marginPx;
  let cols = OPT.cols;
  if (cols <= 0) {
    // Near-square grid matching the viewport aspect.
    cols = Math.max(1, Math.round(Math.sqrt((ledCount * availW) / availH)));
  }
  const rows = Math.ceil(ledCount / cols);
  const pitch = Math.min(availW / cols, availH / rows);
  const gridW = pitch * cols;
  const gridH = pitch * rows;
  return {
    cols,
    rows,
    pitch,
    dotR: (pitch * OPT.dotFrac) / 2,
    x0: (w - gridW) / 2 + pitch / 2,
    y0: (h - gridH) / 2 + pitch / 2,
  };
}

/** Row-major LED center in canvas px. Row 0 is the TOP row. */
function ledCenter(l: Layout, id: number): { x: number; y: number } {
  const row = Math.floor(id / l.cols);
  const col = id % l.cols;
  return { x: l.x0 + col * l.pitch, y: l.y0 + row * l.pitch };
}

function resize(): void {
  canvas.width = window.innerWidth * devicePixelRatio;
  canvas.height = window.innerHeight * devicePixelRatio;
  canvas.style.width = `${window.innerWidth}px`;
  canvas.style.height = `${window.innerHeight}px`;
  state.lastFrameIndex = -1; // force redraw
}
window.addEventListener("resize", resize);
resize();

// -- rendering ----------------------------------------------------------------

function draw(frameIndex: number): void {
  const params = state.params;
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  if (!params) return;
  const l = layoutFor(params.ledCount);
  for (let id = 0; id < params.ledCount; id++) {
    const inStudy = OPT.only < 0 || id === OPT.only;
    const { x, y } = ledCenter(l, id);
    ctx.beginPath();
    ctx.arc(x, y, l.dotR, 0, Math.PI * 2);
    if (frameIndex >= 0 && inStudy) {
      // Hue carrier: constant full brightness, the code is in the color.
      const color = cssColor(colorForFrame(id, frameIndex, params));
      ctx.fillStyle = color;
      ctx.shadowColor = color;
      ctx.shadowBlur = l.dotR * 0.8; // a soft halo reads more like a real LED
    } else {
      // Idle dots barely visible for framing; must stay below the detector
      // threshold (which keys on max channel ≥ ~0.6).
      ctx.fillStyle = frameIndex >= 0 ? "#000" : "#1a1a1a";
      ctx.shadowBlur = 0;
    }
    ctx.fill();
    ctx.shadowBlur = 0;
  }
}

function renderLoop(): void {
  requestAnimationFrame(renderLoop);
  if (!state.active || state.epochMs === null || !state.params || !state.synced) {
    if (state.lastFrameIndex !== -1) {
      state.lastFrameIndex = -1;
      draw(-1);
    }
    return;
  }
  const tServer = performance.now() + state.offsetMs;
  const idx = frameIndexAt(tServer, state.epochMs, state.params);
  if (idx !== state.lastFrameIndex) {
    state.lastFrameIndex = idx;
    draw(idx);
  }
}

function updateStatus(): void {
  const bits: string[] = [];
  bits.push(state.connected ? "connected" : "connecting…");
  if (state.synced) bits.push(`offset ${state.offsetMs.toFixed(1)} ms · rtt ${state.rttMs.toFixed(1)} ms`);
  if (state.params) {
    const l = layoutFor(state.params.ledCount);
    bits.push(`${state.params.ledCount} LEDs (${l.cols}×${l.rows})`);
  }
  if (OPT.only >= 0) bits.push(`STUDY MODE: only LED #${OPT.only}`);
  if (state.params) bits.push(`${state.params.symbols}-symbol hue code`);
  bits.push(state.active ? "PATTERN RUNNING" : "idle — start mapping from the phone");
  statusEl.textContent = bits.join("  ·  ");
}

// -- ground-truth export (shape checks need no absolute scale) ---------------

function groundTruth(): unknown {
  if (!state.params) return null;
  const l = layoutFor(state.params.ledCount);
  const leds = [];
  for (let id = 0; id < state.params.ledCount; id++) {
    const c = ledCenter(l, id);
    // Pitch-normalized planar coordinates (z=0): comparable to a
    // reconstruction up to a similarity transform.
    leds.push({ id, xyz: [c.x / l.pitch, c.y / l.pitch, 0] });
  }
  return { kind: "virtual_wall", cols: l.cols, rows: l.rows, units: "led_pitch", leds };
}

// Publish the layout to the server whenever it (re)settles, so the capture
// app's result view can overlay the EXACT truth — including the ragged last
// row of a non-square count — without anyone re-typing grid dimensions.
let publishedSig = "";
function publishTruth(): void {
  // Only while a capture runs: when idle the wall lays out the SERVER
  // DEFAULT code-book (e.g. 1024 LEDs), which is not this session's fixture —
  // publishing it would overwrite the real truth the result view fetches.
  if (!state.active) return;
  const gt = groundTruth() as { cols: number; rows: number } | null;
  if (gt === null || state.params === null) return;
  const sig = `${state.params.ledCount}:${gt.cols}x${gt.rows}`;
  if (sig === publishedSig) return;
  publishedSig = sig;
  fetch("/truth", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(gt),
  }).catch(() => {
    publishedSig = ""; // retry on the next tick
  });
}

(document.getElementById("truth") as HTMLButtonElement).addEventListener("click", () => {
  const blob = new Blob([JSON.stringify(groundTruth(), null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "wall-ground-truth.json";
  a.click();
  URL.revokeObjectURL(a.href);
});

(document.getElementById("fullscreen") as HTMLButtonElement).addEventListener("click", () => {
  void document.documentElement.requestFullscreen();
});
document.addEventListener("fullscreenchange", () => {
  document.body.classList.toggle("fullscreen", document.fullscreenElement !== null);
});

// -- control plane ------------------------------------------------------------

async function main(): Promise<void> {
  const client = new LedMapperClient(OPT.wsUrl, { clientName: "virtual-wall" });
  client.events = {
    onConnected: () => {
      state.connected = true;
      updateStatus();
    },
    onDisconnected: () => {
      state.connected = false;
      state.synced = false;
      updateStatus();
    },
  };

  hintEl.textContent = `control plane: ${OPT.wsUrl}`;
  try {
    await client.connect();
  } catch {
    // connect() retries internally; onConnected will fire eventually.
  }

  // Periodic clock sync + pattern poll. The pattern is self-clocking on the
  // phone side, so ~1 s of poll latency at mapping start is harmless.
  const tick = async (): Promise<void> => {
    if (client.isConnected) {
      try {
        if (!state.synced || Math.random() < 0.1) {
          const s = await client.syncClock(state.synced ? 3 : 8);
          state.offsetMs = s.offsetMs;
          state.rttMs = s.rttMs;
          state.synced = true;
        }
        const p = await client.getPattern();
        state.active = p.active && p.patternClockEpoch !== null;
        state.epochMs = p.patternClockEpoch;
        state.params = p.codeParams;
        publishTruth();
      } catch {
        // disconnected mid-poll; the client reconnects on its own
      }
    }
    updateStatus();
    setTimeout(() => void tick(), 1000);
  };
  void tick();
  renderLoop();
}

void main();

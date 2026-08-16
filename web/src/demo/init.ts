/**
 * Demo / capture mode (FUG-103 documentation screenshots).
 *
 * Activated ONLY by a `?demo=<scenario[,scenario…]>` query flag (see
 * `ui/app/main.ts`), and lazy-imported, so it is a complete no-op in every
 * normal load and never ships in the hot path. It drives the app into the
 * hardware-dependent states a headless browser can't reach for real, so the
 * user-guide capturer (`docs/capture_user_guide.py`) can screenshot them:
 *
 *   device     — a connected controller ("Living Room") with a plausible RTT,
 *                so the device sheet shows real connection status + latency.
 *   bluetooth  — a Web Bluetooth seam so the add-device BLE button appears
 *                (instead of the "not available in this browser" note).
 *   camera     — a simulated camera frame for the mapping/capture screen.
 *
 * These are genuine seams into the real stores/clients — no production path
 * calls them. Each scenario is independent so a shot can combine them
 * (`?demo=device,bluetooth`).
 */

import { appState } from "../ui/app/state";
import { deviceStore } from "../store/deviceStore";
import { LedMapperClient } from "../net/client";

/** Canvas that also exposes captureStream (not in the base DOM lib types). */
type CaptureCanvas = HTMLCanvasElement & { captureStream(fps?: number): MediaStream };

export function initDemoMode(scenarios: Set<string>): void {
  if (scenarios.has("device")) setupConnectedDevice();
  if (scenarios.has("bluetooth")) setupWebBluetooth();
  if (scenarios.has("camera")) setupFakeCamera();
  if (scenarios.has("effect")) setupEffectEditor();
  if (scenarios.has("flash")) setupFlashDemo();
}

/** Open the flash sheet showing a simulated ESP32-C6 esptool log (see
 * flashSheet.enableDemoFlash). Deferred so it lands over the mounted shell. */
function setupFlashDemo(): void {
  void import("../ui/screens/flashSheet").then((m) => {
    m.enableDemoFlash();
    setTimeout(() => void m.openFlashSheet(), 500);
  });
}

/** Inject a connected controller with a fixed RTT. The device sheet renders the
 * active client's `clock.rttMs` as "connected · N ms RTT" (deviceSheet.ts). */
function setupConnectedDevice(): void {
  const dev = deviceStore.upsert("wss://living-room.local:8443/ws", "Living Room");
  deviceStore.setActive(dev.id);
  const client = new LedMapperClient(dev.wssUrl);
  client.clock.update({ offsetMs: 0, rttMs: 24 });
  // The device sheet only shows the RTT when the active client reports connected
  // (connectedMeta in deviceSheet.ts). There's no real socket here, so force it.
  Object.defineProperty(client, "isConnected", { configurable: true, get: () => true });
  appState.setDemoConnection(client, {
    state: "connected",
    text: "connected",
    certUrl: null,
    error: null,
  });
}

/** Provide a minimal `navigator.bluetooth` so `bleAvailable()` (net/improv.ts)
 * is true and the add-device flow offers the Bluetooth button. */
function setupWebBluetooth(): void {
  if (typeof navigator === "undefined" || "bluetooth" in navigator) return;
  Object.defineProperty(navigator, "bluetooth", {
    configurable: true,
    value: {
      getAvailability: async (): Promise<boolean> => true,
      // Never actually invoked in a still screenshot; present so the API "exists".
      requestDevice: async (): Promise<never> => {
        throw new DOMException("demo mode", "NotFoundError");
      },
    },
  });
}

/** Feed a simulated fixture frame to the capture screen by returning a canvas
 * stream from getUserMedia — a dim room with a bright Y-fixture of LEDs. */
function setupFakeCamera(): void {
  if (typeof navigator === "undefined" || !navigator.mediaDevices) return;
  const canvas = document.createElement("canvas") as CaptureCanvas;
  canvas.width = 1280;
  canvas.height = 720;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  // A three-armed "Y" of LEDs (echoing the sample map), each a soft green dot,
  // over a dark room — reads clearly as "a fixture seen through the camera".
  const cx = canvas.width / 2;
  const cy = canvas.height / 2;
  const arms: [number, number][] = [
    [-140, -230],
    [220, 60],
    [-60, 250],
  ];
  ctx.fillStyle = "#0a0a0e";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  for (const [dx, dy] of arms) {
    for (let i = 1; i <= 10; i++) {
      const x = cx + (dx * i) / 10;
      const y = cy + (dy * i) / 10;
      const g = ctx.createRadialGradient(x, y, 0, x, y, 16);
      g.addColorStop(0, "rgba(120,255,150,0.95)");
      g.addColorStop(1, "rgba(120,255,150,0)");
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(x, y, 16, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  const stream = canvas.captureStream(30);
  const md = navigator.mediaDevices as MediaDevices & {
    getUserMedia: (c?: MediaStreamConstraints) => Promise<MediaStream>;
  };
  md.getUserMedia = async () => stream;
}

/**
 * Make the effect editor render its docked workspace with a compiled sample —
 * status, Uniforms panel and Disassembly all populated — WITHOUT the off-thread
 * wasm compiler (which 404s on the headless static server). We intercept the
 * `new Worker(new URL("./compile-worker.ts", …))` construction and hand back a
 * fake worker that answers `compile`/`disassemble` with a canned result. (The
 * live LED preview still needs the fx-vm wasm bundle served — a follow-up once
 * container memory allows building it; see WORKLOG.) */
function setupEffectEditor(): void {
  const Orig = globalThis.Worker;
  if (!Orig) return;
  const compiled = {
    ok: true,
    // A short, valid-looking .fxb-ish blob; only its length is shown in the UI.
    bytecode: new Uint8Array([0x46, 0x58, 0x42, 0x31, 0x10, 0x00, 0x2a, 0x07, 0x00, 0x00]),
    uniforms: [
      { name: "speed", slot: 0, width: 1, ui: { kind: "slider", min: 0, max: 5, step: 0.01 }, default: [1.5] },
      { name: "glow", slot: 1, width: 1, ui: { kind: "slider", min: 0, max: 1, step: 0.01 }, default: [0.35] },
      { name: "tint", slot: 2, width: 3, ui: { kind: "color" }, default: [0.95, 0.45, 0.12] },
    ],
    diagnostics: [] as { line: number; col: number; msg: string }[],
  };
  const disasm = [
    "; demo disassembly (mocked compiler)",
    "update:",
    "  load_ctx   time            ; t",
    "  push_f     1.500000        ; speed",
    "  mul                        ; phase = t * speed",
    "  store      g0",
    "shade:",
    "  load_ctx   led.pos.x",
    "  load       g0",
    "  add",
    "  hsv2rgb                    ; -> colour",
    "  ret_rgb",
  ].join("\n");

  const fake = (): Worker => {
    const w: {
      onmessage: ((ev: { data: unknown }) => void) | null;
      postMessage: (req: { id: number; kind?: string }) => void;
      terminate: () => void;
      addEventListener: () => void;
      removeEventListener: () => void;
    } = {
      onmessage: null,
      postMessage(req) {
        const resp =
          req.kind === "disassemble"
            ? { id: req.id, kind: "disassemble", text: disasm }
            : { id: req.id, kind: "compile", result: compiled };
        setTimeout(() => w.onmessage?.({ data: resp }), 40);
      },
      terminate() {},
      addEventListener() {},
      removeEventListener() {},
    };
    return w as unknown as Worker;
  };

  const Patched = function (this: unknown, url: string | URL, opts?: WorkerOptions): Worker {
    if (String(url).includes("compile-worker")) return fake();
    return new Orig(url, opts);
  } as unknown as typeof Worker;
  globalThis.Worker = Patched;
}

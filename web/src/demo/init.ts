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
}

/** Inject a connected controller with a fixed RTT. The device sheet renders the
 * active client's `clock.rttMs` as "connected · N ms RTT" (deviceSheet.ts). */
function setupConnectedDevice(): void {
  const dev = deviceStore.upsert("wss://living-room.local:8443/ws", "Living Room");
  deviceStore.setActive(dev.id);
  const client = new LedMapperClient(dev.wssUrl);
  client.clock.update({ offsetMs: 0, rttMs: 24 });
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

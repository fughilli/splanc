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
 *   fxstub     — effect compiles answered from the declared uniforms (no
 *                compiler wasm on a static screenshot server).
 *   devmap-none / devmap-saved / devmap-unsaved — `device`, plus a stored map
 *                on it (none; one this phone already has; one it doesn't) and a
 *                running IMU, for the Maps tab's "On <device>" card.
 *   imu        — (with `device`) the connected controller has a running motion
 *                sensor, no saved capture settings, and answers the capture
 *                requests, so `#/capture?calibrate=__demo__` (the first library
 *                map) renders the Calibrate-IMU screen with its controls.
 *   mesh       — (with `device`) the controller is a mesh gateway with two other
 *                fixtures meshed with it (the device sheet's Mesh section, mesh M5).
 *   discovered — fixtures heard on the network (net/discovery.ts): two new ones
 *                ("Porch Arch", "Stair Rail") and a known "Kitchen" at a new
 *                address, so the lists show "On this network".
 *   stale      — a known "Bedroom" that was looked for and not found (a fixture
 *                moved to another Wi-Fi), so its row shows what to do about it.
 *   nousb      — no Web Serial / WebUSB (an iPhone-like browser), so "Flash a
 *                new device" shows the plug-into-a-laptop pictogram.
 *   play / play-revert / play-nomap / play-off — Halloween play mode: a
 *                connected "SpookySplanc1" in kiosk mode (countdown 1:42) with a
 *                stored map; `play-revert` fires an idle revert after 5 s;
 *                `play-nomap` has no stored map; `play-off` is not connected.
 *
 * These are genuine seams into the real stores/clients — no production path
 * calls them. Each scenario is independent so a shot can combine them
 * (`?demo=device,bluetooth`).
 */

import { appState } from "../ui/app/state";
import { deviceStore } from "../store/deviceStore";
import { LedMapperClient, ServerErrorReply } from "../net/client";
import { decodeMappingBundle, encodeMappingBundle } from "../net/proto";
import { mapStore } from "../store/mapStore";

/** Canvas that also exposes captureStream (not in the base DOM lib types). */
type CaptureCanvas = HTMLCanvasElement & { captureStream(fps?: number): MediaStream };

export function initDemoMode(scenarios: Set<string>): void {
  const devmap = [...scenarios].find((s) => s.startsWith("devmap-"))?.slice("devmap-".length);
  if (scenarios.has("device") || devmap) setupConnectedDevice();
  // `fxstub`: answer effect compiles from the declared uniforms (the static
  // screenshot server has no compiler wasm), e.g. for the Effects tab's tune sheet.
  if (scenarios.has("fxstub")) {
    stubPresetCompiler();
    // ...and the demo controller takes the upload (no socket behind it).
    const c = appState.client as unknown as Record<string, unknown> | null;
    if (c) {
      c["submitEffect"] = async (effectId: string) => ({ type: "result_ready", id: effectId });
      c["setUniforms"] = () => true;
    }
  }
  if (devmap) setupDeviceMap(devmap);
  if (scenarios.has("bluetooth")) setupWebBluetooth();
  if (scenarios.has("camera")) setupFakeCamera();
  if (scenarios.has("effect")) setupEffectEditor();
  if (scenarios.has("flash")) setupFlashDemo();
  if (scenarios.has("imu")) setupImuDemo();
  if (scenarios.has("mesh")) setupMeshDemo();
  if (scenarios.has("discovered")) void setupDiscovered();
  if (scenarios.has("stale")) void setupStale();
  if (scenarios.has("nousb")) setupNoUsb();
  const play = [...scenarios].find((s) => s === "play" || s.startsWith("play-"));
  if (play) void setupPlayDemo(play);
}

/** The compiler wasm isn't served by the static screenshot server: answer the
 * play screen's compiles with the scalar uniforms declared in the source (enough
 * for the tiles' sliders). */
function stubPresetCompiler(): void {
  const Orig = globalThis.Worker;
  if (!Orig) return;
  const compile = (src: string): unknown => {
    const sliders = [...src.matchAll(/uniform\s+(?:float|int)\s+(\w+)\s*:\s*([-\d.]+)\s*\.\.\s*([-\d.]+)\s*=\s*([-\d.]+)/g)].map(
      (m) => ({
        at: m.index ?? 0,
        name: m[1],
        width: 1,
        ui: { kind: "slider", min: Number(m[2]), max: Number(m[3]), step: 0.01 },
        default: [Number(m[4])],
      }),
    );
    // `uniform vec3 tint : color = r, g, b;` (the tune sheet's colour rows).
    const colors = [...src.matchAll(/uniform\s+vec3\s+(\w+)\s*:\s*color\s*=\s*([-\d.]+)\s*,\s*([-\d.]+)\s*,\s*([-\d.]+)/g)].map(
      (m) => ({
        at: m.index ?? 0,
        name: m[1],
        width: 3,
        ui: { kind: "color" },
        default: [Number(m[2]), Number(m[3]), Number(m[4])],
      }),
    );
    const uniforms = [...sliders, ...colors]
      .sort((a, b) => a.at - b.at)
      .map(({ at: _at, ...u }, i) => ({ ...u, slot: i }));
    return { ok: true, bytecode: new Uint8Array([0x46, 0x58, 0x42, 0x31]), uniforms, diagnostics: [] };
  };
  globalThis.Worker = function (this: unknown, url: string | URL, opts?: WorkerOptions): Worker {
    if (!String(url).includes("compile-worker")) return new Orig(url, opts);
    const w = {
      onmessage: null as ((ev: { data: unknown }) => void) | null,
      postMessage(req: { id: number; kind?: string; src: string }) {
        if (req.kind === "warm") return;
        setTimeout(() => w.onmessage?.({ data: { id: req.id, kind: "compile", result: compile(req.src) } }), 20);
      },
      terminate() {},
      addEventListener() {},
      removeEventListener() {},
    };
    return w as unknown as Worker;
  } as unknown as typeof Worker;
}

/** Halloween play mode with a kiosk-mode fixture (see the header). */
async function setupPlayDemo(kind: string): Promise<void> {
  setupWebBluetooth();
  if (kind === "play-off") return;
  const dev = deviceStore.upsert("ble:demo-spooky-1", "SpookySplanc1");
  deviceStore.setActive(dev.id);
  const client = new LedMapperClient(dev.wssUrl);
  Object.defineProperty(client, "isConnected", { configurable: true, get: () => true });
  appState.setDemoConnection(client, { state: "connected", text: "connected", certUrl: null, error: null });
  setupDeviceMap(kind === "play-nomap" ? "none" : "saved");
  const kiosk = {
    enabled: true,
    idleTimeoutS: 120,
    idleRemainingS: 102,
    attractActive: false,
    hasAttract: true,
    attractName: "boo-haunted-glow",
    attractBrightness: 0.6,
    ownerUnlocked: false,
    hasSecret: true,
    event: "KIOSK_EVENT_NONE",
  };
  const welcome = {
    type: "welcome",
    sessionId: "demo",
    deviceName: "SpookySplanc1",
    mac: "AA:BB:CC:00:0B:01",
    features: ["effects", "stored_map", "decks", "kiosk", "uniform_commit"],
    codeParams: { ledCount: 64 },
    kiosk,
  };
  Object.defineProperty(client, "welcome", { configurable: true, get: () => welcome });
  const c = client as unknown as Record<string, unknown>;
  c["submitEffect"] = async (effectId: string) => ({ type: "result_ready", id: effectId });
  c["setUniforms"] = () => true;
  c["getKioskStatus"] = async () => ({ type: "kiosk_status", ...kiosk });
  stubPresetCompiler();
  const { kioskStore } = await import("../halloween/kioskStore");
  const { normalizeKioskStatus } = await import("../net/kiosk");
  kioskStore.start();
  kioskStore.apply(normalizeKioskStatus(kiosk)!);
  if (kind === "play-revert") {
    const reverted = { ...kiosk, idleRemainingS: 0, attractActive: true, event: "KIOSK_EVENT_REVERTED" };
    setTimeout(() => kioskStore.apply(normalizeKioskStatus(reverted)!), 5000);
  }
}

/** The Calibrate-IMU screen without hardware (sensor-core.md §7.3): stub the
 * demo client's capture + sensor requests and resolve `__demo__` to the first
 * library map. */
function setupImuDemo(): void {
  const c = appState.client as unknown as Record<string, unknown> | null;
  if (c === null) return;
  const codeParams = {
    ledCount: 30,
    bits: 9,
    encoding: "hue",
    symbols: 4,
    bitPeriodMs: 66,
    syncPattern: "on_off",
    cycleFrames: 7,
    brightness: 0.6,
  };
  c["getCaptureProfile"] = async () => ({ mapId: "" }); // a map from before profiles
  c["syncClock"] = async () => ({ offsetMs: 0, rttMs: 24 });
  c["startMapping"] = async () => ({ type: "mapping_started", patternClockEpoch: 0, codeParams });
  c["configure"] = async () => ({ type: "pattern_state", active: true, patternClockEpoch: 0, codeParams });
  c["stopMappingNoSolve"] = async () => ({ type: "mapping_stopped" });
  c["getSensors"] = async () => ({
    type: "sensor_state",
    status: "SENSOR_STATUS_RUNNING",
    part: "MPU-6050",
    atRest: true,
    restUpImu: [0.02, -0.01, 0.999],
    restUpSigmaDeg: 0.3,
    restSamples: 240,
    mountQuat: [1, 0, 0, 0],
    gravity: [0, 0, -1],
  });
  const get = mapStore.get.bind(mapStore);
  (mapStore as unknown as { get: typeof mapStore.get }).get = async (id: string) => {
    if (id !== "__demo__") return get(id);
    const first = (await mapStore.list())[0];
    return first ? get(first.id) : undefined;
  };
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

/** The demo controller is a mesh gateway with two others meshed with it (mesh M5). */
function setupMeshDemo(): void {
  const client = appState.client;
  if (!client) return;
  const state = {
    on: true,
    member: true,
    node: 0x3a41,
    meshId: 0x5e1f00d1,
    channel: 6,
    gateway: true,
    envelopeTrust: true,
    sync: 2,
    timeErrUs: 41,
    epochGen: 1,
    members: [
      { node: 0x7c02, rssi: -38, seenMsAgo: 400, fps: 80, sync: 2 },
      { node: 0x91e4, rssi: -44, seenMsAgo: 700, fps: 80, sync: 2 },
    ],
  };
  // A mesh-variant player says so in welcome.features (the app's mesh UI is gated on it).
  const base = client.welcome;
  const welcome = { ...base, features: [...(base?.features ?? []), "mesh"] };
  Object.defineProperty(client, "welcome", { configurable: true, get: () => welcome });
  const c = client as unknown as Record<string, unknown>;
  c["getMesh"] = async () => {
    c["meshState_"] = state;
    return state;
  };
}

/** Give the demo controller a stored map + running IMU (the Maps tab's device
 * card): `none` = nothing stored, `saved` = the first library map (so the card
 * matches it), `unsaved` = the same geometry under a new id with a few LEDs
 * unmapped. */
function setupDeviceMap(kind: string): void {
  const client = appState.client;
  if (!client) return;
  const welcome = {
    type: "welcome",
    sessionId: "demo",
    deviceName: "Living Room",
    mac: "AA:BB:CC:12:34:56",
    features: ["effects", "stored_map", "sensors", "imu_extrinsic"],
    codeParams: { ledCount: 64 },
  };
  Object.defineProperty(client, "welcome", { configurable: true, get: () => welcome });
  let bytes: Promise<Uint8Array> | null = null;
  const stored = (): Promise<Uint8Array> =>
    (bytes ??= (async () => {
      // The app seeds its sample maps at boot; wait for one.
      for (let i = 0; i < 50; i++) {
        const first = (await mapStore.list({ sort: "name" }))[0];
        const rec = first && (await mapStore.get(first.id));
        if (rec) {
          const map = { ...rec.map };
          if (kind === "unsaved") {
            map.mapId = "demo-device-map";
            map.createdAt = "2026-09-14T19:20:00Z";
            map.unmapped = map.leds.slice(0, 6).map((l) => l.id);
            map.leds = map.leds.slice(6);
          }
          const topology = rec.topology ?? { mapId: map.mapId, branchPoints: [], segments: [], associations: [] };
          return encodeMappingBundle({ map, topology });
        }
        await new Promise((r) => setTimeout(r, 100));
      }
      throw new Error("no sample map");
    })());
  const chunk = async (offset: number, len: number) => {
    if (kind === "none") throw new ServerErrorReply("no_map", "no stored map to dump");
    const b = await stored();
    return { totalLen: b.length, data: b.subarray(offset, Math.min(b.length, offset + len)) };
  };
  const c = client as unknown as Record<string, unknown>;
  c["peekStoredMap"] = async (peekLen = 192) => {
    const w = await chunk(0, peekLen);
    return { totalLen: w.totalLen, hasTopology: true, prefix: w.data };
  };
  c["pullStoredMap"] = async (onProgress?: (done: number, total: number) => void) => {
    const w = await chunk(0, Number.MAX_SAFE_INTEGER);
    onProgress?.(w.totalLen, w.totalLen);
    return decodeMappingBundle(w.data);
  };
  c["getSensors"] = async () => ({ type: "sensor_state", status: "SENSOR_STATUS_RUNNING" });
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
        if (req.kind === "warm") return;
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

/** Fixtures heard on the network (see the scenario list above). */
async function setupDiscovered(): Promise<void> {
  const { discovery } = await import("../net/discovery");
  const known = deviceStore.upsert("wss://192.168.1.23/ws", "Kitchen");
  deviceStore.applyWelcome(known.id, { mac: "AA:BB:CC:00:11:22", deviceName: "Kitchen" });
  const now = Date.now();
  const base = { source: "mdns" as const, seenAt: now, fw: "1.21.0" };
  discovery.report({ ...base, key: "AA:BB:CC:00:11:22", id: "AA:BB:CC:00:11:22", name: "Kitchen", host: "192.168.1.31", url: "wss://192.168.1.31/ws" });
  discovery.report({ ...base, key: "AA:BB:CC:33:44:55", id: "AA:BB:CC:33:44:55", name: "Porch Arch", host: "192.168.1.42", url: "wss://192.168.1.42/ws" });
  discovery.report({ ...base, key: "AA:BB:CC:66:77:88", id: "AA:BB:CC:66:77:88", name: "Stair Rail", host: "192.168.1.57", url: "wss://192.168.1.57/ws" });
}

/** A known fixture that isn't on this network (see the scenario list above). */
async function setupStale(): Promise<void> {
  const { deviceProber } = await import("../net/deviceProber");
  const dev = deviceStore.upsert("wss://192.168.1.77/ws", "Bedroom");
  deviceStore.applyWelcome(dev.id, { mac: "AA:BB:CC:99:00:77", deviceName: "Bedroom" });
  deviceProber.noteUnreachable(dev.id);
}

/** A browser without Web Serial or WebUSB (iPhone/iPad, Safari, Firefox). */
function setupNoUsb(): void {
  for (const k of ["serial", "usb"]) {
    try {
      delete (Navigator.prototype as unknown as Record<string, unknown>)[k];
      delete (navigator as unknown as Record<string, unknown>)[k];
    } catch {
      // not configurable here: the shot just shows the flasher instead
    }
  }
}

/**
 * App-driver control channel (phone-in-the-loop HITL).
 *
 * Reachable ONLY behind `?driver=<ws-url>` in `ui/app/main.ts`, dynamic-imported,
 * so it is a complete no-op in every normal load and never ships in the hot path
 * (the same guarantee the `?demo=` seam relies on). It opens a WebSocket to the
 * station harness and turns JSON commands into calls on the EXACT production
 * functions a user's taps would invoke — `appState.connect`, `provisionViaBle`,
 * `client.startMapping/stopMapping/setHardwareConfig/setColorCorrection`,
 * `router.navigate` — and streams app-state transitions + milestones back, so the
 * station can drive the real user journeys and assert on real replies.
 *
 * Wire protocol (one JSON object per WS frame):
 *   station → app : { id, kind:"command"|"query", method, params }
 *   app → station : { id, kind:"result"|"error", ok, value?|error? }
 *                   { kind:"event", event:"ready"|"state"|"milestone"|"error", … }
 */

import { requestBleDevice, bleSocketFactory } from "../net/bleTransport";
import { improvDeviceById, readGapDeviceName, scanImprovNative } from "../net/capacitorImprov";
import {
  provisionViaBle,
  requestImprovDevice,
  wsUrlFromRedirect,
  type ImprovDevice,
} from "../net/improv";
import { isNativePlatform } from "../net/native";
import { deviceStore } from "../store/deviceStore";
import { mapStore } from "../store/mapStore";
import { appState } from "../ui/app/state";
import type { Router } from "../ui/app/router";
import { driverCapture, setDriverActive } from "./guard";

type Json = Record<string, unknown>;

/** The wss URL of the most recently BLE-provisioned device, so a following `connect`
 * with no explicit URL dials it (the iOS bench reaches the C6 directly, rather than
 * via a rig-forwarded socket). Reset per provision. */
let lastProvisionedWss: string | null = null;

/** Headless native Improv pick for the HITL driver (no UI chooser): scan the
 * Capacitor BLE plugin for a short window and return the strongest-RSSI device,
 * which on the bench is the DUT right next to the phone. Adapts to the shared
 * `provisionViaBle` seam. Used only on iOS/native, where there is no Web Bluetooth. */
async function pickImprovDeviceHeadless(
  onStatus?: (s: string) => void,
  windowMs = 5000,
  wantName = "",
  timeoutMs = 70000,
): Promise<ImprovDevice> {
  // `wantName` PINS the pick to a specific advertised name. iOS (CoreBluetooth) never
  // exposes a peripheral's BLE MAC — only an opaque per-app UUID — so on a bench with
  // several Improv devices in range (the other rigs' C6s) the ONLY way to target the
  // reserved board is by its advertised name. When set we accept only that name (and
  // fail rather than silently provision a stray); when empty we keep the strongest-RSSI
  // pick (a real user has a single device, and the shipping app uses a visible picker).
  onStatus?.(wantName ? `scanning for "${wantName}" over Bluetooth…` : "scanning over Bluetooth…");
  const hits = new Map<string, { name: string; rssi: number }>();
  const scan = await scanImprovNative((h) => {
    // iOS delivers a peripheral's scan-response NAME on a LATER advertising callback
    // than its first discovery (the primary ADV carries only Flags + the Improv UUID).
    // Keep the best name seen — NEVER clobber a real name with a not-yet-named ("")
    // sighting — so the pinned-name match below succeeds once the name arrives.
    const prev = hits.get(h.deviceId);
    hits.set(h.deviceId, {
      name: h.name || prev?.name || "",
      rssi: h.rssi ?? prev?.rssi ?? -999,
    });
  });
  try {
    if (wantName) {
      // Crowded RF: 8+ "Led Widget <hex>" boards can advertise at once and OUR board may
      // take several scan cycles to surface. POLL until the pinned name appears rather
      // than snapshot one fixed window (a slow first sighting was a spurious "not found").
      const deadline = Date.now() + timeoutMs;
      // How many times we've connected-and-read each device for a GAP name. iOS
      // surfaces the name lazily after connect, so allow a few attempts per device
      // (not just one) before giving up on it.
      const probeCount = new Map<string, number>();
      const MAX_GAP_PROBES = 4;
      for (;;) {
        const match = [...hits.entries()].filter(([, v]) => v.name === wantName);
        const top = match.sort((a, b) => b[1].rssi - a[1].rssi)[0];
        if (top) {
          onStatus?.(`selected ${top[1].name} (rssi ${top[1].rssi})`);
          return improvDeviceById(top[0], top[1].name);
        }
        // No sighting carries the pinned name yet. On a coex-busy unprovisioned board
        // the scan-response name may NEVER arrive (coex starves its TX reply), so the
        // reserved board can sit here nameless forever. Connect to the strongest
        // not-yet-probed UNNAMED candidate and read its name over GATT (GAP 0x2A00,
        // which the firmware exposes independent of the scan response); fold the
        // resolved name back into `hits` so the match check above catches it next loop.
        const unnamed = [...hits.entries()]
          .filter(([id, v]) => !v.name && (probeCount.get(id) ?? 0) < MAX_GAP_PROBES)
          .sort((a, b) => b[1].rssi - a[1].rssi);
        if (unnamed[0]) {
          const [id, v] = unnamed[0];
          probeCount.set(id, (probeCount.get(id) ?? 0) + 1);
          onStatus?.(`reading name of an unnamed device over GATT (rssi ${v.rssi})…`);
          const gapName = await readGapDeviceName(id);
          if (gapName) {
            hits.set(id, { name: gapName, rssi: hits.get(id)?.rssi ?? v.rssi });
            continue; // re-evaluate the pinned-name match immediately
          }
        }
        if (Date.now() >= deadline) {
          const saw =
            [...hits.values()].map((v) => `${v.name || "(unnamed)"}@${v.rssi}`).join(", ") ||
            "none";
          throw new Error(`Improv device "${wantName}" not found over BLE (saw: ${saw})`);
        }
        await new Promise((r) => setTimeout(r, 400));
      }
    }
    await new Promise((r) => setTimeout(r, windowMs));
  } finally {
    await scan.stop();
  }
  const top = [...hits.entries()].sort((a, b) => b[1].rssi - a[1].rssi)[0];
  if (!top) throw new Error("no Improv device found over BLE");
  const [deviceId, best] = top;
  const label = best.name || "Splanc device";
  onStatus?.(`selected ${label} (rssi ${best.rssi})`);
  return improvDeviceById(deviceId, best.name || label);
}

interface Incoming {
  id?: string;
  kind: "command" | "query";
  method: string;
  params?: Json;
}

let sock: WebSocket | null = null;

function send(obj: Json): void {
  try {
    sock?.send(JSON.stringify(obj));
  } catch {
    // socket closed mid-run — the station observes the drop; nothing to do here.
  }
}

function emit(event: string, extra: Json = {}): void {
  send({ kind: "event", event, ...extra });
}

/** Serialize the app's connection state for `state` events + `appState` queries. */
function appStateSnapshot(): Json {
  const w = appState.welcome();
  return {
    status: appState.status,
    selectedMapId: appState.selectedMapId,
    hasClient: appState.client !== null,
    isConnected: appState.client?.isConnected ?? false,
    welcome: w ? { deviceName: w.deviceName, mac: w.mac } : null,
  };
}

async function handle(msg: Incoming): Promise<unknown> {
  const p = msg.params ?? {};
  const client = () => {
    if (!appState.client) throw new Error("no active device connection");
    return appState.client;
  };
  switch (msg.method) {
    // --- navigation -------------------------------------------------------
    case "navigate":
      driverRouter?.navigate(String(p.path ?? "/"));
      return { route: location.hash };

    // --- connect / pairing ------------------------------------------------
    case "connect": {
      // On the iOS bench the phone reaches the C6 directly, so the wss URL isn't a
      // rig-forwarded input — it's the address the device just reported over Improv.
      // Fall back to the last provisioned wss when the journey passes no explicit URL.
      const wssUrl = String(p.wssUrl || lastProvisionedWss || "");
      if (!wssUrl) throw new Error("connect: no wssUrl (and nothing provisioned yet)");
      appState.connect(wssUrl, p.label ? String(p.label) : undefined, {
        coldRetryLimit: 6,
      });
      return { connecting: true };
    }

    case "provisionBle": {
      // iOS (native) has no Web Bluetooth: provision over the Capacitor BLE plugin,
      // headlessly (no UI chooser) — scan for Improv and take the strongest-signal
      // device, which on the bench is the DUT inches from the phone. The browser/
      // emulator lane keeps the Web Bluetooth path.
      const dev = isNativePlatform()
        ? await pickImprovDeviceHeadless(
            (s) => emit("status", { where: "provision", message: s }),
            5000,
            String(p.deviceName ?? ""),
          )
        : await requestImprovDevice();
      const urls = await provisionViaBle(
        dev,
        String(p.ssid ?? ""),
        String(p.password ?? ""),
        (s) => emit("status", { where: "provision", message: s }),
      );
      emit("milestone", { name: "provisioned", detail: { urls } });
      const wssUrl = urls[0] ? wsUrlFromRedirect(urls[0]) : null;
      // Remember it so a following `connect` with no explicit URL dials this device
      // (the iOS bench path; see the connect case).
      lastProvisionedWss = wssUrl;
      return { urls, wssUrl };
    }

    case "connectBle": {
      const dev = await requestBleDevice();
      appState.connect("ble://virtual", p.label ? String(p.label) : "ble-device", {
        socketFactory: bleSocketFactory(dev),
        coldRetryLimit: 6,
      });
      return { connecting: true };
    }

    // --- mapping ----------------------------------------------------------
    case "startMapping": {
      const reply = await client().startMapping(Number(p.ledCount ?? 0), (p.config ?? {}) as Json);
      emit("milestone", { name: "mapping_started", detail: reply as unknown as Json });
      return reply;
    }
    case "stopMapping": {
      const reply = await client().stopMapping();
      emit("milestone", { name: "result_ready", detail: reply as unknown as Json });
      return reply;
    }

    // --- deep capture (the real screen: synthetic camera → detect → decode →
    // solve, not just the start/stop-mapping RPC). openCapture navigates to the
    // capture screen (it auto-starts and owns the mapping lifecycle); finishCapture
    // lets the synthetic sweep accumulate parallax, then ends it and returns the
    // SOLVED map (how many LED positions were actually recovered). ----------------
    case "openCapture": {
      const leds = Number(p.ledCount ?? 0);
      driverRouter?.navigate(leds > 0 ? `/capture?leds=${leds}` : "/capture");
      return { route: location.hash };
    }
    case "captureStats": {
      const ctrl = driverCapture();
      if (!ctrl) throw new Error("no capture screen mounted — send openCapture first");
      return ctrl.stats() as unknown as Json;
    }
    case "awaitDecode": {
      // Poll live decode health until `minIds` distinct LED ids are recovered
      // through the REAL detector + decoder (the part the synthetic camera drives),
      // or the timeout elapses. Returns the final stats either way.
      const minIds = Number(p.minIds ?? 0);
      const deadline = Date.now() + Number(p.timeoutMs ?? 30000);
      for (;;) {
        const ctrl = driverCapture();
        const st = ctrl?.stats() ?? { ids: 0, total: 0, tracks: 0, observations: 0 };
        if (st.ids >= minIds && st.total > 0) {
          emit("milestone", { name: "decoded", detail: st as unknown as Json });
          return st as unknown as Json;
        }
        if (Date.now() >= deadline) {
          throw new Error(`decode timeout: ${st.ids}/${minIds} ids after ${p.timeoutMs ?? 30000}ms`);
        }
        await new Promise((r) => setTimeout(r, 250));
      }
    }
    case "finishCapture": {
      // Give the ~6 s synthetic arc time to render enough parallax before solving.
      const dwellMs = Number(p.captureMs ?? 7000);
      await new Promise((r) => setTimeout(r, dwellMs));
      const ctrl = driverCapture();
      if (!ctrl) throw new Error("no capture screen mounted — send openCapture first");
      // Bound the solve: the VIO solver can stall on a synthetic scene that lacks
      // real inertial data (solve() itself has no timeout), and a hung solve must
      // not wedge the journey. Surface a clear error instead.
      const solveMs = Number(p.solveMs ?? 60000);
      const result = await Promise.race([
        ctrl.finish(),
        new Promise<never>((_res, rej) =>
          setTimeout(() => rej(new Error(`solve did not converge within ${solveMs}ms`)), solveMs),
        ),
      ]);
      // A real solve recovers most of the fixture; a near-empty map means the VIO
      // failed even though a map object came back. Fail the journey on that.
      const need = Math.max(1, Math.floor(result.ledCount * 0.5));
      if (result.solved < need) {
        throw new Error(`solve recovered only ${result.solved}/${result.ledCount} LEDs`);
      }
      emit("milestone", { name: "map_solved", detail: result as unknown as Json });
      return result as unknown as Json;
    }

    // --- device configuration --------------------------------------------
    case "setHardwareConfig": {
      const reply = await client().setHardwareConfig(p as Json);
      emit("milestone", { name: "hardware_config_state", detail: reply as unknown as Json });
      return reply;
    }
    case "getHardwareConfig":
      return await client().getHardwareConfig();
    case "setColorCorrection":
      return await client().setColorCorrection(p as Json);

    // --- queries ----------------------------------------------------------
    case "appState":
      return appStateSnapshot();
    case "welcome":
      return appState.welcome();
    case "store":
      if (p.name === "mapStore") return await mapStore.list({});
      return deviceStore.list();

    default:
      throw new Error(`unknown method: ${msg.method}`);
  }
}

let driverRouter: Router | null = null;

/**
 * Bootstrap the app-driver. Called from `main.ts` when `?driver=` is present,
 * BEFORE `router.start()` — so `setDriverActive(true)` is in effect before any
 * screen mounts and the BLE/capture swap points take their virtual branches.
 */
export async function initDriver(wsUrl: string, router: Router): Promise<void> {
  setDriverActive(true);
  driverRouter = router;

  await new Promise<void>((resolve) => {
    const ws = new WebSocket(wsUrl);
    sock = ws;
    let settled = false;
    const done = (): void => {
      if (!settled) {
        settled = true;
        resolve();
      }
    };
    ws.onopen = () => {
      emit("ready", { platform: "web", route: location.hash });
      // Stream every app-state transition so the station can await journeys.
      appState.subscribe(() => emit("state", appStateSnapshot()));
      done();
    };
    // Don't block bootstrap forever if the station isn't up yet.
    ws.onerror = () => done();
    ws.onclose = () => done();
    ws.onmessage = (ev: MessageEvent) => {
      let msg: Incoming;
      try {
        msg = JSON.parse(String(ev.data)) as Incoming;
      } catch (e) {
        emit("error", { where: "parse", message: String(e) });
        return;
      }
      void handle(msg)
        .then((value) => {
          if (msg.id) send({ id: msg.id, kind: "result", ok: true, value: value as Json });
        })
        .catch((e: unknown) => {
          const message = e instanceof Error ? e.message : String(e);
          if (msg.id) send({ id: msg.id, kind: "error", ok: false, error: message });
          emit("error", { where: msg.method, message });
        });
    };
  });
}

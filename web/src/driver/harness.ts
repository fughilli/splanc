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
import { provisionViaBle, requestImprovDevice, wsUrlFromRedirect } from "../net/improv";
import { deviceStore } from "../store/deviceStore";
import { mapStore } from "../store/mapStore";
import { appState } from "../ui/app/state";
import type { Router } from "../ui/app/router";
import { setDriverActive } from "./guard";

type Json = Record<string, unknown>;

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
    case "connect":
      appState.connect(String(p.wssUrl), p.label ? String(p.label) : undefined, {
        coldRetryLimit: 6,
      });
      return { connecting: true };

    case "provisionBle": {
      const dev = await requestImprovDevice();
      const urls = await provisionViaBle(
        dev,
        String(p.ssid ?? ""),
        String(p.password ?? ""),
        (s) => emit("status", { where: "provision", message: s }),
      );
      emit("milestone", { name: "provisioned", detail: { urls } });
      return { urls, wssUrl: urls[0] ? wsUrlFromRedirect(urls[0]) : null };
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

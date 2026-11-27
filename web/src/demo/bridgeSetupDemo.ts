/**
 * `?demo=bridge-<variant>`: a scripted Splanc bridge for the bridge setup flow (#698), so
 * the layout guard and the docs can walk every step with no Pi, radio or relay. It swaps
 * the flow's I/O seam (ui/screens/bridgeSetupIO.ts) and offers a stand-in Bluetooth
 * chooser that "finds" the bridge. Time runs fast (each check is a 20 s step) so the
 * failure screens arrive in about a second.
 *
 *   bridge-fresh        joins, starts, reaches the relay, shows a code; any code pairs
 *   bridge-moved        this app is already paired with it (seed splanc.bridge.v1): back online
 *   bridge-browser      a browser that doesn't trust its certificate: stages end "later"
 *   bridge-slow         the relay never connects and the clock is real (the checking page)
 *   bridge-joining      the Wi-Fi join never answers (the joining page)
 *   bridge-wrongpw      UNABLE_TO_CONNECT (a wrong password)
 *   bridge-unreachable  joined, nothing answers at its address (native: certain)
 *   bridge-relayblocked up on the LAN, the relay is blocked from it (the phone reaches it)
 *   bridge-notbridge    the device picked is a fixture
 *   bridge-handoff      arrives from the fixture flow, already joined
 */

import { ImprovError, type ImprovDevice } from "../net/improv";
import type { LanHealth } from "../net/liveProtocol";
import { abortableSleep, type BridgeSetupIO } from "../ui/screens/bridgeSetupRun";
import { handOffJoinedBridge, setBridgeSetupIO } from "../ui/screens/bridgeSetupIO";

export const DEMO_BRIDGE_IP = "192.168.1.68";
export const DEMO_BRIDGE_SHA = "5f3c9a0e7d21b84c6a1e0f9b3d7c2a58e4b1f60d9c8a7e3b2d1f0c9e8a7b6c5d";
const RELAY = "https://splanc.pages.dev";
const PLAYERS = ["Living Room", "Kitchen", "Porch Arch"];

export function setupBridgeSetupDemo(variant: string): void {
  installChooser();
  if (variant === "handoff") handOffJoinedBridge(DEMO_BRIDGE_IP, "Home Wi-Fi");
  setBridgeSetupIO(() => demoIO(variant));
}

function installChooser(): void {
  const device = { id: "demo-bridge", name: "splanc-bridge", gatt: {} } as unknown as ImprovDevice;
  Object.defineProperty(navigator, "bluetooth", {
    configurable: true,
    value: {
      getAvailability: async (): Promise<boolean> => true,
      requestDevice: async (): Promise<ImprovDevice> => device,
    },
  });
}

function demoIO(variant: string): BridgeSetupIO {
  const fast = variant !== "slow";
  let clock = Date.now();
  let reads = 0;
  const health = (over: Partial<LanHealth>): LanHealth => ({
    ok: true,
    live: 1,
    sha256: DEMO_BRIDGE_SHA,
    relay: RELAY,
    state: "pairing",
    relay_online: true,
    relay_error: null,
    code_expires_at: Math.floor(Date.now() / 1000) + 540,
    ...over,
  });
  return {
    provision: async (_device, _creds, onStatus, signal) => {
      onStatus("Connecting…");
      await abortableSleep(400, signal);
      onStatus("Sent the Wi-Fi details. Waiting for it to join…");
      if (variant === "joining") {
        await new Promise<void>((_, reject) => signal.addEventListener("abort", () => reject(new ImprovError("cancelled", "stopped"))));
      }
      await abortableSleep(500, signal);
      if (signal.aborted) throw new ImprovError("cancelled", "stopped");
      if (variant === "wrongpw") throw new ImprovError("unable-to-connect", "unable to connect to the network (check SSID/password)", 3);
      if (variant === "notbridge") return ["http://192.168.1.77/"];
      return [`http://${DEMO_BRIDGE_IP}/#splanc-bridge`];
    },
    readHealth: async () => {
      reads++;
      if (variant === "browser" || variant === "unreachable") return null;
      if (variant === "relayblocked" || variant === "slow") {
        return health({ state: "offline", relay_online: false, relay_error: "relay connect failed: connect ETIMEDOUT 172.66.44.1:443", code_expires_at: null });
      }
      if (variant === "moved") return health({ state: "paired", code_expires_at: null });
      // A fresh bridge: still connecting to the relay on the first read.
      return reads < 2 ? health({ state: "starting", relay_online: false, code_expires_at: null }) : health({});
    },
    healthCertain: variant !== "browser",
    relayReachable: async () => true,
    checkPaired: async (_ms, signal) => {
      await abortableSleep(500, signal);
      return { players: PLAYERS, sha256: DEMO_BRIDGE_SHA };
    },
    pair: async () => {
      await new Promise((r) => setTimeout(r, 400));
    },
    confirmPaired: async () => {
      await new Promise((r) => setTimeout(r, 300));
      return PLAYERS;
    },
    defaultRelay: RELAY,
    credsRelay: variant === "moved" ? RELAY : null,
    now: () => (fast ? (clock += 20_000) : Date.now()),
    sleep: (ms, signal) => abortableSleep(fast ? Math.min(ms, 150) : ms, signal),
  };
}

/**
 * The app's one device-metrics collector (collector.ts), wired to the live
 * player connections, the build version and the platform. installDeviceMetrics()
 * runs at boot: with "Send feedback to Fug Studio" off (the default) it only
 * registers a hashchange listener that returns at once, and starts nothing else.
 */

import { appBuildInfo } from "../buildInfo";
import { isBleUrl } from "../net/bleTransport";
import { connectionRegistry } from "../net/connectionRegistry";
import { nativePlatform } from "../net/native";
import { MetricsCollector, usageScreenFor, type MetricsPlayer } from "./collector";

function platform(): "web" | "ios" | "android" {
  const p = nativePlatform();
  return p === "ios" || p === "android" ? p : "web";
}

function players(): MetricsPlayer[] {
  const out: MetricsPlayer[] = [];
  for (const c of connectionRegistry.clients()) {
    const w = c.welcome;
    if (!c.isConnected || !w) continue;
    let key = w.mac;
    if (!key) {
      try {
        key = new URL(c.url).host;
      } catch {
        key = c.url;
      }
    }
    out.push({
      key,
      fw: w.fwVersion,
      transport: isBleUrl(c.url) ? "ble" : "wss",
      supports: (w.features ?? []).includes("device_metrics"),
      read: async () => (await c.getDeviceMetrics()) as unknown as Record<string, unknown>,
    });
  }
  return out;
}

export const deviceMetrics = new MetricsCollector({
  players,
  app: () => appBuildInfo.version || "0.0.0-dev",
  platform,
});

let installed = false;

export function installDeviceMetrics(): void {
  if (installed) return;
  installed = true;
  deviceMetrics.sync();
  deviceMetrics.countUsage("sessions");
  const onRoute = (): void => {
    const sc = usageScreenFor(location.hash);
    if (sc) deviceMetrics.countUsage(`screen_${sc}`);
  };
  window.addEventListener("hashchange", onRoute);
  onRoute();
}

/** An effect went to a player (Usage: a count, never which effect). */
export function countEffectDeployed(): void {
  deviceMetrics.countUsage("effects_deployed");
}

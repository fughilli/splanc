/**
 * Native BLE device picker (Capacitor wrapper — docs/design/ios-support.md §4.2).
 *
 * The plugin's built-in `requestDevice` chooser labels devices by CoreBluetooth's
 * `peripheral.name`, which is empty during a service-filtered scan on iOS — so a
 * Splanc board shows up as "Unknown". Here we run our own scan (net/capacitorImprov
 * `scanImprovNative`, which reports the advertised/scan-response name) and present a
 * simple sheet listing devices by name, resolving with the picked `ImprovDevice`
 * so the shared `provisionViaBle` flow drives it unchanged.
 *
 * Web (non-wrapper) callers never reach here — they use the browser's own chooser
 * via `requestImprovDevice()`; addDevice.ts branches on `isNativePlatform()`.
 */

import { Button, Sheet } from "../kit";
import { improvDeviceById, scanImprovNative, type ImprovScanHit } from "../../net/capacitorImprov";
import type { ImprovDevice } from "../../net/improv";

/** Scan + let the user pick an Improv device. Rejects with an AbortError
 * DOMException when dismissed (so addDevice's isCancel() stays silent). */
export function pickImprovDeviceNative(): Promise<ImprovDevice> {
  return new Promise<ImprovDevice>((resolve, reject) => {
    const sheet = Sheet("Add device over Bluetooth", {
      onClose: () => finish({ err: new DOMException("cancelled", "AbortError") }),
    });

    const hint = document.createElement("p");
    hint.className = "wifi-lead";
    hint.textContent = "Looking for nearby Splanc devices…";
    const list = document.createElement("div");
    list.style.display = "flex";
    list.style.flexDirection = "column";
    list.style.gap = "var(--sp-2)";
    sheet.body.append(hint, list);

    const rows = new Map<string, HTMLButtonElement>();
    let settled = false;

    // Kick off the scan; surface a permission/adapter error into the sheet
    // rather than throwing past the picker.
    const scanP = scanImprovNative(onHit);
    scanP.catch((e: unknown) => {
      hint.textContent = `Bluetooth unavailable: ${e instanceof Error ? e.message : String(e)}`;
    });

    async function stopScan(): Promise<void> {
      try {
        await (await scanP).stop();
      } catch {
        // scan failed to start or already stopped — nothing to clean up
      }
    }

    function finish(outcome: { device?: ImprovDevice; err?: unknown }): void {
      if (settled) return;
      settled = true;
      void stopScan();
      if (outcome.device) resolve(outcome.device);
      else reject(outcome.err ?? new DOMException("cancelled", "AbortError"));
    }

    function onHit(hit: ImprovScanHit): void {
      if (rows.has(hit.deviceId)) return; // first sighting wins (iOS name is freshest then)
      hint.textContent = "Tap your device to set it up:";
      const btn = Button({
        label: hit.name,
        block: true,
        onClick: () => {
          void (async () => {
            try {
              const device = await improvDeviceById(hit.deviceId, hit.name);
              finish({ device });
              sheet.close(); // settled already, so onClose's finish() is a no-op
            } catch (e) {
              finish({ err: e });
            }
          })();
        },
      });
      rows.set(hit.deviceId, btn);
      list.append(btn);
    }
  });
}

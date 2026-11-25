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
 * Each row has a Blink button beside the name (D-259): it sends Improv Identify,
 * and the fixture flashes its lights for about a second, so with several boards
 * nearby the user can tell which row is which before picking.
 *
 * Web (non-wrapper) callers never reach here — they use the browser's own chooser
 * via `requestImprovDevice()`; addDevice.ts branches on `isNativePlatform()`.
 */

import { Button, Sheet, toast } from "../kit";
import {
  improvDeviceById,
  readGapDeviceName,
  scanImprovNative,
  type ImprovScanHit,
} from "../../net/capacitorImprov";
import { identifyViaBle, type ImprovDevice } from "../../net/improv";

/** Scan + let the user pick an Improv device. Rejects with an AbortError
 * DOMException when dismissed (so addDevice's isCancel() stays silent). */
export function pickImprovDeviceNative(): Promise<ImprovDevice> {
  return pickNativeBleDevice(improvDeviceById);
}

/** Labels for the picker sheet (defaults: the Improv "add device" wording). */
export interface NativePickerText {
  title?: string;
  prompt?: string;
}

/** The scan-and-pick sheet, generic over what a picked device becomes: an
 * `ImprovDevice` for provisioning, or a player `BleDevice` for the offline
 * "Connect over Bluetooth" (net/nativeBlePlayer.ts `nativeBleDevice`). Every
 * splanc board advertises the Improv service, so the same scan finds both. */
export function pickNativeBleDevice<T>(
  toDevice: (deviceId: string, name?: string) => Promise<T>,
  text: NativePickerText = {},
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const sheet = Sheet(text.title ?? "Add device over Bluetooth", {
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
    const blinking = new Set<string>();

    /** Improv Identify to one board (its own short GATT session). */
    async function blink(deviceId: string, btn: HTMLButtonElement): Promise<void> {
      if (blinking.has(deviceId)) return;
      blinking.add(deviceId);
      btn.disabled = true;
      try {
        await identifyViaBle(await improvDeviceById(deviceId, names.get(deviceId)));
      } catch (e) {
        toast(`Couldn't reach it: ${e instanceof Error ? e.message : String(e)}`, { error: true });
      } finally {
        blinking.delete(deviceId);
        btn.disabled = false;
      }
    }
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

    function finish(outcome: { device?: T; err?: unknown }): void {
      if (settled) return;
      settled = true;
      void stopScan();
      if (outcome.device) resolve(outcome.device);
      else reject(outcome.err ?? new DOMException("cancelled", "AbortError"));
    }

    // Best name seen per device: iOS reports a peripheral's scan-response name on a
    // later advertising callback than its first sighting (the primary ADV holds only
    // Flags + the Improv UUID), so a device can surface nameless, then gain its name.
    const names = new Map<string, string>();
    // Devices we've already connected-and-read for a GAP name, so we probe each at
    // most once (see resolveNameOverGatt).
    const gapProbed = new Set<string>();

    function setLabel(deviceId: string, label: string): void {
      const span = rows.get(deviceId)?.querySelector("span");
      if (span) span.textContent = label;
    }

    /** If a device is still nameless a moment after it surfaces, its scan-response
     * name may never arrive (BLE/WiFi coex can starve it on a busy board). Connect
     * once and read the GAP Device Name (0x2A00) the firmware exposes, then relabel
     * the row with the real name. Best-effort: a failure leaves "Splanc device". */
    function resolveNameOverGatt(deviceId: string): void {
      if (gapProbed.has(deviceId) || names.has(deviceId) || settled) return;
      gapProbed.add(deviceId);
      void readGapDeviceName(deviceId).then((name) => {
        if (name && !names.has(deviceId) && !settled) {
          names.set(deviceId, name);
          setLabel(deviceId, name);
        }
      });
    }

    function onHit(hit: ImprovScanHit): void {
      if (hit.name) names.set(hit.deviceId, hit.name);
      const label = names.get(hit.deviceId) ?? "Splanc device";
      const existing = rows.get(hit.deviceId);
      if (existing) {
        // Refresh the label if a later sighting supplied the real name (Button renders
        // its label in a child <span>).
        setLabel(hit.deviceId, label);
        // Still nameless after re-sighting → fall back to a GATT name read.
        if (!names.has(hit.deviceId)) resolveNameOverGatt(hit.deviceId);
        return;
      }
      hint.textContent = text.prompt ?? "Tap your fixture to set it up. Not sure which is which? Blink it.";
      const btn = Button({
        label,
        block: true,
        onClick: () => {
          void (async () => {
            try {
              const device = await toDevice(hit.deviceId, names.get(hit.deviceId));
              finish({ device });
              sheet.close(); // settled already, so onClose's finish() is a no-op
            } catch (e) {
              finish({ err: e });
            }
          })();
        },
      });
      rows.set(hit.deviceId, btn);
      const blinkBtn = Button({ label: "Blink", icon: "sparkles", variant: "quiet" });
      blinkBtn.title = "Blink its lights";
      blinkBtn.setAttribute("aria-label", "Blink its lights");
      blinkBtn.addEventListener("click", () => void blink(hit.deviceId, blinkBtn));
      const row = document.createElement("div");
      row.className = "ble-pick-row";
      row.style.display = "flex";
      row.style.alignItems = "center";
      row.style.gap = "var(--sp-3)";
      btn.style.flex = "1";
      btn.style.minWidth = "0";
      blinkBtn.style.flex = "0 0 auto";
      row.append(btn, blinkBtn);
      list.append(row);
    }
  });
}

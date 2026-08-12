/**
 * Add-device flow — shared by the device sheet and the onboarding screen.
 *
 * Both "add" affordances open a Wi-Fi dialog first (pick a saved network or
 * enter a new one), then proceed to their method: the native BLE device
 * scanner/picker (Improv provisioning) or manual address entry. The per-device
 * "re-discover over Bluetooth" chip button skips the dialog and goes straight to
 * the picker, provisioning with the most-recently-used network.
 *
 * Web Bluetooth's `requestDevice` needs an UNCONSUMED user gesture, so on any
 * path the chooser is the FIRST async call in its click handler (before any
 * prompt/await) — see net/improv.ts.
 */

import { Button, Sheet, confirmDialog, toast } from "../kit";
import {
  provisionViaBle,
  requestImprovDevice,
  wsUrlFromRedirect,
  type ImprovDevice,
} from "../../net/improv";
import { prefs, type WifiCreds } from "../../store/prefs";
import { deviceStore, type KnownDevice } from "../../store/deviceStore";
import { appState } from "../app/state";
import { isNativePlatform } from "../../net/native";

/** Get an Improv device to provision: the browser's Web Bluetooth chooser, or —
 * in the native wrapper — our own named scan+picker (the plugin's built-in
 * chooser shows devices as "Unknown" on iOS). On web this stays the FIRST async
 * call in the click handler so the user gesture that Web Bluetooth requires is
 * still unconsumed; the native scan has no such gesture requirement. */
async function chooseImprovDevice(): Promise<ImprovDevice> {
  if (isNativePlatform()) {
    const { pickImprovDeviceNative } = await import("./blePicker");
    return pickImprovDeviceNative();
  }
  return requestImprovDevice();
}

export type AddMethod = "ble" | "manual";

/** Open the Wi-Fi dialog, then the chosen method. */
export function openAddDevice(method: AddMethod, onDone?: () => void): void {
  const sheet = Sheet(method === "ble" ? "Add device over Bluetooth" : "Add device by address");
  sheet.body.className = "wifi-sheet";

  const saved = prefs.getWifiList();
  const first = saved[0] ?? { ssid: "", password: "" };

  const lead = document.createElement("p");
  lead.className = "wifi-lead";
  lead.textContent =
    method === "ble"
      ? "Choose the Wi-Fi network the device should join, then pick it in the Bluetooth chooser."
      : "Choose the Wi-Fi network the device is on, then enter its address.";

  // Saved-network pick list (tap to fill the fields below).
  const picks = document.createElement("div");
  picks.className = "wifi-picks";

  const ssidInput = document.createElement("input");
  ssidInput.className = "sheet-input";
  ssidInput.placeholder = "Wi-Fi network (SSID)";
  ssidInput.value = first.ssid;
  const passInput = document.createElement("input");
  passInput.className = "sheet-input";
  passInput.type = "password";
  passInput.placeholder = "Wi-Fi password";
  passInput.value = first.password;

  const renderPicks = (): void => {
    picks.replaceChildren();
    for (const net of prefs.getWifiList()) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "wifi-pick";
      if (net.ssid === ssidInput.value) b.classList.add("wifi-pick--on");
      b.textContent = net.ssid;
      b.addEventListener("click", () => {
        ssidInput.value = net.ssid;
        passInput.value = net.password;
        renderPicks();
      });
      picks.appendChild(b);
    }
  };
  renderPicks();

  const status = document.createElement("div");
  status.className = "wifi-status metric";
  const setStatus = (s: string): void => {
    status.textContent = s;
  };

  const go = Button({
    label: method === "ble" ? "Scan for device" : "Enter address",
    icon: method === "ble" ? "bluetooth" : "link",
    block: true,
    onClick: () => {
      const creds: WifiCreds = { ssid: ssidInput.value.trim(), password: passInput.value };
      if (method === "manual") {
        if (creds.ssid) prefs.addWifi(creds);
        sheet.close();
        promptManualAddress();
        onDone?.();
        return;
      }
      // BLE: chooser FIRST (gesture), then provision with the chosen network.
      go.disabled = true;
      void runBleProvision(creds, setStatus)
        .then((ok) => {
          if (ok) {
            sheet.close();
            onDone?.();
          } else {
            go.disabled = false;
          }
        })
        .catch(() => {
          go.disabled = false;
        });
    },
  });

  sheet.body.append(lead);
  if (saved.length > 0) {
    const cap = document.createElement("div");
    cap.className = "wifi-cap";
    cap.textContent = "Saved networks";
    sheet.body.append(cap, picks);
  }
  sheet.body.append(ssidInput, passInput, go, status);
  ssidInput.focus();
}

/** Per-device "re-discover over Bluetooth": straight to the BLE picker, then
 * provision with the most-recent saved network (falling back to the dialog if
 * none is saved yet). When re-discovering a KNOWN device, warns first if the
 * user picked a DIFFERENT physical device (a mismatched Web Bluetooth id) — so
 * they don't accidentally re-point it and overwrite its name. */
export function bleRediscover(known?: KnownDevice, onDone?: () => void): void {
  void (async () => {
    let device: ImprovDevice;
    try {
      device = await chooseImprovDevice(); // FIRST — preserve the (web) gesture
    } catch (e) {
      if (!isCancel(e)) toast(`Bluetooth: ${msg(e)}`, { error: true });
      return;
    }
    if (known?.bleId && device.id && device.id !== known.bleId) {
      const ok = await confirmDialog({
        title: "Different device?",
        message:
          `The device you picked${device.name ? ` ("${device.name}")` : ""} doesn't look ` +
          `like "${known.label}" — it's a different Bluetooth device. Setting it up will ` +
          `connect to it and may overwrite "${known.label}"'s name. Continue?`,
        confirmLabel: "Continue",
        danger: true,
      });
      if (!ok) return;
    }
    const creds = prefs.getWifiList()[0];
    if (!creds || !creds.ssid) {
      toast("Pick a Wi-Fi network first", { error: true });
      openAddDevice("ble", onDone);
      return;
    }
    try {
      await provisionWithDevice(device, creds, (s) => toast(s));
      onDone?.();
    } catch (e) {
      toast(`Setup failed: ${msg(e)}`, { error: true });
    }
  })();
}

// -- internals ---------------------------------------------------------------

/** Run the BLE chooser + provisioning for `openAddDevice`. Returns true on a
 * completed provision. `requestImprovDevice` is called first for the gesture. */
async function runBleProvision(
  creds: WifiCreds,
  setStatus: (s: string) => void,
): Promise<boolean> {
  let device: ImprovDevice;
  try {
    device = await chooseImprovDevice();
  } catch (e) {
    if (!isCancel(e)) setStatus(`Bluetooth: ${msg(e)}`);
    return false;
  }
  if (!creds.ssid) {
    setStatus("Enter a Wi-Fi network name.");
    return false;
  }
  try {
    await provisionWithDevice(device, creds, setStatus);
    return true;
  } catch (e) {
    setStatus(`Setup failed: ${msg(e)}`);
    return false;
  }
}

/** Send credentials over BLE, cache the network, and bind to the reported LAN
 * address (whose cert-trust step surfaces in the device sheet). */
async function provisionWithDevice(
  device: ImprovDevice,
  creds: WifiCreds,
  setStatus: (s: string) => void,
): Promise<void> {
  const urls = await provisionViaBle(device, creds.ssid, creds.password, setStatus);
  prefs.addWifi(creds); // only after the device reports it JOINED
  const target = urls.map((u) => wsUrlFromRedirect(u)).find((u) => u !== null);
  if (!target) throw new Error(`device joined but sent no usable address (${urls})`);
  setStatus(`Provisioned at ${target} — connecting…`);
  appState.connect(target);
  // Remember which physical Bluetooth device this record is, so a later
  // re-discover can warn if a different one is picked.
  if (device.id) deviceStore.setBleId(target, device.id);
  toast("Device provisioned");
}

function promptManualAddress(): void {
  const url = prompt("Device address (wss://host:port):", "wss://");
  if (!url) return;
  if (!/^wss?:\/\//.test(url)) {
    toast("Address must start with ws:// or wss://", { error: true });
    return;
  }
  appState.connect(url);
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
/** The user dismissing the BLE chooser rejects with NotFoundError — not an error
 * worth toasting. */
function isCancel(e: unknown): boolean {
  return e instanceof DOMException && (e.name === "NotFoundError" || e.name === "AbortError");
}

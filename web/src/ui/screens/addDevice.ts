/**
 * Add-device flows — reached from the connect picker (connectPicker.ts), which
 * the welcome screen and the device sheet both open.
 *
 * "Set up a new fixture" opens a Wi-Fi dialog (pick a saved network or enter a
 * new one; pressing Connect saves it, store/savedNetworks.ts), then the BLE
 * scanner/picker and Improv provisioning. "Connect by network address" is its own
 * one-field sheet (no Wi-Fi details needed). The per-device
 * "re-discover over Bluetooth" chip button skips the dialog and goes straight to
 * the picker, provisioning with the most-recently-used network.
 *
 * Web Bluetooth's `requestDevice` needs an UNCONSUMED user gesture, so on any
 * path the chooser is the FIRST async call in its click handler (before any
 * prompt/await) — see net/improv.ts.
 */

import { Button, PasswordReveal, Sheet, confirmDialog, toast } from "../kit";
import {
  ImprovError,
  bridgeHostFromRedirect,
  provisionViaBle,
  requestImprovDevice,
  wsUrlFromRedirect,
  type ImprovDevice,
} from "../../net/improv";
import { prefs, type WifiCreds } from "../../store/prefs";
import { savedNetworks } from "../../store/savedNetworks";
import { wifiDraft } from "../../store/wifiDraft";
import { deviceStore, type KnownDevice } from "../../store/deviceStore";
import { appState } from "../app/state";
import { isNativePlatform } from "../../net/native";
import type { BleDevice } from "../../net/bleTransport";

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

/** Options for reopening the sheet on a specific state (bleRediscover's failure). */
export interface AddDeviceOpts {
  /** A device already picked: "Try again" re-sends to it without the chooser. */
  device?: ImprovDevice;
  /** Prefill these details (instead of the session draft / saved networks). */
  creds?: WifiCreds;
  /** Open showing this failure (focuses the field to fix). */
  error?: unknown;
}

/** Open the Wi-Fi dialog, then the chosen method.
 *
 * The fields prefill from what the user typed earlier this session (the draft,
 * store/wifiDraft.ts) — a mistyped password is never lost by backing out — or
 * else the most recent saved network. While a BLE provision is in flight the
 * fields lock and a secondary "Edit Wi-Fi details" stops waiting; a failure the
 * device reports (a rejected password, a network it can't see) returns straight
 * to the field to fix, with the picked device kept so "Try again" re-sends at once. */
export function openAddDevice(method: AddMethod, onDone?: () => void, opts: AddDeviceOpts = {}): void {
  // Connecting by address needs no Wi-Fi details: its own sheet.
  if (method === "manual") {
    openAddressSheet(onDone);
    return;
  }
  // Closing the sheet mid-provision stops waiting (and drops the BLE link); closing
  // it after a failure drops the link a retry would have re-used.
  let inflight: AbortController | null = null;
  let provisioned = false;
  const sheet = Sheet("Set up a new fixture", {
    onClose: () => {
      if (inflight) inflight.abort();
      else if (picked && !provisioned) dropLink(picked);
    },
  });
  sheet.body.className = "wifi-sheet";

  const saved = prefs.getWifiList();
  const first = opts.creds ?? wifiDraft.get() ?? saved[0] ?? { ssid: "", password: "" };
  // The device picked for this sheet: a retry re-sends to it (no second chooser).
  let picked: ImprovDevice | null = opts.device ?? null;

  const lead = document.createElement("p");
  lead.className = "wifi-lead";
  lead.textContent =
    "Choose the Wi-Fi network the fixture should join, then pick the fixture in the Bluetooth list. " +
    "The network is saved for next time.";

  // Saved-network pick list (tap to fill the fields below).
  const picks = document.createElement("div");
  picks.className = "wifi-picks";

  const ssidInput = document.createElement("input");
  ssidInput.className = "sheet-input";
  ssidInput.placeholder = "Wi-Fi network (SSID)";
  ssidInput.setAttribute("aria-label", "Wi-Fi network (SSID)");
  ssidInput.value = first.ssid;
  ssidInput.setAttribute("autocomplete", "off");
  ssidInput.setAttribute("autocapitalize", "off");
  ssidInput.setAttribute("autocorrect", "off");
  ssidInput.setAttribute("spellcheck", "false");
  const passInput = document.createElement("input");
  passInput.className = "sheet-input";
  passInput.placeholder = "Wi-Fi password";
  passInput.setAttribute("aria-label", "Wi-Fi password");
  passInput.value = first.password;
  // Eye toggle for cleartext (starts hidden). "new-password": these are the
  // network's credentials for the device, not a login for this site, so keep
  // the browser's password manager from autofilling/saving them. Picking a
  // saved network below only swaps the value, so the current visibility stays.
  const pass = PasswordReveal(passInput, { autocomplete: "new-password", className: "sheet-pw" });

  const current = (): WifiCreds => ({ ssid: ssidInput.value.trim(), password: passInput.value });
  // Every edit updates the session draft, so reopening the sheet shows it again.
  const keepDraft = (): void => wifiDraft.set({ ssid: ssidInput.value, password: passInput.value });
  ssidInput.addEventListener("input", keepDraft);
  passInput.addEventListener("input", keepDraft);

  const renderPicks = (): void => {
    picks.replaceChildren();
    for (const net of prefs.getWifiList()) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "wifi-pick";
      if (net.ssid === ssidInput.value) b.classList.add("wifi-pick--on");
      b.textContent = net.ssid;
      if (savedNetworks.get(net.ssid)?.state === "rejected") {
        b.classList.add("wifi-pick--rejected");
        b.title = "A fixture rejected this password last time";
      }
      b.addEventListener("click", () => {
        ssidInput.value = net.ssid;
        passInput.value = net.password;
        keepDraft();
        renderPicks();
      });
      picks.appendChild(b);
    }
  };
  renderPicks();
  ssidInput.addEventListener("input", renderPicks);

  const status = document.createElement("div");
  status.className = "wifi-status metric";
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  const setStatus = (s: string, kind: "info" | "error" = "info"): void => {
    status.textContent = s;
    status.classList.toggle("wifi-status--error", kind === "error");
  };

  const go = Button({
    label: "Connect",
    icon: "bluetooth",
    block: true,
    onClick: () => {
      const creds = current();
      // Whatever is entered when Connect is pressed is saved (D-72), upserted by
      // SSID; the join's outcome is recorded on it below. Synchronous, so the
      // Bluetooth chooser that follows still has the click's user gesture.
      savedNetworks.saveOnConnect(creds);
      renderPicks();
      // Chooser FIRST (gesture) — unless this sheet already has the device (a
      // retry) — then provision with the chosen network.
      void runBle(creds, picked);
    },
  });
  const setGoLabel = (label: string): void => {
    const span = go.querySelector("span");
    if (span) span.textContent = label;
  };

  // Secondary actions, visually subordinate to the one primary button and on their
  // own rows: stop waiting (while a provision is in flight) and, after a failure
  // with a device picked, choose a different one.
  const stopBtn = Button({
    label: "Edit Wi-Fi details",
    icon: "edit",
    variant: "quiet",
    block: true,
    onClick: () => inflight?.abort(),
  });
  stopBtn.classList.add("wifi-secondary");
  stopBtn.hidden = true;
  const otherBtn = Button({
    label: "Choose a different device",
    variant: "quiet",
    block: true,
    onClick: () => {
      if (picked) dropLink(picked);
      picked = null;
      otherBtn.hidden = true;
      void runBle(current(), null);
    },
  });
  otherBtn.classList.add("wifi-secondary");
  otherBtn.hidden = true;

  /** Lock the form while a provision runs (the stop button is the way back). */
  const setBusy = (busy: boolean): void => {
    ssidInput.disabled = busy;
    passInput.disabled = busy;
    for (const b of picks.querySelectorAll("button")) (b as HTMLButtonElement).disabled = busy;
    go.hidden = busy;
    stopBtn.hidden = !busy;
    if (busy) otherBtn.hidden = true;
  };

  /** Back to editing after a failure: say what happened, focus what to fix. */
  const showFailure = (e: unknown): void => {
    setBusy(false);
    const kind = e instanceof ImprovError ? e.kind : null;
    if (kind === "cancelled") {
      setStatus("Stopped waiting. Edit the Wi-Fi details, then try again.");
    } else if (kind === "wrong-password" || kind === "not-found") {
      setStatus(msg(e), "error");
    } else if (kind === "timeout") {
      setStatus(
        "The device didn't join the network in time. Check the Wi-Fi details, then try again.",
        "error",
      );
    } else {
      setStatus(`Setup failed: ${msg(e)}`, "error");
    }
    const fix = kind === "not-found" ? ssidInput : passInput;
    fix.focus();
    fix.select();
    if (picked) {
      setGoLabel("Try again");
      otherBtn.hidden = false;
    }
  };

  const runBle = async (creds: WifiCreds, device: ImprovDevice | null): Promise<void> => {
    if (!device) {
      go.disabled = true;
      try {
        device = await chooseImprovDevice(); // FIRST async call — the (web) gesture
      } catch (e) {
        if (!isCancel(e)) setStatus(`Bluetooth: ${msg(e)}`, "error");
        return;
      } finally {
        go.disabled = false;
      }
      picked = device;
    }
    if (!creds.ssid) {
      setStatus("Enter a Wi-Fi network name.", "error");
      ssidInput.focus();
      return;
    }
    const ctl = new AbortController();
    inflight = ctl;
    setBusy(true);
    setStatus("Connecting…");
    try {
      await provisionWithDevice(device, creds, (s) => setStatus(s), ctl.signal);
      inflight = null;
      provisioned = true;
      sheet.close();
      onDone?.();
    } catch (e) {
      inflight = null;
      if (e instanceof ImprovError && e.kind === "wrong-password") savedNetworks.markResult(creds, "rejected");
      renderPicks();
      showFailure(e);
    }
  };

  sheet.body.append(lead);
  if (saved.length > 0) {
    const cap = document.createElement("div");
    cap.className = "wifi-cap";
    cap.textContent = "Saved networks";
    sheet.body.append(cap, picks);
  }
  sheet.body.append(ssidInput, pass.el, status, go, stopBtn, otherBtn);
  if (opts.error !== undefined) showFailure(opts.error);
  else ssidInput.focus();
}

/** Per-device "re-discover over Bluetooth": straight to the BLE picker, then
 * provision with the most-recent saved network (falling back to the dialog if
 * none is saved yet). When re-discovering a KNOWN device, warns first if the
 * user picked a DIFFERENT physical device (a mismatched Web Bluetooth id) — so
 * they don't accidentally re-point it and overwrite its name. A failure the user
 * can fix (a rejected password, a network the device can't see) opens the Wi-Fi
 * dialog on that field, with the picked device kept for "Try again". */
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
      openAddDevice("ble", onDone, { device });
      return;
    }
    try {
      await provisionWithDevice(device, creds, (s) => toast(s));
      onDone?.();
    } catch (e) {
      if (e instanceof ImprovError && e.kind === "wrong-password") savedNetworks.markResult(creds, "rejected");
      if (e instanceof ImprovError && e.kind !== "device") {
        openAddDevice("ble", onDone, { device, creds, error: e });
      } else {
        toast(`Setup failed: ${msg(e)}`, { error: true });
      }
    }
  })();
}

// -- internals ---------------------------------------------------------------

/** Best-effort BLE disconnect (frees the device's shared radio). */
function dropLink(device: ImprovDevice): void {
  try {
    device.gatt?.disconnect();
  } catch {
    // already disconnected — fine
  }
}

/** Send credentials over BLE, cache the network, and bind to the reported LAN
 * address (whose cert-trust step surfaces in the device sheet). */
async function provisionWithDevice(
  device: ImprovDevice,
  creds: WifiCreds,
  setStatus: (s: string) => void,
  signal?: AbortSignal,
): Promise<void> {
  const urls = await provisionViaBle(device, creds.ssid, creds.password, setStatus, { signal });
  prefs.addWifi(creds); // only after the device reports it JOINED
  wifiDraft.clear(); // the draft is now a saved network
  // A Splanc bridge (Pi) joined the network: it isn't a player to connect to, it
  // pairs with the code on its screen (Live via bridge). Don't add it as a device.
  const bridgeHost = urls.map((u) => bridgeHostFromRedirect(u)).find((h) => h !== null);
  if (bridgeHost) {
    setStatus(`Bridge joined ${creds.ssid} (${bridgeHost}).`);
    toast(`Bridge is on ${creds.ssid}. Not paired yet? Open Live via bridge and enter the code on its screen.`);
    return;
  }
  const target = urls.map((u) => wsUrlFromRedirect(u)).find((u) => u !== null);
  if (!target) throw new Error(`device joined but sent no usable address (${urls})`);
  setStatus(`Provisioned at ${target} — connecting…`);
  appState.connect(target);
  // Remember which physical Bluetooth device this record is, so a later
  // re-discover can warn if a different one is picked.
  if (device.id) deviceStore.setBleId(target, device.id);
  toast("Device provisioned");
}

/**
 * Connect to a device over Bluetooth (no Wi-Fi, no cert) — the offline config
 * path. Some networks (a phone hotspot with no upstream internet) refuse to
 * load the device's https cert-accept page, so wss:// never becomes trustable;
 * BLE sidesteps it entirely, carrying the full player protocol (see
 * net/bleTransport.ts). The chooser is the FIRST async call (Web Bluetooth
 * gesture). Keyed in the device list by a synthetic `ble:` URL; the socket runs
 * over GATT, so cert-trust is meaningless and the client retries on the backoff.
 */
export function connectOverBle(onDone?: () => void): void {
  void (async () => {
    const { requestBleDevice, bleSocketFactory, bleDeviceUrl, BLE_UPLOAD_CHUNK_BYTES } = await import(
      "../../net/bleTransport"
    );
    let device;
    try {
      // Native wrapper (iOS has no Web Bluetooth): our own scan-and-pick sheet over
      // CoreBluetooth, adapted to the same BleDevice seam, so the shared BleSocket
      // runs the protocol unchanged (net/nativeBlePlayer.ts).
      device = isNativePlatform()
        ? await pickPlayerDeviceNative()
        : await requestBleDevice(); // FIRST — preserve the user gesture
    } catch (e) {
      if (!isCancel(e)) toast(`Bluetooth: ${msg(e)}`, { error: true });
      return;
    }
    const label = device.name || "Bluetooth device";
    // Stable key so a re-scan of the same device dedups instead of duplicating —
    // device.id is not stable across sessions (see bleDeviceUrl).
    const url = bleDeviceUrl(device);
    toast("Connecting over Bluetooth…");
    appState.connect(url, label, {
      socketFactory: bleSocketFactory(device),
      // GATT link is reliable once open; give the initial discovery a few tries.
      coldRetryLimit: 6,
      // Shard uploads into small windows so each GATT frame fits the device's
      // bounded BLE reassembly buffer (tight on the heapless-netstack build).
      uploadChunkBytes: BLE_UPLOAD_CHUNK_BYTES,
    });
    if (device.id) deviceStore.setBleId(url, device.id);
    onDone?.();
  })();
}

/** Native scan-and-pick for the player transport (the Web Bluetooth chooser's
 * stand-in inside the Capacitor app). */
async function pickPlayerDeviceNative(): Promise<BleDevice> {
  const [{ loadNativeBle, nativeBleDevice }, { pickNativeBleDevice }] = await Promise.all([
    import("../../net/nativeBlePlayer"),
    import("./blePicker"),
  ]);
  const ble = await loadNativeBle();
  return pickNativeBleDevice(async (id, name) => nativeBleDevice(ble, id, name), {
    title: "Connect over Bluetooth",
    prompt: "Tap the device to connect:",
  });
}

/** Turn what the user typed into the player's wss URL: a bare host or IP
 * (`192.168.1.40`, `kitchen.local`), an http(s) page address (what a device
 * reports), or a ws(s):// URL kept as given. Null when it isn't an address. */
export function normalizeDeviceAddress(input: string): string | null {
  const raw = input.trim();
  if (!raw) return null;
  if (/^wss?:\/\//i.test(raw)) {
    try {
      const u = new URL(raw);
      return u.hostname ? raw : null;
    } catch {
      return null;
    }
  }
  if (/^https?:\/\//i.test(raw)) return wsUrlFromRedirect(raw);
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) return null; // some other scheme
  try {
    const u = new URL(`https://${raw}`);
    if (!u.hostname || /\s/.test(raw)) return null;
    const port = u.port && u.port !== "443" ? `:${u.port}` : "";
    return `wss://${u.hostname}${port}/ws`;
  } catch {
    return null;
  }
}

/** "Connect by network address": one field and one Connect button. For a fixture
 * already on the network whose address the user knows (the router's client list,
 * the fixture's own screen, a `<name>.local` hostname). */
export function openAddressSheet(onDone?: () => void): void {
  const sheet = Sheet("Connect by network address");
  sheet.body.className = "wifi-sheet";
  const lead = document.createElement("p");
  lead.className = "wifi-lead";
  lead.textContent =
    "For a fixture that is already on your Wi-Fi. Enter its IP address or name, as shown in your " +
    "router's device list (for example 192.168.1.40 or living-room.local).";
  const input = document.createElement("input");
  input.className = "sheet-input";
  input.placeholder = "192.168.1.40";
  input.setAttribute("aria-label", "Fixture address");
  input.setAttribute("autocomplete", "off");
  input.setAttribute("autocapitalize", "off");
  input.setAttribute("autocorrect", "off");
  input.setAttribute("spellcheck", "false");
  input.setAttribute("inputmode", "url");
  const status = document.createElement("div");
  status.className = "wifi-status metric";
  status.setAttribute("role", "status");
  const go = Button({
    label: "Connect",
    icon: "link",
    block: true,
    onClick: () => {
      const url = normalizeDeviceAddress(input.value);
      if (!url) {
        status.textContent = "That doesn't look like an address. Try something like 192.168.1.40.";
        status.classList.add("wifi-status--error");
        input.focus();
        return;
      }
      sheet.close();
      appState.connect(url);
      onDone?.();
    },
  });
  input.addEventListener("keydown", (e) => {
    if ((e as KeyboardEvent).key === "Enter") go.click();
  });
  sheet.body.append(lead, input, status, go);
  input.focus();
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
/** The user dismissing the BLE chooser rejects with NotFoundError — not an error
 * worth toasting. */
function isCancel(e: unknown): boolean {
  return e instanceof DOMException && (e.name === "NotFoundError" || e.name === "AbortError");
}

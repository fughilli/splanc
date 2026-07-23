/**
 * Device sheet (design doc §6.2 / §7.4) — a bottom sheet reachable everywhere
 * (the app-bar pill and the Device tab both open it). Lists known devices by
 * their display name, shows reachability (probed over the wss the app already
 * uses — a device answers `welcome` with its MAC + name), and lets the user
 * connect, re-discover over Bluetooth when unreachable, rename, and forget.
 *
 * Long-pressing (or right-clicking) a row opens a detail popup with the recorded
 * LAN address, MAC, Bluetooth name, and the editable display name (which is
 * reflected to the device — and its Bluetooth advertisement — on connect).
 */

import { Button, IconButton, Sheet, toast } from "../kit";
import { appState } from "../app/state";
import { deviceProber } from "../../net/deviceProber";
import { deviceStore, deviceHost, type KnownDevice } from "../../store/deviceStore";
import { bleRediscover, openAddDevice } from "./addDevice";
import { appendGrouped, openFolderPicker } from "./folders";

let openHandle: { close: () => void } | null = null;

export function openDeviceSheet(): void {
  if (openHandle) return; // already open — don't stack
  let unsubDev: () => void = () => {};
  let unsubApp: () => void = () => {};
  let unsubProbe: () => void = () => {};

  const sheet = Sheet("Devices", {
    onClose: () => {
      unsubDev();
      unsubApp();
      unsubProbe();
      openHandle = null;
    },
  });
  openHandle = sheet;

  const rerender = (): void => {
    sheet.body.innerHTML = "";
    sheet.body.append(render());
  };
  unsubDev = deviceStore.subscribe(rerender);
  unsubApp = appState.subscribe(rerender);
  // Reachability comes from the shared background prober (lazy: 1/min → 1/10min).
  // Opening the sheet asks it for a fresh, prompt look.
  unsubProbe = deviceProber.subscribe(rerender);
  deviceProber.refresh();
  rerender();
}

function render(): HTMLElement {
  const wrap = document.createElement("div");
  const status = appState.status;
  const activeId = deviceStore.activeId();
  const devices = deviceStore.list();

  // -- inline cert-trust (design doc §6.2): when the active device needs its
  // self-signed cert trusted, show the trust action here (mirrored in the pill).
  if (status.certUrl) {
    const card = document.createElement("div");
    card.className = "k-card";
    card.style.borderColor = "var(--warn)";
    card.style.marginBottom = "var(--sp-3)";
    const p = document.createElement("div");
    p.textContent = "This device uses a self-signed certificate — trust it once to connect.";
    p.style.marginBottom = "var(--sp-2)";
    const btn = Button({ label: "Trust & connect", onClick: () => trustCert(status.certUrl!) });
    card.append(p, btn);
    wrap.append(card);
  }
  if (status.error) {
    const e = document.createElement("div");
    e.className = "k-card";
    e.style.borderColor = "var(--err)";
    e.style.color = "var(--err)";
    e.style.marginBottom = "var(--sp-3)";
    e.textContent = status.error;
    wrap.append(e);
  }

  if (devices.length === 0) {
    const empty = document.createElement("div");
    empty.className = "device-empty";
    empty.textContent = "No devices yet. Add one to control a player.";
    wrap.append(empty);
  }

  appendGrouped(
    wrap,
    devices,
    (dev) => dev.folder,
    (dev) => deviceRow(dev, dev.id === activeId, status, deviceProber.isReachable(dev.id)),
  );

  // -- add-device section (compact icon buttons under a labelled divider).
  const addSection = document.createElement("div");
  addSection.className = "device-add";
  const addLabel = document.createElement("div");
  addLabel.className = "device-add-label";
  addLabel.textContent = "Add device…";
  const addRow = document.createElement("div");
  addRow.className = "device-add-row";
  addRow.append(
    IconButton("bluetooth", {
      title: "Add device (Bluetooth)",
      onClick: () => openAddDevice("ble"),
    }),
    IconButton("link", {
      title: "Enter address manually",
      onClick: () => openAddDevice("manual"),
    }),
  );
  addSection.append(addLabel, addRow);
  wrap.append(addSection);
  return wrap;
}

function deviceRow(
  dev: KnownDevice,
  isActive: boolean,
  status = appState.status,
  isReachable = false,
): HTMLElement {
  const row = document.createElement("div");
  row.className = "device-row";

  const connected = isActive && (appState.client?.isConnected ?? false);
  const dot = document.createElement("span");
  dot.className = "device-dot";
  dot.dataset["state"] = connected
    ? status.state // connected/connecting/error
    : isReachable
      ? "reachable" // on the LAN, MAC known — yellow
      : "offline";

  const info = document.createElement("div");
  info.className = "device-info";
  const name = document.createElement("div");
  name.className = "device-name";
  name.textContent = dev.label;
  const meta = document.createElement("div");
  meta.className = "device-url";
  meta.textContent = isActive
    ? connectedMeta(status)
    : isReachable
      ? `on this network · ${deviceHost(dev)}`
      : deviceHost(dev);
  info.append(name, meta);

  const btns = document.createElement("div");
  btns.className = "device-btns";
  if (isActive) {
    btns.append(Button({ label: "Disconnect", variant: "quiet", onClick: () => appState.disconnect() }));
  } else if (isReachable) {
    btns.append(Button({ label: "Connect", onClick: () => appState.connect(dev.wssUrl, dev.label) }));
  } else {
    // Unreachable on the LAN: the connect affordance opens the BLE picker
    // directly to re-discover / re-provision the device (Improv flow).
    btns.append(
      IconButton("ble-search", {
        title: "Find over Bluetooth",
        onClick: () => bleRediscover(dev),
      }),
    );
  }
  btns.append(IconButton("trash", { title: "Forget", onClick: () => deviceStore.forget(dev.id) }));

  row.append(dot, info, btns);

  // Long-press (or right-click) opens the device detail popup. Ignore presses
  // that start on a button so Connect/Forget still work normally.
  let pressTimer: number | null = null;
  const startPress = (ev: PointerEvent): void => {
    if ((ev.target as HTMLElement).closest(".device-btns")) return;
    pressTimer = window.setTimeout(() => openDeviceDetail(dev), 500);
  };
  const cancelPress = (): void => {
    if (pressTimer !== null) {
      clearTimeout(pressTimer);
      pressTimer = null;
    }
  };
  row.addEventListener("pointerdown", startPress);
  row.addEventListener("pointerup", cancelPress);
  row.addEventListener("pointermove", cancelPress);
  row.addEventListener("pointerleave", cancelPress);
  row.addEventListener("contextmenu", (ev) => {
    ev.preventDefault();
    openDeviceDetail(dev);
  });
  return row;
}

function connectedMeta(status = appState.status): string {
  const c = appState.client;
  if (c?.isConnected) return `${status.text} · offset ${c.clock.offsetMs.toFixed(1)}ms`;
  return status.text;
}

/** Detail popup: recorded LAN address, MAC, Bluetooth name + editable display
 * name (reflected to the device on connect). */
function openDeviceDetail(dev: KnownDevice): void {
  const cur = deviceStore.get(dev.id) ?? dev;
  const sheet = Sheet("Device");
  sheet.body.className = "device-detail";

  const nameLabel = document.createElement("label");
  nameLabel.className = "device-detail-field";
  const nameCap = document.createElement("span");
  nameCap.className = "device-detail-cap";
  nameCap.textContent = "Display name (also the Bluetooth name)";
  const input = document.createElement("input");
  input.className = "sheet-input";
  input.value = cur.label;
  nameLabel.append(nameCap, input);

  const rowFor = (cap: string, value: string): HTMLElement => {
    const r = document.createElement("div");
    r.className = "device-detail-row";
    const c = document.createElement("span");
    c.className = "device-detail-cap";
    c.textContent = cap;
    const v = document.createElement("span");
    v.className = "device-detail-val metric";
    v.textContent = value;
    r.append(c, v);
    return r;
  };

  const isActive = deviceStore.activeId() === dev.id && (appState.client?.isConnected ?? false);
  const save = Button({
    label: "Save name",
    block: true,
    onClick: () => {
      const name = input.value.trim();
      if (!name || name === cur.label) {
        sheet.close();
        return;
      }
      // Optimistic + queued for next connect; push live if connected now.
      deviceStore.rename(dev.id, name);
      if (isActive && appState.client) {
        void appState.client
          .setDeviceName(name)
          .then((w) => {
            deviceStore.applyWelcome(dev.id, { mac: w.mac, deviceName: w.deviceName });
            deviceStore.takePending(dev.id);
            toast("Device renamed");
          })
          .catch(() => toast("Rename will apply on next connection"));
      } else {
        toast("Name saved — applies on next connection");
      }
      sheet.close();
    },
  });

  sheet.body.append(
    nameLabel,
    rowFor("LAN address", deviceHost(cur)),
    rowFor("MAC address", cur.bleMac || "unknown (connect once)"),
    rowFor("Bluetooth name", cur.label),
    rowFor("Folder", cur.folder || "Ungrouped"),
    save,
    Button({
      label: "Move to folder…",
      icon: "folder",
      variant: "quiet",
      block: true,
      onClick: () => {
        sheet.close();
        openFolderPicker({
          current: cur.folder ?? "",
          existing: deviceStore.folders(),
          onPick: (folder) => deviceStore.setFolder(dev.id, folder),
        });
      },
    }),
    Button({
      label: "Forget device",
      icon: "trash",
      variant: "danger",
      block: true,
      onClick: () => {
        deviceStore.forget(dev.id);
        sheet.close();
      },
    }),
  );
  input.focus();
}

/**
 * Popup-based self-signed-cert trust (unchanged from main.ts §4.1). A browser
 * only offers "proceed anyway" for a TOP-LEVEL context, so we open the device's
 * https page as a popup; its page postMessages us once past the interstitial.
 */
function trustCert(certUrl: string): void {
  const deviceOrigin = new URL(certUrl).origin;
  const wssUrl = appState.client?.url ?? null;
  appState.disconnect(); // stop competing for the device's scarce TLS slots
  let popup: Window | null = null;
  let done = false;
  const finish = (): void => {
    if (done) return;
    done = true;
    try {
      popup?.close();
    } catch {
      /* cross-origin close may be refused — the reconnect covers it */
    }
    if (wssUrl) appState.connect(wssUrl); // fresh client, cert now trusted
    toast("Certificate trusted — connecting…");
  };
  window.addEventListener("message", (ev: MessageEvent): void => {
    if (ev.origin === deviceOrigin && ev.data === "ledmapper-cert-ok") finish();
  });
  const armReturn = (): void => {
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") finish();
    });
  };
  armReturn();
  popup = window.open(certUrl, "ledmapper-cert", "width=420,height=560");
  if (popup === null) {
    toast("Popup blocked — open the device page, accept the warning, then return", { error: true });
    window.open(certUrl, "_blank", "noopener");
  }
}

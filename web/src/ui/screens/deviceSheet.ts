/**
 * Device sheet (design doc §6.2 / §7.4) — a bottom sheet reachable everywhere
 * (the app-bar pill and the Device tab both open it). Lists known devices with
 * status, lets the user switch/forget, add a device (re-enters onboarding),
 * enter an address manually, and surfaces connection/cert errors in-context.
 */

import { Button, IconButton, Sheet, toast } from "../kit";
import { appState } from "../app/state";
import { deviceStore, type KnownDevice } from "../../store/deviceStore";

let openHandle: { close: () => void } | null = null;

export function openDeviceSheet(): void {
  if (openHandle) return; // already open — don't stack
  // onClose fires for EVERY close path (✕, scrim, programmatic), so the reopen
  // guard is always reset — the ✕ calls the sheet's internal close, not this
  // handle, so we must hook onClose rather than wrap handle.close.
  let unsubDev: () => void = () => {};
  let unsubApp: () => void = () => {};
  const sheet = Sheet("Devices", {
    onClose: () => {
      unsubDev();
      unsubApp();
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
    const btn = Button({
      label: "Trust & connect",
      onClick: () => trustCert(status.certUrl!),
    });
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

  for (const dev of devices) {
    wrap.append(deviceRow(dev, dev.id === activeId, status));
  }

  // -- add-device section: a labelled divider, then two compact icon buttons
  // side by side (Bluetooth onboarding / manual address). Icon-only keeps them
  // small; the label tells the user what the row is for.
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
      onClick: () => {
        openHandle?.close();
        location.hash = "#/onboard";
      },
    }),
    IconButton("link", {
      title: "Enter address manually",
      onClick: () => addManual(),
    }),
  );
  addSection.append(addLabel, addRow);
  wrap.append(addSection);
  return wrap;
}

function deviceRow(dev: KnownDevice, isActive: boolean, status = appState.status): HTMLElement {
  const row = document.createElement("div");
  row.className = "device-row";

  const dot = document.createElement("span");
  dot.className = "device-dot";
  dot.dataset["state"] = isActive ? status.state : "offline";

  const info = document.createElement("div");
  info.className = "device-info";
  const name = document.createElement("div");
  name.className = "device-name";
  name.textContent = dev.label;
  const url = document.createElement("div");
  url.className = "device-url";
  url.textContent = dev.wssUrl;
  info.append(name, url);
  if (isActive) {
    const meta = document.createElement("div");
    meta.className = "device-meta metric";
    const c = appState.client;
    if (c?.isConnected) {
      const sync = c.clock;
      meta.textContent = `${status.text} · offset ${sync.offsetMs.toFixed(1)}ms`;
    } else {
      meta.textContent = status.text;
    }
    info.append(meta);
  }

  const btns = document.createElement("div");
  btns.className = "device-btns";
  if (isActive) {
    btns.append(
      Button({ label: "Disconnect", variant: "quiet", onClick: () => appState.disconnect() }),
    );
  } else {
    btns.append(
      Button({ label: "Connect", onClick: () => appState.connect(dev.wssUrl, dev.label) }),
    );
  }
  btns.append(IconButton("trash", { title: "Forget", onClick: () => deviceStore.forget(dev.id) }));

  row.append(dot, info, btns);
  return row;
}

function addManual(): void {
  const url = prompt("Player address (wss://host:port):", appState.client?.url ?? "wss://");
  if (!url) return;
  if (!/^wss?:\/\//.test(url)) {
    toast("Address must start with ws:// or wss://", { error: true });
    return;
  }
  appState.connect(url);
}

/**
 * Popup-based self-signed-cert trust (unchanged from main.ts §4.1). A browser
 * only offers "proceed anyway" for a TOP-LEVEL context, so we open the device's
 * https page as a popup; its page postMessages us once past the interstitial.
 * We first close the client (a heap-tight ESP holds ~2 TLS sessions; our wss
 * retries would starve the cert page), then reconnect on the ok signal or the
 * visibility-return fallback.
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

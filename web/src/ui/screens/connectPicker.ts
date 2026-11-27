/**
 * The one way in (D-72): a labelled "Connect a fixture" button — the same on the
 * welcome screen and in the device sheet — that opens a picker of connection
 * modes, each with a preview drawing and one line on what it is for:
 *
 *   - Set up a new fixture        (Bluetooth → Wi-Fi provisioning, Improv)
 *   - Connect directly over Bluetooth  (the BLE player transport, no Wi-Fi)
 *   - Connect by network address  (a fixture already on the Wi-Fi)
 *
 * Fixtures the app finds on the network by itself (net/discovery.ts) are listed
 * above the modes, one tap to connect. "Flash a new device" is its own labelled
 * button beside Connect, never inside the picker; where USB flashing can't work
 * (iPhone/iPad, browsers without Web Serial/WebUSB) it explains, with a drawing,
 * to plug the fixture into a laptop or an Android phone instead.
 *
 * The drawings are rendered from the product's mechanical design by
 * tools/connect_diagrams (web/public/connect/*.png).
 */

import { Button, Sheet } from "../kit";
import { assetUrl } from "../../assetBase";
import { bleAvailable } from "../../net/improv";
import { isNativePlatform } from "../../net/native";
import { discovery, type FoundFixture } from "../../net/discovery";
import { summarizeEnv } from "../../flash/env";
import { appState } from "../app/state";
import { connectOverBle, openAddDevice } from "./addDevice";
import { installConnectStyles } from "./connectPicker.css";

let openHandle: { close: () => void } | null = null;

export interface ConnectMode {
  id: "setup" | "ble" | "address";
  title: string;
  blurb: string;
  image: string;
  /** Why it can't be used here (null = available). */
  unavailable: string | null;
  run: () => void;
}

/** The three ways to connect, in the order the picker shows them. */
export function connectModes(onDone?: () => void): ConnectMode[] {
  const noBle = bleAvailable()
    ? null
    : "Needs Bluetooth: use Chrome or Edge on a computer or Android phone, or the Splanc app.";
  return [
    {
      id: "setup",
      title: "Set up a new fixture",
      blurb: "Over Bluetooth: give a new fixture your Wi-Fi details so it joins your network.",
      image: "connect/setup-ble.png",
      unavailable: noBle,
      run: () => openAddDevice("ble", onDone),
    },
    {
      id: "ble",
      title: "Connect directly over Bluetooth",
      blurb: "Control a nearby fixture with no Wi-Fi at all, for places without a network.",
      image: "connect/direct-ble.png",
      unavailable: noBle,
      run: () => connectOverBle(onDone),
    },
    {
      id: "address",
      title: "Connect by network address",
      blurb: "Type the IP address or name of a fixture that is already on your Wi-Fi.",
      image: "connect/address.png",
      unavailable: null,
      run: () => openAddDevice("manual", onDone),
    },
  ];
}

/** The connect picker sheet. */
export function openConnectPicker(onDone?: () => void): void {
  if (openHandle) return;
  installConnectStyles();
  const stop = discovery.start();
  let unsub: () => void = () => {};
  const sheet = Sheet("Connect a fixture", {
    onClose: () => {
      unsub();
      stop();
      openHandle = null;
    },
  });
  openHandle = sheet;
  sheet.body.classList.add("connect-picker");

  const found = document.createElement("div");
  const renderFound = (): void => {
    const fresh = discovery.view().fresh;
    found.replaceChildren();
    if (fresh.length === 0) return;
    found.append(
      sectionLabel("On this network"),
      FoundList(fresh, () => sheet.close()),
    );
  };
  renderFound();
  unsub = discovery.subscribe(renderFound);

  const modes = document.createElement("div");
  modes.className = "connect-modes";
  for (const m of connectModes(onDone)) {
    modes.append(
      modeCard(m, () => {
        // Close first: the mode opens its own sheet (or the Bluetooth chooser,
        // which must be the first async step of this click — see addDevice.ts).
        sheet.close();
        m.run();
      }),
    );
  }

  const wifi = Button({
    label: "Saved Wi-Fi networks",
    icon: "wifi",
    variant: "quiet",
    block: true,
    onClick: () => {
      sheet.close();
      location.hash = "#/settings/wifi";
    },
  });
  wifi.classList.add("connect-footer");

  // A bridge isn't a fixture: its own flow (#698), named here so nobody has to guess
  // that "Set up a new fixture" would do.
  const bridge = Button({
    label: "Set up a Splanc bridge",
    icon: "link",
    variant: "quiet",
    block: true,
    onClick: () => {
      sheet.close();
      location.hash = "#/bridge/setup";
    },
  });
  bridge.classList.add("connect-footer");

  sheet.body.append(found, sectionLabel("Choose how to connect"), modes, bridge, wifi);
}

function sectionLabel(text: string): HTMLElement {
  const l = document.createElement("div");
  l.className = "connect-label";
  l.textContent = text;
  return l;
}

function modeCard(m: ConnectMode, onPick: () => void): HTMLElement {
  const card = document.createElement("button");
  card.type = "button";
  card.className = "connect-mode";
  card.title = m.title;
  card.dataset["mode"] = m.id;
  const img = document.createElement("img");
  img.className = "connect-mode-img";
  img.src = assetUrl(m.image);
  img.alt = "";
  img.decoding = "async";
  const text = document.createElement("span");
  text.className = "connect-mode-text";
  const t = document.createElement("span");
  t.className = "connect-mode-title";
  t.textContent = m.title;
  const b = document.createElement("span");
  b.className = "connect-mode-blurb";
  b.textContent = m.unavailable ?? m.blurb;
  text.append(t, b);
  card.append(img, text);
  if (m.unavailable) {
    card.disabled = true;
    card.classList.add("connect-mode--off");
  } else {
    card.addEventListener("click", onPick);
  }
  return card;
}

/** Rows for fixtures found on the network that the app doesn't know yet. */
export function FoundList(fresh: readonly FoundFixture[], onConnect?: () => void): HTMLElement {
  installConnectStyles();
  const list = document.createElement("div");
  list.className = "connect-found";
  for (const f of fresh) {
    const row = document.createElement("div");
    row.className = "device-row connect-found-row";
    const dot = document.createElement("span");
    dot.className = "device-dot";
    dot.dataset["state"] = "reachable";
    const info = document.createElement("div");
    info.className = "device-info";
    const name = document.createElement("div");
    name.className = "device-name";
    name.textContent = f.name;
    const meta = document.createElement("div");
    meta.className = "device-url";
    meta.textContent = `on this network · ${f.host}`;
    info.append(name, meta);
    const go = Button({
      label: "Connect",
      onClick: () => {
        appState.connect(f.url, f.name);
        onConnect?.();
      },
    });
    go.classList.add("device-act");
    go.title = `Connect to ${f.name}`;
    row.append(dot, info, go);
    list.append(row);
  }
  return list;
}

// -- the two top-level actions ------------------------------------------------

/** "Connect a fixture" (primary unless `quietConnect`) and "Flash a new device"
 * (secondary), each a full-width button on its own row. */
export function ConnectActions(opts: { quietConnect?: boolean; onDone?: () => void } = {}): HTMLElement {
  installConnectStyles();
  const wrap = document.createElement("div");
  wrap.className = "connect-actions";
  const connect = Button({
    label: "Connect a fixture",
    icon: "plus",
    block: true,
    ...(opts.quietConnect ? { variant: "quiet" as const } : {}),
    onClick: () => openConnectPicker(opts.onDone),
  });
  connect.classList.add("connect-primary");
  connect.title = "Connect a fixture";
  const flash = Button({
    label: "Flash a new device",
    icon: "chip",
    variant: "quiet",
    block: true,
    onClick: () => openFlashEntry(),
  });
  flash.classList.add("connect-flash");
  flash.title = "Flash a new device";
  wrap.append(connect, flash);
  return wrap;
}

/** Can this browser/app flash a board over USB? (No esptool import: cheap.) */
export function usbFlashAvailable(): boolean {
  if (isNativePlatform()) return false; // iOS: no USB serial for apps at all
  if (typeof navigator === "undefined") return false;
  return summarizeEnv({
    serial: "serial" in navigator,
    usb: "usb" in navigator,
    secureContext: typeof window === "undefined" ? true : window.isSecureContext !== false,
    userAgent: navigator.userAgent ?? "",
  }).ok;
}

function isAppleMobile(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent ?? "";
  // iPadOS reports a Mac UA; touch points tell it apart from a real Mac.
  return /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && (navigator.maxTouchPoints ?? 0) > 1);
}

/** "Flash a new device": the flasher where USB works, else how to do it elsewhere. */
export function openFlashEntry(): void {
  if (usbFlashAvailable()) {
    void import("./flashSheet").then((m) => m.openFlashSheet());
    return;
  }
  openFlashElsewhere();
}

/** The pictogram sheet: plug the fixture into a laptop or an Android phone. */
export function openFlashElsewhere(): void {
  installConnectStyles();
  const sheet = Sheet("Flash a new device");
  sheet.body.classList.add("connect-flash-sheet");
  const img = document.createElement("img");
  img.className = "connect-flash-img";
  img.src = assetUrl("connect/flash-usb.png");
  img.alt = "A Splanc fixture plugged by USB-C into a laptop, or into an Android phone";
  const lead = document.createElement("p");
  lead.className = "connect-flash-lead";
  lead.textContent =
    isNativePlatform() || isAppleMobile()
      ? "iPhone and iPad can't flash a fixture over USB."
      : "This browser can't flash a fixture over USB.";
  const how = document.createElement("p");
  how.className = "connect-flash-how";
  how.textContent =
    "Plug the fixture into a laptop or an Android phone with a USB-C data cable, open " +
    "splanc.io/app there in Chrome or Edge, and choose Flash a new device. Once it is on " +
    "your Wi-Fi, it shows up here.";
  const ok = Button({ label: "Got it", block: true, onClick: () => sheet.close() });
  sheet.body.append(img, lead, how, ok);
}

/**
 * Device sheet (design doc §6.2 / §7.4) — a bottom sheet reachable everywhere
 * (the app-bar pill and the Device tab both open it). Lists known devices by
 * their display name, shows reachability (probed over the wss the app already
 * uses — a device answers `welcome` with its MAC + name), and lets the user
 * connect, re-discover over Bluetooth when unreachable, rename, and forget.
 *
 * Each row's 3-dots (⋮) menu opens a detail popup with the recorded LAN address,
 * MAC, Bluetooth name, the editable display name (reflected to the device — and
 * its Bluetooth advertisement — on connect), and Forget. Delete lives in there,
 * not as a one-tap top-level button, so it can't be hit by accident.
 */

import { buildLabel, commitUrl } from "../../buildInfo";
import { ActionGrid, Button, IconButton, Sheet, toast } from "../kit";
import { appState } from "../app/state";
import { deviceProber } from "../../net/deviceProber";
import { deviceStore, deviceHost, type KnownDevice } from "../../store/deviceStore";
import { bleRediscover, openAddDevice } from "./addDevice";
import { appendGrouped, openFolderPicker } from "./folders";

let openHandle: { close: () => void } | null = null;

// Connecting-plug animation period (ms). The button is recreated on every
// re-render (one per status change while connecting), so its animation is phase-
// synced to a global clock via the --conn-phase delay to avoid restarting.
const CONN_ANIM_MS = 1200;

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
  // Pull down on the list for a one-shot poll of every device's reachability.
  attachPullToRefresh(sheet.body, () => deviceProber.probeAllNow());
}

/** Pull-to-refresh on the sheet's scroll container: dragging down while scrolled
 * to the top, past a threshold, fires a one-shot poll. The indicator lives
 * between the head and the list, so the pull reveals it in place. Touch-only —
 * desktop uses the auto-poll + reopening the sheet (which calls refresh()). */
function attachPullToRefresh(body: HTMLElement, onRefresh: () => Promise<void>): void {
  const scroller = body.parentElement; // .k-sheet (overflow-y: auto)
  if (!scroller) return;
  const ind = document.createElement("div");
  ind.className = "device-ptr";
  const spin = document.createElement("div");
  spin.className = "device-ptr-spin"; // frozen while pulling, spins on release
  ind.append(spin);
  scroller.insertBefore(ind, body);

  const THRESHOLD = 60;
  const MAX = 90;
  let startY = 0;
  let pulling = false;
  let busy = false;
  let pull = 0;

  const setPull = (px: number): void => {
    pull = px;
    ind.style.height = `${px}px`;
    // The spinner rides the bottom edge (flex-end) — it slides in from the fold —
    // and fades up to full as the pull clears the threshold.
    spin.style.opacity = `${Math.min(1, px / THRESHOLD)}`;
  };
  const reset = (): void => {
    ind.classList.remove("device-ptr--active", "device-ptr--busy", "device-ptr--done");
    ind.style.height = "";
    spin.style.opacity = "";
    pull = 0;
    pulling = false;
    busy = false;
  };

  scroller.addEventListener(
    "touchstart",
    (e) => {
      if (busy) return;
      pulling = scroller.scrollTop <= 0 && e.touches.length === 1;
      startY = e.touches[0]!.clientY;
    },
    { passive: true },
  );
  scroller.addEventListener(
    "touchmove",
    (e) => {
      if (!pulling || busy) return;
      if (scroller.scrollTop > 0) {
        setPull(0);
        pulling = false;
        return;
      }
      const dy = e.touches[0]!.clientY - startY;
      if (dy <= 0) {
        setPull(0);
        return;
      }
      e.preventDefault(); // take over from native overscroll while pulling
      ind.classList.add("device-ptr--active");
      setPull(Math.min(MAX, dy * 0.5));
    },
    { passive: false },
  );
  const end = (): void => {
    if (!pulling || busy) return;
    ind.classList.remove("device-ptr--active");
    if (pull >= THRESHOLD) {
      // Release past the threshold: settle to the threshold height and start the
      // spinner spinning; when the poll resolves, pop it out, then collapse.
      busy = true;
      ind.classList.add("device-ptr--busy");
      ind.style.height = `${THRESHOLD}px`;
      spin.style.opacity = "1";
      void onRefresh().finally(() => {
        ind.classList.remove("device-ptr--busy");
        ind.classList.add("device-ptr--done"); // spinner pops out
        window.setTimeout(reset, 240);
      });
    } else {
      reset();
    }
  };
  scroller.addEventListener("touchend", end);
  scroller.addEventListener("touchcancel", end);
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
    empty.textContent = "No devices yet. Add one to get started.";
    wrap.append(empty);
  }

  appendGrouped(
    wrap,
    devices,
    (dev) => dev.folder,
    (dev) => deviceRow(dev, dev.id === activeId, status, deviceProber.isReachable(dev.id)),
    { scope: "devices" },
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
    // Flash a new/blank board over USB (WebSerial). The whole flasher — esptool-js
    // and the USB code — is loaded lazily so it never weighs on the main bundle.
    IconButton("chip", {
      title: "Flash firmware (USB)",
      onClick: () => void import("./flashSheet").then((m) => m.openFlashSheet()),
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

  // Fully connected only once the handshake AND clock sync are done (status
  // "connected"). "connecting…" and "syncing clock…" both report state
  // "connecting", so both keep the in-progress affordance below.
  const fullyConnected = isActive && status.state === "connected";
  const dot = document.createElement("span");
  dot.className = "device-dot";
  dot.dataset["state"] = isActive
    ? status.state // connecting (incl. syncing) / connected / error / offline
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
  if (fullyConnected) {
    btns.append(
      IconButton("plug-off", {
        title: "Disconnect",
        className: "device-disconnect",
        onClick: () => appState.disconnect(),
      }),
    );
  } else if (isActive) {
    // Active but not fully connected yet (connecting, syncing clock, or awaiting
    // cert trust): a gray, pulsing plug so it reads as in-progress. Tap cancels.
    // Phase-sync the animation to a global clock so the re-render on each status
    // change doesn't restart it (negative delay = current phase of a 1.2s cycle).
    const connectingBtn = IconButton("plug", {
      title: "Connecting… (tap to cancel)",
      className: "device-connecting",
      onClick: () => appState.disconnect(),
    });
    const nowMs = typeof performance !== "undefined" ? performance.now() : 0;
    connectingBtn.style.setProperty("--conn-phase", `-${nowMs % CONN_ANIM_MS}ms`);
    btns.append(connectingBtn);
  } else if (isReachable) {
    btns.append(
      IconButton("plug", {
        title: "Connect",
        className: "device-connect",
        onClick: () => appState.connect(dev.wssUrl, dev.label),
      }),
    );
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
  // The 3-dots menu opens the device config (rename, folder, color correction,
  // and Forget). Delete lives in there rather than as a top-level trash button,
  // so it isn't a one-tap action next to Connect.
  btns.append(IconButton("more", { title: "Options", onClick: () => openDeviceDetail(dev) }));

  row.append(dot, info, btns);
  return row;
}

function connectedMeta(status = appState.status): string {
  const c = appState.client;
  if (!c?.isConnected) return status.text;
  // NOT the clock offset: that's device-uptime minus tab-uptime — two unrelated
  // monotonic epochs, so it's huge (hours in ms) and meaningless to a user. Show
  // the round-trip latency (the kept min-RTT sample) instead: small, and an
  // actual connection-quality signal. Infinity until the first clock sync lands.
  const rtt = c.clock.rttMs;
  return Number.isFinite(rtt) ? `${status.text} · ${Math.round(rtt)} ms RTT` : status.text;
}

/** Detail popup: an inline-editable display name, quick actions, and the recorded
 * LAN address / MAC / folder. */
function openDeviceDetail(dev: KnownDevice): void {
  const cur = deviceStore.get(dev.id) ?? dev;
  const sheet = Sheet("Device");
  sheet.body.className = "device-detail";
  const isActive = deviceStore.activeId() === dev.id && (appState.client?.isConnected ?? false);
  let currentLabel = cur.label;

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

  // Like rowFor, but the value is a link to the GitHub commit page (FUG-126).
  const commitRowFor = (cap: string, commit: string, dirty: boolean): HTMLElement => {
    if (!commit) return rowFor(cap, "unknown (connect once)");
    const r = document.createElement("div");
    r.className = "device-detail-row";
    const c = document.createElement("span");
    c.className = "device-detail-cap";
    c.textContent = cap;
    const a = document.createElement("a");
    a.className = "device-detail-val metric about-link";
    a.href = commitUrl(commit);
    a.textContent = buildLabel(commit, dirty);
    a.title = commit;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    r.append(c, a);
    return r;
  };

  // -- display name: a label with a pencil; tapping swaps in an input + floppy.
  const nameField = document.createElement("div");
  nameField.className = "device-detail-field";
  const nameCap = document.createElement("span");
  nameCap.className = "device-detail-cap";
  nameCap.textContent = "Display name (also the Bluetooth name)";
  const nameRow = document.createElement("div");
  nameRow.className = "device-name-row";
  nameField.append(nameCap, nameRow);

  const commit = (name: string): void => {
    // Optimistic + queued for next connect; push live if connected now.
    deviceStore.rename(dev.id, name);
    if (isActive && appState.client) {
      void appState.client
        .setDeviceName(name)
        .then((w) => {
          deviceStore.applyWelcome(dev.id, {
            mac: w.mac,
            deviceName: w.deviceName,
            fwGitCommit: w.fwGitCommit,
            fwGitDirty: w.fwGitDirty,
            fwVersion: w.fwVersion,
          });
          deviceStore.takePending(dev.id);
          toast("Device renamed");
        })
        .catch(() => toast("Rename will apply on next connection"));
    } else {
      toast("Name saved — applies on next connection");
    }
  };

  const showLabel = (): void => {
    const val = document.createElement("span");
    val.className = "device-name-val";
    val.textContent = currentLabel;
    const edit = IconButton("edit", { title: "Rename", onClick: () => showEditor() });
    nameRow.replaceChildren(val, edit);
  };

  const showEditor = (): void => {
    const input = document.createElement("input");
    input.className = "sheet-input device-name-input";
    input.value = currentLabel;
    const saveBtn = IconButton("save", { title: "Save", onClick: () => finish(true) });
    // Save on pointerdown, which fires BEFORE the input's blur. On iOS WKWebView
    // the pointerdown preventDefault doesn't reliably keep the input focused, so
    // tapping the floppy blurs first → the blur's cancel (finish(false)) runs and
    // swallows the save (the rename "flips back" to the old name). Committing in
    // pointerdown guarantees the save lands regardless of blur/click ordering;
    // preventDefault still suppresses the focus flicker. (The click handler stays
    // as a harmless no-op fallback via the `done` guard.)
    saveBtn.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      finish(true);
    });
    let done = false;
    const finish = (save: boolean): void => {
      if (done) return;
      done = true;
      const name = input.value.trim();
      if (save && name && name !== currentLabel) {
        currentLabel = name;
        commit(name);
      }
      showLabel();
    };
    input.addEventListener("blur", () => finish(false)); // tap away cancels
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        finish(true);
      } else if (e.key === "Escape") {
        e.preventDefault();
        finish(false);
      }
    });
    nameRow.replaceChildren(input, saveBtn);
    input.focus();
    input.select();
  };

  showLabel();

  const divider = document.createElement("hr");
  divider.className = "device-detail-divider";

  sheet.body.append(
    nameField,
    ActionGrid([
      {
        label: "Gamma",
        icon: "gamma",
        onClick: () => {
          sheet.close();
          location.hash = "#/settings/color-correction";
        },
      },
      {
        label: "Hardware",
        icon: "chip",
        onClick: () => {
          sheet.close();
          location.hash = "#/settings/hardware";
        },
      },
      {
        label: "Move",
        icon: "folder",
        onClick: () => {
          sheet.close();
          openFolderPicker({
            current: cur.folder ?? "",
            existing: deviceStore.folders(),
            onPick: (folder) => deviceStore.setFolder(dev.id, folder),
          });
        },
      },
      {
        label: "Forget",
        icon: "trash",
        variant: "danger",
        onClick: () => {
          deviceStore.forget(dev.id);
          sheet.close();
        },
      },
    ]),
    divider,
    rowFor("LAN address", deviceHost(cur)),
    rowFor("MAC address", cur.bleMac || "unknown (connect once)"),
    rowFor("Firmware version", cur.fwVersion || "unknown (connect once)"),
    commitRowFor("Firmware build", cur.fwGitCommit ?? "", cur.fwGitDirty ?? false),
    rowFor("Folder", cur.folder || "Ungrouped"),
  );
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
  // Named handlers so finish() can REMOVE them: without this, every "Trust &
  // connect" click (and the flow re-pops on a mid-linger bounce) leaked a fresh
  // message + visibilitychange pair. The stale listeners kept firing finish() on
  // later returns, racing disconnect()/connect() and thrashing the player's ~2
  // TLS slots until only a full page reload cleared them — the reload-to-recover
  // bug. One trust attempt now registers exactly one pair and tears it down.
  const onMessage = (ev: MessageEvent): void => {
    if (ev.origin === deviceOrigin && ev.data === "ledmapper-cert-ok") finish();
  };
  const onVisible = (): void => {
    if (document.visibilityState === "visible") finish();
  };
  const finish = (): void => {
    if (done) return;
    done = true;
    window.removeEventListener("message", onMessage);
    document.removeEventListener("visibilitychange", onVisible);
    try {
      popup?.close();
    } catch {
      /* cross-origin close may be refused — the reconnect covers it */
    }
    // Give the player a beat to release the TLS slot the socket we just closed
    // (and the popup's cert-page load) still hold, THEN reconnect over the backoff
    // (not the default single cold attempt): the cert is trusted now, so what's
    // left is transient slot-linger that clears within a second or two. Without
    // the delay the first attempt lands mid-linger and bounces the user back to
    // "trust needed"; without the backoff it wouldn't retry after that.
    if (wssUrl) {
      window.setTimeout(() => appState.connect(wssUrl, undefined, { coldRetryLimit: 6 }), 800);
    }
    toast("Certificate trusted — connecting…");
  };
  window.addEventListener("message", onMessage);
  document.addEventListener("visibilitychange", onVisible);
  popup = window.open(certUrl, "ledmapper-cert", "width=420,height=560");
  if (popup === null) {
    toast("Popup blocked — open the device page, accept the warning, then return", { error: true });
    window.open(certUrl, "_blank", "noopener");
  }
}

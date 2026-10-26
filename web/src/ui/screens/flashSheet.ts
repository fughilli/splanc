/**
 * Flash / commission a board (FUG-60; FUG-85 Android/WebUSB) — a bottom sheet
 * reached from the Device tab. Flashes the firmware image(s) this build bundles
 * onto a USB-connected board over Web Serial (native on desktop Chromium, or via
 * the WebUSB polyfill on Android Chrome — see flash/webserial.ts), with live
 * progress, a log, and a diagnostics panel so a failed attempt (e.g. neither API
 * present on iOS, or the chooser finding nothing) is self-explaining rather than
 * a dead end.
 *
 * Everything USB/flasher-related is loaded lazily from here (this screen is the
 * only static importer of the flash/ modules, and it's itself dynamically
 * imported by the device sheet), so esptool-js never weighs on the main bundle
 * until someone actually opens this flow.
 */

import { Button, Sheet, toast, type SheetHandle } from "../kit";
import {
  loadFirmwareIndex,
  loadFlashRequest,
  totalBytes,
  downloadFirmwareToCache,
  prefetchLatestFirmware,
} from "../../flash/firmwareRepo";
import { loadReleaseFirmwareIndex, proxiedAssetUrl, siblingAssetUrl } from "../../flash/githubReleaseRepo";
import { cachedIds, deleteBundle, listBundles } from "../../flash/firmwareCache";
import {
  webSerialUnavailableReason,
  requestSerialPort,
  portUsbId,
  readFlashEnv,
  authorizedPortIds,
  describeFilters,
  isPolyfillActive,
  KNOWN_SERIAL_FILTERS,
} from "../../flash/webserial";
import { summarizeEnv } from "../../flash/env";
import { identifyUsb, formatUsbId } from "../../flash/usb";
import { getFlasher, type FlashHooks } from "../../flash/flasher";
import { isNativePlatform } from "../../net/native";
import { buildLabel, commitUrl } from "../../buildInfo";
import type { FirmwareEntry, FirmwareIndex } from "../../flash/manifest";
import { appState } from "../app/state";
import type { LedMapperClient } from "../../net/client";
import { inLoader, maxManifestAsset, OtaError, pullsImage, updateFirmware, type OtaProgress } from "../../net/otaUpdate";

let openHandle: SheetHandle | null = null;

/** Where firmware comes from: published GitHub releases (default — pick any
 * version × variant) or the same-commit bundle this build staged under /firmware/
 * (the "dev" fallback, e.g. a PR preview flashing its exact-commit firmware). */
type FwSource = "release" | "bundled";
let currentSource: FwSource = "release";

/** Ids of firmware versions cached for OFFLINE flashing — refreshed on each picker
 * load and after a manage-drawer download/remove, and used to mark them in the UI. */
let cachedSet = new Set<string>();

function loadIndexForSource(source: FwSource): Promise<FirmwareIndex | null> {
  return source === "release" ? loadReleaseFirmwareIndex() : loadFirmwareIndex();
}

// Demo/capture mode (FUG-103 docs screenshots): when set, openFlashSheet() shows
// a canned "flashed" view with a simulated esptool log instead of driving real
// hardware (no Web Serial / firmware / chip in a headless browser).
let demoFlash = false;
export function enableDemoFlash(): void {
  demoFlash = true;
}

/** Render a finished demo flash: a simulated ESP32-C6 esptool/bootloader log +
 * a full progress bar, as if a real board had just been flashed. */
function renderDemoFlash(sheet: SheetHandle): void {
  sheet.body.innerHTML = "";
  const status = document.createElement("div");
  status.className = "flash-status flash-status--ok";
  status.textContent = "Flashed ESP32-C6 · reset into the app";
  const bar = document.createElement("div");
  bar.className = "flash-bar";
  const fill = document.createElement("div");
  fill.className = "flash-bar-fill flash-bar-fill--done";
  fill.style.width = "100%";
  bar.append(fill);
  const log = document.createElement("pre");
  log.className = "flash-log";
  log.textContent = [
    "Port USB id: 303a:1001 — Espressif ESP32-C6",
    "Firmware: 1.21 MB across 4 image(s).",
    "esptool.py v4.7.0",
    "Connecting.....",
    "Chip is ESP32-C6 (QFN40) (revision v0.1)",
    "Features: WiFi 6, BT 5, IEEE802.15.4",
    "Crystal is 40MHz",
    "MAC: 40:4c:ca:4b:9e:20",
    "Uploading stub...",
    "Running stub...",
    "Stub running...",
    "Configuring flash size...",
    "Flash will be erased from 0x00000000 to 0x00005fff...",
    "Flash will be erased from 0x00010000 to 0x0013afff...",
    "Compressed 1269248 bytes to 812004...",
    "Writing at 0x00010000... (25 %)",
    "Writing at 0x00050000... (58 %)",
    "Writing at 0x000a4000... (91 %)",
    "Writing at 0x00130000... (100 %)",
    "Wrote 1269248 bytes (812004 compressed) at 0x00010000 in 11.3 seconds.",
    "Hash of data verified.",
    "Leaving...",
    "Hard resetting via RTS pin...",
    "Done — the board is running the Splanc firmware.",
  ].join("\n");
  sheet.body.append(status, bar, log);
}

export async function openFlashSheet(): Promise<void> {
  if (openHandle) return;

  // Warm the offline cache with the latest release in the background (idempotent,
  // no-ops offline) so the newest firmware is flashable without a network even if
  // the connection drops mid-session.
  void prefetchLatestFirmware();

  // iOS gives third-party apps no USB-serial access at all (no Web Serial, no
  // WebUSB, and no native serial to an unlisted board — docs/design/ios-support.md
  // §3.1), so first-flash of a blank board can't happen on iPhone/iPad by any
  // path. Rather than open the flasher into a dead end, point the user to the
  // desktop web app, where Web Serial/WebUSB flashing works.
  usbBlocked = null;
  if (isNativePlatform() && otaTarget()) {
    // No USB here, but the connected device can update over Wi-Fi.
    usbBlocked = "USB flashing isn't available on this device.";
  } else if (isNativePlatform()) {
    const sheet = Sheet("Set up a new device", { onClose: () => (openHandle = null) });
    openHandle = sheet;
    sheet.body.append(
      note("Flashing a brand-new device over USB isn't supported on iPhone or iPad."),
      intro(
        "To provision a board for the first time, open splanc.io/app on a desktop or laptop " +
          "computer (Chrome or Edge) and use its flash tool. Once the device has joined your " +
          "Wi-Fi, you can add and control it here.",
      ),
      Button({
        label: "Got it",
        variant: "primary",
        block: true,
        onClick: () => sheet.close(),
      }),
    );
    return;
  }

  const sheet = Sheet("Flash firmware", { onClose: () => (openHandle = null) });
  openHandle = sheet;

  if (demoFlash) {
    renderDemoFlash(sheet);
    return;
  }

  const reason = usbBlocked ? null : webSerialUnavailableReason();
  if (reason && otaTarget()) {
    usbBlocked = reason;
  } else if (reason) {
    // Unsupported browser (commonly Android/iOS): explain, and show the full
    // capability report so it's clear WHAT is missing, not just that it failed.
    sheet.body.append(note(reason), intro(FLASH_HELP), buildDiagnostics({ open: true }));
    return;
  }

  await showPicker(sheet);
}

/** Load firmware for the current source and render the picker. On the release
 * source finding nothing (offline / rate-limited / no release ships firmware yet),
 * fall back to the bundled source before giving up, so flashing still works. */
async function showPicker(sheet: SheetHandle): Promise<void> {
  sheet.body.innerHTML = "";
  sheet.body.append(
    loadingLine(currentSource === "release" ? "Fetching firmware releases…" : "Looking for bundled firmware…"),
  );
  let index = await loadIndexForSource(currentSource);
  if (!index && currentSource === "release") {
    currentSource = "bundled";
    index = await loadIndexForSource(currentSource);
  }
  sheet.body.innerHTML = "";
  if (!index) {
    sheet.body.append(
      sourceField(sheet),
      note(
        "No firmware available from this source. Releases need a network connection; the bundled source needs a build with firmware staged.",
      ),
      intro(FLASH_HELP),
      buildDiagnostics(),
    );
    return;
  }
  cachedSet = await cachedIds(); // mark which versions are offline-ready
  renderIdle(sheet, index, index.entries[0]!);
}

/** The "Firmware source" selector (releases vs this build), shown atop the picker. */
function sourceField(sheet: SheetHandle): HTMLElement {
  const sel = document.createElement("select");
  sel.className = "sheet-input";
  for (const [value, label] of [
    ["release", "GitHub releases"],
    ["bundled", "This build (dev)"],
  ] as const) {
    const opt = document.createElement("option");
    opt.value = value;
    opt.textContent = label;
    if (value === currentSource) opt.selected = true;
    sel.append(opt);
  }
  sel.addEventListener("change", () => {
    currentSource = sel.value as FwSource;
    void showPicker(sheet);
  });
  return field("Firmware source", sel);
}

const FLASH_HELP =
  "Flashing runs entirely in your browser over USB — desktop Chrome/Edge (Web Serial) or Chrome on Android (WebUSB). Connect the board with a data-capable cable, then keep it plugged in until the write finishes.";

// -- idle: pick an image + flash -------------------------------------------

function renderIdle(sheet: SheetHandle, index: FirmwareIndex, selected: FirmwareEntry): void {
  sheet.body.innerHTML = "";
  sheet.body.append(intro(FLASH_HELP));

  // Firmware source (GitHub releases vs this build) — switching reloads the picker.
  sheet.body.append(sourceField(sheet));

  // On the WebUSB (Android) path there's a caveat worth stating up front — the
  // board is picked from the WebUSB prompt, and the OS may have claimed it.
  const envNote = summarizeEnv(readFlashEnv()).note;
  if (envNote) sheet.body.append(note(envNote));

  // Firmware picker (only shown when there's a real choice).
  if (index.entries.length > 1) {
    const sel = document.createElement("select");
    sel.className = "sheet-input";
    for (const e of index.entries) {
      const opt = document.createElement("option");
      opt.value = e.id;
      opt.textContent = e.label + (cachedSet.has(e.id) ? "  ·  cached ✓" : "");
      if (e.id === selected.id) opt.selected = true;
      sel.append(opt);
    }
    sel.addEventListener("change", () => {
      const next = index.entries.find((e) => e.id === sel.value);
      if (next) renderIdle(sheet, index, next);
    });
    sheet.body.append(field("Firmware", sel));
  }

  const card = document.createElement("div");
  card.className = "k-card flash-summary";
  card.append(
    kv("Firmware", selected.label),
    kv("Chip", selected.chip),
    kv("Version", selected.version || "dev (unversioned build)"),
    // The exact source: link the full commit when known, else the bundled short SHA.
    selected.commit
      ? kvCommit("Build", selected.commit)
      : kv("Built at", index.revision ? `revision ${index.revision}` : "unknown revision"),
  );
  if (cachedSet.has(selected.id)) card.append(kv("Offline", "cached — flashes without a network"));
  sheet.body.append(card);

  // Over the air: the connected device, if it has the OTA loader (welcome feature
  // "ota") or is sitting in its update loader right now (recovery).
  const target = otaTarget();
  if (target) {
    const w = target.welcome!;
    const name = w.deviceName || w.mac || "the connected device";
    if (inLoader(w)) {
      sheet.body.append(
        note(`${name} is in its updater (recovery mode): install firmware over Wi-Fi to bring it back.`),
      );
    }
    // The app advertises "ota" even on the legacy (pre-OTA) partition layout, where
    // an update over Wi-Fi can only be refused: ask the device up front and, if it
    // still has the old layout, say what to do instead of offering a doomed button.
    const slot = document.createElement("div");
    sheet.body.append(slot);
    const offer = (): void => {
      slot.replaceChildren(
        Button({
          label: `Update ${name} over Wi-Fi`,
          icon: "chip",
          variant: "primary",
          block: true,
          onClick: () => void startOtaUpdate(sheet, index, selected, target),
        }),
      );
    };
    if (inLoader(w)) offer();
    else {
      slot.append(note(`Checking whether ${name} can update over Wi-Fi…`));
      void otaReadiness(target).then((ready) => {
        if (ready === "legacy") slot.replaceChildren(note(legacyLayoutText(name)));
        else offer();
      });
    }
  }
  if (usbBlocked) {
    sheet.body.append(note(usbBlocked));
  } else {
    sheet.body.append(
      Button({
        label: "Connect a board & flash (USB)",
        icon: "chip",
        ...(target ? { variant: "quiet" as const } : {}),
        block: true,
        onClick: () => void startFlash(sheet, index, selected),
      }),
    );
  }
  // Manage the offline cache — only meaningful for the releases source (versioned,
  // downloadable). The bundled "this build" source has a single non-cacheable image.
  if (currentSource === "release") {
    sheet.body.append(
      Button({
        label: "Manage cached versions…",
        variant: "quiet",
        block: true,
        onClick: () => void renderManageDrawer(sheet, index, selected),
      }),
    );
  }
  sheet.body.append(buildDiagnostics());
}

/**
 * "Manage cached versions" drawer — lists every release × variant with its cached
 * state and per-version Download / Remove actions, so any version can be warmed for
 * OFFLINE flashing (or removed to reclaim space). The latest release is prefetched
 * automatically; this is where the user grabs any other one. Back returns to the picker.
 */
async function renderManageDrawer(
  sheet: SheetHandle,
  index: FirmwareIndex,
  selected: FirmwareEntry,
): Promise<void> {
  cachedSet = await cachedIds();
  const sizes = new Map((await listBundles()).map((b) => [b.id, b.size] as const));
  sheet.body.innerHTML = "";
  sheet.body.append(
    intro(
      "Downloaded versions are cached in this browser and flash without a network connection. " +
        "The latest release is fetched automatically; download any other version here.",
    ),
  );

  const releaseEntries = index.entries.filter((e) => e.tarUrl);
  if (releaseEntries.length === 0) sheet.body.append(note("No published firmware releases to manage."));

  for (const e of releaseEntries) {
    const isCached = cachedSet.has(e.id);
    const card = document.createElement("div");
    card.className = "k-card flash-summary";
    card.append(
      kv("Firmware", e.label),
      kv(
        "Status",
        isCached ? `Cached · ${fmtKB(sizes.get(e.id) ?? 0)} · flashes offline` : "Not downloaded",
      ),
    );
    if (isCached) {
      card.append(
        Button({
          label: "Remove",
          variant: "quiet",
          block: true,
          onClick: () => void removeThen(sheet, index, selected, e.id),
        }),
      );
    } else {
      card.append(
        Button({
          label: "Download for offline",
          icon: "chip",
          block: true,
          onClick: () => void downloadThen(sheet, index, selected, e),
        }),
      );
    }
    sheet.body.append(card);
  }

  sheet.body.append(
    Button({ label: "Back", variant: "quiet", block: true, onClick: () => renderIdle(sheet, index, selected) }),
  );
}

/** Remove a cached bundle, then re-render the drawer. */
async function removeThen(sheet: SheetHandle, index: FirmwareIndex, selected: FirmwareEntry, id: string): Promise<void> {
  await deleteBundle(id);
  await renderManageDrawer(sheet, index, selected);
}

/** Download+cache a version (pinned — user-requested, never auto-evicted), showing a
 * progress line, then re-render the drawer with it marked cached. */
async function downloadThen(
  sheet: SheetHandle,
  index: FirmwareIndex,
  selected: FirmwareEntry,
  entry: FirmwareEntry,
): Promise<void> {
  sheet.body.innerHTML = "";
  sheet.body.append(loadingLine(`Downloading ${entry.label}…`));
  try {
    await downloadFirmwareToCache(entry, true);
    toast(`Downloaded ${entry.label} — flashes offline now`);
  } catch (err) {
    toast(errText(err), { error: true });
  }
  await renderManageDrawer(sheet, index, selected);
}

// -- no device found -------------------------------------------------------

function renderNoDevice(
  sheet: SheetHandle,
  index: FirmwareIndex,
  entry: FirmwareEntry,
  filters: SerialPortFilter[],
): void {
  sheet.body.innerHTML = "";
  sheet.body.append(
    note(
      filters.length
        ? "No board selected, or none matched the USB vendor filter. If the board is plugged in but didn't appear, try again without the vendor filter to list every serial device."
        : "No board selected. Plug the board in over USB and try again.",
    ),
    buildDiagnostics({ open: true, filters }),
  );
  if (filters.length) {
    sheet.body.append(
      Button({
        label: "Try without vendor filter",
        icon: "chip",
        block: true,
        onClick: () => void startFlash(sheet, index, entry, []),
      }),
    );
  }
  sheet.body.append(
    Button({ label: "Back", variant: "quiet", block: true, onClick: () => renderIdle(sheet, index, entry) }),
  );
}

// -- flashing --------------------------------------------------------------

async function startFlash(
  sheet: SheetHandle,
  index: FirmwareIndex,
  entry: FirmwareEntry,
  filters: SerialPortFilter[] = KNOWN_SERIAL_FILTERS,
): Promise<void> {
  let port: SerialPort | null;
  try {
    port = await requestSerialPort(filters);
  } catch (err) {
    toast(errText(err), { error: true });
    renderNoDevice(sheet, index, entry, filters);
    return;
  }
  if (!port) {
    // Cancelled, or the chooser found nothing (Web Serial can't tell them apart).
    renderNoDevice(sheet, index, entry, filters);
    return;
  }

  // Switch to the progress view.
  sheet.body.innerHTML = "";
  const status = document.createElement("div");
  status.className = "flash-status";
  const bar = document.createElement("div");
  bar.className = "flash-bar";
  const fill = document.createElement("div");
  fill.className = "flash-bar-fill";
  bar.append(fill);
  const log = document.createElement("pre");
  log.className = "flash-log";
  sheet.body.append(status, bar, log);

  const appendLog = (line: string): void => {
    log.textContent += line.endsWith("\n") ? line : line + "\n";
    log.scrollTop = log.scrollHeight;
  };
  const hooks: FlashHooks = {
    log: appendLog,
    progress: ({ phase, written, total }) => {
      const pct = total > 0 ? Math.min(100, Math.round((written / total) * 100)) : 0;
      fill.style.width = `${pct}%`;
      status.textContent =
        total > 1 ? `${phase}… ${pct}% (${fmtKB(written)} / ${fmtKB(total)})` : `${phase}…`;
    },
  };

  // USB VID/PID is the first-pass hint; the flasher confirms the exact chip
  // from the bootloader self-report. We flash for the selected image's family.
  const usb = portUsbId(port);
  const match = usb ? identifyUsb(usb) : null;
  appendLog(usb ? `Port ${formatUsbId(usb)}${match ? ` — ${match.label}` : ""}` : "Port USB id: not reported");
  if (match && match.family !== entry.family) {
    appendLog(`Warning: this port looks like a ${match.family} device, not ${entry.family}.`);
  }

  try {
    status.textContent = "Downloading firmware…";
    const req = await loadFlashRequest(entry);
    appendLog(`Firmware: ${fmtKB(totalBytes(req))} across ${req.images.length} image(s).`);

    const flasher = await getFlasher(entry.family);
    const result = await flasher.flash(port, req, hooks);

    fill.style.width = "100%";
    fill.classList.add("flash-bar-fill--done");
    renderDone(sheet, index, entry, result.chipDescription, result.mac, log.textContent ?? "");
    toast("Firmware flashed");
  } catch (err) {
    appendLog(`\nError: ${errText(err)}`);
    status.textContent = "Flashing failed.";
    status.classList.add("flash-status--err");
    fill.classList.add("flash-bar-fill--err");
    sheet.body.append(
      Button({
        label: "Try again",
        block: true,
        onClick: () => renderIdle(sheet, index, entry),
      }),
    );
    toast(errText(err), { error: true });
  }
}

// -- over the air -----------------------------------------------------------

let usbBlocked: string | null = null;

/** Whether the connected device's app can hand over to its updater: "legacy" when it
 * still has the pre-OTA partition layout (it needs a one-time USB update first).
 * Remembered per connection (the welcome object), so reopening the sheet doesn't ask
 * again. An unanswered query counts as ready — the update itself reports a refusal. */
const readiness = new WeakMap<object, Promise<"ready" | "legacy">>();
function otaReadiness(client: LedMapperClient): Promise<"ready" | "legacy"> {
  const w = client.welcome;
  if (!w) return Promise.resolve("ready");
  let p = readiness.get(w);
  if (!p) {
    p = client
      .getOtaStatus()
      .then((st) => (st.error === "legacy_layout" ? ("legacy" as const) : ("ready" as const)))
      .catch(() => "ready" as const);
    readiness.set(w, p);
  }
  return p;
}

export function legacyLayoutText(name: string): string {
  return (
    `${name} needs a one-time USB update before it can update over Wi-Fi (its firmware predates ` +
    "the updater). Connect it to this phone or a computer with a USB cable and use " +
    "“Connect a board & flash (USB)” below — its Wi-Fi settings, name and maps are kept. " +
    "After that, updates work over Wi-Fi."
  );
}

/** The connected device, when it can take an update over Wi-Fi. */
function otaTarget(): LedMapperClient | null {
  const c = appState.client;
  const w = c?.welcome;
  if (!c || !w) return null;
  return (w.features ?? []).includes("ota") || inLoader(w) ? c : null;
}

const OTA_PHASE_TEXT: Record<OtaProgress["phase"], string> = {
  handoff: "Restarting into the updater",
  wait: "Waiting for the device",
  transfer: "Sending firmware",
  download: "The device is downloading the firmware",
  resume: "Reconnecting",
  verify: "Verifying",
  reboot: "Starting the new firmware",
  health: "Checking it runs",
  done: "Done",
  rolled_back: "Rolled back",
};

async function startOtaUpdate(
  sheet: SheetHandle,
  index: FirmwareIndex,
  entry: FirmwareEntry,
  client: LedMapperClient,
): Promise<void> {
  sheet.body.innerHTML = "";
  const status = document.createElement("div");
  status.className = "flash-status";
  const bar = document.createElement("div");
  bar.className = "flash-bar";
  const fill = document.createElement("div");
  fill.className = "flash-bar-fill";
  bar.append(fill);
  const log = document.createElement("pre");
  log.className = "flash-log";
  sheet.body.append(status, bar, log);
  const appendLog = (line: string): void => {
    log.textContent += line + "\n";
    log.scrollTop = log.scrollHeight;
  };
  let lastPhase = "";
  let lastKey = "";
  try {
    status.textContent = "Downloading firmware…";
    const { pkg, keyEpoch } = pullsImage(client.welcome) ? await maxPackage(client, entry) : await c6Package(entry);
    appendLog(
      pullsImage(client.welcome)
        ? `Signed manifest for ${entry.label}: the device fetches the image itself.`
        : `Package: ${fmtKB(pkg.length)} (${entry.label}).`,
    );
    const result = await updateFirmware(client, pkg, {
      ...(keyEpoch ? { keyEpoch } : {}),
      onProgress: (p) => {
        const pct = p.total > 0 ? Math.min(100, Math.round((p.sent / p.total) * 100)) : 0;
        fill.style.width = `${pct}%`;
        const text = OTA_PHASE_TEXT[p.phase];
        // While waiting on the device the message carries the elapsed seconds
        // ("Waiting for the updater (12 s)") — show it, so it never looks hung.
        status.textContent =
          p.phase === "transfer" || p.phase === "download"
            ? `${text}… ${pct}% (${fmtKB(p.sent)} / ${fmtKB(p.total)})`
            : p.message && p.phase !== "done" && p.phase !== "rolled_back" && p.phase !== "resume"
              ? p.message
              : `${text}…`;
        const line = p.phase === "wait" ? (p.message ?? text).replace(/ \(\d+ s\)$/, "…") : p.message;
        const key = `${p.phase}:${line ?? ""}`;
        if (p.phase !== lastPhase || (p.phase !== "wait" && p.phase !== "transfer" && key !== lastKey)) {
          lastPhase = p.phase;
          lastKey = key;
          appendLog(line ? (p.phase === "wait" ? line : `${text}: ${line}`) : `${text}…`);
        }
      },
    });
    fill.style.width = "100%";
    fill.classList.add("flash-bar-fill--done");
    status.textContent = "✓ Updated";
    status.classList.add("flash-status--ok");
    appendLog(`Running version ${result.version} (sent in ${(result.transferMs / 1000).toFixed(0)} s, ${result.resumes} resume(s)).`);
    sheet.body.append(Button({ label: "Done", block: true, onClick: () => sheet.close() }));
    toast("Firmware updated");
  } catch (err) {
    const msg = errText(err);
    appendLog(`\nError: ${msg}`);
    status.textContent = "Update failed.";
    status.classList.add("flash-status--err");
    fill.classList.add("flash-bar-fill--err");
    sheet.body.append(note(err instanceof OtaError && err.code === "legacy_layout" ? legacyLayoutText("This device") : msg));
    sheet.body.append(Button({ label: "Back", block: true, onClick: () => renderIdle(sheet, index, entry) }));
    toast(msg, { error: true });
  }
}

/** A C6's `.ota` (manifest ‖ image) from the selected bundle. */
async function c6Package(entry: FirmwareEntry): Promise<{ pkg: Uint8Array; keyEpoch?: Uint8Array }> {
  const req = await loadFlashRequest(entry);
  if (!req.otaPackage) {
    throw new OtaError(
      "no_package",
      "This firmware has no over-the-air package — pick a “Netstack + OTA loader” release.",
    );
  }
  return { pkg: req.otaPackage, ...(req.keyEpoch ? { keyEpoch: req.keyEpoch } : {}) };
}

/** A Splanc MAX (pull device, docs/design/max-ota.md): just the release's signed
 * manifest for this board (`max-<board>-<ver>.manifest`, 108 bytes); the Pi
 * downloads the system image itself. Its key-epoch record is the release's
 * `key-epoch.bin`, the C6's: a MAX trusts the same keyring. */
async function maxPackage(client: LedMapperClient, entry: FirmwareEntry): Promise<{ pkg: Uint8Array; keyEpoch?: Uint8Array }> {
  const st = await client.getOtaStatus();
  const board = st.board ?? "";
  if (!board || !entry.tarUrl || !entry.version) {
    throw new OtaError("no_package", "This device updates from a firmware release — pick a released version.");
  }
  const res = await fetch(proxiedAssetUrl(siblingAssetUrl(entry.tarUrl, maxManifestAsset(board, entry.version))));
  if (!res.ok) {
    throw new OtaError("no_package", `Firmware ${entry.version} has no Splanc MAX image for this board (${board}).`);
  }
  const pkg = new Uint8Array(await res.arrayBuffer());
  const er = await fetch(proxiedAssetUrl(siblingAssetUrl(entry.tarUrl, "key-epoch.bin"))).catch(() => null);
  return { pkg, ...(er?.ok ? { keyEpoch: new Uint8Array(await er.arrayBuffer()) } : {}) };
}

// -- done ------------------------------------------------------------------

function renderDone(
  sheet: SheetHandle,
  index: FirmwareIndex,
  entry: FirmwareEntry,
  chip: string,
  mac: string | undefined,
  logText: string,
): void {
  sheet.body.innerHTML = "";
  const ok = document.createElement("div");
  ok.className = "flash-status flash-status--ok";
  ok.textContent = "✓ Flashed successfully";
  const card = document.createElement("div");
  card.className = "k-card flash-summary";
  card.append(kv("Chip", chip));
  if (mac) card.append(kv("MAC", mac));
  const details = document.createElement("details");
  details.className = "flash-log-details";
  const sum = document.createElement("summary");
  sum.textContent = "Flash log";
  const pre = document.createElement("pre");
  pre.className = "flash-log";
  pre.textContent = logText;
  details.append(sum, pre);

  sheet.body.append(
    ok,
    card,
    intro(
      "The board reboots into the device firmware. If it was already on Wi-Fi it rejoins by itself; otherwise it advertises over Bluetooth — provision it onto Wi-Fi from “Add device”, then connect.",
    ),
    details,
    Button({ label: "Flash another", block: true, onClick: () => renderIdle(sheet, index, entry) }),
    Button({ label: "Done", variant: "quiet", block: true, onClick: () => sheet.close() }),
  );
}

// -- diagnostics -----------------------------------------------------------

/** A collapsible capability/diagnostics report. Populates the "devices seen"
 * line asynchronously (getPorts needs no gesture). */
function buildDiagnostics(opts: { open?: boolean; filters?: SerialPortFilter[]; error?: string } = {}): HTMLElement {
  const env = readFlashEnv();
  const summary = summarizeEnv(env);
  const details = document.createElement("details");
  details.className = "flash-log-details";
  if (opts.open) details.open = true;
  const sum = document.createElement("summary");
  sum.textContent = "Diagnostics";
  const pre = document.createElement("pre");
  pre.className = "flash-log";

  const lines = [...summary.lines];
  lines.push(`WebUSB polyfill installed: ${isPolyfillActive() ? "yes" : "no"}`);
  lines.push(`Vendor filter: ${describeFilters(opts.filters ?? KNOWN_SERIAL_FILTERS)}`);
  if (opts.error) lines.push(`Last error: ${opts.error}`);
  lines.push(`User agent: ${env.userAgent || "unknown"}`);
  lines.push("Previously granted ports: …");
  pre.textContent = lines.join("\n");
  details.append(sum, pre);

  // Fill in the granted-ports line once resolved.
  void authorizedPortIds().then((ids) => {
    const seen = ids.length ? ids.map((id) => formatUsbId(id)).join(", ") : "none";
    pre.textContent = pre.textContent!.replace("Previously granted ports: …", `Previously granted ports: ${seen}`);
  });

  return details;
}

// -- small DOM helpers -----------------------------------------------------

function intro(text: string): HTMLElement {
  const p = document.createElement("p");
  p.className = "flash-intro";
  p.textContent = text;
  return p;
}

function note(text: string): HTMLElement {
  const d = document.createElement("div");
  d.className = "k-card";
  d.style.borderColor = "var(--warn)";
  d.style.marginBottom = "var(--sp-3)";
  d.textContent = text;
  return d;
}

function loadingLine(text: string): HTMLElement {
  const d = document.createElement("div");
  d.className = "flash-status";
  d.textContent = text;
  return d;
}

function kv(cap: string, value: string): HTMLElement {
  const r = document.createElement("div");
  r.className = "flash-kv";
  const c = document.createElement("span");
  c.className = "flash-kv-cap";
  c.textContent = cap;
  const v = document.createElement("span");
  v.className = "flash-kv-val metric";
  v.textContent = value;
  r.append(c, v);
  return r;
}

/** Like kv, but the value links to the GitHub commit page (the exact source the
 * selected image was built from), matching the device card's build row. */
function kvCommit(cap: string, commit: string): HTMLElement {
  const r = document.createElement("div");
  r.className = "flash-kv";
  const c = document.createElement("span");
  c.className = "flash-kv-cap";
  c.textContent = cap;
  const a = document.createElement("a");
  a.className = "flash-kv-val metric about-link";
  a.href = commitUrl(commit);
  a.textContent = buildLabel(commit, false);
  a.title = commit;
  a.target = "_blank";
  a.rel = "noopener noreferrer";
  r.append(c, a);
  return r;
}

function field(cap: string, control: HTMLElement): HTMLElement {
  const label = document.createElement("label");
  label.className = "device-detail-field";
  const c = document.createElement("span");
  c.className = "device-detail-cap";
  c.textContent = cap;
  label.append(c, control);
  return label;
}

function fmtKB(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  return `${Math.round(bytes / 1024)} KB`;
}

function errText(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

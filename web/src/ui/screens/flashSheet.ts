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
} from "../../flash/firmwareRepo";
import { loadReleaseFirmwareIndex } from "../../flash/githubReleaseRepo";
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

let openHandle: SheetHandle | null = null;

/** Where firmware comes from: published GitHub releases (default — pick any
 * version × variant) or the same-commit bundle this build staged under /firmware/
 * (the "dev" fallback, e.g. a PR preview flashing its exact-commit firmware). */
type FwSource = "release" | "bundled";
let currentSource: FwSource = "release";

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

  // iOS gives third-party apps no USB-serial access at all (no Web Serial, no
  // WebUSB, and no native serial to an unlisted board — docs/design/ios-support.md
  // §3.1), so first-flash of a blank board can't happen on iPhone/iPad by any
  // path. Rather than open the flasher into a dead end, point the user to the
  // desktop web app, where Web Serial/WebUSB flashing works.
  if (isNativePlatform()) {
    const sheet = Sheet("Set up a new device", { onClose: () => (openHandle = null) });
    openHandle = sheet;
    sheet.body.append(
      note("Flashing a brand-new device over USB isn't supported on iPhone or iPad."),
      intro(
        "To provision a board for the first time, open splanc.pages.dev on a desktop or laptop " +
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

  const reason = webSerialUnavailableReason();
  if (reason) {
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
      opt.textContent = e.label;
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
  sheet.body.append(card);

  sheet.body.append(
    Button({
      label: "Connect a board & flash",
      icon: "chip",
      block: true,
      onClick: () => void startFlash(sheet, index, selected),
    }),
    buildDiagnostics(),
  );
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
      "The board reboots into the device firmware and starts advertising over Bluetooth. Provision it onto Wi-Fi from “Add device”, then connect.",
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

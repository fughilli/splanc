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
import type { FirmwareEntry, FirmwareIndex } from "../../flash/manifest";

let openHandle: SheetHandle | null = null;

export async function openFlashSheet(): Promise<void> {
  if (openHandle) return;
  const sheet = Sheet("Flash firmware", { onClose: () => (openHandle = null) });
  openHandle = sheet;

  const reason = webSerialUnavailableReason();
  if (reason) {
    // Unsupported browser (commonly Android/iOS): explain, and show the full
    // capability report so it's clear WHAT is missing, not just that it failed.
    sheet.body.append(note(reason), intro(FLASH_HELP), buildDiagnostics({ open: true }));
    return;
  }

  sheet.body.append(loadingLine("Looking for bundled firmware…"));
  const index = await loadFirmwareIndex();
  sheet.body.innerHTML = "";
  if (!index) {
    sheet.body.append(
      note(
        "This build doesn't bundle any firmware. Deploy or serve the app with the firmware bundle staged to enable one-tap flashing.",
      ),
      intro(FLASH_HELP),
      buildDiagnostics(),
    );
    return;
  }
  renderIdle(sheet, index, index.entries[0]!);
}

const FLASH_HELP =
  "Flashing runs entirely in your browser over USB — desktop Chrome/Edge (Web Serial) or Chrome on Android (WebUSB). Connect the board with a data-capable cable, then keep it plugged in until the write finishes.";

// -- idle: pick an image + flash -------------------------------------------

function renderIdle(sheet: SheetHandle, index: FirmwareIndex, selected: FirmwareEntry): void {
  sheet.body.innerHTML = "";
  sheet.body.append(intro(FLASH_HELP));

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
    kv("Built at", index.revision ? `revision ${index.revision}` : "unknown revision"),
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
      "The board reboots into the player and starts advertising over Bluetooth. Provision it onto Wi-Fi from “Add device”, then connect.",
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

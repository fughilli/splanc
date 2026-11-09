/**
 * Settings ▸ Debugging ▸ "Send diagnostics" (#450): one place to collect the
 * effects library, AI chat sessions and mapping/localization capture bundles —
 * all of a category or everything — and send it to the debug server, Share it
 * or save it as a file. "Prepare" takes one snapshot (store/diagnosticExport.ts)
 * and every action in the sheet uses that same snapshot, so what the server
 * receives and what Share hands over are the same items with the same
 * checksums. Nothing is uploaded until the user taps Send; nothing local is
 * ever deleted.
 *
 * The settings screen's row/group/segmented builders are passed in, like the
 * other Debugging groups.
 */

import { debugServerConnected, debugServerUrl, postJsonText } from "../../net/debugServer";
import { bundleIncludeFrames } from "../../store/captureBundleStore";
import {
  buildArchive,
  CATEGORY_LABEL,
  DIAG_CATEGORIES,
  describeReport,
  failedKeys,
  storeSources,
  summarizeCategories,
  takeSnapshot,
  uploadSnapshot,
  type DiagCategory,
  type DiagnosticArchive,
  type DiagnosticSnapshot,
  type DiagSources,
  type Poster,
  type UploadReport,
} from "../../store/diagnosticExport";
import { Button, Sheet, toast } from "../kit";
import { saveFile } from "../saveFile";

type GroupFn = (legend: string) => HTMLElement;
type RowFn = (name: string, hint: string, control: HTMLElement) => HTMLElement;
type SegmentedFn = <T extends string>(options: [T, string][], value: T, onPick: (v: T) => void) => HTMLElement;

const ON_OFF: ["off" | "on", string][] = [
  ["off", "Off"],
  ["on", "On"],
];

/** Selection survives the settings screen's re-renders (connection changes). */
const selection: Record<DiagCategory, boolean> = { effects: true, chatlogs: true, captures: true };
let includeFrames: boolean | null = null;

/** Test seams. */
export interface DiagnosticsDeps {
  sources?: DiagSources;
  post?: Poster | null;
  connected?: () => boolean;
  serverUrl?: () => string;
  save?: (data: Blob, name: string, mime: string) => Promise<void>;
  share?: ((data: ShareData) => Promise<void>) | null;
  canShare?: ((data: ShareData) => boolean) | null;
}

export function diagnosticsGroup(group: GroupFn, row: RowFn, segmented: SegmentedFn, deps: DiagnosticsDeps = {}): HTMLElement {
  const sources = deps.sources ?? storeSources;
  const connected = deps.connected ?? debugServerConnected;
  const serverUrl = deps.serverUrl ?? debugServerUrl;
  if (includeFrames === null) includeFrames = bundleIncludeFrames();

  const g = group("Send diagnostics");
  const intro = document.createElement("div");
  intro.className = "settings-row-hint";
  intro.style.padding = "0 0 8px";
  intro.textContent =
    "Collect debug data into one snapshot, then send it to the debug server, share it, or save it as a file. " +
    "Every option sends the same snapshot. Nothing on this phone is deleted.";
  g.append(intro);

  const countEls = new Map<DiagCategory, HTMLElement>();
  for (const c of DIAG_CATEGORIES) {
    const r = row(CATEGORY_LABEL[c], "…", segmented(ON_OFF, selection[c] ? "on" : "off", (v) => (selection[c] = v === "on")));
    r.dataset.diagCategory = c;
    const hint = r.querySelector(".settings-row-hint") as HTMLElement | null;
    if (hint) countEls.set(c, hint);
    g.append(r);
  }
  g.append(
    row(
      "Include camera frames",
      "Capture bundles' optional camera frames (large). Left out unless on.",
      segmented(ON_OFF, includeFrames ? "on" : "off", (v) => (includeFrames = v === "on")),
    ),
  );
  const prepare = Button({ label: "Prepare", icon: "upload", onClick: () => void prepareAndShow() });
  prepare.classList.add("diag-prepare");
  g.append(row("Send, share or save", "Takes a snapshot of the selected categories.", prepare));

  void summarizeCategories(sources).then((s) => {
    for (const c of DIAG_CATEGORIES) {
      const el = countEls.get(c);
      if (!el) continue;
      const x = s[c];
      el.textContent =
        x.count === null ? `Unavailable (${x.error ?? "storage error"})` : `${x.count} item${x.count === 1 ? "" : "s"}${x.bytes ? ` · ~${sizeText(x.bytes)}` : ""}`;
    }
  });

  let busy = false;
  async function prepareAndShow(): Promise<void> {
    if (busy) return;
    const cats = DIAG_CATEGORIES.filter((c) => selection[c]);
    if (cats.length === 0) {
      toast("Pick at least one category", { error: true });
      return;
    }
    busy = true;
    prepare.disabled = true;
    try {
      const snap = await takeSnapshot({ categories: cats, includeFrames: includeFrames === true }, sources);
      const archive = await buildArchive(snap);
      openSnapshotSheet(snap, archive, { ...deps, connected, serverUrl });
    } catch (e) {
      toast(`Couldn't prepare the snapshot: ${e instanceof Error ? e.message : String(e)}`, { error: true });
    } finally {
      busy = false;
      prepare.disabled = false;
    }
  }
  return g;
}

/** The snapshot is ready: Send / Share / Save from fresh taps (iOS only shares
 * with fresh user activation, so the file is built before the sheet opens). */
export function openSnapshotSheet(
  snap: DiagnosticSnapshot,
  archive: DiagnosticArchive,
  deps: DiagnosticsDeps & { connected: () => boolean; serverUrl: () => string },
): { close(): void; el: HTMLElement } {
  const m = snap.manifest;
  let ctl: AbortController | null = null;
  const sheet = Sheet("Diagnostics snapshot", { onClose: () => ctl?.abort() });
  const root = document.createElement("div");
  root.className = "diag-sheet";

  const summary = document.createElement("div");
  summary.className = "settings-row-hint diag-summary";
  const lines = DIAG_CATEGORIES.filter((c) => m.categories[c]).map((c) => {
    const x = m.categories[c]!;
    return `${CATEGORY_LABEL[c]}: ${x.count} (${sizeText(x.bytes)})`;
  });
  for (const u of m.unavailable) lines.push(`Not included: ${CATEGORY_LABEL[u.category]}${u.id ? ` ${u.id}` : ""} — ${u.reason}`);
  lines.push(`File: ${archive.name} (${sizeText(archive.blob.size)})`);
  summary.textContent = lines.join("\n");
  summary.style.whiteSpace = "pre-line";

  const server = deps.serverUrl();
  const dest = document.createElement("div");
  dest.className = "settings-row-hint diag-dest";
  dest.textContent = deps.connected() && server ? `Debug server: ${hostOf(server)}` : "Debug server: not connected (connect above to send)";

  const status = document.createElement("div");
  status.className = "settings-row-hint diag-status";
  status.style.whiteSpace = "pre-line";
  status.setAttribute("aria-live", "polite");

  const post: Poster | null =
    deps.post !== undefined ? deps.post : server ? (path, body) => postJsonText(server, path, body) : null;
  let last: UploadReport | null = null;

  const send = Button({ label: "Send to server", icon: "upload", variant: "primary", block: true, onClick: () => void doSend(false) });
  send.classList.add("diag-send");
  send.disabled = !deps.connected() || post === null;
  const retry = Button({ label: "Retry failed", icon: "reset", block: true, onClick: () => void doSend(true) });
  retry.classList.add("diag-retry");
  retry.style.display = "none";
  const cancel = Button({ label: "Cancel send", variant: "quiet", block: true, onClick: () => ctl?.abort() });
  cancel.classList.add("diag-cancel");
  cancel.style.display = "none";
  const share = Button({ label: "Share", icon: "upload", block: true, onClick: () => void doShare() });
  share.classList.add("diag-share");
  const save = Button({ label: "Save file", icon: "save", variant: "quiet", block: true, onClick: () => void doSave() });
  save.classList.add("diag-save");

  async function doSend(onlyFailed: boolean): Promise<void> {
    if (ctl !== null || post === null) return;
    ctl = new AbortController();
    const signal = ctl.signal;
    send.disabled = true;
    retry.style.display = "none";
    cancel.style.display = "";
    status.textContent = "Sending…";
    const r = await uploadSnapshot(snap, post, {
      signal,
      ...(onlyFailed && last ? { only: failedKeys(last) } : {}),
      onProgress: (done, total, label) => {
        if (!signal.aborted) status.textContent = `Sending ${done + 1}/${total}: ${label}`;
      },
    });
    ctl = null;
    cancel.style.display = "none";
    send.disabled = false;
    last = onlyFailed && last ? mergeReports(last, r, m.unavailable.length) : r;
    const out = describeReport(last, m);
    status.textContent = (last.complete ? "Sent — everything acknowledged.\n" : "Not everything was sent.\n") + out.join("\n");
    status.classList.toggle("diag-status--err", !last.complete);
    retry.style.display = last.complete ? "none" : "";
  }

  async function doShare(): Promise<void> {
    const file = new File([archive.blob], archive.name, { type: archive.mime });
    const data: ShareData = { files: [file], title: archive.name };
    const shareFn = deps.share !== undefined ? deps.share : typeof navigator.share === "function" ? (d: ShareData) => navigator.share(d) : null;
    const canShareFn = deps.canShare !== undefined ? deps.canShare : (d: ShareData) => navigator.canShare?.(d) ?? false;
    if (shareFn === null || canShareFn === null || !canShareFn(data)) {
      status.textContent = "Sharing files isn't available here — saving the file instead.";
      await doSave();
      return;
    }
    try {
      await shareFn(data);
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") return;
      status.textContent = "Share didn't open — tap Share again, or Save file.";
    }
  }

  async function doSave(): Promise<void> {
    const saver = deps.save ?? ((b: Blob, n: string, mime: string) => blobBytes(b).then((u) => saveFile(u, n, mime)));
    await saver(archive.blob, archive.name, archive.mime);
  }

  root.append(summary, dest, send, cancel, retry, share, save, status);
  sheet.body.append(root);
  return { close: () => sheet.close(), el: root };
}

/** A retry's report folded over the previous one: items acked by either. */
export function mergeReports(prev: UploadReport, next: UploadReport, unavailable: number): UploadReport {
  const out: UploadReport = { ...next, categories: {} };
  for (const c of DIAG_CATEGORIES) {
    const a = prev.categories[c];
    const b = next.categories[c];
    if (!a && !b) continue;
    if (!b || b.expected === 0) {
      out.categories[c] = a!;
      continue;
    }
    if (!a) {
      out.categories[c] = b;
      continue;
    }
    const acked = new Set([...a.acked, ...b.acked]);
    const failed = new Map<string, string>();
    for (const f of [...a.failed, ...b.failed]) if (!acked.has(f.id)) failed.set(f.id, f.error);
    for (const f of b.failed) failed.set(f.id, f.error); // latest error wins
    out.categories[c] = {
      expected: acked.size + failed.size,
      acked: [...acked],
      failed: [...failed].map(([id, error]) => ({ id, error })),
    };
  }
  out.manifest = next.manifest.ok || prev.manifest.ok ? { ok: true } : next.manifest;
  out.complete =
    out.manifest.ok &&
    !next.cancelled &&
    unavailable === 0 &&
    DIAG_CATEGORIES.every((c) => (out.categories[c]?.failed.length ?? 0) === 0);
  return out;
}

async function blobBytes(b: Blob): Promise<Uint8Array> {
  return new Uint8Array(await b.arrayBuffer());
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function sizeText(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  return bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1048576).toFixed(1)} MB`;
}

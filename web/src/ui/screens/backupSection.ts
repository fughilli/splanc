/**
 * Settings ▸ Behavior ▸ "Backup & restore": export the whole app to one file and
 * import it on another phone or browser (store/backup.ts).
 */

import { buildBackup, importBackup, readBackup, type BuiltBackup } from "../../store/backup";
import { backupCounts, type BackupFile } from "../../store/backupFormat";
import { Button, Sheet, confirmDialog, toast } from "../kit";
import { saveFile } from "../saveFile";

type GroupFn = (legend: string) => HTMLElement;
type RowFn = (name: string, hint: string, control: HTMLElement) => HTMLElement;
type SegmentedFn = <T extends string>(options: [T, string][], value: T, onPick: (v: T) => void) => HTMLElement;

const ON_OFF: ["off" | "on", string][] = [
  ["off", "Off"],
  ["on", "On"],
];

export function backupGroup(group: GroupFn, row: RowFn, segmented: SegmentedFn): HTMLElement {
  const g = group("Backup & restore");
  const opts = { secrets: false, captures: false };
  let busy = false;

  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".gz,.json,application/gzip,application/json";
  input.style.display = "none";
  input.addEventListener("change", () => {
    const f = input.files?.[0];
    input.value = "";
    if (f) void importFile(f);
  });

  async function exportAll(): Promise<void> {
    if (busy) return;
    busy = true;
    toast("Preparing the backup…");
    try {
      showSaveSheet(await buildBackup(opts));
    } catch (e) {
      toast(`Backup failed: ${(e as Error).message}`, { error: true });
    } finally {
      busy = false;
    }
  }

  async function importFile(f: File): Promise<void> {
    if (busy) return;
    busy = true;
    try {
      const file = await readBackup(new Uint8Array(await f.arrayBuffer()));
      const ok = await confirmDialog({
        title: "Import this backup?",
        message: `${describe(file)} Where this app has the same item, the newer copy wins. Settings in the backup replace this app's. The app restarts afterwards.`,
        confirmLabel: "Import",
      });
      if (!ok) return;
      const r = await importBackup(file);
      toast(`Imported: ${r.added} new, ${r.updated} updated, ${r.kept} kept (newer here). Restarting…`);
      setTimeout(() => location.reload(), 1500);
    } catch (e) {
      toast(`Import failed: ${(e as Error).message}`, { error: true });
    } finally {
      busy = false;
    }
  }

  g.append(
    row(
      "Export everything",
      "Effects, maps, device profiles, settings and known fixtures, in one file. Use it to move your library to another phone or browser.",
      Button({ label: "Export", icon: "download", variant: "primary", onClick: () => void exportAll() }),
    ),
    row(
      "Include API keys",
      "Also put AI keys and bridge and kiosk passwords in the file. Keep that file private.",
      segmented(ON_OFF, "off", (v) => (opts.secrets = v === "on")),
    ),
    row(
      "Include capture recordings",
      "Mapping recordings kept for bug reports. They can make the file large.",
      segmented(ON_OFF, "off", (v) => (opts.captures = v === "on")),
    ),
    row(
      "Import a backup",
      "Adds a backup's effects, maps and settings to this app.",
      Button({ label: "Import", icon: "upload", variant: "quiet", onClick: () => input.click() }),
    ),
    input,
  );
  return g;
}

/** The file is ready: save it from a fresh tap (iOS shares only from one). */
function showSaveSheet(b: BuiltBackup): void {
  const sheet = Sheet("Backup ready");
  const p = document.createElement("p");
  p.className = "settings-row-hint";
  p.textContent = `${countsText(b.counts)} (${sizeText(b.bytes.length)}).`;
  const save = Button({
    label: "Save file",
    icon: "save",
    variant: "primary",
    block: true,
    onClick: () => {
      void saveFile(b.bytes, b.name, b.mime);
      sheet.close();
    },
  });
  sheet.body.append(p, save);
}

function describe(f: BackupFile): string {
  const when = f.createdAt ? new Date(f.createdAt).toLocaleString() : "an unknown date";
  return `This backup from ${when} has ${countsText(backupCounts(f))}.`;
}

function countsText(c: Record<string, number>): string {
  const n = (k: string): number => c[k] ?? 0;
  const parts = [plural(n("effects"), "effect"), plural(n("maps_index"), "map")];
  if (n("cost_tables")) parts.push(plural(n("cost_tables"), "device profile"));
  if (n("sessions")) parts.push(plural(n("sessions"), "AI chat"));
  if (n("meta")) parts.push(plural(n("meta"), "capture recording"));
  return parts.join(", ");
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function sizeText(bytes: number): string {
  return bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1048576).toFixed(1)} MB`;
}

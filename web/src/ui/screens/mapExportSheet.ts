/**
 * "Export map" sheet (map workspace): download the fixture's LED positions for
 * other software — a TouchDesigner-ready CSV or a Chromatik `.lxf` fixture
 * (serializers + format notes in geom/mapExport.ts).
 *
 * The channel layout isn't stored with a map; when a connected device reports
 * per-channel LED counts that add up to this map's LED count, the export uses
 * them for the channel columns / per-channel components. The lookup runs when
 * the sheet opens (not on the button tap) so the download/share stays inside
 * the tap's user activation — iOS Safari refuses navigator.share() otherwise.
 */

import type { OutputMap, Topology } from "@ledmapper/protocol";
import { Button, Chip, Sheet, toast } from "../kit";
import { appState } from "../app/state";
import {
  channelLayoutFor,
  exportFileName,
  exportLedCount,
  exportRows,
  mapToCsv,
  mapToLxf,
  type UpAxis,
} from "../../geom/mapExport";
import { saveFile } from "../saveFile";

let installed = false;
function installStyles(): void {
  if (installed || typeof document === "undefined") return;
  installed = true;
  const style = document.createElement("style");
  style.textContent = `
.mapexport-row { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-2); margin: var(--sp-2) 0 var(--sp-3); }
.mapexport-label { color: var(--text-dim); font-size: var(--f-caption); }
.mapexport-actions { display: flex; flex-direction: column; gap: var(--sp-2); margin-top: var(--sp-3); }
`;
  document.head.appendChild(style);
}

/** Per-channel LED counts from the connected device, or null (none connected,
 * old firmware, no counts set, or they don't cover this map). */
async function deviceChannelLayout(ledCount: number): Promise<number[] | null> {
  const c = appState.client;
  if (!c?.isConnected) return null;
  try {
    const st = await Promise.race([
      c.getHardwareConfig(),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error("timeout")), 2500)),
    ]);
    return channelLayoutFor(
      ledCount,
      st.channels.map((ch) => ch.ledCount),
    );
  } catch {
    return null;
  }
}

export function openMapExportSheet(input: { name: string; map: OutputMap; topology: Topology | null }): void {
  installStyles();
  const { name, map, topology } = input;
  const sheet = Sheet("Export map");
  const n = exportLedCount(map);
  let channels: number[] | null = null;
  let up: UpAxis = "y";

  const summary = document.createElement("p");
  summary.className = "sheet-hint metric";
  const renderSummary = (): void => {
    const unmapped = exportRows(map, { channels }).filter((r) => !r.mapped).length;
    const chans = channels ? `${channels.length} channel${channels.length === 1 ? "" : "s"} (${channels.join(" + ")})` : "1 channel";
    summary.textContent =
      `${n} LEDs in output order · ${unmapped} unmapped (interpolated, mapped=0) · ${chans} · metres`;
  };
  renderSummary();

  // Up axis (CSV only). Splanc, TouchDesigner and Chromatik are all +Y up.
  const upRow = document.createElement("div");
  upRow.className = "mapexport-row";
  const upLabel = document.createElement("span");
  upLabel.className = "mapexport-label";
  upLabel.textContent = "CSV up axis";
  const yChip = Chip({ label: "Y up (TouchDesigner)", on: true, onClick: () => setUp("y") });
  const zChip = Chip({ label: "Z up (Blender)", onClick: () => setUp("z") });
  const setUp = (v: UpAxis): void => {
    up = v;
    yChip.classList.toggle("k-chip--on", v === "y");
    zChip.classList.toggle("k-chip--on", v === "z");
  };
  upRow.append(upLabel, yChip, zChip);

  const save = (ext: string, mime: string, build: () => string): void => {
    try {
      void saveFile(build(), exportFileName(name, ext), mime);
    } catch (e) {
      toast(`Export failed: ${e instanceof Error ? e.message : e}`, { error: true });
    }
  };
  const actions = document.createElement("div");
  actions.className = "mapexport-actions";
  actions.append(
    Button({
      label: "CSV — TouchDesigner, spreadsheets",
      icon: "download",
      block: true,
      onClick: () => save("csv", "text/csv", () => mapToCsv(map, { topology, channels, up })),
    }),
    Button({
      label: "Chromatik fixture (.lxf)",
      icon: "download",
      variant: "quiet",
      block: true,
      onClick: () => save("lxf", "application/json", () => mapToLxf(map, { name, topology, channels })),
    }),
  );

  sheet.body.append(summary, upRow, actions);

  void deviceChannelLayout(n).then((layout) => {
    if (!layout) return;
    channels = layout;
    renderSummary();
  });
}

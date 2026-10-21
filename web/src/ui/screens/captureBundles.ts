/**
 * Settings ▸ Debugging ▸ "Mapping capture bundles": the reproduction bundles
 * debug mode logs for failed / degenerate mapping runs (solver/captureBundle),
 * with Export (a single .splanc-capture.json file) and Share (the Web Share
 * sheet — AirDrop, Mail, Files… on phones) per bundle.
 *
 * The settings screen's own row/group/segmented builders are passed in, so
 * this group looks like every other settings card without a circular import.
 */

import { Button, toast } from "../kit";
import {
  bundleIncludeFrames,
  bundleKeepSuccessful,
  captureBundleStore,
  setBundleIncludeFrames,
  setBundleKeepSuccessful,
  type CaptureBundleMeta,
} from "../../store/captureBundleStore";
import { bundleFileName } from "../../solver/captureBundle";
import { saveFile } from "../saveFile";

type GroupFn = (legend: string) => HTMLElement;
type RowFn = (name: string, hint: string, control: HTMLElement) => HTMLElement;
type SegmentedFn = <T extends string>(options: [T, string][], value: T, onPick: (v: T) => void) => HTMLElement;

const MIME = "application/json";

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** A loaded bundle's file, cached so a second Share tap is synchronous (iOS
 * only lets navigator.share() run with fresh user activation, which the
 * IndexedDB read before the first attempt may have spent). */
const fileCache = new Map<string, { name: string; text: string }>();

async function loadFile(meta: CaptureBundleMeta): Promise<{ name: string; text: string } | null> {
  const hit = fileCache.get(meta.id);
  if (hit) return hit;
  const b = await captureBundleStore.get(meta.id);
  if (!b) return null;
  const f = { name: bundleFileName(b), text: JSON.stringify(b) };
  fileCache.clear(); // keep at most one (bundles are MBs)
  fileCache.set(meta.id, f);
  return f;
}

async function exportBundle(meta: CaptureBundleMeta): Promise<void> {
  const f = await loadFile(meta);
  if (!f) {
    toast("That bundle is gone", { error: true });
    return;
  }
  await saveFile(f.text, f.name, MIME);
}

async function shareBundle(meta: CaptureBundleMeta): Promise<void> {
  const f = await loadFile(meta);
  if (!f) {
    toast("That bundle is gone", { error: true });
    return;
  }
  const file = new File([f.text], f.name, { type: MIME });
  if (typeof navigator.share !== "function" || !(navigator.canShare?.({ files: [file] }) ?? false)) {
    toast("Sharing files isn't supported here — use Export", { error: true });
    return;
  }
  try {
    await navigator.share({ files: [file], title: f.name, text: meta.summary });
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") return;
    // NotAllowedError: the read above used up the tap's user activation.
    toast("Ready — tap Share again");
  }
}

export function captureBundlesGroup(group: GroupFn, row: RowFn, segmented: SegmentedFn): HTMLElement {
  const g = group("Mapping capture bundles");
  const intro = document.createElement("div");
  intro.className = "settings-row-hint";
  intro.style.padding = "0 0 8px";
  intro.textContent =
    "While debug mode is on, every mapping run that fails, comes out degenerate, or disagrees " +
    "with its live preview saves everything needed to replay its solves offline. Export or " +
    "share one to attach it to a bug report.";
  g.append(intro);
  g.append(
    row(
      "Keep successful runs too",
      "Also save bundles for runs that ended fine, to compare against failed ones.",
      segmented<"on" | "off">(
        [
          ["off", "Off"],
          ["on", "On"],
        ],
        bundleKeepSuccessful() ? "on" : "off",
        (v) => setBundleKeepSuccessful(v === "on"),
      ),
    ),
    row(
      "Include camera frames",
      "Add a downsampled camera frame every 2 s (about 1–2 MB per minute). The solver " +
        "doesn't need them; they help judge detection. Not available with the native iOS camera.",
      segmented<"on" | "off">(
        [
          ["off", "Off"],
          ["on", "On"],
        ],
        bundleIncludeFrames() ? "on" : "off",
        (v) => setBundleIncludeFrames(v === "on"),
      ),
    ),
  );

  const list = document.createElement("div");
  list.className = "capture-bundle-list";
  g.append(list);

  const render = (metas: CaptureBundleMeta[]): void => {
    list.replaceChildren();
    if (metas.length === 0) {
      const empty = document.createElement("div");
      empty.className = "settings-row-hint";
      empty.style.padding = "8px 0";
      empty.textContent = "No bundles yet. Map a fixture with debug mode on.";
      list.append(empty);
      return;
    }
    for (const m of metas) {
      const actions = document.createElement("div");
      actions.style.cssText = "display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end";
      actions.append(
        Button({ label: "Export", icon: "download", variant: "quiet", onClick: () => void exportBundle(m) }),
        Button({ label: "Share", icon: "upload", variant: "quiet", onClick: () => void shareBundle(m) }),
        Button({
          label: "Delete",
          icon: "trash",
          variant: "quiet",
          onClick: () => {
            void captureBundleStore.delete(m.id).then(refresh);
          },
        }),
      );
      const when = new Date(m.createdAt).toLocaleString();
      const r = row(
        `${when} · ${m.outcome}`,
        `${m.summary} · ${fmtBytes(m.bytes)}${m.frames > 0 ? ` · ${m.frames} frames` : ""}`,
        actions,
      );
      r.dataset.bundleId = m.id;
      list.append(r);
    }
    const clear = Button({
      label: "Delete all",
      icon: "trash",
      variant: "danger",
      onClick: () => {
        void captureBundleStore.clear().then(() => {
          fileCache.clear();
          toast("Capture bundles deleted");
          refresh();
        });
      },
    });
    list.append(row("Delete all bundles", `${metas.length} saved on this device.`, clear));
  };

  const refresh = (): void => {
    captureBundleStore
      .list()
      .then(render)
      .catch(() => {
        list.textContent = "Couldn't read the bundle store (IndexedDB unavailable?).";
      });
  };
  refresh();
  return g;
}

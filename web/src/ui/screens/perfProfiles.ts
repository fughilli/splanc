/**
 * Performance-profile manager (FUG-11 review: "a system for managing the
 * performance profiles for devices — view the learned cost tables,
 * export/import, delete, etc").
 *
 * Lists every stored {@link StoredCostTable} (the persisted execution profiles),
 * grouped default / host-smoke / per-device calibrations, with each one's
 * provenance, fit residual, and — for validated device profiles — the held-out
 * measuredError. Supports export (download the profile JSON), import (load a
 * profile file), and delete. Device (HITL) calibrations are the authoritative
 * models; host/default are seeds.
 */

import { Button, Card, EmptyState, toast } from "../kit";
import type { Router, Screen } from "../app/router";
import {
  costTableStore,
  CURRENT_TABLE_VERSION,
  exportTable,
  importTable,
  type StoredCostTable,
} from "../../store/costTableStore";
import { buildDeviceProfile, parseDeviceBundle } from "../../effects/deviceProfile";
import { profileToStored } from "../../effects/executionProfile";
import { fleetStore } from "../../store/fleetStore";
import { installPerfStyles } from "./perfPanel.css";

/** Default LED count for a newly-added fleet member (editable per row). */
const DEFAULT_FLEET_LEDS = 256;

export function PerfProfilesScreen(_router: Router): Screen {
  installPerfStyles();
  const el = document.createElement("div");
  el.className = "screen screen--perf";

  const intro = document.createElement("div");
  intro.className = "perf-gauge-sub";
  intro.textContent =
    "Learned execution-cost profiles. Device calibrations (from the HITL rig or a connected board) are the authoritative models; host and default profiles are seeds. Tick “Use in AI estimates” to add a device to the fleet the AI code generator estimates programs against — mix devices to design for a heterogeneous set at once.";

  const list = document.createElement("div");
  list.className = "perf-profiles";

  const actions = document.createElement("div");
  actions.className = "perf-actions";

  // hidden file input for import.
  const fileInput = document.createElement("input");
  fileInput.type = "file";
  fileInput.accept = "application/json,.json";
  fileInput.style.display = "none";
  fileInput.addEventListener("change", () => {
    const f = fileInput.files?.[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const rec = importTable(String(reader.result));
        await costTableStore.save(rec);
        toast(`Imported profile for ${rec.deviceLabel || rec.soc}`);
        await refresh();
      } catch (e) {
        toast(`Import failed: ${(e as Error).message}`, { error: true });
      }
      fileInput.value = "";
    };
    reader.readAsText(f);
  });

  // hidden file input for a raw HITL device-measurement bundle → fit + validate.
  const bundleInput = document.createElement("input");
  bundleInput.type = "file";
  bundleInput.accept = "application/json,.json";
  bundleInput.style.display = "none";
  bundleInput.addEventListener("change", () => {
    const f = bundleInput.files?.[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const bundle = parseDeviceBundle(String(reader.result));
        const { profile } = buildDeviceProfile(bundle);
        await costTableStore.save(profileToStored(profile, CURRENT_TABLE_VERSION));
        const err =
          typeof profile.measuredError === "number"
            ? ` (validated ±${Math.round(profile.measuredError * 100)}%)`
            : "";
        toast(`Fitted device profile for ${profile.deviceLabel || profile.soc}${err}`);
        await refresh();
      } catch (e) {
        toast(`Bundle import failed: ${(e as Error).message}`, { error: true });
      }
      bundleInput.value = "";
    };
    reader.readAsText(f);
  });

  actions.append(
    Button({
      label: "Import profile",
      icon: "upload",
      variant: "quiet",
      onClick: () => fileInput.click(),
    }),
    Button({
      label: "Import device measurements",
      icon: "device",
      variant: "quiet",
      onClick: () => bundleInput.click(),
    }),
  );

  function download(rec: StoredCostTable): void {
    const blob = new Blob([exportTable(rec)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${rec.id.replace(/[^\w.@#-]+/g, "_")}.profile.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function originBadge(origin: StoredCostTable["origin"]): HTMLElement {
    const s = document.createElement("span");
    s.className = "perf-badge";
    s.textContent = origin === "calibrated" ? "device" : origin;
    if (origin === "calibrated") s.dataset["conf"] = "green";
    else if (origin === "host") s.dataset["conf"] = "yellow";
    return s;
  }

  function row(rec: StoredCostTable): HTMLElement {
    const head = document.createElement("div");
    head.className = "perf-profile-head";
    const title = document.createElement("span");
    title.className = "perf-effect";
    title.textContent = rec.deviceLabel || rec.soc;
    head.append(title, originBadge(rec.origin));

    const meta = document.createElement("div");
    meta.className = "perf-detail";
    meta.append(
      readout("SoC", `${rec.soc} @ ${(rec.cpuHz / 1e6).toFixed(0)} MHz`),
      readout("fit residual", `±${Math.round(rec.residualError * 100)}%`),
      readout(
        "validated",
        typeof rec.measuredError === "number"
          ? `±${Math.round(rec.measuredError * 100)}% (held-out)`
          : "—",
      ),
      readout("device", rec.deviceKey ? rec.deviceKey : "SoC-wide"),
      readout("firmware", rec.firmwareBuild || "—"),
      readout("when", rec.timestamp ? new Date(rec.timestamp).toLocaleString() : "—"),
    );

    const btns = document.createElement("div");
    btns.className = "perf-actions";
    btns.append(
      Button({ label: "Export", icon: "download", variant: "quiet", onClick: () => download(rec) }),
      Button({
        label: "Delete",
        icon: "trash",
        variant: "danger",
        disabled: rec.origin === "default",
        onClick: async () => {
          fleetStore.remove(rec.id);
          await costTableStore.delete(rec.id);
          toast(`Deleted ${rec.deviceLabel || rec.soc}`);
          await refresh();
        },
      }),
    );

    return Card(head, meta, fleetControl(rec), btns);
  }

  /** Per-profile "AI estimation fleet" control: a toggle to include the device
   * in the fleet the AI code generator estimates against, plus its LED count
   * (heterogeneous fleets run different-sized maps). */
  function fleetControl(rec: StoredCostTable): HTMLElement {
    const wrap = document.createElement("label");
    wrap.className = "perf-fleet";

    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = fleetStore.has(rec.id);

    const text = document.createElement("span");
    text.textContent = "Use in AI estimates";

    const leds = document.createElement("input");
    leds.type = "number";
    leds.min = "1";
    leds.className = "perf-fleet-leds";
    leds.title = "LED count to estimate this device at";
    const entry = fleetStore.get().find((e) => e.tableId === rec.id);
    leds.value = String(entry?.ledCount ?? DEFAULT_FLEET_LEDS);
    leds.disabled = !cb.checked;
    const suffix = document.createElement("span");
    suffix.className = "perf-fleet-suffix";
    suffix.textContent = "LEDs";
    suffix.style.opacity = cb.checked ? "1" : "0.4";

    cb.addEventListener("change", () => {
      fleetStore.toggle(rec.id, Math.max(1, Number(leds.value) || DEFAULT_FLEET_LEDS));
      leds.disabled = !cb.checked;
      suffix.style.opacity = cb.checked ? "1" : "0.4";
    });
    leds.addEventListener("change", () => {
      const n = Math.max(1, Math.round(Number(leds.value) || DEFAULT_FLEET_LEDS));
      leds.value = String(n);
      if (cb.checked) fleetStore.setLedCount(rec.id, n);
    });

    wrap.append(cb, text, leds, suffix);
    return wrap;
  }

  function readout(label: string, value: string): HTMLElement {
    const d = document.createElement("div");
    d.className = "perf-readout";
    const l = document.createElement("span");
    l.className = "perf-readout-label";
    l.textContent = label;
    const v = document.createElement("span");
    v.className = "perf-readout-val";
    v.textContent = value;
    d.append(l, v);
    return d;
  }

  async function refresh(): Promise<void> {
    const recs = await costTableStore.list().catch(() => [] as StoredCostTable[]);
    // authoritative device calibrations first, then host, then default.
    const rank = (o: StoredCostTable["origin"]): number =>
      o === "calibrated" ? 0 : o === "host" ? 1 : 2;
    recs.sort((a, b) => rank(a.origin) - rank(b.origin) || a.soc.localeCompare(b.soc));
    list.innerHTML = "";
    if (recs.length === 0) {
      list.append(
        EmptyState({
          icon: "sparkles",
          title: "No profiles yet — calibrate a device, run the HITL benchmark, or import one",
        }),
      );
      return;
    }
    for (const rec of recs) list.append(row(rec));
  }

  el.append(Card(intro), actions, list, fileInput, bundleInput);

  return {
    el,
    onMount: () => {
      void refresh();
    },
  };
}

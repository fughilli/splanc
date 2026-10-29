/**
 * Fallback "Generate a curtain + rope map" sheet (Hardware Setup ▸ LED layout).
 * For when a camera capture isn't possible: builds the map from the curtain's
 * wiring (halloween/layout.ts), saves it to the Maps library, and pushes it to
 * the connected device with the same submit_map the map screen's Push uses (so
 * it works over BLE too). Without a map the device renders nothing.
 */

import { Button, Field, Sheet, toast } from "../ui/kit";
import { appState } from "../ui/app/state";
import { mapStore } from "../store/mapStore";
import {
  CORNERS,
  DEFAULT_SPEC,
  channelCounts,
  generateCurtainRopeMap,
  layoutName,
  suggestGrid,
  type CurtainRopeSpec,
} from "./layout";

function select<T extends string>(
  label: string,
  options: { value: T; label: string }[],
  value: T,
  onChange: (v: T) => void,
): HTMLLabelElement {
  const el = document.createElement("label");
  el.className = "k-field";
  const cap = document.createElement("span");
  cap.className = "k-field-label";
  cap.textContent = label;
  const sel = document.createElement("select");
  for (const o of options) sel.add(new Option(o.label, o.value, false, o.value === value));
  sel.addEventListener("change", () => onChange(sel.value as T));
  el.append(cap, sel);
  return el;
}

/** Open the sheet. `ch0` / `ch1` are the device's channel LED counts (0 = unset). */
export function openCurtainLayoutSheet(ch0: number, ch1: number): void {
  const grid = suggestGrid(ch0);
  const spec: CurtainRopeSpec = {
    curtain: { ...DEFAULT_SPEC.curtain, ...(grid ?? {}) },
    rope: { ...DEFAULT_SPEC.rope, count: ch1 > 0 ? ch1 : 0 },
  };
  const sheet = Sheet("Generate a curtain + rope map");
  const intro = document.createElement("p");
  intro.className = "hw-hint";
  intro.textContent =
    "Fallback for when you can't camera-map: builds the map from how the curtain (channel 0) " +
    "is wired, plus the rope (channel 1) laid in front of it. Effects then follow the curtain's grid.";
  const check = document.createElement("p");
  check.className = "hw-hint";

  const num = (label: string, v: number, set: (n: number) => void): HTMLElement => {
    const f = Field({
      label,
      type: "number",
      value: String(v),
      onInput: (s) => {
        set(Number(s));
        refresh();
      },
    });
    f.input.min = "0";
    f.input.inputMode = "numeric";
    return f.el;
  };
  const c = spec.curtain;
  const push = Button({ label: "Save + push to device", variant: "primary", block: true, onClick: () => void go() });

  function refresh(): void {
    const { ch0: n0, ch1: n1 } = channelCounts(spec);
    const bad: string[] = [];
    if (ch0 > 0 && n0 !== ch0) bad.push(`curtain is ${n0} LEDs but channel 0 is set to ${ch0}`);
    if (ch1 > 0 && n1 !== ch1) bad.push(`rope is ${n1} LEDs but channel 1 is set to ${ch1}`);
    check.textContent =
      `LEDs 0–${n0 - 1} curtain` + (n1 > 0 ? `, ${n0}–${n0 + n1 - 1} rope` : "") + ". " +
      (bad.length > 0 ? `Check: ${bad.join("; ")}.` : "Matches the channel counts.");
  }

  async function go(): Promise<void> {
    const client = appState.client;
    if (!client?.isConnected) {
      toast("Connect a device first", { error: true });
      return;
    }
    push.disabled = true;
    try {
      const map = generateCurtainRopeMap(spec);
      const name = layoutName(spec);
      await mapStore.create({ map, source: "import", name, deviceMapId: map.mapId });
      await client.submitMap(map);
      toast(`${name} saved and pushed to the device`);
      sheet.close();
    } catch (e) {
      toast(`Push failed: ${e instanceof Error ? e.message : String(e)}`, { error: true });
    } finally {
      push.disabled = false;
    }
  }

  sheet.body.append(
    intro,
    num("Curtain columns (LEDs across)", c.cols, (n) => (c.cols = n)),
    num("Curtain rows (LEDs down)", c.rows, (n) => (c.rows = n)),
    select("First LED (data in), seen from the front", CORNERS, c.origin, (v) => (c.origin = v)),
    select(
      "Strands run",
      [
        { value: "columns", label: "Down (vertical strands)" },
        { value: "rows", label: "Across (horizontal rows)" },
      ],
      c.runs,
      (v) => (c.runs = v),
    ),
    select(
      "Wiring",
      [
        { value: "serpentine", label: "Zig-zag (each strand doubles back)" },
        { value: "linear", label: "Every strand starts on the same side" },
      ],
      c.wiring,
      (v) => (c.wiring = v),
    ),
    num("LED spacing (cm)", Math.round(c.colSpacing * 100), (n) => {
      c.colSpacing = n / 100;
      c.rowSpacing = n / 100;
    }),
    num("Rope LEDs (channel 1)", spec.rope.count, (n) => (spec.rope.count = n)),
    select(
      "Rope shape",
      [
        { value: "arc", label: "Gentle arc in front" },
        { value: "line", label: "Straight line along the foot" },
      ],
      spec.rope.shape,
      (v) => (spec.rope.shape = v),
    ),
    check,
    push,
  );
  refresh();
}

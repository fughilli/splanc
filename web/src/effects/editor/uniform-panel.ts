/**
 * Auto uniform panel (docs/design/effects-compiler.md §"live uniform panel"):
 * renders one control per manifest uniform (slider/color/toggle/dropdown) and
 * holds the live values. Preview and device consume the SAME values — dragging a
 * control fires `onChange(slot, value[])` with the exact numbers both sinks use.
 *
 * On recompile the panel is RECONCILED against the new manifest: a uniform with
 * the same name+width+ui keeps its current live value; new ones appear at their
 * default; removed ones drop out. So tweaking the script while a slider sits at
 * 0.7 doesn't reset that slider.
 */

import type { FxUiKind, FxUniform } from "../../fx/preview";

interface Slot {
  uniform: FxUniform;
  value: number[];
}

/** Stable identity key for reconciliation: same name+width+ui => keep value. */
function keyOf(u: FxUniform): string {
  return `${u.name}|${u.width}|${JSON.stringify(u.ui)}`;
}

export class UniformPanel {
  private slots: Slot[] = [];

  constructor(
    private readonly root: HTMLElement,
    private readonly onChange: (slot: number, value: number[]) => void,
  ) {}

  /** Current live values, keyed by manifest slot. */
  values(): { slot: number; value: number[] }[] {
    return this.slots.map((s) => ({ slot: s.uniform.slot, value: s.value.slice() }));
  }

  /** Overwrite live values (e.g. from device getEffectUniforms hydration). */
  hydrate(values: { slot: number; value: number[] }[]): void {
    for (const v of values) {
      const s = this.slots.find((x) => x.uniform.slot === v.slot);
      if (s) s.value = v.value.slice();
    }
    this.render();
  }

  /** Reconcile against a new manifest, preserving live values where possible. */
  setManifest(uniforms: FxUniform[]): void {
    const prev = new Map(this.slots.map((s) => [keyOf(s.uniform), s.value]));
    this.slots = uniforms.map((u) => ({
      uniform: u,
      value: (prev.get(keyOf(u)) ?? u.default).slice(),
    }));
    this.render();
  }

  private set(slotIndex: number, value: number[]): void {
    const s = this.slots[slotIndex];
    if (s === undefined) return;
    s.value = value;
    this.onChange(s.uniform.slot, value);
  }

  private render(): void {
    this.root.replaceChildren();
    if (this.slots.length === 0) {
      const p = document.createElement("p");
      p.className = "muted";
      p.textContent = "No uniforms declared.";
      this.root.appendChild(p);
      return;
    }
    this.slots.forEach((s, i) => this.root.appendChild(this.control(s, i)));
  }

  private control(s: Slot, i: number): HTMLElement {
    const wrap = document.createElement("label");
    wrap.className = "uni";
    const name = document.createElement("span");
    name.className = "uni-name";
    name.textContent = s.uniform.name;
    wrap.appendChild(name);
    wrap.appendChild(this.input(s, i));
    return wrap;
  }

  private input(s: Slot, i: number): HTMLElement {
    const ui: FxUiKind = s.uniform.ui;
    if (ui.kind === "toggle") {
      const el = document.createElement("input");
      el.type = "checkbox";
      el.checked = (s.value[0] ?? 0) >= 0.5;
      el.addEventListener("change", () => this.set(i, [el.checked ? 1 : 0]));
      return el;
    }
    if (ui.kind === "color") {
      const el = document.createElement("input");
      el.type = "color";
      el.value = rgbToHex(s.value);
      el.addEventListener("input", () => this.set(i, hexToRgb(el.value, s.uniform.width)));
      return el;
    }
    if (ui.kind === "dropdown") {
      const el = document.createElement("select");
      ui.options.forEach((opt, idx) => {
        const o = document.createElement("option");
        o.value = String(idx);
        o.textContent = opt;
        el.appendChild(o);
      });
      el.value = String(Math.round(s.value[0] ?? 0));
      el.addEventListener("change", () => this.set(i, [parseInt(el.value, 10)]));
      return el;
    }
    // slider
    const box = document.createElement("span");
    box.className = "uni-slider";
    const el = document.createElement("input");
    el.type = "range";
    el.min = String(ui.min);
    el.max = String(ui.max);
    el.step = String(ui.step > 0 ? ui.step : 0.001);
    el.value = String(s.value[0] ?? ui.min);
    const val = document.createElement("span");
    val.className = "uni-val";
    val.textContent = (s.value[0] ?? ui.min).toFixed(2);
    el.addEventListener("input", () => {
      const v = parseFloat(el.value);
      val.textContent = v.toFixed(2);
      this.set(i, [v]);
    });
    box.appendChild(el);
    box.appendChild(val);
    return box;
  }
}

function clamp255(x: number): number {
  return Math.max(0, Math.min(255, Math.round(x * 255)));
}
function rgbToHex(v: number[]): string {
  const [r, g, b] = [v[0] ?? 0, v[1] ?? 0, v[2] ?? 0];
  const h = (n: number): string => clamp255(n).toString(16).padStart(2, "0");
  return `#${h(r)}${h(g)}${h(b)}`;
}
function hexToRgb(hex: string, width: number): number[] {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const out = [r, g, b];
  // vec4 color uniforms carry an alpha slot; default it opaque.
  if (width >= 4) out.push(1);
  return out.slice(0, Math.max(3, width));
}

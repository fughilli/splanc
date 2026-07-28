/**
 * Uniform schema → kit controls (design doc §4.4 / §7.6). The reserved seam for
 * the forthcoming effects runtime: an effect publishes a uniform schema and the
 * app renders it to controls automatically. Today's hard-coded pulse/flood
 * params are expressed as a schema until the runtime publishes real ones, so
 * the Effects panel is already data-driven ("schema → controls → re-run").
 */

import { Slider } from "../ui/kit";

export type UniformValue = number | boolean | string;

export type UniformSpec =
  | { name: string; label: string; type: "float"; default: number; min: number; max: number; step: number }
  | { name: string; label: string; type: "int"; default: number; min: number; max: number }
  | { name: string; label: string; type: "bool"; default: boolean }
  | { name: string; label: string; type: "enum"; default: string; options: string[] }
  | { name: string; label: string; type: "color"; default: string }
  | { name: string; label: string; type: "trigger" };

export type UniformValues = Record<string, UniformValue>;

/** Build the initial value map from a schema's defaults. */
export function defaultValues(schema: UniformSpec[]): UniformValues {
  const out: UniformValues = {};
  for (const u of schema) {
    if (u.type !== "trigger") out[u.name] = u.default;
  }
  return out;
}

/**
 * Render a uniform schema to a control panel. `onChange(name, value)` fires on
 * every edit (hot-reload); `onTrigger(name)` fires one-shot for triggers. The
 * mapping (§4.4): float→Slider, int→stepped Slider, bool→toggle, color→swatch,
 * enum→dropdown, trigger→button.
 */
export function renderUniformControls(
  schema: UniformSpec[],
  values: UniformValues,
  onChange: (name: string, value: UniformValue) => void,
  onTrigger?: (name: string) => void,
): HTMLElement {
  const panel = document.createElement("div");
  panel.className = "uniform-panel";
  for (const u of schema) {
    switch (u.type) {
      case "float":
      case "int": {
        const step = u.type === "int" ? 1 : u.step;
        const cur = typeof values[u.name] === "number" ? (values[u.name] as number) : u.default;
        panel.append(
          Slider({
            label: u.label,
            min: u.min,
            max: u.max,
            step,
            value: cur,
            format: (v) => (u.type === "int" ? String(Math.round(v)) : v.toFixed(2)),
            onInput: (v) => onChange(u.name, u.type === "int" ? Math.round(v) : v),
          }).el,
        );
        break;
      }
      case "bool": {
        const row = document.createElement("label");
        row.className = "uniform-row";
        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.checked = Boolean(values[u.name] ?? u.default);
        cb.addEventListener("change", () => onChange(u.name, cb.checked));
        const span = document.createElement("span");
        span.textContent = u.label;
        row.append(cb, span);
        panel.append(row);
        break;
      }
      case "enum": {
        const row = document.createElement("label");
        row.className = "uniform-row";
        const span = document.createElement("span");
        span.textContent = u.label;
        const sel = document.createElement("select");
        for (const opt of u.options) {
          const o = document.createElement("option");
          o.value = opt;
          o.textContent = opt;
          sel.appendChild(o);
        }
        sel.value = String(values[u.name] ?? u.default);
        sel.addEventListener("change", () => onChange(u.name, sel.value));
        row.append(span, sel);
        panel.append(row);
        break;
      }
      case "color": {
        const row = document.createElement("label");
        row.className = "uniform-row";
        const span = document.createElement("span");
        span.textContent = u.label;
        const inp = document.createElement("input");
        inp.type = "color";
        inp.value = String(values[u.name] ?? u.default);
        inp.addEventListener("input", () => onChange(u.name, inp.value));
        row.append(span, inp);
        panel.append(row);
        break;
      }
      case "trigger": {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "k-btn k-btn--quiet";
        btn.textContent = u.label;
        btn.addEventListener("click", () => onTrigger?.(u.name));
        panel.append(btn);
        break;
      }
    }
  }
  return panel;
}

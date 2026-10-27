/**
 * The effect workspace's FX debugger pane (docs/design/fx-debugger.md): pause /
 * step / resume the connected device's FX engine, compare the device's frame
 * with a host replay of it (fx/fxDebug.ts compareWithPreview), show the device's
 * colours or a diff in the 3D preview (rings on the LEDs that differ), and
 * inspect a clicked LED — its shade() inputs, the VM locals of a re-run on the
 * device, and the effect's uniforms / state — named from the compiler's symbol
 * table when the code in the editor is what the device runs.
 *
 * The device pause is a lease: the pane keeps it alive while it is open
 * (status polls) and resumes the engine when it closes, so a fixture never
 * stays frozen.
 */

import {
  compareWithPreview,
  decodeLedRecord,
  fxbHash,
  FxDebugger,
  parseFxbLayout,
  slotName,
  type CompareReport,
  type FxEngineState,
} from "../../fx/fxDebug";
import { loadReplayVm, type FxSymbol } from "../../fx/preview";
import type { LedMapperClient } from "../../net/client";
import type { MappingBundle } from "../../net/proto";
import { Button } from "../../ui/kit";

export interface FxDebugPanelHost {
  /** The connected device (null when none). */
  client(): LedMapperClient | null;
  /** The map + topology the preview runs on (null before one is loaded). */
  bundle(): MappingBundle | null;
  /** The last compile's symbol table + bytecode (to name VM slots). */
  compiled(): { symbols?: FxSymbol[]; bytecode: Uint8Array } | null;
  /** Show these colours (map.leds order) in the preview instead of the live
   * effect; null returns to the live preview. */
  showColors(colors: Uint8Array | null): void;
  /** Rings on map.leds indices (null clears), and the selected LED. */
  mark(marks: Map<number, string> | null, selected: number | null): void;
  /** Route preview taps (a map.leds index) here; null stops. */
  setPicker(cb: ((index: number) => void) | null): void;
}

const HOLD_MS = 60_000;
const POLL_MS = 4_000;
const ENGINE = "#ff4d4d";
const INPUT = "#ffb020";

type View = "preview" | "device" | "diff";

let stylesInstalled = false;
function installStyles(): void {
  if (stylesInstalled || typeof document === "undefined") return;
  stylesInstalled = true;
  const style = document.createElement("style");
  style.textContent = `
.fxdbg { display:flex; flex-direction:column; gap:var(--sp-2); padding:var(--sp-2); font-size:13px; }
.fxdbg-row { display:flex; flex-wrap:wrap; gap:var(--sp-1); align-items:center; }
.fxdbg-row input[type=number] {
  width:5.5em; background:var(--surface-2); color:var(--text); border:1px solid var(--border);
  border-radius:var(--r-ctrl); padding:0.4rem 0.5rem; font:inherit;
}
.fxdbg-row input[type=number]:focus { outline:none; border-color:var(--accent); }
.fxdbg-status { color:var(--text-dim); font-variant-numeric:tabular-nums; }
.fxdbg-status[data-paused="1"] { color:var(--warn); }
.fxdbg-views button[aria-pressed="true"] { outline:2px solid var(--accent); }
.fxdbg-verdict { font-weight:600; }
.fxdbg-verdict[data-v="match"] { color:var(--ok); }
.fxdbg-verdict[data-v="engine"], .fxdbg-verdict[data-v="mixed"] { color:var(--err); }
.fxdbg-verdict[data-v="inputs"], .fxdbg-verdict[data-v="output_stage"] { color:var(--warn); }
.fxdbg-findings { margin:0; padding-left:1.2em; }
.fxdbg-findings li { margin:2px 0; }
.fxdbg-legend { color:var(--text-dim); font-size:12px; }
.fxdbg-legend i { display:inline-block; width:9px; height:9px; border-radius:50%; border:2px solid; margin:0 4px -1px 8px; }
.fxdbg-inspect { border-top:1px solid var(--border); padding-top:var(--sp-2); }
.fxdbg-inspect table { border-collapse:collapse; width:100%; }
.fxdbg-inspect td { padding:1px 6px 1px 0; vertical-align:top; font-variant-numeric:tabular-nums; }
.fxdbg-inspect td:first-child { color:var(--text-dim); white-space:nowrap; }
.fxdbg-swatch { display:inline-block; width:12px; height:12px; border-radius:3px; vertical-align:-2px; margin-right:4px; border:1px solid var(--border); }
.fxdbg-h { font-weight:600; margin:var(--sp-1) 0 2px; }
`;
  document.head.appendChild(style);
}

const fmt = (v: number): string => (Number.isInteger(v) ? String(v) : Number.isFinite(v) ? v.toPrecision(6) : String(v));
const rgbCss = (c: ArrayLike<number>): string => `rgb(${c[0] ?? 0} ${c[1] ?? 0} ${c[2] ?? 0})`;

export class FxDebugPanel {
  readonly node: HTMLElement;
  private dbg: FxDebugger | null = null;
  private dbgFor: LedMapperClient | null = null;
  private state: FxEngineState | null = null;
  private report: CompareReport | null = null;
  private view: View = "preview";
  private selected: number | null = null;
  private pausedByUs = false;
  private poll = 0;
  private busy = false;
  private disposed = false;

  private readonly statusEl: HTMLElement;
  private readonly dtEl: HTMLInputElement;
  private readonly framesEl: HTMLInputElement;
  private readonly btns: HTMLButtonElement[] = [];
  private readonly viewBtns = new Map<View, HTMLButtonElement>();
  private readonly reportEl: HTMLElement;
  private readonly inspectEl: HTMLElement;

  constructor(private readonly host: FxDebugPanelHost) {
    installStyles();
    this.node = document.createElement("div");
    this.node.className = "fxdbg";
    const intro = document.createElement("div");
    intro.className = "fxdbg-legend";
    intro.textContent =
      "Fixture doesn't match the preview? Pause the device, compare its frame with a replay on this computer, and tap an LED to inspect it.";

    const ctl = document.createElement("div");
    ctl.className = "fxdbg-row";
    const pause = Button({ label: "Pause", onClick: () => void this.act(() => this.pause()) });
    const resume = Button({ label: "Resume", variant: "quiet", onClick: () => void this.act(() => this.resume()) });
    this.framesEl = numberInput(1, 1, 600, 1, "frames to step");
    this.dtEl = numberInput(33, 0, 1000, 1, "ms of effect time per step (blank: the device's last dt)");
    const step = Button({ label: "Step", onClick: () => void this.act(() => this.step()) });
    const lbl = (t: string) => {
      const s = document.createElement("span");
      s.className = "fxdbg-legend";
      s.textContent = t;
      return s;
    };
    ctl.append(pause, resume, step, this.framesEl, lbl("frames ×"), this.dtEl, lbl("ms"));
    this.btns.push(pause, resume, step);

    const cmp = document.createElement("div");
    cmp.className = "fxdbg-row";
    const compare = Button({ label: "Compare with preview", onClick: () => void this.act(() => this.compare()) });
    this.btns.push(compare);
    const views = document.createElement("div");
    views.className = "fxdbg-row fxdbg-views";
    for (const [v, label] of [
      ["preview", "Preview"],
      ["device", "Device"],
      ["diff", "Diff"],
    ] as const) {
      const b = Button({ label, variant: "quiet", onClick: () => this.setView(v) });
      b.setAttribute("aria-pressed", String(v === this.view));
      this.viewBtns.set(v, b);
      views.append(b);
    }
    cmp.append(compare, views);

    this.statusEl = document.createElement("div");
    this.statusEl.className = "fxdbg-status";
    this.reportEl = document.createElement("div");
    this.inspectEl = document.createElement("div");
    this.inspectEl.className = "fxdbg-inspect";
    this.inspectEl.hidden = true;
    this.node.append(intro, ctl, cmp, this.statusEl, this.reportEl, this.inspectEl);
    this.host.setPicker((i) => void this.inspect(i));
    this.refresh();
  }

  /** Re-evaluate the connection (call on connect / disconnect). */
  refresh(): void {
    const c = this.host.client();
    const features = (c?.welcome as unknown as { features?: string[] } | null)?.features ?? [];
    const ok = !!c?.isConnected && features.includes("fx_debug");
    for (const b of this.btns) b.disabled = !ok || this.busy;
    if (!c?.isConnected) {
      this.setStatus("Connect a device to debug it.");
      this.stopPolling();
      this.state = null;
      this.dbg = null;
      this.dbgFor = null;
    } else if (!ok) {
      this.setStatus("This device's firmware has no FX debugger — update it.");
    } else if (!this.state) {
      this.setStatus("Running.");
    }
  }

  private debugger(): FxDebugger {
    const c = this.host.client();
    if (!c?.isConnected) throw new Error("no device connected");
    if (this.dbgFor !== c || !this.dbg) {
      this.dbg = new FxDebugger(c);
      this.dbgFor = c;
    }
    return this.dbg;
  }

  private async act(fn: () => Promise<void>): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.refresh();
    try {
      await fn();
    } catch (e) {
      this.setStatus(`⚠ ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      this.busy = false;
      this.refresh();
    }
  }

  private async pause(): Promise<void> {
    this.show(await this.debugger().pause(HOLD_MS));
    this.pausedByUs = true;
    this.startPolling();
  }

  private async resume(): Promise<void> {
    this.show(await this.debugger().resume());
    this.pausedByUs = false;
    this.stopPolling();
    this.setView("preview");
  }

  private async step(): Promise<void> {
    const frames = Math.max(1, Math.round(Number(this.framesEl.value) || 1));
    const dtMs = this.dtEl.value === "" ? undefined : Number(this.dtEl.value);
    const st = await this.debugger().step({ frames, holdMs: HOLD_MS, ...(dtMs !== undefined && Number.isFinite(dtMs) ? { dt: dtMs / 1000 } : {}) });
    this.pausedByUs = true;
    this.show(st);
    this.startPolling();
    if (this.view !== "preview") await this.refreshDeviceColors();
  }

  private async compare(): Promise<void> {
    this.setStatus("Pausing, stepping one frame and replaying it…");
    const vm = await loadReplayVm();
    const comp = this.host.compiled();
    const st = await this.debugger().status(HOLD_MS);
    const deck = st.decks.find((d) => d.renders);
    const symbols = comp?.symbols && deck && fxbHash(comp.bytecode) === deck.fxbHash ? comp.symbols : undefined;
    this.report = await compareWithPreview(this.debugger(), vm, { bundle: this.host.bundle(), holdMs: HOLD_MS, ...(symbols ? { symbols } : {}) });
    this.deviceOut = null;
    this.pausedByUs = true;
    this.show(await this.debugger().status(HOLD_MS));
    this.startPolling();
    this.renderReport(symbols !== undefined, deck !== undefined && comp !== null);
    this.setView("diff");
  }

  private renderReport(named: boolean, hadCode: boolean): void {
    const r = this.report;
    this.reportEl.replaceChildren();
    if (!r) return;
    const v = document.createElement("div");
    v.className = "fxdbg-verdict";
    v.dataset["v"] = r.verdict;
    v.textContent = {
      match: "✓ Device matches the replay",
      engine: "✕ Engine divergence",
      inputs: "⚠ The preview's inputs differ",
      output_stage: "⚠ Output stage changes the colours",
      mixed: "✕ Several differences",
    }[r.verdict];
    const ul = document.createElement("ul");
    ul.className = "fxdbg-findings";
    for (const f of r.findings) {
      const li = document.createElement("li");
      li.textContent = f;
      ul.append(li);
    }
    const legend = document.createElement("div");
    legend.className = "fxdbg-legend";
    legend.innerHTML = `Diff rings: <i style="border-color:${ENGINE}"></i>engine <i style="border-color:${INPUT}"></i>inputs · tap an LED to inspect it`;
    const note = document.createElement("div");
    note.className = "fxdbg-legend";
    note.textContent = named
      ? "VM slots are named from the code in the editor (it matches the device's program)."
      : hadCode
        ? "The editor's code isn't what the device runs — VM slots are shown by number."
        : "";
    this.reportEl.append(v, ul, legend, note);
  }

  private show(st: FxEngineState): void {
    this.state = st;
    const deck = st.decks.filter((d) => d.renders).map((d) => `${d.deck ? "B" : "A"}: ${d.effectId || "?"}${d.jitBlocks ? ` (JIT ×${d.jitBlocks})` : ""}`).join(" · ");
    const left = st.paused ? ` · auto-resume in ${Math.ceil(st.holdRemainingMs / 1000)} s` : "";
    this.setStatus(
      `${st.paused ? "⏸ Paused" : "▶ Running"} · frame ${st.frame} · t ${st.time.toFixed(3)} s · dt ${(st.dt * 1000).toFixed(1)} ms · ${st.currentFps} fps · ${deck}${left}` +
        (st.resumeReason && !st.paused ? ` · last auto-resume: ${st.resumeReason}` : ""),
      st.paused,
    );
  }

  private setStatus(text: string, paused = false): void {
    this.statusEl.textContent = text;
    this.statusEl.dataset["paused"] = paused ? "1" : "0";
  }

  private startPolling(): void {
    if (this.poll) return;
    this.poll = window.setInterval(() => {
      if (this.busy || !this.dbg) return;
      void this.dbg.status(HOLD_MS).then(
        (st) => {
          this.show(st);
          if (!st.paused) {
            this.pausedByUs = false;
            this.stopPolling();
          }
        },
        () => undefined,
      );
    }, POLL_MS);
  }

  private stopPolling(): void {
    if (this.poll) window.clearInterval(this.poll);
    this.poll = 0;
  }

  private setView(v: View): void {
    this.view = v;
    for (const [k, b] of this.viewBtns) b.setAttribute("aria-pressed", String(k === v));
    void this.paint();
  }

  /** map.leds index <-> device LED index (= LED id on the device). */
  private ids(): number[] {
    return this.host.bundle()?.map?.leds.map((l) => l.id) ?? [];
  }

  /** Re-read the device's strip colours (after a step) for the Device view. */
  private async refreshDeviceColors(): Promise<void> {
    if (!this.dbg) return;
    this.deviceOut = await this.dbg.readSection("output");
    await this.paint();
  }

  /** The device's colours read after the last step (else the compare's). */
  private deviceOut: Uint8Array | null = null;

  private async paint(): Promise<void> {
    const ids = this.ids();
    if (this.view === "preview" || ids.length === 0) {
      this.host.showColors(null);
      this.host.mark(null, this.selected);
      return;
    }
    const r = this.report;
    const out = this.deviceOut ?? r?.deviceOutput ?? null;
    const first = this.deviceOut ? 0 : (r?.first ?? 0);
    if (!out) {
      this.host.showColors(null);
      return;
    }
    const colors = new Uint8Array(ids.length * 3);
    ids.forEach((id, i) => {
      const k = id - first;
      if (k >= 0 && k * 3 + 2 < out.length) colors.set(out.subarray(k * 3, k * 3 + 3), i * 3);
    });
    if (this.view === "diff") for (let k = 0; k < colors.length; k++) colors[k] = Math.round(colors[k]! * 0.45);
    this.host.showColors(colors);
    if (this.view === "diff" && r) {
      const marks = new Map<number, string>();
      const at = new Map(ids.map((id, i) => [id, i]));
      for (const l of r.inputs?.leds ?? []) {
        const i = at.get(l.led);
        const changes = l.previewRgb && l.deviceRgb && l.previewRgb.some((v, k) => v !== l.deviceRgb![k]);
        if (i !== undefined && changes) marks.set(i, INPUT);
      }
      for (const m of r.engine.leds) {
        const i = at.get(m.led);
        if (i !== undefined) marks.set(i, ENGINE);
      }
      this.host.mark(marks, this.selected);
    } else {
      this.host.mark(null, this.selected);
    }
  }

  /** A tapped LED (map.leds index): its inputs, a device re-run's locals, and
   * the effect's uniforms / state. */
  private async inspect(index: number): Promise<void> {
    this.selected = index;
    void this.paint();
    const id = this.ids()[index];
    if (id === undefined || !this.state?.paused || !this.dbg) {
      this.inspectEl.hidden = false;
      this.inspectEl.textContent = this.state?.paused ? "" : "Pause the device to inspect an LED.";
      return;
    }
    const dbg = this.dbg;
    const st = this.state;
    const deck = st.decks.find((d) => d.renders)?.deck ?? 0;
    try {
      const comp = this.host.compiled();
      const dk = st.decks.find((d) => d.deck === deck);
      const symbols = comp?.symbols && dk && fxbHash(comp.bytecode) === dk.fxbHash ? comp.symbols : undefined;
      const led = await dbg.debugLed(id, deck);
      const program = await dbg.readSection("program", deck);
      const uniforms = new Float32Array((await dbg.readSection("uniforms", deck)).slice().buffer);
      const state = new Float32Array((await dbg.readSection("state", deck)).slice().buffer);
      const layout = parseFxbLayout(program);
      const rows: [string, string | HTMLElement][] = [];
      const sw = (c: number[] | null, extra = ""): HTMLElement => {
        const s = document.createElement("span");
        if (!c) {
          s.textContent = "—";
          return s;
        }
        const b = document.createElement("span");
        b.className = "fxdbg-swatch";
        b.style.background = rgbCss(c);
        s.append(b, `${c.join(", ")}${extra}`);
        return s;
      };
      rows.push(["shown", sw(led.output)]);
      rows.push(["effect (interpreter)", sw(led.rgb)]);
      if (led.rgbJit) rows.push(["effect (normal path)", sw(led.rgbJit, led.rgbJit.some((v, k) => v !== led.rgb[k]) ? "  ✕ JIT differs" : "")]);
      const exp = this.report ? this.report.expected.subarray((id - this.report.first) * 3, (id - this.report.first) * 3 + 3) : null;
      if (exp && exp.length === 3) rows.push(["replay expected", sw(Array.from(exp))]);
      const inp = led.inputs.hasEntry ? led.inputs : decodeLedRecord(led.ledContext);
      rows.push(["led.pos", inp.pos.map(fmt).join(", ")]);
      rows.push(["led.seg / s / dist", `${inp.seg} / ${fmt(inp.s)} / ${fmt(inp.dist)}${inp.branch ? " (branch)" : ""}`]);
      rows.push(["led.uv", inp.uv.map(fmt).join(", ")]);
      rows.push(["instructions", `${led.instructions} (stack ${led.stackMax})`]);
      const table = (title: string, entries: [string, string | HTMLElement][]) => {
        const h = document.createElement("div");
        h.className = "fxdbg-h";
        h.textContent = title;
        const t = document.createElement("table");
        for (const [k, v] of entries) {
          const tr = document.createElement("tr");
          const a = document.createElement("td");
          a.textContent = k;
          const b = document.createElement("td");
          b.append(v);
          tr.append(a, b);
          t.append(tr);
        }
        return [h, t];
      };
      const locals: [string, string][] = [];
      led.locals.forEach((v, slot) => {
        const name = slotName(symbols, "local", slot);
        if (v !== 0 || name) locals.push([name ? `${name} [${slot}]` : `slot ${slot}`, fmt(v)]);
      });
      const uni: [string, string][] = (layout?.manifest ?? []).map((m) => [
        m.name,
        Array.from(uniforms.subarray(m.slot, m.slot + (m.width || 1))).map(fmt).join(", "),
      ]);
      const sta: [string, string][] = [];
      for (let k = 0; k < (layout?.nState ?? 0); k++) {
        const name = slotName(symbols, "state", k);
        sta.push([name ? `${name} [${k}]` : `slot ${k}`, fmt(state[k] ?? 0)]);
      }
      this.inspectEl.hidden = false;
      this.inspectEl.replaceChildren(
        ...table(`LED ${id} · deck ${deck ? "B" : "A"} · frame ${st.frame}`, rows),
        ...table(`Locals${symbols ? "" : " (by slot — compile the device's effect here to name them)"}`, locals.length ? locals : [["—", "no local written"]]),
        ...table("Uniforms", uni),
        ...table("State", sta),
      );
    } catch (e) {
      this.inspectEl.hidden = false;
      this.inspectEl.textContent = `inspect failed: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  /** Leave: stop polling, drop the overlay, and resume a pause this pane made. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stopPolling();
    this.host.setPicker(null);
    this.host.showColors(null);
    this.host.mark(null, null);
    if (this.pausedByUs && this.dbg) void this.dbg.resume().catch(() => undefined);
  }
}

function numberInput(value: number, min: number, max: number, step: number, title: string): HTMLInputElement {
  const i = document.createElement("input");
  i.type = "number";
  i.value = String(value);
  i.min = String(min);
  i.max = String(max);
  i.step = String(step);
  i.title = title;
  return i;
}

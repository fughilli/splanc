/**
 * Keypoint strip — the device-stored named uniform positions of the effect on one
 * FX deck (docs/design/uniform-keypoints.md), as a row of pads plus a morph
 * fader. Shared by Show Mode (one per deck) and the effect editor.
 *
 *   - tap a pad: recall it (over `morph` seconds — 0 = jump);
 *   - "＋ Save": store the deck's live uniforms under a name (overwrites by name);
 *   - the fader morphs between two chosen pads in parameter space, on the device
 *     (fire-and-forget blends, throttled to the wire);
 *   - long-press / right-click a pad: delete it.
 *
 * The device owns the list; the strip re-reads it after every change.
 */

import { Button, toast } from "../kit";
import type { LedMapperClient } from "../../net/client";
import type { KeypointInfoFlat } from "../../net/proto";
import {
  Throttle,
  defaultKeypointName,
  morphWeights,
  stepKeypoint,
  supportsKeypoints,
  validKeypointName,
} from "../../effects/keypoints";

export interface KeypointStripOpts {
  deck: 0 | 1;
  /** The live client (null when disconnected). */
  client: () => LedMapperClient | null;
  /** Called after a recall/blend so the host can re-pull the deck's uniforms. */
  onApplied?: () => void;
}

export interface KeypointStrip {
  el: HTMLElement;
  /** Re-read the deck's keypoints from the device (after a cue / connect). */
  refresh(): Promise<void>;
  /** Morph fader position 0..1 (MIDI "morph" action). */
  setMorph(position: number): void;
  /** Recall the next / previous keypoint (MIDI triggers). */
  step(delta: number): void;
  /** Save the live uniforms under a fresh default name. */
  saveQuick(): Promise<void>;
}

const MORPH_CHOICES = [0, 1, 4] as const;

export function KeypointStrip(opts: KeypointStripOpts): KeypointStrip {
  const el = document.createElement("div");
  el.className = "kp-strip";
  let list: KeypointInfoFlat[] = [];
  let effectId = "";
  let current: string | null = null;
  let morphSeconds: number = 0;
  let fromKp: string | null = null;
  let toKp: string | null = null;
  let morphPos = 0;

  const deck = opts.deck;
  const live = (): LedMapperClient | null => {
    const c = opts.client();
    return c?.isConnected && supportsKeypoints(c.welcome) ? c : null;
  };

  const blendOut = new Throttle<number>((pos) => {
    const c = live();
    if (!c || !fromKp || !toKp) return;
    c.blendKeypoints(morphWeights(pos, fromKp, toKp), { deck });
  });

  function recall(name: string): void {
    const c = live();
    if (!c) return;
    current = name;
    c.blendKeypoints([{ name, weight: 1 }], { deck, seconds: morphSeconds });
    render();
    opts.onApplied?.();
  }

  async function save(name: string): Promise<void> {
    const c = live();
    if (!c) return;
    try {
      const r = await c.saveKeypoint(name, deck);
      list = r.keypoints;
      effectId = r.effectId;
      current = name;
      toast(`Saved keypoint "${name}"`);
    } catch (e) {
      toast(`Save failed: ${String(e)}`, { error: true });
    }
    render();
  }

  async function remove(name: string): Promise<void> {
    const c = live();
    if (!c || !confirm(`Delete keypoint "${name}" from the device?`)) return;
    try {
      const r = await c.deleteKeypoint(name, deck);
      list = r.keypoints;
      if (current === name) current = null;
    } catch (e) {
      toast(`Delete failed: ${String(e)}`, { error: true });
    }
    render();
  }

  function pickEnds(): void {
    const names = [...list].sort((a, b) => a.index - b.index).map((k) => k.name);
    if (!fromKp || !names.includes(fromKp)) fromKp = names[0] ?? null;
    if (!toKp || !names.includes(toKp)) toKp = names[1] ?? names[0] ?? null;
  }

  function select(label: string, value: string | null, onChange: (v: string) => void): HTMLSelectElement {
    const s = document.createElement("select");
    s.className = "kp-select";
    s.setAttribute("aria-label", label);
    for (const k of [...list].sort((a, b) => a.index - b.index)) {
      const o = document.createElement("option");
      o.value = k.name;
      o.textContent = k.name;
      o.selected = k.name === value;
      s.append(o);
    }
    s.addEventListener("change", () => onChange(s.value));
    return s;
  }

  function render(): void {
    el.replaceChildren();
    const c = live();
    if (!c) {
      el.classList.add("kp-strip--off");
      return;
    }
    el.classList.remove("kp-strip--off");
    pickEnds();

    const head = document.createElement("div");
    head.className = "kp-head";
    const title = document.createElement("span");
    title.className = "kp-title";
    title.textContent = list.length ? `Keypoints · ${list.length}/16` : "Keypoints";
    const morph = document.createElement("button");
    morph.type = "button";
    morph.className = "kp-morph";
    morph.title = "Recall transition time";
    morph.textContent = morphSeconds === 0 ? "jump" : `${morphSeconds}s`;
    morph.addEventListener("click", () => {
      const i = MORPH_CHOICES.indexOf(morphSeconds as (typeof MORPH_CHOICES)[number]);
      morphSeconds = MORPH_CHOICES[(i + 1) % MORPH_CHOICES.length]!;
      render();
    });
    const add = Button({
      label: "Save",
      icon: "plus",
      variant: "quiet",
      onClick: () => {
        const raw = prompt("Name this look", defaultKeypointName(list));
        if (raw === null) return;
        const name = validKeypointName(raw);
        if (!name) {
          toast("Names are 1–32 characters", { error: true });
          return;
        }
        void save(name);
      },
    });
    head.append(title, morph, add);
    el.append(head);

    const pads = document.createElement("div");
    pads.className = "kp-pads";
    for (const k of [...list].sort((a, b) => a.index - b.index)) {
      const p = document.createElement("button");
      p.type = "button";
      p.className = "kp-pad";
      if (k.name === current) p.classList.add("kp-pad--on");
      if (k.stale) {
        p.classList.add("kp-pad--stale");
        p.title = "Saved against an older build of this effect (recalls by uniform name)";
      }
      p.textContent = k.name;
      p.addEventListener("click", () => recall(k.name));
      p.addEventListener("contextmenu", (ev) => {
        ev.preventDefault();
        void remove(k.name);
      });
      let hold = 0;
      p.addEventListener("pointerdown", () => {
        hold = window.setTimeout(() => void remove(k.name), 700);
      });
      for (const t of ["pointerup", "pointerleave", "pointercancel"]) {
        p.addEventListener(t, () => window.clearTimeout(hold));
      }
      pads.append(p);
    }
    if (list.length === 0) {
      const hint = document.createElement("span");
      hint.className = "kp-hint";
      hint.textContent = "Tune the uniforms, then Save to keep this look on the device.";
      pads.append(hint);
    }
    el.append(pads);

    if (list.length >= 2) {
      const row = document.createElement("div");
      row.className = "kp-fader";
      const fader = document.createElement("input");
      fader.type = "range";
      fader.min = "0";
      fader.max = "1000";
      fader.value = String(Math.round(morphPos * 1000));
      fader.className = "kp-fader-input";
      fader.setAttribute("aria-label", "Morph between keypoints");
      fader.addEventListener("input", () => setMorph(Number(fader.value) / 1000));
      row.append(
        select("Morph from", fromKp, (v) => {
          fromKp = v;
          blendOut.push(morphPos);
        }),
        fader,
        select("Morph to", toKp, (v) => {
          toKp = v;
          blendOut.push(morphPos);
        }),
      );
      el.append(row);
    }
    void effectId;
  }

  function setMorph(position: number): void {
    morphPos = Math.min(1, Math.max(0, position));
    const f = el.querySelector<HTMLInputElement>(".kp-fader-input");
    if (f) f.value = String(Math.round(morphPos * 1000));
    current = null;
    el.querySelectorAll(".kp-pad--on").forEach((p) => p.classList.remove("kp-pad--on"));
    blendOut.push(morphPos);
  }

  async function refresh(): Promise<void> {
    const c = live();
    if (!c) {
      list = [];
      render();
      return;
    }
    try {
      const r = await c.listKeypoints(deck);
      list = r.keypoints;
      effectId = r.effectId;
    } catch {
      list = []; // no effect on the deck yet
    }
    render();
  }

  render();
  return {
    el,
    refresh,
    setMorph,
    step: (delta) => {
      const n = stepKeypoint(list, current, delta);
      if (n) recall(n);
    },
    saveQuick: () => save(defaultKeypointName(list)),
  };
}

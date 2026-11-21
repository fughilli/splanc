/**
 * The Transitions flow (route /device/transitions; firmware feature "power",
 * docs/design/lamp-power.md): how the lamp turns ON and how it turns OFF, set
 * separately, plus what it does at power-up.
 *
 * One step per screen:
 *   overview  — the two current transitions + boot behaviour; "Try it".
 *   style     — Fade (default) / Cut / Play an effect.
 *   effect    — a built-in transition effect or one from the library (previews).
 *   look      — optional: a saved look (keypoint) of that effect on the lamp.
 *   duration  — the length; Save stores the effect (submit_effect power_slot)
 *               and the transition (set_power_config).
 *
 * Browser-only (statically imports the worker compiler, like showMode.ts), so
 * it is excluded from the CJS unit-test build; the logic lives in power/power.ts.
 */

import { Button, Slider, toast } from "../kit";
import type { Router, Screen } from "../app/router";
import { appState } from "../app/state";
import { effectStore, type StoredEffect } from "../../store/effectStore";
import { FxCompilerWorker } from "../../effects/editor/compiler";
import { EffectPreviewTiles } from "./effectPreviewTiles";
import {
  POWER_STYLE_CUT,
  POWER_STYLE_EFFECT,
  POWER_STYLE_FADE,
  type PowerState,
  type UniformValueFlat,
} from "../../net/proto";
import {
  BOOT_OPTIONS,
  MIN_DURATION_MS,
  SLIDER_MAX_MS,
  TRANSITION_PRESETS,
  choiceFromState,
  deviceHasPower,
  effectDisplayName,
  formatSeconds,
  keypointToUniforms,
  powerHeadline,
  slotFor,
  transitionMessage,
  transitionSummary,
  type Direction,
  type TransitionChoice,
} from "../../power/power";
import { installPowerStyles } from "./power.css";

type Step = "overview" | "style" | "effect" | "look" | "duration";

interface Candidate {
  id: string;
  name: string;
  hint: string;
  source: string;
}

export function PowerTransitionsScreen(_router: Router): Screen {
  installPowerStyles();
  const el = document.createElement("div");
  el.className = "screen screen--pw";
  const compiler = new FxCompilerWorker();
  const tiles = new EffectPreviewTiles();

  let state: PowerState | null = null;
  let step: Step = "overview";
  let dir: Direction = "on";
  let choice: TransitionChoice = choiceFromState(null, "on");
  let library: StoredEffect[] = [];
  let busy = false;
  // The look step: the lamp's saved looks for the picked effect.
  let looks: string[] | null = null;
  let unsub: (() => void) | null = null;
  let unsubApp: (() => void) | null = null;
  let bound: ReturnType<typeof client> = null;

  const client = () => {
    const c = appState.client;
    return c?.isConnected ? c : null;
  };

  const candidates = (): Candidate[] => [
    ...TRANSITION_PRESETS.map((p) => ({ id: p.id, name: p.name, hint: p.description, source: p.source })),
    ...library.map((e) => ({ id: e.id, name: e.name, hint: "From your effects library", source: e.source })),
  ];
  const nameOf = (id: string): string | undefined => candidates().find((c) => c.id === id)?.name;

  function headline(text: string, sub?: string): HTMLElement[] {
    const h = document.createElement("h1");
    h.className = "screen-headline";
    h.textContent = text;
    const out: HTMLElement[] = [h];
    if (sub) {
      const p = document.createElement("p");
      p.className = "screen-sub";
      p.textContent = sub;
      out.push(p);
    }
    return out;
  }

  function stepLine(): HTMLElement {
    const order: Step[] = choice.style === POWER_STYLE_EFFECT ? ["style", "effect", "look", "duration"] : ["style", "duration"];
    const i = order.indexOf(step);
    const s = document.createElement("div");
    s.className = "pw-steps";
    s.textContent = `Turning ${dir} · step ${i + 1} of ${order.length}`;
    return s;
  }

  function footer(primary: HTMLButtonElement | null, back: () => void): HTMLElement {
    const f = document.createElement("div");
    f.className = "pw-footer";
    f.append(Button({ label: "Back", variant: "quiet", onClick: back }));
    if (primary) f.append(primary);
    return f;
  }

  function tile(opts: {
    name: string;
    hint: string;
    pressed: boolean;
    onClick: () => void;
    thumb?: HTMLElement;
  }): HTMLButtonElement {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "pw-tile";
    b.setAttribute("aria-pressed", String(opts.pressed));
    const t = document.createElement("div");
    t.className = "pw-tile-text";
    const n = document.createElement("span");
    n.className = "pw-tile-name";
    n.textContent = opts.name;
    const h = document.createElement("span");
    h.className = "pw-tile-hint";
    h.textContent = opts.hint;
    t.append(n, h);
    if (opts.thumb) b.append(opts.thumb);
    b.append(t);
    b.addEventListener("click", opts.onClick);
    return b;
  }

  function glyphThumb(text: string): HTMLElement {
    const d = document.createElement("div");
    d.className = "pw-thumb pw-thumb--style";
    d.textContent = text;
    return d;
  }

  // -- overview -------------------------------------------------------------

  function overview(): HTMLElement[] {
    const c = client();
    const parts = headline(
      "On / off transitions",
      "How this lamp lights up and goes dark: from the app, the agent or a tap on the lid.",
    );
    if (!c || !deviceHasPower(c.welcome)) {
      const p = document.createElement("p");
      p.className = "pw-empty";
      p.textContent = c
        ? "This lamp's firmware doesn't support on/off yet. Update it from the device sheet."
        : "Connect a lamp to set up its transitions.";
      return [...parts, p];
    }
    for (const d of ["on", "off"] as Direction[]) {
      const t = state ? (d === "on" ? state.onTransition : state.offTransition) : null;
      const card = document.createElement("div");
      card.className = "pw-summary";
      const title = document.createElement("div");
      title.className = "pw-summary-title";
      title.textContent = d === "on" ? "Turning on" : "Turning off";
      const val = document.createElement("div");
      val.className = "pw-summary-val";
      val.textContent = t ? transitionSummary(t, d, nameOf) : "Reading…";
      card.append(
        title,
        val,
        Button({
          label: d === "on" ? "Change how it turns on" : "Change how it turns off",
          variant: "quiet",
          disabled: busy || !state,
          onClick: () => begin(d),
        }),
      );
      parts.push(card);
    }

    const bootTitle = document.createElement("div");
    bootTitle.className = "pw-section-title";
    bootTitle.textContent = "When power returns";
    const boot = document.createElement("div");
    boot.className = "pw-summary";
    for (const o of BOOT_OPTIONS) {
      const lab = document.createElement("label");
      lab.className = "pw-radio";
      const r = document.createElement("input");
      r.type = "radio";
      r.name = "pw-boot";
      r.checked = (state?.boot ?? 0) === o.value;
      r.disabled = busy || !state;
      r.addEventListener("change", () => void saveBoot(o.value));
      const t = document.createElement("span");
      t.className = "pw-tile-text";
      const n = document.createElement("span");
      n.className = "pw-tile-name";
      n.textContent = o.label;
      const h = document.createElement("span");
      h.className = "pw-tile-hint";
      h.textContent = o.hint;
      t.append(n, h);
      lab.append(r, t);
      boot.append(lab);
    }
    parts.push(bootTitle, boot);

    const f = document.createElement("div");
    f.className = "pw-footer";
    f.append(
      Button({
        label: state?.on ? "Try it: turn off" : "Try it: turn on",
        variant: "primary",
        disabled: busy || !state,
        onClick: () => void tryIt(),
      }),
    );
    const now = document.createElement("div");
    now.className = "pw-steps";
    now.textContent = `The lamp is ${powerHeadline(state).toLowerCase()}`;
    parts.push(now, f);
    return parts;
  }

  // -- steps ----------------------------------------------------------------

  function styleStep(): HTMLElement[] {
    const parts = [stepLine(), ...headline(dir === "on" ? "How should it turn on?" : "How should it turn off?")];
    const list = document.createElement("div");
    list.className = "pw-list";
    const opts: Array<{ style: number; name: string; hint: string; glyph: string }> = [
      { style: POWER_STYLE_FADE, name: "Fade", hint: "The show fades in or out smoothly.", glyph: "◐" },
      { style: POWER_STYLE_EFFECT, name: "Play an effect", hint: "Bloom, sparkle or any effect from your library.", glyph: "✦" },
      { style: POWER_STYLE_CUT, name: "Cut", hint: "Instantly on or off.", glyph: "▮" },
    ];
    for (const o of opts) {
      list.append(
        tile({
          name: o.name,
          hint: o.hint,
          pressed: choice.style === o.style,
          thumb: glyphThumb(o.glyph),
          onClick: () => {
            choice.style = o.style;
            render();
          },
        }),
      );
    }
    parts.push(list);
    const next = Button({
      label: choice.style === POWER_STYLE_CUT ? "Save" : "Next",
      variant: "primary",
      disabled: busy,
      onClick: () => {
        if (choice.style === POWER_STYLE_CUT) void save();
        else go(choice.style === POWER_STYLE_EFFECT ? "effect" : "duration");
      },
    });
    parts.push(footer(next, () => go("overview")));
    return parts;
  }

  function effectStep(): HTMLElement[] {
    const parts = [
      stepLine(),
      ...headline(
        "Pick the effect",
        "Built-in transitions follow the lamp's light level, so one works both ways. Any library effect works too: it's blended in and out of the show.",
      ),
    ];
    const list = document.createElement("div");
    list.className = "pw-list";
    tiles.reset();
    // Previews always (the app-wide renderFxPreviews default is off to save the
    // library browser's battery): here they ARE the choice, and the pool is lazy.
    for (const cnd of candidates()) {
      const thumb = document.createElement("div");
      thumb.className = "pw-thumb";
      tiles.observe(thumb, cnd.id, cnd.source);
      list.append(
        tile({
          name: cnd.name,
          hint: cnd.hint,
          pressed: choice.effectId === cnd.id,
          thumb,
          onClick: () => {
            if (choice.effectId !== cnd.id) {
              delete choice.label;
              delete choice.uniforms;
            }
            choice.effectId = cnd.id;
            // In place, not a re-render: that would restart every preview.
            for (const t of list.querySelectorAll(".pw-tile")) {
              t.setAttribute("aria-pressed", String(t.getAttribute("data-id") === cnd.id));
            }
            next.disabled = false;
          },
        }),
      );
      list.lastElementChild?.setAttribute("data-id", cnd.id);
    }
    parts.push(list);
    const next = Button({
      label: "Next",
      variant: "primary",
      disabled: busy || !choice.effectId,
      onClick: () => {
        looks = null;
        go("look");
        void loadLooks();
      },
    });
    parts.push(footer(next, () => go("style")));
    return parts;
  }

  function lookStep(): HTMLElement[] {
    const parts = [
      stepLine(),
      ...headline("Pick a look (optional)", "A look saved on this lamp for that effect: its colours and settings."),
    ];
    const list = document.createElement("div");
    list.className = "pw-list";
    list.append(
      tile({
        name: "Effect defaults",
        hint: "The effect as it was written.",
        pressed: !choice.label,
        onClick: () => {
          delete choice.label;
          delete choice.uniforms;
          render();
        },
      }),
    );
    if (looks === null) {
      const p = document.createElement("div");
      p.className = "pw-empty";
      p.textContent = "Looking for saved looks on the lamp…";
      list.append(p);
    } else if (looks.length === 0) {
      const p = document.createElement("div");
      p.className = "pw-empty";
      p.textContent = "No saved looks for this effect on the lamp. Save one from Show mode or the effect editor.";
      list.append(p);
    } else {
      for (const name of looks) {
        list.append(
          tile({
            name,
            hint: "Saved look",
            pressed: choice.label === name,
            onClick: () => void pickLook(name),
          }),
        );
      }
    }
    parts.push(list);
    parts.push(
      footer(Button({ label: "Next", variant: "primary", disabled: busy, onClick: () => go("duration") }), () =>
        go("effect"),
      ),
    );
    return parts;
  }

  function durationStep(): HTMLElement[] {
    const parts = [stepLine(), ...headline("How long?", dir === "on" ? "From dark to the show." : "From the show to dark.")];
    const card = document.createElement("div");
    card.className = "pw-summary";
    const slider = Slider({
      label: "Duration",
      min: MIN_DURATION_MS,
      max: SLIDER_MAX_MS,
      step: 100,
      value: Math.min(SLIDER_MAX_MS, choice.durationMs),
      format: (v) => formatSeconds(v),
      onInput: (v) => (choice.durationMs = v),
    });
    const what = document.createElement("div");
    what.className = "pw-summary-val";
    what.textContent =
      choice.style === POWER_STYLE_EFFECT && choice.effectId
        ? `${effectDisplayName(choice.effectId, nameOf)}${choice.label ? ` (${choice.label})` : ""}`
        : "Fade";
    card.append(what, slider.el);
    parts.push(card);
    parts.push(
      footer(Button({ label: busy ? "Saving…" : "Save", variant: "primary", disabled: busy, onClick: () => void save() }), () =>
        go(choice.style === POWER_STYLE_EFFECT ? "look" : "style"),
      ),
    );
    return parts;
  }

  // -- actions --------------------------------------------------------------

  function go(s: Step): void {
    step = s;
    render();
    el.scrollIntoView?.({ block: "start" });
  }

  function begin(d: Direction): void {
    dir = d;
    choice = choiceFromState(state, d);
    go("style");
  }

  async function loadLooks(): Promise<void> {
    const c = client();
    const id = choice.effectId;
    if (!c || !id) {
      looks = [];
      render();
      return;
    }
    try {
      const r = await c.listKeypoints(0, id);
      looks = (r.keypoints ?? []).filter((k) => !k.stale).map((k) => k.name);
    } catch {
      looks = [];
    }
    if (step === "look") render();
  }

  async function pickLook(name: string): Promise<void> {
    const c = client();
    const cnd = candidates().find((x) => x.id === choice.effectId);
    if (!c || !cnd) return;
    busy = true;
    render();
    try {
      const [kp, compiled] = await Promise.all([c.getKeypoint(name, 0, cnd.id), compiler.compile(cnd.source)]);
      const uniforms: UniformValueFlat[] | null = compiled.ok ? keypointToUniforms(kp.values ?? [], compiled.uniforms) : null;
      if (!uniforms) {
        toast(compiled.ok ? `"${name}" sets too many values for a transition` : "The effect doesn't compile", {
          error: true,
        });
      } else {
        choice.label = name;
        choice.uniforms = uniforms;
      }
    } catch (e) {
      toast(`Couldn't read "${name}": ${e instanceof Error ? e.message : String(e)}`, { error: true });
    } finally {
      busy = false;
      render();
    }
  }

  async function save(): Promise<void> {
    const c = client();
    if (!c) {
      toast("Connect the lamp first", { error: true });
      return;
    }
    busy = true;
    render();
    try {
      if (choice.style === POWER_STYLE_EFFECT) {
        const cnd = candidates().find((x) => x.id === choice.effectId);
        if (!cnd) throw new Error("pick an effect first");
        const r = await compiler.compile(cnd.source);
        if (!r.ok) throw new Error(`"${cnd.name}" has compile errors`);
        await c.storeTransitionEffect(slotFor(dir), cnd.id, r.bytecode);
      }
      const t = transitionMessage(choice);
      state = await c.setPowerConfig(dir === "on" ? { onTransition: t } : { offTransition: t });
      toast(`Saved how the lamp turns ${dir}`);
      step = "overview";
    } catch (e) {
      toast(`Couldn't save: ${e instanceof Error ? e.message : String(e)}`, { error: true });
    } finally {
      busy = false;
      render();
    }
  }

  async function saveBoot(boot: number): Promise<void> {
    const c = client();
    if (!c) return;
    busy = true;
    render();
    try {
      state = await c.setPowerConfig({ boot });
      toast("Saved");
    } catch {
      toast("Couldn't save the power-up behaviour", { error: true });
    } finally {
      busy = false;
      render();
    }
  }

  async function tryIt(): Promise<void> {
    const c = client();
    if (!c) return;
    try {
      state = await c.setPower({ toggle: true });
      render();
    } catch {
      toast("Couldn't reach the lamp", { error: true });
    }
  }

  function render(): void {
    let parts: HTMLElement[];
    if (step === "style") parts = styleStep();
    else if (step === "effect") parts = effectStep();
    else if (step === "look") parts = lookStep();
    else if (step === "duration") parts = durationStep();
    else parts = overview();
    el.replaceChildren(...parts);
  }

  render();

  return {
    el,
    onMount: () => {
      compiler.warm();
      void effectStore.list({ sort: "name" }).then((l) => {
        library = l;
        if (step === "effect") render();
      });
      // (Re)bind to whichever client is connected: a deep link mounts before the
      // connection is up, and a reconnect brings a new session. getPower() both
      // hydrates and subscribes this session to the device's power_state pushes.
      const bind = (): void => {
        const c = client();
        if (c === bound) return;
        unsub?.();
        unsub = null;
        bound = c;
        if (!c || !deviceHasPower(c.welcome)) {
          render();
          return;
        }
        unsub = c.onPowerState((s) => {
          if (state && s.seq < state.seq && s.seq !== 0) return;
          state = s;
          if (step === "overview") render();
        });
        void c
          .getPower()
          .then((s) => {
            state = s;
            render();
          })
          .catch(() => toast("Couldn't read the lamp's power settings", { error: true }));
      };
      unsubApp = appState.subscribe(bind);
      bind();
    },
    onUnmount: () => {
      unsub?.();
      unsubApp?.();
      tiles.dispose();
      compiler.dispose();
    },
  };
}

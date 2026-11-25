/**
 * Kit onboarding (route /kit/:id, e.g. #/kit/coil?v=1 from the QR code in the
 * kit's booklet): connect the shipped lamp, then apply its known config, one
 * step per screen:
 *   welcome -> connect -> touch sensor -> transitions -> tap test -> done.
 * Kit definitions live in kits/kits.ts. The compiler is injected (deps) like
 * the Sensors page; the default is the app's worker compiler.
 */

import { Button, toast } from "../kit";
import type { Router, Screen } from "../app/router";
import { appState } from "../app/state";
import { bleAvailable } from "../../net/improv";
import { openAddDevice } from "./addDevice";
import { kitById, type KitDef } from "../../kits/kits";
import type { PowerState } from "../../net/proto";
import { CountWatch, deviceHasPower } from "../../power/power";
import { setUpTouch, type DriverCompile } from "../../power/touchDriver";
import { describeTouch } from "../../power/sensorAgent";
import { workerDriverCompile } from "./driverCompile";
import { checkList } from "./sensors";
import { installPowerStyles } from "./power.css";

export type KitStep = "welcome" | "connect" | "touch" | "transitions" | "test" | "done";
export const KIT_STEPS: KitStep[] = ["welcome", "connect", "touch", "transitions", "test", "done"];

export function KitOnboardingScreen(router: Router, id: string | undefined, deps: { compile?: DriverCompile } = {}): Screen {
  installPowerStyles();
  const el = document.createElement("div");
  el.className = "screen screen--pw";
  const kit = kitById(id);
  let step: KitStep = "welcome";
  let busy = false;
  let power: PowerState | null = null;
  let testOk = false;
  const watch = new CountWatch();
  let compile: DriverCompile | null = deps.compile ?? null;
  let disposeCompile: (() => void) | null = null;
  let unsubPower: (() => void) | null = null;

  const client = () => {
    const c = appState.client;
    return c?.isConnected ? c : null;
  };

  function h(text: string, sub: string): HTMLElement[] {
    const a = document.createElement("h1");
    a.className = "screen-headline";
    a.textContent = text;
    const b = document.createElement("p");
    b.className = "screen-sub";
    b.textContent = sub;
    return [a, b];
  }
  function progress(): HTMLElement {
    const p = document.createElement("div");
    p.className = "pw-steps";
    const i = KIT_STEPS.indexOf(step);
    p.textContent = `${kit?.name ?? "Kit"} setup · step ${i + 1} of ${KIT_STEPS.length}`;
    return p;
  }
  function footer(primary: HTMLButtonElement, back?: KitStep, extra?: HTMLButtonElement): HTMLElement {
    const f = document.createElement("div");
    f.className = "pw-footer";
    if (back) f.append(Button({ label: "Back", variant: "quiet", onClick: () => go(back) }));
    if (extra) f.append(extra);
    f.append(primary);
    return f;
  }
  function go(s: KitStep): void {
    step = s;
    render();
  }

  function subscribePower(): void {
    const c = client();
    if (!c || unsubPower) return;
    unsubPower = c.onPowerState((s) => {
      power = s;
      if (watch.bumped(s.triggerCount)) {
        testOk = true;
        if (step === "test") render();
      }
    });
    void c
      .getPower()
      .then((s) => {
        power = s;
        watch.bumped(s.triggerCount);
      })
      .catch(() => undefined);
  }

  function welcome(k: KitDef): HTMLElement[] {
    const list = document.createElement("div");
    list.className = "pw-summary";
    for (const line of [
      "Plug the lamp in and keep this phone close to it.",
      "We'll connect it to your Wi-Fi, set up the touch-sensitive lid and its fade in and out.",
      "It takes about two minutes.",
    ]) {
      const d = document.createElement("div");
      d.className = "pw-summary-val";
      d.textContent = line;
      list.append(d);
    }
    return [progress(), ...h(`Welcome to your ${k.name}`, k.blurb), list, footer(Button({ label: "Start", variant: "primary", onClick: () => go("connect") }))];
  }

  function connect(): HTMLElement[] {
    const c = client();
    const ok = c !== null && deviceHasPower(c.welcome);
    const card = document.createElement("div");
    card.className = "pw-summary";
    const st = document.createElement("div");
    st.className = "pw-summary-title";
    st.textContent = ok
      ? `Connected to ${c?.welcome?.deviceName || "the lamp"}`
      : c
        ? "Connected, but this lamp's firmware needs an update first (device sheet → Update)."
        : appState.status.state === "connecting"
          ? "Connecting…"
          : "Not connected yet";
    card.append(st);
    const methods = document.createElement("div");
    methods.className = "pw-actions";
    if (!ok) {
      if (bleAvailable()) {
        methods.append(Button({ label: "Connect over Bluetooth", variant: "quiet", onClick: () => openAddDevice("ble") }));
      }
      methods.append(Button({ label: "Enter its address", variant: "quiet", onClick: () => openAddDevice("manual") }));
      card.append(methods);
    }
    return [
      progress(),
      ...h("Connect the lamp", "Pick your Wi-Fi network, then choose the lamp in the list."),
      card,
      footer(
        Button({
          label: "Next",
          variant: "primary",
          disabled: !ok,
          onClick: () => {
            subscribePower();
            go("touch");
          },
        }),
        "welcome",
      ),
    ];
  }

  async function applyTouch(k: KitDef): Promise<void> {
    const c = client();
    if (!c) return toast("The lamp disconnected: go back a step", { error: true });
    busy = true;
    render();
    try {
      if (!compile) {
        const w = workerDriverCompile();
        compile = w.compile;
        disposeCompile = w.dispose;
      }
      await setUpTouch(c, compile, k.touch);
      go("transitions");
    } catch (e) {
      toast(`Couldn't set up the lid sensor: ${e instanceof Error ? e.message : String(e)}`, { error: true });
    } finally {
      busy = false;
      render();
    }
  }

  function touch(k: KitDef): HTMLElement[] {
    const card = document.createElement("div");
    card.className = "pw-summary";
    const d = document.createElement("div");
    d.className = "pw-summary-val";
    d.textContent = `Your lamp's lid has a touch pad wired in at the factory (${describeTouch(k.touch)}).`;
    card.append(d);
    const wait = document.createElement("div");
    wait.className = "pw-tile-hint";
    wait.textContent = "Built it yourself? Check the board's pads below. Either way: don't touch the lid for about 1 s after the lamp powers up.";
    card.append(wait, checkList());
    return [
      progress(),
      ...h("Turn on the touch lid", "A tap on the top of the lamp will switch it on and off."),
      card,
      footer(
        Button({ label: busy ? "Setting up…" : "Set up the lid", variant: "primary", disabled: busy, onClick: () => void applyTouch(k) }),
        "connect",
      ),
    ];
  }

  async function applyTransitions(k: KitDef): Promise<void> {
    const c = client();
    if (!c) return toast("The lamp disconnected: go back a step", { error: true });
    busy = true;
    render();
    try {
      power = await c.setPowerConfig({ onTransition: k.onTransition, offTransition: k.offTransition });
      go("test");
    } catch {
      toast("Couldn't save the fades", { error: true });
    } finally {
      busy = false;
      render();
    }
  }

  function transitions(k: KitDef): HTMLElement[] {
    const card = document.createElement("div");
    card.className = "pw-summary";
    for (const [t, ms] of [
      ["Turning on: fades in", k.onTransition.durationMs],
      ["Turning off: fades out", k.offTransition.durationMs],
    ] as const) {
      const d = document.createElement("div");
      d.className = "pw-summary-val";
      d.textContent = `${t} over ${(ms / 1000).toFixed(1)} s`;
      card.append(d);
    }
    const more = document.createElement("div");
    more.className = "pw-tile-hint";
    more.textContent = "You can pick other transitions later: device sheet → On / off transitions.";
    card.append(more);
    return [
      progress(),
      ...h("Fade in and out", "How the lamp lights up and goes dark."),
      card,
      footer(
        Button({ label: busy ? "Saving…" : "Use these fades", variant: "primary", disabled: busy, onClick: () => void applyTransitions(k) }),
        "touch",
      ),
    ];
  }

  function test(k: KitDef): HTMLElement[] {
    const flash = document.createElement("div");
    flash.className = "sn-flash";
    flash.dataset["on"] = String(testOk);
    flash.textContent = testOk ? `Tap detected · the lamp is ${power?.on ? "on" : "off"}` : "Waiting for a tap…";
    const card = document.createElement("div");
    card.className = "pw-summary";
    const d = document.createElement("div");
    d.className = "pw-summary-val";
    d.textContent = k.tapHint;
    card.append(flash, d);
    if (!testOk) {
      const help = document.createElement("div");
      help.className = "pw-tile-hint";
      help.textContent =
        "Nothing? Tap the centre of the lid with a fingertip and hold it for a moment. Still nothing: the Sensors page can test the sensor live.";
      card.append(help);
    }
    return [
      progress(),
      ...h("Tap the lid to test", "Watch the lamp and this screen."),
      card,
      footer(
        Button({ label: testOk ? "It works" : "Skip the test", variant: testOk ? "primary" : "quiet", onClick: () => go("done") }),
        "transitions",
        testOk ? undefined : Button({ label: "Open Sensors", variant: "quiet", onClick: () => (location.hash = "#/sensors") }),
      ),
    ];
  }

  function done(k: KitDef): HTMLElement[] {
    return [
      progress(),
      ...h(`Your ${k.name} is ready`, "Tap the lid to turn it on and off. Pick a new look in Effects."),
      footer(Button({ label: "Go to effects", variant: "primary", onClick: () => router.navigate("/effects") })),
    ];
  }

  function render(): void {
    if (!kit) {
      el.replaceChildren(
        ...h("Unknown kit", "This link doesn't match a Splanc kit. Check the QR code, or set up your lamp from the start."),
        footer(Button({ label: "Set up a device", variant: "primary", onClick: () => router.navigate("/") })),
      );
      return;
    }
    const parts =
      step === "connect"
        ? connect()
        : step === "touch"
          ? touch(kit)
          : step === "transitions"
            ? transitions(kit)
            : step === "test"
              ? test(kit)
              : step === "done"
                ? done(kit)
                : welcome(kit);
    el.replaceChildren(...parts);
  }

  render();
  const unsubApp = appState.subscribe(() => {
    if (step === "connect") render();
  });
  return {
    el,
    onUnmount: () => {
      unsubApp();
      unsubPower?.();
      disposeCompile?.();
    },
  };
}

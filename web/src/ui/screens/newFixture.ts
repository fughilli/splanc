/**
 * New-fixture setup (D-259, `#/new-fixture`): opened automatically the first time
 * the app connects to a fixture that has no stored map (app/newFixtureWatch.ts),
 * so a brand-new fixture is named and wired right before the first effect:
 *
 *   1. Name      — shown in the app and as its Bluetooth name.
 *   2. LEDs      — how many LEDs each output drives. The strip lights dim white up
 *                  to the count, with the last LED green: right when the green LED
 *                  is the strip's last.
 *   3. Colours   — one screen per output with LEDs: three runs light at the strip
 *                  start; the user taps the row of dots that matches what they see,
 *                  previews it, and confirms.
 *   4. Done      — Choose an effect.
 *
 * One step per screen with one primary action (owner rule). The probes run on the
 * counting pattern (hardware/setupProbe.ts) and never touch the committed config;
 * each answer is committed with a one-field set_hardware_config nudge, so other
 * settings (GPIOs, sensors — #602) are left as they are. "Skip setup" is always
 * there; the flow is offered once per device either way.
 */

import { Button, toast } from "../kit";
import type { Router, Screen } from "../app/router";
import { appState } from "../app/state";
import { deviceStore } from "../../store/deviceStore";
import { normalizeFixtureName, setupSeen, setupSteps, type SetupStep } from "../../store/newFixture";
import { clampLedCount, countProbeBlocks, orderProbeBlocks } from "../../hardware/setupProbe";
import { COLOR_ORDERS, type ColorOrder, type HardwareChannel } from "../../net/proto";
import { installNewFixtureStyles } from "./newFixture.css";

const DOT_HEX: Record<string, string> = { R: "#ff4d4d", G: "#3ccf5a", B: "#4d7cff" };
/** A fresh strip's starting guess when the device reports no count. */
const DEFAULT_COUNT = 60;
/** Strip outputs (network outputs are "ddp" and have no strip to probe). */
const isStrip = (c: HardwareChannel): boolean => c.ledType !== "ddp";

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function NewFixtureScreen(router: Router): Screen {
  installNewFixtureStyles();
  const el = document.createElement("div");
  el.className = "screen nf";

  const devId = deviceStore.activeId();
  if (devId) setupSeen.mark(devId); // offered once per device, finished or not

  let channels: HardwareChannel[] = [];
  let maxPerChannel = 0;
  const counts = new Map<number, number>();
  let stepIndex = 0;
  let probing: number | null = null; // the output the probe is on
  let pickedOrder: ColorOrder | null = null;
  let busy = false;
  let disposed = false;

  const client = () => (appState.client?.isConnected ? appState.client : null);

  function steps(): { step: SetupStep; port: number }[] {
    const used = channels.filter((c) => isStrip(c) && (counts.get(c.channel) ?? 0) > 0).map((c) => c.channel);
    return setupSteps(used);
  }

  async function probe(ch: number, blocks: ReturnType<typeof countProbeBlocks>, order: ColorOrder = "RGB"): Promise<void> {
    const c = client();
    if (!c) return;
    if (probing !== null && probing !== ch) await c.setCountingPattern([], probing).catch(() => undefined);
    probing = ch;
    await c.setCountingPattern(blocks, ch, order).catch(() => undefined);
  }

  async function stopProbe(): Promise<void> {
    const c = client();
    const ch = probing;
    probing = null;
    if (c && ch !== null) await c.setCountingPattern([], ch).catch(() => undefined);
  }

  function leave(to: string): void {
    void stopProbe();
    router.navigate(to);
  }

  // -- chrome shared by every step --------------------------------------------

  function frame(title: string, lead: string, body: Node[], actions: HTMLElement[]): void {
    const all = steps();
    const k = Math.min(stepIndex, all.length - 1);
    const prog = document.createElement("div");
    prog.className = "nf-progress";
    const pt = document.createElement("div");
    pt.className = "nf-progress-text";
    pt.textContent = `Step ${k + 1} of ${all.length}`;
    const bar = document.createElement("div");
    bar.className = "nf-progress-bar";
    for (let i = 0; i < all.length; i++) {
      const seg = document.createElement("i");
      if (i <= k) seg.className = "on";
      bar.append(seg);
    }
    prog.append(pt, bar);
    const h = document.createElement("h2");
    h.className = "nf-title";
    h.textContent = title;
    const p = document.createElement("p");
    p.className = "nf-lead";
    p.textContent = lead;
    const err = document.createElement("div");
    err.className = "nf-err";
    err.setAttribute("role", "alert");
    const row = document.createElement("div");
    row.className = "nf-actions";
    row.append(...actions);
    el.replaceChildren(prog, h, p, ...body, err, row);
  }

  function showError(text: string): void {
    const e = el.querySelector(".nf-err");
    if (e) e.textContent = text;
  }

  function next(): void {
    stepIndex++;
    pickedOrder = null;
    render();
  }

  const skip = (): HTMLElement =>
    Button({ label: "Skip setup", variant: "quiet", onClick: () => leave("/effects") });

  // -- steps ------------------------------------------------------------------

  function renderName(): void {
    const w = appState.client?.welcome;
    const input = document.createElement("input");
    input.id = "nf-name";
    input.value = deviceStore.active()?.label || w?.deviceName || "";
    input.placeholder = "e.g. Desk lamp";
    input.maxLength = 32;
    input.autocomplete = "off";
    const label = document.createElement("label");
    label.htmlFor = "nf-name";
    label.textContent = "Fixture name";
    const field = document.createElement("div");
    field.className = "nf-field";
    field.append(label, input);
    const go = Button({
      label: "Next",
      onClick: () => {
        void (async () => {
          const name = normalizeFixtureName(input.value);
          const c = client();
          if (name && c && devId && name !== c.welcome?.deviceName) {
            busy = true;
            go.disabled = true;
            deviceStore.rename(devId, name);
            try {
              const nw = await c.setDeviceName(name);
              deviceStore.applyWelcome(devId, { mac: nw.mac, deviceName: nw.deviceName });
              deviceStore.takePending(devId);
            } catch {
              // queued: deviceStore applies it on the next connection
            } finally {
              busy = false;
            }
          }
          next();
        })();
      },
    });
    frame(
      "Name your fixture",
      "The name shows in the app and when your phone looks for it over Bluetooth.",
      [field],
      [go, skip()],
    );
    input.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") go.click();
    });
  }

  function renderLeds(): void {
    const strips = channels.filter(isStrip);
    const list = document.createElement("div");
    list.className = "nf-ports";
    const cards = new Map<number, HTMLElement>();
    const markLive = (ch: number): void => {
      for (const [k, card] of cards) card.classList.toggle("nf-port--live", k === ch);
    };
    for (const c of strips) {
      if (!counts.has(c.channel)) counts.set(c.channel, c.ledCount > 0 ? c.ledCount : c.channel === 0 ? DEFAULT_COUNT : 0);
      const card = document.createElement("div");
      card.className = "nf-port";
      const head = document.createElement("div");
      head.className = "nf-port-head";
      const name = document.createElement("div");
      name.className = "nf-port-name";
      name.textContent = strips.length > 1 ? `Output ${c.channel + 1}` : "LED strip";
      const hint = document.createElement("div");
      hint.className = "nf-port-hint";
      hint.textContent =
        c.gpio >= 0 ? `GPIO ${c.gpio}. Set 0 if nothing is plugged in here.` : "Set 0 if nothing is plugged in here.";
      head.append(name, hint);
      const input = document.createElement("input");
      input.type = "number";
      input.inputMode = "numeric";
      input.min = "0";
      if (maxPerChannel > 0) input.max = String(maxPerChannel);
      input.value = String(counts.get(c.channel) ?? 0);
      input.setAttribute("aria-label", `${name.textContent}: number of LEDs`);
      const apply = (n: number): void => {
        const v = clampLedCount(n, maxPerChannel);
        counts.set(c.channel, v);
        input.value = String(v);
        markLive(c.channel);
        if (v > 0) void probe(c.channel, countProbeBlocks(v));
        else void stopProbe();
      };
      input.addEventListener("change", () => apply(Number(input.value)));
      input.addEventListener("focus", () => apply(Number(input.value)));
      const minus = Button({ label: "−", variant: "quiet", onClick: () => apply((counts.get(c.channel) ?? 0) - 1) });
      minus.setAttribute("aria-label", "One LED fewer");
      const plus = Button({ label: "+", variant: "quiet", onClick: () => apply((counts.get(c.channel) ?? 0) + 1) });
      plus.setAttribute("aria-label", "One LED more");
      const stepper = document.createElement("div");
      stepper.className = "nf-stepper";
      stepper.append(minus, input, plus);
      card.append(head, stepper);
      cards.set(c.channel, card);
      list.append(card);
    }
    const note = document.createElement("p");
    note.className = "nf-note";
    note.textContent =
      maxPerChannel > 0 ? `This fixture drives up to ${maxPerChannel} LEDs per output.` : "";
    const go = Button({
      label: "Next",
      onClick: () => {
        void (async () => {
          const c = client();
          if (!c) {
            showError("The fixture disconnected. Reconnect it, then try again.");
            return;
          }
          if (![...counts.values()].some((n) => n > 0)) {
            showError("Set how many LEDs at least one output has.");
            return;
          }
          go.disabled = true;
          busy = true;
          let reboot = false;
          try {
            for (const ch of strips) {
              const n = counts.get(ch.channel) ?? 0;
              if (n === ch.ledCount) continue;
              const st = await c.setHardwareConfig({ channel: ch.channel, ledCount: n, commit: true });
              channels = st.channels.map((x) => ({ ...x }));
              reboot ||= st.rebootRequired === true;
            }
          } catch (e) {
            busy = false;
            go.disabled = false;
            showError(`Couldn't save the LED count: ${msg(e)}`);
            return;
          }
          busy = false;
          await stopProbe();
          if (reboot) toast("The fixture is restarting to make room for the LEDs. It reconnects in a few seconds.");
          next();
        })();
      },
    });
    frame(
      "How many LEDs?",
      "Change the number until the green LED is the last one on the strip. Everything before it glows dim white.",
      [list, note],
      [go, skip()],
    );
    const first = strips.find((s) => (counts.get(s.channel) ?? 0) > 0);
    if (first) {
      markLive(first.channel);
      void probe(first.channel, countProbeBlocks(counts.get(first.channel)!));
    }
  }

  function renderOrder(port: number): void {
    const label = channels.filter(isStrip).length > 1 ? `output ${port + 1}` : "the strip";
    if (pickedOrder === null) {
      void probe(port, orderProbeBlocks(), "RGB");
      const list = document.createElement("div");
      list.className = "nf-orders";
      for (const order of COLOR_ORDERS) {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "nf-order";
        b.setAttribute("aria-label", `Pick ${order}`);
        b.append(dots(order));
        const name = document.createElement("span");
        name.className = "nf-order-name";
        name.textContent = order;
        b.append(name);
        b.addEventListener("click", () => {
          pickedOrder = order;
          void probe(port, orderProbeBlocks(), order);
          render();
        });
        list.append(b);
      }
      frame(
        "Check the colours",
        `The first LEDs of ${label} show three colours. Tap the row that matches them, starting from the beginning of the strip.`,
        [list],
        [skip()],
      );
      return;
    }
    const order = pickedOrder;
    const yes = Button({
      label: "Yes, red, green, blue",
      onClick: () => {
        void (async () => {
          const c = client();
          if (!c) {
            showError("The fixture disconnected. Reconnect it, then try again.");
            return;
          }
          yes.disabled = true;
          try {
            const st = await c.setHardwareConfig({ channel: port, colorOrder: order, commit: true });
            channels = st.channels.map((x) => ({ ...x }));
          } catch (e) {
            yes.disabled = false;
            showError(`Couldn't save the colour order: ${msg(e)}`);
            return;
          }
          await stopProbe();
          next();
        })();
      },
    });
    const again = Button({
      label: "No, pick again",
      variant: "quiet",
      onClick: () => {
        pickedOrder = null;
        render();
      },
    });
    frame(
      "Do they read red, green, blue now?",
      "The same LEDs should now show red, then green, then blue.",
      [dots("RGB")],
      [yes, again],
    );
  }

  function renderDone(): void {
    const go = Button({ label: "Choose an effect", onClick: () => leave("/effects") });
    const map = Button({ label: "Map it in 3D", variant: "quiet", onClick: () => leave("/maps") });
    frame(
      "All set",
      "The name, LED count and colours are saved on the fixture. Pick an effect to light it up. Mapping it in 3D is optional, for effects that follow its shape.",
      [],
      [go, map],
    );
  }

  function renderWaiting(text: string): void {
    const p = document.createElement("p");
    p.className = "nf-lead";
    p.textContent = text;
    el.replaceChildren(p, skip());
  }

  function render(): void {
    if (disposed || busy) return;
    if (!client()) {
      renderWaiting("Waiting for the fixture to connect…");
      return;
    }
    if (channels.length === 0) {
      renderWaiting("Reading the fixture's outputs…");
      return;
    }
    const all = steps();
    const cur = all[Math.min(stepIndex, all.length - 1)]!;
    if (cur.step === "name") renderName();
    else if (cur.step === "leds") renderLeds();
    else if (cur.step === "order") renderOrder(cur.port);
    else renderDone();
  }

  let loadedFor: unknown = null;
  async function load(): Promise<void> {
    const c = client();
    if (!c || loadedFor === c) return;
    loadedFor = c;
    try {
      const st = await c.getHardwareConfig();
      channels = st.channels.map((x) => ({ ...x }));
      maxPerChannel = st.board?.maxLedsPerChannel || st.board?.maxLeds || 0;
      if (!channels.some(isStrip)) channels = [{ channel: 0, gpio: -1, ledType: "ws2812", colorOrder: "GRB", ledCount: 0 }];
    } catch {
      // Old firmware without get_hardware_config: one output, nothing known.
      channels = [{ channel: 0, gpio: -1, ledType: "ws2812", colorOrder: "GRB", ledCount: 0 }];
    }
    render();
  }

  const unsub = appState.subscribe(() => {
    if (disposed) return;
    if (client() && loadedFor !== appState.client) void load();
    else if (!client()) render();
  });

  return {
    el,
    onMount: () => {
      render();
      void load();
    },
    onUnmount: () => {
      disposed = true;
      unsub();
      void stopProbe();
    },
  };
}

function dots(order: string): HTMLElement {
  const wrap = document.createElement("span");
  wrap.className = "nf-dots";
  for (const ch of order) {
    const d = document.createElement("span");
    d.className = "nf-dot";
    d.style.background = DOT_HEX[ch] ?? "#888";
    wrap.append(d);
  }
  return wrap;
}

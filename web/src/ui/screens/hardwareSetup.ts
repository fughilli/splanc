/**
 * Hardware Setup (FUG-123). A per-device surface for the LED strip's HARDWARE
 * wiring: which GPIO drives each output channel, the LED chip family (WS281x
 * today), and the wire color order (RGB / GRB / …).
 *
 * Color order is the tricky one — you can't read a strip's wiring, you have to
 * SEE it. The "check color order" flow forces the channel to identity RGB (so
 * the raw wire bytes reach the strip) and paints three bands: intent red, green,
 * blue. Whatever the strip physically shows is a permutation of those; the user
 * taps the swatch (of the six) whose dots match what they see, and that
 * permutation IS the wire order. Committing it makes the same on-device pattern
 * snap to a correct R/G/B — instant confirmation.
 *
 * The config round-trips through set_hardware_config; the device persists it to
 * NVS and replies hardware_config_state, and get_hardware_config hydrates this
 * page on open.
 */

import { Button, Card, toast } from "../kit";
import type { Router, Screen } from "../app/router";
import { appState } from "../app/state";
import { deviceStore } from "../../store/deviceStore";
import { COLOR_ORDERS, type ColorOrder, type HardwareChannel } from "../../net/proto";
import type { ColorBlock } from "@ledmapper/protocol";
import { installHardwareSetupStyles } from "./hardwareSetup.css";

// Curated output-capable C6 GPIOs for LED data (see firmware led_config.h): not
// strapping (4/5/8/9/15), not USB-JTAG (12/13), not SPI-flash. The device also
// range-checks; the currently-configured pin is always added so hydration has a
// matching option even if it's off this list.
const SAFE_GPIOS = [0, 1, 2, 3, 6, 7, 10, 11, 14, 20, 21, 22, 23];

// Per-logical-channel dot colors for the color-order swatches (matches the
// color-correction screen's channel palette).
const COLOR_HEX: Record<string, string> = { R: "#ff5d5d", G: "#57d16a", B: "#5d8bff" };

const LED_TYPES: Array<{ value: string; label: string }> = [
  { value: "ws281x", label: "WS281x (WS2811/2812/2812B/SK6812)" },
];

export function HardwareSetupScreen(_router: Router): Screen {
  installHardwareSetupStyles();

  const deviceId = deviceStore.activeId();
  const dev = deviceId ? deviceStore.get(deviceId) : null;

  // Local mirror of the device's per-channel config, hydrated from
  // get_hardware_config on mount and updated as the user edits (each edit
  // round-trips a fresh hardware_config_state).
  let channels: HardwareChannel[] = [];
  // Which channel's color-order test is currently painting the strip (null = none).
  let activeTest: number | null = null;

  const el = document.createElement("div");
  el.className = "screen screen--hw";

  const head = document.createElement("h1");
  head.className = "screen-headline";
  head.textContent = "Hardware Setup";
  const sub = document.createElement("p");
  sub.className = "screen-sub";
  sub.textContent = dev
    ? `LED wiring for ${dev.label}. Saved on the device.`
    : "LED wiring for the strip. Connect a device to configure.";
  el.append(head, sub);

  const body = document.createElement("div");
  el.append(body);

  // -- device round-trips ---------------------------------------------------

  function connectedClient(): NonNullable<typeof appState.client> | null {
    const c = appState.client;
    if (!c?.isConnected) {
      toast("Connect a device first", { error: true });
      return null;
    }
    return c;
  }

  /** Three equal R/G/B bands across the strip, for the color-order check. */
  function testBlocks(): ColorBlock[] {
    const ledCount = appState.client?.welcome?.codeParams.ledCount ?? 30;
    const seg = Math.max(1, Math.floor(ledCount / 3));
    return [
      { start: 0, count: seg, rgb: [1, 0, 0] },
      { start: seg, count: seg, rgb: [0, 1, 0] },
      { start: 2 * seg, count: seg, rgb: [0, 0, 1] },
    ];
  }

  /** Pull the device's current per-channel config into `channels` + repaint. */
  async function hydrate(): Promise<void> {
    const c = appState.client;
    if (!c?.isConnected) return;
    try {
      const st = await c.getHardwareConfig();
      channels = st.channels.map((x) => ({ ...x }));
      render();
    } catch {
      /* leave the empty-state note up */
    }
  }

  async function setGpio(ch: number, gpio: number): Promise<void> {
    const c = connectedClient();
    if (!c) return;
    try {
      const st = await c.setHardwareConfig({ channel: ch, gpio, commit: true });
      channels = st.channels.map((x) => ({ ...x }));
      render();
      toast(`Channel ${ch} → GPIO ${gpio}`);
    } catch {
      toast("Failed to set GPIO", { error: true });
    }
  }

  async function startTest(ch: number): Promise<void> {
    const c = connectedClient();
    if (!c) return;
    try {
      // Force identity so the raw wire bytes (255,0,0)/(0,255,0)/(0,0,255) reach
      // the strip unpermuted — commit:false keeps it out of flash.
      await c.setHardwareConfig({ channel: ch, colorOrder: "RGB", commit: false });
      await c.setCountingPattern(testBlocks(), ch);
      activeTest = ch;
      render();
    } catch {
      toast("Couldn't start the color test", { error: true });
    }
  }

  async function pickOrder(ch: number, order: ColorOrder): Promise<void> {
    const c = connectedClient();
    if (!c) return;
    try {
      const st = await c.setHardwareConfig({ channel: ch, colorOrder: order, commit: true });
      channels = st.channels.map((x) => ({ ...x }));
      // Repaint: the same on-device bands now reorder through the chosen wire
      // order, so the strip should snap to a correct red / green / blue.
      await c.setCountingPattern(testBlocks(), ch);
      render();
      toast(`Color order set to ${order}`);
    } catch {
      toast("Failed to set color order", { error: true });
    }
  }

  async function stopTest(ch: number): Promise<void> {
    activeTest = null;
    const c = appState.client;
    if (c?.isConnected) {
      try {
        await c.setCountingPattern([], ch); // clear the strip
        // Re-assert the committed order from RAM (undoes the identity override if
        // the user backed out without picking).
        const cur = channels.find((x) => x.channel === ch);
        if (cur) await c.setHardwareConfig({ channel: ch, colorOrder: cur.colorOrder, commit: false });
      } catch {
        /* best-effort cleanup */
      }
    }
    render();
  }

  // -- rendering ------------------------------------------------------------

  function render(): void {
    if (channels.length === 0) {
      const note = document.createElement("div");
      note.className = "hw-hint";
      note.textContent = appState.client?.isConnected
        ? "This device's firmware doesn't report hardware config. Update it to configure GPIO and color order."
        : "Connect a device to configure its LED GPIO, type, and color order.";
      body.replaceChildren(note);
      return;
    }
    body.replaceChildren(...channels.map(channelCard));
  }

  function channelCard(cfg: HardwareChannel): HTMLElement {
    const g = group(`Channel ${cfg.channel}`);

    g.append(
      row(
        "Data GPIO",
        "Which pin drives this channel's WS281x data line.",
        select(gpioOptions(cfg.gpio), String(cfg.gpio), (v) => void setGpio(cfg.channel, Number(v))),
      ),
      row(
        "LED type",
        "The LED chip family. Only WS281x is supported today.",
        select(
          LED_TYPES.map((t) => ({ value: t.value, label: t.label })),
          "ws281x",
          () => undefined,
          true,
        ),
      ),
    );

    // Color order: current value + the test/confirm flow.
    const orderRow = document.createElement("div");
    orderRow.className = "hw-row";
    const label = document.createElement("div");
    const name = document.createElement("div");
    name.className = "hw-row-name";
    name.textContent = "Color order";
    const hint = document.createElement("div");
    hint.className = "hw-row-hint";
    hint.textContent = "The wire byte order the strip expects.";
    label.append(name, hint);
    const cur = document.createElement("div");
    cur.className = "hw-order-current";
    cur.append(orderDots(cfg.colorOrder), document.createTextNode(cfg.colorOrder));
    const ctl = document.createElement("div");
    ctl.className = "hw-row-ctl";
    ctl.append(cur);
    orderRow.append(label, ctl);
    g.append(orderRow);

    if (activeTest === cfg.channel) {
      const testHint = document.createElement("div");
      testHint.className = "hw-hint";
      testHint.textContent =
        "The strip now shows three color bands. Tap the swatch whose dots match " +
        "what you physically see, left to right — that's your wire order.";
      g.append(testHint, permGrid(cfg.channel, cfg.colorOrder));
      const actions = document.createElement("div");
      actions.className = "hw-test-actions";
      actions.append(
        Button({ label: "Done", variant: "primary", onClick: () => void stopTest(cfg.channel) }),
      );
      g.append(actions);
    } else {
      const actions = document.createElement("div");
      actions.className = "hw-test-actions";
      actions.append(
        Button({
          label: "Check color order",
          onClick: () => void startTest(cfg.channel),
        }),
      );
      g.append(actions);
    }
    return g;
  }

  /** The six permutations as tappable swatches; the current order is highlighted. */
  function permGrid(ch: number, current: ColorOrder): HTMLElement {
    const grid = document.createElement("div");
    grid.className = "hw-perm-grid";
    for (const order of COLOR_ORDERS) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "hw-perm" + (order === current ? " hw-perm--on" : "");
      const lbl = document.createElement("span");
      lbl.className = "hw-perm-label";
      lbl.textContent = order;
      btn.append(orderDots(order), lbl);
      btn.addEventListener("click", () => void pickOrder(ch, order));
      grid.append(btn);
    }
    return grid;
  }

  function gpioOptions(current: number): Array<{ value: string; label: string }> {
    const pins = SAFE_GPIOS.includes(current) ? SAFE_GPIOS : [current, ...SAFE_GPIOS];
    return pins.map((p) => ({ value: String(p), label: `GPIO ${p}` }));
  }

  render();

  return {
    el,
    onMount: () => void hydrate(),
    onUnmount: () => {
      // Leave the strip clean: clear any in-progress color test.
      if (activeTest !== null) void stopTest(activeTest);
    },
  };
}

// ---------------------------------------------------------------------------
// small local builders (mirrors the color-correction screen's group/row helpers)
// ---------------------------------------------------------------------------

/** Three colored dots in the given wire order (e.g. "GRB" -> green, red, blue). */
function orderDots(order: ColorOrder): HTMLElement {
  const wrap = document.createElement("span");
  wrap.className = "hw-perm-dots";
  for (const ch of order) {
    const dot = document.createElement("span");
    dot.className = "hw-dot";
    dot.style.background = COLOR_HEX[ch] ?? "#888";
    wrap.append(dot);
  }
  return wrap;
}

function select(
  options: Array<{ value: string; label: string }>,
  value: string,
  onPick: (v: string) => void,
  disabled = false,
): HTMLElement {
  const sel = document.createElement("select");
  sel.className = "hw-select";
  sel.disabled = disabled;
  for (const opt of options) {
    const o = document.createElement("option");
    o.value = opt.value;
    o.textContent = opt.label;
    if (opt.value === value) o.selected = true;
    sel.appendChild(o);
  }
  sel.addEventListener("change", () => onPick(sel.value));
  return sel;
}

function group(legend: string): HTMLElement {
  const card = Card();
  card.classList.add("hw-group");
  const l = document.createElement("div");
  l.className = "hw-legend";
  l.textContent = legend;
  card.appendChild(l);
  return card;
}

function row(name: string, hint: string, control: HTMLElement): HTMLElement {
  const r = document.createElement("div");
  r.className = "hw-row";
  const label = document.createElement("div");
  const n = document.createElement("div");
  n.className = "hw-row-name";
  n.textContent = name;
  const h = document.createElement("div");
  h.className = "hw-row-hint";
  h.textContent = hint;
  label.append(n, h);
  const ctl = document.createElement("div");
  ctl.className = "hw-row-ctl";
  ctl.appendChild(control);
  r.append(label, ctl);
  return r;
}

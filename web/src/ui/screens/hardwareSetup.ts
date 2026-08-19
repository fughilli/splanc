/**
 * Hardware Setup (FUG-123). A per-device surface for the LED strip's HARDWARE
 * wiring: which GPIO drives each output channel, the LED chip family (WS281x
 * today), and the wire color order (RGB / GRB / …).
 *
 * Color order is the tricky one — you can't read a strip's wiring, you have to
 * SEE it. The "check color order" flow forces the channel to identity RGB (so
 * the raw wire bytes reach the strip) and lights three short runs at the START
 * of the strip: N pixels intent-red, then N green, then N blue (N is picked next
 * to the button). Anchoring at index 0 keeps them visible no matter how many
 * LEDs are physically wired — the old "even thirds of the configured length"
 * lit the whole strip red when the strip was shorter than a third of that count.
 * Whatever the strip physically shows is a permutation of R/G/B; the user taps
 * the swatch (of the six) whose dots match what they see, and that permutation
 * IS the wire order. Committing it makes the same on-device pattern snap to a
 * correct R/G/B — instant confirmation.
 *
 * The config round-trips through set_hardware_config; the device persists it to
 * NVS and replies hardware_config_state, and get_hardware_config hydrates this
 * page on open.
 */

import { Button, Card, confirmDialog, toast } from "../kit";
import type { Router, Screen } from "../app/router";
import { appState } from "../app/state";
import { deviceStore } from "../../store/deviceStore";
import { COLOR_ORDERS, type ColorOrder, type HardwareChannel } from "../../net/proto";
import type { ColorBlock } from "@ledmapper/protocol";
import { installHardwareSetupStyles } from "./hardwareSetup.css";

// Output-capable C6 GPIOs for LED data, grouped by how safe they are to use (see
// firmware led_config.h + the ESP32-C6 SuperMini pinout). "Recommended" are clean
// general-purpose pins; the rest are OVERLOADED — usable for WS281x data (the GPIO
// matrix routes RMT anywhere) but with a caveat, so picking one pops a confirm.
// The device also range-checks; a currently-configured pin that's off this list is
// still shown (see gpioGroups) so hydration always has a matching option.
interface GpioGroup {
  label: string;
  gpios: number[];
  /** Non-null → picking any pin in this group needs a confirm; text explains why. */
  caution?: (gpio: number) => string;
}

const GPIO_GROUPS: GpioGroup[] = [
  { label: "Recommended", gpios: [0, 1, 2, 3, 6, 7, 10, 11, 14, 20, 21, 22, 23] },
  {
    label: "Strapping pins — use with care",
    gpios: [4, 5, 8, 9, 15],
    caution: (g) =>
      `GPIO ${g} is an ESP32-C6 boot strapping pin. Whatever is wired to it is sampled ` +
      `at reset and can change how the board boots (download mode, flash voltage). It ` +
      `works for LED data once booted, but wire it with care so it isn't held at the ` +
      `wrong level during power-up.`,
  },
  {
    label: "USB-Serial-JTAG — use with care",
    gpios: [12, 13],
    caution: (g) =>
      `GPIO ${g} is the C6's built-in USB-Serial-JTAG line. Driving it for LED data ` +
      `gives up USB flashing and serial monitoring over that port until the pin is freed.`,
  },
  {
    label: "Internal SPI flash — avoid",
    gpios: [18, 19],
    caution: (g) =>
      `GPIO ${g} is wired to the C6 SuperMini's on-board SPI flash. Driving it will very ` +
      `likely hang or corrupt the board. Only pick it if your particular board does NOT ` +
      `route flash to this pin.`,
  },
];

/** The caution text for `gpio`, or undefined if it's a recommended/off-catalog pin. */
function gpioCaution(gpio: number): string | undefined {
  for (const grp of GPIO_GROUPS) {
    if (grp.gpios.includes(gpio)) return grp.caution?.(gpio);
  }
  return undefined;
}

/** Groups for the dropdown; a device pin that's off the catalog gets its own
 * "Current" group up top so hydration always has a matching (selectable) option. */
function gpioGroups(current: number): Array<{ label: string; gpios: number[] }> {
  const known = GPIO_GROUPS.some((g) => g.gpios.includes(current));
  const groups = GPIO_GROUPS.map((g) => ({ label: g.label, gpios: g.gpios }));
  if (!known) groups.unshift({ label: "Current", gpios: [current] });
  return groups;
}

// Per-logical-channel dot colors for the color-order swatches (matches the
// color-correction screen's channel palette).
const COLOR_HEX: Record<string, string> = { R: "#ff5d5d", G: "#57d16a", B: "#5d8bff" };

const LED_TYPES: Array<{ value: string; label: string }> = [{ value: "ws281x", label: "WS281x" }];

// Pixel-run lengths offered next to "Check color order": N pixels of each
// primary. Anchored at the strip start, so N up to this max stays visible on a
// short strip (needs 3·N LEDs to show all three runs).
const TEST_COUNTS = [1, 2, 3, 5, 10];

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
  // How many pixels of each primary the color-order test lights (see TEST_COUNTS).
  let testCount = 3;

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

  /** Three short R/G/B runs at the START of the strip (N = testCount pixels
   * each), for the color-order check. Anchored at index 0 — NOT scaled to the
   * configured length — so they stay visible on a strip shorter than the
   * configured max (the old thirds-of-ledCount lit the whole strip red then). */
  function testBlocks(): ColorBlock[] {
    const n = Math.max(1, testCount);
    return [
      { start: 0, count: n, rgb: [1, 0, 0] },
      { start: n, count: n, rgb: [0, 1, 0] },
      { start: 2 * n, count: n, rgb: [0, 0, 1] },
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
      // Repaint: the same on-device runs now reorder through the chosen wire
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
      row("Data GPIO", "Which pin drives this channel's WS281x data line.", gpioSelect(cfg)),
      row(
        "LED type",
        "The LED chip family. Only WS281x (WS2811/2812/2812B/SK6812) is supported today.",
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
    label.className = "hw-row-label";
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
        `The strip now lights ${testCount} red, then ${testCount} green, then ` +
        `${testCount} blue pixel${testCount === 1 ? "" : "s"} at its start. Tap the ` +
        "swatch whose dots match what you physically see, left to right — that's " +
        "your wire order.";
      g.append(testHint, permGrid(cfg.channel, cfg.colorOrder));
      const actions = document.createElement("div");
      actions.className = "hw-test-actions";
      actions.append(
        countControl(cfg.channel),
        Button({ label: "Done", variant: "primary", onClick: () => void stopTest(cfg.channel) }),
      );
      g.append(actions);
    } else {
      const actions = document.createElement("div");
      actions.className = "hw-test-actions";
      actions.append(
        countControl(cfg.channel),
        Button({
          label: "Check color order",
          onClick: () => void startTest(cfg.channel),
        }),
      );
      g.append(actions);
    }
    return g;
  }

  /** "N per color" picker sitting next to the check button. Retunes the live
   * strip immediately if this channel's test is already running. */
  function countControl(ch: number): HTMLElement {
    const wrap = document.createElement("label");
    wrap.className = "hw-count";
    const cap = document.createElement("span");
    cap.className = "hw-count-label";
    cap.textContent = "Pixels each";
    const sel = select(
      TEST_COUNTS.map((n) => ({ value: String(n), label: String(n) })),
      String(testCount),
      (v) => {
        testCount = Math.max(1, Number(v) || 1);
        const c = appState.client;
        if (activeTest === ch && c?.isConnected) void c.setCountingPattern(testBlocks(), ch);
        if (activeTest === ch) render(); // refresh the hint's pixel counts
      },
    );
    sel.classList.add("hw-select--narrow");
    wrap.append(cap, sel);
    return wrap;
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

  /** GPIO dropdown with the pins grouped (optgroups) by safety category. Picking
   * an overloaded pin (strapping / USB-JTAG / flash) confirms first; on cancel the
   * select snaps back to the previously-set pin so nothing is committed. */
  function gpioSelect(cfg: HardwareChannel): HTMLElement {
    const sel = document.createElement("select");
    sel.className = "hw-select";
    for (const grp of gpioGroups(cfg.gpio)) {
      const og = document.createElement("optgroup");
      og.label = grp.label;
      for (const gpio of grp.gpios) {
        const o = document.createElement("option");
        o.value = String(gpio);
        o.textContent = `GPIO ${gpio}`;
        if (gpio === cfg.gpio) o.selected = true;
        og.appendChild(o);
      }
      sel.appendChild(og);
    }
    let prev = String(cfg.gpio);
    sel.addEventListener("change", () => {
      void (async () => {
        const gpio = Number(sel.value);
        const caution = gpioCaution(gpio);
        if (caution) {
          const ok = await confirmDialog({
            title: `Use GPIO ${gpio}?`,
            message: caution,
            confirmLabel: `Use GPIO ${gpio}`,
            cancelLabel: "Keep current",
            danger: true,
          });
          if (!ok) {
            sel.value = prev; // user backed out — revert the visible selection
            return;
          }
        }
        prev = sel.value;
        await setGpio(cfg.channel, gpio);
      })();
    });
    return sel;
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
  label.className = "hw-row-label";
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

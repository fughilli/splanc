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
import {
  COLOR_ORDERS,
  type BoardCapabilitiesFlat,
  type ColorOrder,
  type GpioPinFlat,
  type HardwareChannel,
  type PinSafety,
} from "../../net/proto";
import type { ColorBlock } from "@ledmapper/protocol";
import { installHardwareSetupStyles } from "./hardwareSetup.css";

// Output-capable C6 GPIOs for LED data, grouped by how safe they are to use.
// Categories + caveats follow the ESP32-C6 SuperMini pinout published at
// espboards.dev/esp32/esp32-c6-super-mini: "Recommended" is that page's exact
// no-caveat set; every other pin is OVERLOADED — usable for WS281x data (the GPIO
// matrix routes RMT anywhere) but with a caveat, so picking one pops a confirm.
// The device also range-checks; a currently-configured pin that's off this list is
// still shown (see gpioGroups) so hydration always has a matching option.
interface GpioGroup {
  label: string;
  gpios: number[];
  /** Non-null → picking any pin in this group needs a confirm; text explains why. */
  caution?: (gpio: number) => string;
}

// The four JTAG debug pins (MTMS/MTDI/MTCK/MTDO) that also carry internal-flash
// clock/data on internal-flash C6 SuperMini models (espboards.dev, above).
const JTAG_FLASH: Record<number, { sig: string; flash: string }> = {
  4: { sig: "MTMS", flash: "flash data" },
  5: { sig: "MTDI", flash: "flash data" },
  6: { sig: "MTCK", flash: "flash clock" },
  7: { sig: "MTDO", flash: "flash data" },
};

const GPIO_GROUPS: GpioGroup[] = [
  // espboards.dev's "safe/general-purpose (no caveats)" list, plus 10/11 — plain
  // C6 GPIOs with no strapping/flash/USB/JTAG role (just not enumerated on that
  // page). NOTE: 6/7 were wrongly here before — they're JTAG/flash pins (below).
  // This whole catalog is a FALLBACK; a board that reports its pin config over RPC
  // should override it (see hardware_config_state / TODO board-capabilities).
  { label: "Recommended", gpios: [0, 1, 2, 3, 10, 11, 14, 20, 21, 22, 23] },
  {
    label: "JTAG / internal-flash — use with care",
    gpios: [4, 5, 6, 7],
    caution: (g) => {
      const { sig, flash } = JTAG_FLASH[g] ?? { sig: `IO${g}`, flash: "flash data" };
      return (
        `GPIO ${g} (${sig}) is a JTAG debug pin and carries ${flash} on internal-flash ` +
        `C6 SuperMini models. Using it for LED data disables JTAG debugging and, on those ` +
        `boards, will disrupt the internal flash — only pick it if your board doesn't ` +
        `route flash to this pin.`
      );
    },
  },
  {
    label: "Boot strapping — use with care",
    gpios: [8, 9, 15],
    caution: (g) =>
      `GPIO ${g} is an ESP32-C6 boot strapping pin (boot mode / download mode / JTAG ` +
      `source). It's sampled at reset, so whatever is wired to it can stop the board ` +
      `booting normally. Usable for LED data once booted, but wire it with care.`,
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
      `GPIO ${g} (${g === 18 ? "FSPIQ" : "FSPID"}) is connected to the C6 SuperMini's ` +
      `internal SPI flash. Driving it will disrupt flash operations and very likely hang ` +
      `or corrupt the board — avoid it.`,
  },
];

// Fallback LED driver modes when the board reports none (only WS281x today).
const LED_TYPES: Array<{ value: string; label: string }> = [{ value: "ws281x", label: "WS281x" }];

// The GPIO picker + LED-type list are driven by a PinCatalog. It comes from the
// board itself when the firmware reports BoardCapabilities (hardware_config_state
// .board); older firmware that reports none falls back to FALLBACK_CATALOG below.
interface PinCatalog {
  /** Ordered optgroups for the dropdown. */
  groups: Array<{ label: string; gpios: number[] }>;
  /** Confirm text for a pin, or undefined when it needs no confirmation. */
  caution: (gpio: number) => string | undefined;
  /** LED driver-mode options for the LED-type dropdown. */
  ledTypes: Array<{ value: string; label: string }>;
}

// The built-in fallback, from the hardcoded ESP32-C6 SuperMini catalog above.
const FALLBACK_CATALOG: PinCatalog = {
  groups: GPIO_GROUPS.map((g) => ({ label: g.label, gpios: g.gpios })),
  caution: (gpio) => {
    for (const grp of GPIO_GROUPS) {
      if (grp.gpios.includes(gpio)) return grp.caution?.(gpio);
    }
    return undefined;
  },
  ledTypes: LED_TYPES,
};

// PinSafety (proto enum name) -> dropdown group. UNSPECIFIED is treated as
// recommended (a board that lists a pin without tagging it isn't flagging risk);
// any unknown value is treated as caution, the safe default.
const CAUTION_GROUP = { order: 1, label: "Use with care" };
const SAFETY_GROUP: Record<string, { order: number; label: string }> = {
  PIN_SAFETY_RECOMMENDED: { order: 0, label: "Recommended" },
  PIN_SAFETY_UNSPECIFIED: { order: 0, label: "Recommended" },
  PIN_SAFETY_CAUTION: CAUTION_GROUP,
  PIN_SAFETY_AVOID: { order: 2, label: "Avoid" },
};

function pinNeedsConfirm(safety: PinSafety): boolean {
  return safety === "PIN_SAFETY_CAUTION" || safety === "PIN_SAFETY_AVOID";
}

/** App-supplied default wording when a reported pin carries no board-specific note. */
function defaultCaution(safety: PinSafety, gpio: number): string {
  if (safety === "PIN_SAFETY_AVOID") {
    return (
      `GPIO ${gpio} is unsafe to drive on this board — it can hang or corrupt it. ` +
      `Only use it if you know your board wiring differs.`
    );
  }
  return `GPIO ${gpio} is an overloaded pin on this board — use it with care.`;
}

/** Build a catalog from the board's reported capabilities (grouped by safety;
 * the per-pin note drives the confirm text, falling back to default wording). */
function boardCatalog(caps: BoardCapabilitiesFlat): PinCatalog {
  const buckets = new Map<string, { order: number; gpios: number[] }>();
  const byGpio = new Map<number, GpioPinFlat>();
  for (const p of caps.gpioPins) {
    byGpio.set(p.gpio, p);
    const grp = SAFETY_GROUP[p.safety] ?? CAUTION_GROUP;
    const bucket = buckets.get(grp.label) ?? { order: grp.order, gpios: [] };
    bucket.gpios.push(p.gpio);
    buckets.set(grp.label, bucket);
  }
  const groups = [...buckets.entries()]
    .sort((a, b) => a[1].order - b[1].order)
    .map(([label, b]) => ({ label, gpios: [...b.gpios].sort((x, y) => x - y) }));
  const ledTypes = caps.ledModes.length
    ? caps.ledModes.map((m) => ({ value: m.id, label: m.label }))
    : LED_TYPES;
  return {
    groups,
    caution: (gpio) => {
      const p = byGpio.get(gpio);
      if (!p || !pinNeedsConfirm(p.safety)) return undefined;
      return p.note.length > 0 ? p.note : defaultCaution(p.safety, gpio);
    },
    ledTypes,
  };
}

/** Groups for the dropdown; a device pin that's off the catalog gets its own
 * "Current" group up top so hydration always has a matching (selectable) option. */
function gpioGroupsFor(cat: PinCatalog, current: number): Array<{ label: string; gpios: number[] }> {
  const known = cat.groups.some((g) => g.gpios.includes(current));
  const groups = cat.groups.map((g) => ({ label: g.label, gpios: g.gpios }));
  if (!known) groups.unshift({ label: "Current", gpios: [current] });
  return groups;
}

// Per-logical-channel dot colors for the color-order swatches (matches the
// color-correction screen's channel palette).
const COLOR_HEX: Record<string, string> = { R: "#ff5d5d", G: "#57d16a", B: "#5d8bff" };

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
  // The board's reported capabilities (pin catalog + LED modes), captured from
  // hardware_config_state; null until hydrated or on firmware that reports none.
  let boardCaps: BoardCapabilitiesFlat | null = null;
  // Which channel's color-order test is currently painting the strip (null = none).
  let activeTest: number | null = null;
  // While a test is active: the order the user tapped and is now confirming (the
  // strip previews it applied), or null during the raw identify phase.
  let pendingOrder: ColorOrder | null = null;
  // How many pixels of each primary the color-order test lights (see TEST_COUNTS).
  let testCount = 3;

  // Active pin/LED-type catalog: the board's own when it reports one, else the
  // built-in SuperMini fallback.
  const catalog = (): PinCatalog =>
    boardCaps && boardCaps.gpioPins.length > 0 ? boardCatalog(boardCaps) : FALLBACK_CATALOG;

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
      boardCaps = st.board ?? null;
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
      if (st.board) boardCaps = st.board;
      render();
      toast(`Channel ${ch} → GPIO ${gpio}`);
    } catch {
      toast("Failed to set GPIO", { error: true });
    }
  }

  async function setLedType(ch: number, ledType: string): Promise<void> {
    const c = connectedClient();
    if (!c) return;
    try {
      const st = await c.setHardwareConfig({ channel: ch, ledType, commit: true });
      channels = st.channels.map((x) => ({ ...x }));
      if (st.board) boardCaps = st.board;
      render();
      toast(`LED type set to ${ledType}`);
    } catch {
      toast("Failed to set LED type", { error: true });
    }
  }

  async function startTest(ch: number): Promise<void> {
    const c = connectedClient();
    if (!c) return;
    try {
      // Identify phase: drive the probe with identity "RGB" so the raw wire bytes
      // (255,0,0)/(0,255,0)/(0,0,255) reach the strip unpermuted and the user sees
      // its true wire order. The probe carries its own order — the committed
      // hardware config is never touched.
      await c.setCountingPattern(testBlocks(), ch, "RGB");
      activeTest = ch;
      pendingOrder = null;
      render();
    } catch {
      toast("Couldn't start the color test", { error: true });
    }
  }

  async function pickOrder(ch: number, order: ColorOrder): Promise<void> {
    const c = connectedClient();
    if (!c) return;
    try {
      // PREVIEW the picked order on the probe only — the committed hardware config
      // is untouched until the user confirms. The probe now reorders through the
      // candidate, so a correct pick snaps the strip to red / green / blue.
      await c.setCountingPattern(testBlocks(), ch, order);
      pendingOrder = order;
      render();
    } catch {
      toast("Failed to set color order", { error: true });
    }
  }

  /** Confirm phase → "Yes": persist the previewed order to flash and end the test. */
  async function confirmOrder(ch: number): Promise<void> {
    const c = connectedClient();
    if (!c || pendingOrder === null) return;
    const order = pendingOrder;
    try {
      const st = await c.setHardwareConfig({ channel: ch, colorOrder: order, commit: true });
      channels = st.channels.map((x) => ({ ...x }));
    } catch {
      toast("Failed to set color order", { error: true });
      return;
    }
    toast(`Color order set to ${order}`);
    await stopTest(ch);
  }

  /** Confirm phase → "No": drop the preview, drive the probe raw again (identity)
   * so the strip shows the true wire colors, and reopen the swatch picker. */
  async function rePick(ch: number): Promise<void> {
    const c = connectedClient();
    if (!c) return;
    try {
      await c.setCountingPattern(testBlocks(), ch, "RGB");
      pendingOrder = null;
      render();
    } catch {
      toast("Couldn't restart the color test", { error: true });
    }
  }

  async function stopTest(ch: number): Promise<void> {
    activeTest = null;
    pendingOrder = null;
    const c = appState.client;
    if (c?.isConnected) {
      try {
        // Just clear the probe. Nothing to restore: the test drives the probe's
        // own wire order and never touches the committed hardware config.
        await c.setCountingPattern([], ch);
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

    const ledTypes = catalog().ledTypes;
    const ledHint =
      ledTypes.length > 1
        ? "The LED chip family this channel drives."
        : "The LED chip family. Only WS281x (WS2811/2812/2812B/SK6812) is supported today.";
    g.append(
      row("Data GPIO", "Which pin drives this channel's WS281x data line.", gpioSelect(cfg)),
      row(
        "LED type",
        ledHint,
        select(
          ledTypes,
          cfg.ledType || ledTypes[0]?.value || "ws281x",
          (v) => void setLedType(cfg.channel, v),
          ledTypes.length <= 1, // only one supported mode -> read-only
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

    if (activeTest === cfg.channel && pendingOrder === null) {
      // Identify phase: the strip shows the RAW primaries (the test forces an
      // identity wire order, so the stored color order is NOT applied) and the
      // user taps the swatch matching what they physically see.
      const testHint = document.createElement("div");
      testHint.className = "hw-hint";
      testHint.textContent =
        `The strip now lights ${testCount} red, then ${testCount} green, then ` +
        `${testCount} blue pixel${testCount === 1 ? "" : "s"} at its start. Tap the ` +
        "swatch whose dots match what you physically see, from the beginning of " +
        "the strip toward the end — that's your wire order.";
      g.append(testHint, permGrid(cfg.channel, cfg.colorOrder));
      const actions = document.createElement("div");
      actions.className = "hw-test-actions";
      actions.append(
        countControl(cfg.channel),
        Button({ label: "Done", variant: "primary", onClick: () => void stopTest(cfg.channel) }),
      );
      g.append(actions);
    } else if (activeTest === cfg.channel) {
      // Confirm phase: the picked order is now applied (previewed, not yet
      // committed), so a correct pick makes the strip read red → green → blue in
      // order. Ask whether it now matches that RGB target; let the user re-pick.
      const confirmHint = document.createElement("div");
      confirmHint.className = "hw-hint";
      confirmHint.textContent =
        `Set to ${pendingOrder}. The strip should now read ${testCount} red, then ` +
        `${testCount} green, then ${testCount} blue — from the beginning of the ` +
        "strip toward the end. Does the color order now look like this?";
      const target = document.createElement("div");
      target.className = "hw-order-current";
      target.append(orderDots("RGB"), document.createTextNode("RGB"));
      const actions = document.createElement("div");
      actions.className = "hw-test-actions";
      actions.append(
        Button({
          label: "Yes, looks right",
          variant: "primary",
          onClick: () => void confirmOrder(cfg.channel),
        }),
        Button({ label: "No, pick again", onClick: () => void rePick(cfg.channel) }),
      );
      g.append(confirmHint, target, actions);
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
        // Retune the live probe, keeping its current wire order (raw during
        // identify, the previewed candidate during confirm).
        if (activeTest === ch && c?.isConnected)
          void c.setCountingPattern(testBlocks(), ch, pendingOrder ?? "RGB");
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
    const cat = catalog();
    const sel = document.createElement("select");
    sel.className = "hw-select";
    for (const grp of gpioGroupsFor(cat, cfg.gpio)) {
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
        const caution = cat.caution(gpio);
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

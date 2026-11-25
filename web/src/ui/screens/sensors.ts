/**
 * The Sensors page (route /sensors; firmware feature "power"; owner decision
 * D-185): set up a sensor module on the lamp and test it live.
 *
 * - Live test: the running driver (get_driver_state, polled while the page is
 *   open) and the power binding (power_state pushes): the trigger's count and a
 *   "Touch detected" flash each time it fires.
 * - Set up with the assistant: a chat on the app's AI provider seam; it reads
 *   the lamp's state and proposes a setup the user applies with one tap.
 * - Set it up yourself: the TTP223 form (pin, polarity, mode).
 *
 * Applying = compile the touch driver (power/touchDriver.ts), submit it
 * (submit_driver), bind its trigger to power (set_power_config.toggle_trigger).
 * The compiler is injected (`deps.compile`) so tests and the kit flow can stub it.
 */

import { Button, Card, toast } from "../kit";
import type { Router, Screen } from "../app/router";
import { appState } from "../app/state";
import { renderMarkdown } from "../markdown";
import { isAiConfigured, type ChatMessage } from "../../effects/ai/provider";
import { activeProvider } from "../../effects/ai/generate";
import type { DriverStateMessage, HardwareConfigStateMessage, PowerState } from "../../net/proto";
import {
  TTP223_CHECK,
  TTP223_PADS,
  TTP223_WIRING,
  CountWatch,
  deviceHasPower,
  suggestedTouchPin,
  touchPinOptions,
  triggerLiveLine,
} from "../../power/power";
import {
  DEFAULT_TOUCH_TRIGGER,
  TOUCH_MODE_MOMENTARY,
  TOUCH_MODE_TOGGLE,
  setUpTouch,
  triggerExportCount,
  type DriverCompile,
  type TouchDriverConfig,
} from "../../power/touchDriver";
import { describeTouch, parseTouchProposal, runSensorTurn } from "../../power/sensorAgent";
import { workerDriverCompile } from "./driverCompile";
import { installPowerStyles } from "./power.css";

/** Recommended pins when the board reports no catalog (C6 SuperMini). */
export const FALLBACK_RECOMMENDED = [0, 1, 2, 3, 10, 11, 14, 20, 21, 22, 23];

/** Free pins for a sensor: the board's recommended ones minus LED data pins. */
export function freePinsOf(hw: HardwareConfigStateMessage | null): number[] {
  const rec = hw?.board?.gpioPins?.length
    ? hw.board.gpioPins
        .filter((p) => p.safety === "PIN_SAFETY_RECOMMENDED" || p.safety === "PIN_SAFETY_UNSPECIFIED")
        .map((p) => p.gpio)
    : FALLBACK_RECOMMENDED;
  const busy = (hw?.channels ?? []).filter((c) => c.gpio >= 0).map((c) => c.gpio);
  return touchPinOptions(rec, busy, -1);
}

/** The "check the A/B pads or meter OUT" list (shared with the kit flow). */
export function checkList(): HTMLElement {
  const box = document.createElement("div");
  box.className = "sn-check";
  const t = document.createElement("div");
  t.className = "pw-tile-name";
  t.textContent = "Check the board's A and B pads";
  const table = document.createElement("table");
  table.className = "sn-pads";
  const head = document.createElement("tr");
  for (const c of ["A", "B", "Mode", "Output"]) {
    const th = document.createElement("th");
    th.textContent = c;
    head.append(th);
  }
  table.append(head);
  for (const r of TTP223_PADS) {
    const tr = document.createElement("tr");
    if (r.recommended) tr.dataset["rec"] = "true";
    for (const c of [
      r.a ? "bridged" : "open",
      r.b ? "bridged" : "open",
      r.mode,
      (r.activeLow ? "Active-low" : "Active-high") + (r.recommended ? " (use this)" : ""),
    ]) {
      const td = document.createElement("td");
      td.textContent = c;
      tr.append(td);
    }
    table.append(tr);
  }
  const ul = document.createElement("ul");
  for (const line of TTP223_CHECK) {
    const li = document.createElement("li");
    li.textContent = line;
    ul.append(li);
  }
  box.append(t, table, ul);
  return box;
}

export function SensorsScreen(_router: Router, deps: { compile?: DriverCompile } = {}): Screen {
  installPowerStyles();
  const el = document.createElement("div");
  el.className = "screen screen--pw";
  let compile: DriverCompile | null = deps.compile ?? null;
  let disposeCompile: (() => void) | null = null;
  const getCompile = (): DriverCompile => {
    if (!compile) {
      const w = workerDriverCompile();
      compile = w.compile;
      disposeCompile = w.dispose;
    }
    return compile;
  };

  let hw: HardwareConfigStateMessage | null = null;
  let power: PowerState | null = null;
  let driver: DriverStateMessage | null = null;
  let busy = false;
  const watch = new CountWatch();
  const history: ChatMessage[] = [];
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let unsub: (() => void) | null = null;
  let unsubApp: (() => void) | null = null;
  let bound: ReturnType<typeof client> = null;

  const client = () => {
    const c = appState.client;
    return c?.isConnected ? c : null;
  };

  // -- live test card -------------------------------------------------------
  const live = Card();
  live.classList.add("pw-summary", "sn-live");
  const liveTitle = document.createElement("div");
  liveTitle.className = "pw-summary-title";
  liveTitle.textContent = "Live test";
  const flash = document.createElement("div");
  flash.className = "sn-flash";
  flash.textContent = "Tap the lid";
  const powerLine = document.createElement("div");
  powerLine.className = "pw-summary-val";
  const driverLine = document.createElement("div");
  driverLine.className = "pw-summary-val";
  live.append(liveTitle, flash, powerLine, driverLine);

  const trigger = (): string => power?.toggleTrigger || DEFAULT_TOUCH_TRIGGER;
  function paintLive(): void {
    powerLine.textContent = `Lamp: ${power?.on ? "on" : "off"} · ${triggerLiveLine(power)}`;
    if (!driver) driverLine.textContent = "Driver: reading…";
    else if (!driver.running) driverLine.textContent = "Driver: none running";
    else {
      const n = triggerExportCount(driver.exports, trigger());
      driverLine.textContent =
        `Driver: running · ${driver.polls} polls` + (n !== null ? ` · "${trigger()}" fired ${n}×` : "");
    }
  }
  function onCount(n: number | null): void {
    if (!watch.bumped(n)) return;
    flash.textContent = "Touch detected";
    flash.dataset["on"] = "true";
    setTimeout(() => {
      flash.dataset["on"] = "false";
      flash.textContent = "Tap the lid";
    }, 700);
  }

  // -- the assistant ----------------------------------------------------------
  const chat = Card();
  chat.classList.add("pw-summary");
  const chatLog = document.createElement("div");
  chatLog.className = "sn-chat-log";
  const input = document.createElement("textarea");
  input.className = "sn-chat-input";
  input.rows = 2;
  input.placeholder = "e.g. I have a red touch board with 3 pins under the lid";
  const sendBtn = Button({ label: "Send", variant: "quiet", onClick: () => void send() });
  const chatRow = document.createElement("div");
  chatRow.className = "sn-chat-row";
  chatRow.append(input, sendBtn);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  });

  function bubble(role: "user" | "assistant", text: string): HTMLElement {
    const b = document.createElement("div");
    b.className = `sn-msg sn-msg--${role}`;
    if (role === "assistant") b.append(renderMarkdown(text));
    else b.textContent = text;
    chatLog.append(b);
    chatLog.scrollTop = chatLog.scrollHeight;
    return b;
  }

  function proposalCard(cfg: Required<TouchDriverConfig>, why: string): void {
    const p = document.createElement("div");
    p.className = "sn-proposal";
    const t = document.createElement("div");
    t.className = "pw-tile-name";
    t.textContent = "Proposed setup";
    const d = document.createElement("div");
    d.className = "pw-tile-hint";
    d.textContent = describeTouch(cfg) + (why ? `. ${why}` : "");
    const act = document.createElement("div");
    act.className = "pw-actions";
    act.append(Button({ label: "Apply this setup", onClick: () => void apply(cfg) }));
    p.append(t, d, act);
    chatLog.append(p);
    chatLog.scrollTop = chatLog.scrollHeight;
  }

  async function exec(name: string, inputArgs: Record<string, unknown>): Promise<{ text: string; error?: boolean }> {
    if (name === "get_sensor_status") {
      return {
        text: JSON.stringify({
          free_pins: freePinsOf(hw),
          led_data_pins: (hw?.channels ?? []).map((c) => c.gpio),
          power: power ? { on: power.on, toggle_trigger: power.toggleTrigger, trigger_count: power.triggerCount } : null,
          driver: driver
            ? { running: driver.running, exports: driver.exports.map((e) => ({ name: e.name, value: e.value })) }
            : null,
        }),
      };
    }
    if (name === "propose_touch_setup") {
      const r = parseTouchProposal(inputArgs, freePinsOf(hw));
      if (!r.ok) return { text: r.error, error: true };
      proposalCard(r.cfg, r.why);
      return { text: "Shown to the user as a card with an Apply button. Wait for them to apply and test it." };
    }
    return { text: `unknown tool ${name}`, error: true };
  }

  async function send(): Promise<void> {
    const text = input.value.trim();
    if (!text || busy) return;
    input.value = "";
    bubble("user", text);
    history.push({ role: "user", content: text });
    sendBtn.disabled = true;
    const pending = bubble("assistant", "…");
    try {
      const reply = await runSensorTurn(activeProvider(), history, exec);
      pending.replaceChildren(renderMarkdown(reply || "(no reply)"));
    } catch (e) {
      pending.textContent = `The assistant couldn't answer: ${e instanceof Error ? e.message : String(e)}`;
    } finally {
      sendBtn.disabled = false;
    }
  }

  function chatCard(): HTMLElement {
    const title = document.createElement("div");
    title.className = "pw-summary-title";
    title.textContent = "Set up with the assistant";
    const hint = document.createElement("div");
    hint.className = "pw-summary-val";
    if (!isAiConfigured()) {
      hint.textContent = "Choose an AI provider in Settings to set up a sensor by chatting. Or use the form below.";
      const act = document.createElement("div");
      act.className = "pw-actions";
      act.append(Button({ label: "AI settings", variant: "quiet", onClick: () => (location.hash = "#/settings/ai") }));
      chat.replaceChildren(title, hint, act);
      return chat;
    }
    hint.textContent = "Describe the module and how it's wired. The assistant proposes a setup; you apply it.";
    if (chatLog.childElementCount === 0) {
      bubble("assistant", "Hi! What sensor are you adding? For a touch board under the lid, tell me which pin its I/O wire goes to.");
    }
    chat.replaceChildren(title, hint, chatLog, chatRow);
    return chat;
  }

  // -- manual form ------------------------------------------------------------
  const form: { gpio: number; activeLow: boolean; mode: number } = { gpio: -1, activeLow: false, mode: TOUCH_MODE_MOMENTARY };

  function select(opts: Array<[string, string]>, value: string, on: (v: string) => void, label: string): HTMLElement {
    const wrap = document.createElement("label");
    wrap.className = "k-field";
    const cap = document.createElement("span");
    cap.className = "k-field-label";
    cap.textContent = label;
    const s = document.createElement("select");
    s.className = "hw-select";
    for (const [v, l] of opts) {
      const o = document.createElement("option");
      o.value = v;
      o.textContent = l;
      o.selected = v === value;
      s.append(o);
    }
    s.addEventListener("change", () => on(s.value));
    wrap.append(cap, s);
    return wrap;
  }

  function formCard(): HTMLElement {
    const c = Card();
    c.classList.add("pw-summary");
    const title = document.createElement("div");
    title.className = "pw-summary-title";
    title.textContent = "Or set up a TTP223 touch sensor yourself";
    const help = document.createElement("div");
    help.className = "pw-summary-val";
    help.textContent = TTP223_WIRING;
    const check = checkList();
    const pins = freePinsOf(hw);
    if (form.gpio < 0) form.gpio = suggestedTouchPin(pins) ?? -1;
    const fields = document.createElement("div");
    fields.className = "sn-fields";
    fields.append(
      select(pins.map((g) => [String(g), `GPIO ${g}`]), String(form.gpio), (v) => (form.gpio = Number(v)), "I/O pin"),
      select(
        [
          ["high", "Active-high (pad A open)"],
          ["low", "Active-low (pad A bridged)"],
        ],
        form.activeLow ? "low" : "high",
        (v) => (form.activeLow = v === "low"),
        "Polarity",
      ),
      select(
        [
          [String(TOUCH_MODE_MOMENTARY), "Momentary (pad B open, recommended)"],
          [String(TOUCH_MODE_TOGGLE), "Toggle / self-lock (pad B bridged)"],
        ],
        String(form.mode),
        (v) => (form.mode = Number(v)),
        "Mode",
      ),
    );
    const act = document.createElement("div");
    act.className = "pw-footer";
    if (power?.toggleTrigger) {
      act.append(Button({ label: "Stop using the sensor", variant: "quiet", disabled: busy, onClick: () => void removeSetup() }));
    }
    act.append(
      Button({
        label: busy ? "Setting up…" : "Set up touch sensor",
        variant: "primary",
        disabled: busy || form.gpio < 0,
        onClick: () => void apply({ ...form, exportName: DEFAULT_TOUCH_TRIGGER }),
      }),
    );
    c.append(title, help, check, fields, act);
    return c;
  }

  async function apply(cfg: TouchDriverConfig): Promise<void> {
    const cl = client();
    if (!cl) {
      toast("Connect the lamp first", { error: true });
      return;
    }
    busy = true;
    render();
    try {
      const r = await setUpTouch(cl, getCompile(), cfg);
      toast(`Touch sensor set up: "${r.trigger}" toggles the lamp. Tap the lid to test.`);
      history.push({ role: "user", content: `(I applied: ${describeTouch(cfg)}.)` });
      void refresh();
    } catch (e) {
      toast(`Couldn't set up the sensor: ${e instanceof Error ? e.message : String(e)}`, { error: true });
    } finally {
      busy = false;
      render();
    }
  }

  async function removeSetup(): Promise<void> {
    const cl = client();
    if (!cl) return;
    busy = true;
    render();
    try {
      power = await cl.setPowerConfig({ toggleTrigger: "" });
      driver = await cl.removeDriver();
      toast("The sensor no longer toggles the lamp");
    } catch {
      toast("Couldn't remove the sensor setup", { error: true });
    } finally {
      busy = false;
      render();
    }
  }

  async function refresh(): Promise<void> {
    const cl = client();
    if (!cl) return;
    try {
      driver = await cl.getDriverState();
      onCount(triggerExportCount(driver.exports, trigger()));
    } catch {
      /* firmware without the driver VM: leave it "reading" */
    }
    paintLive();
  }

  function render(): void {
    const h = document.createElement("h1");
    h.className = "screen-headline";
    h.textContent = "Sensors";
    const sub = document.createElement("p");
    sub.className = "screen-sub";
    const cl = client();
    if (!cl || !deviceHasPower(cl.welcome)) {
      sub.textContent = cl
        ? "This lamp's firmware doesn't support sensor-driven power yet. Update it from the device sheet."
        : "Connect a lamp to set up its sensors.";
      el.replaceChildren(h, sub);
      return;
    }
    sub.textContent = "Add a sensor module to the lamp, most often a touch pad under the lid that turns it on and off.";
    paintLive();
    el.replaceChildren(h, sub, live, chatCard(), formCard());
  }

  render();
  return {
    el,
    onMount: () => {
      // (Re)bind to whichever client is connected (a deep link mounts before the
      // connection is up; a reconnect brings a new session). getPower() both
      // hydrates and subscribes this session to the power_state pushes.
      const bind = (): void => {
        const cl = client();
        if (cl === bound) return;
        unsub?.();
        unsub = null;
        bound = cl;
        if (!cl || !deviceHasPower(cl.welcome)) {
          render();
          return;
        }
        unsub = cl.onPowerState((s) => {
          power = s;
          onCount(s.triggerCount);
          paintLive();
        });
        void (async () => {
          try {
            hw = await cl.getHardwareConfig();
          } catch {
            hw = null;
          }
          try {
            power = await cl.getPower();
            watch.bumped(power.triggerCount);
          } catch {
            power = null;
          }
          render();
          await refresh();
        })();
      };
      unsubApp = appState.subscribe(bind);
      bind();
      pollTimer = setInterval(() => void refresh(), 800);
    },
    onUnmount: () => {
      if (pollTimer) clearInterval(pollTimer);
      unsub?.();
      unsubApp?.();
      disposeCompile?.();
    },
  };
}

/**
 * The Sensors page's assistant (pure parts): its system prompt, tools and the
 * parsing of a proposed setup. The chat loop itself runs in the Sensors screen
 * on the app's AI provider seam (effects/ai/provider.ts).
 *
 * The assistant never changes the lamp by itself: `propose_touch_setup` shows
 * a card the user applies (compile the touch driver, submit it, bind it to
 * power); `get_sensor_status` reads what is there now.
 */

import type { AiProvider, ChatMessage, ContentBlock, ToolDef } from "../effects/ai/provider";
import { TOUCH_MODE_MOMENTARY, TOUCH_MODE_TOGGLE, triggerName, type TouchDriverConfig } from "./touchDriver";

export const SENSOR_TOOLS: readonly ToolDef[] = [
  {
    name: "get_sensor_status",
    description:
      "Read the lamp's sensor setup now: the free GPIOs (board's recommended pins minus LED data pins), the running driver's exports, the trigger bound to lamp power and how often it has fired.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "propose_touch_setup",
    description:
      "Propose a touch-sensor setup for the user to apply with one tap: a GPIO input read by a driver that fires a trigger, bound to toggle the lamp's power. Use after you know the pin and the board's A/B pads.",
    input_schema: {
      type: "object",
      properties: {
        gpio: { type: "integer", description: "GPIO the board's I/O pin is wired to (one of the free pins)." },
        active_low: { type: "boolean", description: "I/O is low while touched (TTP223 pad A bridged)." },
        mode: {
          type: "string",
          enum: ["momentary", "toggle"],
          description: "momentary: I/O active while touched (pad B open, recommended); toggle: I/O flips per touch (pad B bridged).",
        },
        trigger: { type: "string", description: "Trigger name (identifier); default touch_tap." },
        why: { type: "string", description: "One sentence for the user on why this setup." },
      },
      required: ["gpio", "active_low", "mode"],
    },
  },
];

export const SENSOR_SYSTEM = `You help the owner of a Splanc LED lamp set up a sensor module on its ESP32-C6, most often a capacitive touch sensor under the lid that toggles the lamp on and off. Be brief and practical; one question at a time.

Facts:
- The C6 has no touch peripheral: a touch BOARD does the sensing and gives a digital output. The usual one is a TTP223 board (about 15x11 mm, round pad, 3-pin header GND / I/O / VCC, runs on 2.5-5.5 V).
- Wiring: VCC to 3V3 (never 5V: I/O would then swing to 5 V, which the C6 does not tolerate), GND to GND, I/O to a free GPIO. Call get_sensor_status for the free pins; GPIO 3 is the usual choice.
- TTP223 solder pads (0 = open, 1 = bridged): A=0 B=0 momentary active-high (as shipped; the target); A=0 B=1 toggle active-high; A=1 B=0 momentary active-low; A=1 B=1 toggle active-low. Recommend momentary active-high; a toggle (self-lock) board still works (every change of I/O toggles the lamp) but suggest opening pad B. To check without reading the pads: meter I/O against GND, about 0 V idle and 3.3 V while touched = momentary active-high.
- The pad goes under the lid, flat against it (up to ~3 mm of plastic or wood). Don't touch it for about 1 s after the lamp powers up: it recalibrates then (the driver ignores the first second).
- The app runs a small driver on the lamp that reads the pin, debounces it and fires a trigger; the lamp's power listens to that trigger. Nothing else changes.

When you know the pin and pads, call propose_touch_setup. The user applies it, then taps the lid while the page shows the live trigger count. If taps don't register: check 3V3/GND, the pin, and flip active-low (a module that reads "touched" all the time usually has the wrong polarity). Never claim a setup is applied: the user applies it.`;

/** A parsed proposal, or an error the tool result reports back to the model. */
export function parseTouchProposal(
  input: Record<string, unknown>,
  freePins: number[],
): { ok: true; cfg: Required<TouchDriverConfig>; why: string } | { ok: false; error: string } {
  const gpio = input["gpio"];
  if (typeof gpio !== "number" || !Number.isInteger(gpio)) return { ok: false, error: "gpio must be an integer" };
  if (freePins.length > 0 && !freePins.includes(gpio)) {
    return { ok: false, error: `GPIO ${gpio} isn't free on this lamp; free pins: ${freePins.join(", ")}` };
  }
  const mode = input["mode"];
  if (mode !== "momentary" && mode !== "toggle") return { ok: false, error: 'mode must be "momentary" or "toggle"' };
  const why = typeof input["why"] === "string" ? input["why"] : "";
  return {
    ok: true,
    cfg: {
      gpio,
      activeLow: input["active_low"] === true,
      mode: mode === "toggle" ? TOUCH_MODE_TOGGLE : TOUCH_MODE_MOMENTARY,
      exportName: triggerName(typeof input["trigger"] === "string" ? input["trigger"] : undefined),
    },
    why,
  };
}

/** One-line description of a touch config, for the proposal card. */
export function describeTouch(cfg: TouchDriverConfig): string {
  return `TTP223 on GPIO ${cfg.gpio}, ${cfg.activeLow ? "active-low" : "active-high"}, ${
    cfg.mode === TOUCH_MODE_TOGGLE ? "toggle" : "momentary"
  }; trigger "${triggerName(cfg.exportName)}" toggles the lamp`;
}

/** Run one user turn of the sensor assistant: send, execute any tool calls
 * through `exec` (which returns the tool's text result), repeat up to
 * `maxRounds`. `history` already ends with the user's message and is mutated.
 * Returns the assistant's visible text for the turn. */
export async function runSensorTurn(
  provider: Pick<AiProvider, "send" | "capabilities">,
  history: ChatMessage[],
  exec: (name: string, input: Record<string, unknown>) => Promise<{ text: string; error?: boolean }>,
  opts: { maxRounds?: number; signal?: AbortSignal; onText?: (delta: string) => void } = {},
): Promise<string> {
  const tools = provider.capabilities.tools ? SENSOR_TOOLS : [];
  let text = "";
  for (let round = 0; round < (opts.maxRounds ?? 5); round++) {
    const r = await provider.send(history, {
      system: SENSOR_SYSTEM,
      tools,
      signal: opts.signal,
      maxTokens: 1024,
      stream: opts.onText ? { onText: opts.onText } : undefined,
    });
    history.push({ role: "assistant", content: r.content });
    for (const b of r.content) if (b.type === "text") text += (text ? "\n\n" : "") + b.text;
    const calls = r.content.filter((b): b is Extract<ContentBlock, { type: "tool_use" }> => b.type === "tool_use");
    if (calls.length === 0 || r.stop_reason !== "tool_use") return text;
    const results: ContentBlock[] = [];
    for (const c of calls) {
      let out: { text: string; error?: boolean };
      try {
        out = await exec(c.name, c.input);
      } catch (e) {
        out = { text: e instanceof Error ? e.message : String(e), error: true };
      }
      results.push({
        type: "tool_result",
        tool_use_id: c.id,
        content: [{ type: "text", text: out.text }],
        ...(out.error ? { is_error: true } : {}),
      });
    }
    history.push({ role: "user", content: results });
  }
  return text;
}

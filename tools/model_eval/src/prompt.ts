/**
 * Builds the prompt the CPU (wllama) path sends, reusing the app's own pure
 * prompt modules so the eval can't drift from production:
 *   system = compact chat spec + tool instructions   (baseChatSystem + formatToolInstructions)
 *   user   = editor grounding context + "User: <ask>"
 *
 * We advertise the same tools the effect editor does for a fresh authoring chat
 * (set_script; no vision/MIDI/perf noise here) and, OPTIONALLY, an EXPERIMENTAL
 * targeted-edit tool (edit_script) we're evaluating before productizing — it lets
 * a model change a snippet instead of re-emitting the whole program each turn,
 * which is much cheaper on a phone CPU and gives a small model less room to
 * derail. The eval measures whether models actually use it and whether it helps.
 */

import { baseChatSystem, selectTools } from "../../../web/src/effects/ai/chatPrompt";
import { formatToolInstructions } from "../../../web/src/effects/ai/providers/wllamaProtocol";
import type { ToolDef } from "../../../web/src/effects/ai/provider";

/** The blank starting effect a fresh "New effect" opens with — valid + compiles,
 * so the model authors FROM a working baseline, like a real user. */
export const STARTER_SOURCE = `uniform float speed : 0.0 .. 5.0 = 1.0;
void update() {}
vec3 shade(Led led) {
  return vec3(0.0, 0.0, 0.0);
}`;

/** EXPERIMENTAL targeted-edit tool (not yet in the app). str_replace semantics —
 * no line numbers (small models can't count reliably); `find` must be copied
 * verbatim and match exactly once. */
export const EDIT_TOOL: ToolDef = {
  name: "edit_script",
  description:
    "Make a TARGETED edit to the CURRENT script instead of rewriting the whole " +
    "thing: replace an exact snippet with new text. Much cheaper than set_script " +
    "for a small change or a compile fix. `find` must be copied VERBATIM from the " +
    "current script and must appear EXACTLY ONCE (include enough surrounding text " +
    "to be unique). Prefer this over set_script when changing only part of the program.",
  input_schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      find: { type: "string", description: "Exact snippet to replace, copied verbatim from the current script." },
      replace: { type: "string", description: "Replacement text." },
    },
    required: ["find", "replace"],
  },
};

/** Mirror of generate.editorContext for the CPU path (no disassembly). Inlined to
 * avoid importing generate.ts (which pulls the WASM engine). */
export function editorContext(source: string, compileSummary: string): string {
  return `Current editor script:\n\n\`\`\`\n${source}\n\`\`\`\n\nLatest compile result: ${compileSummary}`;
}

export function buildAuthoringPrompt(
  ask: string,
  source: string,
  opts: { edit: boolean } = { edit: false },
): { system: string; user: string } {
  const tools = selectTools({ tools: true, vision: false }, { perf: false, midi: false });
  const allTools: ToolDef[] = opts.edit ? [...tools, EDIT_TOOL] : tools;
  const system = baseChatSystem("wllama") + formatToolInstructions(allTools);
  const user = `${editorContext(source, "OK — compiles.")}\n\nUser: ${ask}`;
  return { system, user };
}

/** Apply an edit_script call to the working source. str_replace with a
 * uniqueness guard, so an ambiguous/absent `find` becomes a clear error the
 * repair loop can feed back (rather than silently corrupting the program). */
export function applyEdit(
  source: string,
  input: Record<string, unknown>,
): { ok: true; next: string } | { ok: false; err: string } {
  const find = String(input["find"] ?? "");
  const replace = String(input["replace"] ?? "");
  if (!find) return { ok: false, err: "edit_script: empty `find`" };
  const count = source.split(find).length - 1;
  if (count === 0) return { ok: false, err: "edit_script: `find` text not present in the current script" };
  if (count > 1) return { ok: false, err: `edit_script: \`find\` matched ${count} times — include more surrounding text so it's unique` };
  return { ok: true, next: source.replace(find, replace) };
}

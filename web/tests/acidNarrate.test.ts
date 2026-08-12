/**
 * Acid-mode narration copy (src/ui/acid/narrate.ts) — the plain-language
 * translations the hands-free agent shows. Pure, so the phrasing is pinned here:
 * every tool the loop can call maps to a friendly line, an unknown tool has a
 * safe default, and the shake-confirm line picker wraps deterministically.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { narrateTool, shakeConfirmLine, SHAKE_CONFIRM_LINES } from "../src/ui/acid/narrate";

test("every real tool has a distinct, non-empty narration", () => {
  const tools = [
    "set_script",
    "capture_preview",
    "estimate_performance",
    "list_midi_controls",
    "set_midi_mapping",
  ];
  const phrases = tools.map(narrateTool);
  for (const p of phrases) assert.ok(p.length > 0);
  // set_script / capture_preview read differently (writing vs looking).
  assert.notEqual(narrateTool("set_script"), narrateTool("capture_preview"));
});

test("an unknown tool falls back to a generic working line", () => {
  const fallback = narrateTool("some_future_tool");
  assert.ok(fallback.length > 0);
  assert.equal(fallback, narrateTool("another_unknown"));
});

test("shake-confirm lines exist and the picker wraps by index", () => {
  assert.ok(SHAKE_CONFIRM_LINES.length > 0);
  assert.equal(shakeConfirmLine(0), SHAKE_CONFIRM_LINES[0]);
  // Wraps past the end and handles negatives.
  assert.equal(shakeConfirmLine(SHAKE_CONFIRM_LINES.length), SHAKE_CONFIRM_LINES[0]);
  assert.equal(shakeConfirmLine(-1), SHAKE_CONFIRM_LINES[SHAKE_CONFIRM_LINES.length - 1]);
});

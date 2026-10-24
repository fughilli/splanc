/**
 * Rate controls in the effect-AI prompts (system-prompt.ts, chatPrompt.ts): a
 * speed/rate uniform multiplying `time` inside a phase makes the effect jump
 * whenever the slider moves, so every prompt states the rule and the
 * integrator idiom, and no worked EXAMPLE teaches the anti-pattern. (The
 * compiler's lint — fx_compiler/src/lint.rs — catches it in generated code.)
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { CHAT_SYSTEM, CHAT_SYSTEM_COMPACT } from "../src/effects/ai/chatPrompt";
import { SYSTEM_PROMPT, SYSTEM_PROMPT_COMPACT } from "../src/effects/ai/system-prompt";

const PROMPTS = { SYSTEM_PROMPT, SYSTEM_PROMPT_COMPACT, CHAT_SYSTEM, CHAT_SYSTEM_COMPACT };

/** The worked EXAMPLE programs of a prompt (header line stripped). */
function examples(prompt: string): string[] {
  const out: string[] = [];
  const re = /EXAMPLE \d+ — [^\n]*\n([\s\S]*?)(?=\n\n|$)/g;
  for (let m = re.exec(prompt); m !== null; m = re.exec(prompt)) out.push(m[1]!);
  return out;
}

test("every prompt states the rate-control rule with the integrator idiom", () => {
  for (const [name, p] of Object.entries(PROMPTS)) {
    assert.match(p, /never `time \* speed`|must NOT multiply `time`/, name);
    assert.ok(p.includes("ph = fract(ph + dt * speed);"), `${name}: integrator idiom`);
    assert.match(p, /jump/, `${name}: says why`);
  }
  // The full prompt also teaches oscillators, non-periodic offsets, fixed point
  // and when plain time is fine.
  for (const s of ["sin(ph * 6.2832)", "drift = drift + dt * speed;", "fract(ph + fixed(dt) * fixed(speed))", "sin(time * 0.7)"]) {
    assert.ok(SYSTEM_PROMPT.includes(s), s);
  }
});

test("no worked example multiplies a uniform by time", () => {
  for (const [name, p] of Object.entries({ SYSTEM_PROMPT, SYSTEM_PROMPT_COMPACT })) {
    const ex = examples(p);
    assert.ok(ex.length >= 3, `${name}: ${ex.length} examples`);
    for (const src of ex) {
      const uniforms = [...src.matchAll(/uniform\s+\w+\s+(\w+)/g)].map((m) => m[1]!);
      for (const u of uniforms) {
        assert.doesNotMatch(src, new RegExp(`\\btime\\s*\\*[^;]*\\b${u}\\b|\\b${u}\\b\\s*\\*\\s*time\\b`), `${name}: ${u}\n${src}`);
      }
    }
  }
});

test("the compact prompts stay compact", () => {
  assert.ok(SYSTEM_PROMPT_COMPACT.length < SYSTEM_PROMPT.length / 2);
  assert.ok(CHAT_SYSTEM_COMPACT.length < CHAT_SYSTEM.length / 2);
});

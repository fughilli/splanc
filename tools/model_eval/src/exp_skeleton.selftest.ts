import { extractFill, assemble } from "/workspace/tools/model_eval/src/exp_skeleton.ts";
import { compile } from "/workspace/tools/model_eval/src/compile";

const cases: [string, string][] = [
  ["clean json", `{"uniforms": ["float speed : 0.0 .. 5.0 = 1.0"], "state": ["float phase"], "update_body": "phase = phase + dt * speed;", "shade_body": "float v = 0.5 + 0.5 * sin(phase + led.s * 6.2832);\\nreturn vec3(v, 0.0, 0.0);"}`],
  ["fenced + prose", "Here is the effect you asked for:\n```json\n{\"uniforms\": [], \"state\": [], \"update_body\": \"\", \"shade_body\": \"return vec3(led.s, 0.0, 1.0 - led.s);\"}\n```\nHope that helps!"],
  ["raw newlines in strings", `{"uniforms": ["float speed : 0.0 .. 5.0 = 1.0"],
"state": [],
"update_body": "",
"shade_body": "float h = fract(led.s + time);
return hsv2rgb(h, 1.0, 1.0);"}`],
  ["truncated json", `{"uniforms": ["float speed : 0.0 .. 5.0 = 1.0"], "state": ["float t"], "update_body": "t = t + dt;", "shade_body": "float v = fract(led.s - t);\\nreturn vec3(v, v, 0.`],
  ["tool-call wrapper", `<tool_call>{"name": "fill", "arguments": {"uniforms": [], "state": [], "update_body": "", "shade_body": "return vec3(1.0, 0.0, 0.0);"}}</tool_call>`],
  ["keywords already in decls", `{"uniforms": ["uniform float speed : 0.0 .. 5.0 = 1.0;"], "state": ["state float phase = 0.5;"], "update_body": "void update() { phase = phase + dt; }", "shade_body": "vec3 shade(Led led) { return vec3(fract(phase), 0.0, 0.0); }"}`],
  ["trailing comma + fence body", `{"uniforms": ["vec3 tint : color = 1.0, 0.2, 0.1"], "state": [], "update_body": "", "shade_body": "return tint * (0.5 + 0.5 * sin(time));",}`],
  ["prose only", "I cannot write that program, sorry."],
];

for (const [name, text] of cases) {
  const r = extractFill(text);
  if ("err" in r) { console.log(`${name}: ERR ${r.err}`); continue; }
  const src = assemble(r.fill);
  const c = compile(src);
  console.log(`${name}: how=${r.how} compile=${c.ok ? "OK" : "FAIL " + c.diagnostics.slice(0, 80)}`);
  if (!c.ok) console.log(src.split("\n").map((l,i)=>`   ${i+1}| ${l}`).join("\n"));
}

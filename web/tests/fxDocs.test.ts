/**
 * The FX editor's Docs pane and selection actions (D-541 PR 6): search and the
 * category index over the compiler's language table, which term "Go to docs"
 * opens for a caret or a selection, the example Insert edit, the rendered
 * term pages, and the desktop right-click menu.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { asFake, fire, installFakeDom, textOf, typeInto, type FakeElement } from "./fakeDom";

installFakeDom();

import {
  docsByCategory,
  exampleIsProgram,
  insertSnippetEdit,
  scopeText,
  searchDocs,
  termAt,
} from "../src/effects/editor/docs";
import { DocsPanel } from "../src/effects/editor/docs-panel";
import { LANG, langEntry } from "../src/effects/editor/lang-spec";
import { SelectionActions, availableActions, type SelectionAction, type SelectionContext } from "../src/effects/editor/selection-actions";

/** `|` marks the caret, `[` `]` a selection. */
function at(s: string): string | null {
  if (s.includes("[")) {
    const a = s.indexOf("[");
    const src = s.replace("[", "").replace("]", "");
    const b = s.indexOf("]") - 1;
    return termAt(src, a, b);
  }
  const c = s.indexOf("|");
  return termAt(s.replace("|", ""), c, c);
}

test("the index lists every table entry exactly once, program first", () => {
  const groups = docsByCategory();
  const names = groups.flatMap((g) => g.entries.map((e) => e.name));
  assert.equal(names.length, LANG.length);
  assert.equal(new Set(names).size, LANG.length);
  assert.equal(groups[0]!.category, "program");
  for (const g of groups) assert.ok(g.label.length > 0 && g.label[0] === g.label[0]!.toUpperCase(), g.label);
});

test("an unknown category from a newer table still shows, after the known ones", () => {
  const extra = { ...LANG[0]!, name: "spin", category: "direction" };
  const groups = docsByCategory([...LANG, extra]);
  assert.equal(groups[groups.length - 1]!.category, "direction");
  assert.equal(groups[groups.length - 1]!.label, "Direction");
});

test("search ranks the exact name first, then prefixes, and needs every word", () => {
  assert.equal(searchDocs("sin")[0]!.name, "sin");
  assert.equal(searchDocs("SMOOTH")[0]!.name, "smoothstep");
  assert.equal(searchDocs("led.pos")[0]!.name, "led.pos");
  const pal = searchDocs("palette").map((e) => e.name);
  assert.equal(pal[0], "palette");
  assert.ok(pal.includes("palette0"));
  // Every word must match: "sine radians" finds sin, "sine zebra" nothing.
  assert.ok(searchDocs("sine radians").some((e) => e.name === "sin"));
  assert.deepEqual(searchDocs("sine zebra"), []);
  assert.deepEqual(searchDocs("   "), []);
  // Category and kind words work too.
  assert.ok(searchDocs("colour").some((e) => e.name === "hsv2rgb"));
  assert.ok(searchDocs("input field").some((e) => e.name === "led.pos"));
});

test("the caret resolves to the documented word under it", () => {
  assert.equal(at("float y = si|n(x);"), "sin");
  assert.equal(at("float y = |sin(x);"), "sin");
  assert.equal(at("float y = sin|(x);"), "sin");
  assert.equal(at("vec3 p = led.p|os;"), "led.pos");
  assert.equal(at("vec3 p = l|ed.pos;"), "led");
  assert.equal(at("vec2 f = led.pos.x|z;"), "swizzle");
  assert.equal(at("float t = ti|me * 0.2;"), "time");
  assert.equal(at("ve|c3 c = vec3(1.0);"), "vec3");
  assert.equal(at("uniform vec3 tint : col|or = 1, 0, 0;"), "color");
  assert.equal(at("uni|form float a : 0 .. 1 = 0.5;"), "uniform");
  assert.equal(at("fixed a = 0.5f|x;"), "fx");
  // `step` in a range annotation is the annotation, not the built-in.
  assert.equal(at("uniform float a : 0 .. 1 st|ep 0.1 = 0.5;"), "range");
  assert.equal(at("float on = st|ep(0.5, led.s);"), "step");
  // User names, numbers and punctuation have no page.
  assert.equal(at("float spe|ed = 1.0;"), null);
  assert.equal(at("float a = 1.|5;"), null);
  assert.equal(at("float a = b |+ c;"), null);
  assert.equal(at("|"), null);
});

test("a selection resolves to the whole term, else the first documented word in it", () => {
  assert.equal(at("float y = [sin](x);"), "sin");
  assert.equal(at("float y = [ smoothstep ](0.0, 1.0, x);"), "smoothstep");
  assert.equal(at("vec3 c = [hsv2rgb(led.s, 1.0, 1.0)];"), "hsv2rgb");
  assert.equal(at("float y = [a * sin(x)];"), "sin");
  assert.equal(at("vec2 f = [led.pos.xz];"), "led.pos");
  assert.equal(at("vec2 f = [p.xz];"), "swizzle");
  assert.equal(at("fixed a = [0.5fx];"), "fx");
  assert.equal(at("float [speed] = 1.0;"), null);
  assert.equal(at("float a = [1.5 + 2.0];"), null);
});

test("every function, type, input and keyword resolves to its own page from the caret", () => {
  for (const e of LANG) {
    if (!["builtin", "type", "context", "member", "keyword"].includes(e.kind)) continue;
    const src = `${e.name}(x)`;
    assert.equal(termAt(src, e.name.length, e.name.length), e.name, e.name);
    assert.equal(termAt(src, 0, e.name.length), e.name, `${e.name} selected`);
  }
});

test("Insert puts a snippet on its own lines above the caret's line, re-indented", () => {
  const src = "vec3 shade(Led led) {\n  return vec3(x);\n}\n";
  const caret = src.indexOf("vec3(x)");
  const e = insertSnippetEdit(src, caret, "float a = 1.0;\nfloat b = a;\n");
  const out = src.slice(0, e.from) + e.text + src.slice(e.to);
  assert.equal(out, "vec3 shade(Led led) {\n  float a = 1.0;\n  float b = a;\n  return vec3(x);\n}\n");
  assert.equal(out.slice(0, e.selStart).endsWith("float b = a;"), true);

  // A blank line is replaced, not pushed down.
  const src2 = "vec3 shade(Led led) {\n    \n  return c;\n}";
  const e2 = insertSnippetEdit(src2, src2.indexOf("    ") + 2, "vec3 c = vec3(1.0);");
  assert.equal(src2.slice(0, e2.from) + e2.text + src2.slice(e2.to), "vec3 shade(Led led) {\n    vec3 c = vec3(1.0);\n  return c;\n}");
  assert.equal(e2.selStart, e2.selEnd);
});

test("whole-program examples are told apart from snippets", () => {
  assert.equal(exampleIsProgram(langEntry("shade")!.example), true);
  assert.equal(exampleIsProgram(langEntry("sin")!.example), true); // it declares a uniform
  assert.equal(exampleIsProgram(langEntry("led.pos")!.example), false);
  assert.equal(exampleIsProgram(langEntry("step")!.example), false);
  assert.equal(exampleIsProgram("float a = 1.0;\nif (a > 0.5) { a = 0.0; }"), false);
});

test("scope sentences cover the restricted scopes only", () => {
  assert.equal(scopeText("any"), "");
  assert.match(scopeText("update"), /update\(\)/);
  assert.match(scopeText("driver"), /poll\(\)/);
  assert.match(scopeText("reserved"), /Reserved/);
});

test("every related name in the table has a page (no dead links)", () => {
  for (const e of LANG) for (const r of e.related) assert.ok(langEntry(r), `${e.name} -> ${r}`);
});

// ---- the panel --------------------------------------------------------------

function panel(): { p: DocsPanel; inserted: string[]; copied: string[]; node: FakeElement } {
  const inserted: string[] = [];
  const copied: string[] = [];
  const p = new DocsPanel({ onInsert: (s) => inserted.push(s), onCopy: (s) => copied.push(s) });
  document.body.appendChild(p.node);
  return { p, inserted, copied, node: asFake(p.node) };
}

const buttonNamed = (root: FakeElement, label: string): FakeElement => {
  const b = root.querySelectorAll("button").find((x) => textOf(x) === label);
  assert.ok(b, `button "${label}" in: ${root.querySelectorAll("button").map((x) => textOf(x)).join(" | ")}`);
  return b;
};

test("the panel's index shows every term; search narrows it and Enter opens the top hit", () => {
  const { p, node } = panel();
  assert.equal(node.querySelectorAll(".fxdocs-row").length, LANG.length);
  const search = node.querySelector("input")!;
  typeInto(search, "smoothst");
  const rows = node.querySelectorAll(".fxdocs-row");
  assert.equal(rows[0]!.dataset["term"], "smoothstep");
  fire(search, "keydown", { key: "Enter" });
  assert.equal(p.term, "smoothstep");
  typeInto(search, "zebra");
  assert.match(textOf(node.querySelector(".fxdocs-count")), /Nothing matches/);
});

test("a term page shows signature, docs, cost, example actions and related links", () => {
  const { p, inserted, copied, node } = panel();
  p.show("led.pos");
  assert.equal(textOf(node.querySelector(".fxdocs-title")), "led.pos");
  assert.match(textOf(node.querySelector(".fxdocs-badges")), /input field/);
  assert.match(textOf(node.querySelector(".fxdocs-badges")), /vec3/);
  // A snippet example: Insert and Copy.
  fire(buttonNamed(node, "Insert"), "click");
  assert.deepEqual(inserted, [langEntry("led.pos")!.example]);
  fire(buttonNamed(node, "Copy"), "click");
  assert.deepEqual(copied, [langEntry("led.pos")!.example]);

  // A built-in with a cost hint and a scope restriction.
  p.show("flood_from");
  assert.match(textOf(node.querySelector(".fxdocs-facts")), /update\(\) or init\(\)/);
  assert.ok(node.querySelector(".fxdocs-sig"));

  // A whole-program example offers Copy only.
  p.show("sin");
  assert.match(textOf(node.querySelector(".fxdocs-facts")), /Cost on the lamp/);
  assert.equal(node.querySelectorAll("button").some((b) => textOf(b) === "Insert"), false);
  assert.match(textOf(node.querySelector(".fxdocs-note")), /whole effect/);

  // Related chips navigate; Back walks the history, then to the index.
  fire(buttonNamed(node, "cos"), "click");
  assert.equal(p.term, "cos");
  fire(buttonNamed(node, "Back to sin"), "click");
  assert.equal(p.term, "sin");
  fire(buttonNamed(node, "Back to flood_from"), "click");
  assert.equal(p.term, "flood_from");
  fire(buttonNamed(node, "Back to led.pos"), "click");
  fire(buttonNamed(node, "All terms"), "click");
  assert.equal(p.term, null);
  assert.equal(node.querySelectorAll(".fxdocs-row").length, LANG.length);
});

test("an unknown term falls back to a search for it", () => {
  const { p, node } = panel();
  p.show("hsv");
  assert.equal(p.term, null);
  assert.equal((node.querySelector("input") as unknown as { value: string }).value, "hsv");
  assert.ok(node.querySelectorAll(".fxdocs-row").some((r) => r.dataset["term"] === "hsv2rgb"));
});

// ---- selection actions ------------------------------------------------------

const ctx = (term: string | null): SelectionContext => ({ src: "", start: 0, end: 0, text: "", term });

test("actions offer themselves only where they apply", () => {
  const docs: SelectionAction = {
    id: "docs",
    icon: "info",
    label: (c) => `Docs: ${c.term}`,
    available: (c) => c.term !== null,
    run: () => undefined,
  };
  const always: SelectionAction = { ...docs, id: "watch", available: () => true };
  assert.deepEqual(availableActions([docs, always], ctx("sin")).map((a) => a.id), ["docs", "watch"]);
  assert.deepEqual(availableActions([docs, always], ctx(null)).map((a) => a.id), ["watch"]);
});

test("right-click on a documented word opens the menu; elsewhere the browser keeps its own", () => {
  const code = document.createElement("textarea");
  const wrap = document.createElement("div");
  wrap.appendChild(code);
  document.body.appendChild(wrap);
  let term: string | null = "sin";
  const ran: string[] = [];
  const sa = new SelectionActions({
    code,
    wrap,
    caretPixel: () => ({ left: 0, top: 0, lineH: 18 }),
    context: () => ({ src: "sin(x)", start: 1, end: 1, text: "", term }),
    actions: () => [
      {
        id: "docs",
        icon: "info",
        label: (c) => `Docs: ${c.term}`,
        available: (c) => c.term !== null,
        run: (c) => ran.push(c.term!),
      },
    ],
  });
  try {
    fire(code, "pointerdown", { pointerType: "mouse" });
    const ev = fire(code, "contextmenu", { clientX: 10, clientY: 10 });
    assert.equal(ev.defaultPrevented, true);
    const menu = asFake(document.body).querySelector(".fxsel-menu")!;
    assert.ok(menu);
    assert.match(textOf(menu), /Docs: sin/);
    assert.match(textOf(menu), /Paste/);
    assert.doesNotMatch(textOf(menu), /Cut/); // nothing selected
    fire(buttonNamed(menu, "Docs: sin"), "click");
    assert.deepEqual(ran, ["sin"]);
    assert.equal(asFake(document.body).querySelector(".fxsel-menu"), null);

    // Shift+right-click, or no documented word: the native menu.
    assert.equal(fire(code, "contextmenu", { shiftKey: true }).defaultPrevented, false);
    term = null;
    assert.equal(fire(code, "contextmenu", {}).defaultPrevented, false);
    // A touch long-press (Android fires contextmenu) is left to the chip.
    term = "sin";
    fire(code, "pointerdown", { pointerType: "touch" });
    assert.equal(fire(code, "contextmenu", {}).defaultPrevented, false);
  } finally {
    sa.dispose();
    wrap.remove();
  }
});

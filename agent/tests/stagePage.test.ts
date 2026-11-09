/**
 * The stage page's own script (src/stage/page.ts), run in a VM against a small
 * stand-in DOM and fed real server-sent events from a StageBus: what the
 * conversation pane and the tool cards show on first load, after reconnects
 * (EventSource replays the catch-up on every attach), after a reload mid-turn,
 * and while the voice is still synthesizing.
 *
 * #449: every reconnect appended the whole history again (cards 3 -> 6 -> 8).
 * #445: a reload after a long turn lost its prompt and reply (the history kept
 * only the last 400 streaming deltas), and with the voice on the reply stayed
 * blank until each sentence had been synthesized.
 */

import assert from "node:assert/strict";
import type { ServerResponse } from "node:http";
import { test } from "node:test";
import { createContext, runInContext } from "node:vm";

import { StageBus, type StageEvent } from "../src/stage/bus";
import { STAGE_PAGE } from "../src/stage/page";

// ---- a small DOM ---------------------------------------------------------------

class El {
  id = "";
  className = "";
  hidden = false;
  disabled = false;
  value = "";
  title = "";
  scrollTop = 0;
  offsetTop = 0;
  offsetHeight = 0;
  clientHeight = 100;
  clientWidth = 100;
  children: El[] = [];
  parentNode: El | null = null;
  dataset: Record<string, string> = {};
  style: Record<string, string> = {};
  attrs: Record<string, string> = {};
  onclick: unknown = null;
  private text = "";
  private html: string | null = null;
  readonly classList = {
    add: (c: string) => this.setClass(c, true),
    remove: (c: string) => this.setClass(c, false),
    toggle: (c: string, on?: boolean) => this.setClass(c, on ?? !this.classes().includes(c)),
    contains: (c: string) => this.classes().includes(c),
  };
  constructor(readonly tagName = "div") {}
  private classes(): string[] {
    return this.className.split(/\s+/).filter(Boolean);
  }
  private setClass(c: string, on: boolean): boolean {
    const set = new Set(this.classes());
    if (on) set.add(c);
    else set.delete(c);
    this.className = [...set].join(" ");
    return on;
  }
  get firstChild(): El | null {
    return this.children[0] ?? null;
  }
  appendChild(c: El): El {
    if (c.parentNode) c.parentNode.removeChild(c);
    c.parentNode = this;
    this.children.push(c);
    return c;
  }
  removeChild(c: El): El {
    this.children = this.children.filter((x) => x !== c);
    c.parentNode = null;
    return c;
  }
  remove(): void {
    this.parentNode?.removeChild(this);
  }
  set textContent(t: string) {
    this.text = String(t);
    this.html = null;
    this.children = [];
  }
  get textContent(): string {
    if (this.html !== null) return unhtml(this.html);
    return this.text + this.children.map((c) => c.textContent).join("");
  }
  /** innerHTML: kept as text; elements with a class become (flat) children so
   * querySelector(".sub") finds them, as the cards need. */
  set innerHTML(h: string) {
    this.children = [];
    this.text = "";
    const parts = [...h.matchAll(/<(\w+) class="([^"]*)">(.*?)<\/\1>/g)];
    if (parts.length && h.startsWith("<div class=")) {
      this.html = null;
      for (const m of parts) {
        const c = new El(m[1]);
        c.className = m[2]!;
        c.innerHTML = m[3]!;
        this.appendChild(c);
      }
    } else this.html = h;
  }
  get innerHTML(): string {
    return this.html ?? this.text;
  }
  querySelector(sel: string): El | null {
    if (!sel.startsWith(".")) return null;
    const want = sel.slice(1);
    for (const c of this.children) {
      if (c.classList.contains(want)) return c;
      const d = c.querySelector(sel);
      if (d) return d;
    }
    return null;
  }
  querySelectorAll(): El[] {
    return [];
  }
  setAttribute(k: string, v: string): void {
    this.attrs[k] = v;
  }
  getAttribute(k: string): string | null {
    return this.attrs[k] ?? null;
  }
  removeAttribute(k: string): void {
    delete this.attrs[k];
  }
  addEventListener(): void {}
  focus(): void {}
  blur(): void {}
  scrollTo(): void {}
}

function unhtml(h: string): string {
  return h.replace(/<[^>]*>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

interface Page {
  el: (id: string) => El;
  /** One EventSource connection: deliver a server's SSE text to it. */
  connect: () => (sse: string) => void;
  spoken: string[];
}

/** Load the page's main script; `voice`: a system voice that never finishes speaking. */
function loadPage(opts: { voice?: boolean } = {}): Page {
  const els = new Map<string, El>();
  const el = (id: string): El => {
    let e = els.get(id);
    if (!e) {
      e = new El();
      e.id = id;
      els.set(id, e);
    }
    return e;
  };
  const sources: { on: Map<string, (m: { data: string }) => void> }[] = [];
  const spoken: string[] = [];
  const storage = new Map<string, string>();
  const g: Record<string, unknown> = {
    document: {
      getElementById: el,
      createElement: (t: string) => new El(t),
      querySelectorAll: () => [],
      addEventListener: () => undefined,
    },
    location: { search: "", protocol: "http:", hostname: "localhost" },
    navigator: { language: "en-US" },
    localStorage: {
      getItem: (k: string) => storage.get(k) ?? null,
      setItem: (k: string, v: string) => void storage.set(k, v),
    },
    URLSearchParams,
    atob: (s: string) => Buffer.from(s, "base64").toString("binary"),
    setInterval: () => 0,
    setTimeout: () => 0,
    clearTimeout: () => undefined,
    requestAnimationFrame: () => 0,
    fetch: async () => ({ json: async () => ({}) }),
    addEventListener: () => undefined,
    EventSource: class {
      on = new Map<string, (m: { data: string }) => void>();
      constructor() {
        sources.push(this);
      }
      addEventListener(k: string, f: (m: { data: string }) => void) {
        this.on.set(k, f);
      }
    },
  };
  if (opts.voice) {
    g["speechSynthesis"] = {
      getVoices: () => [],
      addEventListener: () => undefined,
      cancel: () => undefined,
      resume: () => undefined,
      speak: (u: { text: string }) => void spoken.push(u.text), // and never ends
    };
    g["SpeechSynthesisUtterance"] = class {
      constructor(readonly text: string) {}
    };
  }
  g["window"] = g;
  const ctx = createContext(g);
  const at = STAGE_PAGE.indexOf("<script>\n(function () {");
  const script = STAGE_PAGE.slice(at + "<script>".length, STAGE_PAGE.indexOf("</script>", at));
  runInContext(script, ctx);
  return {
    el,
    spoken,
    connect: () => {
      // The page opened its EventSource at load; a reconnect is the same source
      // reopening (EventSource does that itself).
      const es = sources[0]!;
      es.on.get("open")?.({ data: "" });
      return (sse: string) => {
        for (const block of sse.split("\n\n")) {
          let type = "message";
          let data = "";
          for (const line of block.split("\n")) {
            if (line.startsWith("event: ")) type = line.slice(7);
            else if (line.startsWith("data: ")) data += line.slice(6);
          }
          if (data) es.on.get(type)?.({ data });
        }
      };
    },
  };
}

// ---- a bus whose screens we can read ---------------------------------------------

class Screen {
  text = "";
  closed: (() => void) | undefined;
  readonly res = {
    writeHead: () => this.res,
    write: (s: string) => {
      this.text += s;
      return true;
    },
    on: (k: string, f: () => void) => {
      if (k === "close") this.closed = f;
      return this.res;
    },
  };
  /** What arrived since last time. */
  take(): string {
    const t = this.text;
    this.text = "";
    return t;
  }
}

function attach(bus: StageBus): Screen {
  const s = new Screen();
  bus.attach(s.res as unknown as ServerResponse);
  return s;
}

const cards = (p: Page) => p.el("steps").children.filter((c) => !c.classList.contains("note"));
const cardNames = (p: Page) => cards(p).map((c) => c.querySelector(".nm")!.textContent);

function toolTurn(bus: StageBus, ids: [string, string][]): void {
  bus.emit({ type: "prompt", text: "make it a sunny hillside", request: 1 });
  bus.emit({ type: "say_start" });
  bus.emit({ type: "say", text: "Golden hour on the hill." });
  for (const [id, name] of ids) {
    bus.emit({ type: "tool_call", id, name, args: {} });
    bus.emit({ type: "tool_result", id, name, ok: true, ms: 40, text: "{}", images: [] });
  }
}

// ---- tests -----------------------------------------------------------------------------

test("reconnecting replays the catch-up without duplicating tool cards (#449)", () => {
  const bus = new StageBus();
  toolTurn(bus, [
    ["t1", "compile_effect"],
    ["t2", "crossfade_to"],
    ["t3", "set_uniforms"],
  ]);
  const page = loadPage();
  for (let i = 0; i < 4; i++) {
    // A first load, then EventSource reconnecting on its own three times.
    const s = attach(bus);
    page.connect()(s.take());
    s.closed?.();
    assert.equal(cards(page).length, 3, `after attach ${i + 1}: ${cardNames(page).join(", ")}`);
  }
  assert.deepEqual(cardNames(page), ["Compilecompile_effect", "Crossfadecrossfade_to", "Turn knobsset_uniforms"]);
  assert.ok(cards(page).every((c) => c.className === "step ok"), "each card shows its result");
  assert.equal(page.el("said").textContent, "make it a sunny hillside");
  assert.equal(page.el("reply").textContent, "Golden hour on the hill.", "the reply is not appended twice");
});

test("a live event delivered twice, or a repeated tool call, keeps one card", () => {
  const bus = new StageBus();
  const page = loadPage();
  const s = attach(bus);
  const deliver = page.connect();
  deliver(s.take());
  toolTurn(bus, [["t1", "deploy_effect"]]);
  const live = s.take();
  deliver(live);
  deliver(live); // the same events again (same seq): ignored
  bus.emit({ type: "tool_call", id: "t1", name: "deploy_effect", args: {} }); // same tool id: redrawn in place
  deliver(s.take());
  assert.equal(cards(page).length, 1);
  assert.equal(page.el("reply").textContent, "Golden hour on the hill.");
});

test("the 8-card limit drops the oldest cards and forgets them", () => {
  const bus = new StageBus();
  const ids: [string, string][] = [];
  for (let i = 1; i <= 11; i++) ids.push([`t${i}`, "set_uniforms"]);
  toolTurn(bus, ids);
  const page = loadPage();
  for (let i = 0; i < 2; i++) page.connect()(attach(bus).take());
  assert.deepEqual(
    cards(page).map((c) => c.dataset["id"]),
    ["t4", "t5", "t6", "t7", "t8", "t9", "t10", "t11"],
  );
  // A result for a card that scrolled away doesn't resurrect or break anything.
  const s = attach(bus);
  const deliver = page.connect();
  deliver(s.take());
  bus.emit({ type: "tool_result", id: "t1", name: "set_uniforms", ok: true, ms: 1, text: "{}", images: [] });
  deliver(s.take());
  assert.equal(cards(page).length, 8);
  assert.equal(cards(page)[0]!.dataset["id"], "t4");
});

test("a page loaded after a long turn shows its prompt and the whole reply (#445)", () => {
  const bus = new StageBus();
  bus.emit({ type: "prompt", text: "an earlier look", request: 1 });
  bus.emit({ type: "say", text: "Earlier reply." });
  bus.emit({ type: "turn_end", request: 1 });
  // A realistic authoring turn: hundreds of streaming deltas.
  bus.emit({ type: "prompt", text: "make all the fixtures a grassy hillside in the late afternoon", request: 2 });
  bus.emit({ type: "thinking_start" });
  for (let i = 0; i < 500; i++) bus.emit({ type: "thinking", text: `step ${i}, ` });
  bus.emit({ type: "say_start" });
  const words = "Late sun on a grassy hill, coming up now. ".match(/.{1,5}/g)!;
  for (const w of words) bus.emit({ type: "say", text: w });
  bus.emit({ type: "tool_writing", id: "t1", name: "compile_effect" });
  let src = "";
  for (let i = 0; i < 120; i++) {
    src += `float a${i} = ${i}.0;\n`;
    bus.emit({ type: "code", id: "t1", tool: "compile_effect", source: src, done: false });
  }
  bus.emit({ type: "code", id: "t1", tool: "compile_effect", source: src, done: true });
  bus.emit({ type: "tool_call", id: "t1", name: "compile_effect", args: {} });
  for (let i = 0; i < 50; i++) bus.emit({ type: "tool_progress", id: "t1", text: `compiling ${i}` });
  bus.emit({ type: "tool_result", id: "t1", name: "compile_effect", ok: true, ms: 40, text: "{}", images: [] });
  for (let i = 0; i < 300; i++) bus.emit({ type: "thinking", text: "more " });

  const kept = bus.events();
  assert.ok(kept.length < 30, `compacted: ${kept.length} events kept for ~1000 emitted`);
  const page = loadPage();
  page.connect()(attach(bus).take());
  assert.equal(page.el("said").textContent, "make all the fixtures a grassy hillside in the late afternoon");
  assert.equal(page.el("reply").textContent, words.join(""));
  assert.deepEqual(cardNames(page), ["Compilecompile_effect"]);
});

test("history trimming keeps whole turns, and the current turn's prompt", () => {
  const bus = new StageBus();
  for (let t = 1; t <= 40; t++) {
    bus.emit({ type: "prompt", text: `turn ${t}`, request: t });
    for (let i = 0; i < 20; i++) bus.emit({ type: "note", text: `turn ${t} note ${i}` });
  }
  let kept = bus.events();
  assert.ok(kept.length <= 400);
  assert.equal(kept[0]!.type, "prompt", "the history starts at a turn");
  // One turn longer than the whole history: its prompt stays first.
  bus.emit({ type: "prompt", text: "the long one", request: 99 });
  for (let i = 0; i < 1000; i++) bus.emit({ type: "note", text: `n${i}` });
  kept = bus.events();
  assert.ok(kept.length <= 400, String(kept.length));
  assert.deepEqual([kept[0]!.type, kept[0]!["text"]], ["prompt", "the long one"]);
  assert.equal(kept.at(-1)!["text"], "n999");
  const seqs = kept.map((e) => e["seq"] as number);
  assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b), "in order");
});

test("with the voice on, the reply shows as it arrives, before it is spoken (#445)", () => {
  const bus = new StageBus();
  const page = loadPage({ voice: true });
  const s = attach(bus);
  const deliver = page.connect();
  deliver(s.take());
  bus.emit({ type: "prompt", text: "warmer please", request: 1 });
  bus.emit({ type: "say_start" });
  for (const w of ["Warming ", "it up. ", "Amber ", "now"]) bus.emit({ type: "say", text: w });
  deliver(s.take());
  assert.equal(page.el("reply").textContent, "Warming it up. Amber now", "all of it on screen (unspoken part dim)");
  assert.deepEqual(page.spoken, ["Warming it up."], "the voice speaks whole sentences");
});

test("the request badge follows the newest request", () => {
  const bus = new StageBus();
  const page = loadPage();
  const s = attach(bus);
  const deliver = page.connect();
  deliver(s.take());
  const req = (id: number, state: string, more: Record<string, unknown> = {}) =>
    bus.emit({ type: "request", id, text: `r${id}`, state, ...more } as StageEvent);
  req(1, "queued");
  req(1, "generating");
  req(1, "deploying", { tool: "crossfade_to" });
  deliver(s.take());
  assert.equal(page.el("req").textContent, "#1 · deploying");
  req(2, "queued");
  req(1, "superseded", { by: 2 });
  deliver(s.take());
  assert.equal(page.el("req").textContent, "#2 · queued", "an older request doesn't take the badge back");
  req(2, "running", { tool: "search_effects" });
  deliver(s.take());
  assert.equal(page.el("req").textContent, "#2 · search library");
  req(2, "failed", { detail: "no players" });
  deliver(s.take());
  assert.equal(page.el("req").textContent, "#2 · failed");
  assert.match(page.el("req").className, /err/);
  // A reload shows the same.
  const fresh = loadPage();
  fresh.connect()(attach(bus).take());
  assert.equal(fresh.el("req").textContent, "#2 · failed");
});

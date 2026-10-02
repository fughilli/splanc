/**
 * AI chat replies render as Markdown (src/ui/markdown.ts, FUG-52). The effect
 * editor's chat shows every assistant reply through renderMarkdown (user and tool
 * rows stay literal), so this suite pins what a user actually sees: the subset of
 * Markdown models emit — headings, emphasis, inline + fenced code, lists, quotes,
 * rules, links, line breaks — becomes real DOM structure instead of literal
 * `**`/`#`/backtick noise; model text can never turn into live markup (it is
 * untrusted: it can echo user/tool content); prose identifiers aren't mangled
 * into emphasis; and anything unsupported or unterminated still renders as
 * readable text rather than vanishing or throwing.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { installFakeDom, asFake, textOf, type FakeElement } from "./fakeDom";

installFakeDom();

import { renderMarkdown } from "../src/ui/markdown";

/** Render `md` into a host element (what the chat bubble does) and return it. */
function bubble(md: string): FakeElement {
  const host = asFake(document.createElement("div"));
  host.appendChild(renderMarkdown(md) as unknown as FakeElement);
  return host;
}

test("an assistant reply's Markdown renders as structured, readable DOM [rr:PR-6]", () => {
  const reply = [
    "# Plan",
    "",
    "Make it **bold**, *calm* and `fast`.",
    "Second line of the same paragraph.",
    "",
    "- one",
    "- two",
    "",
    "1. first",
    "2. second",
    "",
    "> quoted **note**",
    "",
    "---",
    "",
    "```glsl",
    "vec3 shade(Led l) { return l.pos * 2.0; } // **not bold** <b>",
    "```",
  ].join("\n");
  const host = bubble(reply);

  // The exact block/inline structure (fakeDom serializes elements + escaped text).
  assert.equal(
    host.innerHTML,
    "<h1>Plan</h1>" +
      "<p>Make it <strong>bold</strong>, <em>calm</em> and <code>fast</code>." +
      "<br></br>Second line of the same paragraph.</p>" +
      "<ul><li>one</li><li>two</li></ul>" +
      "<ol><li>first</li><li>second</li></ol>" +
      "<blockquote><p>quoted <strong>note</strong></p></blockquote>" +
      "<hr></hr>" +
      '<pre><code class="language-glsl">vec3 shade(Led l) { return l.pos * 2.0; } // **not bold** &lt;b></code></pre>',
  );

  // Code is shown verbatim: no emphasis parsed inside it, markup kept as text.
  const code = host.querySelector("pre code")!;
  assert.equal(code.textContent, "vec3 shade(Led l) { return l.pos * 2.0; } // **not bold** <b>");
  assert.equal(code.querySelectorAll("strong, b").length, 0);
  // No literal Markdown punctuation leaks into the readable text.
  const prose = textOf(host.querySelector("p"));
  assert.doesNotMatch(prose, /\*\*|`/);
});

test("model text can't inject markup: raw HTML stays literal and unsafe links lose their href [rr:PR-6]", () => {
  const reply =
    'Try <img src=x onerror="alert(1)"> or <script>steal()</script> now.\n\n' +
    "[click me](javascript:alert(1)) [data](data:text/html,hi) " +
    '[docs](https://example.com/fx "Docs") [mail](mailto:a@b.c) [top](#top) [rel](/guide)';
  const host = bubble(reply);

  // Nothing the model wrote became an element other than the safe structure.
  for (const tag of ["img", "script", "iframe"]) assert.equal(host.querySelectorAll(tag).length, 0, tag);
  const first = host.querySelector("p")!;
  assert.equal(first.textContent, 'Try <img src=x onerror="alert(1)"> or <script>steal()</script> now.');
  assert.equal(first.children.length, 0, "the injection attempt is one plain text run");

  // javascript:/data: links render their label as text, never as an <a>.
  const links = host.querySelectorAll("a");
  assert.deepEqual(
    links.map((a) => [a.textContent, a.getAttribute("href")]),
    [
      ["docs", "https://example.com/fx"],
      ["mail", "mailto:a@b.c"],
      ["top", "#top"],
      ["rel", "/guide"],
    ],
  );
  assert.match(textOf(host), /click me/);
  assert.match(textOf(host), /\bdata\b/);
  assert.ok(links.every((a) => !/^(javascript|data):/i.test(a.getAttribute("href") ?? "")));
  // External links open in a new tab without handing the page an opener.
  for (const a of links) {
    assert.equal(a.getAttribute("target"), "_blank");
    assert.equal(a.getAttribute("rel"), "noopener noreferrer");
  }
});

test("identifiers and code in prose stay literal (no spurious emphasis) [rr:PR-6]", () => {
  const host = bubble("Set `led_count` from max_led_count, then __really__ mean it and _only_ that.");
  const p = host.querySelector("p")!;
  // snake_case words are not italicized; the code span keeps its underscore.
  assert.match(p.textContent, /from max_led_count, then/);
  assert.equal(p.querySelector("code")?.textContent, "led_count");
  // Real word-bounded emphasis still works.
  assert.deepEqual(
    p.querySelectorAll("strong, em").map((e) => [e.localName, e.textContent]),
    [
      ["strong", "really"],
      ["em", "only"],
    ],
  );
});

test("unterminated or unsupported Markdown degrades to readable text [rr:PR-6]", () => {
  // An unterminated fence still shows the code (to the end of the reply).
  const fence = bubble("Here:\n```\nvoid update() {}\nvec3 shade(Led l) { return vec3(1.0); }");
  assert.equal(fence.querySelector("p")?.textContent, "Here:");
  assert.equal(fence.querySelector("pre code")?.textContent, "void update() {}\nvec3 shade(Led l) { return vec3(1.0); }");

  // Unclosed emphasis and unsupported table syntax render as plain text.
  const loose = bubble("**not closed\n\n_open underscore\n\n| a | b |\n|---|---|");
  assert.equal(loose.querySelectorAll("strong, em").length, 0);
  assert.deepEqual(
    loose.querySelectorAll("p").map((p) => p.innerHTML),
    ["**not closed", "_open underscore", "| a | b |<br></br>|---|---|"],
  );

  // Windows line endings are normalized (one paragraph, one line break).
  const crlf = bubble("line one\r\nline two");
  assert.equal(crlf.innerHTML, "<p>line one<br></br>line two</p>");

  // An empty reply renders nothing (no stray empty paragraph).
  assert.equal(bubble("").childNodes.length, 0);
});

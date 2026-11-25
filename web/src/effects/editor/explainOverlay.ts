/**
 * The explain layer of the code editor (D-541 PR 7): the same text as the
 * textarea, transparent, drawn over the highlighted backdrop, with the
 * walkthrough's marks painted on it (explain.ts ExplainMark):
 * - band: a tinted band with a stripe on each line (a single-line `match`
 *   tints just the matched text instead);
 * - box: an outline around the lines;
 * - underline: a wavy underline under the matched text;
 * - scroll: nothing drawn, the lines are only brought into view;
 * - note: a small label under the mark's last line.
 *
 * Pure string building, like diagnosticsHtml (editing.ts), so it is unit-tested.
 */

import type { ExplainMark } from "../ai/explain";

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** The marks' HTML over `src`. The element `.fxexp-target` sits at the start of
 * the last mark's first line (the scroll target); a span mark's text is also
 * `.fxexp-span` (for horizontal scrolling). Empty when there are no marks. */
export function explainHtml(src: string, marks: readonly ExplainMark[]): string {
  if (marks.length === 0) return "";
  const lines = src.split("\n");
  const target = marks[marks.length - 1]!;
  let out = "";
  lines.forEach((line, idx) => {
    const n = idx + 1;
    const cls: string[] = [];
    let span: ExplainMark | undefined;
    let note = "";
    for (const m of marks) {
      if (n < m.from || n > m.to) continue;
      const single = m.span !== undefined && m.from === m.to;
      if (single && m.style !== "scroll") span = m;
      if (m.style === "band" && !single) cls.push("fxexp-band", `fxexp-c-${m.color}`);
      else if (m.style === "box") {
        cls.push("fxexp-box", `fxexp-c-${m.color}`);
        if (n === m.from) cls.push("fxexp-top");
        if (n === m.to) cls.push("fxexp-bot");
      }
      if (n === m.to && m.note) {
        note += `<span class="fxexp-noteat"><span class="fxexp-note fxexp-c-${m.color}">${esc(m.note)}</span></span>`;
      }
    }
    let body: string;
    if (span?.span && span.span[0] < line.length) {
      const a = span.span[0];
      const b = Math.min(line.length, span.span[1]);
      const kind = span.style === "underline" ? "fxexp-ul" : "fxexp-hl";
      body = `${esc(line.slice(0, a))}<span class="fxexp-span ${kind} fxexp-c-${span.color}">${esc(line.slice(a, b))}</span>${esc(line.slice(b))}`;
    } else body = esc(line);
    const at = n === target.from ? '<span class="fxexp-target"></span>' : "";
    const lead = at + note;
    if (cls.length > 0) out += `<span class="fxexp-line ${[...new Set(cls)].join(" ")}">${lead}${body || "​"}</span>`;
    else out += lead + body;
    if (idx < lines.length - 1) out += "\n";
  });
  return out;
}

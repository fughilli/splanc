/**
 * Minimal, zero-dependency Markdown → DOM renderer for chat messages.
 *
 * The AI chat (see effectEditor.ts) previously rendered assistant replies as
 * plain text, so **bold**, lists, `code`, etc. showed up as literal markup.
 * This renders a useful subset of CommonMark to real DOM nodes.
 *
 * Design constraints:
 *  - No dependency (the web build is offline/pnpm+bazel; adding `marked` +
 *    a sanitizer isn't worth it for a chat bubble).
 *  - XSS-safe BY CONSTRUCTION: every node is built with createElement and text
 *    goes through textContent — we never assign innerHTML. Assistant output is
 *    untrusted (it's model text that can echo user/tool content), so we don't
 *    rely on a separate sanitizer pass. Link hrefs are scheme-checked.
 *
 * Supported: ATX headings, fenced code blocks, blockquotes, unordered and
 * ordered lists (one level), horizontal rules, paragraphs, and the inline
 * spans bold, italic, inline code, and links. Unsupported syntax degrades to
 * plain text rather than throwing.
 */

/** Render `src` markdown into a fragment of DOM nodes. */
export function renderMarkdown(src: string): DocumentFragment {
  const frag = document.createDocumentFragment();
  const lines = src.replace(/\r\n?/g, "\n").split("\n");

  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;

    // Blank line — skip; block boundaries are handled per-block below.
    if (line.trim() === "") {
      i++;
      continue;
    }

    // Fenced code block: ```lang ... ```
    const fence = /^\s*```(.*)$/.exec(line);
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i]!)) {
        body.push(lines[i]!);
        i++;
      }
      i++; // consume closing fence (or run off the end)
      const pre = document.createElement("pre");
      const code = document.createElement("code");
      const lang = fence[1]!.trim();
      if (lang) code.className = `language-${lang.replace(/[^\w-]/g, "")}`;
      code.textContent = body.join("\n");
      pre.appendChild(code);
      frag.appendChild(pre);
      continue;
    }

    // ATX heading: #..###### text
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const level = heading[1]!.length;
      const h = document.createElement(`h${level}`);
      renderInline(heading[2]!.replace(/\s+#+\s*$/, ""), h);
      frag.appendChild(h);
      i++;
      continue;
    }

    // Horizontal rule: ---, ***, ___ (3+).
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      frag.appendChild(document.createElement("hr"));
      i++;
      continue;
    }

    // Blockquote: consecutive `>` lines.
    if (/^\s*>/.test(line)) {
      const quoted: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i]!)) {
        quoted.push(lines[i]!.replace(/^\s*>\s?/, ""));
        i++;
      }
      const bq = document.createElement("blockquote");
      // Recurse so a quote can itself contain lists/paragraphs.
      bq.appendChild(renderMarkdown(quoted.join("\n")));
      frag.appendChild(bq);
      continue;
    }

    // Lists: a run of consecutive bullet (-,*,+) or ordered (1.) items. The
    // whole run must share a kind; a switch ends the list.
    const listMatch = matchListItem(line);
    if (listMatch) {
      const ordered = listMatch.ordered;
      const list = document.createElement(ordered ? "ol" : "ul");
      while (i < lines.length) {
        const m = matchListItem(lines[i]!);
        if (!m || m.ordered !== ordered) break;
        const li = document.createElement("li");
        renderInline(m.text, li);
        list.appendChild(li);
        i++;
      }
      frag.appendChild(list);
      continue;
    }

    // Otherwise a paragraph: gather until a blank line or a block starter.
    const para: string[] = [];
    while (i < lines.length && lines[i]!.trim() !== "" && !startsBlock(lines[i]!)) {
      para.push(lines[i]!);
      i++;
    }
    const p = document.createElement("p");
    renderInline(para.join("\n"), p);
    frag.appendChild(p);
  }

  return frag;
}

interface ListItem {
  ordered: boolean;
  text: string;
}

/** Match a top-level list item, returning its kind and content, else null. */
function matchListItem(line: string): ListItem | null {
  const ul = /^\s*[-*+]\s+(.*)$/.exec(line);
  if (ul) return { ordered: false, text: ul[1]! };
  const ol = /^\s*\d+[.)]\s+(.*)$/.exec(line);
  if (ol) return { ordered: true, text: ol[1]! };
  return null;
}

/** True when a line begins a block that must interrupt an open paragraph. */
function startsBlock(line: string): boolean {
  return (
    /^\s*```/.test(line) ||
    /^(#{1,6})\s+/.test(line) ||
    /^\s*>/.test(line) ||
    /^\s*([-*_])(\s*\1){2,}\s*$/.test(line) ||
    matchListItem(line) !== null
  );
}

/**
 * Render inline markdown (bold, italic, code, links) from `text` into `parent`.
 * Newlines within the run become <br>. Code spans are parsed first so their
 * contents are never treated as emphasis.
 */
function renderInline(text: string, parent: HTMLElement): void {
  // Split on backtick code spans; even indices are normal text, odd are code.
  const parts = text.split(/(`+)([^`]*?)\1/);
  // String.split with two capture groups yields [text, ticks, code, text, …].
  for (let k = 0; k < parts.length; k++) {
    if (k % 3 === 0) {
      renderEmphasisAndLinks(parts[k]!, parent);
    } else if (k % 3 === 2) {
      const code = document.createElement("code");
      code.textContent = parts[k]!;
      parent.appendChild(code);
    }
    // k % 3 === 1 is the backtick run itself — skip.
  }
}

/** Handle bold, italic, `[links](url)`, and line breaks. */
function renderEmphasisAndLinks(text: string, parent: HTMLElement): void {
  // A single regex alternation walked left-to-right keeps nesting simple and
  // avoids re-scanning already-consumed spans. Underscore emphasis is gated on
  // word boundaries (lookaround) so snake_case identifiers in prose aren't
  // italicized; asterisk emphasis is unconditional.
  const rx =
    /(\*\*)(.+?)\*\*|(?<![\w`])(__)(.+?)__(?![\w`])|(\*)(.+?)\*|(?<![\w`])(_)(.+?)_(?![\w`])|\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = rx.exec(text)) !== null) {
    if (m.index > last) appendText(text.slice(last, m.index), parent);
    const bold = m[1] ? m[2]! : m[3] ? m[4]! : undefined;
    const italic = m[5] ? m[6]! : m[7] ? m[8]! : undefined;
    if (bold !== undefined) {
      const strong = document.createElement("strong");
      renderEmphasisAndLinks(bold, strong);
      parent.appendChild(strong);
    } else if (italic !== undefined) {
      const em = document.createElement("em");
      renderEmphasisAndLinks(italic, em);
      parent.appendChild(em);
    } else {
      const label = m[9]!;
      const href = safeHref(m[10]!);
      if (href) {
        const a = document.createElement("a");
        a.href = href;
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        renderEmphasisAndLinks(label, a);
        parent.appendChild(a);
      } else {
        // Unsafe scheme — render the label as plain text, drop the link.
        appendText(label, parent);
      }
    }
    last = rx.lastIndex;
  }
  if (last < text.length) appendText(text.slice(last), parent);
}

/** Append text, turning embedded newlines into <br> elements. */
function appendText(text: string, parent: HTMLElement): void {
  const segments = text.split("\n");
  for (let k = 0; k < segments.length; k++) {
    if (k > 0) parent.appendChild(document.createElement("br"));
    const seg = segments[k]!;
    if (seg) parent.appendChild(document.createTextNode(seg));
  }
}

/** Allow only http(s), mailto, and relative/anchor links; reject the rest. */
function safeHref(url: string): string | null {
  const trimmed = url.trim();
  if (/^(https?:|mailto:)/i.test(trimmed)) return trimmed;
  // Relative, root-relative, or in-page anchors are safe.
  if (/^(\/|\.|#)/.test(trimmed)) return trimmed;
  return null;
}

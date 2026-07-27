/**
 * Conservative auto-formatter for the fx (GLSL-ish) effect language. It ONLY:
 *   - re-indents each line by its nesting depth (braces + parens + brackets),
 *   - trims trailing whitespace,
 *   - collapses runs of blank lines to one, and
 *   - ensures a single trailing newline.
 * It never touches token spacing, reorders, or rewrites anything on a line, so it
 * cannot break otherwise-valid code. Braces/parens inside `//` line comments and
 * `/* … *\/` block comments are ignored when computing depth.
 */

const INDENT = "  ";

const isOpener = (c: string): boolean => c === "{" || c === "(" || c === "[";
const isCloser = (c: string): boolean => c === "}" || c === ")" || c === "]";

/** Blank out comments in one line for depth analysis, tracking block-comment
 * state across lines. Returns the code-only text + whether we're still in a block
 * comment at end of line. */
function stripComments(line: string, inBlock: boolean): { code: string; inBlock: boolean } {
  let out = "";
  let i = 0;
  while (i < line.length) {
    const c = line[i];
    const c2 = line[i + 1];
    if (inBlock) {
      if (c === "*" && c2 === "/") {
        inBlock = false;
        i += 2;
      } else {
        i++;
      }
      continue;
    }
    if (c === "/" && c2 === "/") break; // line comment → ignore the rest
    if (c === "/" && c2 === "*") {
      inBlock = true;
      i += 2;
      continue;
    }
    out += c;
    i++;
  }
  return { code: out, inBlock };
}

/** Re-indent + tidy an fx source string. Idempotent. */
export function formatFx(src: string): string {
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  let nest = 0;
  let inBlock = false;
  let blankRun = 0;

  for (const raw of lines) {
    const trimmed = raw.trim();

    if (trimmed === "") {
      if (++blankRun <= 1) out.push("");
      continue;
    }
    blankRun = 0;

    // Inside a multi-line block comment: keep the line, hold the current indent,
    // and just watch for the closing delimiter (don't count braces).
    if (inBlock) {
      out.push(INDENT.repeat(Math.max(0, nest)) + trimmed);
      inBlock = stripComments(trimmed, true).inBlock;
      continue;
    }

    const { code, inBlock: nextBlock } = stripComments(trimmed, false);

    // Leading closers dedent THIS line (e.g. `}` / `});` / `)`).
    let lead = 0;
    for (const ch of code) {
      if (isCloser(ch)) lead++;
      else if (ch.trim() !== "") break;
    }
    out.push(INDENT.repeat(Math.max(0, nest - lead)) + trimmed);

    // The net delta shifts subsequent lines.
    for (const ch of code) {
      if (isOpener(ch)) nest++;
      else if (isCloser(ch)) nest--;
    }
    if (nest < 0) nest = 0;
    inBlock = nextBlock;
  }

  while (out.length && out[out.length - 1] === "") out.pop();
  while (out.length && out[0] === "") out.shift();
  return out.join("\n") + "\n";
}

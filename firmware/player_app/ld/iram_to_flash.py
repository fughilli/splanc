"""Rewrite ESP-IDF's ldgen-generated sections.ld to move chosen input sections
out of internal RAM (.iram0.text / .dram0.data) and into flash.

The SDK is prebuilt with a fixed sdkconfig, so its IRAM placement Kconfigs
(CONFIG_RINGBUF_PLACE_FUNCTIONS_INTO_FLASH, CONFIG_ESP_WIFI_SLP_IRAM_OPT, ...)
can't be turned; but those options only change sections.ld, which this does
directly. Each rule names input files (`lib.a` or `lib.a:object`) and,
optionally, the input sections it applies to. For a rule:

  1. in the RAM output sections, every input-section line whose file pattern
     the rule matches is DELETED (for a section-filtered rule, only lines that
     place one of those sections);
  2. in the flash output sections, the rule's files are removed from every
     EXCLUDE_FILE list (for a section-filtered rule, only in statements that
     name one of those sections), so the generic flash catch-alls pick them up.

  3. an OBJECT rule with sections (`lib.a:obj .sec ...`) whose sections the RAM
     side places library-wide (`*lib.a:(.sec .sec.*)`, no per-object line) is
     carved out instead: the object is EXCLUDE_FILE'd from that RAM statement
     and an explicit `*lib.a:obj.*(.sec .sec.*)` statement is added at the top
     of .flash.text (the flash catch-alls exclude the whole library).

The reverse also exists, for our own hot code that must NOT pay flash-cache
misses (the per-LED fx shade path):

  4. an `iram:` rule (`iram: <input-section glob> ...`) adds `*(<globs>)` to
     .iram0.text right after the `*(.iram1 .iram1.*)` statement. Output
     statements match in script order and .iram0.text precedes .flash.text, so
     those input sections land in IRAM; the flash catch-alls never see them.
     Our code is built with -ffunction-sections, so a glob names functions
     (`.text.lm_fx_shade`, `.text._ZN15ledmapper_fx_vm7Program5parse*`).

  5. a `flash-first:` rule (`flash-first: <input-section glob> ...`) adds
     `*(<globs>)` as the FIRST statement of .flash.text, so those input sections
     sit at a fixed address at the start of flash code instead of wherever the link
     order puts them. For the per-frame render path that stays in flash this makes
     its flash-cache footprint independent of how much app code precedes it in link
     order (growing main.cpp / netstack_transport.cpp used to shift the whole Rust
     player and move fx_bench's per-frame cost by ~9 k cycles, e.g. sweep16 +16%).

Nothing else changes; the link runs with --orphan-handling=warn, so a section
that ends up placed nowhere is a loud warning, and the caller asserts every rule
matched something.

usage: iram_to_flash.py RULES IN_SECTIONS_LD OUT_SECTIONS_LD
RULES lines: `<file>[ <section> ...]`, `iram: <section> ...` or
`flash-first: <section> ...`, `#` comments.
"""

import re
import sys

RAM_SECTIONS = (".iram0.text", ".dram0.data")
FLASH_SECTIONS = (".flash.text", ".flash.rodata")


def parse_rules(text):
    rules = []
    for line in text.splitlines():
        line = line.split("#", 1)[0].strip()
        if not line:
            continue
        parts = line.split()
        rules.append((parts[0], tuple(parts[1:])))
    return rules


def file_regex(spec):
    """`libpp.a` matches `*libpp.a` and `*libpp.a:obj.*`; `libhal.a:gpspi`
    matches `*libhal.a:gpspi.*` only."""
    if ":" in spec:
        lib, obj = spec.split(":", 1)
        return re.compile(r"\*" + re.escape(lib) + ":" + re.escape(obj) + r"\.\*")
    return re.compile(r"\*" + re.escape(spec) + r"(:[^\s()]*)?(?=[\s()]|$)")


def names_section(stmt, sections):
    return any(
        re.search(r"(^|[\s(])" + re.escape(s) + r"(\.\*)?(?=[\s)]|$)", stmt) for s in sections
    )


def carve(src, rules, hits):
    """Rule kind 3 (see the module doc): object carve-outs from library-wide RAM
    statements. Idempotent: a statement already carrying an EXCLUDE_FILE is left
    alone."""
    carves = [r for r in rules if ":" in r[0] and r[1]]
    lines = src.splitlines(keepends=True)
    region = None
    flash_adds = []
    for i, line in enumerate(lines):
        m = re.match(r"\s*(\.[\w.]+)\s*:", line)
        if m:
            region = m.group(1)
        stmt = line.strip()
        if region not in RAM_SECTIONS or "EXCLUDE_FILE" in stmt:
            continue
        m = re.fullmatch(r"\*([\w.-]+\.a):\(([^()]*)\)", stmt)
        if not m:
            continue
        lib, pats = m.group(1), m.group(2).split()
        mine = [r for r in carves if r[0].split(":", 1)[0] == lib and names_section(stmt, r[1])]
        if not mine:
            continue
        objs = " ".join("*" + r[0] + ".*" for r in mine)
        secs = {x for r in mine for x in r[1]}
        new = [f"EXCLUDE_FILE({objs}) {p}" if p.removesuffix(".*") in secs else p for p in pats]
        lines[i] = line[: len(line) - len(line.lstrip())] + f"*{lib}:({' '.join(new)})\n"
        for r in mine:
            hits[r] += 1
            add = "    *" + r[0] + ".*(" + " ".join(f"{x} {x}.*" for x in r[1]) + ")\n"
            if add not in flash_adds:
                flash_adds.append(add)
    if flash_adds:
        for i, line in enumerate(lines):
            if re.match(r"\s*\.flash\.text\s*:", line):
                j = i + 1
                while j < len(lines) and "{" not in lines[j - 1]:
                    j += 1
                lines[j:j] = flash_adds
                break
        else:
            raise SystemExit("iram_to_flash: no .flash.text section")
    return "".join(lines)


IRAM_ANCHOR = re.compile(r"^(\s*)\*\(\.iram1 \.iram1\.\*\)\s*$")


def to_iram(src, rules, hits):
    """Rule kind 4 (see the module doc): pin input sections into .iram0.text.
    Idempotent: an identical statement already present is not added again."""
    pins = [r for r in rules if r[0] == "iram:"]
    if not pins:
        return src
    lines = src.splitlines(keepends=True)
    region = None
    for i, line in enumerate(lines):
        m = re.match(r"\s*(\.[\w.]+)\s*:", line)
        if m:
            region = m.group(1)
        a = IRAM_ANCHOR.match(line)
        if region == ".iram0.text" and a:
            adds = []
            for r in pins:
                add = f"{a.group(1)}*({' '.join(r[1])})\n"
                hits[r] += 1
                if add not in lines and add not in adds:
                    adds.append(add)
            lines[i + 1 : i + 1] = adds
            return "".join(lines)
    raise SystemExit("iram_to_flash: no `*(.iram1 .iram1.*)` statement in .iram0.text")


FLASH_TEXT = re.compile(r"^\s*\.flash\.text\s*:")


def flash_first(src, rules, hits):
    """Rule kind 5 (see the module doc): place input sections first in .flash.text.
    Idempotent: an identical statement already present is not added again."""
    pins = [r for r in rules if r[0] == "flash-first:"]
    if not pins:
        return src
    lines = src.splitlines(keepends=True)
    for i, line in enumerate(lines):
        if FLASH_TEXT.match(line):
            j = i + 1
            while j < len(lines) and "{" not in lines[j - 1]:
                j += 1
            adds = []
            for r in pins:
                add = f"    *({' '.join(r[1])})\n"
                hits[r] += 1
                if add not in lines and add not in adds:
                    adds.append(add)
            lines[j:j] = adds
            return "".join(lines)
    raise SystemExit("iram_to_flash: no .flash.text section")


def rewrite(src, rules):
    out, hits = [], {r: 0 for r in rules}
    src = to_iram(src, rules, hits)
    rules_ram_to_flash = [r for r in rules if r[0] not in ("iram:", "flash-first:")]
    src = carve(src, rules_ram_to_flash, hits)
    # After carve: carve also inserts at the top of .flash.text, and these must lead.
    src = flash_first(src, rules, hits)
    rules = rules_ram_to_flash
    region = None
    for line in src.splitlines(keepends=True):
        m = re.match(r"\s*(\.[\w.]+)\s*:", line)
        if m and "{" not in line and not line.strip().startswith("*"):
            region = m.group(1)
        elif m:
            region = m.group(1)
        stripped = line.strip()
        if region in RAM_SECTIONS and stripped.startswith("*") and "EXCLUDE_FILE" not in line:
            head = stripped.split("(", 1)[0]
            drop = False
            for r in rules:
                spec, secs = r
                if file_regex(spec).fullmatch(head) or (
                    ":" not in spec and file_regex(spec).match(head)
                ):
                    if not secs or names_section(stripped, secs):
                        hits[r] += 1
                        drop = True
            if drop:
                continue
        if region in FLASH_SECTIONS and "EXCLUDE_FILE" in line:
            for r in rules:
                spec, secs = r
                if secs and not names_section(line, secs):
                    continue
                rx = file_regex(spec)
                new = re.sub(
                    r"EXCLUDE_FILE\(([^)]*)\)",
                    lambda m: "EXCLUDE_FILE("
                    + " ".join(t for t in m.group(1).split() if not rx.fullmatch(t))
                    + ")",
                    line,
                )
                if new != line:
                    hits[r] += 1
                    line = new
            line = line.replace("EXCLUDE_FILE() ", "")
        out.append(line)
    return "".join(out), hits


def main():
    rules = parse_rules(open(sys.argv[1]).read())
    for r in rules:
        if r[0] in ("iram:", "flash-first:") and not r[1]:
            sys.exit(f"iram_to_flash: a `{r[0]}` rule needs at least one section")
    text, hits = rewrite(open(sys.argv[2]).read(), rules)
    dead = [r for r, n in hits.items() if n == 0]
    if dead:
        sys.exit(f"iram_to_flash: rules matched nothing (SDK changed?): {dead}")
    open(sys.argv[3], "w").write(text)
    for r, n in hits.items():
        print(f"{n:3d} edits  {r[0]} {' '.join(r[1])}", file=sys.stderr)


if __name__ == "__main__":
    main()

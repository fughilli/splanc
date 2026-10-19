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


Nothing else changes; the link runs with --orphan-handling=warn, so a section
that ends up placed nowhere is a loud warning, and the caller asserts every rule
matched something.

usage: iram_to_flash.py RULES IN_SECTIONS_LD OUT_SECTIONS_LD
RULES lines: `<file>[ <section> ...]`, `#` comments.
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


def rewrite(src, rules):
    out, hits = [], {r: 0 for r in rules}
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
    text, hits = rewrite(open(sys.argv[2]).read(), rules)
    dead = [r for r, n in hits.items() if n == 0]
    if dead:
        sys.exit(f"iram_to_flash: rules matched nothing (SDK changed?): {dead}")
    open(sys.argv[3], "w").write(text)
    for r, n in hits.items():
        print(f"{n:3d} edits  {r[0]} {' '.join(r[1])}", file=sys.stderr)


if __name__ == "__main__":
    main()

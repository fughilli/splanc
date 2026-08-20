#!/usr/bin/env python3
"""Strip degenerate zero-length `fp_line` elements from generated .kicad_mod
footprints.

EasyEDA->KiCad conversion (via `ato create part`) sometimes emits an fp_line
whose start == end (a zero-length segment). atopile 0.15.8's PCB transformer
then throws `min() iterable argument is empty` while laying out that footprint.
Removing the degenerate lines is cosmetic (they draw nothing) and lets the board
build. Idempotent. Usage: sanitize_footprints.py <dir-or-.kicad_mod>...
"""
import re
import sys
from pathlib import Path


def sanitize(text: str) -> tuple[str, int]:
    out, i, removed = [], 0, 0
    # Walk top-level (fp_line ...) blocks; drop those with start==end.
    while i < len(text):
        if text.startswith("(fp_line", i):
            depth, j = 0, i
            while j < len(text):
                if text[j] == "(":
                    depth += 1
                elif text[j] == ")":
                    depth -= 1
                    if depth == 0:
                        break
                j += 1
            block = text[i : j + 1]
            s = re.search(r"\(start\s+(-?[\d.]+)\s+(-?[\d.]+)\)", block)
            e = re.search(r"\(end\s+(-?[\d.]+)\s+(-?[\d.]+)\)", block)
            if s and e and s.groups() == e.groups():
                removed += 1
                # also swallow a trailing newline + indentation
                k = j + 1
                while k < len(text) and text[k] in "\n\t ":
                    k += 1
                i = k
                continue
            out.append(block)
            i = j + 1
        else:
            out.append(text[i])
            i += 1
    return "".join(out), removed


def _floats(pat, block):
    m = re.search(pat, block)
    return (float(m.group(1)), float(m.group(2))) if m else None


def ensure_silk_line(text: str) -> tuple[str, bool]:
    """atopile's `get_bbox_from_geos` only reads Lines/Rects — a footprint whose
    silkscreen is *only* circles/arcs yields an empty bbox and crashes layout
    with `min() iterable argument is empty`. If the silk layer has no fp_line/
    fp_rect, add one spanning the pad extents so the bbox is well-defined."""
    has_silk_line = False
    for m in re.finditer(r"\(fp_(line|rect)\b(.*?)\n\t\)", text, re.S):
        if "SilkS" in m.group(2):
            has_silk_line = True
            break
    has_silk_any = "SilkS" in text
    if has_silk_line or not has_silk_any:
        return text, False
    # Span the pad centres.
    xs, ys = [], []
    for m in re.finditer(r"\(pad\b(.*?)\n\t\)", text, re.S):
        at = _floats(r"\(at\s+(-?[\d.]+)\s+(-?[\d.]+)", m.group(1))
        if at:
            xs.append(at[0])
            ys.append(at[1])
    if not xs:
        return text, False
    x0, y0, x1, y1 = min(xs), min(ys), max(xs), max(ys)
    if x0 == x1 and y0 == y1:
        x1 += 0.5
    line = (
        f"\t(fp_line\n\t\t(start {x0} {y0})\n\t\t(end {x1} {y1})\n"
        f'\t\t(stroke (width 0.12) (type solid))\n\t\t(layer "F.SilkS")\n\t)\n'
    )
    idx = text.rfind(")")
    return text[:idx] + line + text[idx:], True


def main(args):
    files = []
    for a in args:
        p = Path(a)
        files += list(p.rglob("*.kicad_mod")) if p.is_dir() else [p]
    total, silk = 0, 0
    for f in files:
        text = f.read_text()
        text, n = sanitize(text)
        text, added_silk = ensure_silk_line(text)
        if n or added_silk:
            f.write_text(text)
        if n:
            total += n
            print(f"{f}: removed {n} zero-length fp_line(s)")
        if added_silk:
            silk += 1
            print(f"{f}: added silk outline line (had only circles/arcs)")
    print(
        f"done: removed {total} zero-length line(s), added {silk} silk line(s) "
        f"across {len(files)} footprint(s)"
    )


if __name__ == "__main__":
    main(sys.argv[1:])

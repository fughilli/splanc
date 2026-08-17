#!/usr/bin/env python3
"""Treeview + bar-chart visualizer for `fw_memaudit.py --json`.

fw_memaudit emits a component -> file -> symbol RAM breakdown as JSON; this
renders it as a box-drawing treeview with proportional bars and percentages,
plus a flat "biggest symbols" listing. Kept separate so the audit stays a plain
data source and the presentation can evolve independently. No ELF/toolchain
needed here — it's pure presentation over the JSON.

    # on the host, where the built ELF lives:
    python3 tools/fw_memaudit.py --json | python3 tools/fw_memviz.py
    python3 tools/fw_memaudit.py --json > mem.json
    python3 tools/fw_memviz.py mem.json --depth 3 --top 40 --min 256
"""

from __future__ import annotations

import argparse
import json
import sys

BAR_CHARS = " ▏▎▍▌▋▊▉█"  # 1/8-block ramp for sub-cell precision


def human(n: int) -> str:
    if n >= 1024 * 1024:
        return f"{n / (1024 * 1024):.2f} MB"
    if n >= 1024:
        return f"{n / 1024:.1f} KB"
    return f"{n} B"


def bar(frac: float, width: int) -> str:
    """A proportional bar `width` cells wide, 1/8-block granular."""
    frac = max(0.0, min(1.0, frac))
    eighths = round(frac * width * 8)
    full, rem = divmod(eighths, 8)
    out = "█" * full
    if rem:
        out += BAR_CHARS[rem]
    return out.ljust(width)


def render(obj: dict, depth: int, top: int, min_bytes: int, width: int) -> str:
    comps = obj.get("components", {})
    total = obj.get("total_ram_bytes", 0) or 1  # attributed .data/.bss (tree denom)
    sram = obj.get("sram", {})
    hp = sram.get("hp_capacity_bytes", 512 * 1024) or 1
    out: list[str] = []

    out.append(f"ELF: {obj.get('elf', '?')}")

    # --- SRAM budget (bars vs the 512 KB HP SRAM) ---
    if sram:
        out.append("\n== SRAM budget (ESP32-C6: 512 KB HP SRAM, unified I/D) ==")
        for label, key in (
            ("IRAM (code in RAM)", "iram_bytes"),
            ("DRAM (.data + .bss)", "dram_bytes"),
            ("static HP used", "static_hp_bytes"),
            ("→ link-time heap ceiling", "heap_ceiling_bytes"),
        ):
            v = sram.get(key, 0)
            out.append(f"  {label:<26}{human(v):>9}  {100 * v / hp:5.1f}%  {bar(v / hp, width)}")
        if sram.get("lp_rtc_bytes"):
            out.append(
                f"  {'LP/RTC used':<26}{human(sram['lp_rtc_bytes']):>9}"
                f"   (of {human(sram.get('lp_capacity_bytes', 16 * 1024))})"
            )
        out.append(
            "  (ceiling = link-time max; live free heap is lower — runtime WiFi/BLE/TLS alloc)"
        )

    # --- sections (bars vs HP SRAM capacity) ---
    secs = sorted(obj.get("sections", []), key=lambda s: -s["bytes"])
    if secs:
        out.append("\n== SRAM sections ==")
        for s in secs:
            kt = f"[{s['kind']}]" if s.get("kind") else ""
            out.append(
                f"  {human(s['bytes']):>9}  {100 * s['bytes'] / hp:5.1f}%  "
                f"{bar(s['bytes'] / hp, width)}  {kt:<7}{s['name']}"
            )

    # --- treeview: component -> file -> symbol (vs attributed .data/.bss) ---
    out.append(
        f"\n== DRAM .data/.bss treeview (component → file"
        f"{' → symbol' if depth >= 3 else ''}, {human(total)} attributed) =="
    )
    ordered_comps = sorted(comps.items(), key=lambda kv: -kv[1]["bytes"])
    shown_comps = [(c, d) for c, d in ordered_comps if d["bytes"] >= min_bytes]
    for ci, (comp, cdat) in enumerate(shown_comps):
        c_last = ci == len(shown_comps) - 1
        c_branch = "└── " if c_last else "├── "
        pct = 100 * cdat["bytes"] / total
        out.append(
            f"{c_branch}{human(cdat['bytes']):>9}  {pct:5.1f}%  {bar(cdat['bytes']/total, width)}  {comp}"
        )
        if depth < 2:
            continue
        c_pad = "    " if c_last else "│   "
        files = sorted(cdat.get("files", {}).items(), key=lambda kv: -kv[1]["bytes"])
        files = [(f, d) for f, d in files if d["bytes"] >= min_bytes]
        for fi, (fname, fdat) in enumerate(files):
            f_last = fi == len(files) - 1
            f_branch = "└── " if f_last else "├── "
            fpct = 100 * fdat["bytes"] / total
            out.append(f"{c_pad}{f_branch}{human(fdat['bytes']):>9}  {fpct:5.1f}%  {fname}")
            if depth < 3:
                continue
            f_pad = c_pad + ("    " if f_last else "│   ")
            syms = [s for s in fdat.get("symbols", []) if s["bytes"] >= min_bytes]
            for si, sym in enumerate(syms):
                s_branch = "└── " if si == len(syms) - 1 else "├── "
                out.append(f"{f_pad}{s_branch}{human(sym['bytes']):>9}  {sym['name']}")

    # --- flat biggest-symbols listing ---
    flat: list[tuple[int, str, str]] = []
    for comp, cdat in comps.items():
        for fname, fdat in cdat.get("files", {}).items():
            for sym in fdat.get("symbols", []):
                flat.append((sym["bytes"], sym["name"], comp))
    flat.sort(reverse=True)
    out.append(f"\n== {top} biggest RAM symbols ==")
    for sz, name, comp in flat[:top]:
        pct = 100 * sz / total
        out.append(f"  {human(sz):>9}  {pct:5.1f}%  {bar(sz/total, width)}  {name}  [{comp}]")

    return "\n".join(out)


def main() -> int:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument("json", nargs="?", help="fw_memaudit --json file (default: stdin)")
    ap.add_argument(
        "--depth", type=int, default=3, help="tree depth (1=component, 2=+file, 3=+symbol)"
    )
    ap.add_argument("--top", type=int, default=30, help="how many biggest symbols to list")
    ap.add_argument("--min", type=int, default=256, help="hide nodes below N bytes")
    ap.add_argument("--width", type=int, default=24, help="bar width in cells")
    args = ap.parse_args()

    raw = open(args.json).read() if args.json else sys.stdin.read()
    obj = json.loads(raw)
    print(render(obj, args.depth, args.top, args.min, args.width))
    return 0


if __name__ == "__main__":
    sys.exit(main())

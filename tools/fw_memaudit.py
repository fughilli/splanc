#!/usr/bin/env python3
"""Static RAM audit for the firmware ELF — where does .data/.bss go?

The C6's heap is what's left of internal RAM after every statically-allocated
buffer (.data + .bss, incl. IRAM/DRAM/RTC) is carved out. When a TLS handshake
(a ~17 KB heap alloc) OOMs, the lever is usually a fat static buffer that can be
shrunk or made lazy. This tool attributes every RAM symbol back to its source
translation unit and prints:

  * a per-section RAM summary (.dram0.bss, .dram0.data, …),
  * a size-sorted tree  component → file → symbol,
  * a flat "biggest symbols" list.

It shells out to the toolchain's `readelf`/`nm` (auto-detecting the RISC-V
`riscv32-esp-elf-*` from the Bazel cache; falls back to generic binutils, which
read the cross ELF fine), plus `addr2line` to attribute symbols `nm -l` can't.

    bazel build -c opt //firmware/player_app:esp32c6
    python3 tools/fw_memaudit.py            # auto-locates the built ELF
    python3 tools/fw_memaudit.py --elf x.elf --top 40 --min 256 --depth 3
    python3 tools/fw_memaudit.py --json     # machine-readable tree
"""

from __future__ import annotations

import argparse
import glob
import json
import os
import re
import shutil
import subprocess
import sys

# nm type letters that live in RAM (initialized data + zero/bss, incl. the
# RISC-V "small" .sdata/.sbss variants). r/R (rodata) and t/T (text) are flash.
RAM_TYPES = set("bBdDgGsS")


def find_tool(name: str) -> str:
    """Prefer the RISC-V cross tool from the Bazel/Nix cache, else generic."""
    cache = os.path.expanduser("~/.cache")
    hits = glob.glob(f"{cache}/**/riscv32-esp-elf-{name}", recursive=True)
    if hits:
        return hits[0]
    generic = shutil.which(name)
    if not generic:
        sys.exit(f"error: no `{name}` (install binutils or point --toolchain)")
    return generic


def locate_elf() -> str:
    """Find the most recently built esp32c6 ELF under any bazel-out config."""
    roots = ["bazel-out", os.path.expanduser("~/.cache/bazel-volumetric")]
    found: list[str] = []
    for r in roots:
        found += glob.glob(f"{r}/**/firmware/player_app/esp32c6.elf", recursive=True)
    if not found:
        sys.exit("error: no esp32c6.elf found — build it or pass --elf")
    return max(found, key=os.path.getmtime)


# The C6's HP SRAM is mapped into the data bus at 0x4080_0000..0x4088_0000
# (512 KiB). A section's load address (VMA) tells us whether it actually eats
# internal SRAM (and therefore heap) or merely lives in flash: flash rodata is
# mapped up at 0x4200_0000 via the cache, so it must NOT be counted as RAM even
# though the ELF marks the reservation ALLOC. (The old heuristic — ALLOC and
# writable/NOBITS — wrongly swept in .flash.rodata + the 2 MB
# .flash_rodata_dummy padding, inflating the "static RAM" figure ~15x.)
SRAM_LO = 0x4080_0000
SRAM_HI = 0x4088_0000


def _in_sram(addr: int) -> bool:
    # RTC-retained statics (LP RAM, ~0x5000_0000) are tiny; count only the HP
    # SRAM window that the heap allocator draws from.
    return SRAM_LO <= addr < SRAM_HI


def ram_sections(readelf: str, elf: str) -> tuple[list[tuple[str, int]], set[int]]:
    """(name,size) of SRAM-resident sections + their section indices.

    A section counts as SRAM iff it is ALLOC, occupies space (NOBITS bss or a
    writable/PROGBITS load), AND its VMA lands in the HP-SRAM window — the last
    clause is what excludes flash-mapped rodata (see SRAM_LO/HI)."""
    out = subprocess.run([readelf, "-SW", elf], capture_output=True, text=True).stdout
    sizes: list[tuple[str, int]] = []
    ram_idx: set[int] = set()
    for line in out.splitlines():
        m = re.match(
            r"\s*\[\s*(\d+)\]\s+(\S+)\s+(\S+)\s+([0-9a-f]+)\s+[0-9a-f]+\s+([0-9a-f]+)\s+\S+\s+([A-Zpx]*)",
            line,
        )
        if not m:
            continue
        idx, name, styp, addr, size, flags = m.groups()
        size_i = int(size, 16)
        addr_i = int(addr, 16)
        is_ram = ("A" in flags) and (styp == "NOBITS" or "W" in flags) and _in_sram(addr_i)
        if is_ram and size_i > 0:
            sizes.append((name, size_i))
            ram_idx.add(int(idx))
    return sizes, ram_idx


def read_symbols(nm: str, elf: str) -> list[tuple[int, int, str, str, str | None]]:
    """(addr,size,type,name,file|None) for every defined RAM symbol."""
    out = subprocess.run(
        [nm, "-SlC", "--defined-only", "--radix=d", elf],
        capture_output=True,
        text=True,
    ).stdout
    syms: list[tuple[int, int, str, str, str | None]] = []
    for line in out.splitlines():
        # "<addr> <size> <type> <name>[\t<file>:<line>]"
        parts = line.split("\t", 1)
        head = parts[0].split(None, 3)
        if len(head) < 4:
            continue
        addr, size, typ, name = head
        if typ not in RAM_TYPES or not size.isdigit():
            continue
        # Guard against the odd absolute/flash-shadow symbol that carries a RAM
        # type letter but no SRAM home, so the per-symbol roll-up reconciles with
        # the section totals.
        if not _in_sram(int(addr)):
            continue
        src = parts[1].rsplit(":", 1)[0] if len(parts) > 1 else None
        syms.append((int(addr), int(size), typ, name, src))
    return syms


def addr2line_files(a2l: str, elf: str, addrs: list[int]) -> dict[int, str]:
    """Batch-resolve addresses → source file (for symbols nm -l couldn't map)."""
    if not addrs:
        return {}
    proc = subprocess.run(
        [a2l, "-e", elf, "-C"] + [hex(a) for a in addrs],
        capture_output=True,
        text=True,
    )
    res: dict[int, str] = {}
    for addr, line in zip(addrs, proc.stdout.splitlines()):
        f = line.rsplit(":", 1)[0].strip()
        if f and f not in ("??", "?"):
            res[addr] = f
    return res


def component_of(path: str | None, name: str) -> tuple[str, str]:
    """Map a source path to a (component, short-file) bucket for the tree."""
    if not path or path in ("??", ""):
        # Rust FFI statics demangle to `ledmapper_player_ffi::…` with no file.
        if "::" in name and ("ledmapper" in name or "fx" in name.lower()):
            return "firmware/player (rust)", "(rust statics)"
        return "(no debug info)", "(unknown)"
    p = path.replace("\\", "/")
    m = re.search(r"esp-idf/components/([^/]+)/", p)
    if m:
        return f"esp-idf/{m.group(1)}", os.path.basename(p)
    m = re.search(r"arduino_esp32[^/]*/(?:libraries/([^/]+)/)?", p)
    if m:
        return f"arduino/{m.group(1)}" if m.group(1) else "arduino/core", os.path.basename(p)
    m = re.search(r"(firmware/[^:]*)", p)
    if m:
        d = os.path.dirname(m.group(1))
        return d, os.path.basename(p)
    if "/fx_compiler/" in p or p.startswith("fx_"):
        return "fx_compiler", os.path.basename(p)
    return os.path.dirname(p) or "(other)", os.path.basename(p)


def human(n: int) -> str:
    return f"{n/1024:.1f}K" if n >= 1024 else f"{n}B"


def signed(n: int) -> str:
    return f"+{human(n)}" if n > 0 else (f"-{human(-n)}" if n < 0 else "0")


def _symbol_totals(obj: dict) -> dict[str, int]:
    """{symbol_name: bytes} flattened across the tree of a --json snapshot."""
    out: dict[str, int] = {}
    for comp in obj.get("components", {}).values():
        for f in comp.get("files", {}).values():
            for s in f.get("symbols", []):
                out[s["name"]] = out.get(s["name"], 0) + s["bytes"]
    return out


def print_compare(cur: dict, baseline_path: str) -> int:
    """Diff current SRAM against an earlier --json snapshot: totals, then the
    per-symbol movers (added / reclaimed / resized). This is the lever for
    "pin as you iterate" — every cut shows up as a concrete negative delta."""
    with open(baseline_path) as fh:
        base = json.load(fh)
    b_tot, c_tot = base.get("total_ram_bytes", 0), cur["total_ram_bytes"]
    print(f"baseline: {baseline_path}")
    print(f"current:  {cur['elf']}")
    print("\n== SRAM total ==")
    print(f"  {human(b_tot):>9}  baseline")
    print(f"  {human(c_tot):>9}  current")
    print(f"  {signed(c_tot - b_tot):>9}  delta")

    bs, cs = _symbol_totals(base), _symbol_totals(cur)
    deltas = []
    for name in set(bs) | set(cs):
        d = cs.get(name, 0) - bs.get(name, 0)
        if d:
            deltas.append((d, name))
    if not deltas:
        print("\n(no per-symbol change)")
        return 0
    print("\n== per-symbol movers (current − baseline) ==")
    for d, name in sorted(deltas, key=lambda x: x[0]):  # reclaimed (neg) first
        tag = "new" if name not in bs else ("gone" if name not in cs else "")
        print(f"  {signed(d):>9}  {name}  {tag}".rstrip())
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument("--elf", help="firmware ELF (default: auto-locate the built esp32c6.elf)")
    ap.add_argument("--toolchain", help="cross-tool prefix, e.g. riscv32-esp-elf-")
    ap.add_argument("--top", type=int, default=30, help="how many biggest symbols to list")
    ap.add_argument(
        "--min", type=int, default=256, help="hide symbols/files below N bytes in the tree"
    )
    ap.add_argument(
        "--depth", type=int, default=2, help="tree depth (1=component, 2=+file, 3=+symbol)"
    )
    ap.add_argument("--json", action="store_true", help="emit the tree as JSON")
    ap.add_argument(
        "--compare",
        metavar="BASELINE.json",
        help="diff this ELF's per-component/-symbol SRAM against an earlier "
        "--json snapshot (shows what a change added/reclaimed)",
    )
    args = ap.parse_args()

    if args.toolchain:
        readelf, nm, a2l = (args.toolchain + t for t in ("readelf", "nm", "addr2line"))
    else:
        readelf, nm, a2l = find_tool("readelf"), find_tool("nm"), find_tool("addr2line")
    elf = args.elf or locate_elf()

    sections, _ = ram_sections(readelf, elf)
    syms = read_symbols(nm, elf)

    # Fill missing source files via addr2line, then bucket everything.
    missing = [a for (a, _s, _t, _n, src) in syms if not src]
    resolved = addr2line_files(a2l, elf, missing)

    # tree: component -> file -> list[(size,name)]
    tree: dict[str, dict[str, list[tuple[int, str]]]] = {}
    for addr, size, _typ, name, src in syms:
        src = src or resolved.get(addr)
        comp, short = component_of(src, name)
        tree.setdefault(comp, {}).setdefault(short, []).append((size, name))

    total_ram = sum(s for _n, s in sections)
    comp_tot = {c: sum(sz for f in files.values() for sz, _ in f) for c, files in tree.items()}

    obj = {
        "elf": elf,
        "sections": [{"name": n, "bytes": s} for n, s in sections],
        "total_ram_bytes": total_ram,
        "components": {
            c: {
                "bytes": comp_tot[c],
                "files": {
                    f: {
                        "bytes": sum(sz for sz, _ in items),
                        "symbols": [
                            {"name": nm_, "bytes": sz} for sz, nm_ in sorted(items, reverse=True)
                        ],
                    }
                    for f, items in files.items()
                },
            }
            for c, files in tree.items()
        },
    }

    if args.json:
        print(json.dumps(obj, indent=2))
        return 0

    if args.compare:
        return print_compare(obj, args.compare)

    # C6 HP SRAM is 512 KiB; the heap allocator hands out whatever isn't claimed
    # by these static sections OR by the runtime allocations the ELF can't see
    # (WiFi/BLE/lwIP pools, mbedTLS sessions, and the HEAP-allocated FreeRTOS task
    # stacks). So this headroom is a CEILING on the runtime free heap, not a
    # measurement of it — pair it with the device's esp_get_free_heap_size().
    C6_HP_SRAM = 512 * 1024
    print(f"ELF: {elf}")
    print("\n== Internal SRAM (heap-eating static) ==")
    print(f"  {human(total_ram):>8}  static SRAM footprint (.bss + .data)")
    print(f"  {human(C6_HP_SRAM):>8}  C6 HP SRAM total")
    print(
        f"  {human(C6_HP_SRAM - total_ram):>8}  ceiling on runtime heap (before WiFi/BLE/TLS/stacks)"
    )

    print("\n== SRAM sections ==")
    for n, s in sorted(sections, key=lambda x: -x[1]):
        print(f"  {human(s):>8}  {n}")

    print(f"\n== RAM by component → file{' → symbol' if args.depth >= 3 else ''} ==")
    for comp in sorted(comp_tot, key=lambda c: -comp_tot[c]):
        if comp_tot[comp] < args.min:
            continue
        print(f"  {human(comp_tot[comp]):>8}  {comp}")
        if args.depth < 2:
            continue
        files = tree[comp]
        for f in sorted(files, key=lambda f: -sum(sz for sz, _ in files[f])):
            ftot = sum(sz for sz, _ in files[f])
            if ftot < args.min:
                continue
            print(f"  {human(ftot):>8}    {f}")
            if args.depth < 3:
                continue
            for sz, name in sorted(files[f], reverse=True):
                if sz < args.min:
                    continue
                print(f"  {human(sz):>8}      {name}")

    print(f"\n== {args.top} biggest RAM symbols ==")
    flat = sorted(
        ((sz, name, src or resolved.get(a) or "?") for (a, sz, _t, name, src) in syms), reverse=True
    )
    for sz, name, src in flat[: args.top]:
        loc = component_of(src if src != "?" else None, name)[0]
        print(f"  {human(sz):>8}  {name}   [{loc}]")
    return 0


if __name__ == "__main__":
    sys.exit(main())

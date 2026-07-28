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


def ram_sections(readelf: str, elf: str) -> tuple[list[tuple[str, int]], set[int]]:
    """(name,size) of RAM sections + the set of section indices that are RAM.
    RAM = ALLOC and (NOBITS bss OR writable) — excludes flash .text/.rodata."""
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
        idx, name, styp, _addr, size, flags = m.groups()
        size_i = int(size, 16)
        is_ram = ("A" in flags) and (styp == "NOBITS" or "W" in flags)
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

    if args.json:
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
                                {"name": nm_, "bytes": sz}
                                for sz, nm_ in sorted(items, reverse=True)
                            ],
                        }
                        for f, items in files.items()
                    },
                }
                for c, files in tree.items()
            },
        }
        print(json.dumps(obj, indent=2))
        return 0

    print(f"ELF: {elf}")
    print(f"\n== RAM sections ({human(total_ram)} static) ==")
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

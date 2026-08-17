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


# Apparent repo name of the Nix-vendored binutils (MODULE.bazel `use_repo`); its
# bin/ holds unprefixed readelf/nm/addr2line (binutils-unwrapped-all-targets).
_BINUTILS_REPO = "binutils-unwrapped-all-targets"


def _runfiles():
    """The rules_python runfiles handle when launched under Bazel, else None.
    Use the library (not a hand-rolled path walk): it reads the runfiles
    MANIFEST + repo-mapping and resolves the SYMLINKED external-repo entries (the
    Nix store paths), which a plain glob(**) skips because it won't descend
    symlinked dirs. The API name shifted across rules_python versions (a
    `Runfiles` class vs a `runfiles` module), so try both."""
    try:
        from python.runfiles import Runfiles  # newer rules_python

        return Runfiles.Create()
    except Exception:
        pass
    try:
        from python.runfiles import runfiles  # older rules_python

        return runfiles.Create()
    except Exception:
        return None


_RF = _runfiles()


def find_tool(name: str) -> str:
    """Resolve readelf/nm/addr2line, in order of preference:
    1. the Nix-vendored binutils from bazel runfiles (hermetic — works on a
       host with no binutils, e.g. macOS; //tools:fw_memaudit `data`),
    2. a RISC-V cross tool from the Bazel/Nix cache (~/.cache),
    3. a generic host binutils on PATH."""
    if _RF is not None:
        p = _RF.Rlocation(f"{_BINUTILS_REPO}/bin/{name}")
        if p and os.path.exists(p):
            return p
    cache = os.path.expanduser("~/.cache")
    hits = glob.glob(f"{cache}/**/riscv32-esp-elf-{name}", recursive=True)
    if hits:
        return hits[0]
    generic = shutil.which(name)
    if not generic:
        sys.exit(
            f"error: no `{name}` — under Bazel it comes from runfiles "
            "(//tools:fw_memaudit `data`); standalone, install binutils or pass --toolchain"
        )
    return generic


def locate_elf() -> str:
    """Find the most recently built esp32c6 ELF under any bazel-out config."""
    # BUILD_WORKSPACE_DIRECTORY is set by `bazel run`, so the workspace-root
    # bazel-out symlink is reachable even though cwd is the runfiles tree.
    ws = os.environ.get("BUILD_WORKSPACE_DIRECTORY", "")
    roots = ["bazel-out", os.path.expanduser("~/.cache/bazel-volumetric")]
    if ws:
        roots = [os.path.join(ws, "bazel-out")] + roots
    found: list[str] = []
    for r in roots:
        found += glob.glob(f"{r}/**/firmware/player_app/esp32c6.elf", recursive=True)
    if not found:
        sys.exit("error: no esp32c6.elf found — build it or pass --elf")
    return max(found, key=os.path.getmtime)


# ESP32-C6 on-chip RAM (TRM ch.3): a single 512 KB HP SRAM (unified I/D bus,
# based at 0x40800000) + 16 KB LP SRAM (0x50000000). Flash is XIP-mapped at
# 0x42000000+ — NOT RAM. IRAM and DRAM are the SAME physical HP SRAM here, so
# the heap is simply 512 KB minus everything statically placed in it.
HP_SRAM_BYTES = 512 * 1024
LP_SRAM_BYTES = 16 * 1024
HP_SRAM_LO, HP_SRAM_HI = 0x40800000, 0x40800000 + HP_SRAM_BYTES
LP_SRAM_LO, LP_SRAM_HI = 0x50000000, 0x50000000 + LP_SRAM_BYTES


def ram_sections(readelf: str, elf: str) -> list[tuple[str, int, int, str]]:
    """Allocated SRAM sections as (name, size, addr, kind); kind is
    iram | dram | lp. 'SRAM' = any ALLOC section whose VMA lands in a C6 SRAM
    window; an executable HP section is IRAM (code that runs from RAM), a
    non-exec HP section is DRAM (.data/.bss). Flash XIP (rodata at 0x42000000+,
    including the huge .flash_rodata_dummy address-space placeholder) is
    excluded — gating on the ADDRESS is what keeps the total honest, since the
    ELF flags alone (ALLOC) let those flash sections through."""
    out = subprocess.run([readelf, "-SW", elf], capture_output=True, text=True).stdout
    secs: list[tuple[str, int, int, str]] = []
    for line in out.splitlines():
        m = re.match(
            r"\s*\[\s*(\d+)\]\s+(\S+)\s+(\S+)\s+([0-9a-f]+)\s+[0-9a-f]+\s+([0-9a-f]+)\s+\S+\s+([A-Zpx]*)",
            line,
        )
        if not m:
            continue
        _idx, name, _styp, addr, size, flags = m.groups()
        size_i = int(size, 16)
        a = int(addr, 16)
        if size_i == 0 or "A" not in flags:
            continue
        if LP_SRAM_LO <= a < LP_SRAM_HI:
            kind = "lp"
        elif HP_SRAM_LO <= a < HP_SRAM_HI:
            kind = "iram" if "X" in flags else "dram"
        else:
            continue  # flash XIP / MMIO — not SRAM
        secs.append((name, size_i, a, kind))
    return secs


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

    sections = ram_sections(readelf, elf)
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

    comp_tot = {c: sum(sz for f in files.values() for sz, _ in f) for c, files in tree.items()}
    attributable = sum(comp_tot.values()) or 1  # data/bss the tree accounts for

    # SRAM budget. On the C6, IRAM and DRAM share the ONE 512 KB HP SRAM, so the
    # link-time internal-RAM heap ceiling is simply what is left of it after all
    # static code+data. This is the MOST the allocator can ever have; the live
    # free heap is lower (ROM/DMA-reserved regions + runtime WiFi/BLE/TLS/lwip
    # allocations) — compare against the `[boot]` heap print and PerfReport.
    dram = sum(sz for _n, sz, _a, k in sections if k == "dram")
    iram = sum(sz for _n, sz, _a, k in sections if k == "iram")
    lp = sum(sz for _n, sz, _a, k in sections if k == "lp")
    static_hp = dram + iram
    heap_ceiling = HP_SRAM_BYTES - static_hp
    sram = {
        "hp_capacity_bytes": HP_SRAM_BYTES,
        "lp_capacity_bytes": LP_SRAM_BYTES,
        "dram_bytes": dram,
        "iram_bytes": iram,
        "lp_rtc_bytes": lp,
        "static_hp_bytes": static_hp,
        "heap_ceiling_bytes": heap_ceiling,
    }

    if args.json:
        obj = {
            "elf": elf,
            "sram": sram,
            "sections": [{"name": n, "bytes": s, "kind": k} for n, s, _a, k in sections],
            "total_ram_bytes": attributable,
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

    def pct(x: int) -> str:
        return f"{100 * x / HP_SRAM_BYTES:5.1f}%"

    print(f"ELF: {elf}")
    print("\n== SRAM budget (ESP32-C6: 512 KB HP SRAM, unified I/D) ==")
    print(f"  IRAM  (code run from RAM)  {human(iram):>9}  {pct(iram)}")
    print(f"  DRAM  (.data + .bss)       {human(dram):>9}  {pct(dram)}")
    print(f"  static HP SRAM used        {human(static_hp):>9}  {pct(static_hp)}")
    print(
        f"  -> link-time heap ceiling  {human(heap_ceiling):>9}  {pct(heap_ceiling)}"
        "   (before ROM/DMA-reserved + runtime WiFi/BLE/TLS alloc)"
    )
    if lp:
        print(f"  LP/RTC SRAM used           {human(lp):>9}   (of {human(LP_SRAM_BYTES)})")

    print("\n== SRAM sections ==")
    for n, s, _a, k in sorted(sections, key=lambda x: -x[1]):
        print(f"  {human(s):>8}  [{k:<4}]  {n}")

    print(
        f"\n== DRAM .data/.bss by component -> file"
        f"{' -> symbol' if args.depth >= 3 else ''}  ({human(attributable)} attributed) =="
    )
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

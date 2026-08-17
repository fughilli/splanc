#!/usr/bin/env python3
"""Decode the malloc_trace serial output into a per-call-site heap attribution.

The instrumented firmware (esp32c6_malloc_trace, -DLM_MALLOC_TRACE) prints, every
few seconds, a split summary plus its top allocation call sites:

    [mtrace] libc: 467 allocs / 39650 B | heap_caps: 933 allocs / 168174 B | ...
    [mtrace] site pc=42009f18 bytes=65536 count=1 op=4
    ...

This symbolizes each site's caller PC against the flashed ELF (addr2line) and
prints a ranked table — which function/subsystem is eating the heap, split by
allocator path (libc vs ESP-IDF heap_caps). Feed it the captured serial:

    hitl monitor --seconds 20 | python3 tools/mtrace_decode.py
    python3 tools/mtrace_decode.py serial.log --elf bazel-bin/firmware/player_app/player_app_malloc_trace
"""

from __future__ import annotations

import argparse
import glob
import os
import re
import subprocess
import sys

# op codes (see malloc_trace.cpp). >=4 is the ESP-IDF heap_caps path.
OP_NAME = {
    0: "malloc",
    1: "free",
    2: "calloc",
    3: "realloc",
    4: "heap_caps_malloc",
    5: "heap_caps_calloc",
    6: "heap_caps_realloc",
    7: "heap_caps_aligned_alloc",
}
SITE_RE = re.compile(r"\[mtrace\] site pc=([0-9a-fA-F]+) bytes=(\d+) count=(\d+) op=(\d+)")


def find_addr2line(explicit: str | None) -> str:
    if explicit:
        return explicit
    for pat in (
        "/nix/store/*riscv32-esp-elf*/bin/riscv32-esp-elf-addr2line",
        os.path.expanduser("~/.cache/**/riscv32-esp-elf-addr2line"),
    ):
        hits = glob.glob(pat, recursive=True)
        if hits:
            return hits[0]
    sys.exit("error: no riscv32-esp-elf-addr2line found; pass --addr2line")


def find_elf(explicit: str | None) -> str:
    if explicit:
        return explicit
    # the malloc_trace variant's cc_binary output IS the ELF
    hits = glob.glob("bazel-bin/**/player_app_malloc_trace", recursive=True)
    hits = [h for h in hits if os.path.isfile(h)]
    if not hits:
        sys.exit("error: no player_app_malloc_trace ELF; build it or pass --elf")
    return max(hits, key=os.path.getmtime)


def symbolize(addr2line: str, elf: str, pcs: list[int]) -> dict[int, str]:
    if not pcs:
        return {}
    out = subprocess.run(
        [addr2line, "-e", elf, "-f", "-C", "-s"] + [hex(p) for p in pcs],
        capture_output=True,
        text=True,
    ).stdout.splitlines()
    # addr2line -f prints two lines per address: function, then file:line
    res: dict[int, str] = {}
    for i, pc in enumerate(pcs):
        func = out[2 * i].strip() if 2 * i < len(out) else "??"
        loc = out[2 * i + 1].strip() if 2 * i + 1 < len(out) else "??"
        res[pc] = f"{func}  ({loc})"
    return res


def human(n: int) -> str:
    return f"{n/1024:.1f}K" if n >= 1024 else f"{n}B"


def main() -> int:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument("log", nargs="?", help="serial capture file (default: stdin)")
    ap.add_argument("--elf", help="flashed ELF (default: newest player_app_malloc_trace)")
    ap.add_argument("--addr2line", help="riscv32-esp-elf-addr2line path")
    args = ap.parse_args()

    text = open(args.log).read() if args.log else sys.stdin.read()
    # Keep the LAST occurrence of each site pc (the histogram is cumulative, so the
    # latest report is the most complete).
    sites: dict[int, tuple[int, int, int]] = {}  # pc -> (bytes, count, op)
    for m in SITE_RE.finditer(text):
        pc = int(m.group(1), 16)
        sites[pc] = (int(m.group(2)), int(m.group(3)), int(m.group(4)))
    if not sites:
        sys.exit("no `[mtrace] site` lines found in input")

    addr2line = find_addr2line(args.addr2line)
    elf = find_elf(args.elf)
    syms = symbolize(addr2line, elf, list(sites.keys()))

    rows = sorted(sites.items(), key=lambda kv: -kv[1][0])
    libc_b = sum(b for _pc, (b, _c, op) in rows if op < 4)
    caps_b = sum(b for _pc, (b, _c, op) in rows if op >= 4)
    total = libc_b + caps_b or 1

    print(f"ELF: {elf}")
    print(
        f"\n== cumulative heap by call site ({human(total)} total; "
        f"libc {human(libc_b)} / heap_caps {human(caps_b)}) =="
    )
    print(f"{'BYTES':>9} {'CNT':>6}  {'PATH':<10} CALLER")
    for pc, (b, c, op) in rows:
        path = "heap_caps" if op >= 4 else "libc"
        print(
            f"{human(b):>9} {c:>6}  {path:<10} {syms.get(pc, '?')}  [pc={pc:08x} {OP_NAME.get(op, op)}]"
        )
    return 0


if __name__ == "__main__":
    sys.exit(main())

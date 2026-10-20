"""Read + symbolize the firmware's post-boot heap census (LM_HEAP_CENSUS, see
firmware/player_app/heap_census_core.h) from a raw dump of the struct.

    heap_census.py ELF census.bin [--md out.md]

ram_audit dumps the struct over JTAG at the end of a run (no halt, no DUT-side
reporting); this maps each call site's return address to function+offset with
the ELF the image was linked from and renders the site table + the newest events.
"""

from __future__ import annotations

import argparse
import bisect
import shutil
import struct
import subprocess

MAGIC = 0x4C4D4843
SITES, RING, LIVE = 64, 128, 512
HDR = struct.Struct("<15I")
SITE = struct.Struct("<8I")
EVENT = struct.Struct("<5I4B")
KINDS = {
    1: "malloc",
    2: "calloc",
    3: "realloc",
    4: "caps_malloc",
    5: "caps_calloc",
    6: "caps_realloc",
    7: "aligned_alloc",
    8: "aligned_calloc",
    9: "free",
}
HDR_FIELDS = (
    "magic version layout frozen t_freeze_ms boot_allocs boot_bytes allocs bytes frees failed "
    "site_overflow live_overflow frees_untracked ring_total"
).split()


def elf_symbols(path: str) -> list[tuple[int, int, str]]:
    """(address, size, name) of every FUNC/OBJECT symbol in a little-endian ELF32."""
    with open(path, "rb") as fh:
        d = fh.read()
    (shoff,) = struct.unpack_from("<I", d, 0x20)
    shentsize, shnum = struct.unpack_from("<HH", d, 0x2E)
    secs = [struct.unpack_from("<IIIIIIIIII", d, shoff + i * shentsize) for i in range(shnum)]
    out = []
    for sec in secs:
        if sec[1] != 2:  # SHT_SYMTAB
            continue
        strtab = secs[sec[6]]
        for off in range(sec[4], sec[4] + sec[5], 16):
            st_name, value, size, info = struct.unpack_from("<IIIB", d, off)
            if info & 0xF not in (1, 2):  # OBJECT, FUNC
                continue
            s0 = strtab[4] + st_name
            out.append((value, size, d[s0 : d.index(b"\0", s0)].decode(errors="replace")))
    return sorted(out)


def symbol(elf_syms, name: str) -> tuple[int, int] | None:
    for value, size, n in elf_syms:
        if n == name:
            return value, size
    return None


class Symbolizer:
    def __init__(self, elf_syms):
        self.funcs = [s for s in elf_syms if s[1] > 0]
        self.addrs = [s[0] for s in self.funcs]
        self.cache: dict[str, str] = {}

    def demangle(self, name: str) -> str:
        if not name.startswith("_Z") or not shutil.which("c++filt"):
            return name
        if name not in self.cache:
            self.cache[name] = subprocess.run(
                ["c++filt", name], capture_output=True, text=True
            ).stdout.strip()
        return self.cache[name]

    def __call__(self, pc: int) -> str:
        i = bisect.bisect_right(self.addrs, pc) - 1
        if i >= 0:
            a, size, name = self.funcs[i]
            if pc < a + size + 4:  # a return address may sit just past a tail
                return f"{self.demangle(name)}+{pc - a:#x}"
        return f"{pc:#010x}"


def parse(blob: bytes) -> dict:
    hdr = dict(zip(HDR_FIELDS, HDR.unpack_from(blob, 0)))
    if hdr["magic"] != MAGIC:
        raise ValueError(f"not a census (magic {hdr['magic']:#x}; was lm_heap_freeze reached?)")
    if hdr["layout"] != (SITE.size << 16 | EVENT.size):
        raise ValueError(f"census layout {hdr['layout']:#x} != reader's; rebuild the reader")
    off = HDR.size
    sites = []
    for i in range(SITES):
        pc, count, nbytes, live, max_size, frees, failed, first_ms = SITE.unpack_from(blob, off)
        off += SITE.size
        if pc:
            sites.append(
                dict(
                    pc=pc,
                    count=count,
                    bytes=nbytes,
                    live=live,
                    max_size=max_size,
                    frees=frees,
                    failed=failed,
                    first_ms=first_ms,
                )
            )
    ring = []
    for i in range(RING):
        pc, ptr, size, t_ms, task, kind, isr, _, _ = EVENT.unpack_from(blob, off + i * EVENT.size)
        ring.append(dict(pc=pc, ptr=ptr, size=size, t_ms=t_ms, task=task, kind=kind, isr=isr))
    total = hdr["ring_total"]
    n = min(total, RING)
    start = total % RING if total > RING else 0
    events = [ring[(start + k) % RING] for k in range(n)]
    return dict(header=hdr, sites=sites, events=events)


def task_name(v: int) -> str:
    if v == 0:
        return "(isr)"
    return bytes((v >> (8 * i)) & 0xFF for i in range(4)).rstrip(b"\0").decode(errors="replace")


def render(census: dict, sym: Symbolizer, newest: int = 40) -> str:
    h = census["header"]
    lines = [
        "# Post-boot heap census",
        "",
        f"Frozen at {h['t_freeze_ms']} ms. Before the freeze: {h['boot_allocs']} allocations, "
        f"{h['boot_bytes']} B (counted, not attributed).",
        f"After: {h['allocs']} allocations ({h['bytes']} B), {h['frees']} frees "
        f"({h['frees_untracked']} of blocks from before the freeze or untracked), "
        f"{h['failed']} failed; overflow: sites {h['site_overflow']}, live map {h['live_overflow']}.",
        "",
        "| call site | allocs | bytes | live B | max | frees | failed | first ms |",
        "|---|---:|---:|---:|---:|---:|---:|---:|",
    ]
    for s in sorted(census["sites"], key=lambda s: (-s["bytes"], -s["count"])):
        lines.append(
            f"| `{sym(s['pc'])}` | {s['count']} | {s['bytes']} | {s['live']} | {s['max_size']} "
            f"| {s['frees']} | {s['failed']} | {s['first_ms']} |"
        )
    lines += [
        "",
        f"## Newest {newest} events",
        "",
        "| ms | task | kind | size | site |",
        "|---:|---|---|---:|---|",
    ]
    for e in census["events"][-newest:]:
        lines.append(
            f"| {e['t_ms']} | {task_name(e['task'])} | {KINDS.get(e['kind'], e['kind'])} "
            f"| {e['size']} | `{sym(e['pc'])}` |"
        )
    return "\n".join(lines) + "\n"


def main() -> int:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument("elf")
    ap.add_argument("census_bin")
    ap.add_argument("--md", help="write the markdown report here (default: stdout)")
    args = ap.parse_args()
    syms = elf_symbols(args.elf)
    with open(args.census_bin, "rb") as fh:
        census = parse(fh.read())
    text = render(census, Symbolizer(syms))
    if args.md:
        with open(args.md, "w") as fh:
            fh.write(text)
    else:
        print(text, end="")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

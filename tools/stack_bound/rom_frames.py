"""Generate the `rom_frames` table of a stack_bound manifest: the worst-case stack
of every mask-ROM function a firmware ELF calls.

The firmware ELF has no ROM code (only `A` symbols at the ROM jump-table / function
addresses), so stack_bound used to count every ROM call as a 0-byte leaf. That hid
the newlib printf family, which is in ROM on the C6: `_svfprintf_r` alone has a
1,072 B frame, so `Log().printf` (Print::vprintf -> vsnprintf) costs ~1.2 KB more
than the bound said (#384: the xmit task overflowed on its reconfigure log line).

The ROM is fixed per chip revision, so the table is generated once from Espressif's
ROM ELF and checked in. ROM newlib reaches the IDF side only through its syscall
table (`_write_r`, `_malloc_r`, the locks, ...); those stubs are recorded per entry
(`via`) and stack_bound adds the firmware implementation's own depth on top.

  python3 tools/stack_bound/rom_frames.py <objdump> <rom.elf> <firmware.elf>

ROM ELF: esp32c6_rev0_rom.elf from github.com/espressif/esp-rom-elfs release
20240305 (sha256 788e1d38724aeb8fd974fa10c4a7b089c02627d35342ce84b9e0b12b239f3551).
"""

import json
import subprocess
import sys

import stack_bound

ROM_LO, ROM_HI = 0x40000000, 0x40050000
# newlib's reentrant syscall stubs: in ROM they jump through syscall_table_ptr into
# the firmware's implementations of the same names.
SYSCALLS = (
    "_write_r",
    "_read_r",
    "_open_r",
    "_close_r",
    "_lseek_r",
    "_fstat_r",
    "_malloc_r",
    "_free_r",
    "_realloc_r",
    "_calloc_r",
    "_lock_acquire",
    "_lock_acquire_recursive",
    "_lock_release",
    "_lock_release_recursive",
    "_lock_try_acquire",
    "_lock_try_acquire_recursive",
    "_lock_init",
    "_lock_init_recursive",
)

# Stream output reaches the device through the FILE's write hook (__swrite, an
# indirect call in ROM) and then _write_r: charge it to the functions that write a
# stream (not to the string formatters, whose FILE is a buffer).
STREAM_WRITERS = (
    "printf",
    "vprintf",
    "fprintf",
    "vfprintf",
    "puts",
    "putchar",
    "fputs",
    "fputc",
    "fwrite",
    "fflush",
    "_fflush_r",
    "__swbuf_r",
)
# ROM functions the firmware reaches only through a function pointer (so they never
# appear as a direct callee): esp_log's default esp_log_vprint_func is ROM vprintf.
INDIRECT_ONLY = ("vprintf",)


def _syms(elf):
    out = subprocess.run(["nm", elf], capture_output=True, text=True, check=True).stdout
    by_addr = {}
    for line in out.splitlines():
        p = line.split()
        if len(p) == 3:
            a = int(p[0], 16)
            if ROM_LO <= a < ROM_HI:
                by_addr.setdefault(a, []).append(p[2])
    return by_addr


def main():
    objdump, rom_elf, fw_elf = sys.argv[1:4]
    rom = stack_bound.parse(stack_bound.objdump(objdump, rom_elf))
    fw = stack_bound.parse(stack_bound.objdump(objdump, fw_elf))
    b = stack_bound.Bound(rom, {"noreturn": ["^abort$", "^__assert"]})
    rom_by_addr = _syms(rom_elf)
    fw_rom = {n: a for a, ns in _syms(fw_elf).items() for n in ns}

    def reach(name):
        seen, st = {name}, [name]
        while st:
            f = rom.get(st.pop())
            for c in (f["calls"] | f["tails"]) if f else ():
                if c not in seen:
                    seen.add(c)
                    st.append(c)
        return seen

    called = {c for f in fw.values() for c in f["calls"] | f["tails"] if c not in fw}
    called |= set(INDIRECT_ONLY)
    table = {}
    for name in sorted(called):
        if name not in fw_rom:
            continue
        cands = [n for n in rom_by_addr.get(fw_rom[name], []) if n in rom] or (
            [name] if name in rom else []
        )
        if not cands:
            continue
        depth = max(b.depth(c)[0] for c in cands)
        via = {s for c in cands for s in reach(c) if s in SYSCALLS}
        if name in STREAM_WRITERS:
            via.add("_write_r")
        via = sorted(via)
        if depth or via:
            table[name] = [depth, via]
    json.dump(table, sys.stdout, indent=None, separators=(",", ":"), sort_keys=True)
    print()


if __name__ == "__main__":
    main()

"""heap_census: parse a raw LM_HEAP_CENSUS dump (layout of
firmware/player_app/heap_census_core.h), order the ring, render the report."""

import struct

import heap_census as hc
import pytest


def blob(sites=(), events=(), ring_total=None, magic=hc.MAGIC, layout=None):
    hdr = [0] * 15
    hdr[0], hdr[1] = magic, 1
    hdr[2] = (hc.SITE.size << 16 | hc.EVENT.size) if layout is None else layout
    hdr[3], hdr[4] = 1, 1000
    hdr[7] = sum(s[1] for s in sites)
    hdr[14] = len(events) if ring_total is None else ring_total
    out = bytearray(hc.HDR.pack(*hdr))
    for i in range(hc.SITES):
        s = sites[i] if i < len(sites) else (0,) * 8
        out += hc.SITE.pack(*s)
    for i in range(hc.RING):
        e = events[i] if i < len(events) else (0, 0, 0, 0, 0, 0, 0, 0, 0)
        out += hc.EVENT.pack(*e)
    out += bytes(hc.LIVE * 9)
    return bytes(out)


def test_struct_sizes_match_the_firmware_layout():
    # sizeof(Site) == 32, sizeof(Event) == 24 (5 x u32 + 4 x u8), header 15 x u32.
    assert (hc.HDR.size, hc.SITE.size, hc.EVENT.size) == (60, 32, 24)


def test_parse_sites_and_ring_in_order():
    sites = [(0x42001000, 3, 300, 100, 200, 2, 0, 5)]
    loop = int.from_bytes(b"loop", "little")
    events = [(0x42001000, 0x40850000 + i, 10 * i, i, loop, 1, 0, 0, 0) for i in range(5)]
    c = hc.parse(blob(sites, events))
    assert c["sites"] == [
        dict(
            pc=0x42001000, count=3, bytes=300, live=100, max_size=200, frees=2, failed=0, first_ms=5
        )
    ]
    assert [e["t_ms"] for e in c["events"]] == [0, 1, 2, 3, 4]
    assert hc.task_name(c["events"][0]["task"]) == "loop" and hc.task_name(0) == "(isr)"


def test_wrapped_ring_starts_at_the_oldest_event():
    events = [(1, 0, 0, i, 0, 1, 0, 0, 0) for i in range(hc.RING)]
    # 130 events ever: slots 0,1 hold events 128,129 (t=0,1 here); the oldest kept is slot 2.
    c = hc.parse(blob(events=events, ring_total=hc.RING + 2))
    assert [e["t_ms"] for e in c["events"]][:2] == [2, 3]
    assert len(c["events"]) == hc.RING


def test_rejects_wrong_magic_or_layout():
    with pytest.raises(ValueError, match="magic"):
        hc.parse(blob(magic=0))
    with pytest.raises(ValueError, match="layout"):
        hc.parse(blob(layout=1))


def test_render_symbolizes_call_sites():
    syms = [(0x42001000, 0x40, "netstack_alloc"), (0x42002000, 0x10, "_Z3foov")]
    sym = hc.Symbolizer(syms)
    assert sym(0x42001010) == "netstack_alloc+0x10"
    assert sym(0x43000000) == "0x43000000"
    md = hc.render(hc.parse(blob([(0x42001010, 1, 64, 64, 64, 0, 0, 1)])), sym)
    assert "`netstack_alloc+0x10` | 1 | 64 | 64 |" in md


def test_elf_symbol_table_round_trip(tmp_path):
    # A minimal ELF32 with one SYMTAB: proves the reader's offsets.
    strtab = b"\0LM_HEAP_CENSUS\0f\0"
    syms = struct.pack("<IIIBBH", 0, 0, 0, 0, 0, 0)
    syms += struct.pack("<IIIBBH", 1, 0x4083AC4C, 0x263C, 1, 0, 1)  # OBJECT
    syms += struct.pack("<IIIBBH", 16, 0x42000000, 8, 2, 0, 1)  # FUNC
    shoff = 52
    body_off = shoff + 3 * 40
    sh = [
        (0,) * 10,
        (0, 2, 0, 0, body_off, len(syms), 2, 0, 4, 16),  # SYMTAB, link -> 2
        (0, 3, 0, 0, body_off + len(syms), len(strtab), 0, 0, 1, 0),  # STRTAB
    ]
    ehdr = bytearray(52)
    struct.pack_into("<I", ehdr, 0x20, shoff)
    struct.pack_into("<HH", ehdr, 0x2E, 40, 3)
    data = bytes(ehdr) + b"".join(struct.pack("<10I", *s) for s in sh) + syms + strtab
    p = tmp_path / "x.elf"
    p.write_bytes(data)
    got = hc.elf_symbols(str(p))
    assert hc.symbol(got, "LM_HEAP_CENSUS") == (0x4083AC4C, 0x263C)
    assert hc.symbol(got, "f") == (0x42000000, 8)

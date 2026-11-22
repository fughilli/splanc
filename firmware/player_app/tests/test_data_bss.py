"""Gate: no big, mostly-zero static in the shipped image's initialized data.

`.dram0.data` is stored in the flash image (and copied to RAM at boot); `.bss` costs
RAM only. A Rust `static mut` lands in `.data` as soon as one byte of its const
initializer is non-zero, and `Option<T>::None` usually is non-zero (the niche lives in a
`bool`/enum byte inside `T`). That put ~53 KB of almost-all-zero statics in flash
(wifi_sta_ffi::RX 27.5 KB for one `owned_by_hw: true` per slot, DECK_A 11.6 KB,
wifi_sta_ffi::TCP 6.3 KB, IMPROV_SVC 4.2 KB, PLAYER 2.3 KB, ...). They now start
all-zero (//firmware/bss BssOption, in-place init); this test keeps it that way.

It reads the ELF directly (no tools): every symbol in `.dram0.data` of at least
MIN_SIZE bytes whose initializer is less than MAX_NONZERO non-zero must be made
zero-initialized (or, for a prebuilt vendor object we can't change, listed in ALLOW)."""

import os
import struct
import unittest

MIN_SIZE = 256
MAX_NONZERO = 0.05
# Prebuilt vendor objects (libpp/libphy/...): not ours to change.
ALLOW = {"TxRxCxt", "eb_txdesc_space", "phy_param", "s_retention", "setup_timer_param"}


def runfile(rel):
    from python.runfiles import runfiles

    p = runfiles.Create().Rlocation(rel)
    assert p and os.path.exists(p), rel
    return p


def sections(f):
    assert f[:4] == b"\x7fELF" and f[4] == 1 and f[5] == 1, "not a 32-bit LE ELF"
    shoff = struct.unpack_from("<I", f, 0x20)[0]
    shentsize, shnum, shstrndx = struct.unpack_from("<HHH", f, 0x2E)
    secs = [struct.unpack_from("<10I", f, shoff + i * shentsize) for i in range(shnum)]
    strtab = secs[shstrndx][4]

    def name(off):
        return f[strtab + off : f.index(b"\0", strtab + off)].decode()

    return [(name(s[0]),) + s for s in secs]


def sparse_data_symbols(path):
    f = open(path, "rb").read()
    secs = sections(f)
    idx = {s[0]: i for i, s in enumerate(secs)}
    data_i = idx[".dram0.data"]
    _, _, _, _, d_addr, d_off, d_size = secs[data_i][:7]
    symtab = secs[idx[".symtab"]]
    sym_off, sym_size, sym_link = symtab[5], symtab[6], symtab[7]
    str_off = secs[sym_link][5]
    out = []
    for o in range(sym_off, sym_off + sym_size, 16):
        st_name, value, size, info, _other, shndx = struct.unpack_from("<IIIBBH", f, o)
        if shndx != data_i or size < MIN_SIZE or (info & 0xF) != 1:  # STT_OBJECT
            continue
        name = f[str_off + st_name : f.index(b"\0", str_off + st_name)].decode()
        b = f[d_off + value - d_addr : d_off + value - d_addr + size]
        nz = sum(1 for x in b if x)
        out.append((name, size, nz))
    return out


class DataBssTest(unittest.TestCase):
    def test_no_mostly_zero_statics_in_data(self):
        syms = sparse_data_symbols(runfile(os.environ["ELF"]))
        self.assertTrue(syms, "no .dram0.data symbols found: wrong ELF?")
        bad = [
            "%s: %d B with only %d non-zero bytes" % (n, s, nz)
            for n, s, nz in syms
            if nz < MAX_NONZERO * s and not any(n == a or n.startswith(a + ".") for a in ALLOW)
        ]
        self.assertEqual(
            bad,
            [],
            "mostly-zero statics in .data (flash): make them start all-zero "
            "(//firmware/bss BssOption, or zeroed storage + in-place init)",
        )


if __name__ == "__main__":
    unittest.main()

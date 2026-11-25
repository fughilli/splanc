"""MODVERSIONS CRCs from stock kernel modules, for rebuilding in-tree modules without the
kernel's build tree (the image kernel's `dev` output is not in any binary cache).

  symvers.py imports STOCK.ko...           Module.symvers lines for every symbol the stock
                                           modules import, minus what they export themselves
                                           (those are rebuilt alongside).
  symvers.py check NEW.symvers STOCK.ko... Every symbol the rebuilt modules export that a
                                           stock module imports carries the same CRC:
                                           the rebuild is ABI-identical to the stock build.
"""

import struct
import sys


def sections(path):
    b = open(path, "rb").read()
    (shoff,) = struct.unpack_from("<Q", b, 0x28)
    shentsize, shnum, shstrndx = struct.unpack_from("<HHH", b, 0x3A)
    sh = [struct.unpack_from("<IIQQQQIIQQ", b, shoff + i * shentsize) for i in range(shnum)]
    strtab = sh[shstrndx]

    def name(o):
        return b[strtab[4] + o : b.index(b"\0", strtab[4] + o)].decode()

    return {name(s[0]): b[s[4] : s[4] + s[5]] for s in sh}


def imports(kos):
    out = {}
    for ko in kos:
        v = sections(ko).get("__versions", b"")
        for i in range(0, len(v), 64):
            (crc,) = struct.unpack_from("<Q", v, i)
            out[v[i + 8 : i + 64].split(b"\0")[0].decode()] = crc & 0xFFFFFFFF
    return out


def exports(kos):
    names = set()
    for ko in kos:
        s = sections(ko).get("__ksymtab_strings", b"")
        names.update(n.decode() for n in s.split(b"\0") if n)
    return names


def main(argv):
    if argv[0] == "imports":
        kos = argv[1:]
        own = exports(kos)
        for nm, crc in sorted(imports(kos).items()):
            if nm not in own:
                print(f"0x{crc:08x}\t{nm}\tvmlinux\tEXPORT_SYMBOL\t")
        return 0
    if argv[0] == "check":
        new = {}
        for line in open(argv[1]):
            f = line.rstrip("\n").split("\t")
            new[f[1]] = int(f[0], 16)
        stock = imports(argv[2:])
        shared = sorted(set(new) & set(stock))
        bad = [nm for nm in shared if new[nm] != stock[nm]]
        for nm in bad:
            print(f"CRC mismatch: {nm} rebuilt 0x{new[nm]:08x} stock 0x{stock[nm]:08x}")
        print(f"{len(shared)} exported symbols checked against stock imports, {len(bad)} differ")
        return 1 if bad or not shared else 0
    print(__doc__)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

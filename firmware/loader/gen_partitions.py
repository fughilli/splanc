"""Partition table CSV -> the binary the IDF bootloader reads at 0x8000.

  gen_partitions.py --csv partitions_ota.csv --bin out.bin [--header out.h]

Same format as ESP-IDF's gen_esp32part.py (32-byte entries, magic 0xAA50, then the
0xEBEB MD5 entry over the entries, 0xFF-padded to 0xC00), for the handful of
types/subtypes this layout uses. Also checks the layout: 4 KiB alignment (64 KiB
for apps), no overlap, inside 4 MiB, and after the 0x9000 table area. --header
emits the offsets/sizes for C++ (the loader's migration needs the OLD littlefs
region, which is not in the new table).
"""

import argparse
import hashlib
import struct
import sys

TYPES = {"app": 0x00, "data": 0x01}
SUBTYPES = {
    ("app", "factory"): 0x00,
    ("app", "ota_0"): 0x10,
    ("app", "ota_1"): 0x11,
    ("data", "ota"): 0x00,
    ("data", "phy"): 0x01,
    ("data", "nvs"): 0x02,
    ("data", "coredump"): 0x03,
    ("data", "spiffs"): 0x82,
}
FLASH_SIZE = 4 * 1024 * 1024
TABLE_LEN = 0xC00


def parse(path):
    rows = []
    for line in open(path):
        line = line.split("#", 1)[0].strip()
        if not line:
            continue
        f = [x.strip() for x in line.split(",")]
        name, typ, sub, off, size = f[:5]
        flags = f[5] if len(f) > 5 else ""
        rows.append((name, typ, sub, int(off, 0), int(size, 0), flags))
    return rows


def check(rows):
    end = 0x9000
    for name, typ, sub, off, size, _ in sorted(rows, key=lambda r: r[3]):
        align = 0x10000 if typ == "app" else 0x1000
        if off % align or size % 0x1000:
            sys.exit("gen_partitions: %s misaligned (0x%x/0x%x)" % (name, off, size))
        if off < end:
            sys.exit("gen_partitions: %s at 0x%x overlaps the previous partition" % (name, off))
        end = off + size
        if end > FLASH_SIZE:
            sys.exit("gen_partitions: %s ends at 0x%x, past 4 MiB" % (name, end))
        if len(name) > 15:
            sys.exit("gen_partitions: name %s too long" % name)


def encode(rows):
    out = b""
    for name, typ, sub, off, size, flags in rows:
        fl = (1 if "encrypted" in flags else 0) | (2 if "readonly" in flags else 0)
        out += struct.pack(
            "<2sBBLL16sL",
            b"\xaa\x50",
            TYPES[typ],
            SUBTYPES[(typ, sub)],
            off,
            size,
            name.encode().ljust(16, b"\0"),
            fl,
        )
    out += b"\xeb\xeb" + b"\xff" * 14 + hashlib.md5(out).digest()
    if len(out) > TABLE_LEN:
        sys.exit("gen_partitions: table too long")
    return out + b"\xff" * (TABLE_LEN - len(out))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--csv", required=True)
    ap.add_argument("--bin", required=True)
    ap.add_argument("--header")
    a = ap.parse_args()
    rows = parse(a.csv)
    check(rows)
    open(a.bin, "wb").write(encode(rows))
    if a.header:
        with open(a.header, "w") as h:
            h.write(
                "// Generated from %s by gen_partitions.py. Do not edit.\n#pragma once\n" % a.csv
            )
            for name, _, _, off, size, _ in rows:
                n = name.upper()
                h.write(
                    "#define OTA_PART_%s_OFFSET 0x%xu\n#define OTA_PART_%s_SIZE 0x%xu\n"
                    % (n, off, n, size)
                )


if __name__ == "__main__":
    main()

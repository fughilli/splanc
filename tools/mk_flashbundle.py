#!/usr/bin/env python3
"""Package an esptool_flash target's images into one self-describing flash bundle:
a tar of `flash.json` (chip + flash params + offset→file list) plus the referenced
.bin files, flattened to basenames.

The launcher (`@embedded//rules:flash.bzl` esptool_flash) is the source of truth for
the chip, flash mode/freq/size, and every `0xADDR $(rlocation …)` image pair, in
order. We parse those from the launcher text and bind each to the matching --bin
file (by basename), so the bundle can't drift from what `flash_*` actually writes.

  mk_flashbundle.py --launcher L.sh --out B.tar --bin a.bin --bin b.bin …
"""
import argparse
import io
import json
import os
import re
import sys
import tarfile

# `'0xADDR' "$(rlocation LOGICAL)"` — offset/image pairs, in launch order.
_PAIR = re.compile(r'\'(0x[0-9a-fA-F]+)\'\s*"\$\(rlocation\s+([^)]+)\)"')


def _opt(text, name, default):
    m = re.search(r"'%s'\s*'([^']*)'" % re.escape(name), text)
    return m.group(1) if m else default


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--launcher", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--bin", action="append", default=[], dest="bins")
    a = ap.parse_args()

    text = open(a.launcher).read()
    by_base = {os.path.basename(p): p for p in a.bins}

    chip = _opt(text, "--chip", "esp32c6")
    fm = _opt(text, "--flash-mode", "keep")
    ff = _opt(text, "--flash-freq", "keep")
    fs = _opt(text, "--flash-size", "keep")

    images = []
    for offset, logical in _PAIR.findall(text):
        base = os.path.basename(logical)
        real = by_base.get(base)
        if not real:
            sys.exit("mk_flashbundle: no --bin supplied for %s (%s)" % (offset, base))
        images.append((offset, base, real))

    if not images:
        sys.exit("mk_flashbundle: no image pairs parsed from %s" % a.launcher)

    manifest = {
        "chip": chip,
        "flash_mode": fm,
        "flash_freq": ff,
        "flash_size": fs,
        "images": [{"offset": off, "file": name} for off, name, _ in images],
    }

    # Deterministic tar (sorted addfile order, zeroed mtime/uid) for reproducibility.
    with tarfile.open(a.out, "w") as tar:
        blob = (json.dumps(manifest, indent=2) + "\n").encode()
        info = tarfile.TarInfo("flash.json")
        info.size = len(blob)
        tar.addfile(info, io.BytesIO(blob))
        for _, name, real in images:
            data = open(real, "rb").read()
            info = tarfile.TarInfo(name)
            info.size = len(data)
            tar.addfile(info, io.BytesIO(data))

    sys.stderr.write(
        "wrote %s: chip=%s %s\n" % (a.out, chip, " ".join("%s->%s" % (o, n) for o, n, _ in images))
    )


if __name__ == "__main__":
    main()

"""Check splanc-splash's SH1106 byte stream against luma.oled (the build's check).

    check_stream.py STREAM FRAME STAGE

STREAM is what ``splanc-splash run --oled=file:STREAM`` wrote (records of: DC
level, u16 length, bytes), FRAME/STAGE the frame index and stage its hand-off
reply named. Checks that

* the init sequence is luma.oled's sh1106 init (what splanc-display's luma would
  send) followed by splanc-display's contrast, so the panel is configured
  exactly as splanc-display expects when it takes over without re-initialising;
* replaying the stream into a model of the SH1106's RAM gives the same pixels
  as luma's own sh1106.display() (rotate=2, as splanc-display) of the frame
  splanc-display renders for that moment: boot_frames.bin + the stage text.

Needs the image's Python env (Pillow, luma.oled) and splanc_display on the path.
"""

from __future__ import annotations

import struct
import sys

ARG_CMDS = {0x81, 0xA8, 0xD3, 0xD5, 0xD9, 0xDA, 0xDB, 0x8D, 0xAD}


class Capture:
    """A luma serial interface that records (dc, bytes)."""

    def __init__(self):
        self.recs = []

    def command(self, *cmd):
        self.recs.append((0, bytes(cmd)))

    def data(self, data):
        self.recs.append((1, bytes(data)))

    def cleanup(self):
        pass


def read_stream(path):
    recs, data = [], open(path, "rb").read()
    i = 0
    while i + 3 <= len(data):
        dc, n = data[i], struct.unpack("<H", data[i + 1 : i + 3])[0]
        recs.append((dc, data[i + 3 : i + 3 + n]))
        i += 3 + n
    assert i == len(data), "truncated stream"
    return recs


def ram(recs):
    """SH1106 display RAM (8 pages x 132 columns) after ``recs``."""
    mem = [[0] * 132 for _ in range(8)]
    page = col = 0
    for dc, b in recs:
        if dc:
            for x in b:
                if col < 132:
                    mem[page][col] = x
                col += 1
            continue
        i = 0
        while i < len(b):
            c = b[i]
            if 0xB0 <= c <= 0xB7:
                page = c - 0xB0
            elif c <= 0x0F:
                col = (col & 0xF0) | c
            elif 0x10 <= c <= 0x1F:
                col = (col & 0x0F) | ((c & 0x0F) << 4)
            elif c in ARG_CMDS:
                i += 1
            i += 1
    return mem


def main(argv) -> int:
    path, fi, stage = argv[1], int(argv[2]), int(argv[3])
    from luma.oled.device import sh1106
    from splanc_display import boot, splash

    ours = read_stream(path)
    cap = Capture()
    dev = sh1106(cap, width=128, height=64, rotate=2)
    luma_init = cap.recs[0][1]
    want_init = luma_init + bytes([0x81, 0xCF])
    assert ours[0] == (
        0,
        want_init,
    ), f"init differs:\n ours {ours[0][1].hex()}\n luma {want_init.hex()}"

    frames = boot.load()
    img = frames.frames[frames.index(fi / frames.fps)].copy()
    if frames.loop_start is not None and fi >= frames.loop_start:
        splash.draw_stage(img, splash.STAGES[stage])
    cap.recs.clear()
    dev.display(img)
    want, got = ram(cap.recs), ram(ours)
    for p in range(8):
        assert got[p][2:130] == want[p][2:130], f"page {p} differs from luma's display()"
    lit = sum(bin(x).count("1") for p in got for x in p)
    print(
        f"stream ok: init = luma sh1106 + contrast; frame {fi} (stage {stage}) = luma display(), {lit} px lit"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))

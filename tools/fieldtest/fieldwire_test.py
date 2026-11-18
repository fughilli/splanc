"""fieldwire: flash images and serial copies decode as the firmware writes them
(firmware/fieldtest/field_node.cpp: log_append / emit_block / WinHdr / Entry / Ctrl)."""

import base64
import struct
import unittest
import zlib

import fieldwire as fw


def tlv(typ: str, payload: bytes, pad: bool = True) -> bytes:
    b = (
        b"S"
        + typ.encode()
        + struct.pack("<HI", len(payload), zlib.crc32(payload) & 0xFFFFFFFF)
        + payload
    )
    if pad:
        b += b"\xff" * (-len(b) % 4)
    return b


def window(node, phase, boot, win, up_ms, entries):
    head = fw.WIN_HDR.pack(node, phase, boot, win, up_ms, 7, len(entries), 6, 20, 0)
    return head + b"".join(fw.ENTRY.pack(*e) for e in entries)


def phase_rec(node, boot, up_ms, epoch, unix, phase, label):
    ctrl = fw.CTRL.pack(
        epoch,
        unix,
        250,
        phase,
        1,
        label.encode(),
        0,
        0,
        8,
        2,
        bytes([0, 0x0B, 0, 0]),
        255,
        255,
        0,
        255,
        255,
        255,
    )
    return ctrl + fw.PHASE_TAIL.pack(up_ms, boot, node, 1, -40)


# peer rate rx exp rmean rmin rmax rstd4 urx uexp aok afail nf ptx flags dup
E_PEER = (2, 0x00, 9, 10, -60, -66, -55, 8, 4, 5, 5, 0, -97, 20, 0, 0)
E_SELF = (1, 0x0B, 10, 0, 0, 0, 0, 0, 5, 0, 0, 0, 0, 20, fw.F_SELF, 0)


class FieldwireTest(unittest.TestCase):
    def test_flash_image_roundtrip_and_torn_sector(self):
        img = bytearray()
        img += tlv("P", phase_rec(1, 3, 5000, 100, 1_800_000_000, 2, "b_static"))
        img += tlv("W", window(1, 2, 3, 0, 6000, [E_PEER, E_SELF]))
        img += b"S" + b"W" + b"\x40\x00" + b"\x00" * 10  # torn block: bad CRC
        img += b"\xab" * (4096 - len(img))  # junk to the sector end
        img += tlv("W", window(1, 2, 3, 1, 8000, [E_PEER]))
        img += b"\xff" * 64
        got = [(t, len(p)) for _, t, p in fw.blocks(bytes(img))]
        self.assertEqual([t for t, _ in got], ["P", "W", "W"])

        ds = fw.Dataset()
        for _, t, p in fw.blocks(bytes(img)):
            ds._block(t, p, "flash")
        self.assertEqual(len(ds.windows), 2)
        w = ds.windows[(1, 3, 0)]
        self.assertEqual(w.entries[0].rate, "1")
        self.assertEqual(w.entries[1].rate, "6")
        self.assertEqual((w.entries[0].rx, w.entries[0].exp, w.entries[0].rstd), (9, 10, 2.0))
        ph = ds.phases[0]
        self.assertEqual((ph.phase, ph.label, ph.pwr, ph.rates), (2, "b_static", 8, ["1", "6"]))
        # uptime 5.0 s at unix 1.8e9 + 0.25 s of relay age
        self.assertAlmostEqual(ds.wall_offset(1, 3), 1_800_000_000 + 0.25 - 5.0)

    def test_serial_copies_and_preference(self):
        w = window(2, 1, 1, 4, 9000, [E_PEER])
        b64 = base64.b64encode(tlv("W", w, pad=False)).decode()
        self.assertEqual(fw.tlv_from_b64(b64)[0], "W")
        self.assertIsNone(fw.tlv_from_b64(b64[:-8] + "AAAAAAA="))
        ds = fw.Dataset()
        t, p = fw.tlv_from_b64(b64)
        ds._block(t, p, "air")
        ds._block(t, p, "flash")
        ds._block(t, p, "serial")
        self.assertEqual(ds.windows[(2, 1, 4)].source, "flash")

    def test_mesh_window(self):
        head = fw.WIN_HDR.pack(3, 2, 1, 5, 1000, 0, 2, 6, 20, 0)
        body = fw.MENTRY.pack(1, 9, 10, 1, 2, -50, 12) + fw.MENTRY.pack(2, 5, 5, 1, 1, -40, 5)
        m = fw.parse_mesh_window(head + body)
        self.assertEqual(
            [(e.origin, e.rx, e.exp, e.hsum) for e in m.entries], [(1, 9, 10, 12), (2, 5, 5, 5)]
        )


if __name__ == "__main__":
    unittest.main()

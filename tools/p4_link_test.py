"""p4_link.py against the vectors firmware/p4/link/link_codec_test.cc pins."""

import unittest

import p4_link as L


class LinkCodecTest(unittest.TestCase):
    def test_crc_check_value(self):
        self.assertEqual(L.crc16(b"123456789"), 0x29B1)

    def test_vectors(self):
        f = L.Frame(L.PLAYER, bytes([0x0A, 0x00, 0x12, 0x34]), session=0x0102, seq=7)
        self.assertEqual(f.pack()[:L.HEADER].hex(), "010100000201070004008bda")
        self.assertEqual(L.encode(f).hex(), "0003010101040201070204048bda0a03123400")
        self.assertEqual(L.encode(L.Frame(L.LOG, b"hi\n")).hex(), "000301060101010101020306e81168690a00")

    def test_roundtrips(self):
        for n in (0, 1, 241, 242, 243, 253, 254, 255, 600, 4095, 4096):
            payload = bytes((i * 7 + 1) % 256 for i in range(n))
            f = L.Frame(L.REPLY, payload, lane=1, flags=L.MORE, session=9, seq=300)
            wire = L.encode(f)
            self.assertNotIn(0, wire[1:-1])
            self.assertEqual(L.StreamDecoder().feed(wire), [f])

    def test_resync_and_noise(self):
        wire = L.encode(L.Frame(L.PLAYER, b"\1\2\3", seq=1))
        stream = b"ESP-ROM:esp32p4\r\n" + wire[: len(wire) // 2] + wire
        got = L.StreamDecoder().feed(stream)
        self.assertEqual(len(got), 3)
        self.assertEqual(got[0], b"ESP-ROM:esp32p4\r\n")
        self.assertIsInstance(got[1], bytes)
        self.assertEqual(got[2].payload, b"\1\2\3")

    def test_split_feed(self):
        wire = L.encode(L.Frame(L.PUSH, b"abc\0def"))
        dec = L.StreamDecoder()
        out = []
        for b in wire:
            out += dec.feed(bytes([b]))
        self.assertEqual([f.payload for f in out], [b"abc\0def"])

    def test_fragments(self):
        msg = bytes(range(256)) * 40  # 10240 B -> 3 frames
        frames = L.fragments(L.PLAYER, msg, session=3)
        self.assertEqual([len(f.payload) for f in frames], [4096, 4096, 2048])
        self.assertEqual([f.flags for f in frames], [L.MORE, L.MORE, 0])
        r = L.Reassembler()
        self.assertEqual([r.push(f) for f in frames], [None, None, msg])


if __name__ == "__main__":
    unittest.main()

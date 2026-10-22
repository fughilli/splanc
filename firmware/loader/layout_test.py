"""The OTA flash layout holds what ships: both images fit their slots (with the
headroom the design promises), the table binary matches the CSV, and the app slot
still covers the legacy littlefs superblock (the migration's "an installed app
always destroys the old filesystem" invariant, docs/design/ota.md "Migration")."""

import os
import unittest

import gen_partitions

LEGACY_FS_OFFSET = 0x310000


def rf(var):
    p = os.environ[var]
    base = os.environ.get("RUNFILES_DIR") or os.environ.get("TEST_SRCDIR") or ""
    for cand in (os.path.join(base, "_main", p), p):
        if os.path.exists(cand):
            return cand
    raise FileNotFoundError(p)


class LayoutTest(unittest.TestCase):
    def setUp(self):
        self.parts = {r[0]: r for r in gen_partitions.parse(rf("CSV"))}

    def slot(self, name):
        _, _, _, off, size, _ = self.parts[name]
        return off, size

    def test_table_binary_matches_csv(self):
        rows = gen_partitions.parse(rf("CSV"))
        with open(rf("PT_BIN"), "rb") as f:
            self.assertEqual(f.read(), gen_partitions.encode(rows))

    def test_nvs_and_otadata_never_move(self):
        self.assertEqual(self.slot("nvs"), (0x9000, 0x5000))
        self.assertEqual(self.slot("otadata"), (0xE000, 0x2000))

    def test_loader_fits(self):
        _, size = self.slot("loader")
        for var in ("LOADER_BIN", "LOADER_TESTKEY_BIN"):
            n = os.path.getsize(rf(var))
            self.assertLessEqual(n, size - 16 * 1024, "%s is %d B in a %d B slot" % (var, n, size))

    def test_app_fits_with_headroom(self):
        _, size = self.slot("app")
        n = os.path.getsize(rf("APP_BIN"))
        # Keep 64 KiB spare so the next release doesn't silently stop fitting.
        self.assertLessEqual(n, size - 64 * 1024, "app is %d B in a %d B slot" % (n, size))

    def test_littlefs_holds_a_2048_led_upload(self):
        # PR #335: 1024 LEDs/channel x 2 channels. A map + topology upload peaks at ~245 KB
        # (the old map stays until the new one lands); keep >= 320 KB for littlefs's
        # copy-on-write blocks and the other files (effect, keypoints, TLS identity, LUT).
        _, size = self.slot("spiffs")
        self.assertGreaterEqual(size, 320 * 1024)

    def test_an_installed_app_covers_the_legacy_superblock(self):
        off, size = self.slot("app")
        n = os.path.getsize(rf("APP_BIN"))
        self.assertLess(off, LEGACY_FS_OFFSET)
        self.assertGreater(off + n, LEGACY_FS_OFFSET + 2 * 4096)
        # ...and the new littlefs + loader sit entirely below the legacy region, so the
        # USB migration's writes leave it intact for the copy.
        for name in ("loader", "spiffs"):
            o, s = self.slot(name)
            self.assertLessEqual(o + s, LEGACY_FS_OFFSET, name)


if __name__ == "__main__":
    unittest.main()

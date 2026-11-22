"""flash_render_core: late frames and flash writes per phase from the stamped serial log."""

from __future__ import annotations

import unittest

import flash_render_core as core
import pytest

LOG = """\
10:00:00.100Z [flash] auto-suspend on jedec=464016
10:00:05.000Z [ft] r84:11970/12000/12040 w84:1/1/1 dt12 fps=80 sl=11-11
10:00:10.500Z [fs] wrote /lfs/fx_store/a.rec 400 B us=31000
10:00:11.000Z [ft] r84:11970/12000/12040 w84:1/1/1 dt12 fps=80 sl=11-11
10:00:20.200Z [fs] wrote /lfs/map.pb 9000 B us=140000
10:00:21.000Z [ft] r83:11970/12180/30000 w83:1/1/1 dt30 fps=80 sl=11-12
10:00:21.000Z [late] n=1 max=30000 ago_ms=700
10:00:26.000Z [fs] wrote /lfs/kp_a.0 200 B us=20000
10:00:30.000Z [fs] wrote /lfs/fx.pb 200 B us=20000
10:00:31.000Z [late] n=1 max=4292472685 ago_ms=4294964803
"""

T0 = 1_700_000_000 - (1_700_000_000 % 86400)  # a UTC midnight
PHASES = {
    "effect_store": (T0 + 36010, T0 + 36015),
    "map": (T0 + 36019, T0 + 36022),
    "settings": (T0 + 36029, T0 + 36032),
    "keypoints": (T0 + 36025, T0 + 36028),
}


@pytest.mark.requirements("PR-41")
class FlashRenderTest(unittest.TestCase):
    def test_report(self) -> None:
        rep = core.report(LOG, PHASES)
        self.assertEqual((rep.suspend, rep.jedec), ("on", "464016"))
        self.assertEqual(rep.late_in("effect_store"), 0)
        self.assertEqual(rep.late_in("map"), 1)  # at 20.3 s, during the map write
        self.assertEqual(rep.late_in("settings"), 0)  # a clock step's wrapped value: ignored
        self.assertEqual([w["path"] for w in rep.per_phase["map"]["writes"]], ["/lfs/map.pb"])

    def test_verdict(self) -> None:
        v, why = core.verdict(core.report(LOG, PHASES))
        self.assertEqual(v, "FAIL")
        lock = LOG.replace(
            "10:00:10.500Z [fs]",
            "10:00:12.000Z [late] n=1 max=40000 ago_ms=500\n10:00:10.500Z [fs]",
        )
        rep = core.report(lock.replace("[late] n=1 max=30000", "[x]"), PHASES)
        self.assertEqual(rep.late_in("effect_store"), 1)
        self.assertEqual(core.verdict(rep)[0], "PASS")  # under the player mutex: reported
        self.assertEqual(core.verdict(rep, strict=True)[0], "FAIL")
        self.assertTrue(any(w.startswith("map: 1 late frame") for w in why), why)
        clean = LOG.replace("[late] n=1 max=30000", "[x]")
        self.assertEqual(core.verdict(core.report(clean, PHASES)), ("PASS", []))
        off = clean.replace("auto-suspend on", "auto-suspend off (flash not supported) ")
        v, why = core.verdict(core.report(off, PHASES))
        self.assertEqual(v, "FAIL")
        self.assertIn("auto-suspend", why[0])
        self.assertEqual(core.verdict(core.report(off, PHASES), require_suspend=False)[0], "PASS")
        # The boot line from the flash tool's monitor (the capture was paused for it).
        nobanner = clean.replace("[flash] auto-suspend on jedec=464016", "")
        boot = "[flash] auto-suspend on jedec=464016\n"
        self.assertEqual(core.verdict(core.report(nobanner, PHASES, boot=boot)), ("PASS", []))
        no_writes = {**PHASES, "settings": (T0 + 1, T0 + 2)}
        self.assertIn(
            "settings: no flash write seen", core.verdict(core.report(clean, no_writes))[1]
        )


if __name__ == "__main__":
    unittest.main()

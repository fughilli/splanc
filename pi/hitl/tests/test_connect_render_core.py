"""connect_render_core: late frames, [ft] rates and [rsv] reserves per phase."""

from __future__ import annotations

import unittest

import connect_render_core as core
import pytest

# 10:00:00-10 steady (80 fps), 10:00:10-20 connects (the reserve: 50 fps), 10:00:20-28 after.
LOG = """\
10:00:05.000Z [ft] r80:12400/12500/12600 w80:1/1/1 dt13 fps=80 sl=3-3
10:00:09.000Z [ft] r80:12400/12500/12600 w80:1/1/1 dt13 fps=80 sl=3-3
10:00:12.000Z [ft] r60:12400/16000/20100 w60:1/1/1 dt20 fps=50 sl=3-11
10:00:12.000Z [rsv] frames=44 entered=1
10:00:15.000Z [ft] r50:19900/20000/20100 w50:1/1/1 dt20 fps=50 sl=11-11
10:00:15.000Z [rsv] frames=50 entered=0
10:00:18.000Z [ft] r80:12400/12500/12600 w80:1/1/1 dt13 fps=80 sl=3-3
10:00:21.000Z [ft] r80:12400/12500/12600 w80:1/1/1 dt13 fps=80 sl=3-3
10:00:25.000Z [ft] r80:12400/12500/12600 w80:1/1/1 dt13 fps=80 sl=3-3
"""
BASE = """\
10:00:05.000Z [ft] r80:12400/12500/12600 w80:1/1/1 dt13 fps=80 sl=3-3
10:00:12.000Z [ft] r76:12400/13100/25000 w76:1/1/1 dt25 fps=80 sl=3-3
10:00:12.000Z [late] n=22 max=25000 ago_ms=600
10:00:21.000Z [ft] r80:12400/12500/12600 w80:1/1/1 dt13 fps=80 sl=3-3
10:00:25.000Z [ft] r80:12400/12500/12600 w80:1/1/1 dt13 fps=80 sl=3-3
"""

T0 = 1_700_000_000 - (1_700_000_000 % 86400) + 36000  # 10:00:00 UTC
PHASES = {"steady": (T0, T0 + 10), "connect": (T0 + 10, T0 + 20), "after": (T0 + 20, T0 + 28)}
OK = [{"ok": True, "s": 1.4}, {"ok": True, "s": 1.9}]


@pytest.mark.requirements("PR-42")
class ConnectRenderTest(unittest.TestCase):
    def test_reserve_pass(self) -> None:
        rep = core.report(LOG, PHASES)
        self.assertEqual(rep.late_in("connect"), 0)
        self.assertEqual(rep.reserves_entered("connect"), 1)
        self.assertEqual(rep.reserve_frames("connect"), 94)
        self.assertEqual(rep.fps_range("connect"), (50, 80))
        self.assertEqual(rep.fps_range("steady"), (80, 80))
        self.assertEqual(core.verdict(rep, OK), ("PASS", []))
        s = core.summary(rep, OK)
        self.assertEqual(s["handshakes"], {"n": 2, "ok": 2, "s_min": 1.4, "s_max": 1.9})
        self.assertEqual(s["connect"]["max_interval_us"], 20100)

    def test_baseline_late_frames_fail(self) -> None:
        rep = core.report(BASE, PHASES)
        self.assertEqual(rep.late_in("connect"), 22)  # started 11.4 s: in the connects
        v, why = core.verdict(rep, OK)
        self.assertEqual(v, "FAIL")
        self.assertTrue(any("22 late" in w for w in why), why)
        self.assertTrue(any("reserve never engaged" in w for w in why), why)
        # A baseline image is graded without the reserve requirement.
        _, why = core.verdict(rep, OK, require_reserve=False)
        self.assertFalse(any("reserve" in w for w in why), why)

    def test_a_slow_or_failed_connect_fails(self) -> None:
        rep = core.report(LOG, PHASES)
        v, why = core.verdict(
            rep, [{"ok": True, "s": 9.0}, {"ok": False, "s": 8.5, "err": "timeout"}]
        )
        self.assertEqual(v, "FAIL")
        self.assertEqual(len(why), 2, why)

    def test_a_phase_without_frames_fails(self) -> None:
        rep = core.report("", PHASES)
        _, why = core.verdict(rep, OK)
        self.assertTrue(any("no [ft] window" in w for w in why), why)

#!/usr/bin/env python3
"""Unit tests for the ingest's per-row ratio/ln_ratio enrichment + recent slice.

Pure Python, no network / no bazel:  python3 test_ingest_fx_bench.py
"""

from __future__ import annotations

import math
import unittest
from datetime import datetime, timezone

import ingest_fx_bench as ing


def _golden(label, build, frame, show, soc="esp32c6"):
    # Shape mirrors load_goldens_from_repo() rows (chip mirrors soc).
    return {
        "label": label,
        "build": build,
        "soc": soc,
        "chip": soc,
        "goldenFrameCycles": frame,
        "goldenShowCycles": show,
    }


def _meas(label, build, frame, show, time_iso, soc="esp32c6"):
    return {
        "label": label,
        "build": build,
        "soc": soc,
        "frame": frame,
        "show": show,
        "leds": 16,
        "time": time_iso,
        "branch": "main",
        "short_sha": "deadbeef",
        "conclusion": "success",
    }


NOW = datetime(2026, 9, 27, tzinfo=timezone.utc)
RECENT_ISO = "2026-09-01T00:00:00Z"  # ~26 days ago — inside a 180d window
OLD_ISO = "2025-01-01T00:00:00Z"  # ~635 days ago — outside a 180d window


class RatioEnrichment(unittest.TestCase):
    def setUp(self):
        self.goldens = [
            _golden("sweep16", "jit", frame=100, show=200),
            _golden("empty", "jit", frame=500, show=0),  # show golden absent (0)
        ]

    def test_ratio_and_ln_ratio_match_golden(self):
        rows = [_meas("sweep16", "jit", frame=110, show=220, time_iso=RECENT_ISO)]
        out = ing.build_infinity_rows(rows, self.goldens)
        frame = next(r for r in out if r["metric"] == "frame")
        show = next(r for r in out if r["metric"] == "show")
        # ratio = measured / golden ; ln_ratio = ln(ratio), for BOTH metrics.
        self.assertAlmostEqual(frame["ratio"], 110 / 100)
        self.assertAlmostEqual(frame["ln_ratio"], math.log(110 / 100))
        self.assertAlmostEqual(show["ratio"], 220 / 200)
        self.assertAlmostEqual(show["ln_ratio"], math.log(220 / 200))

    def test_missing_golden_yields_null_not_crash(self):
        # Unknown effect (no golden at all) AND a metric whose golden is 0 (empty.show).
        rows = [
            _meas("ghost", "jit", frame=123, show=456, time_iso=RECENT_ISO),
            _meas("empty", "jit", frame=505, show=333, time_iso=RECENT_ISO),
        ]
        out = ing.build_infinity_rows(rows, self.goldens)  # must not raise
        ghost = [r for r in out if r["label"] == "ghost"]
        self.assertEqual(len(ghost), 2)  # both frame + show emitted
        for r in ghost:
            self.assertIsNone(r["ratio"])
            self.assertIsNone(r["ln_ratio"])
        # empty: frame golden exists (500) → ratio; show golden is 0 → null.
        empty_frame = next(r for r in out if r["label"] == "empty" and r["metric"] == "frame")
        empty_show = next(r for r in out if r["label"] == "empty" and r["metric"] == "show")
        self.assertAlmostEqual(empty_frame["ratio"], 505 / 500)
        self.assertIsNone(empty_show["ratio"])
        self.assertIsNone(empty_show["ln_ratio"])


class RecentSlice(unittest.TestCase):
    def test_old_row_excluded_from_recent_but_present_in_full(self):
        goldens = [_golden("sweep16", "jit", frame=100, show=200)]
        rows = [
            _meas("sweep16", "jit", 110, 220, RECENT_ISO),
            _meas("sweep16", "jit", 111, 221, OLD_ISO),
        ]
        full = ing.build_infinity_rows(rows, goldens)
        recent = ing.slice_recent(full, now=NOW, window_days=180)
        full_times = {r["time"] for r in full}
        recent_times = {r["time"] for r in recent}
        # The old row is in the full array …
        self.assertIn(OLD_ISO, full_times)
        # … but excluded from the trailing-window recent slice.
        self.assertIn(RECENT_ISO, recent_times)
        self.assertNotIn(OLD_ISO, recent_times)
        # Same schema (frame+show rows) for the surviving sample.
        self.assertEqual(len([r for r in recent if r["time"] == RECENT_ISO]), 2)

    def test_default_window_constant(self):
        self.assertEqual(ing.RECENT_WINDOW_DAYS, 180)


if __name__ == "__main__":
    unittest.main(verbosity=2)

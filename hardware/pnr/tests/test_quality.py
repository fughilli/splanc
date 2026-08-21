"""Phase 6 tests — routing-rule compilation + the post-route quality analysis.

Pure (no pcbnew): `compile_routing_rules` net-glob expansion, and `analyze` over
synthetic per-net length/via dicts for diff-pair skew, length-match spread, and
net-class totals.
"""

import unittest

from pnr.constraints import (
    DiffPair,
    LengthMatch,
    NetClass,
    compile_constraints,
    compile_routing_rules,
)
from pnr.quality import analyze


class RoutingRuleCompileTest(unittest.TestCase):
    def _compiled(self):
        doc = {
            "net_class": {"power": {"width_mm": 0.4, "clearance_mm": 0.3, "nets": ["lv", "*hv"]}},
            "diff_pair": [{"name": "usb", "p": "usb_dp", "n": "usb_dm", "skew_mm": 0.3}],
            "length_match": [{"name": "i2c", "nets": ["scl", "sda"], "tolerance_mm": 2.0}],
        }
        return compile_constraints(doc, [])

    def test_parses_into_typed_rules(self):
        c = self._compiled()
        self.assertEqual(len(c.net_classes), 1)
        self.assertIsInstance(c.net_classes[0], NetClass)
        self.assertEqual(c.net_classes[0].width_mm, 0.4)
        self.assertIsInstance(c.diff_pairs[0], DiffPair)
        self.assertEqual(c.diff_pairs[0].skew_mm, 0.3)
        self.assertIsInstance(c.length_matches[0], LengthMatch)

    def test_glob_expansion_against_netlist(self):
        c = self._compiled()
        nets = ["lv", "hv", "p3v3-hv", "vsys-hv", "sda", "scl", "usb_dp", "usb_dm", "misc"]
        rules = compile_routing_rules(c, nets)
        power = rules["net_classes"][0]["nets"]
        self.assertIn("lv", power)
        self.assertIn("p3v3-hv", power)  # *hv glob
        self.assertNotIn("misc", power)
        # diff pair kept only because both nets exist
        self.assertEqual(len(rules["diff_pairs"]), 1)
        self.assertEqual(set(rules["length_match"][0]["nets"]), {"sda", "scl"})

    def test_diff_pair_dropped_if_net_missing(self):
        c = self._compiled()
        rules = compile_routing_rules(c, ["usb_dp"])  # usb_dm absent
        self.assertEqual(rules["diff_pairs"], [])

    def test_diff_pair_requires_p_and_n(self):
        from pnr.constraints import ConstraintError

        with self.assertRaises(ConstraintError):
            compile_constraints({"diff_pair": [{"name": "x", "p": "a"}]}, [])


class QualityAnalyzeTest(unittest.TestCase):
    def test_totals(self):
        r = analyze({"a": 10.0, "b": 5.0}, {"a": 2, "b": 1}, {})
        self.assertEqual(r.total_length_mm, 15.0)
        self.assertEqual(r.total_vias, 3)
        self.assertEqual(r.routed_nets, 2)
        self.assertTrue(r.ok)  # no rules -> trivially ok

    def test_diff_pair_skew_pass_fail(self):
        rules = {"diff_pairs": [{"name": "usb", "p": "dp", "n": "dm", "skew_mm": 0.5}]}
        ok = analyze({"dp": 10.0, "dm": 10.3}, {}, rules)
        self.assertTrue(ok.diff_pairs[0].ok)
        self.assertAlmostEqual(ok.diff_pairs[0].skew_mm, 0.3, places=6)
        bad = analyze({"dp": 10.0, "dm": 12.0}, {}, rules)
        self.assertFalse(bad.diff_pairs[0].ok)
        self.assertFalse(bad.ok)

    def test_diff_pair_unrouted_is_not_ok(self):
        rules = {"diff_pairs": [{"name": "usb", "p": "dp", "n": "dm", "skew_mm": 5.0}]}
        r = analyze({"dp": 10.0}, {}, rules)  # dm has no copper
        self.assertFalse(r.diff_pairs[0].routed)
        self.assertFalse(r.diff_pairs[0].ok)

    def test_length_match_spread(self):
        rules = {"length_match": [{"name": "bus", "nets": ["x", "y", "z"], "tolerance_mm": 1.0}]}
        ok = analyze({"x": 10.0, "y": 10.5, "z": 10.8}, {}, rules)
        self.assertAlmostEqual(ok.length_matches[0].spread_mm, 0.8, places=6)
        self.assertTrue(ok.length_matches[0].ok)
        bad = analyze({"x": 10.0, "y": 12.0, "z": 10.8}, {}, rules)
        self.assertFalse(bad.length_matches[0].ok)

    def test_net_class_length_rollup(self):
        rules = {"net_classes": [{"name": "power", "nets": ["gnd", "vcc"]}]}
        r = analyze({"gnd": 40.0, "vcc": 20.0, "sig": 5.0}, {}, rules)
        self.assertEqual(r.net_class_length_mm["power"], 60.0)

    def test_summary_renders(self):
        rules = {"diff_pairs": [{"name": "usb", "p": "dp", "n": "dm", "skew_mm": 0.5}]}
        text = analyze({"dp": 10.0, "dm": 10.2}, {"dp": 1}, rules).summary()
        self.assertIn("diff-pair usb", text)
        self.assertIn("quality: PASS", text)


if __name__ == "__main__":
    unittest.main()

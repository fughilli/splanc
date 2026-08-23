"""Unit tests for the constraint schema + compiler (pnr.constraints)."""

import json
import os
import unittest

from pnr.constraints import (
    ConstraintError,
    Enforcement,
    compile_constraints,
    load_constraints,
)

# Synthetic netlist covering the glob/side/group cases.
REFS = ["U1", "U2", "U5", "USB1", "SW1", "SW2", "C1", "C2", "R1", "R2", "L2", "L3"]


class CompileTest(unittest.TestCase):
    def test_fixed_is_hard_and_locked(self):
        cc = compile_constraints(
            {"fixed": {"USB1": {"edge": "south", "rot": 0, "side": "top"}}}, REFS
        )
        (c,) = cc.constraints
        self.assertEqual(c.kind, "fixed")
        self.assertIs(c.enforcement, Enforcement.HARD)
        self.assertEqual(c.refs, ("USB1",))
        self.assertEqual(cc.locked_refs, ("USB1",))
        self.assertEqual(cc.hard, cc.constraints)
        self.assertEqual(cc.soft, [])

    def test_edge_align_is_soft_and_weighted(self):
        cc = compile_constraints({"edge_align": {"SW1": {"edge": "north", "side": "top"}}}, REFS)
        (c,) = cc.constraints
        self.assertIs(c.enforcement, Enforcement.SOFT)
        self.assertEqual(c.params["edge"], "north")
        self.assertIsNotNone(c.weight)
        self.assertGreater(c.weight, 0)

    def test_edge_align_requires_edge(self):
        with self.assertRaises(ConstraintError):
            compile_constraints({"edge_align": {"SW1": {"side": "top"}}}, REFS)

    def test_bad_enum_raises(self):
        with self.assertRaises(ConstraintError):
            compile_constraints({"fixed": {"USB1": {"edge": "nowhere"}}}, REFS)
        with self.assertRaises(ConstraintError):
            compile_constraints({"fixed": {"USB1": {"side": "sideways"}}}, REFS)

    def test_keepout_is_hard_and_needs_region(self):
        cc = compile_constraints(
            {"keepout": [{"name": "ant", "ref": "U5", "extent": {"edge": "west", "depth_mm": 8}}]},
            REFS,
        )
        (c,) = cc.constraints
        self.assertIs(c.enforcement, Enforcement.HARD)
        self.assertEqual(c.name, "ant")
        self.assertEqual(c.refs, ("U5",))
        with self.assertRaises(ConstraintError):
            compile_constraints({"keepout": [{"name": "bad"}]}, REFS)

    def test_side_pref_glob_expands(self):
        cc = compile_constraints({"side_pref": {"bottom": ["C*", "R*"]}}, REFS)
        (c,) = cc.constraints
        self.assertIs(c.enforcement, Enforcement.SOFT)
        self.assertEqual(c.params["side"], "bottom")
        self.assertEqual(set(c.refs), {"C1", "C2", "R1", "R2"})

    def test_group_attracts_members(self):
        cc = compile_constraints(
            {"group": [{"members": ["U2", "L2", "L3"], "anchor": "U2", "radius_mm": 8}]},
            REFS,
        )
        (c,) = cc.constraints
        self.assertIs(c.enforcement, Enforcement.SOFT)
        self.assertEqual(set(c.refs), {"U2", "L2", "L3"})
        self.assertEqual(c.params["anchor"], "U2")
        self.assertEqual(c.params["radius_mm"], 8)

    def test_unknown_ref_warns_but_keeps(self):
        cc = compile_constraints({"edge_align": {"J99": {"edge": "north"}}}, REFS)
        self.assertTrue(any("J99" in w for w in cc.warnings))
        self.assertEqual(cc.constraints[0].refs, ("J99",))

    def test_glob_no_match_warns(self):
        cc = compile_constraints({"side_pref": {"bottom": ["Z*"]}}, REFS)
        self.assertTrue(any("Z*" in w for w in cc.warnings))

    def test_unknown_top_level_section_warns(self):
        cc = compile_constraints({"thermal": {}}, REFS)
        self.assertTrue(any("thermal" in w for w in cc.warnings))

    def test_board_spec_defaults_and_overrides(self):
        cc = compile_constraints({}, REFS)
        self.assertEqual(cc.board.layers, 2)
        cc2 = compile_constraints({"board": {"outline": {"w": 40, "h": 30}, "layers": 4}}, REFS)
        self.assertEqual(cc2.board.width, 40)
        self.assertEqual(cc2.board.layers, 4)

    def test_top_level_must_be_mapping(self):
        with self.assertRaises(ConstraintError):
            compile_constraints([1, 2, 3], REFS)


class RealFixtureTest(unittest.TestCase):
    """Compile the committed splanc_dev constraints against its real netlist."""

    def setUp(self):
        here = os.path.dirname(os.path.abspath(__file__))
        base = os.path.join(here, "..", "testdata", "splanc_dev")
        with open(os.path.join(base, "graph.json"), encoding="utf-8") as fh:
            self.refs = [c["ref"] for c in json.load(fh)["components"]]
        self.path = os.path.join(base, "constraints.yaml")

    def test_fixture_compiles_without_warnings(self):
        cc = load_constraints(self.path, self.refs)
        self.assertEqual(cc.warnings, [], f"unexpected warnings: {cc.warnings}")

    def test_fixture_intent(self):
        cc = load_constraints(self.path, self.refs)
        # USB-C is a locked hard constraint.
        self.assertIn("USB1", cc.locked_refs)
        # All four buttons are soft edge-aligned to the north edge.
        buttons = {r for c in cc.soft if c.kind == "edge_align" for r in c.refs}
        self.assertTrue({"SW1", "SW2", "SW3", "SW4"} <= buttons)
        # The ESP32 antenna keep-out is a hard constraint on U5.
        keepouts = [c for c in cc.hard if c.kind == "keepout"]
        self.assertTrue(any("U5" in c.refs for c in keepouts))
        # C*/R* passives biased to the bottom expand to real refs.
        bottom = {r for c in cc.soft if c.kind == "side_pref" for r in c.refs}
        self.assertTrue(any(r.startswith("C") for r in bottom))
        self.assertTrue(any(r.startswith("R") for r in bottom))


if __name__ == "__main__":
    unittest.main()

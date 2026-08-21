"""Unit tests for the internal board graph (pnr.graph)."""

import unittest

from pnr.graph import (
    SIDE_BOTTOM,
    SIDE_TOP,
    BoardGraph,
    BoardOutline,
    Component,
    Net,
    Pad,
)


def _sample() -> BoardGraph:
    u1 = Component(
        ref="U1",
        footprint="Lib:QFN",
        pos=(10.0, 5.0),
        rot=90.0,
        side=SIDE_TOP,
        courtyard=(4.0, 4.0),
        bbox=(4.5, 4.5),
        pads=[Pad("1", "VCC", (-1.0, 1.0)), Pad("2", "GND", (1.0, -1.0))],
    )
    r1 = Component(
        ref="R1",
        footprint="Lib:R0402",
        pos=(3.0, 2.0),
        rot=0.0,
        side=SIDE_BOTTOM,
        courtyard=(1.0, 0.5),
        bbox=(1.0, 0.5),
        pads=[Pad("1", "VCC", (-0.5, 0.0)), Pad("2", "NET1", (0.5, 0.0))],
    )
    return BoardGraph(
        name="sample",
        components=[u1, r1],
        nets=[
            Net("VCC", 1, [("U1", "1"), ("R1", "1")]),
            Net("GND", 2, [("U1", "2")]),
            Net("NET1", 3, [("R1", "2")]),
        ],
        outline=BoardOutline(40.0, 30.0, [(0, 0), (40, 0), (40, 30), (0, 30)]),
    )


class GraphViewsTest(unittest.TestCase):
    def test_basic_views(self):
        g = _sample()
        self.assertEqual(g.refs, ["U1", "R1"])
        self.assertEqual(g.pad_count, 4)
        self.assertEqual(g.component("U1").rot, 90.0)
        self.assertEqual(g.net("VCC").degree, 2)
        self.assertEqual(g.net("GND").degree, 1)

    def test_missing_lookups_raise(self):
        g = _sample()
        with self.assertRaises(KeyError):
            g.component("NOPE")
        with self.assertRaises(KeyError):
            g.net("NOPE")


class GraphRoundTripTest(unittest.TestCase):
    def test_json_round_trip_is_stable(self):
        g = _sample()
        again = BoardGraph.from_json(g.to_json())
        self.assertEqual(again.to_json(), g.to_json())

    def test_round_trip_preserves_fields(self):
        g = _sample()
        again = BoardGraph.from_json(g.to_json())
        u1 = again.component("U1")
        self.assertEqual(u1.footprint, "Lib:QFN")
        self.assertEqual(u1.side, SIDE_TOP)
        self.assertEqual(u1.pos, (10.0, 5.0))
        self.assertEqual(u1.pads[0].net, "VCC")
        self.assertEqual(again.component("R1").side, SIDE_BOTTOM)
        self.assertEqual(again.outline.width, 40.0)
        self.assertEqual(again.schema, "v0")


if __name__ == "__main__":
    unittest.main()

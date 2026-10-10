"""Regression: source intent survives ref renumbering and scales with current."""

import tempfile, unittest
from pathlib import Path
from types import SimpleNamespace as NS
from pnr.plane_intent import read_annotations, resolve, size_array

FAB = dict(
    via_drill_mm=0.3,
    via_diameter_mm=0.6,
    min_via_plating_um=20,
    board_thickness_mm=1.6,
    copper_resistivity_ohm_mm=0.000021,
    via_barrel_loss_budget_w=0.01,
    via_array_peak_drop_v=0.01,
    hole_clearance_mm=0.2,
    track_width_mm=0.2,
    outer_copper_oz=1,
    plane_access_delta_t_c=40,
    power_bus_min_width_mm=1.5,
)


class IntentTests(unittest.TestCase):
    def test_source_to_ref_and_current_changes(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "design.ato"
            p.write_text(
                '# @pnr-plane-access {"target":"converter.low_fet","pads":["1","2","3"],"kind":"power_array","rms_current_a":5,"peak_current_a":16}\n'
            )
            cs = [
                NS(
                    ref="Q987",
                    address="other.converter.low_fet._p",
                    pads=[NS(name=str(i), net="return") for i in [1, 2, 3]],
                )
            ]
            intent = resolve(read_annotations([p]), cs)[0]
            self.assertEqual(intent["ref"], "Q987")
            self.assertEqual(intent["net"], "return")
            self.assertEqual(size_array(intent, FAB)["count"], 3)
            larger = size_array(dict(intent, rms_current_a=10, peak_current_a=20), FAB)
            self.assertGreater(larger["count"], 3)
            self.assertLessEqual(
                larger["per_via_loss_w"], FAB["via_barrel_loss_budget_w"]
            )
            self.assertLessEqual(larger["peak_drop_v"], FAB["via_array_peak_drop_v"])

    def test_array_space_follows_source_current_and_is_idempotent(self):
        from pnr.graph import BoardGraph, Component, Pad
        from pnr.plane_intent import reserve_array_space
        c = Component('Q987', 'x', (5,5), 0, 'top', (2,3), (2,3),
            pads=[Pad(str(i), 'GND', (1,y), (.7,.5)) for i,y in enumerate((-1,0,1),1)])
        g = BoardGraph('test', [c], [])
        intent = dict(ref='Q987', pads=['1','2','3'], kind='power_array',
            rms_current_a=5, peak_current_a=16, max_array_span_mm=10)
        reserve_array_space(g, [intent], FAB, .2)
        first = c.courtyard
        self.assertGreater(first[0], 2)
        reserve_array_space(g, [intent], FAB, .2)
        self.assertEqual(c.courtyard, first)
        reserve_array_space(g, [dict(intent,rms_current_a=10,peak_current_a=20)], FAB, .2)
        self.assertGreater(max(c.courtyard), max(first))

    def test_missing_process_data_fails_closed(self):
        with self.assertRaises(KeyError):
            size_array(dict(rms_current_a=5, peak_current_a=16), {})

    def test_mixed_net_group_rejected(self):
        a = dict(target="part", pads=["1", "2"], kind="power_array")
        with self.assertRaises(ValueError):
            resolve(
                [a],
                [
                    NS(
                        ref="X1",
                        address="board.part",
                        pads=[NS(name="1", net="a"), NS(name="2", net="b")],
                    )
                ],
            )


if __name__ == "__main__":
    unittest.main()

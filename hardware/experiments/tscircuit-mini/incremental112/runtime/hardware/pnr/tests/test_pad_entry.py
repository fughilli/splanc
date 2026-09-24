"""Actual U18 grazing geometry, robust bus entry, and cleanup regression."""

import unittest

try:
    import pcbnew
except ImportError:
    pcbnew = None
from pnr.pad_entry import witness, repair, snapshot, required_width, repair_changed_entries


@unittest.skipIf(pcbnew is None, "requires native KiCad Python")
class PadEntryTests(unittest.TestCase):
    def test_reroute_repairs_new_grazing_and_reports_disappearing_entry(self):
        b, p, t = self.fixture(x=46.1929)
        before = snapshot(b, {})
        self.assertTrue(all(before.values()))
        p.SetPosition(pcbnew.VECTOR2I(46350000, 63500000))
        result = repair_changed_entries(b, {}, before)
        self.assertEqual(len(result['entry_repairs']['added']), 1)
        self.assertEqual(result['lost_pad_entries'], [])
        self.assertEqual(result['new_bad_entries'], [])
        for track in list(b.GetTracks()):
            b.Remove(track)
        missing = repair_changed_entries(b, {}, before)
        self.assertEqual(set(missing['lost_pad_entries']), set(before))

    def fixture(self, x=46.35, y=63.5, width=0.2):
        b = pcbnew.BOARD()
        n = pcbnew.NETINFO_ITEM(b, "return")
        b.Add(n)
        f = pcbnew.FOOTPRINT(b)
        f.SetReference("X987")
        b.Add(f)
        p = pcbnew.PAD(f)
        p.SetNumber("19")
        p.SetAttribute(pcbnew.PAD_ATTRIB_SMD)
        p.SetShape(pcbnew.PAD_SHAPE_RECT)
        p.SetSize(pcbnew.VECTOR2I(200000, 800000))
        p.SetPosition(pcbnew.VECTOR2I(round(x * 1e6), round(y * 1e6)))
        ls = pcbnew.LSET()
        ls.AddLayer(pcbnew.F_Cu)
        p.SetLayerSet(ls)
        p.SetNetCode(n.GetNetCode())
        f.Add(p)
        t = pcbnew.PCB_TRACK(b)
        t.SetStart(pcbnew.VECTOR2I(46192900, 63742900))
        t.SetEnd(pcbnew.VECTOR2I(46192900, 64210500))
        t.SetWidth(round(width * 1e6))
        t.SetLayer(pcbnew.F_Cu)
        t.SetNetCode(n.GetNetCode())
        b.Add(t)
        return b, p, t

    def test_u18_19_grazing_is_not_entry_and_repair_is_repeatable(self):
        b, p, t = self.fixture()
        self.assertTrue(
            p.GetEffectiveShape(pcbnew.F_Cu).Collide(
                t.GetEffectiveShape(pcbnew.F_Cu), 0
            )
        )
        self.assertFalse(witness(p, t, 0.2))
        r = repair(b, {})
        self.assertEqual(len(r["added"]), 1)
        self.assertTrue(all(snapshot(b, {}).values()))
        self.assertEqual(repair(b, {})["added"], [])
        new = next(x for x in b.GetTracks() if x.m_Uuid != t.m_Uuid)
        b.Remove(new)
        self.assertFalse(all(snapshot(b, {}).values()))

    def test_u18_18_diagonal_rejected(self):
        b, p, t = self.fixture(x=46.75)
        t.SetStart(pcbnew.VECTOR2I(46650000, 65000000))
        t.SetEnd(pcbnew.VECTOR2I(47013900, 63635376))
        self.assertTrue(
            p.GetEffectiveShape(pcbnew.F_Cu).Collide(
                t.GetEffectiveShape(pcbnew.F_Cu), 0
            )
        )
        self.assertFalse(witness(p, t, 0.2))
        self.assertEqual(len(repair(b, {})["added"]), 1)

    def test_broad_bus_inside_pad_needs_no_center_endpoint(self):
        b, p, t = self.fixture(x=46.1929)
        self.assertTrue(witness(p, t, 0.2))
        self.assertEqual(repair(b, {})["added"], [])

    def test_wide_bus_centerline_outside_pad_is_valid(self):
        b, p, t = self.fixture(width=1.0)
        self.assertTrue(witness(p, t, 0.2))
        self.assertEqual(repair(b, {})["added"], [])

    def test_resolved_current_width_cannot_be_silently_necked(self):
        b, p, t = self.fixture()
        rules = {
            "fab": {"track_width_mm": 0.2},
            "net_classes": [{"nets": ["return"], "width_mm": 0.8}],
        }
        self.assertEqual(required_width(p, rules), 0.8)
        r = repair(b, rules)
        self.assertEqual(r["added"], [])
        self.assertEqual(len(r["blocked"]), 1)

    def test_full_width_grazing_bus_can_add_full_width_entry_to_small_land(self):
        b, p, t = self.fixture(x=46.55,width=0.8)
        rules = {"net_classes": [{"nets": ["return"], "width_mm": 0.8}]}
        self.assertFalse(witness(p, t, 0.8))
        result = repair(b, rules)
        self.assertEqual(len(result["added"]), 1)
        self.assertEqual(result["added"][0]["width_mm"], 0.8)
        self.assertTrue(all(snapshot(b, rules).values()))
        self.assertEqual(repair(b, rules)["added"], [])

    def test_custom_copper_uses_polygon_not_tiny_anchor(self):
        b,p,t = self.fixture(x=46.1929)
        p.SetShape(pcbnew.PAD_SHAPE_CUSTOM)
        p.SetSize(pcbnew.VECTOR2I(10000,10000))
        polygon = pcbnew.SHAPE_POLY_SET()
        polygon.NewOutline()
        for x,y in [(-200000,-500000),(200000,-500000),(200000,500000),(-200000,500000)]:
            polygon.Append(pcbnew.VECTOR2I(x,y))
        p.AddPrimitivePoly(pcbnew.F_Cu, polygon, 0, True)
        self.assertTrue(witness(p,t,.2))
        # Keep an overlap, but reduce contact below the required full-width disk.
        t.SetStart(pcbnew.VECTOR2I(46470000,63400000))
        t.SetEnd(pcbnew.VECTOR2I(46470000,63600000))
        self.assertTrue(p.GetEffectiveShape(pcbnew.F_Cu).Collide(t.GetEffectiveShape(pcbnew.F_Cu),0))
        self.assertFalse(witness(p,t,.2))

    def test_custom_offset_copper_gets_full_width_repeatable_entry(self):
        b,p,t=self.fixture(x=46.1929)
        p.SetShape(pcbnew.PAD_SHAPE_CUSTOM);p.SetSize(pcbnew.VECTOR2I(10000,10000))
        polygon=pcbnew.SHAPE_POLY_SET();polygon.NewOutline()
        for x,y in [(300000,-500000),(700000,-500000),(700000,500000),(300000,500000)]:
            polygon.Append(pcbnew.VECTOR2I(x,y))
        p.AddPrimitivePoly(pcbnew.F_Cu,polygon,0,True)
        center=p.GetPosition()
        t.SetStart(pcbnew.VECTOR2I(center.x+780000,center.y-300000))
        t.SetEnd(pcbnew.VECTOR2I(center.x+780000,center.y+300000))
        self.assertFalse(witness(p,t,.2))
        result=repair(b,{})
        self.assertEqual(len(result['added']),1,result)
        self.assertTrue(all(snapshot(b,{}).values()))
        self.assertEqual(repair(b,{})['added'],[])

    def test_scoped_repair_only_completes_selected_new_contacts(self):
        b,p,t=self.fixture()
        self.assertEqual(repair(b,{},only_keys=set())['added'],[])
        identity=p.m_Uuid.AsString()+':'+str(pcbnew.F_Cu)
        self.assertEqual(len(repair(b,{},only_keys={identity})['added']),1)
        self.assertTrue(all(snapshot(b,{}).values()))

    def test_full_current_bus_covers_small_land_with_offset_centerline(self):
        b,p,t=self.fixture(x=46.,y=63.5,width=1.2)
        p.SetSize(pcbnew.VECTOR2I(600000,300000))
        t.SetStart(pcbnew.VECTOR2I(46600000,63500000));t.SetEnd(pcbnew.VECTOR2I(48000000,63500000))
        self.assertTrue(witness(p,t,1.2))  # complete .3mm land disk, 1.2mm feed
        t.SetStart(pcbnew.VECTOR2I(46800000,63500000))
        self.assertFalse(witness(p,t,1.2))  # only .1mm overlap is a graze
        t.SetWidth(1100000)
        self.assertFalse(witness(p,t,1.2))  # never relax current-required width

    def test_full_current_width_can_land_on_smaller_pad_without_necking(self):
        b,p,t=self.fixture(x=46.1929,width=.8)
        p.SetSize(pcbnew.VECTOR2I(250000,800000))
        t.SetStart(p.GetPosition());t.SetEnd(p.GetPosition()+pcbnew.VECTOR2I(1000000,0))
        self.assertTrue(witness(p,t,.8))
        t.SetWidth(200000)
        self.assertFalse(witness(p,t,.8))
        t.SetWidth(800000)
        t.SetStart(p.GetPosition()+pcbnew.VECTOR2I(510000,0))
        t.SetEnd(p.GetPosition()+pcbnew.VECTOR2I(510000,1000000))
        self.assertFalse(witness(p,t,.8))

    def test_foreign_copper_blocks_branch(self):
        b, p, t = self.fixture()
        other = pcbnew.NETINFO_ITEM(b, "other")
        b.Add(other)
        block = pcbnew.PCB_TRACK(b)
        block.SetStart(pcbnew.VECTOR2I(46350000, 63500000))
        block.SetEnd(pcbnew.VECTOR2I(46350000, 63550000))
        block.SetWidth(200000)
        block.SetLayer(pcbnew.F_Cu)
        block.SetNetCode(other.GetNetCode())
        b.Add(block)
        self.assertEqual(repair(b, {})["added"], [])


if __name__ == "__main__":
    unittest.main()

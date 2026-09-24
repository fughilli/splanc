"""Regression: three connected pads get one deliberate bank, never per-pad banks."""

import importlib.util, unittest
from test_plane_access_intent import FAB


@unittest.skipUnless(importlib.util.find_spec("pcbnew"), "requires native KiCad")
class PowerArrayTests(unittest.TestCase):
    def fixture(self):
        import pcbnew
        b = pcbnew.BOARD()
        b.SetCopperLayerCount(4)
        n = pcbnew.NETINFO_ITEM(b, "lv")
        b.Add(n)
        f = pcbnew.FOOTPRINT(b)
        f.SetReference("Q987")
        f.SetPosition(pcbnew.VECTOR2I(5000000, 5000000))
        b.Add(f)
        for i, y in enumerate([4, 5, 6], 1):
            p = pcbnew.PAD(f)
            p.SetNumber(str(i))
            p.SetPosition(pcbnew.VECTOR2I(6000000, y * 1000000))
            p.SetSize(pcbnew.VECTOR2I(700000, 500000))
            p.SetAttribute(pcbnew.PAD_ATTRIB_SMD)
            ls = pcbnew.LSET()
            ls.AddLayer(pcbnew.F_Cu)
            p.SetLayerSet(ls)
            p.SetNetCode(n.GetNetCode())
            f.Add(p)
        intent = dict(
            ref="Q987",
            address="any.converter.low_fet",
            pads=["1", "2", "3"],
            kind="power_array",
            surface="F.Cu",
            rms_current_a=5,
            peak_current_a=16,
            max_array_span_mm=3,
        )
        return b, f, intent, n

    def test_initial_generation_restart_and_fanout(self):
        import pcbnew
        from pnr.plane_access import replace_power_array
        from pnr.writeback import _dogbone_fanout_net

        b, f, intent, n = self.fixture()
        first = replace_power_array(b, intent, FAB)
        self.assertEqual(first["count"], 3)

        def geometry():
            return sorted(
                (
                    t.GetClass(),
                    t.GetStart().x,
                    t.GetStart().y,
                    t.GetEnd().x,
                    t.GetEnd().y,
                )
                for t in b.GetTracks()
            )

        original = geometry()
        second = replace_power_array(b, intent, FAB)
        self.assertEqual(second["previous_vias"], 3)
        self.assertEqual(original, geometry())
        self.assertEqual(_dogbone_fanout_net(b, n.GetNetCode()), 0)
        self.assertEqual(sum(t.GetClass() == "PCB_VIA" for t in b.GetTracks()), 3)
        self.assertEqual(original, geometry())
        # The same current-sized bank must be rejected before changing copper
        # when a board edge cuts through its required space.
        edge = pcbnew.PCB_SHAPE(b)
        edge.SetShape(pcbnew.SHAPE_T_RECT)
        edge.SetStart(pcbnew.VECTOR2I(0,0))
        edge.SetEnd(pcbnew.VECTOR2I(6500000,10000000))
        edge.SetLayer(pcbnew.Edge_Cuts)
        b.Add(edge)
        with self.assertRaisesRegex(ValueError, 'board edge'):
            replace_power_array(b, intent, FAB)
        self.assertEqual(original, geometry())

    def test_shared_array_plan_matches_native_at_every_cardinal_rotation(self):
        import pcbnew as k
        import math
        from pnr.plane_intent import array_geometry
        from pnr.plane_access import replace_power_array
        for rotation in (0,90,180,270):
            b,f,intent,n=self.fixture();f.SetOrientationDegrees(rotation)
            pads=[((p.GetPosition().x/1e6,p.GetPosition().y/1e6),
                   (p.GetBoundingBox().GetWidth()/1e6,p.GetBoundingBox().GetHeight()/1e6)) for p in f.Pads()]
            plan=array_geometry(pads,(5,5),intent,FAB)
            replace_power_array(b,intent,FAB)
            actual=sorted((t.GetPosition().x/1e6,t.GetPosition().y/1e6) for t in b.GetTracks() if t.GetClass()=='PCB_VIA')
            self.assertEqual(len(actual),len(plan['vias']))
            self.assertTrue(all(math.dist(a,z)<2e-6 for a,z in zip(actual,sorted(p for p,d,h in plan['vias']))))

    def test_future_bank_rejects_foreign_back_copper_before_mutation(self):
        import pcbnew as k
        from pnr.plane_intent import array_geometry
        from pnr.plane_access import replace_power_array
        b,f,intent,n=self.fixture()
        pads=[((p.GetPosition().x/1e6,p.GetPosition().y/1e6),
               (p.GetBoundingBox().GetWidth()/1e6,p.GetBoundingBox().GetHeight()/1e6)) for p in f.Pads()]
        plan=array_geometry(pads,(5,5),intent,FAB);point=plan['vias'][0][0]
        other=k.NETINFO_ITEM(b,'foreign');b.Add(other)
        t=k.PCB_TRACK(b);t.SetLayer(k.B_Cu);t.SetWidth(200000);t.SetNetCode(other.GetNetCode())
        t.SetStart(k.VECTOR2I(*(round(x*1e6) for x in point)));t.SetEnd(t.GetStart()+k.VECTOR2I(100000,0));b.Add(t)
        before=[t.m_Uuid.AsString() for t in b.GetTracks()]
        with self.assertRaisesRegex(ValueError,'foreign copper'):replace_power_array(b,intent,FAB)
        self.assertEqual([t.m_Uuid.AsString() for t in b.GetTracks()],before)



if __name__ == "__main__":
    unittest.main()

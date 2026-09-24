"""A routing restart must refill the existing plane without duplicating copper."""

import importlib.util
import unittest
from unittest.mock import patch


@unittest.skipUnless(importlib.util.find_spec("pcbnew"), "requires KiCad Python")
class PlaneRefillTest(unittest.TestCase):
    def test_same_package_plated_hole_is_reused_across_back_layer_copper(self):
        import pcbnew as k
        from pnr.writeback import _dogbone_fanout_net,_has_through_access
        b=k.BOARD();b.SetCopperLayerCount(4);n=k.NETINFO_ITEM(b,'lv');b.Add(n)
        f=k.FOOTPRINT(b);b.Add(f);f.SetPosition(k.VECTOR2I(5000000,5000000))
        pads=[]
        for through,x in ((False,5),(True,6.5)):
            p=k.PAD(f);p.SetNumber('2' if through else '1');p.SetSize(k.VECTOR2I(800000,800000))
            p.SetShape(k.PAD_SHAPE_CIRCLE);p.SetPosition(k.VECTOR2I(round(x*1e6),5000000))
            p.SetAttribute(k.PAD_ATTRIB_PTH if through else k.PAD_ATTRIB_SMD)
            layers=k.LSET.AllCuMask() if through else k.LSET();layers.AddLayer(k.F_Cu);p.SetLayerSet(layers)
            if through:p.SetDrillSize(k.VECTOR2I(300000,300000))
            p.SetNetCode(n.GetNetCode());f.Add(p);pads.append(p)
        edge=k.PCB_SHAPE(b);edge.SetShape(k.SHAPE_T_RECT);edge.SetStart(k.VECTOR2I(0,0));edge.SetEnd(k.VECTOR2I(12000000,12000000));edge.SetLayer(k.Edge_Cuts);edge.SetWidth(50000);b.Add(edge)
        other=k.NETINFO_ITEM(b,'back');b.Add(other)
        t=k.PCB_TRACK(b);t.SetLayer(k.B_Cu);t.SetStart(k.VECTOR2I(5750000,4000000));t.SetEnd(k.VECTOR2I(5750000,6000000));t.SetWidth(200000);t.SetNetCode(other.GetNetCode());b.Add(t)
        b.BuildConnectivity()
        self.assertEqual(_dogbone_fanout_net(b,n.GetNetCode()),0)
        self.assertTrue(_has_through_access(b,pads[0]))
        self.assertEqual(sum(t.GetClass()=='PCB_VIA' for t in b.GetTracks()),0)
        self.assertEqual(len(list(b.GetTracks())),2)
        self.assertEqual(_dogbone_fanout_net(b,n.GetNetCode()),0)
        self.assertEqual(len(list(b.GetTracks())),2)

    def test_surface_reuse_is_idempotent_and_avoids_another_via(self):
        import pcbnew
        from pnr.writeback import _dogbone_fanout_net, _has_through_access

        b = pcbnew.BOARD()
        b.SetCopperLayerCount(4)
        n = pcbnew.NETINFO_ITEM(b, "lv")
        b.Add(n)
        f = pcbnew.FOOTPRINT(b)
        b.Add(f)
        pads = []
        for i, x in enumerate([5, 6.5]):
            p = pcbnew.PAD(f)
            p.SetNumber(str(i + 1))
            p.SetAttribute(pcbnew.PAD_ATTRIB_SMD)
            ls = pcbnew.LSET()
            ls.AddLayer(pcbnew.F_Cu)
            p.SetLayerSet(ls)
            p.SetSize(pcbnew.VECTOR2I(600000, 600000))
            p.SetPosition(pcbnew.VECTOR2I(int(x * 1e6), 5000000))
            p.SetNetCode(n.GetNetCode())
            f.Add(p)
            pads.append(p)
        v = pcbnew.PCB_VIA(b)
        v.SetPosition(pcbnew.VECTOR2I(7500000, 5000000))
        v.SetLayerPair(pcbnew.F_Cu, pcbnew.B_Cu)
        v.SetViaType(pcbnew.VIATYPE_THROUGH)
        v.SetFrontWidth(600000)
        v.SetDrill(300000)
        v.SetNetCode(n.GetNetCode())
        b.Add(v)
        t = pcbnew.PCB_TRACK(b)
        t.SetStart(pads[1].GetPosition())
        t.SetEnd(v.GetPosition())
        t.SetLayer(pcbnew.F_Cu)
        t.SetWidth(200000)
        t.SetNetCode(n.GetNetCode())
        b.Add(t)
        b.BuildConnectivity()
        self.assertFalse(_has_through_access(b, pads[0]))
        self.assertTrue(_has_through_access(b, pads[1]))
        self.assertEqual(_dogbone_fanout_net(b, n.GetNetCode()), 0)
        self.assertTrue(_has_through_access(b, pads[0]))
        self.assertEqual(len(b.GetTracks()), 3)
        self.assertEqual(_dogbone_fanout_net(b, n.GetNetCode()), 0)
        self.assertEqual(len(b.GetTracks()), 3)

    def test_existing_thermal_pad_prevents_extra_router_via(self):
        import pcbnew
        from pnr.writeback import _dogbone_fanout_net

        b = pcbnew.BOARD()
        b.SetCopperLayerCount(4)
        n = pcbnew.NETINFO_ITEM(b, "lv")
        b.Add(n)
        f = pcbnew.FOOTPRINT(b)
        b.Add(f)
        for thermal in [False, True]:
            p = pcbnew.PAD(f)
            p.SetNumber("39")
            p.SetPosition(pcbnew.VECTOR2I(5000000, 5000000))
            p.SetNetCode(n.GetNetCode())
            p.SetAttribute(pcbnew.PAD_ATTRIB_PTH if thermal else pcbnew.PAD_ATTRIB_SMD)
            ls = pcbnew.LSET.AllCuMask() if thermal else pcbnew.LSET()
            ls.AddLayer(pcbnew.F_Cu)
            p.SetLayerSet(ls)
            p.SetSize(
                pcbnew.VECTOR2I(600000, 600000)
                if thermal
                else pcbnew.VECTOR2I(2650000, 2650000)
            )
            if thermal:
                p.SetDrillSize(pcbnew.VECTOR2I(200000, 200000))
            f.Add(p)
        b.BuildConnectivity()
        self.assertEqual(_dogbone_fanout_net(b, n.GetNetCode()), 0)
        self.assertEqual(len(b.GetTracks()), 0)
        self.assertEqual(len(list(f.Pads())), 2)

    def test_surface_reuse_rejects_blocked_connection(self):
        import pcbnew
        from pnr.writeback import _reuse_surface_ground

        b = pcbnew.BOARD()
        n = pcbnew.NETINFO_ITEM(b, "lv")
        b.Add(n)
        f = pcbnew.FOOTPRINT(b)
        b.Add(f)
        ps = []
        for i, x in enumerate([5, 6.5]):
            p = pcbnew.PAD(f)
            p.SetNumber(str(i))
            p.SetAttribute(pcbnew.PAD_ATTRIB_SMD)
            ls = pcbnew.LSET()
            ls.AddLayer(pcbnew.F_Cu)
            p.SetLayerSet(ls)
            p.SetSize(pcbnew.VECTOR2I(600000, 600000))
            p.SetPosition(pcbnew.VECTOR2I(int(x * 1e6), 5000000))
            p.SetNetCode(n.GetNetCode())
            f.Add(p)
            ps.append(p)
        # Force a known target-access classification; obstacle blocks its path.
        with patch("pnr.writeback._has_through_access", return_value=True):
            self.assertFalse(
                _reuse_surface_ground(
                    b,
                    ps[0],
                    [((5750000, 4000000), (5750000, 6000000), 300000, -1)],
                    200000,
                    200000,
                )
            )
        self.assertEqual(len(b.GetTracks()), 0)

    def test_refill_preserves_plane_and_does_not_repeat_fanout(self):
        import pcbnew
        from pnr.writeback import apply_planes

        board = pcbnew.BOARD()
        board.SetCopperLayerCount(4)
        net = pcbnew.NETINFO_ITEM(board, "GND")
        board.Add(net)
        fp = pcbnew.FOOTPRINT(board)
        board.Add(fp)
        pad = pcbnew.PAD(fp)
        pad.SetNumber("1")
        pad.SetAttribute(pcbnew.PAD_ATTRIB_SMD)
        layers = pcbnew.LSET()
        layers.AddLayer(pcbnew.F_Cu)
        pad.SetLayerSet(layers)
        pad.SetSize(pcbnew.VECTOR2I(1000000, 1000000))
        pad.SetPosition(pcbnew.VECTOR2I(5000000, 5000000))
        pad.SetNetCode(net.GetNetCode())
        fp.Add(pad)
        edges = []
        corners = [(0, 0), (10000000, 0), (10000000, 10000000), (0, 10000000)]
        for a, z in zip(corners, corners[1:] + corners[:1]):
            edge = pcbnew.PCB_SHAPE(board)
            edge.SetShape(pcbnew.SHAPE_T_SEGMENT)
            edge.SetLayer(pcbnew.Edge_Cuts)
            edge.SetStart(pcbnew.VECTOR2I(*a))
            edge.SetEnd(pcbnew.VECTOR2I(*z))
            edge.SetWidth(50000)
            board.Add(edge)
            edges.append(edge)
        board.BuildConnectivity()
        rules = {"net_classes": [{"plane_layer": "In1.Cu", "nets": ["GND"]}]}
        with patch(
            "pnr.writeback._dogbone_fanout_net", return_value=0
        ) as fanout, patch("pcbnew.ZONE_FILLER") as filler:
            self.assertEqual(apply_planes(board, rules), 1)
            original = next(iter(board.Zones())).m_Uuid.AsString()
            self.assertEqual(apply_planes(board, rules), 1)
            self.assertEqual(len(board.Zones()), 1)
            self.assertEqual(next(iter(board.Zones())).m_Uuid.AsString(), original)
            fanout.assert_called_once()
            self.assertEqual(filler.return_value.Fill.call_count, 2)


if __name__ == "__main__":
    unittest.main()

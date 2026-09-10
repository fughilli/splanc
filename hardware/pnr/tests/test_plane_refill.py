"""A routing restart must refill the existing plane without duplicating copper."""
import importlib.util
import unittest
from unittest.mock import patch

@unittest.skipUnless(importlib.util.find_spec('pcbnew'), 'requires KiCad Python')
class PlaneRefillTest(unittest.TestCase):
    def test_refill_preserves_plane_and_does_not_repeat_fanout(self):
        import pcbnew
        from pnr.writeback import apply_planes
        board = pcbnew.BOARD()
        board.SetCopperLayerCount(4)
        net = pcbnew.NETINFO_ITEM(board, 'GND')
        board.Add(net)
        fp = pcbnew.FOOTPRINT(board)
        board.Add(fp)
        pad = pcbnew.PAD(fp)
        pad.SetNumber('1')
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
        rules = {'net_classes': [{'plane_layer': 'In1.Cu', 'nets': ['GND']}]}
        with patch('pnr.writeback._dogbone_fanout_net', return_value=0) as fanout, \
                patch('pcbnew.ZONE_FILLER') as filler:
            self.assertEqual(apply_planes(board, rules), 1)
            original = next(iter(board.Zones())).m_Uuid.AsString()
            self.assertEqual(apply_planes(board, rules), 1)
            self.assertEqual(len(board.Zones()), 1)
            self.assertEqual(next(iter(board.Zones())).m_Uuid.AsString(), original)
            fanout.assert_called_once()
            self.assertEqual(filler.return_value.Fill.call_count, 2)

if __name__ == '__main__':
    unittest.main()

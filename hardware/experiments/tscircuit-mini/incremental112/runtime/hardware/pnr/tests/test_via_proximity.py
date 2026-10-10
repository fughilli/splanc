"""Native scanner must distinguish net, distance, and footprint thermal holes."""

import importlib.util
import sys
import unittest
from pathlib import Path


@unittest.skipUnless(importlib.util.find_spec("pcbnew"), "requires KiCad Python")
class ViaProximityTest(unittest.TestCase):
    def test_pair_boundary_and_plated_holes(self):
        import pcbnew

        sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "tools"))
        from scan_via_proximity import scan

        b = pcbnew.BOARD()
        b.SetCopperLayerCount(4)
        nets = []
        for name in ["lv", "other"]:
            n = pcbnew.NETINFO_ITEM(b, name)
            b.Add(n)
            nets.append(n)
        for x, net in [(0, 0), (2, 0), (4.001, 0), (1, 1)]:
            v = pcbnew.PCB_VIA(b)
            v.SetPosition(pcbnew.VECTOR2I(round(x * 1e6), 0))
            v.SetLayerPair(pcbnew.F_Cu, pcbnew.B_Cu)
            v.SetViaType(pcbnew.VIATYPE_THROUGH)
            v.SetFrontWidth(600000)
            v.SetDrill(300000)
            v.SetNetCode(nets[net].GetNetCode())
            b.Add(v)
        f = pcbnew.FOOTPRINT(b)
        f.SetReference("U1")
        b.Add(f)
        for x in [0, 0.1]:
            p = pcbnew.PAD(f)
            p.SetAttribute(pcbnew.PAD_ATTRIB_PTH)
            p.SetLayerSet(pcbnew.LSET.AllCuMask())
            p.SetPosition(pcbnew.VECTOR2I(round(x * 1e6), 0))
            p.SetSize(pcbnew.VECTOR2I(600000, 600000))
            p.SetDrillSize(pcbnew.VECTOR2I(200000, 200000))
            p.SetNetCode(nets[0].GetNetCode())
            f.Add(p)
        r = scan(b, 2)
        self.assertEqual(r["via_count"], 4)
        self.assertEqual(r["pair_count"], 5)  # 1 via-via plus 4 via-hole, no hole-hole.
        self.assertEqual(r["cluster_count"], 1)
        self.assertEqual(len(r["clusters"][0]["nodes"]), 4)
        self.assertEqual(
            sum(n["kind"] == "plated_pad" for n in r["clusters"][0]["nodes"]), 2
        )


if __name__ == "__main__":
    unittest.main()

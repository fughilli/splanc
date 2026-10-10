"""Native regression: a shared zone UUID must not merge disconnected islands."""

import pcbnew
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "tools"))
from keyhole_region import pad_partition

v = lambda x, y: pcbnew.VECTOR2I(round(x * 1e6), round(y * 1e6))


def make(split):
    b = pcbnew.BOARD()
    b.SetCopperLayerCount(4)
    n = pcbnew.NETINFO_ITEM(b, "test")
    b.Add(n)
    for a, z in [
        ((0, 0), (10, 0)),
        ((10, 0), (10, 6)),
        ((10, 6), (0, 6)),
        ((0, 6), (0, 0)),
    ]:
        s = pcbnew.PCB_SHAPE()
        s.SetShape(pcbnew.SHAPE_T_SEGMENT)
        s.SetLayer(pcbnew.Edge_Cuts)
        s.SetStart(v(*a))
        s.SetEnd(v(*z))
        s.SetWidth(50000)
        b.Add(s)
    pads = []
    for ref, x in [("A", 2), ("B", 8)]:
        f = pcbnew.FOOTPRINT(b)
        f.SetReference(ref)
        b.Add(f)
        p = pcbnew.PAD(f)
        p.SetNumber("1")
        p.SetAttribute(pcbnew.PAD_ATTRIB_PTH)
        p.SetShape(pcbnew.PAD_SHAPE_CIRCLE)
        p.SetSize(v(0.6, 0.6))
        p.SetDrillSize(v(0.3, 0.3))
        p.SetPosition(v(x, 3))
        p.SetLayerSet(pcbnew.LSET.AllCuMask())
        p.SetNetCode(n.GetNetCode())
        f.Add(p)
        pads.append(p)
    zone = pcbnew.ZONE(b)
    zone.SetLayer(pcbnew.In1_Cu)
    zone.SetNetCode(n.GetNetCode())
    zone.SetLocalClearance(150000)
    zone.SetMinThickness(100000)
    zone.SetPadConnection(pcbnew.ZONE_CONNECTION_FULL)
    zone.SetThermalReliefGap(200000)
    zone.SetThermalReliefSpokeWidth(200000)
    for x0, x1 in [(0.5, 4.5), (5.5, 9.5)] if split else [(0.5, 9.5)]:
        zone.Outline().NewOutline()
        for x, y in [(x0, 0.5), (x1, 0.5), (x1, 5.5), (x0, 5.5)]:
            zone.Outline().Append(int(x * 1e6), int(y * 1e6))
    b.Add(zone)
    b.BuildConnectivity()
    pcbnew.ZONE_FILLER(b).Fill(b.Zones())
    b.BuildConnectivity()
    return b, pads


for split in [False, True]:
    b, pads = make(split)
    group = b.GetConnectivity().GetConnectedItems(pads[0])
    ids = {t.m_Uuid.AsString() for t in group if isinstance(t, pcbnew.PAD)}
    connected = pads[1].m_Uuid.AsString() in ids
    print("split", split, "connected", connected, flush=True)
    assert connected != split
    assert len(pad_partition(b)) == (2 if split else 1)
print("Native continuous/split-plane connectivity cases pass", flush=True)

import unittest
import pcbnew as k
from pnr.electrical_repair import candidates,restoration_pair
from pnr.via_coalesce import partition
class RepairGuards(unittest.TestCase):
    def setUp(self):
        self.b=k.BOARD();self.n=k.NETINFO_ITEM(self.b,'s');self.b.Add(self.n)
    def track(self,a,z,locked=False):
        t=k.PCB_TRACK(self.b);t.SetNetCode(self.n.GetNetCode());t.SetLayer(k.F_Cu);t.SetWidth(200000);t.SetStart(k.VECTOR2I(int(a*1e6),1000000));t.SetEnd(k.VECTOR2I(int(z*1e6),1000000));t.SetLocked(locked);self.b.Add(t);return t
    def pad(self,ref,x):
        f=k.FOOTPRINT(self.b);f.SetReference(ref);self.b.Add(f);p=k.PAD(f);f.Add(p);p.SetNumber('1');p.SetPosition(k.VECTOR2I(int(x*1e6),1000000));p.SetSize(k.VECTOR2I(500000,500000));p.SetNetCode(self.n.GetNetCode());p.SetAttribute(k.PAD_ATTRIB_SMD);layers=k.LSET();layers.AddLayer(k.F_Cu);p.SetLayerSet(layers);return p
    def test_only_unlocked_wholly_local_segments(self):
        t=self.track(1,2);self.track(2,4);self.track(1,2,True)
        found=candidates(self.b,'s',[0,0,3,3],{})
        self.assertEqual([x.m_Uuid.AsString() for x in found],[t.m_Uuid.AsString()])
    def test_protected_electrical_modes_are_rejected(self):
        for rules in ({'net_classes':[{'nets':['s'],'width_mm':1}]},{'net_classes':[{'nets':['s'],'plane_layer':'In1.Cu'}]},{'diff_pairs':[{'p':'s','n':'other'}]}):
            with self.assertRaises(ValueError):candidates(self.b,'s',[0,0,3,3],rules)
    def test_restore_original_connection_not_preexisting_open(self):
        self.pad('A',1);self.pad('B',2);self.pad('C',3);t=self.track(1,2);self.b.BuildConnectivity();old=partition(self.b)
        self.assertIsNone(restoration_pair(self.b,'s',old));self.b.Remove(t);self.b.BuildConnectivity()
        pair=restoration_pair(self.b,'s',old)
        self.assertEqual({p.GetParentFootprint().GetReference() for p in pair},{'A','B'})
if __name__=='__main__':unittest.main()

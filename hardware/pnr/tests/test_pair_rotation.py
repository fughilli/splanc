import unittest
import pcbnew as k
from test_native_electrical import board,pad
from pnr.native_electrical import move_pair_support,add_track,vec
from pnr.via_coalesce import partition
class RotationTest(unittest.TestCase):
    def test_rotates_isolated_return_with_component_and_rejects_stale_pose(self):
        b=board()
        for ref,x in [('SOURCE',2),('PROTECTOR',8),('SINK',15)]:
            pad(b,ref,'1','p',(x,5),(.2,.2));pad(b,ref,'2','n',(x,5.4),(.2,.2))
        ground=pad(b,'PROTECTOR','3','rail',(9,6),(.4,.4))
        track=add_track(b,'rail',k.F_Cu,(9,6),(10,6),.2);b.BuildConnectivity()
        pair=dict(p='p',n='n',terminal_chain=[dict(p=ref+'.1',n=ref+'.2') for ref in ('SOURCE','PROTECTOR','SINK')])
        spec=dict(ref='PROTECTOR',original=[8,5],position=[8,7],original_rotation=0,rotation=90)
        move_pair_support(b,pair,spec)
        self.assertEqual(track.GetStart(),ground.GetPosition())
        self.assertEqual(track.GetStart(),vec((9,6)))
        self.assertEqual(track.GetEnd(),vec((9,5)))
        self.assertEqual(ground.GetParentFootprint().GetOrientationDegrees(),90)
        with self.assertRaisesRegex(ValueError,'stale pair orientation'):
            move_pair_support(b,pair,dict(spec,original=[8,7]))
if __name__=='__main__':unittest.main()

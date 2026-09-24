import json,tempfile,unittest
from pathlib import Path
from pnr.graph import BoardGraph,BoardOutline,Component,Pad
from pnr.native_loop import pair_placements
class PairPlacementTest(unittest.TestCase):
    def test_source_topology_selects_orientations_without_reference_names(self):
        cs=[Component(ref,'generic',(x,y),rot,'top',(1,1),(1,1),pads=[Pad('1','p',(-.3,0),(.2,.2)),Pad('2','n',(.3,0),(.2,.2))]) for ref,x,y,rot in [('SOCKET',10,2,0),('CLAMP',3,7,180),('LOAD',10,17,0)]]
        g=BoardGraph('generic',cs,[],BoardOutline(20,20))
        inventory=dict(graph=json.loads(g.to_json()),footprint_poses={c.ref:[c.pos[0],20-c.pos[1]] for c in cs})
        pair=dict(terminal_chain=[dict(p=c.ref+'.1',n=c.ref+'.2') for c in cs])
        with tempfile.TemporaryDirectory() as directory:
            config=Path(directory)/'constraints.yaml';config.write_text('schema: v0\nboard:\n  outline: {w: 20, h: 20}\n')
            options=pair_placements(inventory,config,pair)
            self.assertTrue(options);self.assertEqual(options[0]['ref'],'CLAMP')
            self.assertEqual(options[0]['rotation'],0)
            self.assertTrue(all(o['original_rotation']==180 for o in options))
            cs[1].locked=True;inventory['graph']=json.loads(g.to_json())
            self.assertEqual(pair_placements(inventory,config,pair),[])
            inventory['physical_locks']=[]
            self.assertTrue(pair_placements(inventory,config,pair))
            inventory['physical_locks']=['CLAMP']
            self.assertEqual(pair_placements(inventory,config,pair),[])
if __name__=='__main__':unittest.main()

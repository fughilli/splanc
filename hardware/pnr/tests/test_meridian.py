import unittest
from pnr.graph import BoardGraph,BoardOutline,Component
from pnr.place.meridian import expand

class MeridianTest(unittest.TestCase):
    def fixture(self):
        return BoardGraph('test',[Component(str(i),'f',p,0,'top',(1,1),(1,1),locked=True) for i,p in enumerate([(1,1),(3,3),(2.5,2.5)])],[],BoardOutline(5,5,[(0,0),(5,0),(5,5),(0,5)]))
    def test_exact_half_plane_motion_and_outline(self):
        g=self.fixture();original=g.to_json();r={'mounting_holes':[{'at':[1,1]}]}
        out,rules,event=expand(g,r,[[1]],pitch=5,step=.1)
        self.assertEqual(g.to_json(),original);self.assertEqual(r['mounting_holes'][0]['at'],[1,1])
        self.assertEqual(out.component('0').pos,(1.,1.));self.assertEqual(out.component('1').pos,(3.2,3.2))
        self.assertEqual(out.component('2').pos,(2.6,2.6));self.assertEqual(out.outline.width,5.2)
        self.assertEqual(out.outline.polygon[-1],(0.,5.2));self.assertEqual(event['moves']['0']['signed_displacement'],[-.1,-.1])
        self.assertTrue(out.component('0').locked)
    def test_binary_scores_superposition_and_no_feedback(self):
        g=self.fixture();a,_,e=expand(g,{},[[1,3],[0,1]],pitch=2.5,step=.1)
        b,_,_=expand(g,{},[[10,1],[0,100]],pitch=2.5,step=.1)
        self.assertEqual(a.to_json(),b.to_json());self.assertEqual(e['active_cells'],3)
        self.assertEqual(expand(g,{},[[0]],pitch=5)[0].to_dict(),g.to_dict())
        for i in range(2):self.assertGreaterEqual(a.component('1').pos[i]-a.component('0').pos[i],2)
    def test_partial_edge_cell_meridian_is_inside_outline(self):
        g=self.fixture();g.outline.width=4
        _,_,e=expand(g,{},[[0],[1]],pitch=3)
        self.assertEqual(e['meridians'],[[3.5,1.5]])
    def test_invalid_scores_rejected(self):
        for value in [-1,float('nan'),float('inf')]:
            with self.assertRaises(ValueError):expand(self.fixture(),{},[[value]])

if __name__=='__main__':unittest.main()

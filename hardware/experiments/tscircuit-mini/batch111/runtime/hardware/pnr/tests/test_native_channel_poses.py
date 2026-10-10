import unittest
from pnr.graph import BoardGraph,Component,Pad,Net
from pnr.native_loop import rank_translation_channels
from pnr.place.channels import ChannelModel

class NativeChannelPoseTest(unittest.TestCase):
    def test_prioritizes_opening_an_escape_gap_over_first_compass_direction(self):
        a=Component('A','ic',(5,5),0,'top',(2,3),(2,3),pads=[Pad(str(i),'n'+str(i),(1,i*.5-.75),(.2,.2)) for i in range(4)])
        b=Component('B','body',(7.5,5),0,'top',(2,3),(2,3),pads=[Pad('1','',(-1,0),(.2,2))])
        g=BoardGraph('test',[a,b],[Net('n'+str(i),i,[('A',str(i)),('C',str(i))]) for i in range(4)])
        poses=[dict(ref='B',dx=-.25,dy=0,rank=0,score=4),dict(ref='B',dx=.5,dy=0,rank=1,score=4)]
        result=rank_translation_channels(g,{'default_clearance_mm':.15},poses)
        self.assertEqual(result[0]['dx'],.5)
        self.assertGreater(result[0]['channel_improvement'],0)
        self.assertLess(result[1]['channel_improvement'],0)
        self.assertEqual(b.pos,(7.5,5))
        self.assertNotIn('channel_penalty',poses[0])
    def test_native_y_is_reflected_into_engine_coordinates(self):
        a=Component('A','ic',(5,5),0,'top',(3,2),(3,2),pads=[Pad(str(i),'n'+str(i),(i*.5-.75,1),(.2,.2)) for i in range(4)])
        b=Component('B','body',(5,7.5),0,'top',(3,2),(3,2),pads=[Pad('1','',(0,-1),(2,.2))])
        g=BoardGraph('test',[a,b],[Net('n'+str(i),i,[('A',str(i)),('C',str(i))]) for i in range(4)])
        poses=[dict(ref='B',dx=0,dy=.25,rank=0,score=4),dict(ref='B',dx=0,dy=-.5,rank=1,score=4)]
        result=rank_translation_channels(g,{'default_clearance_mm':.15},poses)
        self.assertEqual(result[0]['dy'],-.5)
        self.assertGreater(result[0]['channel_improvement'],0)
    def test_compiled_ampacity_width_not_stale_signal_class_sizes_channel(self):
        g=BoardGraph('test',[],[Net('power',1,[])])
        rules={'electrical_fab':{},'net_classes':[{'nets':['power'],'width_mm':.2}]}
        # Only a complete, already compiled electrical policy activates this path.
        rules['electrical_fab']={'qualification':'test'}
        rules['electrical_nets']={'power':{'outer_width_mm':1.5,'inner_width_mm':2,'rms_current_a':4,'peak_current_a':5}}
        from pnr.electrical import net_policy
        policy=net_policy('power',rules)
        self.assertEqual(policy['outer_width_mm'],1.5)
        self.assertGreater(ChannelModel(g,rules).demand({'power'}),1.5)

if __name__=='__main__':unittest.main()

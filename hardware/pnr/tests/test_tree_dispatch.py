import math,time,unittest
import pcbnew as k
from test_native_electrical import board,pad,FAB
from pnr.electrical import compile_policy,terminal_policy
from pnr.native_electrical import power_plan,Oracle,xy,add_track

class TreeDispatchTest(unittest.TestCase):
    def test_planner_uses_nearby_qualified_lead_instead_of_parallel_trunk_route(self):
        b=board();root=pad(b,'LOAD','1','rail',(5,5),(.4,.4))
        records=[dict(ref='SUPPLY',pads=['1'],net='rail',scope='net',rms_current_a=4,peak_current_a=5,source={}),dict(ref='LOAD',pads=['1'],net='rail',scope='terminal',rms_current_a=4,peak_current_a=5,neck_max_length_mm=.5,source={})]
        rules=compile_policy({'fab':{'track_width_mm':.2},'net_classes':[{'nets':['rail'],'width_mm':1.5}]},records,dict(FAB,neck_loss_budget_w=.01,neck_peak_drop_v=.005))
        width=terminal_policy('LOAD',['1'],'rail',rules)['outer_width_mm']
        add_track(b,'rail',k.F_Cu,(5,5),(5.3,5),.4)
        add_track(b,'rail',k.F_Cu,(5.3,5),(7,5),width)
        add_track(b,'rail',k.F_Cu,(7,5),(8,5),1.5)
        source=pad(b,'NEW','1','rail',(5,3),(.4,.4))
        record=dict(ref='NEW',pads=['1'],net='rail',scope='terminal',rms_current_a=4,peak_current_a=5,neck_max_length_mm=.5,source={})
        rules=compile_policy(rules,rules['current_intents']+[record],rules['electrical_fab'])
        b.BuildConnectivity()
        plan=power_plan(b,'rail',source,root,rules,Oracle(b,rules,deadline=time.monotonic()+10),[0,0,10,10],.25)
        self.assertEqual(plan['status'],'routed')
        self.assertFalse(plan['banks'])
        self.assertLess(sum(math.dist(a,z) for layer,a,z,width in plan['tracks']),2.5)
        self.assertIn(xy(root.GetPosition()),[tuple(p) for layer,a,z,width in plan['tracks'] for p in (a,z)])

if __name__=='__main__':unittest.main()

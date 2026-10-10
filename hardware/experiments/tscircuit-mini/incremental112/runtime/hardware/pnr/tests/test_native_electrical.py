"""Native geometric regressions; run under KiCad Python (no mocked copper)."""
import math,json,tempfile,time,unittest
from pathlib import Path
from types import SimpleNamespace as NS
import pcbnew as k
from pnr.native_electrical import Oracle,vec,add_track,power_plan,bank_clear,add_bank,pair_plan,move_pair_support
from pnr.electrical import compile_policy
from pnr.pad_entry import snapshot
from pnr.via_coalesce import partition
from pnr.route.detail.coupled import solve_pair
from pnr.native_loop import native_worker
FAB=dict(outer_copper_oz=1,inner_copper_oz=1,delta_t_c=40,via_drill_mm=.3,via_diameter_mm=.6,min_via_plating_um=20,board_thickness_mm=1.6,copper_resistivity_ohm_mm=2.1e-5,via_barrel_loss_budget_w=.01,via_array_peak_drop_v=.01,neck_loss_budget_w=.01,neck_peak_drop_v=.005)

def board():
    b=k.BOARD();b.SetCopperLayerCount(4)
    for name in ('rail','other','p','n'):b.Add(k.NETINFO_ITEM(b,name))
    points=[(0,0),(20,0),(20,20),(0,20),(0,0)]
    for a,z in zip(points,points[1:]):
        e=k.PCB_SHAPE(b);e.SetShape(k.SHAPE_T_SEGMENT);e.SetLayer(k.Edge_Cuts);e.SetStart(vec(a));e.SetEnd(vec(z));e.SetWidth(50000);b.Add(e)
    return b

def pad(b,ref,num,net,pos,size=(2,2)):
    f=next((f for f in b.GetFootprints() if f.GetReference()==ref),None)
    if f is None:
        f=k.FOOTPRINT(b);f.SetReference(ref);b.Add(f);f.SetPosition(vec(pos))
    p=k.PAD(f);p.SetNumber(num);p.SetShape(k.PAD_SHAPE_RECT);p.SetSize(vec(size));p.SetPosition(vec(pos));p.SetAttribute(k.PAD_ATTRIB_SMD);ls=k.LSET();ls.AddLayer(k.F_Cu);p.SetLayerSet(ls);p.SetNetCode(b.FindNet(net).GetNetCode());f.Add(p);return p

def rules():
    return compile_policy(dict(fab={'track_width_mm':.2,'clearance_mm':.15},net_classes=[dict(name='power',nets=['rail'],width_mm=1.5)]),[dict(ref='A',pads=['1'],net='rail',rms_current_a=5,peak_current_a=16,source={})],FAB)

class NativeElectricalTest(unittest.TestCase):
    def test_via_index_checks_foreign_inner_copper_across_bucket_boundary(self):
        b=board();add_track(b,'other',k.In2_Cu,(3,5),(8,5),.2)
        r=dict(fab={'clearance_mm':.15},net_classes=[dict(nets=['other'],clearance_mm=1.2)])
        o=Oracle(b,r)
        self.assertFalse(o.via('rail',(5,6.59),.6,.3))
        self.assertTrue(o.via('rail',(5,6.61),.6,.3))

    def test_via_index_blocks_same_net_smd_and_slotted_holes(self):
        b=board();a=pad(b,'A','1','rail',(5,5),(1,1))
        z=pad(b,'Z','1','rail',(12,12),(1,2));z.SetAttribute(k.PAD_ATTRIB_PTH)
        z.SetDrillSize(vec((.7,1.1)));z.SetDrillShape(k.PAD_DRILL_SHAPE_OBLONG)
        z.SetLayerSet(k.LSET.AllCuMask());o=Oracle(b,{})
        self.assertFalse(o.via('rail',(5,5),.6,.3))
        self.assertFalse(o.via('rail',(12,12.7),.6,.3))
        self.assertTrue(o.via('rail',(12,13.1),.6,.3))
        ignored=Oracle(b,{},ignored=[a.m_Uuid.AsString(),z.m_Uuid.AsString()])
        self.assertTrue(ignored.via('rail',(5,5),.6,.3))
        self.assertTrue(ignored.via('rail',(12,12),.6,.3))

    def test_via_index_updates_after_planned_tracks_and_vias(self):
        b=board();o=Oracle(b,{})
        self.assertTrue(o.via('rail',(5,5),.6,.3))
        o.reserve_track('other',k.B_Cu,(3,5),(8,5),.2)
        self.assertFalse(o.via('rail',(5,5),.6,.3))
        o.reserve_via('rail',(12,12))
        self.assertFalse(o.via('rail',(12.2,12),.6,.3))

    def test_custom_power_pad_access_uses_actual_copper_and_required_width(self):
        from pnr.native_electrical import access
        from pnr.pad_entry import witness
        b=board();p=pad(b,'SHIFTED','1','rail',(5,5),(.01,.01));p.SetShape(k.PAD_SHAPE_CUSTOM)
        polygon=k.SHAPE_POLY_SET();polygon.NewOutline()
        for point in [(.3,-.5),(.7,-.5),(.7,.5),(.3,.5)]:polygon.Append(vec(point))
        p.AddPrimitivePoly(k.F_Cu,polygon,0,True)
        choices=access([p],k.F_Cu,.2)
        self.assertTrue(choices)
        for point in choices:
            t=k.PCB_TRACK(b);t.SetStart(vec(point));t.SetEnd(vec(point));t.SetWidth(200000);t.SetLayer(k.F_Cu)
            self.assertTrue(witness(p,t,.2))
        self.assertEqual(access([p],k.F_Cu,.5),[])

    def test_power_trunk_access_projects_onto_full_width_interior(self):
        from pnr.native_electrical import access
        b=board();track=add_track(b,'rail',k.F_Cu,(3,5),(15,5),1.5)
        self.assertIn((9.,5.),access([track],k.F_Cu,1.5,towards=[(9,8)]))
        self.assertEqual(access([track],k.F_Cu,1.6,towards=[(9,8)]),[])

    def test_full_width_power_track_lands_on_smaller_package_pads(self):
        b=board();a=pad(b,'A','1','rail',(3,5),(.6,1.2));z=pad(b,'Z','1','rail',(7,5),(.6,1.2))
        b.BuildConnectivity();r=rules();plan=power_plan(b,'rail',a,z,r,Oracle(b,r),(1,1,19,19),.2)
        self.assertEqual(plan['status'],'routed')
        self.assertTrue(all(t[3]>=1.5 for t in plan['tracks']))
        keep=[add_track(b,'rail',*t) for t in plan['tracks']];b.BuildConnectivity()
        self.assertTrue(all(snapshot(b,r).values()))
        self.assertEqual(len(partition(b)),1)

    def test_full_width_power_plan_and_native_connectivity(self):
        b=board();a=pad(b,'A','1','rail',(3,5));z=pad(b,'Z','1','rail',(15,5));b.BuildConnectivity();r=rules();o=Oracle(b,r)
        plan=power_plan(b,'rail',a,z,r,o,(1,1,19,19),.2)
        self.assertEqual(plan['status'],'routed');self.assertTrue(all(t[3]>=1.5 for t in plan['tracks']))
        keep=[add_track(b,'rail',*t) for t in plan['tracks']];b.BuildConnectivity()
        self.assertEqual(len(partition(b)),1);self.assertTrue(all(snapshot(b,r).values()))
    def test_native_clearance_uses_actual_power_width(self):
        b=board();add_track(b,'other',k.F_Cu,(3,5.7),(15,5.7),.2);o=Oracle(b,rules())
        self.assertTrue(o.clear('rail',k.F_Cu,(3,5),(15,5),.2))
        self.assertFalse(o.clear('rail',k.F_Cu,(3,5),(15,5),1.5))
    def test_planned_copper_is_visible_to_following_pair_stages(self):
        b=board();o=Oracle(b,dict(fab={'clearance_mm':.15}))
        self.assertTrue(o.clear('n',k.F_Cu,(5,2),(5,8),.2))
        o.reserve_track('p',k.F_Cu,(3,5),(8,5),.2)
        self.assertFalse(o.clear('n',k.F_Cu,(5,2),(5,8),.2))
        self.assertTrue(o.clear('p',k.F_Cu,(5,2),(5,8),.2))
        o.reserve_via('p',(10,10))
        self.assertFalse(o.via('n',(10,10),.6,.3))
        self.assertEqual(len(list(b.GetTracks())),0)

    def test_bank_has_current_sized_multiple_barrels(self):
        b=board();r=rules();p=r['electrical_nets']['rail'];o=Oracle(b,r)
        points=bank_clear(o,'rail',(10,10),p,[(k.F_Cu,p['outer_width_mm']),(k.In2_Cu,p['inner_width_mm'])])
        self.assertIsNotNone(points);self.assertGreater(len(points),1)
        keep=add_bank(b,'rail',(10,10),points,p,[(k.F_Cu,p['outer_width_mm']),(k.In2_Cu,p['inner_width_mm'])])
        self.assertEqual(sum(t.GetClass()=='PCB_VIA' for t in b.GetTracks()),p['via_array']['count'])
    def test_neck_requires_short_budget_and_full_width_continuation(self):
        b=board();a=pad(b,'A','1','rail',(3,5),(.25,.8));r=rules();r['current_intents'].append(dict(ref='A',net='rail',pads=['1'],scope='terminal',rms_current_a=2,peak_current_a=2,neck_max_length_mm=.5))
        narrow=add_track(b,'rail',k.F_Cu,(3,5),(3.4,5),.25);b.BuildConnectivity()
        self.assertFalse(all(snapshot(b,r).values()))
        wide=add_track(b,'rail',k.F_Cu,(3.4,5),(5,5),.34);b.BuildConnectivity()
        self.assertTrue(all(snapshot(b,r).values()))
        wide.SetStart(vec((3.4,5.22)));wide.SetEnd(vec((5,5.22)));b.BuildConnectivity()
        self.assertFalse(all(snapshot(b,r).values()))  # grazing the neck end is insufficient
        wide.SetStart(vec((3.4,5)));wide.SetEnd(vec((5,5)))
        narrow.SetEnd(vec((4,5)));wide.SetStart(vec((4,5)));b.BuildConnectivity()
        self.assertFalse(all(snapshot(b,r).values()))
    def test_pair_clearance_native_shapes_and_center_connections(self):
        b=board();terms={'p':((3,5.2),(15,5.2)),'n':((3,4.8),(15,4.8))}
        for net,(a,z) in terms.items():pad(b,net+'A','1',net,a,(.2,.2));pad(b,net+'Z','1',net,z,(.2,.2))
        r=dict(fab={'track_width_mm':.2,'clearance_mm':.15});o=Oracle(b,r)
        result=solve_pair('p','n',terms,(1,1,19,19),lambda n,a,z,w:o.clear(n,k.F_Cu,a,z,w),lambda a,z,w:o.clear('p',k.F_Cu,a,z,w,ignore_nets=('p','n')),.2,.2,.1)
        self.assertEqual(result['status'],'routed')
        keep=[add_track(b,n,k.F_Cu,a,z,.2) for n,path in result['paths'].items() for a,z in zip(path,path[1:])];b.BuildConnectivity()
        self.assertEqual(sorted(map(len,partition(b))),[2,2]);self.assertTrue(all(snapshot(b,r).values()))
    def test_complete_pair_chain_requires_reference_and_matches_endpoints(self):
        b=board()
        chain=[]
        for ref,x in [('J',3),('D',8),('U',15)]:
            pad(b,ref,'1','p',(x,5.2),(.2,.2));pad(b,ref,'2','n',(x,4.8),(.2,.2))
            chain.append({'p':ref+'.1','n':ref+'.2'})
        pair=dict(name='usb',p='p',n='n',width_mm=.2,gap_mm=.2,skew_mm=.1,terminal_chain=chain,reference_layer='In1.Cu')
        r=dict(fab={'track_width_mm':.2,'clearance_mm':.15},electrical_fab=FAB,net_classes=[dict(name='ground',nets=['rail'],plane_layer='In1.Cu')])
        b.BuildConnectivity()
        plan=pair_plan(b,pair,r,Oracle(b,r),(1,1,19,19),.2)
        self.assertEqual(plan['status'],'pair_reference_plane_discontinuity')
        zone=k.ZONE(b);zone.SetLayer(k.In1_Cu);zone.SetNetCode(b.FindNet('rail').GetNetCode());outline=zone.Outline();outline.NewOutline()
        for x,y in [(1,1),(19,1),(19,19),(1,19)]:outline.Append(round(x*1e6),round(y*1e6))
        b.Add(zone);k.ZONE_FILLER(b).Fill(b.Zones());b.BuildConnectivity()
        plan=pair_plan(b,pair,r,Oracle(b,r),(1,1,19,19),.2)
        self.assertEqual(plan['status'],'routed',plan)
        self.assertAlmostEqual(plan['endpoint_metrics']['p']['length_mm'],12,places=5)
        self.assertAlmostEqual(plan['endpoint_metrics']['n']['length_mm'],12,places=5)
        self.assertFalse(plan['impedance_qualified'])

    def test_pair_support_move_preserves_return_and_lock(self):
        b=board();pad(b,'J','1','p',(2,5));pad(b,'J','2','n',(2,8))
        pad(b,'D','1','p',(8,5));pad(b,'D','2','n',(8,8));g=pad(b,'D','3','rail',(9,6),(.3,.3))
        pad(b,'U','1','p',(15,5));pad(b,'U','2','n',(15,8))
        keep=add_track(b,'rail',k.F_Cu,(9,6),(10,6),.2);b.BuildConnectivity()
        pair=dict(p='p',n='n',terminal_chain=[dict(p=f+'.1',n=f+'.2') for f in ('J','D','U')])
        spec=dict(ref='D',original=[8,5],position=[8,7])
        moved=move_pair_support(b,pair,spec)
        self.assertEqual(len(moved['translated_return_items']),1)
        self.assertEqual(keep.GetStart(),vec((9,8)))
        g.GetParentFootprint().SetLocked(True)
        with self.assertRaisesRegex(ValueError,'locked'):move_pair_support(b,pair,dict(spec,original=[8,7],position=[8,9]))

    def test_inventory_identifies_distinct_pads_sharing_one_terminal_number(self):
        from pnr.pad_identity import resolve_pad
        b=board();a=pad(b,'MULTI','3','other',(3,5),(.5,.5));z=pad(b,'MULTI','3','other',(7,5),(.5,.5))
        with self.assertRaisesRegex(ValueError,'one match'):resolve_pad(b,'MULTI.3')
        self.assertEqual(resolve_pad(b,'MULTI.3',a.m_Uuid.AsString()).m_Uuid,a.m_Uuid)
        with tempfile.TemporaryDirectory() as td:
            d=Path(td);pcb=d/'b.kicad_pcb';r=d/'r.json';report=d/'i.json'
            k.SaveBoard(str(pcb),b);r.write_text('{}')
            native_worker(NS(board=pcb,rules=r,annotation_source=[],worker='inspect',report=report))
            targets=json.loads(report.read_text())['targets']
            self.assertEqual(len(targets),1)
            self.assertEqual(targets[0]['source'],targets[0]['target'])
            self.assertNotEqual(targets[0]['source_uuid'],targets[0]['target_uuid'])
            self.assertEqual({targets[0]['source_uuid'],targets[0]['target_uuid']},{a.m_Uuid.AsString(),z.m_Uuid.AsString()})

    def test_inventory_covers_all_disconnected_groups(self):
        b=board()
        for i,x in enumerate((3,7,12,16)):pad(b,'P'+str(i),'1','other',(x,5),(.5,.5))
        with tempfile.TemporaryDirectory() as td:
            d=Path(td);pcb=d/'b.kicad_pcb';r=d/'r.json';report=d/'i.json';k.SaveBoard(str(pcb),b);r.write_text('{}')
            native_worker(NS(board=pcb,rules=r,annotation_source=[],worker='inspect',report=report))
            self.assertEqual(len(json.loads(report.read_text())['targets']),3)

class PowerTreeTest(unittest.TestCase):
 def test_local_branch_joins_existing_full_current_tree(self):
  b=board();a=pad(b,'LOAD','1','rail',(3,5),(.4,.4));target=pad(b,'CAP','1','rail',(3,10));root=pad(b,'ROOT','1','rail',(10,5));keep=add_track(b,'rail',k.F_Cu,(10,5),(15,5),1.5);b.BuildConnectivity()
  r=rules();r['current_intents'].append(dict(ref='LOAD',pads=['1'],net='rail',scope='terminal',rms_current_a=.01,peak_current_a=.01))
  plan=power_plan(b,'rail',a,target,r,Oracle(b,r),(1,1,19,19),.2)
  self.assertEqual(plan['status'],'routed');keep2=[add_track(b,'rail',*t) for t in plan['tracks']];b.BuildConnectivity()
  self.assertTrue(all(snapshot(b,r).values()));groups=partition(b)
  self.assertTrue(any(a.m_Uuid.AsString() in group and root.m_Uuid.AsString() in group and target.m_Uuid.AsString() not in group for group in groups))
 def test_narrow_existing_leaf_is_not_a_trunk_anchor(self):
  b=board();a=pad(b,'LOAD','1','rail',(3,5),(.4,.4));target=pad(b,'CAP','1','rail',(3,10));root=pad(b,'ROOT','1','rail',(10,5));keep=add_track(b,'rail',k.F_Cu,(10,5),(15,5),.2);b.BuildConnectivity()
  r=rules();r['current_intents'].append(dict(ref='LOAD',pads=['1'],net='rail',scope='terminal',rms_current_a=.01,peak_current_a=.01))
  plan=power_plan(b,'rail',a,target,r,Oracle(b,r),(1,1,19,19),.2);self.assertEqual(plan['status'],'routed');keep2=[add_track(b,'rail',*t) for t in plan['tracks']];b.BuildConnectivity()
  self.assertFalse(any(a.m_Uuid.AsString() in group and root.m_Uuid.AsString() in group for group in partition(b)))
 def test_unreachable_alternate_trunk_keeps_original_target_fallback(self):
  b=board();a=pad(b,'A','1','rail',(3,5));target=pad(b,'CAP','1','rail',(7,5));keep=add_track(b,'rail',k.F_Cu,(15,15),(18,15),1.5);b.BuildConnectivity()
  r=rules();plan=power_plan(b,'rail',a,target,r,Oracle(b,r),(1,1,9,9),.2)
  self.assertEqual(plan['status'],'routed');keep2=[add_track(b,'rail',*t) for t in plan['tracks']];b.BuildConnectivity()
  self.assertTrue(any(a.m_Uuid.AsString() in group and target.m_Uuid.AsString() in group for group in partition(b)))


from pnr.native_electrical import uid
from pnr.electrical import net_policy
class PowerLandingTest(unittest.TestCase):
 def test_low_current_branch_preserves_full_width_rail_pad_entry(self):
  b=board();a=pad(b,'A','1','rail',(3,5),(.6,.6));z=pad(b,'Z','1','rail',(12,5),(2,2));b.BuildConnectivity()
  r=compile_policy(dict(fab={'track_width_mm':.2,'clearance_mm':.15},net_classes=[dict(name='power',nets=['rail'],width_mm=1.5)]),[dict(ref='Z',pads=['1'],net='rail',rms_current_a=2,peak_current_a=2,source={}),dict(ref='A',pads=['1'],net='rail',scope='terminal',rms_current_a=.001,peak_current_a=.001,source={})],FAB)
  plan=power_plan(b,'rail',a,z,r,Oracle(b,r),(0,0,20,20),.15)
  self.assertEqual(plan['status'],'routed')
  for la,x,y,w in plan['tracks']:add_track(b,'rail',la,x,y,w)
  b.BuildConnectivity();entries=snapshot(b,r)
  self.assertTrue(entries[uid(a)+':0']);self.assertTrue(entries[uid(z)+':0'])
  self.assertTrue(any(abs(t[3]-net_policy('rail',r)['outer_width_mm'])<1e-9 for t in plan['tracks']))

 def test_annotated_root_terminal_does_not_get_a_rail_width_collar(self):
  b=board();a=pad(b,'A','1','rail',(3,5),(.6,.6));z=pad(b,'Z','1','rail',(12,5),(.6,.6));b.BuildConnectivity()
  current=[dict(ref=ref,pads=['1'],net='rail',scope='terminal',rms_current_a=.001,peak_current_a=.001,source={}) for ref in ('A','Z')]
  r=compile_policy(dict(fab={'track_width_mm':.2,'clearance_mm':.15},net_classes=[dict(name='power',nets=['rail'],width_mm=1.5)]),current,FAB)
  plan=power_plan(b,'rail',a,z,r,Oracle(b,r),(0,0,20,20),.15)
  self.assertEqual(plan['status'],'routed');self.assertNotIn('root_landing',plan)
  self.assertTrue(all(abs(t[3]-.2)<1e-9 for t in plan['tracks']))



class SharedMoveTest(unittest.TestCase):
 def test_internal_pad_bridge_moves_both_ends_and_retains_entries(self):
  b=board();a=pad(b,'A','1','p',(5,5),(.4,.45));z=pad(b,'A','2','p',(5,5.65),(.4,.45));add_track(b,'p',k.F_Cu,(5,5),(5,5.65),.2)
  r={'fab':{'track_width_mm':.2,'clearance_mm':.15}}
  before=snapshot(b,r);self.assertTrue(all(before.values()))
  with tempfile.TemporaryDirectory() as d:
   d=Path(d);pcb=d/'in.kicad_pcb';k.SaveBoard(str(pcb),b)
   rules=d/'rules.json';rules.write_text(json.dumps(r));spec=d/'move.json';spec.write_text(json.dumps(dict(ref='A',dx=.5,dy=0)))
   native_worker(NS(board=pcb,rules=rules,annotation_source=[],worker='move',spec=spec,out=d/'out.kicad_pcb',report=d/'report.json'))
   moved=k.LoadBoard(str(d/'out.kicad_pcb'));after=snapshot(moved,r)
   self.assertTrue(all(after.get(i,False) for i in before));self.assertEqual(len(partition(moved)),1)
   tracks=list(moved.GetTracks());self.assertEqual(len(tracks),1)
   self.assertEqual(tracks[0].GetStart().x,5500000);self.assertEqual(tracks[0].GetEnd().x,5500000)


if __name__=='__main__':unittest.main()


"""Independent assertions for circuit intent and the fail-closed acceptance gate."""
import copy,unittest
from collections import Counter
from designs import designs
from run import acceptance

class CircuitContract(unittest.TestCase):
 def test_ladder_and_multiterminal_networks(self):
  cases=designs();self.assertEqual([len(c['parts']) for c in cases],[2,3,5,8,10,14,20,20])
  self.assertEqual([c['constraints']['board']['layers'] for c in cases],[2]*7+[4])
  for c in cases:
   with self.subTest(c=c['name']):
    self.assertEqual(len({p['ref'] for p in c['parts']}),len(c['parts']))
    counts=Counter(n for p in c['parts'] for n in p['pins'].values() if n)
    self.assertTrue(all(v>=2 for v in counts.values()),counts)
    self.assertEqual(set(c['constraints']['fixed']),{'J1'})
 def test_timer_and_counter_pin_contract(self):
  for c in designs()[4:]:
   parts={p['ref']:p for p in c['parts']};timer=parts['U1']['pins']
   self.assertEqual(timer,{'1':'GND','2':'TIMING','3':'CLOCK','4':'VCC','5':'CONTROL','6':'TIMING','7':'DISCHARGE','8':'VCC'})
   if 'U2' in parts:
    counter=parts['U2']['pins'];self.assertEqual([counter[str(i)] for i in (8,13,14,15,16)],['GND','GND','CLOCK','RESET','VCC'])
    self.assertEqual(counter['4' if len(parts)==14 else '1'],'RESET')
    self.assertEqual(parts['C4']['pins'],{'1':'VCC','2':'GND'})
 def test_no_onboard_current_limiter_only_for_external_current_source(self):
  c=designs()[0];self.assertIn('current source',c['description'])
  for c in designs()[1:]:self.assertTrue(any(p['ref'].startswith('R') for p in c['parts']))

class GateContract(unittest.TestCase):
 def setUp(self):
  self.p=dict(legal=True,converged=True,unrouted=[],deferred=[])
  self.a=dict(netlist_preserved=True,subwidth_tracks=[],pad_entries=[dict(qualified=True)])
  self.d=dict(unconnected_items=[],violations=[])
 def test_clean(self):self.assertEqual(acceptance(self.p,self.a,self.d),[])
 def test_no_native_report_no_pass(self):self.assertIn('invalid_drc_report',acceptance(self.p,self.a,{}))
 def test_native_opens_override_router_success(self):
  self.d['unconnected_items']=[{}];self.assertIn('native_unconnected_items',acceptance(self.p,self.a,self.d))
 def test_every_native_warning_rejected(self):
  for kind in ['shorting_items','clearance','track_dangling','via_dangling','lib_footprint_mismatch']:
   self.d['violations']=[dict(type=kind,severity='warning')];self.assertIn('native_drc_violations',acceptance(self.p,self.a,self.d))
 def test_missing_net_not_hidden_by_zero_opens(self):
  self.a['netlist_preserved']=False;self.assertIn('changed_pin_netlist',acceptance(self.p,self.a,self.d))
 def test_narrow_grazing_contact_rejected(self):
  self.a['pad_entries'][0]['qualified']=False;self.assertIn('unqualified_pad_entry',acceptance(self.p,self.a,self.d))
 def test_power_or_pair_deferral_is_incomplete(self):
  self.p['deferred']=['VCC'];self.assertIn('incomplete_pnr',acceptance(self.p,self.a,self.d))
 def test_undersized_copper_rejected(self):
  self.a['subwidth_tracks']=['track'];self.assertIn('undersized_copper',acceptance(self.p,self.a,self.d))

if __name__=='__main__':unittest.main()

#!/usr/bin/env python3
"""Connectivity parity and physical contract checks (not circuit simulation/ERC)."""
from pathlib import Path
import json,collections
import pcbnew as k
R=Path(__file__).resolve().parents[1]
d=json.loads((R/'design.json').read_text());out={}
for name,B in d['boards'].items():
 board=k.LoadBoard(str(R/'boards'/f'splanc_max_{name}.kicad_pcb'));fs={f.GetReference():f for f in board.GetFootprints()}
 assert len(fs)==len(B['components'])+len(B['mounts'])
 assert len(board.GetTracks())==0
 edge_points=[p for g in board.GetDrawings() if g.GetLayer()==k.Edge_Cuts for p in [g.GetStart(),g.GetEnd()]]
 assert abs(k.ToMM(max(p.x for p in edge_points)-min(p.x for p in edge_points))-B['outline']['width_mm'])<.001
 assert abs(k.ToMM(max(p.y for p in edge_points)-min(p.y for p in edge_points))-B['outline']['height_mm'])<.001
 compiled=k.LoadBoard(str(R/'elec/layout'/name/(name+'.kicad_pcb')))
 af={f.GetFieldText('atopile_address'):f for f in compiled.GetFootprints() if f.HasField('atopile_address')}
 equiv=collections.defaultdict(set);reverse=collections.defaultdict(set);checked=0
 for c in B['components']:
  f=fs[c['ref']];pos=f.GetPosition();assert abs(k.ToMM(pos.x)-c['position'][0])<.001 and abs(k.ToMM(pos.y)-(B['outline']['height_mm']-c['position'][1]))<.001,(name,c['ref'],'coordinate contract');ap={p.GetNumber():p for p in af[c['ref']].Pads()};np={p.GetNumber():p for p in f.Pads()}
  for pin,net in c['nets'].items():
   assert pin in np,(name,c['ref'],pin,'missing native pad')
   assert np[pin].GetNetname()==net,(name,c['ref'],pin)
   assert pin in ap,(name,c['ref'],pin,'missing atopile pad')
   actual=ap[pin].GetNetname();assert actual
   equiv[net].add(actual);reverse[actual].add(net);checked+=1
 assert all(len(x)==1 for x in equiv.values()),('split source net',name,dict(equiv))
 assert all(len(x)==1 for x in reverse.values()),('shorted source nets',name,dict(reverse))
 for i,m in enumerate(B['mounts']):
  p=fs[f'H{i+1}'].GetPosition();assert abs(k.ToMM(p.x)-m['x'])<.001 and abs(k.ToMM(p.y)-(B['outline']['height_mm']-m['y']))<.001
 assert not json.loads((R/'placement-report.json').read_text())[name]['overlap_pairs']
 board.BuildConnectivity();conn=board.GetConnectivity();conn.RecalculateRatsnest()
 out[name]={'native_unconnected_count':conn.GetUnconnectedCount(False),'footprints':len(fs),'circuit_components':len(B['components']),'connected_pads_checked':checked,'atopile_net_partition_matches':True,'no_tracks':True,'mounts_checked':len(B['mounts'])}
assert sum(c['part']=='SW' for c in d['boards']['power']['components'])==20
assert len({n for c in d['boards']['lv']['components'] for n in c['nets'].values() if n.startswith('DATA')})==20
pw={c['ref']:c for c in d['boards']['power']['components']}
assert sum(c['part']=='CSA' for c in pw.values())==5
assert sum(c['part']=='MUX' for c in pw.values())==5
assert sum(c['part']=='ADC' for c in pw.values())==1
for ref in ['U6','U7','U8']:assert pw[ref]['nets']['13']=='SHIFT_OE_N'
for i in range(20):
 assert pw[f'J{i+10}']['nets']['3']==f'RETURN{i}'
 assert pw[f'RS{i}']['nets']=={'1':f'RETURN{i}','2':'PGND'}
 assert pw[f'U{i+20}']['nets']['14']=='FAULT_N'
 assert pw[f'U{i+20}']['nets']['3']==f'EN{i}'
 assert pw[f'U{50+i//4}']['nets'][str([3,5,10,12][i%4])]==f'RETURN{i}'
 assert pw[f'U{50+i//4}']['nets'][str([2,6,9,13][i%4])]=='PGND'
native_power=k.LoadBoard(str(R/'boards/splanc_max_power.kicad_pcb'));nf={f.GetReference():f for f in native_power.GetFootprints()}
header_report=[]
for i in range(20):
 f=nf[f'J{i+10}'];pads={p.GetNumber():p for p in f.Pads()};expected_rotation=0 if i<10 else 180
 assert abs(f.GetOrientationDegrees()-expected_rotation)<.001
 assert abs(pw[f'J{i+10}']['position'][1]-(9.9 if i<10 else 110.1))<.001
 assert pads['1'].GetNetname()==f'OUT{i}' and pads['3'].GetNetname()==f'RETURN{i}'
 for pad in pads.values():assert abs(k.ToMM(pad.GetDrillSize().x)-1.5)<.001
 assert abs(abs(k.ToMM(pads['2'].GetPosition().x-pads['1'].GetPosition().x))-5.08)<.001
 # Board-frame front vector: south +nativeY, north -nativeY.
 front_y=k.ToMM(f.GetPosition().y)+(9.9 if i<10 else -9.9)
 assert abs(front_y-(120 if i<10 else 0))<.001
 body=[g for g in f.GraphicalItems() if g.GetLayer()==k.F_Fab and g.GetShape()==k.SHAPE_T_RECT][0]
 assert abs(k.ToMM(abs(body.GetEnd().x-body.GetStart().x))-17.24)<.001
 assert abs(k.ToMM(abs(body.GetEnd().y-body.GetStart().y))-12)<.001
 header_report.append({'ref':f.GetReference(),'native_front_y':front_y,'rotation':expected_rotation,'pin1':pads['1'].GetNetname(),'pin3':pads['3'].GetNetname(),'body_mm':[17.24,12,8.6],'drill_mm':1.5})
(R/'validation/header-coordinate-check.json').write_text(json.dumps(header_report,indent=2)+'\n')
assert pw['U9']['nets']['15']==pw['U9']['nets']['16']=='P5V'
assert pw['U9']['nets']['6']=='REF2V5'
out['power']['telemetry_and_safe_off_checks']=True
(R/'validation.json').write_text(json.dumps(out,indent=2)+'\n');print(json.dumps(out,indent=2))

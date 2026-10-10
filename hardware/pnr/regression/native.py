"""Native KiCad endpoints, always launched in a separate pcbnew process."""
import argparse,hashlib,json,math,uuid
from pathlib import Path
import pcbnew as k
from pnr.ingest import load
from pnr.writeback import frame_region,patch_project_rules

def make(spec,root,library):
 b=k.BOARD();b.SetCopperLayerCount(spec['constraints']['board']['layers'])
 nets=sorted({n for p in spec['parts'] for n in p['pins'].values() if n})
 nm={}
 for n in nets:
  ni=k.NETINFO_ITEM(b,n);b.Add(ni);nm[n]=ni
 used={};footprints=[]
 for i,p in enumerate(spec['parts']):
  lib,name=p['footprint'].split(':');folder=library/(lib+'.pretty')
  fp=k.FootprintLoad(str(folder),name)
  if fp is None:raise ValueError('Missing library '+p['footprint'])
  used[lib]=str(folder);b.Add(fp);fp.SetReference(p['ref']);fp.SetValue(p['value'])
  items=[fp,fp.Reference(),fp.Value(),*fp.Pads(),*fp.GraphicalItems()]
  for index,item in enumerate(items):
   item.m_Uuid.Clone(k.KIID(str(uuid.uuid5(uuid.NAMESPACE_URL,'splanc-regression/'+spec['name']+'/'+p['ref']+'/'+str(index)))))
  fp.SetFPID(k.LIB_ID(lib,name));fp.Reference().SetLayer(k.F_Fab)
  # Deliberately naive row, unrelated to final pose, with no copper at all.
  fp.SetPosition(k.VECTOR2I(round((35+i*12)*1e6),40000000))
  seen=set()
  for pad in fp.Pads():
   pin=pad.GetNumber();seen.add(pin)
   if pin not in p['pins']:raise ValueError('Unspecified pin '+p['ref']+'.'+pin)
   if p['pins'][pin]:pad.SetNet(nm[p['pins'][pin]])
  if seen!=set(p['pins']):raise ValueError('Missing pad '+p['ref'])
  footprints.append(fp)
 source=root/'source.kicad_pcb';k.SaveBoard(str(source),b)
 size=spec['constraints']['board']['outline']
 source.write_text(frame_region(source.read_text(),size['w'],size['h']))
 table='(fp_lib_table (version 7)\n'+''.join(' (lib (name %s) (type "KiCad") (uri %s) (options "") (descr "Regression source"))\n'%(json.dumps(lib),json.dumps(path)) for lib,path in used.items())+')\n'
 (root/'fp-lib-table').write_text(table)
 graph=load(str(source));graph.components.sort(key=lambda c:c.ref);graph.nets.sort(key=lambda n:n.name)
 (root/'source-graph.json').write_text(graph.to_json())
 (root/'library-manifest.json').write_text(json.dumps({p['footprint']:dict(path=str(library/(p['footprint'].split(':')[0]+'.pretty')/(p['footprint'].split(':')[1]+'.kicad_mod')),sha256=hashlib.sha256((library/(p['footprint'].split(':')[0]+'.pretty')/(p['footprint'].split(':')[1]+'.kicad_mod')).read_bytes()).hexdigest()) for p in spec['parts']},indent=2))

def audit(spec,root,pcb):
 from pnr.pad_entry import inspect,required_width
 b=k.LoadBoard(str(pcb));b.BuildConnectivity()
 expected={(p['ref'],pin):n for p in spec['parts'] for pin,n in p['pins'].items()}
 actual={(fp.GetReference(),pad.GetNumber()):pad.GetNetname() for fp in b.GetFootprints() for pad in fp.Pads()}
 rules=json.loads((root/'rules.json').read_text())
 entries=[dict(ref=p.GetParentFootprint().GetReference(),pin=p.GetNumber(),net=p.GetNetname(),layer=b.GetLayerName(la),required_width_mm=w,qualified=bool(good)) for p,la,ts,w,good in inspect(b,rules)]
 netwidth={n:rules['fab']['track_width_mm'] for n in set(expected.values()) if n}
 for cls in rules['net_classes']:
  for n in cls['nets']:netwidth[n]=max(netwidth[n],cls['width_mm'])
 thin=[str(t.m_Uuid.AsString()) for t in b.GetTracks() if t.GetClass()=='PCB_TRACK' and t.GetWidth()/1e6+1e-6<netwidth.get(t.GetNetname(),0)]
 data=dict(netlist_preserved=expected==actual,components=len(b.GetFootprints()),pads=len(actual),
  tracks=sum(t.GetClass()=='PCB_TRACK' for t in b.GetTracks()),vias=sum(t.GetClass()=='PCB_VIA' for t in b.GetTracks()),
  copper_length_mm=sum(t.GetLength()/1e6 for t in b.GetTracks() if t.GetClass()=='PCB_TRACK'),
  subwidth_tracks=thin,pad_entries=entries,layer_count=b.GetCopperLayerCount(),
  missing_pins=[str(v) for v in expected.keys()-actual.keys()])
 (root/'native-audit.json').write_text(json.dumps(data,indent=2))

if __name__=='__main__':
 a=argparse.ArgumentParser();a.add_argument('mode',choices=['make','audit']);a.add_argument('root',type=Path);a.add_argument('--library',type=Path);a.add_argument('--pcb',type=Path);v=a.parse_args()
 spec=json.loads((v.root/'design.json').read_text())
 if v.mode=='make':make(spec,v.root,v.library)
 else:audit(spec,v.root,v.pcb)

"""Prove the installed native oracle rejects disconnected and shorted copper.

Run with pcbnew Python on a PASSED two-component result directory. Deliberate
faults are saved to separate files; the routed result is never modified.
"""
import argparse,json,shutil,subprocess,hashlib,sys
from pathlib import Path
import pcbnew as k
import wx
_app=wx.App(False)
p=argparse.ArgumentParser();p.add_argument('case',type=Path);p.add_argument('--kicad-cli',required=True);p.add_argument('--worker');a=p.parse_args()
out=a.case/'negative-controls';out.mkdir(exist_ok=bool(a.worker));source=a.case/'routed.kicad_pcb'
original=hashlib.sha256(source.read_bytes()).hexdigest()
shutil.copy2(a.case/'fp-lib-table',out/'fp-lib-table')
results={}
for mode in ([a.worker] if a.worker else ['open','short']):
 if not a.worker:
  subprocess.run([sys.executable,__file__,str(a.case),'--kicad-cli',a.kicad_cli,'--worker',mode],check=True,timeout=60)
  results[mode]=json.loads((out/(mode+'-result.json')).read_text())
  continue
 b=k.LoadBoard(str(source))
 if mode=='open':
  for track in list(b.GetTracks()):b.Remove(track)
  for zone in list(b.Zones()):b.Remove(zone)
 else:
  pads=[p for f in b.GetFootprints() if f.GetReference()=='J1' for p in f.Pads()]
  assert len(pads)==2 and pads[0].GetNetCode()!=pads[1].GetNetCode()
  t=k.PCB_TRACK(b);t.SetStart(pads[0].GetPosition());t.SetEnd(pads[1].GetPosition());t.SetWidth(250000);t.SetLayer(k.F_Cu);t.SetNetCode(pads[0].GetNetCode());b.Add(t)
 pcb=out/(mode+'.kicad_pcb');k.SaveBoard(str(pcb),b);shutil.copy2(source.with_suffix('.kicad_pro'),pcb.with_suffix('.kicad_pro'))
 report=out/(mode+'-drc.json')
 subprocess.run([a.kicad_cli,'pcb','drc',str(pcb),'--format','json','--output',str(report)],check=True,timeout=60,capture_output=True)
 data=json.loads(report.read_text());types=sorted({v['type'] for v in data['violations']})
 detected=bool(data['unconnected_items']) if mode=='open' else 'shorting_items' in types
 results[mode]=dict(detected=detected,opens=len(data['unconnected_items']),types=types)
assert hashlib.sha256(source.read_bytes()).hexdigest()==original
(out/(a.worker+'-result.json' if a.worker else 'result.json')).write_text(json.dumps(results[a.worker] if a.worker else results,indent=2))
print(json.dumps(results,indent=2));assert all(r['detected'] for r in results.values())

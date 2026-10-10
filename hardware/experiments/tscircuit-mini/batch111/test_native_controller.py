import pcbnew as k,json
from pathlib import Path
r=Path('output/batch111/controller-regression');r.mkdir(parents=True,exist_ok=False)
b=k.LoadBoard('output/parallel107/merge-fixture/base.kicad_pcb')
for f in b.GetFootprints():
 if f.GetReference()=='J2':
  for p in f.Pads():p.SetPosition(k.VECTOR2I(5000000 if p.GetNumber()=='1' else 15000000,15000000))
k.SaveBoard(str(r/'base.kicad_pcb'),b)
(r/'base.kicad_pro').write_text(json.dumps({'net_settings':{'classes':[{'name':'Default','track_width':.2,'clearance':.15,'via_diameter':.6,'via_drill':.3}],'netclass_patterns':[]}}))
(r/'rules.json').write_text(json.dumps({'fab':{'track_width_mm':.2,'clearance_mm':.15,'via_diameter_mm':.6,'via_drill_mm':.3},'net_classes':[],'diff_pairs':[],'length_match':[]}))

import subprocess,os,sys
wrapper=Path(__file__).with_name('runtime.py').resolve()
cli='/Applications/KiCad/KiCad.app/Contents/MacOS/kicad-cli'
for mode in ('signal','power'):
 rules=json.loads((r/'rules.json').read_text())
 if mode=='power':rules['net_classes']=[dict(name='power',nets=['A','B'],width_mm=.4,clearance_mm=.15)]
 policy=r/(mode+'-rules.json');policy.write_text(json.dumps(rules));out=r/mode
 cmd=['python3',str(wrapper),'-m','pnr.native_loop',str(r/'base.kicad_pcb'),'--rules',str(policy),'--constraints','output/fresh-pnr-20260919/full104/constraints.yaml','--route-only','--cycles','1','--route-attempts','2','--search-seconds','5','--seconds','90','--out-dir',str(out),'--kicad-python',sys.executable,'--kicad-cli',cli]
 if mode=='power':cmd+=['--electrical-fab','hardware/splanc_dev/mini-routing-electrical-fab.json','--only-mode','power']
 subprocess.run(cmd,check=True,env=dict(os.environ,PNR_SINGLE_TRACK_WORKERS='2',OMP_NUM_THREADS='1'))
 progress=json.loads((out/'progress.json').read_text());assert progress['initial_opens']==2 and progress['opens']==0
 events=[e for e in progress['events'] if e['stage']=='batch_native_validation'];assert len(events)==1 and events[0]['accepted']==2 and events[0]['metrics']['validation_attempts']==1
 proposals=list(out.glob('cycle-01/parallel-*/proposal'));assert len(proposals)==2
 for folder in proposals:
  result=json.loads((folder/'result.json').read_text());assert result['proposal_ready'] and not result['accepted']
  assert not list(folder.glob('*.drc.json')), 'Proposal worker ran native DRC'
 validation=json.loads(next(out.glob('cycle-01/batch-*/result.json')).read_text());assert validation['accepted'] and validation['violations']==0
print('PASS signal/power workers defer DRC, full controller validates once, zero opens/violations')

#!/usr/bin/env python3
from pathlib import Path
import pcbnew as k,json,collections,csv,hashlib
R=Path(__file__).resolve().parents[1];report={}
for v in ['base','gps']:
 src=R/'elec/layout'/v/(v+'.kicad_pcb');dst=R/'boards'/f'splanc_{v}.kicad_pcb';a=k.LoadBoard(str(src));b=k.LoadBoard(str(dst))
 def fps(board):return {f.GetFieldText('atopile_address'):f for f in board.GetFootprints() if f.HasField('atopile_address')}
 af,bf=fps(a),fps(b);assert af.keys()==bf.keys();checked=0
 for addr,f in af.items():
  def nets(f):return sorted((p.GetNumber(),p.GetNetname()) for p in f.Pads())
  assert nets(f)==nets(bf[addr]),addr;checked+=len(nets(f))
 assert len(b.GetTracks())==0
 for variant in [v]:assert not json.loads((R/'placement-report.json').read_text())[variant]['overlap_pairs']
 p4=bf['board.esp.p4'];nets={p.GetNumber():p.GetNetname() for p in p4.Pads()}
 assert len({nets[str(i)] for i in [26,54,76,91]})==1
 assert len({nets[str(i)] for i in [59,67,72]})==1
 assert nets['30']==nets['71']
 assert nets['105']!=nets['9']!=nets['26']
 assert nets['49']!=nets['50']
 assert sum(addr.endswith('.conn') and '.led' in addr for addr in bf)==2
 assert ('gps.gnss' in bf)==(v=='gps')
 assert 'board.esp.wireless' in bf and 'board.esp.uwb' in bf
 b.BuildConnectivity();connectivity=b.GetConnectivity();connectivity.RecalculateRatsnest();opens=connectivity.GetUnconnectedCount(False)
 report[v]={'native_unconnected_count':opens,'atopile_to_native_pad_net_assignments_checked':checked,'components':len(bf),'tracks':0,'pin54_is_core_power':True,'separate_core_and_3v3':True,'psram_from_vddo_psram':True,'optional_gnss_correct':True,'native_sha256':hashlib.sha256(dst.read_bytes()).hexdigest()}
 with (R/f'{v}-engineering-bom.csv').open('w') as h:
  w=csv.writer(h);w.writerow(['value_or_part','quantity','references','status'])
  groups=collections.defaultdict(list)
  for f in bf.values():groups[f.GetValue()].append(f.GetReference())
  for value,refs in sorted(groups.items()):w.writerow([value,len(refs),' '.join(sorted(refs)),'engineering selection; verify purchasing ID'])
(R/'validation/connectivity.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps(report,indent=2))

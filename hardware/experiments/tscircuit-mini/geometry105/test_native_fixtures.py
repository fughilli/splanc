"""Saved-board regressions: branch consolidation and simultaneous escape room."""
import json,hashlib,collections
from pathlib import Path
import pcbnew as k
from pnr.native_electrical import Oracle
root=Path('output/geometry105');rules=json.load(open('output/fresh-pnr-20260919/full104/relocation/round-01/alternatives/candidate-00/evaluated-rules.json'))
source=Path('output/fresh-pnr-20260919/full104/relocation/round-01/diagnostic.kicad_pcb');assert hashlib.sha256(source.read_bytes()).hexdigest()=='0459b8dfe5e5ecd3bee2d26a780f5b69ba0bd0066395c89f6b0ff133355a0922'
branch=json.loads((root/'board-fault-v2.kicad_pcb.json').read_text());assert branch['connectivity_preserved'] and not branch['lost_pad_entries'];assert branch['after_mm']<branch['before_mm']*.8;degrees=collections.Counter(tuple(p) for e in branch['edges'] for p in e);assert max(degrees.values())>=3
b=k.LoadBoard(str(source));original=Oracle(b,rules);after=k.LoadBoard(str(root/'U4-clearance.kicad_pcb'));candidate=Oracle(after,rules);meta=json.loads((root/'U4-clearance.kicad_pcb.json').read_text());assert meta['preserved'] and not meta['lost_entries']
for p in meta['reservations']:
 assert not all(original.clear(p['net'],k.F_Cu,a,z,p['width']) for a,z in zip(p['path'],p['path'][1:])), 'fixture no longer obstructed'
 assert all(candidate.clear(p['net'],k.F_Cu,a,z,p['width']) for a,z in zip(p['path'],p['path'][1:])), 'escape corridor regressed'
 assert candidate.via(p['net'],p['end'],rules['fab']['via_diameter_mm'],rules['fab']['via_drill_mm']), 'via landing regressed'
 candidate.reserve_via(p['net'],p['end'],rules['fab']['via_diameter_mm'],rules['fab']['via_drill_mm'])
 for a,z in zip(p['path'],p['path'][1:]):candidate.reserve_track(p['net'],k.F_Cu,a,z,p['width'])
for file in ['board-fault-v2.drc.json','U4-clearance.drc.json']:
 d=json.loads((root/file).read_text());assert not d['violations'];assert len(d['unconnected_items'])==93
print('PASS saved native fixtures: new shared junction, >20% branch reduction, simultaneous SCL/SDA escape corridors and legal via sites, native0/93')

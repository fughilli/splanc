"""Copy fixed-placement native inputs for JITX. Never changes source boards.

Run with KiCad's bundled Python. Output remains unqualified until an import/export
roundtrip preserves geometry, nets, source rules and native connectivity.
"""
import hashlib
import json
from pathlib import Path
import shutil
import pcbnew

ROOT = Path(__file__).resolve().parents[4]
OUT = ROOT / 'output/jitx117'
BASE = ROOT / 'output/fresh-pnr-20260919/full116-20260924/seed'
POGO = ROOT / 'output/fresh-pnr-20260919/pogo114-20260924/preflight'


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def inventory(path):
    board = pcbnew.LoadBoard(str(path))
    layers = [i for i in range(pcbnew.PCB_LAYER_ID_COUNT) if board.IsLayerEnabled(i)]
    copper = [i for i in layers if pcbnew.IsCopperLayer(i)]
    footprints = []
    for fp in board.GetFootprints():
        pads = []
        for pad in fp.Pads():
            pos = pad.GetPosition(); size = pad.GetSize(); drill = pad.GetDrillSize()
            pads.append(dict(number=pad.GetNumber(), net=pad.GetNetname(),
                x_mm=pcbnew.ToMM(pos.x), y_mm=pcbnew.ToMM(pos.y),
                size_mm=[pcbnew.ToMM(size.x), pcbnew.ToMM(size.y)],
                drill_mm=[pcbnew.ToMM(drill.x), pcbnew.ToMM(drill.y)],
                shape=int(pad.GetShape()),
                copper_layers=[board.GetLayerName(i) for i in copper if pad.IsOnLayer(i)]))
        pos=fp.GetPosition()
        footprints.append(dict(ref=fp.GetReference(), x_mm=pcbnew.ToMM(pos.x),
            y_mm=pcbnew.ToMM(pos.y), angle_deg=fp.GetOrientationDegrees(),
            side=board.GetLayerName(fp.GetLayer()), pads=sorted(pads,key=lambda p:(p['number'],p['x_mm'],p['y_mm']))))
    tracks=list(board.GetTracks())
    return dict(kicad_version=pcbnew.Version(),
        enabled_layers=[board.GetLayerName(i) for i in layers],
        copper_layers=[board.GetLayerName(i) for i in copper],
        footprint_count=len(footprints), pad_count=sum(len(fp['pads']) for fp in footprints),
        net_count=len(board.GetNetsByName()),
        track_count=sum(not isinstance(t,pcbnew.PCB_VIA) for t in tracks),
        via_count=sum(isinstance(t,pcbnew.PCB_VIA) for t in tracks),
        zone_count=len(board.Zones()), rule_area_count=sum(z.GetIsRuleArea() for z in board.Zones()),
        footprints=sorted(footprints,key=lambda f:f['ref']))


def main():
    OUT.mkdir(parents=True,exist_ok=True)
    cases = [('original',BASE/'source.kicad_pcb',BASE/'source.kicad_pro',85,0),
             ('under-radio',POGO/'board.kicad_pcb',POGO/'board.kicad_pro',96,6)]
    manifest=dict(scope='fixed-placement incremental routing comparison, not fresh placement',
        source_qualification='baseline has 153 subwidth flags, one unqualified pair, incomplete native stackup; retain source electrical sidecar',
        protected_best='fresh28 48 opens/0 violations, untouched',
        native_import_validated=False, benchmark_executed=False, cases=[])
    for name,pcb,pro,opens,warnings in cases:
        dest=OUT/'inputs'/name;dest.mkdir(parents=True,exist_ok=True)
        files=[]
        for source,filename in ((pcb,'board.kicad_pcb'),(pro,'board.kicad_pro'),
                                (BASE/'rules.json','source-rules.json'),(BASE/'placed.json','original-placed.json')):
            target=dest/filename
            if target.exists() and sha(target)!=sha(source):
                raise RuntimeError('Refusing overwrite of different file: '+str(target))
            shutil.copy2(source,target)
            assert sha(source)==sha(target)
            files.append(dict(source=str(source.relative_to(ROOT)),file=str(target.relative_to(OUT)),sha256=sha(target)))
        inv=inventory(dest/'board.kicad_pcb')
        (dest/'native-inventory.json').write_text(json.dumps(inv,indent=2)+'\n')
        manifest['cases'].append(dict(name=name,files=files,baseline_native_opens=opens,
            baseline_dangling_warnings=warnings,
            notes='Historical preflight prior to final routing; not rejected 57-open output' if name=='under-radio' else 'Exact frozen full116 seed',
            summary={k:v for k,v in inv.items() if k!='footprints'}))
    (OUT/'input-manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
    print(json.dumps({c['name']:c['summary'] for c in manifest['cases']},indent=2))

if __name__=='__main__':
    main()

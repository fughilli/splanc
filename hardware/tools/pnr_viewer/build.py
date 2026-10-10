#!/usr/bin/env python3
"""Build a portable, offline PnR viewer from native checkpoints and saved DRC."""
import argparse, base64, hashlib, html, json, math, subprocess, tempfile
from pathlib import Path


def added_segments(current, previous, tolerance=1e-5):
    """Subtract collinear same-net/layer/width coverage, independent of splitting/direction."""
    groups = {}
    for p in previous:
        groups.setdefault((p['net'], p['layer'], p['width']), []).append(p)
    out = []
    for t in current:
        a, b = t['start'], t['end']
        dx, dy = b[0]-a[0], b[1]-a[1]
        length = math.hypot(dx, dy)
        if length < tolerance:
            continue
        ux, uy = dx/length, dy/length
        intervals = [(0, length)]
        for p in groups.get((t['net'], t['layer'], t['width']), []):
            points = [(q[0]-a[0], q[1]-a[1]) for q in (p['start'],p['end'])]
            if any(abs(x*uy-y*ux)>tolerance for x,y in points):
                continue
            lo, hi = sorted(x*ux+y*uy for x,y in points)
            next_intervals=[]
            for s,e in intervals:
                if hi <= s or lo >= e:
                    next_intervals.append((s,e))
                else:
                    if lo-s>tolerance: next_intervals.append((s,lo))
                    if e-hi>tolerance: next_intervals.append((hi,e))
            intervals=next_intervals
        for s,e in intervals:
            out.append(dict(t, start=[a[0]+s*ux,a[1]+s*uy],end=[a[0]+e*ux,a[1]+e*uy]))
    return out

NATIVE = '''import pcbnew,json,sys
b=pcbnew.LoadBoard(sys.argv[1])
def xy(p): return [p.x/1e6,p.y/1e6]
tracks=[]
for t in b.GetTracks():
 if t.GetClass()=='PCB_VIA': continue
 if t.GetClass()!='PCB_TRACK': raise RuntimeError('Arc diff requires tessellation')
 tracks.append(dict(net=t.GetNetname(),layer=pcbnew.BOARD.GetStandardLayerName(t.GetLayer()),width=t.GetWidth()/1e6,start=xy(t.GetStart()),end=xy(t.GetEnd())))
parts=[dict(ref=f.GetReference(),xy=xy(f.GetPosition()),pads=[dict(number=p.GetNumber(),xy=xy(p.GetPosition()),layers=[pcbnew.BOARD.GetStandardLayerName(n) for n in p.GetLayerSet().Seq()]) for p in f.Pads()]) for f in b.GetFootprints()]
r=b.GetBoardEdgesBoundingBox()
contour=pcbnew.SHAPE_POLY_SET()
frame=contour.BBox() if b.GetBoardPolygonOutlines(contour,False) and contour.OutlineCount() else r
json.dump(dict(engine_origin=[frame.GetLeft()/1e6,frame.GetBottom()/1e6],tracks=tracks,parts=parts,bounds=[r.GetX()/1e6,r.GetY()/1e6,r.GetRight()/1e6,r.GetBottom()/1e6],layers=[pcbnew.BOARD.GetStandardLayerName(n) for n in b.GetEnabledLayers().Seq()]),open(sys.argv[2],'w'))
'''

def main():
    ap=argparse.ArgumentParser(description=__doc__)
    ap.add_argument('rounds',type=Path)
    ap.add_argument('--output',type=Path,required=True)
    ap.add_argument('--title',default='PnR experiment')
    ap.add_argument('--allow-incomplete-search',action='store_true',help='Internal debugging only; do not present as converged')
    ap.add_argument('--python',default='/Applications/KiCad/KiCad.app/Contents/Frameworks/Python.framework/Versions/3.9/bin/python3')
    ap.add_argument('--cli',default='/Applications/KiCad/KiCad.app/Contents/MacOS/kicad-cli')
    args=ap.parse_args()
    termination_path=args.rounds.parent/'termination.json'
    termination=json.loads(termination_path.read_text()) if termination_path.exists() else {}
    if not termination.get('plateau_observed') and not args.allow_incomplete_search:
        ap.error('No observed plateau: run the PnR loop to plateau before presenting a viewer. Internal debug override: --allow-incomplete-search')
    rounds=[]
    def frame(directory,temp,previous=()):
        board=directory/'diagnostic.kicad_pcb'
        sha=hashlib.sha256(board.read_bytes()).hexdigest()
        subprocess.run([args.python,'-c',NATIVE,str(board),str(temp/'meta.json')],check=True,capture_output=True)
        data=json.loads((temp/'meta.json').read_text());drc=json.loads((directory/'diagnostic.drc.json').read_text())
        data.update(name=directory.name,sha256=sha,source=str(board.resolve()),opens=len(drc['unconnected_items']),violations=len(drc['violations']),airwires=[dict(points=[[i['pos']['x'],i['pos']['y']] for i in u['items']],description=u['description']) for u in drc['unconnected_items']])
        data['added']=added_segments(data['tracks'],previous);data['images']={}
        for layer in data['layers']:
            svg=temp/'layer.svg'
            subprocess.run([args.cli,'pcb','export','svg',str(board),'--layers',layer,'--exclude-drawing-sheet','--mode-single','--output',str(svg)],check=True,capture_output=True)
            raw=svg.read_text()
            import re
            vb=re.search(r'viewBox="([^"]+)"',raw).group(1)
            data['images'][layer]=dict(viewBox=list(map(float,vb.split())),url='data:image/svg+xml;base64,'+base64.b64encode(raw.encode()).decode())
        assert hashlib.sha256(board.read_bytes()).hexdigest()==sha
        return data
    with tempfile.TemporaryDirectory() as temp:
        temp=Path(temp)
        for directory in sorted(args.rounds.glob('round-*')):
            if not (directory/'diagnostic.kicad_pcb').exists():continue
            result=json.loads((directory/'result.json').read_text())
            if not args.allow_incomplete_search and not result.get('all_phases_completed'):
                ap.error('Signal-only rounds cannot establish a full-electrical plateau')
            variants=[]
            folders=sorted((directory/'alternatives').glob('candidate-*')) or [directory]
            for candidate in folders:
                frames=[];previous=[]
                phase_dirs=sorted((candidate/'phases').glob('*')) or [candidate]
                for phase in phase_dirs:
                    if not (phase/'diagnostic.kicad_pcb').exists():continue
                    f=frame(phase,temp,previous);previous=f['tracks'];frames.append(f)
                if frames:variants.append(dict(name=candidate.name,phases=frames))
            selected=result.get('selected_alternative',0)
            data=dict(variants[selected]['phases'][-1]);data.update(name=directory.name,search=result,variants=variants,selected_alternative=selected)
            for key,file in [('decision','placement-decision.json'),('feedback','feedback.json')]:
                data[key]=json.loads((directory/file).read_text()) if (directory/file).exists() else {}
            rounds.append(data)
            print(directory.name,len(variants),'alternatives',sum(len(v['phases']) for v in variants),'phases',flush=True)
    assert rounds,'No checkpoints found'
    template=Path(__file__).with_name('viewer.html').read_text()
    args.output.parent.mkdir(parents=True,exist_ok=True)
    args.output.write_text(template.replace('__EXPERIMENT__',html.escape(args.title)).replace('/*__SEARCH__*/',json.dumps(termination).replace('</','<\\/')).replace('/*__DATA__*/',json.dumps(rounds).replace('</','<\\/')))
    print(args.output.resolve())

if __name__=='__main__':main()

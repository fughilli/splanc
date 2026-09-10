#!/usr/bin/env python3
"""Verify actual mating PCB geometry, exposure, pad numbering and continuity.

Run with KiCad Python, after placement and before export. This test deliberately
compares the two independent, physically flipped PCB representations.
"""
import argparse
import json
import math
from pathlib import Path
import pcbnew

HARDWARE=Path(__file__).resolve().parents[1]

def check(dut_path, fixture_path, placement_path):
    spec=json.loads((HARDWARE/'interfaces/mini-eol-v1.json').read_text())
    dut=pcbnew.LoadBoard(str(dut_path));fixture=pcbnew.LoadBoard(str(fixture_path))
    assert dut is not None and fixture is not None, 'Both boards must load'
    dfs={f.GetReference():f for f in dut.GetFootprints()}
    ffs={f.GetReference():f for f in fixture.GetFootprints()}
    df=next(f for f in dfs.values() if f.GetFPIDAsString()=='Splanc_Mini_EOL_V1:MINI-EOL-V1')
    ff=ffs['J1'];wire=ffs['J2']
    records=[]
    def require(name,condition):records.append({'check':name,'passed':bool(condition)})
    def xy(item,datum):
        p=item.GetPosition();o=datum.GetPosition()
        return ((p.x-o.x)/1e6+4,4-(p.y-o.y)/1e6)
    require('DUT array is underside TP1; fixture pins face upward',df.GetReference()=='TP1' and df.IsFlipped() and not ff.IsFlipped())
    require('Bare copper excluded from assembly BOM and placement',
            df.GetAttributes() & pcbnew.FP_EXCLUDE_FROM_BOM and df.GetAttributes() & pcbnew.FP_EXCLUDE_FROM_POS_FILES)
    dps={p.GetNumber():p for p in df.Pads()};fps={p.GetNumber():p for p in ff.Pads()};wps={p.GetNumber():p for p in wire.Pads()}
    numbers={str(i) for i in range(1,21)}
    require('Exactly 20 uniquely numbered contacts on both sides and harness',
            all(set(ps)==numbers and len(list(fp.Pads()))==20 for ps,fp in [(dps,df),(fps,ff),(wps,wire)]))
    require('Array center agrees with physical specification', math.dist(xy(df,dfs['MH1']),spec['array_center_mm'])<.001)
    graph=json.loads(Path(placement_path).read_text())
    component=next(c for c in graph['components'] if c['address']=='board.eol')
    require('Routing graph records underside array',component['side']=='bottom')
    gpads={p['name']:p for p in component['pads']}
    theta=math.radians(component['rot']);ct,st=math.cos(theta),math.sin(theta)
    coordinate_rows=[]
    for i,want in enumerate(spec['mount_centers_mm'],1):
        require(f'Mating mount {i} coordinates',math.dist(xy(dfs[f'MH{i}'],dfs['MH1']),want)<.001 and math.dist(xy(ffs[f'H{i}'],ffs['H1']),want)<.001)
    # Exact outline endpoints, without line-width expansion of the bounding box.
    edges=[d for d in dut.GetDrawings() if d.GetLayer()==pcbnew.Edge_Cuts]
    raw=[v for d in edges for v in (d.GetStart(),d.GetEnd())]
    o=dfs['MH1'].GetPosition()
    points=[((v.x-o.x)/1e6+4,4-(v.y-o.y)/1e6) for v in raw]
    require('Mini outline is 70 by 55 mm at the shared origin',
            len(edges)==4 and {tuple(round(a,3) for a in p) for p in points}=={(0,0),(70,0),(70,55),(0,55)})
    for row in spec['pads']:
        n=str(row['number']);dp=dps[n];fp=fps[n];wp=wps[n]
        want=(spec['array_center_mm'][0]+row['x_mm'],spec['array_center_mm'][1]+row['y_mm'])
        a,z=xy(dp,dfs['MH1']),xy(fp,ffs['H1'])
        gx,gy=gpads[n]['offset']
        router_xy=(component['pos'][0]+gx*ct-gy*st,component['pos'][1]+gx*st+gy*ct)
        require(f'Contact {n}: routing graph pad is not accidentally mirrored',math.dist(router_xy,a)<.001)
        require(f'Contact {n}: DUT/fixture coordinate match',math.dist(a,want)<.001 and math.dist(z,want)<.001)
        layers=dp.GetLayerSet()
        require(f'Contact {n}: bare 1.6 mm circular bottom copper, no drill or paste',
                dp.GetAttribute()==pcbnew.PAD_ATTRIB_SMD and dp.GetShape()==pcbnew.PAD_SHAPE_CIRCLE and
                dp.GetSize().x==dp.GetSize().y==1600000 and dp.GetDrillSize().x==0 and
                layers.Contains(pcbnew.B_Cu) and layers.Contains(pcbnew.B_Mask) and
                not any(layers.Contains(l) for l in (pcbnew.F_Cu,pcbnew.F_Mask,pcbnew.F_Paste,pcbnew.B_Paste)) and
                abs(dp.GetLocalSolderMaskMargin()-50000)<1)
        require(f'Contact {n}: correct carrier net and harness continuation',
                fp.GetNetname()==row['signal'] and wp.GetNetname()==row['signal'] and fp.GetNetCode()!=0)
        require(f'Contact {n}: carrier 0.65 mm PTH solder tail',fp.GetAttribute()==pcbnew.PAD_ATTRIB_PTH and fp.GetDrillSize().x==650000)
        coordinate_rows.append({'pad':int(n),'signal':row['signal'],'dut_xy_mm':a,'fixture_xy_mm':z})
    return {'interface':spec['id'],'passed':all(r['passed'] for r in records),'checks':records,'contact_coordinates':coordinate_rows}

def main():
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('dut',type=Path);p.add_argument('fixture',type=Path);p.add_argument('--output',type=Path,required=True);p.add_argument('--placement',type=Path,required=True);args=p.parse_args()
    report=check(args.dut,args.fixture,args.placement);args.output.write_text(json.dumps(report,indent=2)+'\n')
    print(f"{sum(r['passed'] for r in report['checks'])}/{len(report['checks'])} interface checks passed")
    for r in report['checks']:
        if not r['passed']:print('FAIL:',r['check'])
    raise SystemExit(0 if report['passed'] else 1)

if __name__=='__main__':main()

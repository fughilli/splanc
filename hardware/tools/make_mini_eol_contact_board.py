#!/usr/bin/env python3
"""Create an unrouted Mini EoL pogo carrier and a fixture BOM from its interface.

Run with KiCad Python. The legacy active tester is deliberately not connected:
its VBUS injection and load circuitry are incompatible with MINI-EOL-V1.
"""
import argparse
import json
from pathlib import Path
import pcbnew

HARDWARE = Path(__file__).resolve().parents[1]

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    spec = json.loads((HARDWARE / 'interfaces/mini-eol-v1.json').read_text())
    b = pcbnew.BOARD()
    b.SetCopperLayerCount(2)
    # Shared datum at page (35,90), Y up, same projection as DUT top.
    def point(x,y): return pcbnew.VECTOR2I(round((35+x)*1e6),round((90-y)*1e6))
    keep = []  # Keep SWIG owners alive through SaveBoard.
    copper_mask = pcbnew.LSET.AllCuMask(2)
    copper_mask.AddLayer(pcbnew.F_Mask)
    copper_mask.AddLayer(pcbnew.B_Mask)
    keep.append(copper_mask)
    def segment(a,z,layer):
        s=pcbnew.PCB_SHAPE(b);s.SetShape(pcbnew.SHAPE_T_SEGMENT)
        s.SetStart(point(*a));s.SetEnd(point(*z));s.SetLayer(layer);s.SetWidth(50000)
        b.Add(s);keep.append(s)
    def text(value,x,y,size=.8):
        t=pcbnew.PCB_TEXT(b);t.SetText(value);t.SetPosition(point(x,y));t.SetLayer(pcbnew.F_SilkS)
        t.SetTextSize(pcbnew.VECTOR2I(int(size*1e6),int(size*1e6)));t.SetTextThickness(120000)
        b.Add(t);keep.append(t)
    outline=[(-4,-4),(86,-4),(86,59),(-4,59)]
    for a,z in zip(outline,outline[1:]+outline[:1]):segment(a,z,pcbnew.Edge_Cuts)
    w,h=spec['board_mm'];dut=[(0,0),(w,0),(w,h),(0,h)]
    for a,z in zip(dut,dut[1:]+dut[:1]):segment(a,z,pcbnew.Dwgs_User)
    net_by_name={}
    for p in spec['pads']:
        name=p['signal']
        if name not in net_by_name:
            net=pcbnew.NETINFO_ITEM(b,name);b.Add(net);keep.append(net);net_by_name[name]=net
    path=HARDWARE/'splanc_eol_tester/elec/footprints/Splanc_Mini_EOL.pretty'
    fp=pcbnew.FootprintLoad(str(path),'MINI-EOL-V1-POGOS');keep.append(fp)
    fp.SetFPID(pcbnew.LIB_ID('Splanc_Mini_EOL','MINI-EOL-V1-POGOS'))
    fp.SetReference('J1');fp.SetPosition(point(*spec['array_center_mm']))
    fp.Reference().SetLayer(pcbnew.F_Fab);fp.Value().SetLayer(pcbnew.F_Fab)
    b.Add(fp)
    for p in fp.Pads():p.SetNet(net_by_name[spec['pads'][int(p.GetNumber())-1]['signal']])
    # Individually labelled wire terminations, not a legacy 2x10 mating header.
    # They connect 1:1 to the test controller harness; loads never use this carrier.
    wire=pcbnew.FOOTPRINT(b);keep.append(wire);wire.SetReference('J2');wire.SetValue('MINI-EOL-V1 wire harness')
    wire.SetAttributes(pcbnew.FP_EXCLUDE_FROM_BOM|pcbnew.FP_EXCLUDE_FROM_POS_FILES)
    wire.SetPosition(point(78,28));b.Add(wire)
    for p in spec['pads']:
        index=p['number']-1;x=74 if index<10 else 82;y=51-5*(index%10)
        pad=pcbnew.PAD(wire);keep.append(pad);pad.SetNumber(str(p['number']))
        pad.SetAttribute(pcbnew.PAD_ATTRIB_PTH);pad.SetShape(pcbnew.PAD_SHAPE_CIRCLE)
        pad.SetSize(pcbnew.VECTOR2I(1800000,1800000));pad.SetDrillSize(pcbnew.VECTOR2I(1000000,1000000))
        pad.SetLayerSet(copper_mask)
        pad.SetPosition(point(x,y));pad.SetNet(net_by_name[p['signal']]);wire.Add(pad)
        text(str(p['number']),x-2,y)
    for i,xy in enumerate(spec['mount_centers_mm'],1):
        hole=pcbnew.FOOTPRINT(b);keep.append(hole);hole.SetReference(f'H{i}');hole.SetValue('Fixture datum / M2.5')
        hole.SetAttributes(pcbnew.FP_EXCLUDE_FROM_BOM|pcbnew.FP_EXCLUDE_FROM_POS_FILES);hole.SetPosition(point(*xy));b.Add(hole)
        pad=pcbnew.PAD(hole);keep.append(pad);pad.SetAttribute(pcbnew.PAD_ATTRIB_NPTH)
        pad.SetSize(pcbnew.VECTOR2I(2700000,2700000));pad.SetDrillSize(pcbnew.VECTOR2I(2700000,2700000))
        pad.SetLayerSet(copper_mask);pad.SetPosition(point(*xy));hole.Add(pad)
        hole.Reference().SetVisible(False);hole.Value().SetVisible(False)
        z=pcbnew.ZONE(b);keep.append(z);z.SetIsRuleArea(True);z.SetLayerSet(pcbnew.LSET.AllCuMask(2));z.SetZoneName(f'M2.5 mount {i}')
        z.SetDoNotAllowCopperPour(True);z.SetDoNotAllowTracks(True);z.SetDoNotAllowVias(True);z.SetDoNotAllowPads(False)
        poly=z.Outline();poly.NewOutline()
        import math
        for k in range(48):
            a=2*math.pi*k/48;v=point(xy[0]+3.5*math.cos(a),xy[1]+3.5*math.sin(a));poly.Append(v.x,v.y)
        b.Add(z)
    text('MINI-EOL-V1 / POGO CARRIER',35,56.8,1.0)
    text('USB-C PD + LED loads use separate cables',34,-1.7,.85)
    text('ENGINEERING / UNROUTED',24,25,1.0)
    b.BuildConnectivity();args.output.parent.mkdir(parents=True,exist_ok=True)
    pcbnew.SaveBoard(str(args.output),b)
    args.output.with_suffix('.kicad_pro').write_text(json.dumps({'meta':{'version':1,'filename':args.output.with_suffix('.kicad_pro').name}},indent=2)+'\n')
    data={'interface':spec['id'],'status':'unrouted engineering carrier; active tester adaptation pending',
          'items':[{'reference':'J1 contacts 1–20','quantity':20,'manufacturer':'Mill-Max',
                    'mpn':'0906-0-15-20-76-14-11-0','qualification':'candidate; verify tip diameter, assembly height and actual fixture compression before release',
                    'source':'https://www.farnell.com/datasheets/3820075.pdf'}],
          'not_included':['wire harness','fixture nest and mechanical stops','PD source and USB-C cable','LED load cables','active tester controller']}
    args.output.with_suffix('.bom.json').write_text(json.dumps(data,indent=2)+'\n')
    print(args.output)

if __name__ == '__main__':main()

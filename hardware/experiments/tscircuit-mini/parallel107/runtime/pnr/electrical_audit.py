"""Electrical audit that distinguishes connected geometry from qualification.

Reports existing sub-width copper rather than assuming old routing carries its
net's full current. Pair lengths use actual endpoint graphs; mere nonzero copper
is not routed. Stackup absence/inconsistency prevents impedance qualification.
"""
from collections import Counter
import math,re
from pnr.electrical import net_policy
from pnr.route.detail.coupled import path_metrics


def audit_board(board,rules,board_text=''):
    import pcbnew as k
    xy=lambda p:(p.x/1e6,p.y/1e6)
    stack=board_text.split('(stackup',1)[-1].split('(copper_finish',1)[0] if '(stackup' in board_text else ''
    defined=set(re.findall(r'\(layer\s+"([^"]+\.Cu)"',stack))
    enabled={board.GetLayerName(la) for la in board.GetEnabledLayers().CuStack()}
    undersized=[];unknown=set()
    for t in board.GetTracks():
        if t.GetClass()!='PCB_TRACK':continue
        policy=net_policy(t.GetNetname(),rules)
        if policy['mode']!='power':continue
        if not policy['current_known']:unknown.add(t.GetNetname())
        required=policy['outer_width_mm'] if t.GetLayer() in (k.F_Cu,k.B_Cu) else policy['inner_width_mm']
        if t.GetWidth()/1e6+1e-6<required:undersized.append(dict(uuid=t.m_Uuid.AsString(),net=t.GetNetname(),width_mm=t.GetWidth()/1e6,trunk_required_mm=required,layer=board.GetLayerName(t.GetLayer()),finding='requires terminal/branch or short-neck justification'))
    pads={f.GetReference()+'.'+p.GetNumber():p for f in board.GetFootprints() for p in f.Pads()}
    pair_reports=[]
    for pair in rules.get('diff_pairs',[]):
        chain=pair.get('terminal_chain',[]);report=dict(name=pair['name'],impedance_qualified=False,segments=[])
        if len(chain)<2:report['status']='missing_source_endpoints';pair_reports.append(report);continue
        metrics={}
        for net,key in ((pair['p'],'p'),(pair['n'],'n')):
            tracks=[t for t in board.GetTracks() if t.GetNetname()==net]
            if any(t.GetClass() not in ('PCB_TRACK','PCB_VIA') for t in tracks):metrics[net]=dict(valid=False,reason='unsupported_arc');continue
            segments=[(t.GetLayer(),xy(t.GetStart()),xy(t.GetEnd())) for t in tracks if t.GetClass()=='PCB_TRACK']
            # Only actual used layers are relevant to vertical travel. Refuse
            # to invent missing inner-layer heights from nominal board thickness.
            via_nodes=[];heights={k.F_Cu:0,k.B_Cu:rules.get('electrical_fab',{}).get('board_thickness_mm',1.6)}
            missing=False
            for t in tracks:
                if t.GetClass()!='PCB_VIA':continue
                layers=sorted({s.GetLayer() for s in tracks if s.GetClass()=='PCB_TRACK' and t.IsOnLayer(s.GetLayer()) and t.GetEffectiveShape(s.GetLayer()).Collide(s.GetEffectiveShape(s.GetLayer()),0)})
                if any(la not in heights for la in layers):missing=True
                via_nodes.append((xy(t.GetPosition()),layers))
            if missing:metrics[net]=dict(valid=False,reason='missing_actual_inner_layer_heights');continue
            source,target=pads[chain[0][key]],pads[chain[-1][key]]
            metrics[net]=path_metrics(segments,via_nodes,(xy(source.GetPosition()),source.GetLayer()),(xy(target.GetPosition()),target.GetLayer()),layer_heights=heights)
        report['endpoint_metrics']=metrics
        valid=all(m.get('valid') for m in metrics.values())
        report['skew_mm']=abs(metrics[pair['p']]['length_mm']-metrics[pair['n']]['length_mm']) if valid else None
        report['length_match_qualified']=valid and report['skew_mm']<=pair['skew_mm']
        report['status']='geometry_requires_coupling_reference_audit' if report['length_match_qualified'] else 'unqualified'
        pair_reports.append(report)
    from pnr.native_electrical import reference_failures
    reference=reference_failures(board,rules) if rules.get('routed_pair_references') else None
    return dict(reference_failures=reference,stackup=dict(enabled_layers=sorted(enabled),defined_copper_layers=sorted(defined),consistent=enabled==defined),power_current_unknown=sorted(unknown),subwidth_track_count=len(undersized),subwidth_tracks=undersized,pairs=pair_reports,qualified=False)


def main():
    import argparse,json
    from pathlib import Path
    import pcbnew as k
    ap=argparse.ArgumentParser(description=__doc__);ap.add_argument('board',type=Path);ap.add_argument('--rules',type=Path,required=True);ap.add_argument('--out',type=Path,required=True)
    a=ap.parse_args();b=k.LoadBoard(str(a.board));b.BuildConnectivity()
    result=audit_board(b,json.loads(a.rules.read_text()),a.board.read_text());a.out.write_text(json.dumps(result,indent=2)+'\n')

if __name__=='__main__':main()

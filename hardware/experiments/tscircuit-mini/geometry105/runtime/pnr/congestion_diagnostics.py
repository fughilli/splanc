"""Auditable placement diagnostics; all maps are heuristics, not DRC capacity.

SVG rendering is dependency-free. Coordinates are engine mm, top view with Y up.
Use identical physical scales across cycles, never normalize each image by its peak.
"""
import html
import json
import math
from pathlib import Path


def snapshot(graph, rules, *, label, unresolved=(), metadata=None, cell=None,
             pitch=2.5, inflation=None, applied_inflation=None):
    from pnr.place.channels import ChannelModel
    from pnr.place.geometry import pad_rects
    model = ChannelModel(graph, rules)
    report = model.report(graph)
    parts = []
    for c in graph.components:
        rects = [r for _, _, r in pad_rects(c)]
        bounds = ([min(r.left for r in rects), min(r.bottom for r in rects),
                   max(r.right for r in rects), max(r.top for r in rects)]
                  if rects else [c.pos[0]-.3,c.pos[1]-.3,c.pos[0]+.3,c.pos[1]+.3])
        parts.append(dict(ref=c.ref, pos=list(c.pos), bounds=bounds, side=c.side,
                          locked=c.locked))
    bins = {}
    wanted = set(unresolved)
    for c in graph.components:
        for name, net, r in pad_rects(c):
            if net in wanted:
                key = (math.floor(r.cx/pitch), math.floor(r.cy/pitch))
                bins[key] = bins.get(key, 0)+1
    return dict(schema='pnr-congestion-v1', label=label,
                width=graph.outline.width, height=graph.outline.height,
                components=parts, channels=report, metadata=metadata or {},
                endpoint_bins=[[*k,v] for k,v in sorted(bins.items())],
                endpoint_note='All pads on unresolved nets; not failed endpoints or measured routing capacity.',
                feedback_cell=cell.tolist() if hasattr(cell,'tolist') else cell,
                pitch_mm=pitch, requested_inflation=inflation,
                applied_inflation=applied_inflation)


def native_endpoints(data, inventory):
    """Deduplicate native unconnected terminal UUIDs and transform to engine mm."""
    parts={c['ref']:c for c in inventory['graph']['components']}
    ref=next(iter(inventory['footprint_poses']))
    native=inventory['footprint_poses'][ref];engine=parts[ref]['pos']
    offset_x=native[0]-engine[0];offset_y=native[1]+engine[1]
    sites={}
    for target in inventory['targets']:
        for end in ('source','target'):
            x,y=target[end+'_xy']
            sites[target.get(end+'_uuid',target[end])]=(x-offset_x,offset_y-y)
    pitch=data['pitch_mm'];bins={}
    for x,y in sites.values():
        key=(math.floor(x/pitch),math.floor(y/pitch));bins[key]=bins.get(key,0)+1
    data['endpoint_bins']=[[*k,v] for k,v in sorted(bins.items())]
    data['endpoint_kind']='native'
    data['endpoint_note']='Unique native unresolved terminal sites; not measured track capacity.'
    return data


def svg(data, feedback_max=10.):
    esc=lambda s:html.escape(str(s))
    w,h=data['width'],data['height'];scale=5.;pw=w*scale;ph=h*scale
    exact=data.get('feedback_cell') is not None
    out=[f'<svg xmlns="http://www.w3.org/2000/svg" width="{2*pw+100}" height="{ph+190}" viewBox="0 0 {2*pw+100} {ph+190}">',
         '<rect width="100%" height="100%" fill="white"/>',
         '<style>text{font-family:Arial,sans-serif;fill:#14283c}.part{fill:none;stroke:#64748b;stroke-width:.4}</style>',
         f'<text x="20" y="25" font-size="17">{esc(data["label"])}</text>',
         '<text x="20" y="46" font-size="11">Top view; engine mm; identical color scales for every cycle. These estimates do not prove routability.</text>']
    parts={c['ref']:c for c in data['components']}
    for panel in range(2):
        ox=30+panel*(pw+40);oy=80
        title='Surface escape shortage (0 to 5+ mm)' if panel==0 else (f'Recorded router feedback (0 to {feedback_max:g}+ units/cell)' if exact else ('Native unresolved terminals (0 to 10+ sites/cell)' if data.get('endpoint_kind')=='native' else 'Unresolved-net pad density (0 to 10+ pads/cell)'))
        out.append(f'<text x="{ox}" y="68" font-size="12">{title}</text>')
        def rect(x0,y0,x1,y1,attrs):
            return f'<rect x="{ox+x0*scale:.2f}" y="{oy+(h-y1)*scale:.2f}" width="{max(.06,x1-x0)*scale:.2f}" height="{max(.06,y1-y0)*scale:.2f}" {attrs}/>'
        out.append(rect(0,0,w,h,'fill="#f8fafc" stroke="#334155"'))
        if panel==0:
            # Paint only the facing overlap corridor, not a component-centre blob.
            for ch in sorted(data['channels']['channels'],key=lambda c:c['shortage_mm']):
                a,b=[parts[r]['bounds'] for r in ch['refs']];direction=ch['direction']
                if direction in ('east','west'):
                    x0,x1=(a[2],b[0]) if direction=='east' else (b[2],a[0]);y0,y1=max(a[1],b[1]),min(a[3],b[3])
                else:
                    y0,y1=(a[3],b[1]) if direction=='north' else (b[3],a[1]);x0,x1=max(a[0],b[0]),min(a[2],b[2])
                alpha=.15+.8*min(1,ch['shortage_mm']/5)
                out.append(rect(x0,y0,x1,y1,f'fill="#dc2626" fill-opacity="{alpha:.3f}"')[:-2]+f'><title>{esc(ch)}</title></rect>')
        else:
            values=([(i,j,v) for i,col in enumerate(data['feedback_cell']) for j,v in enumerate(col) if v>0]
                    if exact else data['endpoint_bins'])
            pitch=data['pitch_mm']
            for i,j,v in values:
                alpha=.15+.8*min(1,v/feedback_max)
                out.append(rect(i*pitch,j*pitch,min(w,(i+1)*pitch),min(h,(j+1)*pitch),f'fill="#ea580c" fill-opacity="{alpha:.3f}"')[:-2]+f'><title>{v}</title></rect>')
        for c in parts.values():
            out.append(rect(*c['bounds'],'class="part"'))
            x,y=c['pos'];out.append(f'<text x="{ox+x*scale:.2f}" y="{oy+(h-y)*scale:.2f}" font-size="4.8" text-anchor="middle">{esc(c["ref"])}</text>')
        for tick in range(0,int(w)+1,10):out.append(f'<text x="{ox+tick*scale}" y="{oy+ph+13}" font-size="8">{tick}</text>')
        for tick in range(0,int(h)+1,10):out.append(f'<text x="{ox-20}" y="{oy+(h-tick)*scale}" font-size="8">{tick}</text>')
        for i in range(6):
            out.append(f'<rect x="{ox+i*22}" y="{oy+ph+23}" width="22" height="9" fill="{ "#dc2626" if panel==0 else "#ea580c"}" fill-opacity="{.15+.8*i/5}"/>')
            out.append(f'<text x="{ox+i*22}" y="{oy+ph+43}" font-size="8">{i if panel==0 else round(feedback_max*i/5,1)}{"+" if i==5 else ""}</text>')
    score=data['channels']['shortage_score'];meta=data.get('metadata',{})
    out.append(f'<text x="20" y="{ph+139}" font-size="11">Channel shortage score: {score:.2f} mm² | {esc(meta.get("summary",""))}</text>')
    out.append(f'<text x="20" y="{ph+160}" font-size="10">{"Recorded feedback may exclude deferred power/USB nets." if exact else ("Native unresolved terminals include power/USB. Channel model excludes routed obstacles and layer capacity." if data.get("endpoint_kind")=="native" else "Historical proxy: exact failure-site cells were not saved. Includes deferred nets; no invented past feedback.")}</text>')
    out.append('</svg>')
    return '\n'.join(out)


def write_snapshot(folder, data):
    folder=Path(folder);folder.mkdir(parents=True,exist_ok=True)
    (folder/'congestion.json').write_text(json.dumps(data,indent=2)+'\n')
    (folder/'congestion.svg').write_text(svg(data))

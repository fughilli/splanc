"""Collect cycle diagnostics and draw the deformation field and actual part moves."""
import argparse,json,html
from pathlib import Path

def moves_for(event):
 event=event or {}
 if 'moves' in event:
  moves=event['moves']
  if isinstance(moves,list):return {m['ref']:dict(before=m['original'],after=m['position']) for m in moves}
  return moves
 if 'ref' in event:return {event['ref']:dict(before=event['original'],after=event['position'])}
 return {}

def mesh_svg(graph,event,title):
 w,h=graph['outline']['width'],graph['outline']['height'];s=8;ox=35;oy=70
 def xy(x,y):return (ox+x*s,oy+(h-y)*s)
 def line(a,b,color,width):
  x,y=xy(*a);u,v=xy(*b);return f'<line x1="{x}" y1="{y}" x2="{u}" y2="{v}" stroke="{color}" stroke-width="{width}"/>'
 parts=graph['components'];out=[f'<svg xmlns="http://www.w3.org/2000/svg" width="{w*s+90}" height="{h*s+160}"><rect width="100%" height="100%" fill="white"/>',f'<text x="20" y="25" font-family="Arial" font-size="18">{html.escape(title)}</text>',f'<text x="20" y="47" font-family="Arial" font-size="11">Purple: centre movement. Blue lines: mesh when present. Dashed outline: previous size when present.</text>',f'<rect x="{ox}" y="{oy}" width="{w*s}" height="{h*s}" fill="#fafafa" stroke="#334155"/>']
 if event and 'mesh_nodes' in event:
  nodes=event['mesh_nodes'];nx,ny=event['mesh_shape']
  for i in range(nx):
   for j in range(ny):
    point=(i*w/(nx-1)+nodes[i][j][0],j*h/(ny-1)+nodes[i][j][1])
    if i+1<nx:out.append(line(point,((i+1)*w/(nx-1)+nodes[i+1][j][0],j*h/(ny-1)+nodes[i+1][j][1]),'#93c5fd',.6))
    if j+1<ny:out.append(line(point,(i*w/(nx-1)+nodes[i][j+1][0],(j+1)*h/(ny-1)+nodes[i][j+1][1]),'#93c5fd',.6))
 shift=(event or {}).get('origin_translation',[0,0])
 if event and 'old_outline' in event:
  ow,oh=event['old_outline'];x,y=xy(shift[0],shift[1]+oh)
  out.append(f'<rect x="{x}" y="{y}" width="{ow*s}" height="{oh*s}" fill="none" stroke="#64748b" stroke-dasharray="4 3"/>')
 for move in moves_for(event).values():
  before=[move['before'][k]+shift[k] for k in (0,1)]
  out.append(line(before,move['after'],'#9333ea',1.4));x,y=xy(*before);out.append(f'<circle cx="{x}" cy="{y}" r="1.6" fill="#9333ea"/>')
 fixed=set((event or {}).get('fixed_refs',[]))
 for c in parts:
  x,y=xy(*c['pos']);color='#111827' if c['ref'] in fixed else '#475569'
  if c['ref'] in fixed:out.append(f'<rect x="{x-2}" y="{y-2}" width="4" height="4" fill="{color}"/>')
  else:out.append(f'<circle cx="{x}" cy="{y}" r="1.5" fill="{color}"/>')
  out.append(f'<text x="{x+3}" y="{y-3}" font-family="Arial" font-size="6" fill="{color}">{html.escape(c["ref"])}</text>')
 if event and 'origin_translation' in event:
  out.append(f'<text x="20" y="{h*s+130}" font-family="Arial" font-size="11">Dashed: previous outline. Movement uses centred frames so west/south displacement remains visible.</text>')
 out.append(f'<text x="20" y="{h*s+110}" font-family="Arial" font-size="12">{len(moves_for(event))} component movement records; diagram shows placement, not routed copper.</text></svg>')
 return '\n'.join(out)

def export(root,out):
 import shutil
 out.mkdir(parents=True,exist_ok=True);records=[]
 for mode in sorted(p.name for p in root.iterdir() if p.is_dir() and list(p.glob('round-*/result.json'))):
  for folder in sorted((root/mode).glob('round-*')):
   if not (folder/'result.json').exists():continue
   result=json.loads((folder/'result.json').read_text());graph=json.loads((folder/'placed.json').read_text());target=out/f'{mode}-{folder.name}';target.mkdir(exist_ok=True)
   for name in ('congestion.json','congestion.svg'):shutil.copyfile(folder/name,target/name)
   title=f'{mode} {folder.name}';event=result.get('local_feedback_move')
   (target/'mesh.svg').write_text(mesh_svg(graph,event,title))
   records.append(dict(folder=target.name,label=title,missing=result['estimated_missing_connections'],moves=len(moves_for(event)),outline=[graph['outline']['width'],graph['outline']['height']]))
 # Use one absolute scale across the entire comparison, not per-cycle peaks.
 from pnr.congestion_diagnostics import svg
 maximum=max([10.]+[v for r in records for col in json.loads((out/r['folder']/'congestion.json').read_text()).get('feedback_cell',[]) for v in col])
 for r in records:
  folder=out/r['folder'];data=json.loads((folder/'congestion.json').read_text())
  (folder/'congestion.svg').write_text(svg(data,feedback_max=maximum))
 (out/'display-scale.json').write_text(json.dumps(dict(feedback_max=maximum,scope='identical across all cycles')))
 (out/'index.json').write_text(json.dumps(records,indent=2));print(json.dumps(records,indent=2))
if __name__=='__main__':
 p=argparse.ArgumentParser(description=__doc__);p.add_argument('comparison',type=Path);p.add_argument('--out',required=True,type=Path);a=p.parse_args();export(a.comparison,a.out)

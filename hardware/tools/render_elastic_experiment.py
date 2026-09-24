"""Render mesh experiment comparison; all figures rasterized for fast PDF viewing."""
import argparse,json,subprocess
from pathlib import Path
from reportlab.pdfgen import canvas
from PIL import Image,ImageDraw
p=argparse.ArgumentParser(description=__doc__);p.add_argument('directory',type=Path);a=p.parse_args();out=a.directory
records=json.loads((out/'index.json').read_text())
c=canvas.Canvas(str(out/'mesh-comparison.pending.pdf'),pagesize=(1000,720));c.setTitle('Splanc Mini - collective placement experiment')
c.setFont('Helvetica-Bold',23);c.drawString(36,674,'Collective placement: measured routing feedback')
c.setFont('Helvetica',12);c.drawString(36,647,'Diagnostic signal-router experiment. Missing grid connections are not native KiCad opens.')
c.drawString(36,625,'Best enclosure-compatible native board remains 48 opens / 0 violations until full validation.')
c.setFont('Helvetica-Bold',12)
for x,s in [(36,'Variant / cycle'),(320,'Missing signals'),(460,'Moved parts'),(600,'Channel score (mm2)'),(790,'Outline (mm)')]:c.drawString(x,590,s)
y=561
for r in records:
 d=json.loads((out/r['folder']/'congestion.json').read_text())
 score=d.get('channel_report',d.get('channels',{}))
 if isinstance(score,dict):score=score.get('shortage_score','?')
 else:score='?'
 c.setFont('Helvetica',12)
 for x,v in [(36,r['label']),(320,r['missing']),(460,r['moves']),(600,f'{score:.2f}' if isinstance(score,(float,int)) else str(score)),(790,' x '.join(f'{v:.2f}' for v in r.get('outline',[])))]:c.drawString(x,y,str(v))
 y-=23
c.setFont('Helvetica',11)
notes_path=out/'notes.json'
notes=json.loads(notes_path.read_text()) if notes_path.exists() else [
 'Experimental placement comparison; native DRC determines acceptance.',
 'Channel score is a facing-pad escape proxy, not measured routed-layer capacity.',
]
for line in notes:
 y-=24;c.drawString(36,y,line)
c.showPage()
for r in records:
 for kind in ('mesh','congestion'):
  folder=out/r['folder'];png=folder/f'{kind}.png'
  subprocess.run(['/opt/homebrew/bin/rsvg-convert','-w','1800','-o',str(png),str(folder/f'{kind}.svg')],check=True)
  c.setFont('Helvetica-Bold',16);c.drawString(30,690,f"{r['label']} - {kind}")
  c.drawImage(str(png),20,32,width=960,height=635,preserveAspectRatio=True,anchor='c')
  c.setFont('Helvetica',10);c.drawString(30,15,f"{r['missing']} estimated missing signals | {r['moves']} moved parts | experimental; not a finished PCB")
  c.showPage()
c.save()
(out/'mesh-comparison.pending.pdf').replace(out/'mesh-comparison.pdf')
print(out/'mesh-comparison.pdf')

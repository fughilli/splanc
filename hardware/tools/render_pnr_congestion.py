"""Package cycle SVGs as a raster PDF and contact sheets; use document Python."""
from pathlib import Path
import subprocess,json
from reportlab.pdfgen import canvas
from PIL import Image,ImageOps,ImageDraw
import argparse
ap=argparse.ArgumentParser(description=__doc__);ap.add_argument('directory');ap.add_argument('--rsvg-convert',default='/opt/homebrew/bin/rsvg-convert');args=ap.parse_args()
out=Path(args.directory);records=json.loads((out/'index.json').read_text());pdf=canvas.Canvas(str(out/'congestion-by-cycle.pdf'),pagesize=(960,600));pdf.setTitle('Splanc Mini - congestion by PnR cycle')
for r in records:
 p=out/r['folder'];subprocess.run([args.rsvg_convert,'-w','1600','-o',str(p/'congestion.png'),str(p/'congestion.svg')],check=True)
 pdf.drawImage(str(p/'congestion.png'),10,25,width=940,height=550,preserveAspectRatio=True,anchor='c');pdf.bookmarkPage(r['folder']);pdf.addOutlineEntry(r['label'],r['folder']);pdf.showPage()
pdf.save()
for kind,rs in [('source',records[:6]),('native',[r for r in records if r['folder'].endswith('after')])]:
 thumbs=[]
 for r in rs:
  im=Image.open(out/r['folder']/'congestion.png').convert('RGB');im.thumbnail((800,480));thumbs.append(im)
 sheet=Image.new('RGB',(1600,480*((len(thumbs)+1)//2)),'white')
 for i,im in enumerate(thumbs):sheet.paste(im,((i%2)*800,(i//2)*480))
 sheet.save(out/f'{kind}-contact.png')
print(out/'congestion-by-cycle.pdf')

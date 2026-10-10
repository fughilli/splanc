from pathlib import Path
import sys,subprocess
from PIL import Image,ImageOps,ImageDraw
root=Path(sys.argv[1]);mode=sys.argv[2]
if mode=='vias':
 images=[]
 for svg in sorted(root.glob('cluster-*.svg')):
  png=svg.with_suffix('.png');subprocess.run(['/opt/homebrew/bin/rsvg-convert','-w','900','-o',str(png),str(svg)],check=True);images.append(png)
else:images=[p for p in sorted((root/'pages').glob('layer-*.png')) if int(p.stem.split('-')[-1])>8]
cols=3;rows=2 if mode=='vias' else 4;w=700;h=600 if mode=='vias' else 500;n=cols*rows
for index in range(0,len(images),n):
 sheet=Image.new('RGB',(w*cols,h*rows),'white');draw=ImageDraw.Draw(sheet)
 for j,p in enumerate(images[index:index+n]):
  im=Image.open(p).convert('RGB');im.thumbnail((w,h-24));x=(j%cols)*w;y=(j//cols)*h
  sheet.paste(im,(x+(w-im.width)//2,y+24));draw.text((x+8,y+5),p.name,fill='black')
 sheet.save(root/f'review-contact-{index//n+1}.png')
print('images',len(images),'contacts',(len(images)+n-1)//n)

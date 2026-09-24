"""Render honest proxy-only initial-pool placement contacts (Pillow required)."""
import argparse,json,math
from pathlib import Path
from PIL import Image,ImageDraw,ImageFont

def font(size):
    for path in ['/System/Library/Fonts/Supplemental/Arial.ttf','/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf']:
        if Path(path).exists():return ImageFont.truetype(path,size)
    return ImageFont.load_default()

def panel(root,record,fixed):
    image=Image.new('RGB',(745,655),'#0b111b');draw=ImageDraw.Draw(image)
    graph=json.loads((root/'pool'/record['id']/'placed.json').read_text());proxy=record['proxy'];scale=9.4
    draw.text((15,12),record['id']+'  '+record['kind'],font=font(23),fill='white')
    draw.text((15,43),f"Unreachable {proxy['unreachable_branches']} · overflow {proxy['overflow_units']:.2f} · proxy {proxy['score']:.0f}",font=font(18),fill='#aebbd0')
    bx=15;by=102
    draw.rectangle((bx,by,bx+70*scale,by+55*scale),fill='#141d2b',outline='#a4afbd',width=2)
    for part in sorted(graph['components'],key=lambda a:(a['ref']=='TP1')):
        x,y=part['pos'];w,h=part['courtyard'];angle=math.radians(part['rot']);co=math.cos(angle);si=math.sin(angle)
        corners=[(bx+(x+u*co-v*si)*scale,by+(55-y-u*si-v*co)*scale)
                 for u,v in [(-w/2,-h/2),(w/2,-h/2),(w/2,h/2),(-w/2,h/2)]]
        color='#bc568e' if part['side']=='bottom' else '#477eaf' if part['ref'] in fixed else '#cfa161'
        draw.polygon(corners,fill=color,outline='white' if part['ref']=='U6' else '#07111d',width=2)
        if not part['ref'].startswith(('C','R')):
            draw.text((bx+x*scale,by+(55-y)*scale),part['ref'],font=font(12),fill='white',anchor='mm',stroke_width=1,stroke_fill='#18202a')
    pogo=next(p for p in graph['components'] if p['ref']=='TP1')
    draw.text((15,69),f"TP1 {pogo['pos']} · {pogo['rot']:.0f}° · {pogo['side']}"+(' · fallback after global failure' if record.get('basin_fallback_from') else ''),font=font(17),fill='#edb5d2')
    return image

def main():
    ap=argparse.ArgumentParser(description=__doc__);ap.add_argument('roots',nargs='+',type=Path);args=ap.parse_args()
    for root in args.roots:
        report=json.loads((root/'pool/report.json').read_text());fixed=set(report['fixed_refs'])
        records=[c for c in report['candidates'] if c.get('poses') and c.get('proxy')]
        contact=Image.new('RGB',(1490,160+655*math.ceil(len(records)/2)),'#0b111b');draw=ImageDraw.Draw(contact)
        draw.text((20,20),'Mini initial-placement exploration · PROXY ONLY',font=font(34),fill='white')
        draw.text((20,69),f"{len(report['candidates'])} starts / {len(records)} legal · {len(fixed)} hard-fixed parts · no detailed routing or native DRC",font=font(22),fill='#aebbd0')
        draw.text((20,108),'Blue = fixed/template · Orange = movable top · Magenta = bottom pogo · White outline = radio',font=font(21),fill='#aebbd0')
        folder=root/'placement-images';folder.mkdir(exist_ok=True)
        for index,record in enumerate(records):
            tile=panel(root,record,fixed);tile.save(folder/(record['id']+'.png'))
            contact.paste(tile,((index%2)*745,160+(index//2)*655))
        contact.save(root/'initial-placement-contact.png')
        (folder/'manifest.json').write_text(json.dumps({'scope':'Placement geometry only, no routed copper','pages':[r['id'] for r in records],'source':str(root/'pool/report.json')},indent=2))
if __name__=='__main__':main()

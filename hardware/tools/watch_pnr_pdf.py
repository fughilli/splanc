#!/usr/bin/env python3
"""Refresh an atomic PDF of saved source/native heatmaps during an active PnR run.

Use document Python. Does not write build inputs or validate a board. Start the
PDF skill authoring marker first. Review ledger deliberately stays pending.
"""
import argparse, hashlib, json, subprocess, time
from pathlib import Path
from reportlab.pdfgen import canvas


def snapshots(root):
    paths = []
    for p in sorted(root.glob('round-*/congestion.svg')):
        if (p.parent/'result.json').exists():
            paths.append(p)
    paths += sorted(root.glob('native-loop/cycle-*/congestion-*/congestion.svg'))
    return paths


def refresh(root, out, paths):
    staging = out/'congestion-by-cycle.pending.pdf'
    c = canvas.Canvas(str(staging), pagesize=(1000,700))
    c.setTitle('Splanc Mini - live PnR cycle diagnostics')
    records = []
    for number,p in enumerate(paths,1):
        label = str(p.parent.relative_to(root))
        data = p.read_bytes(); png = out/f'cycle-{number:02d}.png'
        subprocess.run(['/opt/homebrew/bin/rsvg-convert','-w','1800','-o',str(png),str(p)],check=True)
        c.setFont('Helvetica-Bold',16);c.drawString(25,670,label)
        c.drawImage(str(png),20,55,width=960,height=590,preserveAspectRatio=True,anchor='c')
        c.setFont('Helvetica',10)
        c.drawString(25,30,'Diagnostic only. Source signal counts are not native opens. All completion and electrical gates remain required.')
        c.drawString(25,15,'Saved producer color scales; compare only equal quantities and legends. Pending visual review.')
        c.showPage()
        records.append(dict(source=str(p),sha256=hashlib.sha256(data).hexdigest(),page=number))
    c.save();staging.replace(out/'congestion-by-cycle.pdf')
    (out/'review.json').write_text(json.dumps(dict(status='pending',reviewed_pages=[],snapshots=records),indent=2))
    print('PDF refreshed:',len(paths),'saved snapshots',flush=True)


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('diagnostics',type=Path);p.add_argument('--out',type=Path,required=True)
    p.add_argument('--seconds',type=float,default=1800);p.add_argument('--once',action='store_true')
    a=p.parse_args();a.out.mkdir(parents=True,exist_ok=True);seen=None;deadline=time.monotonic()+a.seconds
    while True:
        paths=snapshots(a.diagnostics)
        signature=[(str(v),hashlib.sha256(v.read_bytes()).hexdigest()) for v in paths]
        if paths and signature!=seen:refresh(a.diagnostics,a.out,paths);seen=signature
        if a.once or time.monotonic()>=deadline:break
        time.sleep(5)

if __name__=='__main__':main()

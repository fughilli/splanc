"""Flatten annotated board artwork for fast PDF viewing; retain clean vectors.

300 dpi at the large companion page size, cropped to nonwhite body artwork.
Titles/footers stay vector. Raster companions trade unbounded zoom and label
search for bounded decode cost; clean native pages retain precise vector copper.
"""
import argparse
import hashlib
import io
import json
import shutil
import subprocess
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from PIL import Image, ImageChops, ImageDraw
from reportlab.pdfgen.canvas import Canvas
from pypdf import PdfReader, PdfWriter

def flatten(source, output, specs, board, sha, pdftoppm, assets, dpi=300):
    assets.mkdir(parents=True, exist_ok=True)
    source_reader = PdfReader(source)
    annotated = [(i, p) for (i, p) in enumerate(specs) if p['kind'] == 'annotated']

    def render(item):
        (i, spec) = item
        prefix = assets / f'page-{i + 1:02}'
        subprocess.run([pdftoppm, '-f', str(i + 1), '-l', str(i + 1), '-r', str(dpi), '-singlefile', '-png', str(source), str(prefix)], check=True, capture_output=True)
        with Image.open(prefix.with_suffix('.png')) as raw:
            im = raw.convert('RGB')
        page = source_reader.pages[i]
        (w, h) = (float(page.mediabox.width), float(page.mediabox.height))
        sy = im.height / h
        sx = im.width / w
        # Exclude the original header/legend/footer before finding artwork bounds.
        top = round(110 * sy)
        bottom = im.height - round(60 * sy)
        body = im.crop((0, top, im.width, bottom))
        bounds = ImageChops.difference(body, Image.new('RGB', body.size, 'white')).getbbox()
        if bounds:
            (x0, y0, x1, y1) = bounds
            x0 = max(0, x0 - 4)
            y0 = max(0, y0 - 4)
            x1 = min(body.width, x1 + 4)
            y1 = min(body.height, y1 + 4)
            tile = body.crop((x0, y0, x1, y1))
            crop = assets / f'body-{i + 1:02}.png'
            tile.save(crop, optimize=True)
            # Map cropped pixels back to the original PDF coordinate system.
            placement = [x0 / sx, h - (top + y1) / sy, (x1 - x0) / sx, (y1 - y0) / sy]
        else:
            crop = None
            placement = None
        prefix.with_suffix('.png').unlink()
        return (i, crop, placement)
    # Bound memory to two large raster pages in flight.
    with ThreadPoolExecutor(max_workers=2) as pool:
        bodies = {i: (p, box) for (i, p, box) in pool.map(render, annotated)}
    writer = PdfWriter()
    for (i, spec) in enumerate(specs):
        original = source_reader.pages[i]
        if spec['kind'] == 'clean':
            writer.add_page(original)
        else:
            (w, h) = (float(original.mediabox.width), float(original.mediabox.height))
            data = io.BytesIO()
            c = Canvas(data, pagesize=(w, h), pageCompression=1)
            (crop, box) = bodies[i]
            if crop:
                c.drawImage(str(crop), *box)
            c.setFont('Helvetica-Bold', 28)
            c.drawString(48, h - 52, f"{i + 1:02} / {len(specs):02}   {spec['layer']} | annotated")
            c.setFont('Helvetica', 16)
            c.drawRightString(w - 48, h - 50, 'Splanc Mini | top-view | not mirrored')
            c.setFont('Helvetica', 14)
            c.drawString(48, h - 84, 'Blue: parts | Purple: pad indices (including off-layer references) | Brown: trace-group nets | Raster artwork: 300 dpi; clean pages remain vector')
            c.drawString(48, 30, f'{board.parent.name}/{board.name} | SHA256 {sha[:16]} | Edge.Cuts reference')
            c.save()
            data.seek(0)
            writer.add_page(PdfReader(data).pages[0])
        writer.add_outline_item(spec['layer'] + ' - ' + spec['kind'], i)
    if hasattr(writer, 'compress_identical_objects'):
        writer.compress_identical_objects(remove_identicals=True, remove_orphans=True)
    with output.open('wb') as f:
        writer.write(f)

def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('review', type=Path)
    ap.add_argument('--out-dir', type=Path, required=True)
    ap.add_argument('--pdftoppm', required=True)
    a = ap.parse_args()
    a.out_dir.mkdir(parents=True, exist_ok=False)
    m = json.loads((a.review / 'manifest.json').read_text())
    out = a.out_dir / 'all-layers.pdf'
    assert hashlib.sha256(Path(m['board']).read_bytes()).hexdigest() == m['sha256'], 'stale source board'
    flatten(Path(m['pdf']), out, m['layers'], Path(m['board']), m['sha256'], a.pdftoppm, a.out_dir / 'raster')
    pages = a.out_dir / 'pages'
    pages.mkdir()
    subprocess.run([a.pdftoppm, '-r', '110', '-png', str(out), str(pages / 'layer')], check=True, capture_output=True)
    pngs = sorted(pages.glob('layer-*.png'))
    assert len(pngs) == len(m['layers'])
    for (spec, p) in zip(m['layers'], pngs):
        spec['image'] = str(p.resolve())
    m.update(pdf=str(out.resolve()), annotation_rendering='lossless RGB raster, 300 dpi; clean pages vector', visual_review='pending')
    for first in range(0, len(pngs), 6):
        sheet = Image.new('RGB', (1200, 620), '#cbd0d6')
        draw = ImageDraw.Draw(sheet)
        for (off, p) in enumerate(pngs[first:first + 6]):
            im = Image.open(p).convert('RGB')
            im.thumbnail((395, 280))
            x = off % 3 * 400
            y = off // 3 * 310
            sheet.paste(im, (x + (400 - im.width) // 2, y))
            spec = m['layers'][first + off]
            draw.text((x + 8, y + 285), f"{first + off + 1:02} {spec['layer']} {spec['kind']}", fill='black')
        sheet.save(a.out_dir / f'contact-{first // 6 + 1:02}.png')
    (a.out_dir / 'native').mkdir()
    shutil.copyfile(a.review / 'native' / 'annotations.json', a.out_dir / 'native' / 'annotations.json')
    for native_pdf in (a.review / 'native').glob('[0-9][0-9].pdf'):
        shutil.copyfile(native_pdf, a.out_dir / 'native' / native_pdf.name)
    shutil.copyfile(a.review / 'annotations.json', a.out_dir / 'annotations.json')
    assert hashlib.sha256(Path(m['board']).read_bytes()).hexdigest() == m['sha256'], 'board changed during export'
    (a.out_dir / 'manifest.json').write_text(json.dumps(m, indent=2) + '\n')
    (a.out_dir / 'review.json').write_text(json.dumps(dict(board_sha256=m['sha256'], status='pending', reviewed_pages=[], observations=[]), indent=2) + '\n')
    print(json.dumps(dict(pdf=str(out), pages=len(pngs), bytes=out.stat().st_size)))
if __name__ == '__main__':
    main()

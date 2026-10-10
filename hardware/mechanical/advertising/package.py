"""Build the advertising gallery and distributable kit from completed renders."""
from pathlib import Path
import json,shutil,gzip,hashlib,zipfile,html,re
from PIL import Image,ImageDraw
R=Path.cwd();O=R/'output/advertising-kit-20261008';P=R/'output/mechanical-viewer/advertising-kit'
P.mkdir(parents=True,exist_ok=True)
source=R/'hardware/mechanical/advertising'
scripts=['sim.js','physics.mjs','perimeter-leds.js','inspect.js','port-labels.js','perimeter-lighting.js','model-data.js']
code_version=hashlib.sha256(b''.join((source/f).read_bytes() for f in scripts)).hexdigest()[:16]
markup=(source/'sim.html').read_text().replace('src="sim.js"',f'src="sim.js?v={code_version}"')
(O/'sim/index.html').write_text(markup)
for f in scripts:
    js=(source/f).read_text()
    for dependency in scripts:js=js.replace(f"'./{dependency}'",f"'./{dependency}?v={code_version}'")
    (O/'sim'/f).write_text(js)
models=O/'sim/models';catalog={};model_assets={'environment.jpg'}
for sku in ['mini','splanc','max']:
    blob=(models/f'{sku}.bin').read_bytes();digest=hashlib.sha256(blob).hexdigest()
    mesh_file=f'{sku}-{digest[:16]}.bin';(models/mesh_file).write_bytes(blob)
    (models/(mesh_file+'.gz')).write_bytes(gzip.compress(blob,compresslevel=6,mtime=0))
    meta=json.loads((models/f'{sku}.json').read_text());meta.update(mesh_file=mesh_file,sha256=digest)
    data=json.dumps(meta,sort_keys=True).encode();meta_file=f'{sku}-{hashlib.sha256(data).hexdigest()[:16]}.json'
    (models/meta_file).write_bytes(data);catalog[sku]=meta_file;model_assets.update([mesh_file,mesh_file+'.gz',meta_file])
(models/'index.json').write_text(json.dumps(catalog));model_assets.add('index.json')
# Keep only the current immutable export in the package, plus unversioned local
# CAD build inputs. Older live revisions remain available for already-open tabs.
for p in models.iterdir():
    if re.fullmatch(r'(mini|splanc|max)-[a-f0-9]{16}\.(json|bin|bin.gz)',p.name) and p.name not in model_assets:p.unlink()
Image.open(O/'stills/family.png').convert('RGB').save(O/'sim/poster.jpg',quality=85)
d=json.loads((O/'pricing/pricing-model.json').read_text())
css='''*{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;background:#10141a;color:#e9edf2;font:16px/1.5 system-ui,sans-serif}main{max-width:1240px;margin:auto;padding:36px 28px}a{color:#f7dc86;text-decoration:none}a:hover{text-decoration:underline}nav{display:flex;gap:22px;flex-wrap:wrap;border-bottom:1px solid #36404c;padding-bottom:20px}h1{font-size:clamp(36px,6vw,70px);line-height:1.05;font-weight:500;letter-spacing:-3px;margin:55px 0 20px}h2{font-size:30px;font-weight:500;margin-top:60px}h3{font-weight:500}.sub{color:#9caaba;max-width:760px}.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:20px}.card{border:1px solid #38404c;border-radius:12px;overflow:hidden;background:#192029}.card img,.card video{width:100%;display:block;aspect-ratio:16/9;object-fit:contain;background:#080b10}.cap{padding:14px 18px;display:flex;justify-content:space-between;gap:12px}.pill{display:inline-block;padding:11px 18px;border:1px solid #687281;border-radius:8px;margin:8px 10px 8px 0}.hero{width:100%;border-radius:12px;margin-top:25px}table{border-collapse:collapse;width:100%;margin:20px 0}th,td{text-align:left;border-bottom:1px solid #35414e;padding:14px 12px}th{color:#aab8c6;font-weight:500}td:nth-child(n+2){font-variant-numeric:tabular-nums}code,pre{background:#202934;border-radius:8px;padding:14px;white-space:pre-wrap;font-size:13px}.scroll{overflow:auto}small{color:#9caaba}details{padding:12px 0}iframe{width:100%;height:560px;border:1px solid #38404c;border-radius:12px}@media(max-width:650px){main{padding:22px 16px}.grid{grid-template-columns:1fr}h1{letter-spacing:-1px}iframe{height:460px}}@media print{body{background:white;color:black}main{padding:0}nav,.no-print{display:none}td,th{color:black;border-color:#ccc}a{color:#333}h1{font-size:32px;margin:10px 0}h2{margin-top:20px}small,.sub{color:#444}}'''
cards=[]
for sku,name in [('mini','Splanc Mini'),('splanc','Splanc / GNSS'),('max','Splanc MAX')]:
    angles=[]
    for angle in ['hero','ports','reverse','top']:
        p=O/'stills'/f'{sku}-{angle}.png';im=Image.open(p).convert('RGB');im.save(p.with_suffix('.jpg'),quality=91)
        angles.append(f'<article class="card"><a href="stills/{p.name}"><img loading="lazy" src="stills/{p.stem}.jpg" alt="{name}, {angle} angle"></a><div class="cap"><span>{angle.capitalize()}</span><a href="stills/{p.name}" download>1920 × 1080 PNG ↓</a></div></article>')
    cards.append(f'<section id="{sku}"><h2>{name}</h2><div class="grid">'+''.join(angles)+'</div></section>')
videos=[]
for shot,name in [('mini-orbit','Mini · camera orbit'),('splanc-orbit','Splanc · camera orbit'),('max-orbit','MAX · camera orbit'),('mini-macro-roll','Mini · diagonal macro roll'),('family-pullback','Family · reverse crash zoom')]:
    frame=60 if shot=='family-pullback' else 48
    Image.open(O/'review'/f'{shot}-{frame:03}.png').convert('RGB').save(O/'video'/f'{shot}.jpg',quality=90)
    videos.append(f'<article class="card"><video controls playsinline preload="metadata" poster="video/{shot}.jpg" src="video/{shot}.mp4"></video><div class="cap"><span>{name}</span><a href="video/{shot}.mp4" download>HD MP4 ↓</a></div></article>')
pricingrows=''.join(f'<tr><td>{p["name"]}</td><td>${p["price"]:,.2f}</td><td>${p["cost"][1]:,.2f}</td><td>{p["margin"]:.1%}</td><td>${p["cost"][0]:,.2f}–${p["cost"][2]:,.2f}</td></tr>' for p in d['products'])
prices=f'<div class="scroll"><table><thead><tr><th>Product</th><th>Launch price</th><th>Unit cost</th><th>Gross margin</th><th>Cost scenarios</th></tr></thead><tbody>{pricingrows}</tbody></table></div>'
notes=''.join('<p>'+html.escape(t)+'</p>' for t in d['notes'])
notes+='<p>MAX is now $599, adding $30 of headroom for optional UWB/GNSS. The base cost still excludes their modules and antenna/support circuits; the displayed margin is before those optional costs.</p>'
bomrows=''.join(f'<tr><td>{html.escape(r["part"])}</td><td>{r["qty"]:g}</td><td>${r["mid"]:.4f}</td><td>${r["qty"]*r["mid"]:.2f}</td><td>{html.escape(r["basis"])}</td><td>'+ (f'<a href="{html.escape(r["source"])}">Source</a>' if r['source'] else 'Allowance')+'</td></tr>' for r in d['max_bom'])
(O/'pricing/index.html').write_text(f'<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Splanc pricing</title><style>{css}</style><main><nav><a href="../">Advertising kit</a><a href="../outputs/pricing-20261008/splanc-pricing.xlsx">Editable workbook</a><a href="max-r11-bom.csv">MAX BOM CSV</a></nav><h1>Launch pricing</h1><p class="sub">Planning sheet · USD · 1,000 units per product · 9 October 2026. MAX rounded to $599; Mini and Splanc carry forward September estimates.</p>{prices}<h2>Scope and assumptions</h2>{notes}<h2>MAX component budget</h2><p>Components and internal hardware: ${d["max_components"][1]:.2f}. Increase over the previous component budget: ${d["max_component_delta"][1]:.2f}.</p><div class="scroll"><table><thead><tr><th>Part / allowance</th><th>Qty</th><th>Unit USD</th><th>Total USD</th><th>Basis</th><th>Reference</th></tr></thead><tbody>{bomrows}</tbody></table></div></main></html>')
readme='''# Splanc advertising kit — 8 October 2026

13 full-HD PNG stills, JPEG web copies, five H.264 MP4 motion clips at 24 fps,
the browser simulation, a pricing workbook, HTML pricing sheet and BOM CSV.
Mini and Splanc use the last mechanical r10 board snapshots; MAX uses r11.
Splanc GNSS shares the Splanc exterior. These are CAD design renders, not
photographs or proof of final production hardware. No waterproof, regulatory
or shipment-readiness claim is implied. Prices remain planning proposals.

## Website integration

Copy the complete sim directory into your site's public assets. Serve over
HTTP(S), not file://. All JS, models, environment image and fallback poster
are local; no CDN, telemetry or account is required. Use:

<iframe src="/splanc/sim/?embed=1" title="Splanc products in zero gravity"
  style="width:100%;height:560px;border:0" loading="lazy"></iframe>

The iframe should have a useful accessible title. Reduced-motion preference
starts it paused. It pauses processing when hidden. Play/pause is always
available. Normal view adds density, speed, reset and drag-to-throw controls.
A continuous frosted RGB diffuser bar runs a smooth chaser around the viewport
perimeter. Light faces inward; one screen-space pass approximates its colored spill
on the product surfaces without shadow-map lights. Its motion shares the
simulation speed, pause and reduced-motion controls.
Double-click or double-tap any product to inspect it: drag to orbit and scroll
or pinch to zoom. Tap the background, press Escape, or use the X to ease it
back into its saved flight state. Inspection freezes product flight while the
diffuser keeps chasing, unless already paused. Closing restores the prior
playing/paused state. Reduced motion skips the transitions.
Circular port and button markers track the CAD locations while orbiting; only
facing features are shown. Tap a circle to reveal its name and description.
In inspection, Sensors separates the case and reveals the saved board layout
with sensor callouts. Close case reassembles it; X/background/Escape returns to
flight, even while exploded. Component bodies are simplified display shapes,
not final assembly CAD. Splanc's GNSS module is explicitly marked optional;
MAX groups its twenty-channel power telemetry into one callout and shows optional
DWM3000 UWB and MAX-M10S GNSS fitments for cooperative localization. Their
locations are provisional display envelopes; circuits, antennas and integration
remain design work. Base MAX pricing excludes these optional fitments.
Seed can be set with ?seed=42. No host DOM or postMessage permission required.
The model sizes remain proportional. Impacts use conservative 2D oriented
rectangle bounds with cosmetic 3D tilt, not a full 3D impact solver.

Model metadata and buffers have content-addressed filenames. Deploy the whole
sim directory together, and do not cache models/index.json indefinitely. Keep
old model revisions available until existing page loads have completed.

Host .js/.mjs as JavaScript, .json as JSON and .bin/.gz as binary. The .gz
models are explicitly decompressed in the browser: do NOT add a separate
Content-Encoding:gzip header to those files. Uncompressed models are the
fallback for browsers without DecompressionStream. Normal server compression
may still be used for JS/HTML/JSON.

## Asset treatment and rights

Real CAD silhouettes and connector geometry; clean fine-grained black plastic,
white logo inlay, yellow buttons, frosted light pipes. Stills use Cycles;
motion clips use Eevee at 1920×1080, 24 fps, 48 samples. No audio. Macro roll
uses the earlier diagonal-through-frame brief; family shot pulls back while
the larger units slide into frame. Blender source scenes are supplied separately
in the local blender folder, omitted from the lightweight advertising ZIP.

Three.js vendor files retain their MIT LICENSE. The existing ambientCG PBR/HDRI
assets are CC0 (Plastic013A, Plastic016A, IndoorEnvironmentHDRI002); shell grain
is the project's procedural scratch-free material. Vendor connector CAD is
used as reference geometry with its existing source attribution; no new license
to vendor design data is asserted. Splanc branding remains the project owner's.

## Pricing

See pricing/index.html, pricing/pricing-model.json, pricing/max-r11-bom.csv and
outputs/pricing-20261008/splanc-pricing.xlsx. MAX includes new internal power
and switching but excludes Pi/cooler/storage/external supply and cables.
Network circuitry remains specification-stage. Cost allowances and retrieved
price tiers are separated; obtain supplier/tooling quotes before committing.
'''
(O/'README.md').write_text(readme)
(O/'index.html').write_text(f'''<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Splanc advertising kit</title><style>{css}</style><main><nav><strong>Splanc</strong><a href="#stills">Product shots</a><a href="#motion">Motion</a><a href="#live">Zero gravity</a><a href="pricing/">Pricing</a></nav><h1>The Splanc family.</h1><p class="sub">Full-HD product artwork, camera motion and an interactive playground. Latest enclosure design: Mini, Splanc with optional GNSS, and MAX with optional UWB and GNSS.</p><a class="pill" href="splanc-advertising-kit.zip" download>Download the kit ↓</a><a class="pill" href="sim/">Open live simulation ↗</a><img class="hero" src="sim/poster.jpg" alt="Splanc product family"><small>Design visualizations · 1920 × 1080 · 8 October 2026</small><div id="stills">{''.join(cards)}</div><section id="motion"><h2>Camera studies</h2><p class="sub">HD H.264 · 24 fps · silent · three orbits, a diagonal rolling entrance and a family reveal.</p><div class="grid">{''.join(videos)}</div></section><section id="live"><h2>Zero gravity, live.</h2><p class="sub">Drag, throw and watch the family collide inside a continuous chasing RGB diffuser. Double-tap a product to orbit and zoom, label its buttons, or explore its sensors. A self-contained animation for your website.</p><iframe src="sim/?embed=1" title="Splanc products in zero gravity" loading="lazy"></iframe><a class="pill" href="splanc-browser-sim.zip" download>Download standalone embed ↓</a><details><summary>Embed instructions</summary><p>Copy the sim directory to your website. No CDN or service required.</p><pre>&lt;iframe src="/splanc/sim/?embed=1"
  title="Splanc products in zero gravity"
  style="width:100%;height:560px;border:0"
  loading="lazy"&gt;&lt;/iframe&gt;</pre><a href="README.md">Full integration notes</a></details></section><section><h2>Planning prices</h2>{prices}<p class="sub">MAX excludes the Raspberry Pi. Launch prices are selected; the underlying costs include first-batch tooling allocations and remain estimates, not supplier quotes. Mini and Splanc estimates are carried forward; MAX reflects r11 hardware.</p><a class="pill" href="pricing/">Pricing and cost basis →</a><a class="pill" href="outputs/pricing-20261008/splanc-pricing.xlsx">Download editable workbook ↓</a></section><footer><p><small>CAD design renders, not production photography. Final electronics, thermal and tooling qualification remain in progress.</small></p></footer></main></html>''')
files=[p for p in O.rglob('*') if p.is_file() and p.name!='manifest.json' and not any(x in p.relative_to(O).parts for x in ['authoring','blender','review']) and p.suffix not in ['.zip','.ndjson'] and (p.parent!=models or p.name in model_assets)]
manifest={'revision':'max-service-r11','date':'2026-10-08','simulation_updated':'2026-10-09','stills':13,'videos':5,'resolution':[1920,1080],'fps':24,'files':[{"path":str(p.relative_to(O)),"bytes":p.stat().st_size,"sha256":hashlib.sha256(p.read_bytes()).hexdigest()} for p in files]}
(O/'manifest.json').write_text(json.dumps(manifest,indent=2));files.append(O/'manifest.json')
with zipfile.ZipFile(O/'splanc-browser-sim.zip','w',zipfile.ZIP_DEFLATED) as z:
 for p in files:
  if p.is_relative_to(O/'sim'):z.write(p,str(p.relative_to(O)))
 z.write(O/'README.md','README.md')
with zipfile.ZipFile(O/'splanc-advertising-kit.zip','w',zipfile.ZIP_DEFLATED) as z:
 for p in files:z.write(p,str(p.relative_to(O)))
deployed=files+[O/'splanc-advertising-kit.zip',O/'splanc-browser-sim.zip']
# Publish buffers before catalogs/HTML, and atomically replace every served file.
for p in sorted(deployed,key=lambda p:p.name in ['index.json','index.html']):
 target=P/p.relative_to(O);target.parent.mkdir(parents=True,exist_ok=True)
 temporary=target.with_name(target.name+'.deploying');shutil.copy2(p,temporary);temporary.replace(target)
print(json.dumps({'gallery':str(P),'zip_bytes':(O/'splanc-advertising-kit.zip').stat().st_size,'simulation_zip_bytes':(O/'splanc-browser-sim.zip').stat().st_size}))

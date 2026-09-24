# Current finish: textured black with white double-shot logo

The current output is `output/product-renders-black`. Each black lid contains a
0.7mm-deep logo pocket and a separate flush white plastic solid exported as
`logo-white-inlay.step`. The artwork comes from `web/public/icons/splanc.svg`.
This specifies the visible two-material design; second-shot gates, runners,
material bonding and tooling construction remain to be designed with the molder.
The earlier white-shell/embossed study and ZIP remain available unchanged.

Both shell halves use black PC-ABS PBR materials with physical-scale fine-grain
bump texture and a satin roughness of0.48. The white second-shot plastic has
roughness0.36. Blue buttons and real connector models are retained. Individual
Mini, Splanc (also GNSS), and MAX hero views are rendered at1800×1350.
Rebuild with prepare_product_assets.py, then render_products.py using
`output/product-renders-black/scene.json --hero-only`. Test with test_product_assets.py;
package with package_products.py. The new archive is
`releases/splanc-black-inlay-assets-20260921.zip`.

The previous estimated launch costs have not been requoted for two-shot tooling.

---

# Splanc product render assets

These are dimensioned engineering-design renders, not photographs or released
manufacturing designs. Three enclosure geometries are generated: Mini, Splanc
(with the same exterior for the optional GNSS assembly), and MAX.

The actual repository artwork `web/public/icons/splanc.svg` is tessellated into
closed contours with letter counters preserved, then embossed 0.45 mm into the
centre of every lid. MAX has a solid central logo field interrupting the vent
array. Base/lid dimensions before embossing: Mini76.4×61.4×20mm,
Splanc106.4×86.4×25mm, MAX335×134×53mm.

Materials use Blender Principled BSDFs: satin PC-ABS shells with microtexture,
blue silicone button caps, PMMA light pipes, nickel-plated connector shells,
gold contacts, ivory JST nylon, green terminal PA66 and copper busbars. These
are material specifications for visualization; exact resin/color/tool texture
and RF/thermal qualification remain open. Lighting uses area lights, physical
ray tracing, AgX colour management and denoising. No AI-generated geometry.

Visible external connector geometry uses the GCT USB4105 KiCad model, the
existing JST B3B-PH-K-S CAD, official Pi5 STEP ports, and the selected DEGSON
2EDGRC-5.08-03P-14-100A(H) headers. These replace block placeholders. MAX is shown with output
plugs removed; its matching2EDGKDF-5.08-03P-14-00A(H) screw plugs are included in the price model.
The actual Wuerth5580510 lug model is shown, with its manufacturer CAD/drawing
revision discrepancy recorded in `assets/max-connectors.json`. Do not scale that
model to hide the discrepancy. Production lug mating fit remains unqualified.
The old Mini USB part directory contains an aliased GT-USB model; the render uses
the catalog-specific GCT library geometry, with its mouth aligned to the existing
opening. Final pad/model origin correspondence requires the package audit.

Rebuild after installing `requirements.txt` in the isolated mechanical runtime:

```sh
output/mechanical-runtime/bin/python hardware/mechanical/build.py \
  --mini output/fresh-pnr-20260919/fresh-28-final/splanc_mini.fab.board.kicad_pcb
output/mechanical-runtime/bin/python hardware/mechanical/prepare_product_assets.py
/path/to/Blender --background --factory-startup \
  --python hardware/mechanical/render_products.py -- output/product-renders/scene.json
```

Rendering was performed with official Blender4.5.9LTS for macOS arm64, run from a
read-only disk image. No application security/permission settings were changed.
The Pi5 reference is the official RaspberryPi5-step.zip, with its included MIT
license retained under output/mechanical/sources/pi5. Model paths and SHA256s
are captured in scene.json; the source STEP files retain their licensing notices.
Source CAD is in millimetres and converted to metres exactly once for rendering.
The .blend contains separate product collections and reusable materials/cameras.

The bodies are prototypes: cable-plug access, fastener stacks, mould draft,
USB rigid-jumper mating, RF antenna detuning and thermal limits still require
physical review. Internal component envelopes are not supplier CAD; hero renders
are exterior views. See the electronics README for electrical qualification gaps.

The DEGSON manufacturer CAD is rigidly rotated about X and translated into the
pin-1 PCB frame; no scaling is applied. Its normalization test checks both the
17.24×12×11.7mm total envelope and that only the solder tails intersect a plane
2mm below the PCB. This detects inverted models that share the same bounding box.

Current MAX budget: $177.86 finished cost at1000, proposed$299 launch price
(40.5% gross margin), excluding Pi and power supply. See the maintained pricing
report rather than the historical first enclosure-release cost estimate.

Repackage reviewed outputs with `python3 hardware/mechanical/package_products.py`.
The dated ZIP contains individual STEP parts, the PBR Blender scene, PNG views,
pricing assumptions, connector provenance and a SHA256 inventory. It preserves
the earlier enclosure prototype archive. All six shell STEP files pass re-import
validity, single-solid, positive-volume, zero-intersection and emboss-height checks.

Visual review: the revised MAX views show ten unplugged green headers on each
long board edge, with connector apertures and an uninterrupted central embossed
logo field. Pi ports remain deeply recessed in this concept; cable mating access
is not validated by their visible CAD alone. Mini/Splanc use the same shell finish,
blue button caps and shallow white-on-white embossing. JST top-entry connectors
are recessed beneath their cable openings. These observations are fit-review
items, not a claim that the enclosure is ready to tool.

Black-finish validation: all six shell exports remain valid single solids with
zero base/lid intersection. All three logo solids are valid, exactly flush at
20/25/53mm respectively,0.7mm deep, and have zero volumetric overlap with their
matching lids. These are design solids; tooling feed geometry is not included.

Individual black-finish images were visually reviewed: Mini and Splanc have
legible white wordmarks, retained blue controls and clean connector cutouts;
MAX has a legible centered inlay between the vent fields. Fine black texture
shows in the grazing highlights. Recessed connector access remains as documented
for the earlier mechanical study.

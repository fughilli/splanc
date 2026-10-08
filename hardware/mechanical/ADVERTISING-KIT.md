# Advertising kit, 8 October 2026

Current local output: `output/advertising-kit-20261008`.
Private gallery: `http://mac-mini.tail6b8ad3.ts.net:8767/advertising-kit/`.
Standalone animation: gallery path plus `sim/` (add `?embed=1` for minimal controls).

The kit contains 13 full-HD stills (four angles per enclosure plus family),
five silent H.264 1920×1080/24 fps clips (three four-second camera orbits,
four-second diagonal Mini roll, five-second family pullback), a self-contained
Three.js animation and a formula-driven pricing workbook with MAX r11 BOM.
GNSS is a stuffing option sharing the Splanc exterior. The original PNGs,
web JPEGs, simulation, prices, BOM and integration instructions are in the
advertising ZIP; packed Blender scenes stay separately in the output directory.
Generated binaries are ignored by Git. No public hosting or release publication.

## Frozen geometry and reproducibility

`render_advertising.py` reads the saved `output/max-service-r11/scene.json`,
which incorporates handheld r10 and MAX r11, and retrieves approved material
and HDRI data from `output/blender-motion-studio-r4/splanc-motion-studio.blend`.
It never rebuilds electrical boards or edits PnR work. Use Blender 4.5.9:

```
blender -b -t 4 --python hardware/mechanical/render_advertising.py -- --mode stills
blender -b -t 4 --python hardware/mechanical/render_advertising.py -- --mode videos
blender -b -t 2 --python hardware/mechanical/render_advertising.py -- --mode web
```

Stills use Cycles/Metal, 64 samples, denoising; video uses Eevee, 48 samples.
Motion is deliberately editable via named product pivots, lights and camera
keys in the separately packed scenes. The macro shot has no visible backdrop;
the other shots use the charcoal studio surface. Camera clips are motion
masters for editing, not a claim of production photography.

`advertising/package.py` assembles the gallery into a bounded subdirectory of
the existing mechanical viewer, avoiding access to source, runtime or unrelated
work. All browser dependencies are local. Binary geometry is grouped by
material and gzipped; hidden PCBs and internal harnesses are omitted from the
web model. The simulation retains relative dimensions and uses fixed-step
planar oriented-box collision impulses with cosmetic tilt, not engineering
impact physics. Density is a maximum; packing may reduce count to avoid overlap.

## Pricing

Run `hardware/pricing/max_service_r11.py`; then run
`hardware/pricing/build_kit_workbook.mjs` with the bundled Artifact Tool runtime.
The latter's module resolution needs the bundled node_modules alongside the
builder. Read the spreadsheet skill before reauthoring. The workbook lives at
`outputs/pricing-20261008/splanc-pricing.xlsx` within the kit directory.

First-batch central MAX component/internal-hardware budget is $245.09;
finished-unit estimate is $336.64, including 3% component overage, board
assembly/test, enclosure and tooling amortization over 1,000 units. Proposed
$569 gives 40.8% gross margin; Pi/cooler/storage/external supply and cables are
excluded. Previous $299 estimate is historical for the earlier configuration.
Mini $52.99, Splanc $109 and GNSS option $139 retain September sourcing.

New supplier references: TRACO THL40-2411WI $58.7923 at100, KSZ9896CTXI $12.7625
at100, NE8FDP $11.02934 at500 (two per MAX). Existing applicable tiers are
carried forward without an unverified volume discount. New power protection,
network passives/magnetics/controller and harnesses remain allowances. RFQ,
allocations, detailed circuit completion and tooling quotes are outstanding.
Source URLs, dates, line quantities, assumptions and cost scenarios are in the
machine-readable model, CSV, workbook and HTML sheet.

## Validation recorded

`review/` contains browser checks, contact sheets, workbook image renders and
formula scans. The 13 stills and three sampled frames from each of the five
clips were actually viewed. The workbook's summary, complete cost model,
complete BOM and sources were reviewed as rendered images. Formula totals
reconcile to the independent Python calculation; no formula errors found.
All five MP4s loaded and sought successfully with native Chrome video decoding;
dimensions1920×1080 and durations4/4/4/4/5seconds checked. Browser simulation
had no page errors, recorded collisions, respected pause/reduced-motion, and
rendered at desktop and mobile viewport sizes. Observed desktop ~55fps on this
Mac is not a claim about physical phone performance. A 60-second physics test
checks head-on rebound, rotated overlap, finite states and bounded motion.

Visual observations: current connector scallops, yellow button faces and white
lid inlay are visible; MAX includes the new red/black DC and twin network end.
Bright studio highlights make upward-facing black lids read charcoal grey.
The family reveal has intentional close framing during the initial pullback;
the macro roll enters lower-left and exits right. The browser uses simpler
materials and geometry than the path-traced stills, with no internal exposed
flexure geometry. Remaining product engineering gates are unchanged.

# Mechanical section viewer

Local Three.js 0.180 viewer of the button-dfa-r5 geometric prototype. Run from repo root:

```
XDG_CACHE_HOME=/private/tmp/mechanical-cache output/mechanical-runtime/bin/python hardware/mechanical/viewer/build.py
python3 hardware/mechanical/viewer/serve.py
```

Open http://127.0.0.1:8767/ . Localhost-only default. Vendored Three.js and its MIT
license avoid runtime CDN access. The server exposes only output/mechanical-viewer.

Features: product selection, orbit/pan/zoom, axis-aligned movable/flippable section
plane, triangulated filled sections plus contours, visible/occluded dashed edges,
shell transparency, per-part visibility/solo, search, button-section preset,
section-normal camera, PNG and JSON view-state download. Section faces are derived
from tessellated meshes, not exact analytic CAD; very small features/coplanar cuts
can be better inspected with caps disabled. Render on interaction only. Mesh packs
are gzipped in transit and loaded per product.

Current prototype: flat-backed drafted rectangular button strip, plain internal rail land,
raised local sealing joint, and 0.4–0.6 mm nominal direct-contact travel. Use **Your saved view**
to reproduce the user-supplied cutaway. Select all or individual buttons, press
travel, and assumed switch travel. Animated flexure deformation and tip compression
are illustrative kinematics, not a structural or force simulation.

See [BUTTON-FLEXURE.md](../BUTTON-DFA.md) for reproduction, geometric checks,
and outstanding supplier stack-up, tip force, fatigue and weather-diaphragm work.
The old campaign-r3 flange intersected the Mini PCB by 0.26412449 mm³; that checkpoint
is preserved. The new guide/shoulder geometry is checked separately.

The source TL3340 STEP seating plane is Z=-1.65. Reference switch placement uses
Z translation 9.05 to seat at PCB top 7.4. Source footprint model offsets are now
1.65 mm, correcting the previous 0.4 mm offset that buried the model by 1.25 mm.
No PCB copper or placement changed. Actuator motion is illustrative; internal dome
mechanics are not modeled.

Manufacturer source:
https://configured-product-images.s3.amazonaws.com/2D/specs/TL3340AF160QG.pdf

Use Assembly insertion view to inspect insertion before PCBA installation. Print-oriented STEP/STL files are in output/button-dfa-r5.

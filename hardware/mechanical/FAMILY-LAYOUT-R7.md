# MAX compact stack, revision 7

Current scene: `output/family-layout-r7/scene.json`.
Run `output/mechanical-runtime/bin/python hardware/mechanical/compact_max.py`
from the repository root, followed by `check_family_layout.py` and
`viewer/build.py --source output/family-layout-r7` in the same runtime.
The immutable r6 STEP checkpoint is the source; other family products retain r6.

MAX is now 292 × 134 × 43 mm, excluding the unchanged external lug projection.
The original 26.4 mm HAT spacers inherited the provisional rigid USB bridge's
connector spacing. They were not required by the cooler. HAT underside is now
Z28 mm, supported by 18.4 mm spacers above the Pi PCB top at Z9.6 mm.
The tallest modeled Pi USB housing reaches Z25.53, leaving 2.47 mm nominal
vertical clearance; the cooler envelope reaches Z23.3, leaving 4.7 mm.
The lid and case fasteners move down 10 mm. The Pi, power board, busbars, output
banks and existing bottom mounting supports remain at their previous heights.

The rigid bridge becomes 24 × 32 × 1.6 mm. USB-A stays in place, USB-C moves
down 8 mm. Authoring source, interface, design, placement constraint and the
unrouted native bridge board use the 18.4 mm connector spacing. The exact
male connector and elevated GPIO socket parts are still provisional: physical
mating and supplier tolerance checks are required before fabrication.

Both Pi USB openings are covered by a continuous exterior wall. Ethernet
retains its north-facing opening, with a 22 mm wide open-bottom finger relief
starting beyond the Pi PCB edge to reach the cable latch. Internal pockets
clear the lowered HAT and USB-C bridge without opening the exterior USB cover.
Pi power access remains at the east end. The relief is not a waterproof feature.

Validation checks solid validity, a single connected solid per shell half,
zero lid/base overlap, actual Pi CAD and cooler/HAT/jumper versus shell,
HAT-to-Pi and cooler clearance with a 1 mm allowance, continuous USB covers,
Ethernet finger corridor, preserved Pi support height and supported logo inlay.
USB bridge native DRC reports zero violations and eight expected unrouted items.
Finger comfort with booted Ethernet plugs, airflow/thermal behavior, full
supplier tolerances and tooling qualification still require physical review.

Blender regeneration uses `build_motion_studio.py` and writes
`output/blender-motion-studio-r2/splanc-motion-studio.blend` without modifying r1.

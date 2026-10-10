# Internal button carrier — r2 correction

The r1 external bezel/carrier was a misinterpretation of the intended exterior.
It is superseded by this prototype. Only the original 5×5 mm button faces appear
outside the front wall, at their original released protrusion and locations.
There is no external carrier, bezel or additional visible fastener.

All retention and actuation parts are inside: a common registered rail, two folded
planar springs per button, narrow stems with raised retaining shoulders, internal
inward stops, and provisional compliant tips. The rail seats in the base and is
trapped by lid fingers during closure. The internal shoulders stop outward travel
against the inside wall; side-supported stops limit inward travel to 1.6 mm.
The exterior face pockets receive the inward stroke. The sealing joint rises locally
to clear the internal spring carrier. Complete strip STEP is one connected solid.

Source: button_flexure_internal.py. Output: output/button-flexure-r2. Historical
r1 and campaign-r3 are preserved. check_button_internal.py checks rigid shuttles
at three travel positions and four transverse ±0.20 mm corners, all four buttons
and all four variants, against the actual shells and PCB/source switch bodies.
Intended inward stop lip contact is excluded to allow +0.10 mm stop tolerance.
Conservative spring bounding prisms cover the entire 0–1.7 mm stroke plus ±0.20
mm transverse and ±0.10 mm axial allowances. This does not model elastic buckling.

These dimensions are allocations, not a supplier-verified production stack-up.
The shorter TPE contact tips, 0.25 mm thick PP-candidate springs, fatigue/creep,
molding feasibility and switch force/overload remain unqualified. The raised
weather gasket is included, but a moving-button diaphragm is still outstanding.
No claim of waterproofness or production readiness. The r1 highlight video shows
the rejected external mechanism and must not be used as the final product render.

Rebuild using output/mechanical-runtime/bin/python and XDG_CACHE_HOME set to a
writable cache: run button_flexure_internal.py, check_button_internal.py, then
viewer/build.py --source output/button-flexure-r2. Viewer motion is illustrative
kinematics, not FEA. Hide the lid/base to inspect the internal carrier.

# Rectangular flat-backed button strip — r5

User accepted rectangular faces. This supersedes the r1 external carrier and r2
barbell geometry; r3 was only the interim pogo-floor closure.

The r5 revision uses0.8mm rear-width ×0.3mm thick flexures (1° side draft gives
approximately0.7895mm width at the opposite face). Folds have1.5mm pitch, leaving
0.7mm nominal slots. The raised1.8mm rail has0.8mm capture overlap with the lid lip,
compared with0.35mm in r4. Both retention-web portions extend continuously to the
lid plane; there is no suspended shelf. A lid-print STEP/STL places the lid top on
the bed, with the web growing upward. Force and fatigue have not been requalified.

## Geometry and assembly

Each button is one drafted prism, approximately5×2.2mm at the visible face,
5.2×2.4mm at the rear and6mm deep, with0.95° draft. The entire strip has a common
flat rear plane atY=1.45mm; there are no rear contact tips, flanges, locating pins,
sockets or hooked retainers. The upper rail and folded springs have1° draft toward
the same rear draw plane. The buttons themselves register in5.7×2.9mm apertures.

Lower the strip into the empty base, then push it toward the exterior through the
openings. The common rail bears against the inner wall. Install the PCB, then the
lid; a plain lid land backs the rail. This land supplies the reaction needed for
the springs, without an additional keyed retention feature. Only the rectangular
button faces are visible outside. The6mm body depth maintains full2.2mm guide
engagement over the reviewed0–0.6mm stroke, so depression cannot disengage the guides.

TP1 is board-level EoL access only. Mini and Mini-weather now have continuous2.2mm
floors at the pogo location; the service cover is removed. PCB pads are unchanged.

## Reproduction and checks

Run button_dfa.py then check_button_dfa.py with output/mechanical-runtime/bin/python
and a writable XDG_CACHE_HOME. Build viewer with viewer/build.py --source
output/button-dfa-r5. Checkpoint contains complete button-flexure-strip.step in
assembly coordinates plus button-strip-print.step and button-strip-print.stl with
the rear plane on the print bed and all material atZ>=0. Inspection subpart files
are not separate production parts: the complete strip is the single manufactured
component.

Checks include: valid single solids and zero base/lid overlap; lower-into-base and
outward insertion samples; aperture containment for the full prism section plus
±0.20mm transverse allowance;192 nominal-travel/alignment poses against shells,
PCB and fixed switch bodies; conservative spring sweep envelopes; and zero volume
outside the rear-face extrusion (no rear-draw undercut). The moving actuator is
excluded from fixed obstacles because direct contact is intentional. The PCB
allowance uses topZ7.6mm, leaving0.1mm below the button at worst transverse position.

Viewer includes **Assembly insertion view** with an insertion slider: lid and
PCBA are hidden, so the strip can be inspected before board installation. **Show
all** restores the assembly. Press travel is limited to0.3mm nominal gap plus the
selected switch travel, instead of the former unjustified1.6mm motion.

## Limits still open

This is an assembly and nominal-kinematics prototype, not tooling release. The
0.3mm gap plus0.1–0.3mm switch travel requires0.4–0.6mm nominal depression. A±0.2mm
axial stack changes that requirement to0.2–0.8mm; fixed enclosure stops and switch
overload protection are NOT qualified across that range. No compliant tip remains,
so the previous travel/force claims must not be reused. The viewer intentionally
does not depict travel beyond the selected switch's nominal contact limit.

PP resin,0.3mm spring thickness/0.8mm rear width, gate filling, shrinkage, fatigue,
return force and allowable switch overload still require engineering and tests.
The rear-draw check establishes geometric release direction for the button strip,
not tooling feasibility for the whole enclosure: side openings, shell draft,
ejection and parting/gland tooling need review. Weather moving-button diaphragm
and ingress qualification remain outstanding. Separate STEP/STL parts support
print trials; print material/process and minimum feature capability are not qualified.

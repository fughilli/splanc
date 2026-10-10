> Superseded: user accepted rectangular faces; see BUTTON-DFA.md and output/button-dfa-r4.

# Button DFA correction pending face-size decision

User clarified TP1 pogo pads are board-level EoL test before enclosure installation.
mini-ports.json now records expose_in_enclosure=false; generate_enclosures.py honors
that flag. weather_details.py no longer adds a pogo cover. close_test_access.py
creates output/button-dfa-r3 from preserved button-flexure-r2, closing Mini and
Mini-weather floors with 2.2 mm material. test-access-validation.json records checks.
This checkpoint still contains the rejected r2 button geometry; it is NOT the new
DFA button solution and has not replaced the live viewer.

R2 insertion test confirms the assembly defect: translating the complete strip
from inside toward final position intersects the base by 9.87 mm³ at +2 mm and
40.24 mm³ at +3 mm despite zero intersection in the final pose. The final-pose
clearance test is insufficient. Future checks must include insertion before PCB
installation, button draft/draw direction, planar rear face and print orientation.

User wants a single drafted prism per button, no rear protrusions beyond the
flexure plane, direct rear-plane switch contact, no special rail locator/retainer.
Asked user whether to use shorter roughly5×2.2 mm faces or preserve5×5 mm faces
and revise PCB/switch arrangement. Current switch axis is9.1 mm, PCB top7.4 mm;
a full-depth5 mm square centered on that axis extends down to6.6 mm and intersects
the board. +/-0.20 mm envelope uses PCB top7.6 mm. Do not silently alter the exterior
or claim the current PCB can accommodate a full-depth square prism.

Also re-evaluate actuation stroke: the former1.6 mm travel relied on an unqualified
compliant tip, which the requested flat-backed direct-contact architecture removes.
Do not carry that stroke/force claim into a rigid prism. Switch travel is0.2+/-0.1mm;
stack-up/overload protection must be resolved alongside the new mounting geometry.

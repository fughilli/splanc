# Connector access and weather-treatment study

Initial access outputs: `output/product-renders-access`. Final chamfered parts and
selected-material stills: `output/product-renders-campaign`; follow the complete
rebuild order in `CAMPAIGN-RENDERS.md`. For the initial access study run `refine_enclosures.py`,
`weather_details.py`, `test_access_enclosures.py`, then render the new scene with
`render_products.py -- output/product-renders-access/scene.json --hero-only`.
The black/white-inlay source package remains unchanged. No electronics moved.

## Standard exterior

Four visible nominal M2.5 socket-head fasteners on Mini/Splanc; six nominal M3
on MAX. Their shaft/thread/insert selection is provisional; rendered fasteners
are dimensioned visual models, not vendor-qualified screw CAD. Top-entry LED
connectors sit in lowered tapered molded wells. USB entries flare towards the
outside. MAX has tapered output access and a recessed Pi connector panel.
The black fine-grain material and flush white logo inlay remain.

## Weather variant concept

Separate `*-weather` STEP folders and rendered views show perimeter gaskets,
screw seals, connector collars, bonded-button boot concepts, Mini pogo-service
cover and acoustic/pressure membranes. The JST collar depth follows the actual
housing CAD height and spans to the lowered lid opening. MAX adds nominal Pi
port and lug collars. Vent openings are blanked in the MAX weather study.
The coating is an assembly-process requirement, not a decorative material layer
or a simulated ingress barrier in the render.

This is an unqualified weather-resistant design study, not a waterproof product
or an IP rating. In particular, the rendered open connector mating cavities are
still open to water. Exposed JST, USB and pluggable terminal headers require
sealed mating boots/cables, or gasketed unused-port caps. Their shell-to-body
collars alone do not make the connector internals sealed. Board-side connector
seams may require compatible potting/sealant; validate capillary paths and adhesion.

Conformal coating process: coat assembled electronics with a selected qualified
chemistry and documented thickness/cure. Mask connector contacts, pogo pads,
buttons, microphone and pressure-sensor ports, antenna/RF keepouts and service
points. Verify compatibility, cleanliness and coverage on test coupons/assemblies.
This change has not selected a coating supplier or updated the production BOM.

Before offering the weather SKU: complete continuous gasket compression at
connector/button seam transitions; qualify elastomer bonding, pressure/acoustic
membranes and service covers; provide drainage outside the seal line for the
lowered wells; add sealed cable strain relief and port caps; perform ingress,
condensation and environmental tests. MAX's blanked ventilation requires a new
thermal solution/load derating assessment before operation, especially with the
Pi and 20 power channels. No thermal or ingress validation is inferred from CAD.
Two-shot tooling, seals, coating, sealed mating accessories and their assembly
costs are not included in the earlier launch-price estimates.

## Checks

STEP re-import confirms all 12 base/lid solids valid and single-piece, with zero
base/lid intersection. Actual JST and DEGSON models have zero measured shell
intersection in the standard version; connector poses remain unchanged. These
checks do not establish plug clearance, seal compression or waterproofness.

The final MAX access revision merges each terminal row into a shared recess.
Two continuous provisional silicone carrier STEP parts span the gaps between
individual connector interfaces. Their compression/adhesion to both the shell
and actual connector housings still requires qualification; open mating cavities
still require sealed cables or unused-port caps.

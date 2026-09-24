# Electronics reference assets for the clean build

`reference-electronics.json.gz` contains 95 tessellated electronics entries
extracted from the accepted family-layout-r7 scene. These are PCB reference
envelopes, GCT USB4105 connectors, JST PH headers, the Raspberry Pi official CAD
port/PCB selection, official DEGSON headers, busbars and the catalog M5 lugs.
Geometry is already posed in the enclosure's millimetre assembly frame. This
is an electronics reference, not a source of enclosure geometry. Do not add
shells, supports, buttons, fasteners, seals or lightpipes to this asset.

Original tessellation/model retrieval is recorded by prepare_product_assets.py
and the existing connector provenance in this directory. Manufacturer models
retain their original terms; no new license is asserted. The Pi solid reference
is a gzip-compressed copy of pi5-visible-ports.step, extracted from the official
Pi 5 STEP by that same preparation script. Tests use it directly, without a
prior enclosure output dependency.

Mini's frozen board reference provides 70x55mm outline and mounting locations.
Current Splanc and MAX interface/design JSON supply their board parameters.
The reference meshes must be refreshed when electrical placements change; they
are not a live PCB exporter and do not claim the boards are completely routed.

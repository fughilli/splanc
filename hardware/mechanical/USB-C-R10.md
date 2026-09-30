# USB-C surrounds and seam seal — r10

The Mini, Splanc/GNSS and MAX Pi-power openings now use the same shell-conformal USB-C feature. The internal MAX USB jumper stays internal. The last mechanical board state is retained; this change does not import ongoing electrical work.

The actual saved GCT and Pi connector STEP sections measure 8.94 × 3.16 mm at the mating face. The opening has 0.30 mm nominal radial clearance and 1 degree of outward draft. Its local plastic web is 0.80 mm thick and sits 0.90 to 0.10 mm behind that face. This lets a mating cable overmold reach the connector face without the case setting its insertion depth. A rounded 18 × 10 mm recess at the web flares to 20 × 12 mm at the exterior. MAX has a deeper recess and inward support because its connector face is 5.8 mm inside the exterior wall; Mini and Splanc are 1.75 mm inside.

The sealing representation is a **dispensed bead in the gland**, not a continuous O-ring. The Mini/Splanc gland and bead stop 0.8 mm outside the recess-mouth envelope. Every remaining bead volume is clipped to supporting shell material before its gland is cut, so there are no free spans across the openings. MAX can use a continuous dispensed seam bead where its gland is uninterrupted. The connector-to-case perimeter requires a separate sealant application if the sealed variant is pursued. The 0.30 mm clearance itself is not a seal. Chemistry, bead dosing, adhesion and ingress performance remain unqualified; MAX is vented.

An open, cut-to-length gasket is a possible later substitution, but this revision represents sealant and does not specify gasket compression or a butt-joint seal. No unsupported strip bridges a connector.

## Rebuild and verify

Run from the repository root:

```sh
output/mechanical-runtime/bin/python hardware/mechanical/build_clean_enclosures.py --out output/usb-conformal-r10
output/mechanical-runtime/bin/python hardware/mechanical/check_clean_enclosures.py --source output/usb-conformal-r10
output/mechanical-runtime/bin/python hardware/mechanical/check_usb_c.py --source output/usb-conformal-r10
output/mechanical-runtime/bin/python hardware/mechanical/check_button_dfa.py --source output/usb-conformal-r10 --products mini splanc
output/mechanical-runtime/bin/python hardware/mechanical/viewer/build.py --source output/usb-conformal-r10
```

Frozen interface inputs are under `assets/frozen-r9`, taken from mechanical commit `3576fd292` with individual SHA256s. Electronics meshes remain the existing `assets/reference-electronics.json.gz`. Existing r9 output is preserved.

Validation covers the complete native reference connector bodies, board/port/fastener envelopes, valid single-solid shells, no base/lid overlap, nine socket tolerance positions per product, measured web thickness on four sides and 54 cable positions per product. The tested cable has an explicitly assumed rounded 16 × 8 mm overmold, a metal insertion envelope and ±0.25 mm lateral offsets. It clears all three cases down to the connector face. This is not a guarantee for every USB-C cable. The existing 96 button travel/tolerance poses, installation path and spring/retainer checks also pass.

Outputs: `output/usb-conformal-r10` contains STEP/STL parts, scene, input manifest and validation reports. `output/product-renders-usb-r10` contains updated hero/detail views and the packed Blender project. CAD changes are limited to the shells and seam seal; the other 211 scene meshes match r9 exactly across the standard and weather-study assemblies.

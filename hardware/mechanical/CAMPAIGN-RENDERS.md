# Product stills and motion-ready scene

Current stills and CAD: `output/product-renders-campaign-r3`. Earlier white,
black/inlay and access-study outputs are preserved separately.

## Selected materials and lighting

- Shell: clean procedural labyrinth grain,0.30mm nominal wavelength (half the
  previous perceived grain size),12micrometre relief,350mm unique swatch; uniform
  black albedo and0.48 roughness. Plastic012B is superseded for the shell.
- White inlay: Plastic013A,2K maps,350mm swatch.
- Yellow buttons: Plastic016A,2K maps,350mm swatch, authored color retained.
- Light pipes: neutral semi-frosted PMMA, IOR1.49, transmission0.78,
  roughness0.32, subtle subsurface scattering and indicator emission.
- Environment: IndoorEnvironmentHDRI002,4K EXR, strength0.15,35degree rotation.
  Broad area lights supplement its reflections; AgX exposure−1.3.

Source links, CC0 declarations and ZIP hashes are in assets/ambientcg-sources.json.
The Blender file packs the used images, so texture paths are not required to open
it. Unused displacement/DirectX maps remain in the download cache. Meshes have
physical-scale projected UVs; geometric chamfers are in STEP, not painted highlights.

## Mechanical refinement

Visible nominal fasteners are included. Mini has a shared lowered LED-connector
well; Splanc has a lowered front connector deck; MAX has shared terminal-bank
recesses and a recessed Pi interface. Connector models and electronics stay in
place. Pressure-vent pitch on Mini increases from2 to2.4mm so three0.5mm mouth
chamfers fit without intersecting. Top lid perimeters, recess rims, screw
counterbores and other exterior cuts use0.5mm chamfers. Logo/inlay interfaces and
gasket compression faces are preserved. Existing rounded corners remain rounded.

The initial OCC chamfer attempt logs rejected topology in chamfer-validation.json;
later geometric wedge/cone passes resolve recorded lid conflicts in
finish-validation.json. bank-validation.json records the shared-recess update and
any remaining modified/tangent edge candidates. Do not interpret candidate counts
as a manufacturing edge audit. See WEATHER-STUDY.md for the unqualified weather
variant, coating requirements and thermal/ingress limitations.

Final checks: all twelve exported shell halves re-import as valid single solids;
all six base/lid pairs have zero intersection. The standard JST and twenty MAX
terminal interfaces have zero measured shell intersection. MAX's Pi clearance
check is also zero. The final bank-edge audit classifies old rejected candidates
as superseded edges or tangent surface boundaries, with no remaining flagged
sharp transition. These geometric checks do not replace manufacturing review.

Image review: Mini's rim, vent mouths and screw recesses read clearly; Splanc's
connector-deck shoulder preserves both light pipes entirely on the flat lid.
The black source texture retains visible fine wear under the selected HDRI.
MAX shows a continuous terminal-bank opening, six fasteners and chamfered vent
mouths; its deeply recessed Pi ports are shadowed at this hero angle. The Splanc
weather still visibly adds connector collars and button boots, while the mating
cavities remain open. All four delivered stills were reviewed as images.

## Rebuild order

Use the isolated mechanical Python for CAD scripts:

1. fetch_ambientcg.py (ordinary Python; source cache downloaded once), then generate_clean_plastic.py (mechanical Python)
2. refine_enclosures.py
3. weather_details.py
4. chamfer_enclosures.py
5. finalize_shells.py
6. finish_edge_fallbacks.py
7. finalize_mini_vents.py
8. finish_max_banks.py
9. trim_panel_lip.py, audit_bank_edges.py, raise_max_bosses.py, weather_bank_carriers.py, then prepare_campaign_scene.py --output output/product-renders-campaign-r3
10. test_access_enclosures.py --root output/product-renders-campaign-r3
11. Blender: render_campaign.py -- output/product-renders-campaign-r3/scene.json --hero-only
12. package_products.py --root output/product-renders-campaign-r3 --archive hardware/mechanical/releases/splanc-campaign-assets-20260922-r3.zip --scene-archive hardware/mechanical/releases/splanc-campaign-blender-20260922-r3.zip

## Later video shots (not rendered yet)

The saved scene has separate product collections, a Turntable pivot per product,
and a named Highlight Sweep light. Retain the material exposure between shots.

-6second reveal: hold camera, sweep a long area-light reflection across the
black lid and white inlay; finish with a readable product silhouette.
-4–6second orbit: ease from a quick30degree turn into a slow connector/logo
close-up. Render at60fps for retiming; avoid synthetic motion-blur artifacts.
-2–3second connector/macro inserts: fasteners,0.5mm bevel, frosted indicator,
then a cut to real fixtures driven by Splanc on the matching motion beat.
-Finish with all three form factors and a short title hold. Keep a16:9 master
with protected central framing for mobile crops and launch-page text overlays.

Use real fixture footage for light output/effects and the CAD scenes for product
form. No test results or waterproof claims should be implied by the visual style.

## Revision 2: texture scale and center bosses

The plastic maps all use a 350mm swatch in physical object coordinates, with a
5mm origin offset to keep every UV inside the first tile. This is consistent
across products and all three map channels. A render-time check verifies no
plastic UV falls outside that swatch; MAX spans335mm. This replaces the overly
repetitive5–10mm mapping.

Both MAX center screw bosses start at the terminal opening's upper edge, Z22.8mm.
The former lower post remnants are removed while preserving the floor and wall.
The upper screw engagement and screw locations are unchanged. boss-validation.json
checks zero remaining post volume below the opening ceiling, excluding the wall
and floor, and valid single solids in both standard and weather variants.

## Revision 3: scratch-free fine grain and continuous mapping

The user requested removal of source scratches and half-size grain after revision2.
`generate_clean_plastic.py` generates a deterministic4096px spectral labyrinth
height field with0.30mm nominal wavelength and12micrometre relief over350mm. It
is a Turing-like stripe synthesis, not a reaction-diffusion simulation. A tangent
OpenGL normal map is also exported for other renderers.

The shell shader blends object-space box projections of the **height**, then
derives normals using the bump node. It does not box-project tangent normals
(which would use incompatible face frames). Blend width0.3 transitions across
chamfers/rounded corners; texture extension is clamped and coordinates retain the
same metric scale across products. Shell color and roughness contain no scratch
maps. This supersedes the old dominant-face shell UV projection. White inlay and
yellow button assets retain their selected ambientCG materials.

Revision3 image review: Mini's finer grain is visible on the lid and recesses,
with no scratches or obvious corner projection breaks. Initial2micrometre relief
was too faint under the studio lighting; final relief is12micrometres while the
0.30mm grain size remains fixed. All CAD geometry is unchanged from revision2.
Splanc and its weather view retain the same fine grain; MAX's hero reads smoother
at its wider camera distance, as expected for the same physical grain size. The
center-post nub is absent. All four final revision3 images were visually reviewed.

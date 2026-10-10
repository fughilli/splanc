# Advertising kit, updated 10 October 2026

Current local output: `output/advertising-kit-20261008`.
Private gallery: `http://mac-mini.tail6b8ad3.ts.net:8767/advertising-kit/`.
Standalone animation: gallery path plus `sim/` (add `?embed=1` for minimal controls).

The kit contains 13 full-HD stills (four angles per enclosure plus family),
five silent H.264 1920×1080/24 fps clips (three eight-second camera orbits,
twelve-second slow Mini reveal, five-second family pullback), a self-contained
Three.js animation and a formula-driven pricing workbook with MAX r11 BOM.
GNSS is a stuffing option sharing the Splanc exterior. The original PNGs,
web JPEGs, simulation, prices, BOM and integration instructions are in the
advertising ZIP; packed Blender scenes stay separately in the output directory.
Generated binaries are ignored by Git. No public hosting or release publication.

## Current refresh, 10 October 2026

The current generation is saved at `output/advertising-r13-20261010`, then
copied into the existing kit directory after review. Mini's shell is
75.6 × 61.0 × 11.3 mm, with directly connected button caps and no upper rail.
The overall displayed height is 11.8 mm because the LED headers project locally.
Both handhelds have outward-facing QWIIC sockets and cable openings; their
PCB footprint and routing are explicitly pending. All PCB placements remain
from the saved mechanical snapshot. See `CLEAN-ENCLOSURES.md` for the fit gates.

A true-scale credit-card reference and overall dimensions default on when a
product is inspected. Both fade out while Sensors opens the case, and return
when it closes if the reference is enabled. Desktop and touch checks cover all
three products, toggling, reduced motion, and exact restoration of flight.
QWIIC callouts appear on Mini and Splanc/GNSS only. Mini's direct button links
are included in the exploded browser model.

The three orbits last eight seconds, keep a constant 6.25–7.32 degrees/second,
and have distinct seeded start/end angles. Splanc runs in the reverse direction.
The twelve-second Mini reveal has 20 degrees of attitude change and about
38.45 mm total diagonal drift; its projected logo is centered at frame 208.
`advertising/check_render_scenes.py` verifies the packed scene configuration,
constant orbit speeds, and the reveal logo position. Final renders are HD Cycles.
Source hashes, geometric reports, actual reviewed image hashes, scene audit and
full movie decode evidence are kept in the generation's `authoring/` and `review/`.

The website hero also includes four supplied installation photos and the fifth
portrait installation video, all using a full-slot cover crop. Its two decoded
media buffers support mixed image/video transitions without poster flashes.
The portrait source is encoded at its native 1080 × 1920 resolution, silent H.264,
with fast-start metadata; responsive photos use 960/1920-pixel WebP variants.
Website source and deployment media are maintained in the separate splanc.io repo.

## Frozen geometry and reproducibility

`render_advertising.py` reads the saved `output/qwiic-linked-r13/scene.json`,
which incorporates the compact Mini, both QWIIC provisions and MAX r11, and retrieves approved material
and simulation environment data from `output/blender-motion-studio-r4/splanc-motion-studio.blend`.
It never rebuilds electrical boards or edits PnR work. Use Blender 4.5.9:

```
blender -b -t 4 --python hardware/mechanical/render_advertising.py -- --mode stills
blender -b -t 4 --python hardware/mechanical/render_advertising.py -- --mode videos
blender -b -t 2 --python hardware/mechanical/render_advertising.py -- --mode web
```

Stills use Cycles/Metal, 64 samples, denoising; all five videos use Cycles/Metal, 32 samples.
Motion is deliberately editable via named product pivots, lights and camera
keys in the separately packed scenes. All current shots use a black world with a single elevated reveal softbox;
there is no HDRI, fill/rim light, emissive lighting, studio floor or haze. Camera clips are motion
masters for editing, not a claim of production photography.

`advertising/package.py` assembles the gallery into a bounded subdirectory of
the existing mechanical viewer, avoiding access to source, runtime or unrelated
work. All browser dependencies are local. Binary geometry is grouped by
material and gzipped; simplified PCB/component bodies and the button mechanism
appear in the exploded Sensors view. The simulation retains relative dimensions and uses fixed-step
planar oriented-box collision impulses with cosmetic tilt, not engineering
impact physics. Density is a maximum; packing may reduce count to avoid overlap.

## Simulation interaction update, 9 October 2026

A local Canvas2D overlay draws a WS2812-style perimeter strip with three smooth
RGB chaser tails. Emitters face into the viewport; a single screen-space GPU
pass approximates colored illumination on opaque product pixels. This is a
visual approximation with no ray-traced occlusion or engineering photometry.
Package geometry is cached on resize; the pointer-transparent overlay follows
shared pause, speed, visibility and reduced-motion settings.
Double-click/tap a product to inspect it at the center, then drag to orbit,
scroll/pinch to zoom, and use the background, X or Escape to return. The flight
state is frozen during inspection; position, orientation and velocity are
preserved. Returning uses quaternion interpolation; reduced motion skips these
transitions. Port bubbles follow connector anchors extracted from the frozen
CAD and expand on tap. Back-facing ports are hidden until rotated into view.
This works in the standalone view and minimal website embed.

The source button normals were correct, but the old browser decimator removed
front faces (7 triangles per cap instead of 12). The web exporter now welds CAD
face seams, retains small solids, avoids a second bevel on complex connectors,
uses boundary-preserving planar dissolve on open vendor tessellations and
rejects modifiers that open or invert a closed input. Exported Mini/Splanc caps
have zero unpaired geometric edges and no inverted shading normals. Blender
stills/videos were unaffected; the frozen source CAD was not changed.

`advertising/check_interactions.mjs` checks exact paused flight restoration,
orbit, wheel/pinch zoom, background/X/Escape return, desktop/touch port bubbles,
LED animation/pause and reduced motion in an isolated Chrome profile. Evidence
lives in the kit's `review/interaction-validation.json`, screenshots,
`button-mesh-validation.json` and `web-topology.json`.

## Pricing

Run `hardware/pricing/max_service_r11.py`; then run
`hardware/pricing/build_kit_workbook.mjs` with the bundled Artifact Tool runtime.
The latter's module resolution needs the bundled node_modules alongside the
builder. Read the spreadsheet skill before reauthoring. The workbook lives at
`outputs/pricing-20261008/splanc-pricing.xlsx` within the kit directory.

First-batch central MAX component/internal-hardware budget is $245.09;
finished-unit estimate is $336.64, including 3% component overage, board
assembly/test, enclosure and tooling amortization over 1,000 units. Selected
$599 gives 43.8% gross margin before optional UWB/GNSS costs; Pi/cooler/storage/external supply and cables are
excluded. Previous $299 estimate is historical for the earlier configuration.
Mini $52.99, Splanc $109 and GNSS option $139 retain September sourcing.

New supplier references: TRACO THL40-2411WI $58.7923 at100, KSZ9896CTXI $12.7625
at100, NE8FDP $11.02934 at500 (two per MAX). Existing applicable tiers are
carried forward without an unverified volume discount. New power protection,
network passives/magnetics/controller and harnesses remain allowances. RFQ,
allocations, detailed circuit completion and tooling quotes are outstanding.
Source URLs, dates, line quantities, assumptions and cost scenarios are in the
machine-readable model, CSV, workbook and HTML sheet.

## Original validation (8 October, superseded media)

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


## Browser model delivery, 9 October 2026

After a report of disembodied connectors, fresh Chrome and WebKit screenshots
showed complete enclosures; the exact user-tab failure was not reproduced.
The app tab-capture tool failed to initialize, so these are isolated browsers
at the same live URL, not a capture of the user's existing tab.

Delivery now uses an uncached model catalog, content-addressed metadata and
binary filenames, atomic deployment and versioned script imports. This closes
a real cache/deployment race: older layout offsets can no longer be combined
with a newly exported binary under the same URL. The loader checks byte length,
alignment, index ranges, finite geometry and required enclosure parts before
rendering. A rejected model displays the fallback instead of partial geometry.
`advertising/check_model_delivery.mjs` verifies gzip/raw delivery and warm
reloads in Chromium and WebKit, plus explicit mismatched-metadata rejection.
Actual screenshots and results are in `review/model-delivery-*`. The isolated
WebKit test installation is in ignored `authoring/browser-cache`; it changes
no app permissions or user browser profile. Stills/CAD remain unchanged.

A repeated-load check also observed `ERR_CONNECTION_RESET` on a JavaScript
module, leaving the page at its loading message. The private viewer now allows
a backlog of 64 connections (previously 5) for parallel module/mesh loads and
sets revalidation headers for current code/catalogs and immutable caching for
hashed models. This is a loading reliability fix, not proof of the reported
connector-only rendering cause. Both existing bind addresses are preserved.

## Button labels, exploded sensors and diffuser — 9 October 2026

Inspecting Mini or Splanc now labels Reset, Boot, User 1 and User 2 at the
actual cap positions. User-button actions remain firmware-assigned. MAX has
no exterior button array in the saved mechanical design.

The Sensors control smoothly separates the lid, base and internal assemblies.
Callouts and highlight rings follow the board during orbit/zoom. Mini shows
motion, compass, pressure/temperature, microphone and two INA226 monitors;
Splanc also shows DWM3000 ranging and explicitly optional MAX-M10S GNSS.
MAX shows the five INA4180 current-sense banks and MCP3208 telemetry ADC.
Close case reassembles; X/background/Escape restores the original flight state.
Reduced-motion skips the transitions. The shared pause/speed behavior remains.

The old visible diode packages are replaced by one continuous frosted diffuser
bar with three smoothly chasing color regions; inward light directions and
the lightweight screen-space spill remain. No external dependencies added.

Internal package bodies are simplified display envelopes, not manufacturer
CAD or final routing. Their placements are frozen in
`advertising/board-details.json`, with source hashes: Mini and MAX power use
`output/mechanical/*-board.json`; Splanc uses the saved rough design layout.
The exporter adds these to the existing r11 CAD without writing source boards.
The live electrical agent's board and routing work are untouched.

Validation: `advertising/check_sensors.mjs` passed Chrome and WebKit at desktop
1440×1000 and touch/mobile 390×844. All three models passed sensor count,
button label, callout expansion, non-overlap, open/close, preserved paused
flight state, Escape during explosion and reduced-motion checks. Review JSONs
are `review/sensors-validation.json` and `review/sensors-validation-webkit.json`.
Actually viewed Chrome desktop diffuser, buttons and all three exploded SKUs;
Chrome mobile Mini/MAX exploded and Splanc expanded detail; final WebKit
diffuser desktop, Mini expanded sensor detail and mobile buttons. Enclosure
pieces, board, button faces and anchored callouts were visible. No script
errors were reported. The final WebKit captures verify the smoother diffuser
core (the earlier Chrome captures precede that minor visual adjustment).

Outputs and both download ZIPs were refreshed at the existing private viewer.
The old viewer listeners had stopped; restored loopback and tailnet on8767,
with process identity recorded in `server-process-sensors-20261009.json`.


## Inspection chase and circular markers — 9 October 2026

Inspection now freezes product flight without pausing the diffuser clock or
its colored spill. Explicit Pause and reduced-motion still stop both clocks.
Collapsed port, button and sensor callouts are text-free 24px circles within
40px touch targets. Tapping reveals a title and description, with the selected
circle highlighted. Accessible feature names and keyboard focus remain.

Extended the existing interaction check to verify changing diffuser pixels
and time while inspected product positions remain frozen, then resumption of
flight. Chrome and WebKit passed desktop and touch/mobile checks for all three
SKUs, empty circular marker labels, accessible names, titled descriptions,
non-overlap, paused state preservation and reduced motion; no script errors.
Evidence: output/advertising-kit-20261008/review/sensors-validation{,-webkit}.json.
Actually viewed refreshed buttons-desktop.png, buttons-mobile.png,
sensor-detail-splanc-mobile.png and inspection-chase-desktop-webkit.png. Circles
remain small and descriptions readable; complete shells are visible.
Both ZIPs and the existing private viewer were refreshed. CAD and boards are
unchanged; no rendering/model export was needed.


## MAX optional localization and grouped telemetry — 9 October 2026

MAX's Sensors view now offers three product-level callouts: 20-channel power
telemetry, optional UWB, and optional GNSS. Existing current-sense bank meshes
remain in place; the five bank labels and separate ADC label are consolidated
into one entry. Mini and Splanc display components and sensors are unchanged.

The optional fitment contract is `../splanc_max/localization-options.json`,
referenced by the MAX service-system contract and README. It uses Qorvo DWM3000
and u-blox MAX-M10S to support a cooperative-localization ground-station role.
It records independent DNP options, LV/DGND host interfaces, antenna and
power-budget work, anchor calibration and timing limitations. Official primary
references are linked in that contract. No new pin-level circuit or routed
board is claimed. The advertising model places simplified optional envelopes
on the saved HAT for inspection only; the on-screen note says their positions
are provisional. GNSS still requires an antenna implementation. Existing MAX
base BOM/price excludes these options; the kit and pricing page say so.

Rebuilt only web meshes and both download ZIPs, preserving all frozen board
snapshot hashes. Export topology check found no newly open/inverted closed
solids. Chrome desktop/mobile checks pass, including exactly three MAX entries,
both optional descriptions, titled grouped telemetry, non-overlap, state return
and continuing diffuser. Evidence remains in review/sensors-validation.json.
Actually viewed refreshed sensors-max-desktop.png and
sensor-detail-max-desktop.png: complete exploded shells/boards, two small
optional module envelopes at the Pi/HAT end, and one power telemetry marker.

WebKit desktop/mobile checks also passed, with zero script errors and no callout
overlap (review/sensors-validation-webkit.json). Additionally viewed Chrome
sensors-max-mobile.png: all three markers and the GNSS description fit the
phone viewport. Both optional-module descriptions are exercised by the check.

### Website integration — 9 October 2026

The website work lives in the separate `Studio-Fug/splanc.io` repository.
MAX is rounded from $569 to $599 to provide $30 of headroom for optional
localization sensors. The base cost model has not gained a quoted optional
sensor BOM; its 43.8% margin is before that fitment. Other prices remain
Mini $52.99, Splanc $109, and Splanc GNSS $139.

Website preview validation found that some static servers advertise .gz meshes
with Content-Encoding, which fetch decodes automatically. The shared loader
now checks the payload signature before decompression, then performs the same
geometry bounds validation. Website Chrome checks cover opaque gzip; WebKit
checks cover HTTP-decoded gzip. Missing decode support uses the poster.

### Diffuser without halo — 9 October 2026

Removed the 32px and 17px translucent strokes around the 8px emitting core.
The housing, smooth color chase and inward product-only lighting remain.
There is no new fog, bloom or ambient glow. Updated both the standalone kit
and the website copy; refreshed runtime versions and the existing private kit.
Desktop/mobile canvas checks found zero nontransparent pixels beyond the
housing envelope while the colored core continued animating. Actually viewed
website .preview.local/no-halo-website.png and no-halo-kit-mobile.png; sharp
strip edges and colored illumination on modules are visible. Site hero videos
now fill the entire hero with centered cover cropping on desktop/mobile.

### Continuous callout layout — 9 October 2026

Replaced greedy discrete slots with a persistent screen-space solver. Costs
cover distance to the port, overlapping expanded cards, crossed/nearby leaders,
and displacement from the preceding layout. A bounded descent runs jointly over
visible entries, with time-based interpolation and a speed cap on the displayed
circles. Leaders follow the displayed center. Visibility has hysteresis at the
back-facing threshold; reduced motion bypasses interpolation.

`check_callout_layout.mjs` passes crossing reduction, eight-label crowding,
expanded-card phone resize, settled stability, 30/60/120 Hz step response and
reduced motion. Eight-label local p95 update cost was ~1.12ms; this is a local
CPU benchmark, not a mobile performance claim. Chrome checked 18 states across
three SKUs, desktop/phone, ports/sensors/expanded: zero settled overlaps,
out-of-bounds cards or crossed leaders in those views. Arbitrary projections
can still have crossings: this is a local optimizer, not a planarity guarantee.
Chrome and WebKit orbit/expand/close tests passed with attached leaders and no
script errors; observed maximum per-frame movement 11.26px desktop/3.05px phone.
Actually viewed the Splanc/MAX desktop descriptions, Splanc phone description,
and post-orbit desktop screenshot. Evidence: website `.preview.local/` JSON
and images; kit `advertising/check_callout_motion.mjs` is the repeatable check.

### Black single-source campaign renders — 9 October 2026

Re-rendered the complete current kit: thirteen 1920×1080 stills and five
1920×1080/24fps clips, using the same frozen r11 CAD and existing camera motion.
The single rectangular light travels in an overhead arc from behind the object
to the camera side; intensity and exposure stay constant within each shot. The
Mini diagonal shot advances the light arc so the face is lit around the center
crossing. Stills use one light at the revealed angle. The browser zero-gravity
simulation keeps its own environment and perimeter illumination.

Masters, logs, sampled frames and six packed editable Blender scenes are in
`output/advertising-black-20261009`; delivered copies are in the existing kit.
Low-resolution previews showed early light spill from the tall source, so its
height and start angle were corrected before HD rendering. Reopened all six
scenes and verified exactly one AREA light, zero world/mesh emission, no floor,
HD resolution and negative-to-positive camera-side light position for each
film. Evidence: `review/scene-audit.json`. The referenced YouTube tutorial could
not be loaded; implementation follows the user's explicit lighting description.

Actually reviewed all thirteen final stills (twelve-angle contact sheet plus
family), all twenty-five sampled HD film frames in the final contact sheet,
and the corrected Mini center-crossing frame at full size. The logo is readable
at that crossing; the orbits open nearly black with isolated edge glints before
the top face appears. The family shot finishes centered on the three products.
Source geometry, existing trajectories and hardware state are unchanged.
`advertising/check_render_scenes.py` repeats the saved-scene audit in Blender.


### Slow Mini reveal — 9 October 2026

Revised the diagonal Mini shot to follow the user's stage-separation reference:
slow deliberate drift, with the moving light providing the reveal. The transit
now lasts eight seconds (192 frames at 24 fps), twice the preceding duration.
The roll is only 65° to 45° instead of 125° to −15°; the pose at the center
crossing and the existing behind-to-front light timing remain aligned. Camera
framing, frozen CAD and the other four films are unchanged.

HD master and editable scene: `output/advertising-slow-reveal-20261009`.
The saved-scene audit measures 20.000° total attitude change and a peak rate of
3.770°/second, with one light, zero ambient/emission and 1920×1080 output.
Actually viewed the five low-resolution samples, five HD samples as a contact
sheet, the full-resolution center frame, and desktop/phone hero screenshots.
The logo catches the light near the center crossing with only a small attitude
change. Chrome verified the eight-second HD decode and automatic next-clip
handoff in both layouts, without a poster or script errors. Website build/lint
passed. Refreshed the existing private kit and site preview; the kit poster is
now selected from the actual middle sample instead of a fixed frame number.


### Ray-traced reveal and much slower drift

Matched-camera/light comparison of old Mini frames 48, 72 and 96 isolated a
renderer problem: Eevee illuminated connector-recess surfaces that Cycles
correctly left occluded. Geometry and materials were held constant. The old
light had shadows enabled and a 1 mm shadow maximum-resolution setting; the
comparison does not isolate that individual setting from other Eevee shadow
approximations. New motion renders now default to Cycles; Eevee requires an
explicit draft override.

The current Mini movie is twelve seconds, 1920×1080/24fps, Cycles 32 samples
with the fast denoiser for motion iteration. Travel is now 36 mm horizontally
and 13.5 mm vertically, down from 240/90 mm in eight seconds: approximately
ten times slower. Roll remains 20° across the longer duration; the light arc
now occupies 90% of the shot. The product stays in the macro composition while
its edge, side, then logo emerge from darkness. No CAD changes, ambient fill,
fog, emission, or additional lights. Other four films retain their prior
Eevee renders; only the current Mini reveal was replaced this iteration.

Master, editable Blender scene and diagnostics:
`output/advertising-reveal-raytrace-20261009`. `render-final.log` completed
288 frames; the earlier high-denoiser run was cancelled after a timing check
and is not the delivered clip. Audit confirms peak drift 3.215 mm/s and peak
roll 2.509°/s, one area light, black world, and zero material emission. Source
now records renderer/sample quality and checks the animation operator result.

Actually viewed the matched six-image renderer comparison, five new low-res
samples, sample-count/denoiser HD comparisons, all five final HD samples, and
desktop/phone hero screenshots. Early connector recess illumination disappears
in Cycles; the broad side lights before the face. Chrome confirms twelve-second
HD decode, no poster and natural next-film handoff in both viewports, with no
script errors. Website build/lint passed. Private preview and kit refreshed;
the Mini poster now uses the revealed 75% sample rather than its dark midpoint.

### Detail-view scale comparison — 10 October 2026

Double-click/tap detail view opens with an ISO/IEC 7810 ID-1 credit-card
reference, 85.60 × 53.98 × 0.76 mm, sharing the product's metre-based CAD
coordinates, orbit and zoom. The `Size reference` toggle controls both card
and width/depth/height labels and resets to visible on each new detail opening.
The values are the saved model's overall bounds, including projecting parts:
Mini 76.4 × 62.8 × 17.2 mm; Splanc 106.4 × 87.8 × 17.2 mm; MAX 339 × 134 × 43 mm.
Source for ID-1 dimensions: https://committee.iso.org/standard/31432.html?browse=ics.

As Sensors opens the case, the card and all dimension labels fade out with
the explosion animation. They fade back in on closing only if their toggle
remains enabled. Exploded framing excludes the hidden reference. The reference
geometry and texture are disposed on return to flight; shared product meshes
and the electrical/mechanical source snapshots are unchanged.

`advertising/check_scale_reference.mjs` drives real double-click/tap entry for
all three products on desktop and phone layouts, checks intermediate fade
opacity, fully hidden/open and visible/closed states, retains a disabled toggle,
and verifies default-on reset, exact flight restoration and the continuing LED
chase. Chrome passes all six cases. The existing interaction check also passes
orbit, wheel, pinch, background/X/Escape exit and reduced-motion behavior.
Actually inspected the three desktop and phone closed-case compositions and
six exploded compositions; the final requested fade removes the reference
from the exploded view. Review evidence is under
`output/advertising-kit-20261008/review/size-*` and
`scale-reference-validation.json`.

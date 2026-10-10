# Advertising kit, 8 October 2026

Current local output: `output/advertising-kit-20261008`.
Private gallery: `http://mac-mini.tail6b8ad3.ts.net:8767/advertising-kit/`.
Standalone animation: gallery path plus `sim/` (add `?embed=1` for minimal controls).

The kit contains 13 full-HD stills (four angles per enclosure plus family),
five silent H.264 1920×1080/24 fps clips (three four-second camera orbits,
four-second diagonal Mini roll, five-second family pullback), a self-contained
Three.js animation and a formula-driven pricing workbook with MAX r11 BOM.
GNSS is a stuffing option sharing the Splanc exterior. The original PNGs,
web JPEGs, simulation, prices, BOM and integration instructions are in the
advertising ZIP; packed Blender scenes stay separately in the output directory.
Generated binaries are ignored by Git. No public hosting or release publication.

## Frozen geometry and reproducibility

`render_advertising.py` reads the saved `output/max-service-r11/scene.json`,
which incorporates handheld r10 and MAX r11, and retrieves approved material
and HDRI data from `output/blender-motion-studio-r4/splanc-motion-studio.blend`.
It never rebuilds electrical boards or edits PnR work. Use Blender 4.5.9:

```
blender -b -t 4 --python hardware/mechanical/render_advertising.py -- --mode stills
blender -b -t 4 --python hardware/mechanical/render_advertising.py -- --mode videos
blender -b -t 2 --python hardware/mechanical/render_advertising.py -- --mode web
```

Stills use Cycles/Metal, 64 samples, denoising; video uses Eevee, 48 samples.
Motion is deliberately editable via named product pivots, lights and camera
keys in the separately packed scenes. The macro shot has no visible backdrop;
the other shots use the charcoal studio surface. Camera clips are motion
masters for editing, not a claim of production photography.

`advertising/package.py` assembles the gallery into a bounded subdirectory of
the existing mechanical viewer, avoiding access to source, runtime or unrelated
work. All browser dependencies are local. Binary geometry is grouped by
material and gzipped; hidden PCBs and internal harnesses are omitted from the
web model. The simulation retains relative dimensions and uses fixed-step
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
assembly/test, enclosure and tooling amortization over 1,000 units. Proposed
$569 gives 40.8% gross margin; Pi/cooler/storage/external supply and cables are
excluded. Previous $299 estimate is historical for the earlier configuration.
Mini $52.99, Splanc $109 and GNSS option $139 retain September sourcing.

New supplier references: TRACO THL40-2411WI $58.7923 at100, KSZ9896CTXI $12.7625
at100, NE8FDP $11.02934 at500 (two per MAX). Existing applicable tiers are
carried forward without an unverified volume discount. New power protection,
network passives/magnetics/controller and harnesses remain allowances. RFQ,
allocations, detailed circuit completion and tooling quotes are outstanding.
Source URLs, dates, line quantities, assumptions and cost scenarios are in the
machine-readable model, CSV, workbook and HTML sheet.

## Validation recorded

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

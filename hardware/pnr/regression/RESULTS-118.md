# Native PnR ladder and initial placement pool — round 118

All 8 fixture designs, each with seeds 0 and 1, passed the exact native saved-board
gate: 0 unconnected items, 0 KiCad DRC findings, preserved pin/net assignments,
source track widths and qualified tracked SMD pad entry. Runtime Python sources
were frozen before each run and their copied hashes verified after completion.
The ladder exercises the PnR backend from native circuit manifests; it does not
claim an atopile-to-final Splanc board or validate analog circuit behavior.

## Complete ladder

Run: `output/pnr-regression118/qualified-ladder-v2`

| Fixture | Seed | Vias | Copper mm | Total seconds | Native opens/findings |
|---|---:|---:|---:|---:|---:|
| 01-connector-led-2 | 0 | 0 | 9.27 | 4.5 | 0 / 0 |
| 01-connector-led-2 | 1 | 0 | 9.27 | 4.2 | 0 / 0 |
| 02-resistor-led-3 | 0 | 0 | 15.86 | 4.2 | 0 / 0 |
| 02-resistor-led-3 | 1 | 0 | 18.35 | 4.4 | 0 / 0 |
| 03-branched-leds-5 | 0 | 0 | 31.33 | 4.5 | 0 / 0 |
| 03-branched-leds-5 | 1 | 1 | 32.15 | 4.8 | 0 / 0 |
| 04-inverter-leds-8 | 0 | 7 | 90.91 | 7.2 | 0 / 0 |
| 04-inverter-leds-8 | 1 | 5 | 88.48 | 7.9 | 0 / 0 |
| 05-timer-led-10 | 0 | 7 | 120.12 | 9.5 | 0 / 0 |
| 05-timer-led-10 | 1 | 5 | 149.11 | 38.3 | 0 / 0 |
| 06-chaser-14 | 0 | 16 | 285.04 | 24.0 | 0 / 0 |
| 06-chaser-14 | 1 | 12 | 237.93 | 27.1 | 0 / 0 |
| 07-chaser-20 | 0 | 20 | 371.66 | 43.3 | 0 / 0 |
| 07-chaser-20 | 1 | 27 | 377.59 | 94.6 | 0 / 0 |
| 08-chaser-20-plane | 0 | 28 | 312.31 | 68.8 | 0 / 0 |
| 08-chaser-20-plane | 1 | 28 | 336.02 | 158.4 | 0 / 0 |

An earlier failing ladder (`ladder-first`) is preserved: 8/10/14/20-part cases
remained open. The fixes include coordinated pin-access selection, treating NC
pads as foreign copper rather than oversized opaque blocks, searching with the
same width/via envelope used during commit, deriving via transitions from real
edges rather than coincident XY cells, actual drill/PTH ingestion and reuse, and
source-sized plane-access traces. No fixture nets/pins were deleted or relaxed.
The native oracle was also tested with intentionally opened and shorted copies
of a passed 2-part board; both faults were detected. See
`output/pnr-regression118/baseline/01-connector-led-2-seed-0/negative-controls/result.json`.

## Initial pool, native comparison

Run: `output/pnr-regression118/initial-pool-native`, seed 0. Eight unique legal
starts, three routed finalists, fixed outline/connector and the same per-finalist
detail budget. Start05 won both comparisons. The pool adds total computation:
this is a quality improvement for these examples, not a measured speedup.

| Fixture | Baseline vias → pool | Copper mm | Total seconds | Native opens/findings |
|---|---:|---:|---:|---:|
| 04-inverter-leds-8 | 7 → 4 | 90.91 → 72.93 | 7.2 → 15.6 | 0 / 0 |
| 08-chaser-20-plane | 28 → 26 | 312.31 → 274.30 | 68.8 → 174.9 | 0 / 0 |

Final ground-plane access is included in these final via/length metrics. The
initial pool itself uses a capacity proxy and detailed-route screening; native
acceptance of the chosen result remains downstream. This experiment predates the
new hard-side constraint / source TP1 release, which are tested separately.

## Visual evidence and remaining issues

`output/pdf/pnr-regression118` contains paired clean/annotated pages for every
enabled layer of all eight seed-0 cases (388 pages). Every copper page was
actually viewed individually, all technical pages through contact sheets; each
SHA-bound review ledger passed the verifier. Default footprint fabrication text
is crowded in several cases. These are circuit regression drawings, not release
assembly documentation. Seed-1 results have native checks and full via-cluster
review, but do not have all-layer PDFs in this bundle.

All 16 cases have 5mm proximity scans, and all 21 clusters were actually viewed.
Most small two-layer pairs are real crossing excursions. Remaining targets:

- Inverter seed0 VCC can potentially reuse J1.1 instead of a nearby added via.
- Chaser20 seed1 RESET has a plausible short front-surface detour instead of a
  two-via excursion; this needs native testing.
- Plane case seed1 U2.8/C4.2 and D1.1/D3.1 ground ports have visibly clear nearby
  sharing opportunities. Other plane ports straddle signals and need checked
  detours, not blanket merging.
- Long LED2 detours, remote decoupling and excess empty area demonstrate why
  first-placement exploration and source proximity constraints still matter.

Cluster observations live in each `via-scan/visual-review.json`; no via was
deleted based on proximity alone. A DRC closure pass is not a claim of optimal
placement, minimum via count, manufacturing readiness, or complete Splanc routing.

Paired PDFs for the initial-pool native results are under
`output/pdf/initial-pool118`; their independent ledgers record actual review.
Full116 remains paused and protected fresh28 is unchanged.

# Mechanical/electronics review — 2026-09-21

The MAX electronics draft and both enclosure studies are ready for design review.
Assumptions are Pi 5 with official Active Cooler, 12/24 V LED supply, twenty 2 A
channels, 40 A aggregate. Ratings remain design targets. No routing or manufacture
was requested for MAX. The running Mini routing experiment was not restarted.

| Item | Board size mm | Enclosure outside mm |
|---|---:|---:|
| Mini | 70 × 55 × 1.6 | 76.4 × 61.4 × 20 |
| MAX LV / Pi header expansion | 85 × 56 × 1.6 | 315 × 134 × 53, shared |
| MAX power | 180 × 120 × 1.6 | shared |
| MAX rigid USB jumper | 24 × 40 × 1.6 | internal, vertical |

The Mini has a two-part shell, four separate button caps, two light pipes,
top-entry JST cable apertures, USB, microphone and bottom pogo access. Four M2.5
mounts are taken directly from the PCB. Upper mounting stack reserves 1.7 mm for
spacers/washer clearance; fastener lengths, button travel and fits need print trials.
The MAX power board sits beside the Pi/HAT stack. Two 160 × 8 × 2 mm copper bars,
M5 lug windows, twenty output windows, cooler space and a 32 mm ribbon clearance
band are represented. Ribbon and component envelopes are reservations, not exact
supplier models. Busbar taps, insulating guards and attachment details remain open.

## Estimated unit costs at 1,000 units (USD)

| Item | Component BOM | PCB + assembly + test | Electronics subtotal |
|---|---:|---:|---:|
| MAX complete board set/ribbon | $144.43 | $21.70 | $166.13 |
| Mini, historical BOM | $24.01 | $3–6.50 | $27–30.50 |

MAX electronics estimate range: $121.69–232.11. Pi, storage, LED power supplies,
shipping and tax excluded. Separate enclosure allowance: MAX $31/unit in a first
1,000-unit molded batch ($9 recurring plus $22 tooling allocation); Mini $11
($3 recurring plus $8 tooling allocation). These are budget assumptions, not
supplier quotes. The BOM budget includes explicit completion reserves for not-yet-fitted protection and EEPROM parts. Source/pricing tier distinctions and machine-readable BOM are in
`../splanc_max/costing/` and `../../docs/hardware/splanc-max-costing.md`.

## Validation and limits

All three MAX atopile designs compiled; an independent checker matched 1,120 pad
assignments to native net partitions. Native KiCad DRC has zero violations, with
226 LV / 499 power / 8 jumper opens expected from intentionally unrouted boards.
Generic signal atoms do not establish functional power ERC. Final connector and
FPGA footprints, input fault protection, regulator budgets and USB behavior need
electrical review before routing/release.

Both shells pass STEP re-import, single-solid and shell-overlap checks. The Mini
fit check uses the available populated native STEP model; missing component CAD
and mating cables are excluded. Reviewed assembled/exploded images show distinct
JST openings, four button caps, MAX dual connector rows and separated power/Pi
bays. Full MAX manufacturer-model collision checks and USB mating-stack checks
remain outstanding. PCB envelope checks alone do not prove assembled fit.

STEP parts are printable engineering prototypes. Injection mold draft, tooling,
material choice, lug protection/strain relief and thermal qualification are not
complete. No production-ready claim is made.

## Connector coordinates

Coordinates below are PCB-local millimetres: origin at outline lower left,
X right and Y toward the rear. Native-board extraction and source hashes are in
the output bundle. MAX connector mouths come from `interface.json`; Mini entries
are footprint anchors, with enclosure cutouts following `mini-ports.json`.

| Board | Reference | X | Y | Access |
|---|---|---:|---:|---|
| Mini | USB1 | 14 | 3.5 | south |
| Mini | CN1 | 64 | 20 | top |
| Mini | CN2 | 64 | 31 | top |
| Mini | SW1 | 42 | 3.5 | south |
| Mini | SW2 | 34 | 3.5 | south |
| Mini | SW3 | 51 | 3.5 | south |
| Mini | SW4 | 59 | 3.5 | south |
| Mini | LED1 | 22 | 4 | top |
| Mini | LED2 | 26 | 4 | top |
| Mini | MIC1 | 63 | 10 | bottom |
| Mini | TP1 | 45 | 13.5 | bottom |
| MAX lv | J2 | 85 | 29.1 | east |
| MAX lv | J3 | 65 | 12 | internal |
| MAX power | J1 | 28 | 60 | internal |
| MAX power | J2 | 0 | 45 | west |
| MAX power | J3 | 0 | 75 | west |
| MAX power | J10 | 13.5 | 0 | north |
| MAX power | J11 | 30.5 | 0 | north |
| MAX power | J12 | 47.5 | 0 | north |
| MAX power | J13 | 64.5 | 0 | north |
| MAX power | J14 | 81.5 | 0 | north |
| MAX power | J15 | 98.5 | 0 | north |
| MAX power | J16 | 115.5 | 0 | north |
| MAX power | J17 | 132.5 | 0 | north |
| MAX power | J18 | 149.5 | 0 | north |
| MAX power | J19 | 166.5 | 0 | north |
| MAX power | J20 | 13.5 | 120 | south |
| MAX power | J21 | 30.5 | 120 | south |
| MAX power | J22 | 47.5 | 120 | south |
| MAX power | J23 | 64.5 | 120 | south |
| MAX power | J24 | 81.5 | 120 | south |
| MAX power | J25 | 98.5 | 120 | south |
| MAX power | J26 | 115.5 | 120 | south |
| MAX power | J27 | 132.5 | 120 | south |
| MAX power | J28 | 149.5 | 120 | south |
| MAX power | J29 | 166.5 | 120 | south |
| MAX usb_bridge | J1 | 12 | 7 | internal |
| MAX usb_bridge | J2 | 12 | 33.4 | internal |

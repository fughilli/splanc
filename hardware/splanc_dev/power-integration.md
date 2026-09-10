# Splanc factory power revision — engineering status

This revision is **not ready for fabrication**. It builds both factory assemblies,
but routing, power transients, thermal design and production firmware remain open.
Do not use the old manufacturing/checkpoint archive as a fabrication package.

## Implemented power path

USB-C → TPS25730D protected sink → LTC4421 priority input 1.
Protected 1S/2S battery → LTC4421 input 2.
LTC4421 output → TPS552882 buck-boost → regulated 5V → TLV62569 → 3.3V.
A separate BQ25798 branch charges the battery from negotiated USB power. Its SYS
node carries only local decoupling, not the system load. This avoids the charger
BATFET's 6A DC limit in the high-current 1S discharge path.

The TPS25730D requests up to 20V/5A, with 5V minimum and 1.5A operating current.
The connector/charger/system do not automatically have a 100W load budget.
Firmware must read the actual contract, account for the cable current limit,
reserve system power, and limit charging to the remainder. Charger input is
limited to 3.3A; initial ILIM_HIZ clamps it to roughly 0.2–0.4A. CE is pulled high
and a transistor permits charging only when GPIO11 is actively high.

CC protection uses the routable WQFN TPD6S300A powered by the PD controller's VBUS-derived LDO. Its VPWR capacitor table specifies 0.3µF minimum and 1µF nominal, with no maximum; the local 1µF and shared LDO bulk do not conflict with that table.
TPD2EUSB30A protects USB data; TVS2200 clamps raw VBUS. Clamp margin against the
PD controller's 28V absolute maximum, including PCB inductance and temperature,
requires validation; this is not a claim of passing any ESD/surge standard.

The GCT USB4105-GF-A-060 receptacle replaces the previous 5V/3A SHOUHAN part.
Its manufacturer specifies 5A collectively on VBUS and 48V DC. Imported locator
holes and shell slots were corrected against the GCT drawing; ground/VBUS land
heels have a documented 0.10mm relief for hole clearance.

Mux input MOSFETs are now PSMN4R2-80YSE enhanced-SOA devices; output MOSFETs
remain CSD18540Q5B. The battery sense element is one WSL25122L000FEA 2mΩ/1W shunt;
9.90–15.15A are room-temperature controller/1% resistor bounds. Include its
±275ppm/C TCR in hot/cold fault limits (at 85°C, approximately 9.74–15.41A
using a conservative additive 2.65% resistance bound). The USB sense element
is one PA1206FRE470R005L 5mΩ/1W shunt, giving 3.96–6.06A at room temperature.
These fault thresholds are not continuous load budgets.
Timer maximum is about 3.23ms; assess at least the 10ms SOA curve at the actual
mounting-base temperature. Hold-up and thermal validation remain open.

The current 120µF nominal selected-bus bank is insufficient to guarantee a
low-battery, full-load 1S-to-USB transfer. Even at 100% efficiency, zero ESR and
full nominal capacitance, 3.13V to 2.7V at 20W provides only 7.52µs. Supporting
15µs in this idealized window requires 239µF effective capacitance; actual
losses, bias derating, path drops and gate loading worsen the bound. Reproduce
with `hardware/tools/power_hold_up.py --capacitance-uf 120 --start-v 3.13
--minimum-v 2.7 --load-w 20 --efficiency 1 --delay-us 15` (one command line).
TPS552882 permits 2.7V while running; its rising startup threshold reaches 3.0V.
The 15µs data-sheet bound is specified with 47nF gate loading; confirm timing
with the assembled MOSFET pair. Adding bulk alone also lengthens the USB
inrush current-limit interval, so capacitance, timer, MOSFET SOA and low-voltage
load policy must be solved together. GPIO15 now drives a normally-off NPN that can pull the USB channel's active-low
DISABLE input down. The default pullup allows USB-only boot. Firmware must
assert holdoff before enabling high LED load on battery, verify the actual USB
contract, turn LEDs and charger off, confirm current has fallen, release holdoff,
and wait for GPIO10 to report USB selected and INA226 to confirm the 5V rail
before restoring load. The converter PG remains available as a board net. This avoids asking the linear
USB mux to raise a 3V bus while supplying a 20W constant-power load. Firmware
implementation and measured logic-only hold-up remain release blockers.
GPIO15 is a JTAG-source strap only when JTAG_SEL_ENABLE is fused; keep that eFuse
at its default 0 for this assembly (native USB JTAG remains the default).


## Factory configuration

`default` instantiates SplancDev1S; `factory_2s` instantiates SplancDev2S.
PROG is 3.0k/6.04k respectively, selecting 1.5MHz charging. LTC4421 battery
window top resistors are 100k/220k. Parallel count changes pack capacity and
factory provisioning, not PCB straps. All six profiles are in factory_profiles.json.
Cell model, charge current, protection settings, chemistry ID and calibrated
fuel-gauge images remain unset; no profile is released.

BQ34Z100-G1 measures current through a 5mΩ/3W low-side shunt. Its ground is on
the pack side; all main-board current crosses the shunt. TPS70933 protects its
supply from 2S voltage. Both variants use a 200k/20k 0.1% voltage divider and
require VOLTSEL=1, nominal Voltage Divider=11000, the correct series count, and
factory calibration/learning. Do not flash below the gauge's allowed supply range.
The pack must contain its own protection and, for 2S, balancing.

XT30 carries battery current. Two separate pack-mounted 103AT thermistors use
separate 2-pin connectors: one for the charger, one for the gauge. Their bias
circuits differ and the thermistors must not share signal/return wires. The
charger temperature-window values must be finalized against the selected cell.

## Remaining work

- Complete source-footprint validation, routing and independent KiCad DRC. The
  placement study is 85×65mm, four layers. Mechanical size is provisional.
- Size LTC4421 hold-up capacitance and fault timers for full-load source removal;
  validate MOSFET SOA and battery undervoltage tolerances. Current 100uF nominal
  bus capacitance is not yet proven to prevent a 1S switchover brownout.
- Validate TPS552882 compensation, effective ceramic capacitance under DC bias,
  saturation/ripple limits and thermal performance. Current values are preliminary.
- Place high-current copper, Kelvin sensing, decoupling and switching loops with
  electrical intent; a zero-overlap placement alone does not satisfy this.
- Preserve the ESP antenna keepout and compass distance from magnetic/current
  sources; keep traces/vias out from below the MPU exposed die. Mic requires an
  open 0.5mm non-plated acoustic hole and a matching enclosure aperture.
- Account for thermal vias in assembly process/stencil design. Imported vias
  with no net are now tied to the devices' ground pad and have no paste layer.
- Implement and test contract-aware power management, sensors and gauge drivers.
  Firmware pin definitions now match GPIO10=USB-selected input, GPIO11=charger enable and GPIO15=USB holdoff;
  the current engineering firmware intentionally leaves LEDs/charging disabled.
- Legacy EoL pins 1/3/4 are disconnected to prevent 20V/2S reaching old tester
  circuits. Power this revision through USB-C; update the tester protocol/fixture.
- Generate fabrication files only after checks pass. Product shots must come
  from the final routed CAD, with renders clearly identified as renders.

## Checks completed

Both factory assemblies build with atopile 0.15.8. The generated-board audit
`hardware/tools/check_splanc_power.py` passes 44 critical connection/footprint
checks for each assembly, and the placed-board audit additionally checks the MPU
copper keepout. The current 227-component placement has zero KiCad DRC violations
before routing, with 499 unconnected items in each factory assembly. An earlier
placement reached 360 unconnected items after a bounded route and plane refill,
but its power support parts were too far apart; that routing is superseded.
Source-address placement selectors and net-endpoint routing selectors survive
reference/net renumbering; unknown endpoints fail closed. Placement now bounds
offset component bodies around their actual origins, and writeback repairs cloned
child UUIDs so KiCad diagnostics identify the correct component instance.
The full router Python suite passes 114 tests with 7 environment-dependent skips;
14 KiCad writeback tests and 6 KiCad ingest tests also pass. All 227 component
instances now have packaged 3D assets; the PD controller and microphone use
dimensioned simplified bodies, and the barometer uses a representative supplier
model; the Vishay shunt uses a representative 2512 body. These renders are engineering placement studies.
The routing power class now covers 21 distinct nets, including the pack return,
source-selector intermediate nodes, converter/charger switch nodes and LED
outputs. Its 1.5mm width is only a study constraint: high-current copper areas,
short switching loops and Kelvin sense branches still require implementation.
These checks do not establish fabrication or product readiness.

## Primary design sources

- https://www.ti.com/lit/ds/symlink/tps25730.pdf
- https://www.ti.com/lit/ds/symlink/bq25798.pdf
- https://www.analog.com/media/en/technical-documentation/data-sheets/ltc4421.pdf
- https://www.ti.com/lit/ds/symlink/tps552882.pdf
- https://www.ti.com/lit/ds/symlink/csd18540q5b.pdf
- https://www.ti.com/lit/ds/symlink/bq34z100-g1.pdf
- https://www.ti.com/lit/ds/symlink/tps709.pdf
- https://www.ti.com/lit/ds/symlink/tpd6s300a.pdf
- https://www.ti.com/lit/ds/symlink/tpd2eusb30a.pdf

## Placement correction

Clearance-clean placement alone hid a power-integrity problem: converter
bootstrap/decoupling parts had been scattered 20–34mm from the IC. Hard group
radii now survive legalization and reject impossible placements. Selected
converter, charger and PD support parts have a 5mm centre-distance ceiling,
while the converter FETs/inductor and charger inductor have separate bounds.
The revised placement passes the independent hard-group metric and KiCad DRC
for both assemblies. These ceilings still require pad-specific placement and
short switching/return paths; they do not establish an acceptable switching loop.

The added hard-group tests plus constraint regressions pass 23 tests. The full
placement/orientation regression selection passes 15 tests. Both revised placed
boards pass all 45 source/footprint/keepout audits.

## PD host-interface implementation reference

TI SLVUCJ7 defines ACTIVE_CONTRACT_PDO at 0x34 (six payload bytes; the
first four form the little-endian accepted source PDO) and ACTIVE_CONTRACT_RDO
at 0x35 (four little-endian payload bytes). Both clear on disconnect, hard reset
or power-role swap. I2C reads include a byte-count prefix. Firmware must treat
a cleared/inconsistent contract or bus error as invalid permission for high
load/charging, rather than retaining a stale 20V/5A allowance. Read and validate
these registers before releasing USB holdoff and allocating charge input current.
The register decoder and power state machine are not yet implemented.

Reference: https://www.ti.com/lit/ug/slvucj7/slvucj7.pdf

## Review corrections: connector alignment and LED port array

The XT30 STEP Y offset was -1.01 mm; it is now -3.50 mm. Measured model
power-contact axes and both mounting-post axes align with the four footprint
holes after this 2.49 mm correction. Pad geometry and circuit nets are unchanged.

Twelve oversized 2512 shunts were inherited from a single generic 10mΩ part.
They are now six application-specific parts: two CSRF0805FT10L0 10mΩ/0.5W
LED shunts, one PA1206FRE470R01L 10mΩ/1W converter shunt, one
PA1206FRE470R005L 5mΩ/1W USB shunt, one WSL25122L000FEA 2mΩ/1W
battery-mux shunt, and one RLP25FEGMR005 5mΩ/3W gauge shunt. Resistor
power at 2.5A LED, 5A converter/USB, and 10A battery is respectively
0.0625W, 0.25W, 0.125W, 0.2W and 0.5W. Thermal derating and Kelvin routing
still apply. Other large tan/yellow rectangles in the render are bulk capacitors.

`constraints.yaml` now defines one 13-member LED port cell, expanded for
`board.led0` and `board.led1` at 11 mm pitch along the east edge. Positions,
rotations and side are shared. The eFuse input faces the incoming shunt and
its output faces the connector. The level-shifter B pin faces the termination
resistor. This is a replicated placement template; internal copper routing
has not yet been templated or completed. The constraints compiler rejects
missing members, duplicate instances and conflicting fixed selectors.

Sources for shunt selection/land patterns:
- https://www.vishay.com/docs/30100/wsl.pdf
- https://www.seielect.com/catalog/sei-csrf.pdf

The enclosure revision adds four M2.5 mounting holes, side-actuated buttons,
parallel edge LED headers, and two status indicators. See `enclosure-interface.md`
for dimensions and mechanical validation limits.

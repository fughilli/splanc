# MINI-EOL-V1 — Splanc Mini factory contact interface

Status: engineering interface revision 1, 2026-09-09. Mini placement and the passive
pogo carrier are generated; routing, fixture mechanics, controller adaptation,
and physical qualification are not released. This interface is specific to Mini.
It is **not electrically compatible with the legacy Splanc 2×10 EoL header**.

The normative coordinate and pin file is `hardware/interfaces/mini-eol-v1.json`.
`hardware/tools/generate_mini_eol.py` generates both mating footprints from it;
`--check` detects stale footprints. Any change to contact positions, signal
meaning, voltage class, or mating datum requires a new interface revision. Board
revision and interface revision are separate identifiers.

## Mechanical contract

Mini is 70 × 55 mm, four layers, nominal 1.6 mm PCB thickness. It has four
2.7 mm NPTH M2.5 holes at (4,4), (66,4), (66,51), (4,51) mm. A 7 mm diameter
all-copper and placement exclusion around each hole reserves the screw/boss
space. The 20 contact centers form four columns and five rows at 2.54 mm pitch.
The array center is (45,13.5) mm. Pads are 1.60 mm diameter exposed copper on
B.Cu/B.Mask only, with 0.05 mm radial mask expansion and **no paste or drill**.
Use ENIG for the DUT landing surface; prohibit solder coating, ink, adhesive,
exposed vias, and component bodies in the landing area. Review wear on actual
boards before adopting a repeated-use rework process.

All coordinates use the **DUT top-view projection**, origin at the lower-left
outline corner, +X right and +Y up. The USB and button edge is Y=0. A fixture
viewed from above has the same X/Y projection; the DUT sits component-side up
above it. Thus fixture contact N and DUT pad N have identical physical X/Y.
A direct underside drawing made by turning the DUT over left-to-right mirrors X:
`X_underside = 70 − X_top`, `Y_underside = Y_top`. Do not renumber after mirroring.
The footprint generator accounts for KiCad's bottom-side flip explicitly.

In the shared top projection, pad centers run:

```text
Y=18.58:   1   2   3   4
Y=16.04:   5   6   7   8
Y=13.50:   9  10  11  12
Y=10.96:  13  14  15  16
Y= 8.42:  17  18  19  20
X:     41.19 43.73 46.27 48.81
```

Reserve at least the 10.5 × 13 mm bottom-side contact envelope centered on the
array for probe access. Top-side SMD parts may occupy this XY region. Maintain
at least 0.5 mm from each exposed contact edge to any other exposed conductor;
routes may leave pads under solder mask. The bottom courtyard reserves probe
access; it is not an all-layer copper keepout, which would prohibit the pads.
Internal planes and covered routing remain permitted.

The fixture uses a rigid nonconductive nest and positive stroke stops. Locate
from the two lower mounting datums using one round and one relieved/diamond
locator; the other holes support the board without overconstraining it. Control
contact-to-pad **total radial misalignment to at most 0.30 mm**. This is an
assembly acceptance limit including PCB registration, locator clearance,
fixture manufacture, pin tilt, and seating repeatability—not a claim that
standard PCB tolerances automatically meet it. Qualify with a gauge coupon.
A tip envelope no larger than 0.80 mm leaves at least 0.10 mm radial margin on a
1.60 mm pad at that worst-case displacement.

Use a keyed nest that only closes with the USB opening at Y=0 and the LED
connectors at X=70. The rectangular mounting pattern alone cannot distinguish a
180° rotation. A lid-closed switch plus the mechanical USB/LED housing key must
interlock fixture power. A silk pin-1 mark is an assembly aid, not a safety key.
Clamp on the four mounting keepout regions; do not load the sensor packages,
antenna, microphone port, buttons, or light-pipe lenses. Add insulated local
support outside the contact envelope if measured PCB deflection requires it.

A candidate fixture contact is **Mill-Max 0906-0-15-20-76-14-11-0**, 20 pieces.
The manufacturer's sheet specifies 3.480 mm free height and 0.991 mm travel.
Start the mechanical stack study at a 2.98 mm contact-plane gap (approximately
0.50 mm compression). Accept 0.30–0.70 mm actual compression across all contacts;
set stops and shim the carrier after measuring the assembled height and board
flatness. Do not rely on a nominal 3 mm spacer alone. The proposed footprint
uses 0.65 mm finished PTH holes and 1.4 mm copper lands at the shared centers.
Check the selected pin's tip/body/tail drawing and finished-hole tolerance with
the assembler before freezing that footprint. The datasheet's 60 gf spring
figure corresponds to about 12 N total for 20 contacts; design the clamping
structure with margin and verify the actual force/stroke relationship.
[Manufacturer datasheet](https://www.farnell.com/datasheets/3820075.pdf).

## Electrical contract

All directions below are relative to the DUT. Pads are test-only, not a power
input or a load-current connector. Pins 1–4 are common ground. Pins 5, 6, 9 and
10 are high-impedance voltage observations. **No raw USB VBUS, battery rail, or
power-injection pin is exposed.** USB-C is the only DUT power input; full-power
testing uses an appropriate PD source and cable. Test loads plug into the two
LED JST connectors so the production power contacts are also exercised.

- **1–4 GND:** four redundant signal-reference/continuity contacts. Limit total
  intentional fixture signal return to 20 mA; load returns use the LED cables.
- **5 5V_SENSE:** regulated 5 V before channel switches. Fixture measurement
  input rated for at least 0–5.5 V, ≥100 kΩ input impedance.
- **6 3V3_SENSE:** DUT logic supply observation and output-enable interlock;
  same ≥100 kΩ measurement impedance. Never power the tester from this pad.
- **7 CH0_FAULT_N; 8 CH1_FAULT_N:** active-low digital fault observations,
  referenced to DUT 3.3 V. These are not analog current-sense outputs. Read
  current through the INA226 telemetry under DUT firmware control.
- **9 CH0_5V_SENSE; 10 CH1_5V_SENSE:** switched LED rail observations, 0–5.5 V
  measurement range, ≥100 kΩ. No load or short-circuit testing through these pads.
- **11 CH0_DATA_3V3; 12 CH1_DATA_3V3:** outputs tapped at MCU GPIO0/GPIO1,
  before the 5 V translators. Observe only. Test the translated signals at the
  LED connectors when validating the full output path.
- **13 I2C_SDA; 14 I2C_SCL:** shared sensor/power bus, DUT pullups to 3V3A.
  The fixture is a passive monitor by default; no added pullups. Fixture drive
  is allowed only after an explicit test-firmware handover leaves the DUT bus
  idle and releases both pins. Open-drain only, initially 100 kHz. Keep added
  fixture bus capacitance ≤20 pF and verify rise times on the assembled system.
- **15 RESET_N:** ESP EN input. Fixture may only sink through an open-drain or
  open-collector stage, or disconnect.
- **16 BOOT_N:** GPIO9; same sink-only control.
- **17 USER1_N; 18 USER2_N:** GPIO22/GPIO23 button emulation; same sink-only
  control. Avoid uncommanded pulses during power-up or fixture connection.
- **19 UART_TX_DUT:** DUT UART0 output to fixture RX.
- **20 UART_RX_DUT:** DUT UART0 input from fixture TX. Use a DUT-voltage-referenced
  buffer with output enable, unpowered isolation, and series current limiting.

All digital observations are ≥1 MΩ and ≤10 pF unless the I2C limit above applies.
Do not apply 5 V logic. Fixture-driven high levels must follow DUT 3.3 V;
normal-operation pin voltage stays between GND and the measured DUT logic rail.
When DUT 3V3 is below 3.0 V, **all fixture digital outputs must be high impedance**,
including UART, I2C and button stages; specify ≤1 µA off-state leakage per pin.
Never connect an always-powered UART TX directly to an unpowered Mini.
Use buffered/limited inputs for the four rail sense pads; a 3.3 V ADC cannot be
connected directly to the 5 V sense nets. Signal ground must not become the
alternate return for failed LED load cabling; interlock the load connectors
and check their ground continuity before enabling loads.

## Test sequence and programming

1. Disable PD output and loads; place all fixture outputs in high impedance.
   Seat the board in the keyed nest, close and verify the clamp. Check ground
   continuity between redundant contacts with a limited stimulus (≤1 mA).
2. Connect the USB-C and both LED load cables while de-energized. Enable PD,
   verify DUT 3.3 V/5 V rails, then enable buffered UART observation. Contract
   and current limits remain enforced by Mini firmware and the hardware eFuses.
3. For ROM programming, hold BOOT_N low, pulse RESET_N low for 50 ms, release
   RESET_N, keep BOOT_N low for a further 100 ms, then release it. Use UART0 at
   an initial 115200 baud; qualify higher rates separately. Mini now includes
   a 10 kΩ GPIO8 pullup because ESP32-C6 requires GPIO8 high and GPIO9 low for
   joint download boot; GPIO8 otherwise floats. After programming, release
   BOOT_N and pulse RESET_N to enter normal SPI boot. Do not burn eFuses as part
   of this interface qualification.
   [Espressif boot configuration](https://documentation.espressif.com/esp32-c6_datasheet_en.html),
   [download guidelines](https://docs.espressif.com/projects/esp-hardware-design-guidelines/en/latest/esp32c6/download-guidelines.html).
4. Run test firmware for sensor/microphone checks, button/status behavior,
   INA226 readings and both LED paths. Compare rail sense observations with
   firmware telemetry. Drive channel loads only through the LED connectors.
5. Disable loads and every fixture driver, disable PD and verify rails have
   discharged, then open the clamp. Equal-height pins do not guarantee
   ground-first mating; the sequence and interlock are mandatory.

## Implementation boundary and release checks

The delivered pogo carrier is a passive, unrouted board with the mating array,
matching mounting datums, and numbered wire terminations. Its contact BOM is
separate from Mini's fitted BOM. It does not implement the powered-off buffers,
ADC dividers, nest, interlocks, load banks, or test firmware described above.
The existing `SplancEolTester` remains a legacy design and must not be connected
through a simple rewired cable: its pin-1 injection would short to Mini ground,
and its load/ADC assumptions are different.

Before fabrication release: route and review both PCBs; run full DRC; inspect
landing finish and probe alignment on a coupon; qualify off-state leakage,
orientation rejection, stroke/force/flatness, fixture grounding and rails;
verify ROM programming on blank devices and the functional test sequence on
hardware. The manufacturing release must record the exact pin MPN, datum and
stack tolerances, carrier revision, interface revision, and test firmware hash.

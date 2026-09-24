# Splanc MAX — two-board engineering draft

This project reserves 20 independently switched, sensed and isolated-data LED
outputs. It is a **rough, unrouted design**, not a manufacturing release. Source,
board footprints and enclosure interfaces are reproducible with `tools/generate.py`.
The generator emits atopile atomic components and LV/power entry modules, as well
as the same-netlist native KiCad placement boards when run using KiCad Python with
`--pcb`. Atopile's independent default layout is under `elec/layout`; the rough
placed boards for mechanical work are under `boards`.

- LV: 85×56×1.6 mm, four copper layers, Raspberry Pi 40-pin socket, GW1NR-LV9QN88PC6/I5,
  W25Q32JV SPI configuration flash, FT2232HL USB/JTAG bridge, TXU0304 3.3↔1.8 V JTAG
  translation, independent Pi application SPI and 50-way ribbon.
- Power: 200×120×1.6 mm, four layers, twenty TPS1H100**A** (digital fault)
  switches, four ISO7760F data isolators, one ISO7761F bidirectional SPI isolator,
  three 74HC595 enable/address registers, five quad INA4180A2 current amplifiers,
  five 4051 multiplexers, one MCP3208 ADC and a calibration reference.
- Design target: 2 A/channel, 40 A total, **12 or 24 V input**. These are engineering
  assumptions, not tested continuous ratings. A 5 V-input SKU needs a different
  logic supply/bypass and low-input-voltage qualification; it is not this assembly.
- Proposed positive and return busbars each160×8×2 mm, M5 lugs. At40 A eachbar's
  ideal20°C resistance is~0.172 mΩ and dissipation~0.275 W, excludingjoints.
  Bolts/standoffs, taps and interlayer isolation remain detailed-design work.
- Outputs: ten three-pole 5.08 mm terminals per long edge, pin1 switchedpositive,
  pin2 5 V logic data through100Ω, pin3 powerreturn. Each return reaches PGND through its own20mΩ shunt;
  isolation separates the Pi domain from the complete LED domain, not each strip.
- Ribbon carries no LED loadcurrent. Alternating data/ground pins1–40, clock41,
  MOSI42, latch43, ADCselect44/spare45, MISO46, LV3V3 47, ground48/50, safe-enable49.
  Allribbongrounds are DGND andmustneverjoin PGND.
- Currentlimit1kΩ nominal2.466 A; tolerance requires branch/fusecoordination.
  Gain50 and20mΩ low-side shunts give2V at2A with40mV output-return lift.
  See [TELEMETRY.md](TELEMETRY.md) for scan mapping, settling, limits and costs.
- Enable shiftregister outputs remain highimpedance via pulled-high OE_N until
  isolatedSAFE_ENABLE drives an NPN. Per-switch100kΩ pull-downs keepoutputs off.
  Firmware must load zeros beforeassertingSAFE_ENABLE; default-lowFisolators help.
- USBconnector is a receptacle on HATeastedge. A separate vertical USB-A-male /
  USB-C-male bridge has an electrical module and rough PCB. Exact connector MPNs,
  fabrication pin mapping, USB2 impedance and fitted offsets must be finalized.

`interface.json` defines connector mouths, openings, mounts and rough busbar
geometry in millimetres. `design.json` is the expanded connectivity/placement model.
`electrical-requirements.json` holds machine-readable current/USB rules for later
PnR. The comment annotations in atopile sources are generated from this same data.

## Validation limits and work before routing

The atoms use generic passive signal pins, so a successful atopile ERC cannot
prove power-domain or pin-direction correctness. Custom QN88, IDC, outputterminal,
buckmodule and lug footprints require package/MPN audits. The FPGA EP land is
provisional. The final coarse placement has no detected body-envelope overlaps or native DRC
violations. Isolation corridors still need a dedicated keepout and busbar clearance pass; theoutline is a mechanical
budget, not placementclosure. No coppertracks or planes have been generated.

Audit FPGAconfigurationmode/boot/clock/power sequencing, regulator power andthermal
budgets, USB VBUS detection/self-powered descriptor/reset behavior, ESD andinput
transientprotection, fuses/reverse-polarityprotection, ADC RCsettling andpowerdecoupling.
Add Pi HAT identification EEPROM if formalHAT compliance isrequired (this is a
Pi-header expansionboard now). Core1.2V LDO is a provisionalpowerbudget choice;
FPGA worst-case simulation mayrequire a buck. Do not connectdirectly to 40 A supply
untilinputfaultprotection andconnectorcurrentrating are finalized.

Primary references:
- [Sipeed Tang Nano9K schematic](https://dl.sipeed.com/fileList/TANG/Nano%209K/2_Schematic/Tang_Nano_9k_3672_Schematic.pdf)
- [TPS1H100-Q1](https://www.ti.com/lit/ds/symlink/tps1h100-q1.pdf)
- [ISO776x](https://www.ti.com/lit/ds/symlink/iso7760.pdf)
- [MCP3208](https://ww1.microchip.com/downloads/en/devicedoc/21298e.pdf)
- [TXU0304](https://www.ti.com/lit/ds/symlink/txu0304.pdf)
- [FT2232H](https://ftdichip.com/wp-content/uploads/2024/03/DS_FT2232H.pdf)

KiCad library footprints copied into this project retain KiCad-library licensing
(CC-BY-SA with library exception); custom footprints explicitly carry provisional
status in `design.json`. No externalprocurement was performed.

## Reproduce

```sh
ato build hardware/splanc_max -b lv -b power -b usb_bridge -t build-design -x default -x picker -v
/Applications/KiCad/KiCad.app/Contents/Frameworks/Python.framework/Versions/3.9/bin/python3 hardware/splanc_max/tools/generate.py --pcb
/Applications/KiCad/KiCad.app/Contents/Frameworks/Python.framework/Versions/3.9/bin/python3 hardware/splanc_max/tools/check.py
```

Manual atomic choices deliberately have empty supplier IDs. The build-design
stage compiles the circuits and PCB exports; the LCSC-only default BOM stage is
excluded. `costing/` provides the separate engineering-cost BOM. Final rough
placement uses 0.15 mm minimum clearance (including the 0.4 mm-pitch FPGA lands).
References are on Fab and long component values hidden for this preview.
`tools/place.py` deterministically resolves body/land-envelope overlaps after
initial placement. Routing, creepage, busbar-underbody clearances and thermal
closure remain separate work. Power mounting holes are at y15/105, not y5/115.

USB bridge now has an atopile entry and unrouted PCB. It carries VBUS, D+, D−,
ground and shield; 56 kΩ Rp joins Type-C CC to VBUS for a legacy Type-A source.
Male connector footprints are explicit provisional envelopes, not fabrication
pinouts. VBUS is never joined to the Pi-header 5 V net on the LV board. The
18.4 mm connector spacing is an assembly assumption, requiring a physical fit.

## Recorded checks

Atopile 0.15.8 compiled all three build-design targets successfully. The checked-in
configuration selects this target by default. Procurement metadata is deliberately
empty, so warnings about missing supplier parts are expected; the design does not
claim validated LCSC part choices. `tools/check.py` verified 1,120 connected pad
assignments against the independently compiled atopile net partitions, all board
outlines and mounting coordinates, twenty channels and no existing tracks.

KiCad 10 native DRC reports zero violations for all three rough placed boards.
Native connectivity API unconnected counts are LV 226, power 920 and USB bridge 8. The CLI JSON lists only 499 power-board entries because its report is capped; it is not the complete connectivity count. The
full native reports and file hashes are in `validation/`. These results validate
geometry and netlist consistency, not circuit functionality, voltage compatibility
or thermal ratings. Generic signal pins prevent meaningful power ERC.


The active connectors are DEGSON2EDGRC-5.08-03P-14-100A(H) headers and
2EDGKDF-5.08-03P-14-00A(H) mating plugs (LCSC C669315/C691852).
Official drawing dimensions define the native footprint:17.24×12mm body,
8.6mm abovePCB,3.1mm tails,5.08mm pitch and1.5mm recommended holes.
The normalized actual manufacturer STEP is bundled with the OUT atom;
no model scaling is used. Twenty headers retain19mm center spacing.
Pin rows are9.9/110.1mm so mating mouths lie at0/120mm board edges.
Pin1 is switchedpower, pin2data and pin3 the individual sensedreturn.
Library/model fit still requires physical qualification; this is not a fabricated
sample. Historical cost reports remain archival; current pricing is in
hardware/pricing and the telemetry design update is inTELEMETRY.md.

Coordinate contract: design/interface positions use lower-left origin and +Y upward. Native KiCad positions use `(x, board_height - y)`. Placement and validation use this conversion consistently; header mouth/pad coordinates are recorded in `validation/header-coordinate-check.json`.

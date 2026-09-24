# Splanc module — factory battery and USB PD revision

Product direction is now defined in [Splanc product family design](splanc-product-family.md).
Splanc Mini (USB PD only) is the Kickstarter priority. This document describes
the earlier battery-capable engineering baseline, retained for later Splanc
Battery development; its sensor names and implementation status are historical.

Engineering design in progress; **not released for fabrication**. This document
supersedes the original MCP73831/MAX17048/TPS61088 power architecture. The current
implementation and remaining electrical checks are in
[power-integration.md](../../hardware/splanc_dev/power-integration.md).

## Required behavior

The module includes ESP32-C6 wireless control, MPU6050 motion sensing, BMP280
pressure sensing, QMC5883L compass and INMP441 microphone. Compass and microphone
are populated features. Two independently switched, level-shifted and monitored
5V LED channels share a **4A aggregate application budget**; the individual
hardware fault thresholds are not permission to exceed that budget.

Power comes from USB-C or a protected high-discharge 18650 pack. Factory options
are 1S1P, 1S2P, 1S3P, 2S1P, 2S2P and 2S3P. Series count is selected by assembly
resistors and matching provisioning, not an end-user switch. Parallel count
changes pack capacity, charge/discharge limits and gauge calibration. Cell model
and qualified pack data remain required before releasing any profile.

USB PD requests up to 20V/5A. The system must also start with no battery and a
lower-power source, keeping the LEDs and charger disabled until firmware has
established the available budget. A requested 100W contract does not imply that
the source/cable granted it or that the 5V rail is rated for 100W.

## Current hardware

- **USB interface:** GCT USB4105-GF-A-060 receptacle, TPS25730D sink controller,
  TPD6S300A QFN CC protection, separate USB2.0 data ESD clamp and raw VBUS TVS.
  GCT specifies 5A collectively on VBUS and 48V DC. The old SHOUHAN C2765186
  connector is rated 5V/3A and is not an approved substitute.
- **Source selection:** LTC4421 with external back-to-back MOSFETs gives USB
  priority and selects the protected battery when USB is absent. Its fault
  thresholds require worst-case tolerance, inrush and MOSFET SOA validation.
- **System rails:** TPS552882 buck-boost regulates the selected 1S/2S/USB bus to
  5V. TLV62569 generates 3.3V from this regulated rail. Never connect the 3.3V
  converter directly to 20V VBUS.
- **Charging:** BQ25798 charges the pack on a separate USB branch. Charger SYS
  carries local capacitors only; full system discharge bypasses its 6A BATFET.
  Charging stays disabled in hardware unless GPIO11 explicitly enables it.
- **Fuel gauge:** BQ34Z100-G1, protected by TPS70933, senses all pack current
  through a 5mΩ low-side shunt bank. Both cell counts require the external
  voltage divider and correct calibrated data-flash image.
- **Pack interface:** XT30 for current, plus two separate thermistors and their
  two-pin connectors. Charger TS and gauge TS use different bias circuits and
  must not share a thermistor. Pack protection is external; 2S requires balancing.
- **LED channels:** TPS25200 current-limited switches, INA226 monitors and
  SN74LVC1T45 level shifters. Faults reach the MCU, and switch enables default low.

The source of truth for pins is
[the board header](../../firmware/player_app/boards/splanc_dev.h). GPIO10 reports USB source selection, GPIO11 enables charging, GPIO15 holds
the USB mux input off for a controlled transfer, and GPIO20 is microphone data. I2C
addresses include PD 0x20, gauge 0x55, charger 0x6B, channel monitors 0x40/0x41,
compass 0x0D, MPU 0x68 and BMP 0x76. Power-policy and sensor drivers remain
unfinished; the engineering firmware currently leaves LED power and charging off.

## Assembly and layout constraints

Build `default` for 1S or `factory_2s` for 2S. The six provisioning records live in
[factory_profiles.json](../../hardware/splanc_dev/factory_profiles.json); none is
approved. Changing the battery series count requires matching hardware and
firmware settings, not merely editing a capacity field.

The current placement region is 85×65mm on four layers, pending mechanical and
thermal review. Keep switching loops compact, route Kelvin sense pairs directly,
and size copper/via arrays for the current and temperature rise. The compass
needs separation from inductors and high-current paths. Preserve the ESP antenna
keepout and the microphone's non-plated acoustic port.

The MPU exposed die must not be soldered. A 2.7×2.7mm all-layer copper keepout
is reconstructed by PnR writeback because atopile 0.15.8 strips footprint rule
areas. Verify it with `check_splanc_power.py --require-layout` and final KiCad DRC.

Legacy EoL fixture pins 1, 3 and 4 are disconnected on this revision, preventing
20V VBUS or a 2S pack from reaching the old fixture circuitry. Bring-up power
enters through USB-C; update the fixture and its protocol before production use.

## Release requirements

Both factory netlists must pass the power audit. The routed PCB must pass
independent KiCad DRC, connectivity, copper-current and mechanical checks.
Complete source-switching/inrush/SOA calculations, converter loop design and
thermal review before ordering an engineering assembly. Validate startup,
source removal, current limits, charging and all sensors on that assembly before
claiming product readiness. Gerbers, drill files, BOM and placement outputs must
come from the same verified board revision. Kickstarter product renders must
come from the final routed CAD and be identified as renders.

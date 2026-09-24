# Splanc: P4 + UWB middle variant

**Engineering draft, unrouted.** This is the middle member of the family: Mini's
USB-PD input, two protected LED channels and sensor functions, an ESP32-P4 main
processor, wireless companion, UWB ranging and optional GNSS. It does not modify
the active Mini experiment or its frozen sources.

## Architecture

- ESP32-P4NRW32X, **revision 3.x**, 32 MB package PSRAM and W25Q128JV 16 MB external
  QSPI flash. P4 executes application, sensor, LED and ranging code. Earlier P4
  NRW16/NRW32 revisions are not interchangeable with this circuit.
- ESP32-C6-WROOM-1-N8 remains a separate Wi-Fi/BLE/802.15.4 companion: P4 has no
  integrated radio. ESP-Hosted SPI connects the processors. The GPIO map is an
  explicit firmware configuration, not an assertion that stock binaries match.
  A six-pin internal C6 UART/reset/boot programming header is included.
- Qorvo DWM3000 module on a dedicated SPI bus, using its integral UWB antenna.
  Its reset is **open-drain** in firmware; IRQ has a 100 kΩ pulldown. Wake can use
  CS; WAKEUP is tied low. Ranging antenna calibration is required in the enclosure.
- Optional u-blox MAX-M10S-00B receives UART, PPS and reset from P4. Base and GPS
  are separate atopile builds. The GPS assembly includes a U.FL connector, DC
  block/bias tee and a lid-mounted Taoglas AP.25F.07.0078A active antenna. That
  antenna supports GPS/Galileo; do not market the resulting system as an equally
  optimized all-constellation antenna. Antenna dimensions25×25×8mm,cable78mm.
- Inherited Mini sensors: ICM-42670-P accelerometer/gyro, MMC5603NJ magnetometer,
  BMP580 pressure sensor and MMICT5848 I2S microphone with 1.8 V interface shifters.
- Inherited USB-C PD/protection, 5 V conversion and two 2 A LED ports with current
  sensing, hardware current limiting and 5 V data translation. P4's extra load
  must be included in the negotiated PD and regulator thermal budget.

## P4 electrical decisions

The dedicated high-speed USB PHY pins49/50 connect to the inherited connector and
low-capacitance ESD network. USB is a 90 Ω differential routing requirement, with
continuous reference plane and controlled stubs. The source pair annotation now
names `esp.p4:50` and `esp.p4:49`, not the old C6 package pins.

P4's core uses TLV62569 with 2.2 μH, 22 μF, two499kΩ feedback resistors and22pF
feed-forward capacitor, with FB and EN connected to P4's dedicated control pins.
This follows the **revision3.x** reference circuit, including VDD_HP pin54.
VDDO_FLASH powers flash/flash-IO and VDDO_PSRAM powers both PSRAM rails. Unused MIPI
PHY supply and lanes remain unconnected as allowed by the hardware guide. Reset
uses10kΩ/1μF. All main power pins have local decoupling in the source.

P4 GPIO35/36 are the download straps. The copied core names `IO8`/`IO9` are host
interface aliases for these pins, not native P4 GPIO numbers. Likewise LED enables
and faults use GPIO11–14 to avoid the JTAG startup behavior of GPIO2–5. The actual
mapping is in `p4_host.ato`; firmware must consume this mapping rather than reuse
the Mini pin definitions unchanged.

## Mechanical contract

Board100×80×1.6mm, four layers. Origin is lower left; positiveY points north/rear.
The common enclosure supports both assemblies. USB-C mouth is south at(18,0).
Two vertical JST-PH LED sockets are top-access at(50,12) and(70,12), not side ports.
Reset/boot/user buttons are right-angle south-edge parts. Two status LEDs have
separate light-pipe positions. The bottom-port microphone needs an acoustic path
through the board/base, not a top-only lid hole. RF modules occupy opposite north
regions; keep plastic/metal/coatings and wiring away from their antenna keepouts.

`interface.json` is the enclosure contract. `boards/` contains rough placement
exports; `design.json` enumerates actual component and pad/net positions. There
are no routes. A full placement/routing pass must preserve RF keepouts, quiet
sensor placement, switching-loop locality and USB geometry.

## Reproduction and limitations

```sh
python3 hardware/splanc/tools/author.py
ato build hardware/splanc -b base -b gps -v
/Applications/KiCad/KiCad.app/Contents/Frameworks/Python.framework/Versions/3.9/bin/python3 hardware/splanc/tools/place.py
```

The local atopile0.15.8 incremental PCB comparison can throw a UTF-8 decoding
error after pin remapping. Save the generated `elec/layout` PCBs and rebuild with
those generated layouts absent; never remove a routed checkpoint. The build
configuration excludes procurement exports because new manually selected atoms
have no invented supplier IDs. Existing Mini modules are copied snapshots;
`author.py` only regenerates the new P4/UWB/GNSS modules.

New P4 and GNSS land patterns are **provisional**, requiring vendor package-drawing
review. DWM3000 uses the KiCad DWM1000 land pattern because Qorvo declares pin/size
compatibility; final antenna keepout verification is still necessary. The inherited
USB4105 part uses a footprint named GT-USB-7010E-1; confirm that supplier/land/model
cross-reference before manufacture. Generic new atomic signals do not provide
power-direction ERC. Native DRC/netlist parity cannot prove the circuit works.

Outstanding detailed work includes regulator load/thermal testing, RF bias and
matching/SRF selection, crystal load tuning, USB SI, firmware boot/hosted-radio
bring-up, optional GNSS population rules, EMC/ranging calibration and antenna
performance in the actual case. Capacitor, inductor and RF generic choices need
orderable MPNs and footprint audits before a fabrication release.

Primary references:
- [ESP32-P4 datasheet](https://documentation.espressif.com/esp32-p4_datasheet_en.html)
- [P4 hardware checklist](https://docs.espressif.com/projects/esp-hardware-design-guidelines/en/latest/esp32p4/schematic-checklist-esp32p4.html)
- [P4 wireless companion architecture](https://docs.espressif.com/projects/esp-idf/en/latest/esp32p4/get-started/index.html)
- [Qorvo DWM3000](https://www.qorvo.com/products/p/DWM3000)
- [u-blox MAX-M10S datasheet](https://content.u-blox.com/sites/default/files/MAX-M10S_DataSheet_UBX-20035208.pdf)
- [Taoglas AP.25F](https://www.taoglas.com/product/ap-25f-gps-2-stage-active-patch-25mm-2/)

## Validation checkpoint

Both base and GPS `ato build ... -b base -b gps -v` builds pass on atopile
0.15.8. Native KiCad 10.0.6 board-to-source checks match all 800/831 pad-net
assignments, respectively, including P4 core/PSRAM/flash rails and optional GPS.
There are 180/187 circuit components and four mounting holes on each board;
rough body-envelope collision checks report zero overlaps.

These boards are intentionally unrouted: native connectivity counts **556 base /
578 GPS opens**. The CLI JSON list truncates at 499 and must not be mistaken for
the actual count. Native DRC finds zero copper-short, clearance, drill/hole or
silkscreen violations; 14/16 library-footprint mismatch warnings remain,
requiring land-pattern/library normalization review before release. Raw reports
and exact PCB hashes are in `validation/`. This is a reviewed engineering draft,
not a manufacturing-ready design.

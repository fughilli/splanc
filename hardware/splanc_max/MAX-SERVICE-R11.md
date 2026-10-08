# MAX service-end revision 11

MAX now has a single DC connection and two Ethernet connections on its west end.
The Pi USB-C and Ethernet openings are removed. The Pi, LV HAT and twenty LED
channels remain; an isolated control supply is added to the power board and a
separate three-physical-port Gigabit switch board sits above it.

This is an engineering specification and packaging prototype. The updated LV
and power circuits compile, but all PCBs remain unrouted. NET3 is a functional
specification with component-placement envelopes, not a pin-complete schematic.
Do not treat a successful rough-board check as electrical qualification.

## DC and control power

One mechanically paired XT150 input replaces the two exposed M5 lugs. The
original copper bars retain internal bolted cable attachments. Use a keyed,
retained two-pole carrier, red positive/black return and 8 AWG copper leads.
The input cable uses recessed female contacts. The supplied carrier geometry
is a packaging concept: final shoulder capture, polarization of the mating
carrier, strain relief and dimensional tolerances need the actual connector
samples before printing a functional part or cutting a mould.

[AMASS specifies 57 A at a 30 K rise with 8 AWG](https://www.china-amass.net/xt150-f-2-product/).
The part name is not a 150 A continuous rating. At 40 A of LED load plus
35.2 W control power and 2.5 W LED-side logic, using a conservative 85% conversion efficiency and
10.8 V low-input limit, the input budget is **44.11 A** (rounded to a 45 A design allowance). A single XT60 lacks
adequate margin; parallel input contacts were avoided. Specify a DC-rated
50 A upstream harness fuse and qualify its coordination with the source,
connector, harness and branch protection. Do not hot-plug this connector.
The LED aggregate limit stays 40 A, even if individual current-limit thresholds
would permit more when summed.

The power-board tongue carries a
[TRACO THL 40-2411WI](https://www.tracopower.com/products/thl40wi.pdf):
9–36 V input, 5 V/8 A nominal, 40 W, isolated, 25.4 × 25.4 × 11.5 mm.
Its output return is DGND; its input return is PGND. The existing 500 mA
RECOM supply remains exclusively on the P5V/PGND LED-side logic domain.
A nonisolated Pi buck would defeat that separation.

Target 5.1 V after selecting the manufacturer's trim network; maximum output
current then becomes 40/5.1 = 7.84 A. The provisional allocation is Pi 5 A,
HAT 0.8 A, switch 1 A and reserve 0.1 A: **35.19 W**. This is a design budget,
not a measured power result. Verify transient droop, module derating and heat
rise in the assembled, vented box.

The draft power source includes the six converter pins and separated input,
output and trim nets. Protection is explicitly a harness stage: 8 A slow-blow
converter input fuse, separately protected Pi/HAT/switch branches, reverse
blocking and overvoltage protection. These protection elements and the trim
resistor are **not yet implemented as a complete board circuit**. SYS5V_RAW
must not be treated as the finished Pi supply.

Low-profile, strain-relieved 18 AWG solder harness landings feed the HAT, then
Pi header pins 2 and 4 with multiple ground contacts. Verify contact ratings,
copper sizing and cable voltage drop at 5 A; header powering bypasses USB-C
power negotiation. Keep the USB-C power path disconnected and qualify Pi
power/peripheral configuration for this fixed supply. The internal USB data
bridge still carries its own Pi USB VBUS to FTDI detection; it must not
backfeed the new supply.

## NET3 board specification

| Item | Selection or requirement |
|---|---|
| Board | 80 × 60 × 1.6 mm, four layers, four M3 mounting holes |
| Switch | Microchip KSZ9896CTXI; PHY ports 1/2/3 used |
| Exposed ports | Upstream and downstream, each 10/100/1000BASE-T |
| Third port | Internal right-angle CAT5e-or-better patch lead to Pi |
| Panel sockets | Two Neutrik NE8FDP CAT5e feedthroughs, rear-mounted |
| Supply | Protected SYS5V/DGND; separate 3.3 V and 1.2 V regulators |
| Boot | Dedicated local controller configures forwarding independently of Pi |
| PCB pairs | Twelve PHY-side pairs, 100 Ω differential, target ≤0.5 mm intra-pair skew |
| Management | Local SPI programming/debug; optional Pi management separately from FPGA SPI |
| PoE | None |

The [KSZ9896C](https://ww1.microchip.com/downloads/aemDocuments/documents/OTH/ProductDocuments/DataSheets/KSZ9896C-Data-Sheet-DS00002390C.pdf)
has five integrated copper PHYs and one MAC-only port. Using three PHYs avoids
adding an external PHY for the Pi. Disable PHY4, PHY5 and MAC6 and terminate
unused pins per the datasheet. The cheaper-looking three-port KSZ9893 has only
two copper PHYs; its MAC-only third port cannot connect directly to Pi RJ45.

Reserve three integrated-magnetics jacks, a 25 MHz crystal, ESD protection,
reset/power-good supervision, a local boot MCU and regulator/decoupling areas.
Exact magnetics pinout and the MCU/boot implementation remain schematic gates.
In particular, follow the KSZ voltage-mode PHY guidance: PHY-side transformer
center taps must not simply be tied to 3.3 V. Keep cable-side magnetics copper
and shield/ESD return separate from DGND and PGND; define their EMC coupling.

The [NE8FDP manufacturer page](https://www.neutrik.us/en-us/product/ne8fdp)
provides the actual STEP used here and the panel drawing. Its CAT5e interface
supports the planned copper link. The 3D model is rear-mounted, with its latch
at the bottom so the internal jack/cable reservation is above the power PCB.
Two 100–150 mm panel patch leads and a roughly 300 mm Pi lead are initial
procurement lengths; verify routing, slack, bend radii and latch removal on
samples. Rendered harness paths are reservations, not cable bend qualification.

Forwarding must start without Linux. On loss of unit power the daisy chain is
interrupted. Use a linear chain; a loop/ring requires implemented and tested
RSTP, not merely a switch chip advertising protocol support. Both external
ports are electrically symmetric; their labels describe installation order.

## Packaging and reproduction

Outside dimensions are **330 × 134 × 43 mm**. The 38 mm extension creates room
for the connector backshells, internal wiring and power-supply tongue; height
is unchanged. The original 200 × 120 mm LED section is translated east intact.
The new power PCB has a 238 × 120 mm bounding box with a central service tongue,
leaving the volume underneath the two panel sockets empty.

NET3 bottom is Z23.5, with a removable insulating support tray at Z21. It is
supported through the existing power-board mounting holes. The service-end
centres in enclosure coordinates are ETH1 Y25/Z21, DC Y66.5/Z29, ETH2 Y106/Z21.
The Pi/HAT moves with the LED section; no live Mini electrical input is read.
The mechanical preview retains frozen PCB/package envelopes; it is not a
component-accurate STEP export of the newly legalized MAX electrical draft.
The converter position is checked explicitly against its CAD reservation.

Source contracts:

- `service-system.json`: power budget, isolation, board placement and release gates.
- `elec/src/service_system.ato`: functional system interfaces; deliberately no PCB build target.
- `tools/generate.py`: updated LV/power atoms and rough boards.
- `../mechanical/enclosure-spec.json` and `../mechanical/max_service.py`: CAD.

Run the existing three atopile build-design targets, then `tools/generate.py
--pcb` with KiCad Python and `tools/check.py` for source/native net parity.
The new NET3 board requires schematic completion before adding a build target.
Mechanical builds use `build_clean_enclosures.py`; validate with
`check_clean_enclosures.py`, `check_max_service.py`, `check_usb_c.py` and
`check_button_dfa.py`, passing `--source output/max-service-r11` where supported.
`render_max_service.py` creates the editable Blender project and three stills.

No manufacturing package, routing, procurement or publication is authorized
by this revision. Existing launch/BOM estimates exclude this network/supply
revision and need updating once the schematic and actual sourcing are closed.

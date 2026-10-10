# Enclosure interface, 9 September 2026

Engineering layout, 85 × 65 mm. Coordinates below use the PCB bottom-left
corner, X right, Y toward the antenna edge; dimensions in mm. Board thickness
is provisionally 1.6 mm. Confirm the assembly stackup before tooling.

Four M2.5 mounts have 2.7 mm unplated holes at (4,4), (81,4), (81,61),
(4,61), giving 77 × 57 mm center spacing. Each reserves a 7 mm diameter
screw-head/boss envelope on both faces. Placement and all-layer copper rules
conservatively reserve its enclosing 7 × 7 mm square. No tracks, vias or
copper pours are allowed there. Mounting holes are not purchased BOM items.
Use bosses/heads no larger than this envelope; enclosure fastener and insert
selection remains to be specified. Keep metal away from the ESP32 antenna.

The XT30 is rotated 180° from the previous preview (now 270° in placement
coordinates), at (8.5,36), with the mating face toward the west wall. Its
previous 3D-to-footprint alignment correction is retained. The LED JST headers
are at (79,20) and (79,31), rotated 90°, with their pin rows parallel to the
east edge. These remain top-entry JST PH connectors: cable entry is from the
lid, not through the side wall. Their surrounding port cells still share one
placement template. Check plugged cable housings and bend radii against the lid.

The four TL3340AF160QG side-actuated buttons face the south wall, centered at
(40,3.5) RESET, (48,3.5) BOOT, (60,3.5) USER1, (68,3.5) USER2. The standard
actuator axis is 1.7 mm above the seating plane. Manufacturer travel is
0.2 ±0.1 mm and force 160 ±50 gf. Compliant levers need a hard stop and
must not preload the buttons at rest. The electrical switches still perform
the original functions. Source land patterns contain documented locator-hole
and pad-heel corrections; the underside metal-case trace keepout is enforced.

Top-emitting power (yellow-green) and charge (orange) LEDs are at (28,4) and
(32,4), 4 mm pitch. Each uses a 2 kΩ series resistor on 3.3 V, about 0.65 mA
at nominal 2 V forward voltage. The charge LED is driven by BQ25798 STAT
and can blink for charge faults; it is not a fuel-level indicator. The power
LED adds continuous standby draw. A two-channel light pipe can collect above
these emitters and turn toward the south wall. Component-free corridors are
reserved at X=26.5–29.5 and 30.5–33.5, Y=0–2.5. Provide opaque separation
between optical channels. Light pipe geometry, optical gap, brightness and
lever tolerances need enclosure CAD and physical verification.

Microphone acoustic opening is now centered at (74,10); do not cover it with
a boss, foam or adhesive. Provide an acoustic path from the underside to the
outside. Pressure-sensor venting and the radio antenna keepout also remain
requirements for enclosure design.

Both factory assemblies have 227 populated components plus four mounting
holes. Placement DRC is clean, with 499 unrouted connections. This is not a
manufacturing release, and no enclosure tooling or board order has been placed.

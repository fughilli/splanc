Source: InvenSense MPU-6000/6050 specification rev 3.4, sections 11.3, 11.4.2–3.
https://www.cdiweb.com/datasheets/invensense/mpu-6050_datasheet_v3%204.pdf

The exposed die must not be soldered. Removed imported pad 25; reserved pins
19/21/22 are individually unconnected. Keep traces/vias out from under the die.

Atopile 0.15.8 drops footprint rule areas. The authoritative 2.7×2.7mm all-layer
copper_keepout is therefore in constraints.yaml. Writeback reconstructs it at
the placed MPU location, forbidding tracks, vias and copper pours. The source
footprint does not contain a redundant zone that atopile would silently remove.
Run check_splanc_power.py --require-layout on the placed/routed board and DRC.

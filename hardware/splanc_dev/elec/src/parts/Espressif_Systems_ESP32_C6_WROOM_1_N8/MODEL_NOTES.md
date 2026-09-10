# ESP32-C6-WROOM-1 3D model

Official model from Espressif's KiCad library:
https://github.com/espressif/kicad-libraries/blob/main/3dmodels/espressif.3dshapes/ESP32-C6-WROOM-1.STEP

Offset (-9, -9.75, 0) and zero rotation are from the official matching footprint:
https://github.com/espressif/kicad-libraries/blob/main/footprints/Espressif.pretty/ESP32-C6-WROOM-1.kicad_mod

The footprint coordinate frames match: pad 2 is (-8.75, -6.99) mm in both;
pad 1 differs only by 0.01 mm rounding. The local copper/antenna footprint repairs
remain in place; this change attaches the manufacturer's physical model.

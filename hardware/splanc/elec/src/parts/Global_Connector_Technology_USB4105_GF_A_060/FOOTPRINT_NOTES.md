USB4105-GF-A-060 selected for 5A USB PD service.
Manufacturer USB4105 specification Rev A3 (2023-02-27), section 4:
https://gct.co/files/specs/usb4105-spec.pdf
5A collectively across VBUS contacts; 48V DC rating.
Imported mechanical locator holes are 0.65mm non-plated holes, not plated pads.
Validate source land pattern and connector overhang against the assembly drawing.
The previous SHOUHAN C2765186 datasheet rates that part only 5V/3A and it must
not be substituted into this PD assembly.

Checked against GCT drawing Rev C dated 18/12/23:
https://gct.co/files/drawings/usb4105.pdf
Corrected imported 0.60mm locator drills to the specified 0.65mm. Relieved the
inner heels of the four ground/VBUS lands by 0.10mm (height 1.05mm, center Y
-2.41mm), preserving their outer toe. This provides >0.20mm nominal hole-to-
copper clearance; the unmodified recommended land has only ~0.15mm here.
This deliberate DFM adjustment requires solder-joint inspection on prototypes.
Rear shell slots corrected to 0.6×1.7mm drill and 1.0×2.1mm copper;
shell X pitch corrected to 8.64mm and rear/front Y pitch to 4.18mm per drawing.
The overhanging front body outline is on F.Fab, keeping it off the board silk.

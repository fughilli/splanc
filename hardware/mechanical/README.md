# Active enclosure build

Use [CLEAN-ENCLOSURES.md](CLEAN-ENCLOSURES.md) and `build_clean_enclosures.py` with `enclosure-spec.json`. The earlier STEP patch pipeline is historical and must not be run on the current output. Latest output is `output/compact-handheld-r9`.

# Splanc mechanical study

Engineering enclosure models generated from board interface data. Mini input is
extracted from a native PCB checkpoint using `extract_board.py`; MAX interfaces
come from the unrouted atopile board project. Models are dimensional design
proposals, not tooling releases or product photographs.

Current envelope assumptions: Pi5 with official Active Cooler; separate MAX LV
HAT and power board connected by a ribbon; twenty 2A outputs with40A aggregate.
The powerboard is beside the Pi/HAT stack so high-current terminals and busbars
remain accessible. User confirmation of Pi/current envelope is pending.

Mini must preserve USB-C, top-entry LED JST cable access, four side-actuated
buttons, two status light paths, bottom microphone aperture, pressure venting,
antenna clearance and underside pogo access. Four M2.5 PCB mounts are derived
from actual mounting pads. Use the70x55mm Mini, never the old85x65 Battery file.

MAX needs USB-A-to-C rigid bridge clearance, Pi Ethernet and USB-C power only, twenty LED output
ports, insulated lug access, ribbon bend space, cooling inlet/exhaust and separate
PCB support. Rigid USB bridge connector mating locations remain a fit-check item.
No mains voltage or isolation certification is implied by the isolated LED domain.

CAD library: CadQuery2.8.0/OCP7.9.3.1.1. Install dependencies in an isolated venv.
Output STEP solids and rendered views go under output/mechanical. Generated solid
validity, dimensions, collision checks and hashes accompany the deliverables.

Primary dimensional references:
- https://datasheets.raspberrypi.com/rpi5/raspberry-pi-5-mechanical-drawing.pdf
- https://datasheets.raspberrypi.com/cooling/raspberry-pi-active-cooler-mechanical-drawing.pdf
- Existing native Mini PCB and source component STEP models.

Reproduce from repository root:

```sh
python3 -m venv output/mechanical-runtime
output/mechanical-runtime/bin/pip install -r hardware/mechanical/requirements.txt
output/mechanical-runtime/bin/python hardware/mechanical/build.py \
  --mini output/fresh-pnr-20260919/fresh-28-final/splanc_mini.fab.board.kicad_pcb
output/mechanical-runtime/bin/python hardware/mechanical/test_outputs.py
```

`build.py` reads native PCB geometry for all three boards and checks MAX outline
agreement with the electronics interface. `mini-ports.json` supplies mating-port
clearances anchored to actual connector poses. Pin-level geometry is not a
substitute for manufacturer cable/connector tolerances. The selected Mini input is
the protected48-open checkpoint; enclosure generation does not modify it.

Current generated outside envelopes: Mini76.4×61.4×20mm; MAX315×134×53mm. The large
MAX footprint intentionally separates the high-current board and Pi stack.
All`*-envelope.step`parts are simplified reference geometry, not fabrication
parts. `base.step`, `lid.step`, Mini button/lightpipe parts and MAX copper busbars
are generated part solids; assemblies carry colours. Renders use those solids
with a software depth buffer, not image generation. Component blocks illustrate
native placement only; package heights are provisional.

The shells are printable fit prototypes. Tooling draft, gate/ejector positions,
material fire/thermal suitability, snap/insert tolerance and thermal validation
are not approved. STEP validity and rigid-body clearance tests are recorded in
manifest.json and checked again after STEP re-import.

The checked-in prototype ZIP under `releases/` includes individual STEP parts,
coloured assemblies, renders, connector coordinates and source hashes. Rebuilds
write to `output/mechanical` and do not replace this dated review snapshot.

## Current product-render revision

The later PBR study adds the100×80mm ESP32-P4 Splanc board and embossed logos.
The selected DEGSON connectors use a200×120mm MAX power board and335×134×53mm
MAX enclosure. This supersedes the earlier315mm-wide concept above; the original
dated prototype ZIP is preserved. See `PRODUCT-RENDERS.md` and
`../../docs/hardware/launch-pricing.md` for current assets and launch pricing.

## Black / white inlay revision

Current renders and STEP parts are in `output/product-renders-black`, packaged in
`releases/splanc-black-inlay-assets-20260921.zip`. Both shell halves use textured
black plastic. The white logo is a separate flush0.7mm second-shot solid seated
in a matching pocket; see `logo-white-inlay.step` for each product. Splanc and
Splanc GNSS share the same exterior. Earlier embossed white-shell files remain
in their original output/archive. Two-shot tooling costs are not yet included
in the prior launch-cost estimates.

## Campaign material / access revision

The latest workflow is documented in `CAMPAIGN-RENDERS.md`. It adds visible
fasteners, lowered connector access,0.5mm exterior chamfer operations, the four
user-selected ambientCG assets, yellow buttons and frosted light pipes. Current
stills and packed Blender scene are under `output/product-renders-campaign`.
`WEATHER-STUDY.md` separates the seal/coating concept from any ingress rating.

Revision 2 is in `output/product-renders-campaign-r2`: MAX's center screw bosses
begin above the terminal openings, and all plastic maps use one shared350mm
physical swatch to avoid repetition even across MAX. The earlier campaign
renders and archives are preserved. See `CAMPAIGN-RENDERS.md` for rebuild steps.

Revision 3 (`output/product-renders-campaign-r3`) further replaces the scratched
shell maps with scratch-free0.30mm labyrinth grain and blended object-space
height mapping across corners. The previous revisions remain available.

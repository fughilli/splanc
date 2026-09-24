# Clean enclosure build

The active generator is `build_clean_enclosures.py`, with dimensions in
`enclosure-spec.json`. It constructs each part from primitives, named feature
cutters and the repository SVG. It never imports an earlier enclosure STEP,
STL or scene. Earlier repair/patch scripts are historical and are not stages
in this build. Their outputs remain available for comparison.

Inputs are the Mini board reference, current Splanc/MAX interface JSON, and
manufacturer-derived electronics meshes in `assets/reference-electronics.json.gz`.
These meshes contain only PCBs/connectors/busbars/lugs; no shell, supports,
buttons, fasteners, seal or lightpipe geometry is carried forward. The compressed
Pi STEP supports independent solid collision checks. Reference meshes preserve
existing electrical poses; this task does not redesign or route the PCBs.

Each handheld model has one shell envelope, one cavity, a stepped split above
the button row, supported tongue/ledge registration, one connector bowl, PCB
mounts, a continuous stepped seal gland and explicit port openings. The button
strip is generated directly as a flat-backed drafted rail, four drafted prisms
and eight S flexures (0.8 mm wide, 0.3 mm thick). Retention lands meet the lid
roof. The pogo pads have no enclosure opening. Logo inlays are separate flush
white solids with material behind them. Lightpipes and visible screws are
separate parts. The outer perimeter has the specified 0.5 mm chamfer.

MAX uses a 292 × 134 × 43 mm envelope and an explicit 18.4 mm HAT spacer stack.
The only Pi access cutters are Ethernet and USB-C power. HDMI and USB-A are
fully covered. Ethernet includes an open-bottom finger relief. Output banks,
lugs, PCB supports, case bosses, cooling slots, seal joint and logo field are
independent features. Middle case bosses start above the output openings.
The updated USB bridge dimensions remain in the MAX electrical interface.

Rebuild and check from repository root:

```
output/mechanical-runtime/bin/python hardware/mechanical/build_clean_enclosures.py
output/mechanical-runtime/bin/python hardware/mechanical/check_clean_enclosures.py
output/mechanical-runtime/bin/python hardware/mechanical/check_button_dfa.py --source output/compact-handheld-r9 --products mini splanc
output/mechanical-runtime/bin/python hardware/mechanical/viewer/build.py --source output/compact-handheld-r9
```

No shell is resized by scaling. No failed collision is corrected by importing a
modified prior shell. Correct the named feature or contract and regenerate.
OCC shape fixing during export normalizes numerical B-rep tolerances; it is not
a design repair step. Reports distinguish nominal geometric checks from supplier
mating tolerances, spring force/fatigue, thermal tests, sealing and production
mold qualification, which remain open. Side openings can still require mold
slides or tool inserts; a valid solid alone does not establish moldability.

The Mini/Splanc weather-study entries currently share the clean common shell
and stepped gland. Separate weather-specific connector treatment and ingress
qualification have not been promoted from the older patch models.

Current editable scene: `output/blender-motion-studio-r4/splanc-motion-studio.blend`.
Current parts archive: `hardware/mechanical/releases/splanc-compact-handheld-r9.zip`.
The viewer is rebuilt at its existing endpoint; no server/permission changes are
required. `package_clean_enclosures.py` packages checked output and review
records. The previous motion studios remain unchanged.

## Compact handheld revision 9

Mini is now 76.4 × 61.4 × 17.2 mm (was20 mm tall), and Splanc/GNSS is
106.4 × 86.4 × 17.2 mm (was25 mm tall). Floor and roof are1.6 mm. PCB
bottom is4.2 mm above the enclosure bottom, leaving2.6 mm beneath the PCB
and0.8 mm beneath the modeled JST through-hole pins. The button rail top
is15.3 mm, roof underside15.6 mm, leaving0.3 mm nominal clearance. The
existing0.8 ×0.3 mm flexures and their path are preserved; their height sets
the remaining package-height limit. Supplier tolerance qualification is open.

The generator uses the electronics reference frame internally: top18.8 mm,
then an explicit assembly translation of−1.6 mm puts the exterior floor atZ0.
All electronics, moving parts, spring metadata and viewer switch models use
that same datum shift. Print-oriented files retain their print-bed datum. The
button checker normalizes the assembly datum before evaluating unchanged
switch positions and travel envelopes. MAX geometry remains unchanged.

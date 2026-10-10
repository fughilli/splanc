# Button flexure prototype — r1

This replaces independent flanged caps in a NEW checkpoint,
`output/button-flexure-r1`. Campaign-r3 is preserved. Both Mini and Splanc,
including their weather-study shells, receive the change. MAX is unchanged.

## Mechanism

- One connected molded strip with four independent shuttles, two long planar
  S-shaped flexures per shuttle, and a common registration frame. PP is the
  initial flexure-resin candidate; resin, gating, shrinkage and fatigue are not
  qualified. STEP includes the complete connected strip and inspection subparts.
- The flexures lie outside the enclosure wall. A fixed outer bezel retains the
  shoulders in the outward direction; enclosure pads stop inward travel at1.6mm.
  Integral sleeves register in the enclosure; one receiver is slotted to avoid
  overconstraining the long strip. Two nominal M1.6 screws clamp bezel and frame.
- Flanges no longer enter the PCB cavity. Rigid shafts are1.1mm square through
  radius1.2mm guides. The local front joint rises toZ12.1, above the plungers.
  The old tongue crossing the button row is removed only in that region.
- Weather gasket is rerouted continuously over the raised joint. New free gasket
  section0.4mm sits in a0.3mm closed gland (nominal25% squeeze); free-state CAD
  interference at this intentional seal contact is expected. Compression and
  mold tolerances still require qualification. Old static button boots are
  removed: a dynamic sealed diaphragm for the new strip is NOT yet designed,
  so the weather variant is not currently sealed at the moving plungers.
- Proposed compliant TPE contact tips absorb excess stroke. They are a second
  material/assembly process, not a claim that the PP springs alone limit switch
  force. The viewer compresses them kinematically and moves an extracted switch
  actuator; it does not solve elastomer mechanics.

## Allocated dimensional envelope

Nominal released gap0.30mm; assumed axial stack-up +/-0.20mm, giving0.10–0.50mm.
Switch actuation travel0.10–0.30mm from E-Switch. Enclosure stop travel1.60+/-0.10mm.
At the allocated worst case,1.50−0.50−0.30=0.70mm remains to compress the contact
pad. The pad must produce at least2.06N by0.70mm compression to overcome the maximum
specified160+/-50gf operating force. The largest provisional compression is1.50mm.
Its maximum load must be below the switch supplier's allowed overload; that limit
and an actual tip compression curve have NOT been established. Therefore successful
actuation, overload protection and return/fatigue are not claimed as validated.

Transverse allocation is +/-0.20mm in X/Z; spring axial allowance additionally
includes0.10mm. This is a **design allocation**, not a verified production stack-up.
The manufacturer's drawing includes general +/-0.25mm tolerances, so these tighter
allocations require supplier dimensional data/controlled datums or a larger
redesign envelope. Do not manufacture this candidate on the basis of these checks.

## Checks and remaining qualification

`check_button_flexure.py` checks all four shuttle positions in each of four variants,
three press positions including1.7mm and all transverse tolerance corners (192
poses total), against the actual shell with only intentional stop contacts omitted.
Analytic guide-radius and external-spring bounds cover intermediate translation.
The PCB is expanded to a7.6mm top surface. The maximum predicted contact-tip bulge
uses a uniform incompressible-cylinder approximation, not a finite-element model.
The report states geometric margins and explicitly records force_curve_validated=false.

The shell pairs remain valid single solids with zero base/lid overlap; the complete
strip is one solid and the raised gasket remains one solid. Old collar/connector,
thermal and ingress limitations remain unchanged. Further release work: real
supplier/assembly tolerance stack, compliant-tip force/overload test, molded-spring
strain/fatigue and creep analysis, registration/screw pullout, and a new sealed
button diaphragm where weather resistance is required.

## Reproduce / inspect

```
XDG_CACHE_HOME=/private/tmp/mechanical-cache output/mechanical-runtime/bin/python hardware/mechanical/button_flexure.py
XDG_CACHE_HOME=/private/tmp/mechanical-cache output/mechanical-runtime/bin/python hardware/mechanical/check_button_flexure.py
XDG_CACHE_HOME=/private/tmp/mechanical-cache output/mechanical-runtime/bin/python hardware/mechanical/viewer/build.py --source output/button-flexure-r1
```

Reload the existing viewer; use **Your saved view**, the press-travel slider,
and switch-travel selection. Hide **Button retainer bezel** to inspect the S springs.
The viewer includes height-corrected source switch CAD. Source footprint model offsets
are corrected from0.4 to1.65mm; no PCB copper/placement/routing changes were made.

Manufacturer drawing: https://configured-product-images.s3.amazonaws.com/2D/specs/TL3340AF160QG.pdf

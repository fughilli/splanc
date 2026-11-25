# Connect-flow pictograms

`render.py` draws the line-art pictures the app shows in its connect picker and on the
"Flash a new device" sheet (`web/public/connect/`):

| File             | Shows                                                                  |
| ---------------- | ---------------------------------------------------------------------- |
| `setup-ble.png`  | phone sends Wi-Fi details over Bluetooth; the fixture joins the router |
| `direct-ble.png` | phone and fixture talking directly over Bluetooth                      |
| `address.png`    | phone and fixture on the same router, with the fixture's address       |
| `flash-usb.png`  | fixture on USB-C to a laptop, or to an Android phone                   |

Regenerate (writes into the source tree):

```sh
bazel run //tools/connect_diagrams:render
bazel run //tools/connect_diagrams:render -- --check   # inputs load, outputs exist
```

## How it renders

The fixture is the Splanc Mini, built as a triangle mesh from its enclosure design
parameters, with the same formulas as `hardware/mechanical/build_clean_enclosures.py`:

- the shell outline: board size, side and rear margins, the 3.2 mm front margin, the
  corner radius and the edge chamfer;
- the height: from `assembly_z_shift_mm` and `top`;
- the parting line: at `split`, raised to `raised_seam_z` over the button run;
- the USB-C cable well and throat: from `usb_c` at `usb_x`;
- the four button caps and their apertures;
- the two light pipes, the four corner screws at the board mounts, the two top-entry
  LED ports, and the QWIIC side opening.

The laptop, phones, router and cable are simple procedural props. A small numpy
rasterizer draws everything as white line art on black:

1. It fills depth, normal and part-id buffers at 3x supersampling.
2. It draws lines wherever those buffers change (silhouettes and creases), over dark
   lambert-shaded fills.
3. It box-filters the image down to size.

The "Splanc" wordmark and the phone-screen UI are perspective-mapped onto their
surfaces. Arrows and the Bluetooth and Wi-Fi glyphs are 2D overlays placed on
projected 3D points. Nothing is hand-drawn or AI-generated, so a CAD change re-renders
correctly. In the Bluetooth and address pictures the fixture is drawn about 2x scale
so it stays legible next to the phone.

## Inputs (first match wins)

1. **`--mesh <file.stl>`**: an STL export of the Mini assembly, in millimetres, in the
   enclosure build's emitted frame. X runs right along the front, Y runs to the rear,
   Z is up with the enclosure floor at z = 0, and USB-C is on the -Y face. The STL can
   be binary or ASCII.
2. **`--cad-dir <dir>`**: a directory holding `enclosure-spec.json` and
   `assets/mini-board-reference.json`. The default is `<repo>/hardware/mechanical`,
   once that directory exists on this branch.
3. **`mini_mechanical.json`**: the committed snapshot of those two files. Its
   `provenance` block records the git ref, the commit and the sha256 of each source
   file. Refresh it with `bazel run //tools/connect_diagrams:render -- --refresh-snapshot --git-ref origin/splanc-mini`.

## What would make it exact

Today the enclosure CAD lives only on the `splanc-mini` branch, and its full CadQuery
build needs `assets/reference-electronics.json.gz`, which is gitignored. So this tool
rebuilds the Mini from the design parameters rather than from the solid model.

To render the real solids, export the coloured Mini assembly from the CadQuery build
or Onshape as a single **STL**, in the frame described above, and pass it with
`--mesh`. The pipeline needs no other change.

A STEP file would need OpenCascade (OCP) to tessellate, which the zero-dependency
renderer avoids. Convert STEP to STL first, for example with CadQuery's
`exporters.export(shape, "mini.stl")`.

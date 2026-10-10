# Showcase fixtures

`generate_showcase.ts` deterministically builds three synthetic examples inspired
by real installations. These are authored approximations, not scans or original
artist CAD. Coordinates are meters, +Y up. No reference photographs are bundled.

- **Tree of Light** — broad branching canopy, luminous leaves, bare trunk and
  roots; inspired by the [Studio DRIFT reference](https://i0.wp.com/studiodrift.com/wp-content/uploads/2021/02/IMG_2295-scaled.jpg?resize=1700%2C1220&ssl=1).
- **Primitive Obsession** — one 10-foot module, 20 × 20 × 20 LEDs, open conduit
  frame; dimensions and LED count from the [project page](https://wakenmake.shop/projects/primitive_obsession/).
  An explicit empty topology prevents the Effects workspace from extracting
  meaningless nearest-neighbor connectivity across the volume.
- **Resting Deer** — crouching deer with folded legs, ears and antlers; triangulated
  skin sampled along unique mesh edges, inspired by the supplied reference photos.

The tree and deer use the app's actual `extractTopology` offline. Results, model
geometry and LED maps ship in the generated `showcaseTree.ts`, `showcaseVolume.ts`,
and `showcaseMaxa.ts` modules, composed by `web/src/store/showcaseData.ts`. They load
without a server or runtime extraction. The existing topology editor can re-extract,
preview and save adjustments. The deer retains short cycle chords; the tree uses
forest extraction. Connectivity is estimated from geometry, as for scanned maps.

From the repository root, with workspace dependencies installed:

```sh
node_modules/.bin/tsc -p tools/fixtures/tsconfig.json --outDir /tmp/splanc-showcase-generator
node /tmp/splanc-showcase-generator/tools/fixtures/generate_showcase.js
```

The generator prints LED / triangle / segment / junction counts. Re-running it
produces identical data. Sample-specific localStorage flags allow existing installs
to receive new examples and respect user deletion. Data is loaded in a separate
chunk only when a sample still needs seeding.

## Digital twin overlays

Open a captured or imported map, expand **Digital twin · mesh overlay**, and import
an OBJ or STL (ASCII or binary). Materials, textures and colors are ignored.
Translate in meters, rotate about XYZ in degrees, and scale uniformly, then
**Save mesh**. Alignment affects only the mesh. STL units are unspecified: use
scale `0.001` for millimeter geometry. **Reset alignment** restores the original
model coordinates; the visibility control hides the geometry without deleting it.

Mesh overlays are gray and translucent in the map viewer, Effects, Acid Mode, and
library thumbnails. The device protobuf stays LED/topology-only. Library exports
preserve model geometry, alignment and visibility, as do map duplicates. Imports
are limited to 20 MB / 30,000 triangles / 90,000 vertices; simplify large scans
before import. OBJ polygons are fan-triangulated, so concave polygons should be
triangulated in the model exporter. GLTF/GLB and automatic alignment are not yet
supported. Reality capture of unlit structure remains future work.

## Captured Resting Deer demo

`web/src/demo/maxaScene.ts` holds the captured Acid Mode shader and all eleven
live uniform values. Color values are normalized RGB channels, including
`#fcff52` and `#ff66e6`. The Effects library seeds a read-only canned scene;
starting the tutorial creates an editable copy and opens the real authoring
workspace. Existing tutorial edits are preserved when restarting the tour.

The shell-free `/scene.html` entry cycles through Resting Deer, Tree of Light, and
Primitive Obsession every twelve seconds, with gentle rotation and mouse-driven
camera phase/elevation. Each uses the captured effect; the topology flood is
disabled for the volume. The scene pauses offscreen or in a hidden document, and
renders a static frame when reduced motion is requested. `vite build` bundles
this entry separately to keep app bootstrap code out of the embedded viewport.

To export it for the website after building the app:

```sh
python3 tools/fixtures/export_hero.py /path/to/splanc.io/public/scenes/maxa --runtime /path/to/wasm/bundles
```

The runtime directory must contain matching `fx-compiler` and `fx-vm` bundles.
The website receives only the isolated scene bundle and those two runtimes;
it does not depend on a deployed app or run a separate approximation of the shader.

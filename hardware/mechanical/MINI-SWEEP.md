# Mini highlight sweep draft r1

Run from repository root with Blender 4.5:

```
blender -b --python hardware/mechanical/render_mini_sweep.py
```

Reads the packed campaign-r3 Blender materials/environment and replaces the product
meshes with the current button-flexure-r1 Mini CAD. Outputs to
`output/mini-highlight-preview-r1`: MP4, reusable animated Blender scene, three
review stills, and shot metadata. Historical CAD/render checkpoints are preserved.

The four-second draft uses 96 frames at 24 fps, 640×360, 8 Cycles samples with
denoising. Camera arcs 12 degrees with a gentle push-in; a rectangular softbox
moves across the lid while the IndoorEnvironmentHDRI002 environment and a quiet
front fill retain shape. No depth of field, audio, or motion blur in this draft.
Review highlight width/intensity, camera elevation, arc direction and pacing before
increasing resolution/samples. Prototype geometry remains mechanically unqualified;
this is a visualization of the current design.

# Motion studies r1 — low-quality selection previews

Six candidates built from button-dfa-r5 CAD and packed campaign materials. Mini,
Splanc/GNSS and weather variants share rectangular 5×2.2mm caps and the r5 flexures;
MAX has no external button array. No old square caps or external carrier is used.

Run Blender with render_motion_candidates.py; --stills renders two composition
frames, --shot selects a catalog name, --samples sets Cycles sample count. Default
640×360,24fps,6samples/denoising, no depth of field or motion blur. Output lives in
output/motion-studies-r1. Each candidate has shot.json and MP4; catalog.json describes
all choices. Reproducible script retains materials from the packed campaign blend.

Entrance A: slow diagonal glide, long-axis roll68°→22°, late logo light sweep.
Entrance B: faster slide, stronger100°→18° roll, earlier reveal.
Entrance C: longer floating glide,55°→28° roll, faint physical haze.
All long axes lie on a45° screen diagonal; entry comes from the lower-left. The
world uses the requested HDRI for reflection/illumination, with black camera rays
and no ground. C adds a very low-density scattering volume.

Family A: rapid camera pullback into a centered three-product pyramid.
Family B: quicker pullback into a wide lineup, staggered sibling arrival.
Family C: later/longer pullback into a gently angled fan with a longer settle.
The camera dollies back at fixed focal length; MAX enters from left and Splanc
from right with small rotations. Relative product dimensions are preserved.
Mini/Splanc sit in front of MAX in A/C. B is left-to-right MAX/Mini/Splanc, avoiding crossing the stationary Mini during entry.
Backdrop is procedural charcoal velvet with dark sheen and fine nap; it is a
motion-study material, not a final scanned cloth asset.

These are CAD prototype visualization/motion studies, not photographs, tooling
release or final hero-quality rendering. Review timing, roll, entry, logo reveal,
crash speed and final composition before increasing quality or adding motion blur.

## Revised B macro pass (r2)

Run `render_motion_candidates.py -- --macro-pass` in Blender. Output is
`output/motion-studies-r2/entrance-b-macro/entrance-b-macro.mp4`.
The 4-second pass has a projected long axis 30 degrees from vertical, 35 degrees
of longitudinal depth tilt, and rolls from 75 to 35 degrees. The camera is
150 mm from the logo plane at 55 mm focal length. At midpoint the camera views
the lid at about 28 degrees above its surface. The logo centroid travels
continuously through frame center at 2 seconds, with a Gaussian highlight
peak timed to that crossing. It exits right without settling. HDRI reflections
remain; the background is black. Current r5 CAD and materials are unchanged.
Validate using `validate_motion_previews.py -- --root output/motion-studies-r2`.

## Stronger visible roll (r3)

The current `--macro-pass` outputs to `output/motion-studies-r3` and replaces
the subtle 40-degree full-shot roll with a 140-degree roll (125 to -15 degrees)
concentrated between 1 and 3 seconds. Smoothstep timing preserves the midpoint
55-degree roll and the same shallow logo view/highlight at 2 seconds.
Translation, camera, black background, and CAD remain unchanged. About 111 degrees
of the rotation now occurs between 35% and 65% of the shot, where the module
crosses the crop. The prior r2 MP4 remains intact for comparison.

## Asteroid field r1

`render_asteroids.py` reuses the canonical r5 CAD/material setup and instances
10 bodies with seeded SKU choices, launch times, velocities and spin. The
8-second / 24 fps / 640x360 draft uses 4 Cycles samples, black camera background,
HDRI reflections, and broad studio lights. Relative physical SKU sizes remain
correct. Blender Bullet runs with zero gravity, 8 substeps/frame, 30 solver
iterations, 0.92 restitution, and no damping. Conservative full-assembly box
colliders provide deflection and spin; these are cinematic collision proxies,
not detailed mechanical impact models. Bodies spawn beyond the frame and launch
from alternate sides. Mesh data are shared. The baked trajectory, seed and
instance settings are saved in output/asteroids-r1/simulation.json. No enclosure
geometry changes are made. Run the common video validator with
`--root output/asteroids-r1` after rendering.

## 30-second Full HD asteroid field

Run `render_asteroids.py -- --hd`. Outputs go to `output/asteroids-hd-r1`.
The shot uses 720 frames at 24 fps, 1920x1080, 16 denoised Cycles samples,
Metal GPU acceleration when available, and 43 seeded bodies launched throughout
the 30-second duration. Evaluated meshes are shared between instances to avoid
repeating bevel evaluation. PNG frames are checkpointed in `asteroids/frames`;
rerunning skips completed frames and encodes the complete sequence to H.264.
The common validator checks the full source dimensions while generating small
review images. No prior preview files are overwritten.

# Canonical Splanc splash motion

`frames.json` is the approved, reusable impact/splash artwork. Consumers should
use its saved vector samples, changing placement, scale and colour as needed.
Do not regenerate the contours from a physics model or apply another smoothing
pass. This is an art-directed constrained-contour study, not CFD.

## Provenance and timing

Kevin approved the 65% tension-like smoothing and 6× playback preset on
November 8, 2026. The source is `splanc-fluid-65-approved.tar.gz`:

- Archive SHA-256:
  `cec9c22addb9db556a7978f7043de960fe3ee8160227e7681e157c7a397b285c`
- Extracted `splanc-fluid-65/frames.json` SHA-256:
  `210d2b5ef4d09b8bbc6c0b8a21a6eae32ce6d38d3187d2744b1e8ab75dbf159f`

The JSON is committed byte-for-byte, including its original lack of a trailing
newline, and excluded from automatic formatters. The bridge tests pin its hash.
The archive's duplicate SVG/PNG exports are not required to regenerate the
artwork and are not vendored.

- `frames`: 73 saved samples at 240 fps, including both endpoints.
- `titleFrames`: 19 exact samples at 60000/1001 fps; the last at 0.3003 s clamps
  to the final vectors. Use these for that frame rate rather than rounding onto
  the 240 fps grid.
- Each sample contains `time` in playback seconds, `modelTime`, SVG `markup`,
  and study metadata (`area`, `depth`, `phase`). Playback is already accelerated;
  do not apply 6× again.
- Duration: 0.300 s; impact: 0.133333… s; formation interval: 0.166667… s;
  final vector lock begins at 0.291667… s.
- Transparent SVG `viewBox`: `95 -30 75 87`. Each sample's markup supplies
  its paths/circle, fill and any group transform. Final paths are the exact
  source logo shapes in the coordinate system of `web/public/icons/splanc.svg`.

This source contains only the impact/splash motion. The historical title
renderer used the samples in white before its separate title slide, reverse
pipe reveal and fade. Those title effects are not part of this asset.

## Export the original vector frames

From the repository root, with Python's standard library:

```sh
python3 - <<'PY'
import json
from pathlib import Path

source = json.loads(Path('shared/brand/splash/frames.json').read_text())
out = Path('/tmp/splanc-splash-svg')
out.mkdir(parents=True, exist_ok=True)
for i, sample in enumerate(source['frames']):  # or source['titleFrames']
    svg = (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{source["viewBox"]}">'
           f'{sample["markup"]}</svg>\n')
    (out / f'{i:03d}.svg').write_text(svg)
PY
```

## Relay/bridge boot bitmap generation

The current boot consumer is
[`gen_boot_frames.py`](../../../pi/bridge/tools/gen_boot_frames.py).
It uses the saved samples with the existing Pillow rasterizer: filled paths
and circles, transformed to logo coordinates, white on black, 4× supersampling,
then the existing one-bit threshold. No SVG browser, fonts or new runtime
dependency is needed.

The existing initial black frame is retained. The approved pass starts at
1/30 s and finishes at 1/3 s, selecting every eighth 240 fps sample without
interpolation. The mark holds until the existing glide. The wordmark wipe,
LED chase and glint retain their schedules. Frames from 0.5 s onward remain
pixel-identical to the previous generator.

The output remains SPLB v1: 128×64, one bit per pixel, 60 frames at 30 fps,
two seconds total, with the same zlib payload. `boot.py` still holds the final
frame and the display service retains its existing status-screen handoff.
The unmerged initrd/C splash pipeline is not a dependency of this asset.

Both `//pi/bridge:boot_frames` and Nix's `splancPy` derivation declare this JSON
as an input. The checkout display simulator uses it too. Generated bitmaps
remain build outputs, not committed files.

```sh
bazel build //pi/bridge:boot_frames
bazel test //pi/bridge:display_test

# Direct equivalent, with Pillow installed (12.3.0 in requirements.lock):
python3 pi/bridge/tools/gen_boot_frames.py \
  --svg web/public/icons/splanc.svg \
  --splash shared/brand/splash/frames.json \
  --out /tmp/boot_frames.bin --png-dir /tmp/splanc-boot-preview
```

`test_splash_source.py` checks provenance, exact sample timing, the final vector
lock, repeatable generation, the v1 decoder/last-frame hold and the unchanged
later bitmap frames. Inspect PNGs at their actual 128×64 size as well as enlarged.
Hardware brightness, first boot and timing on the physical SH1106 still need a
board test; software validation does not establish those results.

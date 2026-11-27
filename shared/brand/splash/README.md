# Canonical Splanc splash motion

`frames.json` is the approved, reusable impact/splash artwork, the motion of the
intro video's title sequence. Consumers use its saved vector samples, changing
placement, scale and colour as needed. Do not regenerate the contours from a
physics model or apply another smoothing pass. This is an art-directed
constrained-contour study, not CFD.

## Provenance and timing

The 65% tension-like smoothing and 6× playback preset were approved on
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
- `titleFrames`: the title sequence's 19 exact samples at 60000/1001 fps; the
  last at 0.3003 s clamps to the final vectors. Use these at that frame rate
  (or at 60 fps) rather than rounding onto the 240 fps grid.
- Each sample contains `time` in playback seconds, `modelTime`, SVG `markup`,
  and study metadata (`area`, `depth`, `phase`). Playback is already accelerated;
  do not apply 6× again.
- Duration: 0.300 s; impact: 0.133333… s; formation interval: 0.166667… s;
  final vector lock begins at 0.291667… s.
- Transparent SVG `viewBox`: `95 -30 75 87`. Each sample's markup supplies
  its paths/circle, fill (`#c7eea4`) and any group transform. Final paths are
  the exact source logo shapes in the coordinate system of
  `web/public/icons/splanc.svg`.

Everything a consumer needs is here: the splash motion at both rates. What
follows the splash (where the mark goes, the wordmark, any reveal) belongs to
each consumer; the bridge's boot animation below is one.

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

## The bridge's boot animation

[`gen_boot_frames.py`](../../../pi/bridge/tools/gen_boot_frames.py) renders it
for both of the Pi bridge's screens from the saved samples, with its own small
rasterizer (filled paths and circles, transformed to logo coordinates; Pillow
only, no SVG renderer, fonts or new runtime dependency). Same timeline on both:

1. 1/30 s of black, then the approved splash plays at the centre from 1/30 s to
   1/3 s, sample by sample, without interpolation;
2. the mark holds, then glides to its place in the logo (0.45–0.9 s) while the
   wordmark is wiped in behind a scan line (0.7–1.25 s);
3. a row of LEDs chases on underneath (0.95–1.6 s) and a glint crosses the logo
   (1.4–1.85 s); the intro ends at 2 s;
4. then a 1.2 s "loading" loop, repeated until the bridge is ready: a head runs
   along the LED row with a dark gap behind it, then the row rests.

The two outputs:

- **OLED** (`--out`, `boot_frames.bin`, SPLB v2): 128×64, one bit per pixel,
  4× supersampled then thresholded, white on black. The `frames` samples at
  240 fps (the source's own rate, above the SH1106's ~156 Hz scan): a 480-frame
  intro and a 288-frame loop. The panel shows whichever frame matches the
  current time, so it plays at whatever rate the panel loop reaches.
- **HDMI** (`--hdmi-out`, SPLH v1): the same layout ×4 (512×256), in colour
  and anti-aliased: the mark in the samples' own fill, the wordmark white, the
  LEDs in colour. The `titleFrames` samples, at 60 fps: a 120-frame intro and a
  72-frame loop, palette-coded as frame-to-frame deltas (~260 KB).

The early boot splash (`pi/bridge/splash`, from the initrd) plays both: the OLED
frames at 60 fps (every fourth one) and the HDMI animation, scaled to the
screen. splanc-display (`pi/bridge/display`) then continues the OLED animation
from the same moment and the splash opens HDMI into the app's first page
(`pi/bridge/README.md`, "Boot splash"). Both `//pi/bridge:boot_frames` and
Nix's `splancPy` / `splashAssets` derivations declare this JSON as an input. The
checkout display simulator uses it too. Generated frames remain build outputs,
not committed files.

```sh
bazel build //pi/bridge:boot_frames
bazel test //pi/bridge:display_test

# Direct equivalent, with Pillow installed (12.3.0 in requirements.lock):
python3 pi/bridge/tools/gen_boot_frames.py \
  --svg web/public/icons/splanc.svg \
  --splash shared/brand/splash/frames.json \
  --out /tmp/boot_frames.bin --hdmi-out /tmp/boot_hdmi.bin \
  --png-dir /tmp/splanc-boot-preview
```

`test_splash_source.py` checks provenance, exact sample timing, the final vector
lock, repeatable generation, the decoder/loop, and the HDMI animation (its
timing, its decoder round trip, the titleFrames it plays). Inspect the PNGs at
their actual size as well as enlarged. Brightness, first boot and timing on the
physical SH1106 and on a real HDMI screen still need a board test; software
validation does not establish those results.

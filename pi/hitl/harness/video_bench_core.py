"""Pure logic for the video-streaming-performance HITL test (FUG-video-stream).

Kept apart from the hardware driver (hitl_video_stream.py) so it's unit-testable
in //pi/hitl/tests with no rig/network: the texture-effect source we compile+load
onto the device, and parsing/judging the stream_bench binary's RESULT line. The
frame encoding + FPS measurement itself lives in the Rust stream_bench binary,
which reuses the TouchDesigner plugin's own encoder (//tools/touchdesigner/core).
"""

from __future__ import annotations

from typing import Any


def bars_effect_src(width: int, height: int, tex_name: str = "vid") -> str:
    """A minimal effect that declares a `width`x`height` 2D texture and samples it
    per-LED. The scrolling-bars frames are streamed in over set_texture (the host
    generates + encodes them with the TouchDesigner codec), so the shader only has
    to sample the texture — its declared size is what makes the device accept our
    frames: the firmware silently drops any set_texture whose dimensions don't
    match a declared texture port. Mirrors the `texture …; sample(t, led.uv)` form
    the fx_compiler tests exercise."""
    return (
        f"texture vec3 {tex_name}({width}, {height});\n"
        "void update() {}\n"
        f"vec3 shade(Led led) {{ return sample({tex_name}, led.uv); }}\n"
    )


def parse_result(stdout: str) -> dict[str, Any]:
    """Parse the `RESULT k=v k=v …` line the stream_bench binary prints (numbers
    coerced), scanning from the end so trailing output wins. Returns {} when no
    RESULT line is present."""
    for line in reversed(stdout.splitlines()):
        line = line.strip()
        if not line.startswith("RESULT "):
            continue
        fields: dict[str, Any] = {}
        for tok in line[len("RESULT ") :].split():
            key, _, val = tok.partition("=")
            if key:
                fields[key] = val
        for num in ("fps", "seconds", "min_fps"):
            if num in fields:
                try:
                    fields[num] = float(fields[num])
                except ValueError:
                    pass
        for i in ("frames", "bytes"):
            if i in fields:
                try:
                    fields[i] = int(fields[i])
                except ValueError:
                    pass
        return fields
    return {}


def verdict(fps: float, min_fps: float) -> bool:
    """Streaming is acceptable when the measured rate clears the threshold."""
    return fps >= min_fps

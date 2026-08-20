"""Pure logic for the loaded-device wss:443 / cert-page TLS gate (FUG-133).

Split from the hardware driver (hitl_loaded_tls.py) so it's unit-testable in
//pi/hitl/tests with no rig/network. Two pieces live here:

  1. the fixtures that load the device to its worst case — a FULL map, a
     texture-sampling effect, and a resident texture keyframe — reusing the exact
     shapes the other on-hardware drivers already pin, plus the SetTexture wire
     dict the harness needs (the other drivers stream textures from Rust, so there
     was no Python builder for it yet);
  2. `scan_serial_for_oom`, which decides from the captured serial whether an
     mbedTLS session allocation OOM'd during the window (the PR #114 symptom).

The rig lifecycle and the actual wss/https handshakes live in the driver.
"""

from __future__ import annotations

import base64
from typing import Any

# Reuse the fixtures the sibling drivers already pin, so this gate loads the
# device the SAME way they do rather than with a private near-duplicate: the full
# LedEntry map (map_upload_core, the FUG-74 shape) and the WxH texture-sampler
# effect source (video_bench_core, the FUG-video-stream shape). Re-exported so the
# driver + tests import everything loaded-device from one module.
from map_upload_core import synth_output_map  # noqa: F401  (re-exported)
from video_bench_core import bars_effect_src  # noqa: F401  (re-exported)

# SetTexture.format wire code for a 2 B/texel RGB565 frame. A plain keyframe is
# flags=0 (no DELTA bit0, no RLE bit1), so the firmware zeroes its prev buffer and
# copies our bytes straight in (handle_set_texture in firmware/player_app/ffi.rs).
TEX_FORMAT_RGB565 = 1

# The two device-log signatures the gate must NEVER see during the window — both
# are how an mbedTLS session allocation failed on a heap starved by the resident
# map+effect (the PR #114 symptom). esp-tls logs the first when it can't create
# the ~28 KB server session (-0x7f00); mbedTLS's dynamic-buffer impl logs the
# second ("Dynamic Impl: alloc(NNNN bytes) failed") when a record-buffer alloc
# fails outright. Matched case-insensitively as substrings.
_OOM_SESSION = "esp_tls_create_server_session failed"
_OOM_ALLOC = "dynamic impl: alloc"


def rgb565_gradient_frame(width: int, height: int) -> bytes:
    """A full `width`x`height` RGB565 keyframe (2 B/texel, row-major, little-endian)
    carrying a gradient — so the streamed texture holds real data the effect
    samples, not zeros. The packed length (w*h*2) must stay <= the firmware's 8 KB
    FX_TEX_PREV cap; the driver's default dims sit well under it."""
    denom_x = max(1, width - 1)
    denom_y = max(1, height - 1)
    denom_d = max(1, denom_x + denom_y)
    buf = bytearray()
    for y in range(height):
        for x in range(width):
            r = (x * 31) // denom_x  # 5 bits
            g = (y * 63) // denom_y  # 6 bits
            b = ((x + y) * 31) // denom_d  # 5 bits
            px = (r << 11) | (g << 5) | b
            buf.append(px & 0xFF)
            buf.append((px >> 8) & 0xFF)
    return bytes(buf)


def set_texture_msg(
    tex_index: int, width: int, height: int, data: bytes, fmt: int = TEX_FORMAT_RGB565
) -> dict[str, Any]:
    """The flat set_texture message for a full keyframe (flags=0). `data` is
    base64'd because proto3-JSON (proto_wire.encode_client) carries a bytes field
    as a base64 string. Fire-and-forget on the wire — the firmware sends no reply."""
    return {
        "type": "set_texture",
        "tex_index": tex_index,
        "format": fmt,
        "width": width,
        "height": height,
        "flags": 0,
        "data": base64.b64encode(data).decode("ascii"),
    }


def texture_fits_arena(width: int, height: int, elem_bytes: int = 12) -> bool:
    """True iff a `width`x`height` texture at `elem_bytes`/texel (default vec3 f32 =
    12 B) fits the firmware's 24 KB static FX_ARENA. Guards the driver's dims so a
    too-big texture can't silently fail to load (the effect would drop every frame
    and the gate would measure an unloaded device). Mirrors ffi.rs's arena bound."""
    return width * height * elem_bytes <= 24 * 1024


def texture_frame_fits(width: int, height: int, bytes_per_texel: int = 2) -> bool:
    """True iff the packed set_texture frame (default RGB565 = 2 B/texel) fits the
    firmware's 8 KB FX_TEX_PREV cap; over it, handle_set_texture drops the frame."""
    return width * height * bytes_per_texel <= 8 * 1024


def scan_serial_for_oom(serial: str) -> list[str]:
    """Return the serial lines that indicate an mbedTLS session OOM during the
    window (empty == the gate held). Matches esp-tls's session-create failure and
    mbedTLS's dynamic-buffer alloc failure; the alloc line is only counted when it
    also says 'failed', so a benign 'alloc(...)' trace can't trip a false red."""
    hits: list[str] = []
    for raw in serial.splitlines():
        low = raw.lower()
        if _OOM_SESSION in low:
            hits.append(raw.strip())
        elif _OOM_ALLOC in low and "failed" in low:
            hits.append(raw.strip())
    return hits

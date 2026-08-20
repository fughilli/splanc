"""Pure-logic unit tests for the loaded-device TLS gate core (FUG-133).

No rig, no network: the texture-frame builder + set_texture wire dict, the
firmware-cap guards, and the serial-OOM scanner. The on-hardware behaviour
(reserve/flash/provision, the wss handshake + HTTPS GET) lives in the manual
py_binary //pi/hitl/harness:loaded_tls.
"""

from __future__ import annotations

import base64

from loaded_tls_core import (
    bars_effect_src,
    rgb565_gradient_frame,
    scan_serial_for_oom,
    set_texture_msg,
    synth_output_map,
    texture_fits_arena,
    texture_frame_fits,
)


def test_gradient_frame_is_two_bytes_per_texel():
    frame = rgb565_gradient_frame(40, 40)
    assert len(frame) == 40 * 40 * 2
    # Not all-zero (it carries a gradient, so the streamed texture holds real data).
    assert any(frame)


def test_gradient_frame_handles_1xn_without_zero_division():
    # denom guards: a 1-wide / 1-tall texture must not divide by zero.
    assert len(rgb565_gradient_frame(1, 8)) == 1 * 8 * 2
    assert len(rgb565_gradient_frame(8, 1)) == 8 * 1 * 2
    assert len(rgb565_gradient_frame(1, 1)) == 2


def test_set_texture_msg_shape_and_payload():
    data = bytes(range(20))
    msg = set_texture_msg(2, 5, 4, data)
    assert msg["type"] == "set_texture"
    assert msg["tex_index"] == 2
    assert msg["width"] == 5 and msg["height"] == 4
    assert msg["format"] == 1  # RGB565
    assert msg["flags"] == 0  # keyframe, no delta / RLE
    # bytes travel base64'd (proto3-JSON bytes field).
    assert base64.b64decode(msg["data"]) == data


def test_texture_fits_arena_boundary():
    # vec3 f32 = 12 B/texel against the 24 KB FX_ARENA: 40x40 = 19.2 KB fits.
    assert texture_fits_arena(40, 40)
    # 48x48 = 27.6 KB overflows the arena.
    assert not texture_fits_arena(48, 48)


def test_texture_frame_fits_boundary():
    # RGB565 = 2 B/texel against the 8 KB FX_TEX_PREV cap: 64x64 = 8192 B is the max.
    assert texture_frame_fits(64, 64)
    assert not texture_frame_fits(64, 65)


def test_scan_serial_clean_is_empty():
    clean = "\n".join(
        [
            "[wss] TLS player on :443 (heap=120000)",
            "[wss] re-issuing cert with SAN IP:192.168.4.2 (heap=98000); restarting TLS",
            "I (1234) esp-tls: handshake ok",
            "Dynamic Impl: alloc(8866 bytes) ok",  # benign alloc trace, not a failure
        ]
    )
    assert scan_serial_for_oom(clean) == []


def test_scan_serial_flags_session_create_failure():
    serial = "E (5000) esp-tls: esp_tls_create_server_session failed, 0x7f00"
    hits = scan_serial_for_oom(serial)
    assert len(hits) == 1
    assert "esp_tls_create_server_session failed" in hits[0]


def test_scan_serial_flags_mbedtls_alloc_failure():
    serial = "E (5001) mbedtls: Dynamic Impl: alloc(8866 bytes) failed"
    hits = scan_serial_for_oom(serial)
    assert len(hits) == 1
    assert "alloc(8866 bytes) failed" in hits[0]


def test_scan_serial_is_case_insensitive_and_counts_each_line():
    serial = "\n".join(
        [
            "esp_tls_create_server_session FAILED",
            "DYNAMIC IMPL: ALLOC(8866 bytes) FAILED",
            "unrelated line",
        ]
    )
    assert len(scan_serial_for_oom(serial)) == 2


def test_reexports_load_fixtures():
    # The gate loads the device via the shared sibling fixtures.
    m = synth_output_map(768, "__fug133")
    assert m["type"] == "submit_map"
    assert m["map"]["led_count"] == 768
    src = bars_effect_src(40, 40)
    assert "texture" in src and "40, 40" in src

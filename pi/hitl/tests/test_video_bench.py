"""Unit tests for the video-streaming HITL test's pure logic (video_bench_core).

The frame encoding + FPS measurement live in the Rust stream_bench binary (tested
in //tools/touchdesigner/stream_bench:stream_bench_test); here we pin the
device-side effect source and the RESULT-line parsing/verdict the harness relies
on."""

from video_bench_core import bars_effect_src, parse_result, verdict


def test_bars_effect_src_declares_texture_and_samples_it():
    src = bars_effect_src(24, 24)
    assert "texture vec3 vid(24, 24);" in src
    assert "sample(vid, led.uv)" in src
    # A different size is reflected verbatim (the device accepts only exact match).
    assert "texture vec3 vid(32, 8);" in bars_effect_src(32, 8)
    # A narrow arena precision is emitted as a `: fixed8`/`: fixed16` annotation.
    assert "texture vec3 vid(24, 24) : fixed8;" in bars_effect_src(24, 24, comp="fixed8")
    assert "texture vec3 vid(24, 24) : fixed16;" in bars_effect_src(24, 24, comp="fixed16")
    assert " : " not in bars_effect_src(24, 24, comp="f32")  # f32 = no annotation


def test_parse_result_extracts_and_coerces_fields():
    out = (
        "[video-stream] noise line\n"
        "RESULT fps=32.50 frames=98 seconds=3.010 bytes=12345 "
        "device_tex=24x24 min_fps=10.00 verdict=PASS\n"
    )
    r = parse_result(out)
    assert r["fps"] == 32.5
    assert r["frames"] == 98
    assert r["bytes"] == 12345
    assert r["seconds"] == 3.01
    assert r["min_fps"] == 10.0
    assert r["device_tex"] == "24x24"
    assert r["verdict"] == "PASS"


def test_parse_result_error_line():
    assert parse_result("RESULT verdict=ERROR") == {"verdict": "ERROR"}


def test_parse_result_missing_returns_empty():
    assert parse_result("no result here\nRESULTS are elsewhere") == {}


def test_verdict_threshold():
    assert verdict(10.0, 10.0)  # exactly at the floor passes
    assert verdict(15.0, 10.0)
    assert not verdict(9.9, 10.0)

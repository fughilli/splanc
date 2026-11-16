"""Approved artwork, deterministic OLED conversion, and the existing boot contract."""

import hashlib
import json
import os
from pathlib import Path

import gen_boot_frames as g
import pytest
from splanc_display import boot

ROOT = (
    Path(os.environ["TEST_SRCDIR"]) / "_main"
    if "TEST_SRCDIR" in os.environ
    else Path(__file__).resolve().parents[3]
)
SOURCE = ROOT / "shared/brand/splash/frames.json"
LOGO = ROOT / "web/public/icons/splanc.svg"


def test_approved_source_is_unchanged():
    raw = SOURCE.read_bytes()
    assert hashlib.sha256(raw).hexdigest() == (
        "210d2b5ef4d09b8bbc6c0b8a21a6eae32ce6d38d3187d2744b1e8ab75dbf159f"
    )
    source = json.loads(raw)
    assert source["smoothing"] == 65 and source["timing"]["rate"] == 6
    assert source["viewBox"] == "95 -30 75 87"
    assert source["timing"]["duration"] == 0.3
    assert source["timing"]["impact"] == pytest.approx(0.8 / 6)
    assert source["timing"]["formation"] == pytest.approx(1 / 6)
    assert len(source["frames"]) == 73 and len(source["titleFrames"]) == 19
    for i, sample in enumerate(source["frames"]):
        assert sample["time"] == pytest.approx(i / 240)
    for i, sample in enumerate(source["titleFrames"]):
        assert sample["time"] == pytest.approx(i * 1001 / 60000)


def test_boot_uses_saved_samples_at_the_approved_speed():
    samples = json.loads(SOURCE.read_bytes())["frames"]
    assert g.splash_sample(samples, -1) is samples[0]
    assert g.splash_sample(samples, 100) is samples[-1]
    # After the initial black frame, nine 30 Hz intervals cover the 0.3 s pass.
    for i in range(10):
        assert g.splash_sample(samples, i / 30) is samples[i * 8]
    assert g.splash_sample(samples, 4 / 30)["time"] == pytest.approx(0.8 / 6)


def test_final_sample_locks_to_existing_logo_vectors():
    source = json.loads(SOURCE.read_bytes())
    expected = g.logo_shapes(str(LOGO))["mark"]
    for sample in (source["frames"][-1], source["titleFrames"][-1]):
        actual = g.splash_shapes(sample["markup"])
        assert len(actual) == len(expected)
        for a_path, e_path in zip(actual, expected):
            assert len(a_path) == len(e_path)
            for a_sub, e_sub in zip(a_path, e_path):
                assert len(a_sub) == len(e_sub)
                for a_point, e_point in zip(a_sub, e_sub):
                    assert a_point == pytest.approx(e_point, abs=1e-12, rel=0)


def test_deterministic_generation_and_v1_compatibility(tmp_path):
    outputs = [tmp_path / "first.bin", tmp_path / "second.bin"]
    for output in outputs:
        assert g.main(["--svg", str(LOGO), "--splash", str(SOURCE), "--out", str(output)]) == 0
    data = outputs[0].read_bytes()
    assert data == outputs[1].read_bytes()
    assert data[:10] == b"SPLB\x01\x1e\x80\x40\x3c\x00"
    animation = boot.unpack(data)
    assert animation.fps == 30 and animation.duration == 2
    assert len(animation.frames) == 60
    assert animation.at(200).tobytes() == animation.frames[-1].tobytes()
    assert animation.frames[0].getbbox() is None
    for i, frame in enumerate(animation.frames[1:], start=1):
        assert frame.mode == "1" and frame.size == (128, 64)
        if i < 15:  # The splash fits; the later scan line intentionally exits the panel.
            x0, y0, x1, y1 = frame.getbbox()
            assert 0 < x0 < x1 < 128 and 0 < y0 < y1 < 64
    # Pixel baseline from main 4da9640: glide, wordmark, LEDs, glint and last
    # held frame from 0.5 s onward must remain byte-identical.
    assert hashlib.sha256(b"".join(f.tobytes() for f in animation.frames[15:])).hexdigest() == (
        "73adc3b7b93b4ccd24d502053728d84241f4487ca523b685b7d46259657f15ef"
    )


def test_unknown_splash_elements_fail_explicitly():
    with pytest.raises(ValueError, match="unsupported splash element"):
        g.splash_shapes('<rect x="1" y="1" width="10" height="10"/>')

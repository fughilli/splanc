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
    # After the initial black hold, the 240 fps boot frames take every sample in turn.
    for i in range(len(samples)):
        assert g.splash_sample(samples, i / g.FPS) is samples[i]
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


def test_deterministic_generation_and_v2_loop(tmp_path):
    outputs = [tmp_path / "first.bin", tmp_path / "second.bin"]
    for output in outputs:
        assert g.main(["--svg", str(LOGO), "--splash", str(SOURCE), "--out", str(output)]) == 0
    data = outputs[0].read_bytes()
    assert data == outputs[1].read_bytes()
    # v2: 240 fps, 128x64, 768 frames, the loading loop from frame 480 (after the 2 s intro).
    assert data[:12] == b"SPLB\x02\xf0\x80\x40\x00\x03\xe0\x01"
    animation = boot.unpack(data)
    assert animation.fps == 240 and animation.duration == 2
    assert animation.loop_start == 480 and len(animation.frames) == 768
    # The loop rests on the intro's last frame, so intro -> loop is seamless.
    assert animation.frames[-1].tobytes() == animation.frames[479].tobytes()
    assert all(animation.frames[i].getbbox() is None for i in range(8))  # 1/30 s of black
    assert animation.index(200) >= animation.loop_start  # still moving, in the loop
    assert animation.frames[0].getbbox() is None
    for i, frame in enumerate(animation.frames[1:480], start=1):
        assert frame.mode == "1" and frame.size == (128, 64)
        if 8 <= i < 120:  # The splash fits; the later scan line intentionally exits the panel.
            x0, y0, x1, y1 = frame.getbbox()
            assert 0 < x0 < x1 < 128 and 0 < y0 < y1 < 64
    # Pixel baseline from main 4da9640 (then 30 fps): at each of its frame times from
    # 0.5 s onward (every eighth 240 fps frame) the glide, wordmark, LEDs, glint and
    # last held frame must remain byte-identical.
    old_times = animation.frames[120:480:8]
    assert hashlib.sha256(b"".join(f.tobytes() for f in old_times)).hexdigest() == (
        "73adc3b7b93b4ccd24d502053728d84241f4487ca523b685b7d46259657f15ef"
    )


def test_unknown_splash_elements_fail_explicitly():
    with pytest.raises(ValueError, match="unsupported splash element"):
        g.splash_shapes('<rect x="1" y="1" width="10" height="10"/>')
